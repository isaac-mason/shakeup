// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are JS source under test.
// Ported from oxc_minifier/tests/peephole/fold_constants.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { test, testSame } from './harness.ts';

const MAX_SAFE_FLOAT = 9007199254740991;
const NEG_MAX_SAFE_FLOAT = -9007199254740991;
const MAX_SAFE_INT = 9007199254740991;
const NEG_MAX_SAFE_INT = -9007199254740991;

/** Wrapped in a call so the expression is not removed. */
const fold = (source: string, expected: string): void => test(`NOOP(${source})`, `NOOP(${expected})`);

const foldSame = (source: string): void => fold(source, source);

// wrap with a function call so it doesn't get removed.

describe('test_comparison', () => {
    it('(1, 2) !== 2', () => fold('(1, 2) !== 2', '!1'));
    it('({} <= {})', () => foldSame('({} <= {})'));
    it('({} >= {})', () => foldSame('({} >= {})'));
    it('({} > {})', () => foldSame('({} > {})'));
    it('({} < {})', () => foldSame('({} < {})'));
    it('([] <= [])', () => foldSame('([] <= [])'));
    it('([] >= [])', () => foldSame('([] >= [])'));
    it('([] > [])', () => foldSame('([] > [])'));
    it('([] < [])', () => foldSame('([] < [])'));
});

describe('undefined_comparison1', () => {
    it('undefined == undefined', () => fold('undefined == undefined', '!0'));
    it('undefined == null', () => fold('undefined == null', '!0'));
    it('undefined == void 0', () => fold('undefined == void 0', '!0'));
    it('undefined == 0', () => fold('undefined == 0', '!1'));
    it('undefined == 1', () => fold('undefined == 1', '!1'));
    it("undefined == 'hi'", () => fold("undefined == 'hi'", '!1'));
    it('undefined == true', () => fold('undefined == true', '!1'));
    it('undefined == false', () => fold('undefined == false', '!1'));
    it('undefined === undefined', () => fold('undefined === undefined', '!0'));
    it('undefined === null', () => fold('undefined === null', '!1'));
    it('undefined === void 0', () => fold('undefined === void 0', '!0'));
    it('undefined == this', () => fold('undefined == this', 'this == null'));
    it('undefined == x', () => fold('undefined == x', 'x == null'));
    it('undefined != undefined', () => fold('undefined != undefined', '!1'));
    it('undefined != null', () => fold('undefined != null', '!1'));
    it('undefined != void 0', () => fold('undefined != void 0', '!1'));
    it('undefined != 0', () => fold('undefined != 0', '!0'));
    it('undefined != 1', () => fold('undefined != 1', '!0'));
    it("undefined != 'hi'", () => fold("undefined != 'hi'", '!0'));
    it('undefined != true', () => fold('undefined != true', '!0'));
    it('undefined != false', () => fold('undefined != false', '!0'));
    it('undefined !== undefined', () => fold('undefined !== undefined', '!1'));
    it('undefined !== void 0', () => fold('undefined !== void 0', '!1'));
    it('undefined !== null', () => fold('undefined !== null', '!0'));
    it('undefined != this', () => fold('undefined != this', 'this != null'));
    it('undefined != x', () => fold('undefined != x', 'x != null'));
    it('undefined < undefined', () => fold('undefined < undefined', '!1'));
    it('undefined > undefined', () => fold('undefined > undefined', '!1'));
    it('undefined >= undefined', () => fold('undefined >= undefined', '!1'));
    it('undefined <= undefined', () => fold('undefined <= undefined', '!1'));
    it('0 < undefined', () => fold('0 < undefined', '!1'));
    it('true > undefined', () => fold('true > undefined', '!1'));
    it("'hi' >= undefined", () => fold("'hi' >= undefined", '!1'));
    it('null <= undefined', () => fold('null <= undefined', '!1'));
    it('undefined < 0', () => fold('undefined < 0', '!1'));
    it('undefined > true', () => fold('undefined > true', '!1'));
    it("undefined >= 'hi'", () => fold("undefined >= 'hi'", '!1'));
    it('undefined <= null', () => fold('undefined <= null', '!1'));
    it('null == undefined', () => fold('null == undefined', '!0'));
    it('0 == undefined', () => fold('0 == undefined', '!1'));
    it('1 == undefined', () => fold('1 == undefined', '!1'));
    it("'hi' == undefined", () => fold("'hi' == undefined", '!1'));
    it('true == undefined', () => fold('true == undefined', '!1'));
    it('false == undefined', () => fold('false == undefined', '!1'));
    it('null === undefined', () => fold('null === undefined', '!1'));
    it('void 0 === undefined', () => fold('void 0 === undefined', '!0'));
    it('undefined == NaN', () => fold('undefined == NaN', '!1'));
    it('NaN == undefined', () => fold('NaN == undefined', '!1'));
    it('undefined == Infinity', () => fold('undefined == Infinity', '!1'));
    it('Infinity == undefined', () => fold('Infinity == undefined', '!1'));
    it('undefined == -Infinity', () => fold('undefined == -Infinity', '!1'));
    it('-Infinity == undefined', () => fold('-Infinity == undefined', '!1'));
    it('({}) == undefined', () => fold('({}) == undefined', '!1'));
    it('undefined == ({})', () => fold('undefined == ({})', '!1'));
    it('([]) == undefined', () => fold('([]) == undefined', '!1'));
    it('undefined == ([])', () => fold('undefined == ([])', '!1'));
    it('(/a/g) == undefined', () => fold('(/a/g) == undefined', '!1'));
    it('undefined == (/a/g)', () => fold('undefined == (/a/g)', '!1'));
    it('(function(){}) == undefined', () => fold('(function(){}) == undefined', '!1'));
    it('undefined == (function(){})', () => fold('undefined == (function(){})', '!1'));
    it('undefined != NaN', () => fold('undefined != NaN', '!0'));
    it('NaN != undefined', () => fold('NaN != undefined', '!0'));
    it('undefined != Infinity', () => fold('undefined != Infinity', '!0'));
    it('Infinity != undefined', () => fold('Infinity != undefined', '!0'));
    it('undefined != -Infinity', () => fold('undefined != -Infinity', '!0'));
    it('-Infinity != undefined', () => fold('-Infinity != undefined', '!0'));
    it('({}) != undefined', () => fold('({}) != undefined', '!0'));
    it('undefined != ({})', () => fold('undefined != ({})', '!0'));
    it('([]) != undefined', () => fold('([]) != undefined', '!0'));
    it('undefined != ([])', () => fold('undefined != ([])', '!0'));
    it('(/a/g) != undefined', () => fold('(/a/g) != undefined', '!0'));
    it('undefined != (/a/g)', () => fold('undefined != (/a/g)', '!0'));
    it('(function(){}) != undefined', () => fold('(function(){}) != undefined', '!0'));
    it('undefined != (function(){})', () => fold('undefined != (function(){})', '!0'));
    it('this == undefined', () => fold('this == undefined', 'this == null'));
    it('x == undefined', () => fold('x == undefined', 'x == null'));
});

describe('test_undefined_comparison2', () => {
    it('"123" !== void 0', () => fold('"123" !== void 0', '!0'));
    it('"123" === void 0', () => fold('"123" === void 0', '!1'));
    it('void 0 !== "123"', () => fold('void 0 !== "123"', '!0'));
    it('void 0 === "123"', () => fold('void 0 === "123"', '!1'));
});

describe('test_undefined_comparison3', () => {
    it('"123" !== undefined', () => fold('"123" !== undefined', '!0'));
    it('"123" === undefined', () => fold('"123" === undefined', '!1'));
    it('undefined !== "123"', () => fold('undefined !== "123"', '!0'));
    it('undefined === "123"', () => fold('undefined === "123"', '!1'));
});

describe('test_null_comparison1', () => {
    it('null == undefined', () => fold('null == undefined', '!0'));
    it('null == null', () => fold('null == null', '!0'));
    it('null == void 0', () => fold('null == void 0', '!0'));
    it('null == 0', () => fold('null == 0', '!1'));
    it('null == 1', () => fold('null == 1', '!1'));
    it('null == 0n', () => fold('null == 0n', '!1'));
    it('null == 1n', () => fold('null == 1n', '!1'));
    it("null == 'hi'", () => fold("null == 'hi'", '!1'));
    it('null == true', () => fold('null == true', '!1'));
    it('null == false', () => fold('null == false', '!1'));
    it('null === undefined', () => fold('null === undefined', '!1'));
    it('null === null', () => fold('null === null', '!0'));
    it('null === void 0', () => fold('null === void 0', '!1'));
    it('x===null', () => foldSame('x===null'));
    it('this==null', () => foldSame('this==null'));
    it('x==null', () => foldSame('x==null'));
    it('null != undefined', () => fold('null != undefined', '!1'));
    it('null != null', () => fold('null != null', '!1'));
    it('null != void 0', () => fold('null != void 0', '!1'));
    it('null != 0', () => fold('null != 0', '!0'));
    it('null != 1', () => fold('null != 1', '!0'));
    it('null != 0n', () => fold('null != 0n', '!0'));
    it('null != 1n', () => fold('null != 1n', '!0'));
    it("null != 'hi'", () => fold("null != 'hi'", '!0'));
    it('null != true', () => fold('null != true', '!0'));
    it('null != false', () => fold('null != false', '!0'));
    it('null !== undefined', () => fold('null !== undefined', '!0'));
    it('null !== void 0', () => fold('null !== void 0', '!0'));
    it('null !== null', () => fold('null !== null', '!1'));
    it('this!=null', () => foldSame('this!=null'));
    it('x!=null', () => foldSame('x!=null'));
    it('null < null', () => fold('null < null', '!1'));
    it('null > null', () => fold('null > null', '!1'));
    it('null >= null', () => fold('null >= null', '!0'));
    it('null <= null', () => fold('null <= null', '!0'));
    it('0 < null', () => fold('0 < null', '!1'));
    it('0 > null', () => fold('0 > null', '!1'));
    it('0 >= null', () => fold('0 >= null', '!0'));
    it('0n < null', () => fold('0n < null', '!1'));
    it('0n > null', () => fold('0n > null', '!1'));
    it('0n >= null', () => fold('0n >= null', '!0'));
    it('true > null', () => fold('true > null', '!0'));
    it("'hi' < null", () => fold("'hi' < null", '!1'));
    it("'hi' >= null", () => fold("'hi' >= null", '!1'));
    it('null <= null', () => fold('null <= null', '!0'));
    it('null < 0', () => fold('null < 0', '!1'));
    it('null < 0n', () => fold('null < 0n', '!1'));
    it('null > true', () => fold('null > true', '!1'));
    it("null < 'hi'", () => fold("null < 'hi'", '!1'));
    it("null >= 'hi'", () => fold("null >= 'hi'", '!1'));
    it('null <= null', () => fold('null <= null', '!0'));
    it('null == null', () => fold('null == null', '!0'));
    it('0 == null', () => fold('0 == null', '!1'));
    it('1 == null', () => fold('1 == null', '!1'));
    it("'hi' == null", () => fold("'hi' == null", '!1'));
    it('true == null', () => fold('true == null', '!1'));
    it('false == null', () => fold('false == null', '!1'));
    it('null === null', () => fold('null === null', '!0'));
    it('void 0 === null', () => fold('void 0 === null', '!1'));
    it('null == NaN', () => fold('null == NaN', '!1'));
    it('NaN == null', () => fold('NaN == null', '!1'));
    it('null == Infinity', () => fold('null == Infinity', '!1'));
    it('Infinity == null', () => fold('Infinity == null', '!1'));
    it('null == -Infinity', () => fold('null == -Infinity', '!1'));
    it('-Infinity == null', () => fold('-Infinity == null', '!1'));
    it('({}) == null', () => fold('({}) == null', '!1'));
    it('null == ({})', () => fold('null == ({})', '!1'));
    it('([]) == null', () => fold('([]) == null', '!1'));
    it('null == ([])', () => fold('null == ([])', '!1'));
    it('(/a/g) == null', () => fold('(/a/g) == null', '!1'));
    it('null == (/a/g)', () => fold('null == (/a/g)', '!1'));
    it('(function(){}) == null', () => fold('(function(){}) == null', '!1'));
    it('null == (function(){})', () => fold('null == (function(){})', '!1'));
    it('null != NaN', () => fold('null != NaN', '!0'));
    it('NaN != null', () => fold('NaN != null', '!0'));
    it('null != Infinity', () => fold('null != Infinity', '!0'));
    it('Infinity != null', () => fold('Infinity != null', '!0'));
    it('null != -Infinity', () => fold('null != -Infinity', '!0'));
    it('-Infinity != null', () => fold('-Infinity != null', '!0'));
    it('({}) != null', () => fold('({}) != null', '!0'));
    it('null != ({})', () => fold('null != ({})', '!0'));
    it('([]) != null', () => fold('([]) != null', '!0'));
    it('null != ([])', () => fold('null != ([])', '!0'));
    it('(/a/g) != null', () => fold('(/a/g) != null', '!0'));
    it('null != (/a/g)', () => fold('null != (/a/g)', '!0'));
    it('(function(){}) != null', () => fold('(function(){}) != null', '!0'));
    it('null != (function(){})', () => fold('null != (function(){})', '!0'));
    it('({a:f()})==null', () => foldSame('({a:f()})==null'));
    it('[f()]==null', () => foldSame('[f()]==null'));
    it('this==null', () => foldSame('this==null'));
    it('x==null', () => foldSame('x==null'));
});

