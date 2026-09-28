// Port of oxc_minifier/src/is_terminated.rs.

import { type DataOf, N, type Node } from '../../ast/index.ts';

/** oxc `Statement::is_jump_statement`: a jump, or a block whose single statement is one. */
export function isJumpStatement(statement: Node): boolean {
    let single = statement;
    if (statement.type === N.BlockStatement) {
        const body = statement.data.body as Node[];
        if (body.length !== 1) return false;
        single = body[0];
    }
    return (
        single.type === N.ReturnStatement ||
        single.type === N.ThrowStatement ||
        single.type === N.BreakStatement ||
        single.type === N.ContinueStatement
    );
}

/** A statement that never completes normally, which makes the rest of its list unreachable. */
export function statementIsTerminated(statement: Node | null): boolean {
    if (statement === null) return false;
    switch (statement.type) {
        case N.IfStatement:
            return statementIsTerminated(statement.data.consequent) && statementIsTerminated(statement.data.alternate);
        case N.BlockStatement:
            return statementsAreTerminated(statement.data.body);
        case N.TryStatement: {
            // A finalizer that aborts overrides however the other blocks complete. Otherwise the try
            // block must abort, and so must the catch block when present.
            const { block, handler, finalizer } = statement.data;
            return (
                statementIsTerminated(finalizer) ||
                (statementIsTerminated(block) &&
                    handler !== null &&
                    statementIsTerminated((handler.data as DataOf<'CatchClause'>).body))
            );
        }
        default:
            return isJumpStatement(statement);
    }
}

/** A list is terminated by its last statement that is not a hoisting survivor (a function
 *  declaration or an initializer-less `var`) left behind in a minimized dead zone. */
export function statementsAreTerminated(statements: readonly Node[]): boolean {
    for (let index = statements.length - 1; index >= 0; index--) {
        const statement = statements[index];
        if (statement.type === N.FunctionDeclaration) continue;
        if (
            statement.type === N.VariableDeclaration &&
            statement.data.kind === 'var' &&
            (statement.data.declarations as Node[]).every(
                (declarator) => (declarator.data as DataOf<'VariableDeclarator'>).init === null,
            )
        )
            continue;
        return statementIsTerminated(statement);
    }
    return false;
}
