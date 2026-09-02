// A function's NAME and PARAMETERS are read in a different context from the code around them, and
// the grammar's parameter lists say exactly which:
//
//   FunctionDeclaration / GeneratorDeclaration : function [*] BindingIdentifier[?Yield, ?Await]
//   GeneratorExpression                        : function *   BindingIdentifier[+Yield, ~Await]
//   AsyncFunctionExpression                    : async function BindingIdentifier[~Yield, +Await]
//   UniqueFormalParameters[?Yield, ?Await]     — always the function's OWN
//
// So a DECLARATION's name follows the enclosing context (`function* yield(){}` is legal at the top
// level of a script, an error inside a generator) while an EXPRESSION's name follows its own
// (`(function* yield(){})` is always an error, but `(function yield(){})` inside a generator is
// fine). Parameters always follow the function's own, which is why `function* g(yield){}` is an
// error and `function* g(){ function inner(yield){} }` is not.
//
// shakeup had the expression-name rule half right — it cleared BOTH flags for every expression name,
// which is correct only for a plain `function`. A generator expression's name is `[+Yield]` and an
// async one's is `[+Await]`, so `(function* yield(){})` slipped through. Parameters were read in the
// ENCLOSING context entirely, so nothing in a function head was checked.
//
// The fix widened `inFunctionScope` to cover the head as well as the body, which is also how oxc
// reads it. That keeps it at ONE `inFunctionScope` per function — wrapping the parameters in a scope
// of their own would have meant two, which is why the head and body share one instead. `parseMethodTail` had the identical hole and is fixed the same way; a method
// has no name to place, but its parameters are its own just as a function declaration's are.
//
// NOT covered here, deliberately: `(function*(a = yield) {})` is a YieldExpression in a parameter
// default, which oxc ACCEPTS in the parser and raises in `oxc_semantic`'s `check_yield_expression`
// via `await_or_yield_in_parameter`. That is checker territory (ROADMAP §2b).
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors;
const msg = (src: string) => errs(src)[0]?.msg;

const rejects = (src: string) => {
    expect(() => new Function(src), `node must agree ${src} is invalid`).toThrow();
    expect(errs(src), src).not.toEqual([]);
};

describe('a generator may not bind `yield` in its own head', () => {
    it.each([
        'function* g(yield) {}',
        '(function*(yield) { });',
        '(async function*(yield) { });',
        '(function* yield() { });',
        '(async function* yield() { });',
        'function* g() { function* yield() {} }',
        'class C { *m(yield) {} }',
        'class C { async *m(yield) {} }',
        '({ *m(yield) {} });',
    ])('%s', rejects);

    it('reports oxc’s message', () => {
        expect(msg('function* g(yield) {}')).toBe('cannot use `yield` as an identifier in a generator context');
    });
});

describe('an async function may not bind `await` in its own head', () => {
    it.each([
        'async function f(await) {}',
        '(async function(await) { });',
        '(async function*(await) { });',
        '(async function await() { });',
        '(async function* await() { });',
        'class C { async m(await) {} }',
        '({ async m(await) {} });',
    ])('%s', rejects);

    it('reports oxc’s message', () => {
        expect(msg('async function f(await) {}')).toBe('cannot use `await` as an identifier in an async context');
    });
});

describe('what stays legal', () => {
    // A DECLARATION's name uses the enclosing context, so these are legal in a script and only the
    // module goal makes `await` reserved — which is a different rule, checked separately below.
    it.each([
        'function f(yield) {}',
        'function* yield() {}',
        'async function await() {}',
        'function* g() { (function yield() {}) }',
        'function* g() { function inner(yield) {} }',
        'async function f() { function g(await) {} }',
        'function f(a = this) {}',
        'function f(a = new.target) {}',
        'function* g(a) { yield a; }',
        'async function f(a) { await a; }',
        'const f = function*() {};',
        'class C { get x() { return 1; } }',
        'class C { static async *m(a) { yield a; } }',
        '({ m(a, b) { return a; } });',
    ])('%s', (src) => {
        expect(() => new Function(src), `node must agree ${src} is valid`).not.toThrow();
        expect(errs(src), src).toEqual([]);
    });

    it('a declaration name follows the GOAL, matching oxc in both', () => {
        const inModule = (src: string) => parse(src, { ts: false, jsx: false, kind: 'module' }).errors;
        // `await` is reserved at the top level of a module, so the enclosing context rejects it there
        // and accepts it in a script. oxc agrees on both, checked directly against `oxc-parser`.
        expect(inModule('async function await() {}')).not.toEqual([]);
        expect(errs('async function await() {}')).toEqual([]);
        // `yield` has no such module rule, so it is legal in both.
        expect(inModule('function* yield() {}')).toEqual([]);
    });

    // `class C { m(yield) {} }` is NOT in the list above on purpose. A class body is always strict,
    // where `yield` is a strict-mode reserved word — so node rejects it, oxc's PARSER accepts it, and
    // oxc raises it in `oxc_semantic`'s `check_identifier` on `ctx.strict_mode()`. Matching oxc means
    // accepting it here; it is one of the 1,365 misses §2b would close, not a hole in this rule.
    it('a strict-mode-only reserved word stays a CHECKER concern, as in oxc', () => {
        expect(errs('class C { m(yield) {} }')).toEqual([]);
        expect(() => new Function('class C { m(yield) {} }')).toThrow();
    });

    it('the TS and export forms are untouched', () => {
        for (const src of ['declare function f(): void;', 'export default function* g() {}', 'export async function f() {}']) {
            expect(parse(src, { ts: true, jsx: false, kind: 'module' }).errors, src).toEqual([]);
        }
    });
});
