// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are JS source under test.
// Ported from oxc_minifier/tests/peephole/minimize_conditional_expression.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { test, testSame, testTarget } from './harness.ts';

describe('test_minimize_expr_condition', () => {
    it('(x ? true : false) && y()', () => test('(x ? true : false) && y()', 'x && y()'));
    it('(x ? false : true) && y()', () => test('(x ? false : true) && y()', '!x && y()'));
    it('(x ? true : y) && y()', () => test('(x ? true : y) && y()', '(x || y) && y();'));
    it('(x ? y : false) && y()', () => test('(x ? y : false) && y()', '(x && y) && y()'));
    it('var x; (x && true) && y()', () => test('var x; (x && true) && y()', 'var x; x && y()'));
    it('var x; (x && false) && y()', () => test('var x; (x && false) && y()', 'var x'));
    it('(x && true) && y()', () => test('(x && true) && y()', 'x && y()'));
    it('(x && false) && y()', () => test('(x && false) && y()', 'x'));
    it('var x; (x || true) && y()', () => test('var x; (x || true) && y()', 'var x; y()'));
    it('var x; (x || false) && y()', () => test('var x; (x || false) && y()', 'var x; x && y()'));
    it('(x || true) && y()', () => test('(x || true) && y()', 'x, y()'));
    it('(x || false) && y()', () => test('(x || false) && y()', 'x && y()'));
    it('let x = foo ? true : false', () => test('let x = foo ? true : false', 'let x = !!foo'));
    it('let x = foo ? true : bar', () => test('let x = foo ? true : bar', 'let x = foo ? !0 : bar'));
    it('let x = foo ? bar : false', () => test('let x = foo ? bar : false', 'let x = foo ? bar : !1'));
    it('function x () { return a ? true : false }', () =>
        test('function x () { return a ? true : false }', 'function x() { return !!a }'));
    it('function x () { return a ? false : true }', () =>
        test('function x () { return a ? false : true }', 'function x() { return !a }'));
    it('function x () { return a ? true : b }', () =>
        test('function x () { return a ? true : b }', 'function x() { return a ? !0 : b }'));
    it('function x() { return a && true }', () => test('function x() { return a && true }', 'function x() { return a && !0 }'));
    it('foo ? bar : bar', () => test('foo ? bar : bar', 'foo, bar'));
    it('foo ? bar : baz', () => testSame('foo ? bar : baz'));
    it('foo() ? bar : bar', () => test('foo() ? bar : bar', 'foo(), bar'));
    it('var k = () => !!x;', () => testSame('var k = () => !!x;'));
});

