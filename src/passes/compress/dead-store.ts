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
import { computeLiveness } from '../../analysis/liveness.ts';
import { isPureExpr } from '../../analysis/effects.ts';
import { N, type Node, walk } from '../../ast.ts';
import * as create from '../../parser/create.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

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

const fnHook = (fn: Node, ctx: TransformCtx): void => {
    const body = (fn.data as { body: Node | null }).body;
    if (body === null || body.type !== N.BlockStatement) return;

    const { locals, escaped } = scopeSymbols(fn);
    const tracked = new Set([...locals].filter((s) => !escaped.has(s)));
    if (tracked.size === 0) return;

    const liveOut = computeLiveness(body, tracked, new Set());
    if (liveOut === null) return; // flow this analysis does not model — skip the function

    // Rewrite dead stores in every statement list inside this function.
    let changed = false;
    walk(body, (n) => {
        if (n !== body && isFn(n)) return false;
        if (n.data === null) return undefined; // data-less leaf (identifier, literal)
        const field = n.type === N.SwitchCase ? 'consequent' : 'body';
        const list = (n.data as Record<string, unknown>)[field];
        if (!Array.isArray(list)) return undefined;
        const stmts = list as Node[];
        for (let i = 0; i < stmts.length; i++) {
            const cand = deadCandidate(stmts[i], tracked);
            if (cand === null) continue;
            const after = liveOut.get(stmts[i]);
            if (after === undefined || after.has(cand.sym)) continue; // still read — keep it
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