describe('test_boolean_boolean_comparison', () => {
    it('!x == !y', () => foldSame('!x == !y'));
    it('!x < !y', () => foldSame('!x < !y'));
    it('!x!==!y', () => fold('!x!==!y', '!x != !y'));
    it('!x == !x', () => foldSame('!x == !x'));
    // foldable
    it('!x <! x', () => foldSame('!x <! x'));
    // foldable
    it('!x !== !x', () => fold('!x !== !x', '!x != !x'));
    // foldable
});

describe('test_boolean_number_comparison', () => {
    it('!x==+y', () => foldSame('!x==+y'));
    it('!x<=+y', () => foldSame('!x<=+y'));
    it('!x !== +y', () => foldSame('!x !== +y'));
});

describe('test_number_boolean_comparison', () => {
    it('+x==!y', () => foldSame('+x==!y'));
    it('+x<=!y', () => foldSame('+x<=!y'));
    it('+x === !y', () => foldSame('+x === !y'));
});

describe('test_boolean_string_comparison', () => {
    it("!x==''+y", () => foldSame("!x==''+y"));
    it("!x<=''+y", () => foldSame("!x<=''+y"));
    it("!x !== '' + y", () => foldSame("!x !== '' + y"));
});

describe('test_string_boolean_comparison', () => {
    it("''+x==!y", () => foldSame("''+x==!y"));
    it("''+x<=!y", () => foldSame("''+x<=!y"));
    it("'' + x === !y", () => foldSame("'' + x === !y"));
});

describe('test_number_number_comparison', () => {
    it('1 > 1', () => fold('1 > 1', '!1'));
    it('2 == 3', () => fold('2 == 3', '!1'));
    it('3.6 === 3.6', () => fold('3.6 === 3.6', '!0'));
    it('+x > +y', () => foldSame('+x > +y'));
    it('+x == +y', () => foldSame('+x == +y'));
    it('+x === +y', () => fold('+x === +y', '+x == +y'));
    it('+x > +x', () => foldSame('+x > +x'));
    // foldable to false
    it('+x == +x', () => foldSame('+x == +x'));
    it('+x === +x', () => fold('+x === +x', '+x == +x'));
});

describe('test_string_string_comparison', () => {
    it("'a' < 'b'", () => fold("'a' < 'b'", '!0'));
    it("'a' <= 'b'", () => fold("'a' <= 'b'", '!0'));
    it("'a' > 'b'", () => fold("'a' > 'b'", '!1'));
    it("'a' >= 'b'", () => fold("'a' >= 'b'", '!1'));
    it("+'a' < +'b'", () => fold("+'a' < +'b'", '!1'));
    it("typeof a < 'a'", () => foldSame("typeof a < 'a'"));
    it("'a' >= typeof a", () => foldSame("'a' >= typeof a"));
    it('typeof a < typeof a', () => foldSame('typeof a < typeof a'));
    it('typeof a >= typeof a', () => foldSame('typeof a >= typeof a'));
    it('typeof 3 > typeof 4', () => fold('typeof 3 > typeof 4', '!1'));
    it('typeof function() {} < typeof function() {}', () => fold('typeof function() {} < typeof function() {}', '!1'));
    it("'a' == 'a'", () => fold("'a' == 'a'", '!0'));
    it("'b' != 'a'", () => fold("'b' != 'a'", '!0'));
    it("typeof a != 'number'", () => foldSame("typeof a != 'number'"));
    it("typeof a != 'unknown'", () => foldSame("typeof a != 'unknown'"));
    // IE
    it("'a' === 'a'", () => fold("'a' === 'a'", '!0'));
    it("'b' !== 'a'", () => fold("'b' !== 'a'", '!0'));
    it("'' + x <= '' + y", () => foldSame("'' + x <= '' + y"));
    it("'' + x != '' + y", () => foldSame("'' + x != '' + y"));
    it("'' + x === '' + y", () => fold("'' + x === '' + y", "'' + x == '' + y"));
    it("'' + x <= '' + x", () => foldSame("'' + x <= '' + x"));
    // potentially foldable
    it("'' + x != '' + x", () => foldSame("'' + x != '' + x"));
    // potentially foldable
    it("'' + x === '' + x", () => fold("'' + x === '' + x", "'' + x == '' + x"));
    // potentially foldable
    it('if (" str ing " !== "\\u000Bstr\\u000Bing\\u000B") {}', () =>
        test('if ("\x0bstr\x0bing\x0b" !== "\\u000Bstr\\u000Bing\\u000B") {}', ''));
});

describe('test_number_string_comparison', () => {
    it("1 < '2'", () => fold("1 < '2'", '!0'));
    it("2 > '1'", () => fold("2 > '1'", '!0'));
    it("123 > '34'", () => fold("123 > '34'", '!0'));
    it("NaN >= 'NaN'", () => fold("NaN >= 'NaN'", '!1'));
    it("1 == '2'", () => fold("1 == '2'", '!1'));
    it("1 != '1'", () => fold("1 != '1'", '!1'));
    it("NaN == 'NaN'", () => fold("NaN == 'NaN'", '!1'));
    it("1 === '1'", () => fold("1 === '1'", '!1'));
    it("1 !== '1'", () => fold("1 !== '1'", '!0'));
    it("+x>''+y", () => foldSame("+x>''+y"));
    it("+x==''+y", () => foldSame("+x==''+y"));
    it("+x !== '' + y", () => foldSame("+x !== '' + y"));
});

describe('test_string_number_comparison', () => {
    it("'1' < 2", () => fold("'1' < 2", '!0'));
    it("'2' > 1", () => fold("'2' > 1", '!0'));
    it("'123' > 34", () => fold("'123' > 34", '!0'));
    it("'NaN' < NaN", () => fold("'NaN' < NaN", '!1'));
    it("'1' == 2", () => fold("'1' == 2", '!1'));
    it("'1' != 1", () => fold("'1' != 1", '!1'));
    it("'NaN' == NaN", () => fold("'NaN' == NaN", '!1'));
    it("'1' === 1", () => fold("'1' === 1", '!1'));
    it("'1' !== 1", () => fold("'1' !== 1", '!0'));
    it("''+x<+y", () => foldSame("''+x<+y"));
    it("''+x==+y", () => foldSame("''+x==+y"));
    it("'' + x === +y", () => foldSame("'' + x === +y"));
});

describe('test_nan_comparison', () => {
    it('NaN < 1', () => fold('NaN < 1', '!1'));
    it('NaN <= 1', () => fold('NaN <= 1', '!1'));
    it('NaN > 1', () => fold('NaN > 1', '!1'));
    it('NaN >= 1', () => fold('NaN >= 1', '!1'));
    it('NaN < 1n', () => fold('NaN < 1n', '!1'));
    it('NaN <= 1n', () => fold('NaN <= 1n', '!1'));
    it('NaN > 1n', () => fold('NaN > 1n', '!1'));
    it('NaN >= 1n', () => fold('NaN >= 1n', '!1'));
    it('NaN < NaN', () => fold('NaN < NaN', '!1'));
    it('NaN >= NaN', () => fold('NaN >= NaN', '!1'));
    it('NaN == NaN', () => fold('NaN == NaN', '!1'));
    it('NaN === NaN', () => fold('NaN === NaN', '!1'));
    it('NaN < null', () => fold('NaN < null', '!1'));
    it('null >= NaN', () => fold('null >= NaN', '!1'));
    it('NaN == null', () => fold('NaN == null', '!1'));
    it('null != NaN', () => fold('null != NaN', '!0'));
    it('null === NaN', () => fold('null === NaN', '!1'));
    it('NaN < undefined', () => fold('NaN < undefined', '!1'));
    it('undefined >= NaN', () => fold('undefined >= NaN', '!1'));
    it('NaN == undefined', () => fold('NaN == undefined', '!1'));
    it('undefined != NaN', () => fold('undefined != NaN', '!0'));
    it('undefined === NaN', () => fold('undefined === NaN', '!1'));
    it('NaN<x', () => foldSame('NaN<x'));
    it('x>=NaN', () => foldSame('x>=NaN'));
    it('NaN==x', () => fold('NaN==x', 'x==NaN'));
    it('x!=NaN', () => foldSame('x!=NaN'));
    it('NaN === x', () => fold('NaN === x', 'x === NaN'));
    it('x !== NaN', () => foldSame('x !== NaN'));
    it('NaN==foo()', () => fold('NaN==foo()', 'foo()==NaN'));
});

describe('test_object_comparison1', () => {
    it('!new Date()', () => fold('!new Date()', '!1'));
    it('!!new Date()', () => fold('!!new Date()', '!0'));
    it('!new Date(foo)', () => foldSame('!new Date(foo)'));
    it('new Date() == null', () => fold('new Date() == null', '!1'));
    it('new Date() == undefined', () => fold('new Date() == undefined', '!1'));
    it('new Date() != null', () => fold('new Date() != null', '!0'));
    it('new Date() != undefined', () => fold('new Date() != undefined', '!0'));
    it('null == new Date()', () => fold('null == new Date()', '!1'));
    it('undefined == new Date()', () => fold('undefined == new Date()', '!1'));
    it('null != new Date()', () => fold('null != new Date()', '!0'));
    it('undefined != new Date()', () => fold('undefined != new Date()', '!0'));
    it('new Date(foo) != undefined', () => fold('new Date(foo) != undefined', 'new Date(foo) != null'));
});

describe('js_typeof', () => {
    it('x = typeof 1n', () => fold('x = typeof 1n', 'x = "bigint"'));
    it('x = typeof 1', () => fold('x = typeof 1', 'x = "number"'));
    it("x = typeof 'foo'", () => fold("x = typeof 'foo'", 'x = "string"'));
    it('x = typeof true', () => fold('x = typeof true', 'x = "boolean"'));
    it('x = typeof false', () => fold('x = typeof false', 'x = "boolean"'));
    it('x = typeof null', () => fold('x = typeof null', 'x = "object"'));
    it('x = typeof undefined', () => fold('x = typeof undefined', 'x = "undefined"'));
    it('x = typeof void 0', () => fold('x = typeof void 0', 'x = "undefined"'));
    it('x = typeof []', () => fold('x = typeof []', 'x = "object"'));
    it('x = typeof [1]', () => fold('x = typeof [1]', 'x = "object"'));
    it('x = typeof [1,[]]', () => fold('x = typeof [1,[]]', 'x = "object"'));
    it('x = typeof {}', () => fold('x = typeof {}', 'x = "object"'));
    it('var a, b; NOOP(x = typeof (a === b))', () =>
        test('var a, b; NOOP(x = typeof (a === b))', 'var a, b; NOOP(x = "boolean")'));
    it('var foo; NOOP(x = typeof { foo })', () => test('var foo; NOOP(x = typeof { foo })', 'var foo; NOOP(x = "object")'));
    it('x = typeof function() {}', () => fold('x = typeof function() {}', "x = 'function'"));
    it('x = typeof (() => {})', () => fold('x = typeof (() => {})', "x = 'function'"));
    it('x = typeof class{}', () => fold('x = typeof class{}', 'x = "function"'));
    it('x = typeof foo', () => foldSame('x = typeof foo'));
    // no sideeffect, but we don't know the result
    it('x = typeof[1,[foo()]]', () => foldSame('x = typeof[1,[foo()]]'));
    it('x = typeof{bathwater:baby()}', () => foldSame('x = typeof{bathwater:baby()}'));
    it('x = typeof class { static { foo() } }', () => foldSame('x = typeof class { static { foo() } }'));
});

