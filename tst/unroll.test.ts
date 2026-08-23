import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';
import { exportShape, runModule } from './exec-helpers.ts';

const build = async (src: string) =>
    (await bundle({ input: '/m.js', fs: createMemoryFs({ '/m.js': src }), output: { minify: { compress: false } } })).code;

const run = runModule;

/** The unrolled build must compute exactly what the un-annotated build computes. */
const parity = async (src: string) => {
    const on = await build(src);
    const off = await build(src.replace(/\/\* @unroll \*\//g, ''));
    expect(exportShape(await run(on))).toEqual(exportShape(await run(off)));
    return on;
};

describe('unroll (@unroll)', () => {
    it('unrolls a constant-bound loop and removes it', async () => {
        const src = [
            'export function sum(v) {',
            '  let acc = 0;',
            '  /* @unroll */ for (let i = 0; i < 3; i++) acc += v[i];',
            '  return acc;',
            '}',
            'export const out = sum([1, 2, 3]);',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(6);
        expect(code).not.toContain('for ('); // the loop is gone
        expect(code).toContain('v[0]');
        expect(code).toContain('v[2]');
    });

    it('handles `<=`, a step, and named numeric constants', async () => {
        const src = [
            'const N = 6;',
            'export function f(v) {',
            '  let acc = 0;',
            '  /* @unroll */ for (let i = 0; i <= N; i += 2) acc += v[i];',
            '  return acc;',
            '}',
            'export const out = f([0, 1, 2, 3, 4, 5, 6]);',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(0 + 2 + 4 + 6);
        expect(code).not.toContain('for (');
    });

    it('a zero-trip loop expands to nothing', async () => {
        const src = [
            'export function f(v) { let acc = 0; /* @unroll */ for (let i = 0; i < 0; i++) acc += v[i]; return acc; }',
            'export const out = f([9]);',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(0);
        expect(code).not.toContain('for (');
    });

    it('gives each iteration its own scope, so body declarations do not collide', async () => {
        const src = [
            'export function f(v) {',
            '  let acc = 0;',
            '  /* @unroll */ for (let i = 0; i < 3; i++) { const d = v[i] * 2; acc += d; }',
            '  return acc;',
            '}',
            'export const out = f([1, 2, 3]);',
        ].join('\n');
        expect((await run(await parity(src))).out).toBe(12);
    });

    it('closures capture the right per-iteration value', async () => {
        const src = [
            'export function f() {',
            '  const fns = [];',
            '  /* @unroll */ for (let i = 0; i < 3; i++) fns.push(() => i);',
            '  return fns.map((g) => g());',
            '}',
            'export const out = f();',
        ].join('\n');
        expect((await run(await parity(src))).out).toEqual([0, 1, 2]);
    });

    // ── refusals ──────────────────────────────────────────────────────────────────────────────
    it('is NOT implied by @optimize — unrolling stays explicitly opt-in', async () => {
        const src = [
            'export function f(v) { let a = 0; /* @optimize */ for (let i = 0; i < 3; i++) a += v[i]; return a; }',
            'export const out = f([1, 2, 3]);',
        ].join('\n');
        expect(await build(src)).toContain('for (');
    });

    it('REFUSES a loop whose body breaks or continues', async () => {
        const src = [
            'export function f(v) { let a = 0; /* @unroll */ for (let i = 0; i < 3; i++) { if (v[i] < 0) break; a += v[i]; } return a; }',
            'export const out = f([1, -1, 3]);',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(1);
        expect(code).toContain('for (');
    });

    it('REFUSES when the body writes the loop variable', async () => {
        const src = [
            'export function f() { let a = 0; /* @unroll */ for (let i = 0; i < 4; i++) { a += i; i++; } return a; }',
            'export const out = f();',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(0 + 2);
        expect(code).toContain('for (');
    });

    it('REFUSES a non-constant bound', async () => {
        const src = [
            'export function f(n, v) { let a = 0; /* @unroll */ for (let i = 0; i < n; i++) a += v[i]; return a; }',
            'export const out = f(2, [1, 2, 3]);',
        ].join('\n');
        expect(await parity(src)).toContain('for (');
    });

    it('REFUSES when the expansion exceeds the budget', async () => {
        const src = [
            'export function f(v) { let a = 0; /* @unroll */ for (let i = 0; i < 200; i++) a += v[i]; return a; }',
            'export const out = f(new Array(200).fill(1));',
        ].join('\n');
        expect(await parity(src)).toContain('for (');
    });
});
