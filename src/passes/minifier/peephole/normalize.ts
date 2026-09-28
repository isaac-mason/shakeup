// Port of oxc_minifier/src/peephole/normalize.rs.
//
// Makes later passes easier to analyze: drops empty statements, spells `undefined`, `Infinity`,
// `NaN` and `Number.NaN` as values, turns `void x` into `void 0`, marks side-effect-free global
// constructors pure, and registers the stable symbol-liveness facts.

import {
    getInnerExpression,
    numericLiteralValue,
    stringLiteralValue,
    type ValueType,
    valueType,
} from '../../../analysis/const-eval.ts';
import { attachScopeNode } from '../../../analysis/semantic.ts';
import { isTypedArrayConstructor, isValidRegExp } from '../../../analysis/side-effects.ts';
import { type DataOf, N, type Node, node } from '../../../ast/index.ts';
import { boundNames } from '../bound-names.ts';
import { isTreeShakeOnly, shouldTrackMemberWriteEffects } from '../state.ts';
import {
    registerDefaultExport,
    registerExportDeclaration,
    registerFunction,
    registerNamedExport,
    registerUsingDeclaration,
} from '../symbol-liveness.ts';
import { MemberWriteEffect } from '../symbol-metadata.ts';
import { recordMemberWriteEffect } from '../symbol-state.ts';
import { referenceIsReadOnly, scopeContainsDirectEval, scopeIsStrictMode } from '../syntax.ts';
import { compileWalker, type HookFilter, type HookName, hookNamesOf, type Traverser } from '../traverse.ts';
import {
    createChildScopeOfCurrent,
    createVoidZero,
    type DceCtx,
    getReference,
    getResolvedReferences,
    isGlobalReference,
    noSideEffects,
    overwriteNode,
    parentKind,
    replaceExpression,
    scopeFlags,
    scopeParentId,
    valueToExpr,
} from '../traverse-context.ts';
import { memberKeyIsSafe } from './remove-unused-expression.ts';

export type NormalizeOptions = {
    convertWhileToFors: boolean;
    convertConstToLet: boolean;
    removeUnnecessaryUseStrict: boolean;
};