describe('minimize_conditional_exprs', () => {
    it('(a, b) ? c : d', () => test('(a, b) ? c : d', 'a, b ? c : d'));
    it('!a ? b : c', () => test('!a ? b : c', 'a ? c : b'));
    it('/* @__PURE__ */ a() ? b : b', () => test('/* @__PURE__ */ a() ? b : b', 'b'));
    it('a ? b : b', () => test('a ? b : b', 'a, b'));
    it('a ? true : false', () => test('a ? true : false', 'a'));
    it('a ? false : true', () => test('a ? false : true', 'a'));
    it('a ? a : b', () => test('a ? a : b', 'a || b'));
    it('a ? b : a', () => test('a ? b : a', 'a && b'));
    it('a ? b ? c : d : d', () => test('a ? b ? c : d : d', 'a && b ? c : d'));
    it('a ? b : c ? b : d', () => test('a ? b : c ? b : d', 'a || c ? b : d'));
    it('a ? c : (b, c)', () => test('a ? c : (b, c)', '(a || b), c'));
    it('a ? (b, c) : c', () => test('a ? (b, c) : c', '(a && b), c'));
    it('a ? b || c : c', () => test('a ? b || c : c', '(a && b) || c'));
    it('a ? c : b && c', () => test('a ? c : b && c', '(a || b) && c'));
    it('var a, b; a ? b(c, d) : b(e, d)', () => test('var a, b; a ? b(c, d) : b(e, d)', 'var a, b; b(a ? c : e, d)'));
    it('var a, b; a ? b(...c) : b(...e)', () => test('var a, b; a ? b(...c) : b(...e)', 'var a, b; b(...a ? c : e)'));
    it('var a, b; a ? b(c) : b(e)', () => test('var a, b; a ? b(c) : b(e)', 'var a, b; b(a ? c : e)'));
    it('var a, b; a ? b() : b()', () => test('var a, b; a ? b() : b()', 'var a, b; b()'));
    it('var a, b; a === 0 ? b(c) : b(e)', () => test('var a, b; a === 0 ? b(c) : b(e)', 'var a, b; b(a === 0 ? c : e)'));
    it('var a; a === 0 ? b(c) : b(e)', () => testSame('var a; a === 0 ? b(c) : b(e)'));
    it('var b; a === 0 ? b(c) : b(e)', () => testSame('var b; a === 0 ? b(c) : b(e)'));
    it('a === 0 ? b(c) : b(e)', () => testSame('a === 0 ? b(c) : b(e)'));
    it('a() != null ? a() : b', () => test('a() != null ? a() : b', 'a() == null ? b : a()'));
    it('var a; a != null ? a : b', () => test('var a; a != null ? a : b', 'var a; a ?? b'));
    it('var a; (a = _a) != null ? a : b', () => test('var a; (a = _a) != null ? a : b', 'var a; (a = _a) ?? b'));
    it('v = a != null ? a : b', () => test('v = a != null ? a : b', 'v = a == null ? b : a'));
    it('var a; v = a != null ? a : b', () => testTarget('var a; v = a != null ? a : b', 'var a; v = a == null ? b : a', 2019));
    it('var a; v = a != null ? a.b.c[d](e) : undefined', () =>
        test('var a; v = a != null ? a.b.c[d](e) : undefined', 'var a; v = a?.b.c[d](e)'));
    it('var a; v = (a = _a) != null ? a.b.c[d](e) : undefined', () =>
        test('var a; v = (a = _a) != null ? a.b.c[d](e) : undefined', 'var a; v = (a = _a)?.b.c[d](e)'));
    it('v = a != null ? a.b.c[d](e) : undefined', () =>
        test('v = a != null ? a.b.c[d](e) : undefined', 'v = a == null ? void 0 : a.b.c[d](e)'));
    it('var a, undefined = 1; v = a != null ? a.b.c[d](e) : undefine', () =>
        test('var a, undefined = 1; v = a != null ? a.b.c[d](e) : undefined', 'var a; v = a == null ? 1 : a.b.c[d](e)'));
    it('var a; v = a != null ? a.b.c[d](e) : undefined', () =>
        testTarget('var a; v = a != null ? a.b.c[d](e) : undefined', 'var a; v = a == null ? void 0 : a.b.c[d](e)', 2019));
    it('v = cmp !== 0 ? cmp : (bar, cmp);', () => test('v = cmp !== 0 ? cmp : (bar, cmp);', 'v = (cmp === 0 && bar, cmp);'));
    it('v = cmp === 0 ? cmp : (bar, cmp);', () => test('v = cmp === 0 ? cmp : (bar, cmp);', 'v = (cmp === 0 || bar, cmp);'));
    it('v = cmp !== 0 ? (bar, cmp) : cmp;', () => test('v = cmp !== 0 ? (bar, cmp) : cmp;', 'v = (cmp === 0 || bar, cmp);'));
    it('v = cmp === 0 ? (bar, cmp) : cmp;', () => test('v = cmp === 0 ? (bar, cmp) : cmp;', 'v = (cmp === 0 && bar, cmp);'));
});

describe('compress_conditional', () => {
    it('foo ? foo : bar', () => test('foo ? foo : bar', 'foo || bar'));
    it('foo ? bar : foo', () => test('foo ? bar : foo', 'foo && bar'));
    it('x.y ? x.y : bar', () => testSame('x.y ? x.y : bar'));
    it('x.y ? bar : x.y', () => testSame('x.y ? bar : x.y'));
});

