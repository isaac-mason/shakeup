import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (src: string, minify: boolean | { compress?: boolean }) => {
    const result = await bundle({ entry: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), output: { minify } });
    expect(result.errors).toEqual([]);
    return result.code;
};

/** Exported functions are different instances across the two bundles (and legitimately differ in
 *  source), so collapse them to a sentinel; everything else compares structurally. */
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

/** compress-only vs plain, execute both, assert exports identical (behavior preservation is the guard). */
const parity = async (src: string) => {
    const on = await build(src, { compress: true });
    const off = await build(src, false);
    expect(normalize(await run(on))).toEqual(normalize(await run(off)));
    return on;
};

describe('constant propagation (compress)', () => {
    it('feature-flag elimination: const DEBUG = false; if (DEBUG) {…} is fully removed', async () => {
        const src = [
            'const DEBUG = false;',
            'export function f(x) { if (DEBUG) { globalThis.__hit__ = 1; } return x + 1; }',
            'export const out = f(41);',
        ].join('\n');
        const code = await parity(src);
        // DEBUG inlined to false → if(false) → dead-code eliminates the whole branch, no residue.
        expect(code).not.toMatch(/__hit__/);
        expect(code).not.toMatch(/\bif\b/);
        expect(code).not.toMatch(/&&/); // no stranded `false && …`
        expect((await run(code)).out).toBe(42);
    });

    it('inlines a single-read const of any primitive (number/string/bool/null)', async () => {
        const src = [
            'const n = 7;',
            'const s = "a-longer-string-value";', // single read → inlined regardless of size
            'const b = true;',
            'export const out = [n * 2, s.length, b ? 1 : 0];',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toEqual([14, 21, 1]);
        // the bindings are gone (inlined then reclaimed)
        expect(code).not.toMatch(/\bconst n\b|\bconst s\b|\bconst b\b/);
    });

    it('inlines a SMALL const across MULTIPLE reads', async () => {
        const src = ['const K = 5;', 'export const out = K + K + K;'].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(15);
        expect(code).not.toMatch(/\bconst K\b/);
    });

    it('does NOT inline a LARGE const across multiple reads (would bloat)', async () => {
        const big = 'this-is-a-long-constant-string';
        const src = [`const BIG = "${big}";`, 'export const out = [BIG, BIG, BIG];'].join('\n');
        const code = await parity(src);
        // Multi-read + large → NOT inlined; the single declaration is kept, referenced 3×.
        expect(code).toContain(`"${big}"`);
        expect(code).toMatch(/\bBIG\b/);
        expect((await run(code)).out).toEqual([big, big, big]);
    });

    it('does NOT inline a reassigned `let` (has writes)', async () => {
        const src = ['export function f() { let x = 1; x = 2; return x; }', 'export const out = f();'].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(2); // not the stale `1`
    });

    it('does NOT inline an object / array / function init (identity matters)', async () => {
        const src = [
            'const obj = { a: 1 };',
            'const arr = [1, 2];',
            'export const sameObj = obj === obj;', // if inlined into 2 copies, would be false
            'export const sameArr = arr === arr;',
        ].join('\n');
        const code = await parity(src);
        const m = await run(code);
        expect(m.sameObj).toBe(true);
        expect(m.sameArr).toBe(true);
    });

    it('inlines negative-number and undefined constants', async () => {
        const src = ['const NEG = -3;', 'const U = undefined;', 'export const out = [NEG * 2, U === undefined];'].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toEqual([-6, true]);
    });

    it('composes: const propagates through to enable further folding', async () => {
        const src = ['const A = 2;', 'const B = 3;', 'export const out = A * B + 1;'].join('\n');
        const code = await parity(src);
        // A→2, B→3 → 2*3+1 → fold → 7.
        expect(code).toMatch(/=\s*7\b/);
        expect((await run(code)).out).toBe(7);
    });

    it('does not fire without compress', async () => {
        const code = await build('const K = 5;\nexport const out = K + 1;', false);
        expect(code).toMatch(/\bK\b/);
        expect((await run(code)).out).toBe(6);
    });
});
