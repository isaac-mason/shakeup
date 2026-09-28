// Port of oxc_minifier/src/peephole/minimize_if_statement.rs.

import { attachScopeNode } from '../../../analysis/semantic.ts';
import { type DataOf, N, type Node, node } from '../../../ast/index.ts';
import { createChildScopeOfCurrent, type DceCtx, replaceExpression, replaceStatement, takeNode } from '../traverse-context.ts';
import { minimizeConditional } from './minimize-conditional-expression.ts';
import { joinWithLeftAssociativeOp } from './minimize-conditions.ts';
import { minimizeNot } from './minimize-not-expression.ts';
import { removeUnusedExpression } from './remove-unused-expression.ts';

const expressionStatement = (span: Node, expression: Node): Node =>
    node(N.ExpressionStatement, span.start, span.end, '', { expression });

/** The argument of a `!` expression, or null. */
const negatedOperandument = (expr: Node): Node | null =>
    expr.type === N.UnaryExpression && expr.data.operator === '!' ? expr.data.argument : null;

/** esbuild's `MangleIf`. Returns the statement to replace `ifStatement` with, or null. */
export function tryMinimizeIf(ctx: DceCtx, ifStatement: Node): Node | null {
    wrapToAvoidAmbiguousElse(ctx, ifStatement);
    const data = ifStatement.data as DataOf<'IfStatement'>;
    const consequent = data.consequent as Node;
    if (consequent.type === N.ExpressionStatement) {
        const alternate = data.alternate as Node | null;
        if (alternate === null) {
            // "if (!a) b();" => "a || b();"
            // "if (a) b();" => "a && b();"
            const negatedOperand = negatedOperandument(data.test);
            const operator = negatedOperand !== null ? '||' : '&&';
            const a = takeNode(ctx, negatedOperand ?? data.test);
            const b = takeNode(ctx, consequent.data.expression);
            return expressionStatement(ifStatement, joinWithLeftAssociativeOp(ctx, ifStatement, operator, a, b));
        }
        if (alternate.type === N.ExpressionStatement) {
            // "if (a) b(); else c();" => "a ? b() : c();"
            const test = takeNode(ctx, data.test);
            const consequentExpr = takeNode(ctx, consequent.data.expression);
            const alternateExpr = takeNode(ctx, alternate.data.expression);
            return expressionStatement(ifStatement, minimizeConditional(ctx, ifStatement, test, consequentExpr, alternateExpr));
        }
    } else if (isStatementEmpty(consequent)) {
        const alternate = data.alternate as Node | null;
        if (alternate === null || isStatementEmpty(alternate)) {
            // "if (a) {}" => "a;"
            const expr = takeNode(ctx, data.test);
            removeUnusedExpression(ctx, expr);
            return expressionStatement(ifStatement, expr);
        }
        if (alternate.type === N.ExpressionStatement) {
            // "if (!a) {} else b();" => "a && b();"
            // "if (a) {} else b();" => "a || b();"
            const negatedOperand = negatedOperandument(data.test);
            const operator = negatedOperand !== null ? '&&' : '||';
            const a = takeNode(ctx, negatedOperand ?? data.test);
            const b = takeNode(ctx, alternate.data.expression);
            return expressionStatement(ifStatement, joinWithLeftAssociativeOp(ctx, ifStatement, operator, a, b));
        }
        // "yes" is missing and "no" is not missing (and is not an expression)
        const negatedOperand = negatedOperandument(data.test);
        if (negatedOperand !== null) {
            // "if (!a) {} else return b;" => "if (a) return b;"
            const newTest = takeNode(ctx, negatedOperand);
            const newConsequent = takeNode(ctx, alternate);
            replaceExpression(ctx, data.test, newTest);
            replaceStatement(ctx, data.consequent, newConsequent);
            data.alternate = null;
        } else {
            // "if (a) {} else return b;" => "if (!a) return b;"
            const newTest = minimizeNot(ctx, data.test, takeNode(ctx, data.test));
            const newConsequent = takeNode(ctx, alternate);
            replaceExpression(ctx, data.test, newTest);
            replaceStatement(ctx, data.consequent, newConsequent);
            data.alternate = null;
            tryMinimizeIf(ctx, ifStatement);
        }
    } else {
        // "yes" is not missing (and is not an expression)
        const alternate = data.alternate as Node | null;
        if (alternate !== null) {
            // "yes" is not missing (and is not an expression) and "no" is not missing
            const negatedOperand = negatedOperandument(data.test);
            if (alternate.type !== N.IfStatement && negatedOperand !== null) {
                // "if (!a) return b; else return c;" => "if (a) return c; else return b;"
                const newTest = takeNode(ctx, negatedOperand);
                replaceExpression(ctx, data.test, newTest);
                data.consequent = alternate;
                data.alternate = consequent;
                wrapToAvoidAmbiguousElse(ctx, ifStatement);
            }
            // "if (!a) {} else if (b) {}" => "if (!a) {} if (b) {}" is handled by minimize_statements
            // "if (a) return b; else {}" => "if (a) return b;" is handled by remove_dead_code
        } else if (consequent.type === N.IfStatement && consequent.data.alternate === null) {
            // "if (a) if (b) return c;" => "if (a && b) return c;"
            const a = takeNode(ctx, data.test);
            const b = takeNode(ctx, consequent.data.test);
            const newTest = joinWithLeftAssociativeOp(ctx, data.test, '&&', a, b);
            const newConsequent = takeNode(ctx, consequent.data.consequent);
            replaceExpression(ctx, data.test, newTest);
            replaceStatement(ctx, data.consequent, newConsequent);
        }
    }
    return null;
}

/** `if (foo) if (bar) baz else quaz` => `if (foo) { if (bar) baz else quaz }` */
function wrapToAvoidAmbiguousElse(ctx: DceCtx, ifStatement: Node): void {
    const data = ifStatement.data as DataOf<'IfStatement'>;
    const consequent = data.consequent as Node;
    if (consequent.type !== N.IfStatement || consequent.data.alternate === null) return;
    const scopeId = createChildScopeOfCurrent(ctx, 0);
    const newConsequent = node(N.BlockStatement, consequent.start, consequent.end, '', {
        body: [takeNode(ctx, consequent)],
        scopeId,
    });
    attachScopeNode(ctx.scoping.semantic, scopeId, newConsequent);
    replaceStatement(ctx, data.consequent, newConsequent);
}

function isStatementEmpty(statement: Node): boolean {
    switch (statement.type) {
        case N.BlockStatement:
            return (statement.data.body as Node[]).length === 0;
        case N.EmptyStatement:
            return true;
        default:
            return false;
    }
}
