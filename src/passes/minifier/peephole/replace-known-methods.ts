// Port of oxc_minifier/src/peephole/replace_known_methods.rs. Tree-shake mode reaches only
// `escapeStringForTemplateLiteral`, through the constant folds; the rest is full minify only.

import {
    bigIntLiteralValue,
    evaluateValueInContext,
    numericLiteralValue,
    plainStringLiteralValue,
    stringCharAt,
    stringLiteralText,
    valueType,
} from '../../../analysis/const-eval.ts';
import {
    bigIntToIntegerIndex,
    isRegExpPatternValid,
    isRegExpSyntaxSupported,
    mayHaveSideEffects,
    numberToIntegerIndex,
} from '../../../analysis/side-effects.ts';
import { type DataOf, N, type Node, node } from '../../../ast/index.ts';
import {
    createVoidZero,
    type DceCtx,
    isGlobalReference,
    parent,
    parentKind,
    replaceExpression,
    type Span,
    supportsFeature,
    valueToExpr,
} from '../traverse-context.ts';
import { isLiteral } from './index.ts';

const SPAN: Span = { start: 0, end: 0 };

const numericLiteral = (span: Span, value: number): Node => node(N.NumericLiteral, span.start, span.end, String(value), null);

const binaryExpression = (span: Span, left: Node, operator: string, right: Node): Node =>
    node(N.BinaryExpression, span.start, span.end, '', { operator, left, right });

const unaryExpression = (span: Span, operator: string, argument: Node): Node =>
    node(N.UnaryExpression, span.start, span.end, '', { operator, prefix: true, argument });

const callExpression = (span: Span, callee: Node, args: Node[]): Node =>
    node(N.CallExpression, span.start, span.end, '', {
        callee,
        arguments: args,
        optional: false,
        pure: false,
        typeArguments: null,
    });

const stringLiteral = (span: Span, value: string): Node =>
    node(N.StringLiteral, span.start, span.end, JSON.stringify(value), null);

const isStaticMemberNamed = (member: Node, name: string): boolean =>
    member.type === N.StaticMemberExpression && (member.data.property as Node).name === name;

export function replaceKnownGlobalMethods(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.CallExpression) return;

    const constantValue = evaluateValueInContext(expr, ctx);
    if (constantValue !== null) {
        replaceExpression(ctx, expr, valueToExpr(ctx, expr, constantValue));
        return;
    }

    const call = expr.data as DataOf<'CallExpression'>;
    const callee = call.callee;
    let name: string;
    let object: Node;
    if (callee.type === N.StaticMemberExpression && !callee.data.optional) {
        name = (callee.data.property as Node).name;
        object = callee.data.object;
    } else if (callee.type === N.ComputedMemberExpression && !callee.data.optional) {
        const property = callee.data.expression as Node;
        if (property.type !== N.StringLiteral) return;
        name = stringLiteralText(property);
        object = callee.data.object;
    } else {
        return;
    }
    let replacement: Node | null = null;
    switch (name) {
        case 'concat':
            replacement = tryFoldConcat(ctx, expr, call.arguments, callee);
            break;
        case 'pow':
            replacement = tryFoldPow(ctx, expr, call.arguments, object);
            break;
        case 'of':
            replacement = tryFoldArrayOf(ctx, expr, call.arguments, name, object);
            break;
    }
    if (replacement !== null) replaceExpression(ctx, expr, replacement);
}

/** `Math.pow(a, b)` -> `+(a) ** +b` */
function tryFoldPow(ctx: DceCtx, span: Span, args: Node[], object: Node): Node | null {
    if (!supportsFeature(ctx, 'ES2016ExponentiationOperator')) return null;
    if (!validateGlobalReference(ctx, object, 'Math') || !validateArguments(args, 2)) return null;

    const [firstArg, secondArg] = args;

    const wrapWithUnaryPlusIfNeeded = (arg: Node): Node =>
        valueType(arg, ctx) === 'number' ? arg : unaryExpression(SPAN, '+', arg);

    // `**` converts its left operand to a number itself, so only the right needs the `+`.
    return binaryExpression(span, firstArg, '**', wrapWithUnaryPlusIfNeeded(secondArg));
}

function tryFoldArrayOf(ctx: DceCtx, span: Span, args: Node[], name: string, object: Node): Node | null {
    if (!validateGlobalReference(ctx, object, 'Array')) return null;
    if (name !== 'of') return null;
    return node(N.ArrayExpression, span.start, span.end, '', { elements: args.slice() });
}

/** `[].concat(a).concat(b)` -> `[].concat(a, b)`
 *  `"".concat(a).concat(b)` -> `"".concat(a, b)` */
