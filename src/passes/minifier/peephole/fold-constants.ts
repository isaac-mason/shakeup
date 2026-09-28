// Port of oxc_minifier/src/peephole/fold_constants.rs. Every fold here runs in tree-shake mode.

import {
    evaluateValueInContext,
    evaluateValueToBoolean,
    evaluateValueToNumber,
    getInnerExpression,
    getSideFreeNumberValue,
    getSideFreeStringValue,
    numericLiteralValue,
    stringLiteralValue,
    templateElementCooked,
    toJsString,
    utf8Length,
    valueType,
} from '../../../analysis/const-eval.ts';
import type { ConstantValue } from '../../../analysis/constant-value.ts';
import { mayHaveSideEffects } from '../../../analysis/side-effects.ts';
import { type DataOf, N, type Node, node } from '../../../ast/index.ts';
import { numberLiteral } from '../../../print/print-constant.ts';
import { symbolValueOf } from '../symbol-state.ts';
import { canInlineInitializedConstant } from '../symbol-value.ts';
import {
    createVoidZero,
    type DceCtx,
    dropExpression,
    evalBinary,
    evalBinaryOperation,
    isExpressionUndefined,
    isGlobalExpr,
    isIdentifierUndefined,
    noticeChange,
    referenceOf,
    replaceExpression,
    type Span,
    takeNode,
    valueToExpr,
} from '../traverse-context.ts';
import { shouldKeepIndirectAccess } from './remove-dead-code.ts';
import { escapeStringForTemplateLiteral } from './replace-known-methods.ts';

const EMPTY_SPAN: Span = { start: 0, end: 0 };

/** oxc `Span::merge_within`, with `SPAN` for the `None` case. */
function mergeWithin(first: Span, second: Span, within: Span): Span {
    const start = Math.min(first.start, second.start);
    const end = Math.max(first.end, second.end);
    return within.start <= start && end <= within.end ? { start, end } : EMPTY_SPAN;
}

/** Rust `f64::fract`. */
const fract = (value: number): number => value - Math.trunc(value);

/** Rust `f64::is_sign_negative`. */
const isSignNegative = (value: number): boolean => value < 0 || Object.is(value, -0);

const numericLiteral = (span: Span, text: string): Node => node(N.NumericLiteral, span.start, span.end, text, null);

const sequenceExpression = (span: Span, expressions: Node[]): Node =>
    node(N.SequenceExpression, span.start, span.end, '', { expressions });

const binaryExpression = (span: Span, left: Node, operator: string, right: Node): Node =>
    node(N.BinaryExpression, span.start, span.end, '', { operator, left, right });

const booleanLiteral = (span: Span, value: boolean): Node =>
    node(N.BooleanLiteral, span.start, span.end, value ? 'true' : 'false', null);

const isNumber0 = (expr: Node): boolean => expr.type === N.NumericLiteral && numericLiteralValue(expr) === 0;

const isVoid0 = (expr: Node): boolean =>
    expr.type === N.UnaryExpression && expr.data.operator === 'void' && isNumber0(expr.data.argument);

/** oxc `Expression::is_literal`. */
const isLiteral = (expr: Node): boolean =>
    expr.type === N.BooleanLiteral ||
    expr.type === N.NullLiteral ||
    expr.type === N.NumericLiteral ||
    expr.type === N.BigIntLiteral ||
    expr.type === N.RegExpLiteral ||
    expr.type === N.StringLiteral;

const isMemberExpression = (expr: Node): boolean =>
    expr.type === N.StaticMemberExpression || expr.type === N.ComputedMemberExpression || expr.type === N.PrivateFieldExpression;

const isEqualityOperator = (operator: string): boolean =>
    operator === '==' || operator === '!=' || operator === '===' || operator === '!==';

/** oxc `PropertyKey::static_name` for a non-computed key. */
function propertyKeyStaticName(key: Node): string | null {
    switch (key.type) {
        case N.IdentifierName:
            return key.name;
        case N.StringLiteral:
            return stringLiteralValue(key).value;
        case N.NumericLiteral:
            return String(numericLiteralValue(key));
        case N.NullLiteral:
            return 'null';
        default:
            return null;
    }
}

const isSpecificStaticName = (key: Node, name: string): boolean => propertyKeyStaticName(key) === name;

/** oxc `MemberExpression::static_property_name`. */
function staticPropertyName(member: Node): string | null {
    switch (member.type) {
        case N.StaticMemberExpression:
            return member.data.property.name;
        case N.ComputedMemberExpression: {
            const property = member.data.expression;
            if (property.type === N.StringLiteral) return stringLiteralValue(property).value;
            if (property.type === N.TemplateLiteral && property.data.quasis.length === 1)
                return templateElementCooked(property.data.quasis[0])?.value ?? null;
            if (property.type === N.RegExpLiteral) return property.name;
            return null;
        }
        default:
            return null;
    }
}

export function foldUnaryExpr(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.UnaryExpression) return;
    const { operator, argument } = expr.data;
    // Do not fold `void 0` back to `undefined`.
    if (operator === 'void' && isNumber0(argument)) return;
    // Do not fold `true` and `false` back to `!0` and `!1`.
    if (operator === '!' && argument.type === N.NumericLiteral) {
        const value = numericLiteralValue(argument);
        if (value === 0 || value === 1) return;
    }
    // Do not fold big int.
    if (operator === '-' && argument.type === N.BigIntLiteral) return;
    // oxc checks side effects first; evaluation only reads, so the order does not change the answer
    const value = evaluateValueInContext(expr, ctx);
    if (value === null || mayHaveSideEffects(expr, ctx)) return;
    replaceExpression(ctx, expr, valueToExpr(ctx, expr, value));
}

