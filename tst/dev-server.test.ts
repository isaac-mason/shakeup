import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs, type Fs } from '../src/bundler/fs.ts';
import type { Plugin } from '../src/bundler/plugin.ts';
import { createDevServer, type DevServerOptions, watch } from '../src/bundler/runtime/dev-server.ts';
import { createModuleRunner } from '../src/bundler/runtime/module-runner.ts';

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

    it('stats() counts fetches/transforms and cache hits across the graph', async () => {
        // preTransform off so counts reflect only the explicit fetches (prefetch would warm the dep).
        const { server } = setup(
            {
                '/entry.ts': `import { v } from './dep';\nexport const result = v * 2;`,
                '/dep.ts': `export const v = 21;`,
            },
            { preTransform: false },
        );
        await server.fetchModule('/entry.ts');
        await server.fetchModule('/dep.ts');
        let s = server.stats();
        expect(s.fetches).toBe(2);
        expect(s.transforms).toBe(2); // both cold
        expect(s.cacheHits).toBe(0);

        // a re-fetch of unchanged source hits the content-hash cache (no re-transform).
        await server.fetchModule('/entry.ts');
        s = server.stats();
        expect(s.fetches).toBe(3);
        expect(s.transforms).toBe(2);
        expect(s.cacheHits).toBe(1);
        expect(s.devTransformMs).toBeGreaterThanOrEqual(0); // timers populated, non-negative
    });

    it("preTransform eagerly warms a module's static-import closure in the background", async () => {
        const { server } = setup({
            '/entry.ts': `import { v } from './dep';\nexport const result = v;`,
            '/dep.ts': `export const v = 7;`,
        });
        // Fetch ONLY the entry; its static dep should get transformed in the background.
        await server.fetchModule('/entry.ts');
        await new Promise((r) => setTimeout(r, 20)); // let the fire-and-forget prefetch settle
        const dep = server.node('/dep.ts');
        expect(dep?.hash).not.toBe(0); // transformed (not just a dep stub)
        expect(dep?.code).toContain('__shakeup'); // runner-rewritten
        expect(server.stats().transforms).toBe(2); // entry + prefetched dep, without an explicit fetch
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
                        resolveId: (spec) => (spec === 'virtual:config' ? spec : null),
                        load: (id) => (id === 'virtual:config' ? `export const v = 'from-plugin';` : null),
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
                plugins: [{ name: 'define', transform: (code) => code.replace('__TAG__', `'patched'`) }],
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
                        resolveId: async (spec) => (spec === 'async:mod' ? spec : null),
                        load: async (id) => (id === 'async:mod' ? `export const v = 7;` : null),
                        transform: async (code) => code,
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
                        moduleParsed: (info) => {
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
            resolveId: (spec) => (spec === 'virtual:d' ? { id: '\0d', external: false } : null),
            // SourceDescription with an accepted-but-ignored side-effect flag (dev doesn't shake).
            load: (id) => (id === '\0d' ? { code: 'export const d = 41;', moduleSideEffects: false } : null),
        };
        const { runner } = setup(files, { plugins: [desc] });
        expect((await runner.import('/entry.ts')).v).toBe(42);
    });

    it('resolveId { external: true } routes to a native import (external)', async () => {
        const externalize: Plugin = {
            name: 'ext',
            resolveId: (spec) => (spec === 'lib-esque' ? { id: 'lib-esque', external: true } : null),
        };
        const { server } = setup({ '/a.ts': '' }, { plugins: [externalize] });
        expect(await server.resolveId('lib-esque', '/a.ts')).toEqual({ external: 'lib-esque' });
    });

    it('externalises to the plugin RESOLVED id — a rewritten URL the runner native-imports', async () => {
        // A plugin can externalise a bare dep to a served URL (no import map needed).
        const toUrl: Plugin = {
            name: 'ext-url',
            resolveId: (spec) =>
                spec === 'gpucat' ? { id: 'https://app.test/@project/node_modules/gpucat/dist/index.js', external: true } : null,
        };
        const { server } = setup({ '/a.ts': '' }, { plugins: [toUrl] });
        expect(await server.resolveId('gpucat', '/a.ts')).toEqual({
            external: 'https://app.test/@project/node_modules/gpucat/dist/index.js',
        });
    });
});

