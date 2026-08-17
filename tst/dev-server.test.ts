import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createDevServer, type DevServerOptions } from '../src/dev-server.ts';
import { createMemoryFs, type Fs } from '../src/fs.ts';
import type { Plugin } from '../src/plugin.ts';
import { createModuleRunner } from '../src/module-runner.ts';

function setup(files: Record<string, string>, opts: Omit<DevServerOptions, 'fs'> = {}) {
    const fs: Fs = { read: (id) => files[id] ?? null, exists: (id) => id in files };
    const server = createDevServer({ fs, ...opts });
    const runner = createModuleRunner({
        resolveId: (spec, importer) => server.resolveId(spec, importer),
        fetchModule: async (id) => {
            const r = await server.fetchModule(id);
            if (r.errors.length) throw new Error(r.errors.join('\n'));
            return r.code;
        },
        createImportMeta: (id) => ({ url: `sk://${id}` }),
    });
    return { server, runner, files };
}

describe('dev server — resolution + serving', () => {
    it('resolves relative specifiers with extension probing', async () => {
        const { server } = setup({ '/a.ts': '', '/dir/b.ts': '' });
        expect(await server.resolveId('./dir/b', '/a.ts')).toBe('/dir/b.ts');
        expect(await server.resolveId('../a', '/dir/b.ts')).toBe('/a.ts');
    });

    it('treats bare specifiers as external', async () => {
        const { server } = setup({ '/a.ts': '' });
        expect(await server.resolveId('react', '/a.ts')).toEqual({ external: 'react' });
    });

    it('serves a transformed module graph to the runner', async () => {
        const { runner } = setup({
            '/entry.ts': `import { v } from './dep';\nexport const result: number = v * 2;`,
            '/dep.ts': `export const v = 21;`,
        });
        expect((await runner.import('/entry.ts')).result).toBe(42);
    });
});

describe('dev server — resolve config (shared with bundle)', () => {
    it('honours resolve.alias', async () => {
        const { server } = setup({ '/src/util.ts': '' }, { resolve: { alias: { '@': '/src' } } });
        expect(await server.resolveId('@/util', '/entry.ts')).toBe('/src/util.ts');
    });

    it('honours resolve.extensionAlias (import ./x.js → x.ts)', async () => {
        const { server } = setup({ '/x.ts': '' }, { resolve: { extensionAlias: { '.js': ['.ts', '.js'] } } });
        expect(await server.resolveId('./x.js', '/entry.ts')).toBe('/x.ts');
    });

    it('honours the external option for an otherwise-resolvable specifier', async () => {
        const { server } = setup({ '/lib.ts': '' }, { external: ['./lib'] });
        expect(await server.resolveId('./lib', '/entry.ts')).toEqual({ external: './lib' });
    });
});

describe('dev server — plugins are the surface', () => {
    it('a load plugin supplies virtual modules', async () => {
        const { runner } = setup(
            { '/entry.ts': `import { v } from 'virtual:config';\nexport const r = v;` },
            {
                plugins: [
                    {
                        name: 'virtual',
                        resolveId: (_ctx, spec) => (spec === 'virtual:config' ? spec : null),
                        load: (_ctx, id) => (id === 'virtual:config' ? `export const v = 'from-plugin';` : null),
                    },
                ],
            },
        );
        expect((await runner.import('/entry.ts')).r).toBe('from-plugin');
    });

    it('a transform plugin patches source before strip + runner rewrite', async () => {
        const { runner } = setup(
            { '/entry.ts': `export const tag = __TAG__;` },
            {
                plugins: [{ name: 'define', transform: (_ctx, code) => code.replace('__TAG__', `'patched'`) }],
            },
        );
        expect((await runner.import('/entry.ts')).tag).toBe('patched');
    });

    it('supports ASYNC plugin hooks (load/resolveId/transform)', async () => {
        const { runner } = setup(
            { '/entry.ts': `import { v } from 'async:mod';\nexport const r = v;` },
            {
                plugins: [
                    {
                        name: 'async',
                        resolveId: async (_ctx, spec) => (spec === 'async:mod' ? spec : null),
                        load: async (_ctx, id) => (id === 'async:mod' ? `export const v = 7;` : null),
                        transform: async (_ctx, code) => code,
                    },
                ],
            },
        );
        expect((await runner.import('/entry.ts')).r).toBe(7);
    });

    it('runs read-only moduleParsed with the shared AST', async () => {
        const seen: string[] = [];
        const { server } = setup(
            { '/m.ts': `export const a = 1;\nexport function f() {}` },
            {
                plugins: [
                    {
                        name: 'inspect',
                        moduleParsed: (_ctx, info) => {
                            seen.push(`${info.id}:${info.program.data.body.length}`);
                        },
                    },
                ],
            },
        );
        await server.fetchModule('/m.ts');
        expect(seen).toEqual(['/m.ts:2']);
    });
});

describe('dev server — graph tracking', () => {
    it('records importer edges', async () => {
        const { server, runner } = setup({
            '/entry.ts': `import './a';\nimport './b';`,
            '/a.ts': `import './shared';`,
            '/b.ts': `import './shared';`,
            '/shared.ts': `export const s = 1;`,
        });
        await runner.import('/entry.ts');
        expect(server.node('/shared.ts')?.importers).toEqual(new Set(['/a.ts', '/b.ts']));
        expect(server.node('/a.ts')?.deps).toEqual(['/shared.ts']);
    });
});

