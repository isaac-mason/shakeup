import { describe, expect, it } from 'vitest';
import { bundle, createBuildContext } from '../src/bundle.ts';
import type { Fs } from '../src/fs.ts';

function mutableFs(files: Record<string, string>): Fs {
    return { read: (id) => files[id] ?? null, exists: (id) => id in files };
}

describe('incremental: createBuildContext', () => {
    it('reuses unchanged modules and rebuilds byte-identically', () => {
        const files: Record<string, string> = {
            '/entry.ts': "import { v } from './dep';\nexport const r = v * 2;",
            '/dep.ts': 'export const v = 21;',
        };
        const ctx = createBuildContext({ entry: '/entry.ts', fs: mutableFs(files) });

        const first = ctx.rebuild();
        expect(first.errors).toEqual([]);
        expect(first.parseStats).toEqual({ parsed: 2, reused: 0 });

        // No change → every module reused, output byte-identical.
        const second = ctx.rebuild();
        expect(second.parseStats).toEqual({ parsed: 0, reused: 2 });
        expect(second.chunks[0].code).toBe(first.chunks[0].code);

        // Change one module → only it re-parses; output matches a fresh build of the new state.
        files['/dep.ts'] = 'export const v = 50;';
        const third = ctx.rebuild();
        expect(third.parseStats).toEqual({ parsed: 1, reused: 1 });
        const fresh = bundle({ entry: '/entry.ts', fs: mutableFs(files) });
        expect(third.chunks[0].code).toBe(fresh.chunks[0].code);
        expect(third.chunks[0].code).toContain('50');
    });

    it('an export-surface change re-links importers correctly', () => {
        const files: Record<string, string> = {
            '/entry.ts': "export { a, b } from './dep';",
            '/dep.ts': 'export const a = 1;\nexport const b = 2;',
        };
        const ctx = createBuildContext({ entry: '/entry.ts', fs: mutableFs(files) });
        ctx.rebuild();
        files['/dep.ts'] = 'export const a = 1;\nexport const b = 99;';
        const r = ctx.rebuild();
        expect(r.parseStats).toEqual({ parsed: 1, reused: 1 });
        expect(r.chunks[0].code).toBe(bundle({ entry: '/entry.ts', fs: mutableFs(files) }).chunks[0].code);
    });

    it('affected-set: an export-surface change marks importers; a body-only change does not', () => {
        const files: Record<string, string> = {
            '/entry.ts': "import { v } from './dep';\nexport const r = v;",
            '/dep.ts': 'export const v = 1;\nconst hidden = 2;\nexport function use() { return hidden; }',
        };
        const ctx = createBuildContext({ entry: '/entry.ts', fs: mutableFs(files) });
        ctx.rebuild();

        // Body-only change (hidden's value) — export surface {v, use} unchanged → no importer affected.
        files['/dep.ts'] = 'export const v = 1;\nconst hidden = 99;\nexport function use() { return hidden; }';
        const bodyOnly = ctx.rebuild();
        expect(bodyOnly.graph!.affected.has('/entry.ts')).toBe(false);

        // Export-surface change (add an export) — importer is now stale.
        files['/dep.ts'] = 'export const v = 1;\nexport const w = 3;';
        const surface = ctx.rebuild();
        expect(surface.graph!.affected.has('/dep.ts')).toBe(true);
        expect(surface.graph!.affected.has('/entry.ts')).toBe(true);
    });

    it('affected-set: an export * re-export propagates transitively', () => {
        const files: Record<string, string> = {
            '/entry.ts': "import { v } from './mid';\nexport const r = v;",
            '/mid.ts': "export * from './leaf';",
            '/leaf.ts': 'export const v = 1;',
        };
        const ctx = createBuildContext({ entry: '/entry.ts', fs: mutableFs(files) });
        ctx.rebuild();
        // leaf's export surface changes → mid (export *) is transitively export-changed → entry affected.
        files['/leaf.ts'] = 'export const v = 1;\nexport const v2 = 2;';
        const r = ctx.rebuild();
        expect(r.graph!.affected.has('/leaf.ts')).toBe(true);
        expect(r.graph!.affected.has('/mid.ts')).toBe(true);
        expect(r.graph!.affected.has('/entry.ts')).toBe(true);
    });

    it('invalidate() forces a re-parse', () => {
        const files: Record<string, string> = { '/a.ts': 'export const a = 1;' };
        const ctx = createBuildContext({ entry: '/a.ts', fs: mutableFs(files) });
        ctx.rebuild();
        expect(ctx.rebuild().parseStats).toEqual({ parsed: 0, reused: 1 });
        ctx.invalidate('/a.ts');
        expect(ctx.rebuild().parseStats).toEqual({ parsed: 1, reused: 0 });
    });
});
