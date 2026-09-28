// Port of oxc_minifier/src/peephole/remove_unused_expression.rs, tree-shake-only paths.

import { getInnerExpression, stringLiteralValue, toPrimitive, type ToPrimitiveResult } from '../../../analysis/const-eval.ts';
import {
    arrayExpressionElementMayHaveSideEffects,
    mayHaveSideEffects,
    objectPropertyKindMayHaveSideEffects,
    type SideEffectsContext,
} from '../../../analysis/side-effects.ts';
import { type DataOf, N, type Node, node } from '../../../ast/index.ts';
import { functionSummaryIsSideEffectFree, memberWriteEffectMayMutatePrototype } from '../symbol-metadata.ts';
import { functionSummary, isImplicitlyObservable, memberWriteEffect, symbolValueOf } from '../symbol-state.ts';
import { countsHaveOnlyMemberWriteTargetReads, countsHaveReads } from '../symbol-value.ts';
import { scopeContainsDirectEval, scopeIsArrow, scopeIsBlock, scopeIsConstructor, symbolIsConstVariable } from '../syntax.ts';
import {
    ancestorScopes,
    currentScopeFlags,
    type DceCtx,
    dropExpression,
    getReference,
    getResolvedReferences,
    isGlobalReference,
    noticeChange,
    replaceExpression,
    type Span,
    scopeFlags,
    supportsFeature,
    symbolFlags,
    takeNode,
} from '../traverse-context.ts';
import { isCjsModuleExportsHint } from './fold-constants.ts';
import { minimizeExpressionInBooleanContext } from './minimize-expression-in-boolean-context.ts';
import { joinWithLeftAssociativeOp } from './minimize-conditions.ts';
import { injectOptionalChainingIfMatched } from './minimize-conditional-expression.ts';
import { canCompressToLogicalAssignment, markAssignmentTargetAsRead } from './minimize-logical-expression.ts';
import { isScriptRootScope } from './remove-unused-declaration.ts';

/** Reduce an expression whose value is unused to the parts with side effects, in place. Returns true
 *  when nothing is left and the caller should drop it. esbuild's `SimplifyUnusedExpr`. */
export function removeUnusedExpression(ctx: DceCtx, e: Node): boolean {
    if (exprHasSpecializedUnusedHandler(e)) {
        switch (e.type) {
            case N.ArrayExpression:
                return removeUnusedArrayExpr(ctx, e);
            case N.AssignmentExpression:
                return removeUnusedAssignmentExpr(ctx, e);
            case N.BinaryExpression:
                return removeUnusedBinaryExpr(ctx, e);
            case N.CallExpression:
                return removeUnusedCallExpr(ctx, e);
            case N.ClassExpression:
                return removeUnusedClassExpr(ctx, e);
            case N.ConditionalExpression:
                return removeUnusedConditionalExpr(ctx, e);
            case N.LogicalExpression:
                return removeUnusedLogicalExpr(ctx, e);
            case N.NewExpression:
                return removeUnusedNewExpr(ctx, e);
            case N.ObjectExpression:
                return removeUnusedObjectExpr(ctx, e);
            case N.SequenceExpression:
                return removeUnusedSequenceExpr(ctx, e);
            case N.TemplateLiteral:
                return removeUnusedTemplateLiteral(ctx, e);
            case N.UnaryExpression:
                return removeUnusedUnaryExpr(ctx, e);
            // In a derived class constructor, `this` before `super()` throws a `ReferenceError`.
            case N.ThisExpression:
                return derivedConstructorThisScope(ctx) === 0;
            default:
                throw new Error('dce: exprHasSpecializedUnusedHandler is out of sync with removeUnusedExpression');
        }
    }
    return !mayHaveSideEffects(e, ctx);
}

/** Scope of the derived constructor whose `this` is used at the current position, or 0. Only derived
 *  constructors have the TDZ for `this` before `super()`. */
