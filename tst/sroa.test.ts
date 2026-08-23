import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';
import { exportShape, runModule } from './exec-helpers.ts';

const build = async (src: string) =>
    (await bundle({ input: '/m.js', fs: createMemoryFs({ '/m.js': src }), output: { minify: { compress: false } } })).code;

/** The SROA'd build must compute exactly what the un-annotated build computes. */
const parity = async (src: string) => {
    const on = await build(src);
    const off = await build(src.replace(/\/\* @sroa \*\//g, ''));
    expect(exportShape(await runModule(on))).toEqual(exportShape(await runModule(off)));
    return on;
};

describe('sroa (@sroa)', () => {
    it('replaces a tuple with scalars and removes the array', async () => {
        const src = [
            'export function f(a, b) {',
            '  /* @sroa */ const v = [a, b];',
            '  v[1] = v[0] + v[1];',
            '  return v[1];',
            '}',
            'export const out = f(1, 2);',
        ].join('\n');
        const code = await parity(src);
        expect((await runModule(code)).out).toBe(3);
        expect(code).not.toContain('[a, b]'); // the aggregate is gone
        expect(code).toContain('v_0');
        expect(code).toContain('v_1');
    });

    it('replaces a record with scalars', async () => {
        const src = [
            'export function f() {',
            '  /* @sroa */ const p = { x: 1, y: 2 };',
            '  p.x = p.x + p.y;',
            '  return p.x;',
            '}',
            'export const out = f();',
        ].join('\n');
        const code = await parity(src);
        expect((await runModule(code)).out).toBe(3);
        expect(code).toContain('p_x');
        expect(code).not.toMatch(/\{\s*x:/);
    });

    it('opts in from an enclosing function via the gate', async () => {
        const src = [
            '/* @sroa */ export function f(a) {',
            '  const v = [a, a * 2];',
            '  return v[0] + v[1];',
            '}',
            'export const out = f(3);',
        ].join('\n');
        const code = await parity(src);
        expect((await runModule(code)).out).toBe(9);
        expect(code).toContain('v_0');
    });

    // ── escape analysis: each of these must REFUSE ────────────────────────────────────────────
    it('REFUSES when the aggregate is passed as a whole object', async () => {
        const src = [
            'function use(o) { return o[0]; }',
            'export function f(a) { /* @sroa */ const v = [a]; return use(v); }',
            'export const out = f(7);',
        ].join('\n');
        const code = await parity(src);
        expect((await runModule(code)).out).toBe(7);
        expect(code).toContain('[a]'); // refused
    });

    it('REFUSES a dynamic index', async () => {
        const src = [
            'export function f(a, i) { /* @sroa */ const v = [a, a + 1]; return v[i]; }',
            'export const out = f(5, 1);',
        ].join('\n');
        const code = await parity(src);
        expect((await runModule(code)).out).toBe(6);
        expect(code).toContain('v[i]');
    });

    it('REFUSES an out-of-shape field', async () => {
        const src = [
            'export function f(a) { /* @sroa */ const v = [a]; return v[3]; }',
            'export const out = f(1);',
        ].join('\n');
        expect(await parity(src)).toContain('v[3]');
    });

    it('REFUSES a spread initialiser (shape not statically known)', async () => {
        const src = [
            'export function f(rest) { /* @sroa */ const v = [1, ...rest]; return v[0]; }',
            'export const out = f([2, 3]);',
        ].join('\n');
        expect(await parity(src)).toContain('...rest');
    });

    it('REFUSES capture by a nested function', async () => {
        const src = [
            'export function f(a) { /* @sroa */ const v = [a]; const g = () => v[0]; return g(); }',
            'export const out = f(4);',
        ].join('\n');
        const code = await parity(src);
        expect((await runModule(code)).out).toBe(4);
        expect(code).toContain('v[0]');
    });

    it('REFUSES a getter in the initialiser', async () => {
        const src = [
            'export function f() { /* @sroa */ const p = { get x() { return 1; } }; return p.x; }',
            'export const out = f();',
        ].join('\n');
        expect(await parity(src)).toContain('get x');
    });
});
