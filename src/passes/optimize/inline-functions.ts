// inline-functions (DIRECT strategy) — replace a call to an `@inline`-annotated function with its
// body. Port of the DIRECT half of compilecat `passes/inline_functions.rs` (Closure `InlineFunctions`
// / `FunctionInjector`).
//
//   /* @inline */ function add(a, b) { return a + b; }
//   const x = add(p, 2);            →   const x = p + 2;
//
// DIRECT handles a body that is a single `return <expr>`. BLOCK — any other body, including one with
// interior `return`s — is spliced through `block-mutate` and lands next; the two share candidate
// collection.
//
// ── The four conditions, and why each is a correctness requirement, not a nicety ────────────────
//
//  1. ELIGIBILITY. Not async/generator (the call's value is a promise/iterator, not the body's);
//     simple identifier parameters (a pattern needs destructuring semantics we would have to
//     reproduce); no `this`/`arguments` (both re-bind at the call site); and not recursive — a
//     self-referencing body would expand forever, so it is refused rather than partially expanded.
//
//  2. ARGUMENT DUPLICATION. Substituting an argument expression for a parameter used TWICE evaluates
//     it twice. `add(next(), 1)` with `a + a` would call `next()` twice. So a parameter used more than
//     once accepts only a SIMPLE argument (identifier / literal / `this`), which is free to duplicate.
//
//  3. DROPPED EFFECTS. A parameter used ZERO times discards its argument — fine for a literal, a
//     miscompile for `f(sideEffect())`. Refused unless the argument is provably pure.
//
//  4. HYGIENE. A free variable in the body must resolve to the SAME binding at the call site. Splicing
//     `return scale * x` into a scope that has its own `scale` would silently re-bind it, so every free
//     variable is re-resolved with `lookupValue` at the call site and the inline is refused on any
//     mismatch. This also covers globals (`Math`), which a local binding at the call site can shadow.
import { isPureExpr } from '../../analysis/effects.ts';
import { lookupValue, type Semantic, scopeOf } from '../../analysis/semantic.ts';
import { cloneNode, create, N, type Node, node, ref, VAR_KIND, walk, walkChildren } from '../../ast/index.ts';
import { attachScopeNode, createScope, declareLocal, SCOPE, SYM } from '../../analysis/semantic.ts';
import { applyRefDelta, hookTable, type RefDelta, type TransformCtx, traverse, type Visitor } from '../traverse.ts';
import { isReassigned, mutateForBlockInline } from './block-mutate.ts';
import { DIRECTIVE, directiveSpans } from './directives.ts';

/** A callee whose body is spliced as a STATEMENT (any body, including interior returns). */
type BlockCandidate = {
    sym: number;
    paramSyms: number[];
    paramNames: string[];
    /** Body statements, kept in the tree; cloned per splice because `block-mutate` mutates in place. */
    body: Node[];
    free: Map<string, number>;
};

type Candidate = {
    /** Symbol of the function binding, so call sites match by binding rather than by name. */
    sym: number;
    /** Parameter binding symbols, in order. */
    paramSyms: number[];
    /** The returned expression (kept in the tree; cloned per call site). */
    value: Node;
    /** Free variables of `value`: name → the symbol it resolved to where the function was DEFINED. */
    free: Map<string, number>;
    /** How many times each parameter is read in `value`. */
    uses: number[];
};

const isFn = (n: Node): boolean =>
    n.type === N.FunctionDeclaration || n.type === N.FunctionExpression || n.type === N.ArrowFunctionExpression;

/** An argument that is free to duplicate and free to drop. */
const isSimpleArg = (n: Node): boolean =>
    n.type === N.IdentifierReference ||
    n.type === N.NumericLiteral ||
    n.type === N.StringLiteral ||
    n.type === N.BooleanLiteral ||
    n.type === N.NullLiteral ||
    n.type === N.ThisExpression;

/** Parameter binding symbols, or `null` if any parameter is not a plain identifier. */
function simpleParamSyms(params: readonly Node[]): number[] | null {
    const out: number[] = [];
    for (const p of params) {
        const pattern = (p.data as { pattern: Node; init: Node | null }).pattern;
        if (pattern.type !== N.BindingIdentifier) return null;
        if ((p.data as { init: Node | null }).init !== null) return null; // default value → not simple
        out.push((pattern as { sym: number }).sym);
    }
    return out;
}

/** The single `return <expr>` of a DIRECT-eligible body, else `null`. */
function directValue(fn: Node): Node | null {
    const d = fn.data as { body: Node | null; async?: boolean; generator?: boolean; expression?: boolean };
    if (d.async === true || d.generator === true) return null;
    const body = d.body;
    if (body === null) return null;
    // An expression-bodied arrow (`(a) => a + 1`) is already the value.
    if (body.type !== N.BlockStatement) return body;
    const stmts = (body.data as { body: Node[] }).body;
    if (stmts.length !== 1 || stmts[0].type !== N.ReturnStatement) return null;
    return (stmts[0].data as { argument: Node | null }).argument;
}

/** `this` / `arguments` re-bind at the call site, so a body reading either cannot move. */
function readsThisOrArguments(value: Node): boolean {
    let hit = false;
    walk(value, (n) => {
        if (hit) return false;
        if (isFn(n)) return false; // a nested function has its own `this`/`arguments`
        if (n.type === N.ThisExpression) hit = true;
        else if (n.type === N.IdentifierReference && n.name === 'arguments') hit = true;
        return undefined;
    });
    return hit;
}

/** Build a candidate from a function node bound to `sym`, or `null` when ineligible. */
function classifyDirect(fn: Node, sym: number): Candidate | null {
    const params = (fn.data as { params: Node[] }).params;
    const paramSyms = simpleParamSyms(params);
    if (paramSyms === null) return null;
    const value = directValue(fn);
    if (value === null || readsThisOrArguments(value)) return null;

    const uses = new Array<number>(paramSyms.length).fill(0);
    const free = new Map<string, number>();
    let recursive = false;
    walk(value, (n) => {
        if (n.type !== N.IdentifierReference) return undefined;
        const s = (n as { sym: number }).sym;
        const idx = paramSyms.indexOf(s);
        if (s !== 0 && idx !== -1) {
            uses[idx]++;
            return undefined;
        }
        if (s === sym) recursive = true; // self-reference → would expand forever
        free.set(n.name, s);
        return undefined;
    });
    if (recursive) return null;
    return { sym, paramSyms, value, free, uses };
}