export function derivedConstructorThisScope(ctx: DceCtx): number {
    for (const scopeId of ancestorScopes(ctx)) {
        const flags = scopeFlags(ctx, scopeId);
        if (scopeIsBlock(flags) || scopeIsArrow(flags)) continue;
        if (!scopeIsConstructor(flags)) return 0;
        // The nearest class is not necessarily the right one: computed keys and decorators of a nested
        // class still use the outer lexical `this`.
        let foundConstructorMethod = false;
        for (let at = ctx.ancestorDepth - 1; at >= 0; at--) {
            const owner = ctx.ancestorNodes[at];
            switch (ctx.ancestorKinds[at]) {
                // Field initializers have their own `this`, though they introduce no function scope.
                case 'PropertyDefinitionValue':
                    return 0;
                case 'MethodDefinitionValue':
                    if ((owner.data as DataOf<'MethodDefinition'>).kind === 'constructor') foundConstructorMethod = true;
                    break;
                case 'ClassBodyBody':
                    if (foundConstructorMethod)
                        return (owner.data as DataOf<'ClassExpression'>).superClass !== null ? scopeId : 0;
                    break;
            }
        }
        return 0;
    }
    return 0;
}

function removeUnusedUnaryExpr(ctx: DceCtx, e: Node): boolean {
    if (e.type !== N.UnaryExpression) return false;
    switch (e.data.operator) {
        case 'void':
        case '!':
            replaceExpression(ctx, e, takeNode(ctx, e.data.argument));
            return removeUnusedExpression(ctx, e);
        case 'typeof':
            if (e.data.argument.type === N.IdentifierReference) return true;
            replaceExpression(ctx, e, takeNode(ctx, e.data.argument));
            return removeUnusedExpression(ctx, e);
        default:
            return !mayHaveSideEffects(e, ctx);
    }
}

function removeUnusedSequenceExpr(ctx: DceCtx, e: Node): boolean {
    if (e.type !== N.SequenceExpression) return false;
    const expressions = e.data.expressions as Node[];
    let kept = 0;
    for (let index = 0; index < expressions.length; index++) {
        const item = expressions[index];
        if (removeUnusedExpression(ctx, item)) dropExpression(ctx, item);
        else expressions[kept++] = item;
    }
    expressions.length = kept;
    return kept === 0;
}

