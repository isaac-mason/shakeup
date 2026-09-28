// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are JS source under test.
// Ported from oxc_minifier/tests/peephole/minimize_not_expression.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { test, testSame } from './harness.ts';

describe('minimize_duplicate_nots', () => {
    it('!x', () => test('!x', 'x'));
    it('!!x', () => test('!!x', 'x'));
    it('!!!x', () => test('!!!x', 'x'));
    it('!!!!x', () => test('!!!!x', 'x'));
    it('!!!(x && y)', () => test('!!!(x && y)', 'x && y'));
    it('var k = () => { !!x; }', () => test('var k = () => { !!x; }', 'var k = () => { x }'));
    it('var k = !!x;', () => testSame('var k = !!x;'));
    it('function k () { return !!x; }', () => testSame('function k () { return !!x; }'));
    it('var k = () => { return !!x; }', () => test('var k = () => { return !!x; }', 'var k = () => !!x'));
    it('var k = () => !!x;', () => testSame('var k = () => !!x;'));
});

describe('minimize_nots_with_de_morgan_comparison_chains', () => {
    it('if (!(a == b || c == d)) throw x;', () => test('if (!(a == b || c == d)) throw x;', 'if (a != b && c != d) throw x;'));
    it('if (!(a === b || c === d)) throw x;', () =>
        test('if (!(a === b || c === d)) throw x;', 'if (a !== b && c !== d) throw x;'));
    it('if (!(a == b && c == d)) throw x;', () => test('if (!(a == b && c == d)) throw x;', 'if (a != b || c != d) throw x;'));
    it('function f() { if (!(a === b || c === d)) return; g(); }', () =>
        test('function f() { if (!(a === b || c === d)) return; g(); }', 'function f() { (a === b || c === d) && g(); }'));
    it('while (e) { if (!(a == b || c == d)) break; }', () =>
        test('while (e) { if (!(a == b || c == d)) break; }', 'for (; e && (a == b || c == d);) ;'));
    it('while (!(a == b || c == d)) g();', () => test('while (!(a == b || c == d)) g();', 'for (; a != b && c != d;) g();'));
    it('do g(); while (!(a == b && c == d));', () =>
        test('do g(); while (!(a == b && c == d));', 'do g(); while (a != b || c != d);'));
    it('for (; !(a == b || c == d);) g();', () => test('for (; !(a == b || c == d);) g();', 'for (; a != b && c != d;) g();'));
    it('if (!(a == b || c == d || e == f)) throw x;', () =>
        test('if (!(a == b || c == d || e == f)) throw x;', 'if (a != b && c != d && e != f) throw x;'));
    it('if (!((a == b || c == d) && e == f)) throw x;', () =>
        test('if (!((a == b || c == d) && e == f)) throw x;', 'if (a != b && c != d || e != f) throw x;'));
    it('var v = !(a == b || c == d);', () => test('var v = !(a == b || c == d);', 'var v = a != b && c != d;'));
});

describe('minimize_nots_with_de_morgan_negative_cases', () => {
    it('if (!(a < b || c < d)) throw x;', () => testSame('if (!(a < b || c < d)) throw x;'));
    it('if (!(a == b || c)) throw x;', () => testSame('if (!(a == b || c)) throw x;'));
    it('if (!(a == b && c == d || e == f)) throw x;', () => testSame('if (!(a == b && c == d || e == f)) throw x;'));
    it('var v = !!(a == b || c == d);', () => test('var v = !!(a == b || c == d);', 'var v = a == b || c == d;'));
    it('if (!(a == b && c == d)) x(); else y();', () =>
        test('if (!(a == b && c == d)) x(); else y();', 'a != b || c != d ? x() : y();'));
});

describe('minimize_nots_with_binary_expressions', () => {
    it('!(x === undefined)', () => test('!(x === undefined)', 'x'));
    it("!(typeof(x) === 'undefined')", () => test("!(typeof(x) === 'undefined')", ''));
    it("!(typeof(x()) === 'undefined')", () => test("!(typeof(x()) === 'undefined')", 'x()'));
    it('!(x === void 0)', () => test('!(x === void 0)', 'x'));
    it('!!delete x.y', () => test('!!delete x.y', 'delete x.y'));
    it('!!!delete x.y', () => test('!!!delete x.y', 'delete x.y'));
    it('!!!!delete x.y', () => test('!!!!delete x.y', 'delete x.y'));
    it('var k = !!(foo instanceof bar)', () => test('var k = !!(foo instanceof bar)', 'var k = foo instanceof bar'));
    it('!(a === 1 ? void 0 : a.b)', () => test('!(a === 1 ? void 0 : a.b)', 'a !== 1 && a.b;'));
    it('!(a, b)', () => test('!(a, b)', 'a, b'));
});
