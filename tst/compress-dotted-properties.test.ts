import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (src: string, minify: boolean | { compress?: boolean; mangle?: boolean; whitespace?: boolean }) => {
    const result = await bundle({ entry: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), output: { minify } });
    expect(result.errors).toEqual([]);
    return result.code;
};

/** Build twice — compress-on and compress-off — and assert identical runtime values for every
 *  exported key. Every conversion case funnels through here so a syntactic swap is never asserted
 *  without proving it preserved behavior. */
/** Exported values, with functions reduced to a name/arity token. `run` imports a `data:` URL and
 *  Node caches those by URL, so when the two builds happened to be byte-identical both imports
 *  returned the SAME module instance and the comparison was trivially true. Once compress changes
 *  anything the instances differ, and comparing exported FUNCTIONS by object identity would always
 *  fail — that is an artifact of two module instances, not a behavior difference. Compare shape. */
const shape = (m: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
        Object.entries(m).map(([k, v]) => [k, typeof v === 'function' ? `[fn ${v.name}/${v.length}]` : v]),
    );

const assertParity = async (src: string) => {
    const on = await build(src, { compress: true });
    const off = await build(src, false);
    expect(shape(await run(on))).toEqual(shape(await run(off)));
    return on;
};

describe('convert-to-dotted-properties (compress)', () => {
    it('a["b"] → a.b for reads, behavior preserved', async () => {
        const src = ['const o = { b: 1, c: 2 };', 'export const b = o["b"];', 'export const c = o["c"];'].join('\n');
        const code = await assertParity(src);
        expect(code).toContain('.b');
        expect(code).not.toContain('["b"]');
        const m = await run(code);
        expect(m.b).toBe(1);
        expect(m.c).toBe(2);
    });

    it('a["b"] = v write target converts, behavior preserved', async () => {
        const src = ['const o = {};', 'o["x"] = 41;', 'o["x"] += 1;', 'export const out = o["x"];'].join('\n');
        const code = await assertParity(src);
        expect(code).not.toContain('["x"]');
        expect((await run(code)).out).toBe(42);
    });

    it('a["m"]() call target converts, behavior preserved', async () => {
        const src = ['const o = { m() { return 7; } };', 'export const out = o["m"]();'].join('\n');
        const code = await assertParity(src);
        expect(code).toContain('.m(');
        expect(code).not.toContain('["m"]');
        expect((await run(code)).out).toBe(7);
    });

    it('reserved word: a["default"] → a.default (valid after `.`)', async () => {
        const src = [
            'const o = { default: 5, class: 6, return: 7 };',
            'export const a = o["default"];',
            'export const b = o["class"];',
            'export const c = o["return"];',
        ].join('\n');
        const code = await assertParity(src);
        expect(code).toContain('.default');
        expect(code).not.toContain('["default"]');
        const m = await run(code);
        expect(m.a).toBe(5);
        expect(m.b).toBe(6);
        expect(m.c).toBe(7);
    });

    it('$ and _ keys convert', async () => {
        const src = [
            'const o = { $x: 1, _y: 2, $: 3 };',
            'export const a = o["$x"];',
            'export const b = o["_y"];',
            'export const c = o["$"];',
        ].join('\n');
        const code = await assertParity(src);
        expect(code).not.toContain('["$x"]');
        const m = await run(code);
        expect(m.a).toBe(1);
        expect(m.b).toBe(2);
        expect(m.c).toBe(3);
    });

    it('nested / chained member access converts at each level', async () => {
        const src = ['const o = { a: { b: { c: 9 } } };', 'export const out = o["a"]["b"]["c"];'].join('\n');
        const code = await assertParity(src);
        expect(code).not.toContain('["a"]');
        expect(code).not.toContain('["b"]');
        expect(code).not.toContain('["c"]');
        expect((await run(code)).out).toBe(9);
    });

    it('optional-chaining computed a?.["b"] → a?.b, behavior preserved', async () => {
        const src = [
            'const o = { b: 3 };',
            'const n = null;',
            'export const hit = o?.["b"];',
            'export const miss = n?.["b"];',
        ].join('\n');
        const code = await assertParity(src);
        expect(code).not.toContain('["b"]');
        const m = await run(code);
        expect(m.hit).toBe(3);
        expect(m.miss).toBe(undefined);
    });

    // ── ADVERSARIAL: these must be left UNCHANGED (still computed) and stay behavior-correct ─────────
    it('a["foo-bar"] (non-identifier key) is NOT converted', async () => {
        const src = ['const o = { "foo-bar": 11 };', 'export const out = o["foo-bar"];'].join('\n');
        const code = await assertParity(src);
        expect(code).toContain('["foo-bar"]');
        expect((await run(code)).out).toBe(11);
    });

    it('a["0"] (numeric-string / array-index key) is NOT converted', async () => {
        const src = [
            'const arr = [10, 20, 30];',
            'const o = { "0": 99 };',
            'export const first = arr["0"];',
            'export const zero = o["0"];',
        ].join('\n');
        const code = await assertParity(src);
        expect(code).toContain('["0"]');
        expect(code).not.toContain('.0');
        const m = await run(code);
        expect(m.first).toBe(10);
        expect(m.zero).toBe(99);
    });

    it('a["123abc"] (digit-leading) and a["with space"] are NOT converted', async () => {
        const src = [
            'const o = { "123abc": 1, "with space": 2 };',
            'export const a = o["123abc"];',
            'export const b = o["with space"];',
        ].join('\n');
        const code = await assertParity(src);
        expect(code).toContain('["123abc"]');
        expect(code).toContain('["with space"]');
        const m = await run(code);
        expect(m.a).toBe(1);
        expect(m.b).toBe(2);
    });

    it('a[""] (empty-string key) is NOT converted', async () => {
        const src = ['const o = { "": 7 };', 'export const out = o[""];'].join('\n');
        const code = await assertParity(src);
        expect(code).toContain('[""]');
        expect((await run(code)).out).toBe(7);
    });

    it('a[dynamicVar] (non-literal computed key) is NOT converted', async () => {
        // A parameter key (not a constant) stays genuinely dynamic — constant-propagation can't turn
        // it into a string literal, so dotted-properties correctly leaves `o[key]` computed.
        const src = ['export function f(o, key) { return o[key]; }', 'export const out = f({ k: 4 }, "k");'].join('\n');
        const code = await assertParity(src);
        expect(code).toContain('[key]');
        expect((await run(code)).out).toBe(4);
    });

    it('a[0] (numeric-literal computed key) is NOT converted', async () => {
        const src = ['const arr = [5, 6, 7];', 'export const out = arr[1];'].join('\n');
        const code = await assertParity(src);
        expect(code).toContain('[1]');
        expect((await run(code)).out).toBe(6);
    });

    it('does NOT fire without compress (plain build keeps computed form)', async () => {
        const code = await build('const o = { b: 1 };\nexport const b = o["b"];', false);
        expect(code).toContain('["b"]');
        expect(code).not.toMatch(/o\.b\b/);
    });
});
