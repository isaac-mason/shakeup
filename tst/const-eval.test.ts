import { describe, expect, it } from 'vitest';
import {
    type ConstEvalContext,
    evaluateValue,
    type GlobalContext,
    isUnresolvedReference,
    valueType,
} from '../src/analysis/const-eval.ts';
import type { ConstantValue } from '../src/analysis/constant-value.ts';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { N, type Node } from '../src/ast/index.ts';
import { parseProgram } from '../src/parser/index.ts';

/** Evaluate the last expression statement of `source`. Top-level `const` initialisers are
 *  evaluated first and feed `constantOf`, the way rolldown's scanner fills its constant map. */
function evaluate(source: string): ConstantValue | null {
    const program = parseProgram(source, { ts: false, jsx: false });
    const semantic = createSemantic();
    analyze(semantic, program, true);
    const constants = new Map<number, ConstantValue>();
    const ctx: ConstEvalContext = { constantOf: (ident) => constants.get(ident.sym) ?? null };
    let last: Node | null = null;
    for (const statement of program.data.body) {
        if (statement.type === N.VariableDeclaration) {
            for (const declarator of statement.data.declarations) {
                if (declarator.type !== N.VariableDeclarator || declarator.data.init === null) continue;
                const value = evaluateValue(declarator.data.init, ctx);
                if (value !== null) constants.set(declarator.data.id.sym, value);
            }
        } else if (statement.type === N.ExpressionStatement) {
            last = statement.data.expression;
        }
    }
    if (last === null) throw new Error(`no expression statement in ${source}`);
    return evaluateValue(last, ctx);
}

function typeOf(source: string): string {
    const program = parseProgram(source, { ts: false, jsx: false });
    analyze(createSemantic(), program, true);
    const statement = program.data.body[0];
    if (statement.type !== N.ExpressionStatement) throw new Error(`not an expression statement: ${source}`);
    return valueType(statement.data.expression, ROLLDOWN_GLOBALS);
}

/** rolldown's `GlobalContext`: unresolved references are globals, and no reference has a known value type. */
const ROLLDOWN_GLOBALS: GlobalContext = {
    isGlobalReference: isUnresolvedReference,
    constantValueForReference: () => null,
    valueTypeForReference: () => null,
};

const number = (value: number): ConstantValue => ({ kind: 'number', value });
const string = (value: string): ConstantValue => ({ kind: 'string', value });
const boolean = (value: boolean): ConstantValue => ({ kind: 'boolean', value });
const bigint = (value: bigint): ConstantValue => ({ kind: 'bigint', value });
/** A string built from UTF-16 code units, so non-ASCII expectations stay escaped in source. */
const units = (...codes: number[]): string => String.fromCharCode(...codes);
const UNDEFINED: ConstantValue = { kind: 'undefined' };
const NULL: ConstantValue = { kind: 'null' };

const cases = (table: [string, ConstantValue | null][]) => {
    for (const [source, expected] of table) {
        it(source, () => {
            const result = evaluate(source);
            expect(result).toEqual(expected);
            if (expected !== null && expected.kind === 'number' && result !== null && result.kind === 'number') {
                expect(Object.is(result.value, expected.value)).toBe(true);
            }
        });
    }
};

describe('literals and identifiers', () => {
    cases([
        ['1', number(1)],
        ['0x1F', number(31)],
        ['1_000', number(1000)],
        ['.5', number(0.5)],
        ['"a"', string('a')],
        ["'a\\x41\\u0042\\u{43}\\n'", string('aABC\n')],
        ['"\\uD83D\\uDE00"', string('\u{1F600}')],
        ['"\\uD800"', null],
        ['true', boolean(true)],
        ['null', NULL],
        ['1n', bigint(1n)],
        ['0x10n', bigint(16n)],
        ['undefined', UNDEFINED],
        ['NaN', number(Number.NaN)],
        ['Infinity', number(Number.POSITIVE_INFINITY)],
        ['foo', null],
        ['const undefined = 5; undefined', number(5)],
        ['const a = "x"; a', string('x')],
        // oxc does not evaluate template literals unless the target is a string.
        ['`abc`', null],
        ['`a${1}b` + ""', string('a1b')],
        ['`a${x}b` + ""', null],
        ['`\\uD800` + ""', null],
        ['/a/', null],
    ]);
});