/** Statements a spliced body must not contain: `try`/`with` change control flow in ways the mutator's
 *  `break LABEL` rewrite does not model, and `await`/`yield` belong to the callee's own context. */
function hasUnsupportedConstruct(stmts: readonly Node[]): boolean {
    let bad = false;
    for (const s of stmts) {
        walk(s, (n) => {
            if (bad) return false;
            if (isFn(n)) return false; // a nested function keeps its own constructs
            if (
                n.type === N.TryStatement ||
                n.type === N.AwaitExpression ||
                n.type === N.YieldExpression
            ) {
                bad = true;
            }
            return undefined;
        });
        if (bad) return true;
    }
    return false;
}

/** Build a BLOCK candidate — any body the mutator can splice — or `null` when ineligible. */
function classifyBlock(fn: Node, sym: number): BlockCandidate | null {
    const d = fn.data as { params: Node[]; body: Node | null; async?: boolean; generator?: boolean };
    if (d.async === true || d.generator === true) return null;
    const paramSyms = simpleParamSyms(d.params);
    if (paramSyms === null) return null;
    const body = d.body;
    if (body === null || body.type !== N.BlockStatement) return null;
    const stmts = (body.data as { body: Node[] }).body;
    if (hasUnsupportedConstruct(stmts)) return null;

    const paramNames = d.params.map((p) => ((p.data as { pattern: Node }).pattern).name);
    // Symbols BOUND inside the body are not free variables — they travel with the spliced code. Without
    // this, `const t = a * 2; return t;` would report `t` as free and the call-site hygiene check would
    // refuse every body that declares anything.
    const locals = new Set<number>();
    for (const st of stmts) {
        walk(st, (n) => {
            if (n.type === N.BindingIdentifier) {
                const b = (n as { sym: number }).sym;
                if (b > 0) locals.add(b);
            }
            return undefined;
        });
    }
    const free = new Map<string, number>();
    let bad = false;
    for (const st of stmts) {
        walk(st, (n) => {
            if (bad) return false;
            if (n.type === N.ThisExpression) {
                bad = true; // `this` re-binds at the call site
                return false;
            }
            if (n.type !== N.IdentifierReference) return undefined;
            if (n.name === 'arguments') {
                bad = true;
                return false;
            }
            const s = (n as { sym: number }).sym;
            if (s !== 0 && (paramSyms.includes(s) || locals.has(s))) return undefined;
            if (s === sym) {
                bad = true; // recursive
                return false;
            }
            free.set(n.name, s);
            return undefined;
        });
        if (bad) return null;
    }
    return { sym, paramSyms, paramNames, body: stmts, free };
}

/** Every declaration `collectCandidates` can classify — the span set a `@flatten` body needs, where
 *  the opt-in is on the CALLER and any resolvable callee is fair game. */
function allCandidateSpans(program: Node): Set<number> {
    const out = new Set<number>();
    walk(program, (n) => {
        if (n.type === N.FunctionDeclaration || n.type === N.VariableDeclaration) out.add(n.start);
        return undefined;
    });
    return out;
}

/** Collect `@inline`-annotated candidates, keyed by their binding symbol. */
function collectCandidates(program: Node, spans: ReadonlySet<number>): Candidates {
    const out: Candidates = { direct: new Map(), block: new Map() };
    /** DIRECT is preferred (it produces an expression); BLOCK is the fallback for any other body. */
    const add = (fn: Node, sym: number): void => {
        const d = classifyDirect(fn, sym);
        if (d !== null) {
            out.direct.set(sym, d);
            return;
        }
        const b = classifyBlock(fn, sym);
        if (b !== null) out.block.set(sym, b);
    };
    walk(program, (n) => {
        if (n.type === N.FunctionDeclaration && spans.has(n.start)) {
            const id = (n.data as { id: Node | null }).id;
            if (id !== null) add(n, (id as { sym: number }).sym);
            return undefined;
        }
        // `/* @inline */ const f = (a) => …` — the directive attaches to the declaration.
        if (n.type !== N.VariableDeclaration || !spans.has(n.start)) return undefined;
        const vd = n.data as { kind: string; declarations: Node[] };
        if (vd.kind !== 'const') return undefined; // a rebindable holder is not a stable target
        for (const decl of vd.declarations) {
            const d = decl.data as { id: Node; init: Node | null };
            if (d.init === null || !isFn(d.init) || d.id.type !== N.BindingIdentifier) continue;
            add(d.init, (d.id as { sym: number }).sym);
        }
        return undefined;
    });
    return out;
}

type Candidates = { direct: Map<number, Candidate>; block: Map<number, BlockCandidate> };

/** Whether this call site may take `cand`, given its arguments and the scope it sits in. */
function callIsInlinable(cand: Candidate, args: readonly Node[], scope: number, sem: Semantic): boolean {
    if (args.length > cand.paramSyms.length) return false; // extra args still evaluate — keep the call
    for (const a of args) if (a.type === N.SpreadElement) return false;
    for (let i = 0; i < args.length; i++) {
        const uses = cand.uses[i];
        if (uses > 1 && !isSimpleArg(args[i])) return false; // would evaluate the argument twice
        if (uses === 0 && !isPureExpr(args[i])) return false; // would discard its side effect
    }
    // Hygiene: every free variable must still resolve to the binding it had where the body was written.
    for (const [name, sym] of cand.free) {
        if (lookupValue(sem, scope, name) !== sym) return false;
    }
    return true;
}

/** A clone of `cand.value` with parameter references replaced by the matching arguments. */
function substitute(cand: Candidate, args: readonly Node[]): Node {
    return cloneNode(cand.value, (n) => {
        if (n.type !== N.IdentifierReference) return null;
        const idx = cand.paramSyms.indexOf((n as { sym: number }).sym);
        if (idx === -1) return null;
        const arg = args[idx];
        // A parameter with no matching argument is `undefined`; reuse the node shape by cloning a
        // fresh reference to the global `undefined`.
        return arg === undefined ? null : (cloneNode(arg) as Node);
    }) as Node;
}

