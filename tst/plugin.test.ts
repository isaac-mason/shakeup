import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';
import type { Plugin } from '../src/bundler/plugin.ts';
import { json } from '../src/bundler/plugins/json.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (files: Record<string, string>, plugins: Plugin[] = [], external: string[] = []) => {
    const result = await bundle({ entry: '/main.ts', fs: createMemoryFs(files), external, plugins });
    expect(result.errors).toEqual([]);
    return result;
};

describe('plugin pipeline', () => {
    it('virtual modules via resolveId + load', async () => {
        const virtual: Plugin = {
            name: 'virtual-config',
            resolveId: (spec) => (spec === 'virtual:config' ? '\0virtual:config' : null),
            load: (id) => (id === '\0virtual:config' ? 'export const version = "9.9.9";' : null),
        };
        const {
            chunks: [{ code }],
        } = await build({ '/main.ts': "import { version } from 'virtual:config';\nexport const v = version;" }, [virtual]);
        const mod = await run(code);
        expect(mod.v).toBe('9.9.9');
    });

    it('transform chain: string replacement then Edit[] patches, in order', async () => {
        const replacer: Plugin = {
            name: 'define',
            transform: (code) => code.replace('__BUILD__', '"1.2.3"'),
        };
        const patcher: Plugin = {
            name: 'patcher',
            transform: (code) => {
                const at = code.indexOf('MARK');
                return at < 0 ? null : [{ start: at, end: at + 4, text: 'PATCHED' }];
            },
        };
        const {
            chunks: [{ code }],
        } = await build({ '/main.ts': 'export const build = __BUILD__;\nexport const mark = "MARK";' }, [replacer, patcher]);
        const mod = await run(code);
        expect(mod.build).toBe('1.2.3');
        expect(mod.mark).toBe('PATCHED');
    });

    it('filters run in core: non-matching modules never invoke the handler', async () => {
        let calls = 0;
        const special: Plugin = {
            name: 'special-only',
            transform: {
                filter: { id: /\.special\.ts$/ },
                handler: (code) => {
                    calls++;
                    return code;
                },
            },
        };
        await build(
            {
                '/main.ts': "import { s } from './thing.special.ts';\nexport const out = s;",
                '/thing.special.ts': 'export const s = 1;',
            },
            [special],
        );
        expect(calls).toBe(1);
    });

    it('json plugin: import a .json file, tree-shaking friendly', async () => {
        const {
            chunks: [{ code }],
        } = await build(
            {
                '/main.ts': "import cfg from './config.json';\nexport const name = cfg.name;",
                '/config.json': '{ "name": "puddle", "unused": [1, 2, 3] }',
            },
            [json()],
        );
        const mod = await run(code);
        expect(mod.name).toBe('puddle');
    });

    it('resolveId returning false marks a specifier external', async () => {
        const externalize: Plugin = {
            name: 'externalize-lodash',
            resolveId: (spec) => (spec === 'lodash-esque' ? false : null),
        };
        const {
            chunks: [{ code }],
        } = await build({ '/main.ts': "import { chunk } from 'lodash-esque';\nexport const c = () => chunk([1], 1);" }, [
            externalize,
        ]);
        expect(code).toContain("from 'lodash-esque'");
    });

    it('renderChunk sees the final chunk; buildStart/buildEnd bracket the build', async () => {
        const order: string[] = [];
        const banner: Plugin = {
            name: 'banner',
            buildStart: () => {
                order.push('start');
            },
            renderChunk: (code) => {
                order.push('render');
                return `/* built by shakeup */\n${code}`;
            },
            buildEnd: () => {
                order.push('end');
            },
        };
        const {
            chunks: [{ code }],
        } = await build({ '/main.ts': 'export const x = 1;' }, [banner]);
        expect(code.startsWith('/* built by shakeup */')).toBe(true);
        expect(order).toEqual(['start', 'render', 'end']);
    });

    it('moduleParsed sees every module with its ast + semantic', async () => {
        const seen: string[] = [];
        const spy: Plugin = {
            name: 'spy',
            moduleParsed: (info) => {
                seen.push(info.id);
                expect(info.nodeCount).toBeGreaterThan(1);
                expect(info.semantic.symbols.length).toBeGreaterThan(0);
            },
        };
        await build(
            {
                '/main.ts': "import { a } from './a';\nexport const out = a;",
                '/a.ts': 'export const a = 1;',
            },
            [spy],
        );
        expect(seen.sort()).toEqual(['/a.ts', '/main.ts']);
    });

    it('moduleParsed reports its dependency ids; load and transform report none', async () => {
        // Rollup's contract, which rolldown documents in the same words: the ids "are available when
        // a module has been parsed and its dependencies have been RESOLVED. This is the case in the
        // `moduleParsed` hook", and `this.load` without `resolveDependencies` deliberately sees them
        // empty. Both halves matter — a hook that reported them everywhere would be as wrong as one
        // that reported them nowhere.
        //
        // shakeup used to hand `moduleParsed` an info object with neither field at all
        // (`undefined`), because the hook fired before scan resolved a single record.
        const at: string[] = [];
        const spy: Plugin = {
            name: 'ids',
            load: function (id) {
                const i = this.getModuleInfo(id);
                at.push(`load ${id} ${JSON.stringify(i?.importedIds)} ${JSON.stringify(i?.dynamicallyImportedIds)}`);
                return null;
            },
            transform: function (_code, id) {
                const i = this.getModuleInfo(id);
                at.push(`transform ${id} ${JSON.stringify(i?.importedIds)} ${JSON.stringify(i?.dynamicallyImportedIds)}`);
                return null;
            },
            moduleParsed: (info) => {
                at.push(`parsed ${info.id} ${JSON.stringify(info.importedIds)} ${JSON.stringify(info.dynamicallyImportedIds)}`);
            },
        };
        await build(
            {
                '/main.ts': "import { a } from './a';\nexport const out = [a, import('./d')];",
                '/a.ts': 'export const a = 1;',
                '/d.ts': 'export const d = 2;',
            },
            [spy],
        );
        expect(at.filter((l) => l.startsWith('parsed /main.ts'))).toEqual(['parsed /main.ts ["/a.ts"] ["/d.ts"]']);
        expect(at.filter((l) => l.startsWith('parsed /a.ts'))).toEqual(['parsed /a.ts [] []']);
        // Empty in the earlier hooks — nothing has been resolved when they run.
        expect(at.filter((l) => l.startsWith('load /main.ts'))).toEqual(['load /main.ts [] []']);
        expect(at.filter((l) => l.startsWith('transform /main.ts'))).toEqual(['transform /main.ts [] []']);
    });

    it("OutputChunk.modules reports each module's rendered contribution", async () => {
        // Rollup's and rolldown's `OutputChunk.modules`, which plugins like size visualizers read.
        // Every value below was compared against a real rolldown build of the same input before it
        // was written: `renderedExports` matches name-for-name, and `renderedLength` differs only by
        // the `//#region` banner comments rolldown renders and shakeup does not.
        const seen: Record<string, unknown> = {};
        const spy: Plugin = {
            name: 'mods',
            generateBundle: (_o, b) => {
                for (const [file, entry] of Object.entries(b)) seen[file] = (entry as { modules?: unknown }).modules;
            },
        };
        const { chunks } = await build(
            {
                '/lib.ts': 'export const foo = 42;\nexport const dropped = 1;',
                '/reexporter.ts': "export { foo } from './lib';",
                '/main.ts': "export { foo } from './reexporter';",
            },
            [spy],
        );
        const mods = chunks[0].modules;
        // A pure RE-EXPORTER renders nothing and is absent; the ENTRY renders nothing either but is
        // listed with `code: null`, because it is why the chunk exists. Both oracles agree on exactly
        // this pair of keys, in this order.
        expect(Object.keys(mods)).toEqual(['/lib.ts', '/main.ts']);
        expect(mods['/main.ts']).toEqual({ code: null, renderedLength: 0, renderedExports: ['foo'] });
        expect(mods['/lib.ts'].code).toContain('foo = 42');
        expect(mods['/lib.ts'].renderedLength).toBe(mods['/lib.ts'].code?.length);
        // `dropped` was shaken, so it is not a rendered export — the field's whole point.
        expect(mods['/lib.ts'].renderedExports).toEqual(['foo']);
        // The same object reaches `generateBundle`, which is where the fixtures read it.
        expect(seen['main.js']).toBe(mods);
    });

    it('emitFile answers a REFERENCE ID, resolved by getFileName', async () => {
        // Both oracles pair `emitFile(file): string` with `getFileName(referenceId): string`, and
        // shakeup used to return the fileName straight from `emitFile`. Not a spelling difference:
        // a fileName cannot exist at emit time for everything that can be emitted — a chunk's name is
        // settled only after chunking and naming — which is why the indirection is there at all.
        let refA = '';
        let refB = '';
        let nameA = '';
        let unknown: unknown;
        const p: Plugin = {
            name: 'emitter',
            buildEnd: function () {
                refA = this.emitFile({ type: 'asset', name: 'a.txt', source: 'SAME' });
                refB = this.emitFile({ type: 'asset', name: 'a.txt', source: 'SAME' });
                nameA = this.getFileName(refA);
                try {
                    this.getFileName('not-a-ref');
                } catch (e) {
                    unknown = (e as Error).message;
                }
            },
        };
        const r = await build({ '/main.ts': 'export const x = 1;' }, [p]);
        expect(refA, 'the id is not the name').not.toBe(nameA);
        expect(nameA).toMatch(/^assets\/a-[0-9a-f]+\.txt$/);
        // Same bytes: one file, two distinct ids — Rollup's behaviour, and the reason the ids are
        // per-CALL rather than derived from the content.
        expect(refB).not.toBe(refA);
        expect(r.assets?.filter((a) => a.fileName === nameA)).toHaveLength(1);
        // An unknown id THROWS rather than answering undefined, which would get embedded in code and
        // fail somewhere much later.
        expect(unknown).toMatch(/Unknown file reference id/);
    });

    it('a file emitted from inside generateBundle reaches the output', async () => {
        // It did not. `graph.emitted` was drained once, before the hook ran, so the file vanished
        // with no error at all. rolldown emits it (probed on the same input: `late.txt` is in its
        // output), and so does Rollup.
        const secondSaw: string[] = [];
        const emitter: Plugin = {
            name: 'emitter',
            generateBundle: function () {
                this.emitFile({ type: 'asset', fileName: 'late.txt', source: 'LATE' });
            },
        };
        // A LATER hook must see what an earlier one emitted — Rollup's behaviour, and the reason the
        // drain happens between hooks rather than once at the end.
        const observer: Plugin = { name: 'observer', generateBundle: (_o, b) => void secondSaw.push(...Object.keys(b)) };
        const r = await build({ '/main.ts': 'export const x = 1;' }, [emitter, observer]);
        expect(r.assets?.map((a) => a.fileName)).toContain('late.txt');
        expect(secondSaw).toContain('late.txt');
    });

    it('but a deleted entry stays deleted', async () => {
        // The falsification arm. Re-reading `graph.emitted` after every hook could resurrect an entry
        // a plugin had just removed; seeding the seen-set with what is already in the object is what
        // stops that, and without this test that seeding would look like belt-and-braces.
        const emitter: Plugin = {
            name: 'emitter',
            buildEnd: function () {
                this.emitFile({ type: 'asset', fileName: 'early.txt', source: 'EARLY' });
            },
        };
        const deleter: Plugin = {
            name: 'deleter',
            generateBundle: (_o, b) => {
                delete b['early.txt'];
            },
        };
        const after: Plugin = { name: 'after', generateBundle: () => {} };
        const r = await build({ '/main.ts': 'export const x = 1;' }, [emitter, deleter, after]);
        expect(r.assets?.map((a) => a.fileName)).not.toContain('early.txt');
    });

    it('ctx.warn lands in result warnings', async () => {
        const warner: Plugin = {
            name: 'warner',
            transform: function (code) {
                this.warn('something smells');
                return code;
            },
        };
        const { warnings } = await build({ '/main.ts': 'export const x = 1;' }, [warner]);
        expect(warnings).toContain('something smells');
    });
});

