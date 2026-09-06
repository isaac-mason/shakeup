import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';
import { linkGraph } from '../src/bundler/link.ts';
import type { Plugin } from '../src/bundler/plugin.ts';
import { buildGraph } from '../src/bundler/scan.ts';
import { treeshake } from '../src/bundler/treeshake.ts';

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
    resolveId: (spec, importer) => (spec === specifier && importer !== null ? { id, moduleSideEffects: false } : null),
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
        const shaken = treeshake(graph, linked);
        expect(shaken.deadDynamic.has(lazy.idx)).toBe(true);
    });

    it('drops a dead pure dynamic import and rewrites the site to Promise.resolve({})', async () => {
        const files = {
            '/main.ts': 'export const f = () => { import("./lazy"); };\nexport const out = 1;',
            '/lazy.ts': 'export const marker = "LAZY_MARKER";',
        };
        const {
            chunks: [{ code }],
            chunks,
        } = await build(files, [markPure('./lazy', '/lazy.ts')]);
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
        const {
            chunks: [{ code }],
            chunks,
        } = await build(files); // no plugin → default (has side effects)
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
        const {
            chunks: [{ code }],
        } = await build(files, [markPure('./lazy', '/lazy.ts')]);
        expect(code).toContain('LAZY_MARKER'); // static edge keeps it in the sync graph
    });
});

describe('a dynamically imported chunk is never dropped for being empty', () => {
    it('emits the chunk and resolves its filename, rather than dangling the import()', async () => {
        // `import('./dep.ts')` whose result is DISCARDED, and whose target is not marked pure — so
        // `computeDeadDynamic` correctly declines to eliminate it, a chunk is made for it, and then
        // tree-shaking empties that chunk because nothing reads `value`.
        //
        // Dropping the empty chunk left `main` importing a file that was never written: the hash
        // PLACEHOLDER was never substituted either, so the specifier shipped as literal
        // `./dep-!~{001}~.js` and the program died with ERR_MODULE_NOT_FOUND — from a build
        // reporting no errors. Rollup's `dynamic-import-mutate-then-return` is this exact shape.
        //
        // Nothing can statically import an empty chunk (it has no exports), so a dynamic entry is
        // the only way a dropped chunk leaves a live reference behind.
        const result = await build({
            '/dep.ts': 'export const value = 42;\n',
            '/main.ts': "export const test = import('./dep.ts').then(() => 'done');\n",
        });
        const entry = result.chunks.find((c) => c.fileName.startsWith('main'));
        expect(entry, 'the entry chunk exists').toBeDefined();
        expect(entry?.code, 'no unsubstituted hash placeholder').not.toContain('!~{');
        // The specifier names a chunk that was actually emitted.
        const spec = /import\('\.\/([^']+)'\)/.exec(entry?.code ?? '')?.[1];
        expect(spec, 'the import() names a chunk').toBeDefined();
        expect(result.chunks.map((c) => c.fileName)).toContain(spec);
    });
});