/** A name not bound at `scope` (and not one of `avoid`), for the result temp and the break label. */
function freshName(sem: Semantic, scope: number, prefix: string, seq: number, avoid: readonly string[]): string {
    for (let i = seq; ; i++) {
        const name = `${prefix}${i}`;
        if (lookupValue(sem, scope, name) === 0 && !avoid.includes(name)) return name;
    }
}

/** Gates common to a BLOCK splice at `scope`. */
function blockIsInlinable(cand: BlockCandidate, args: readonly Node[], scope: number, sem: Semantic): boolean {
    if (args.length > cand.paramSyms.length) return false; // extra args must still be evaluated
    for (const a of args) if (a.type === N.SpreadElement) return false;
    for (const [name, sym] of cand.free) if (lookupValue(sem, scope, name) !== sym) return false;
    return true;
}

/** Make one spliced block a self-contained lexical region: its own scopes, its own symbols.
 *
 *  A splice mixes three kinds of node and all three need binding:
 *   * the wrapper `BlockStatement` and `let <result>;` prologue that `block-mutate` SYNTHESIZED — plain
 *     nodes with no `scopeId` and `sym === 0`;
 *   * the PARAMETER bindings, which the prologue introduces (`const p = arg`) OUTSIDE the cloned body;
 *   * the cloned body itself, whose bindings still carry the ORIGINAL callee's symbols.
 *
 *  Binding all of them here, after `block-mutate` has finished, avoids an ordering trap: seeding the
 *  clone with parameter symbols cannot work, because the prologue that declares them is built later.
 *
 *  Every binding gets a FRESH symbol, so the callee and each of its call sites stop sharing one symbol
 *  per local — "maintained 2 -> truth 8, but maintained 2 already maps to 2", an UNSAFE partition
 *  mismatch. References are then rebound BY NAME within the block, which is exactly the shadowing rule:
 *  if the block declares `x`, a reference to `x` inside it binds to that declaration.
 *
 *  Two passes, because a reference can appear before its binding. */
function bindSplicedBlock(sem: Semantic, root: Node, scope: number): void {
    // Keyed by SCOPE and name, not name alone. A body may bind the same name in sibling scopes —
    //   if (…) { const n = …; use(n); }
    //   const n = …;
    // — and a name-keyed map keeps only the last, then stamps BOTH references with it, orphaning the
    // first binding's symbol ("symbol partition mismatch", the unsafe direction). Resolution below
    // walks the scope chain outward so each reference finds the binding actually visible to it.
    const minted = new Map<string, number>();
    const key = (sc: number, name: string): string => `${sc}\u0000${name}`;
    const declare = (n: Node, sc: number): void => {
        const own = (n.data as { scopeId?: number } | null)?.scopeId ?? 0;
        let inner = sc;
        if (own === 0 && SCOPE_OWNERS.has(n.type)) {
            inner = createScope(sem, sc, SCOPE.BLOCK);
            attachScopeNode(sem, inner, n);
        } else if (own !== 0) {
            inner = own;
        }
        if (n.type === N.BindingIdentifier && n.name !== '') {
            minted.set(key(inner, n.name), declareLocal(sem, n, inner, SYM.LET));
        }
        walkChildren(n, (c) => {
            declare(c, inner);
        });
    };
    declare(root, scope);

    /** The innermost minted binding for `name` visible from `chain`, or undefined. */
    const mintedFor = (chain: readonly number[], name: string): number | undefined => {
        for (let i = chain.length - 1; i >= 0; i--) {
            const sym = minted.get(key(chain[i], name));
            if (sym !== undefined) return sym;
        }
        return undefined;
    };

    const stamp = (n: Node, chain: number[]): void => {
        const own = (n.data as { scopeId?: number } | null)?.scopeId ?? 0;
        const pushed = own !== 0 && own !== chain[chain.length - 1];
        if (pushed) chain.push(own);
        if (n.type === N.IdentifierReference) {
            const sym = mintedFor(chain, n.name);
            if (sym !== undefined) {
                // Declared inside the block — shadowing wins.
                (n as { sym: number }).sym = sym;
            } else if ((n as { sym: number }).sym === 0 && n.name !== '') {
                // NOT declared here, and still unbound: `block-mutate` writes the call's result into
                // the CALLER's binding (`const x = callee(...)` makes `x` the result name), so it emits
                // `x = …` with a synthesized node that has no symbol. Resolve it against the enclosing
                // scope — leaving it at 0 reads as "'x' unbound in maintained, bound in truth", the
                // direction where a live symbol looks dead and its declaration gets deleted.
                (n as { sym: number }).sym = lookupValue(sem, scope, n.name);
            }
        }
        walkChildren(n, (c) => stamp(c, chain));
        if (pushed) chain.pop();
    };
    stamp(root, [scope]);
}

/** Node types that OWN a lexical scope and so need one minted when synthesized. */
const SCOPE_OWNERS = new Set<number>([
    N.BlockStatement,
    N.StaticBlock,
    // The rest own a scope too (their `create` carries a `scopeId`), and a spliced body containing a
    // loop or a catch reaches them. Omitting one leaves a scope-owning node with no scopeId, which
    // resolves its contents from the enclosing scope — the unsafe direction.
    N.CatchClause,
    N.ForStatement,
    N.ForInStatement,
    N.ForOfStatement,
    N.SwitchStatement,
]);

/** Whether `name` is BOUND anywhere inside `stmts` — a local, a nested function's param, a catch
 *  clause. Substituting an argument that reads `name` into such a body would silently capture that
 *  inner binding instead of the caller's. */
function bindsName(stmts: readonly Node[], name: string): boolean {
    let hit = false;
    for (const st of stmts) {
        walk(st, (n) => {
            if (hit) return false;
            if (n.type === N.BindingIdentifier && n.name === name) hit = true;
            return undefined;
        });
        if (hit) return true;
    }
    return false;
}

/**
 * Whether `arg` can be written at each USE of its parameter rather than bound once up front.
 *
 * A prologue binding is an ALIAS, and an alias is where scalar replacement stops: SROA refuses a
 * buffer that is ever used as a whole object, so `const out = _m;` is enough to keep a module scratch
 * array allocated and index-addressed for the rest of the function. Substituting leaves `_m[0]` in the
 * body, which SROA can take apart. This is compilecat's `FunctionArgumentInjector`.
 *
 * Only a CONST binding qualifies. Binding captures the argument's value at entry; substituting
 * re-reads the variable at each use, and the two differ the moment anything the body runs reassigns
 * it — a call into a closure over that variable is enough. `const` makes the two identical by
 * construction, and covers what this exists for (module scratch is declared `const`). A literal would
 * be equally safe but is left to `const`-propagation, which already handles it.
 */
