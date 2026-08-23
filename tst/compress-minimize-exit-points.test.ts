import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const build = async (src: string, minify: boolean | { compress?: boolean } = true) =>
    (await bundle({ input: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), output: { minify } })).code;

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

/** Exported values, with functions reduced to an ARITY token. Two things about exported functions
 *  legitimately differ between the builds and say nothing about behaviour: object identity (the two
 *  builds are separate module instances) and `.name` (mangled in the minified build). */
const shape = (m: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'function' ? `[fn/${v.length}]` : v]));

/** Compressed and uncompressed builds must produce the same exported values. */
const parity = async (src: string) => {
    const on = await build(src, true);
    const off = await build(src, { compress: false });
    expect(shape(await run(on))).toEqual(shape(await run(off)));
    return on;
};

describe('minimize-exit-points (compress)', () => {
    it('folds an early-return guard into `c || (…)`', async () => {
        const src = `
            export function f(c, o) { if (c) return; o.a = 1; o.b = 2; }
            const o1 = {}; f(false, o1);
            const o2 = {}; f(true, o2);
            export const out = [o1.a, o1.b, o2.a, o2.b];`;
        const code = await parity(src);
        expect(code).not.toContain('return');
        expect((await run(code)).out).toEqual([1, 2, undefined, undefined]);
    });

    // ── ADVERSARIAL: each of these would be a MISCOMPILE if the pass fired ──────────────────────
    it('does NOT fire from a NESTED block — the guard would stop skipping later statements', async () => {
        // `{ if (c) return; A; } B;` — when `c` is truthy the original skips BOTH A and B.
        const src = `
            export function f(c, o) { { if (c) return; o.a = 1; } o.b = 2; }
            const o1 = {}; f(true, o1);
            export const out = [o1.a, o1.b];`;
        const code = await parity(src);
        expect((await run(code)).out).toEqual([undefined, undefined]); // NOT [undefined, 2]
    });

    it('does NOT fire when the guard returns a VALUE', async () => {
        const src = `
            export function f(c, o) { if (c) return 'early'; o.a = 1; return 'late'; }
            export const out = [f(true, {}), f(false, {})];`;
        const code = await parity(src);
        expect((await run(code)).out).toEqual(['early', 'late']);
    });

    it('does NOT fire when the remainder holds a declaration (hoisting hazard)', async () => {
        // `g` is called ABOVE the guard and only works because the declaration hoists; moving it into
        // a block would break that call.
        const src = `
            export function f(c) { const first = g(); if (c) return; const second = g(); return first + second; }
            function g() { return 1; }
            export const out = [f(true), f(false)];`;
        const code = await parity(src);
        expect((await run(code)).out).toEqual([undefined, 2]);
    });
});
