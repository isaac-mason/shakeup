import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const build = async (src: string, minify: boolean | { compress?: boolean } = true) =>
    (await bundle({ input: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), output: { minify } })).code;

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const shape = (m: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'function' ? `[fn/${v.length}]` : v]));

/** Compressed and uncompressed builds must agree on every exported value. */
const parity = async (src: string) => {
    const on = await build(src, true);
    expect(shape(await run(on))).toEqual(shape(await run(await build(src, { compress: false }))));
    return on;
};

describe('interprocedural purity', () => {
    it('drops a discarded call to a provably pure function', async () => {
        const src = ['function add(a, b) { return a + b; }', 'add(1, 2);', 'export const out = add(3, 4);'].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(7);
        // The discarded `add(1, 2);` statement is gone; the used one survives.
        expect(code.match(/add|\(1,2\)/g) ?? []).not.toContain('(1,2)');
    });

    it('propagates impurity through the call graph (fixpoint)', async () => {
        const src = [
            'let log = 0;',
            'function bump() { log = 1; }', // impure: assignment
            'function outer(a) { bump(); return a; }', // impure via callee
            'outer(1);',
            'export const out = log;',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(1); // the call MUST have run
    });

    // ── The contract tests: shakeup is stricter than compilecat, and these prove it ──────────────
    it('does NOT treat a member read as pure — a getter may run arbitrary code', async () => {
        const src = [
            'let hits = 0;',
            'const o = { get x() { hits++; return 1; } };',
            'function readIt(p) { return p.x; }', // member read → impure under shakeup's contract
            'readIt(o);', // discarded, but MUST still run: it fires the getter
            'export const out = hits;',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(1); // getter fired — call was not dropped
    });

    it('does NOT treat a throwing function as pure', async () => {
        const src = [
            'function boom() { throw new Error("x"); }',
            'let caught = 0;',
            'try { boom(); } catch { caught = 1; }',
            'export const out = caught;',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(1); // the throw still happened
    });

    it('allows Math.* while keeping the surrounding rules', async () => {
        const src = ['function mag(a) { return Math.abs(a); }', 'mag(-3);', 'export const out = mag(-5);'].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(5);
    });
});
