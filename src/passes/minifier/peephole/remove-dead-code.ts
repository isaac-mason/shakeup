// Port of oxc_minifier/src/peephole/remove_dead_code.rs.

import { evaluateValueToBoolean, numericLiteralValue } from '../../../analysis/const-eval.ts';
import { mayHaveSideEffects, someMayHaveSideEffects } from '../../../analysis/side-effects.ts';
import { create, type DataOf, N, type Node, node } from '../../../ast/index.ts';
import {
    createKeepVar,
    keepVarVariableDeclaration,
    keepVarVariableDeclarationStatement,
    keepVarVisitBlockStatement,
    keepVarVisitStatement,
} from '../keep-var.ts';
import { functionSummaryReturnsUndefined } from '../symbol-metadata.ts';
import { clearFunctionSummary, functionSummary, setFunctionSummary } from '../symbol-state.ts';
import { referenceIsReadOnly, scopeContainsDirectEval } from '../syntax.ts';
import {
    createVoidZero,
    type DceCtx,
    dropExpression,
    dropStatement,
    getReference,
    getResolvedReferences,
    isGlobalReference,
    noticeChange,
    parent,
    parentKind,
    replaceExpression,
    replaceStatement,
    type Span,
    scopeFlags,
    symbolRedeclarations,
    symbolScopeId,
    takeNode,
} from '../traverse-context.ts';
import { removeUnusedVariableDeclaration } from './remove-unused-declaration.ts';
import { foldArgumentsIntoNeededExpressions, removeUnusedExpression } from './remove-unused-expression.ts';

/** Record a function summary for side-effect-free functions declared by `statement`. */
export function keepTrackOfPureFunctions(ctx: DceCtx, statement: Node): void {
    switch (statement.type) {
        case N.FunctionDeclaration: {
            const body = statement.data.body as Node | null;
            if (body === null) return;
            const statements = (body.data as DataOf<'BlockStatement'>).body;
            trySavePureFunction(
                ctx,
                statement.data.id,
                statement.data.params,
                statement.data.async,
                statement.data.generator,
                someMayHaveSideEffects(statements, ctx),
                statements.length === 0,
            );
            return;
        }
        case N.VariableDeclaration:
            for (const declarator of statement.data.declarations as Node[]) {
                const { id, init } = declarator.data as DataOf<'VariableDeclarator'>;
                if (id.type !== N.BindingIdentifier || init === null) continue;
                if (init.type === N.ArrowFunctionExpression) {
                    const body = init.data.body as Node;
                    const isBlock = body.type === N.BlockStatement;
                    const bodyHasSideEffects = isBlock
                        ? someMayHaveSideEffects(body.data.body as Node[], ctx)
                        : mayHaveSideEffects(body, ctx);
                    const bodyIsEmpty = isBlock && (body.data.body as Node[]).length === 0;
                    trySavePureFunction(ctx, id, init.data.params, init.data.async, false, bodyHasSideEffects, bodyIsEmpty);
                } else if (init.type === N.FunctionExpression) {
                    const body = init.data.body as Node | null;
                    if (body === null) continue;
                    const statements = (body.data as DataOf<'BlockStatement'>).body;
                    trySavePureFunction(
                        ctx,
                        id,
                        init.data.params,
                        init.data.async,
                        init.data.generator,
                        someMayHaveSideEffects(statements, ctx),
                        statements.length === 0,
                    );
                }
            }
            return;
    }
}

function trySavePureFunction(
    ctx: DceCtx,
    id: Node | null,
    params: readonly Node[],
    isAsync: boolean,
    generator: boolean,
    bodyHasSideEffects: boolean,
    returnsUndefined: boolean,
): void {
    if (isAsync || generator) return;
    // Destructuring can throw, and default initializers run for missing arguments, so every
    // parameter must be a plain binding with a side-effect-free initializer. The rest parameter is
    // not one of oxc's `items`.
    for (const param of params) {
        if (param.type !== N.FormalParameter) continue;
        if (param.data.pattern.type !== N.BindingIdentifier) return;
        const init = param.data.init as Node | null;
        if (init !== null && mayHaveSideEffects(init, ctx)) return;
    }
    if (bodyHasSideEffects) return;
    const symbolId = id === null ? 0 : id.sym;
    if (symbolId === 0) return;
    const bindingScopeId = symbolScopeId(ctx, symbolId);
    const bindingScopeFlags = scopeFlags(ctx, bindingScopeId);
    // Redeclarations create no references, so another declaration of the symbol may be impure and win.
    if (symbolRedeclarations(ctx, symbolId).length > 0) {
        clearFunctionSummary(ctx.state.symbols, symbolId);
        return;
    }
    // Direct eval and Script global properties can replace the binding without a resolved write.
    if (
        scopeContainsDirectEval(bindingScopeFlags) ||
        (ctx.state.sourceType === 'script' && bindingScopeId === ctx.scoping.rootScopeId)
    ) {
        clearFunctionSummary(ctx.state.symbols, symbolId);
        return;
    }
    if (getResolvedReferences(ctx, symbolId).every((reference) => referenceIsReadOnly(reference.flags))) {
        setFunctionSummary(
            ctx.state.symbols,
            symbolId,
            returnsUndefined ? 'side-effect-free-returns-undefined' : 'side-effect-free',
        );
    }
}

