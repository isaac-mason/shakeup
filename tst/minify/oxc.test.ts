// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are JS source under test.
// Ported from oxc_minifier/tests/peephole/oxc.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { test, testSame } from './harness.ts';

describe('integration', () => {
    it("require('./index.js')(function (e, os) {\n    if (e) return c", () =>
        test(
            "require('./index.js')(function (e, os) {\n    if (e) return console.log(e)\n    return console.log(JSON.stringify(os))\n    })",
            'require("./index.js")(function(e, os) {\n    return console.log(e || JSON.stringify(os));\n    });',
        ));
    it('if (!(foo instanceof Var) || open) {\n          arg0 = null;\n', () =>
        test(
            'if (!(foo instanceof Var) || open) {\n          arg0 = null;\n        } else if (que || !(foo && bar)) {\n          if (baz()) arg0 = null;\n        }',
            '(!(foo instanceof Var) || open || (que || !(foo && bar)) && baz()) && (arg0 = null);',
        ));
    it('function foo() {\n          if (value === null || Array.isArr', () =>
        test(
            'function foo() {\n          if (value === null || Array.isArray(value))\n            return undefined;\n          return isTimeDisabled === null || isTimeDisabled === void 0 ? void 0 : isTimeDisabled(value);\n    }',
            'function foo() {\n        if (!(value === null || Array.isArray(value))) return isTimeDisabled == null ? void 0 : isTimeDisabled(value);\n    }',
        ));
    it('a && (b && (c && (d && (e && (f && (g && (h && i && j && k &', () =>
        testSame(
            'a && (b && (c && (d && (e && (f && (g && (h && i && j && k && l && m && n && o && p && q && r && s && t && u && v && w && x && y && z)))))))',
        ));
    it("if (((() => console.log('effect'))(), true)) {\n         } el", () =>
        test(
            "if (((() => console.log('effect'))(), true)) {\n         } else {\n           var c = 1;\n           for (var c; unknownGlobal && true; unknownGlobal && true) var d;\n         }\n         console.log(c, d);\n        ",
            "if (console.log('effect'), !1) var c, c, d;\n        console.log(c, d);\n        ",
        ));
    it("v = KEY === 'delete' ? function () {\n          return 1;\n   ", () =>
        test(
            "v = KEY === 'delete' ? function () {\n          return 1;\n        } : KEY === 'has' ? function has () {\n          return 1;\n        } : function set () {\n          return 2;\n        };\n        ",
            "v = KEY === 'delete' || KEY === 'has' ? function () { return 1 } : function () { return 2 }",
        ));
});

describe('fold', () => {
    it('var x = (-0).toString()', () => test('var x = (-0).toString()', "var x = '0'"));
    it('var x = (-0).toString(36)', () => test('var x = (-0).toString(36)', "var x = '0'"));
    it('var x = (-123).toString()', () => test('var x = (-123).toString()', "var x = '-123'"));
    it('var x = (-Infinity).toString()', () => test('var x = (-Infinity).toString()', "var x = '-Infinity'"));
    it('var x = (-1000000).toString(36)', () => test('var x = (-1000000).toString(36)', 'var x = (-1e6).toString(36)'));
});

describe('tagged_template', () => {
    it('(1, o.f)()', () => test('(1, o.f)()', '(0, o.f)()'));
    it('(1, o.f)``', () => test('(1, o.f)``', '(0, o.f)``'));
    it('(!0 && o.f)()', () => test('(!0 && o.f)()', '(0, o.f)()'));
    it('(!0 && o.f)``', () => test('(!0 && o.f)``', '(0, o.f)``'));
    it('(!0 ? o.f : !1)()', () => test('(!0 ? o.f : !1)()', '(0, o.f)()'));
    it('(!0 ? o.f : !1)``', () => test('(!0 ? o.f : !1)``', '(0, o.f)``'));
    it('foo(true && o.f)', () => test('foo(true && o.f)', 'foo(o.f)'));
    it('foo(true ? o.f : false)', () => test('foo(true ? o.f : false)', 'foo(o.f)'));
});

describe('eval', () => {
    it('(!0 && eval)(x)', () => test('(!0 && eval)(x)', '(0, eval)(x)'));
    it('(1 ? eval : 2)(x)', () => test('(1 ? eval : 2)(x)', '(0, eval)(x)'));
    it('(1 ? eval : 2)?.(x)', () => test('(1 ? eval : 2)?.(x)', '(0, eval)?.(x)'));
    it('(1, eval)(x)', () => test('(1, eval)(x)', '(0, eval)(x)'));
    it('(1, eval)?.(x)', () => test('(1, eval)?.(x)', '(0, eval)?.(x)'));
    it('(3, eval)(x)', () => test('(3, eval)(x)', '(0, eval)(x)'));
    it('(4, eval)?.(x)', () => test('(4, eval)?.(x)', '(0, eval)?.(x)'));
    it('(eval)(x)', () => testSame('(eval)(x)'));
    it('(eval)?.(x)', () => testSame('(eval)?.(x)'));
    it('eval(x)', () => testSame('eval(x)'));
    it('eval(x, y)', () => testSame('eval(x, y)'));
    it('eval(x,y)', () => testSame('eval(x,y)'));
    it('eval?.(x)', () => testSame('eval?.(x)'));
    it('eval?.(x)', () => testSame('eval?.(x)'));
    it('eval?.(x, y)', () => testSame('eval?.(x, y)'));
    it('eval?.(x,y)', () => testSame('eval?.(x,y)'));
});
