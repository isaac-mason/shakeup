// Interprocedural purity — a summary of which locally-declared functions are side-effect-free, so a
// call to one can be dropped when its result is unused.
//
// Port of the SHAPE of Closure's `PureFunctionIdentifier` (compilecat `analysis/purity.rs`): a
// per-function summary plus a reverse-call-graph fixpoint that propagates callee effects to callers.
//
// ── The contract is shakeup's, NOT compilecat's ────────────────────────────────────────────────
// compilecat's port assumes `assumeGettersArePure = true`. shakeup assumes the OPPOSITE (`effects.ts`
// treats every member access as potentially running a getter), and shakeup's DELETION passes
// (`drop-unused`, `remove-unused-expr`) act on that verdict. Importing compilecat's optimistic answer
// would therefore drop getter-triggering or throwing calls — a miscompile. So the analysis is
// recomputed here under shakeup's stricter rules: a member access, a `throw`, a `new`, an assignment,
// `await`/`yield`, `delete`, or a call to anything unresolved all make a function impure.
//
// The single documented relaxation is `Math.*` (see `isKnownPureCallee`), which every minifier
// assumes is not monkey-patched and which is what makes the analysis useful on real numeric code.
//
// OUTPUT: `CallExpression.pure` is stamped on calls to proven-pure functions — the SAME flag
// `/*@__PURE__*/` sets, which `isPureExpr` already honours. `isPureExpr` stays the deletion primitive;
// this only ever supplies it with more information.
//
// SCOPE (v1): module-local. Compress runs per-module in SCAN, so a link-stage (cross-module) summary
// would be computed too late for the passes that consume it. Within one module this still covers the
// common case — helpers declared and called in the same file — and, for a scope-hoisted bundle, the
// bundle IS one module.
import { N, type Node, walk } from '../ast.ts';
import { markInferredPure } from './effects.ts';
import { type Graph, type Linked, packRef } from '../graph-types.ts';

/** A call to `Math.<anything>()` on the GLOBAL `Math` (unresolved binding). The Math methods are
 *  specified as pure numeric functions; like every other minifier we assume the global is not
 *  monkey-patched. `Math.random()` counts as pure too: it is non-deterministic but has no OBSERVABLE
 *  side effect, so dropping an unused call to it changes nothing. */
function isKnownPureCallee(callee: Node): boolean {
    if (callee.type !== N.StaticMemberExpression) return false;
    const d = callee.data as { object: Node; optional: boolean };
    if (d.optional) return false;
    return d.object.type === N.IdentifierReference && d.object.name === 'Math' && d.object.sym === 0;
}

/** The body of a function-ish node, or `null`. */
const bodyOf = (fn: Node): Node | null => (fn.data as { body: Node | null }).body;

const isFunctionNode = (n: Node): boolean =>
    n.type === N.FunctionDeclaration || n.type === N.FunctionExpression || n.type === N.ArrowFunctionExpression;

type Summary = { impure: boolean; callees: Set<number> };

/** Every symbol BOUND inside `fn` — parameters and local declarations. Writing to one of these is
 *  unobservable from outside the call, so it must not poison the summary; without this, any function
 *  with an accumulator (`let s = 0; … s += x`) would be classed impure and nothing numeric would ever
 *  be provably pure. Nested functions are skipped: their own bindings are not this function's locals
 *  (missing a nested declaration's name only costs precision, never soundness). */
function collectLocals(fn: Node): Set<number> {
    const locals = new Set<number>();
    walk(fn, (n) => {
        if (n !== fn && isFunctionNode(n)) return false;
        if (n.type === N.BindingIdentifier) {
            const sym = (n as { sym: number }).sym ?? 0;
            if (sym > 0) locals.add(sym);
        }
        return;
    });
    return locals;
}

/** A write target that is a plain reference to one of `locals`. */
function isLocalTarget(target: Node, locals: Set<number>): boolean {
    if (target.type !== N.IdentifierReference && target.type !== N.BindingIdentifier) return false;
    const sym = (target as { sym: number }).sym ?? 0;
    return sym > 0 && locals.has(sym);
}

/** Walk one function body, WITHOUT descending into nested functions (they carry their own summary —
 *  merely *defining* one has no effect). Records local impurity and the locally-resolvable callees. */
