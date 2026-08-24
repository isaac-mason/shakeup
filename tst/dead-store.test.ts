import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';
import { exportShape, runModule } from './exec-helpers.ts';

const build = async (src: string, compress: boolean | 'dce' = true) =>
    (await bundle({ input: '/m.js', fs: createMemoryFs({ '/m.js': src }), output: { minify: { compress } } })).code;

/** Compressed output must compute exactly what uncompressed output computes. */
const parity = async (src: string) => {
    const on = await build(src);
    expect(exportShape(await runModule(on))).toEqual(exportShape(await runModule(await build(src, false))));
    return on;
};

describe('dead-store elimination', () => {
    it('drops a store whose value is never read', async () => {
        const src = [
            '/* @optimize */ export function f() { let x; x = 1; x = 2; return x; }',
            'export const out = f();',
        ].join('\n');
        const code = await parity(src);
        expect((await runModule(code)).out).toBe(2);
        expect(code).not.toContain('1'); // the dead `x = 1` is gone
    });

    it('KEEPS the right-hand side when it has side effects', async () => {
        const src = [
            'let hits = 0;',
            'function eff() { hits++; return 1; }',
            '/* @optimize */ export function f() { let x; x = eff(); x = 2; return x; }',
            'export const out = [f(), hits];',
        ].join('\n');
        const code = await parity(src);
        expect((await runModule(code)).out).toEqual([2, 1]); // eff() still ran exactly once
    });

    it('keeps a store that is read on ONE branch only', async () => {
        const src = [
            'export function f(c) { let x; x = 1; if (c) return x; x = 2; return x; }',
            'export const out = [f(true), f(false)];',
        ].join('\n');
        const code = await parity(src);
        expect((await runModule(code)).out).toEqual([1, 2]);
    });

    it('keeps a store read on the NEXT loop iteration (back edge)', async () => {
        const src = [
            'export function f(n) {',
            '  let prev = 0, acc = 0;',
            '  for (let i = 0; i < n; i++) { acc += prev; prev = i; }',
            '  return acc;',
            '}',
            'export const out = f(4);',
        ].join('\n');
        const code = await parity(src);
        expect((await runModule(code)).out).toBe(0 + 0 + 1 + 2);
    });

    it('models `break LABEL` — the shape block-inlining emits', async () => {
        const src = [
            'export function f(c) {',
            '  let r;',
            '  L: { if (c) { r = 1; break L; } r = 2; }',
            '  return r;',
            '}',
            'export const out = [f(true), f(false)];',
        ].join('\n');
        const code = await parity(src);
        expect((await runModule(code)).out).toEqual([1, 2]);
    });

    it('leaves a variable captured by a closure alone', async () => {
        const src = [
            '/* @optimize */ export function f() { let x; x = 1; const g = () => x; x = 2; return g(); }',
            'export const out = f();',
        ].join('\n');
        expect((await runModule(await parity(src))).out).toBe(2);
    });

    it('skips a function whose flow it cannot model (try)', async () => {
        const src = [
            '/* @optimize */ export function f() { let x; x = 1; try { x = 2; } catch { x = 3; } return x; }',
            'export const out = f();',
        ].join('\n');
        expect((await runModule(await parity(src))).out).toBe(2);
    });

    // Dead-store is OPTIMIZE-tier (directive-gated) as of the tier move — it earned zero bytes on
    // non-directive code while costing ~8% of every build. The dev/bundle parity property still holds
    // and is what this pins: the optimize tier runs in scan regardless of compress mode, so a
    // directive-annotated function is optimized identically in `'dce'` (dev) and full minify.
    it('runs in dev (dce) as well as full minify, so dev and bundle agree', async () => {
        const src = ['/* @optimize */ export function f() { let x; x = 1; x = 2; return x; }', 'export const out = f();'].join('\n');
        const dce = await build(src, 'dce');
        expect((await runModule(dce)).out).toBe(2);
        expect(dce).not.toContain('x = 1');
    });
});
