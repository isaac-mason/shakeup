// Port of oxc's constant evaluator (`oxc_ecmascript`: `constant_evaluation/`, `value_type.rs`,
// `to_*.rs`, `string_*.rs`, `is_less_than.rs`), driven the way rolldown's `ConstEvalCtx` drives it.
// Where oxc relies on Rust semantics that differ from JS (UTF-8 byte lengths, `char` iteration,
// `str::trim`, `f64::powf`, `str::parse::<f64>`, num-bigint parsing), the Rust behaviour is kept.

import { type DataOf, N, type Node, num } from '../ast/index.ts';
import type { ConstantValue } from './constant-value.ts';
import { mayHaveSideEffects, type SideEffectsContext } from './side-effects.ts';

export type ConstEvalContext = {
    /** The constant an identifier reference resolves to, or null. Unresolved (global) references never reach this. */
    constantOf: (ident: Node) => ConstantValue | null;
};

export type ValueType = 'undefined' | 'null' | 'number' | 'bigint' | 'string' | 'boolean' | 'object' | 'undetermined';

export type ToPrimitiveResult = 'undefined' | 'null' | 'number' | 'bigint' | 'string' | 'boolean' | 'symbol' | 'undetermined';

type ToNumericResult = 'number' | 'bigint' | 'undetermined';

// --- ConstantValue helpers (value.rs) ------------------------------------------------------------

const numberValue = (value: number): ConstantValue => ({ kind: 'number', value });
const bigIntValue = (value: bigint): ConstantValue => ({ kind: 'bigint', value });
const stringValue = (value: string): ConstantValue => ({ kind: 'string', value });
const booleanValue = (value: boolean): ConstantValue => ({ kind: 'boolean', value });
const UNDEFINED_VALUE: ConstantValue = { kind: 'undefined' };
const NULL_VALUE: ConstantValue = { kind: 'null' };

function constantToJsString(value: ConstantValue): string {
    switch (value.kind) {
        case 'number':
            return String(value.value);
        case 'bigint':
            return String(value.value);
        case 'string':
            return value.value;
        case 'boolean':
            return value.value ? 'true' : 'false';
        case 'undefined':
            return 'undefined';
        case 'null':
            return 'null';
    }
}

function constantToNumber(value: ConstantValue): number | null {
    switch (value.kind) {
        case 'number':
            return value.value;
        case 'bigint':
            return null;
        case 'string':
            return stringToNumber(value.value);
        case 'boolean':
            return value.value ? 1 : 0;
        case 'null':
            return 0;
        case 'undefined':
            return Number.NaN;
    }
}

function constantToBoolean(value: ConstantValue): boolean {
    switch (value.kind) {
        case 'number':
            return !Number.isNaN(value.value) && value.value !== 0;
        case 'bigint':
            return value.value !== 0n;
        case 'string':
            return value.value !== '';
        case 'boolean':
            return value.value;
        case 'null':
        case 'undefined':
            return false;
    }
}

// --- GlobalContext (global_context.rs, rolldown const_eval.rs) -----------------------------------

/** oxc `GlobalContext`. The reference lookups take the identifier reference itself. */
export type GlobalContext = {
    isGlobalReference: (ident: Node) => boolean;
    /** oxc `get_constant_value_for_reference_id`. */
    constantValueForReference: (ident: Node) => ConstantValue | null;
    /** oxc `value_type_for_reference_id`, consulted for references that are not global. */
    valueTypeForReference: (ident: Node) => ValueType | null;
};

/** oxc `ConstantEvaluationCtx`. */
export type ConstantEvaluationContext = SideEffectsContext;

/** A reference shakeup's semantic analysis left unresolved, which is how oxc's scoping sees a global. */
export const isUnresolvedReference = (ident: Node): boolean => ident.type === N.IdentifierReference && ident.sym === 0;

const noValueTypeForReference = (): ValueType | null => null;

const everyCalleePure = (): boolean => true;

/** rolldown's `ConstEvalCtx`: no annotations, every call treated as manually pure, property reads and
 *  unknown globals side-effectful, and constants only for references that resolve to a symbol. */
function rolldownConstEvalContext(ctx: ConstEvalContext): ConstantEvaluationContext {
    return {
        isGlobalReference: isUnresolvedReference,
        constantValueForReference: (ident) => (ident.sym === 0 ? null : ctx.constantOf(ident)),
        valueTypeForReference: noValueTypeForReference,
        engineTargets: null,
        annotations: false,
        manualPureFunctions: everyCalleePure,
        propertyReadSideEffects: 'all',
        propertyWriteSideEffects: true,
        unknownGlobalSideEffects: true,
    };
}

/** oxc `Expression::get_inner_expression`. */
export function getInnerExpression(expr: Node): Node {
    let inner = expr;
    for (;;) {
        switch (inner.type) {
            case N.TSAsExpression:
            case N.TSSatisfiesExpression:
            case N.TSInstantiationExpression:
            case N.TSNonNullExpression:
                inner = inner.data.expression;
                break;
            default:
                return inner;
        }
    }
}

function isGlobalExpr(name: string, expr: Node, ctx: GlobalContext): boolean {
    const inner = getInnerExpression(expr);
    return inner.type === N.IdentifierReference && inner.name === name && ctx.isGlobalReference(inner);
}

// --- Literal values ------------------------------------------------------------------------------

export function numericLiteralValue(literal: Node): number {
    const text = literal.name.includes('_') ? literal.name.replaceAll('_', '') : literal.name;
    if (/^0[0-7]+$/.test(text)) return Number.parseInt(text, 8);
    return Number(text);
}

export const bigIntLiteralValue = (literal: Node): bigint => BigInt(literal.name.slice(0, -1).replaceAll('_', ''));

export type CookedString = { value: string; loneSurrogates: boolean };

/** A string literal's value, its raw text with the quotes removed and escapes decoded. */
export const stringLiteralText = (literal: Node): string => cookEscapes(literal.name.slice(1, -1), false) ?? '';

export function stringLiteralValue(literal: Node): CookedString {
    const value = stringLiteralText(literal);
    return { value, loneSurrogates: hasLoneSurrogate(value) };
}

/** A template chunk's cooked value, or null where oxc's `cooked` is `None` (an invalid escape). */
export function templateElementCooked(element: Node): CookedString | null {
    const value = cookEscapes(element.name, true);
    if (value === null) return null;
    return { value, loneSurrogates: hasLoneSurrogate(value) };
}

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

const isOctalDigit = (char: string | undefined): boolean => char !== undefined && char >= '0' && char <= '7';
const isDecimalDigit = (char: string | undefined): boolean => char !== undefined && char >= '0' && char <= '9';

/** Decode the escapes of a string literal body or a template chunk (raw source text). Returns null
 *  for an escape a template cannot cook. */
function cookEscapes(text: string, isTemplate: boolean): string | null {
    if (!text.includes('\\') && !(isTemplate && text.includes('\r'))) return text;
    let out = '';
    let index = 0;
    while (index < text.length) {
        const char = text[index];
        if (char === '\r' && isTemplate) {
            out += '\n';
            index += text[index + 1] === '\n' ? 2 : 1;
            continue;
        }
        if (char !== '\\') {
            out += char;
            index++;
            continue;
        }
        index++;
        const escapedChar = text[index];
        index++;
        if (escapedChar === LINE_SEPARATOR || escapedChar === PARAGRAPH_SEPARATOR) continue;
        switch (escapedChar) {
            case 'n':
                out += '\n';
                break;
            case 't':
                out += '\t';
                break;
            case 'r':
                out += '\r';
                break;
            case 'b':
                out += '\b';
                break;
            case 'f':
                out += '\f';
                break;
            case 'v':
                out += '\v';
                break;
            case '\r':
                if (text[index] === '\n') index++;
                break;
            case '\n':
                break;
            case 'x': {
                const hex = text.slice(index, index + 2);
                if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
                out += String.fromCharCode(Number.parseInt(hex, 16));
                index += 2;
                break;
            }
            case 'u': {
                if (text[index] === '{') {
                    const close = text.indexOf('}', index);
                    if (close < 0) return null;
                    const hex = text.slice(index + 1, close);
                    if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
                    const codePoint = Number.parseInt(hex, 16);
                    if (codePoint > 0x10ffff) return null;
                    out += String.fromCodePoint(codePoint);
                    index = close + 1;
                } else {
                    const hex = text.slice(index, index + 4);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
                    out += String.fromCharCode(Number.parseInt(hex, 16));
                    index += 4;
                }
                break;
            }
            default: {
                if (escapedChar === '0' && !isDecimalDigit(text[index])) {
                    out += '\0';
                } else if (isOctalDigit(escapedChar)) {
                    if (isTemplate) return null;
                    let value = escapedChar.charCodeAt(0) - 48;
                    const maxDigits = escapedChar <= '3' ? 3 : 2;
                    for (let digits = 1; digits < maxDigits && isOctalDigit(text[index]); digits++) {
                        value = value * 8 + (text.charCodeAt(index) - 48);
                        index++;
                    }
                    out += String.fromCharCode(value);
                } else if (escapedChar === '8' || escapedChar === '9') {
                    if (isTemplate) return null;
                    out += escapedChar;
                } else {
                    const codePoint = text.codePointAt(index - 1) ?? 0;
                    out += String.fromCodePoint(codePoint);
                    if (codePoint > 0xffff) index++;
                }
            }
        }
    }
    return out;
}

function hasLoneSurrogate(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const unit = value.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                index++;
                continue;
            }
            return true;
        }
        if (unit >= 0xdc00 && unit <= 0xdfff) return true;
    }
    return false;
}

/** A string literal's value for the known-method folds, which read oxc's `lit.value` directly.
 *  oxc re-encodes lone surrogates into that value, so those literals are not folded here. */
export function plainStringLiteralValue(expr: Node): string | null {
    if (expr.type !== N.StringLiteral) return null;
    const literal = stringLiteralValue(expr);
    return literal.loneSurrogates ? null : literal.value;
}

// --- Rust number and string semantics ------------------------------------------------------------

const toInt32 = (value: number): number => value | 0;
const toUint32 = (value: number): number => value >>> 0;

/** Rust `f64::fract`. */
const fract = (value: number): number => value - Math.trunc(value);

/** Rust `f64::powf` (C `pow`), which differs from `**` for a base of 1 and for -1 to an infinite power. */
function rustPowf(base: number, exponent: number): number {
    if (exponent === 0 || base === 1) return 1;
    if (base === -1 && (exponent === Number.POSITIVE_INFINITY || exponent === Number.NEGATIVE_INFINITY)) return 1;
    return base ** exponent;
}

/** Rust `f64::round`: half away from zero. */
function rustRound(value: number): number {
    const truncated = Math.trunc(value);
    return Math.abs(value - truncated) >= 0.5 ? truncated + Math.sign(value) : truncated;
}

/** Rust `char::is_whitespace` (Unicode White_Space). */
function isRustWhitespace(char: string): boolean {
    const code = char.charCodeAt(0);
    return (
        (code >= 0x09 && code <= 0x0d) ||
        code === 0x20 ||
        code === 0x85 ||
        code === 0xa0 ||
        code === 0x1680 ||
        (code >= 0x2000 && code <= 0x200a) ||
        code === 0x2028 ||
        code === 0x2029 ||
        code === 0x202f ||
        code === 0x205f ||
        code === 0x3000
    );
}

function rustTrimStart(value: string): string {
    let start = 0;
    while (start < value.length && isRustWhitespace(value[start])) start++;
    return value.slice(start);
}