export function foldStaticMemberExpr(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.StaticMemberExpression) return;
    // `evaluate_value` folds only a narrow set of member accesses, so it runs before the side-effect walk.
    const value = evaluateValueInContext(expr, ctx);
    if (value === null) return;
    if (mayHaveSideEffects(expr.data.object, ctx)) return;
    replaceExpression(ctx, expr, valueToExpr(ctx, expr, value));
}

export function foldComputedMemberExpr(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.ComputedMemberExpression) return;
    const value = evaluateValueInContext(expr, ctx);
    if (value === null) return;
    if (mayHaveSideEffects(expr.data.object, ctx) || mayHaveSideEffects(expr.data.expression, ctx)) return;
    replaceExpression(ctx, expr, valueToExpr(ctx, expr, value));
}

export function foldLogicalExpr(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.LogicalExpression) return;
    const changed = expr.data.operator === '??' ? tryFoldCoalesce(ctx, expr) : tryFoldAndOr(ctx, expr);
    if (changed !== null) replaceExpression(ctx, expr, changed);
}

export function foldChainExpr(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.ChainExpression) return;
    const fold = tryFoldChainAtElement(ctx, expr.data.expression);
    switch (fold.kind) {
        case 'unfolded':
            return;
        case 'flipped':
            // For `(known_obj)?.foo?.bar` the inner `?.` flips, but the outer `?.bar` keeps the wrapper alive.
            if (fold.hasOptional) noticeChange(ctx);
            else replaceExpression(ctx, expr, expr.data.expression);
            return;
        case 'collapse': {
            // Without side effects `base` is dropped with the rest of the old chain.
            const newExpr = fold.baseHasSideEffects
                ? sequenceExpression(expr, [fold.base, createVoidZero(expr)])
                : valueToExpr(ctx, expr, { kind: 'undefined' });
            replaceExpression(ctx, expr, newExpr);
            return;
        }
    }
}

/** Try to fold an AND / OR node. */
export function tryFoldAndOr(ctx: DceCtx, logicalExpr: Node): Node | null {
    const data = logicalExpr.data as DataOf<'LogicalExpression'>;
    const operator = data.operator;
    const left = data.left;
    const leftValue = evaluateValueToBoolean(left, ctx);

    if (leftValue !== null) {
        // (TRUE || x) => TRUE (also, (3 || x) => 3)
        // (FALSE && x) => FALSE
        if (leftValue ? operator === '||' : operator === '&&') {
            // Keep esbuild's `0 && (module.exports = { ... })` hint for `cjs-module-lexer`.
            if (!leftValue && operator === '&&' && isCjsModuleExportsHint(data.right)) return null;
            return data.left;
        } else if (!mayHaveSideEffects(left, ctx)) {
            // (true && o.f) => (0, o.f)
            if (shouldKeepIndirectAccess(ctx, data.right)) {
                return sequenceExpression(logicalExpr, [numericLiteral(data.left, '0'), data.right]);
            }
            // (FALSE || x) => x
            // (TRUE && x) => x
            return data.right;
        }
        // Left side may have side effects, but we know its boolean value.
        // e.g. true_with_sideeffects || foo() => true_with_sideeffects, foo()
        return sequenceExpression(logicalExpr, [data.left, data.right]);
    } else if (left.type === N.LogicalExpression && left.data.operator === operator) {
        const leftChild = left.data as DataOf<'LogicalExpression'>;
        const leftChildRightBoolean = evaluateValueToBoolean(leftChild.right, ctx);
        const leftChildOperator = leftChild.operator;
        if (leftChildRightBoolean !== null && !mayHaveSideEffects(leftChild.right, ctx)) {
            // a || false || b => a || b
            // a && true && b => a && b
            if ((!leftChildRightBoolean && leftChildOperator === '||') || (leftChildRightBoolean && leftChildOperator === '&&')) {
                return node(N.LogicalExpression, logicalExpr.start, logicalExpr.end, '', {
                    operator: leftChildOperator,
                    left: leftChild.left,
                    right: data.right,
                });
            }
        }
    }
    return null;
}

/** Try to fold a nullish coalesce `foo ?? bar`. */
export function tryFoldCoalesce(ctx: DceCtx, logicalExpr: Node): Node | null {
    const data = logicalExpr.data as DataOf<'LogicalExpression'>;
    const left = data.left;
    switch (valueType(left, ctx)) {
        case 'null':
        case 'undefined':
            if (mayHaveSideEffects(left, ctx)) {
                // e.g. `(a(), null) ?? 1` => `(a(), null, 1)`
                return sequenceExpression(logicalExpr, [data.left, data.right]);
            }
            // (null ?? o.f) => (0, o.f)
            if (shouldKeepIndirectAccess(ctx, data.right)) {
                return sequenceExpression(logicalExpr, [numericLiteral(data.left, '0'), data.right]);
            }
            // nullish condition => this expression evaluates to the right side.
            return data.right;
        case 'number':
        case 'bigint':
        case 'string':
        case 'boolean':
        case 'object':
            // (o.f ?? something) => (0, o.f)
            if (shouldKeepIndirectAccess(ctx, data.left)) {
                return sequenceExpression(logicalExpr, [numericLiteral(data.right, '0'), data.left]);
            }
            // non-nullish condition => this expression evaluates to the left side.
            return data.left;
        case 'undetermined':
            return null;
    }
}