function removeUnusedLogicalExpr(ctx: DceCtx, e: Node): boolean {
    // Keep esbuild's `0 && (module.exports = { ... })` hint for `cjs-module-lexer`.
    if (e.type === N.LogicalExpression && isCjsModuleExportsHint(e.data.right)) return false;
    if (!mayHaveSideEffects(e, ctx)) return true;
    if (e.type !== N.LogicalExpression) return false;
    if (e.data.operator !== '??') minimizeExpressionInBooleanContext(ctx, e.data.left);
    if (removeUnusedExpression(ctx, e.data.right)) {
        removeUnusedExpression(ctx, e.data.left);
        replaceExpression(ctx, e, takeNode(ctx, e.data.left));
        return false;
    }

    // try optional chaining and nullish coalescing
    if (supportsFeature(ctx, 'ES2020OptionalChaining') || supportsFeature(ctx, 'ES2020NullishCoalescingOperator')) {
        const logicalOperator = e.data.operator as string;
        const logicalLeft = e.data.left as Node;
        const logicalRight = e.data.right as Node;
        if (logicalLeft.type === N.BinaryExpression) {
            const binaryOperator = logicalLeft.data.operator as string;
            const binaryLeft = logicalLeft.data.left as Node;
            const binaryRight = logicalLeft.data.right as Node;
            if (
                ((logicalOperator === '&&' && binaryOperator === '!=') ||
                    (logicalOperator === '||' && binaryOperator === '==')) &&
                supportsFeature(ctx, 'ES2020OptionalChaining')
            ) {
                // "a != null && a.b()" => "a?.b()"
                // "a == null || a.b()" => "a?.b()"
                let id: Node | null = null;
                if (binaryLeft.type === N.IdentifierReference) {
                    if (!isGlobalReference(ctx, binaryLeft) && binaryRight.type === N.NullLiteral) id = binaryLeft;
                } else if (binaryRight.type === N.IdentifierReference) {
                    if (!isGlobalReference(ctx, binaryRight) && binaryLeft.type === N.NullLiteral) id = binaryRight;
                }
                if (id !== null && injectOptionalChainingIfMatched(ctx, id.name, id, logicalRight)) {
                    replaceExpression(ctx, e, takeNode(ctx, logicalRight));
                    return false;
                }
            } else if (
                ((logicalOperator === '&&' && binaryOperator === '==') ||
                    (logicalOperator === '||' && binaryOperator === '!=')) &&
                supportsFeature(ctx, 'ES2020NullishCoalescingOperator')
            ) {
                // "a == null && b" => "a ?? b"
                // "a != null || b" => "a ?? b"
                // "a == null && (a = b)" => "a ??= b"
                // "a != null || (a = b)" => "a ??= b"
                const newLeftHandExpr =
                    binaryRight.type === N.NullLiteral ? binaryLeft : binaryLeft.type === N.NullLiteral ? binaryRight : null;
                if (newLeftHandExpr !== null) {
                    if (
                        supportsFeature(ctx, 'ES2021LogicalAssignmentOperators') &&
                        logicalRight.type === N.AssignmentExpression &&
                        logicalRight.data.operator === '=' &&
                        canCompressToLogicalAssignment(ctx, logicalRight.data.left, newLeftHandExpr)
                    ) {
                        logicalRight.start = e.start;
                        logicalRight.end = e.end;
                        logicalRight.data.operator = '??=';
                        // `??=` reads the target to check for nullish.
                        markAssignmentTargetAsRead(ctx, logicalRight.data.left);
                        replaceExpression(ctx, e, takeNode(ctx, logicalRight));
                        return false;
                    }

                    const newExpr = node(N.LogicalExpression, e.start, e.end, '', {
                        operator: '??',
                        left: takeNode(ctx, newLeftHandExpr),
                        right: takeNode(ctx, logicalRight),
                    });
                    replaceExpression(ctx, e, newExpr);
                    return false;
                }
            }
        }
    }

    return false;
}

// `([1,2,3, foo()])` -> `foo()`
function removeUnusedArrayExpr(ctx: DceCtx, e: Node): boolean {
    if (e.type !== N.ArrayExpression) return false;
    const elements = e.data.elements as (Node | null)[];
    if (elements.length === 0) return true;

    const oldLength = elements.length;
    let kept = 0;
    for (let index = 0; index < elements.length; index++) {
        const element = elements[index];
        // An elision carries no subtree.
        if (element === null) continue;
        if (element.type === N.SpreadElement) {
            // `[...ident]` runs the iterator protocol, which counts as a side effect.
            if (arrayExpressionElementMayHaveSideEffects(element, ctx)) {
                elements[kept++] = element;
                continue;
            }
            dropExpression(ctx, element.data.argument);
            continue;
        }
        if (removeUnusedExpression(ctx, element)) dropExpression(ctx, element);
        else elements[kept++] = element;
    }
    elements.length = kept;
    if (elements.length !== oldLength) noticeChange(ctx);

    if (elements.length === 0) return true;

    // `a(), b()` is shorter than `[a(), b()]`, but `[...a], [...b]` is not shorter than `[...a, ...b]`.
    const keepAsArray = elements.some((element) => element !== null && element.type === N.SpreadElement);
    if (keepAsArray) return false;

    const expressions = elements.splice(0) as Node[];
    if (expressions.length === 0) return true;
    if (expressions.length === 1) {
        replaceExpression(ctx, e, expressions[0]);
        return false;
    }
    replaceExpression(ctx, e, sequenceExpression(e, expressions));
    return false;
}