describe('generateBundle', () => {
    // rollup's last hook, and the only one that can MUTATE finished output. 19 of rollup's own
    // function samples use it, and several inject files specifically to test that the bundler
    // rejects names escaping the output directory.
    it('receives the bundle keyed by fileName, tagged chunk/asset', async () => {
        let seen: string[] = [];
        let types: string[] = [];
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({ '/main.js': 'export const a = 1;' }),
            plugins: [
                {
                    name: 'observe',
                    generateBundle(_options, b) {
                        seen = Object.keys(b);
                        types = Object.values(b).map((e) => e.type);
                    },
                },
            ],
        });
        expect(r.errors).toEqual([]);
        expect(seen).toEqual(['main.js']);
        expect(types).toEqual(['chunk']);
    });

    it('a file it injects appears in the output', async () => {
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({ '/main.js': 'export const a = 1;' }),
            plugins: [
                {
                    name: 'inject',
                    generateBundle(_options, b) {
                        b['extra.txt'] = { type: 'asset', fileName: 'extra.txt', source: 'hello' };
                    },
                },
            ],
        });
        expect(r.errors).toEqual([]);
        expect((r.assets ?? []).find((a) => a.fileName === 'extra.txt')?.source).toBe('hello');
    });

    it('rejects an injected file name that escapes the output directory', async () => {
        // rollup's `FILE_NAME_OUTSIDE_OUTPUT_DIRECTORY` (`Bundle.ts:368`). The check runs AFTER
        // generateBundle precisely so a plugin-injected name is covered.
        for (const bad of ['/etc/passwd', '../escaped.js', '..', '.', 'C:\\etc\\passwd', 'a/b/../../../escape.js']) {
            const r = await bundle({
                entry: '/main.js',
                fs: createMemoryFs({ '/main.js': 'export const a = 1;' }),
                plugins: [
                    {
                        name: 'escape',
                        generateBundle(_options, b) {
                            b[bad] = { type: 'asset', fileName: bad, source: 'x' };
                        },
                    },
                ],
            });
            expect(r.errors[0], `expected rejection for ${bad}`).toContain('is not contained in the output directory');
        }
    });

    it('a relative name in a subdirectory is allowed', async () => {
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({ '/main.js': 'export const a = 1;' }),
            plugins: [
                {
                    name: 'nested',
                    generateBundle(_options, b) {
                        b['assets/deep/ok.txt'] = { type: 'asset', fileName: 'assets/deep/ok.txt', source: 'x' };
                    },
                },
            ],
        });
        expect(r.errors).toEqual([]);
        expect((r.assets ?? []).some((a) => a.fileName === 'assets/deep/ok.txt')).toBe(true);
    });
});

