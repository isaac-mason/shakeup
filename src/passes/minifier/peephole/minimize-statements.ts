// Port of oxc_minifier/src/peephole/minimize_statements.rs.

import { getSideFreeBooleanValue, isLiteralValue, valueType } from '../../../analysis/const-eval.ts';
import { attachScopeNode } from '../../../analysis/semantic.ts';
import { assignmentTargetMayHaveSideEffects, mayHaveSideEffects } from '../../../analysis/side-effects.ts';
import { create, type DataOf, N, type Node, node, num, OP } from '../../../ast/index.ts';
import { isJumpStatement, statementIsTerminated } from '../is-terminated.ts';
import { createKeepVar, keepVarVariableDeclarationStatement, keepVarVisitStatement } from '../keep-var.ts';
import { isTreeShakeOnly } from '../state.ts';
import { isImplicitlyObservable, symbolValueOf } from '../symbol-state.ts';
import { countsHaveMultipleReads, countsHaveWrites } from '../symbol-value.ts';
import { scopeContainsDirectEval, symbolIsCatchVariable } from '../syntax.ts';
import {
    ancestor,
    contentEq,
    createChildScopeOfCurrent,
    currentScopeFlags,
    type DceCtx,
    dropExpression,
    dropStatement,
    dropSwitchCase,
    dropVariableDeclarator,
    isClosestFunctionScopeAnAsyncGenerator,
    isExpressionWhoseNameNeedsToBeKept,
    noticeChange,
    parentKind,
    replaceExpression,
    replaceForStatementLeft,
    type Span,
    symbolFlags,
    takeNode,
} from '../traverse-context.ts';
import {
    computedKeyBlocksReorder,
    expressionContainsSuperCall,
    identifierReadBlocksReorder,
    isLiteral,
    memberPartBlocksReorder,
} from './index.ts';
import { minimizeConditional } from './minimize-conditional-expression.ts';
import { joinWithLeftAssociativeOp } from './minimize-conditions.ts';
import { minimizeExpressionInBooleanContext } from './minimize-expression-in-boolean-context.ts';
import { tryMinimizeIf } from './minimize-if-statement.ts';
import { minimizeNot } from './minimize-not-expression.ts';
import { isScriptRootScope, removeUnusedVariableDeclaration, shouldRemoveUnusedDeclarator } from './remove-unused-declaration.ts';
import {
    derivedConstructorThisScope,
    hasSideEffectsOrPreservedIife,
    removeUnusedExpression,
} from './remove-unused-expression.ts';

type VariableDeclarationKind = DataOf<'VariableDeclaration'>['kind'];

const isUsing = (kind: VariableDeclarationKind): boolean => kind === 'using' || kind === 'await using';

/** oxc `Statement::is_module_declaration`. */
function isModuleDeclaration(statement: Node): boolean {
    switch (statement.type) {
        case N.ImportDeclaration:
        case N.ExportAllDeclaration:
        case N.ExportDefaultDeclaration:
        case N.ExportNamedDeclaration:
            return true;
        default:
            return false;
    }
}

const lastOf = (statements: readonly Node[]): Node | null => (statements.length === 0 ? null : statements[statements.length - 1]);

const expressionStatementOf = (expr: Node): Node => create.ExpressionStatement(expr.start, expr.end, 0, expr);

/** `false` when dropping `statement` produces an identical AST: a `var` with no initializers, which
 *  `KeepVar` re-emits unchanged at the end of the block. Flagging such a drop as a change would keep
 *  the fixed-point loop spinning. A type annotation disqualifies it, since the re-emit strips it. */
function deadDropMutatesAst(statement: Node): boolean {
    if (statement.type !== N.VariableDeclaration) return true;
    const { kind, declarations } = statement.data as DataOf<'VariableDeclaration'>;
    return !(
        kind === 'var' &&
        declarations.every((declarator) => {
            const data = declarator.data as DataOf<'VariableDeclarator'>;
            return data.init === null && data.typeAnnotation === null;
        })
    );
}

/** oxc `minimize_statements` (esbuild's `mangleStmts`), over `statements[firstStatement..]`: the
 *  statements after the directive prologue. */
export function minimizeStatements(ctx: DceCtx, statements: Node[], firstStatement: number): void {
    // The parser shares one frozen array for every empty list, and there is nothing to minimize.
    if (statements.length === firstStatement) return;
    const oldStatements = statements.slice(firstStatement);
    const result: Node[] = [];
    let isControlFlowDead = false;
    const keepVar = createKeepVar();
    let identityDrops = 0;
    for (let index = 0; index < oldStatements.length; index++) {
        const statement = oldStatements[index];
        if (isControlFlowDead && !isModuleDeclaration(statement) && statement.type !== N.FunctionDeclaration) {
            // Harvest `var` bindings so they re-emit at the end of the block.
            keepVarVisitStatement(keepVar, statement);
            // Re-flag the loop so the next pass sees refreshed counts and can remove bindings this drop
            // orphaned (`var x = {}` after dropping `module.exports = x;`).
            if (deadDropMutatesAst(statement)) dropStatement(ctx, statement);
            else identityDrops++;
            continue;
        }
        if (minimizeStatement(ctx, statement, index, oldStatements, result)) break;
        // A statement that never completes normally makes the rest of the list unreachable.
        if (!isControlFlowDead) {
            const last = lastOf(result);
            if (last !== null && statementIsTerminated(last)) isControlFlowDead = true;
        }
    }
    const keptVars = keepVarVariableDeclarationStatement(keepVar);
    if (keptVars !== null) {
        const filtered = removeUnusedVariableDeclaration(ctx, keptVars);
        if (filtered !== null) {
            result.push(filtered);
            // Several identity drops coalesce into one `var x, y;`, which is a real change.
            if (identityDrops > 1) noticeChange(ctx);
        } else {
            // The harvested `var` was entirely unused, so the net effect removed the declaration.
            noticeChange(ctx);
        }
    }

    // Drop a trailing unconditional jump statement if applicable.
    const lastStatement = lastOf(result);
    if (lastStatement !== null && canRemoveTerminationStatement(ctx, lastStatement)) {
        result.pop();
        dropStatement(ctx, lastStatement);
    }

    // Merge certain statements in reverse order
    if (result.length >= 2 && ctx.state.options.sequences) {
        const last = lastOf(result) as Node;
        if (last.type === N.ReturnStatement) mergeIntoTrailingReturn(ctx, result);
        else if (last.type === N.ThrowStatement) mergeIntoTrailingThrow(ctx, result);
    }

    statements.length = firstStatement;
    for (const statement of result) statements.push(statement);
}

/** The argument of a return or throw statement. */
const jumpArgumentOf = (statement: Node): Node | null => (statement.data as DataOf<'ReturnStatement'>).argument;

const expressionOf = (expressionStatement: Node): Node => (expressionStatement.data as DataOf<'ExpressionStatement'>).expression;

