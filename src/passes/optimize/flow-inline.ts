// Flow-sensitive variable inlining — a port of Closure's `FlowSensitiveInlineVariables` (via
// compilecat `flow_inline.rs`). The payoff pass the CFG substrate was adopted for: it is the one
// transform whose enabling condition is a genuine dataflow question, not a syntactic one.
//
//   const t = a.b + c;   …straight-line, no interference…   return f(t);
//   → return f(a.b + c);
//
// It combines BOTH reaching analyses:
//   • must-reaching-defs (`reaching-defs.ts`): the read has EXACTLY ONE reaching definition, and it is
//     not a parameter (a parameter's "definition" is the entry sentinel — nothing to move).
//   • maybe-reaching-uses (`reaching-uses.ts`): that definition's value has EXACTLY ONE use, this read.
// When both hold, the definition's RHS can move to the use and the definition is dropped. Neither
// condition is answerable syntactically once the def and use are in different basic blocks — which is
// exactly why this needs the graph and `inline.ts` (adjacent-only, structural) does not reach it.
//
// SCOPE OF THIS INCREMENT — deliberately narrower than Closure's, mirroring how the other optimize-tier
// ports began. Every one of these is a REFUSAL, i.e. conservative and safe:
//   • DIRECTIVE-GATED (`@optimize`/`@flatten`/`@sroa` — the hot-path opt-in), like every optimize pass.
//     Closure/compilecat gate it the same way; it is not a general minify pass.
//   • the definition is a single-declarator `const`/`let` OR a top-level `x = rhs` statement
//   • the RHS is PURE and a SAFE SHAPE (Closure `isRhsSafeToInline`: no member/new/array/object/class/
//     regex anywhere — those either have identity or can throw/observe order when moved)
//   • the use is NOT inside a loop the def sits outside of (the RHS would re-evaluate every iteration)
//   • exactly ONE syntactic occurrence of the variable in the use's CFG node
//   • along every CFG path from def to use, nothing writes a symbol the RHS reads (the interference
//     check; skipped only when def and use are adjacent statements, where there is no path between)
import { isPureExpr, mayHaveSideEffects } from '../../analysis/effects.ts';
import { buildCfg, type Cfg } from '../../analysis/cfg.ts';
import { computeReachingDefs, TOP } from '../../analysis/reaching-defs.ts';
import { computeReachingUses } from '../../analysis/reaching-uses.ts';
import { cloneNode, N, type Node, set, statementListOf, walk, walkChildren } from '../../ast.ts';
import { attachScopeNode, lookupValue, retireSymbol, type Semantic, scopeOf } from '../../analysis/semantic.ts';
import { addRefFacts, subtractRefFacts } from '../../analysis/ref-facts.ts';
import { DIRECTIVE, directiveSpans } from './directives.ts';
import { Gate } from './gate.ts';

const isFn = (n: Node): boolean =>
    n.type === N.FunctionDeclaration || n.type === N.FunctionExpression || n.type === N.ArrowFunctionExpression;

/** Local symbols of `fn` and those a nested function can observe. Same rule as dead-store/coalesce. */
function scopeSymbols(fn: Node): { locals: Set<number>; escaped: Set<number> } {
    const locals = new Set<number>();
    const escaped = new Set<number>();
    walk(fn, (n) => {
        if (n !== fn && isFn(n)) {
            walk(n, (c) => {
                if (c.type === N.IdentifierReference || c.type === N.BindingIdentifier) {
                    const s = (c as { sym: number }).sym;
                    if (s > 0) escaped.add(s);
                }
                return undefined;
            });
            return false;
        }
        if (n.type === N.BindingIdentifier) {
            const s = (n as { sym: number }).sym;
            if (s > 0) locals.add(s);
        }
        return undefined;
    });
    return { locals, escaped };
}

/** Closure `isRhsSafeToInline`: reject anything with identity or a throw/observe hazard when moved. */
function rhsSafe(rhs: Node): boolean {
    let unsafe = false;
    const visit = (n: Node): void => {
        if (unsafe) return;
        switch (n.type) {
            case N.StaticMemberExpression:
            case N.ComputedMemberExpression:
            case N.PrivateFieldExpression:
            case N.ArrayExpression:
            case N.ObjectExpression:
            case N.RegExpLiteral:
            case N.NewExpression:
            case N.ClassExpression:
                unsafe = true;
                return;
            // Do not descend into nested functions — a member access inside a closure body is not
            // evaluated when the RHS moves, so it is not a hazard.
            case N.FunctionExpression:
            case N.ArrowFunctionExpression:
                return;
            default:
                walkChildren(n, visit);
        }
    };
    visit(rhs);
    return !unsafe;
}