function rustTrimEnd(value: string): string {
    let end = value.length;
    while (end > 0 && isRustWhitespace(value[end - 1])) end--;
    return value.slice(0, end);
}

const rustTrim = (value: string): string => rustTrimEnd(rustTrimStart(value));

/** oxc `is_str_white_space_char`: ECMAScript StrWhiteSpaceChar. */
function isStrWhiteSpaceChar(char: string): boolean {
    const code = char.charCodeAt(0);
    return code === 0xfeff || (code !== 0x85 && isRustWhitespace(char));
}

const UTF8 = new TextEncoder();
export const utf8Length = (value: string): number => UTF8.encode(value).length;

/** Rust `char::to_digit(radix)` for one UTF-16 unit. */
function digitValue(char: string, radix: number): number | null {
    const code = char.charCodeAt(0);
    let digit: number;
    if (code >= 48 && code <= 57) digit = code - 48;
    else if (code >= 97 && code <= 122) digit = code - 87;
    else if (code >= 65 && code <= 90) digit = code - 55;
    else return null;
    return digit < radix ? digit : null;
}

/** Rust `u32::from_str_radix`. */
function u32FromStrRadix(text: string, radix: number): number | null {
    const digits = text.startsWith('+') ? text.slice(1) : text;
    if (digits === '') return null;
    let value = 0;
    for (const char of digits) {
        const digit = digitValue(char, radix);
        if (digit === null) return null;
        value = value * radix + digit;
        if (value > 0xffffffff) return null;
    }
    return value;
}

/** Rust `i32::from_str_radix`. */
function i32FromStrRadix(text: string, radix: number): number | null {
    let sign = 1;
    let digits = text;
    if (text.startsWith('+') || text.startsWith('-')) {
        sign = text.startsWith('-') ? -1 : 1;
        digits = text.slice(1);
    }
    if (digits === '') return null;
    let value = 0;
    for (const char of digits) {
        const digit = digitValue(char, radix);
        if (digit === null) return null;
        value = value * radix + digit;
        if (value > 0x80000000) return null;
    }
    const signed = sign * value;
    return signed > 0x7fffffff ? null : signed;
}

/** num-bigint `BigInt::from_str_radix`: one leading sign, `_` skipped between digits. */
function bigIntFromStrRadix(text: string, radix: number): bigint | null {
    let digits = text;
    let negative = false;
    if (digits.startsWith('-')) {
        negative = true;
        if (!digits.slice(1).startsWith('+')) digits = digits.slice(1);
    }
    if (digits.startsWith('+') && !digits.slice(1).startsWith('+')) digits = digits.slice(1);
    if (digits === '' || digits.startsWith('_')) return null;
    let value = 0n;
    const bigRadix = BigInt(radix);
    for (const char of digits) {
        if (char === '_') continue;
        const digit = digitValue(char, radix);
        if (digit === null) return null;
        value = value * bigRadix + BigInt(digit);
    }
    return negative ? -value : value;
}

/** Rust `str::parse::<f64>` for everything but inf/nan spellings, which the caller already handled. */
const RUST_F64_DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** oxc `StringToNumber` (string_to_number.rs). Only leading whitespace is trimmed. */
function stringToNumber(input: string): number {
    let start = 0;
    while (start < input.length && isStrWhiteSpaceChar(input[start])) start++;
    const text = input.slice(start);
    switch (text) {
        case '':
            return 0;
        case '-Infinity':
            return Number.NEGATIVE_INFINITY;
        case 'Infinity':
        case '+Infinity':
            return Number.POSITIVE_INFINITY;
    }
    if (/^[-+]*inf/i.test(text)) return Number.NaN;

    if (text.length > 2 && text[0] === '0') {
        const prefix = text[1];
        const radix =
            prefix === 'x' || prefix === 'X'
                ? 16
                : prefix === 'o' || prefix === 'O'
                  ? 8
                  : prefix === 'b' || prefix === 'B'
                    ? 2
                    : 0;
        if (radix !== 0) {
            const digits = text.slice(2);
            const fast = u32FromStrRadix(digits, radix);
            if (fast !== null) return fast;
            let value = 0;
            for (const char of digits) {
                const digit = digitValue(char, radix);
                if (digit === null) return Number.NaN;
                value = value * radix + digit;
            }
            return value;
        }
    }

    return RUST_F64_DECIMAL.test(text) ? Number(text) : Number.NaN;
}

/** oxc `StringToBigInt` (string_to_big_int.rs). */
function stringToBigInt(input: string): bigint | null {
    if (input.includes('\u000b')) return null;
    const text = rustTrim(input);
    if (text === '') return 0n;
    if (text.length > 2 && text[0] === '0') {
        const prefix = text[1];
        const radix =
            prefix === 'x' || prefix === 'X'
                ? 16
                : prefix === 'o' || prefix === 'O'
                  ? 8
                  : prefix === 'b' || prefix === 'B'
                    ? 2
                    : 0;
        if (radix === 0) return null;
        return bigIntFromStrRadix(text.slice(2), radix);
    }
    return bigIntFromStrRadix(text, 10);
}

// --- ValueType (value_type.rs) -------------------------------------------------------------------

export function valueType(expr: Node, ctx: GlobalContext): ValueType {
    switch (expr.type) {
        case N.BigIntLiteral:
            return 'bigint';
        case N.BooleanLiteral:
            return 'boolean';
        case N.NullLiteral:
            return 'null';
        case N.NumericLiteral:
            return 'number';
        case N.StringLiteral:
        case N.TemplateLiteral:
            return 'string';
        case N.ObjectExpression:
        case N.ArrayExpression:
        case N.RegExpLiteral:
        case N.FunctionExpression:
        case N.ArrowFunctionExpression:
        case N.ClassExpression:
        case N.ImportMeta:
            return 'object';
        case N.IdentifierReference:
            if (ctx.isGlobalReference(expr)) {
                switch (expr.name) {
                    case 'undefined':
                        return 'undefined';
                    case 'NaN':
                    case 'Infinity':
                        return 'number';
                    default:
                        return 'undetermined';
                }
            }
            return ctx.valueTypeForReference(expr) ?? 'undetermined';
        case N.UnaryExpression:
            return unaryValueType(expr.data.operator, expr.data.argument, ctx);
        case N.BinaryExpression:
            return binaryValueType(expr.data.operator, expr.data.left, expr.data.right, ctx);
        case N.SequenceExpression: {
            const last = expr.data.expressions.at(-1);
            return last === undefined ? 'undetermined' : valueType(last, ctx);
        }
        case N.AssignmentExpression:
            return assignmentValueType(expr.data.operator, expr.data.right, ctx);
        case N.ConditionalExpression: {
            const left = valueType(expr.data.consequent, ctx);
            if (left === 'undetermined') return 'undetermined';
            return valueType(expr.data.alternate, ctx) === left ? left : 'undetermined';
        }
        case N.LogicalExpression: {
            const left = valueType(expr.data.left, ctx);
            if (expr.data.operator === '??') {
                if (left === 'undefined' || left === 'null') return valueType(expr.data.right, ctx);
                return left;
            }
            if (left === 'undetermined') return 'undetermined';
            return valueType(expr.data.right, ctx) === left ? left : 'undetermined';
        }
        case N.StaticMemberExpression: {
            const property = expr.data.property.name;
            if (
                (property === 'POSITIVE_INFINITY' || property === 'NEGATIVE_INFINITY') &&
                isGlobalExpr('Number', expr.data.object, ctx)
            ) {
                return 'number';
            }
            return 'undetermined';
        }
        case N.NewExpression:
            return isGlobalExpr('Date', expr.data.callee, ctx) ? 'object' : 'undetermined';
        default:
            return 'undetermined';
    }
}

function binaryValueType(operator: string, left: Node, right: Node, ctx: GlobalContext): ValueType {
    switch (operator) {
        case '+': {
            const leftPrimitive = toPrimitive(left, ctx);
            const rightPrimitive = toPrimitive(right, ctx);
            if (leftPrimitive === 'string' || rightPrimitive === 'string') return 'string';
            const leftNumeric = primitiveToNumeric(leftPrimitive);
            const rightNumeric = primitiveToNumeric(rightPrimitive);
            if (leftNumeric === 'number' && rightNumeric === 'number') return 'number';
            if (leftNumeric === 'bigint' && rightNumeric === 'bigint') return 'bigint';
            return 'undetermined';
        }
        case '-':
        case '*':
        case '/':
        case '%':
        case '<<':
        case '|':
        case '>>':
        case '^':
        case '&':
        case '**': {
            const leftNumeric = toNumeric(left, ctx);
            const rightNumeric = toNumeric(right, ctx);
            if (leftNumeric === 'number' || rightNumeric === 'number') return 'number';
            if (leftNumeric === 'bigint' || rightNumeric === 'bigint') return 'bigint';
            return 'undetermined';
        }
        case '>>>':
            return 'number';
        default:
            return 'boolean';
    }
}

function unaryValueType(operator: string, argument: Node, ctx: GlobalContext): ValueType {
    switch (operator) {
        case 'void':
            return 'undefined';
        case '-':
        case '~': {
            const argumentType = valueType(argument, ctx);
            if (argumentType === 'bigint') return 'bigint';
            if (argumentType === 'undetermined' || argumentType === 'object') return 'undetermined';
            return 'number';
        }
        case '+':
            return 'number';
        case '!':
        case 'delete':
            return 'boolean';
        default:
            return 'string';
    }
}

function assignmentValueType(operator: string, right: Node, ctx: GlobalContext): ValueType {
    switch (operator) {
        case '=':
            return valueType(right, ctx);
        case '+=':
            return valueType(right, ctx) === 'string' ? 'string' : 'undetermined';
        case '>>>=':
            return 'number';
        case '&&=':
        case '||=':
        case '??=':
            return 'undetermined';
        default: {
            const rightType = valueType(right, ctx);
            if (rightType === 'bigint') return 'bigint';
            if (rightType !== 'object' && rightType !== 'undetermined') return 'number';
            return 'undetermined';
        }
    }
}

// --- ToPrimitive / ToNumeric (to_primitive.rs, to_numeric.rs) -------------------------------------

export function toPrimitive(expr: Node, ctx: GlobalContext): ToPrimitiveResult {
    const type = valueType(expr, ctx);
    if (type !== 'object' && type !== 'undetermined') return type;
    switch (expr.type) {
        case N.RegExpLiteral:
        case N.ArrayExpression:
            return 'string';
        case N.ObjectExpression:
            return maybeObjectWithToPrimitiveRelatedPropertiesOverridden(expr) ? 'undetermined' : 'string';
        default:
            return 'undetermined';
    }
}

function maybeObjectWithToPrimitiveRelatedPropertiesOverridden(object: Node): boolean {
    if (object.type !== N.ObjectExpression) return true;
    for (const property of object.data.properties) {
        if (property.type === N.SpreadElement) {
            const argument = property.data.argument;
            switch (argument.type) {
                case N.ObjectExpression:
                    if (maybeObjectWithToPrimitiveRelatedPropertiesOverridden(argument)) return true;
                    continue;
                case N.ArrayExpression:
                case N.StringLiteral:
                case N.TemplateLiteral:
                    continue;
                default:
                    return true;
            }
        }
        if (property.type !== N.ObjectProperty) return true;
        const key = property.data.key;
        let keyName: string | null;
        if (key.type === N.IdentifierName && !property.data.computed) keyName = key.name;
        else if (key.type === N.PrivateIdentifier) continue;
        else if (key.type === N.StringLiteral) keyName = stringLiteralValue(key).value;
        else if (key.type === N.TemplateLiteral) {
            keyName = key.data.quasis.length === 1 ? (templateElementCooked(key.data.quasis[0])?.value ?? null) : null;
            if (keyName === null) continue;
        } else return true;
        if (keyName === 'toString' || keyName === 'valueOf') return true;
    }
    return false;
}

