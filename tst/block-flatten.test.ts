import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';
import { exportShape, runModule } from './exec-helpers.ts';

const build = async (src: string, compress: boolean | 'dce' = true) =>
    (await bundle({ input: '/m.js', fs: createMemoryFs({ '/m.js': src }), output: { minify: { compress } } })).code;

const parity = async (src: string) => {
    const on = await build(src);
    expect(exportShape(await runModule(on))).toEqual(exportShape(await runModule(await build(src, false))));
    return on;
};

describe('block-flatten', () => {
    it('lifts a bare block into its enclosing list', async () => {
        const src = [
            'export function f(o) { o.a = 1; { const t = o.a + 1; o.b = t; } o.c = 3; return o; }',
            'export const out = JSON.stringify(f({}));',
        ].join('\n');
        const code = await parity(src);
        expect(JSON.parse((await runModule(code)).out as string)).toEqual({ a: 1, b: 2, c: 3 });
        // The scaffolding block is gone; its statement survives in the parent list.
        expect(code).not.toMatch(/\{\s*(?:const|let)\s+\w+\s*=\s*\w+\.a/);
    });

    it('RENAMES on collision so two blocks declaring the same name can both lift', async () => {
        const src = [
            'export function f(o) {',
            '  { const t = 1; o.x = t; }',
            '  { const t = 2; o.y = t; }',
            '  return o;',
            '}',
            'export const out = JSON.stringify(f({}));',
        ].join('\n');
        const code = await parity(src);
        expect(JSON.parse((await runModule(code)).out as string)).toEqual({ x: 1, y: 2 });
    });

    it('KEEPS a block that declares a function (hoisting)', async () => {
        const src = [
            'export function f() { { function g() { return 1; } return g(); } }',
            'export const out = f();',
        ].join('\n');
        const code = await parity(src);
        expect((await runModule(code)).out).toBe(1);
    });

    it('does not disturb a control-flow body', async () => {
        const src = [
            'export function f(c, o) { if (c) { const t = 1; o.a = t; } return o; }',
            'export const out = [JSON.stringify(f(true, {})), JSON.stringify(f(false, {}))];',
        ].join('\n');
        const code = await parity(src);
        expect((await runModule(code)).out).toEqual(['{"a":1}', '{}']);
    });

    it('cleans up the scaffolding BLOCK inlining emits', async () => {
        const src = [
            '/* @inline */ function clamp(v, lo) { if (v < lo) return lo; return v; }',
            'export function f(a, b) { const x = clamp(a, 0); const y = clamp(b, 0); return x + y; }',
            'export const out = f(-5, 7);',
        ].join('\n');
        const code = await parity(src);
        expect((await runModule(code)).out).toBe(7);
        expect(code).not.toMatch(/\bclamp\s*\(/); // inlined
    });
});