function extractNumericValues(ctx: DceCtx, binary: Node): [number, number] | null {
    const { left, right } = binary.data as DataOf<'BinaryExpression'>;
    if (left.type === N.NumericLiteral && right.type === N.NumericLiteral)
        return [numericLiteralValue(left), numericLiteralValue(right)];
    // `undefined` has no literal form and a tracked-constant read is an identifier, so fall back to
    // the evaluator, which applies ToNumber and refuses operands with side effects.
    if (!isCheapToNumberOperand(left) || !isCheapToNumberOperand(right)) return null;
    const leftNumber = getSideFreeNumberValue(left, ctx);
    if (leftNumber === null) return null;
    const rightNumber = getSideFreeNumberValue(right, ctx);
    if (rightNumber === null) return null;
    return [leftNumber, rightNumber];
}

/** Operand shapes whose ToNumber evaluation is cheap. */
function isCheapToNumberOperand(expr: Node): boolean {
    switch (getInnerExpression(expr).type) {
        case N.NumericLiteral:
        case N.StringLiteral:
        case N.BooleanLiteral:
        case N.NullLiteral:
        case N.IdentifierReference:
        case N.UnaryExpression:
            return true;
        default:
            return false;
    }
}

const numberResult = (value: ConstantValue | null): number | null =>
    value !== null && value.kind === 'number' ? value.value : null;

export function foldBinaryExpr(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.BinaryExpression) return;
    const { operator, left, right } = expr.data;
    // Do not fold `1/0` and `-1/0`: codegen prints the non-finite numbers in exactly this form.
    if (
        operator === '/' &&
        right.type === N.NumericLiteral &&
        numericLiteralValue(right) === 0 &&
        !isSignNegative(numericLiteralValue(right)) &&
        left.type === N.NumericLiteral &&
        Math.abs(numericLiteralValue(left)) === 1
    ) {
        return;
    }

    const span: Span = expr;
    let changed: Node | null = null;
    switch (operator) {
        case '==':
        case '!=':
        case '===':
        case '!==':
        case '<':
        case '>':
        case '<=':
        case '>=':
        case '>>':
        case 'instanceof':
            changed = evalBinary(ctx, expr);
            break;
        case '&':
        case '|':
        case '^':
            changed = evalBinary(ctx, expr) ?? tryFoldLeftChildOp(ctx, expr);
            break;
        case '+':
            changed = tryFoldAdd(ctx, expr);
            break;
        case '-': {
            // Subtraction of small-ish integers can definitely be folded without issues.
            const values = extractNumericValues(ctx, expr);
            if (values === null) break;
            const [leftNumber, rightNumber] = values;
            if (
                !(
                    Number.isNaN(leftNumber) ||
                    Number.isFinite(leftNumber) ||
                    Number.isNaN(rightNumber) ||
                    Number.isFinite(rightNumber) ||
                    (fract(leftNumber) === 0 &&
                        fract(rightNumber) === 0 &&
                        Math.abs(leftNumber) <= 0xffffffff &&
                        Math.abs(rightNumber) <= 0xffffffff)
                )
            )
                break;
            if (foldedNumericExpressionIsShorter(expr, leftNumber - rightNumber) === false) break;
            changed = evalBinary(ctx, expr);
            break;
        }
        case '*':
        case '**':
        case '%': {
            let shorterNumericExpression: Node | null = null;
            if (operator === '*') {
                shorterNumericExpression = tryFoldShorterNumericExpression(ctx, expr);
            } else if (operator === '**') {
                // Number exponentiation is implementation-approximated, so only fold integer-valued
                // operands where the result is an exact safe integer.
                const values = extractNumericValues(ctx, expr);
                if (values !== null && fract(values[0]) === 0 && fract(values[1]) === 0)
                    shorterNumericExpression = tryFoldSafeIntegerNumericExpression(ctx, expr);
            } else {
                shorterNumericExpression = tryFoldSafeIntegerNumericExpression(ctx, expr);
            }
            if (shorterNumericExpression !== null) {
                changed = shorterNumericExpression;
                break;
            }
            const values = extractNumericValues(ctx, expr);
            if (values === null) break;
            const [leftNumber, rightNumber] = values;
            if (
                leftNumber === 0 ||
                Number.isNaN(leftNumber) ||
                (!Number.isFinite(leftNumber) && !Number.isNaN(leftNumber)) ||
                rightNumber === 0 ||
                Number.isNaN(rightNumber) ||
                (!Number.isFinite(rightNumber) && !Number.isNaN(rightNumber)) ||
                // Small number multiplication.
                (operator === '*' &&
                    Math.abs(leftNumber) <= 255 &&
                    fract(leftNumber) === 0 &&
                    Math.abs(rightNumber) <= 255 &&
                    fract(rightNumber) === 0)
            )
                changed = evalBinary(ctx, expr);
            break;
        }
        case '/': {
            changed = tryFoldSafeIntegerNumericExpression(ctx, expr);
            if (changed !== null) break;
            const values = extractNumericValues(ctx, expr);
            if (values === null) break;
            const rightNumber = values[1];
            if (rightNumber === 0 || Number.isNaN(rightNumber) || (!Number.isFinite(rightNumber) && !Number.isNaN(rightNumber)))
                changed = evalBinary(ctx, expr);
            break;
        }
        case '<<':
        case '>>>': {
            const values = extractNumericValues(ctx, expr);
            if (values === null) break;
            const result = numberResult(evaluateValueInContext(expr, ctx));
            if (result === null) break;
            const leftLength = approximatePrintedIntCharCount(values[0]);
            const rightLength = approximatePrintedIntCharCount(values[1]);
            const resultLength = approximatePrintedIntCharCount(result);
            const operatorLength = operator === '<<' ? 2 : 3;
            if (resultLength <= leftLength + operatorLength + rightLength)
                changed = valueToExpr(ctx, span, { kind: 'number', value: result });
            break;
        }
        case 'in':
            break;
    }
    if (changed !== null) replaceExpression(ctx, expr, changed);
}

