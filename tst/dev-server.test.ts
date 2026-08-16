import { describe, expect, it } from 'vitest';
import { createDevServer, type DevServerOptions } from '../src/dev-server.ts';
import type { Fs } from '../src/fs.ts';
import { createRunner } from '../src/runner.ts';

/** A dev server + runner over an in-memory, editable file map, plus any plugins. */
function setup(files: Record<string, string>, opts: Omit<DevServerOptions, 'fs'> = {}) {
    const fs: Fs = { read: (id) => files[id] ?? null, exists: (id) => id in files };
    const server = createDevServer({ fs, ...opts });
    const runner = createRunner({
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
