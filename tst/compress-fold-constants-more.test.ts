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
 *  exported `out` is identical (and, when given, equals `expected`). EXECUTION PARITY is the guard:
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

describe('fold-constants — typeof over literals / literal-constructors', () => {
    // ---- SAFE: type is statically known WITHOUT evaluating the argument -------------------------
    it('folds typeof [] and typeof {} to "object"', async () => {
        const a = await parity('export const out = typeof [];', 'object');
        expect(a.compressed).toMatch(/"object"|'object'/);
        expect(a.compressed).not.toMatch(/typeof/);
        const b = await parity('export const out = typeof {};', 'object');
        expect(b.compressed).not.toMatch(/typeof/);
    });

    it('folds typeof function(){} and typeof (()=>{}) to "function"', async () => {
        const a = await parity('export const out = typeof function(){};', 'function');
        expect(a.compressed).toMatch(/"function"|'function'/);
        expect(a.compressed).not.toMatch(/typeof/);
        const b = await parity('export const out = typeof (() => {});', 'function');
        expect(b.compressed).not.toMatch(/typeof/);
    });

    it('folds typeof /re/ to "object"', async () => {
        const { compressed } = await parity('export const out = typeof /re/;', 'object');
        expect(compressed).not.toMatch(/typeof/);
    });

    it('folds typeof over a pure array/object literal with literal contents', async () => {
        await parity('export const out = typeof [1, 2, 3];', 'object');
        await parity('export const out = typeof { a: 1, b: "x" };', 'object');
    });

    it('still folds the primitive typeof cases (regression)', async () => {
        await parity('export const out = typeof 1;', 'number');
        await parity('export const out = typeof "x";', 'string');
        await parity('export const out = typeof true;', 'boolean');
        await parity('export const out = typeof null;', 'object');
    });

    // ---- ADVERSARIAL: must NOT fold ------------------------------------------------------------
    it('does NOT fold typeof <identifier> (not statically known)', async () => {
        const { compressed } = await parity('const x = 1; export const out = typeof x;', 'number');
        expect(compressed).toMatch(/typeof/); // survives
    });

    it('does NOT fold typeof over a member / call (not statically known)', async () => {
        const a = await parity('const o = { p: 1 }; export const out = typeof o.p;', 'number');
        expect(a.compressed).toMatch(/typeof/);
        const b = await parity('const f = () => 1; export const out = typeof f();', 'number');
        expect(b.compressed).toMatch(/typeof/);
    });

    it('does NOT drop side effects: typeof {a: sideEffect} keeps the call', async () => {
        // If `typeof {a: hit()}` folded to "object", the `hit()` call would be dropped — observable.
        const src = [
            'let hits = 0;',
            'const hit = () => { hits++; return 1; };',
            'const t = typeof { a: hit() };',
            'export const out = [t, hits];',
        ].join('\n');
        const { out } = await parity(src);
        expect(out).toStrictEqual(['object', 1]); // hit() ran exactly once in BOTH builds
    });

    it('does NOT drop side effects: typeof [sideEffect()] keeps the call', async () => {
        const src = [
            'let hits = 0;',
            'const hit = () => { hits++; return 1; };',
            'const t = typeof [hit()];',
            'export const out = [t, hits];',
        ].join('\n');
        const { out } = await parity(src);
        expect(out).toStrictEqual(['object', 1]);
    });
});

describe('fold-constants — .length on string / array literals', () => {
    // ---- SAFE ---------------------------------------------------------------------------------
    it('folds "abc".length to 3', async () => {
        const { compressed, out } = await parity('export const out = "abc".length;');
        expect(out).toBe(3);
        expect(compressed).toMatch(/=\s*3\b/);
        expect(compressed).not.toMatch(/\.length/);
    });

    it('folds "".length to 0 and a unicode string to its code-unit length', async () => {
        await parity('export const out = "".length;', 0);
        // "\u{1F600}" is a surrogate pair — JS .length is 2 code units.
        await parity('export const out = "\\u{1F600}".length;', 2);
    });

    it('folds [a,b,c].length to 3 for a pure array literal', async () => {
        const { compressed, out } = await parity('export const out = [1, 2, 3].length;');
        expect(out).toBe(3);
        expect(compressed).toMatch(/=\s*3\b/);
        expect(compressed).not.toMatch(/\.length/);
    });

    it('folds [].length to 0', async () => {
        await parity('export const out = [].length;', 0);
    });

    // ---- ADVERSARIAL --------------------------------------------------------------------------
    it('does NOT fold [...a].length (spread makes length unknown)', async () => {
        const { compressed } = await parity('const a = [1, 2]; export const out = [...a, 9].length;', 3);
        expect(compressed).toMatch(/\.length/); // survives — length is not static
    });

    it('does NOT fold a length access on an impure array (would drop the call)', async () => {
        const src = [
            'let hits = 0;',
            'const hit = () => { hits++; return 1; };',
            'const n = [hit(), hit()].length;',
            'export const out = [n, hits];',
        ].join('\n');
        const { out } = await parity(src);
        expect(out).toStrictEqual([2, 2]); // both hits ran in BOTH builds
    });

    it('does NOT fold x.length for an identifier object', async () => {
        const { compressed } = await parity('const s = "abcd"; export const out = s.length;', 4);
        expect(compressed).toMatch(/\.length/);
    });

    it('does NOT fold "abc"?.length (optional chain)', async () => {
        // Value parity is the guard; we do not require the fold. Just assert correctness.
        await parity('export const out = "abc"?.length;', 3);
    });
});

describe('fold-constants — string index into a string literal', () => {
    // ---- SAFE ---------------------------------------------------------------------------------
    it('folds "abc"[0] to "a" and "abc"[2] to "c"', async () => {
        const a = await parity('export const out = "abc"[0];', 'a');
        expect(a.compressed).toMatch(/"a"|'a'/);
        await parity('export const out = "abc"[2];', 'c');
    });

    // ---- ADVERSARIAL --------------------------------------------------------------------------
    it('does NOT fold an out-of-range index (yields undefined)', async () => {
        const { out } = await parity('export const out = "abc"[5];');
        expect(out).toBeUndefined();
    });

    it('does NOT fold a negative index', async () => {
        const { out } = await parity('export const out = "abc"[-1];');
        expect(out).toBeUndefined();
    });

    it('does NOT fold a non-integer index', async () => {
        const { out } = await parity('export const out = "abc"[1.5];');
        expect(out).toBeUndefined();
    });

    it('does NOT fold an array index (deliberately out of scope for v1)', async () => {
        // Correct value either way; we simply do not implement array index folding.
        await parity('export const out = [10, 20, 30][1];', 20);
    });
});