function mergeIntoTrailingReturn(ctx: DceCtx, statements: Node[]): void {
    while (statements.length >= 2) {
        const previous = statements[statements.length - 2];
        if (previous.type === N.ExpressionStatement) {
            const lastReturnArgument = jumpArgumentOf(lastOf(statements) as Node);
            if (lastReturnArgument === null) break;
            noticeChange(ctx);
            // "a(); return b;" => "return a(), b;"
            const lastReturn = statements.pop() as Node;
            const expressionStatement = statements.pop() as Node;
            const argument = joinSequence(ctx, expressionOf(expressionStatement), lastReturnArgument);
            statements.push(create.ReturnStatement(lastReturn.start, lastReturn.end, 0, argument));
        } else if (previous.type === N.IfStatement) {
            // Merge the last two statements
            const previousIf = previous.data as DataOf<'IfStatement'>;
            // The previous statement must be an if statement with no else clause
            if (previousIf.alternate !== null) break;
            // The then clause must be a return
            if (previousIf.consequent.type !== N.ReturnStatement) break;
            const lastArgument = jumpArgumentOf(lastOf(statements) as Node);
            if (lastArgument !== null && conditionalExpressionCountExceeded(lastArgument)) break;

            noticeChange(ctx);
            const lastReturn = statements.pop() as Node;
            statements.pop();
            const previousReturn = previousIf.consequent;

            // "if (a) return; return b;" => "return a ? void 0 : b;"
            const left = jumpArgumentOf(previousReturn) ?? newVoid0(previousReturn);
            // "if (a) return a; return;" => "return a ? b : void 0;"
            const right = lastArgument ?? newVoid0(lastReturn);
            const argument = joinTestWithBranches(ctx, previous, left, right);
            statements.push(create.ReturnStatement(lastReturn.start, lastReturn.end, 0, argument));
        } else {
            break;
        }
    }
}

function mergeIntoTrailingThrow(ctx: DceCtx, statements: Node[]): void {
    while (statements.length >= 2) {
        const previous = statements[statements.length - 2];
        if (previous.type === N.ExpressionStatement) {
            noticeChange(ctx);
            // "a(); throw b;" => "throw a(), b;"
            const lastThrow = statements.pop() as Node;
            const expressionStatement = statements.pop() as Node;
            const argument = joinSequence(ctx, expressionOf(expressionStatement), jumpArgumentOf(lastThrow) as Node);
            statements.push(create.ThrowStatement(lastThrow.start, lastThrow.end, 0, argument));
        } else if (previous.type === N.IfStatement) {
            // Merge the last two statements
            const previousIf = previous.data as DataOf<'IfStatement'>;
            // The previous statement must be an if statement with no else clause
            if (previousIf.alternate !== null) break;
            // The then clause must be a throw
            if (previousIf.consequent.type !== N.ThrowStatement) break;
            const lastArgument = jumpArgumentOf(lastOf(statements) as Node) as Node;
            if (conditionalExpressionCountExceeded(lastArgument)) break;

            noticeChange(ctx);
            const lastThrow = statements.pop() as Node;
            statements.pop();
            const argument = joinTestWithBranches(ctx, previous, jumpArgumentOf(previousIf.consequent) as Node, lastArgument);
            statements.push(create.ThrowStatement(lastThrow.start, lastThrow.end, 0, argument));
        } else {
            break;
        }
    }
}

/** The shared tail of oxc's return and throw merges: `if (test) <left>; <right>` as one conditional.
 *  `ifStatement` has left its list; `left` and `right` are its consequent's and the next statement's
 *  arguments, detached with their owners. */
function joinTestWithBranches(ctx: DceCtx, ifStatement: Node, leftArgument: Node, rightArgument: Node): Node {
    const ifData = ifStatement.data as DataOf<'IfStatement'>;
    let left = leftArgument;
    let right = rightArgument;
    // "if (!a) return b; return c;" => "return a ? c : b;"
    const test = ifData.test;
    if (test.type === N.UnaryExpression && test.data.operator === '!') {
        ifData.test = takeNode(ctx, test.data.argument);
        const swapped = left;
        left = right;
        right = swapped;
    }
    if (ifData.test.type === N.SequenceExpression) {
        // "if (a, b) return c; return d;" => "return a, b ? c : d;"
        const innerTest = (ifData.test.data.expressions as Node[]).pop() as Node;
        const conditional = minimizeConditional(ctx, ifStatement, innerTest, left, right);
        return joinSequence(ctx, ifData.test, conditional);
    }
    // "if (a) return b; return c;" => "return a ? b : c;"
    return minimizeConditional(ctx, ifStatement, takeNode(ctx, ifData.test), left, right);
}

/** oxc `Expression::new_void_0`. */
const newVoid0 = (span: Span): Node => create.UnaryExpression(span.start, span.end, OP.VOID, num(0, span.start));

/** Some parsers cannot parse long conditional expressions.
 *  See <https://bugzilla.mozilla.org/show_bug.cgi?id=2033215> */
function conditionalExpressionCountExceeded(expr: Node): boolean {
    let depth = 0;
    let current = expr;
    while (current.type === N.ConditionalExpression) {
        depth++;
        if (depth === 500) return true;
        current = current.data.alternate;
    }
    return false;
}

/** oxc `minimize_statement`. `true` ends the list: `handle_if_statement` moved the rest of
 *  `statements` (from `index + 1`) into the if. */
function minimizeStatement(ctx: DceCtx, statement: Node, index: number, statements: Node[], result: Node[]): boolean {
    switch (statement.type) {
        case N.EmptyStatement:
            return false;
        case N.VariableDeclaration:
            handleVariableDeclaration(ctx, statement, result);
            return false;
        case N.ExpressionStatement:
            handleExpressionStatement(ctx, statement, result);
            return false;
        case N.SwitchStatement:
            handleSwitchStatement(ctx, statement, result);
            return false;
        case N.IfStatement:
            return handleIfStatement(ctx, index, statements, statement, result);
        case N.ReturnStatement:
            handleReturnStatement(ctx, statement, result);
            return false;
        case N.ThrowStatement:
            handleThrowStatement(ctx, statement, result);
            return false;
        case N.ForStatement:
            handleForStatement(ctx, statement, result);
            return false;
        case N.ForInStatement:
            handleForInStatement(ctx, statement, result);
            return false;
        case N.ForOfStatement:
            handleForOfStatement(ctx, statement, result);
            return false;
        case N.BlockStatement:
            handleBlock(ctx, result, statement);
            return false;
        default:
            result.push(statement);
            return false;
    }
}

/** oxc `join_sequence`: `a, b` from two expression slots, flattening sequences. Both slots are left
 *  as placeholders. */
function joinSequence(ctx: DceCtx, aSlot: Node, bSlot: Node): Node {
    const a = takeNode(ctx, aSlot);
    const b = takeNode(ctx, bSlot);
    if (a.type === N.SequenceExpression) {
        // `(a, b); c`
        (a.data.expressions as Node[]).push(b);
        return a;
    }
    // `a; (b, c)` or `a; b`
    const expressions = b.type === N.SequenceExpression ? [a, ...(b.data.expressions as Node[])] : [a, b];
    return create.SequenceExpression(a.start, a.end, 0, expressions);
}

const jumpStatementsLookTheSame = (left: Node, right: Node): boolean =>
    isJumpStatement(left) && isJumpStatement(right) && contentEq(left, right);

/** Merge with the previous declaration of the same kind, remove unused declarators, and keep the
 *  initializers that have side effects. */