const substitutableArg = (arg: Node, sem: Semantic): boolean => {
    if (arg.type !== N.IdentifierReference) return false;
    const sym = (arg as { sym: number }).sym;
    if (sym <= 0) return false;
    const rec = sem.symbols[sym];
    return rec !== undefined && (rec.flags & SYM.CONST) !== 0;
};

/** The spliced statement for one call, or `null` when refused. `resultName` is `null` in statement
 *  position (the value is discarded). */
function buildSplice(
    cand: BlockCandidate,
    args: readonly Node[],
    scope: number,
    sem: Semantic,
    resultName: string | null,
    seq: number,
): Node | null {
    if (!blockIsInlinable(cand, args, scope, sem)) return null;
    const avoid = cand.paramNames;
    const label = freshName(sem, scope, '_L', seq, avoid);
    const result = resultName ?? freshName(sem, scope, '_r', seq, avoid);

    // An argument that READS one of the callee's parameter NAMES would capture the prologue binding
    // instead of the caller's (`const a = a` — a TDZ error, and silently wrong if it resolved). The
    // names collide constantly in numeric code, where helpers are written `(out, a, b)` and callers
    // hold variables of the same names, so refusing the splice would refuse most real call sites.
    // α-rename the offending parameters instead, which is what compilecat does.
    const argNames = new Set<string>();
    for (const a of args) {
        walk(a, (n) => {
            if (n.type === N.IdentifierReference) argNames.add(n.name);
            return undefined;
        });
    }
    let paramNames = cand.paramNames;
    const renames = new Map<number, string>();
    for (let i = 0; i < paramNames.length; i++) {
        if (!argNames.has(paramNames[i])) continue;
        const fresh = freshName(sem, scope, `_p${i}`, seq, [...paramNames, ...argNames]);
        if (paramNames === cand.paramNames) paramNames = cand.paramNames.slice();
        paramNames[i] = fresh;
        const sym = cand.paramSyms[i];
        if (sym > 0) renames.set(sym, fresh);
    }

    const bodyStmts = cand.body.map((st) => cloneNode(st) as Node);

    // The callee's own LOCALS collide the same way, and the splice puts them in the SAME scope as the
    // prologue that evaluates the arguments:
    //
    //   { const nodeIndex = topo[idx * 5]; const topo = t.topo; … }
    //      ↑ the CALLER's `topo`             ↑ the CALLEE's, shadowing it for the whole block
    //
    // which is not "silently wrong" but a hard `ReferenceError: Cannot access 'topo' before
    // initialization` — the argument reads the binding in its temporal dead zone. Renaming the param
    // above does not help, because the shadowing name is not a param. Rename these too, by symbol.
    if (argNames.size > 0) {
        const taken = [...paramNames, ...argNames];
        let unrenamable = false;
        for (const st of bodyStmts) {
            walk(st, (n) => {
                if (n.type !== N.BindingIdentifier || !argNames.has(n.name)) return undefined;
                const sym = (n as { sym: number }).sym;
                // A binding with no symbol cannot be renamed BY symbol, and renaming it by NAME would
                // catch the caller's references too. Nothing here makes the splice safe, so refuse it.
                if (sym <= 0) {
                    unrenamable = true;
                    return false;
                }
                if (!renames.has(sym)) {
                    const fresh = freshName(sem, scope, `_s${renames.size}`, seq, taken);
                    taken.push(fresh);
                    renames.set(sym, fresh);
                }
                return undefined;
            });
        }
        if (unrenamable) return null;
    }

    if (renames.size > 0) {
        // by SYMBOL, not name: a local inside the body that shadows a parameter carries a different
        // symbol and must keep its own name. Both halves of a local's rename — the BINDING and every
        // reference to it — key off the same symbol.
        for (const st of bodyStmts) {
            walk(st, (n) => {
                if (n.type !== N.IdentifierReference && n.type !== N.BindingIdentifier) return undefined;
                const to = renames.get((n as { sym: number }).sym);
                if (to !== undefined) (n as { name: string }).name = to;
                return undefined;
            });
        }
    }

    // ── Substitute what can be substituted; bind the rest ──
    // See `substitutableArg`. Everything that stays in `boundNames` gets block-mutate's `const p = arg`
    // prologue, which is still the only correct home for a reassigned parameter or a side-effecting
    // argument (it must be evaluated exactly once).
    const passedCount = Math.max(Math.min(args.length, paramNames.length), 0);
    const boundNames: string[] = [];
    const boundArgs: Node[] = [];
    const subs = new Map<number, Node>();
    for (let i = 0; i < passedCount; i++) {
        const arg = args[i];
        const psym = cand.paramSyms[i];
        if (
            psym > 0 &&
            substitutableArg(arg, sem) &&
            !bindsName(bodyStmts, (arg as { name: string }).name) &&
            !isReassigned(bodyStmts, paramNames[i])
        ) {
            subs.set(psym, arg);
            continue;
        }
        boundNames.push(paramNames[i]);
        boundArgs.push(cloneNode(arg) as Node);
    }
    if (subs.size > 0) {
        // In place, by SYMBOL — same reason the α-rename above is: a body local that shadows the
        // parameter carries its own symbol and must be left alone. Rewriting the reference's name and
        // symbol (rather than swapping the node) keeps every parent slot untouched.
        for (const st of bodyStmts) {
            walk(st, (n) => {
                if (n.type !== N.IdentifierReference) return undefined;
                const to = subs.get((n as { sym: number }).sym);
                if (to !== undefined) {
                    (n as { name: string }).name = (to as { name: string }).name;
                    (n as { sym: number }).sym = (to as { sym: number }).sym;
                }
                return undefined;
            });
        }
    }

    const out = mutateForBlockInline({
        // `block-mutate` mutates its input in place, so every splice gets its own copy — and each copy
        // needs its OWN scopes and symbols. `cloneNode` clears `scopeId` and copies `sym`, so without
        // this every inlined copy of a callee shares one binding per local with the original and with
        // every other call site: "no scopeId in maintained" plus "symbol partition mismatch", both
        // UNSAFE. Done here, before `block-mutate` rewrites the statements, while the clone still
        // pairs structurally with its source.
        // Plain clone: `bindSplicedBlock` below rebinds the whole spliced block in one pass, so
        // seeding scopes/symbols here would only be overwritten (and could not cover the PARAMETERS,
        // which the prologue declares after this point).
        bodyStmts,
        params: boundNames,
        args: boundArgs,
        label,
        resultName: result,
        needsResult: resultName !== null,
    });
    bindSplicedBlock(sem, out.block, scope);
    return out.block;
}

