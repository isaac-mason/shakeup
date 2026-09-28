// Port of oxc_minifier/src/peephole/minimize_for_statement.rs.

import { type DataOf, N, type Node, node } from '../../../ast/index.ts';
import { type DceCtx, replaceExpression, replaceStatement, type Span, takeNode } from '../traverse-context.ts';
import { tryFoldAndOr } from './fold-constants.ts';
import { minimizeNot } from './minimize-not-expression.ts';
import { statementCaresAboutScope } from './minimize-statements.ts';

/** oxc_ast `Statement::get_one_child`: a block's only statement, or the statement itself. */
function getOneChild(statement: Node): Node | null {
    if (statement.type === N.BlockStatement) {
        const body = statement.data.body as Node[];
        return body.length === 1 ? body[0] : null;
    }
    return statement;
}

const isUnlabeledBreak = (statement: Node | null): boolean | null => {
    if (statement === null || statement.type !== N.BreakStatement) return null;
    return statement.data.label === null;
};

/** esbuild's `mangleFor`. */
export function minimizeForStatement(ctx: DceCtx, forStatement: Node): void {
    const forData = forStatement.data as DataOf<'ForStatement'>;
    // Get the first statement in the loop
    let first = forData.body as Node;
    if (first.type === N.BlockStatement) {
        const body = first.data.body as Node[];
        if (body.length === 0) return;
        first = body[0];
    }

    if (first.type !== N.IfStatement) return;
    const ifData = first.data as DataOf<'IfStatement'>;
    // "for (;;) if (x) break;" => "for (; !x;) ;"
    // "for (; a;) if (x) break;" => "for (; a && !x;) ;"
    // "for (;;) if (x) break; else y();" => "for (; !x;) y();"
    // "for (; a;) if (x) break; else y();" => "for (; a && !x;) y();"
    const consequentBreak = isUnlabeledBreak(getOneChild(ifData.consequent));
    if (consequentBreak !== null) {
        if (!consequentBreak) return;
        const span: Span = { start: forData.body.start, end: forData.body.end };
        const [ifStatement, body] = takeFirstStatement(ctx, forData);
        const movedIf = ifStatement.data as DataOf<'IfStatement'>;
        const test = takeNode(ctx, movedIf.test);
        const expr =
            test.type === N.UnaryExpression && test.data.operator === '!'
                ? (test.data.argument as Node)
                : minimizeNot(ctx, test, test);
        joinIntoForTest(ctx, forData, expr);
        const alternate = movedIf.alternate as Node | null;
        movedIf.alternate = null;
        replaceStatement(ctx, forData.body, dropFirstStatement(ctx, span, body, alternate));
        return;
    }
    // "for (;;) if (x) y(); else break;" => "for (; x;) y();"
    // "for (; a;) if (x) y(); else break;" => "for (; a && x;) y();"
    const alternateBreak = ifData.alternate === null ? null : isUnlabeledBreak(getOneChild(ifData.alternate));
    if (alternateBreak !== null) {
        if (!alternateBreak) return;
        const span: Span = { start: forData.body.start, end: forData.body.end };
        const [ifStatement, body] = takeFirstStatement(ctx, forData);
        const movedIf = ifStatement.data as DataOf<'IfStatement'>;
        joinIntoForTest(ctx, forData, takeNode(ctx, movedIf.test));
        const consequent = takeNode(ctx, movedIf.consequent);
        replaceStatement(ctx, forData.body, dropFirstStatement(ctx, span, body, consequent));
    }
}

/** Move the loop body out and its first statement out of the body. Returns the moved first
 *  statement and the moved block, or null when the body was the statement itself. */
function takeFirstStatement(ctx: DceCtx, forData: DataOf<'ForStatement'>): [Node, Node | null] {
    const body = takeNode(ctx, forData.body);
    if (body.type === N.BlockStatement) return [takeNode(ctx, (body.data.body as Node[])[0]), body];
    return [body, null];
}

/** `test && expr` as the loop test, or `expr` when there is none. */
function joinIntoForTest(ctx: DceCtx, forData: DataOf<'ForStatement'>, expr: Node): void {
    const test = forData.test as Node | null;
    if (test === null) {
        forData.test = expr;
        return;
    }
    const left = takeNode(ctx, test);
    const logicalExpr = node(N.LogicalExpression, test.start, test.end, '', { operator: '&&', left, right: expr });
    const newTest = tryFoldAndOr(ctx, logicalExpr) ?? logicalExpr;
    replaceExpression(ctx, test, newTest);
}

function dropFirstStatement(ctx: DceCtx, span: Span, body: Node | null, replace: Node | null): Node {
    if (body !== null && body.type === N.BlockStatement) {
        const statements = body.data.body as Node[];
        if (statements.length !== 0) {
            if (replace !== null) {
                statements[0] = replace;
            } else if (statements.length === 2 && !statementCaresAboutScope(statements[1])) {
                return takeNode(ctx, statements[1]);
            } else {
                statements.splice(0, 1);
            }
            return body;
        }
    }
    return replace ?? node(N.EmptyStatement, span.start, span.end, '', null);
}