describe('test_fold_unary', () => {
    it('!foo()', () => foldSame('!foo()'));
    it('~foo()', () => foldSame('~foo()'));
    it('-foo()', () => foldSame('-foo()'));
    it('a=!true', () => fold('a=!true', 'a=!1'));
    it('a=!10', () => fold('a=!10', 'a=!1'));
    it('a=!false', () => fold('a=!false', 'a=!0'));
    it('a=!foo()', () => foldSame('a=!foo()'));
    it('a = !!void b', () => foldSame('a = !!void b'));
    it('a=-0', () => fold('a=-0', 'a=-0'));
    it('a=-(0)', () => fold('a=-(0)', 'a=-0'));
    it('a=-Infinity', () => foldSame('a=-Infinity'));
    it('a=-NaN', () => fold('a=-NaN', 'a=NaN'));
    it('a=-foo()', () => foldSame('a=-foo()'));
    it('-undefined', () => fold('-undefined', 'NaN'));
    it('-null', () => fold('-null', '-0'));
    it('-NaN', () => fold('-NaN', 'NaN'));
    it('a=+true', () => fold('a=+true', 'a=1'));
    it('a=+10', () => fold('a=+10', 'a=10'));
    it('a=+false', () => fold('a=+false', 'a=0'));
    it('a=+foo()', () => foldSame('a=+foo()'));
    it('a=+f', () => foldSame('a=+f'));
    it('a=+(f?true:false)', () => fold('a=+(f?true:false)', 'a=+!!f'));
    it('a=+(f?!0:!1)', () => fold('a=+(f?!0:!1)', 'a=+!!f'));
    it('a=+(f?(foo, !0):(bar, !1))', () => foldSame('a=+(f?(foo, !0):(bar, !1))'));
    it('a=+0', () => fold('a=+0', 'a=0'));
    it('a=+Infinity', () => fold('a=+Infinity', 'a=Infinity'));
    it('a=+NaN', () => fold('a=+NaN', 'a=NaN'));
    it('a=+-7', () => fold('a=+-7', 'a=-7'));
    it('a=+.5', () => fold('a=+.5', 'a=.5'));
    it('a=~~0', () => fold('a=~~0', 'a=0'));
    it('a=~~10', () => fold('a=~~10', 'a=10'));
    it('a=~-7', () => fold('a=~-7', 'a=6'));
    it('a=~~foo()', () => foldSame('a=~~foo()'));
    it('a=~0xffffffff', () => fold('a=~0xffffffff', 'a=0'));
    it('a=~~0xffffffff', () => fold('a=~~0xffffffff', 'a=-1'));
    it('a=~.5', () => fold('a=~.5', 'a=-1'));
    it('a=+[]', () => fold('a=+[]', 'a=0'));
    it('a=+[...foo]', () => foldSame('a=+[...foo]'));
    it('a=+[,]', () => fold('a=+[,]', 'a=0'));
    it('a=+[0]', () => fold('a=+[0]', 'a=0'));
    it("a=+['0x10']", () => fold("a=+['0x10']", 'a=16'));
    it('a=+[[]]', () => fold('a=+[[]]', 'a=0'));
    it('a=+[0, 1]', () => fold('a=+[0, 1]', 'a=NaN'));
    it('var foo; NOOP(a=+[0, ...foo])', () => testSame('var foo; NOOP(a=+[0, ...foo])'));
    // can be either `a=0` or `a=NaN` (also `...foo` may have a side effect)
    it("var foo; NOOP(a=+[0, ...[foo ? 'foo': ''], 1])", () =>
        test("var foo; NOOP(a=+[0, ...[foo ? 'foo': ''], 1])", 'var foo; NOOP(a=NaN)'));
    it('a=+[false]', () => fold('a=+[false]', 'a=NaN'));
    // `+"false"`
    it('a=+[true]', () => fold('a=+[true]', 'a=NaN'));
    // `+"true"`
    it('a=+[undefined]', () => fold('a=+[undefined]', 'a=0'));
    // `+""`
    it('a=+[null]', () => fold('a=+[null]', 'a=0'));
    // `+""`
});

describe('test_fold_unary_big_int', () => {
    it('-(1n)', () => fold('-(1n)', '-1n'));
    it('- -1n', () => fold('- -1n', '1n'));
    it('!1n', () => fold('!1n', '!1'));
    it('~0n', () => fold('~0n', '-1n'));
    it('~-1n', () => fold('~-1n', '0n'));
    it('~~1n', () => fold('~~1n', '1n'));
    it('~0x3n', () => fold('~0x3n', '-4n'));
    it('~0b11n', () => fold('~0b11n', '-4n'));
});

describe('test_unary_ops_string_compare', () => {
    it('a = -1', () => foldSame('a = -1'));
    it('a = ~0', () => fold('a = ~0', 'a = -1'));
    it('a = ~1', () => fold('a = ~1', 'a = -2'));
    it('a = ~101', () => fold('a = ~101', 'a = -102'));
    it('a = ~1.1', () => fold('a = ~1.1', 'a = -2'));
    it('a = ~0x3', () => fold('a = ~0x3', 'a = -4'));
    // Hexadecimal number
    it('a = ~9', () => fold('a = ~9', 'a = -10'));
    // Despite `-10` is longer than `~9`, the compiler still folds it.
    it('a = ~b', () => foldSame('a = ~b'));
    it('a = ~NaN', () => fold('a = ~NaN', 'a = -1'));
    it('a = ~-Infinity', () => fold('a = ~-Infinity', 'a = -1'));
    it('x = ~2147483658.0', () => fold('x = ~2147483658.0', 'x = 2147483637'));
    it('x = ~-2147483658', () => fold('x = ~-2147483658', 'x = -2147483639'));
});

describe('test_fold_logical_op', () => {
    it('x = true && x', () => fold('x = true && x', 'x = x'));
    it('x = [foo()] && x', () => fold('x = [foo()] && x', 'x = (foo(),x)'));
    it('x = false && x', () => fold('x = false && x', 'x = !1'));
    it('x = true || x', () => fold('x = true || x', 'x = !0'));
    it('x = false || x', () => fold('x = false || x', 'x = x'));
    it('x = 0 && x', () => fold('x = 0 && x', 'x = 0'));
    it('x = 3 || x', () => fold('x = 3 || x', 'x = 3'));
    it('x = 0n && x', () => fold('x = 0n && x', 'x = 0n'));
    it('x = 3n || x', () => fold('x = 3n || x', 'x = 3n'));
    it('x = false || 0', () => fold('x = false || 0', 'x = 0'));
    // unfoldable, because the right-side may be the result
    it('a = x && true', () => fold('a = x && true', 'a=x && !0'));
    it('a = x && false', () => fold('a = x && false', 'a=x && !1'));
    it('a = x || 3', () => fold('a = x || 3', 'a=x || 3'));
    it('a = x || false', () => fold('a = x || false', 'a=x || !1'));
    it('a = b ? c : x || false', () => fold('a = b ? c : x || false', 'a=b ? c : x || !1'));
    it('a = b ? x || false : c', () => fold('a = b ? x || false : c', 'a=b ? x || !1 : c'));
    it('a = b ? c : x && true', () => fold('a = b ? c : x && true', 'a=b ? c : x && !0'));
    it('a = b ? x && true : c', () => fold('a = b ? x && true : c', 'a=b ? x && !0 : c'));
    it('a = x || false ? b : c', () => fold('a = x || false ? b : c', 'a = x ? b : c'));
    it('a = x && true ? b : c', () => fold('a = x && true ? b : c', 'a = x ? b : c'));
    it('x = foo() || true || bar()', () => fold('x = foo() || true || bar()', 'x = foo() || !0'));
    it('x = foo() || true && bar()', () => fold('x = foo() || true && bar()', 'x = foo() || bar()'));
    it('x = foo() || false && bar()', () => fold('x = foo() || false && bar()', 'x = foo() || !1'));
    it('x = foo() && false && bar()', () => fold('x = foo() && false && bar()', 'x = foo() && !1'));
    it('x = foo() && false || bar()', () => fold('x = foo() && false || bar()', 'x = (foo(), bar())'));
    it('x = foo() || false || bar()', () => fold('x = foo() || false || bar()', 'x = foo() || bar()'));
    it('x = foo() && true && bar()', () => fold('x = foo() && true && bar()', 'x = foo() && bar()'));
    it('x = foo() || true || bar()', () => fold('x = foo() || true || bar()', 'x = foo() || !0'));
    it('x = foo() && false && bar()', () => fold('x = foo() && false && bar()', 'x = foo() && !1'));
    it('x = foo() && 0 && bar()', () => fold('x = foo() && 0 && bar()', 'x = foo() && 0'));
    it('x = foo() && 1 && bar()', () => fold('x = foo() && 1 && bar()', 'x = foo() && bar()'));
    it('x = foo() || 0 || bar()', () => fold('x = foo() || 0 || bar()', 'x = foo() || bar()'));
    it('x = foo() || 1 || bar()', () => fold('x = foo() || 1 || bar()', 'x = foo() || 1'));
    it('x = foo() && 0n && bar()', () => fold('x = foo() && 0n && bar()', 'x = foo() && 0n'));
    it('x = foo() && 1n && bar()', () => fold('x = foo() && 1n && bar()', 'x = foo() && bar()'));
    it('x = foo() || 0n || bar()', () => fold('x = foo() || 0n || bar()', 'x = foo() || bar()'));
    it('x = foo() || 1n || bar()', () => fold('x = foo() || 1n || bar()', 'x = foo() || 1n'));
    it('x = foo() || bar() || baz()', () => foldSame('x = foo() || bar() || baz()'));
    it('x = foo() && bar() && baz()', () => foldSame('x = foo() && bar() && baz()'));
    it('0 || b()', () => fold('0 || b()', 'b()'));
    it('1 && b()', () => fold('1 && b()', 'b()'));
    it('a() && (1 && b())', () => fold('a() && (1 && b())', 'a() && b()'));
    it('(a() && 1) && b()', () => fold('(a() && 1) && b()', 'a() && b()'));
    it("(x || '') || y", () => fold("(x || '') || y", 'x || y'));
    it("false || (x || '')", () => fold("false || (x || '')", "x || ''"));
    it('(x && 1) && y', () => fold('(x && 1) && y', 'x && y'));
    it('true && (x && 1)', () => fold('true && (x && 1)', 'x && 1'));
    // Really not foldable, because it would change the type of the
    // expression if foo() returns something truthy but not true.
    // Cf. FoldConstants.tryFoldAndOr().
    // An example would be if foo() is 1 (truthy) and bar() is 0 (falsey):
    // (1 && true) || 0 == true
    // 1 || 0 == 1, but true =/= 1
    it('x = foo() && true || bar()', () => fold('x = foo() && true || bar()', 'x = foo() && !0 || bar()'));
    it('foo() && true || bar()', () => fold('foo() && true || bar()', 'foo() && !0 || bar()'));
    it('var y; x = (true && y)()', () => test('var y; x = (true && y)()', 'var y; x = y()'));
    it('var y; x = (true && y.z)()', () => test('var y; x = (true && y.z)()', 'var y; x = (0, y.z)()'));
    it('var y; x = (false || y)()', () => test('var y; x = (false || y)()', 'var y; x = y()'));
    it('var y; x = (false || y.z)()', () => test('var y; x = (false || y.z)()', 'var y; x = (0, y.z)()'));
});

describe('test_fold_logical_op2', () => {
    it('x = function(){} && x', () => fold('x = function(){} && x', 'x=x'));
    it('x = true && function(){}', () => fold('x = true && function(){}', 'x=function(){}'));
    it('x = [(function(){alert(x)})()] && x', () =>
        fold('x = [(function(){alert(x)})()] && x', 'x=((function(){alert(x)})(),x)'));
});

// `cjs-module-lexer` scans `module.exports = { ... }` syntactically. esbuild
// emits `0 && (module.exports = { ... })` as a parse-time hint when the real
// exports happen through helpers the lexer can't trace; folding the hint
// away breaks `import { X } from "<cjs-pkg>"` consumers.
//
// Hint emission site (esbuild v0.28.0):
// https://github.com/evanw/esbuild/blob/v0.28.0/internal/linker/linker.go#L5127-L5138
//
// See also #4878 — the original guard, removed by the #8618 refactor.
describe('test_preserve_cjs_module_lexer_hint', () => {
    it('0 && (module.exports = { version });', () => testSame('0 && (module.exports = { version });'));
    it('0 && (module.exports = { a, b, c });', () => testSame('0 && (module.exports = { a, b, c });'));
    // Compound assignments aren't real lexer hints — keep folding them.
    it('x = 0 && (module.exports ||= y)', () => fold('x = 0 && (module.exports ||= y)', 'x = 0'));
    // Non-export-shape RHS still folds.
    it('x = 0 && foo()', () => fold('x = 0 && foo()', 'x = 0'));
});

describe('test_fold_nullish_coalesce', () => {
    // fold if left is null/undefined
    it('null ?? 1', () => fold('null ?? 1', '1'));
    it('undefined ?? false', () => fold('undefined ?? false', '!1'));
    it('(a(), null) ?? 1', () => fold('(a(), null) ?? 1', '(a(), 1)'));
    it('x = [foo()] ?? x', () => fold('x = [foo()] ?? x', 'x = [foo()]'));
    // short circuit on all non nullish LHS
    it('x = false ?? x', () => fold('x = false ?? x', 'x = !1'));
    it('x = true ?? x', () => fold('x = true ?? x', 'x = !0'));
    it('x = 0 ?? x', () => fold('x = 0 ?? x', 'x = 0'));
    it('x = 3 ?? x', () => fold('x = 3 ?? x', 'x = 3'));
    // unfoldable, because the right-side may be the result
    it('a = x ?? true', () => fold('a = x ?? true', 'a = x ?? !0'));
    it('a = x ?? false', () => fold('a = x ?? false', 'a = x ?? !1'));
    it('a = x ?? 3', () => foldSame('a = x ?? 3'));
    it('a = b ? c : x ?? false', () => fold('a = b ? c : x ?? false', 'a = b ? c : x ?? !1'));
    it('a = b ? x ?? false : c', () => fold('a = b ? x ?? false : c', 'a = b ? x ?? !1 : c'));
    // folded, but not here.
    it('a = x ?? false ? b : c', () => fold('a = x ?? false ? b : c', 'a = x ?? !1 ? b : c'));
    it('a = x ?? true ? b : c', () => fold('a = x ?? true ? b : c', 'a = x ?? !0 ? b : c'));
    it('x = foo() ?? true ?? bar()', () => fold('x = foo() ?? true ?? bar()', 'x = foo() ?? !0 ?? bar()'));
    it('x = foo() ?? (true && bar())', () => fold('x = foo() ?? (true && bar())', 'x = foo() ?? bar()'));
    it('x = (foo() || false) ?? bar()', () => fold('x = (foo() || false) ?? bar()', 'x = (foo() || !1) ?? bar()'));
    it('a() ?? (1 ?? b())', () => fold('a() ?? (1 ?? b())', 'a() ?? 1'));
    it('(a() ?? 1) ?? b()', () => fold('(a() ?? 1) ?? b()', 'a() ?? 1 ?? b()'));
    it('var y; x = (y ?? 1)()', () => testSame('var y; x = (y ?? 1)()'));
    // can compress to "var y; x = y()" if y is not null or undefined
    it('var y; x = (y.z ?? 1)()', () => testSame('var y; x = (y.z ?? 1)()'));
    // "var y; x = (0, y.z)()" if y is not null or undefined
    it('var y; x = (null ?? y)()', () => test('var y; x = (null ?? y)()', 'var y; x = y()'));
    it('var y; x = (null ?? y.z)()', () => test('var y; x = (null ?? y.z)()', 'var y; x = (0, y.z)()'));
});