function removeUnusedNewExpr(ctx: DceCtx, e: Node): boolean {
    if (e.type !== N.NewExpression) return false;
    if ((e.data.pure && ctx.annotations) || ctx.manualPureFunctions(e.data.callee)) {
        const exprs = foldArgumentsIntoNeededExpressions(ctx, e.data.arguments);
        if (exprs.length === 0) return true;
        if (exprs.length === 1) {
            replaceExpression(ctx, e, exprs[0]);
            return false;
        }
        replaceExpression(ctx, e, sequenceExpression(e, exprs));
        return false;
    }
    return false;
}

/** `ToPrimitive` may be a symbol, whose conversion to a string throws. */
const mayBeSymbol = (primitive: ToPrimitiveResult): boolean => primitive === 'symbol' || primitive === 'undetermined';

/** A template literal of `expressions` with empty quasis, which only converts them to strings. */
function toStringTemplate(span: Span, expressions: Node[]): Node {
    const quasis: Node[] = [];
    for (let index = 0; index <= expressions.length; index++)
        quasis.push(node(N.TemplateElement, span.start, span.end, '', null));
    return node(N.TemplateLiteral, span.start, span.end, '', { quasis, expressions });
}

// "`${1}2${foo()}3`" -> "`${foo()}`"
function removeUnusedTemplateLiteral(ctx: DceCtx, e: Node): boolean {
    if (e.type !== N.TemplateLiteral) return false;
    const templateExpressions = e.data.expressions as Node[];
    if (templateExpressions.length === 0) return true;
    if (
        templateExpressions.every((item) => mayBeSymbol(toPrimitive(item, ctx))) &&
        (e.data.quasis as Node[]).every((quasi) => quasi.name === '')
    )
        return false;

    const transformedElements: Node[] = [];
    let pendingToStringRequiredExprs: Node[] = [];

    for (const item of templateExpressions.splice(0)) {
        if (mayBeSymbol(toPrimitive(item, ctx))) {
            pendingToStringRequiredExprs.push(item);
        } else if (removeUnusedExpression(ctx, item)) {
            dropExpression(ctx, item);
        } else {
            if (pendingToStringRequiredExprs.length > 0) {
                transformedElements.push(toStringTemplate(item, pendingToStringRequiredExprs));
                pendingToStringRequiredExprs = [];
            }
            transformedElements.push(item);
        }
    }

    if (pendingToStringRequiredExprs.length > 0) transformedElements.push(toStringTemplate(e, pendingToStringRequiredExprs));

    if (transformedElements.length === 0) return true;
    if (transformedElements.length === 1) {
        replaceExpression(ctx, e, transformedElements[0]);
        return false;
    }
    replaceExpression(ctx, e, sequenceExpression(e, transformedElements));
    return false;
}

// `({ 1: 1, [foo()]: bar() })` -> `foo(), bar()`
function removeUnusedObjectExpr(ctx: DceCtx, e: Node): boolean {
    if (e.type !== N.ObjectExpression) return false;
    const properties = e.data.properties as Node[];
    if (properties.length === 0) return true;
    if (properties.every((property) => property.type === N.SpreadElement)) {
        // An all-spread object is removable only when the spread arguments have no side effects.
        return !properties.some((property) => objectPropertyKindMayHaveSideEffects(property, ctx));
    }

    const transformedElements: Node[] = [];
    let pendingSpreadElements: Node[] = [];

    for (const property of properties.splice(0)) {
        if (property.type === N.SpreadElement) {
            pendingSpreadElements.push(property);
            continue;
        }
        if (pendingSpreadElements.length > 0) {
            transformedElements.push(
                node(N.ObjectExpression, property.start, property.end, '', { properties: pendingSpreadElements }),
            );
            pendingSpreadElements = [];
        }

        const { key, value } = property.data as DataOf<'ObjectProperty'>;
        // ToPropertyKey(key) throws when ToPrimitive(key) throws, which the assumptions rule out.
        if (key.type !== N.IdentifierName && key.type !== N.PrivateIdentifier) {
            if (removeUnusedExpression(ctx, key)) dropExpression(ctx, key);
            else transformedElements.push(key);
        }

        if (removeUnusedExpression(ctx, value)) dropExpression(ctx, value);
        else transformedElements.push(value);
    }

    if (pendingSpreadElements.length > 0)
        transformedElements.push(node(N.ObjectExpression, e.start, e.end, '', { properties: pendingSpreadElements }));

    if (transformedElements.length === 0) return true;
    if (transformedElements.length === 1) {
        replaceExpression(ctx, e, transformedElements[0]);
        return false;
    }
    replaceExpression(ctx, e, sequenceExpression(e, transformedElements));
    return false;
}

