import { describe, expect, it } from 'vitest';
import { createBuildContext } from '../src/bundle.ts';
import type { Fs } from '../src/fs.ts';

function mutableFs(files: Record<string, string>): Fs {
    return { read: (id) => files[id] ?? null, exists: (id) => id in files };
}

// A cross-module substitution makes a consumer's artifact depend on a PRODUCER's source, which the
// parse cache (keyed on the consumer's own source) cannot see. `crossDeps` records that edge — the
// same thing a Rollup/Vite plugin declares with `addWatchFile` — and it is checked BEFORE scan, so an
// invalidated consumer is simply parsed fresh and flows through the ordinary changed-module path.
describe('cross-module cache dependencies', () => {
    it('re-inlines when the @inline DONOR changes, though the consumer did not', async () => {
        const files: Record<string, string> = {
            '/lib.js': '/* @inline */ export function k() { return 1; }',
            '/entry.js': 'import { k } from "./lib.js";\nexport const out = k();',
        };
        const ctx = createBuildContext({ entry: '/entry.js', fs: mutableFs(files), external: [] });

        const first = await ctx.rebuild();
        expect(first.errors).toEqual([]);
        expect(first.code).toMatch(/=\s*1/); // donor body inlined

        // Edit ONLY the donor. Without the recorded edge the consumer is reused from cache with the
        // OLD body baked in — the bug this exists to prevent.
        files['/lib.js'] = '/* @inline */ export function k() { return 2; }';
        const second = await ctx.rebuild();
        expect(second.code).toMatch(/=\s*2/);
        expect(second.code).not.toMatch(/=\s*1/);
    });

    it('matches a cold build after a donor edit', async () => {
        const mk = (v: string): Record<string, string> => ({
            '/lib.js': `/* @inline */ export function k() { return ${v}; }`,
            '/entry.js': 'import { k } from "./lib.js";\nexport const out = k();',
        });
        const files = mk('1');
        const ctx = createBuildContext({ entry: '/entry.js', fs: mutableFs(files), external: [] });
        await ctx.rebuild();
        files['/lib.js'] = mk('9')['/lib.js'];
        const warm = await ctx.rebuild();

        const cold = await createBuildContext({ entry: '/entry.js', fs: mutableFs(mk('9')), external: [] }).rebuild();
        expect(warm.code).toBe(cold.code); // byte-identical to building from scratch
    });

    it('does NOT invalidate when the donor is unchanged', async () => {
        const files: Record<string, string> = {
            '/lib.js': '/* @inline */ export function k() { return 7; }',
            '/entry.js': 'import { k } from "./lib.js";\nexport const out = k();',
        };
        const ctx = createBuildContext({ entry: '/entry.js', fs: mutableFs(files), external: [] });
        const a = await ctx.rebuild();
        const b = await ctx.rebuild();
        expect(b.code).toBe(a.code);
        expect(b.parseStats?.parsed ?? 0).toBe(0); // nothing needlessly re-parsed
    });
});