describe('value_type (oxc value_type.rs)', () => {
    const table: [string, string][] = [
        ['1n', 'bigint'],
        ['true', 'boolean'],
        ['null', 'null'],
        ['0', 'number'],
        ["('')", 'string'],
        ['``', 'string'],
        ['({})', 'object'],
        ['[]', 'object'],
        ['/a/', 'object'],
        ['(function () {})', 'object'],
        ['(() => {})', 'object'],
        ['(class {})', 'object'],
        ['import.meta', 'object'],
        ['undefined', 'undefined'],
        ['NaN', 'number'],
        ['foo', 'undetermined'],
        ['void foo', 'undefined'],
        ['-0n', 'bigint'],
        ['-true', 'number'],
        ['-foo', 'undetermined'],
        ['~0n', 'bigint'],
        ['+foo', 'number'],
        ['!foo', 'boolean'],
        ['delete foo', 'boolean'],
        ['typeof foo', 'string'],
        ["'foo' + bar", 'string'],
        ['foo + 1', 'undetermined'],
        ['true + undefined', 'number'],
        ['true + 0n', 'undetermined'],
        ['({} + [])', 'string'],
        ['1n - 0n', 'bigint'],
        ['1 - 0n', 'number'],
        ['foo - 1n', 'bigint'],
        ['foo - bar', 'undetermined'],
        ['1n >>> 0n', 'number'],
        ['foo * bar * 1n', 'bigint'],
        ['foo instanceof Object', 'boolean'],
        ["'foo' in foo", 'boolean'],
        ['(1, 2n)', 'bigint'],
        ['a = 1', 'number'],
        ["a += ''", 'string'],
        ['a += 1', 'undetermined'],
        ['a -= 1', 'number'],
        ['a -= 1n', 'bigint'],
        ['a -= {}', 'undetermined'],
        ['a >>>= 1n', 'number'],
        ['foo ? 1 : 0', 'number'],
        ["foo ? 1 : 'bar'", 'undetermined'],
        ['foo1 === foo2 && bar1 !== bar2', 'boolean'],
        ['+foo && (bar1 !== bar2)', 'undetermined'],
        ['+foo ?? (bar1 !== bar2)', 'number'],
        ['(void foo) ?? (bar1 !== bar2)', 'boolean'],
        ['foo++', 'undetermined'],
        ['foo ||= 1', 'undetermined'],
        ['this', 'undetermined'],
        ['foo()', 'undetermined'],
        ['foo.bar', 'undetermined'],
        ['new foo()', 'undetermined'],
        ['new Date()', 'object'],
        ['Number.POSITIVE_INFINITY', 'number'],
        // rolldown does not override `value_type_for_reference_id`.
        ['const a = 1; a', 'undetermined'],
    ];
    for (const [source, expected] of table) {
        it(source, () => {
            if (source.startsWith('const ')) {
                const program = parseProgram(source, { ts: false, jsx: false });
                analyze(createSemantic(), program, true);
                const statement = program.data.body[1];
                if (statement.type !== N.ExpressionStatement) throw new Error('expected an expression statement');
                expect(valueType(statement.data.expression, ROLLDOWN_GLOBALS)).toBe(expected);
                return;
            }
            expect(typeOf(source)).toBe(expected);
        });
    }
});

describe('constants', () => {
    cases([
        ['const a = 1; a + 1', number(2)],
        ['const a = 1; const b = a * 3; b', number(3)],
        // Both sides undetermined: oxc cannot pick an addition.
        ['const a = 1; const b = 2; a + b', null],
        // oxc quirk: an identifier's value type is undetermined, so `+` with a number takes the numeric path.
        ['const s = "x"; s + 1', number(Number.NaN)],
        ['const s = "x"; s + "y"', string('xy')],
        ['const s = "ab"; s.length', number(2)],
    ]);
});

describe('binary arithmetic', () => {
    cases([
        ['1 + 2', number(3)],
        ['"a" + 1', string('a1')],
        ['1 + "a"', string('1a')],
        ['1 + null', number(1)],
        ['true + 1', number(2)],
        ['1 + undefined', number(Number.NaN)],
        ['"a" + [1, 2]', string('a1,2')],
        ['({}) + ""', string('[object Object]')],
        ['({ toString() {} }) + ""', null],
        ['1n + 2n', bigint(3n)],
        ['1n + 1', null],
        ['5 - 2', number(3)],
        ['"5" - 2', number(3)],
        ['1 / 0', number(Number.POSITIVE_INFINITY)],
        ['5 % 0', number(Number.NaN)],
        ['5 % 3', number(2)],
        ['-5 % 3', number(-2)],
        ['2 * 3', number(6)],
        ['2 ** 3', number(8)],
        ['2 ** 0.5', null],
        ['10 ** 4', number(10000)],
        ['10 ** 5', null],
        ['2 ** -1', null],
        ['1 / 0 ** -1', number(0)],
        // Rust `powf` quirks: C `pow` returns 1 here where JS returns NaN.
        ['1 ** NaN', number(1)],
        ['(-1) ** Infinity', number(1)],
        ['NaN ** 0', number(1)],
        ['2n ** 3n', null],
        ['1 << 31', number(-2147483648)],
        ['1 << 32', number(1)],
        ['-1 >> 28', number(-1)],
        ['-1 >>> 28', number(15)],
        ['4294967296.5 >>> 0', number(0)],
        ['5 & 3', number(1)],
        ['5 | 3', number(7)],
        ['5 ^ 3', number(6)],
        ['5n & 3n', bigint(1n)],
        ['5n | 3n', bigint(7n)],
        ['5n ^ 3n', bigint(6n)],
        ['5n & 3', null],
        ['"5" & 3', number(1)],
        ['1 in x', null],
    ]);
});

