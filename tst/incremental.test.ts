import { describe, expect, it } from 'vitest';
import { bundle, createBuildContext } from '../src/bundle.ts';
import type { Fs } from '../src/fs.ts';

function mutableFs(files: Record<string, string>): Fs {
    return { read: (id) => files[id] ?? null, exists: (id) => id in files };
}

describe('incremental: createBuildContext', () => {
    it('reuses unchanged modules and rebuilds byte-identically', async () => {
        const files: Record<string, string> = {
            '/entry.ts': "import { v } from './dep';\nexport const r = v * 2;",
            '/dep.ts': 'export const v = 21;',
        };
        const ctx = createBuildContext({ entry: '/entry.ts', fs: mutableFs(files) });

        const first = await ctx.rebuild();
        expect(first.errors).toEqual([]);
        expect(first.parseStats).toEqual({ parsed: 2, reused: 0 });

        // No change → every module reused, output byte-identical.
        const second = await ctx.rebuild();
        expect(second.parseStats).toEqual({ parsed: 0, reused: 2 });
        expect(second.chunks[0].code).toBe(first.chunks[0].code);

        // Change one module → only it re-parses; output matches a fresh build of the new state.
        files['/dep.ts'] = 'export const v = 50;';
        const third = await ctx.rebuild();
        expect(third.parseStats).toEqual({ parsed: 1, reused: 1 });
        const fresh = await bundle({ entry: '/entry.ts', fs: mutableFs(files) });
        expect(third.chunks[0].code).toBe(fresh.chunks[0].code);
        expect(third.chunks[0].code).toContain('50');
    });

    it('an export-surface change re-links importers correctly', async () => {
        const files: Record<string, string> = {
            '/entry.ts': "export { a, b } from './dep';",
            '/dep.ts': 'export const a = 1;\nexport const b = 2;',
        };
        const ctx = createBuildContext({ entry: '/entry.ts', fs: mutableFs(files) });
        await ctx.rebuild();
        files['/dep.ts'] = 'export const a = 1;\nexport const b = 99;';
        const r = await ctx.rebuild();
        expect(r.parseStats).toEqual({ parsed: 1, reused: 1 });
        expect(r.chunks[0].code).toBe((await bundle({ entry: '/entry.ts', fs: mutableFs(files) })).chunks[0].code);
    });

    it('affected-set: an export-surface change marks importers; a body-only change does not', async () => {
        const files: Record<string, string> = {
            '/entry.ts': "import { v } from './dep';\nexport const r = v;",
            '/dep.ts': 'export const v = 1;\nconst hidden = 2;\nexport function use() { return hidden; }',
        };
        const ctx = createBuildContext({ entry: '/entry.ts', fs: mutableFs(files) });
        await ctx.rebuild();

        // Body-only change (hidden's value) — export surface {v, use} unchanged → no importer affected.
        files['/dep.ts'] = 'export const v = 1;\nconst hidden = 99;\nexport function use() { return hidden; }';
        const bodyOnly = await ctx.rebuild();
        expect(bodyOnly.graph!.affected.has('/entry.ts')).toBe(false);

        // Export-surface change (add an export) — importer is now stale.
        files['/dep.ts'] = 'export const v = 1;\nexport const w = 3;';
        const surface = await ctx.rebuild();
        expect(surface.graph!.affected.has('/dep.ts')).toBe(true);
        expect(surface.graph!.affected.has('/entry.ts')).toBe(true);
    });

    it('affected-set: an export * re-export propagates transitively', async () => {
        const files: Record<string, string> = {
            '/entry.ts': "import { v } from './mid';\nexport const r = v;",
            '/mid.ts': "export * from './leaf';",
            '/leaf.ts': 'export const v = 1;',
        };
        const ctx = createBuildContext({ entry: '/entry.ts', fs: mutableFs(files) });
        await ctx.rebuild();
        // leaf's export surface changes → mid (export *) is transitively export-changed → entry affected.
        files['/leaf.ts'] = 'export const v = 1;\nexport const v2 = 2;';
        const r = await ctx.rebuild();
        expect(r.graph!.affected.has('/leaf.ts')).toBe(true);
        expect(r.graph!.affected.has('/mid.ts')).toBe(true);
        expect(r.graph!.affected.has('/entry.ts')).toBe(true);
    });

    it('render cache: a body change re-renders only its chunk; others reuse (byte-identical)', async () => {
        const files: Record<string, string> = {
            '/a.ts': "import { s } from './shared';\nexport const av = s + 1;",
            '/b.ts': "import { s } from './shared';\nexport const bv = s + 2;",
            '/shared.ts': 'export const s = 40;',
        };
        const opts = () => ({ input: { a: '/a.ts', b: '/b.ts' }, fs: mutableFs(files), external: [] as string[] });
        const ctx = createBuildContext(opts());
        const first = await ctx.rebuild();
        expect(first.renderStats).toEqual({ rendered: 3, reused: 0, moduleRendered: 3, moduleReused: 0 });

        // Change a's body only (export name av unchanged) — only a's chunk is dirty.
        files['/a.ts'] = "import { s } from './shared';\nexport const av = s + 100;";
        const r = await ctx.rebuild();
        expect(r.renderStats).toEqual({ rendered: 1, reused: 2, moduleRendered: 1, moduleReused: 0 }); // shared + b reused

        // Reused chunks (incl. b's cross-chunk import to the hashed shared chunk) are byte-identical.
        const fresh = await bundle(opts());
        for (const c of r.chunks) expect(c.code).toBe(fresh.chunks.find((x) => x.name === c.name)!.code);
    });

    it('module render cache: a body change in a single chunk re-renders only that module (byte-identical)', async () => {
        // One entry pulling four modules → a single chunk. A body-only edit to one module must
        // re-render just that module; the other three reuse their cached text.
        const files: Record<string, string> = {
            '/entry.ts': "import { a } from './a';\nimport { b } from './b';\nimport { c } from './c';\nexport const t = a + b + c;",
            '/a.ts': 'export const a = 1;',
            '/b.ts': 'export const b = 2;',
            '/c.ts': 'export const c = 3;',
        };
        const ctx = createBuildContext({ entry: '/entry.ts', fs: mutableFs(files), external: [] as string[] });
        const first = await ctx.rebuild();
        expect(first.chunks.length).toBe(1);
        expect(first.renderStats).toEqual({ rendered: 1, reused: 0, moduleRendered: 4, moduleReused: 0 });

        // Edit b's body only. The chunk is dirty (a member changed), so it re-renders — but only
        // module b re-renders; entry, a, c reuse their cached module text.
        files['/b.ts'] = 'export const b = 20;';
        const r = await ctx.rebuild();
        expect(r.renderStats).toEqual({ rendered: 1, reused: 0, moduleRendered: 1, moduleReused: 3 });

        // Byte-identical to a cold build.
        const fresh = await bundle({ entry: '/entry.ts', fs: mutableFs(files), external: [] as string[] });
        expect(r.chunks[0].code).toBe(fresh.chunks[0].code);
    });

    it('module render cache: a rename that shifts deconflict names falls back safely (byte-identical)', async () => {
        // b and c both declare a top-level `x`; deconfliction renames the later one. Editing b to
        // ADD a colliding top-level `x` shifts names, so the global names signature changes and
        // per-module reuse is (correctly) disabled — output must still be byte-identical.
        const files: Record<string, string> = {
            '/entry.ts': "export { x as bx } from './b';\nexport { x as cx } from './c';",
            '/b.ts': 'export const x = 1;',
            '/c.ts': 'export const x = 2;',
        };
        const ctx = createBuildContext({ entry: '/entry.ts', fs: mutableFs(files), external: [] as string[] });
        await ctx.rebuild();
        // b gains a top-level binding that collides with c's `x` at bundle scope, shifting names.
        files['/b.ts'] = 'const x = 9;\nexport const x2 = x + 1;';
        const r = await ctx.rebuild();
        const fresh = await bundle({ entry: '/entry.ts', fs: mutableFs(files), external: [] as string[] });
        expect(r.chunks[0].code).toBe(fresh.chunks[0].code);
    });

    it('invalidate() forces a re-parse', async () => {
        const files: Record<string, string> = { '/a.ts': 'export const a = 1;' };
        const ctx = createBuildContext({ entry: '/a.ts', fs: mutableFs(files) });
        await ctx.rebuild();
        expect((await ctx.rebuild()).parseStats).toEqual({ parsed: 0, reused: 1 });
        ctx.invalidate('/a.ts');
        expect((await ctx.rebuild()).parseStats).toEqual({ parsed: 1, reused: 0 });
    });
});