/** The symbols a subtree READS (identifier references), not descending into nested functions. */
function readSyms(n: Node, into: Set<number>): void {
    if (n.type === N.IdentifierReference) {
        const s = (n as { sym: number }).sym;
        if (s > 0) into.add(s);
        return;
    }
    if (isFn(n)) return;
    walkChildren(n, (c) => readSyms(c, into));
}

/** Count syntactic reads of `sym` in `n` (not descending into nested functions). */
function countReads(n: Node, sym: number): number {
    let count = 0;
    const visit = (m: Node): void => {
        if (m.type === N.IdentifierReference) {
            if ((m as { sym: number }).sym === sym) count++;
            return;
        }
        if (isFn(m)) return;
        walkChildren(m, visit);
    };
    visit(n);
    return count;
}

/** Whether any node in `n` writes (assigns/updates/declares-with-init) a symbol in `syms`. */
function writesAny(n: Node, syms: ReadonlySet<number>): boolean {
    let hit = false;
    const targets = (t: Node): void => {
        if (hit) return;
        if (t.type === N.IdentifierReference || t.type === N.BindingIdentifier) {
            if (syms.has((t as { sym: number }).sym)) hit = true;
            return;
        }
        walkChildren(t, targets);
    };
    const visit = (m: Node): void => {
        if (hit || isFn(m)) return;
        switch (m.type) {
            case N.AssignmentExpression:
                targets((m.data as { left: Node }).left);
                break;
            case N.UpdateExpression:
                targets((m.data as { argument: Node }).argument);
                break;
            case N.VariableDeclarator:
                if ((m.data as { init: Node | null }).init !== null) targets((m.data as { id: Node }).id);
                break;
            default:
                break;
        }
        walkChildren(m, visit);
    };
    visit(n);
    return hit;
}

/** Does CFG node `id` (an unmodelled interference candidate) write any of `syms`? */
function nodeWrites(cfg: Cfg, id: number, syms: ReadonlySet<number>): boolean {
    const v = cfg.value[id];
    return v !== null && writesAny(v, syms);
}

/** Is there a def→use path (exclusive of endpoints) through a node that writes a RHS-read symbol? */
function pathInterferes(cfg: Cfg, defId: number, useId: number, syms: ReadonlySet<number>): boolean {
    if (syms.size === 0) return false;
    // BFS forward from def's successors; if we reach use, the intervening nodes were clean so far, but
    // any intervening node that writes `syms` is interference. Conservative: an unmodelled/multi-path
    // graph still terminates because we mark visited.
    const seen = new Uint8Array(cfg.value.length);
    const queue: number[] = [...cfg.succ[defId]];
    for (const s of queue) seen[s] = 1;
    let head = 0;
    while (head < queue.length) {
        const id = queue[head++];
        if (id === useId || id === 0) continue; // reached the use, or the implicit return
        if (id !== defId && nodeWrites(cfg, id, syms)) return true;
        for (const s of cfg.succ[id]) if (seen[s] === 0) {
            seen[s] = 1;
            queue.push(s);
        }
    }
    return false;
}

/** The declarator/assignment inside CFG node `stmt` that writes `sym`, with its RHS and how to drop it. */
type DefLoc = { rhs: Node; drop: () => void };

