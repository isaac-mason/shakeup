// dead-store elimination — drop an assignment whose value is never read.
//
//   function f() { let x = 1; x = 2; return x; }   →   function f() { let x = 1; return x; }
//                                    ^ the `1` store is dead
//
// Port of compilecat `dead_assignments.rs` (Closure `DeadAssignmentsElimination`), over the structured
// liveness in `analysis/liveness.ts`.
//
// This is the ONE compress pass with an irreducible control-flow dependency, and it is the cleanup
// that makes aggressive inlining pay off: block-inlining emits a result temp assigned across several
// `break LABEL` branches, and only a flow-sensitive analysis can tell which of those stores survive.
//
// SAFETY:
//   • Only FUNCTION-LOCAL bindings are considered. A local captured by a nested function is excluded
//     entirely, since the closure may read it at any time.
//   • A dead store's right-hand side is KEPT when it has side effects — `x = f()` becomes `f()`, never
//     nothing. Only a provably pure right-hand side lets the statement go.
//   • A function whose flow the analysis cannot model (a `try`, an unresolved `break` target) is
//     skipped wholesale.
import { buildCfg } from '../../analysis/cfg.ts';
import { computeLiveVars } from '../../analysis/live-vars.ts';
import { computeLiveness } from '../../analysis/liveness.ts';
import { isPureExpr } from '../../analysis/effects.ts';
import { N, type Node, statementListOf, walk } from '../../ast.ts';
import * as create from '../../parser/create.ts';
import { hookTable, traverse, type TransformCtx, type Visitor } from '../traverse.ts';
import type { Semantic } from '../../analysis/semantic.ts';
import { DIRECTIVE, directiveSpans } from './directives.ts';
import { Gate } from './gate.ts';

const isFn = (n: Node): boolean =>
    n.type === N.FunctionDeclaration || n.type === N.FunctionExpression || n.type === N.ArrowFunctionExpression;