describe('signal-mode rebuild (Watcher fast path)', () => {
    it('an update signal re-parses ONLY the changed module, byte-identical to a cold build', async () => {
        const files: Record<string, string> = {
            '/entry.ts': "import { a } from './a';\nexport const e = a + 1;",
            '/a.ts': "import { b } from './b';\nexport const a = b + 1;",
            '/b.ts': 'export const b = 2;',
        };
        const opts = () => ({ entry: '/entry.ts', fs: mutableFs(files), external: [] as string[] });
        const ctx = createBuildContext(opts());
        await ctx.rebuild(); // cold build populates the cache

        files['/b.ts'] = 'export const b = 200;';
        const r = await ctx.rebuild([{ kind: 'update', id: '/b.ts' }]);
        // Only /b.ts is re-loaded/parsed; /a.ts + /entry.ts reconstruct straight from cache.
        expect(r.parseStats).toEqual({ parsed: 1, reused: 2 });
        expect(r.errors).toEqual([]);
        expect(r.chunks[0].code).toBe((await bundle(opts())).chunks[0].code);
    });

    it('a create signal (new module + importer edit) is byte-identical to cold', async () => {
        const files: Record<string, string> = {
            '/entry.ts': "import { a } from './a';\nexport const e = a;",
            '/a.ts': 'export const a = 1;',
        };
        const opts = () => ({ entry: '/entry.ts', fs: mutableFs(files), external: [] as string[] });
        const ctx = createBuildContext(opts());
        await ctx.rebuild();

        files['/c.ts'] = 'export const c = 9;';
        files['/a.ts'] = "import { c } from './c';\nexport const a = c;";
        const r = await ctx.rebuild([
            { kind: 'update', id: '/a.ts' },
            { kind: 'create', id: '/c.ts' },
        ]);
        expect(r.errors).toEqual([]);
        expect(r.chunks[0].code).toBe((await bundle(opts())).chunks[0].code);
    });

    it('a delete signal (module removed + importer edit) is byte-identical to cold', async () => {
        const files: Record<string, string> = {
            '/entry.ts': "import { a } from './a';\nexport const e = a;",
            '/a.ts': "import { b } from './b';\nexport const a = b;",
            '/b.ts': 'export const b = 5;',
        };
        const opts = () => ({ entry: '/entry.ts', fs: mutableFs(files), external: [] as string[] });
        const ctx = createBuildContext(opts());
        await ctx.rebuild();

        files['/a.ts'] = 'export const a = 42;';
        delete files['/b.ts'];
        const r = await ctx.rebuild([
            { kind: 'update', id: '/a.ts' },
            { kind: 'delete', id: '/b.ts' },
        ]);
        expect(r.errors).toEqual([]);
        expect(r.chunks[0].code).toBe((await bundle(opts())).chunks[0].code);
    });
});