function approximatePrintedIntCharCount(value: number): number {
    let count: number;
    if (!Number.isFinite(value) && !Number.isNaN(value)) count = 'Infinity'.length;
    else if (Number.isNaN(value)) count = 'NaN'.length;
    // Rust's `as usize` saturates negative and -infinite logarithms to 0.
    else count = 1 + Math.max(0, Math.floor(Math.log10(Math.abs(value))));
    if (isSignNegative(value)) count += 1;
    return count;
}

/** Lower bound for the minified size of a numeric expression. Parentheses are deliberately omitted,
 *  so accepting a fold based on this count cannot make the output longer. */
function numericExpressionSizeLowerBound(expr: Node): number | null {
    const inner = getInnerExpression(expr);
    switch (inner.type) {
        case N.NumericLiteral:
            return numberLiteralSourceLen(numericLiteralValue(inner));
        case N.UnaryExpression: {
            if (inner.data.operator !== '-' && inner.data.operator !== '+') return null;
            const argument = numericExpressionSizeLowerBound(inner.data.argument);
            return argument === null ? null : 1 + argument;
        }
        case N.BinaryExpression:
            switch (inner.data.operator) {
                case '+':
                case '-':
                case '*':
                case '/':
                case '%':
                case '**':
                    return binaryNumericExpressionSizeLowerBound(inner);
                default:
                    return null;
            }
        default:
            return null;
    }
}

function binaryNumericExpressionSizeLowerBound(binary: Node): number | null {
    const { operator, left, right } = binary.data as DataOf<'BinaryExpression'>;
    const leftSize = numericExpressionSizeLowerBound(left);
    if (leftSize === null) return null;
    const rightSize = numericExpressionSizeLowerBound(right);
    if (rightSize === null) return null;
    return leftSize + operator.length + rightSize;
}

function numberLiteralSourceLen(value: number): number | null {
    if (!Number.isFinite(value)) return null;
    return (isSignNegative(value) ? 1 : 0) + numberLiteral(Math.abs(value)).length;
}

function tryFoldShorterNumericExpression(ctx: DceCtx, binary: Node): Node | null {
    const originalLength = binaryNumericExpressionSizeLowerBound(binary);
    if (originalLength === null) return null;
    const result = numberResult(evaluateValueInContext(binary, ctx));
    if (result === null) return null;
    const resultLength = numberLiteralSourceLen(result);
    if (resultLength === null || resultLength > originalLength) return null;
    return valueToExpr(ctx, binary, { kind: 'number', value: result });
}

function tryFoldSafeIntegerNumericExpression(ctx: DceCtx, binary: Node): Node | null {
    if (extractNumericValues(ctx, binary) === null) return null;
    const result = numberResult(evaluateValueInContext(binary, ctx));
    if (result === null) return null;
    const isSafeInteger = fract(result) === 0 && Math.abs(result) <= 9_007_199_254_740_991;
    if (!isSafeInteger || foldedNumericExpressionIsShorter(binary, result) !== true) return null;
    return valueToExpr(ctx, binary, { kind: 'number', value: result });
}

function foldedNumericExpressionIsShorter(binary: Node, result: number): boolean | null {
    const originalLength = binaryNumericExpressionSizeLowerBound(binary);
    if (originalLength === null) return null;
    const resultLength = numberLiteralSourceLen(result);
    if (resultLength === null) return null;
    return resultLength <= originalLength;
}

/** Lower bound for the minified size of a string addition operand, and whether folding it would
 *  materialize a non-inlineable tracked constant. */
function stringExpressionSizeLowerBound(ctx: DceCtx, expr: Node): [number, boolean] | null {
    const inner = getInnerExpression(expr);
    switch (inner.type) {
        case N.StringLiteral:
            return [utf8Length(stringLiteralValue(inner).value) + 2, false];
        case N.NumericLiteral: {
            const length = numberLiteralSourceLen(numericLiteralValue(inner));
            return length === null ? null : [length, false];
        }
        case N.BooleanLiteral:
            return [2, false];
        case N.NullLiteral:
            return [4, false];
        case N.IdentifierReference: {
            const symbolId = referenceOf(ctx, inner)?.symbolId ?? 0;
            const value = symbolId === 0 ? null : symbolValueOf(ctx.state.symbols, symbolId);
            return [
                utf8Length(inner.name),
                value !== null && value.initializedConstant !== null && !canInlineInitializedConstant(value),
            ];
        }
        case N.BinaryExpression: {
            if (inner.data.operator !== '+') return null;
            const leftSize = stringExpressionSizeLowerBound(ctx, inner.data.left);
            if (leftSize === null) return null;
            const rightSize = stringExpressionSizeLowerBound(ctx, inner.data.right);
            if (rightSize === null) return null;
            return [leftSize[0] + 1 + rightSize[0], leftSize[1] || rightSize[1]];
        }
        default:
            return null;
    }
}

