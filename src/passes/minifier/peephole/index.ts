// Port of oxc_minifier/src/peephole/mod.rs: the `Traverse` impl for `PeepholeOptimizations`, tree-shake
// branches only, and the helper predicates the peephole files share. Each hook calls into the peephole
// files in oxc's order.

import { isLiteralValue } from '../../../analysis/const-eval.ts';
import { type DataOf, N, type Node } from '../../../ast/index.ts';
import {
    type BodyFrame,
    enterClassPrivateMembers,
    exitClassPrivateMembers,
    isTreeShakeOnly,
    lastBodyFrame,
    privateMembersAtRoot,
    recordPrivateMemberUse,
} from '../state.ts';
import { symbolValueOf } from '../symbol-state.ts';
import { countsHaveWrites } from '../symbol-value.ts';
import { scopeIsFunction, symbolIsBlockScoped, symbolIsImport } from '../syntax.ts';
import {
    type DceCtx,
    getReference,
    parentKind,
    replaceExpression,
    replaceStatement,
    scopeAncestors,
    scopeFlags,
    symbolFlags,
    symbolIsMutated,
    symbolScopeId,
} from '../traverse-context.ts';
import type { Traverser } from '../traverse.ts';
import {
    foldBinaryExpr,
    foldBinaryTypeofComparison,
    foldCallExpression,
    foldChainExpr,
    foldComputedMemberExpr,
    foldLogicalExpr,
    foldObjectExp,
    foldSequenceExpression,
    foldStaticMemberExpr,
    foldUnaryExpr,
    inlineTemplateLiteral,
} from './fold-constants.ts';
import {
    initClassDeclarationSymbolValue,
    initFunctionDeclarationSymbolValue,
    initSymbolValue,
    inlineIdentifierReference,
} from './inline.ts';
import { convertToDottedProperties } from './convert-to-dotted-properties.ts';
import { minimizeConditionalExpression } from './minimize-conditional-expression.ts';
import {
    minimizeAssignmentToUpdateExpression,
    minimizeBinary,
    minimizeLooseBoolean,
    minimizeNormalAssignmentToCombinedAssignment,
    minimizeNormalAssignmentToCombinedLogicalAssignment,
} from './minimize-conditions.ts';
import { minimizeExpressionInBooleanContext } from './minimize-expression-in-boolean-context.ts';
import { minimizeForStatement } from './minimize-for-statement.ts';
import { tryMinimizeIf } from './minimize-if-statement.ts';
import { minimizeLogicalExpression } from './minimize-logical-expression.ts';
import { minimizeUnary } from './minimize-not-expression.ts';
import { minimizeStatements } from './minimize-statements.ts';
import { setNoSideEffectsToCallExpr, setPureOrNoSideEffectsToNewExpr } from './normalize.ts';
import {
    substituteAccessorProperty,
    substituteArrayExpression,
    substituteArrowExpression,
    substituteAssignmentTargetProperty,
    substituteAssignmentTargetPropertyProperty,
    substituteBindingProperty,
    substituteBoolean,
    substituteCallExpression,
    substituteCatchClause,
    substituteChainExpression,
    substituteForStatement,
    substituteGlobalNewExpression,
    substituteIifeCall,
    substituteIsObjectAndNotNull,
    substituteLooseEqualsUndefined,
    substituteMethodDefinition,
    substituteNewExpression,
    substituteObjectOrArrayConstructor,
    substituteObjectProperty,
    substitutePropertyDefinition,
    substituteReturnStatement,
    substituteRotateBinaryExpression,
    substituteRotateLogicalExpression,
    substituteSimpleFunctionCall,
    substituteSwapBinaryExpressions,
    substituteTemplateLiteral,
    substituteTypedArrayConstructor,
    substituteTypeofUndefined,
    substituteUnaryPlus,
    substituteVariableDeclaration,
    tryFlattenArrayExpressionElements,
    tryRemoveNameFromClasses,
    tryRemoveNameFromFunctions,
} from './substitute-alternate-syntax.ts';
import {
    keepTrackOfPureFunctions,
    removeDeadCodeCallExpression,
    removeDeadCodeExitClassBody,
    removeEmptySpreadArguments,
    removeSequenceExpression,
    tryFoldConditionalExpression,
    tryFoldExpressionStmt,
    tryFoldFor,
    tryFoldIf,
    tryFoldLabeled,
    tryFoldTry,
    tryOptimizeBlock,
} from './remove-dead-code.ts';
import {
    removeUnusedClassDeclaration,
    removeUnusedFunctionDeclaration,
    removeUnusedImportSpecifiers,
} from './remove-unused-declaration.ts';
import { derivedConstructorThisScope, removeUnusedAssignmentExpr } from './remove-unused-expression.ts';
import { replaceConcatChain, replaceKnownGlobalMethods, replaceKnownPropertyAccess } from './replace-known-methods.ts';
import { declaredPrivateMemberNames, removeUnusedPrivateMembers } from './remove-unused-private-members.ts';