export function primitiveToNumeric(primitive: ToPrimitiveResult): ToNumericResult {
    switch (primitive) {
        case 'symbol':
        case 'undetermined':
            return 'undetermined';
        case 'bigint':
            return 'bigint';
        default:
            return 'number';
    }
}

const toNumeric = (expr: Node, ctx: GlobalContext): ToNumericResult => primitiveToNumeric(toPrimitive(expr, ctx));

// --- ToBoolean / ToNumber / ToJsString / ToBigInt on expressions ---------------------------------

function toBoolean(expr: Node, ctx: GlobalContext): boolean | null {
    switch (expr.type) {
        case N.IdentifierReference:
            if (!ctx.isGlobalReference(expr)) return null;
            if (expr.name === 'NaN' || expr.name === 'undefined') return false;
            if (expr.name === 'Infinity') return true;
            return null;
        case N.RegExpLiteral:
        case N.ArrayExpression:
        case N.ArrowFunctionExpression:
        case N.ClassExpression:
        case N.FunctionExpression:
        case N.NewExpression:
        case N.ObjectExpression:
            return true;
        case N.NullLiteral:
            return false;
        case N.BooleanLiteral:
            return expr.name === 'true';
        case N.NumericLiteral: {
            const value = numericLiteralValue(expr);
            return Number.isNaN(value) ? false : value !== 0;
        }
        case N.BigIntLiteral:
            return bigIntLiteralValue(expr) !== 0n;
        case N.StringLiteral:
            return stringLiteralValue(expr).value !== '';
        case N.TemplateLiteral: {
            if (expr.data.quasis.length !== 1) return null;
            const cooked = templateElementCooked(expr.data.quasis[0]);
            return cooked === null ? null : cooked.value !== '';
        }
        case N.SequenceExpression: {
            const last = expr.data.expressions.at(-1);
            return last === undefined ? null : toBoolean(last, ctx);
        }
        default:
            return null;
    }
}

/** oxc `ToNumber::to_number`. */
export function toNumber(expr: Node, ctx: GlobalContext): number | null {
    switch (expr.type) {
        case N.NumericLiteral:
            return numericLiteralValue(expr);
        case N.BooleanLiteral:
            return expr.name === 'true' ? 1 : 0;
        case N.NullLiteral:
            return 0;
        case N.IdentifierReference:
            if (!ctx.isGlobalReference(expr)) return null;
            if (expr.name === 'Infinity') return Number.POSITIVE_INFINITY;
            if (expr.name === 'NaN' || expr.name === 'undefined') return Number.NaN;
            return null;
        case N.StringLiteral:
            return stringToNumber(stringLiteralValue(expr).value);
        case N.UnaryExpression: {
            if (expr.data.operator !== '!') return null;
            const argument = toNumber(expr.data.argument, ctx);
            if (argument === null) return null;
            return argument === 0 ? 1 : 0;
        }
        case N.ObjectExpression:
            return maybeObjectWithToPrimitiveRelatedPropertiesOverridden(expr) ? null : Number.NaN;
        case N.RegExpLiteral:
            return Number.NaN;
        case N.ArrayExpression: {
            let nonSpreadElements = 0;
            for (const element of expr.data.elements) {
                if (element !== null && element.type === N.SpreadElement) continue;
                if (++nonSpreadElements >= 2) return Number.NaN;
            }
            const arrayString = toJsString(expr, ctx);
            return arrayString === null ? null : stringToNumber(arrayString);
        }
        default:
            return null;
    }
}

/** oxc `ToJsString::to_js_string`. */
export function toJsString(expr: Node, ctx: GlobalContext): string | null {
    switch (expr.type) {
        case N.StringLiteral: {
            const literal = stringLiteralValue(expr);
            return literal.loneSurrogates ? null : literal.value;
        }
        case N.TemplateLiteral: {
            let out = '';
            const { quasis, expressions } = expr.data;
            for (let index = 0; index < quasis.length; index++) {
                const cooked = templateElementCooked(quasis[index]);
                if (cooked === null || cooked.loneSurrogates) return null;
                out += cooked.value;
                if (index < expressions.length) {
                    const value = toJsString(expressions[index], ctx);
                    if (value === null) return null;
                    out += value;
                }
            }
            return out;
        }
        case N.IdentifierReference:
            if ((expr.name === 'undefined' || expr.name === 'Infinity' || expr.name === 'NaN') && ctx.isGlobalReference(expr)) {
                return expr.name;
            }
            return null;
        case N.NumericLiteral:
            return String(numericLiteralValue(expr));
        case N.BigIntLiteral:
            return String(bigIntLiteralValue(expr));
        case N.NullLiteral:
            return 'null';
        case N.BooleanLiteral:
            return expr.name === 'true' ? 'true' : 'false';
        case N.UnaryExpression:
            if (expr.data.operator === 'void') return 'undefined';
            if (expr.data.operator === '!') {
                const argument = toBoolean(expr.data.argument, ctx);
                return argument === null ? null : argument ? 'false' : 'true';
            }
            return null;
        case N.ArrayExpression:
            return arrayJoin(expr, ',', ctx);
        case N.ObjectExpression:
            return maybeObjectWithToPrimitiveRelatedPropertiesOverridden(expr) ? null : '[object Object]';
        case N.RegExpLiteral:
            return expr.name;
        default:
            return null;
    }
}

/** oxc `ArrayJoin::array_join` (array_join.rs). */
function arrayJoin(array: Node, separator: string, ctx: GlobalContext): string | null {
    if (array.type !== N.ArrayExpression) return null;
    const strings: string[] = [];
    for (const element of array.data.elements) {
        if (element === null) {
            strings.push('');
            continue;
        }
        if (element.type === N.SpreadElement) return null;
        const type = valueType(element, ctx);
        if (type === 'undefined' || type === 'null') {
            strings.push('');
            continue;
        }
        if (type === 'undetermined') return null;
        const value = toJsString(element, ctx);
        if (value === null) return null;
        strings.push(value);
    }
    return strings.join(separator);
}

export function toBigInt(expr: Node, ctx: GlobalContext): bigint | null {
    switch (expr.type) {
        case N.NumericLiteral: {
            const value = numericLiteralValue(expr);
            return Math.abs(value) < 2 ** 53 && fract(value) === 0 ? BigInt(value) : null;
        }
        case N.BigIntLiteral:
            return bigIntLiteralValue(expr);
        case N.BooleanLiteral:
            return expr.name === 'true' ? 1n : 0n;
        case N.UnaryExpression:
            switch (expr.data.operator) {
                case '!': {
                    // oxc converts the unary expression itself, which ToBoolean never resolves.
                    const boolean = toBoolean(expr, ctx);
                    return boolean === null ? null : boolean ? 1n : 0n;
                }
                case '-': {
                    const argument = toBigInt(expr.data.argument, ctx);
                    return argument === null ? null : -argument;
                }
                case '~': {
                    const argument = toBigInt(expr.data.argument, ctx);
                    return argument === null ? null : ~argument;
                }
                case '+':
                    return toBigInt(expr.data.argument, ctx);
                default:
                    return null;
            }
        case N.StringLiteral:
            return stringToBigInt(stringLiteralValue(expr).value);
        case N.TemplateLiteral: {
            const value = toJsString(expr, ctx);
            return value === null ? null : stringToBigInt(value);
        }
        default:
            return null;
    }
}

// --- ConstantEvaluation (constant_evaluation/mod.rs) ---------------------------------------------

/** rolldown's `try_extract_const_literal`: oxc's `evaluate_value` under rolldown's `ConstEvalCtx`. */
export function evaluateValue(expr: Node, ctx: ConstEvalContext): ConstantValue | null {
    return evaluateValueTo(expr, rolldownConstEvalContext(ctx), null);
}

/** oxc `ConstantEvaluation::evaluate_value` under any context. */
export function evaluateValueInContext(expr: Node, ctx: ConstantEvaluationContext): ConstantValue | null {
    return evaluateValueTo(expr, ctx, null);
}

export function evaluateValueToNumber(expr: Node, ctx: ConstantEvaluationContext): number | null {
    const value = evaluateValueTo(expr, ctx, 'number');
    return value === null ? null : constantToNumber(value);
}

export function evaluateValueToBigInt(expr: Node, ctx: ConstantEvaluationContext): bigint | null {
    const value = evaluateValueTo(expr, ctx, 'bigint');
    return value !== null && value.kind === 'bigint' ? value.value : null;
}

export function evaluateValueToBoolean(expr: Node, ctx: ConstantEvaluationContext): boolean | null {
    const value = evaluateValueTo(expr, ctx, 'boolean');
    return value === null ? null : constantToBoolean(value);
}

export function evaluateValueToString(expr: Node, ctx: ConstantEvaluationContext): string | null {
    const value = evaluateValueTo(expr, ctx, 'string');
    return value === null ? null : constantToJsString(value);
}

export function getSideFreeNumberValue(expr: Node, ctx: ConstantEvaluationContext): number | null {
    const value = evaluateValueToNumber(expr, ctx);
    return value !== null && !mayHaveSideEffects(expr, ctx) ? value : null;
}

function getSideFreeBigIntValue(expr: Node, ctx: ConstantEvaluationContext): bigint | null {
    const value = evaluateValueToBigInt(expr, ctx);
    return value !== null && !mayHaveSideEffects(expr, ctx) ? value : null;
}

export function getSideFreeStringValue(expr: Node, ctx: ConstantEvaluationContext): string | null {
    const value = evaluateValueToString(expr, ctx);
    return value !== null && !mayHaveSideEffects(expr, ctx) ? value : null;
}

export function getSideFreeBooleanValue(expr: Node, ctx: ConstantEvaluationContext): boolean | null {
    const value = evaluateValueToBoolean(expr, ctx);
    return value !== null && !mayHaveSideEffects(expr, ctx) ? value : null;
}

// --- IsInt32OrUint32 (constant_evaluation/is_int32_or_uint32.rs) ---------------------------------

/** Whether the expression's value is an int32 or uint32, so never NaN or Infinity. False when unknown. */
export function isInt32OrUint32(expr: Node, ctx: GlobalContext): boolean {
    switch (expr.type) {
        case N.NumericLiteral: {
            const value = numericLiteralValue(expr);
            return Number.isInteger(value) && value >= -2147483648 && value <= 4294967295;
        }
        case N.UnaryExpression:
            switch (expr.data.operator) {
                case '~':
                    return valueType(expr, ctx) === 'number';
                case '+':
                    return isInt32OrUint32(expr.data.argument, ctx);
                default:
                    return false;
            }
        case N.BinaryExpression:
            switch (expr.data.operator) {
                case '<<':
                case '>>':
                case '&':
                case '|':
                case '^':
                    return valueType(expr, ctx) === 'number';
                case '>>>':
                    return true;
                default:
                    return false;
            }
        case N.LogicalExpression:
            if (expr.data.operator === '??') return isInt32OrUint32(expr.data.left, ctx);
            return isInt32OrUint32(expr.data.left, ctx) && isInt32OrUint32(expr.data.right, ctx);
        case N.ConditionalExpression:
            return isInt32OrUint32(expr.data.consequent, ctx) && isInt32OrUint32(expr.data.alternate, ctx);
        case N.SequenceExpression: {
            const expressions = expr.data.expressions as Node[];
            return expressions.length > 0 && isInt32OrUint32(expressions[expressions.length - 1], ctx);
        }
        default:
            return false;
    }
}