describe('comparison', () => {
    cases([
        ['1 < 2', boolean(true)],
        ['2 < 1', boolean(false)],
        ['1 <= 1', boolean(true)],
        ['1 >= 2', boolean(false)],
        ['2 > 1', boolean(true)],
        ['"a" < "b"', boolean(true)],
        ['"\\uFF61" < "\\uD83D\\uDE00"', boolean(false)],
        ['NaN < 1', boolean(false)],
        ['1 <= NaN', boolean(false)],
        ['NaN >= NaN', boolean(false)],
        ['undefined < 1', boolean(false)],
        ['null < 1', boolean(true)],
        ['"1" < 2', boolean(true)],
        ['1n < 2', boolean(true)],
        ['1 < 2n', boolean(true)],
        ['1n < 1.5', boolean(true)],
        ['2n > 1.5', boolean(true)],
        ['-1n < -1.5', boolean(false)],
        ['1n < Infinity', boolean(true)],
        ['1n < NaN', boolean(false)],
        ['"1" < 2n', boolean(true)],
        ['"x" < 1n', boolean(false)],
        ['1n <= "x"', boolean(false)],
        // oxc quirk: StringToBigInt rejects a leading 0 without a radix prefix.
        ['"012" < 13n', boolean(false)],
        ['x < 1', null],
        ['[] < 1', null],
    ]);
});

describe('equality', () => {
    cases([
        ['1 == "1"', boolean(true)],
        ['"1" == 1', boolean(true)],
        ['null == undefined', boolean(true)],
        ['null === undefined', boolean(false)],
        ['null === null', boolean(true)],
        ['"a" === "a"', boolean(true)],
        ['"a" !== "b"', boolean(true)],
        ['1 === 1', boolean(true)],
        ['0 === -0', boolean(true)],
        ['NaN === NaN', boolean(false)],
        ['NaN == NaN', boolean(false)],
        ['x === NaN', boolean(false)],
        ['1n == "1"', boolean(true)],
        ['1n == 1n', boolean(true)],
        ['1n === 1n', boolean(true)],
        ['16n == "0x10"', boolean(true)],
        ['1000n == "1_000"', boolean(true)],
        ['true == 1', boolean(true)],
        ['true == "1"', boolean(true)],
        ['false == ""', boolean(true)],
        ['true === true', boolean(true)],
        ['({}) == 1', null],
        ['[] === []', null],
        ['[] == null', boolean(false)],
        ['x == 1', null],
        ['"a" == 1', boolean(false)],
    ]);
});

describe('instanceof', () => {
    cases([
        ['[] instanceof Object', boolean(true)],
        ['({}) instanceof Object', boolean(true)],
        ['({ a: 1 }) instanceof Object', null],
        ['(() => {}) instanceof Object', boolean(true)],
        ['1 instanceof Object', boolean(false)],
        ['[] instanceof String', boolean(false)],
        ['x instanceof Object', null],
        ['[] instanceof Array', null],
        ['const Object = 1; [] instanceof Object', null],
    ]);
});