// --- helper predicates ---------------------------------------------------------------------------

/** oxc `Expression::is_literal`. */
export const isLiteral = (expr: Node): boolean =>
    expr.type === N.BooleanLiteral ||
    expr.type === N.NullLiteral ||
    expr.type === N.NumericLiteral ||
    expr.type === N.BigIntLiteral ||
    expr.type === N.RegExpLiteral ||
    expr.type === N.StringLiteral;

/** A body-level statement is declarative if executing it cannot run user code that observes a later
 *  hoisted `var x = <literal>;` as `undefined`. Module loaders only observe our bindings on a cycle,
 *  which `enterProgram` handles; type-only declarations never run. */
export function isDeclarativeBodyStatement(statement: Node): boolean {
    switch (statement.type) {
        case N.EmptyStatement:
        case N.ImportDeclaration:
        case N.ExportAllDeclaration:
            return true;
        case N.ExportNamedDeclaration: {
            const declaration = statement.data.declaration as Node | null;
            return declaration === null || isDeclarativeDeclaration(declaration);
        }
        // `export default function() {}` is hoisted; `export default <expr>` runs user code.
        case N.ExportDefaultDeclaration:
            return statement.data.declaration.type === N.FunctionDeclaration;
        default:
            return isDeclarativeDeclaration(statement);
    }
}

/** A declaration that runs no user code: function and type declarations, and a `var`/`let`/`const`
 *  whose every declarator is a simple binding with a literal or no initializer. */
export function isDeclarativeDeclaration(declaration: Node): boolean {
    switch (declaration.type) {
        case N.FunctionDeclaration:
        case N.TSTypeAliasDeclaration:
        case N.TSInterfaceDeclaration:
            return true;
        case N.VariableDeclaration:
            return isDeclarativeVariableDeclaration(declaration);
        default:
            return false;
    }
}

export const isDeclarativeVariableDeclaration = (declaration: Node): boolean =>
    (declaration.data as DataOf<'VariableDeclaration'>).declarations.every(isDeclarativeVariableDeclarator);

/** Only AST literals qualify; constant non-literals (`-1`, `void 0`) conservatively end the prelude. */
export function isDeclarativeVariableDeclarator(declarator: Node): boolean {
    const { id, init } = declarator.data as DataOf<'VariableDeclarator'>;
    return id.type === N.BindingIdentifier && (init === null || isLiteral(init));
}

/** End the current body's declarative prelude. Inner scopes (blocks, loops) do not end it. */
export function markCurrentBodyUnsafe(ctx: DceCtx): void {
    const frame = lastBodyFrame(ctx.state);
    if (!frame.hoistedVarInliningUnsafe && frame.scopeId === ctx.currentScopeId) frame.hoistedVarInliningUnsafe = true;
}

/** End offset of the first unconditional `super()` call in an expression, or null. A sequence stays
 *  unconditional; nested conditionals and functions do not. */
export function unconditionalSuperCallEnd(expr: Node): number | null {
    switch (expr.type) {
        case N.CallExpression:
            return expr.data.callee.type === N.Super ? expr.end : null;
        case N.SequenceExpression:
            for (const item of expr.data.expressions as Node[]) {
                const end = unconditionalSuperCallEnd(item);
                if (end !== null) return end;
            }
            return null;
        default:
            return null;
    }
}

export const expressionContainsSuperCall = (expr: Node): boolean => unconditionalSuperCallEnd(expr) !== null;