function removeUnusedConditionalExpr(ctx: DceCtx, e: Node): boolean {
    if (!mayHaveSideEffects(e, ctx)) return true;
    if (e.type !== N.ConditionalExpression) return false;

    const consequent = removeUnusedExpression(ctx, e.data.consequent);
    const alternate = removeUnusedExpression(ctx, e.data.alternate);

    // "foo() ? 1 : 2" => "foo()"
    if (consequent && alternate) {
        const test = removeUnusedExpression(ctx, e.data.test);
        if (test) return true;
        replaceExpression(ctx, e, takeNode(ctx, e.data.test));
        return false;
    }

    // "foo() ? 1 : bar()" => "foo() || bar()"
    if (consequent) {
        const newExpr = joinWithLeftAssociativeOp(
            ctx,
            { start: e.start, end: e.end },
            '||',
            takeNode(ctx, e.data.test),
            takeNode(ctx, e.data.alternate),
        );
        replaceExpression(ctx, e, newExpr);
        return false;
    }

    // "foo() ? bar() : 2" => "foo() && bar()"
    if (alternate) {
        const newExpr = joinWithLeftAssociativeOp(
            ctx,
            { start: e.start, end: e.end },
            '&&',
            takeNode(ctx, e.data.test),
            takeNode(ctx, e.data.consequent),
        );
        replaceExpression(ctx, e, newExpr);
        return false;
    }

    return false;
}

function removeUnusedBinaryExpr(ctx: DceCtx, e: Node): boolean {
    if (e.type !== N.BinaryExpression) return false;

    switch (e.data.operator) {
        case '==':
        case '!=':
        case '===':
        case '!==':
        case '<':
        case '<=':
        case '>':
        case '>=': {
            const left = removeUnusedExpression(ctx, e.data.left);
            const right = removeUnusedExpression(ctx, e.data.right);
            if (left && right) return true;
            if (left) {
                replaceExpression(ctx, e, takeNode(ctx, e.data.right));
                return false;
            }
            if (right) {
                replaceExpression(ctx, e, takeNode(ctx, e.data.left));
                return false;
            }
            replaceExpression(ctx, e, sequenceExpression(e, [takeNode(ctx, e.data.left), takeNode(ctx, e.data.right)]));
            return false;
        }
        case '+':
            foldStringAdditionChain(ctx, e);
            return (e as Node).type === N.StringLiteral;
        default:
            return !mayHaveSideEffects(e, ctx);
    }
}

const isSpecificStringLiteral = (expr: Node, value: string): boolean =>
    expr.type === N.StringLiteral && stringLiteralValue(expr).value === value;

/** Replace side-effect-free string parts of a `+` chain with `""`. Returns whether `e` is a string. */
function foldStringAdditionChain(ctx: DceCtx, e: Node): boolean {
    if (e.type !== N.BinaryExpression || e.data.operator !== '+') return toPrimitive(e, ctx) === 'string';

    const leftIsString = foldStringAdditionChain(ctx, e.data.left);
    if (leftIsString) {
        const left = e.data.left as Node;
        if (!mayHaveSideEffects(left, ctx) && !isSpecificStringLiteral(left, ''))
            replaceExpression(ctx, left, node(N.StringLiteral, left.start, left.end, '""', null));

        const rightAsPrimitive = toPrimitive(e.data.right, ctx);
        if (!mayBeSymbol(rightAsPrimitive) && !mayHaveSideEffects(e.data.right, ctx)) {
            replaceExpression(ctx, e, takeNode(ctx, e.data.left));
            return true;
        }
        return true;
    }

    const rightAsPrimitive = toPrimitive(e.data.right, ctx);
    if (rightAsPrimitive === 'string') {
        const right = e.data.right as Node;
        if (!mayHaveSideEffects(right, ctx) && !isSpecificStringLiteral(right, ''))
            replaceExpression(ctx, right, node(N.StringLiteral, right.start, right.end, '""', null));
        return true;
    }
    return false;
}