function handleVariableDeclaration(ctx: DceCtx, varDecl: Node, result: Node[]): void {
    const data = varDecl.data as DataOf<'VariableDeclaration'>;
    const firstDeclarator = data.declarations.length > 0 ? data.declarations[0] : null;
    if (firstDeclarator !== null) {
        const firstInit = (firstDeclarator.data as DataOf<'VariableDeclarator'>).init;
        if (firstInit !== null) substituteSingleUseSymbolInStatement(ctx, firstInit, result, false);
    }
    substituteSingleUseSymbolWithinDeclaration(ctx, data.kind, data.declarations);

    // With `join_vars` off and no unused declarators, keep the declaration as it is.
    if (
        !ctx.state.options.joinVars &&
        data.declarations.every((declarator) => !shouldRemoveUnusedDeclarator(ctx, declarator, data.kind))
    ) {
        result.push(varDecl);
        return;
    }

    const kind = data.kind;
    const previous = lastOf(result);
    if (previous !== null && previous.type === N.VariableDeclaration && previous.data.kind === kind) noticeChange(ctx);
    for (const declarator of data.declarations) {
        const declaratorData = declarator.data as DataOf<'VariableDeclarator'>;
        if (shouldRemoveUnusedDeclarator(ctx, declarator, kind)) {
            // `init` is taken out first because it may survive as an expression statement; the
            // declarator drop below must not mark its references dead.
            const init = declaratorData.init;
            declaratorData.init = null;
            if (init !== null) {
                if (removeUnusedExpression(ctx, init)) dropExpression(ctx, init);
                else result.push(expressionStatementOf(init));
            }
            dropVariableDeclarator(ctx, declarator);
        } else {
            const last = lastOf(result);
            if (last !== null && last.type === N.VariableDeclaration && last.data.kind === kind) {
                (last.data.declarations as Node[]).push(declarator);
                continue;
            }
            result.push(
                node(N.VariableDeclaration, varDecl.start, varDecl.end, '', {
                    declarations: [declarator],
                    kind,
                    declare: data.declare,
                }),
            );
        }
    }
}

function handleExpressionStatement(ctx: DceCtx, expressionStatement: Node, result: Node[]): void {
    const data = expressionStatement.data as DataOf<'ExpressionStatement'>;
    substituteSingleUseSymbolInStatement(ctx, data.expression, result, false);

    // In a derived constructor, `this` after an unconditional top-level `super()` is safe to drop.
    if (
        data.expression.type === N.ThisExpression &&
        derivedConstructorThisScope(ctx) !== 0 &&
        result.some(
            (previous) => previous.type === N.ExpressionStatement && expressionContainsSuperCall(previous.data.expression),
        )
    ) {
        dropStatement(ctx, expressionStatement);
        return;
    }

    if (ctx.state.options.sequences) {
        const previous = lastOf(result);
        if (previous !== null && previous.type === N.ExpressionStatement) {
            data.expression = joinSequence(ctx, previous.data.expression, data.expression);
            dropStatement(ctx, result.pop() as Node);
        }
    }
    // "var a; a = b();" => "var a = b();"
    const expression = data.expression;
    if (expression.type === N.AssignmentExpression) {
        if (mergeAssignmentToDeclaration(ctx, expression, result)) {
            dropStatement(ctx, expressionStatement);
            return;
        }
    } else if (expression.type === N.SequenceExpression) {
        const last = lastOf(result);
        if (last !== null && last.type === N.VariableDeclaration) {
            const expressions = expression.data.expressions as Node[];
            let firstNonMergedIndex = -1;
            for (let index = 0; index < expressions.length; index++) {
                const item = expressions[index];
                if (item.type !== N.AssignmentExpression || !mergeAssignmentToDeclaration(ctx, item, result)) {
                    firstNonMergedIndex = index;
                    break;
                }
            }
            if (firstNonMergedIndex === -1) {
                // Every element merged.
                dropStatement(ctx, expressionStatement);
                return;
            }
            if (firstNonMergedIndex === expressions.length - 1) {
                // Every element merged except the last.
                const lastExpression = expressions.pop() as Node;
                result.push(expressionStatementOf(lastExpression));
                dropStatement(ctx, expressionStatement);
                return;
            }
            if (firstNonMergedIndex > 0) {
                for (const dropped of expressions.splice(0, firstNonMergedIndex)) dropExpression(ctx, dropped);
            }
        }
    }

    result.push(expressionStatement);
}

function mergeAssignmentToDeclaration(ctx: DceCtx, assignExpr: Node, result: Node[]): boolean {
    const assignData = assignExpr.data as DataOf<'AssignmentExpression'>;
    if (assignData.operator !== '=') return false;
    const target = assignData.left;
    if (target.type !== N.IdentifierReference) return false;
    const last = lastOf(result);
    if (last === null || last.type !== N.VariableDeclaration) return false;
    const declarationKind = last.data.kind as VariableDeclarationKind;
    if (declarationKind !== 'var' && declarationKind !== 'let') return false;
    const declarations = last.data.declarations as Node[];
    for (let index = declarations.length - 1; index >= 0; index--) {
        const declaratorData = declarations[index].data as DataOf<'VariableDeclarator'>;
        if (declaratorData.id.type !== N.BindingIdentifier) break;
        if (declaratorData.id.name === target.name) {
            if (declaratorData.init === null && (declarationKind === 'var' || isLiteralValue(assignData.right, true, ctx))) {
                // "var a; a = b();" => "var a = b();"
                declaratorData.init = takeNode(ctx, assignData.right);
                return true;
            }
            // Not possible: "var a = b(); a = c();" (`c()` may read `a`), "var a = 1; a = b();" (`b()`
            // may read `a`), "let a; a = foo(a);" (TDZ error).
            break;
        }
        // Moving the assignment above a declarator with an initializer changes execution order.
        if (declaratorData.init !== null) break;
        // Moving it above another `let` declarator could cause a TDZ error (`let a, b; b = a;`).
        if (declarationKind === 'let') break;
    }
    return false;
}

function isSwitchCaseRemovable(switchCase: Node, allowBreak: boolean): boolean {
    const { test, consequent } = switchCase.data as DataOf<'SwitchCase'>;
    let isEmpty: boolean;
    if (consequent.length === 1) {
        const last = consequent[0];
        if (last.type === N.EmptyStatement) isEmpty = true;
        else if (last.type === N.BreakStatement) isEmpty = allowBreak && last.data.label === null;
        else isEmpty = false;
    } else {
        isEmpty = consequent.length === 0;
    }
    return isEmpty && (test === null || isLiteral(test));
}

/** The case's test has no side effects and its statements can be inlined (no unlabeled `break`). */
export function canSwitchCaseBeInlined(switchCase: Node): boolean {
    const { test, consequent } = switchCase.data as DataOf<'SwitchCase'>;
    if (test !== null && !isLiteral(test)) return false;
    return consequent.length === 0 || !hasUnlabelledBreakInSwitchCase(switchCase);
}

