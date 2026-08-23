import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

// `CompressMode` — the dev/bundle parity split (oxc `CompressionMode`). `'dce'` runs every pass that
// changes which code EXISTS (removals + the folds they need); `'full'` adds the cosmetic byte-shaving.
// The point: OPTIMISATION behaves identically in dev and in a bundle, so a bug cannot hide until the
// production build. Only the cosmetic tier is allowed to differ.

const build = async (src: string, compress: false | true | 'dce') =>
    (await bundle({ input: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), output: { minify: { compress } } })).code;

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

describe('compress modes (dev/bundle parity)', () => {
    it("'dce' folds and drops a dead branch exactly like 'full'", async () => {
        const src = `
            const DEBUG = false;
            export function f() { if (DEBUG) { return 'dev-only'; } return 'shipped'; }
            export const out = f();`;
        const dce = await build(src, 'dce');
        const full = await build(src, true);
        // The dead branch is gone in BOTH — dev and bundle take the same path.
        expect(dce).not.toContain('dev-only');
        expect(full).not.toContain('dev-only');
        expect((await run(dce)).out).toBe('shipped');
        expect((await run(full)).out).toBe('shipped');
    });

    it("'dce' removes unused declarations like 'full'", async () => {
        const src = ['const used = 1;', 'const unused = 2;', 'export const out = used;'].join('\n');
        expect(await build(src, 'dce')).not.toContain('unused');
    });

    it("'dce' skips the COSMETIC tier that 'full' applies", async () => {
        // `f` is exported and never called here, so its body survives both modes and the contrast is
        // purely the cosmetic tier (a constant call site would simply fold away in both).
        const src = 'export function f(a) { const x = a ? true : false; return x; }';
        const dce = await build(src, 'dce');
        const full = await build(src, true);
        // full: ternary → `!!a`, `const` → `let`. dce leaves both alone.
        expect(full).toMatch(/!\s*!/); // `!!a` (readable mode spaces the nested unaries)
        expect(full).not.toContain('const ');
        expect(dce).toContain('const ');
        expect(dce).toContain('? true : false');
        // ...but they still compute the same thing.
        const fd = (await run(dce)).f as (a: unknown) => boolean;
        const ff = (await run(full)).f as (a: unknown) => boolean;
        for (const v of [0, 1, '', 'x', null, undefined]) expect(fd(v)).toBe(ff(v));
    });

    it("keeps `debugger` in 'dce' and drops it in 'full'", async () => {
        const src = 'export function f() { debugger; return 1; }\nexport const out = f();';
        expect(await build(src, 'dce')).toContain('debugger');
        expect(await build(src, true)).not.toContain('debugger');
    });

    it('compress: false runs nothing', async () => {
        const src = ['const DEBUG = false;', 'export const out = DEBUG ? 1 : 2;'].join('\n');
        expect(await build(src, false)).toContain('DEBUG');
    });
});