describe('unary', () => {
    cases([
        ['typeof 1', string('number')],
        ['typeof 1n', string('bigint')],
        ['typeof ""', string('string')],
        ['typeof true', string('boolean')],
        ['typeof undefined', string('undefined')],
        ['typeof null', string('object')],
        ['typeof {}', string('object')],
        ['typeof []', string('object')],
        ['typeof function () {}', string('function')],
        ['typeof class {}', string('function')],
        ['typeof /a/', null],
        ['typeof x', null],
        ['void x', UNDEFINED],
        ['!0', boolean(true)],
        ['!"a"', boolean(false)],
        ['![]', boolean(false)],
        ['!x', null],
        // oxc skips binary expressions evaluated for a boolean target.
        ['!(1 === 1)', null],
        ['+"5"', number(5)],
        ['+""', number(0)],
        ['+"  5"', number(5)],
        // oxc quirk: StringToNumber trims only leading whitespace.
        ['+"5 "', number(Number.NaN)],
        ['+"0x10"', number(16)],
        ['+"0b101"', number(5)],
        // oxc quirk: the hex fast path is `u32::from_str_radix`, which accepts a `+`.
        ['+"0x+1"', number(1)],
        ['+"1_0"', number(Number.NaN)],
        ['+"-Infinity"', number(Number.NEGATIVE_INFINITY)],
        ['+"infinity"', number(Number.NaN)],
        ['+"1e3"', number(1000)],
        ['+"1."', number(1)],
        ['+[]', number(0)],
        ['+[5]', number(5)],
        ['+[1, 2]', number(Number.NaN)],
        ['+{}', number(Number.NaN)],
        ['+true', number(1)],
        ['+null', number(0)],
        // oxc quirk: ToNumber(!x) maps a NaN operand to 0.
        ['+!undefined', number(0)],
        ['-1', number(-1)],
        ['-0', number(-0)],
        ['-NaN', number(Number.NaN)],
        ['-null', number(-0)],
        ['-undefined', number(Number.NaN)],
        // oxc only negates number, bigint, null and undefined operands.
        ['-"1"', null],
        ['-true', null],
        ['-1n', bigint(-1n)],
        ['~5', number(-6)],
        ['~5n', bigint(-6n)],
        ['~"5"', number(-6)],
        ['delete x', null],
    ]);
});

describe('logical and sequence', () => {
    cases([
        ['1 && 2', number(2)],
        ['0 && x', number(0)],
        ['0 || "a"', string('a')],
        ['1 || x', number(1)],
        ['x || 1', null],
        ['x ?? 1', null],
        ['null ?? 1', null],
        ['(x, 1)', number(1)],
        ['(1, x)', null],
    ]);
});

describe('member length', () => {
    cases([
        ['"abc".length', number(3)],
        ['"\\u{1F600}".length', number(2)],
        ['"abc"["length"]', number(3)],
        ['[1, , 3].length', number(3)],
        ['[f()].length', number(1)],
        ['[...a].length', null],
        ['"abc".size', null],
        ['x.length', null],
    ]);
});