describe('test_fold_void', () => {
    it('void 0', () => foldSame('void 0'));
    it('void 1', () => fold('void 1', 'void 0'));
    it('void x', () => foldSame('void x'));
    it('void x()', () => foldSame('void x()'));
});

describe('test_fold_opt_chain', () => {
    // can't fold when optional part may execute
    it('a = x?.y', () => foldSame('a = x?.y'));
    it('a = x?.()', () => foldSame('a = x?.()'));
    // fold args of optional call
    it('x = foo() ?. (true && bar())', () => fold('x = foo() ?. (true && bar())', 'x = foo() ?.(bar())'));
    it('a() ?. (1 ?? b())', () => fold('a() ?. (1 ?? b())', 'a() ?. (1)'));
    // test("({a})?.a.b.c.d()?.x.y.z", "a.b.c.d()?.x.y.z");
    it('x = undefined?.y', () => fold('x = undefined?.y', 'x = void 0'));
    it('x = null?.y', () => fold('x = null?.y', 'x = void 0'));
    it('x = undefined?.[foo]', () => fold('x = undefined?.[foo]', 'x = void 0'));
    it('x = null?.[foo]', () => fold('x = null?.[foo]', 'x = void 0'));
    it('x = undefined?.()', () => fold('x = undefined?.()', 'x = void 0'));
    it('x = null?.()', () => fold('x = null?.()', 'x = void 0'));
    it('x = (foo(), null)?.y', () => fold('x = (foo(), null)?.y', 'x = (foo(), void 0)'));
    it('x = (foo(), null)?.()', () => fold('x = (foo(), null)?.()', 'x = (foo(), void 0)'));
    // Nested: nullish base short-circuits the entire chain even when the
    // optional is not on the outermost element.
    it('x = null?.foo.bar', () => fold('x = null?.foo.bar', 'x = void 0'));
    it('x = ((null))?.foo', () => fold('x = ((null))?.foo', 'x = void 0'));
    it('x = null?.foo()', () => fold('x = null?.foo()', 'x = void 0'));
    it('x = null?.foo.bar.baz()', () => fold('x = null?.foo.bar.baz()', 'x = void 0'));
    it('x = (foo(), null)?.bar.baz', () => fold('x = (foo(), null)?.bar.baz', 'x = (foo(), void 0)'));
});

describe('test_fold_opt_chain_non_nullish_base', () => {
    // https://github.com/oxc-project/oxc/issues/21923
    // Drop `?.` when the base is statically non-nullish.
    it('x = ("")?.foo', () => fold('x = ("")?.foo', 'x = ("").foo'));
    it('x = (1)?.foo', () => fold('x = (1)?.foo', 'x = (1).foo'));
    it('x = (1n)?.foo', () => fold('x = (1n)?.foo', 'x = (1n).foo'));
    it('x = ({})?.foo', () => fold('x = ({})?.foo', 'x = ({}).foo'));
    it('x = ([])?.foo', () => fold('x = ([])?.foo', 'x = ([]).foo'));
    it('x = (() => 0)?.foo', () => fold('x = (() => 0)?.foo', 'x = (() => 0).foo'));
    it('x = (function () {})?.foo', () => fold('x = (function () {})?.foo', 'x = (function () {}).foo'));
    it('x = (class {})?.foo', () => fold('x = (class {})?.foo', 'x = (class {}).foo'));
    it('x = /a/?.flags', () => fold('x = /a/?.flags', 'x = /a/.flags'));
    // Computed and optional-call forms.
    it('x = ({})?.["foo"]', () => fold('x = ({})?.["foo"]', 'x = ({}).foo'));
    // Fold chains with the IIFE inliner: (() => 0)?.() -> (() => 0)() -> 0
    it('x = (() => 0)?.()', () => fold('x = (() => 0)?.()', 'x = 0'));
    // Side effects on the base must be preserved.
    it('x = (foo(), {})?.bar', () => fold('x = (foo(), {})?.bar', 'x = (foo(), {}).bar'));
    // The outer `?.foo` cannot be dropped while the base still contains an
    // unresolved optional. `Number` may be shadowed by a primitive, in which
    // case `Number?.POSITIVE_INFINITY.foo` would throw.
    it('x = Number?.POSITIVE_INFINITY?.foo', () => foldSame('x = Number?.POSITIVE_INFINITY?.foo'));
    it('x = Number?.NEGATIVE_INFINITY?.foo', () => foldSame('x = Number?.NEGATIVE_INFINITY?.foo'));
    it('const Number = 1; x = Number?.POSITIVE_INFINITY?.foo', () =>
        test('const Number = 1; x = Number?.POSITIVE_INFINITY?.foo', 'const Number = 1; x = 1 .POSITIVE_INFINITY?.foo'));
    it('const Number = 1; x = Number?.POSITIVE_INFINITY?.[foo()]', () =>
        test('const Number = 1; x = Number?.POSITIVE_INFINITY?.[foo()]', 'const Number = 1; x = 1 .POSITIVE_INFINITY?.[foo()]'));
    it('const Number = 1; x = Number?.POSITIVE_INFINITY?.(foo())', () =>
        test('const Number = 1; x = Number?.POSITIVE_INFINITY?.(foo())', 'const Number = 1; x = 1 .POSITIVE_INFINITY?.(foo())'));
    // Unknown bases are left alone.
    it('x = b?.foo', () => foldSame('x = b?.foo'));
    it('x = foo()?.bar', () => foldSame('x = foo()?.bar'));
    it('x = new Foo()?.bar', () => foldSame('x = new Foo()?.bar'));
    // Nested chains: drop the inner `?.` when its base is non-nullish, even
    // when the outermost element is non-optional.
    it('x = []?.foo.bar', () => fold('x = []?.foo.bar', 'x = [].foo.bar'));
    it('x = ("")?.foo.bar', () => fold('x = ("")?.foo.bar', 'x = ("").foo.bar'));
    it('x = ({})?.foo()', () => fold('x = ({})?.foo()', 'x = ({}).foo()'));
    it('x = /a/?.test("a")', () => fold('x = /a/?.test("a")', 'x = /a/.test("a")'));
    // Inner `?.` flips, outer `?.` keeps the chain wrapped.
    it('x = ({})?.foo?.bar', () => fold('x = ({})?.foo?.bar', 'x = ({}).foo?.bar'));
    it('x = (() => 0)?.foo?.()', () => fold('x = (() => 0)?.foo?.()', 'x = (() => 0).foo?.()'));
    // Nested ChainExpressions are flattened by a separate pass before this
    // fold sees the inner optional on a later compression iteration.
    it('x = (({})?.foo)?.bar', () => fold('x = (({})?.foo)?.bar', 'x = ({}).foo?.bar'));
});

describe('test_fold_bitwise_op', () => {
    it('x = 1 & 1', () => fold('x = 1 & 1', 'x = 1'));
    it('x = 1 & 2', () => fold('x = 1 & 2', 'x = 0'));
    it('x = 3 & 1', () => fold('x = 3 & 1', 'x = 1'));
    it('x = 3 & 3', () => fold('x = 3 & 3', 'x = 3'));
    it('x = 1 | 1', () => fold('x = 1 | 1', 'x = 1'));
    it('x = 1 | 2', () => fold('x = 1 | 2', 'x = 3'));
    it('x = 3 | 1', () => fold('x = 3 | 1', 'x = 3'));
    it('x = 3 | 3', () => fold('x = 3 | 3', 'x = 3'));
    it('x = 1 ^ 1', () => fold('x = 1 ^ 1', 'x = 0'));
    it('x = 1 ^ 2', () => fold('x = 1 ^ 2', 'x = 3'));
    it('x = 3 ^ 1', () => fold('x = 3 ^ 1', 'x = 2'));
    it('x = 3 ^ 3', () => fold('x = 3 ^ 3', 'x = 0'));
    it('x = -1 & 0', () => fold('x = -1 & 0', 'x = 0'));
    it('x = 0 & -1', () => fold('x = 0 & -1', 'x = 0'));
    it('x = 1 & 4', () => fold('x = 1 & 4', 'x = 0'));
    it('x = 2 & 3', () => fold('x = 2 & 3', 'x = 2'));
    // make sure we fold only when we are supposed to -- not when doing so would
    // lose information or when it is performed on nonsensical arguments.
    it('x = 1 & 1.1', () => fold('x = 1 & 1.1', 'x = 1'));
    it('x = 1.1 & 1', () => fold('x = 1.1 & 1', 'x = 1'));
    it('x = 1 & 3000000000', () => fold('x = 1 & 3000000000', 'x = 0'));
    it('x = 3000000000 & 1', () => fold('x = 3000000000 & 1', 'x = 0'));
    // Try some cases with | as well
    it('x = 1 | 4', () => fold('x = 1 | 4', 'x = 5'));
    it('x = 1 | 3', () => fold('x = 1 | 3', 'x = 3'));
    it('x = 1 | 1.1', () => fold('x = 1 | 1.1', 'x = 1'));
    // test_same("x = 1 | 3e9");
    // these cases look strange because bitwise OR converts unsigned numbers to be signed
    it('x = 1 | 3000000001', () => fold('x = 1 | 3000000001', 'x = -1294967295'));
    it('x = 4294967295 | 0', () => fold('x = 4294967295 | 0', 'x = -1'));
    it('x = -1 | 0', () => fold('x = -1 | 0', 'x = -1'));
});

describe('test_fold_bitwise_op2', () => {
    it('x = y & 1 & 1', () => fold('x = y & 1 & 1', 'x = y & 1'));
    it('x = y & 1 & 2', () => fold('x = y & 1 & 2', 'x = y & 0'));
    it('x = y & 3 & 1', () => fold('x = y & 3 & 1', 'x = y & 1'));
    it('x = 3 & y & 1', () => fold('x = 3 & y & 1', 'x = y & 1'));
    it('x = y & 3 & 3', () => fold('x = y & 3 & 3', 'x = y & 3'));
    it('x = 3 & y & 3', () => fold('x = 3 & y & 3', 'x = y & 3'));
    it('x = y | 1 | 1', () => fold('x = y | 1 | 1', 'x = y | 1'));
    it('x = y | 1 | 2', () => fold('x = y | 1 | 2', 'x = y | 3'));
    it('x = y | 3 | 1', () => fold('x = y | 3 | 1', 'x = y | 3'));
    it('x = 3 | y | 1', () => fold('x = 3 | y | 1', 'x = y | 3'));
    it('x = y | 3 | 3', () => fold('x = y | 3 | 3', 'x = y | 3'));
    it('x = 3 | y | 3', () => fold('x = 3 | y | 3', 'x = y | 3'));
    it('x = y ^ 1 ^ 1', () => fold('x = y ^ 1 ^ 1', 'x = y ^ 0'));
    it('x = y ^ 1 ^ 2', () => fold('x = y ^ 1 ^ 2', 'x = y ^ 3'));
    it('x = y ^ 3 ^ 1', () => fold('x = y ^ 3 ^ 1', 'x = y ^ 2'));
    it('x = 3 ^ y ^ 1', () => fold('x = 3 ^ y ^ 1', 'x = y ^ 2'));
    it('x = y ^ 3 ^ 3', () => fold('x = y ^ 3 ^ 3', 'x = y ^ 0'));
    it('x = 3 ^ y ^ 3', () => fold('x = 3 ^ y ^ 3', 'x = y ^ 0'));
    it('x = Infinity | NaN', () => fold('x = Infinity | NaN', 'x=0'));
    it('x = 12 | NaN', () => fold('x = 12 | NaN', 'x=12'));
});

describe('test_fold_bitwise_op_additional', () => {
    it('x = null & 1', () => fold('x = null & 1', 'x = 0'));
    it('x = (2 ** 31 - 1) | 1', () => foldSame('x = (2 ** 31 - 1) | 1'));
    it('x = (2 ** 31) | 1', () => foldSame('x = (2 ** 31) | 1'));
    // https://github.com/oxc-project/oxc/issues/7944
    it('(x - 1) & 1', () => foldSame('(x - 1) & 1'));
    it('(y >> 3) & 7', () => foldSame('(y >> 3) & 7'));
    it('(y & 3) & 7', () => fold('(y & 3) & 7', 'y & 3'));
    it('(y | 3) & 7', () => foldSame('(y | 3) & 7'));
    it('y | 3 & 7', () => fold('y | 3 & 7', 'y | 3'));
});