function removeUnusedCallExpr(ctx: DceCtx, e: Node): boolean {
    if (e.type !== N.CallExpression) return false;

    const callee = e.data.callee as Node;
    let isPure = (e.data.pure && ctx.annotations) || ctx.manualPureFunctions(callee);
    if (!isPure && callee.type === N.IdentifierReference) {
        const symbolId = getReference(ctx, callee).symbolId;
        isPure = symbolId !== 0 && functionSummaryIsSideEffectFree(functionSummary(ctx.state.symbols, symbolId));
    }

    if (isPure) {
        const exprs = foldArgumentsIntoNeededExpressions(ctx, e.data.arguments);
        if (exprs.length === 0) return true;
        if (exprs.length === 1) {
            replaceExpression(ctx, e, exprs[0]);
            return false;
        }
        replaceExpression(ctx, e, sequenceExpression(e, exprs));
        return false;
    }

    return !hasSideEffectsOrPreservedIife(ctx, e);
}

/** `mayHaveSideEffects`, except that an IIFE call is reported as effectful so tree-shake mode keeps
 *  its structure, as Rollup and esbuild do. */
export function hasSideEffectsOrPreservedIife(ctx: DceCtx, e: Node): boolean {
    if (
        e.type === N.CallExpression &&
        (e.data.callee.type === N.FunctionExpression || e.data.callee.type === N.ArrowFunctionExpression)
    )
        return true;
    return mayHaveSideEffects(e, ctx);
}

/** Move the call arguments out, keeping those with side effects as expressions. A spread `...a`
 *  becomes `[...a]`. */
export function foldArgumentsIntoNeededExpressions(ctx: DceCtx, args: Node[]): Node[] {
    const out: Node[] = [];
    // An empty list may be the parser's shared frozen one.
    if (args.length === 0) return out;
    for (const argument of args.splice(0)) {
        const expr =
            argument.type === N.SpreadElement
                ? node(N.ArrayExpression, argument.start, argument.end, '', { elements: [argument] })
                : argument;
        if (removeUnusedExpression(ctx, expr)) dropExpression(ctx, expr);
        else out.push(expr);
    }
    return out;
}

/** Drop the write of an assignment to a binding nothing reads, keeping the right-hand side. */
export function removeUnusedAssignmentExpr(ctx: DceCtx, e: Node): boolean {
    if (e.type !== N.AssignmentExpression) return false;
    const unused = ctx.state.options.unused;
    if (unused === 'keep' || unused === 'keep-assign') return false;
    // Member expression assignments (e.g. `A.from = () => {}`) use a different path.
    const ident = e.data.left as Node;
    if (ident.type !== N.IdentifierReference) return removeUnusedMemberAssignment(ctx, e);
    if (isScriptRootScope(ctx) || scopeContainsDirectEval(currentScopeFlags(ctx))) return false;
    const symbolId = getReference(ctx, ident).symbolId;
    if (symbolId === 0) return false;
    // Keep the error for `const foo = 1; foo = 2`.
    if (symbolIsConstVariable(symbolFlags(ctx, symbolId))) return false;
    // Writes to implicitly observable bindings (`export let foo; foo = 1;`) stay.
    if (isImplicitlyObservable(ctx.state.symbols, symbolId)) return false;
    const symbolValue = symbolValueOf(ctx.state.symbols, symbolId);
    if (symbolValue === null) return false;
    if (countsHaveReads(symbolValue.references)) return false;
    replaceExpression(ctx, e, takeNode(ctx, e.data.right));
    return false;
}