describe('this.load', () => {
    // rollup's mechanism for a plugin that needs to INSPECT a module it does not own — reading its
    // exports to decide a rewrite, or forcing a dependency into the graph.
    it('pulls a module into the graph and returns its info', async () => {
        let seen: { id: string; exports: string[]; hasDefaultExport: boolean | null } | null = null;
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({
                '/main.js': 'export const a = 1;',
                '/other.js': 'export const b = 2;\nexport default 3;',
            }),
            plugins: [
                {
                    name: 'loader',
                    async buildStart() {
                        const info = await this.load({ id: '/other.js' });
                        seen =
                            info === null
                                ? null
                                : { id: info.id, exports: info.exports, hasDefaultExport: info.hasDefaultExport };
                    },
                },
            ],
        });
        expect(r.errors).toEqual([]);
        expect(seen).not.toBeNull();
        expect(seen!.id).toBe('/other.js');
        expect(seen!.exports.sort()).toEqual(['b', 'default']);
        expect(seen!.hasDefaultExport).toBe(true);
    });

    it('reports a module that is still loading, with the unparsed fields null', async () => {
        // rollup registers a module BEFORE running its load/transform hooks, so those hooks can ask
        // about it. `has-default-export` asserts exactly this: `hasDefaultExport === null` from
        // inside `load(id)`. Returning null there made fixtures deref null and die.
        const duringLoad: (boolean | null | 'MISSING')[] = [];
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({ '/main.js': "import './dep.js';\nexport const a = 1;", '/dep.js': 'export default 1;' }),
            plugins: [
                {
                    name: 'observe',
                    load(id) {
                        const info = this.getModuleInfo(id);
                        duringLoad.push(info === null ? 'MISSING' : info.hasDefaultExport);
                        return null;
                    },
                },
            ],
        });
        expect(r.errors).toEqual([]);
        expect(duringLoad.length).toBeGreaterThan(0);
        expect(duringLoad).not.toContain('MISSING');
        for (const v of duringLoad) expect(v).toBeNull();
    });

    it('hasDefaultExport is false for a module without one, once parsed', async () => {
        let info: { hasDefaultExport: boolean | null } | null = null;
        await bundle({
            entry: '/main.js',
            fs: createMemoryFs({ '/main.js': 'export const a = 1;' }),
            plugins: [
                {
                    name: 'peek',
                    buildEnd() {
                        const i = this.getModuleInfo('/main.js');
                        info = i === null ? null : { hasDefaultExport: i.hasDefaultExport };
                    },
                },
            ],
        });
        expect(info).not.toBeNull();
        expect(info!.hasDefaultExport).toBe(false);
    });
});

