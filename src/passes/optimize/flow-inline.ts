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
import { lookupValue, type Semantic } from '../../analysis/semantic.ts';
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

function locateDef(list: Node[], stmt: Node, sym: number): DefLoc | null {
    if (stmt.type === N.VariableDeclaration) {
        const d = stmt.data as { kind: string; declarations: Node[] };
        for (let i = 0; i < d.declarations.length; i++) {
            const dec = d.declarations[i].data as { id: Node; init: Node | null };
            if (dec.id.type === N.BindingIdentifier && (dec.id as { sym: number }).sym === sym && dec.init !== null) {
                const init = dec.init;
                return {
                    rhs: init,
                    drop: () => {
                        if (d.declarations.length === 1) {
                            const idx = list.indexOf(stmt);
                            if (idx >= 0) list.splice(idx, 1);
                        } else if (d.kind === 'const') {
                            d.declarations.splice(i, 1);
                        } else {
                            // `let` — keep the binding, null the init (it might be read before reassigned).
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
                    if (idx >= 0) list.splice(idx, 1);
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

const fnInline = (fn: Node, sem: Semantic, scopeOfUse: (use: Node) => number): boolean => {
    const body = (fn.data as { body: Node | null }).body;
    if (body === null || body.type !== N.BlockStatement) return false;

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

            const loc = locateDef(defList, defNode, sym);
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

            // scope: every free symbol the RHS reads must resolve to the SAME binding at the use site.
            const rhsReads = new Set<number>();
            readSyms(loc.rhs, rhsReads);
            let scopeOk = true;
            for (const r of rhsReads) {
                // A tracked local of this function is fine; only free/outer names need the check.
                if (tracked.has(r)) continue;
                const nm = sem.symbols[r]?.decl?.name;
                if (nm !== undefined && lookupValue(sem, scopeOfUse(useNode), nm) !== r) {
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
    for (const d of decisions) {
        // Find the single IdentifierReference of useSym inside the use node and overwrite it in place.
        let done = false;
        const replace = (n: Node): void => {
            if (done) return;
            if (n.type === N.IdentifierReference && (n as { sym: number }).sym === d.useSym) {
                const clone = cloneNode(d.rhs) as Node;
                set(n, clone.type, clone.data as never);
                (n as { name: string }).name = clone.name;
                (n as { sym: number }).sym = clone.sym;
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

    // Scope-of-node lookup: reuse the semantic's nodeScope for scope-owning nodes, walking up otherwise.
    const scopeOfUse = (n: Node): number => semantic.nodeScope.get(n) ?? 0;

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