/** Simplified version of `tryFoldAdd` from closure compiler. */
function tryFoldAdd(ctx: DceCtx, binary: Node): Node | null {
    const data = binary.data as DataOf<'BinaryExpression'>;
    // oxc checks side effects first; evaluation only reads, so checking them only for a value that folds is
    // the same answer without the subtree walk for every `+` that does not.
    const evaluated = evaluateValueInContext(binary, ctx);
    const value = evaluated === null || mayHaveSideEffects(binary, ctx) ? null : evaluated;
    if (value !== null) {
        if (value.kind === 'number' && foldedNumericExpressionIsShorter(binary, value.value) === false) return null;
        if (value.kind === 'string') {
            const leftSize = stringExpressionSizeLowerBound(ctx, data.left);
            const rightSize = stringExpressionSizeLowerBound(ctx, data.right);
            if (
                leftSize !== null &&
                rightSize !== null &&
                utf8Length(value.value) + 2 > leftSize[0] + 1 + rightSize[0] &&
                (leftSize[1] || rightSize[1])
            )
                return null;
        }
        return valueToExpr(ctx, binary, value);
    }

    const folded = tryFoldAddOp(ctx, data.left, data.right, binary);
    if (folded !== null) return folded;

    // a + 'b' + 'c' -> a + 'bc'
    // Only sound when the inner operator is also `+`: for `(x - 'b') + 'c'` the inner string operand
    // is numerically coerced.
    const leftBinary = data.left;
    if (
        leftBinary.type === N.BinaryExpression &&
        leftBinary.data.operator === '+' &&
        valueType(leftBinary.data.right, ctx) === 'string'
    ) {
        const leftString = getSideFreeStringValue(leftBinary.data.right, ctx);
        const rightString = getSideFreeStringValue(data.right, ctx);
        if (leftString !== null && rightString !== null) {
            const span = mergeWithin(leftBinary.data.right, data.right, binary);
            const right = node(N.StringLiteral, span.start, span.end, JSON.stringify(leftString + rightString), null);
            return binaryExpression(binary, leftBinary.data.left, data.operator, right);
        }

        const newRight = tryFoldAddOp(ctx, leftBinary.data.right, data.right, binary);
        if (newRight !== null) return binaryExpression(binary, leftBinary.data.left, data.operator, newRight);
    }

    return null;
}

function tryFoldAddOp(ctx: DceCtx, leftExpr: Node, rightExpr: Node, parentSpan: Span): Node | null {
    if (leftExpr.type === N.TemplateLiteral) {
        const left = leftExpr.data as DataOf<'TemplateLiteral'>;
        // "`${a}b` + `x${y}`" => "`${a}bx${y}`"
        if (rightExpr.type === N.TemplateLiteral) {
            const right = rightExpr.data as DataOf<'TemplateLiteral'>;
            setSpan(leftExpr, mergeWithin(leftExpr, rightExpr, parentSpan));
            const leftLastQuasi = left.quasis[left.quasis.length - 1];
            const rightFirstQuasi = right.quasis[0];
            setRaw(leftLastQuasi, leftLastQuasi.name + rightFirstQuasi.name);
            // The first quasi is already merged; the cooked value follows the raw text.
            left.quasis.push(...right.quasis.splice(1));
            left.expressions.push(...right.expressions.splice(0));
            return leftExpr;
        }

        // "`${x}y` + 'z'" => "`${x}yz`"
        const rightString = getSideFreeStringValue(rightExpr, ctx);
        if (rightString !== null) {
            setSpan(leftExpr, mergeWithin(leftExpr, rightExpr, parentSpan));
            const lastQuasi = left.quasis[left.quasis.length - 1];
            setRaw(lastQuasi, lastQuasi.name + escapeStringForTemplateLiteral(rightString));
            return leftExpr;
        }
    } else if (rightExpr.type === N.TemplateLiteral) {
        // "'x' + `y${z}`" => "`xy${z}`"
        const leftString = getSideFreeStringValue(leftExpr, ctx);
        if (leftString !== null) {
            const right = rightExpr.data as DataOf<'TemplateLiteral'>;
            setSpan(rightExpr, mergeWithin(rightExpr, leftExpr, parentSpan));
            const firstQuasi = right.quasis[0];
            setRaw(firstQuasi, escapeStringForTemplateLiteral(leftString) + firstQuasi.name);
            return rightExpr;
        }
    }

    // remove useless `+ ""` (e.g. `typeof foo + ""` -> `typeof foo`)
    if (evaluatesToEmptyString(leftExpr) && valueType(rightExpr, ctx) === 'string') return rightExpr;
    if (evaluatesToEmptyString(rightExpr) && valueType(leftExpr, ctx) === 'string') return leftExpr;

    return null;
}