/** `{ block } -> block` */
export function tryOptimizeBlock(ctx: DceCtx, statement: Node): void {
    if (statement.type !== N.BlockStatement) return;
    const body = statement.data.body as Node[];
    switch (body.length) {
        case 0:
            switch (parentKind(ctx)) {
                case 'WhileStatementBody':
                case 'DoWhileStatementBody':
                case 'ForStatementBody':
                case 'ForInStatementBody':
                case 'ForOfStatementBody':
                case 'BlockStatementBody':
                case 'ProgramBody':
                    replaceStatement(ctx, statement, createEmptyStatement(statement));
            }
            return;
        case 1: {
            const first = body[0];
            if (
                (first.type === N.VariableDeclaration && first.data.kind !== 'var') ||
                first.type === N.ClassDeclaration ||
                first.type === N.FunctionDeclaration ||
                (first.type === N.IfStatement && first.data.alternate !== null && parentKind(ctx) === 'IfStatementConsequent')
            )
                return;
            body.splice(0, 1);
            replaceStatement(ctx, statement, first);
            return;
        }
    }
}

export function tryFoldIf(ctx: DceCtx, statement: Node): void {
    if (statement.type !== N.IfStatement) return;
    const ifData = statement.data as DataOf<'IfStatement'>;
    // Descend and remove `else` blocks first.
    const alternate = ifData.alternate as Node | null;
    if (alternate !== null) {
        if (alternate.type === N.IfStatement) tryFoldIf(ctx, alternate);
        else if (alternate.type === N.BlockStatement && (alternate.data.body as Node[]).length === 0) ifData.alternate = null;
        else if (alternate.type === N.EmptyStatement) ifData.alternate = null;
    }

    const boolean = evaluateValueToBoolean(ifData.test, ctx);
    if (boolean === null) return;
    const testHasSideEffects = mayHaveSideEffects(ifData.test, ctx);
    // `1`/`0` rather than `true`/`false`: shorter, and `!0` cannot swap the branches. Skipped when the
    // test is already that literal, so the loop converges.
    if (!testHasSideEffects && !isCanonicalNumericTest(ifData.test, boolean)) {
        replaceExpression(ctx, ifData.test, createNumericLiteral(ifData.test, boolean ? 1 : 0));
    }
    const keepVar = createKeepVar();
    if (boolean) {
        if (ifData.alternate !== null) keepVarVisitStatement(keepVar, ifData.alternate);
    } else {
        keepVarVisitStatement(keepVar, ifData.consequent);
    }
    const keptStatement = keepVarVariableDeclarationStatement(keepVar);
    const varStatement = keptStatement === null ? null : removeUnusedVariableDeclaration(ctx, keptStatement);
    const hasVarStatement = varStatement !== null;
    if (varStatement !== null) {
        // Skipped when the slot is already KeepVar's shape, which the next pass would re-emit.
        if (boolean) {
            const currentAlternate = ifData.alternate as Node | null;
            const alreadyCanonical = currentAlternate !== null && isKeepVarCanonical(currentAlternate);
            if (!alreadyCanonical) {
                if (currentAlternate !== null) {
                    replaceStatement(ctx, currentAlternate, varStatement);
                } else {
                    ifData.alternate = varStatement;
                    noticeChange(ctx);
                }
            }
        } else if (!isKeepVarCanonical(ifData.consequent)) {
            replaceStatement(ctx, ifData.consequent, varStatement);
        }
        return;
    }
    if (testHasSideEffects) {
        if (!hasVarStatement) {
            if (boolean) {
                const old = ifData.alternate as Node | null;
                if (old !== null) {
                    ifData.alternate = null;
                    dropStatement(ctx, old);
                }
            } else if (ifData.consequent.type !== N.EmptyStatement) {
                replaceStatement(ctx, ifData.consequent, createEmptyStatement(ifData.consequent));
            }
        }
        return;
    }
    let newStatement: Node;
    if (boolean) {
        newStatement = takeNode(ctx, ifData.consequent);
    } else if (ifData.alternate !== null) {
        newStatement = ifData.alternate;
        ifData.alternate = null;
    } else {
        newStatement = createEmptyStatement(statement);
    }
    replaceStatement(ctx, statement, newStatement);
}

