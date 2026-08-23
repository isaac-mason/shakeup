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

/** Walk one function body, WITHOUT descending into nested functions (they carry their own summary —
 *  merely *defining* one has no effect). Records local impurity and the locally-resolvable callees. */
function summarize(fn: Node): Summary {
    const s: Summary = { impure: false, callees: new Set() };
    const body = bodyOf(fn);
    if (body === null) return { impure: true, callees: s.callees };
    walk(body, (n) => {
        if (s.impure) return false;
        if (n !== body && isFunctionNode(n)) return false; // nested function: its own summary
        switch (n.type) {
            // Anything that can write, throw, or run unknown code.
            case N.AssignmentExpression:
            case N.UpdateExpression:
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
                    s.callees.add(d.callee.sym);
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

/**
 * Stamp `pure` on every call to a provably side-effect-free, locally-declared function.
 * Returns whether anything was stamped.
 */
export function stampPureCalls(program: Node): boolean {
    // ── 1. Per-function summaries, keyed by the symbol the function is bound to ──
    const summaries = new Map<number, Summary>();
    walk(program, (n) => {
        if (!isFunctionNode(n)) return;
        const sym = boundSymbol(n);
        if (sym === 0) return;
        // A symbol declared twice (or reassigned) is not a stable target — drop it from consideration.
        if (summaries.has(sym)) summaries.set(sym, { impure: true, callees: new Set() });
        else summaries.set(sym, summarize(n));
    });
    if (summaries.size === 0) return false;

    // Any callee we have no summary for is unknown code → poisons its caller.
    for (const s of summaries.values()) {
        for (const c of s.callees) {
            if (!summaries.has(c)) {
                s.impure = true;
                break;
            }
        }
    }

    // ── 2. Fixpoint: impurity propagates from callee to caller ──
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

    // ── 3. Stamp calls to the survivors ──
    let stamped = false;
    walk(program, (n) => {
        if (n.type !== N.CallExpression) return;
        const d = n.data as { callee: Node; pure?: boolean };
        if (d.pure === true) return;
        if (d.callee.type !== N.IdentifierReference) return;
        const sym = (d.callee as { sym: number }).sym;
        if (sym <= 0) return;
        if (summaries.get(sym)?.impure === false) {
            d.pure = true;
            stamped = true;
        }
    });
    return stamped;
}