describe('test_minimize_conditional_numeric', () => {
    it('let x = !y ? 1 : 0', () => test('let x = !y ? 1 : 0', 'let x = +!y'));
    it('let x = a ? 1 : 0', () => test('let x = a ? 1 : 0', 'let x = +!!a'));
    it('let x = a + b ? 1 : 0', () => test('let x = a + b ? 1 : 0', 'let x = a + b ? 1 : 0'));
    it('let x = a ? 0 : 1', () => test('let x = a ? 0 : 1', 'let x = +!a'));
    it('let x = !y ? 0 : 1', () => test('let x = !y ? 0 : 1', 'let x = +!!y'));
    it('let x = a + b ? 0 : 1', () => test('let x = a + b ? 0 : 1', 'let x = a + b ? 0 : 1'));
    it('let x = a ? 1 : -0', () => testSame('let x = a ? 1 : -0'));
    it('let x = a ? -0 : 1', () => testSame('let x = a ? -0 : 1'));
    it('let x = !y ? 1 : -0', () => test('let x = !y ? 1 : -0', 'let x = y ? -0 : 1'));
});

describe('test_minimize_conditional_boolean_value_context', () => {
    it('let x = foo() ? false : bar()', () => test('let x = foo() ? false : bar()', 'let x = !foo() && bar()'));
    it('let x = num ? false : y', () => test('let x = num ? false : y', 'let x = !num && y'));
    it('foo(a ? false : b)', () => test('foo(a ? false : b)', 'foo(!a && b)'));
    it('function f() { return a === b ? false : x }', () =>
        test('function f() { return a === b ? false : x }', 'function f() { return a !== b && x }'));
    it('let x = foo() ? bar() : true', () => test('let x = foo() ? bar() : true', 'let x = !foo() || bar()'));
    it('let x = a === b ? c : true', () => test('let x = a === b ? c : true', 'let x = a !== b || c'));
    it('let x = !a ? true : b', () => test('let x = !a ? true : b', 'let x = !a || b'));
    it('let x = a === b ? true : c', () => test('let x = a === b ? true : c', 'let x = a === b || c'));
    it('let x = a === b ? c : false', () => test('let x = a === b ? c : false', 'let x = a === b && c'));
    it('use(flag ? false : (touch(), true))', () => test('use(flag ? false : (touch(), true))', 'use(!flag && (touch(), !0))'));
    it('use(flag ? (touch(), value) : true)', () =>
        test('use(flag ? (touch(), value) : true)', 'use(!flag || (touch(), value))'));
    it('use(a === b ? true : (touch(), value))', () =>
        test('use(a === b ? true : (touch(), value))', 'use(a === b || (touch(), value))'));
    it('use(a === b ? (touch(), value) : false)', () =>
        test('use(a === b ? (touch(), value) : false)', 'use(a === b && (touch(), value))'));
    it('use((prepare(), a === b) ? true : value)', () =>
        test('use((prepare(), a === b) ? true : value)', 'use((prepare(), a === b || value))'));
    it('use((flag = a === b) ? false : value)', () =>
        test('use((flag = a === b) ? false : value)', 'use(!(flag = a === b) && value)'));
    it('use((flag = a === b) ? value : true)', () =>
        test('use((flag = a === b) ? value : true)', 'use(!(flag = a === b) || value)'));
    it('use((flag = a === b) ? true : value)', () =>
        test('use((flag = a === b) ? true : value)', 'use((flag = a === b) || value)'));
    it('use((flag = a === b) ? value : false)', () =>
        test('use((flag = a === b) ? value : false)', 'use((flag = a === b) && value)'));
    it('use((flag ? left : right) ? false : value)', () =>
        test('use((flag ? left : right) ? false : value)', 'use(!(flag ? left : right) && value)'));
    it('use((flag ? a === b : c === d) ? true : value)', () =>
        test('use((flag ? a === b : c === d) ? true : value)', 'use((flag ? a === b : c === d) || value)'));
    it('let x = num ? true : y', () => test('let x = num ? true : y', 'let x = num ? !0 : y'));
    it('let x = num ? y : false', () => test('let x = num ? y : false', 'let x = num ? y : !1'));
    it('let x = a || b ? false : c', () => test('let x = a || b ? false : c', 'let x = a || b ? !1 : c'));
    it('let x = a ? false : b ? c : d', () => test('let x = a ? false : b ? c : d', 'let x = a ? !1 : b ? c : d'));
    it('use(flag ? false : (value = touch()))', () =>
        test('use(flag ? false : (value = touch()))', 'use(flag ? !1 : value = touch())'));
    it('use(a === b || c === d ? value : false)', () =>
        test('use(a === b || c === d ? value : false)', 'use(a === b || c === d ? value : !1)'));
});