function handleSwitchStatement(ctx: DceCtx, switchStatement: Node, result: Node[]): void {
    const data = switchStatement.data as DataOf<'SwitchStatement'>;
    substituteSingleUseSymbolInStatement(ctx, data.discriminant, result, false);

    if (ctx.state.options.sequences) {
        const previous = lastOf(result);
        if (previous !== null && previous.type === N.ExpressionStatement) {
            data.discriminant = joinSequence(ctx, previous.data.expression, data.discriminant);
            dropStatement(ctx, result.pop() as Node);
        }
    }

    // Remove empty case clauses that don't affect behavior: empty cases before the default, or at the
    // end when there is no default.
    // `switch (x) { case 0: foo(); break; case 1: default: bar() }` => `switch (x) { case 0: foo(); break; default: bar() }`
    const cases = data.cases;
    const caseCount = cases.length;
    if (caseCount === 1) {
        // Remove the sole case if it is empty and its test has no side effect.
        if (isSwitchCaseRemovable(cases[0], true)) dropSwitchCase(ctx, cases.pop() as Node);
    } else if (caseCount > 1) {
        // The range [0, end) to check for removable cases:
        // 1. an empty default: the whole switch.
        // 2. a non-removable default that is last: the cases before it.
        // 3. a non-removable default that is not last: none.
        // 4. no default: the whole switch, allowing a trailing unlabeled `break`.
        let defaultPosition = -1;
        for (let index = caseCount - 1; index >= 0; index--) {
            if ((cases[index].data as DataOf<'SwitchCase'>).test === null) {
                defaultPosition = index;
                break;
            }
        }
        let end: number;
        let allowBreak: boolean;
        if (defaultPosition >= 0) {
            if (isSwitchCaseRemovable(cases[defaultPosition], true)) {
                end = caseCount;
                allowBreak = true;
            } else if (defaultPosition === caseCount - 1) {
                end = defaultPosition;
                allowBreak = false;
            } else {
                end = 0;
                allowBreak = false;
            }
        } else {
            end = caseCount;
            allowBreak = true;
        }

        if (end > 0) {
            // The removable suffix starts after the last non-removable case in [0, end), or at 0.
            let start = 0;
            for (let index = end - 1; index >= 0; index--) {
                if (!isSwitchCaseRemovable(cases[index], allowBreak)) {
                    start = index + 1;
                    break;
                }
            }
            if (start < end && (defaultPosition < 0 || defaultPosition >= start)) {
                for (const removedCase of cases.splice(start, end - start)) dropSwitchCase(ctx, removedCase);
            }
        }
    }

    if (cases.length === 0) {
        result.push(create.ExpressionStatement(switchStatement.start, switchStatement.end, 0, takeNode(ctx, data.discriminant)));
        return;
    }
    const lastCase = cases[cases.length - 1].data as DataOf<'SwitchCase'>;
    const lastStatement = lastOf(lastCase.consequent);
    if (lastStatement !== null && lastStatement.type === N.BreakStatement && lastStatement.data.label === null) {
        lastCase.consequent.pop();
        dropStatement(ctx, lastStatement);
    }

    if (!isTreeShakeOnly(ctx.state) && cases.length === 1 && canSwitchCaseBeInlined(cases[0])) {
        const switchCase = cases.pop() as Node;
        const caseData = switchCase.data as DataOf<'SwitchCase'>;
        noticeChange(ctx);

        let blockStatement: Node;
        if (caseData.consequent.length === 1 && caseData.consequent[0].type === N.BlockStatement) {
            blockStatement = caseData.consequent.pop() as Node;
        } else {
            blockStatement = create.BlockStatement(switchCase.start, switchCase.end, 0, caseData.consequent);
            attachScopeNode(ctx.scoping.semantic, data.scopeId, blockStatement);
        }

        if (caseData.test !== null) {
            const test = create.BinaryExpression(0, 0, '===', takeNode(ctx, data.discriminant), caseData.test);
            result.push(create.IfStatement(switchStatement.start, switchStatement.end, 0, test, blockStatement, null));
            return;
        }

        if (!isLiteral(data.discriminant)) {
            const discriminant = data.discriminant;
            result.push(create.ExpressionStatement(discriminant.start, discriminant.end, 0, takeNode(ctx, discriminant)));
        }

        result.push(blockStatement);
        return;
    }

    result.push(switchStatement);
}

/** oxc `handle_if_statement`. `true` when the rest of `statements` moved into the if. */
function handleIfStatement(ctx: DceCtx, index: number, statements: Node[], ifStatement: Node, result: Node[]): boolean {
    const data = ifStatement.data as DataOf<'IfStatement'>;
    substituteSingleUseSymbolInStatement(ctx, data.test, result, false);

    // Absorb a previous expression statement
    if (ctx.state.options.sequences) {
        const previous = lastOf(result);
        if (previous !== null && previous.type === N.ExpressionStatement) {
            data.test = joinSequence(ctx, previous.data.expression, data.test);
            dropStatement(ctx, result.pop() as Node);
        }

        if (isJumpStatement(data.consequent)) {
            // Absorb a previous if statement
            const previousIf = lastOf(result);
            if (
                previousIf !== null &&
                previousIf.type === N.IfStatement &&
                previousIf.data.alternate === null &&
                jumpStatementsLookTheSame(previousIf.data.consequent, data.consequent)
            ) {
                // "if (a) break c; if (b) break c;" => "if (a || b) break c;"
                // "if (a) continue c; if (b) continue c;" => "if (a || b) continue c;"
                // "if (a) return c; if (b) return c;" => "if (a || b) return c;"
                // "if (a) throw c; if (b) throw c;" => "if (a || b) throw c;"
                const span = { start: data.test.start, end: data.test.end };
                data.test = joinWithLeftAssociativeOp(
                    ctx,
                    span,
                    '||',
                    takeNode(ctx, previousIf.data.test),
                    takeNode(ctx, data.test),
                );
                dropStatement(ctx, result.pop() as Node);
            }

            if (canRemoveTerminationStatement(ctx, data.consequent)) {
                // Don't do this transformation if the branch condition could potentially access
                // symbols declared later on in this scope. Inverting the branch condition and nesting
                // the statements after this in a block would break that access:
                //
                //   if (a()) return; function a() {}  =>  if (!a()) { function a() {} }
                //   if (a(() => b)) return; let b;     =>  if (a(() => b)) { let b; }
                const canMoveBranchConditionOutsideScope =
                    !(data.alternate !== null && statementCaresAboutScope(data.alternate)) &&
                    !statements.slice(index + 1).some(statementCaresAboutScope);

                if (canMoveBranchConditionOutsideScope) {
                    const drainedStatements = statements.splice(index + 1);
                    const alternate = data.alternate;
                    data.alternate = null;
                    const body = alternate !== null ? [alternate, ...drainedStatements] : drainedStatements;

                    minimizeStatements(ctx, body, 0);
                    const span: Span = body.length === 0 ? data.consequent : body[0];
                    const test = takeNode(ctx, data.test);
                    const notTest = minimizeNot(ctx, test, test);
                    minimizeExpressionInBooleanContext(ctx, notTest);
                    let consequent: Node;
                    if (body.length === 1) {
                        consequent = body[0];
                    } else {
                        const scopeId = createChildScopeOfCurrent(ctx, 0);
                        consequent = create.BlockStatement(span.start, span.end, 0, body);
                        attachScopeNode(ctx.scoping.semantic, scopeId, consequent);
                    }
                    const newIf = create.IfStatement(notTest.start, notTest.end, 0, notTest, consequent, null);
                    result.push(tryMinimizeIf(ctx, newIf) ?? newIf);
                    noticeChange(ctx);
                    return true;
                }
            }
        }

        if (data.alternate !== null && !statementCaresAboutScope(data.alternate) && statementIsTerminated(data.consequent)) {
            // "if (a) return b; else if (c) return d; else return e;" => "if (a) return b; if (c) return d; return e;"
            result.push(ifStatement);
            for (;;) {
                const last = lastOf(result);
                if (last === null || last.type !== N.IfStatement) break;
                const lastData = last.data as DataOf<'IfStatement'>;
                const alternate = lastData.alternate;
                if (alternate === null || statementCaresAboutScope(alternate) || !statementIsTerminated(lastData.consequent))
                    break;
                lastData.alternate = null;
                if (alternate.type === N.BlockStatement) {
                    handleBlock(ctx, result, alternate);
                } else {
                    result.push(alternate);
                    noticeChange(ctx);
                }
            }
            return false;
        }
    }

    result.push(ifStatement);
    return false;
}