function locateDef(list: Node[], stmt: Node, sym: number, sem: Semantic): DefLoc | null {
    if (stmt.type === N.VariableDeclaration) {
        const d = stmt.data as { kind: string; declarations: Node[] };
        for (let i = 0; i < d.declarations.length; i++) {
            const dec = d.declarations[i].data as { id: Node; init: Node | null };
            if (dec.id.type === N.BindingIdentifier && (dec.id as { sym: number }).sym === sym && dec.init !== null) {
                const init = dec.init;
                return {
                    rhs: init,
                    drop: () => {
                        // The two branches below REMOVE the binding, so retire the symbol with it —
                        // `dropRefs`-style count movement does not retire a BINDING, and a symbol left
                        // live keeps claiming a mangler slot for a declaration that no longer exists.
                        // The `let` branch keeps the declarator, so it must NOT evict.
                        if (d.declarations.length === 1) {
                            retireSymbol(sem, sym);
                            const idx = list.indexOf(stmt);
                            if (idx >= 0) {
                                // Subtract what leaves. This pass is not traverse-based, so there is no
                                // `ctx.dropRefs` — without this the removed statement's references stay
                                // counted and `DELTA_MODE=verify` reports `over(safe)`: a dead symbol
                                // still looks live, so `dropUnused` declines to remove it.
                                subtractRefFacts(sem, stmt);
                                list.splice(idx, 1);
                            }
                        } else if (d.kind === 'const') {
                            retireSymbol(sem, sym);
                            subtractRefFacts(sem, d.declarations[i]);
                            d.declarations.splice(i, 1);
                        } else {
                            // `let` — keep the binding, null the init (it might be read before
                            // reassigned). The init expression still LEAVES, so its references go too.
                            if (dec.init !== null) subtractRefFacts(sem, dec.init);
                            (dec as { init: Node | null }).init = null;
                        }
                    },
                };
            }
        }
        return null;
    }
    if (stmt.type === N.ExpressionStatement) {
        const e = (stmt.data as { expression: Node }).expression;
        if (
            e.type === N.AssignmentExpression &&
            (e.data as { operator: string }).operator === '=' &&
            (e.data as { left: Node }).left.type === N.IdentifierReference &&
            ((e.data as { left: Node }).left as { sym: number }).sym === sym
        ) {
            return {
                rhs: (e.data as { right: Node }).right,
                drop: () => {
                    const idx = list.indexOf(stmt);
                    if (idx >= 0) {
                        subtractRefFacts(sem, stmt);
                        list.splice(idx, 1);
                    }
                },
            };
        }
    }
    return null;
}

/** Every statement list in `body`, with the container so a def can be dropped from the right list. */
function statementLists(body: Node): Node[][] {
    const lists: Node[][] = [];
    walk(body, (n) => {
        if (n !== body && isFn(n)) return false;
        const list = statementListOf(n);
        if (list !== null) lists.push(list);
        return undefined;
    });
    return lists;
}

/** Map every node under `root` to the scope that CONTAINS it.
 *
 *  `scopeOf(sem, n)` reports the scope a node OWNS — `0` for a `return`, an assignment, or any other
 *  non-scope-owner — so it cannot answer "what is in scope here". This threads the cursor down instead,
 *  matching `descend`'s rule exactly: a scope-owning node itself belongs to the ENCLOSING scope, while
 *  its CHILDREN belong to the scope it owns.
 *
 *  Built once per function, alongside the CFG this pass already constructs. */
function enclosingScopes(root: Node, outer: number): Map<Node, number> {
    const out = new Map<Node, number>();
    const rec = (n: Node, scope: number): void => {
        out.set(n, scope);
        const own = (n.data as { scopeId?: number } | null)?.scopeId ?? 0;
        const inner = own !== 0 ? own : scope;
        walkChildren(n, (c) => {
            rec(c, inner);
        });
    };
    rec(root, outer);
    return out;
}