describe('string methods (oxc replace_known_methods.rs)', () => {
    cases([
        ["'abcdef'.indexOf('g')", number(-1)],
        ["'abcdef'.indexOf('b')", number(1)],
        ["'abcdefbe'.indexOf('b', 2)", number(6)],
        ["'abcdef'.indexOf('bcd')", number(1)],
        ["'abcdefsdfasdfbcdassd'.indexOf('bcd', 4)", number(13)],
        ["'abcdef'.indexOf(...a, 1)", null],
        ["'abcdef'.indexOf('b', ...a)", null],
        ["'abcdef'.indexOf(a, 1)", null],
        ["'abcdef'.indexOf('b', a)", null],
        ["'abcdef'.indexOf()", number(-1)],
        ["'abcdef'.lastIndexOf('b')", number(1)],
        ["'abcdefbe'.lastIndexOf('b')", number(6)],
        ["'abcdefbe'.lastIndexOf('b', 5)", number(1)],
        ["'abc1def'.indexOf(1)", number(3)],
        ["'abcNaNdef'.indexOf(NaN)", number(3)],
        ["'abcundefineddef'.indexOf(undefined)", number(3)],
        ["'abcnulldef'.indexOf(null)", number(3)],
        ["'abctruedef'.indexOf(true)", number(3)],
        ["'abcdef/b./'.indexOf(/b./)", number(6)],
        ["'abcdef[object Object]'.indexOf({a:2})", number(6)],
        ["'abcdef1,2'.indexOf([1,2])", number(6)],
        ['1 .indexOf("bcd")', null],
        ["`abcdef`.indexOf('b')", null],
        // Rust quirk: the result is a UTF-8 byte offset.
        ["'\\u00e9b'.indexOf('b')", number(2)],
        ["'\\u00e9b'.lastIndexOf('b')", number(2)],

        ["'abcde'.substring(0,2)", string('ab')],
        ["'abcde'.substring(1,2)", string('b')],
        ["'abcde'.substring(2)", string('cde')],
        ["'abcde'.substring(...a, 1)", null],
        ["'abcde'.substring(a, 1)", null],
        ["'abcde'.substring(-1)", null],
        ["'abcde'.substring(1, -2)", null],
        ["'abcde'.substring(1, 2, 3)", null],
        ["'abcde'.substring(2, 0)", null],
        ["'a'.substring(0, 2)", null],
        ["'abcde'.slice(0,2)", string('ab')],
        ["'abcde'.slice(2)", string('cde')],
        ["'abcde'.slice(-1)", null],
        // Rust quirk: bounds are checked against the UTF-8 length, then applied to chars.
        ["'\\u{1F600}a'.slice(1, 2)", string('a')],
        ["'\\u00e9'.substring(0, 2)", string(units(0xe9))],

        ["'abcde'.charAt(0)", string('a')],
        ["'abcde'.charAt(4)", string('e')],
        ["'abcde'.charAt(5)", string('')],
        ["'abcde'.charAt(-1)", string('')],
        ["'abcde'.charAt()", string('a')],
        ["'abcde'.charAt(0.5)", string('a')],
        ["'abcde'.charAt(Infinity)", string('')],
        ["'abcde'.charAt(...foo)", null],
        ["'abcde'.charAt(0, ++z)", null],
        ["'abcde'.charAt(y)", null],
        ["'abcde'.charAt(null)", string('a')],
        ["'abcde'.charAt(!0)", string('b')],
        ["'\\ud834\\udd1e'.charAt(0)", null],
        ["'\\ud834\\udd1e'.charAt(1)", null],

        ["'abcde'.charCodeAt()", number(97)],
        ["'abcde'.charCodeAt(1)", number(98)],
        ["'abcde'.charCodeAt(5)", number(Number.NaN)],
        ["'abcde'.charCodeAt(-1)", number(Number.NaN)],
        ["'abcde'.charCodeAt(NaN)", number(97)],
        ["'abcde'.charCodeAt(...foo)", null],
        ["'abcde'.charCodeAt(y)", null],
        ["'abcde'.charCodeAt(0, ++z)", null],
        // rolldown's ConstEvalCtx treats every callee as manually pure, so `f()` has no side effects.
        ["'abcde'.charCodeAt(0, f())", number(97)],
        ["'abcde'.charCodeAt(0, 1)", number(97)],
        ["'abcde'.charCodeAt(null)", number(97)],
        ["'abcde'.charCodeAt(true)", number(98)],
        ["'\\ud834\\udd1e'.charCodeAt(0)", number(55348)],
        ["'\\ud834\\udd1e'.charCodeAt(1)", number(56606)],

        ["'production'.startsWith('prod')", boolean(true)],
        ["'production'.startsWith('dev')", boolean(false)],
        ["'production'.startsWith('prod', 'bar')", null],
        ["'production'.startsWith(x)", null],

        ["'c'.replace('c','x')", string('x')],
        ["'acaca'.replace('c','x')", string('axaca')],
        ["'ab'.replace('','x')", string('xab')],
        // rolldown's ConstEvalCtx treats every callee as manually pure, so `foo()` has no side effects.
        ["'c'.replace((foo(), 'c'), 'b')", string('b')],
        ["'[object Object]'.replace({}, 'x')", null],
        ["'acaca'.replace(/c/,'x')", null],
        ["'Xyz'.replace('Xyz', '$$')", null],
        ["'abcde'.replaceAll('bcd','c')", string('ace')],
        ["'abcde'.replaceAll('c','xxx')", string('abxxxde')],
        ["'abcde'.replaceAll('xxx','c')", string('abcde')],
        ["'ab'.replaceAll('','x')", string('xaxbx')],
        ["'c_c_c'.replaceAll('c','x')", string('x_x_x')],
        ["'acaca'.replaceAll('c',/x/)", string('a/x/a/x/a')],
        // Rust quirk: an empty pattern matches between chars, not UTF-16 units.
        ["'\\u{1F600}'.replaceAll('','x')", string('x\u{1F600}x')],
        ['x.replace("x", "c")', null],
    ]);
});

describe('string casing and trim', () => {
    cases([
        ["'a'.toUpperCase()", string('A')],
        ["'aBcDe'.toUpperCase()", string('ABCDE')],
        ["'\\u0131'.toUpperCase()", string('I')],
        ["'\\u0130'.toLowerCase()", string(units(0x69, 0x307))],
        ["'\\u00df'.toUpperCase()", string('SS')],
        ["'\\u03a3\\u03a3'.toLowerCase()", string(units(0x3c3, 0x3c2))],
        ["'aBcDe'.toLowerCase()", string('abcde')],
        ['`abc`.toUpperCase()', null],
        ["'abc'.toUpperCase(1)", null],
        ['const env = "Production"; env.toLowerCase()', string('production')],
        ['env.toLowerCase()', null],
        ["'  abc  '.trim()", string('abc')],
        ["'  abc  '.trimStart()", string('abc  ')],
        ["'  abc  '.trimEnd()", string('  abc')],
        ["'abc'.trim(1)", null],
        // Rust `str::trim` whitespace: NEL is trimmed, BOM is not.
        ["'\\u0085a'.trim()", string('a')],
        ["'\\uFEFFa'.trim()", string(units(0xfeff, 0x61))],
    ]);
});