// --- IsLiteralValue (constant_evaluation/is_literal_value.rs) ------------------------------------

const isNoSubstitutionTemplate = (template: Node): boolean => (template.data as DataOf<'TemplateLiteral'>).quasis.length === 1;

const isGlobalLiteralName = (ident: Node, ctx: GlobalContext): boolean =>
    (ident.name === 'undefined' || ident.name === 'Infinity' || ident.name === 'NaN') && ctx.isGlobalReference(ident);

/** oxc `IsLiteralValue::is_literal_value`: evaluates to the same thing regardless of when or where it
 *  is evaluated. Function literals count only when `includeFunctions` is set. */
export function isLiteralValue(expr: Node, includeFunctions: boolean, ctx: GlobalContext): boolean {
    switch (expr.type) {
        case N.BooleanLiteral:
        case N.NullLiteral:
        case N.NumericLiteral:
        case N.BigIntLiteral:
        case N.RegExpLiteral:
        case N.StringLiteral:
            return true;
        case N.TemplateLiteral:
            return isNoSubstitutionTemplate(expr);
        case N.IdentifierReference:
            return isGlobalLiteralName(expr, ctx);
        case N.ArrayExpression:
            return arrayExpressionIsLiteralValue(expr, includeFunctions, ctx);
        case N.ObjectExpression:
            return objectExpressionIsLiteralValue(expr, includeFunctions, ctx);
        case N.FunctionExpression:
        case N.ArrowFunctionExpression:
            return includeFunctions;
        case N.UnaryExpression:
            return unaryExpressionIsLiteralValue(expr, includeFunctions, ctx);
        case N.BinaryExpression:
            // `#x in y` is oxc's `PrivateInExpression`, which is not a literal value.
            if (expr.data.left.type === N.PrivateIdentifier) return false;
            return binaryExpressionIsLiteralValue(expr, includeFunctions, ctx);
        case N.LogicalExpression:
            return (
                isLiteralValue(expr.data.left, includeFunctions, ctx) && isLiteralValue(expr.data.right, includeFunctions, ctx)
            );
        case N.ConditionalExpression:
            return (
                isLiteralValue(expr.data.test, includeFunctions, ctx) &&
                isLiteralValue(expr.data.consequent, includeFunctions, ctx) &&
                isLiteralValue(expr.data.alternate, includeFunctions, ctx)
            );
        case N.SequenceExpression:
            for (const item of expr.data.expressions as Node[]) if (!isLiteralValue(item, includeFunctions, ctx)) return false;
            return true;
        default:
            return false;
    }
}

function arrayExpressionIsLiteralValue(array: Node, includeFunctions: boolean, ctx: GlobalContext): boolean {
    for (const element of (array.data as DataOf<'ArrayExpression'>).elements) {
        if (element === null) continue;
        // A spread element triggers a `Symbol.iterator` call.
        if (element.type === N.SpreadElement || !isLiteralValue(element, includeFunctions, ctx)) return false;
    }
    return true;
}

function objectExpressionIsLiteralValue(object: Node, includeFunctions: boolean, ctx: GlobalContext): boolean {
    for (const property of (object.data as DataOf<'ObjectExpression'>).properties)
        if (!objectPropertyKindIsLiteralValue(property, includeFunctions, ctx)) return false;
    return true;
}

function objectPropertyKindIsLiteralValue(property: Node, includeFunctions: boolean, ctx: GlobalContext): boolean {
    if (property.type === N.ObjectProperty) {
        return (
            propertyKeyIsLiteralValue(property, includeFunctions, ctx) &&
            isLiteralValue((property.data as DataOf<'ObjectProperty'>).value, includeFunctions, ctx)
        );
    }
    const argument = (property.data as DataOf<'SpreadElement'>).argument;
    switch (argument.type) {
        case N.ArrayExpression:
            return arrayExpressionIsLiteralValue(argument, includeFunctions, ctx);
        case N.StringLiteral:
            return true;
        case N.TemplateLiteral:
            return isNoSubstitutionTemplate(argument);
        case N.ObjectExpression:
            return objectExpressionIsLiteralValue(argument, includeFunctions, ctx);
        default:
            return false;
    }
}

/** oxc `PropertyKey::is_literal_value`, for the key of `property`. */
function propertyKeyIsLiteralValue(property: Node, includeFunctions: boolean, ctx: GlobalContext): boolean {
    const { key, computed } = property.data as DataOf<'ObjectProperty'>;
    if (!computed && key.type === N.IdentifierName) return true;
    if (key.type === N.PrivateIdentifier) return false;
    return canConvertToStringTransparently(key, includeFunctions, ctx);
}

function unaryExpressionIsLiteralValue(unary: Node, includeFunctions: boolean, ctx: GlobalContext): boolean {
    const { argument, operator } = unary.data as DataOf<'UnaryExpression'>;
    switch (operator) {
        case 'void':
        case '!':
        case 'typeof':
            return isLiteralValue(argument, includeFunctions, ctx);
        case '+':
            return canConvertToNumberTransparently(argument, includeFunctions, ctx);
        case '-':
        case '~':
            return canConvertToNumberTransparently(argument, includeFunctions, ctx) || argument.type === N.BigIntLiteral;
        default:
            return false;
    }
}

/** Both operands are numeric literals, or both are bigint literals. */
const sameNumericLiteralKinds = (left: Node, right: Node): boolean =>
    (left.type === N.NumericLiteral && right.type === N.NumericLiteral) ||
    (left.type === N.BigIntLiteral && right.type === N.BigIntLiteral);

function binaryExpressionIsLiteralValue(binary: Node, includeFunctions: boolean, ctx: GlobalContext): boolean {
    const { left, right, operator } = binary.data as DataOf<'BinaryExpression'>;
    switch (operator) {
        case '===':
        case '!==':
            return isLiteralValue(left, includeFunctions, ctx) && isLiteralValue(right, includeFunctions, ctx);
        case '+':
            if (
                (isImmutableString(left) && canConvertToStringTransparently(right, includeFunctions, ctx)) ||
                (isImmutableString(right) && canConvertToStringTransparently(left, includeFunctions, ctx))
            )
                return true;
            return sameNumericLiteralKinds(left, right);
        case '-':
        case '*':
        case '/':
        case '%':
        case '**':
        case '<<':
        case '>>':
        case '>>>':
        case '|':
        case '^':
        case '&': {
            if (
                (left.type === N.NumericLiteral && canConvertToNumberTransparently(right, includeFunctions, ctx)) ||
                (right.type === N.NumericLiteral && canConvertToNumberTransparently(left, includeFunctions, ctx))
            )
                return true;
            if (left.type !== N.BigIntLiteral || right.type !== N.BigIntLiteral) return false;
            // `1n / 0n`, `1n % 0n` and `1n ** -1n` throw.
            const rightValue = bigIntLiteralValue(right);
            switch (operator) {
                case '>>>':
                    return false;
                case '**':
                    return rightValue >= 0n;
                case '/':
                case '%':
                    return rightValue !== 0n;
                default:
                    return true;
            }
        }
        default:
            return false;
    }
}

function canConvertToNumberTransparently(expr: Node, includeFunctions: boolean, ctx: GlobalContext): boolean {
    switch (expr.type) {
        case N.NumericLiteral:
        case N.NullLiteral:
        case N.BooleanLiteral:
        case N.StringLiteral:
            return true;
        case N.TemplateLiteral:
            return isNoSubstitutionTemplate(expr);
        case N.IdentifierReference:
            return isGlobalLiteralName(expr, ctx);
        case N.ArrowFunctionExpression:
        case N.FunctionExpression:
            return includeFunctions;
        case N.UnaryExpression:
            switch (expr.data.operator) {
                case 'void':
                case '!':
                case 'typeof':
                    return isLiteralValue(expr.data.argument, includeFunctions, ctx);
                case '+':
                case '-':
                case '~':
                    return canConvertToNumberTransparently(expr.data.argument, includeFunctions, ctx);
                default:
                    return false;
            }
        case N.BinaryExpression: {
            const left = expr.data.left as Node;
            const right = expr.data.right as Node;
            if (left.type === N.PrivateIdentifier) return false;
            switch (expr.data.operator) {
                case '===':
                case '!==':
                    return isLiteralValue(left, includeFunctions, ctx) && isLiteralValue(right, includeFunctions, ctx);
                case '+':
                    if (
                        (isImmutableString(left) && canConvertToStringTransparently(right, includeFunctions, ctx)) ||
                        (isImmutableString(right) && canConvertToStringTransparently(left, includeFunctions, ctx))
                    )
                        return true;
                    return sameNumericLiteralKinds(left, right);
                case '-':
                case '*':
                case '/':
                case '%':
                case '**':
                case '<<':
                case '>>':
                case '>>>':
                case '|':
                case '^':
                case '&':
                    return (
                        (left.type === N.NumericLiteral && canConvertToNumberTransparently(right, includeFunctions, ctx)) ||
                        (right.type === N.NumericLiteral && canConvertToNumberTransparently(left, includeFunctions, ctx))
                    );
                default:
                    return false;
            }
        }
        case N.LogicalExpression:
            return (
                canConvertToNumberTransparently(expr.data.left, includeFunctions, ctx) &&
                canConvertToNumberTransparently(expr.data.right, includeFunctions, ctx)
            );
        case N.ConditionalExpression:
            return (
                isLiteralValue(expr.data.test, includeFunctions, ctx) &&
                canConvertToNumberTransparently(expr.data.consequent, includeFunctions, ctx) &&
                canConvertToNumberTransparently(expr.data.alternate, includeFunctions, ctx)
            );
        case N.SequenceExpression: {
            const expressions = expr.data.expressions as Node[];
            if (!canConvertToNumberTransparently(expressions[expressions.length - 1], includeFunctions, ctx)) return false;
            for (let index = 0; index < expressions.length - 1; index++) {
                if (!isLiteralValue(expressions[index], includeFunctions, ctx)) return false;
            }
            return true;
        }
        default:
            return false;
    }
}

function canConvertToStringTransparently(expr: Node, includeFunctions: boolean, ctx: GlobalContext): boolean {
    switch (expr.type) {
        case N.NumericLiteral:
        case N.StringLiteral:
        case N.NullLiteral:
        case N.BooleanLiteral:
        case N.BigIntLiteral:
            return true;
        case N.TemplateLiteral:
            return isNoSubstitutionTemplate(expr);
        case N.IdentifierReference:
            return isGlobalLiteralName(expr, ctx);
        case N.ArrowFunctionExpression:
        case N.FunctionExpression:
            return includeFunctions;
        case N.UnaryExpression:
            return unaryExpressionIsLiteralValue(expr, includeFunctions, ctx);
        case N.BinaryExpression:
            if (expr.data.left.type === N.PrivateIdentifier) return false;
            return binaryExpressionIsLiteralValue(expr, includeFunctions, ctx);
        case N.LogicalExpression:
            return (
                isLiteralValue(expr.data.left, includeFunctions, ctx) && isLiteralValue(expr.data.right, includeFunctions, ctx)
            );
        case N.ConditionalExpression:
            return (
                isLiteralValue(expr.data.test, includeFunctions, ctx) &&
                canConvertToStringTransparently(expr.data.consequent, includeFunctions, ctx) &&
                canConvertToStringTransparently(expr.data.alternate, includeFunctions, ctx)
            );
        case N.SequenceExpression: {
            const expressions = expr.data.expressions as Node[];
            if (!canConvertToStringTransparently(expressions[expressions.length - 1], includeFunctions, ctx)) return false;
            for (let index = 0; index < expressions.length - 1; index++) {
                if (!isLiteralValue(expressions[index], includeFunctions, ctx)) return false;
            }
            return true;
        }
        default:
            return false;
    }
}

