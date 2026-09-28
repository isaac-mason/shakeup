// Port of oxc_minifier/src/peephole/minimize_not_expression.rs, the functions tree-shake mode reaches.

import { valueType } from '../../../analysis/const-eval.ts';
import { type DataOf, N, type Node, node } from '../../../ast/index.ts';
import { type DceCtx, replaceExpression, type Span, takeNode } from '../traverse-context.ts';
import { minimizeExpressionInBooleanContext } from './minimize-expression-in-boolean-context.ts';

/** `!expr`, simplified. `expr` is a detached node. */
export function minimizeNot(ctx: DceCtx, span: Span, expr: Node): Node {
    const unary = node(N.UnaryExpression, span.start, span.end, '', { operator: '!', prefix: true, argument: expr });
    minimizeUnary(ctx, unary);
    return unary;
}

const isEquality = (operator: string): boolean =>
    operator === '==' || operator === '!=' || operator === '===' || operator === '!==';

function equalityInverseOperator(operator: string): string {
    switch (operator) {
        case '==':
            return '!=';
        case '!=':
            return '==';
        case '===':
            return '!==';
        default:
            return '===';
    }
}

/** esbuild's `MaybeSimplifyNot`. */
export function minimizeUnary(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.UnaryExpression || expr.data.operator !== '!') return;
    minimizeExpressionInBooleanContext(ctx, expr.data.argument);
    const argument = expr.data.argument as Node;
    switch (argument.type) {
        // `!!true` -> `true`
        case N.UnaryExpression:
            if (argument.data.operator === '!' && valueType(argument.data.argument, ctx) === 'boolean') {
                replaceExpression(ctx, expr, takeNode(ctx, argument.data.argument));
            }
            return;
        // `!(a == b)` => `a != b`
        case N.BinaryExpression:
            if (isEquality(argument.data.operator)) {
                argument.data.operator = equalityInverseOperator(argument.data.operator);
                replaceExpression(ctx, expr, takeNode(ctx, argument));
            }
            return;
        // `!(a == b || c == d)` => `a != b && c != d`, only when every comparison in the chain inverts
        // its operator in place and the inversion adds no parentheses.
        case N.LogicalExpression: {
            const delta = deMorganParenDelta(argument);
            if (delta !== null && delta <= 0) {
                deMorganInvertLogical(argument);
                replaceExpression(ctx, expr, takeNode(ctx, argument));
            }
            return;
        }
        // `!(a, b)` => `a, !b`
        case N.SequenceExpression: {
            const expressions = argument.data.expressions as Node[];
            const lastExpr = expressions[expressions.length - 1];
            if (lastExpr !== undefined) {
                const newLast = minimizeNot(ctx, lastExpr, takeNode(ctx, lastExpr));
                replaceExpression(ctx, lastExpr, newLast);
                replaceExpression(ctx, expr, takeNode(ctx, argument));
            }
            return;
        }
    }
}

/** Characters of parentheses De Morgan's law adds or removes, or null when some operand cannot invert
 *  its operator in place. */
function deMorganParenDelta(expr: Node): number | null {
    const data = expr.data as DataOf<'LogicalExpression'>;
    const operator = data.operator;
    if (operator !== '&&' && operator !== '||') return null;
    let delta = 0;
    for (const side of [data.left, data.right]) {
        if (side.type === N.BinaryExpression && isEquality(side.data.operator)) continue;
        if (side.type !== N.LogicalExpression) return null;
        const childDelta = deMorganParenDelta(side);
        if (childDelta === null) return null;
        delta += childDelta;
        // `&&` under `||` prints bare but its inversion (`||` under `&&`) needs parens.
        if (operator === '||' && side.data.operator === '&&') delta += 2;
        else if (operator === '&&' && side.data.operator === '||') delta -= 2;
    }
    return delta;
}

function deMorganInvertLogical(expr: Node): void {
    const data = expr.data as DataOf<'LogicalExpression'>;
    data.operator = data.operator === '&&' ? '||' : '&&';
    deMorganInvert(data.left);
    deMorganInvert(data.right);
}

function deMorganInvert(expr: Node): void {
    if (expr.type === N.BinaryExpression) expr.data.operator = equalityInverseOperator(expr.data.operator);
    else deMorganInvertLogical(expr);
}