/** oxc `commutative_pair`: `checkA` on one side and `checkB` on the other, trying both orders. */
export function commutativePair<RetA, RetB>(
    first: Node,
    second: Node,
    checkA: (candidate: Node) => RetA | null,
    checkB: (candidate: Node) => RetB | null,
): [RetA, RetB] | null {
    const a = checkA(first);
    if (a !== null) {
        const b = checkB(second);
        if (b !== null) return [a, b];
    } else {
        const swappedA = checkA(second);
        if (swappedA !== null) {
            const swappedB = checkB(first);
            if (swappedB !== null) return [swappedA, swappedB];
        }
    }
    return null;
}

/** Whether a member assignment target's base object may be reassigned, which would make
 *  `x.y || (x = {}, x.y = 3)` => `x.y ||= (x = {}, 3)` write to a different object. */
export function memberObjectMayBeMutated(ctx: DceCtx, assignmentTarget: Node): boolean {
    switch (assignmentTarget.type) {
        case N.StaticMemberExpression:
        case N.ComputedMemberExpression:
        case N.PrivateFieldExpression:
            return isExpressionThatReferenceMayChange(ctx, assignmentTarget.data.object);
        default:
            return false;
    }
}

/** Whether the expression is not a plain identifier or `this`, or references a symbol whose value may
 *  change. */
export function isExpressionThatReferenceMayChange(ctx: DceCtx, expr: Node): boolean {
    switch (expr.type) {
        case N.IdentifierReference: {
            const symbolId = getReference(ctx, expr).symbolId;
            return symbolId === 0 || symbolValueMayChange(ctx, symbolId);
        }
        case N.ThisExpression:
            return false;
        default:
            return true;
    }
}

/** Whether reading a resolved symbol again could produce a different value. Imported bindings and
 *  Script-root globals can change externally. */
export function symbolValueMayChange(ctx: DceCtx, symbolId: number): boolean {
    if (
        symbolIsImport(symbolFlags(ctx, symbolId)) ||
        (ctx.state.sourceType === 'script' && symbolScopeId(ctx, symbolId) === ctx.scoping.rootScopeId)
    )
        return true;
    const value = symbolValueOf(ctx.state.symbols, symbolId);
    return value !== null ? countsHaveWrites(value.references) : symbolIsMutated(ctx, symbolId);
}

/** Whether the current read closes over a block-scoped binding, which could still be in its TDZ. */
export function isClosedOverBlockScopedRead(ctx: DceCtx, symbolId: number): boolean {
    if (!symbolIsBlockScoped(symbolFlags(ctx, symbolId))) return false;
    return readCrossesFunctionBoundary(ctx, ctx.currentScopeId, symbolScopeId(ctx, symbolId));
}

/** Whether moving this identifier read earlier could observe a different value or a TDZ. */
export function identifierReadBlocksReorder(ctx: DceCtx, ident: Node): boolean {
    const symbolId = getReference(ctx, ident).symbolId;
    return symbolId === 0 || symbolValueMayChange(ctx, symbolId) || isClosedOverBlockScopedRead(ctx, symbolId);
}

/** Whether evaluating a member assignment-target part earlier could observe a different value. */
export function memberPartBlocksReorder(ctx: DceCtx, expr: Node): boolean {
    switch (expr.type) {
        case N.IdentifierReference:
            return identifierReadBlocksReorder(ctx, expr);
        case N.ThisExpression: {
            const thisScope = derivedConstructorThisScope(ctx);
            if (thisScope === 0) return false;
            // Parameter defaults are visited before their body, so a missing owner frame means this
            // derived constructor's `this` is uninitialized.
            const frames = ctx.state.bodyFrames;
            let ownerIndex = -1;
            for (let index = frames.length - 1; index >= 0; index--) {
                if (frames[index].scopeId === thisScope) {
                    ownerIndex = index;
                    break;
                }
            }
            if (ownerIndex < 0) return true;
            // Arrow frames above the owner share its lexical `this`.
            for (let index = ownerIndex; index < frames.length; index++) {
                const initializedAt = frames[index].thisInitializedAt;
                if (initializedAt !== null && expr.start >= initializedAt) return false;
            }
            return true;
        }
        default:
            return true;
    }
}

/** Whether evaluating a computed member key before a side-effecting replacement could observe a
 *  different value. `ToPropertyKey` still happens afterward, so a literal or a stable simple reference
 *  is safe regardless of its value type. */