describe('test_fold_bitwise_not', () => {
    it('~undefined', () => fold('~undefined', '-1'));
    it('~null', () => fold('~null', '-1'));
    it('~false', () => fold('~false', '-1'));
    it('~true', () => fold('~true', '-2'));
    it("~'1'", () => fold("~'1'", '-2'));
    it("~'-1'", () => fold("~'-1'", '0'));
    it('~{}', () => fold('~{}', '-1'));
});

describe('test_fold_bit_shifts', () => {
    it('x = 1 << 0', () => fold('x = 1 << 0', 'x=1'));
    it('x = -1 << 0', () => fold('x = -1 << 0', 'x=-1'));
    it('x = 1 << 1', () => fold('x = 1 << 1', 'x=2'));
    it('x = 3 << 1', () => fold('x = 3 << 1', 'x=6'));
    it('x = 1 << 8', () => fold('x = 1 << 8', 'x=256'));
    it('x = 1 >> 0', () => fold('x = 1 >> 0', 'x=1'));
    it('x = -1 >> 0', () => fold('x = -1 >> 0', 'x=-1'));
    it('x = 1 >> 1', () => fold('x = 1 >> 1', 'x=0'));
    it('x = 2 >> 1', () => fold('x = 2 >> 1', 'x=1'));
    it('x = 5 >> 1', () => fold('x = 5 >> 1', 'x=2'));
    it('x = 127 >> 3', () => fold('x = 127 >> 3', 'x=15'));
    it('x = 3 >> 1', () => fold('x = 3 >> 1', 'x=1'));
    it('x = 3 >> 2', () => fold('x = 3 >> 2', 'x=0'));
    it('x = 10 >> 1', () => fold('x = 10 >> 1', 'x=5'));
    it('x = 10 >> 2', () => fold('x = 10 >> 2', 'x=2'));
    it('x = 10 >> 5', () => fold('x = 10 >> 5', 'x=0'));
    it('x = 10 >>> 1', () => fold('x = 10 >>> 1', 'x=5'));
    it('x = 10 >>> 2', () => fold('x = 10 >>> 2', 'x=2'));
    it('x = 10 >>> 5', () => fold('x = 10 >>> 5', 'x=0'));
    it('x = -1 >>> 1', () => foldSame('x = -1 >>> 1'));
    it('x = -1 >>> 0', () => foldSame('x = -1 >>> 0'));
    it('x = -2 >>> 0', () => foldSame('x = -2 >>> 0'));
    it('x = 0x90000000 >>> 28', () => fold('x = 0x90000000 >>> 28', 'x=9'));
    it('x = 0xffffffff << 0', () => fold('x = 0xffffffff << 0', 'x=-1'));
    it('x = 0xffffffff << 4', () => fold('x = 0xffffffff << 4', 'x=-16'));
    it('1 << 32', () => fold('1 << 32', '1'));
    it('1 << -1', () => fold('1 << -1', '1<<-1'));
    it('1 >> 32', () => fold('1 >> 32', '1'));
    // Regression on #6161, ported from <https://github.com/tc39/test262/blob/05c45a4c430ab6fee3e0c7f0d47d8a30d8876a6d/test/language/expressions/unsigned-right-shift/S9.6_A2.2.js>.
    it('-2147483647 >>> 0', () => fold('-2147483647 >>> 0', '2147483649'));
    it('-2147483648 >>> 0', () => fold('-2147483648 >>> 0', '2147483648'));
    it('-2147483649 >>> 0', () => fold('-2147483649 >>> 0', '2147483647'));
    it('-4294967295 >>> 0', () => fold('-4294967295 >>> 0', '1'));
    it('-4294967296 >>> 0', () => fold('-4294967296 >>> 0', '0'));
    it('-4294967297 >>> 0', () => fold('-4294967297 >>> 0', '4294967295'));
    it('4294967295 >>> 0', () => fold('4294967295 >>> 0', '4294967295'));
    it('4294967296 >>> 0', () => fold('4294967296 >>> 0', '0'));
    it('4294967297 >>> 0', () => fold('4294967297 >>> 0', '1'));
    it('8589934591 >>> 0', () => fold('8589934591 >>> 0', '4294967295'));
    it('8589934592 >>> 0', () => fold('8589934592 >>> 0', '0'));
    it('8589934593 >>> 0', () => fold('8589934593 >>> 0', '1'));
    it('x = -1 << 1', () => fold('x = -1 << 1', 'x = -2'));
    it('x = -1 << 8', () => fold('x = -1 << 8', 'x = -256'));
    it('x = -1 >> 1', () => fold('x = -1 >> 1', 'x = -1'));
    it('x = -2 >> 1', () => fold('x = -2 >> 1', 'x = -1'));
    it('x = -1 >> 0', () => fold('x = -1 >> 0', 'x = -1'));
});

describe('test_string_add', () => {
    it("x = 'a' + 'bc'", () => fold("x = 'a' + 'bc'", "x = 'abc'"));
    // Lone surrogates are stored escaped in the string value; folding would
    // materialize the escape encoding as literal text.
    it("x = '\\ud800' + 'y'", () => foldSame("x = '\\ud800' + 'y'"));
    it("x = 'a' + 5", () => fold("x = 'a' + 5", "x = 'a5'"));
    it("x = 5 + 'a'", () => fold("x = 5 + 'a'", "x = '5a'"));
    it("x = 'a' + 5n", () => fold("x = 'a' + 5n", "x = 'a5'"));
    it("x = 5n + 'a'", () => fold("x = 5n + 'a'", "x = '5a'"));
    it("x = 'a' + ''", () => fold("x = 'a' + ''", "x = 'a'"));
    it("x = 'a' + foo()", () => fold("x = 'a' + foo()", "x = 'a'+foo()"));
    it("x = foo() + 'a' + 'b'", () => fold("x = foo() + 'a' + 'b'", "x = foo()+'ab'"));
    it("x = (foo() + 'a') + 'b'", () => fold("x = (foo() + 'a') + 'b'", "x = foo()+'ab'"));
    // believe it!
    it("x = foo() + 'a' + 'b' + 'cd' + bar()", () => fold("x = foo() + 'a' + 'b' + 'cd' + bar()", "x = foo()+'abcd'+bar()"));
    it("x = foo() + 2 + 'b'", () => fold("x = foo() + 2 + 'b'", 'x = foo()+2+"b"'));
    // don't fold!
    // Don't merge string literals across a non-`+` inner operator: the inner string operand
    // is coerced numerically, so `(x - 'b') + 'c'` is `(x - NaN) + 'c'`, not `x + 'bc'`.
    it("x = x - 'b' + 'c'", () => foldSame("x = x - 'b' + 'c'"));
    it("x = x * 'b' + 'c'", () => foldSame("x = x * 'b' + 'c'"));
    it("x = x % 'b' + 'c'", () => foldSame("x = x % 'b' + 'c'"));
    it("x = (x & 'b') + 'c'", () => foldSame("x = (x & 'b') + 'c'"));
    it("x = foo() + 'a' + 2", () => fold("x = foo() + 'a' + 2", 'x = foo()+"a2"'));
    it("x = '' + null", () => fold("x = '' + null", "x = 'null'"));
    it("x = true + '' + false", () => fold("x = true + '' + false", "x = 'truefalse'"));
    it("x = '' + []", () => fold("x = '' + []", "x = ''"));
    it("x = foo() + 'a' + 1 + 1", () => fold("x = foo() + 'a' + 1 + 1", "x = foo() + 'a11'"));
    it("x = 1 + 1 + 'a'", () => fold("x = 1 + 1 + 'a'", "x = '2a'"));
    it("x = 1 + 1 + 'a'", () => fold("x = 1 + 1 + 'a'", "x = '2a'"));
    it("x = 'a' + (1 + 1)", () => fold("x = 'a' + (1 + 1)", "x = 'a2'"));
    // fold("x = '_' + p1 + '_' + ('' + p2)", "x = '_' + p1 + '_' + p2");
    it("x = 'a' + ('_' + 1 + 1)", () => fold("x = 'a' + ('_' + 1 + 1)", "x = 'a_11'"));
    it("x = 'a' + ('_' + 1) + 1", () => fold("x = 'a' + ('_' + 1) + 1", "x = 'a_11'"));
    // fold("x = 1 + (p1 + '_') + ('' + p2)", "x = 1 + (p1 + '_') + p2");
    // fold("x = 1 + p1 + '_' + ('' + p2)", "x = 1 + p1 + '_' + p2");
    it("x = 1 + 'a' + p1", () => fold("x = 1 + 'a' + p1", "x = '1a' + p1"));
    // fold("x = (p1 + (p2 + 'a')) + 'b'", "x = (p1 + (p2 + 'ab'))");
    // fold("'a' + ('b' + p1) + 1", "'ab' + p1 + 1");
    // fold("x = 'a' + ('b' + p1 + 'c')", "x = 'ab' + (p1 + 'c')");
    it("void 0 + ''", () => fold("void 0 + ''", "'undefined'"));
    it('`${a}` + `${b}`', () => fold('`${a}` + `${b}`', '`${a}${b}`'));
    it('`${a}` + `${b}b`', () => fold('`${a}` + `${b}b`', '`${a}${b}b`'));
    it('`${a}` + `b${b}`', () => fold('`${a}` + `b${b}`', '`${a}b${b}`'));
    it('`${a}a` + `${b}`', () => fold('`${a}a` + `${b}`', '`${a}a${b}`'));
    it('`${a}a` + `${b}b`', () => fold('`${a}a` + `${b}b`', '`${a}a${b}b`'));
    it('`${a}a` + `b${b}`', () => fold('`${a}a` + `b${b}`', '`${a}ab${b}`'));
    it('`a${a}` + `${b}`', () => fold('`a${a}` + `${b}`', '`a${a}${b}`'));
    it('`a${a}` + `${b}b`', () => fold('`a${a}` + `${b}b`', '`a${a}${b}b`'));
    it('`a${a}` + `b${b}`', () => fold('`a${a}` + `b${b}`', '`a${a}b${b}`'));
    it('foo() + `${a}` + `${b}`', () => fold('foo() + `${a}` + `${b}`', 'foo() + `${a}${b}`'));
    it("x = 'a' + (4 + p1 + 'a')", () => foldSame("x = 'a' + (4 + p1 + 'a')"));
    it('x = p1 / 3 + 4', () => foldSame('x = p1 / 3 + 4'));
    it("foo() + 3 + 'a' + foo()", () => foldSame("foo() + 3 + 'a' + foo()"));
    it("x = 'a' + ('b' + p1 + p2)", () => foldSame("x = 'a' + ('b' + p1 + p2)"));
    it("x = 1 + ('a' + p1)", () => foldSame("x = 1 + ('a' + p1)"));
    it("x = p1 + '' + p2", () => foldSame("x = p1 + '' + p2"));
    it("x = 'a' + (1 + p1)", () => foldSame("x = 'a' + (1 + p1)"));
    it("x = (p2 + 'a') + (1 + p1)", () => foldSame("x = (p2 + 'a') + (1 + p1)"));
    it("x = (p2 + 'a') + (1 + p1 + p2)", () => foldSame("x = (p2 + 'a') + (1 + p1 + p2)"));
    it("x = (p2 + 'a') + (1 + (p1 + p2))", () => foldSame("x = (p2 + 'a') + (1 + (p1 + p2))"));
});

describe('test_fold_arithmetic', () => {
    it('1n+ +1n', () => fold('1n+ +1n', '1n + +1n'));
    it('1n- -1n', () => fold('1n- -1n', '1n - -1n'));
    it('a- -b', () => fold('a- -b', 'a - -b'));
});

describe('test_fold_arithmetic_infinity', () => {
    it('x=-Infinity-2', () => fold('x=-Infinity-2', 'x=-Infinity'));
    it('x=Infinity-2', () => fold('x=Infinity-2', 'x=Infinity'));
    it('x=Infinity*5', () => fold('x=Infinity*5', 'x=Infinity'));
    it('x = Infinity ** 2', () => fold('x = Infinity ** 2', 'x = Infinity'));
    it('x = Infinity ** -2', () => fold('x = Infinity ** -2', 'x = 0'));
    it('x = Infinity % Infinity', () => fold('x = Infinity % Infinity', 'x = NaN'));
    it('x = Infinity % 0', () => fold('x = Infinity % 0', 'x = NaN'));
});

describe('test_fold_add', () => {
    it('x = 10 + 20', () => fold('x = 10 + 20', 'x = 30'));
    it('x = y + 10 + 20', () => foldSame('x = y + 10 + 20'));
    it('x = 1 + null', () => fold('x = 1 + null', 'x = 1'));
    it('x = null + 1', () => fold('x = null + 1', 'x = 1'));
});