/** `let <name>;` */
const letDecl = (name: string): Node =>
    create.VariableDeclaration(0, 0, VAR_KIND.LET, [
        create.VariableDeclarator(0, 0, 0, node(N.BindingIdentifier, 0, 0, name, null), null, null),
    ]);

/** The call a statement shape wraps, plus where its result must land. */
function callOf(expr: Node): Node | null {
    return expr.type === N.CallExpression ? expr : null;
}

/**
 * Module-scope declarations whose binding a `@flatten` body reads.
 *
 * `@flatten` means "inline what this function calls". A hot numeric function's scratch buffer is part
 * of that function's data, and its initialiser is code the function depends on:
 *
 *   const _m = vec3.create();                  // ← reached, because `f` reads `_m`
 *   \/* @optimize *\/ function f() { _m[0] = 1; … }
 *
 * Reaching it matters because of what comes NEXT: SROA can only take a buffer apart when it can see
 * the value is FRESH, and only a literal proves that. `vec3.create()` is opaque, so the buffer stays
 * an array and every access stays a load. Inlining the factory makes the initialiser `[0, 0, 0]` and
 * the ordinary literal path applies. Inferring the shape from the accesses instead would be the
 * unsound shortcut: it approves `const out = res`, an ALIAS, whose scalars swallow every write.
 *
 * Only the DIRECT path can fire here — a module-scope initialiser is an expression slot, and a BLOCK
 * splice needs a statement — so a factory with a multi-statement body is left alone by construction.
 */
function flattenedBufferDecls(program: Node, flattenSpans: ReadonlySet<number>): Set<Node> {
    const out = new Set<Node>();
    if (flattenSpans.size === 0) return out;
    const bodies: Node[] = [];
    walk(program, (n) => {
        if (isFn(n) && flattenSpans.has(n.start)) bodies.push(n);
        return undefined;
    });
    if (bodies.length === 0) return out;
    const used = new Set<number>();
    for (const f of bodies) {
        walk(f, (n) => {
            if (n.type === N.IdentifierReference) {
                const sym = (n as { sym: number }).sym;
                if (sym > 0) used.add(sym);
            }
            return undefined;
        });
    }
    for (const st of (program.data as { body: Node[] }).body) {
        const vd =
            st.type === N.VariableDeclaration
                ? st
                : st.type === N.ExportNamedDeclaration
                  ? ((st.data as { declaration: Node | null }).declaration ?? null)
                  : null;
        if (vd === null || vd.type !== N.VariableDeclaration) continue;
        for (const dtor of (vd.data as { declarations: Node[] }).declarations) {
            const d = dtor.data as { id: Node; init: Node | null };
            if (d.id.type !== N.BindingIdentifier || d.init === null) continue;
            if (used.has((d.id as { sym: number }).sym)) {
                out.add(vd);
                break;
            }
        }
    }
    return out;
}

/**
 * The four STATEMENT SHAPES a block-inlined call can sit in, as hooks.
 *
 * A BLOCK splice produces STATEMENTS, so it can only replace a call that a statement slot holds:
 *
 *   f(args);             → { … }
 *   x = f(args);         → { … x = … }
 *   const x = f(args);   → let x; { … x = … }
 *   return f(args);      → let _r; { … _r = … } return _r;
 *
 * Shared by the LOCAL and the CROSS-MODULE pass, which differ only in how a callee resolves to a
 * donor — and that is all `blockFor` is. They did not used to share it: the cross-module pass grew
 * the FIRST shape and no other, so an imported out-param helper called the way one actually is —
 * `applied = part.warmStart(…)`, `const t = part.warmStart(…)` — stayed a call, while the identical
 * helper inside the module inlined fine. One donor lookup, one set of shapes.
 */