/** A template element's raw text is its `name`; its cooked value is derived from it. */
function setRaw(quasi: Node, raw: string): void {
    (quasi as { name: string }).name = raw;
}

function setSpan(target: Node, span: Span): void {
    const writable = target as { start: number; end: number };
    writable.start = span.start;
    writable.end = span.end;
}

function evaluatesToEmptyString(expr: Node): boolean {
    switch (expr.type) {
        case N.StringLiteral:
            return stringLiteralValue(expr).value === '';
        case N.ArrayExpression:
            return expr.data.elements.length === 0;
        default:
            return false;
    }
}

function tryFoldLeftChildOp(ctx: DceCtx, binary: Node): Node | null {
    const data = binary.data as DataOf<'BinaryExpression'>;
    const operator = data.operator;
    const left = data.left;
    if (left.type !== N.BinaryExpression || left.data.operator !== operator) return null;

    let value: ConstantValue | null = evalBinaryOperation(ctx, operator, left.data.left, data.right);
    let exprToMove: Node;
    if (value !== null) {
        exprToMove = left.data.right;
    } else {
        value = evalBinaryOperation(ctx, operator, left.data.right, data.right);
        if (value === null) return null;
        exprToMove = left.data.left;
    }

    return binaryExpression(
        binary,
        exprToMove,
        operator,
        valueToExpr(ctx, mergeWithin(left.data.right, data.right, binary), value),
    );
}

export function foldCallExpression(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.CallExpression) return;
    const call = expr.data as DataOf<'CallExpression'>;
    if (!isGlobalExpr(ctx, 'Number', call.callee)) return;
    if (call.arguments.length !== 1) return;
    const argument = call.arguments[0];
    if (argument.type === N.SpreadElement) return;
    let value: number;
    switch (argument.type) {
        // `Number(undefined)` -> `NaN`
        case N.IdentifierReference:
            if (!isIdentifierUndefined(ctx, argument)) return;
            value = Number.NaN;
            break;
        // `Number(null)` -> `0`
        case N.NullLiteral:
            value = 0;
            break;
        // `Number(true)` -> `1` `Number(false)` -> `0`
        case N.BooleanLiteral:
            value = argument.name === 'true' ? 1 : 0;
            break;
        // `Number(100)` -> `100`
        case N.NumericLiteral:
            value = numericLiteralValue(argument);
            break;
        // `Number("a")` -> `+"a"` -> `NaN`
        // `Number("1")` -> `+"1"` -> `1`
        case N.StringLiteral: {
            const number = evaluateValueToNumber(argument, ctx);
            if (number === null) {
                const unary = node(N.UnaryExpression, expr.start, expr.end, '', {
                    operator: '+',
                    prefix: true,
                    argument,
                });
                replaceExpression(ctx, expr, unary);
                return;
            }
            value = number;
            break;
        }
        default:
            if (!isVoid0(argument)) return;
            value = Number.NaN;
    }
    replaceExpression(ctx, expr, valueToExpr(ctx, expr, { kind: 'number', value }));
}

function isTypeofString(value: string): boolean {
    switch (value) {
        case 'string':
        case 'number':
        case 'bigint':
        case 'boolean':
        case 'symbol':
        case 'undefined':
        case 'object':
        case 'function':
        // IE
        case 'unknown':
            return true;
        default:
            return false;
    }
}

export function foldBinaryTypeofComparison(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.BinaryExpression) return;
    const { operator, left, right } = expr.data;
    // `typeof a == typeof a` -> `true`, `typeof a != typeof a` -> `false`
    if (
        isEqualityOperator(operator) &&
        left.type === N.UnaryExpression &&
        right.type === N.UnaryExpression &&
        left.data.operator === 'typeof' &&
        right.data.operator === 'typeof' &&
        left.data.argument.type === N.IdentifierReference &&
        right.data.argument.type === N.IdentifierReference &&
        left.data.argument.name === right.data.argument.name
    ) {
        replaceExpression(ctx, expr, booleanLiteral(expr, operator === '===' || operator === '=='));
        return;
    }

    // `typeof a === 'asd'` -> `false`
    // `typeof a !== 'b'` -> `true`
    if (
        left.type === N.UnaryExpression &&
        left.data.operator === 'typeof' &&
        isEqualityOperator(operator) &&
        !mayHaveSideEffects(left, ctx)
    ) {
        const isStrict = operator === '===' || operator === '!==';
        let mayBeEqual: boolean;
        if (right.type === N.StringLiteral) {
            mayBeEqual = isTypeofString(stringLiteralValue(right).value);
        } else {
            const type = valueType(right, ctx);
            // A loose comparison with an object can be `true` via ToPrimitive, so only fold when the
            // object's string value is statically known to not be a typeof result.
            let objectMayBeEqual = false;
            if (type === 'object' && !isStrict) {
                const rightString = toJsString(right, ctx);
                objectMayBeEqual = rightString === null || isTypeofString(rightString);
            }
            mayBeEqual = type === 'undetermined' || type === 'string' || objectMayBeEqual;
        }

        if (mayBeEqual || mayHaveSideEffects(right, ctx)) return;

        replaceExpression(ctx, expr, booleanLiteral(expr, operator === '!=' || operator === '!=='));
    }
}