const isCanonicalNumericTest = (test: Node, boolean: boolean): boolean =>
    test.type === N.NumericLiteral && numericLiteralValue(test) === (boolean ? 1 : 0);

/** Already the shape `KeepVar` emits: a `var` whose declarators all lack initializers. */
function isKeepVarCanonical(statement: Node): boolean {
    return (
        statement.type === N.VariableDeclaration &&
        statement.data.kind === 'var' &&
        (statement.data.declarations as Node[]).every(
            (declarator) => (declarator.data as DataOf<'VariableDeclarator'>).init === null,
        )
    );
}

export function tryFoldFor(ctx: DceCtx, statement: Node): void {
    if (statement.type !== N.ForStatement) return;
    const forData = statement.data as DataOf<'ForStatement'>;
    const init = forData.init as Node | null;
    if (init !== null && init.type !== N.VariableDeclaration && removeUnusedExpression(ctx, init)) {
        dropExpression(ctx, init);
        forData.init = null;
    }
    const update = forData.update as Node | null;
    if (update !== null && removeUnusedExpression(ctx, update)) {
        dropExpression(ctx, update);
        forData.update = null;
    }

    const test = forData.test as Node | null;
    const testBoolean = test === null ? null : evaluateValueToBoolean(test, ctx);
    if (test !== null && mayHaveSideEffects(test, ctx)) return;
    if (testBoolean === false) {
        const currentInit = forData.init as Node | null;
        if (currentInit !== null && currentInit.type === N.VariableDeclaration) {
            const keepVar = createKeepVar();
            keepVarVisitStatement(keepVar, forData.body);
            let varDeclaration = keepVarVariableDeclaration(keepVar);
            if (currentInit.data.kind === 'var') {
                if (varDeclaration !== null) {
                    const initDeclarations = (currentInit.data.declarations as Node[]).splice(0);
                    (varDeclaration.data as DataOf<'VariableDeclaration'>).declarations.splice(0, 0, ...initDeclarations);
                } else {
                    varDeclaration = takeNode(ctx, currentInit);
                }
            }
            replaceStatement(ctx, statement, varDeclaration ?? createEmptyStatement(statement));
        } else if (currentInit === null) {
            const keepVar = createKeepVar();
            keepVarVisitStatement(keepVar, forData.body);
            replaceStatement(ctx, statement, keepVarVariableDeclaration(keepVar) ?? createEmptyStatement(statement));
        }
    } else if (testBoolean === true) {
        // Remove the test expression.
        if (test !== null) {
            forData.test = null;
            dropExpression(ctx, test);
        }
    }
}

/** Remove meaningless labeled statements: `a: break a;` */
export function tryFoldLabeled(ctx: DceCtx, statement: Node): void {
    if (statement.type !== N.LabeledStatement) return;
    const labeledData = statement.data as DataOf<'LabeledStatement'>;
    const id = labeledData.label.name;

    if (ctx.state.options.dropLabels.has(id)) {
        replaceStatement(ctx, statement, createEmptyStatement(statement));
        return;
    }

    // Check the first statement in the block, or just the `break [id]` statement.
    const body = labeledData.body;
    switch (body.type) {
        case N.BreakStatement:
            if (!breaksLabel(body, id)) return;
            break;
        case N.BlockStatement: {
            const first = (body.data.body as Node[])[0] as Node | undefined;
            if (first === undefined || first.type !== N.BreakStatement || !breaksLabel(first, id)) return;
            break;
        }
        case N.EmptyStatement:
            replaceStatement(ctx, statement, createEmptyStatement(statement));
            return;
        default:
            return;
    }
    const keepVar = createKeepVar();
    keepVarVisitStatement(keepVar, body);
    replaceStatement(ctx, statement, keepVarVariableDeclarationStatement(keepVar) ?? createEmptyStatement(statement));
}

function breaksLabel(breakStatement: Node, id: string): boolean {
    const label = (breakStatement.data as DataOf<'BreakStatement'>).label as Node | null;
    return label !== null && label.name === id;
}