const fnInline = (fn: Node, sem: Semantic, scopeOfUse: (use: Node) => number): boolean => {
    const body = (fn.data as { body: Node | null }).body;
    if (body === null || body.type !== N.BlockStatement) return false;

    // The function's own scope and its body-block scope: a `let` at the function's top level lives in
    // the BODY block, while parameters live in the function scope, so both count as "function level".
    const fnScope = scopeOf(sem, fn);
    const fnBodyScope = scopeOf(sem, body);
    // Accurate "what scope is this node in" for the whole function body.
    const enclosing = enclosingScopes(body, fnScope !== 0 ? fnScope : scopeOfUse(fn));
    const scopeAt = (n: Node): number => enclosing.get(n) ?? fnBodyScope;
    const { locals, escaped } = scopeSymbols(fn);
    const tracked = new Set([...locals].filter((s) => !escaped.has(s)));
    if (tracked.size === 0) return false;

    const cfg = buildCfg(body);
    const defs = computeReachingDefs(cfg, tracked);
    const uses = computeReachingUses(cfg, tracked);

    // Map each CFG node to the statement list that contains it (for dropping the def).
    const listOfStmt = new Map<Node, Node[]>();
    for (const list of statementLists(body)) for (const s of list) listOfStmt.set(s, list);

    // Collect decisions first; apply after, so the analysis is never read against a mutated tree.
    type Decision = { use: Node; rhs: Node; drop: () => void; useSym: number };
    const decisions: Decision[] = [];
    const usedDefs = new Set<Node>();
    const usedUses = new Set<Node>();

    for (let useId = 1; useId < cfg.value.length; useId++) {
        const useNode = cfg.value[useId];
        if (useNode === null) continue;
        // Each tracked symbol read in this CFG node is a candidate use.
        const readsHere = new Set<number>();
        readSyms(useNode, readsHere);
        for (const sym of readsHere) {
            if (!tracked.has(sym)) continue;
            // (must) exactly one reaching def, not the entry sentinel.
            const defId = defs.defInAt(useId, sym);
            if (defId <= 0 || defId === TOP || defId === cfg.entry) continue;
            const defNode = cfg.value[defId];
            if (defNode === null || usedDefs.has(defNode)) continue;
            const defList = listOfStmt.get(defNode);
            if (defList === undefined) continue;

            const loc = locateDef(defList, defNode, sym, sem);
            if (loc === null) continue;
            if (!isPureExpr(loc.rhs) || !rhsSafe(loc.rhs)) continue;

            // (may) this def's value has exactly one use, and it is this CFG node.
            const uafter = uses.usesOutAt(defId, sym);
            if (uafter.length !== 1 || uafter[0] !== useId) continue;

            // exactly one syntactic occurrence in the use node.
            if (countReads(useNode, sym) !== 1) continue;

            // …and that occurrence must be a genuine READ, never an LVALUE. `countReads` counts every
            // `IdentifierReference` carrying the symbol, including one being assigned or updated, so
            // `_flatStack[stackSize++] = root` looked like a single clean use of `stackSize`;
            // substituting its definition (`0`) produced `_flatStack[0++] = root`, which is not
            // JavaScript at all. Closure guards this in `FlowSensitiveInlineVariables` with
            // `NodeUtil.isLValue(n)` (line 106) — the check this port omitted.
            //
            // `writesAny` is reused rather than a fresh walk because it already recognises exactly the
            // lvalue positions (assignment target, update argument, declarator id) and already stops
            // at nested function boundaries, matching `countReads`.
            if (writesAny(useNode, new Set([sym]))) continue;

            // SCOPE: every free symbol the RHS reads must still resolve to the SAME binding at the
            // use site. Both halves need the ENCLOSING scope of the use, which `scopeAt` supplies —
            // `scopeOf` reports the scope a node OWNS (`0` for a `return`), which is why the previous
            // version exempted tracked locals outright and let a real miscompile through: block-inline
            // wraps a spliced callee body in a block, so `{ let jv; … } r = jv;` then `return r`
            // became `return jv`, referencing a block-scoped binding from OUTSIDE its block. It only
            // looked correct because `blockFlatten` later hoisted the declaration by accident.
            const rhsReads = new Set<number>();
            readSyms(loc.rhs, rhsReads);
            let scopeOk = true;
            for (const r of rhsReads) {
                if (tracked.has(r)) {
                    // A tracked local: is the scope that DECLARES it an ancestor-or-self of the use's
                    // scope? Structural rather than by name, because inlining renames bindings so
                    // `decl.name` need not match the current text.
                    const declScope = sem.symbols[r]?.scope ?? 0;
                    let sc = scopeAt(useNode);
                    let visible = false;
                    while (sc !== 0) {
                        if (sc === declScope) {
                            visible = true;
                            break;
                        }
                        const parent = sem.scopes[sc]?.parent ?? 0;
                        if (parent === sc) break;
                        sc = parent;
                    }
                    if (!visible) {
                        scopeOk = false;
                        break;
                    }
                    continue;
                }
                // A free/outer name: it must resolve to the same symbol from the use's scope.
                const nm = sem.symbols[r]?.decl?.name;
                if (nm !== undefined && lookupValue(sem, scopeAt(useNode), nm) !== r) {
                    scopeOk = false;
                    break;
                }
            }
            if (!scopeOk) continue;

            // interference: nothing on any def→use path may write a symbol the RHS reads. Skipped when
            // adjacent in the same list (no path between them). An impure RHS is already rejected, so
            // the only hazard left is a WRITE to something the RHS reads.
            const adjacent = defList === listOfStmt.get(useNode) && Math.abs(defList.indexOf(defNode) - defList.indexOf(useNode)) === 1;
            if (!adjacent && pathInterferes(cfg, defId, useId, rhsReads)) continue;
            // Even adjacent, if the RHS reads a mutable global the use expression itself might change
            // it before the read — but the use has exactly one occurrence and the RHS is pure, so the
            // only remaining concern is handled by the path check for non-adjacent cases.
            if (mayHaveSideEffects(loc.rhs)) continue; // belt-and-braces; pure implies this already

            decisions.push({ use: useNode, rhs: loc.rhs, drop: loc.drop, useSym: sym });
            usedDefs.add(defNode);
            usedUses.add(useNode);
        }
    }

    if (decisions.length === 0) return false;

    // Apply: replace the single use with a clone of the RHS (in place, so the parent keeps its
    // reference), then drop the def. Deepest-first is unnecessary — each use node is distinct and each
    // def is used once — but drop after all substitutions so a dropped list index cannot shift a use.
    /** Move the scope ownership of `from` onto its clone `to`.
     *
     *  `cloneNode` deliberately CLEARS `scopeId`, because a clone is normally a second copy and two
     *  nodes cannot own one scope. Here it is not a copy: the clone replaces the use and the original
     *  RHS is dropped immediately after, so this is a MOVE and the scope must travel with it.
     *
     *  Left unset, a cloned arrow function is a scope-OWNING node with no scope, and names inside it
     *  resolve from the wrong scope — `verifySemantic` reports exactly that
     *  ("scope-owning node 37 has no scopeId in maintained"). The two trees are structurally identical
     *  by construction, so a lockstep walk pairs them up. */
    const transferScopes = (from: Node, to: Node): void => {
        const sid = (from.data as { scopeId?: number } | null)?.scopeId ?? 0;
        if (sid !== 0) attachScopeNode(sem, sid, to);
        const fk: Node[] = [];
        const tk: Node[] = [];
        walkChildren(from, (c) => {
            fk.push(c);
        });
        walkChildren(to, (c) => {
            tk.push(c);
        });
        const n = Math.min(fk.length, tk.length);
        for (let i = 0; i < n; i++) transferScopes(fk[i], tk[i]);
    };

    for (const d of decisions) {
        // Find the single IdentifierReference of useSym inside the use node and overwrite it in place.
        let done = false;
        const replace = (n: Node): void => {
            if (done) return;
            if (n.type === N.IdentifierReference && (n as { sym: number }).sym === d.useSym) {
                // The reference `n` LEAVES and the cloned RHS ARRIVES in its place; neither is
                // accounted automatically because this pass walks the program itself rather than
                // through `traverse`, so there is no `ctx` and no `RefDelta`.
                subtractRefFacts(sem, n);
                const clone = cloneNode(d.rhs) as Node;
                set(n, clone.type, clone.data as never);
                (n as { name: string }).name = clone.name;
                (n as { sym: number }).sym = clone.sym;
                transferScopes(d.rhs, n);
                addRefFacts(sem, n);
                done = true;
                return;
            }
            if (isFn(n)) return;
            walkChildren(n, replace);
        };
        replace(d.use);
    }
    for (const d of decisions) d.drop();
    return true;
};