function shouldFoldSpreadElement(ctx: DceCtx, expr: Node): boolean {
    switch (expr.type) {
        case N.ArrayExpression:
            if (expr.data.elements.length === 0) return true;
            break;
        case N.ArrowFunctionExpression:
        case N.FunctionExpression:
            return true;
    }
    if (isLiteral(expr) && expr.type !== N.StringLiteral) return true;
    const value = evaluateValueInContext(expr, ctx);
    return value !== null && value.kind !== 'string' && !mayHaveSideEffects(expr, ctx);
}

export function foldObjectExp(ctx: DceCtx, objectExpr: Node): void {
    const properties = (objectExpr.data as DataOf<'ObjectExpression'>).properties;
    let shouldFold = false;
    for (const property of properties) {
        if (property.type !== N.SpreadElement) continue;
        const argument = property.data.argument;
        if (argument.type === N.ObjectExpression && isSpreadInlineableObjectLiteral(ctx, argument)) shouldFold = true;
        else if (shouldFoldSpreadElement(ctx, argument)) shouldFold = true;
    }
    if (!shouldFold) return;

    const newProperties: Node[] = [];
    for (const property of properties) {
        if (property.type !== N.SpreadElement) {
            newProperties.push(property);
            continue;
        }
        const argument = property.data.argument;
        if (isExpressionUndefined(ctx, argument)) {
            dropExpression(ctx, argument);
            continue;
        }
        if (argument.type === N.ObjectExpression && isSpreadInlineableObjectLiteral(ctx, argument)) {
            for (const inner of argument.data.properties as Node[]) {
                if (inner.type === N.SpreadElement) {
                    newProperties.push(inner);
                    continue;
                }
                const innerProperty = inner.data as DataOf<'ObjectProperty'>;
                if (innerProperty.computed || innerProperty.method || !isSpecificStaticName(innerProperty.key, '__proto__')) {
                    newProperties.push(inner);
                } else {
                    // A non-computed `__proto__` would set the prototype rather than become a property.
                    dropExpression(ctx, innerProperty.value);
                }
            }
        } else if (shouldFoldSpreadElement(ctx, argument)) {
            dropExpression(ctx, argument);
        } else {
            newProperties.push(property);
        }
    }

    properties.splice(0, properties.length, ...newProperties);
    noticeChange(ctx);
}

function isSpreadInlineableObjectLiteral(ctx: DceCtx, objectExpr: Node): boolean {
    return (objectExpr.data as DataOf<'ObjectExpression'>).properties.every((property) => {
        if (property.type === N.SpreadElement) return true;
        const objectProperty = property.data as DataOf<'ObjectProperty'>;
        // getters are evaluated when spreading
        return (
            objectProperty.kind === 'init' &&
            // non-computed __proto__ property sets the prototype of the object instead
            (objectProperty.computed ||
                objectProperty.method ||
                !isSpecificStaticName(objectProperty.key, '__proto__') ||
                !mayHaveSideEffects(objectProperty.value, ctx))
        );
    });
}

/** Inline constant values in template literals: `foo${1}bar${i}` => `foo1bar${i}`. */
export function inlineTemplateLiteral(ctx: DceCtx, templateLiteral: Node): void {
    const { quasis, expressions } = templateLiteral.data as DataOf<'TemplateLiteral'>;
    const inlineExprs: [index: number, value: string][] = [];
    for (let index = 0; index < expressions.length; index++) {
        const expr = expressions[index];
        if (mayHaveSideEffects(expr, ctx)) continue;
        const value = toJsString(expr, ctx);
        if (value !== null) inlineExprs.push([index, value]);
    }
    if (inlineExprs.length === 0) return;

    // Drop the inline-able expressions; their indices are in ascending order.
    for (let removed = 0; removed < inlineExprs.length; removed++) {
        const [index] = inlineExprs[removed];
        const [expr] = expressions.splice(index - removed, 1);
        dropExpression(ctx, expr);
    }

    // "current_quasis + extracted_value + next_quasis"
    for (let removed = 0; removed < inlineExprs.length; removed++) {
        const [originalIndex, value] = inlineExprs[removed];
        const index = originalIndex - removed;
        const nextQuasi = index + 1 < quasis.length ? quasis.splice(index + 1, 1)[0] : null;
        const quasi = quasis[index];
        const escaped = escapeStringForTemplateLiteral(value);
        const nextRaw = nextQuasi === null ? '' : nextQuasi.name;
        const raw = quasi.name;
        const firstChar = escaped.length > 0 ? escaped[0] : nextRaw[0];
        const startsWithDigit = firstChar !== undefined && firstChar >= '0' && firstChar <= '9';
        const cookedEndsWithNull = templateElementCooked(quasi)?.value.endsWith('\0') ?? false;
        // A trailing `\0` followed by a digit would read as a legacy octal escape.
        if (startsWithDigit && cookedEndsWithNull && raw.endsWith('\\0')) {
            setRaw(quasi, `${raw.slice(0, -2)}\\x00${escaped}${nextRaw}`);
        } else {
            setRaw(quasi, raw + escaped + nextRaw);
        }
    }
}