describe('this.load is re-entrancy safe', () => {
    // `preload-loading-module` calls `this.load({ id })` from inside THAT module's own `load` hook.
    // The module is not in the graph yet, so `addModule` began loading it AGAIN, whose load hook
    // called `this.load` again — unbounded recursion. Concurrent requests for one id now share a
    // single in-flight promise.
    it('calling this.load for the module currently being loaded does not recurse', async () => {
        let resolvedId: string | null = null;
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({ '/main.js': "import './dep.js';\nexport const a = 1;", '/dep.js': 'export const d = 1;' }),
            plugins: [
                {
                    name: 'preload',
                    load(id) {
                        if (id === '/dep.js') {
                            // `MaybePromise`, so normalise before chaining — the point is that the
                            // re-entrant call resolves at all rather than recursing.
                            void Promise.resolve(this.load({ id })).then((info) => {
                                resolvedId = info === null ? null : info.id;
                            });
                        }
                        return null;
                    },
                },
            ],
        });
        expect(r.errors).toEqual([]);
        expect(resolvedId).toBe('/dep.js');
    });

    it('concurrent loads of one id share a single module', async () => {
        let count = 0;
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({ '/main.js': 'export const a = 1;', '/dep.js': 'export const d = 1;' }),
            plugins: [
                {
                    name: 'twice',
                    async buildStart() {
                        const [x, y] = await Promise.all([this.load({ id: '/dep.js' }), this.load({ id: '/dep.js' })]);
                        expect(x?.id).toBe(y?.id);
                    },
                    load(id) {
                        if (id === '/dep.js') count++;
                        return null;
                    },
                },
            ],
        });
        expect(r.errors).toEqual([]);
        // Loaded ONCE despite two concurrent requests.
        expect(count).toBe(1);
    });
});