export const computedKeyBlocksReorder = (ctx: DceCtx, key: Node): boolean =>
    !isLiteralValue(key, false, ctx) && memberPartBlocksReorder(ctx, key);

/** Whether the scope chain from `readScope` up to (excluding) `stopScope` crosses a function. */
export function readCrossesFunctionBoundary(ctx: DceCtx, readScope: number, stopScope: number): boolean {
    for (const scopeId of scopeAncestors(ctx.scoping, readScope)) {
        if (scopeId === stopScope) return false;
        if (scopeIsFunction(scopeFlags(ctx, scopeId))) return true;
    }
    return false;
}

function superCallEndInStatements(statements: readonly Node[]): number | null {
    for (const statement of statements) {
        if (statement.type !== N.ExpressionStatement) continue;
        const end = unconditionalSuperCallEnd(statement.data.expression);
        if (end !== null) return end;
    }
    return null;
}

// --- the traverser -------------------------------------------------------------------------------

/** `impl Traverse for PeepholeOptimizations`, tree-shake-only branches. */
export const peepholeOptimizations: Traverser<DceCtx> = {
    enterProgram(ctx, program) {
        // A module loader can, on a cycle, evaluate a foreign module that observes a not-yet-assigned
        // binding, so the root prelude starts unsafe when the body has any.
        const moduleHasLoaders = (program.data as DataOf<'Program'>).body.some(
            (statement) =>
                statement.type === N.ImportDeclaration ||
                statement.type === N.ExportAllDeclaration ||
                (statement.type === N.ExportNamedDeclaration && statement.data.source !== null),
        );
        const root: BodyFrame = {
            scopeId: ctx.scoping.rootScopeId,
            hoistedVarInliningUnsafe: moduleHasLoaders,
            thisInitializedAt: null,
        };
        ctx.state.bodyFrames.length = 1;
        ctx.state.bodyFrames[0] = root;
    },

    enterFunctionBody(ctx, body) {
        if (parentKind(ctx) === 'ArrowFunctionExpressionBody') return;
        const initializedAt =
            derivedConstructorThisScope(ctx) !== 0
                ? superCallEndInStatements((body.data as DataOf<'BlockStatement'>).body)
                : null;
        ctx.state.bodyFrames.push({
            scopeId: ctx.currentScopeId,
            hoistedVarInliningUnsafe: false,
            thisInitializedAt: initializedAt,
        });
    },

    exitFunctionBody(ctx) {
        if (parentKind(ctx) !== 'ArrowFunctionExpressionBody') ctx.state.bodyFrames.pop();
    },

    enterArrowFunctionBody(ctx, body) {
        let initializedAt: number | null = null;
        if (derivedConstructorThisScope(ctx) !== 0) {
            initializedAt =
                body.type === N.BlockStatement ? superCallEndInStatements(body.data.body) : unconditionalSuperCallEnd(body);
        }
        ctx.state.bodyFrames.push({
            scopeId: ctx.currentScopeId,
            hoistedVarInliningUnsafe: false,
            thisInitializedAt: initializedAt,
        });
    },

    exitArrowFunctionBody(ctx) {
        ctx.state.bodyFrames.pop();
    },

    exitStatements(ctx, statements, firstStatement) {
        minimizeStatements(ctx, statements, firstStatement);
    },

    enterStatement(ctx, statement) {
        keepTrackOfPureFunctions(ctx, statement);
    },

    exitProgram(ctx) {
        // Private member usage is collected only in full minify.
        if (ctx.verify && !isTreeShakeOnly(ctx.state) && !privateMembersAtRoot(ctx.state.privateMemberUsage))
            throw new Error('dce: a class body was entered and not exited');
    },

    exitStatement(ctx, statement) {
        if (isTreeShakeOnly(ctx.state)) {
            // oxc dispatches BlockStatement, IfStatement, ForStatement, TryStatement, LabeledStatement,
            // FunctionDeclaration, ClassDeclaration, ExpressionStatement and ImportDeclaration to the
            // peephole files here, by statement type.
            switch (statement.type) {
                case N.BlockStatement:
                    tryOptimizeBlock(ctx, statement);
                    break;
                case N.IfStatement:
                    tryFoldIf(ctx, statement);
                    break;
                case N.ForStatement:
                    tryFoldFor(ctx, statement);
                    break;
                case N.TryStatement:
                    tryFoldTry(ctx, statement);
                    break;
                case N.LabeledStatement:
                    tryFoldLabeled(ctx, statement);
                    break;
                case N.FunctionDeclaration:
                    removeUnusedFunctionDeclaration(ctx, statement);
                    break;
                case N.ClassDeclaration:
                    removeUnusedClassDeclaration(ctx, statement);
                    break;
                case N.ExpressionStatement:
                    tryFoldExpressionStmt(ctx, statement);
                    break;
                case N.ImportDeclaration:
                    removeUnusedImportSpecifiers(ctx, statement);
                    break;
            }
        } else {
            switch (statement.type) {
                case N.BlockStatement:
                    tryOptimizeBlock(ctx, statement);
                    break;
                case N.IfStatement:
                    minimizeExpressionInBooleanContext(ctx, statement.data.test);
                    tryFoldIf(ctx, statement);
                    if (statement.type === N.IfStatement) {
                        const foldedStatement = tryMinimizeIf(ctx, statement);
                        if (foldedStatement !== null) replaceStatement(ctx, statement, foldedStatement);
                    }
                    break;
                case N.WhileStatement:
                    minimizeExpressionInBooleanContext(ctx, statement.data.test);
                    break;
                case N.ForStatement:
                    if (statement.data.test !== null) minimizeExpressionInBooleanContext(ctx, statement.data.test);
                    tryFoldFor(ctx, statement);
                    break;
                case N.DoWhileStatement:
                    minimizeExpressionInBooleanContext(ctx, statement.data.test);
                    break;
                case N.TryStatement:
                    tryFoldTry(ctx, statement);
                    break;
                case N.LabeledStatement:
                    tryFoldLabeled(ctx, statement);
                    break;
                case N.FunctionDeclaration:
                    initFunctionDeclarationSymbolValue(ctx, statement.data.id);
                    removeUnusedFunctionDeclaration(ctx, statement);
                    break;
                case N.ClassDeclaration:
                    initClassDeclarationSymbolValue(ctx, statement);
                    removeUnusedClassDeclaration(ctx, statement);
                    break;
                case N.ImportDeclaration:
                    removeUnusedImportSpecifiers(ctx, statement);
                    break;
            }
            tryFoldExpressionStmt(ctx, statement);
        }
        // Maintain the per-body declarative-prelude flag read by `isHoistedVarInlineable`.
        if (!isDeclarativeBodyStatement(statement)) markCurrentBodyUnsafe(ctx);
    },

    exitForStatement(ctx, statement) {
        if (isTreeShakeOnly(ctx.state)) return;
        substituteForStatement(ctx, statement);
        minimizeForStatement(ctx, statement);
    },

    exitReturnStatement(ctx, statement) {
        if (isTreeShakeOnly(ctx.state)) return;
        substituteReturnStatement(ctx, statement);
    },

    exitVariableDeclaration(ctx, declaration) {
        if (isTreeShakeOnly(ctx.state)) return;
        substituteVariableDeclaration(ctx, declaration);
    },

    exitVariableDeclarator(ctx, declarator) {
        initSymbolValue(ctx, declarator);
        // Per declarator: an earlier declarator can run user code through a destructuring default or
        // a non-literal init before a later one records its value.
        if (!isDeclarativeVariableDeclarator(declarator)) markCurrentBodyUnsafe(ctx);
    },

    exitExpression(ctx, expr) {
        // Tree-shake mode runs only the transforms that remove code, plus the constant folds those
        // removals need. Transforms that only shrink code are left out.
        if (isTreeShakeOnly(ctx.state)) {
            switch (expr.type) {
                case N.TemplateLiteral:
                    inlineTemplateLiteral(ctx, expr);
                    break;
                case N.ObjectExpression:
                    foldObjectExp(ctx, expr);
                    break;
                case N.UnaryExpression:
                    foldUnaryExpr(ctx, expr);
                    break;
                case N.StaticMemberExpression:
                    foldStaticMemberExpr(ctx, expr);
                    break;
                case N.ComputedMemberExpression:
                    foldComputedMemberExpr(ctx, expr);
                    break;
                case N.LogicalExpression:
                    foldLogicalExpr(ctx, expr);
                    break;
                case N.ChainExpression:
                    foldChainExpr(ctx, expr);
                    break;
                case N.CallExpression:
                    foldCallExpression(ctx, expr);
                    substituteIifeCall(ctx, expr);
                    removeDeadCodeCallExpression(ctx, expr);
                    break;
                case N.ConditionalExpression:
                    tryFoldConditionalExpression(ctx, expr);
                    break;
                case N.SequenceExpression:
                    removeSequenceExpression(ctx, expr);
                    break;
                case N.AssignmentExpression:
                    removeUnusedAssignmentExpr(ctx, expr);
                    break;
                case N.BinaryExpression:
                    // `#x in y` is oxc's `PrivateInExpression`, not a binary expression.
                    if (expr.data.left.type === N.PrivateIdentifier) break;
                    foldBinaryExpr(ctx, expr);
                    foldBinaryTypeofComparison(ctx, expr);
                    break;
            }
            return;
        }
        switch (expr.type) {
            case N.TemplateLiteral:
                inlineTemplateLiteral(ctx, expr);
                substituteTemplateLiteral(ctx, expr);
                break;
            case N.ObjectExpression:
                foldObjectExp(ctx, expr);
                break;
            case N.BinaryExpression:
                if (expr.data.left.type === N.PrivateIdentifier) break;
                substituteSwapBinaryExpressions(expr);
                foldBinaryExpr(ctx, expr);
                foldBinaryTypeofComparison(ctx, expr);
                foldSequenceExpression(ctx, expr);
                minimizeLooseBoolean(ctx, expr);
                minimizeBinary(ctx, expr);
                substituteLooseEqualsUndefined(ctx, expr);
                substituteTypeofUndefined(ctx, expr);
                substituteRotateBinaryExpression(ctx, expr);
                break;
            case N.UnaryExpression:
                foldUnaryExpr(ctx, expr);
                minimizeUnary(ctx, expr);
                substituteUnaryPlus(ctx, expr);
                foldSequenceExpression(ctx, expr);
                break;
            case N.YieldExpression:
            case N.AwaitExpression:
                foldSequenceExpression(ctx, expr);
                break;
            case N.StaticMemberExpression:
                foldStaticMemberExpr(ctx, expr);
                replaceKnownPropertyAccess(ctx, expr);
                break;
            case N.ComputedMemberExpression:
                foldComputedMemberExpr(ctx, expr);
                replaceKnownPropertyAccess(ctx, expr);
                break;
            case N.LogicalExpression:
                foldLogicalExpr(ctx, expr);
                foldSequenceExpression(ctx, expr);
                minimizeLogicalExpression(ctx, expr);
                substituteIsObjectAndNotNull(ctx, expr);
                substituteRotateLogicalExpression(ctx, expr);
                break;
            case N.ChainExpression:
                foldChainExpr(ctx, expr);
                substituteChainExpression(ctx, expr);
                break;
            case N.CallExpression:
                foldCallExpression(ctx, expr);
                substituteIifeCall(ctx, expr);
                removeDeadCodeCallExpression(ctx, expr);
                replaceConcatChain(ctx, expr);
                replaceKnownGlobalMethods(ctx, expr);
                substituteSimpleFunctionCall(ctx, expr);
                substituteObjectOrArrayConstructor(ctx, expr);
                break;
            case N.ConditionalExpression: {
                minimizeExpressionInBooleanContext(ctx, expr.data.test);
                const changed = minimizeConditionalExpression(ctx, expr);
                if (changed !== null) replaceExpression(ctx, expr, changed);
                tryFoldConditionalExpression(ctx, expr);
                break;
            }
            case N.AssignmentExpression:
                minimizeNormalAssignmentToCombinedLogicalAssignment(ctx, expr);
                minimizeNormalAssignmentToCombinedAssignment(ctx, expr);
                minimizeAssignmentToUpdateExpression(ctx, expr);
                removeUnusedAssignmentExpr(ctx, expr);
                break;
            case N.SequenceExpression:
                removeSequenceExpression(ctx, expr);
                break;
            case N.ArrowFunctionExpression:
                substituteArrowExpression(ctx, expr);
                break;
            case N.FunctionExpression:
                tryRemoveNameFromFunctions(ctx, expr);
                break;
            case N.ClassExpression:
                tryRemoveNameFromClasses(ctx, expr);
                break;
            case N.NewExpression:
                substituteTypedArrayConstructor(ctx, expr);
                substituteGlobalNewExpression(ctx, expr);
                substituteObjectOrArrayConstructor(ctx, expr);
                break;
            case N.BooleanLiteral:
                substituteBoolean(ctx, expr);
                break;
            case N.ArrayExpression:
                tryFlattenArrayExpressionElements(ctx, expr);
                substituteArrayExpression(ctx, expr);
                break;
            case N.IdentifierReference:
                inlineIdentifierReference(ctx, expr);
                break;
        }
    },

    exitUnaryExpression(ctx, expr) {
        if (isTreeShakeOnly(ctx.state)) return;
        const unary = expr.data as DataOf<'UnaryExpression'>;
        if (unary.operator === '!') minimizeExpressionInBooleanContext(ctx, unary.argument);
    },

    exitCallExpression(ctx, call) {
        if (!isTreeShakeOnly(ctx.state)) {
            substituteCallExpression(ctx, call);
            removeEmptySpreadArguments((call.data as DataOf<'CallExpression'>).arguments);
        }
        // Re-evaluated each pass: folding may expose a pure-eligible shape Normalize missed.
        setNoSideEffectsToCallExpr(ctx, call);
    },

    exitNewExpression(ctx, newExpr) {
        if (!isTreeShakeOnly(ctx.state)) {
            substituteNewExpression(ctx, newExpr);
            removeEmptySpreadArguments((newExpr.data as DataOf<'NewExpression'>).arguments);
        }
        setPureOrNoSideEffectsToNewExpr(ctx, newExpr);
    },

    exitObjectProperty(ctx, property) {
        if (isTreeShakeOnly(ctx.state)) return;
        substituteObjectProperty(ctx, property);
    },

    exitAssignmentTargetProperty(ctx, property) {
        if (isTreeShakeOnly(ctx.state)) return;
        substituteAssignmentTargetProperty(ctx, property);
    },

    exitAssignmentTargetPropertyProperty(ctx, property) {
        if (isTreeShakeOnly(ctx.state)) return;
        substituteAssignmentTargetPropertyProperty(ctx, property);
    },

    exitBindingProperty(ctx, property) {
        if (isTreeShakeOnly(ctx.state)) return;
        substituteBindingProperty(ctx, property);
    },

    exitMethodDefinition(ctx, method) {
        if (isTreeShakeOnly(ctx.state)) return;
        substituteMethodDefinition(ctx, method);
    },

    exitPropertyDefinition(ctx, property) {
        if (isTreeShakeOnly(ctx.state)) return;
        substitutePropertyDefinition(ctx, property);
    },

    exitAccessorProperty(ctx, property) {
        if (isTreeShakeOnly(ctx.state)) return;
        substituteAccessorProperty(ctx, property);
    },

    exitMemberExpression(ctx, member) {
        if (isTreeShakeOnly(ctx.state)) return;
        convertToDottedProperties(ctx, member);
    },

    enterClassBody(ctx) {
        if (isTreeShakeOnly(ctx.state)) return;
        enterClassPrivateMembers(ctx.state.privateMemberUsage);
    },

    exitClassBody(ctx, classNode) {
        if (isTreeShakeOnly(ctx.state)) return;
        removeDeadCodeExitClassBody(ctx, classNode);
        removeUnusedPrivateMembers(ctx, classNode);
        exitClassPrivateMembers(ctx.state.privateMemberUsage, declaredPrivateMemberNames(classNode));
    },

    exitCatchClause(ctx, catchClause) {
        if (isTreeShakeOnly(ctx.state)) return;
        substituteCatchClause(ctx, catchClause);
    },

    exitPrivateFieldExpression(ctx, field) {
        if (isTreeShakeOnly(ctx.state)) return;
        recordPrivateMemberUse(ctx.state.privateMemberUsage, (field.data as DataOf<'PrivateFieldExpression'>).field.name);
    },

    exitPrivateInExpression(ctx, binary) {
        if (isTreeShakeOnly(ctx.state)) return;
        recordPrivateMemberUse(ctx.state.privateMemberUsage, (binary.data as DataOf<'BinaryExpression'>).left.name);
    },
};