function handleReturnStatement(ctx: DceCtx, returnStatement: Node, result: Node[]): void {
    const data = returnStatement.data as DataOf<'ReturnStatement'>;
    if (data.argument !== null) substituteSingleUseSymbolInStatement(ctx, data.argument, result, false);

    const argument = data.argument;
    if (
        argument !== null &&
        valueType(argument, ctx) === 'undefined' &&
        // `return undefined` has different semantics in an async generator.
        !isClosestFunctionScopeAnAsyncGenerator(ctx)
    ) {
        if (mayHaveSideEffects(argument, ctx)) {
            const previous = lastOf(result);
            if (ctx.state.options.sequences && previous !== null && previous.type === N.ExpressionStatement) {
                previous.data.expression = joinSequence(ctx, previous.data.expression, argument);
            } else {
                result.push(expressionStatementOf(takeNode(ctx, argument)));
            }
        }
        data.argument = null;
        dropExpression(ctx, argument);
        result.push(returnStatement);
        return;
    }

    if (ctx.state.options.sequences && argument !== null) {
        const previous = lastOf(result);
        if (previous !== null && previous.type === N.ExpressionStatement) {
            const newArgument = joinSequence(ctx, previous.data.expression, argument);
            replaceExpression(ctx, argument, newArgument);
            result.pop();
        }
    }
    result.push(returnStatement);
}

function handleThrowStatement(ctx: DceCtx, throwStatement: Node, result: Node[]): void {
    const data = throwStatement.data as DataOf<'ThrowStatement'>;
    substituteSingleUseSymbolInStatement(ctx, data.argument, result, false);

    if (ctx.state.options.sequences) {
        const previous = lastOf(result);
        if (previous !== null && previous.type === N.ExpressionStatement) {
            data.argument = joinSequence(ctx, previous.data.expression, data.argument);
            dropStatement(ctx, result.pop() as Node);
        }
    }
    result.push(throwStatement);
}

function handleForStatement(ctx: DceCtx, forStatement: Node, result: Node[]): void {
    const data = forStatement.data as DataOf<'ForStatement'>;
    const init = data.init;
    if (init !== null) {
        if (init.type === N.VariableDeclaration) {
            const declarationData = init.data as DataOf<'VariableDeclaration'>;
            const firstDeclarator = declarationData.declarations.length > 0 ? declarationData.declarations[0] : null;
            if (firstDeclarator !== null) {
                const firstInit = (firstDeclarator.data as DataOf<'VariableDeclarator'>).init;
                if (firstInit !== null) {
                    const isBlockScopedDecl = declarationData.kind !== 'var';
                    substituteSingleUseSymbolInStatement(ctx, firstInit, result, isBlockScopedDecl);
                }
            }
            substituteSingleUseSymbolWithinDeclaration(ctx, declarationData.kind, declarationData.declarations);
        } else {
            substituteSingleUseSymbolInStatement(ctx, init, result, false);
        }
    }

    if (data.init !== null && data.init.type === N.VariableDeclaration) {
        const declarationData = data.init.data as DataOf<'VariableDeclaration'>;
        const declarationKind = declarationData.kind;
        const declarations = declarationData.declarations;
        const oldLength = declarations.length;
        let kept = 0;
        for (const declarator of declarations) {
            const declaratorInit = (declarator.data as DataOf<'VariableDeclarator'>).init;
            const shouldKeep =
                !shouldRemoveUnusedDeclarator(ctx, declarator, declarationKind) ||
                (declaratorInit !== null && hasSideEffectsOrPreservedIife(ctx, declaratorInit));
            if (shouldKeep) declarations[kept++] = declarator;
            // The declarator leaves silently, so its references need an explicit drop walk.
            else dropVariableDeclarator(ctx, declarator);
        }
        declarations.length = kept;
        if (oldLength !== declarations.length) {
            if (declarations.length === 0) data.init = null;
            noticeChange(ctx);
        }
    }

    if (ctx.state.options.sequences) {
        const previous = lastOf(result);
        if (previous !== null && previous.type === N.ExpressionStatement) {
            const forInit = data.init;
            if (forInit !== null) {
                if (forInit.type !== N.VariableDeclaration) {
                    const newInit = joinSequence(ctx, previous.data.expression, forInit);
                    replaceExpression(ctx, forInit, newInit);
                    dropStatement(ctx, result.pop() as Node);
                }
            } else {
                data.init = takeNode(ctx, previous.data.expression);
                dropStatement(ctx, result.pop() as Node);
            }
        } else if (previous !== null && previous.type === N.VariableDeclaration) {
            const forInit = data.init;
            const previousData = previous.data as DataOf<'VariableDeclaration'>;
            if (forInit !== null) {
                if (previousData.kind === 'var' && forInit.type === N.VariableDeclaration && forInit.data.kind === 'var') {
                    (forInit.data.declarations as Node[]).unshift(...previousData.declarations.splice(0));
                    dropStatement(ctx, result.pop() as Node);
                }
            } else if (previousData.kind === 'var') {
                data.init = result.pop() as Node;
                noticeChange(ctx);
            }
        }
    }
    result.push(forStatement);
}

const variableDeclarationHasInit = (declaration: Node): boolean =>
    (declaration.data as DataOf<'VariableDeclaration'>).declarations.some(
        (declarator) => (declarator.data as DataOf<'VariableDeclarator'>).init !== null,
    );