const isImmutableString = (expr: Node): boolean =>
    expr.type === N.StringLiteral || (expr.type === N.TemplateLiteral && isNoSubstitutionTemplate(expr));

function evaluateValueTo(expr: Node, ctx: ConstantEvaluationContext, targetType: ValueType | null): ConstantValue | null {
    switch (targetType) {
        case 'boolean': {
            const value = toBoolean(expr, ctx);
            if (value !== null) return booleanValue(value);
            break;
        }
        case 'number': {
            const value = toNumber(expr, ctx);
            if (value !== null) return numberValue(value);
            break;
        }
        case 'bigint': {
            const value = toBigInt(expr, ctx);
            if (value !== null) return bigIntValue(value);
            break;
        }
        case 'string': {
            const value = toJsString(expr, ctx);
            if (value !== null) return stringValue(value);
            break;
        }
    }

    switch (expr.type) {
        case N.BinaryExpression:
            // oxc skips binary expressions evaluated for a boolean target.
            if (targetType === 'boolean') return null;
            return binaryOperationEvaluateValue(expr.data.operator, expr.data.left, expr.data.right, ctx);
        case N.LogicalExpression:
            return logicalEvaluateValue(expr.data.operator, expr.data.left, expr.data.right, ctx, targetType);
        case N.UnaryExpression:
            return unaryEvaluateValue(expr.data.operator, expr.data.argument, ctx);
        case N.IdentifierReference:
            if (ctx.isGlobalReference(expr)) {
                if (expr.name === 'undefined') return UNDEFINED_VALUE;
                if (expr.name === 'NaN') return numberValue(Number.NaN);
                if (expr.name === 'Infinity') return numberValue(Number.POSITIVE_INFINITY);
            }
            return ctx.constantValueForReference(expr);
        case N.NumericLiteral:
            return numberValue(numericLiteralValue(expr));
        case N.NullLiteral:
            return NULL_VALUE;
        case N.BooleanLiteral:
            return booleanValue(expr.name === 'true');
        case N.BigIntLiteral:
            return bigIntValue(bigIntLiteralValue(expr));
        case N.StringLiteral: {
            const literal = stringLiteralValue(expr);
            return literal.loneSurrogates ? null : stringValue(literal.value);
        }
        case N.StaticMemberExpression:
            return expr.data.property.name === 'length' ? evaluateValueLength(expr.data.object, ctx) : null;
        case N.ComputedMemberExpression: {
            const property = expr.data.expression;
            if (property.type === N.StringLiteral && stringLiteralValue(property).value === 'length') {
                return evaluateValueLength(expr.data.object, ctx);
            }
            return null;
        }
        case N.CallExpression:
            return tryFoldKnownGlobalMethods(expr.data.callee, expr.data.arguments, ctx);
        case N.SequenceExpression: {
            const last = expr.data.expressions.at(-1);
            return last === undefined ? null : evaluateValueTo(last, ctx, targetType);
        }
        default:
            return null;
    }
}

function binaryOperationEvaluateValue(
    operator: string,
    left: Node,
    right: Node,
    ctx: ConstantEvaluationContext,
): ConstantValue | null {
    switch (operator) {
        case '+': {
            const leftPrimitive = toPrimitive(left, ctx);
            const rightPrimitive = toPrimitive(right, ctx);
            if (leftPrimitive === 'string' || rightPrimitive === 'string') {
                const leftString = evaluateValueToString(left, ctx);
                if (leftString === null) return null;
                const rightString = evaluateValueToString(right, ctx);
                if (rightString === null) return null;
                return stringValue(leftString + rightString);
            }
            const leftNumeric = primitiveToNumeric(leftPrimitive);
            const rightNumeric = primitiveToNumeric(rightPrimitive);
            if (leftNumeric === 'number' || rightNumeric === 'number') {
                const leftNumber = evaluateValueToNumber(left, ctx);
                if (leftNumber === null) return null;
                const rightNumber = evaluateValueToNumber(right, ctx);
                if (rightNumber === null) return null;
                return numberValue(leftNumber + rightNumber);
            }
            if (leftNumeric === 'bigint' && rightNumeric === 'bigint') {
                const leftBigInt = evaluateValueToBigInt(left, ctx);
                if (leftBigInt === null) return null;
                const rightBigInt = evaluateValueToBigInt(right, ctx);
                if (rightBigInt === null) return null;
                return bigIntValue(leftBigInt + rightBigInt);
            }
            return null;
        }
        case '-':
        case '/':
        case '%':
        case '*':
        case '**':
        case '<<':
        case '>>':
        case '>>>': {
            const leftNumber = evaluateValueToNumber(left, ctx);
            if (leftNumber === null) return null;
            const rightNumber = evaluateValueToNumber(right, ctx);
            if (rightNumber === null) return null;
            switch (operator) {
                case '-':
                    return numberValue(leftNumber - rightNumber);
                case '/':
                    return numberValue(leftNumber / rightNumber);
                case '%':
                    return numberValue(rightNumber === 0 ? Number.NaN : leftNumber % rightNumber);
                case '*':
                    return numberValue(leftNumber * rightNumber);
                case '**': {
                    const result = rustPowf(leftNumber, rightNumber);
                    // Skip results that would print longer than the input.
                    if (Number.isFinite(result) && (fract(result) !== 0 || Math.log10(result) > 4)) return null;
                    return numberValue(result);
                }
                case '<<':
                    return numberValue(toInt32(leftNumber) << (toUint32(rightNumber) & 31));
                case '>>':
                    return numberValue(toInt32(leftNumber) >> (toUint32(rightNumber) & 31));
                default:
                    return numberValue(toUint32(leftNumber) >>> (toUint32(rightNumber) & 31));
            }
        }
        case '<':
            return isLessThanAsComparison(isLessThan(left, right, ctx));
        case '>':
            return isLessThanAsComparison(isLessThan(right, left, ctx));
        case '<=':
            return isLessThanAsNegatedComparison(isLessThan(right, left, ctx));
        case '>=':
            return isLessThanAsNegatedComparison(isLessThan(left, right, ctx));
        case '&':
        case '|':
        case '^': {
            if (valueType(left, ctx) === 'bigint' && valueType(right, ctx) === 'bigint') {
                const leftBigInt = evaluateValueToBigInt(left, ctx);
                if (leftBigInt === null) return null;
                const rightBigInt = evaluateValueToBigInt(right, ctx);
                if (rightBigInt === null) return null;
                if (operator === '&') return bigIntValue(leftBigInt & rightBigInt);
                if (operator === '|') return bigIntValue(leftBigInt | rightBigInt);
                return bigIntValue(leftBigInt ^ rightBigInt);
            }
            const leftNumber = evaluateValueToNumber(left, ctx);
            if (leftNumber === null) return null;
            const rightNumber = evaluateValueToNumber(right, ctx);
            if (rightNumber === null) return null;
            if (operator === '&') return numberValue(toInt32(leftNumber) & toInt32(rightNumber));
            if (operator === '|') return numberValue(toInt32(leftNumber) | toInt32(rightNumber));
            return numberValue(toInt32(leftNumber) ^ toInt32(rightNumber));
        }
        case 'instanceof':
            return instanceofEvaluateValue(left, right, ctx);
        case '===':
        case '!==': {
            const equal = strictEqualityComparison(left, right, ctx);
            if (equal === null) return null;
            return booleanValue(operator === '===' ? equal : !equal);
        }
        case '==':
        case '!=': {
            const equal = abstractEqualityComparison(left, right, ctx);
            if (equal === null) return null;
            return booleanValue(operator === '==' ? equal : !equal);
        }
        default:
            return null;
    }
}

function isLessThanAsComparison(value: ConstantValue | null): ConstantValue | null {
    if (value === null) return null;
    return value.kind === 'undefined' ? booleanValue(false) : value;
}

function isLessThanAsNegatedComparison(value: ConstantValue | null): ConstantValue | null {
    if (value === null) return null;
    return booleanValue(value.kind === 'boolean' && !value.value);
}

function instanceofEvaluateValue(left: Node, right: Node, ctx: ConstantEvaluationContext): ConstantValue | null {
    if (right.type !== N.IdentifierReference) return null;
    const name = right.name;
    if (!(name === 'Object' || name === 'Number' || name === 'Boolean' || name === 'String') || !ctx.isGlobalReference(right)) {
        return null;
    }
    const leftType = valueType(left, ctx);
    if (leftType === 'undetermined') return null;
    if (name !== 'Object') return booleanValue(false);
    if (leftType !== 'object') return booleanValue(false);
    switch (left.type) {
        case N.ArrayExpression:
        case N.RegExpLiteral:
        case N.FunctionExpression:
        case N.ArrowFunctionExpression:
        case N.ClassExpression:
            return booleanValue(true);
        case N.ObjectExpression:
            // `{ __proto__: null } instanceof Object` is false.
            return left.data.properties.length === 0 ? booleanValue(true) : null;
        default:
            return null;
    }
}

function logicalEvaluateValue(
    operator: string,
    left: Node,
    right: Node,
    ctx: ConstantEvaluationContext,
    targetType: ValueType | null,
): ConstantValue | null {
    if (operator === '??') return null;
    const leftBoolean = evaluateValueToBoolean(left, ctx);
    if (operator === '&&') {
        if (leftBoolean === true) return evaluateValueInContext(right, ctx);
        if (leftBoolean === false) return evaluateValueInContext(left, ctx);
        return targetType === 'boolean' && evaluateValueToBoolean(right, ctx) === false ? booleanValue(false) : null;
    }
    if (leftBoolean === true) return evaluateValueInContext(left, ctx);
    if (leftBoolean === false) return evaluateValueInContext(right, ctx);
    return targetType === 'boolean' && evaluateValueToBoolean(right, ctx) === true ? booleanValue(true) : null;
}

function unaryEvaluateValue(operator: string, argument: Node, ctx: ConstantEvaluationContext): ConstantValue | null {
    switch (operator) {
        case 'typeof': {
            switch (valueType(argument, ctx)) {
                case 'bigint':
                    return stringValue('bigint');
                case 'number':
                    return stringValue('number');
                case 'string':
                    return stringValue('string');
                case 'boolean':
                    return stringValue('boolean');
                case 'undefined':
                    return stringValue('undefined');
                case 'null':
                    return stringValue('object');
            }
            switch (argument.type) {
                case N.ObjectExpression:
                case N.ArrayExpression:
                    return stringValue('object');
                case N.ClassExpression:
                case N.FunctionExpression:
                case N.ArrowFunctionExpression:
                    return stringValue('function');
                default:
                    return null;
            }
        }
        case 'void':
            return UNDEFINED_VALUE;
        case '!': {
            const value = evaluateValueToBoolean(argument, ctx);
            return value === null ? null : booleanValue(!value);
        }
        case '+': {
            const value = evaluateValueToNumber(argument, ctx);
            return value === null ? null : numberValue(value);
        }
        case '-':
            switch (valueType(argument, ctx)) {
                case 'bigint': {
                    const value = evaluateValueToBigInt(argument, ctx);
                    return value === null ? null : bigIntValue(-value);
                }
                case 'number': {
                    const value = evaluateValueToNumber(argument, ctx);
                    return value === null ? null : numberValue(Number.isNaN(value) ? value : -value);
                }
                case 'undefined':
                    return numberValue(Number.NaN);
                case 'null':
                    return numberValue(-0);
                default:
                    return null;
            }
        case '~': {
            if (valueType(argument, ctx) === 'bigint') {
                const value = evaluateValueToBigInt(argument, ctx);
                return value === null ? null : bigIntValue(~value);
            }
            const value = evaluateValueToNumber(argument, ctx);
            return value === null ? null : numberValue(~toInt32(value));
        }
        default:
            return null;
    }
}