function blockSpliceHooks(
    semantic: Semantic,
    blockFor: (call: Node) => BlockCandidate | undefined,
    seq: { n: number },
): { expressionStatement: (n: Node, ctx: TransformCtx) => void; list: (n: Node, ctx: TransformCtx) => void } {
    const argsOf = (call: Node): Node[] => (call.data as { arguments: Node[] }).arguments;

    /** Splice `const x = f(args);` declarations found directly in a statement list. */
    const listHook = (n: Node, ctx: TransformCtx): void => {
        const field = n.type === N.SwitchCase ? 'consequent' : 'body';
        const list = (n.data as Record<string, Node[]>)[field];
        if (!Array.isArray(list)) return;
        // Statements in this container live in the container's OWN scope, not the enclosing one.
        const scope = scopeOf(semantic, n) || ctx.currentScope;
        for (let i = 0; i < list.length; i++) {
            const st = list[i];
            // `return f(args);` → `let _r; { … _r = … } return _r;`. Two statements again, so it is
            // handled here rather than by a replaceWith on the return itself.
            if (st.type === N.ReturnStatement) {
                const arg = (st.data as { argument: Node | null }).argument;
                if (arg === null) continue;
                const rcall = callOf(arg);
                if (rcall === null) continue;
                const rcand = blockFor(rcall);
                if (rcand === undefined) continue;
                // Eligibility first: declaring the result binding below is a semantic mutation, and a
                // refused splice would leave it stranded.
                if (!blockIsInlinable(rcand, argsOf(rcall), scope, semantic)) continue;
                const name = freshName(semantic, scope, '_r', seq.n, rcand.paramNames);
                // `let _r;` is SYNTHESIZED, so it carries no symbol. Declare it before splicing: the
                // block's own `_r = …` writes resolve against the enclosing scope during
                // `bindSplicedBlock`, and the trailing `return _r;` is stamped from the same symbol.
                // Leaving it at 0 reads as "'_r' unbound in maintained, bound in truth" — the
                // direction where a live binding looks dead and its declaration can be deleted.
                const rdecl = letDecl(name);
                const rid = ((rdecl.data as { declarations: Node[] }).declarations[0].data as { id: Node }).id;
                const rsym = declareLocal(semantic, rid, scope, SYM.LET);
                const rblock = buildSplice(rcand, argsOf(rcall), scope, semantic, name, seq.n++);
                if (rblock === null) continue;
                // `block-mutate` emits one `_r = …` per return path, each a synthesized node with no
                // symbol. Stamp them from the binding declared above rather than leaving them to be
                // resolved by name.
                walk(rblock, (n) => {
                    if (n.type === N.IdentifierReference && n.name === name && (n as { sym: number }).sym === 0) {
                        (n as { sym: number }).sym = rsym;
                    }
                    return undefined;
                });
                const rref = ref(name);
                (rref as { sym: number }).sym = rsym;
                ctx.spliceStatements(list, i, 1, rdecl, rblock, create.ReturnStatement(0, 0, 0, rref));
                i += 2;
                continue;
            }
            if (st.type !== N.VariableDeclaration) continue;
            const vd = st.data as { declarations: Node[] };
            if (vd.declarations.length !== 1) continue;
            const d = vd.declarations[0].data as { id: Node; init: Node | null };
            if (d.init === null || d.id.type !== N.BindingIdentifier) continue;
            const call = callOf(d.init);
            if (call === null) continue;
            const cand = blockFor(call);
            if (cand === undefined) continue;
            const name = d.id.name;
            const block = buildSplice(cand, argsOf(call), scope, semantic, name, seq.n++);
            if (block === null) continue;
            // `const x = callee(...)` becomes `let x; { … x = … }` — the SAME binding, re-spelled. So
            // carry the original symbol onto the new declarator and repoint the table's `decl` at it,
            // rather than leaving a synthesized `BindingIdentifier` with `sym === 0` ("'x' unbound in
            // maintained, bound in truth", the direction where a live symbol looks dead).
            const decl = letDecl(name);
            const origSym = (d.id as { sym: number }).sym;
            if (origSym > 0) {
                const idNode = ((decl.data as { declarations: Node[] }).declarations[0].data as { id: Node }).id;
                (idNode as { sym: number }).sym = origSym;
                const rec = semantic.symbols[origSym];
                if (rec !== undefined) rec.decl = idNode;
            }
            // `ctx.spliceStatements`, not a raw splice: the replaced declaration's references have to
            // leave the maintained counts and the spliced block's have to enter them.
            ctx.spliceStatements(list, i, 1, decl, block);
            i++; // skip the block we just inserted
        }
    };

    /** `f(args);` and `x = f(args);` — both replace the statement in place. */
    const expressionStatement = (n: Node, ctx: TransformCtx): void => {
                const expr = (n.data as { expression: Node }).expression;
                // `f(args);` — the value is discarded.
                const bare = callOf(expr);
                if (bare !== null) {
                    const cand = blockFor(bare);
                    if (cand === undefined) return;
                    const block = buildSplice(cand, argsOf(bare), ctx.currentScope, semantic, null, seq.n++);
                    if (block !== null) ctx.replaceWith(block);
                    return;
                }
                // `x = f(args);` — assign straight into the existing binding.
                if (expr.type !== N.AssignmentExpression) return;
                const a = expr.data as { operator: string; left: Node; right: Node };
                if (a.operator !== '=' || a.left.type !== N.IdentifierReference) return;
                const call = callOf(a.right);
                if (call === null) return;
                const cand = blockFor(call);
                if (cand === undefined) return;
                const block = buildSplice(cand, argsOf(call), ctx.currentScope, semantic, a.left.name, seq.n++);
                if (block !== null) ctx.replaceWith(block);
    };

    return { expressionStatement, list: listHook };
}


/**
 * Inline calls to `@inline`-annotated functions. Returns whether anything changed.
 * The now-unreferenced declaration is left for `drop-unused`/treeshake to remove.
 */
export function inlineFunctions(program: Node, semantic: Semantic, source: string): boolean {
    const spans = directiveSpans(source, program, DIRECTIVE.INLINE);
    // `@flatten` (and `@optimize`, which implies it) is a CALLER-side bulk directive: every resolvable
    // call inside the annotated body behaves as if its call site carried `/* @inline */`. So the
    // candidate set inside such a body is every function the module can classify, not just the
    // annotated donors.
    const flattenSpans = directiveSpans(source, program, DIRECTIVE.FLATTEN);
    if (spans.size === 0 && flattenSpans.size === 0) return false;
    const cands = collectCandidates(program, spans);
    const flat = flattenSpans.size > 0 ? collectCandidates(program, allCandidateSpans(program)) : null;
    const nothingToDo =
        cands.direct.size === 0 &&
        cands.block.size === 0 &&
        (flat === null || (flat.direct.size === 0 && flat.block.size === 0));
    if (nothingToDo) return false;

    // Depth of `@flatten` bodies we are inside; the flat candidate set only applies within one.
    let flattenDepth = 0;
    const flatBuffers = flattenedBufferDecls(program, flattenSpans);
    const directFor = (sym: number): Candidate | undefined =>
        cands.direct.get(sym) ?? (flattenDepth > 0 ? flat?.direct.get(sym) : undefined);

    const seq = { n: 0 };
    /** The BLOCK candidate a call resolves to, if any. */
    const blockFor = (call: Node): BlockCandidate | undefined => {
        const d = call.data as { callee: Node; optional: boolean };
        if (d.optional || d.callee.type !== N.IdentifierReference) return undefined;
        const sym = (d.callee as { sym: number }).sym;
        return cands.block.get(sym) ?? (flattenDepth > 0 ? flat?.block.get(sym) : undefined);
    };
    const { expressionStatement, list: listHook } = blockSpliceHooks(semantic, blockFor, seq);

    const visitor: Visitor = {
        name: 'inlineFunctions',
        // BLOCK splices happen on ENTER at the STATEMENT level: the body becomes a statement, so it
        // can only replace a call sitting in one of the shapes `blockSpliceHooks` handles.
        enter: hookTable({
            [N.ExpressionStatement]: expressionStatement,
            // `const x = f(args);` and `return f(args);` are handled on the enclosing statement LIST
            // rather than on the statement itself: each rewrite produces TWO statements, which a
            // single-child slot (`export const x = f()`, a `for` initialiser) cannot hold. Working on
            // the list also means such a slot is simply skipped rather than throwing.
            [N.Program]: listHook,
            [N.BlockStatement]: listHook,
            [N.StaticBlock]: listHook,
            [N.SwitchCase]: listHook,
            [N.FunctionDeclaration]: (n: Node) => { if (flattenSpans.has(n.start)) flattenDepth++; },
            [N.FunctionExpression]: (n: Node) => { if (flattenSpans.has(n.start)) flattenDepth++; },
            [N.ArrowFunctionExpression]: (n: Node) => { if (flattenSpans.has(n.start)) flattenDepth++; },
            [N.VariableDeclaration]: (n: Node) => { if (flatBuffers.has(n)) flattenDepth++; },
        }),
        // DIRECT replaces the call expression itself, on EXIT so a nested `@inline` argument is
        // already inlined by the time this fires.
        exit: hookTable({
            [N.FunctionDeclaration]: (n: Node) => { if (flattenSpans.has(n.start)) flattenDepth--; },
            [N.FunctionExpression]: (n: Node) => { if (flattenSpans.has(n.start)) flattenDepth--; },
            [N.ArrowFunctionExpression]: (n: Node) => { if (flattenSpans.has(n.start)) flattenDepth--; },
            [N.VariableDeclaration]: (n: Node) => { if (flatBuffers.has(n)) flattenDepth--; },
            [N.CallExpression]: (n: Node, ctx: TransformCtx) => {
                const d = n.data as { callee: Node; arguments: Node[]; optional: boolean };
                if (d.optional || d.callee.type !== N.IdentifierReference) return;
                const cand = directFor((d.callee as { sym: number }).sym);
                if (cand === undefined) return;
                if (!callIsInlinable(cand, d.arguments, ctx.currentScope, semantic)) return;
                ctx.replaceWith(substitute(cand, d.arguments));
            },
        }),
    };
    // Thread a `RefDelta`: without one, `ctx.dropRefs`/`addRefs` are NO-OPS, so references this pass
    // moves never reach the maintained counts. That is the UNDER-count direction — a live symbol looks
    // dead and `dropUnused` deletes a declaration still in use — invisible today only because the
    // optimize tier is followed by a full rebuild.
    const delta = new Map<number, RefDelta>();
    const changed = traverse(program, semantic, [visitor], delta);
    applyRefDelta(semantic, delta);
    return changed;
}