function handleForInStatement(ctx: DceCtx, forInStatement: Node, result: Node[]): void {
    const data = forInStatement.data as DataOf<'ForInStatement'>;
    // Annex B.3.5 allows initializers in sloppy mode, evaluated before the right-hand side, so skip the
    // substitution then.
    // <https://tc39.es/ecma262/multipage/additional-ecmascript-features-for-web-browsers.html#sec-initializers-in-forin-statement-heads>
    const left = data.left;
    if (!(left.type === N.VariableDeclaration && variableDeclarationHasInit(left))) {
        const isBlockScopedDecl = left.type === N.VariableDeclaration && left.data.kind !== 'var';
        substituteSingleUseSymbolInStatement(ctx, data.right, result, isBlockScopedDecl);
    }

    if (ctx.state.options.sequences) {
        const previous = lastOf(result);
        if (previous !== null && previous.type === N.ExpressionStatement) {
            // "a; for (var b in c) d" => "for (var b in a, c) d"
            // Only when the for-in variable is a `var` without a side-effectful initializer (Annex
            // B.3.5). A block-scoped declaration could shadow a name the inlined expression reads.
            // <https://github.com/oxc-project/oxc/issues/18650>
            let canInline = true;
            if (data.left.type === N.VariableDeclaration) {
                const leftData = data.left.data as DataOf<'VariableDeclaration'>;
                if (leftData.declarations.length === 1) {
                    const init = (leftData.declarations[0].data as DataOf<'VariableDeclarator'>).init;
                    canInline = leftData.kind === 'var' && !(init !== null && mayHaveSideEffects(init, ctx));
                } else {
                    canInline = false;
                }
            }
            if (canInline) {
                data.right = joinSequence(ctx, previous.data.expression, data.right);
                dropStatement(ctx, result.pop() as Node);
            }
        } else if (previous !== null && previous.type === N.VariableDeclaration) {
            // "var a; for (a in b) c" => "for (var a in b) c"
            const left = data.left;
            if (left.type === N.IdentifierReference) {
                const previousData = previous.data as DataOf<'VariableDeclaration'>;
                if (
                    previousData.kind === 'var' &&
                    previousData.declarations.length === 1 &&
                    (previousData.declarations[0].data as DataOf<'VariableDeclarator'>).init === null
                ) {
                    const declaratorId = (previousData.declarations[0].data as DataOf<'VariableDeclarator'>).id;
                    if (declaratorId.type === N.BindingIdentifier && left.name === declaratorId.name) {
                        result.pop();
                        replaceForStatementLeft(ctx, left, previous);
                    }
                }
            }
        }
    }
    result.push(forInStatement);
}

function handleForOfStatement(ctx: DceCtx, forOfStatement: Node, result: Node[]): void {
    const data = forOfStatement.data as DataOf<'ForOfStatement'>;
    const isBlockScopedDecl = data.left.type === N.VariableDeclaration && data.left.data.kind !== 'var';
    substituteSingleUseSymbolInStatement(ctx, data.right, result, isBlockScopedDecl);

    // "var a; for (a of b) c" => "for (var a of b) c"
    const previous = lastOf(result);
    const left = data.left;
    if (previous !== null && previous.type === N.VariableDeclaration && left.type === N.IdentifierReference) {
        const previousData = previous.data as DataOf<'VariableDeclaration'>;
        if (
            previousData.kind === 'var' &&
            previousData.declarations.length === 1 &&
            (previousData.declarations[0].data as DataOf<'VariableDeclarator'>).init === null
        ) {
            const declaratorId = (previousData.declarations[0].data as DataOf<'VariableDeclarator'>).id;
            if (declaratorId.type === N.BindingIdentifier && left.name === declaratorId.name) {
                result.pop();
                replaceForStatementLeft(ctx, left, previous);
            }
        }
    }
    result.push(forOfStatement);
}

/** esbuild's `appendIfOrLabelBodyPreservingScope`: flatten a block whose statements do not care
 *  about scope. */
function handleBlock(ctx: DceCtx, result: Node[], blockStatement: Node): void {
    const body = (blockStatement.data as DataOf<'BlockStatement'>).body;
    if (body.some(statementCaresAboutScope)) {
        result.push(blockStatement);
    } else {
        for (const statement of body) result.push(statement);
        noticeChange(ctx);
    }
}

/** esbuild's `statementCaresAboutScope`. */
export function statementCaresAboutScope(statement: Node): boolean {
    switch (statement.type) {
        case N.BlockStatement:
        case N.EmptyStatement:
        case N.DebuggerStatement:
        case N.ExpressionStatement:
        case N.IfStatement:
        case N.ForStatement:
        case N.ForInStatement:
        case N.ForOfStatement:
        case N.DoWhileStatement:
        case N.WhileStatement:
        case N.WithStatement:
        case N.TryStatement:
        case N.SwitchStatement:
        case N.ReturnStatement:
        case N.ThrowStatement:
        case N.BreakStatement:
        case N.ContinueStatement:
            return false;
        case N.LabeledStatement:
            return statementCaresAboutScope(statement.data.body);
        case N.VariableDeclaration:
            return statement.data.kind !== 'var';
        default:
            return true;
    }
}

/** Inline single-use declarations from the preceding statement into `exprInStatement`:
 *  `let x = fn(); return x.y();` => `return fn().y();`. esbuild's `substituteSingleUseSymbolInStmt`. */
function substituteSingleUseSymbolInStatement(
    ctx: DceCtx,
    exprInStatement: Node,
    statements: Node[],
    nonScopedLiteralOnly: boolean,
): boolean {
    if (isScriptRootScope(ctx) || scopeContainsDirectEval(currentScopeFlags(ctx))) return false;

    let inlined = false;
    for (;;) {
        const previous = lastOf(statements);
        if (previous === null || previous.type !== N.VariableDeclaration) break;
        const previousData = previous.data as DataOf<'VariableDeclaration'>;
        if (isUsing(previousData.kind)) break;
        const oldLength = previousData.declarations.length;
        const newLength = substituteSingleUseSymbolInExpressionFromDeclarators(
            ctx,
            exprInStatement,
            previousData.declarations,
            nonScopedLiteralOnly,
        );
        // The inlined inits were taken out by the substitution; the declarators still need a drop walk
        // for their type annotations.
        if (newLength === 0) {
            inlined = true;
            statements.pop();
            dropStatement(ctx, previous);
        } else if (oldLength !== newLength) {
            inlined = true;
            for (const declarator of previousData.declarations.splice(newLength)) dropVariableDeclarator(ctx, declarator);
            break;
        } else {
            break;
        }
    }
    return inlined;
}

function substituteSingleUseSymbolWithinDeclaration(ctx: DceCtx, kind: VariableDeclarationKind, declarations: Node[]): boolean {
    if (isScriptRootScope(ctx) || scopeContainsDirectEval(currentScopeFlags(ctx)) || isUsing(kind)) return false;

    let changed = false;
    let index = 1;
    while (index < declarations.length) {
        const declaratorInit = (declarations[index].data as DataOf<'VariableDeclarator'>).init;
        if (declaratorInit === null) {
            index++;
            continue;
        }
        const previousDeclarators = declarations.slice(0, index);
        const oldLength = previousDeclarators.length;
        const newLength = substituteSingleUseSymbolInExpressionFromDeclarators(ctx, declaratorInit, previousDeclarators, false);
        if (oldLength !== newLength) {
            changed = true;
            const dropCount = oldLength - newLength;
            for (const declarator of declarations.splice(index - dropCount, dropCount)) dropVariableDeclarator(ctx, declarator);
            index -= dropCount;
        }
        index++;
    }
    return changed;
}

/** Returns the new length. The consumed suffix `declarators[newLength..]` is the caller's to discard,
 *  through `dropVariableDeclarator` or an enclosing `dropStatement`: the inlined inits are already
 *  taken out, but binding patterns and type annotations can still hold references. */