/** esbuild's `module.exports = { ... }` hint for `cjs-module-lexer`. */
export function isCjsModuleExportsHint(expr: Node): boolean {
    const assign = getInnerExpression(expr);
    if (assign.type !== N.AssignmentExpression || assign.data.operator !== '=') return false;
    const target = assign.data.left;
    if (!isMemberExpression(target)) return false;
    const object = getInnerExpression((target.data as { object: Node }).object);
    return object.type === N.IdentifierReference && object.name === 'module' && staticPropertyName(target) === 'exports';
}

/** Move a sequence out of an operand so its last expression can fold into the operator. oxc defines
 *  this in substitute_alternate_syntax.rs.
 *
 *  - `(a, b) + c` -> `a, b + c`
 *  - `(a, b) || c` -> `a, b || c`
 *  - `-(a, b)` -> `a, -b`
 *  - `await (a, b)` -> `a, await b`
 *  - `yield (a, b)` -> `a, yield b` */
export function foldSequenceExpression(ctx: DceCtx, expr: Node): void {
    let field: 'left' | 'argument';
    switch (expr.type) {
        case N.BinaryExpression:
        case N.LogicalExpression:
            field = 'left';
            break;
        case N.UnaryExpression: {
            const operator = expr.data.operator as string;
            if (operator === 'typeof' || operator === 'void' || operator === 'delete' || operator === '!') return;
            field = 'argument';
            break;
        }
        case N.AwaitExpression:
            field = 'argument';
            break;
        case N.YieldExpression:
            if (expr.data.argument === null) return;
            field = 'argument';
            break;
        default:
            return;
    }
    const operands = expr.data as Record<'left' | 'argument', Node>;
    const sequence = operands[field];
    if (sequence.type !== N.SequenceExpression) return;
    const expressions = sequence.data.expressions as Node[];
    if (expressions.length <= 1) return;
    operands[field] = expressions.pop() as Node;
    expressions.push(takeNode(ctx, expr));
    replaceExpression(ctx, expr, sequence);
}

// --- optional chains -----------------------------------------------------------------------------

/** Outcome of folding an optional chain at its deepest optional position. `hasOptional` is whether
 *  an unresolved `?.` exists in the chain segment seen so far. */
type ChainFold =
    | { kind: 'unfolded'; hasOptional: boolean }
    | { kind: 'flipped'; hasOptional: boolean }
    | { kind: 'collapse'; base: Node; baseHasSideEffects: boolean };

/** Fold the deepest (leftmost) optional in a chain. Nested chains are not descended into. */
function tryFoldChainAtElement(ctx: DceCtx, element: Node): ChainFold {
    switch (element.type) {
        case N.CallExpression:
            return tryFoldCallExpression(ctx, element);
        case N.StaticMemberExpression:
        case N.ComputedMemberExpression:
        case N.PrivateFieldExpression:
            return tryFoldMemberExpression(ctx, element);
        case N.TSNonNullExpression:
            return tryFoldChainAtExpr(ctx, element.data.expression);
        default:
            return { kind: 'unfolded', hasOptional: false };
    }
}

function tryFoldChainAtExpr(ctx: DceCtx, expr: Node): ChainFold {
    const inner = getInnerExpression(expr);
    switch (inner.type) {
        case N.CallExpression:
            return tryFoldCallExpression(ctx, inner);
        case N.StaticMemberExpression:
        case N.ComputedMemberExpression:
        case N.PrivateFieldExpression:
            return tryFoldMemberExpression(ctx, inner);
        default:
            return { kind: 'unfolded', hasOptional: false };
    }
}

function tryFoldCallExpression(ctx: DceCtx, call: Node): ChainFold {
    const data = call.data as DataOf<'CallExpression'>;
    const fold = tryFoldChainAtExpr(ctx, data.callee);
    switch (fold.kind) {
        case 'flipped':
            return { kind: 'flipped', hasOptional: fold.hasOptional || data.optional };
        case 'collapse':
            return fold;
        case 'unfolded':
            return (
                tryFoldAtOptional(ctx, call, data.callee, fold.hasOptional) ?? {
                    kind: 'unfolded',
                    hasOptional: fold.hasOptional || data.optional,
                }
            );
    }
}

function tryFoldMemberExpression(ctx: DceCtx, member: Node): ChainFold {
    const data = member.data as { object: Node; optional: boolean };
    const optional = data.optional;
    const fold = tryFoldChainAtExpr(ctx, data.object);
    switch (fold.kind) {
        case 'flipped':
            return { kind: 'flipped', hasOptional: fold.hasOptional || optional };
        case 'collapse':
            return fold;
        case 'unfolded':
            return (
                tryFoldAtOptional(ctx, member, data.object, fold.hasOptional) ?? {
                    kind: 'unfolded',
                    hasOptional: fold.hasOptional || optional,
                }
            );
    }
}

/** `owner` is the call or member whose `optional` flag guards `base`. */
function tryFoldAtOptional(ctx: DceCtx, owner: Node, base: Node, hasOptional: boolean): ChainFold | null {
    const ownerData = owner.data as { optional: boolean };
    if (!ownerData.optional || hasOptional) return null;
    switch (valueType(base, ctx)) {
        case 'null':
        case 'undefined':
            return { kind: 'collapse', base, baseHasSideEffects: mayHaveSideEffects(base, ctx) };
        case 'undetermined':
            return null;
        default:
            // A flag flip on an existing node, not a slot replacement.
            ownerData.optional = false;
            return { kind: 'flipped', hasOptional: false };
    }
}