export function tryFoldExpressionStmt(ctx: DceCtx, statement: Node): void {
    if (statement.type !== N.ExpressionStatement) return;
    if (removeUnusedExpression(ctx, statement.data.expression)) {
        replaceStatement(ctx, statement, createEmptyStatement(statement));
    }
}

export function tryFoldTry(ctx: DceCtx, statement: Node): void {
    if (statement.type !== N.TryStatement) return;
    const tryData = statement.data as DataOf<'TryStatement'>;
    const blockBody = (tryData.block.data as DataOf<'BlockStatement'>).body;
    const handler = tryData.handler as Node | null;
    if (handler !== null && blockBody.length === 0) {
        const handlerBlock = (handler.data as DataOf<'CatchClause'>).body;
        const handlerBody = (handlerBlock.data as DataOf<'BlockStatement'>).body;
        const isCanonicalBody = handlerBody.length === 0 || (handlerBody.length === 1 && isKeepVarCanonical(handlerBody[0]));
        if (!isCanonicalBody) {
            const keepVar = createKeepVar();
            keepVarVisitBlockStatement(keepVar, handlerBlock);
            for (const dropped of handlerBody.splice(0)) dropStatement(ctx, dropped);
            const varDeclaration = keepVarVariableDeclarationStatement(keepVar);
            if (varDeclaration !== null) handlerBody.push(varDeclaration);
        }
    }

    const finalizer = tryData.finalizer as Node | null;
    if (finalizer !== null && (finalizer.data as DataOf<'BlockStatement'>).body.length === 0 && tryData.handler !== null) {
        tryData.finalizer = null;
    }

    const currentHandler = tryData.handler as Node | null;
    if (
        blockBody.length === 0 &&
        (currentHandler === null ||
            ((currentHandler.data as DataOf<'CatchClause'>).body.data as DataOf<'BlockStatement'>).body.length === 0)
    ) {
        const currentFinalizer = tryData.finalizer as Node | null;
        replaceStatement(
            ctx,
            statement,
            currentFinalizer !== null ? takeNode(ctx, currentFinalizer) : createEmptyStatement(statement),
        );
    }
}

/** Fold `?:` when the test's boolean value is known. */
export function tryFoldConditionalExpression(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.ConditionalExpression) return;
    const conditionalData = expr.data as DataOf<'ConditionalExpression'>;
    const value = evaluateValueToBoolean(conditionalData.test, ctx);
    if (value === null) return;
    let newExpr: Node;
    if (mayHaveSideEffects(conditionalData.test, ctx)) {
        // "(a, true) ? b : c" => "a, b"
        const test = takeNode(ctx, conditionalData.test);
        removeUnusedExpression(ctx, test);
        const result = takeNode(ctx, value ? conditionalData.consequent : conditionalData.alternate);
        newExpr = create.SequenceExpression(expr.start, expr.end, 0, [test, result]);
    } else {
        const resultExpr = takeNode(ctx, value ? conditionalData.consequent : conditionalData.alternate);
        // "(1 ? a.b : 0)()" => "(0, a.b)()"
        newExpr = shouldKeepIndirectAccess(ctx, resultExpr)
            ? create.SequenceExpression(expr.start, expr.end, 0, [createNumericLiteral(expr, 0), resultExpr])
            : resultExpr;
    }
    replaceExpression(ctx, expr, newExpr);
}

export function removeSequenceExpression(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.SequenceExpression) return;
    const expressions = expr.data.expressions as Node[];
    const shouldKeepAsSequenceExpr = expressions.length > 0 && shouldKeepIndirectAccess(ctx, expressions[expressions.length - 1]);
    if (shouldKeepAsSequenceExpr && expressions.length === 2 && isNumber0(expressions[0])) return;
    const oldLength = expressions.length;
    let kept = 0;
    for (let index = 0; index < oldLength; index++) {
        const item = expressions[index];
        const position = index + 1;
        let keep = true;
        if (shouldKeepAsSequenceExpr && position === oldLength - 1) {
            // Skipped when already the `0` placeholder, so the loop converges.
            if (!isNumber0(item) && removeUnusedExpression(ctx, item)) {
                replaceExpression(ctx, item, createNumericLiteral(item, 0));
            }
        } else if (position !== oldLength && removeUnusedExpression(ctx, item)) {
            dropExpression(ctx, item);
            keep = false;
        }
        if (keep) expressions[kept++] = item;
    }
    expressions.length = kept;
    if (expressions.length === 1) {
        const newExpr = expressions.pop() as Node;
        replaceExpression(ctx, expr, newExpr);
    }
}