/** Run Normalize over `program`. Returns whether it modified the program. */
export function normalize(program: Node, ctx: DceCtx, options: NormalizeOptions): boolean {
    let changed = false;
    const traverser: Traverser<DceCtx> = {
        exitProgram(context, programNode) {
            if (options.removeUnnecessaryUseStrict && context.state.sourceType === 'module') {
                if (removeUseStrictDirectives(context, (programNode.data as DataOf<'Program'>).body)) changed = true;
            }
        },
        // Normalize is the only traversal that builds stable liveness metadata.
        enterFunction: registerFunction,
        enterVariableDeclaration: registerUsingDeclaration,
        enterExportNamedDeclaration: registerNamedExport,
        enterExportDeclaration: registerExportDeclaration,
        enterExportDefaultDeclaration: registerDefaultExport,
        exitStatements(context, statements, firstStatement) {
            // Console calls were already rewritten to `void 0` by `exitExpression`.
            for (let index = statements.length - 1; index >= firstStatement; index--) {
                const statement = statements[index];
                if (
                    statement.type === N.EmptyStatement ||
                    (statement.type === N.DebuggerStatement && context.state.options.dropDebugger)
                ) {
                    statements.splice(index, 1);
                    changed = true;
                }
            }
        },
        exitVariableDeclaration(context, declaration) {
            if (options.convertConstToLet && convertConstToLet(context, declaration)) changed = true;
        },
        exitStatement(context, statement) {
            if (statement.type === N.WhileStatement && options.convertWhileToFors) {
                convertWhileToFor(context, statement);
                changed = true;
            }
        },
        exitExpression(context, expr) {
            // Routed through `replaceExpression`, which walks the dropped call's arguments into `PassChanges`.
            if (context.state.options.dropConsole && expr.type === N.CallExpression && isConsoleCallExpression(expr)) {
                replaceExpression(context, expr, createVoidZero(expr));
                changed = true;
                return;
            }
            let replacement: Node | null = null;
            switch (expr.type) {
                case N.IdentifierReference:
                    replacement = tryCompressIdentifier(context, expr);
                    break;
                case N.UnaryExpression:
                    if (expr.data.operator === 'void') {
                        if (foldVoidIdent(context, expr)) changed = true;
                    } else if (expr.data.operator === '-' && expr.data.argument.type === N.NumericLiteral) {
                        // `-1` parses as negation of `1`; the negative literal prints the same.
                        replacement = valueToExpr(context, expr, {
                            kind: 'number',
                            value: -numericLiteralValue(expr.data.argument),
                        });
                    }
                    break;
                case N.StaticMemberExpression:
                    replacement = foldNumberNanToNan(context, expr);
                    break;
            }
            if (replacement !== null) {
                overwriteNode(context, expr, replacement);
                changed = true;
            }
        },
        exitCallExpression: setNoSideEffectsToCallExpr,
        // Seeds persistent member-write metadata before the fixed-point loop runs.
        exitAssignmentTarget(context, target) {
            if (!shouldTrackMemberWriteEffects(context.state)) return;
            if (!isSimpleAssignmentTarget(target)) return;
            // Compound and logical assignments read the property before writing.
            const isReadModify =
                parentKind(context) === 'AssignmentExpressionLeft' &&
                (context.ancestorNodes[context.ancestorDepth - 1].data as DataOf<'AssignmentExpression'>).operator !== '=';
            recordSimpleTargetMemberWriteHazard(context, target, isReadModify);
        },
        exitUpdateExpression(context, update) {
            if (!shouldTrackMemberWriteEffects(context.state)) return;
            recordSimpleTargetMemberWriteHazard(context, (update.data as DataOf<'UpdateExpression'>).argument, true);
        },
        // `delete o.x` neither reads the property nor triggers setters, but a chained `delete a.b.c`
        // reads the intermediate `a.b`.
        exitUnaryExpression(context, unary) {
            if (!shouldTrackMemberWriteEffects(context.state)) return;
            const unaryData = unary.data as DataOf<'UnaryExpression'>;
            if (unaryData.operator !== 'delete') return;
            const member = getInnerExpression(unaryData.argument);
            if (isMemberExpression(member)) recordMemberWriteHazard(context, memberObject(member), false, false);
        },
        exitNewExpression: setPureOrNoSideEffectsToNewExpr,
        exitFunctionBody(context, body) {
            if (options.removeUnnecessaryUseStrict && removeUnusedUseStrictDirective(context, body)) changed = true;
        },
    };
    if (ctx.verify && hookNamesOf(traverser).join() !== NORMALIZE_HOOKS.join()) throw new Error('dce: normalize hooks changed');
    walkNormalize(traverser, program, ctx);
    return changed;
}

/** The hooks the traverser above implements, so its walker is compiled once. */
const NORMALIZE_HOOKS: HookName[] = [
    'exitProgram',
    'exitStatement',
    'exitStatements',
    'exitExpression',
    'enterFunction',
    'exitFunctionBody',
    'enterVariableDeclaration',
    'exitVariableDeclaration',
    'enterExportNamedDeclaration',
    'enterExportDeclaration',
    'enterExportDefaultDeclaration',
    'exitCallExpression',
    'exitNewExpression',
    'exitUpdateExpression',
    'exitUnaryExpression',
    'exitAssignmentTarget',
];
/** The node types the traverser's `exitExpression` and `exitStatement` act on. */
const NORMALIZE_HOOK_FILTER: HookFilter = {
    types: {
        exitExpression: [N.CallExpression, N.IdentifierReference, N.UnaryExpression, N.StaticMemberExpression],
        exitStatement: [N.WhileStatement],
    },
    exitNodeParentKinds: [],
};
const walkNormalize = compileWalker<DceCtx>(NORMALIZE_HOOKS, NORMALIZE_HOOK_FILTER);

const memberObject = (member: Node): Node => (member.data as { object: Node }).object;

const isMemberExpression = (expr: Node): boolean =>
    expr.type === N.StaticMemberExpression || expr.type === N.ComputedMemberExpression || expr.type === N.PrivateFieldExpression;

const isSimpleAssignmentTarget = (target: Node): boolean =>
    target.type === N.IdentifierReference ||
    isMemberExpression(target) ||
    target.type === N.TSAsExpression ||
    target.type === N.TSSatisfiesExpression ||
    target.type === N.TSNonNullExpression;

