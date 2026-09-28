// Port of oxc_minifier/src/peephole/minimize_expression_in_boolean_context.rs.

import { getSideFreeBooleanValue, isInt32OrUint32, numericLiteralValue } from '../../../analysis/const-eval.ts';
import { N, type Node, node } from '../../../ast/index.ts';
import { symbolValueOf } from '../symbol-state.ts';
import { type DceCtx, getReference, replaceExpression, takeNode } from '../traverse-context.ts';
import { joinWithLeftAssociativeOp } from './minimize-conditions.ts';
import { minimizeNot } from './minimize-not-expression.ts';

const isEquality = (operator: string): boolean =>
    operator === '==' || operator === '!=' || operator === '===' || operator === '!==';

const isNumber0 = (expr: Node): boolean => expr.type === N.NumericLiteral && numericLiteralValue(expr) === 0;

/** Simplify an expression whose value is only used as a boolean, e.g. an `if` test. esbuild's
 *  `SimplifyBooleanExpr`. */
export function minimizeExpressionInBooleanContext(ctx: DceCtx, expr: Node): void {
    switch (expr.type) {
        // "!!a" => "a"
        case N.UnaryExpression: {
            if (expr.data.operator !== '!') return;
            const inner = expr.data.argument as Node;
            if (inner.type === N.UnaryExpression && inner.data.operator === '!') {
                const moved = takeNode(ctx, inner.data.argument);
                minimizeExpressionInBooleanContext(ctx, moved);
                replaceExpression(ctx, expr, moved);
            }
            return;
        }
        case N.BinaryExpression: {
            const operator = expr.data.operator as string;
            if (!isEquality(operator) || !isNumber0(expr.data.right) || !isInt32OrUint32(expr.data.left, ctx)) return;
            const argument = takeNode(ctx, expr.data.left);
            // `if ((a | b) !== 0)` -> `if (a | b)`, `if ((a | b) === 0)` -> `if (!(a | b))`
            const newExpr =
                operator === '!==' || operator === '!='
                    ? argument
                    : node(N.UnaryExpression, expr.start, expr.end, '', { operator: '!', prefix: true, argument });
            replaceExpression(ctx, expr, newExpr);
            return;
        }
        case N.LogicalExpression: {
            const operator = expr.data.operator as string;
            if (operator === '&&') {
                // "if (!!a && !!b)" => "if (a && b)"
                minimizeExpressionInBooleanContext(ctx, expr.data.left);
                minimizeExpressionInBooleanContext(ctx, expr.data.right);
                // "if (anything && truthyNoSideEffects)" => "if (anything)"
                if (getSideFreeBooleanValue(expr.data.right, ctx) === true)
                    replaceExpression(ctx, expr, takeNode(ctx, expr.data.left));
            } else if (operator === '||') {
                // "if (!!a || !!b)" => "if (a || b)"
                minimizeExpressionInBooleanContext(ctx, expr.data.left);
                minimizeExpressionInBooleanContext(ctx, expr.data.right);
                // "if (anything || falsyNoSideEffects)" => "if (anything)"
                if (getSideFreeBooleanValue(expr.data.right, ctx) === false)
                    replaceExpression(ctx, expr, takeNode(ctx, expr.data.left));
            }
            return;
        }
        case N.ConditionalExpression: {
            // "if (a ? !!b : !!c)" => "if (a ? b : c)"
            minimizeExpressionInBooleanContext(ctx, expr.data.consequent);
            minimizeExpressionInBooleanContext(ctx, expr.data.alternate);
            const consequentBoolean = getSideFreeBooleanValue(expr.data.consequent, ctx);
            if (consequentBoolean !== null) {
                const right = takeNode(ctx, expr.data.alternate);
                const left = takeNode(ctx, expr.data.test);
                const span = { start: expr.start, end: expr.end };
                // "if (anything1 ? truthyNoSideEffects : anything2)" => "if (anything1 || anything2)"
                // "if (anything1 ? falsyNoSideEffects : anything2)" => "if (!anything1 && anything2)"
                const newExpr = consequentBoolean
                    ? joinWithLeftAssociativeOp(ctx, span, '||', left, right)
                    : joinWithLeftAssociativeOp(ctx, span, '&&', minimizeNot(ctx, left, left), right);
                replaceExpression(ctx, expr, newExpr);
                return;
            }
            const alternateBoolean = getSideFreeBooleanValue(expr.data.alternate, ctx);
            if (alternateBoolean !== null) {
                const left = takeNode(ctx, expr.data.test);
                const right = takeNode(ctx, expr.data.consequent);
                const span = { start: expr.start, end: expr.end };
                // "if (anything1 ? anything2 : truthyNoSideEffects)" => "if (!anything1 || anything2)"
                // "if (anything1 ? anything2 : falsyNoSideEffects)" => "if (anything1 && anything2)"
                const newExpr = alternateBoolean
                    ? joinWithLeftAssociativeOp(ctx, span, '||', minimizeNot(ctx, left, left), right)
                    : joinWithLeftAssociativeOp(ctx, span, '&&', left, right);
                replaceExpression(ctx, expr, newExpr);
            }
            return;
        }
        case N.SequenceExpression: {
            const expressions = expr.data.expressions as Node[];
            const last = expressions[expressions.length - 1];
            if (last !== undefined) minimizeExpressionInBooleanContext(ctx, last);
            return;
        }
        // A write-once falsy binding whose constant was withheld from value-context folding folds to
        // `false` here, where `undefined` before its initializer is just as falsy.
        case N.IdentifierReference: {
            const symbolId = getReference(ctx, expr).symbolId;
            if (symbolId === 0) return;
            if (symbolValueOf(ctx.state.symbols, symbolId)?.booleanFalsy)
                replaceExpression(ctx, expr, node(N.BooleanLiteral, expr.start, expr.end, 'false', null));
            return;
        }
    }
}