export function removeDeadCodeCallExpression(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.CallExpression) return;
    const callee = expr.data.callee as Node;
    if (callee.type !== N.IdentifierReference) return;
    const symbolId = getReference(ctx, callee).symbolId;
    if (symbolId === 0 || !functionSummaryReturnsUndefined(functionSummary(ctx.state.symbols, symbolId))) return;
    const expressions = foldArgumentsIntoNeededExpressions(ctx, expr.data.arguments);
    if (expressions.length === 0) {
        replaceExpression(ctx, expr, createVoidZero(expr));
        return;
    }
    expressions.push(createVoidZero(expr));
    replaceExpression(ctx, expr, create.SequenceExpression(expr.start, expr.end, 0, expressions));
}

/** Whether the indirect access should be kept: `(0, foo.bar)()` must not become `foo.bar()`.
 *  `accessValue` is the expression that may need to stay an indirect reference. */
export function shouldKeepIndirectAccess(ctx: DceCtx, accessValue: Node): boolean {
    switch (parentKind(ctx)) {
        case 'CallExpressionCallee':
        case 'TaggedTemplateExpressionTag':
            switch (accessValue.type) {
                case N.IdentifierReference:
                    return accessValue.name === 'eval' && isGlobalReference(ctx, accessValue);
                case N.StaticMemberExpression:
                case N.ComputedMemberExpression:
                case N.PrivateFieldExpression:
                    return true;
                default:
                    return false;
            }
        case 'UnaryExpressionArgument':
            switch ((parent(ctx).node.data as DataOf<'UnaryExpression'>).operator) {
                case 'typeof':
                    // `typeof (0, foo)` (error) -> `typeof foo` (no error)
                    return accessValue.type === N.IdentifierReference && isGlobalReference(ctx, accessValue);
                case 'delete':
                    switch (accessValue.type) {
                        // `delete (0, foo)` (no error) -> `delete foo` (error)
                        case N.IdentifierReference:
                        // `delete (0, foo.#a)` (no error) -> `delete foo.#a` (error)
                        case N.PrivateFieldExpression:
                        // `delete (0, foo.bar)` (noop) -> `delete foo.bar` (deletes bar)
                        case N.ComputedMemberExpression:
                        case N.StaticMemberExpression:
                            return true;
                        // `delete (0, foo?.bar)` (noop) -> `delete foo?.bar` (deletes bar)
                        case N.ChainExpression: {
                            const element = accessValue.data.expression as Node;
                            return (
                                element.type === N.StaticMemberExpression ||
                                element.type === N.ComputedMemberExpression ||
                                element.type === N.PrivateFieldExpression
                            );
                        }
                        default:
                            return false;
                    }
                default:
                    return false;
            }
        default:
            return false;
    }
}

/** Wrap `expr` as `(0, expr)` so an access `shouldKeepIndirectAccess` flagged stays indirect. The shape
 *  is load-bearing: `removeSequenceExpression` recognizes exactly a two-element sequence headed by `0`. */
export function preserveIndirectAccess(span: Span, expr: Node): Node {
    return create.SequenceExpression(span.start, span.end, 0, [createNumericLiteral(span, 0), expr]);
}

/** Drop empty static blocks. `classNode` stands in for oxc's `ClassBody`. */
export function removeDeadCodeExitClassBody(_ctx: DceCtx, classNode: Node): void {
    const body = (classNode.data as DataOf<'ClassExpression'>).body;
    let kept = 0;
    for (const element of body) {
        if (element.type === N.StaticBlock && (element.data.body as Node[]).length === 0) continue;
        body[kept++] = element;
    }
    // An empty list may be the parser's shared frozen one.
    if (kept !== body.length) body.length = kept;
}

/** `f(...[])` -> `f()` */
export function removeEmptySpreadArguments(args: Node[]): void {
    if (args.length !== 1) return;
    const spread = args[0];
    if (spread.type !== N.SpreadElement) return;
    const argument = spread.data.argument as Node;
    if (argument.type !== N.ArrayExpression) return;
    if ((argument.data.elements as (Node | null)[]).length === 0) args.length = 0;
}

const isNumber0 = (expr: Node): boolean => expr.type === N.NumericLiteral && numericLiteralValue(expr) === 0;

const createEmptyStatement = (span: Span): Node => create.EmptyStatement(span.start, span.end, 0);

const createNumericLiteral = (span: Span, value: number): Node =>
    node(N.NumericLiteral, span.start, span.end, String(value), null);