function evaluateValueLength(object: Node, ctx: ConstantEvaluationContext): ConstantValue | null {
    const value = evaluateValueInContext(object, ctx);
    if (value !== null && value.kind === 'string') return numberValue(value.value.length);
    if (object.type !== N.ArrayExpression) return null;
    for (const element of object.data.elements) {
        if (element !== null && element.type === N.SpreadElement) return null;
    }
    return numberValue(object.data.elements.length);
}

// --- is_less_than.rs -----------------------------------------------------------------------------

function isLessThan(x: Node, y: Node, ctx: ConstantEvaluationContext): ConstantValue | null {
    const px = valueType(x, ctx);
    const py = valueType(y, ctx);
    if (px === 'undetermined' || px === 'object' || py === 'undetermined' || py === 'object') return null;

    if (px === 'string' && py === 'string') {
        const leftString = toJsString(x, ctx);
        if (leftString === null) return null;
        const rightString = toJsString(y, ctx);
        if (rightString === null) return null;
        return booleanValue(leftString < rightString);
    }

    if (px === 'bigint' && py === 'string') {
        const rightString = toJsString(y, ctx);
        if (rightString === null) return null;
        const ny = stringToBigInt(rightString);
        if (ny === null) return UNDEFINED_VALUE;
        const nx = toBigInt(x, ctx);
        return nx === null ? null : booleanValue(nx < ny);
    }
    if (px === 'string' && py === 'bigint') {
        const leftString = toJsString(x, ctx);
        if (leftString === null) return null;
        const nx = stringToBigInt(leftString);
        if (nx === null) return UNDEFINED_VALUE;
        const ny = toBigInt(y, ctx);
        return ny === null ? null : booleanValue(nx < ny);
    }

    const nxIsNumber = px !== 'bigint';
    const nyIsNumber = py !== 'bigint';

    if (nxIsNumber && nyIsNumber) {
        const leftNumber = evaluateValueToNumber(x, ctx);
        if (leftNumber === null) return null;
        if (Number.isNaN(leftNumber)) return UNDEFINED_VALUE;
        const rightNumber = evaluateValueToNumber(y, ctx);
        if (rightNumber === null) return null;
        if (Number.isNaN(rightNumber)) return UNDEFINED_VALUE;
        return booleanValue(leftNumber < rightNumber);
    }
    if (px === 'bigint' && py === 'bigint') {
        const nx = toBigInt(x, ctx);
        if (nx === null) return null;
        const ny = toBigInt(y, ctx);
        return ny === null ? null : booleanValue(nx < ny);
    }

    const nx = evaluateValueToNumber(x, ctx);
    const ny = evaluateValueToNumber(y, ctx);

    if ((nxIsNumber && nx !== null && Number.isNaN(nx)) || (nyIsNumber && ny !== null && Number.isNaN(ny))) {
        return UNDEFINED_VALUE;
    }
    if ((nxIsNumber && nx === Number.NEGATIVE_INFINITY) || (nyIsNumber && ny === Number.POSITIVE_INFINITY)) {
        return booleanValue(true);
    }
    if ((nxIsNumber && nx === Number.POSITIVE_INFINITY) || (nyIsNumber && ny === Number.NEGATIVE_INFINITY)) {
        return booleanValue(false);
    }

    if (px === 'bigint') {
        const bigX = toBigInt(x, ctx);
        if (bigX === null || ny === null) return null;
        const ordering = compareBigIntAndNumber(bigX, ny);
        return ordering === null ? null : booleanValue(ordering < 0);
    }
    if (py === 'bigint') {
        const bigY = toBigInt(y, ctx);
        if (bigY === null || nx === null) return null;
        const ordering = compareBigIntAndNumber(bigY, nx);
        return ordering === null ? null : booleanValue(ordering > 0);
    }
    return null;
}

/** oxc `compare_bigint_and_f64`: the number is truncated first (num-bigint `from_f64`), then its fraction breaks the tie. */
function compareBigIntAndNumber(x: bigint, y: number): number | null {
    if (!Number.isFinite(y)) return null;
    const truncated = BigInt(Math.trunc(y));
    if (x !== truncated) return x < truncated ? -1 : 1;
    const fraction = fract(y);
    return fraction > 0 ? -1 : fraction < 0 ? 1 : 0;
}

// --- equality_comparison.rs ----------------------------------------------------------------------

function abstractEqualityComparison(leftExpr: Node, rightExpr: Node, ctx: ConstantEvaluationContext): boolean | null {
    const left = valueType(leftExpr, ctx);
    const right = valueType(rightExpr, ctx);
    if (left === 'undetermined' || right === 'undetermined') return null;
    if (left === right) return strictEqualityComparison(leftExpr, rightExpr, ctx);
    if ((left === 'null' && right === 'undefined') || (left === 'undefined' && right === 'null')) return true;

    if ((left === 'number' && right === 'string') || right === 'boolean') {
        const rightNumber = evaluateValueToNumber(rightExpr, ctx);
        if (rightNumber === null) return null;
        return abstractEqualityComparison(leftExpr, num(rightNumber), ctx);
    }
    if ((left === 'string' && right === 'number') || left === 'boolean') {
        const leftNumber = evaluateValueToNumber(leftExpr, ctx);
        if (leftNumber === null) return null;
        return abstractEqualityComparison(num(leftNumber), rightExpr, ctx);
    }

    if (left === 'bigint' || right === 'bigint') {
        const leftBigInt = evaluateValueToBigInt(leftExpr, ctx);
        const rightBigInt = evaluateValueToBigInt(rightExpr, ctx);
        if (leftBigInt !== null && rightBigInt !== null) return leftBigInt === rightBigInt;
    }

    if ((left === 'string' || left === 'number' || left === 'bigint') && right === 'object') return null;
    if (left === 'object' && (right === 'string' || right === 'number' || right === 'bigint')) return null;
    return false;
}

function strictEqualityComparison(leftExpr: Node, rightExpr: Node, ctx: ConstantEvaluationContext): boolean | null {
    const left = valueType(leftExpr, ctx);
    const right = valueType(rightExpr, ctx);
    if (left !== 'undetermined' && right !== 'undetermined') {
        if (left !== right) return false;
        switch (left) {
            case 'number': {
                const leftNumber = getSideFreeNumberValue(leftExpr, ctx);
                if (leftNumber === null) return null;
                const rightNumber = getSideFreeNumberValue(rightExpr, ctx);
                if (rightNumber === null) return null;
                return leftNumber === rightNumber;
            }
            case 'string': {
                const leftString = getSideFreeStringValue(leftExpr, ctx);
                if (leftString === null) return null;
                const rightString = getSideFreeStringValue(rightExpr, ctx);
                if (rightString === null) return null;
                return leftString === rightString;
            }
            case 'undefined':
            case 'null':
                return true;
            case 'boolean': {
                const leftBoolean = evaluateValueToBoolean(leftExpr, ctx);
                if (leftBoolean === null) return null;
                const rightBoolean = evaluateValueToBoolean(rightExpr, ctx);
                if (rightBoolean === null) return null;
                return leftBoolean === rightBoolean;
            }
            case 'bigint': {
                const leftBigInt = getSideFreeBigIntValue(leftExpr, ctx);
                if (leftBigInt === null) return null;
                const rightBigInt = getSideFreeBigIntValue(rightExpr, ctx);
                if (rightBigInt === null) return null;
                return leftBigInt === rightBigInt;
            }
            default:
                return null;
        }
    }
    // oxc `Expression::is_nan` matches the name only, shadowed or not.
    const isNaNIdentifier = (expr: Node): boolean => expr.type === N.IdentifierReference && expr.name === 'NaN';
    if (isNaNIdentifier(leftExpr) || isNaNIdentifier(rightExpr)) return false;
    return null;
}

// --- call_expr.rs --------------------------------------------------------------------------------

const isSpread = (argument: Node): boolean => argument.type === N.SpreadElement;

function tryFoldKnownGlobalMethods(callee: Node, args: Node[], ctx: ConstantEvaluationContext): ConstantValue | null {
    if (callee.type === N.IdentifierReference) return tryFoldGlobalFunctions(callee, args, ctx);

    let name: string;
    let object: Node;
    if (callee.type === N.StaticMemberExpression && !callee.data.optional) {
        name = callee.data.property.name;
        object = callee.data.object;
    } else if (callee.type === N.ComputedMemberExpression && !callee.data.optional) {
        if (callee.data.expression.type !== N.StringLiteral) return null;
        name = stringLiteralValue(callee.data.expression).value;
        object = callee.data.object;
    } else {
        return null;
    }
    switch (name) {
        case 'toLowerCase':
        case 'toUpperCase':
        case 'trim':
        case 'trimStart':
        case 'trimEnd':
            return tryFoldStringCasing(args, name, object, ctx);
        case 'substring':
        case 'slice':
            return tryFoldStringSubstringOrSlice(args, object, ctx);
        case 'indexOf':
        case 'lastIndexOf':
            return tryFoldStringIndexOf(args, name, object, ctx);
        case 'charAt':
            return tryFoldStringCharAt(args, object, ctx);
        case 'charCodeAt':
            return tryFoldStringCharCodeAt(args, object, ctx);
        case 'startsWith':
            return tryFoldStartsWith(args, object);
        case 'replace':
        case 'replaceAll':
            return tryFoldStringReplace(args, name, object, ctx);
        case 'fromCharCode':
            return tryFoldStringFromCharCode(args, object, ctx);
        case 'toString':
            return tryFoldToString(args, object, ctx);
        case 'isFinite':
        case 'isNaN':
        case 'isInteger':
        case 'isSafeInteger':
            return tryFoldNumberMethods(args, object, name, ctx);
        case 'sqrt':
        case 'cbrt':
            return tryFoldRoots(args, name, object, ctx);
        case 'abs':
        case 'ceil':
        case 'floor':
        case 'round':
        case 'fround':
        case 'trunc':
        case 'sign':
        case 'clz32':
            return tryFoldMathUnary(args, name, object, ctx);
        case 'imul':
        case 'min':
        case 'max':
            return tryFoldMathVariadic(args, name, object, ctx);
        default:
            return null;
    }
}

function tryFoldGlobalFunctions(ident: Node, args: Node[], ctx: ConstantEvaluationContext): ConstantValue | null {
    if (!ctx.isGlobalReference(ident)) return null;
    switch (ident.name) {
        case 'encodeURI':
            return tryFoldEncodeUri(args, ctx, (byte) => !isUriAlwaysUnescaped(byte) && !URI_RESERVED.includes(byte));
        case 'encodeURIComponent':
            return tryFoldEncodeUri(args, ctx, (byte) => !isUriAlwaysUnescaped(byte));
        case 'decodeURI':
            return tryFoldDecodeUri(args, ctx, (byte) => URI_RESERVED.includes(byte));
        case 'decodeURIComponent':
            return tryFoldDecodeUri(args, ctx, () => false);
        case 'isNaN':
            return tryFoldGlobalIsNaN(args, ctx);
        case 'isFinite':
            return tryFoldGlobalIsFinite(args, ctx);
        case 'parseFloat':
            return tryFoldGlobalParseFloat(args, ctx);
        case 'parseInt':
            return tryFoldGlobalParseInt(args, ctx);
        default:
            return null;
    }
}