function isConsoleCallExpression(call: Node): boolean {
    const callee = (call.data as DataOf<'CallExpression'>).callee;
    if (!isMemberExpression(callee)) return false;
    const object = getInnerExpression(memberObject(callee));
    return object.type === N.IdentifierReference && object.name === 'console';
}

function convertWhileToFor(ctx: DceCtx, statement: Node): void {
    const { test, body } = statement.data as { test: Node; body: Node };
    const scopeId = createChildScopeOfCurrent(ctx, 0);
    const writable = statement as { type: number; data: unknown };
    writable.type = N.ForStatement;
    writable.data = { init: null, test, update: null, body, scopeId };
    attachScopeNode(ctx.scoping.semantic, scopeId, statement);
}

function convertConstToLet(ctx: DceCtx, declaration: Node): boolean {
    const declarationData = declaration.data as DataOf<'VariableDeclaration'>;
    // The root scope stands in for "exposed to other modules", and a direct eval may assign.
    if (
        declarationData.kind !== 'const' ||
        ctx.currentScopeId === ctx.scoping.rootScopeId ||
        scopeContainsDirectEval(scopeFlags(ctx, ctx.currentScopeId))
    )
        return false;
    let allDeclarationsAreOnlyRead = true;
    boundNames(declaration, (ident) => {
        if (!getResolvedReferences(ctx, ident.sym).every((reference) => referenceIsReadOnly(reference.flags)))
            allDeclarationsAreOnlyRead = false;
    });
    if (!allDeclarationsAreOnlyRead) return false;
    declarationData.kind = 'let';
    return true;
}

/** `undefined` -> `void 0`, `Infinity` -> the number, `NaN` -> the number, unless under `delete`. */
function tryCompressIdentifier(ctx: DceCtx, ident: Node): Node | null {
    switch (ident.name) {
        case 'undefined':
            if (!isGlobalReference(ctx, ident) || isUnaryDeleteAncestor(ctx)) return null;
            return createVoidZero(ident);
        case 'Infinity':
            if (!isGlobalReference(ctx, ident) || isUnaryDeleteAncestor(ctx)) return null;
            return node(N.NumericLiteral, ident.start, ident.end, 'Infinity', null);
        case 'NaN':
            if (!isGlobalReference(ctx, ident) || isUnaryDeleteAncestor(ctx)) return null;
            return node(N.NumericLiteral, ident.start, ident.end, 'NaN', null);
        default:
            return null;
    }
}

function isUnaryDeleteAncestor(ctx: DceCtx): boolean {
    for (let at = ctx.ancestorDepth - 1; at >= 0; at--) {
        switch (ctx.ancestorKinds[at]) {
            case 'UnaryExpressionArgument':
                if ((ctx.ancestorNodes[at].data as DataOf<'UnaryExpression'>).operator === 'delete') return true;
                return false;
            case 'SequenceExpressionExpressions':
                continue;
            default:
                return false;
        }
    }
    return false;
}

/** `void x` -> `void 0` for a local `x`; the dropped reference is pruned before pass 1. */
function foldVoidIdent(ctx: DceCtx, unary: Node): boolean {
    const argument = (unary.data as DataOf<'UnaryExpression'>).argument;
    if (argument.type !== N.IdentifierReference || isGlobalReference(ctx, argument)) return false;
    replaceExpression(ctx, argument, node(N.NumericLiteral, argument.start, argument.end, '0', null));
    return true;
}

function foldNumberNanToNan(ctx: DceCtx, member: Node): Node | null {
    const { object, property } = member.data as DataOf<'StaticMemberExpression'>;
    if (object.type !== N.IdentifierReference || object.name !== 'Number') return null;
    if (property.name !== 'NaN') return null;
    if (!isGlobalReference(ctx, object)) return null;
    return node(N.NumericLiteral, object.start, object.end, 'NaN', null);
}

/** Apply `/* #__NO_SIDE_EFFECTS__ *\/` to calls of an annotated function. */
export function setNoSideEffectsToCallExpr(ctx: DceCtx, call: Node): void {
    const callData = call.data as DataOf<'CallExpression'>;
    if (callData.pure) return;
    const callee = getInnerExpression(callData.callee);
    if (callee.type !== N.IdentifierReference) return;
    const symbolId = getReference(ctx, callee).symbolId;
    if (symbolId !== 0 && noSideEffects(ctx, symbolId)) callData.pure = true;
}

