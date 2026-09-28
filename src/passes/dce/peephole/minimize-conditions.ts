// Port of oxc_minifier/src/peephole/minimize_conditions.rs, the functions tree-shake mode reaches.

import { N, type Node, node } from '../../../ast/index.ts';
import { type DceCtx, type Span, takeNode } from '../traverse-context.ts';
import { minimizeLogicalExpression } from './minimize-logical-expression.ts';

/** Rotate `a op (b op c)` into `(a op b) op c` and `(a, b) op c` into `a, b op c`. `op` must be
 *  associative. `a` and `b` are detached nodes. */
export function joinWithLeftAssociativeOp(ctx: DceCtx, span: Span, operator: string, a: Node, b: Node): Node {
    if (a.type === N.SequenceExpression) {
        const expressions = a.data.expressions as Node[];
        const right = expressions.pop();
        if (right !== undefined) expressions.push(joinWithLeftAssociativeOp(ctx, span, operator, right, b));
        return a;
    }
    let left: Node = a;
    let right: Node = b;
    while (right.type === N.LogicalExpression && right.data.operator === operator) {
        const innerLeft = takeNode(ctx, right.data.left);
        left = joinWithLeftAssociativeOp(ctx, span, operator, left, innerLeft);
        right = takeNode(ctx, right.data.right);
    }
    const logicalExpression = node(N.LogicalExpression, span.start, span.end, '', { operator, left, right });
    minimizeLogicalExpression(ctx, logicalExpression);
    return logicalExpression;
}

/** The identifier, or the identifier a plain `=` assignment targets. */
export function extractIdOrAssignToId(expr: Node): Node | null {
    switch (expr.type) {
        case N.IdentifierReference:
            return expr;
        case N.AssignmentExpression:
            if (expr.data.operator === '=' && expr.data.left.type === N.IdentifierReference) return expr.data.left;
            return null;
        default:
            return null;
    }
}