describe('dev server — object plugin returns (R1)', () => {
    it('resolveId { id, external } and load { code } both work in the async dev path', async () => {
        const files: Record<string, string> = { '/entry.ts': "import { d } from 'virtual:d';\nexport const v = d + 1;" };
        const desc: Plugin = {
            name: 'desc',
            resolveId: (_ctx, spec) => (spec === 'virtual:d' ? { id: '\0d', external: false } : null),
            // SourceDescription with an accepted-but-ignored side-effect flag (dev doesn't shake).
            load: (_ctx, id) => (id === '\0d' ? { code: 'export const d = 41;', moduleSideEffects: false } : null),
        };
        const { runner } = setup(files, { plugins: [desc] });
        expect((await runner.import('/entry.ts')).v).toBe(42);
    });

    it('resolveId { external: true } routes to a native import (external)', async () => {
        const externalize: Plugin = {
            name: 'ext',
            resolveId: (_ctx, spec) => (spec === 'lib-esque' ? { id: 'lib-esque', external: true } : null),
        };
        const { server } = setup({ '/a.ts': '' }, { plugins: [externalize] });
        expect(await server.resolveId('lib-esque', '/a.ts')).toEqual({ external: 'lib-esque' });
    });
});

describe('bundle mode — async plugins', () => {
    it('SUPPORTS async plugin hooks (first-class async Fs made the whole graph build async)', async () => {
        const asyncResolve: Plugin = {
            name: 'async-resolve',
            resolveId: async (_ctx, spec) => (spec === 'virtual:x' ? '\0x' : null),
        };
        const asyncLoad: Plugin = {
            name: 'async-load',
            load: async (_ctx, id) => (id === '\0x' ? 'export const vx = 1;' : null),
        };
        // Once Fs became first-class async, bundle() became async too — so async resolveId/load
        // hooks now resolve+load a virtual module in the bundle path (no more assertSync guard).
        const r = await bundle({
            entry: '/main.ts',
            fs: createMemoryFs({ '/main.ts': "import 'virtual:x';\nexport const y = 1;" }),
            external: [],
            plugins: [asyncResolve, asyncLoad],
        });
        expect(r.errors).toEqual([]);
    });
});

describe('dev server — cache + invalidation', () => {
    it('caches by content hash and re-transforms after an edit', async () => {
        const { server, files } = setup({ '/m.ts': `export const v = 1;` });
        const first = await server.fetchModule('/m.ts');
        const second = await server.fetchModule('/m.ts');
        expect(second.code).toBe(first.code);

        files['/m.ts'] = `export const v = 2;`;
        server.invalidate('/m.ts');
        const third = await server.fetchModule('/m.ts');
        expect(third.code).not.toBe(first.code);
        expect(third.code).toContain('const v = 2');
    });

    it('a re-import after invalidate reflects the edit (full-reload path)', async () => {
        const { server, runner, files } = setup({
            '/entry.ts': `import { v } from './dep';\nexport const result = v;`,
            '/dep.ts': `export const v = 'old';`,
        });
        expect((await runner.import('/entry.ts')).result).toBe('old');

        files['/dep.ts'] = `export const v = 'new';`;
        server.invalidate('/dep.ts');
        runner.invalidate('/dep.ts');
        runner.invalidate('/entry.ts');
        expect((await runner.import('/entry.ts')).result).toBe('new');
    });

    it('surfaces transform errors through fetchModule', async () => {
        const { server } = setup({ '/bad.ts': `namespace N { export const y = 1; }` });
        const r = await server.fetchModule('/bad.ts');
        expect(r.errors.length).toBeGreaterThan(0);
        expect(r.errors.join('\n')).toMatch(/value namespaces/);
    });
});

describe('dev server — watch (change source)', () => {
    it('batches + de-dups changed paths and drives handleChange', async () => {
        const { createDevServer } = await import('../src/dev-server.ts');
        const { watch } = await import('../src/dev-server.ts');
        const { createEnvironment } = await import('../src/environment.ts');
        const files: Record<string, string> = {
            '/m.ts': `globalThis.__seen ??= [];\nexport let v = 1;\nimport.meta.hot.accept((nm) => { globalThis.__seen.push(nm.v); });`,
        };
        const server = createDevServer({ fs: { read: (id) => files[id] ?? null, exists: (id) => id in files } });
        const e = createEnvironment({
            name: 'e',
            fetchModule: server.fetchModule,
            resolveId: server.resolveId,
            createImportMeta: (id) => ({ url: id }),
        });
        server.register(e);
        await e.import('/m.ts');

        let emit!: (paths: string[]) => Promise<void>;
        watch(server, (fn) => {
            emit = fn;
        });

        files['/m.ts'] = files['/m.ts'].replace('v = 1', 'v = 2');
        // duplicate path in one batch → handled once.
        await emit(['/m.ts', '/m.ts']);
        expect((globalThis as { __seen?: number[] }).__seen).toEqual([2]);
        (globalThis as { __seen?: number[] }).__seen = undefined;
    });
});