/** Set `pure` on side-effect-free `new` of a known global constructor: `PC` / `PC_WITH_ARRAY` in
 *  rollup's knownGlobals. */
export function setPureOrNoSideEffectsToNewExpr(ctx: DceCtx, newExpr: Node): void {
    const newData = newExpr.data as DataOf<'NewExpression'>;
    if (newData.pure) return;
    const ident = getInnerExpression(newData.callee);
    if (ident.type !== N.IdentifierReference) return;
    const symbolId = getReference(ctx, ident).symbolId;
    if (symbolId !== 0) {
        if (noSideEffects(ctx, symbolId)) newData.pure = true;
        return;
    }
    const args = newData.arguments;
    let zeroArgThrowsError: boolean;
    let oneArgArrayThrowsError: boolean;
    let oneArgThrowsError: readonly ValueType[];
    switch (ident.name) {
        case 'AggregateError':
            zeroArgThrowsError = true;
            oneArgArrayThrowsError = false;
            oneArgThrowsError = ['undefined', 'null', 'number', 'bigint', 'boolean', 'object'];
            break;
        case 'DataView':
            zeroArgThrowsError = true;
            oneArgArrayThrowsError = true;
            oneArgThrowsError = ['undefined', 'null', 'number', 'boolean', 'bigint', 'string', 'boolean', 'object'];
            break;
        // `Set` accepts any iterable of values, so a string argument is pure.
        case 'Set':
            zeroArgThrowsError = false;
            oneArgArrayThrowsError = false;
            oneArgThrowsError = ['number', 'boolean', 'bigint', 'object'];
            break;
        // These need `[k, v]` entries or object keys, so a string argument throws.
        case 'Map':
        case 'WeakSet':
        case 'WeakMap':
            zeroArgThrowsError = false;
            oneArgArrayThrowsError = false;
            oneArgThrowsError = ['number', 'boolean', 'bigint', 'string', 'object'];
            break;
        case 'ArrayBuffer':
        case 'Date':
            zeroArgThrowsError = false;
            oneArgArrayThrowsError = false;
            oneArgThrowsError = ['bigint'];
            break;
        case 'Boolean':
        case 'Error':
        case 'EvalError':
        case 'RangeError':
        case 'ReferenceError':
        case 'SyntaxError':
        case 'TypeError':
        case 'URIError':
        case 'Number':
        case 'Object':
        case 'String':
            zeroArgThrowsError = false;
            oneArgArrayThrowsError = false;
            oneArgThrowsError = [];
            break;
        case 'RegExp':
            if (canSetPure(ctx, ident) && isValidRegExp(args, ctx)) newData.pure = true;
            return;
        default:
            // A typed array allocates a zeroed buffer and runs no user code for a non-negative
            // numeric-literal length; too large a length throws a `RangeError` the minifier may drop.
            if (isTypedArrayConstructor(ident.name)) {
                const safeLength =
                    args.length === 0 ||
                    (args.length === 1 && args[0].type === N.NumericLiteral && numericLiteralValue(args[0]) >= 0);
                if (safeLength && canSetPure(ctx, ident)) newData.pure = true;
            }
            return;
    }

    if (!canSetPure(ctx, ident)) return;

    let pure = false;
    if (args.length === 0) pure = !zeroArgThrowsError;
    else if (args.length === 1) {
        const argument = args[0];
        if (argument.type === N.SpreadElement) pure = false;
        else if (argument.type === N.ArrayExpression) {
            const elements = argument.data.elements as (Node | null)[];
            if (oneArgArrayThrowsError) pure = false;
            else if (elements.length === 0) pure = true;
            else if (ident.name === 'Set') pure = true;
            // `new Map([1])` throws: every entry must be an array literal.
            else if (ident.name === 'Map')
                pure = elements.every((element) => element !== null && element.type === N.ArrayExpression);
            else pure = false;
        } else if (argument.type === N.StringLiteral) {
            // An empty string yields no entries, so it is pure even where a string otherwise throws.
            if (oneArgThrowsError.includes('string'))
                pure =
                    stringLiteralValue(argument).value === '' &&
                    (ident.name === 'Map' || ident.name === 'WeakSet' || ident.name === 'WeakMap');
            else pure = true;
        } else if (argument.type === N.NewExpression) pure = argument.data.pure;
        else {
            const argumentType = valueType(argument, ctx);
            pure = argumentType !== 'undetermined' && !oneArgThrowsError.includes(argumentType);
        }
    }
    if (pure) newData.pure = true;
}

