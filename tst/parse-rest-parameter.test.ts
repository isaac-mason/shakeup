// A rest parameter ends the parameter list — nothing may follow it, not even a trailing comma.
//
// ONE check in `parseParams` covers every function form, because they all parse parameters through
// it. test262 counts this as hundreds of separate failures: the `language/statements/class` and
// `language/expressions/class` clusters (909 combined) are procedurally generated from
// `src/function-forms/` templates, so a single parameter rule is replicated across every form.
//
// The neighbouring rules in those same generated files — duplicate parameters, destructuring in a
// strict body — are NOT done here. oxc raises those in `oxc_semantic`'s checker on
// `ctx.strict_mode()`; its parser has no strict-mode bit at all. Putting them in the parser would be
// the right rule in the wrong phase.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const rejects = (src: string) => {
    expect(() => new Function(src), `node must agree ${src} is invalid`).toThrow();
    expect(parse(src, { ts: false, jsx: false }).errors, src).not.toEqual([]);
};

describe('nothing may follow a rest parameter', () => {
    it.each([
        'function f(...a,) {}',
        'function f(...a, b) {}',
        '(function (...a,) {});',
        'class C { m(...a,) {} }',
        'class C { async *m(...a,) {} }',
        'class C { static m(...a,) {} }',
        '({ m(...a,) {} });',
        '({ *m(...a,) {} });',
        '(...a,) => {};',
        'async (...a,) => {};',
        'function* g(...a,) {}',
        'async function f(...a,) {}',
    ])('%s', rejects);

    it('the message distinguishes a trailing comma from a following parameter', () => {
        const msg = (src: string) => parse(src, { ts: false, jsx: false }).errors[0].msg;
        expect(msg('function f(...a,) {}')).toMatch(/trailing comma/);
        expect(msg('function f(...a, b) {}')).toMatch(/must be last/);
    });
});

describe('what stays legal', () => {
    it.each([
        'function f(...a) {}',
        'function f(a, ...b) {}',
        'function f(a,) {}',
        'function f(...[a]) {}',
        'function f(...{a}) {}',
        '({ m(a,) {} });',
        '(a,) => {};',
    ])('%s', (src) => {
        expect(() => new Function(src), 'node must agree it is valid').not.toThrow();
        expect(parse(src, { ts: false, jsx: false }).errors, src).toEqual([]);
    });

    it('an ambient declaration is exempt, as in oxc', () => {
        expect(parse('declare function g(...a,): void;', { ts: true, jsx: false }).errors).toEqual([]);
    });
});