describe('test_fold_numeric_expression_only_if_shorter', () => {
    // https://github.com/oxc-project/oxc/issues/24863
    it('0.1 + 0.05', () => foldSame('0.1 + 0.05'));
    it('0.7 + 0.1', () => foldSame('0.7 + 0.1'));
    it('0.3 - 0.1', () => foldSame('0.3 - 0.1'));
    it('0.1 + (0.2 - 0.1) * 0.5', () => fold('0.1 + (0.2 - 0.1) * 0.5', '0.1 + 0.05'));
    it('0.7 + (0.9 - 0.7) * 0.5', () => fold('0.7 + (0.9 - 0.7) * 0.5', '0.8'));
    it('1e3 + 1e-10', () => foldSame('1e3 + 1e-10'));
    it('1e12 + 1e12', () => fold('1e12 + 1e12', '2e12'));
    it('1e12 - 1e12', () => fold('1e12 - 1e12', '0'));
    // Compare against the original expression, not the longer value of a nested operand.
    it('0 + (0.1 + 0.05)', () => foldSame('0 + (0.1 + 0.05)'));
    // Do not evaluate across an operand with side effects.
    it('f() + 0.05', () => foldSame('f() + 0.05'));
});

describe('test_fold_sub', () => {
    it('x = 10 - 20', () => fold('x = 10 - 20', 'x = -10'));
});

describe('test_fold_multiply', () => {
    it('x = 2.25 * 3', () => fold('x = 2.25 * 3', 'x = 6.75'));
    it('z = x * y', () => foldSame('z = x * y'));
    it('x = f() * 2', () => foldSame('x = f() * 2'));
    it('x = y * 5', () => foldSame('x = y * 5'));
    it('x = null * undefined', () => fold('x = null * undefined', 'x = NaN'));
    it('x = null * 1', () => fold('x = null * 1', 'x = 0'));
    it('x = (null - 1) * 2', () => fold('x = (null - 1) * 2', 'x = -2'));
    it('x = (null + 1) * 2', () => fold('x = (null + 1) * 2', 'x = 2'));
    // test("x = y + (z * 24 * 60 * 60 * 1000)", "x = y + z * 864E5");
    it('x = y + (z & 24 & 60 & 60 & 1000)', () => fold('x = y + (z & 24 & 60 & 60 & 1000)', 'x = y + (z & 8)'));
    it('x = -1 * -1', () => fold('x = -1 * -1', 'x = 1'));
    it('x = 1 * -1', () => fold('x = 1 * -1', 'x = -1'));
    it('x = 255 * 255', () => fold('x = 255 * 255', 'x = 65025'));
    it('x = -255 * 255', () => fold('x = -255 * 255', 'x = -65025'));
    it('x = -255 * -255', () => fold('x = -255 * -255', 'x = 65025'));
    it('x = 256 * 255', () => fold('x = 256 * 255', 'x = 65280'));
});

describe('test_fold_division', () => {
    it('x = Infinity / Infinity', () => fold('x = Infinity / Infinity', 'x = NaN'));
    it('x = Infinity / 0', () => fold('x = Infinity / 0', 'x = Infinity'));
    // `1 / 0` is the canonical printed spelling of Infinity and is kept as-is.
    it('x = 1 / 0', () => foldSame('x = 1 / 0'));
    it('x = -1 / 0', () => foldSame('x = -1 / 0'));
    // A negative-zero divisor is not canonical and can still be folded.
    it('x = 1 / -0', () => fold('x = 1 / -0', 'x = -Infinity'));
    it('x = -1 / -0', () => fold('x = -1 / -0', 'x = Infinity'));
    it('x = 0 / 0', () => fold('x = 0 / 0', 'x = NaN'));
    it('x = 360 / 360', () => fold('x = 360 / 360', 'x = 1'));
    it('x = 10.5 / 0.75', () => fold('x = 10.5 / 0.75', 'x = 14'));
    it('x = -10.5 / 0.75', () => fold('x = -10.5 / 0.75', 'x = -14'));
    it('x = 0 / -1', () => fold('x = 0 / -1', 'x = -0'));
    it('x = -0 / 1', () => fold('x = -0 / 1', 'x = -0'));
    it('x = -5e-324 / 2', () => fold('x = -5e-324 / 2', 'x = -0'));
    it('x = 9007199254740992 / 2', () => fold('x = 9007199254740992 / 2', 'x = 4503599627370496'));
    it('x = 2 / 4', () => foldSame('x = 2 / 4'));
    it('x = 0.3 / 0.1', () => foldSame('x = 0.3 / 0.1'));
    it('x = 1e-323 / 2', () => foldSame('x = 1e-323 / 2'));
    it('x = 1 / 1e-15', () => foldSame('x = 1 / 1e-15'));
    it('x = 9007199254740991 / 0.5', () => foldSame('x = 9007199254740991 / 0.5'));
    it('x = f() / 2', () => foldSame('x = f() / 2'));
    it('x = (void f()) / 1', () => foldSame('x = (void f()) / 1'));
    it('x = ({ valueOf: f }) / 2', () => foldSame('x = ({ valueOf: f }) / 2'));
    it('x = 4n / 2n', () => foldSame('x = 4n / 2n'));
    it('x = 4n / 2', () => foldSame('x = 4n / 2'));
    it('x = 4n / 0n', () => foldSame('x = 4n / 0n'));
    it('x = y / 2 / 4', () => foldSame('x = y / 2 / 4'));
});

describe('test_fold_remainder', () => {
    it('x = 3 % 2', () => fold('x = 3 % 2', 'x = 1'));
    it('x = 3 % -2', () => fold('x = 3 % -2', 'x = 1'));
    it('x = -1 % 3', () => fold('x = -1 % 3', 'x = -1'));
    it('x = -1 % 1', () => fold('x = -1 % 1', 'x = -0'));
    it('x = 5.5 % 1.5', () => fold('x = 5.5 % 1.5', 'x = 1'));
    it('x = 1 % 0', () => fold('x = 1 % 0', 'x = NaN'));
    it('x = 0 % 0', () => fold('x = 0 % 0', 'x = NaN'));
    it('x = 18014398509481982 % 18014398509481984', () => foldSame('x = 18014398509481982 % 18014398509481984'));
    it('x = 0.3 % 0.1', () => foldSame('x = 0.3 % 0.1'));
    it('x = f() % 2', () => foldSame('x = f() % 2'));
    it('x = 1 % f()', () => foldSame('x = 1 % f()'));
    it('x = 5n % 2n', () => foldSame('x = 5n % 2n'));
    it('x = 4n % 3n', () => foldSame('x = 4n % 3n'));
});

describe('test_fold_exponential', () => {
    it('x = 2 ** 3', () => fold('x = 2 ** 3', 'x = 8'));
    it('x = 10 ** 4', () => fold('x = 10 ** 4', 'x = 1e4'));
    it('x = (-2) ** 3', () => fold('x = (-2) ** 3', 'x = -8'));
    it('x = 0.5 ** -2', () => foldSame('x = 0.5 ** -2'));
    it('x = 4 ** 0.5', () => foldSame('x = 4 ** 0.5'));
    it('x = (-5e-324) ** 3', () => foldSame('x = (-5e-324) ** 3'));
    it('x = 2 ** -3', () => foldSame('x = 2 ** -3'));
    it('x = 2 ** 50', () => foldSame('x = 2 ** 50'));
    it('x = 2 ** 55', () => foldSame('x = 2 ** 55'));
    it('x = 1e8 ** 2', () => foldSame('x = 1e8 ** 2'));
    it('x = 3 ** -1', () => foldSame('x = 3 ** -1'));
    it('x = f() ** 2', () => foldSame('x = f() ** 2'));
    it('x = 2 ** f()', () => foldSame('x = 2 ** f()'));
    it('x = ({ valueOf: f }) ** 2', () => foldSame('x = ({ valueOf: f }) ** 2'));
    it('x = 2n ** 3n', () => foldSame('x = 2n ** 3n'));
    it('x = 2n ** 3', () => foldSame('x = 2n ** 3'));
    it('x = 2 ** 3n', () => foldSame('x = 2 ** 3n'));
    it('x = (void f()) ** 0', () => foldSame('x = (void f()) ** 0'));
    it('function f(Infinity) { return Infinity ** 0; }', () => testSame('function f(Infinity) {\n\treturn Infinity ** 0;\n}'));
    it('x = (-1) ** 0.5', () => foldSame('x = (-1) ** 0.5'));
    it('x = (-0) ** 3', () => fold('x = (-0) ** 3', 'x = -0'));
    it('x = null ** 0', () => fold('x = null ** 0', 'x = 1'));
});

describe('test_fold_arithmetic_undefined_null_operands', () => {
    // `undefined` has no literal form (it prints as `void 0`), so it never
    // satisfied the two-numeric-literals extraction; these folds see through
    // ToNumber(undefined) = NaN / ToNumber(null) = 0 instead. terser folds
    // all of these.
    it('x = void 0 * 2', () => fold('x = void 0 * 2', 'x = NaN'));
    it('x = void 0 - 1', () => fold('x = void 0 - 1', 'x = NaN'));
    it('x = 2 / void 0', () => fold('x = 2 / void 0', 'x = NaN'));
    it('x = void 0 % 2', () => fold('x = void 0 % 2', 'x = NaN'));
    it('x = (void 0) ** 2', () => fold('x = (void 0) ** 2', 'x = NaN'));
    it('x = null * 2', () => fold('x = null * 2', 'x = 0'));
    it("x = '2' * '3'", () => fold("x = '2' * '3'", 'x = 6'));
    it('x = true * 5', () => fold('x = true * 5', 'x = 5'));
    // A tracked constant resolves through the same evaluator path, so the
    // implicit undefined of `let a;` folds without being textually inlined.
    it('let a; NOOP(a * 2)', () => test('let a; NOOP(a * 2)', 'let a; NOOP(NaN)'));
    // An operand with side effects must not fold even though ToNumber of
    // the other side is known.
    it('x = f() * 0', () => foldSame('x = f() * 0'));
    // Mixing BigInt and Number throws at runtime; ToNumber of a BigInt bails.
    it('x = 1n * 2', () => foldSame('x = 1n * 2'));
});

describe('test_fold_non_finite_result_with_shadowed_global', () => {
    // A NaN result is materialized as a numeric literal that codegen prints
    // as the identifier `NaN`; a local `let NaN` binding captures it and
    // changes what the function returns. Same shape for `Infinity`. The fold
    // must bail when the corresponding global name is shadowed.
    it('function f() { let NaN = 1; return 0 / 0; }', () => testSame('function f() {\n\tlet NaN = 1;\n\treturn 0 / 0;\n}'));
    it('function f() { let Infinity = 1; return 1 / 0; }', () =>
        testSame('function f() {\n\tlet Infinity = 1;\n\treturn 1 / 0;\n}'));
});

describe('test_fold_shift_left', () => {
    it('1 << 3', () => fold('1 << 3', '8'));
    it('1.2345 << 0', () => fold('1.2345 << 0', '1'));
    it('1 << 24', () => foldSame('1 << 24'));
});

describe('test_fold_shift_right', () => {
    it('2147483647 >> -32.1', () => fold('2147483647 >> -32.1', '2147483647'));
});

describe('test_fold_shift_right_zero_fill', () => {
    it('10 >>> 1', () => fold('10 >>> 1', '5'));
    it('-1 >>> 0', () => foldSame('-1 >>> 0'));
});

describe('test_fold_left', () => {
    it('(+x - 1) + 2', () => fold('(+x - 1) + 2', 'x - 1 + 2'));
    // not yet
    it('(+x & 1) & 2', () => fold('(+x & 1) & 2', 'x & 0'));
});

describe('test_fold_array_length', () => {
    // Can fold
    it('x = [].length', () => fold('x = [].length', 'x = 0'));
    it('x = [1,2,3].length', () => fold('x = [1,2,3].length', 'x = 3'));
    // test("x = [a,b].length", "x = 2");
    it("x = 'abc'['length']", () => fold("x = 'abc'['length']", 'x = 3'));
    // Not handled yet
    it('x = [,,1].length', () => fold('x = [,,1].length', 'x = 3'));
    // Foldable after constant spread elements are inlined
    it('[...[1, 2, 3]].length', () => fold('[...[1, 2, 3]].length', '3'));
    // Cannot fold
    it('x = [foo(), 0].length', () => fold('x = [foo(), 0].length', 'x = [foo(),0].length'));
    it('x = y.length', () => foldSame('x = y.length'));
});

describe('test_fold_string_length', () => {
    // Can fold basic strings.
    it("x = ''.length", () => fold("x = ''.length", 'x = 0'));
    it("x = '123'.length", () => fold("x = '123'.length", 'x = 3'));
    // Test Unicode escapes are accounted for.
    it("x = '123\\u01dc'.length", () => fold("x = '123\\u01dc'.length", 'x = 4'));
});