describe('String.fromCharCode and toString', () => {
    cases([
        ['String.fromCharCode()', string('')],
        ['String.fromCharCode(120, 121)', string('xy')],
        ['String.fromCharCode(0x10078)', string('x')],
        ['String.fromCharCode(0x1_0000_FFFF)', string(units(0xffff))],
        ['String.fromCharCode(NaN)', string('\0')],
        ["String.fromCharCode('123')", string('{')],
        ['String.fromCharCode(55358, 56768)', null],
        ['String.fromCharCode(x)', null],
        ["Unknown.fromCharCode('0.5')", null],
        ['const String = {}; String.fromCharCode(120)', null],

        ["false['toString']()", string('false')],
        ['false.toString()', string('false')],
        ['(!0).toString()', string('true')],
        ["'xy'.toString()", string('xy')],
        ['0 .toString()', string('0')],
        ['123 .toString()', string('123')],
        ['NaN.toString()', string('NaN')],
        // A radix only folds on a numeric literal; `NaN` here is an identifier.
        ['NaN.toString(2)', null],
        ['Infinity.toString()', string('Infinity')],
        ['1n.toString()', string('1')],
        ['254n.toString(16)', null],
        ['null.toString()', null],
        ['undefined.toString()', null],
        // rolldown's ConstEvalCtx treats every callee as manually pure, so `f()` has no side effects.
        ['(f(), 5).toString()', string('5')],
        ['100 .toString(0)', null],
        ['100 .toString(1)', null],
        ['100 .toString(2)', string('1100100')],
        ['100 .toString(13)', string('79')],
        ['10000 .toString(19)', string('18d6')],
        ['1000000 .toString(36)', string('lfls')],
        ['0 .toString(36)', string('0')],
        ['0.5.toString()', string('0.5')],
        ['0.5.toString(2)', null],
        ['1e99.toString(2)', null],
        ['/a/g.toString()', string('/a/g')],
        ['/./.toString(b)', null],
        ['123 .toString(b)', null],
    ]);
});

describe('Number methods', () => {
    cases([
        ['Number.isSafeInteger(1)', boolean(true)],
        ['Number.isSafeInteger(1.5)', boolean(false)],
        ['Number.isSafeInteger(9007199254740991)', boolean(true)],
        ['Number.isSafeInteger(9007199254740992)', boolean(false)],
        ['Number.isFinite(1.5)', boolean(true)],
        ['Number.isInteger(2)', boolean(true)],
        ['Number.isInteger(2.5)', boolean(false)],
        ['Number.isNaN(1)', boolean(false)],
        ["Number.isFinite('a')", null],
        ['Number.isFinite(NaN)', null],
        ['Number.isFinite(1n)', null],
        ['Number.isNaN(+(void unknown()))', null],
    ]);
});

