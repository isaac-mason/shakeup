import type { ConstantValue } from '../analysis/constant-value.ts';
import { Prec } from './precedence.ts';
import { type Printer, space, write } from './printer.ts';

/**
 * Printing of literals from their VALUE, never their raw text, as oxc's codegen does outside TypeScript
 * context: `GenExpr for NumericLiteral` / `BigIntLiteral`, `Gen for StringLiteral`, `void 0` as a
 * `UnaryExpression` (`llm/libs/oxc/crates/oxc_codegen/src/gen.rs`). Serves both source literals and the
 * substituted constants of rolldown's `ConstantValue::to_expression`.
 *
 * Precedence follows this printer's convention: a form is parenthesised iff its precedence is below
 * the position's `minPrec`.
 */

/** The shortest source form of a non-negative finite number. oxc's `number_literal`
 *  (`oxc_ecmascript/src/number_literal.rs`), itself Terser's `get_minified_number`. */
export function numberLiteral(value: number): string {
    // `String(n)` is ECMAScript Number::toString, which is what dragonbox_ecma's `format` produces.
    const formatted = String(value);
    if (value < 1000 && Number.isInteger(value)) return formatted;

    let best = '';
    for (let index = 0; index < formatted.length; index++) {
        const char = formatted[index];
        if (
            (index === 0 && char === '0' && formatted[1] === '.') ||
            (index > 0 && char === '+' && formatted[index - 1] === 'e')
        ) {
            continue;
        }
        best += char;
    }

    let isHex = false;
    if (Number.isInteger(value)) {
        // Rust's `value as u128` saturates.
        const integer = value >= 2 ** 128 ? (1n << 128n) - 1n : BigInt(value);
        const hex = integer.toString(16);
        if (2 + hex.length < best.length) {
            best = `0x${hex}`;
            isHex = true;
        }
    } else if (best.startsWith('.0')) {
        let digitsStart = 2;
        while (digitsStart < best.length && best[digitsStart] === '0') digitsStart++;
        if (digitsStart < best.length) {
            const digits = best.slice(digitsStart);
            const exponent = String(digits.length + digitsStart - 1);
            if (digits.length + 2 + exponent.length < best.length) best = `${digits}e-${exponent}`;
        }
    }

    if (!isHex && best.endsWith('0')) {
        let zeros = 0;
        while (zeros < best.length && best[best.length - 1 - zeros] === '0') zeros++;
        if (zeros < best.length) {
            const baseLength = best.length - zeros;
            const exponent = String(zeros);
            if (baseLength + 1 + exponent.length < best.length) best = `${best.slice(0, baseLength)}e${exponent}`;
        }
    }

    const point = best.indexOf('.');
    if (point !== -1) {
        const exponentAt = best.indexOf('e', point + 1);
        if (exponentAt !== -1) {
            const integerPart = best.slice(0, point);
            const fraction = best.slice(point + 1, exponentAt);
            const exponentText = best.slice(exponentAt + 1);
            if (/^[+-]?\d+$/.test(exponentText)) {
                const exponent = String(Number(exponentText) - fraction.length);
                if (integerPart.length + fraction.length + 1 + exponent.length < best.length) {
                    best = `${integerPart}${fraction}e${exponent}`;
                }
            }
        }
    }

    return best;
}

type Quote = '"' | "'" | '`';

/** Pick the cheapest quote under minify. oxc's `calculate_quote_maybe_backtick` /
 *  `calculate_quote_no_backtick` (`oxc_codegen/src/str.rs`). oxc counts from the first character
 *  needing attention onward, but nothing before it can carry a cost, so the whole string is equivalent. */
function chooseQuote(value: string, allowBacktick: boolean): Quote {
    if (!allowBacktick) {
        let singleCost = 0;
        for (let index = 0; index < value.length; index++) {
            const code = value.charCodeAt(index);
            if (code === 0x27) singleCost++;
            else if (code === 0x22) singleCost--;
        }
        return singleCost < 0 ? "'" : '"';
    }
    let singleCost = 0;
    let doubleCost = 0;
    let backtickCost = 0;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code === 0x0a) backtickCost--;
        else if (code === 0x27) singleCost++;
        else if (code === 0x22) doubleCost++;
        else if (code === 0x60) backtickCost++;
        else if (code === 0x24 && value.charCodeAt(index + 1) === 0x7b) backtickCost++;
    }
    if (backtickCost <= doubleCost) return backtickCost <= singleCost ? '`' : "'";
    return doubleCost <= singleCost ? '"' : "'";
}

const isAsciiDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

/** `</script`, case-insensitive on `script`, exactly as oxc's `is_script_close_tag` (`| 32` per byte). */
function isScriptCloseTag(value: string, at: number): boolean {
    if (at + 8 > value.length || value.charCodeAt(at + 1) !== 0x2f) return false;
    const tag = 'script';
    for (let index = 0; index < 6; index++) {
        if ((value.charCodeAt(at + 2 + index) | 32) !== tag.charCodeAt(index)) return false;
    }
    return true;
}

/** A string value as a quoted literal. oxc's `print_string_impl` + `print_string_body`
 *  (`oxc_codegen/src/str.rs`): under minify the quote is chosen by cost, otherwise it is the
 *  configured one, which rolldown leaves at oxc's default `"`. */
export function quoteString(value: string, minify: boolean, allowBacktick: boolean): string {
    return quoteStringWith(value, minify ? chooseQuote(value, allowBacktick) : '"');
}

/** A string value as a template literal, whatever its contents. oxc's `print_string_literal_as_template`. */
export const templateString = (value: string): string => quoteStringWith(value, '`');

function quoteStringWith(value: string, quote: Quote): string {
    let out = quote;
    let chunkStart = 0;
    const flush = (end: number, replacement: string, resume: number): void => {
        out += value.slice(chunkStart, end) + replacement;
        chunkStart = resume;
    };
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        switch (code) {
            case 0x00:
                flush(index, isAsciiDigit(value.charCodeAt(index + 1)) ? '\\x00' : '\\0', index + 1);
                break;
            case 0x07:
                flush(index, '\\x07', index + 1);
                break;
            case 0x08:
                flush(index, '\\b', index + 1);
                break;
            case 0x0b:
                flush(index, '\\v', index + 1);
                break;
            case 0x0c:
                flush(index, '\\f', index + 1);
                break;
            case 0x0a:
                if (quote !== '`') flush(index, '\\n', index + 1);
                break;
            case 0x0d:
                flush(index, '\\r', index + 1);
                break;
            case 0x1b:
                flush(index, '\\x1B', index + 1);
                break;
            case 0x5c:
                flush(index, '\\\\', index + 1);
                break;
            case 0x27:
                if (quote === "'") flush(index, "\\'", index + 1);
                break;
            case 0x22:
                if (quote === '"') flush(index, '\\"', index + 1);
                break;
            case 0x60:
                if (quote === '`') flush(index, '\\`', index + 1);
                break;
            case 0x24:
                if (quote === '`' && value.charCodeAt(index + 1) === 0x7b) flush(index, '\\$', index + 1);
                break;
            case 0x3c:
                // `</script` becomes `<\/script`, keeping the tag's own casing.
                if (isScriptCloseTag(value, index)) {
                    flush(index + 1, '\\/', index + 2);
                    index += 7;
                }
                break;
            case 0x2028:
                flush(index, '\\u2028', index + 1);
                break;
            case 0x2029:
                flush(index, '\\u2029', index + 1);
                break;
            case 0xa0:
                flush(index, '\\xA0', index + 1);
                break;
            default:
                if (code >= 0xd800 && code <= 0xdfff) {
                    const isHigh = code <= 0xdbff;
                    const next = value.charCodeAt(index + 1);
                    if (isHigh && next >= 0xdc00 && next <= 0xdfff) {
                        index++;
                        break;
                    }
                    // A lone surrogate: oxc prints it as a lowercase `\uXXXX` escape.
                    flush(index, `\\u${code.toString(16)}`, index + 1);
                }
        }
    }
    return out + value.slice(chunkStart) + quote;
}