/**
 * Flow-sensitive inlining over `program`, directive-gated. Returns whether anything changed.
 * Runs in the optimize tier (before compress), which then folds and cleans up the result.
 */
let ENABLED = true;
/** Test/benchmark toggle. Newest optimize-tier pass; togglable until its win is measured. */
export const setFlowInlineEnabled = (on: boolean): void => {
    ENABLED = on;
};

export function flowInlineVariables(program: Node, semantic: Semantic, source: string): boolean {
    if (!ENABLED) return false;
    const spans = directiveSpans(source, program, DIRECTIVE.FLATTEN);
    if (spans.size === 0) return false;
    const gate = Gate.gated(spans);

    // Scope-of-node lookup: reads the scope a node OWNS (`data.scopeId`); 0 when it owns none.
    const scopeOfUse = (n: Node): number => scopeOf(semantic, n);

    let changed = false;
    // Manual DFS so the gate's active state is restored on the way out of each function (the shared
    // `walk` has no exit hook). A function is optimized iff it is itself opted in or nested inside one.
    const visit = (n: Node): void => {
        if (isFn(n)) {
            const prev = gate.enterFn(n.start);
            if (gate.active && fnInline(n, semantic, scopeOfUse)) changed = true;
            walkChildren(n, visit);
            gate.exit(prev);
            return;
        }
        walkChildren(n, visit);
    };
    visit(program);
    return changed;
}