export function replaceConcatChain(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.CallExpression) return;

    if (parentKind(ctx) === 'StaticMemberExpressionObject' && isStaticMemberNamed(parent(ctx).node, 'concat')) return;

    let currentNode: Node = expr;
    const collectedArguments: Node[][] = [];
    let newRootCallee: Node;
    for (;;) {
        if (currentNode.type !== N.CallExpression) return;
        const call = currentNode.data as DataOf<'CallExpression'>;
        const member = call.callee;
        if (member.type !== N.StaticMemberExpression) return;
        if (member.data.optional || (member.data.property as Node).name !== 'concat') return;

        // Array/String `concat` can only throw on a too-long result, which the compressor assumes
        // may move, so argument side effects need no check.
        collectedArguments.push(call.arguments);

        // [].concat() or "".concat()
        const memberObject = member.data.object as Node;
        if (memberObject.type === N.ArrayExpression || memberObject.type === N.StringLiteral) {
            newRootCallee = member;
            break;
        }

        currentNode = memberObject;
    }

    if (collectedArguments.length <= 1) return;

    const args: Node[] = [];
    for (let index = collectedArguments.length - 1; index >= 0; index--) args.push(...collectedArguments[index]);
    replaceExpression(ctx, expr, callExpression(expr, newRootCallee, args));
}

/** `[].concat(1, 2)` -> `[1, 2]`
 *  `"".concat(a, "b")` -> "`${a}b`" */
function tryFoldConcat(ctx: DceCtx, span: Span, args: Node[], callee: Node): Node | null {
    // let concat chaining reduction handle it first
    if (parentKind(ctx) === 'StaticMemberExpressionObject' && isStaticMemberNamed(parent(ctx).node, 'concat')) return null;

    const object = (callee.data as DataOf<'StaticMemberExpression'> | DataOf<'ComputedMemberExpression'>).object;
    if (object.type === N.ArrayExpression) {
        const array = object.data as DataOf<'ArrayExpression'>;
        let canMergeUntil = -1;
        for (let index = 0; index < args.length; index++) {
            const argument = args[index];
            if (argument.type === N.SpreadElement) break;
            if (!isLiteral(argument) && argument.type !== N.ArrayExpression) break;
            canMergeUntil = index;
        }

        if (canMergeUntil < 0) return null;
        // Parsed empty lists are shared and frozen, so the merged elements go into a fresh list.
        const elements = array.elements.slice();
        for (const argument of args.slice(0, canMergeUntil + 1)) {
            if (isLiteral(argument)) elements.push(argument);
            else elements.push(...(argument.data as DataOf<'ArrayExpression'>).elements);
        }
        array.elements = elements;

        if (canMergeUntil + 1 === args.length) return object;
        return callExpression(span, callee, args.slice(canMergeUntil + 1));
    }
    if (object.type === N.StringLiteral) {
        if (
            !supportsFeature(ctx, 'ES2015TemplateLiterals') ||
            args.length === 0 ||
            !args.every((argument) => argument.type !== N.SpreadElement)
        )
            return null;

        const expressionCount = args.filter((argument) => argument.type !== N.StringLiteral).length;
        const stringCount = args.length - expressionCount;

        // whether it is shorter to use `String::concat`
        if ('.concat()'.length + args.length + "''".length * stringCount < '${}'.length * expressionCount) return null;

        let scratch = stringLiteralText(object);
        const expressions: Node[] = [];
        const quasis: Node[] = [];

        for (const argument of args) {
            if (argument.type === N.StringLiteral) {
                scratch += stringLiteralText(argument);
            } else {
                quasis.push(node(N.TemplateElement, SPAN.start, SPAN.end, escapeStringForTemplateLiteral(scratch), null));
                scratch = '';
                expressions.push(argument);
            }
        }

        if (expressions.length === 0) return stringLiteral(span, scratch);

        quasis.push(node(N.TemplateElement, SPAN.start, SPAN.end, escapeStringForTemplateLiteral(scratch), null));
        return node(N.TemplateLiteral, span.start, span.end, '', { quasis, expressions });
    }
    return null;
}