function summarize(fn: Node, resolve: (sym: number) => number | null): Summary {
    const s: Summary = { impure: false, callees: new Set() };
    const body = bodyOf(fn);
    if (body === null) return { impure: true, callees: s.callees };
    const locals = collectLocals(fn);
    walk(body, (n) => {
        if (s.impure) return false;
        if (n !== body && isFunctionNode(n)) return false; // nested function: its own summary
        switch (n.type) {
            // Writing to a LOCAL is invisible to the caller; anything else is a real effect.
            case N.AssignmentExpression: {
                const d = n.data as { left: Node };
                if (isLocalTarget(d.left, locals)) return; // keep walking: the RHS is still checked
                s.impure = true;
                return false;
            }
            case N.UpdateExpression: {
                const d = n.data as { argument: Node };
                if (isLocalTarget(d.argument, locals)) return false;
                s.impure = true;
                return false;
            }
            // Anything that can throw or run unknown code.
            case N.ThrowStatement:
            case N.NewExpression:
            case N.AwaitExpression:
            case N.YieldExpression:
            case N.TaggedTemplateExpression:
            // Member access — a getter may run arbitrary code (shakeup's standing contract).
            case N.StaticMemberExpression:
            case N.ComputedMemberExpression:
                s.impure = true;
                return false;
            case N.UnaryExpression:
                if ((n.data as { operator: string }).operator === 'delete') {
                    s.impure = true;
                    return false;
                }
                return;
            case N.CallExpression: {
                const d = n.data as { callee: Node; arguments: Node[] };
                if (isKnownPureCallee(d.callee)) {
                    // Skip the callee (its member access is the allow-listed one) but still visit args.
                    for (const a of d.arguments) walk(a, (m) => visitArg(m, s));
                    return false;
                }
                if (d.callee.type === N.IdentifierReference && d.callee.sym > 0) {
                    const key = resolve(d.callee.sym);
                    if (key === null) {
                        s.impure = true; // resolves outside the analysed set (e.g. an external import)
                        return false;
                    }
                    s.callees.add(key);
                    return; // arguments are visited by the outer walk
                }
                s.impure = true; // unresolved / computed callee — unknown code
                return false;
            }
            default:
                return;
        }
    });
    return s;
}

/** Re-enter the main rules for an argument subtree of an allow-listed call. */
function visitArg(n: Node, s: Summary): boolean | void {
    if (s.impure) return false;
    if (isFunctionNode(n)) return false;
    switch (n.type) {
        case N.AssignmentExpression:
        case N.UpdateExpression:
        case N.NewExpression:
        case N.AwaitExpression:
        case N.YieldExpression:
        case N.TaggedTemplateExpression:
        case N.StaticMemberExpression:
        case N.ComputedMemberExpression:
            s.impure = true;
            return false;
        case N.CallExpression: {
            const d = n.data as { callee: Node };
            if (isKnownPureCallee(d.callee)) return;
            s.impure = true;
            return false;
        }
        default:
            return;
    }
}

/** The symbol a function node is bound to (`function f(){}` / `const f = () => {}`), else 0. */
function boundSymbol(n: Node): number {
    if (n.type === N.FunctionDeclaration) {
        const id = (n.data as { id: Node | null }).id;
        return id === null ? 0 : ((id as { sym: number }).sym ?? 0);
    }
    return 0;
}

/** Record one function under `sym`, degrading to impure if the symbol is bound more than once. */
function record(summaries: Map<number, Summary>, k: number, fn: Node, resolve: (sym: number) => number | null): void {
    if (summaries.has(k)) summaries.set(k, { impure: true, callees: new Set() });
    else summaries.set(k, summarize(fn, resolve));
}

