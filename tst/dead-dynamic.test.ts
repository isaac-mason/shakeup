import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import { buildGraph, linkGraph, resolveJSXOptions } from '../src/module-graph.ts';
import type { Plugin } from '../src/plugin.ts';
import { treeshake } from '../src/treeshake.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (files: Record<string, string>, plugins: Plugin[] = []) => {
    const result = await bundle({ entry: '/main.ts', fs: createMemoryFs(files), external: [], plugins });
    expect(result.errors).toEqual([]);
    return result;
};

/** Mark a resolved module id side-effect-free (the package.json `sideEffects: false` equivalent). */
const markPure = (specifier: string, id: string): Plugin => ({
    name: 'mark-pure',
    resolveId: (_ctx, spec, importer) => (spec === specifier && importer !== null ? { id, moduleSideEffects: false } : null),
});

describe('dead pure dynamic-import elimination', () => {
    it('computeDeadDynamic flags a discarded, side-effect-free import() target (unit seam)', async () => {
        const files = {
            '/main.ts': 'export const f = () => { import("./lazy.ts"); };\nexport const out = 1;',
            '/lazy.ts': 'export const marker = "LAZY";',
        };
        const graph = await buildGraph({ entry: '/main.ts', fs: createMemoryFs(files), external: [] });
        expect(graph.errors).toEqual([]);
        const lazy = graph.modules[graph.byId.get('/lazy.ts')!];
        lazy.sideEffects = false;
        const linked = linkGraph(graph);
        const shaken = treeshake(graph, linked, resolveJSXOptions(undefined).pure);
        expect(shaken.deadDynamic.has(lazy.idx)).toBe(true);
    });

    it('drops a dead pure dynamic import and rewrites the site to Promise.resolve({})', async () => {
        const files = {
            '/main.ts': 'export const f = () => { import("./lazy"); };\nexport const out = 1;',
            '/lazy.ts': 'export const marker = "LAZY_MARKER";',
        };
        const { code, chunks } = await build(files, [markPure('./lazy', '/lazy.ts')]);
        expect(code).not.toContain('LAZY_MARKER');
        expect(code).toContain('Promise.resolve({})');
        expect(chunks).toHaveLength(1); // no separate lazy chunk
        const mod = await run(code);
        expect(mod.out).toBe(1);
    });

    it('keeps a side-effectful target even when the result is discarded', async () => {
        const files = {
            '/main.ts': 'export const f = () => { import("./lazy"); };\nexport const out = 1;',
            '/lazy.ts': 'globalThis.__LAZY_FX__ = 1;\nexport const marker = "LAZY_MARKER";',
        };
        const { code, chunks } = await build(files); // no plugin → default (has side effects)
        expect(chunks).toHaveLength(2); // lazy still its own chunk
        expect(code).not.toContain('Promise.resolve({})');
    });

    it('keeps the target when its result is actually used', async () => {
        const files = {
            '/main.ts': 'export const f = async () => (await import("./lazy")).marker;\nexport const out = 1;',
            '/lazy.ts': 'export const marker = "LAZY_MARKER";',
        };
        const { chunks } = await build(files, [markPure('./lazy', '/lazy.ts')]);
        expect(chunks).toHaveLength(2); // used → kept as a dynamic chunk
    });

    it('keeps the target when it is also statically imported', async () => {
        const files = {
            '/main.ts': [
                'import { marker } from "./lazy";',
                'export const f = () => { import("./lazy"); };',
                'export const out = marker;',
            ].join('\n'),
            '/lazy.ts': 'export const marker = "LAZY_MARKER";',
        };
        const { code } = await build(files, [markPure('./lazy', '/lazy.ts')]);
        expect(code).toContain('LAZY_MARKER'); // static edge keeps it in the sync graph
    });
});