describe('test_fold_instance_of', () => {
    // Non object types are never instances of anything.
    it('64 instanceof Object', () => fold('64 instanceof Object', '!1'));
    it('64 instanceof Number', () => fold('64 instanceof Number', '!1'));
    it("'' instanceof Object", () => fold("'' instanceof Object", '!1'));
    it("'' instanceof String", () => fold("'' instanceof String", '!1'));
    it('true instanceof Object', () => fold('true instanceof Object', '!1'));
    it('true instanceof Boolean', () => fold('true instanceof Boolean', '!1'));
    it('!0 instanceof Object', () => fold('!0 instanceof Object', '!1'));
    it('!0 instanceof Boolean', () => fold('!0 instanceof Boolean', '!1'));
    it('false instanceof Object', () => fold('false instanceof Object', '!1'));
    it('null instanceof Object', () => fold('null instanceof Object', '!1'));
    it('undefined instanceof Object', () => fold('undefined instanceof Object', '!1'));
    it('NaN instanceof Object', () => fold('NaN instanceof Object', '!1'));
    it('Infinity instanceof Object', () => fold('Infinity instanceof Object', '!1'));
    // Array and object literals are known to be objects.
    it('[] instanceof Object', () => fold('[] instanceof Object', '!0'));
    it('({}) instanceof Object', () => fold('({}) instanceof Object', '!0'));
    // These cases is foldable, but no handled currently.
    it('new Foo() instanceof Object', () => foldSame('new Foo() instanceof Object'));
    // These would require type information to fold.
    it('[] instanceof Foo', () => foldSame('[] instanceof Foo'));
    it('({}) instanceof Foo', () => foldSame('({}) instanceof Foo'));
    it('(function() {}) instanceof Object', () => fold('(function() {}) instanceof Object', '!0'));
    // An unknown value should never be folded.
    it('x instanceof Foo', () => foldSame('x instanceof Foo'));
    it('var x; foo(x instanceof Object)', () => testSame('var x; foo(x instanceof Object)'));
    it('x instanceof Object', () => foldSame('x instanceof Object'));
    it('0 instanceof Foo', () => foldSame('0 instanceof Foo'));
});

describe('test_fold_instance_of_additional', () => {
    it('(typeof {}) instanceof Object', () => fold('(typeof {}) instanceof Object', '!1'));
    it('(+{}) instanceof Number', () => fold('(+{}) instanceof Number', '!1'));
    it('({ __proto__: null }) instanceof Object', () => foldSame('({ __proto__: null }) instanceof Object'));
    it('/foo/ instanceof Object', () => fold('/foo/ instanceof Object', '!0'));
    it('(() => {}) instanceof Object', () => fold('(() => {}) instanceof Object', '!0'));
    it('(function(){}) instanceof Object', () => fold('(function(){}) instanceof Object', '!0'));
    it('(class{}) instanceof Object', () => fold('(class{}) instanceof Object', '!0'));
});

describe('test_fold_left_child_op', () => {
    it('x & Infinity & 2', () => fold('x & Infinity & 2', 'x & 0'));
    it('x - Infinity - 2', () => foldSame('x - Infinity - 2'));
    // FIXME: want "x-Infinity"
    it('x - 1 + Infinity', () => foldSame('x - 1 + Infinity'));
    it('x - 2 + 1', () => foldSame('x - 2 + 1'));
    it('x - 2 + 3', () => foldSame('x - 2 + 3'));
    it('1 + x - 2 + 1', () => foldSame('1 + x - 2 + 1'));
    it('1 + x - 2 + 3', () => foldSame('1 + x - 2 + 3'));
    it('1 + x - 2 + 3 - 1', () => foldSame('1 + x - 2 + 3 - 1'));
    it('f(x)-0', () => foldSame('f(x)-0'));
    it('x-0-0', () => foldSame('x-0-0'));
    // FIXME: want x - 0
    it('x+2-2+2', () => foldSame('x+2-2+2'));
    it('x+2-2+2-2', () => foldSame('x+2-2+2-2'));
    it('x-2+2', () => foldSame('x-2+2'));
    it('x-2+2-2', () => foldSame('x-2+2-2'));
    it('x-2+2-2+2', () => foldSame('x-2+2-2+2'));
    it('1+x-0-na_n', () => foldSame('1+x-0-na_n'));
    it('1+f(x)-0-na_n', () => foldSame('1+f(x)-0-na_n'));
    it('1+x-0+na_n', () => foldSame('1+x-0+na_n'));
    it('1+f(x)-0+na_n', () => foldSame('1+f(x)-0+na_n'));
    it('1+x+na_n', () => foldSame('1+x+na_n'));
    // unfoldable
    it('x+2-2', () => foldSame('x+2-2'));
    // unfoldable
    it('x+2', () => foldSame('x+2'));
    // nothing to do
    it('x-2', () => foldSame('x-2'));
    // nothing to do
});

describe('test_associative_fold_constants_with_variables', () => {
    // mul and add should not fold
    it('alert(x * 12 * 20)', () => foldSame('alert(x * 12 * 20)'));
    it('alert(12 * x * 20)', () => foldSame('alert(12 * x * 20)'));
    it('alert(x + 12 + 20)', () => foldSame('alert(x + 12 + 20)'));
    it('alert(12 + x + 20)', () => foldSame('alert(12 + x + 20)'));
    it('alert(x & 12 & 20)', () => fold('alert(x & 12 & 20)', 'alert(x & 4)'));
    it('alert(12 & x & 20)', () => fold('alert(12 & x & 20)', 'alert(x & 4)'));
});

// https://github.com/rolldown/rolldown/issues/10656
describe('test_does_not_duplicate_large_tracked_strings_when_folding_addition', () => {
    it("const p = 'PAYLOADpayload0123456789PAYLOADpayload0123456789'; export const a = atob(p); export const", () =>
        testSame(
            "const p = 'PAYLOADpayload0123456789PAYLOADpayload0123456789'; export const a = atob(p); export const b = 'y' + p;",
        ));
    it("const p = 'PAYLOADpayload0123456789PAYLOADpayload0123456789'; export const a = atob(p); export const", () =>
        testSame(
            "const p = 'PAYLOADpayload0123456789PAYLOADpayload0123456789'; export const a = atob(p); export const b = 'x' + ('y' + p);",
        ));
    // A large string with one read is still inlineable and foldable.
    it("const p = 'PAYLOADpayload0123456789PAYLOADpayload0123456789'; export const b = 'y' + p;", () =>
        test(
            "const p = 'PAYLOADpayload0123456789PAYLOADpayload0123456789'; export const b = 'y' + p;",
            "const p = 'PAYLOADpayload0123456789PAYLOADpayload0123456789'; export const b = 'yPAYLOADpayload0123456789PAYLOADpayload0123456789';",
        ));
    // Small tracked strings remain cheap enough to inline and fold.
    it("const p = 'abc'; export const a = atob(p); export const b = 'y' + p;", () =>
        test(
            "const p = 'abc'; export const a = atob(p); export const b = 'y' + p;",
            "const p = 'abc'; export const a = atob('abc'); export const b = 'yabc';",
        ));
});

describe('test_to_number', () => {
    it("x = +''", () => fold("x = +''", 'x = 0'));
    it("x = +'+Infinity'", () => fold("x = +'+Infinity'", 'x = Infinity'));
    it("x = +'-Infinity'", () => fold("x = +'-Infinity'", 'x = -Infinity'));
    for (const op of ['', '+', '-']) {
        for (const s of ['inf', 'infinity', 'INFINITY', 'InFiNiTy']) {
            it(`x = +'${op}${s}'`, () => fold(`x = +'${op}${s}'`, 'x = NaN'));
        }
    }
});

describe('test_number_constructor', () => {
    it('Number(undefined)', () => fold('Number(undefined)', 'NaN'));
    it('Number(void 0)', () => fold('Number(void 0)', 'NaN'));
    it('Number(null)', () => fold('Number(null)', '0'));
    it('Number(true)', () => fold('Number(true)', '1'));
    it('Number(false)', () => fold('Number(false)', '0'));
    it("Number('a')", () => fold("Number('a')", 'NaN'));
    it("Number('1')", () => fold("Number('1')", '1'));
    it('var Number; NOOP(Number(1))', () => testSame('var Number; NOOP(Number(1))'));
});

describe('test_fold_useless_string_addition', () => {
    it('typeof foo', () => foldSame('typeof foo'));
    it("typeof foo + '123'", () => foldSame("typeof foo + '123'"));
    it("typeof foo + ''", () => fold("typeof foo + ''", 'typeof foo'));
    it("'' + typeof foo", () => fold("'' + typeof foo", 'typeof foo'));
    it('typeof foo + ``', () => fold('typeof foo + ``', 'typeof foo'));
    it('`` + typeof foo', () => fold('`` + typeof foo', 'typeof foo'));
    it('typeof foo + []', () => fold('typeof foo + []', 'typeof foo'));
    it('[] + typeof foo', () => fold('[] + typeof foo', 'typeof foo'));
    it("(foo ? 'a' : 'b') + ''", () => fold("(foo ? 'a' : 'b') + ''", "foo ? 'a' : 'b'"));
    it("typeof foo - ''", () => foldSame("typeof foo - ''"));
});

describe('test_fold_same_typeof', () => {
    it('typeof foo === typeof bar', () => fold('typeof foo === typeof bar', 'typeof foo == typeof bar'));
    it('typeof foo !== typeof bar', () => fold('typeof foo !== typeof bar', 'typeof foo != typeof bar'));
    it('typeof foo.bar === typeof foo.bar', () => fold('typeof foo.bar === typeof foo.bar', 'typeof foo.bar == typeof foo.bar'));
    it('typeof foo.bar !== typeof foo.bar', () => fold('typeof foo.bar !== typeof foo.bar', 'typeof foo.bar != typeof foo.bar'));
});

describe('test_fold_invalid_typeof_comparison', () => {
    it('typeof foo == 123', () => fold('typeof foo == 123', '!1'));
    it("typeof foo == '123'", () => fold("typeof foo == '123'", '!1'));
    it('typeof foo === null', () => fold('typeof foo === null', '!1'));
    it('typeof foo === undefined', () => fold('typeof foo === undefined', '!1'));
    it('typeof foo !== 123', () => fold('typeof foo !== 123', '!0'));
    it("typeof foo !== '123'", () => fold("typeof foo !== '123'", '!0'));
    it('typeof foo != null', () => fold('typeof foo != null', '!0'));
    it('typeof foo != undefined', () => fold('typeof foo != undefined', '!0'));
    it("typeof foo === 'string'", () => fold("typeof foo === 'string'", "typeof foo == 'string'"));
    it("typeof foo === 'number'", () => fold("typeof foo === 'number'", "typeof foo == 'number'"));
    // strict equality with an object is always false
    it('typeof foo === [1]', () => fold('typeof foo === [1]', '!1'));
    it('typeof foo !== [1]', () => fold('typeof foo !== [1]', '!0'));
    it("typeof foo === ['object']", () => fold("typeof foo === ['object']", '!1'));
    // but loose equality with an object can be true via ToPrimitive:
    // `typeof foo == ['object']` is true when foo is an object
    it("typeof foo == ['object']", () => foldSame("typeof foo == ['object']"));
    it("typeof foo != ['object']", () => foldSame("typeof foo != ['object']"));
    it("typeof foo == ['function']", () => foldSame("typeof foo == ['function']"));
    it("typeof foo == [['object']]", () => foldSame("typeof foo == [['object']]"));
    it("typeof foo == { toString: () => 'object' }", () => foldSame("typeof foo == { toString: () => 'object' }"));
    it('typeof foo == [x]', () => foldSame('typeof foo == [x]'));
    // folds when the object's string value is statically known
    // to not be a typeof result
    it('typeof foo == [1]', () => fold('typeof foo == [1]', '!1'));
    it("typeof foo == ['x']", () => fold("typeof foo == ['x']", '!1'));
    it('typeof foo == []', () => fold('typeof foo == []', '!1'));
    it('typeof foo == [1, 2]', () => fold('typeof foo == [1, 2]', '!1'));
    it('typeof foo == {}', () => fold('typeof foo == {}', '!1'));
});

describe('test_fold_keep_side_effects_in_typeof_comparison', () => {
    it('typeof f() == 1', () => foldSame('typeof f() == 1'));
    it("typeof f() === 'asd'", () => fold("typeof f() === 'asd'", "typeof f() == 'asd'"));
    it('typeof x === [f()]', () => foldSame('typeof x === [f()]'));
});

describe('test_issue_8782', () => {
    it('+(void unknown())', () => fold('+(void unknown())', '+void unknown()'));
});

describe('test_inline_values_in_template_literal', () => {
    it('`foo${1}`', () => fold('`foo${1}`', "'foo1'"));
    it('`foo${1}bar`', () => fold('`foo${1}bar`', "'foo1bar'"));
    it('`foo${1}bar${2}baz`', () => fold('`foo${1}bar${2}baz`', "'foo1bar2baz'"));
    it('`foo${1}bar${2}baz${3}qux`', () => fold('`foo${1}bar${2}baz${3}qux`', "'foo1bar2baz3qux'"));
    it('`foo${1}${i}`', () => fold('`foo${1}${i}`', '`foo1${i}`'));
    it("`foo${'${}'}`", () => fold("`foo${'${}'}`", "'foo${}'"));
    it("`foo${'${}'}${i}`", () => fold("`foo${'${}'}${i}`", '`foo\\${}${i}`'));
    it('foo`foo${1}bar`', () => foldSame('foo`foo${1}bar`'));
});