// ── Cross-module `@inline` ──────────────────────────────────────────────────────────────────────
//
// A call to an `@inline` function IMPORTED from another module. compilecat implements this by
// re-reading the donor file as a plugin; shakeup does not need to — after `link` the donor is already
// parsed, analysed and bound, so the donor body is simply there to be read.
//
// THE CROSS-MODULE HYGIENE PROBLEM, and the v1 answer: a free variable in the donor body refers to a
// binding in the DONOR's module scope, which generally does not exist in the consumer — splicing the
// body across the boundary would produce a dangling reference. compilecat solves the general case by
// dragging the donor's dependencies along with it. Here we take the sound subset: a donor is eligible
// only when every free variable is a GLOBAL (unresolved in the donor), and each of those still
// resolves to a global at the call site. That covers the self-contained helper — the shape `@inline`
// is written for — and refuses everything else rather than emitting a broken reference.

/** Candidates exported by one module, keyed by the symbol they are bound to in THAT module. */
export function moduleInlineCandidates(program: Node, source: string): Map<number, Candidate> {
    const spans = directiveSpans(source, program, DIRECTIVE.INLINE);
    if (spans.size === 0) return new Map();
    return collectCandidates(program, spans).direct;
}

/** The BLOCK half of the same set — statement-bodied donors, which is how an out-param helper is
 *  written. Dropping these was why the tier did nothing across a module boundary. */
export function moduleBlockCandidates(program: Node, source: string): Map<number, BlockCandidate> {
    const spans = directiveSpans(source, program, DIRECTIVE.INLINE);
    if (spans.size === 0) return new Map();
    return collectCandidates(program, spans).block;
}

/** True when every free variable of `cand` is a global in the donor — the only shape that can move
 *  between modules without carrying its dependencies. */
const freeVarsAllGlobal = (cand: { free: ReadonlyMap<string, number> }): boolean => {
    for (const sym of cand.free.values()) if (sym !== 0) return false;
    return true;
};

/**
 * Inline calls to `@inline` functions imported from another module, across the whole graph.
 * Returns consumer module index → the DONOR modules it inlined from: the consumer's AST now depends
 * on another module's source, which the parse cache cannot see on its own.
 */