/** An optional argument evaluated side-free: undefined when absent, null to bail. */
function optionalSideFreeNumber(argument: Node | undefined, ctx: ConstantEvaluationContext): number | null | undefined {
    if (argument === undefined) return undefined;
    if (isSpread(argument)) return null;
    return getSideFreeNumberValue(argument, ctx);
}

function tryFoldStringCasing(args: Node[], name: string, object: Node, ctx: ConstantEvaluationContext): ConstantValue | null {
    if (args.length !== 0) return null;
    let value: string;
    if (object.type === N.StringLiteral) {
        const literal = plainStringLiteralValue(object);
        if (literal === null) return null;
        value = literal;
    } else if (object.type === N.IdentifierReference) {
        const constant = ctx.constantValueForReference(object);
        if (constant === null || constant.kind !== 'string') return null;
        value = constant.value;
    } else {
        return null;
    }
    switch (name) {
        case 'toLowerCase':
            return stringValue(value.toLowerCase());
        case 'toUpperCase':
            return stringValue(value.toUpperCase());
        case 'trim':
            return stringValue(rustTrim(value));
        case 'trimStart':
            return stringValue(rustTrimStart(value));
        default:
            return stringValue(rustTrimEnd(value));
    }
}

function tryFoldStringIndexOf(args: Node[], name: string, object: Node, ctx: ConstantEvaluationContext): ConstantValue | null {
    if (args.length >= 3) return null;
    const value = plainStringLiteralValue(object);
    if (value === null) return null;
    let searchValue: string | undefined;
    if (args.length > 0) {
        if (isSpread(args[0])) return null;
        const search = getSideFreeStringValue(args[0], ctx);
        if (search === null) return null;
        searchValue = search;
    }
    const searchStartIndex = optionalSideFreeNumber(args[1], ctx);
    if (searchStartIndex === null) return null;
    return numberValue(
        name === 'indexOf'
            ? stringIndexOf(value, searchValue, searchStartIndex)
            : stringLastIndexOf(value, searchValue, searchStartIndex),
    );
}

/** oxc `StringIndexOf`: skips `from` chars, then reports a UTF-8 byte offset plus that char count. */
function stringIndexOf(value: string, searchValue: string | undefined, fromIndex: number | undefined): number {
    const skipChars = fromIndex === undefined ? 0 : Math.max(toInt32(fromIndex), 0);
    if (searchValue === undefined) return -1;
    const rest = Array.from(value).slice(skipChars).join('');
    const found = rest.indexOf(searchValue);
    return found < 0 ? -1 : utf8Length(rest.slice(0, found)) + skipChars;
}

/** oxc `StringLastIndexOf`: takes `from + searchValue.len()` chars (a UTF-8 length) and reports a UTF-8 byte offset. */
function stringLastIndexOf(value: string, searchValue: string | undefined, fromIndex: number | undefined): number {
    if (searchValue === undefined) return -1;
    const takeChars =
        fromIndex === undefined ? Number.POSITIVE_INFINITY : Math.max(toInt32(fromIndex), 0) + utf8Length(searchValue);
    const taken = Array.from(value).slice(0, takeChars).join('');
    const found = taken.lastIndexOf(searchValue);
    return found < 0 ? -1 : utf8Length(taken.slice(0, found));
}

function tryFoldStringSubstringOrSlice(args: Node[], object: Node, ctx: ConstantEvaluationContext): ConstantValue | null {
    if (args.length > 2) return null;
    const value = plainStringLiteralValue(object);
    if (value === null) return null;
    const startIndex = optionalSideFreeNumber(args[0], ctx);
    if (startIndex === null) return null;
    const endIndex = optionalSideFreeNumber(args[1], ctx);
    if (endIndex === null) return null;
    const byteLength = utf8Length(value);
    if (
        (startIndex !== undefined && (startIndex > byteLength || startIndex < 0)) ||
        (endIndex !== undefined && (endIndex > byteLength || endIndex < 0))
    ) {
        return null;
    }
    if (startIndex !== undefined && endIndex !== undefined && startIndex > endIndex) return null;
    return stringValue(stringSubstring(value, startIndex, endIndex));
}

/** oxc `StringSubstring`: clamps to the UTF-8 length, then slices by chars. */
function stringSubstring(value: string, start: number | undefined, end: number | undefined): string {
    const byteLength = utf8Length(value);
    const startChars = Math.min(start === undefined ? 0 : Math.max(toInt32(start), 0), byteLength);
    const endChars = Math.min(end === undefined ? Number.POSITIVE_INFINITY : Math.max(toInt32(end), 0), byteLength);
    if (startChars > endChars) return '';
    return Array.from(value).slice(startChars, endChars).join('');
}

/** oxc `StringCharAt`: a UTF-16 unit, `invalid` when it is a surrogate. */
export function stringCharAt(value: string, position: number | undefined): { unit: number; invalid: boolean } | null {
    const integer = position === undefined || Number.isNaN(position) ? 0 : Math.trunc(position);
    if (!(integer >= 0) || integer >= value.length) return null;
    const unit = value.charCodeAt(integer);
    return { unit, invalid: unit >= 0xd800 && unit <= 0xdfff };
}

function tryFoldStringCharAt(args: Node[], object: Node, ctx: ConstantEvaluationContext): ConstantValue | null {
    if (args.length > 1) return null;
    const value = plainStringLiteralValue(object);
    if (value === null) return null;
    const index = optionalSideFreeNumber(args[0], ctx);
    if (index === null) return null;
    const result = stringCharAt(value, index);
    if (result === null) return stringValue('');
    if (result.invalid) return null;
    return stringValue(String.fromCharCode(result.unit));
}

function tryFoldStringCharCodeAt(args: Node[], object: Node, ctx: ConstantEvaluationContext): ConstantValue | null {
    for (let index = 1; index < args.length; index++) {
        if (isSpread(args[index]) || mayHaveSideEffects(args[index], ctx)) return null;
    }
    const value = plainStringLiteralValue(object);
    if (value === null) return null;
    const index = optionalSideFreeNumber(args[0], ctx);
    if (index === null) return null;
    const result = stringCharAt(value, index);
    return numberValue(result === null ? Number.NaN : result.unit);
}

function tryFoldStartsWith(args: Node[], object: Node): ConstantValue | null {
    if (args.length !== 1) return null;
    const search = plainStringLiteralValue(args[0]);
    if (search === null) return null;
    const value = plainStringLiteralValue(object);
    if (value === null) return null;
    return booleanValue(value.startsWith(search));
}

function tryFoldStringReplace(args: Node[], name: string, object: Node, ctx: ConstantEvaluationContext): ConstantValue | null {
    if (args.length !== 2) return null;
    const value = plainStringLiteralValue(object);
    if (value === null) return null;
    const [searchArgument, replaceArgument] = args;
    if (isSpread(searchArgument) || mayHaveSideEffects(searchArgument, ctx)) return null;
    const search = evaluateValueInContext(searchArgument, ctx);
    if (search === null || search.kind !== 'string') return null;
    if (isSpread(replaceArgument)) return null;
    const replacement = getSideFreeStringValue(replaceArgument, ctx);
    if (replacement === null || replacement.includes('$')) return null;
    return stringValue(
        name === 'replace' ? rustReplacen(value, search.value, replacement) : rustReplace(value, search.value, replacement),
    );
}

/** Rust `str::replacen(.., 1)`. */
function rustReplacen(value: string, search: string, replacement: string): string {
    const found = value.indexOf(search);
    return found < 0 ? value : value.slice(0, found) + replacement + value.slice(found + search.length);
}

/** Rust `str::replace`: an empty pattern matches at every char boundary, not every UTF-16 unit. */
function rustReplace(value: string, search: string, replacement: string): string {
    if (search === '') return replacement + Array.from(value).join(replacement) + (value === '' ? '' : replacement);
    return value.split(search).join(replacement);
}

function tryFoldStringFromCharCode(args: Node[], object: Node, ctx: ConstantEvaluationContext): ConstantValue | null {
    if (!isGlobalExpr('String', object, ctx)) return null;
    let out = '';
    for (const argument of args) {
        if (isSpread(argument)) return null;
        const value = getSideFreeNumberValue(argument, ctx);
        if (value === null) return null;
        const unit = toInt32(value) & 0xffff;
        if (unit >= 0xd800 && unit <= 0xdfff) return null;
        out += String.fromCharCode(unit);
    }
    return stringValue(out);
}

function tryFoldToString(args: Node[], object: Node, ctx: ConstantEvaluationContext): ConstantValue | null {
    if (object.type === N.NumericLiteral && args.length <= 1) {
        let radix = args.length === 0 ? 10 : 0;
        const radixArgument = args[0];
        if (radixArgument !== undefined && radixArgument.type === N.NumericLiteral) {
            const radixValue = numericLiteralValue(radixArgument);
            if (radixValue >= 2 && radixValue <= 36 && fract(radixValue) === 0) radix = radixValue;
        }
        if (radix === 0) return null;
        const value = numericLiteralValue(object);
        if (radix === 10) return stringValue(String(value));
        if (value === Number.POSITIVE_INFINITY) return stringValue('Infinity');
        if (value === Number.NEGATIVE_INFINITY) return stringValue('-Infinity');
        if (Number.isNaN(value)) return stringValue('NaN');
        if (value >= 0 && fract(value) !== 0) return null;
        // Rust's saturating `as u32`.
        const integer = value < 0 ? 0 : Math.min(Math.trunc(value), 0xffffffff);
        if (integer !== value) return null;
        return stringValue(integer.toString(radix));
    }
    if (object.type === N.RegExpLiteral && args.length === 0) return stringValue(object.name);
    if (args.length === 0 && !mayHaveSideEffects(object, ctx)) {
        const value = evaluateValueInContext(object, ctx);
        if (value === null || value.kind === 'undefined' || value.kind === 'null') return null;
        return stringValue(constantToJsString(value));
    }
    return null;
}

/** `args.len() == expected && every arg is an expression`. */
const validateArguments = (args: Node[], expectedLength: number): boolean =>
    args.length === expectedLength && args.every((argument) => !isSpread(argument));

function tryFoldNumberMethods(args: Node[], object: Node, name: string, ctx: ConstantEvaluationContext): ConstantValue | null {
    if (!isGlobalExpr('Number', object, ctx)) return null;
    if (args.length !== 1) return null;
    const argument = args[0];
    if (argument.type !== N.NumericLiteral && argument.type !== N.BigIntLiteral) return null;
    const value = getSideFreeNumberValue(argument, ctx);
    if (value === null) return null;
    switch (name) {
        case 'isFinite':
            return booleanValue(Number.isFinite(value));
        case 'isInteger':
            return booleanValue(Math.abs(fract(value)) < Number.EPSILON);
        case 'isNaN':
            return booleanValue(Number.isNaN(value));
        default:
            return booleanValue(Math.abs(fract(value)) < Number.EPSILON && Math.abs(value) <= 2 ** 53 - 1);
    }
}