/** A member assignment (`A.from = () => {}`) whose root object is an unused local binding. In
 *  tree-shake mode only the `propertyWriteSideEffects: false` opt-in drops it; oxc's default path for
 *  plain writes to fresh locals is full-minify only. */
function removeUnusedMemberAssignment(ctx: DceCtx, e: Node): boolean {
    if (isScriptRootScope(ctx)) return false;
    const symbolId = resolveMemberAssignObjectSymbol(ctx, e);
    if (symbolId === 0) return false;
    // With a pure right-hand side the whole assignment is free; only the binding check remains.
    if (!mayHaveSideEffects(e, ctx)) return isMemberAssignToUnusedBinding(ctx, symbolId);
    return false;
}

/** A computed member key that can never be `__proto__`. */
export function memberKeyIsSafe(key: Node): boolean {
    switch (key.type) {
        case N.StringLiteral:
            return stringLiteralValue(key).value !== '__proto__';
        case N.NumericLiteral:
            return true;
        default:
            return false;
    }
}

/** The symbol of a single-level member assignment's base identifier, or 0. */
function resolveMemberAssignObjectSymbol(ctx: DceCtx, assignExpr: Node): number {
    const left = (assignExpr.data as DataOf<'AssignmentExpression'>).left;
    switch (left.type) {
        case N.StaticMemberExpression:
        case N.ComputedMemberExpression:
        case N.PrivateFieldExpression: {
            const object = left.data.object as Node;
            return object.type === N.IdentifierReference ? getReference(ctx, object).symbolId : 0;
        }
        default:
            return 0;
    }
}

/** Whether `symbolId` holds a fresh value, is not implicitly observable, and every reference is a
 *  member write target. */
function isMemberAssignToUnusedBinding(ctx: DceCtx, symbolId: number): boolean {
    // A potential `__proto__` write may have installed a setter that a sibling write triggers. When the
    // candidate is the only remaining reference, no setter can fire.
    if (
        memberWriteEffectMayMutatePrototype(memberWriteEffect(ctx.state.symbols, symbolId)) &&
        getResolvedReferences(ctx, symbolId).length > 1
    )
        return false;

    if (isImplicitlyObservable(ctx.state.symbols, symbolId)) return false;
    const symbolValue = symbolValueOf(ctx.state.symbols, symbolId);
    if (symbolValue === null) return false;
    if (symbolValue.kind === 'none') return false;
    return countsHaveOnlyMemberWriteTargetReads(symbolValue.references);
}

function removeUnusedClassExpr(ctx: DceCtx, e: Node): boolean {
    if (e.type !== N.ClassExpression) return false;
    const exprs = removeUnusedClass(ctx, e);
    if (exprs !== null) {
        if (exprs.length === 0) return true;
        replaceExpression(ctx, e, sequenceExpression(e, exprs));
    }
    return false;
}

const classElementIsComputed = (element: Node): boolean =>
    (element.type === N.MethodDefinition || element.type === N.PropertyDefinition) && element.data.computed;

const classElementIsStatic = (element: Node): boolean =>
    (element.type === N.MethodDefinition || element.type === N.PropertyDefinition) && element.data.static;

const classElementHasDecorator = (element: Node): boolean =>
    (element.type === N.MethodDefinition || element.type === N.PropertyDefinition) && element.data.decorators.length > 0;

/** A computed key is an expression; an identifier name or a private name is not. */
const isExpressionKey = (key: Node): boolean => key.type !== N.IdentifierName && key.type !== N.PrivateIdentifier;