describe('Math', () => {
    cases([
        ['Math.abs(Math.random())', null],
        ["Math.abs('-1')", number(1)],
        ['Math.abs(-2)', number(2)],
        ['Math.abs(null)', number(0)],
        ["Math.abs('')", number(0)],
        ['Math.abs(NaN)', number(Number.NaN)],
        ['Math.abs(-0)', number(0)],
        ['Math.abs(-Infinity)', number(Number.POSITIVE_INFINITY)],
        ['Math.abs([])', number(0)],
        ['Math.abs([2])', number(2)],
        ['Math.abs([1,2])', number(Number.NaN)],
        ['Math.abs({})', number(Number.NaN)],
        ['Math.abs(1, 2)', null],
        ['Math.abs(...a)', null],
        ['Math.imul()', number(0)],
        ['Math.imul(-1,1)', number(-1)],
        ['Math.imul(2)', number(0)],
        ['Math.imul(2,3,5)', number(6)],
        ['Math.imul(0xfffffffe, 5)', number(-10)],
        ['Math.imul(0xfffffffffffff34f, 0xfffffffffff342)', number(13369344)],
        ['Math.imul(NaN, 2)', number(0)],
        ['Math.ceil(1.3)', number(2)],
        ['Math.ceil(-1.3)', number(-1)],
        ['Math.floor(-1.3)', number(-2)],
        ['Math.fround(NaN)', number(Number.NaN)],
        ['Math.fround(16777217)', number(16777216)],
        ['Math.fround(1.2)', null],
        ['Math.round(NaN)', number(Number.NaN)],
        ['Math.round(3.5)', number(4)],
        ['Math.round(-3.5)', number(-3)],
        ['Math.round(2.4)', number(2)],
        ['Math.round(-2.6)', number(-3)],
        ['Math.round(-0.4)', number(-0)],
        // oxc quirk: a fraction within 2^-52 of one half is ceiled.
        ['Math.round(0.49999999999999994)', number(1)],
        ['Math.sign(NaN)', number(Number.NaN)],
        ['Math.sign(0.0)', number(0)],
        ['Math.sign(-0.0)', number(-0)],
        ['Math.sign(-3.5)', number(-1)],
        ['Math.sign(-Infinity)', number(-1)],
        ['Math.trunc(-0.5)', number(-0)],
        ['Math.clz32(0)', number(32)],
        ['Math.clz32(1)', number(31)],
        ["Math.clz32('52')", number(26)],
        ['Math.clz32([52, 53])', number(32)],
        ['Math.clz32(0x100000001)', number(31)],
        ['Math.clz32(-1)', number(0)],
        ['Math.clz32(-2147483649)', number(1)],
        ['Math.clz32(Infinity)', number(32)],
        ['Math.max()', number(Number.NEGATIVE_INFINITY)],
        ['Math.max(0, 1, -1, 200)', number(200)],
        ['Math.max(0, -1, -Infinity, NaN)', number(Number.NaN)],
        ['Math.max(0, -0)', number(0)],
        ['Math.max(-0, 0)', number(0)],
        ['Math.max(...a, 1)', null],
        ['Math.min()', number(Number.POSITIVE_INFINITY)],
        ['Math.min(0, 1, -1, 200)', number(-1)],
        ['Math.min(0, -0)', number(-0)],
        ['Math.min(-0, 0)', number(-0)],
        ['Math.sqrt()', null],
        ['Math.sqrt(1, 2)', null],
        ['Math.sqrt(a)', null],
        ['Math.sqrt(2n)', null],
        ['Math.sqrt(Infinity)', number(Number.POSITIVE_INFINITY)],
        ['Math.sqrt(-0)', number(-0)],
        ['Math.sqrt(-1)', number(Number.NaN)],
        ['Math.sqrt(-Infinity)', number(Number.NaN)],
        ['Math.sqrt(4)', number(2)],
        ['Math.sqrt(2)', null],
        ['Math.cbrt(8)', number(2)],
        ['Math.cbrt(2)', null],
        ['Unknown.sqrt(1)', null],
        ['Math.pow(2, 3)', null],
        ['const Math = { abs() {} }; Math.abs(1)', null],
    ]);
});

describe('URI functions', () => {
    cases([
        ['encodeURI()', string('undefined')],
        ["encodeURI('hello world')", string('hello%20world')],
        ["encodeURI('http://example.com/path?a=1&b=2#hash')", string('http://example.com/path?a=1&b=2#hash')],
        ["encodeURI('a;b,c/d?e:f@g&h=i+j$k')", string('a;b,c/d?e:f@g&h=i+j$k')],
        ["encodeURI('ABC-_abc.!~*()123')", string('ABC-_abc.!~*()123')],
        ["encodeURI('hello<>\"')", string('hello%3C%3E%22')],
        ["encodeURI('hello\\t\\n')", string('hello%09%0A')],
        ["encodeURI('caf\\u00e9')", string('caf%C3%A9')],
        ["encodeURI('\\u6d4b\\u8bd5')", string('%E6%B5%8B%E8%AF%95')],
        ["encodeURI('a', 'b')", null],
        ['encodeURI(x)', null],
        ["encodeURIComponent('a;b,c/d?e:f@g&h=i+j$k')", string('a%3Bb%2Cc%2Fd%3Fe%3Af%40g%26h%3Di%2Bj%24k')],
        ["encodeURIComponent('#')", string('%23')],
        ["decodeURI('hello%20world')", string('hello world')],
        ["decodeURI('a%3Bb%2Cc%2Fd%3Fe%3Af%40g%26h%3Di%2Bj%24k')", string('a%3Bb%2Cc%2Fd%3Fe%3Af%40g%26h%3Di%2Bj%24k')],
        ["decodeURI('%2f')", string('%2f')],
        ["decodeURI('%23hash')", string('%23hash')],
        ["decodeURI('caf%C3%A9')", string(`caf${units(0xe9)}`)],
        ["decodeURI('%ZZ')", null],
        ["decodeURI('%A')", null],
        ["decodeURI('%C3')", null],
        ["decodeURI('%EF%BB%BFa')", string(units(0xfeff, 0x61))],
        ["decodeURIComponent('a%3Bb%2Cc%2Fd%3Fe%3Af%40g%26h%3Di%2Bj%24k')", string('a;b,c/d?e:f@g&h=i+j$k')],
        ["decodeURIComponent('%23')", string('#')],
        ["decodeURIComponent('%E6%B5%8B%E8%AF%95')", string(units(0x6d4b, 0x8bd5))],
        ["decodeURIComponent('%ED%A0%80')", null],
        ['const encodeURI = (value) => value; encodeURI("a b")', null],
    ]);
});

