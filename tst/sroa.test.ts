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

describe('sroa — typed shapes (in-file)', () => {
    const buildTs = async (src: string) =>
        (await bundle({ input: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), output: { minify: { compress: false } } })).code;

    const parityTs = async (src: string) => {
        const on = await buildTs(src);
        const off = await buildTs(src.replace(/\/\* @sroa \*\//g, ''));
        expect(exportShape(await runModule(on))).toEqual(exportShape(await runModule(off)));
        return on;
    };

    it('takes the shape from a local `type` alias when the initialiser is opaque', async () => {
        const src = [
            'type Vec2 = { x: number; y: number };',
            'function mk(): Vec2 { return { x: 3, y: 4 }; }',
            'export function len2() {',
            '  /* @sroa */ const v: Vec2 = mk();',
            '  return v.x * v.x + v.y * v.y;',
            '}',
            'export const out = len2();',
        ].join('\n');
        const code = await parityTs(src);
        expect((await runModule(code)).out).toBe(25);
        expect(code).toMatch(/\{\s*x:\s*v_x,\s*y:\s*v_y\s*\}\s*=\s*mk\(\)/); // destructured once
        expect(code).not.toMatch(/v\.x/);
    });

    // Pins the invariant the shape collector's DEFERRED resolution exists for. Shape capture used to
    // be a standalone pre-pass that walked the whole program to gather aliases before resolving any
    // of them; it is now folded into the single lowering traversal, which meets a declaration BEFORE
    // it has necessarily seen the alias. Resolution therefore happens after the walk. Without that,
    // this case silently loses its shape and SROA declines to fire — output stays correct, just
    // bigger, which is exactly the kind of regression a correctness suite would not catch.
    it('resolves an alias declared AFTER the declaration that uses it', async () => {
        const src = [
            'export function len2() {',
            '  /* @sroa */ const v: Vec2 = mk();',
            '  return v.x * v.x + v.y * v.y;',
            '}',
            'function mk(): Vec2 { return { x: 3, y: 4 }; }',
            'type Vec2 = { x: number; y: number };', // declared LAST, used above
            'export const out = len2();',
        ].join('\n');
        const code = await parityTs(src);
        expect((await runModule(code)).out).toBe(25);
        expect(code).toMatch(/\{\s*x:\s*v_x,\s*y:\s*v_y\s*\}\s*=\s*mk\(\)/); // shape was found
        expect(code).not.toMatch(/v\.x/);
    });

    it('works from an `interface`', async () => {
        const src = [
            'interface P { a: number; b: number }',
            'function mk(): P { return { a: 1, b: 2 }; }',
            'export function f() { /* @sroa */ const p: P = mk(); return p.a + p.b; }',
            'export const out = f();',
        ].join('\n');
        const code = await parityTs(src);
        expect((await runModule(code)).out).toBe(3);
        expect(code).toContain('p_a');
    });

    it('works from an inline type literal and a tuple type', async () => {
        const src = [
            'function mkO(): { m: number } { return { m: 7 }; }',
            'function mkT(): [number, number] { return [1, 2]; }',
            'export function f() {',
            '  /* @sroa */ const o: { m: number } = mkO();',
            '  /* @sroa */ const t: [number, number] = mkT();',
            '  return o.m + t[0] + t[1];',
            '}',
            'export const out = f();',
        ].join('\n');
        const code = await parityTs(src);
        expect((await runModule(code)).out).toBe(10);
        expect(code).toMatch(/\[\s*t_0,\s*t_1\s*\]\s*=\s*mkT\(\)/); // tuple destructures positionally
    });

    it('REFUSES an optional field — the shape is not fully known', async () => {
        const src = [
            'type Maybe = { a: number; b?: number };',
            'function mk(): Maybe { return { a: 1 }; }',
            'export function f() { /* @sroa */ const v: Maybe = mk(); return v.a; }',
            'export const out = f();',
        ].join('\n');
        const code = await parityTs(src);
        expect((await runModule(code)).out).toBe(1);
        expect(code).toContain('v.a'); // refused
    });

    it('REFUSES a type it cannot resolve in this file', async () => {
        const src = [
            'declare function mk(): any;',
            'export function f(mkv: any) { /* @sroa */ const v: SomeExternal = mkv(); return v.a; }',
            'export const out = f(() => ({ a: 5 }));',
        ].join('\n');
        const code = await parityTs(src.replace('SomeExternal', 'any'));
        expect((await runModule(code)).out).toBe(5);
        expect(code).toContain('v.a');
    });
});