function tryFoldRoots(args: Node[], name: string, object: Node, ctx: ConstantEvaluationContext): ConstantValue | null {
    if (!isGlobalExpr('Math', object, ctx) || !validateArguments(args, 1)) return null;
    const value = getSideFreeNumberValue(args[0], ctx);
    if (value === null) return null;
    if (value === Number.POSITIVE_INFINITY || Number.isNaN(value) || value === 0) return numberValue(value);
    if (value < 0) return numberValue(Number.NaN);
    const root = name === 'sqrt' ? Math.sqrt(value) : Math.cbrt(value);
    return fract(root) === 0 ? numberValue(root) : null;
}

function tryFoldMathUnary(args: Node[], name: string, object: Node, ctx: ConstantEvaluationContext): ConstantValue | null {
    if (!isGlobalExpr('Math', object, ctx) || !validateArguments(args, 1)) return null;
    const value = getSideFreeNumberValue(args[0], ctx);
    if (value === null) return null;
    switch (name) {
        case 'abs':
            return numberValue(Math.abs(value));
        case 'ceil':
            return numberValue(Math.ceil(value));
        case 'floor':
            return numberValue(Math.floor(value));
        case 'round': {
            // Rust rounds halves away from zero; JS rounds them up.
            const fraction = fract(value);
            return numberValue(Math.abs(Math.abs(fraction) - 0.5) < 2 ** -52 ? Math.ceil(value) : rustRound(value));
        }
        case 'fround':
            if (fract(value) === 0 || Number.isNaN(value) || !Number.isFinite(value)) return numberValue(Math.fround(value));
            return null;
        case 'trunc':
            return numberValue(Math.trunc(value));
        case 'sign':
            if (Object.is(value, 0)) return numberValue(0);
            if (Object.is(value, -0)) return numberValue(-0);
            return numberValue(Number.isNaN(value) ? value : value > 0 ? 1 : -1);
        default:
            return numberValue(Math.clz32(toUint32(value)));
    }
}

function tryFoldMathVariadic(args: Node[], name: string, object: Node, ctx: ConstantEvaluationContext): ConstantValue | null {
    if (!isGlobalExpr('Math', object, ctx)) return null;
    const numbers: number[] = [];
    for (const argument of args) {
        if (isSpread(argument)) return null;
        const value = getSideFreeNumberValue(argument, ctx);
        if (value === null) return null;
        numbers.push(value);
    }
    if (name === 'imul') return numberValue(Math.imul(toUint32(numbers[0] ?? Number.NaN), toUint32(numbers[1] ?? Number.NaN)));
    if (numbers.some(Number.isNaN)) return numberValue(Number.NaN);
    let result = name === 'min' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    for (const value of numbers) {
        if (name === 'min') {
            if (!(result < value || (Object.is(result, -0) && Object.is(value, 0)))) result = value;
        } else if (!(result > value || (Object.is(result, 0) && Object.is(value, -0)))) {
            result = value;
        }
    }
    return numberValue(result);
}

// --- url_encoding/ -------------------------------------------------------------------------------

const URI_ALWAYS_UNESCAPED = new Set(
    Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-.!~*'()", (char) => char.charCodeAt(0)),
);
const isUriAlwaysUnescaped = (byte: number): boolean => URI_ALWAYS_UNESCAPED.has(byte);
const URI_RESERVED = Array.from(';/?:@&=+$,#', (char) => char.charCodeAt(0));

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function hexDigitValue(byte: number): number | null {
    if (byte >= 48 && byte <= 57) return byte - 48;
    if (byte >= 65 && byte <= 70) return byte - 55;
    if (byte >= 97 && byte <= 102) return byte - 87;
    return null;
}

/** Percent-encode each UTF-8 byte `shouldEncode` selects. */
function encodeUriChars(value: string, shouldEncode: (byte: number) => boolean): string {
    let out = '';
    for (const byte of UTF8.encode(value)) {
        out += shouldEncode(byte) ? `%${byte.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(byte);
    }
    return out;
}

/** Decode `%XX` escapes at the byte level; null on a malformed escape or invalid UTF-8. */
function decodeUriChars(value: string, shouldNotDecode: (byte: number) => boolean): string | null {
    if (!value.includes('%')) return value;
    const input = UTF8.encode(value);
    const output: number[] = [];
    for (let index = 0; index < input.length; index++) {
        const byte = input[index];
        if (byte !== 37) {
            output.push(byte);
            continue;
        }
        const first = input[index + 1];
        const second = input[index + 2];
        if (first === undefined || second === undefined) return null;
        const high = hexDigitValue(first);
        const low = hexDigitValue(second);
        if (high === null || low === null) return null;
        const decoded = (high << 4) | low;
        if (shouldNotDecode(decoded)) output.push(37, first, second);
        else output.push(decoded);
        index += 2;
    }
    try {
        return UTF8_DECODER.decode(new Uint8Array(output));
    } catch {
        return null;
    }
}

function tryFoldEncodeUri(
    args: Node[],
    ctx: ConstantEvaluationContext,
    shouldEncode: (byte: number) => boolean,
): ConstantValue | null {
    if (args.length === 0) return stringValue('undefined');
    if (args.length !== 1 || isSpread(args[0])) return null;
    const value = getSideFreeStringValue(args[0], ctx);
    return value === null ? null : stringValue(encodeUriChars(value, shouldEncode));
}

function tryFoldDecodeUri(
    args: Node[],
    ctx: ConstantEvaluationContext,
    shouldNotDecode: (byte: number) => boolean,
): ConstantValue | null {
    if (args.length === 0) return stringValue('undefined');
    if (args.length !== 1 || isSpread(args[0])) return null;
    const value = getSideFreeStringValue(args[0], ctx);
    if (value === null) return null;
    const decoded = decodeUriChars(value, shouldNotDecode);
    return decoded === null ? null : stringValue(decoded);
}

// --- global functions ----------------------------------------------------------------------------

function tryFoldGlobalIsNaN(args: Node[], ctx: ConstantEvaluationContext): ConstantValue | null {
    if (args.length === 0) return booleanValue(true);
    if (args.length !== 1 || isSpread(args[0])) return null;
    const value = getSideFreeNumberValue(args[0], ctx);
    return value === null ? null : booleanValue(Number.isNaN(value));
}

function tryFoldGlobalIsFinite(args: Node[], ctx: ConstantEvaluationContext): ConstantValue | null {
    if (args.length === 0) return booleanValue(false);
    if (args.length !== 1 || isSpread(args[0])) return null;
    const value = getSideFreeNumberValue(args[0], ctx);
    return value === null ? null : booleanValue(Number.isFinite(value));
}

function tryFoldGlobalParseFloat(args: Node[], ctx: ConstantEvaluationContext): ConstantValue | null {
    if (args.length === 0) return numberValue(Number.NaN);
    if (args.length !== 1 || isSpread(args[0])) return null;
    const input = getSideFreeStringValue(args[0], ctx);
    if (input === null) return null;
    const prefix = findStrDecimalLiteralPrefix(rustTrimStart(input));
    if (prefix === null) return numberValue(Number.NaN);
    return numberValue(Number(prefix.replaceAll('_', '')));
}

const isAsciiDigit = (char: string | undefined): boolean => char !== undefined && char >= '0' && char <= '9';

/** oxc `match_decimal_digits`. After a `_` that is not followed by a digit, oxc reports the index of
 *  the char AFTER the `_` (a shadowed binding), so that `_` stays in the prefix. */
function matchDecimalDigits(text: string): number | null {
    if (!isAsciiDigit(text[0])) return null;
    let index = 1;
    while (index < text.length) {
        const char = text[index];
        if (isAsciiDigit(char)) {
            index++;
        } else if (char === '_') {
            if (index + 1 >= text.length) return index;
            if (!isAsciiDigit(text[index + 1])) return index + 1;
            index += 2;
        } else {
            return index;
        }
    }
    return text.length;
}

function matchExponentPart(text: string): number | null {
    if (!(text.startsWith('e') || text.startsWith('E'))) return null;
    let lastIndex = 1;
    let rest = text.slice(1);
    if (rest.startsWith('+') || rest.startsWith('-')) {
        lastIndex++;
        rest = rest.slice(1);
    }
    const digits = matchDecimalDigits(rest);
    return digits === null ? null : lastIndex + digits;
}

/** oxc `find_str_decimal_literal_prefix`: the longest prefix that is a StrDecimalLiteral (step 4 of `parseFloat`). */
function findStrDecimalLiteralPrefix(input: string): string | null {
    let rest = input;
    let lastIndex = 0;
    if (rest.startsWith('+') || rest.startsWith('-')) {
        rest = rest.slice(1);
        lastIndex++;
    }
    if (rest.startsWith('Infinity')) return input.slice(0, lastIndex + 'Infinity'.length);
    if (rest.startsWith('.')) {
        lastIndex++;
        rest = rest.slice(1);
        const digits = matchDecimalDigits(rest);
        if (digits === null) return null;
        lastIndex += digits;
        const exponent = matchExponentPart(rest.slice(digits));
        return input.slice(0, exponent === null ? lastIndex : lastIndex + exponent);
    }

    const digits = matchDecimalDigits(rest);
    if (digits === null) return null;
    lastIndex += digits;
    rest = rest.slice(digits);

    if (rest.startsWith('.')) {
        lastIndex++;
        rest = rest.slice(1);
        const fractionDigits = matchDecimalDigits(rest);
        if (fractionDigits === null) return input.slice(0, lastIndex - 1);
        lastIndex += fractionDigits;
        const exponent = matchExponentPart(rest.slice(fractionDigits));
        return input.slice(0, exponent === null ? lastIndex : lastIndex + exponent);
    }

    const exponent = matchExponentPart(rest);
    return input.slice(0, exponent === null ? lastIndex : lastIndex + exponent);
}

function tryFoldGlobalParseInt(args: Node[], ctx: ConstantEvaluationContext): ConstantValue | null {
    if (args.length === 0) return numberValue(Number.NaN);
    if (args.length > 2 || args.some((argument) => isSpread(argument) || mayHaveSideEffects(argument, ctx))) return null;
    const input = evaluateValueToString(args[0], ctx);
    if (input === null) return null;
    let text = rustTrimStart(input);

    const sign = text.startsWith('-') ? -1 : 1;
    if (text.startsWith('+') || text.startsWith('-')) text = text.slice(1);

    let stripPrefix = true;
    let radix = 10;
    if (args.length > 1) {
        const radixNumber = evaluateValueToNumber(args[1], ctx);
        if (radixNumber === null) return null;
        radix = toInt32(radixNumber);
        if (radix === 0) {
            radix = 10;
        } else if (radix < 2 || radix > 36) {
            return numberValue(Number.NaN);
        } else if (radix !== 16) {
            stripPrefix = false;
        }
    }

    // Other radixes may be approximated by implementations.
    if (!(radix === 2 || radix === 4 || radix === 8 || radix === 10 || radix === 16 || radix === 32)) return null;

    if (stripPrefix && (text.startsWith('0x') || text.startsWith('0X'))) {
        text = text.slice(2);
        radix = 16;
    }

    let digitsEnd = 0;
    while (digitsEnd < text.length && digitValue(text[digitsEnd], radix) !== null) digitsEnd++;
    text = text.slice(0, digitsEnd);

    if (text === '') return numberValue(Number.NaN);
    if (radix === 10 && text.length > 20) return null;

    const mathInt = i32FromStrRadix(text, radix);
    if (mathInt === null) return null;
    if (mathInt === 0) return numberValue(sign === -1 ? -0 : 0);
    return numberValue(mathInt * sign);
}
