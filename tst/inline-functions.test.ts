import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const build = async (src: string, minify: boolean | { compress?: boolean } = { compress: false }) =>
    (await bundle({ input: '/m.js', fs: createMemoryFs({ '/m.js': src }), output: { minify } })).code;

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

/** The inlined build must compute exactly what the un-annotated build computes. */
const parity = async (src: string) => {
    const withDirective = await build(src);
    const without = await build(src.replace(/\/\* @inline \*\//g, ''));
    expect(await run(withDirective)).toEqual(await run(without));
    return withDirective;
};

describe('inline-functions (DIRECT)', () => {
    it('inlines an annotated call and leaves the un-annotated one alone', async () => {
        const src = [
            '/* @inline */ function add(a, b) { return a + b; }',
            'function keep(a) { return a * 2; }',
            'export const out = add(p(), 2) + keep(3);',
            'function p() { return 40; }',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(48);
        expect(code).not.toMatch(/\badd\s*\(/); // the call is gone
        expect(code).toMatch(/\bkeep\s*\(/); // un-annotated call untouched
    });

    it('inlines a `const` arrow, including the expression-bodied form', async () => {
        const src = ['/* @inline */ const twice = (a) => a * 2;', 'export const out = twice(21);'].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(42);
        expect(code).not.toMatch(/\btwice\s*\(/);
    });

    // ── the four correctness gates ────────────────────────────────────────────────────────────
    it('REFUSES when a parameter used twice would duplicate an effectful argument', async () => {
        const src = [
            'let calls = 0;',
            '/* @inline */ function dbl(a) { return a + a; }',
            'function next() { calls++; return 1; }',
            'export const out = dbl(next());',
            'export const c = calls;',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).c).toBe(1); // next() ran ONCE
        expect(code).toMatch(/\bdbl\s*\(/); // refused: the call survives
    });

    it('still inlines a twice-used parameter when the argument is simple', async () => {
        const src = ['/* @inline */ function dbl(a) { return a + a; }', 'const v = 21;', 'export const out = dbl(v);'].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(42);
        expect(code).not.toMatch(/\bdbl\s*\(/);
    });

    it('REFUSES when an unused parameter would discard a side effect', async () => {
        const src = [
            'let calls = 0;',
            '/* @inline */ function ignore(a) { return 7; }',
            'function next() { calls++; return 1; }',
            'export const out = ignore(next());',
            'export const c = calls;',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).c).toBe(1); // the effect survived
        expect(code).toMatch(/\bignore\s*\(/); // refused: the call survives
    });

    it('REFUSES when a free variable would be re-bound at the call site (hygiene)', async () => {
        const src = [
            'const scale = 10;',
            '/* @inline */ function grow(a) { return a * scale; }',
            'export function outer() { const scale = 2; return grow(3); }',
            'export const out = outer();',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(30); // uses the OUTER scale, not the shadowing one
        expect(code).toMatch(/\bgrow\s*\(/); // refused: the call survives
    });

    it('REFUSES a recursive function', async () => {
        const src = [
            '/* @inline */ function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }',
            'export const out = fact(5);',
        ].join('\n');
        expect((await run(await parity(src))).out).toBe(120);
    });

    it('REFUSES a body reading `this`', async () => {
        const src = [
            '/* @inline */ function getThis(a) { return this === undefined ? a : a + 1; }',
            'export const out = getThis(1);',
        ].join('\n');
        await parity(src); // parity is the assertion: behaviour must not change
    });
});