function substituteSingleUseSymbolInExpressionFromDeclarators(
    ctx: DceCtx,
    targetExpr: Node,
    declarators: readonly Node[],
    nonScopedLiteralOnly: boolean,
): number {
    for (let index = declarators.length - 1; index >= 0; index--) {
        const { id, init } = declarators[index].data as DataOf<'VariableDeclarator'>;
        if (init === null || id.type !== N.BindingIdentifier) return index + 1;
        const symbolId = id.sym;
        // Don't inline `var e` inside `catch (e) { ... }`: the catch parameter and the var share one
        // symbol, and removing the declarator loses the function-scoped hoisting.
        if (symbolIsCatchVariable(symbolFlags(ctx, symbolId))) return index + 1;
        if (isExpressionWhoseNameNeedsToBeKept(ctx, init)) return index + 1;
        const symbolValue = symbolValueOf(ctx.state.symbols, symbolId);
        if (symbolValue === null) return index + 1;
        // Implicitly observable bindings stay live independently of their reference count.
        if (
            isImplicitlyObservable(ctx.state.symbols, symbolId) ||
            countsHaveMultipleReads(symbolValue.references) ||
            countsHaveWrites(symbolValue.references)
        )
            return index + 1;
        if (nonScopedLiteralOnly && !isLiteralValue(init, false, ctx)) return index + 1;
        const replaced = substituteSingleUseSymbolInExpression(ctx, targetExpr, id.name, init, mayHaveSideEffects(init, ctx));
        if (replaced !== true) return index + 1;
    }
    return 0;
}

/** esbuild's `substituteSingleUseSymbolInExpr`. `true` when the expression was replaced, `false` when it
 *  was not and later expressions must not be tried, `null` when it was not and they may be. */
function substituteSingleUseSymbolInExpression(
    ctx: DceCtx,
    targetExpr: Node,
    searchFor: string,
    replacement: Node,
    replacementHasSideEffect: boolean,
): boolean | null {
    const recurse = (expr: Node): boolean | null =>
        substituteSingleUseSymbolInExpression(ctx, expr, searchFor, replacement, replacementHasSideEffect);

    switch (targetExpr.type) {
        case N.IdentifierReference: {
            if (targetExpr.name === searchFor) {
                // Keep the target's span so comments attached to it stay with the replacement.
                const newExpr = takeNode(ctx, replacement);
                const writable = newExpr as { start: number; end: number };
                writable.start = targetExpr.start;
                writable.end = targetExpr.end;
                replaceExpression(ctx, targetExpr, newExpr);
                return true;
            }
            // A read-only binding keeps its value when reordered, unless it is an import (a live
            // binding) or a closed-over lexical that may still be in its TDZ.
            if (!identifierReadBlocksReorder(ctx, targetExpr)) return null;
            break;
        }
        case N.AwaitExpression: {
            const changed = recurse(targetExpr.data.argument);
            if (changed !== null) return changed;
            break;
        }
        case N.YieldExpression: {
            const argument = targetExpr.data.argument as Node | null;
            if (argument !== null) {
                const changed = recurse(argument);
                if (changed !== null) return changed;
            }
            break;
        }
        case N.ImportExpression: {
            const source = targetExpr.data.source as Node;
            const changed = recurse(source);
            if (changed !== null) return changed;
            // `import()`'s side effects are asynchronous, so they cannot modify the replacement value.
            if (!replacementHasSideEffect && !mayHaveSideEffects(source, ctx)) return null;
            break;
        }
        case N.UnaryExpression: {
            if (targetExpr.data.operator !== 'delete') {
                const changed = recurse(targetExpr.data.argument);
                if (changed !== null) return changed;
            }
            break;
        }
        case N.StaticMemberExpression: {
            const changed = recurse(targetExpr.data.object);
            if (changed !== null) return changed;
            break;
        }
        case N.BinaryExpression: {
            // `#x in y` is oxc's `PrivateInExpression`, which only substitutes into its right side.
            if (targetExpr.data.left.type === N.PrivateIdentifier) {
                const changed = recurse(targetExpr.data.right);
                if (changed !== null) return changed;
                break;
            }
            const leftChanged = recurse(targetExpr.data.left);
            if (leftChanged !== null) return leftChanged;
            const rightChanged = recurse(targetExpr.data.right);
            if (rightChanged !== null) return rightChanged;
            break;
        }
        case N.AssignmentExpression: {
            const left = targetExpr.data.left as Node;
            // A side effect in the assignment target may change the replacement value (`foo[fn()] = a`).
            if (assignmentTargetMayHaveSideEffects(left, ctx)) return false;
            // A read-modify-write target is read, so the replacement's side effect may change it
            // (`let a = fn(); foo += a;`).
            if (targetExpr.data.operator !== '=' && replacementHasSideEffect) return false;
            if (replacementHasSideEffect) {
                // The non-last part of the target evaluates before the assignment, so the
                // replacement's side effect may change it (`let a = fn(); foo.bar = a;`).
                let mayDependOnSideEffect: boolean;
                switch (left.type) {
                    case N.IdentifierReference:
                        mayDependOnSideEffect = false;
                        break;
                    case N.ComputedMemberExpression:
                        mayDependOnSideEffect =
                            memberPartBlocksReorder(ctx, left.data.object) || computedKeyBlocksReorder(ctx, left.data.expression);
                        break;
                    case N.PrivateFieldExpression:
                    case N.StaticMemberExpression:
                        mayDependOnSideEffect = memberPartBlocksReorder(ctx, left.data.object);
                        break;
                    default:
                        mayDependOnSideEffect = true;
                }
                if (mayDependOnSideEffect) return false;
            }
            // It is safe to substitute past the left operand into the right operand.
            const changed = recurse(targetExpr.data.right);
            if (changed !== null) return changed;
            break;
        }
        case N.LogicalExpression: {
            const leftChanged = recurse(targetExpr.data.left);
            if (leftChanged !== null) return leftChanged;
            // Only a side-effect-free value may move into a conditionally executed branch.
            if (!replacementHasSideEffect) {
                const rightChanged = recurse(targetExpr.data.right);
                if (rightChanged !== null) return rightChanged;
            }
            break;
        }
        case N.ConditionalExpression: {
            const testChanged = recurse(targetExpr.data.test);
            if (testChanged !== null) return testChanged;
            // Only a side-effect-free value may move into a conditionally executed branch. Both
            // branches may evaluate, so try either; side effects in one don't block the other.
            if (!replacementHasSideEffect) {
                const consequentChanged = recurse(targetExpr.data.consequent);
                if (consequentChanged === true) return consequentChanged;
                const alternateChanged = recurse(targetExpr.data.alternate);
                if (alternateChanged === true) return alternateChanged;
                // Side effects in either branch stop the substitution after the branches merge.
                if (consequentChanged === false || alternateChanged === false) return false;
            }
            break;
        }
        case N.ComputedMemberExpression: {
            const objectChanged = recurse(targetExpr.data.object);
            if (objectChanged !== null) return objectChanged;
            // Only a side-effect-free value may move into a conditionally executed branch.
            if (!replacementHasSideEffect || !targetExpr.data.optional) {
                const expressionChanged = recurse(targetExpr.data.expression);
                if (expressionChanged !== null) return expressionChanged;
            }
            break;
        }
        case N.PrivateFieldExpression: {
            const changed = recurse(targetExpr.data.object);
            if (changed !== null) return changed;
            break;
        }
        case N.CallExpression: {
            // Don't substitute something into a call target that could change `this`.
            if (replacementChangesThis(replacement, targetExpr.data.callee)) break;
            const calleeChanged = recurse(targetExpr.data.callee);
            if (calleeChanged !== null) return calleeChanged;
            // Only a side-effect-free value may move into a conditionally executed branch.
            if (!replacementHasSideEffect || !targetExpr.data.optional) {
                const changed = substituteIntoArguments(targetExpr.data.arguments, recurse);
                if (changed !== null) return changed;
            }
            break;
        }
        case N.NewExpression: {
            // Don't substitute something into a call target that could change `this`.
            if (replacementChangesThis(replacement, targetExpr.data.callee)) break;
            const calleeChanged = recurse(targetExpr.data.callee);
            if (calleeChanged !== null) return calleeChanged;
            const changed = substituteIntoArguments(targetExpr.data.arguments, recurse);
            if (changed !== null) return changed;
            break;
        }
        case N.ArrayExpression: {
            for (const element of targetExpr.data.elements as (Node | null)[]) {
                if (element === null) continue;
                if (element.type === N.SpreadElement) {
                    const changed = recurse(element.data.argument);
                    if (changed !== null) return changed;
                    // A spread element may have side effects.
                    return false;
                }
                const changed = recurse(element);
                if (changed !== null) return changed;
            }
            break;
        }
        case N.ObjectExpression: {
            for (const property of targetExpr.data.properties as Node[]) {
                if (property.type === N.ObjectProperty) {
                    const propertyData = property.data as DataOf<'ObjectProperty'>;
                    if (propertyData.computed) {
                        const changed = recurse(propertyData.key);
                        if (changed !== null) return changed;
                        // Computed keys have side effects.
                        return false;
                    }
                    const changed = recurse(propertyData.value);
                    if (changed !== null) {
                        const key = propertyData.key;
                        if (propertyData.shorthand && key.type === N.IdentifierName && key.name === '__proto__') {
                            // `{ __proto__ }` => `{ ['__proto__']: value }`
                            propertyData.computed = true;
                            propertyData.key = node(N.StringLiteral, key.start, key.end, '"__proto__"', null);
                        }
                        propertyData.shorthand = false;
                        return changed;
                    }
                } else {
                    const changed = recurse((property.data as DataOf<'SpreadElement'>).argument);
                    if (changed !== null) return changed;
                    // Spread properties have side effects.
                    return false;
                }
            }
            break;
        }
        case N.TaggedTemplateExpression: {
            const tagChanged = recurse(targetExpr.data.tag);
            if (tagChanged !== null) return tagChanged;
            for (const element of (targetExpr.data.quasi.data as DataOf<'TemplateLiteral'>).expressions) {
                const changed = recurse(element);
                if (changed !== null) return changed;
            }
            break;
        }
        case N.TemplateLiteral: {
            for (const element of targetExpr.data.expressions as Node[]) {
                const changed = recurse(element);
                if (changed !== null) return changed;
            }
            break;
        }
        case N.ChainExpression:
            return recurse(targetExpr.data.expression);
        case N.SequenceExpression: {
            for (const item of targetExpr.data.expressions as Node[]) {
                const changed = recurse(item);
                if (changed !== null) return changed;
            }
            break;
        }
    }

    // Reordering the replacement past this expression is fine when neither has observable side
    // effects. `let replacement = fn(); return x + replacement;` is not (`fn()` may change `x`), nor
    // is `let replacement = [x]; return (x == x) + replacement;` (`valueOf()` may change `x`).
    if (!replacementHasSideEffect && !mayHaveSideEffects(targetExpr, ctx)) return null;

    // Literal values can always be reordered past.
    if (isLiteralValue(replacement, true, ctx) || isLiteralValue(targetExpr, true, ctx)) return null;

    // Otherwise stop substituting here.
    return false;
}

