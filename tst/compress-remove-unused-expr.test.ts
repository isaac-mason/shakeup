import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (src: string, minify: boolean | { compress?: boolean }) => {
    const result = await bundle({ entry: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), output: { minify } });
    expect(result.errors).toEqual([]);
    return result.code;
};

function normalize(v: unknown): unknown {
    if (typeof v === 'function') return '$fn';
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === 'object') {
        const o: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as object)) o[k] = normalize(val);
        return o;
    }
    return v;
}

/** compress-only vs plain, execute both, assert exports identical — including side-effect ORDER. */
const parity = async (src: string) => {
    const on = await build(src, { compress: true });
    const off = await build(src, false);
    expect(normalize(await run(on))).toEqual(normalize(await run(off)));
    return on;
};

describe('remove-unused-expression (compress)', () => {
    it('drops a fully pure expression statement', async () => {
        const code = await parity(
            'export function f() { 1 + 2; "dead"; [1, 2, 3]; typeof f; return 5; }\nexport const out = f();',
        );
        expect(code).not.toMatch(/"dead"/);
        expect(code).not.toMatch(/typeof/);
    });

    it('strips pure parts of a sequence, keeping effects', async () => {
        const src = [
            'export const log = [];',
            'function eff(x) { log.push(x); }',
            'export function f() { (eff("a"), 5, eff("b")); return log.length; }',
            'export const out = f();',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(2); // both effs kept, `5` dropped
    });

    it('keeps only effectful array elements', async () => {
        const src = [
            'export const log = [];',
            'function eff() { log.push(1); return 9; }',
            'export function f() { [1, eff(), 3, eff()]; return log.length; }',
            'export const out = f();',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(2);
    });

    it('strips a pure right operand of `&&`, keeping the guard + effect ordering', async () => {
        const src = [
            'export const log = [];',
            'function eff() { log.push(1); return true; }',
            'export function f(c) { c && (eff(), 0); return log.length; }',
            'export const out = [f(true), f(false)];', // eff runs only when c truthy
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toEqual([1, 1]);
    });

    it('KEEPS a member read (getter-conservative — no pure-getter assumption)', async () => {
        const src = [
            'export const log = [];',
            'const o = { get a() { log.push("get"); return 1; } };',
            'export function f() { o.a; return log.length; }',
            'export const out = f();', // the getter must still fire
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(1);
    });

    it('KEEPS a call (its effect cannot be stripped)', async () => {
        const src = [
            'export const log = [];',
            'function eff() { log.push(1); }',
            'export function f() { eff(); return log.length; }',
            'export const out = f();',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(1);
        expect(code).toMatch(/eff|push/);
    });

    it('does not fire when compress is explicitly disabled', async () => {
        const code = await build('export function f() { [1, 2, 3]; return 5; }\nexport const out = f();', { compress: false });
        expect(code).toMatch(/\[1,\s?2,\s?3\]/); // dead array literal kept without compress
    });
});