/** Symbols bound directly in `fn` (params + locals), and those a NESTED function can still reach. */
function scopeSymbols(fn: Node): { locals: Set<number>; escaped: Set<number> } {
    const locals = new Set<number>();
    const escaped = new Set<number>();
    walk(fn, (n) => {
        if (n !== fn && isFn(n)) {
            // Anything this nested function reads may be observed later — treat as escaping.
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

/** `x = <expr>` in statement position, where `x` is tracked. */
function deadCandidate(stmt: Node, tracked: ReadonlySet<number>): { sym: number; value: Node } | null {
    if (stmt.type !== N.ExpressionStatement) return null;
    const e = (stmt.data as { expression: Node }).expression;
    if (e.type !== N.AssignmentExpression) return null;
    const a = e.data as { operator: string; left: Node; right: Node };
    if (a.operator !== '=' || a.left.type !== N.IdentifierReference) return null;
    const s = (a.left as { sym: number }).sym;
    return tracked.has(s) ? { sym: s, value: a.right } : null;
}

/**
 * Which liveness driver dead-store uses. Both compute the SAME answer — `tst/cfg-equivalence.test.ts`
 * asserts exact agreement across three.core.js — so this exists to migrate safely, not to choose
 * between two behaviours.
 *
 * The one real difference is COVERAGE: the structural walker bails on a function containing `try`
 * (and, before it was fixed, on labelled `continue`), skipping it entirely. The CFG models exception
 * edges, so it analyses those functions and can additionally suppress a kill that an exception might
 * skip past (a "conditional kill"). So `'cfg'` should be a strict superset of `'structural'`.
 */
export type LivenessDriver = 'structural' | 'cfg';
let DRIVER: LivenessDriver = 'structural';
export const setLivenessDriver = (d: LivenessDriver): void => {
    DRIVER = d;
};
export const getLivenessDriver = (): LivenessDriver => DRIVER;

/** Live-out lookup for `body`, or null when the driver cannot model this function's flow. */
function liveOutOf(body: Node, tracked: ReadonlySet<number>): ((stmt: Node) => ReadonlySet<number> | null) | null {
    if (DRIVER === 'cfg') {
        // Never bails — that is the point of the CFG.
        const flow = computeLiveVars(buildCfg(body), tracked, EMPTY);
        return flow.liveOut;
    }
    const map = computeLiveness(body, tracked, EMPTY);
    return map === null ? null : (stmt: Node) => map.get(stmt) ?? null;
}

const EMPTY: ReadonlySet<number> = new Set<number>();

const fnHook = (fn: Node, ctx: TransformCtx): void => {
    const body = (fn.data as { body: Node | null }).body;
    if (body === null || body.type !== N.BlockStatement) return;

    const { locals, escaped } = scopeSymbols(fn);
    const tracked = new Set([...locals].filter((s) => !escaped.has(s)));
    if (tracked.size === 0) return;

    const liveOut = liveOutOf(body, tracked);
    if (liveOut === null) return; // flow this driver does not model — skip the function

    // Rewrite dead stores in every statement list inside this function.
    let changed = false;
    walk(body, (n) => {
        if (n !== body && isFn(n)) return false;
        const stmts = statementListOf(n);
        if (stmts === null) return undefined;
        for (let i = 0; i < stmts.length; i++) {
            const cand = deadCandidate(stmts[i], tracked);
            if (cand === null) continue;
            const after = liveOut(stmts[i]);
            if (after === null || after.has(cand.sym)) continue; // no answer, or still read — keep it
            if (isPureExpr(cand.value)) {
                stmts.splice(i, 1);
                i--;
            } else {
                // The value is dead but the computation is not: keep only its effects.
                stmts[i] = create.ExpressionStatement(stmts[i].start, stmts[i].end, 0, cand.value);
            }
            changed = true;
        }
        return undefined;
    });
    if (changed) ctx.changed = true;
};

export const deadStore: Visitor = {
    name: 'deadStore',
    enter: hookTable({
        [N.FunctionDeclaration]: fnHook,
        [N.FunctionExpression]: fnHook,
        [N.ArrowFunctionExpression]: fnHook,
    }),
    exit: null,
};

/**
 * Directive-gated entry point — the way this pass is actually run.
 *
 * WHY IT LIVES IN THE OPTIMIZE TIER. Measured: with dead-store on vs off, output is BYTE-IDENTICAL on
 * both corpora (three.core.js 381,846 and crashcat 410,263), while it cost ~8% of every build. It earns
 * nothing on code that has not opted in, and that is not a surprise — it is a port of Closure's
 * `DeadAssignmentsElimination`, oxc's peephole minifier has NO equivalent (deliberately: flow-sensitive
 * analysis is not what a peephole minifier does), and compilecat gates it to `@optimize` functions.
 * Running it ungated inside the minify loop put a Closure-lineage flow pass in the tier whose oracle is
 * oxc, and paid for it on every build.
 *
 * Its real job is cleaning up after aggressive inlining — the `result = X; break L;` scaffolding that
 * block-inlining emits — which only happens under a directive. So it runs here, where that scaffolding
 * exists, and `output.optimize: false` switches it off with the rest of the tier.
 */
export function eliminateDeadStores(program: Node, semantic: Semantic, source: string): boolean {
    const spans = directiveSpans(source, program, DIRECTIVE.FLATTEN);
    if (spans.size === 0) return false;
    const gate = Gate.gated(spans);
    const stack: boolean[] = [];
    const gated: Visitor = {
        name: 'deadStore',
        enter: hookTable({
            [N.FunctionDeclaration]: (n, ctx) => {
                stack.push(gate.enterFn(n.start));
                if (gate.active) fnHook(n, ctx);
            },
            [N.FunctionExpression]: (n, ctx) => {
                stack.push(gate.enterFn(n.start));
                if (gate.active) fnHook(n, ctx);
            },
            [N.ArrowFunctionExpression]: (n, ctx) => {
                stack.push(gate.enterFn(n.start));
                if (gate.active) fnHook(n, ctx);
            },
        }),
        exit: hookTable({
            [N.FunctionDeclaration]: () => gate.exit(stack.pop() ?? false),
            [N.FunctionExpression]: () => gate.exit(stack.pop() ?? false),
            [N.ArrowFunctionExpression]: () => gate.exit(stack.pop() ?? false),
        }),
    };
    return traverse(program, semantic, [gated]);
}