const isMemberExpression = (expr: Node): boolean =>
    expr.type === N.StaticMemberExpression || expr.type === N.ComputedMemberExpression || expr.type === N.PrivateFieldExpression;

/** A member or chain replacement moved into an identifier callee would change the call's `this`. */
const replacementChangesThis = (replacement: Node, callee: Node): boolean =>
    (isMemberExpression(replacement) || replacement.type === N.ChainExpression) && callee.type === N.IdentifierReference;

function substituteIntoArguments(argumentList: Node[], recurse: (expr: Node) => boolean | null): boolean | null {
    for (const argument of argumentList) {
        if (argument.type === N.SpreadElement) {
            const changed = recurse(argument.data.argument);
            if (changed !== null) return changed;
            // A spread element may have side effects.
            return false;
        }
        const changed = recurse(argument);
        if (changed !== null) return changed;
    }
    return null;
}

/** An unconditional termination that can be removed: an unlabeled `continue` ending a loop body, an
 *  unlabeled `break` ending a `do...while (false)` body, or a bare `return` ending a function body. */
function canRemoveTerminationStatement(ctx: DceCtx, statement: Node): boolean {
    switch (statement.type) {
        case N.ContinueStatement: {
            if (statement.data.label !== null) return false;
            const loopKind = ancestor(ctx, 1).kind;
            return (
                loopKind === 'ForStatementBody' ||
                loopKind === 'ForInStatementBody' ||
                loopKind === 'ForOfStatementBody' ||
                loopKind === 'WhileStatementBody' ||
                loopKind === 'DoWhileStatementBody'
            );
        }
        case N.BreakStatement: {
            if (statement.data.label !== null) return false;
            const loop = ancestor(ctx, 1);
            if (loop.kind !== 'DoWhileStatementBody') return false;
            return getSideFreeBooleanValue((loop.node.data as DataOf<'DoWhileStatement'>).test, ctx) === false;
        }
        case N.ReturnStatement:
            return statement.data.argument === null && parentKind(ctx) === 'FunctionBodyStatements';
        default:
            return false;
    }
}

/** oxc `FindNestedBreak::has_unlabelled_break_in_switch_case`: an unlabeled `break` in the case's
 *  statements that would exit the switch. Expressions, declarations, loops and nested switches are
 *  not searched. */
function hasUnlabelledBreakInSwitchCase(switchCase: Node): boolean {
    return (switchCase.data as DataOf<'SwitchCase'>).consequent.some(findNestedBreak);
}

function findNestedBreak(statement: Node): boolean {
    switch (statement.type) {
        case N.BreakStatement:
            return statement.data.label === null;
        case N.BlockStatement:
            return (statement.data.body as Node[]).some(findNestedBreak);
        case N.IfStatement:
            return (
                findNestedBreak(statement.data.consequent) ||
                (statement.data.alternate !== null && findNestedBreak(statement.data.alternate))
            );
        case N.LabeledStatement:
        case N.WithStatement:
            return findNestedBreak(statement.data.body);
        case N.TryStatement: {
            const { block, handler, finalizer } = statement.data as DataOf<'TryStatement'>;
            return (
                findNestedBreak(block) ||
                (handler !== null && findNestedBreak((handler.data as DataOf<'CatchClause'>).body)) ||
                (finalizer !== null && findNestedBreak(finalizer))
            );
        }
        default:
            return false;
    }
}