/** The expressions an unused class must still evaluate, or null when it cannot be removed. */
export function removeUnusedClass(ctx: DceCtx, c: Node): Node[] | null {
    switch (classifyClassRemovability(c, ctx)) {
        case 'keep':
            return null;
        // Pure heritage, no static values, pure computed keys: nothing to extract.
        case 'removes-clean':
            break;
        case 'extracts': {
            const exprs: Node[] = [];
            const data = c.data as DataOf<'ClassExpression'>;
            const superClass = data.superClass;
            if (superClass !== null && mayHaveSideEffects(superClass, ctx)) {
                data.superClass = null;
                exprs.push(superClass);
            }

            for (const element of data.body) {
                // Save computed key.
                if (classElementIsComputed(element)) {
                    const key = (element.data as DataOf<'PropertyDefinition'>).key;
                    if (isExpressionKey(key) && mayHaveSideEffects(key, ctx)) exprs.push(takeNode(ctx, key));
                }
                // Save static initializer, already checked for side effects.
                if (classElementIsStatic(element) && element.type === N.PropertyDefinition) {
                    const init = element.data.value as Node | null;
                    if (init !== null) {
                        element.data.value = null;
                        exprs.push(init);
                    }
                }
            }

            noticeChange(ctx);
            return exprs;
        }
    }

    noticeChange(ctx);
    return [];
}

/** How `removeUnusedClass` treats an unused class. */
export type ClassRemovability = 'keep' | 'extracts' | 'removes-clean';

/** Whether an unused class can be removed, and whether evaluation-time expressions (effectful heritage
 *  or computed keys, any present static value) must be extracted into the surrounding code. */
export function classifyClassRemovability(c: Node, ctx: SideEffectsContext): ClassRemovability {
    const data = c.data as DataOf<'ClassExpression'>;
    // Decorators may have side effects.
    if (data.decorators.length > 0) return 'keep';
    const superClass = data.superClass;
    if (superClass !== null) {
        // Look through sequence tails, so a later fold surfacing the inner expression does not change
        // the classification.
        let inner = getInnerExpression(superClass);
        while (inner.type === N.SequenceExpression) {
            const expressions = inner.data.expressions as Node[];
            const last = expressions[expressions.length - 1];
            if (last === undefined) break;
            inner = getInnerExpression(last);
        }
        // `class C extends (() => {}) {}` is a statically provable TypeError.
        if (inner.type === N.ArrowFunctionExpression) return 'keep';
    }
    let extracts = false;
    for (const element of data.body) {
        if (classElementHasDecorator(element)) return 'keep';
        if (element.type === N.TSIndexSignature) return 'keep';
        if (element.type === N.StaticBlock && element.data.body.length > 0) return 'keep';
        if (classElementIsStatic(element) && element.type === N.PropertyDefinition) {
            const value = element.data.value as Node | null;
            if (value !== null) {
                if (mayHaveSideEffects(value, ctx)) return 'keep';
                // Every present static value is extracted, pure or not.
                extracts = true;
            }
        }
        if (classElementIsComputed(element)) {
            const key = (element.data as DataOf<'PropertyDefinition'>).key;
            if (isExpressionKey(key) && mayHaveSideEffects(key, ctx)) extracts = true;
        }
    }
    if (superClass !== null && mayHaveSideEffects(superClass, ctx)) extracts = true;
    return extracts ? 'extracts' : 'removes-clean';
}

/** The expression kinds `removeUnusedExpression` sends to a specialized handler, which may reduce the
 *  expression instead of dropping it whole. `this` counts: its removal depends on position. */
export function exprHasSpecializedUnusedHandler(e: Node): boolean {
    switch (e.type) {
        case N.ArrayExpression:
        case N.AssignmentExpression:
        case N.CallExpression:
        case N.ClassExpression:
        case N.ConditionalExpression:
        case N.LogicalExpression:
        case N.NewExpression:
        case N.ObjectExpression:
        case N.SequenceExpression:
        case N.TemplateLiteral:
        case N.UnaryExpression:
        case N.ThisExpression:
            return true;
        // `#x in y` is oxc's `PrivateInExpression`, not a binary expression.
        case N.BinaryExpression:
            return e.data.left.type !== N.PrivateIdentifier;
        default:
            return false;
    }
}

const sequenceExpression = (span: Span, expressions: Node[]): Node =>
    node(N.SequenceExpression, span.start, span.end, '', { expressions });
