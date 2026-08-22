import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (src: string, minify: boolean | { compress?: boolean; mangle?: boolean; whitespace?: boolean }) => {
    const result = await bundle({ entry: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), output: { minify } });
    expect(result.errors).toEqual([]);
    return result.code;
};

/** Build the same source both un-minified and compress-only, execute both bundles, and assert the
 *  exported `out` is identical (and, when given, equals `expected`). This is the load-bearing check:
 *  a fold is only allowed if it preserves the runtime value bit-for-bit. */
const parity = async (src: string, expected?: unknown) => {
    const plain = await build(src, false);
    const compressed = await build(src, { compress: true });
    const plainOut = (await run(plain)).out;
    const compressedOut = (await run(compressed)).out;
    expect(compressedOut).toStrictEqual(plainOut);
    if (expected !== undefined) expect(compressedOut).toStrictEqual(expected);
    return { plain, compressed, out: compressedOut };
};

describe('fold-constants (compress)', () => {
    // ---- SAFE folds: the op collapses to a literal AND the value is preserved -----------------
    it('folds numeric addition', async () => {
        const { compressed, out } = await parity('export const out = 2 + 3;');
        expect(out).toBe(5);
        expect(compressed).toMatch(/=\s*5\b/);
        expect(compressed).not.toMatch(/2\s*\+\s*3/);
    });

    it('folds numeric multiplication / subtraction / nested chains', async () => {
        expect((await parity('export const out = 4 * 5;')).out).toBe(20);
        expect((await parity('export const out = 10 - 3;')).out).toBe(7);
        // nested: bottom-up fold in one traversal, (1+2)+3 -> 6
        const { compressed, out } = await parity('export const out = 1 + 2 + 3;');
        expect(out).toBe(6);
        expect(compressed).toMatch(/=\s*6\b/);
    });

    it('folds bitwise and shift ops', async () => {
        expect((await parity('export const out = 6 & 3;')).out).toBe(2);
        expect((await parity('export const out = 1 << 4;')).out).toBe(16);
        expect((await parity('export const out = -1 >>> 28;')).out).toBe(15);
    });

    it('folds string concatenation of two string literals', async () => {
        const { compressed, out } = await parity('export const out = "a" + "b";');
        expect(out).toBe('ab');
        expect(compressed).toMatch(/"ab"|'ab'|`ab`/);
        expect(compressed).not.toMatch(/"a"\s*\+\s*"b"/);
    });

    it('folds numeric comparisons to booleans', async () => {
        expect((await parity('export const out = 1 < 2;')).out).toBe(true);
        expect((await parity('export const out = 2 <= 2;')).out).toBe(true);
        expect((await parity('export const out = 3 === 4;')).out).toBe(false);
        expect((await parity('export const out = 5 !== 5;')).out).toBe(false);
    });

    it('folds unary !, -, ~, and typeof over literals', async () => {
        expect((await parity('export const out = !true;')).out).toBe(false);
        expect((await parity('export const out = !0;')).out).toBe(true);
        expect((await parity('export const out = !"";')).out).toBe(true);
        expect((await parity('export const out = !null;')).out).toBe(true);
        expect((await parity('export const out = -5 - 1;')).out).toBe(-6);
        expect((await parity('export const out = ~5;')).out).toBe(-6);
        expect((await parity('export const out = typeof 1;')).out).toBe('number');
        expect((await parity('export const out = typeof "x";')).out).toBe('string');
        expect((await parity('export const out = typeof null;')).out).toBe('object');
    });

    it('folds the exact double for 0.1 + 0.2 (round-trips) and preserves the value', async () => {
        const { compressed, out } = await parity('export const out = 0.1 + 0.2;');
        expect(out).toBe(0.30000000000000004);
        // The emitted literal is the exact shortest round-tripping repr, not `0.3`.
        expect(compressed).toMatch(/0\.30000000000000004/);
    });

    // ---- ADVERSARIAL: must NOT fold to a wrong value (parity is the real guard) ---------------
    it('does NOT fold to Infinity (1 / 0)', async () => {
        const { compressed, out } = await parity('export const out = 1 / 0;');
        expect(out).toBe(Infinity);
        expect(compressed).not.toMatch(/Infinity/); // no bogus `Infinity` literal
        expect(compressed).toMatch(/1\s*\/\s*0/); // left as a live division
    });

    it('does NOT fold NaN (0 / 0)', async () => {
        const { out } = await parity('export const out = 0 / 0;');
        expect(Number.isNaN(out)).toBe(true);
    });

    it('does NOT collapse -0 into 0 (Object.is distinguishes them)', async () => {
        // -1 * 0 === -0; folding to `0` would flip Object.is(out, -0) from true to false.
        const { out } = await parity('export const out = -1 * 0;');
        expect(Object.is(out, -0)).toBe(true);
    });

    it('does NOT fold mixed number + string (no coercion emulation)', async () => {
        const { out } = await parity('export const out = 1 + "a";');
        expect(out).toBe('1a');
    });

    it('does NOT fold mixed boolean + number', async () => {
        const { out } = await parity('export const out = true + 1;');
        expect(out).toBe(2);
    });

    it('does NOT fold anything involving an identifier', async () => {
        // A PARAMETER `x` (not a constant — constant-propagation can't inline it) keeps `x + 3` a
        // live add, isolating fold-constants' "don't fold a non-literal operand" behavior.
        const { compressed, out } = await parity('export function f(x) { return x + 3; }\nexport const out = f(2);');
        expect(out).toBe(5);
        expect(compressed).toMatch(/x\s*\+\s*3|x\+3/); // the `x + 3` survives (x is not a literal)
    });

    it('does NOT fold underscore-separated numeric literals (Number() rejects them)', async () => {
        const { out } = await parity('export const out = 1_000 + 1;');
        expect(out).toBe(1001);
    });

    it('value-parity: minify:false vs compress-only agree across a mixed expression program', async () => {
        const src = [
            'export const a = 2 + 3 * 4;',
            'export const b = "x" + "y" + "z";',
            'export const c = !false && (1 < 2);',
            'const id = 7;',
            'export const d = id * 2 + 1;',
            'export const e = 0.1 + 0.2;',
            'export const out = [a, b, c, d, e];',
        ].join('\n');
        const plain = await build(src, false);
        const compressed = await build(src, { compress: true });
        const p = await run(plain);
        const q = await run(compressed);
        for (const k of ['a', 'b', 'c', 'd', 'e', 'out']) expect(q[k]).toStrictEqual(p[k]);
        expect(q.out).toStrictEqual([14, 'xyz', true, 15, 0.30000000000000004]);
    });

    it('does not fire without compress (plain build keeps the un-folded expression)', async () => {
        const code = await build('export const out = 2 + 3;', false);
        expect(code).toMatch(/2\s*\+\s*3/);
        expect((await run(code)).out).toBe(5);
    });
});