export function inlineCrossModule(
    modules: readonly { program: Node; semantic: Semantic; source: string; namedImports: ReadonlyMap<number, unknown> }[],
    resolveImport: (moduleIdx: number, sym: number) => { mod: number; sym: number } | null,
    /** `ns.name(…)` where `ns` is a namespace import. A numeric package is reached this way almost
     *  exclusively (`import { mat4 } from 'math'` over `export * as mat4 from './mat4.ts'`), so
     *  without it the whole tier is inert on such a consumer. */
    resolveMember?: (moduleIdx: number, sym: number, name: string) => { mod: number; sym: number } | null,
): Map<number, Set<number>> {
    // Donor candidates per module, built lazily — most modules annotate nothing.
    const donorCache = new Map<number, Map<number, Candidate>>();
    const blockDonorCache = new Map<number, Map<number, BlockCandidate>>();
    // `@flatten` in the CONSUMER makes any resolvable callee fair game, including donors the
    // producing module never annotated — which is the only way a third-party math package (shipped
    // without directives) can be inlined at all.
    const flatDonorCache = new Map<number, Candidates>();
    const flatDonorsOf = (i: number): Candidates => {
        let c = flatDonorCache.get(i);
        if (c === undefined) {
            c = collectCandidates(modules[i].program, allCandidateSpans(modules[i].program));
            flatDonorCache.set(i, c);
        }
        return c;
    };
    const donorsOf = (idx: number): Map<number, Candidate> => {
        let c = donorCache.get(idx);
        if (c === undefined) {
            c = moduleInlineCandidates(modules[idx].program, modules[idx].source);
            donorCache.set(idx, c);
        }
        return c;
    };

    const changed = new Map<number, Set<number>>();
    for (let idx = 0; idx < modules.length; idx++) {
        const mod = modules[idx];
        const producers = new Set<number>();
        const blockSeq = { n: 0 };
        const flattenSpans = directiveSpans(mod.source, mod.program, DIRECTIVE.FLATTEN);
        let flattenDepth = 0;
        const flatBuffers = flattenedBufferDecls(mod.program, flattenSpans);
        /** The donor module and symbol a callee names, for a bare import or a namespace member. */
        const targetOf = (callee: Node): { mod: number; sym: number } | null => {
            if (callee.type === N.IdentifierReference) {
                const localSym = (callee as { sym: number }).sym;
                if (localSym <= 0 || !mod.namedImports.has(localSym)) return null;
                return resolveImport(idx, localSym);
            }
            if (callee.type !== N.StaticMemberExpression || resolveMember === undefined) return null;
            const m = callee.data as { object: Node; property: Node; optional?: boolean };
            if (m.optional === true || m.object.type !== N.IdentifierReference) return null;
            const objSym = (m.object as { sym: number }).sym;
            if (objSym <= 0) return null;
            const name = (m.property as { name?: string }).name;
            if (name === undefined) return null;
            return resolveMember(idx, objSym, name);
        };

        /** The imported BLOCK donor a call resolves to, subject to the same cross-module hygiene
         *  gate as the DIRECT path: every free name must be a global on both sides. */
        const importedBlock = (call: Node): BlockCandidate | undefined => {
            const d = call.data as { callee: Node; optional: boolean };
            if (d.optional) return undefined;
            const target = targetOf(d.callee);
            if (target === null || target.mod === idx) return undefined;
            let c = blockDonorCache.get(target.mod);
            if (c === undefined) {
                c = moduleBlockCandidates(modules[target.mod].program, modules[target.mod].source);
                blockDonorCache.set(target.mod, c);
            }
            const cand = c.get(target.sym) ?? (flattenDepth > 0 ? flatDonorsOf(target.mod).block.get(target.sym) : undefined);
            if (cand === undefined || !freeVarsAllGlobal(cand)) return undefined;
            producers.add(target.mod);
            return cand;
        };
        // Statement positions: the SAME four shapes the local pass handles, from the same factory.
        // A BLOCK body becomes statements, so unlike the DIRECT path it cannot replace the call
        // expression in place.
        const { expressionStatement, list: listHook } = blockSpliceHooks(mod.semantic, importedBlock, blockSeq);
        const visitor: Visitor = {
            name: 'inlineCrossModule',
            enter: hookTable({
                [N.FunctionDeclaration]: (n: Node) => { if (flattenSpans.has(n.start)) flattenDepth++; },
                [N.FunctionExpression]: (n: Node) => { if (flattenSpans.has(n.start)) flattenDepth++; },
                [N.ArrowFunctionExpression]: (n: Node) => { if (flattenSpans.has(n.start)) flattenDepth++; },
                [N.VariableDeclaration]: (n: Node) => { if (flatBuffers.has(n)) flattenDepth++; },
                [N.ExpressionStatement]: expressionStatement,
                [N.Program]: listHook,
                [N.BlockStatement]: listHook,
                [N.StaticBlock]: listHook,
                [N.SwitchCase]: listHook,
            }),
            exit: hookTable({
                [N.FunctionDeclaration]: (n: Node) => { if (flattenSpans.has(n.start)) flattenDepth--; },
                [N.FunctionExpression]: (n: Node) => { if (flattenSpans.has(n.start)) flattenDepth--; },
                [N.ArrowFunctionExpression]: (n: Node) => { if (flattenSpans.has(n.start)) flattenDepth--; },
                [N.VariableDeclaration]: (n: Node) => { if (flatBuffers.has(n)) flattenDepth--; },
                [N.CallExpression]: (n: Node, ctx: TransformCtx) => {
                    const d = n.data as { callee: Node; arguments: Node[]; optional: boolean };
                    if (d.optional) return;
                    const target = targetOf(d.callee);
                    if (target === null || target.mod === idx) return;
                    const cand =
                        donorsOf(target.mod).get(target.sym) ??
                        (flattenDepth > 0 ? flatDonorsOf(target.mod).direct.get(target.sym) : undefined);
                    if (cand === undefined || !freeVarsAllGlobal(cand)) return;
                    // Argument gates are the same as the local case; hygiene reduces to "each free
                    // name is still a global here", which `callIsInlinable` checks via `lookupValue`.
                    if (!callIsInlinable(cand, d.arguments, ctx.currentScope, mod.semantic)) return;
                    producers.add(target.mod);
                    ctx.replaceWith(substitute(cand, d.arguments));
                },
            }),
        };
        // Do not traverse a module that CANNOT contain an inlinable call. The hook only ever fires on
        // a call whose callee is a named import resolving to an `@inline` donor in another module, and
        // that is decidable in O(imports) from tables we already hold — whereas the traversal it
        // guards is O(nodes) and, on a graph with no `@inline` at all, finds nothing in any module.
        // Counting traversals rather than reading a profile is what surfaced this: it was 1 of the 12
        // whole-program walks a three.core.js build performed, and that file imports nothing.
        let reachesDonor = false;
        for (const localSym of mod.namedImports.keys()) {
            const target = resolveImport(idx, localSym);
            if (target === null || target.mod === idx) continue;
            if (donorsOf(target.mod).has(target.sym)) {
                reachesDonor = true;
                break;
            }
            // BLOCK donors count too, or a module importing only out-param helpers is skipped.
            let bc = blockDonorCache.get(target.mod);
            if (bc === undefined) {
                bc = moduleBlockCandidates(modules[target.mod].program, modules[target.mod].source);
                blockDonorCache.set(target.mod, bc);
            }
            if (bc.has(target.sym)) {
                reachesDonor = true;
                break;
            }
        }
        if (!reachesDonor && flattenSpans.size === 0) continue;
        // A RefDelta, as in the local pass: a BLOCK splice introduces bindings AND references, and
        // without one `ctx.addRefs` is a no-op, so the prologue's `const out = arg` looks unreferenced
        // and `dropUnused` deletes it while the spliced body still reads `out`.
        const delta = new Map<number, RefDelta>();
        const touched = traverse(mod.program, mod.semantic, [visitor], delta);
        applyRefDelta(mod.semantic, delta);
        if (touched) changed.set(idx, producers);
    }
    return changed;
}