/** A global callee, and not a `throw` argument: a throw is never pure. */
function canSetPure(ctx: DceCtx, ident: Node): boolean {
    return isGlobalReference(ctx, ident) && parentKind(ctx) !== 'ThrowStatementArgument';
}

function recordSimpleTargetMemberWriteHazard(ctx: DceCtx, target: Node, isReadModify: boolean): void {
    // A direct member target, or the member inside a TS wrapper: `(o.x as any) = 1`.
    let member: Node | null = null;
    if (isMemberExpression(target)) member = target;
    else if (
        target.type === N.TSAsExpression ||
        target.type === N.TSSatisfiesExpression ||
        target.type === N.TSNonNullExpression
    ) {
        const inner = getInnerExpression(target.data.expression);
        if (isMemberExpression(inner)) member = inner;
    }
    if (member === null) return;
    let keyIsUnsafe: boolean;
    switch (member.type) {
        case N.StaticMemberExpression:
            keyIsUnsafe = member.data.property.name === '__proto__';
            break;
        case N.ComputedMemberExpression:
            keyIsUnsafe = !memberKeyIsSafe(member.data.expression);
            break;
        default:
            // Private fields cannot be `__proto__` and are not affected by the prototype chain.
            keyIsUnsafe = false;
    }
    recordMemberWriteHazard(ctx, memberObject(member), keyIsUnsafe, isReadModify);
}

/** Record the base symbol of a hazardous member write: one that reads the property, is chained, or
 *  may write `__proto__`. Tree-shake mode only reads the possible-prototype-mutation state. */
function recordMemberWriteHazard(ctx: DceCtx, object: Node, keyIsUnsafe: boolean, isReadModify: boolean): void {
    if (isTreeShakeOnly(ctx.state) && !keyIsUnsafe) return;
    let depth = 1;
    let current = object;
    let base: Node;
    for (;;) {
        const inner = getInnerExpression(current);
        if (inner.type === N.IdentifierReference) {
            base = inner;
            break;
        }
        // No identifier base (`f().x`, `this.x`): nothing droppable resolves through these.
        if (!isMemberExpression(inner)) return;
        depth++;
        current = memberObject(inner);
    }
    if (!(isReadModify || depth > 1 || keyIsUnsafe)) return;
    const symbolId = getReference(ctx, base).symbolId;
    if (symbolId === 0) return;
    recordMemberWriteEffect(
        ctx.state.symbols,
        symbolId,
        keyIsUnsafe ? MemberWriteEffect.MayMutatePrototype : MemberWriteEffect.Hazard,
    );
}

function isUseStrictDirective(statement: Node): boolean {
    return (statement.data as DataOf<'ExpressionStatement'>).expression.name.slice(1, -1) === 'use strict';
}

function removeUseStrictDirectives(ctx: DceCtx, body: Node[]): boolean {
    let removed = false;
    for (let index = body.length - 1; index >= 0; index--) {
        const statement = body[index];
        if (!ctx.directives.has(statement) || !isUseStrictDirective(statement)) continue;
        body.splice(index, 1);
        ctx.directives.delete(statement);
        removed = true;
    }
    return removed;
}

/** A `"use strict"` directive in a function nested in strict code is redundant. */
function removeUnusedUseStrictDirective(ctx: DceCtx, body: Node): boolean {
    const statements = (body.data as DataOf<'BlockStatement'>).body;
    if (statements.length === 0 || !ctx.directives.has(statements[0])) return false;
    const parentScopeId = scopeParentId(ctx.scoping, ctx.currentScopeId);
    if (parentScopeId === 0 || !scopeIsStrictMode(scopeFlags(ctx, parentScopeId))) return false;
    return removeUseStrictDirectives(ctx, statements);
}
