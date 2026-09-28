// Port of oxc_minifier/src/peephole/minimize_conditions.rs.

import { evaluateValueInContext, isInt32OrUint32, numericLiteralValue, valueType } from '../../../analysis/const-eval.ts';
import { mayHaveSideEffects } from '../../../analysis/side-effects.ts';
import { N, type Node, node } from '../../../ast/index.ts';
import { ReferenceFlags } from '../syntax.ts';
import {
    type DceCtx,
    getReference,
    isGlobalReference,
    replaceExpression,
    type Span,
    supportsFeature,
    takeNode,
} from '../traverse-context.ts';
import {
    hasNoSideEffectForEvaluationSameTarget,
    markAssignmentTargetAsRead,
    minimizeLogicalExpression,
} from './minimize-logical-expression.ts';

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

const isEquality = (operator: string): boolean =>
    operator === '==' || operator === '!=' || operator === '===' || operator === '!==';

const isNumber0 = (expr: Node): boolean => expr.type === N.NumericLiteral && numericLiteralValue(expr) === 0;

const logicalNot = (span: Span, argument: Node): Node =>
    node(N.UnaryExpression, span.start, span.end, '', { operator: '!', prefix: true, argument });

/** `typeof foo === 'number'` => `typeof foo == 'number'`, `a instanceof b === false` =>
 *  `!(a instanceof b)`, `x >> +y !== 0` => `!!(x >> +y)`. */
export function minimizeBinary(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.BinaryExpression) return;
    const data = expr.data;
    if (!isEquality(data.operator)) return;
    // `NaN == 0` and `!NaN` differ, so require proof that the left side is a non-NaN Number.
    if (isNumber0(data.right) && isInt32OrUint32(data.left, ctx)) {
        let newExpr = logicalNot(expr, takeNode(ctx, data.left));
        if (data.operator === '!=' || data.operator === '!==') newExpr = logicalNot(expr, newExpr);
        replaceExpression(ctx, expr, newExpr);
        return;
    }
    const left = valueType(data.left, ctx);
    const right = valueType(data.right, ctx);
    if (left === 'undetermined' || right === 'undetermined') return;
    if (left === right) {
        if (data.operator === '!==') data.operator = '!=';
        else if (data.operator === '===') data.operator = '==';
    }
    if (left !== 'boolean') return;
    if (mayHaveSideEffects(data.right, ctx)) return;
    const value = evaluateValueInContext(data.right, ctx);
    if (value === null || value.kind !== 'boolean') return;
    let b = value.value;
    switch (data.operator) {
        case '!=':
        case '!==':
            data.operator = '==';
            b = !b;
            break;
        case '===':
            data.operator = '==';
            break;
        case '==':
            break;
        default:
            return;
    }
    const newExpr = b ? takeNode(ctx, data.left) : logicalNot(expr, takeNode(ctx, data.left));
    replaceExpression(ctx, expr, newExpr);
}

/** `foo == true` => `foo == 1`, `foo != false` => `foo != 0`: `IsLooselyEqual` converts booleans to
 *  numbers first. */
export function minimizeLooseBoolean(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.BinaryExpression) return;
    const data = expr.data;
    if (data.operator !== '==' && data.operator !== '!=') return;
    const leftValue = evaluateValueInContext(data.left, ctx);
    if (leftValue !== null && leftValue.kind === 'boolean' && !mayHaveSideEffects(data.left, ctx)) {
        const newLeft = node(N.NumericLiteral, data.left.start, data.left.end, leftValue.value ? '1' : '0', null);
        replaceExpression(ctx, data.left, newLeft);
        return;
    }
    const rightValue = evaluateValueInContext(data.right, ctx);
    if (rightValue !== null && rightValue.kind === 'boolean' && !mayHaveSideEffects(data.right, ctx)) {
        const newRight = node(N.NumericLiteral, data.right.start, data.right.end, rightValue.value ? '1' : '0', null);
        replaceExpression(ctx, data.right, newRight);
    }
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

/** `a = a || b` => `a ||= b`, for resolved identifiers only: a global `a` could be a setter. */
export function minimizeNormalAssignmentToCombinedLogicalAssignment(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.AssignmentExpression) return;
    if (!supportsFeature(ctx, 'ES2021LogicalAssignmentOperators') || expr.data.operator !== '=') return;
    const logicalExpr = expr.data.right as Node;
    if (logicalExpr.type !== N.LogicalExpression) return;
    const writeIdRef = expr.data.left as Node;
    const readIdRef = logicalExpr.data.left as Node;
    if (writeIdRef.type !== N.IdentifierReference || readIdRef.type !== N.IdentifierReference) return;
    if (writeIdRef.name !== readIdRef.name || isGlobalReference(ctx, writeIdRef)) return;

    getReference(ctx, writeIdRef).flags |= ReferenceFlags.Read;

    const newOperator = `${logicalExpr.data.operator}=`;
    const newRight = takeNode(ctx, logicalExpr.data.right);
    expr.data.operator = newOperator;
    replaceExpression(ctx, logicalExpr, newRight);
}

const BINARY_TO_ASSIGNMENT = new Set(['+', '-', '*', '/', '%', '**', '<<', '>>', '>>>', '|', '^', '&']);

/** `a = a + b` => `a += b`. */
export function minimizeNormalAssignmentToCombinedAssignment(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.AssignmentExpression || expr.data.operator !== '=') return;
    const binaryExpr = expr.data.right as Node;
    if (binaryExpr.type !== N.BinaryExpression) return;
    if (!BINARY_TO_ASSIGNMENT.has(binaryExpr.data.operator)) return;
    const newOperator = `${binaryExpr.data.operator}=`;
    if (!hasNoSideEffectForEvaluationSameTarget(ctx, expr.data.left, binaryExpr.data.left)) return;

    markAssignmentTargetAsRead(ctx, expr.data.left);

    const newRight = takeNode(ctx, binaryExpr.data.right);
    expr.data.operator = newOperator;
    replaceExpression(ctx, binaryExpr, newRight);
}

const isSimpleAssignmentTarget = (target: Node): boolean =>
    target.type === N.IdentifierReference ||
    target.type === N.StaticMemberExpression ||
    target.type === N.ComputedMemberExpression ||
    target.type === N.PrivateFieldExpression ||
    target.type === N.TSAsExpression ||
    target.type === N.TSSatisfiesExpression ||
    target.type === N.TSNonNullExpression;

/** `a -= 1` => `--a`, `a -= -1` => `++a`. */
export function minimizeAssignmentToUpdateExpression(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.AssignmentExpression || expr.data.operator !== '-=') return;
    const right = expr.data.right as Node;
    if (right.type !== N.NumericLiteral) return;
    const value = numericLiteralValue(right);
    let operator: string;
    if (value === 1) operator = '--';
    else if (value === -1) operator = '++';
    else return;
    if (!isSimpleAssignmentTarget(expr.data.left)) return;
    const target = takeNode(ctx, expr.data.left);
    replaceExpression(
        ctx,
        expr,
        node(N.UpdateExpression, expr.start, expr.end, '', { operator, prefix: true, argument: target }),
    );
}
