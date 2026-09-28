// Port of oxc_minifier/src/peephole/mod.rs: the `Traverse` impl for `PeepholeOptimizations`, tree-shake
// branches only, and the helper predicates the peephole files share. Each hook calls into the peephole
// files in oxc's order.

import { isLiteralValue } from '../../../analysis/const-eval.ts';
import { type DataOf, N, type Node } from '../../../ast/index.ts';
import { type BodyFrame, lastBodyFrame } from '../state.ts';
import { symbolValueOf } from '../symbol-state.ts';
import { countsHaveWrites } from '../symbol-value.ts';
import { scopeIsFunction, symbolIsBlockScoped, symbolIsImport } from '../syntax.ts';
import {
    type DceCtx,
    getReference,
    parentKind,
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
    foldStaticMemberExpr,
    foldUnaryExpr,
    inlineTemplateLiteral,
} from './fold-constants.ts';
import { initSymbolValue } from './inline.ts';
import { minimizeStatements } from './minimize-statements.ts';
import { setNoSideEffectsToCallExpr, setPureOrNoSideEffectsToNewExpr } from './normalize.ts';
import { substituteIifeCall } from './substitute-alternate-syntax.ts';
import {
    keepTrackOfPureFunctions,
    removeDeadCodeCallExpression,
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

    exitStatement(ctx, statement) {
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
        // Maintain the per-body declarative-prelude flag read by `isHoistedVarInlineable`.
        if (!isDeclarativeBodyStatement(statement)) markCurrentBodyUnsafe(ctx);
    },

    exitVariableDeclarator(ctx, declarator) {
        initSymbolValue(ctx, declarator);
        // Per declarator: an earlier declarator can run user code through a destructuring default or
        // a non-literal init before a later one records its value.
        if (!isDeclarativeVariableDeclarator(declarator)) markCurrentBodyUnsafe(ctx);
    },

    exitExpression(ctx, expr) {
        // Tree-shake mode runs only the transforms that remove code, plus the constant folds those
        // removals need, dispatched by expression type to the peephole files.
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
    },

    exitCallExpression(ctx, call) {
        // Re-evaluated each pass: folding may expose a pure-eligible shape Normalize missed.
        setNoSideEffectsToCallExpr(ctx, call);
    },

    exitNewExpression(ctx, newExpr) {
        setPureOrNoSideEffectsToNewExpr(ctx, newExpr);
    },
};