/** Escape a cooked string for use as template-literal raw text. */
export function escapeStringForTemplateLiteral(value: string): string {
    if (!/[\\`$\r]/.test(value)) return value;
    return value.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('$', '\\$').replaceAll('\r', '\\r');
}

export function replaceKnownPropertyAccess(ctx: DceCtx, expr: Node): void {
    // property access should be kept to keep `this` value
    const kind = parentKind(ctx);
    if (kind === 'CallExpressionCallee' || kind === 'TaggedTemplateExpressionTag') return;

    let name: string;
    let object: Node;
    if (expr.type === N.StaticMemberExpression && !expr.data.optional) {
        name = (expr.data.property as Node).name;
        object = expr.data.object;
    } else if (expr.type === N.ComputedMemberExpression && !expr.data.optional) {
        const property = expr.data.expression as Node;
        object = expr.data.object;
        if (property.type === N.StringLiteral) {
            name = stringLiteralText(property);
        } else if (property.type === N.NumericLiteral) {
            const integerIndex = numberToIntegerIndex(numericLiteralValue(property));
            if (integerIndex !== null) {
                const replacement = tryFoldIntegerIndexAccess(ctx, object, integerIndex, expr);
                if (replacement !== null) replaceExpression(ctx, expr, replacement);
            }
            return;
        } else if (property.type === N.BigIntLiteral) {
            const integerIndex = bigIntToIntegerIndex(bigIntLiteralValue(property));
            if (integerIndex !== null) {
                const replacement = tryFoldIntegerIndexAccess(ctx, object, integerIndex, expr);
                if (replacement !== null) replaceExpression(ctx, expr, replacement);
            }
            return;
        } else {
            return;
        }
    } else {
        return;
    }

    let replacement: Node | null = null;
    if (object.type === N.IdentifierReference) {
        if (!isGlobalReference(ctx, object)) return;
        if (object.name === 'Number') replacement = tryFoldNumberConstants(ctx, name, expr);
    } else if (object.type === N.RegExpLiteral) {
        if (name === 'source') {
            const text = object.name;
            const slash = text.lastIndexOf('/');
            const pattern = text.slice(1, slash);
            const flags = text.slice(slash + 1);
            // the pattern might be invalid, keep it as-is to preserve the error
            if (isRegExpPatternValid(pattern, flags) && isRegExpSyntaxSupported(pattern, flags, ctx))
                replacement = stringLiteral(expr, pattern);
        }
    } else {
        return;
    }
    if (replacement !== null) replaceExpression(ctx, expr, replacement);
}

/** replace `Number.*` constants */
function tryFoldNumberConstants(ctx: DceCtx, name: string, span: Span): Node | null {
    // [neg] base ** exponent [op] a
    const powWithExpr = (at: Span, base: number, exponent: number, operator: string, a: number): Node =>
        binaryExpression(
            at,
            binaryExpression(SPAN, numericLiteral(SPAN, base), '**', numericLiteral(SPAN, exponent)),
            operator,
            numericLiteral(SPAN, a),
        );

    switch (name) {
        case 'POSITIVE_INFINITY':
            return numericLiteral(span, Number.POSITIVE_INFINITY);
        case 'NEGATIVE_INFINITY':
            return numericLiteral(span, Number.NEGATIVE_INFINITY);
        case 'NaN':
            return numericLiteral(span, Number.NaN);
        case 'MAX_SAFE_INTEGER':
            if (supportsFeature(ctx, 'ES2016ExponentiationOperator')) {
                // 2**53 - 1
                return powWithExpr(span, 2, 53, '-', 1);
            }
            return numericLiteral(span, 2 ** 53 - 1);
        case 'MIN_SAFE_INTEGER':
            if (supportsFeature(ctx, 'ES2016ExponentiationOperator')) {
                // -(2**53 - 1)
                return unaryExpression(span, '-', powWithExpr(SPAN, 2, 53, '-', 1));
            }
            return numericLiteral(span, -(2 ** 53 - 1));
        case 'EPSILON':
            if (!supportsFeature(ctx, 'ES2016ExponentiationOperator')) return null;
            // 2**-52
            return binaryExpression(span, numericLiteral(SPAN, 2), '**', numericLiteral(SPAN, -52));
        default:
            return null;
    }
}

/** Compress `"abc"[0]` to `"a"` and `[0,1,2][1]` to `1` */
function tryFoldIntegerIndexAccess(ctx: DceCtx, object: Node, property: number, span: Span): Node | null {
    if (mayHaveSideEffects(object, ctx)) return null;

    if (object.type === N.StringLiteral) {
        // oxc re-encodes lone surrogates in `value`, so indexing it would not index the string.
        const value = plainStringLiteralValue(object);
        if (value === null) return null;
        const result = stringCharAt(value, property);
        if (result === null || result.invalid) return null;
        return stringLiteral(span, String.fromCharCode(result.unit));
    }
    if (object.type === N.ArrayExpression) {
        const elements = (object.data as DataOf<'ArrayExpression'>).elements;
        let lengthUntilSpread = 0;
        while (lengthUntilSpread < elements.length && elements[lengthUntilSpread]?.type !== N.SpreadElement) lengthUntilSpread++;
        if (property < lengthUntilSpread) {
            const element = elements[property];
            if (element === null) return createVoidZero(span);
            return element;
        }
        return null;
    }
    return null;
}

function validateGlobalReference(ctx: DceCtx, expr: Node, target: string): boolean {
    if (expr.type !== N.IdentifierReference) return false;
    return isGlobalReference(ctx, expr) && expr.name === target;
}

function validateArguments(args: Node[], expectedLength: number): boolean {
    return args.length === expectedLength && args.every((argument) => argument.type !== N.SpreadElement);
}
