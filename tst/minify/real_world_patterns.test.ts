// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are JS source under test.
// Ported from oxc_minifier/tests/peephole/real_world_patterns.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { test, testSame } from './harness.ts';

describe('test_function_call_optimization', () => {
    it('String(42)', () => test('String(42)', ''));
    it('String(true)', () => test('String(true)', ''));
    it('String(null)', () => test('String(null)', ''));
    it('return String(42)', () => test('return String(42)', "return '42'"));
    it('return String(true)', () => test('return String(true)', "return 'true'"));
    it('return String(null)', () => test('return String(null)', "return 'null'"));
    it('return Boolean(1)', () => test('return Boolean(1)', 'return !0'));
    it('return Boolean(0)', () => test('return Boolean(0)', 'return !1'));
    it("return Boolean('')", () => test("return Boolean('')", 'return !1'));
    it("Number('42')", () => test("Number('42')", ''));
    it('Number(true)', () => test('Number(true)', ''));
});

describe('test_property_access_optimization', () => {
    it("obj['property']", () => test("obj['property']", 'obj.property'));
    it("obj['validName123']", () => test("obj['validName123']", 'obj.validName123'));
    it("obj['$special']", () => test("obj['$special']", 'obj.$special'));
    it("obj['123invalid']", () => testSame("obj['123invalid']"));
    it("obj['key-with-dash']", () => testSame("obj['key-with-dash']"));
    it("obj['key with space']", () => testSame("obj['key with space']"));
});

describe('test_logical_operator_optimization', () => {
    it('true && foo()', () => test('true && foo()', 'foo()'));
    it('false && foo()', () => test('false && foo()', ''));
    it('true || foo()', () => test('true || foo()', ''));
    it('false || foo()', () => test('false || foo()', 'foo()'));
    it('!!true', () => test('!!true', ''));
    it('!!false', () => test('!!false', ''));
    it('!true', () => test('!true', ''));
    it('!false', () => test('!false', ''));
    it('return !!true', () => test('return !!true', 'return !0'));
    it('return !!false', () => test('return !!false', 'return !1'));
    it('return !true', () => test('return !true', 'return !1'));
    it('return !false', () => test('return !false', 'return !0'));
});

describe('test_conditional_optimization', () => {
    it('true ? foo() : bar()', () => test('true ? foo() : bar()', 'foo()'));
    it('false ? foo() : bar()', () => test('false ? foo() : bar()', 'bar()'));
    it('if (true) foo();', () => test('if (true) foo();', 'foo();'));
    it('if (false) foo();', () => test('if (false) foo();', ''));
    it('if (true) foo(); else bar();', () => test('if (true) foo(); else bar();', 'foo();'));
    it('if (false) foo(); else bar();', () => test('if (false) foo(); else bar();', 'bar();'));
});

describe('test_assignment_optimization', () => {
    it('x = x + 1', () => test('x = x + 1', 'x += 1'));
    it('x = x - 1', () => test('x = x - 1', '--x'));
    it('x = x * 2', () => test('x = x * 2', 'x *= 2'));
    it('x = x + y', () => test('x = x + y', 'x += y'));
});

describe('test_string_concatenation', () => {
    it("'hello ' + 'world'", () => test("'hello ' + 'world'", ''));
    it("'count: ' + 42", () => test("'count: ' + 42", ''));
    it("42 + ' items'", () => test("42 + ' items'", ''));
    it("return 'hello ' + 'world'", () => test("return 'hello ' + 'world'", "return 'hello world'"));
    it("return 'count: ' + 42", () => test("return 'count: ' + 42", "return 'count: 42'"));
    it("return 42 + ' items'", () => test("return 42 + ' items'", "return '42 items'"));
    it("getValue() + 'suffix'", () => test("getValue() + 'suffix'", "getValue() + ''"));
    it("'prefix' + sideEffect()", () => test("'prefix' + sideEffect()", "'' + sideEffect();"));
});

describe('test_optimization_boundaries', () => {
    it("eval('code')", () => testSame("eval('code')"));
    // shakeup's parser rejects `with` in module code, which oxc leaves to its checker; the printer has no `with` either.
    it.skip('with (obj) { prop = value; }', () => test('with (obj) { prop = value; }', 'with(obj) prop = value;'));
    it('delete obj.prop', () => testSame('delete obj.prop'));
    it('obj.method()', () => testSame('obj.method()'));
});