/** Collect summaries for every bound function in `program`, keyed by `key(sym)`. */
function collect(program: Node, summaries: Map<number, Summary>, key: (sym: number) => number, resolve: (sym: number) => number | null): void {
    walk(program, (n) => {
        // `function f() {}` — the name is bound by the declaration itself.
        if (isFunctionNode(n)) {
            const sym = boundSymbol(n);
            if (sym !== 0) record(summaries, key(sym), n, resolve);
            return;
        }
        // `const f = () => {}` / `const f = function () {}` — by far the more common shape in modern
        // source, and invisible from the function node itself. Restricted to `const`: a `let`/`var`
        // holding a function can be reassigned, which would invalidate the summary. (This runs before
        // `substituteAlternateSyntax` rewrites `const` → `let`, so the kind is still intact.)
        if (n.type !== N.VariableDeclaration) return;
        const vd = n.data as { kind: string; declarations: Node[] };
        if (vd.kind !== 'const') return;
        for (const decl of vd.declarations) {
            const d = decl.data as { id: Node; init: Node | null };
            if (d.init === null || !isFunctionNode(d.init)) continue;
            if (d.id.type !== N.BindingIdentifier) continue;
            const sym = (d.id as { sym: number }).sym ?? 0;
            if (sym > 0) record(summaries, key(sym), d.init, resolve);
        }
    });
}

/** Propagate impurity callee→caller to a fixed point, poisoning anything that calls out of the set. */
function solve(summaries: Map<number, Summary>): void {
    for (const s of summaries.values()) {
        for (const c of s.callees) {
            if (!summaries.has(c)) {
                s.impure = true;
                break;
            }
        }
    }
    for (let changed = true; changed; ) {
        changed = false;
        for (const s of summaries.values()) {
            if (s.impure) continue;
            for (const c of s.callees) {
                if (summaries.get(c)?.impure === true) {
                    s.impure = true;
                    changed = true;
                    break;
                }
            }
        }
    }
}

/** Stamp `pure` on calls in `program` whose callee resolves to a proven-pure summary. */
function stamp(program: Node, summaries: Map<number, Summary>, key: (sym: number) => number | null): boolean {
    let stamped = false;
    walk(program, (n) => {
        if (n.type !== N.CallExpression) return;
        const d = n.data as { callee: Node; pure?: boolean };
        if (d.pure === true) return;
        if (d.callee.type !== N.IdentifierReference) return;
        const sym = (d.callee as { sym: number }).sym;
        if (sym <= 0) return;
        const k = key(sym);
        if (k !== null && summaries.get(k)?.impure === false) {
            markInferredPure(n);
            stamped = true;
        }
    });
    return stamped;
}

/**
 * Stamp `pure` on every call to a provably side-effect-free, locally-declared function.
 * Returns whether anything was stamped.
 */
export function stampPureCalls(program: Node): boolean {
    const summaries = new Map<number, Summary>();
    const id = (sym: number): number => sym;
    collect(program, summaries, id, id);
    if (summaries.size === 0) return false;

    solve(summaries);
    return stamp(program, summaries, id);
}

/**
 * Cross-module purity over the whole linked graph, stamping calls in EVERY module.
 *
 * Runs between link and treeshake, which is the point where it pays: `treeshake` roots any top-level
 * statement `isPureStatement` rejects, and that in turn consults `CallExpression.pure`. So proving an
 * IMPORTED helper pure lets treeshake drop a discarded call to it — something the per-module pass in
 * `runCompress` cannot see, because scan analyses each module before any of them are bound together.
 *
 * A callee that leaves the analysed set (an external package, a namespace import, an unresolved bind)
 * is treated as unknown code and poisons its caller, exactly like an unresolved local callee.
 */
export function stampPureCallsGraph(graph: Graph, linked: Linked): boolean {
    /** Local symbol → a graph-wide key, following an import to the symbol that actually defines it. */
    const resolveIn =
        (idx: number) =>
        (sym: number): number | null => {
            if (!graph.modules[idx].namedImports.has(sym)) return packRef(idx, sym);
            const bind = linked.binds.get(packRef(idx, sym));
            return bind !== undefined && bind.kind === 'found' ? bind.ref : null;
        };

    const summaries = new Map<number, Summary>();
    for (let idx = 0; idx < graph.modules.length; idx++) {
        const mod = graph.modules[idx];
        if (mod.program === null) continue;
        collect(mod.program, summaries, (sym) => packRef(idx, sym), resolveIn(idx));
    }
    if (summaries.size === 0) return false;
    solve(summaries);

    let stamped = false;
    for (let idx = 0; idx < graph.modules.length; idx++) {
        const mod = graph.modules[idx];
        if (mod.program === null) continue;
        if (stamp(mod.program, summaries, resolveIn(idx))) stamped = true;
    }
    return stamped;
}