/** oxc's `print_space_before_identifier`: separate from a preceding identifier character. */
function spaceBeforeIdentifier(p: Printer): void {
    const last = p.lastChar;
    if (last === '') return;
    const code = last.charCodeAt(0);
    const identifierPart =
        (code >= 0x61 && code <= 0x7a) ||
        (code >= 0x41 && code <= 0x5a) ||
        isAsciiDigit(code) ||
        code === 0x5f ||
        code === 0x24 ||
        code > 0x7f;
    if (identifierPart) write(p, ' ');
}

/** oxc's `print_space_before_operator` for a leading unary `-`: `a- -1`, never `a--1`. */
function writeMinus(p: Printer): void {
    space(p);
    write(p, '-');
}

/** oxc's `print_non_negative_float`, including its record that a following `.` needs a space
 *  (`0 .toString()`), which only a literal without `.`, `e` or `x` requires. */
function writeNonNegativeNumber(p: Printer, value: number): void {
    const literal = numberLiteral(value);
    write(p, literal);
    if (!/[.ex]/.test(literal)) p.needSpaceBeforeDot = p.len;
}

/** oxc's `GenExpr for NumericLiteral` outside TypeScript context: printed from the value, never the raw text. */
export function printNumber(p: Printer, value: number, minPrec: Prec): void {
    if (Number.isNaN(value)) {
        spaceBeforeIdentifier(p);
        write(p, 'NaN');
        return;
    }
    const negative = value < 0 || Object.is(value, -0);
    if (!Number.isFinite(value)) {
        const wrap = (p.opts.minify && Prec.Multiplicative < minPrec) || (negative && Prec.Unary < minPrec);
        if (wrap) write(p, '(');
        if (negative) writeMinus(p);
        else spaceBeforeIdentifier(p);
        write(p, p.opts.minify ? '1/0' : 'Infinity');
        if (wrap) write(p, ')');
        return;
    }
    if (!negative) {
        spaceBeforeIdentifier(p);
        writeNonNegativeNumber(p, value);
    } else if (Prec.Unary < minPrec) {
        write(p, '(-');
        writeNonNegativeNumber(p, -value);
        write(p, ')');
    } else {
        writeMinus(p);
        writeNonNegativeNumber(p, -value);
    }
}

/** oxc's `GenExpr for BigIntLiteral`: the base-10 value without separators, whatever the source spelling. */
export function printBigInt(p: Printer, value: bigint, minPrec: Prec): void {
    spaceBeforeIdentifier(p);
    const negative = value < 0n;
    if (negative && Prec.Unary < minPrec) {
        write(p, `(${value}n)`);
        return;
    }
    // oxc omits this separator and prints `a--5n`, which does not parse.
    if (negative) space(p);
    write(p, `${value}n`);
}

/** A directive's raw text re-quoted, as oxc's `Gen for Directive`: the text is kept verbatim (a
 *  `"use strict"` may not gain an escape), in `"` unless the first unescaped quote inside is one. */
export function directiveText(raw: string): string {
    let quote = '"';
    for (let index = 0; index < raw.length; index++) {
        const char = raw[index];
        if (char === '"') {
            quote = "'";
            break;
        }
        if (char === "'") break;
        if (char === '\\') index++;
    }
    return quote + raw + quote;
}

/** `value` as oxc prints it in an assignment-expression or argument position (`{ A: -1 }`,
 *  `return -1`), for output assembled outside the printer. No form needs parentheses there. */
export function constantText(value: ConstantValue, minify: boolean): string {
    switch (value.kind) {
        case 'number': {
            const number = value.value;
            if (Number.isNaN(number)) return 'NaN';
            const negative = number < 0 || Object.is(number, -0);
            const sign = negative ? '-' : '';
            if (!Number.isFinite(number)) return sign + (minify ? '1/0' : 'Infinity');
            return sign + numberLiteral(negative ? -number : number);
        }
        case 'bigint':
            return `${value.value}n`;
        case 'string':
            return quoteString(value.value, minify, true);
        case 'boolean':
            return value.value ? 'true' : 'false';
        case 'null':
            return 'null';
        case 'undefined':
            return 'void 0';
    }
}