describe('global isNaN, isFinite, parseFloat, parseInt', () => {
    cases([
        ['isNaN()', boolean(true)],
        ['isNaN(NaN)', boolean(true)],
        ["isNaN('123')", boolean(false)],
        ["isNaN('abc')", boolean(true)],
        ["isNaN(' ')", boolean(false)],
        ['isNaN(unknown)', null],
        ['isFinite()', boolean(false)],
        ["isFinite('123')", boolean(true)],
        ['isFinite(-Infinity)', boolean(false)],
        ['isFinite(unknown)', null],

        ["parseInt('123')", number(123)],
        ["parseInt(' 123')", number(123)],
        ["parseInt('0xA')", number(10)],
        ["parseInt('0xA', 16)", number(10)],
        ["parseInt('07', 8)", number(7)],
        ["parseInt('08')", number(8)],
        ["parseInt('-0')", number(-0)],
        ["parseInt(' F', 16)", number(15)],
        ["parseInt('17', 8)", number(15)],
        ["parseInt('1111', 2)", number(15)],
        ["parseInt('12', 13)", null],
        ['parseInt(15.99, 10)', number(15)],
        ['parseInt(-15.99, 10)', number(-15)],
        ["parseInt('FXX123', 16)", number(15)],
        ["parseInt('15px', 10)", number(15)],
        ["parseInt('-0x08')", number(-8)],
        ["parseInt('1', -1)", number(Number.NaN)],
        ["parseInt('0xa', 10)", number(0)],
        ["parseInt('')", number(Number.NaN)],
        ["parseInt('+1')", number(1)],
        ["parseInt('10', 0)", number(10)],
        ["parseInt('-021', 8)", number(-17)],
        ["parseInt('2147483648')", null],
        ["parseInt('123456789012345678901')", null],
        ['parseInt()', number(Number.NaN)],
        ['parseInt(unknown)', null],
        ["parseInt('1', 2, 3)", null],

        ["parseFloat('1.23')", number(1.23)],
        ["parseFloat('-1.23')", number(-1.23)],
        ["parseFloat(' 0.3333')", number(0.3333)],
        ["parseFloat('0100.000')", number(100)],
        ['parseFloat(3.14)', number(3.14)],
        ["parseFloat('-0')", number(-0)],
        ["parseFloat('3.14more non-digit characters')", number(3.14)],
        ["parseFloat('314e-2')", number(3.14)],
        ["parseFloat('0.0314E+2')", number(3.14)],
        ["parseFloat('3.333333333333333333333333')", number(3.3333333333333335)],
        ["parseFloat('.1e1')", number(1)],
        ["parseFloat('0.e1')", number(0)],
        ["parseFloat('')", number(Number.NaN)],
        ["parseFloat('abc')", number(Number.NaN)],
        ["parseFloat('+Infinity')", number(Number.POSITIVE_INFINITY)],
        ["parseFloat('-Infinityx')", number(Number.NEGATIVE_INFINITY)],
        // oxc quirks: underscores are accepted, and a trailing `_` stays in the prefix.
        ["parseFloat('1_1')", number(11)],
        ["parseFloat('1_.5')", number(1.5)],
        ["parseFloat('1_')", number(1)],
        ['parseFloat()', number(Number.NaN)],
        ['parseFloat(unknown)', null],
    ]);
});

describe("side effects under rolldown's ConstEvalCtx", () => {
    // `unknown_global_side_effects`: reading an unknown global may throw.
    it('isNaN((foo, 0))', () => expect(evaluate('isNaN((foo, 0))')).toBeNull());
    it("parseInt((foo, '0'))", () => expect(evaluate("parseInt((foo, '0'))")).toBeNull());
    // `manual_pure_functions` returns true for every callee, so a call is pure when its arguments are.
    it("decodeURI(encodeURI('hello world'))", () =>
        expect(evaluate("decodeURI(encodeURI('hello world'))")).toEqual(string('hello world')));
});