describe('bundle mode — async plugins', () => {
    it('SUPPORTS async plugin hooks (first-class async Fs made the whole graph build async)', async () => {
        const asyncResolve: Plugin = {
            name: 'async-resolve',
            resolveId: async (spec) => (spec === 'virtual:x' ? '\0x' : null),
        };
        const asyncLoad: Plugin = {
            name: 'async-load',
            load: async (id) => (id === '\0x' ? 'export const vx = 1;' : null),
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
        // A namespace with an unhandled member (`export {}` re-export) is left un-lowered → error surfaces.
        const { server } = setup({ '/bad.ts': `namespace N { const y = 1; export { y }; }` });
        const r = await server.fetchModule('/bad.ts');
        expect(r.errors.length).toBeGreaterThan(0);
        expect(r.errors.join('\n')).toMatch(/value namespaces/);
    });
});

describe('dev server — watch (change source)', () => {
    it('batches + de-dups changed paths and drives handleChange', async () => {
        const { createDevServer } = await import('../src/bundler/runtime/dev-server.ts');
        const { watch } = await import('../src/bundler/runtime/dev-server.ts');
        const { createEnvironment } = await import('../src/bundler/runtime/environment.ts');
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

// A rejecting fetch must reject ONCE, for the caller. The in-flight cleanup used to be
// `void p.finally(…)`, and `finally` returns a NEW promise that adopts p's rejection — discarded
// unhandled, so every throwing plugin hook raised a second, unownable rejection alongside the
// error the caller was already handling.
describe('dev server — a rejecting fetch does not orphan a rejection', () => {
    it('reports the failure to the caller and nowhere else', async () => {
        const boom: Plugin = {
            name: 'boom',
            load: () => {
                throw new Error('load exploded');
            },
        };
        const { server } = setup({ '/a.ts': 'export const a = 1;' }, { plugins: [boom] });

        const orphaned: unknown[] = [];
        const onUnhandled = (reason: unknown) => orphaned.push(reason);
        process.on('unhandledRejection', onUnhandled);
        try {
            await expect(server.fetchModule('/a.ts')).rejects.toThrow('load exploded');
            // a rejection is only reported as unhandled after a turn with no handler attached.
            await new Promise((r) => setTimeout(r, 10));
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
        expect(orphaned).toEqual([]);
    });
});

// ── sourcemap policy ────────────────────────────────────────────────────────────────────────
//
// The dev server defaults to the node_modules rule the OUTPUT side already defaults to
// (`sourcemapIgnoreList`, output-options.ts). A built dependency's map points at the built file —
// there is no original source in reach — and it is not free: a full SMv3 map per module, base64'd
// into a `sourceMappingURL` appended to every module body, re-paid on every boot in every
// environment. On a seeded engine graph that is more map than code.
describe('dev server — sourcemap policy', () => {
    const FILES = {
        '/src/app.ts': `import { v } from '/node_modules/dep/index.js';\nexport const app = v;`,
        '/node_modules/dep/index.js': `export const v = 1;`,
    };

    it('maps project modules but not node_modules, by default', async () => {
        const { server } = setup(FILES);
        expect((await server.fetchModule('/src/app.ts')).map?.sources).toEqual(['/src/app.ts']);
        expect((await server.fetchModule('/node_modules/dep/index.js')).map).toBeUndefined();
    });

    it('sourcemap:false emits none, sourcemap:true emits for node_modules too', async () => {
        const off = setup(FILES, { sourcemap: false }).server;
        expect((await off.fetchModule('/src/app.ts')).map).toBeUndefined();
        expect((await off.fetchModule('/node_modules/dep/index.js')).map).toBeUndefined();

        const on = setup(FILES, { sourcemap: true }).server;
        expect((await on.fetchModule('/src/app.ts')).map).toBeDefined();
        expect((await on.fetchModule('/node_modules/dep/index.js')).map).toBeDefined();
    });

    it('honours a predicate', async () => {
        const { server } = setup(FILES, { sourcemap: (id) => id.endsWith('/index.js') });
        expect((await server.fetchModule('/src/app.ts')).map).toBeUndefined();
        expect((await server.fetchModule('/node_modules/dep/index.js')).map).toBeDefined();
    });

    // Same contract `sourcemapIgnoreList` enforces: a predicate that doesn't answer is a
    // misconfiguration that would otherwise look like it worked.
    it('rejects a predicate that does not return a boolean', async () => {
        const { server } = setup(FILES, { sourcemap: (() => undefined) as unknown as (id: string) => boolean });
        await expect(server.fetchModule('/src/app.ts')).rejects.toThrow('sourcemap function must return a boolean.');
    });

    // The map is cached on the ModuleNode, so a policy applied only on the transform path would
    // be invisible from the second fetch onward. This is the test that catches that.
    it('serves the same verdict from the graph cache', async () => {
        const { server } = setup(FILES);
        expect((await server.fetchModule('/node_modules/dep/index.js')).map).toBeUndefined();
        expect((await server.fetchModule('/node_modules/dep/index.js')).map).toBeUndefined();
        expect((await server.fetchModule('/src/app.ts')).map).toBeDefined();
        expect((await server.fetchModule('/src/app.ts')).map).toBeDefined();
    });
});

// `watch()` is a public export with no tests: it batches + de-dups a host watcher's paths and drives
// `handleChange` for each. Only a fake server is needed — `watch` uses nothing but `handleChange`.
// Two of these were measured failing before the fix (llm/repro/_watchsurf.mts).
describe('watch — batching a host change source', () => {
    type Server = { handleChange: (id: string) => Promise<{ env: string; update: never }[]> };
    /** hand back the `emit` the source is given, so a test drives the watcher directly. */
    const wire = (server: Server, opts: { debounceMs?: number; onError?: (e: unknown) => void } = {}) => {
        let emit!: (paths: string[]) => Promise<void>;
        const w = watch(server as never, (e) => void (emit = e), opts);
        return { emit, close: w.close };
    };

    it('settles the batch it abandons when closed mid-debounce', async () => {
        // `emit` resolves "once that batch is handled". `close()` cleared the debounce timer and
        // nothing ever called the batch's resolve, so a host that awaited it before shutting down
        // waited forever. The paths are dropped — the server is closing — but the promise is not.
        const { emit, close } = wire({ handleChange: async () => [] }, { debounceMs: 50 });
        const pending = emit(['/a.js']);
        close();
        const raced = await Promise.race([pending.then(() => 'settled'), new Promise((r) => setTimeout(() => r('hung'), 250))]);
        expect(raced).toBe('settled');
    });

    it('applies batches ONE AT A TIME, never overlapping', async () => {
        // `handleChange` invalidates the shared transform cache and then fans HMR updates out to
        // every environment. A batch whose debounce elapsed mid-apply used to start on top of the
        // one still running — transcript `start a | start b | end a | end b` — so an environment
        // could receive an update computed either side of another batch's invalidation.
        const log: string[] = [];
        const { emit, close } = wire(
            {
                handleChange: async (id) => {
                    log.push(`start ${id}`);
                    await new Promise((r) => setTimeout(r, 30));
                    log.push(`end ${id}`);
                    return [];
                },
            },
            { debounceMs: 0 },
        );
        const first = emit(['/a.js']);
        await new Promise((r) => setTimeout(r, 10)); // the first batch is mid-flight
        const second = emit(['/b.js']);
        await Promise.all([first, second]);
        close();
        expect(log).toEqual(['start /a.js', 'end /a.js', 'start /b.js', 'end /b.js']);
    });

    it('de-dups a path repeated across one batch, and keeps first-seen order', async () => {
        const log: string[] = [];
        const { emit, close } = wire({ handleChange: async (id) => (log.push(id), []) }, { debounceMs: 5 });
        const done = emit(['/a.js', '/b.js']);
        void emit(['/a.js', '/c.js']); // same debounce window
        await done;
        close();
        expect(log).toEqual(['/a.js', '/b.js', '/c.js']);
    });

    it('reports a failing handleChange and still applies the rest of the batch', async () => {
        const log: string[] = [];
        const errors: string[] = [];
        const { emit, close } = wire(
            {
                handleChange: async (id) => {
                    if (id === '/b.js') throw new Error('boom');
                    log.push(id);
                    return [];
                },
            },
            { debounceMs: 0, onError: (e) => errors.push((e as Error).message) },
        );
        await emit(['/a.js', '/b.js', '/c.js']);
        close();
        expect(log, 'the batch continues past the failure').toEqual(['/a.js', '/c.js']);
        expect(errors, 'and the failure is reported, not swallowed').toEqual(['boom']);
    });

    it('a batch already applying when close() lands still finishes', async () => {
        // The falsification arm for the close fix: settling the ABANDONED batch must not settle,
        // or abandon, one that is already running.
        const log: string[] = [];
        const { emit, close } = wire(
            {
                handleChange: async (id) => {
                    await new Promise((r) => setTimeout(r, 20));
                    log.push(id);
                    return [];
                },
            },
            { debounceMs: 0 },
        );
        const inFlight = emit(['/a.js']);
        await new Promise((r) => setTimeout(r, 5)); // handleChange has started
        close();
        await inFlight;
        expect(log).toEqual(['/a.js']);
    });
});

// `this.addWatchFile` on the DEV side. A declaration that only reported a name would be inert here:
// a dev server's whole job is to invalidate on change, so a change to a declared file has to
// invalidate the module that declared it.
describe('dev server — a plugin-declared watch file', () => {
    const files = () => ({
        '/main.js': "import './dep.js';\nexport const a = 1;\n",
        '/dep.js': 'export const d = 2;\n',
    });

    /** count transform calls per module, and declare `/gen.json` for `/main.js` only. */
    const declaring = (calls: string[]): Plugin =>
        ({
            name: 'gen',
            transform(this: { addWatchFile: (f: string) => void }, _code: string, id: string) {
                calls.push(id);
                if (id === '/main.js') this.addWatchFile('/gen.json');
                return null;
            },
        }) as unknown as Plugin;

    it('a change to the declared file re-transforms the module that declared it', async () => {
        const calls: string[] = [];
        const { server } = setup(files(), { plugins: [declaring(calls)] });
        await server.fetchModule('/main.js');
        await server.fetchModule('/main.js');
        expect(calls.filter((c) => c === '/main.js'), 'cached on the second fetch').toHaveLength(1);

        await server.handleChange('/gen.json');
        await server.fetchModule('/main.js');
        expect(calls.filter((c) => c === '/main.js'), 're-transformed after its watch file changed').toHaveLength(2);
    });

    it('a change to an UNDECLARED file leaves it alone', async () => {
        // The falsification arm: invalidating everything on every change would pass the test above.
        const calls: string[] = [];
        const { server } = setup(files(), { plugins: [declaring(calls)] });
        await server.fetchModule('/main.js');
        await server.handleChange('/somethingelse.json');
        await server.fetchModule('/main.js');
        expect(calls.filter((c) => c === '/main.js')).toHaveLength(1);
    });

    it('only the DECLARING module is invalidated, not every module', async () => {
        const calls: string[] = [];
        const { server } = setup(files(), { plugins: [declaring(calls)] });
        await server.fetchModule('/main.js');
        await server.fetchModule('/dep.js');
        await server.handleChange('/gen.json');
        await server.fetchModule('/main.js');
        await server.fetchModule('/dep.js');
        expect(calls.filter((c) => c === '/main.js')).toHaveLength(2);
        expect(calls.filter((c) => c === '/dep.js'), '/dep.js declared nothing').toHaveLength(1);
    });
});