// Regression: when `fold_object_exp` drops or folds a spread, the dropped
// subtree must be walked through `drop_expression` so identifier references
// inside don't leak across passes. The discriminating signal is an
// otherwise-inlineable symbol that stays uninlined because a stale
// write-ref hangs around in `Scoping` (#22736).
//
// Test options keep unused declarations (`CompressOptionsUnused::Keep`), so
// `let x` survives — but with no cached write references the inline pass
// replaces `return x` with the constant value. Without the drop walk, the
// dropped subtree's stale write-ref leaves the count at 1 and inline is
// blocked.
describe('test_fold_object_spread_drop_walks_argument_refs', () => {
    // Path 2: spread argument is a side-effect-free function expression,
    // folded away entirely. The write to `x` inside the function body must
    // be cleared from `Scoping`, otherwise the constant inline of `x`
    // below is blocked by a stale write-reference.
    it("function f() { let x = 'a'; ({...function(){ x = 'b' }}); return x; }", () =>
        test(
            "function f() { let x = 'a'; ({...function(){ x = 'b' }}); return x; }",
            "function f() { let x = 'a'; return 'a'; }",
        ));
    // Path 3: non-computed `__proto__` from an inlined object literal is
    // elided because it would set the prototype rather than become a
    // regular property. The dropped property's value subtree must be
    // walked for the same reason.
    it("function f() { let x = 'a'; ({...{__proto__: function(){ x = 'b' }}}); return x; }", () =>
        test(
            "function f() { let x = 'a'; ({...{__proto__: function(){ x = 'b' }}}); return x; }",
            "function f() { let x = 'a'; return 'a'; }",
        ));
});

describe('test_fold_bitwise_op_with_big_int', () => {
    it('x = 1n & 1n', () => fold('x = 1n & 1n', 'x = 1n'));
    it('x = 1n & 2n', () => fold('x = 1n & 2n', 'x = 0n'));
    it('x = 3n & 1n', () => fold('x = 3n & 1n', 'x = 1n'));
    it('x = 3n & 3n', () => fold('x = 3n & 3n', 'x = 3n'));
    it('x = 1n | 1n', () => fold('x = 1n | 1n', 'x = 1n'));
    it('x = 1n | 2n', () => fold('x = 1n | 2n', 'x = 3n'));
    it('x = 1n | 3n', () => fold('x = 1n | 3n', 'x = 3n'));
    it('x = 3n | 1n', () => fold('x = 3n | 1n', 'x = 3n'));
    it('x = 3n | 3n', () => fold('x = 3n | 3n', 'x = 3n'));
    it('x = 1n | 4n', () => fold('x = 1n | 4n', 'x = 5n'));
    it('x = 1n ^ 1n', () => fold('x = 1n ^ 1n', 'x = 0n'));
    it('x = 1n ^ 2n', () => fold('x = 1n ^ 2n', 'x = 3n'));
    it('x = 3n ^ 1n', () => fold('x = 3n ^ 1n', 'x = 2n'));
    it('x = 3n ^ 3n', () => fold('x = 3n ^ 3n', 'x = 0n'));
    it('x = -1n & 0n', () => fold('x = -1n & 0n', 'x = 0n'));
    it('x = 0n & -1n', () => fold('x = 0n & -1n', 'x = 0n'));
    it('x = 1n & 4n', () => fold('x = 1n & 4n', 'x = 0n'));
    it('x = 2n & 3n', () => fold('x = 2n & 3n', 'x = 2n'));
    it('x = 1n & 3000000000n', () => fold('x = 1n & 3000000000n', 'x = 0n'));
    it('x = 3000000000n & 1n', () => fold('x = 3000000000n & 1n', 'x = 0n'));
    // bitwise OR does not affect the sign of a bigint
    it('x = 1n | 3000000001n', () => fold('x = 1n | 3000000001n', 'x = 3000000001n'));
    it('x = 4294967295n | 0n', () => fold('x = 4294967295n | 0n', 'x = 4294967295n'));
    it('x = y & 1n & 1n', () => fold('x = y & 1n & 1n', 'x = y & 1n'));
    it('x = y & 1n & 2n', () => fold('x = y & 1n & 2n', 'x = y & 0n'));
    it('x = y & 3n & 1n', () => fold('x = y & 3n & 1n', 'x = y & 1n'));
    it('x = 3n & y & 1n', () => fold('x = 3n & y & 1n', 'x = y & 1n'));
    it('x = y & 3n & 3n', () => fold('x = y & 3n & 3n', 'x = y & 3n'));
    it('x = 3n & y & 3n', () => fold('x = 3n & y & 3n', 'x = y & 3n'));
    it('x = y | 1n | 1n', () => fold('x = y | 1n | 1n', 'x = y | 1n'));
    it('x = y | 1n | 2n', () => fold('x = y | 1n | 2n', 'x = y | 3n'));
    it('x = y | 3n | 1n', () => fold('x = y | 3n | 1n', 'x = y | 3n'));
    it('x = 3n | y | 1n', () => fold('x = 3n | y | 1n', 'x = y | 3n'));
    it('x = y | 3n | 3n', () => fold('x = y | 3n | 3n', 'x = y | 3n'));
    it('x = 3n | y | 3n', () => fold('x = 3n | y | 3n', 'x = y | 3n'));
    it('x = y ^ 1n ^ 1n', () => fold('x = y ^ 1n ^ 1n', 'x = y ^ 0n'));
    it('x = y ^ 1n ^ 2n', () => fold('x = y ^ 1n ^ 2n', 'x = y ^ 3n'));
    it('x = y ^ 3n ^ 1n', () => fold('x = y ^ 3n ^ 1n', 'x = y ^ 2n'));
    it('x = 3n ^ y ^ 1n', () => fold('x = 3n ^ y ^ 1n', 'x = y ^ 2n'));
    it('x = y ^ 3n ^ 3n', () => fold('x = y ^ 3n ^ 3n', 'x = y ^ 0n'));
    it('x = 3n ^ y ^ 3n', () => fold('x = 3n ^ y ^ 3n', 'x = y ^ 0n'));
    // TypeError: Cannot mix BigInt and other types
    it('1n & 1', () => foldSame('1n & 1'));
    it('1n | 1', () => foldSame('1n | 1'));
    it('1n ^ 1', () => foldSame('1n ^ 1'));
});

describe('test_bigint_number_comparison', () => {
    it('1n < 2', () => fold('1n < 2', '!0'));
    it('1n > 2', () => fold('1n > 2', '!1'));
    it('1n == 1', () => fold('1n == 1', '!0'));
    it('1n == 2', () => fold('1n == 2', '!1'));
    // comparing with decimals is allowed
    it('1n < 1.1', () => fold('1n < 1.1', '!0'));
    it('1n < 1.9', () => fold('1n < 1.9', '!0'));
    it('1n < 0.9', () => fold('1n < 0.9', '!1'));
    it('-1n < -1.1', () => fold('-1n < -1.1', '!1'));
    it('-1n < -1.9', () => fold('-1n < -1.9', '!1'));
    it('-1n < -0.9', () => fold('-1n < -0.9', '!0'));
    it('1n > 1.1', () => fold('1n > 1.1', '!1'));
    it('1n > 0.9', () => fold('1n > 0.9', '!0'));
    it('-1n > -1.1', () => fold('-1n > -1.1', '!0'));
    it('-1n > -0.9', () => fold('-1n > -0.9', '!1'));
    // Don't fold unsafely large numbers because there might be floating-point error
    it(`0n > ${MAX_SAFE_INT}`, () => fold(`0n > ${MAX_SAFE_INT}`, '!1'));
    it(`0n < ${MAX_SAFE_INT}`, () => fold(`0n < ${MAX_SAFE_INT}`, '!0'));
    it(`0n > ${NEG_MAX_SAFE_INT}`, () => fold(`0n > ${NEG_MAX_SAFE_INT}`, '!0'));
    it(`0n < ${NEG_MAX_SAFE_INT}`, () => fold(`0n < ${NEG_MAX_SAFE_INT}`, '!1'));
    it(`0n > ${MAX_SAFE_FLOAT}`, () => fold(`0n > ${MAX_SAFE_FLOAT}`, '!1'));
    it(`0n < ${MAX_SAFE_FLOAT}`, () => fold(`0n < ${MAX_SAFE_FLOAT}`, '!0'));
    it(`0n > ${NEG_MAX_SAFE_FLOAT}`, () => fold(`0n > ${NEG_MAX_SAFE_FLOAT}`, '!0'));
    it(`0n < ${NEG_MAX_SAFE_FLOAT}`, () => fold(`0n < ${NEG_MAX_SAFE_FLOAT}`, '!1'));
    // comparing with Infinity is allowed
    it('1n < Infinity', () => fold('1n < Infinity', '!0'));
    it('1n > Infinity', () => fold('1n > Infinity', '!1'));
    it('1n < -Infinity', () => fold('1n < -Infinity', '!1'));
    it('1n > -Infinity', () => fold('1n > -Infinity', '!0'));
    // null is interpreted as 0 when comparing with bigint
    it('1n < null', () => fold('1n < null', '!1'));
    it('1n > null', () => fold('1n > null', '!0'));
});

describe('test_bigint_string_comparison', () => {
    it("1n < '2'", () => fold("1n < '2'", '!0'));
    it("2n > '1'", () => fold("2n > '1'", '!0'));
    it("123n > '34'", () => fold("123n > '34'", '!0'));
    it("1n == '1'", () => fold("1n == '1'", '!0'));
    it("1n == '2'", () => fold("1n == '2'", '!1'));
    it("1n != '1'", () => fold("1n != '1'", '!1'));
    it("1n === '1'", () => fold("1n === '1'", '!1'));
    it("1n !== '1'", () => fold("1n !== '1'", '!0'));
});

describe('test_string_bigint_comparison', () => {
    it("'1' < 2n", () => fold("'1' < 2n", '!0'));
    it("'2' > 1n", () => fold("'2' > 1n", '!0'));
    it("'123' > 34n", () => fold("'123' > 34n", '!0'));
    it("'1' == 1n", () => fold("'1' == 1n", '!0'));
    it("'1' == 2n", () => fold("'1' == 2n", '!1'));
    it("'1' != 1n", () => fold("'1' != 1n", '!1'));
    it("'1' === 1n", () => fold("'1' === 1n", '!1'));
    it("'1' !== 1n", () => fold("'1' !== 1n", '!0'));
});

describe('test_object_bigint_comparison', () => {
    it('{ valueOf: function() { return 0n; } } != 0n', () => foldSame('{ valueOf: function() { return 0n; } } != 0n'));
    it("{ toString: function() { return '0'; } } != 0n", () => foldSame("{ toString: function() { return '0'; } } != 0n"));
});

describe('test_fold_object_spread', () => {
    it('({ z, ...a })', () => foldSame('({ z, ...a })'));
    const result = '({ z })';
    it('({ z, ...[] })', () => fold('({ z, ...[] })', result));
    it('({ z, ...{} })', () => fold('({ z, ...{} })', result));
    it('({ z, ...undefined })', () => fold('({ z, ...undefined })', result));
    it('({ z, ...void 0 })', () => fold('({ z, ...void 0 })', result));
    it('({ z, ...null })', () => fold('({ z, ...null })', result));
    it('({ z, ...true })', () => fold('({ z, ...true })', result));
    it('({ z, ...!0 })', () => fold('({ z, ...!0 })', result));
    it('({ z, ...!1 })', () => fold('({ z, ...!1 })', result));
    it('({ z, ...1 })', () => fold('({ z, ...1 })', result));
    it('({ z, ...1n })', () => fold('({ z, ...1n })', result));
    it('({ z, .../asdf/ })', () => fold('({ z, .../asdf/ })', result));
    it('({ z, ...()=>{} })', () => fold('({ z, ...()=>{} })', result));
    it('({ z, ...function(){} })', () => fold('({ z, ...function(){} })', result));
    it("({ z, ...'abc' })", () => foldSame("({ z, ...'abc' })"));
    it('({ a: 0, ...{ b: 1 } })', () => fold('({ a: 0, ...{ b: 1 } })', '({ a: 0, b: 1 })'));
    it('({ a: 0, ...{ b: 1, ...{ c: 2 } } })', () => fold('({ a: 0, ...{ b: 1, ...{ c: 2 } } })', '({ a: 0, b: 1, c: 2 })'));
    it('({ a: 0, ...{ a: 1 } })', () => fold('({ a: 0, ...{ a: 1 } })', '({ a: 0, a: 1 })'));
    // can be fold to `({ a: 1 })`
    it('({ a: foo(), ...{ a: bar() } })', () => fold('({ a: foo(), ...{ a: bar() } })', '({ a: foo(), a: bar() })'));
    // can be fold to `({ a: (foo(), bar()) })`
    it('({ ...{ get a() { return 0 } } })', () => foldSame('({ ...{ get a() { return 0 } } })'));
    it('({ ...{ __proto__: null } })', () => fold('({ ...{ __proto__: null } })', '({})'));
    it("({ ...{ '__proto__': null } })", () => fold("({ ...{ '__proto__': null } })", '({})'));
    it('({ a: foo(), ...{ __proto__: bar() }, b: baz() })', () => foldSame('({ a: foo(), ...{ __proto__: bar() }, b: baz() })'));
    // can be folded to `({ a: foo(), b: (bar(), baz()) })`
    it('({ ...{ __proto__() {} } })', () => fold('({ ...{ __proto__() {} } })', '({ __proto__() {} })'));
    it("({ ...{ ['__proto__']: null } })", () => fold("({ ...{ ['__proto__']: null } })", "({ ['__proto__']: null })"));
});
