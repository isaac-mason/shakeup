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

    it("emitFile({ type: 'chunk' }) adds an entry, named through getFileName once it exists", async () => {
        // A plugin-created ENTRY. `id` goes through the build hooks like any entry, and the reference
        // id only resolves once chunking and naming have run — which is why `emitFile` answers an id
        // rather than a name (see the test below).
        let ref = '';
        let tooEarly: unknown;
        let named = '';
        const p: Plugin = {
            name: 'emitter',
            buildStart: function () {
                ref = this.emitFile({ type: 'chunk', id: './extra.ts', importer: '/main.ts' });
                try {
                    this.getFileName(ref);
                } catch (e) {
                    tooEarly = (e as Error).message;
                }
            },
            generateBundle: function () {
                named = this.getFileName(ref);
            },
        };
        const { chunks } = await build({ '/main.ts': 'export const x = 1;', '/extra.ts': "export const y = 'FROM_EXTRA';" }, [p]);
        // Asking during the build is a sequencing mistake with its own message, not "unknown id".
        expect(tooEarly).toMatch(/before it is generated/);
        expect(chunks).toHaveLength(2);
        const extra = chunks.find((c) => c.code.includes('FROM_EXTRA'));
        expect(extra, 'the emitted chunk was bundled').toBeDefined();
        expect(extra?.isEntry, 'and it is an ENTRY, not a dynamic chunk').toBe(true);
        expect(named).toBe(extra?.fileName);
    });

    it('resolves an emitted chunk with no importer against the cwd', async () => {
        // `EmittedChunk.importer` exists only so a RELATIVE id resolves against the right file; with
        // none, "paths will be resolved relative to the current working directory" (rolldown's own
        // wording). A bare `extra.ts` is a PATH here, not a package name.
        const p: Plugin = {
            name: 'emitter',
            buildStart: function () {
                this.emitFile({ type: 'chunk', id: 'extra.ts' });
            },
        };
        // `resolve.cwd` explicitly: the memory fs is rooted at `/`, while the option defaults to the
        // real process cwd — which is the point of the test, so it has to be stated rather than
        // inherited.
        const r = await bundle({
            entry: '/main.ts',
            fs: createMemoryFs({ '/main.ts': 'export const x = 1;', '/extra.ts': "export const y = 'FROM_EXTRA';" }),
            external: [],
            plugins: [p],
            resolve: { cwd: '/' },
        });
        expect(r.errors).toEqual([]);
        expect(r.chunks.some((c) => c.code.includes('FROM_EXTRA'))).toBe(true);
    });

    it('this.resolve defaults isEntry to whether there is an importer', async () => {
        // Rollup's documented rule, verbatim: the value passed "will be passed along to the
        // `resolveId` hooks handling this call, otherwise FALSE will be passed if there is an
        // importer and TRUE if there is not". shakeup passed a flat `false`.
        //
        // The importer itself must be `undefined` and not `null` — Rollup's fixtures assert
        // `strictEqual(importer, undefined)`, and a plugin branching on `importer === undefined`
        // took the wrong path.
        const seen: string[] = [];
        const p: Plugin = {
            name: 'probe',
            buildStart: async function () {
                await this.resolve('./a.ts');
                await this.resolve('./a.ts', '/main.ts');
                await this.resolve('./a.ts', undefined, { isEntry: false });
            },
            resolveId: (spec, importer, extra) => {
                if (spec === './a.ts') seen.push(`${importer === undefined ? 'noImporter' : 'importer'}:${extra.isEntry}`);
                return null;
            },
        };
        await build({ '/main.ts': 'export const x = 1;' }, [p]);
        expect(seen).toEqual(['noImporter:true', 'importer:false', 'noImporter:false']);
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

    it('moduleIds lists the INCLUDED modules, matching OutputChunk.modules', async () => {
        // A pure re-exporter renders no code. Both oracles omit it from `moduleIds` AND from
        // `modules` — measured: Rollup and rolldown both answer `["lib.js","main.js"]` for this
        // three-module chain. shakeup listed all three in `moduleIds` while §2z57 had already fixed
        // `modules`, so its own two reports of the same fact disagreed.
        const { chunks } = await build({
            '/lib.ts': 'export const foo = 42;',
            '/reexporter.ts': "export { foo } from './lib';",
            '/main.ts': "export { foo } from './reexporter';",
        });
        expect(chunks[0].moduleIds).toEqual(['/lib.ts', '/main.ts']);
        // The two reports must AGREE — that is the invariant, not just the value.
        expect(chunks[0].moduleIds).toEqual(Object.keys(chunks[0].modules));
    });

    it('but a filename function still sees the same list', async () => {
        // `moduleIds` reaches `chunkFileNames`/`entryFileNames` through `PreRenderedChunk`, and that
        // pass runs BEFORE anything is rendered — which is why inclusion is decided from LIVENESS
        // rather than from rendered text. If the two passes disagreed, a name computed from
        // `moduleIds` would shift between them.
        let seen: string[] = [];
        const r = await bundle({
            entry: '/main.ts',
            fs: createMemoryFs({
                '/lib.ts': 'export const foo = 42;',
                '/reexporter.ts': "export { foo } from './lib';",
                '/main.ts': "export { foo } from './reexporter';",
            }),
            external: [],
            output: {
                entryFileNames: (chunk) => {
                    seen = chunk.moduleIds;
                    return '[name].js';
                },
            },
        });
        expect(r.errors).toEqual([]);
        expect(seen).toEqual(['/lib.ts', '/main.ts']);
    });

    it('renderStart fires before rendering, and output.plugins contribute only generate hooks', async () => {
        // `renderStart(outputOptions, inputOptions)` is the first generate-phase hook, once the output
        // options are settled. It takes the INPUT options too, which is the point rolldown's docs
        // make: "plugins that can be used as output plugins ... can get access to them" — an output
        // plugin has never seen them otherwise.
        //
        // `output.plugins` contributes ONLY generate-phase hooks. A build hook on one does not run,
        // and is not an error, which is Rollup's documented behaviour and the assertion below that
        // would be easy to omit.
        const order: string[] = [];
        let outputOptions: Record<string, unknown> = {};
        let inputOptions: Record<string, unknown> = {};
        const r = await bundle({
            entry: '/main.ts',
            fs: createMemoryFs({ '/main.ts': 'export const x = 1;' }),
            external: [],
            output: {
                entryFileNames: '[name].js',
                plugins: [
                    {
                        name: 'out',
                        renderStart: (o, i) => {
                            order.push('out:renderStart');
                            outputOptions = o;
                            inputOptions = i;
                        },
                        renderChunk: (c) => {
                            order.push('out:renderChunk');
                            return c;
                        },
                        generateBundle: () => void order.push('out:generateBundle'),
                        transform: (c) => {
                            order.push('out:transform');
                            return c;
                        },
                        buildStart: () => void order.push('out:buildStart'),
                    },
                ],
            },
            plugins: [
                {
                    name: 'in',
                    buildStart: () => void order.push('in:buildStart'),
                    renderStart: () => void order.push('in:renderStart'),
                },
            ],
        });
        expect(r.errors).toEqual([]);
        // Input plugin's hooks first, then the output plugin's, and NOTHING from its build hooks.
        expect(order).toEqual(['in:buildStart', 'in:renderStart', 'out:renderStart', 'out:renderChunk', 'out:generateBundle']);
        // Settled OUTPUT options, not the raw object: `entryFileNames` is present because it was
        // given, and the rest of the normalized naming surface is there too.
        expect(outputOptions.entryFileNames).toBe('[name].js');
        expect(Object.keys(outputOptions)).toContain('chunkFileNames');
        // And the INPUT options, which is the whole reason the hook takes two arguments.
        expect(inputOptions.entry).toBe('/main.ts');
    });

    it('an output asset carries the full rollup/rolldown shape', async () => {
        // Every expectation here was read off a real rolldown build of the same four emits before it
        // was written — including the two that are easy to get backwards: `name` is ABSENT (not
        // `null`) when nothing named the file, while `originalFileName` is `null` (not absent) when
        // there is no source file behind it.
        const p: Plugin = {
            name: 'emit',
            buildStart: function () {
                this.emitFile({ type: 'asset', name: 'named.txt', source: 'NAMED' });
                this.emitFile({ type: 'asset', fileName: 'exact.txt', source: 'EXACT' });
                // SAME BYTES, two names, two source files. rolldown emits ONE file listing both.
                this.emitFile({ type: 'asset', name: 'dup1.txt', originalFileName: '/one.txt', source: 'DUPE' });
                this.emitFile({ type: 'asset', name: 'dup2.txt', originalFileName: '/two.txt', source: 'DUPE' });
            },
        };
        const r = await bundle({
            entry: '/main.ts',
            fs: createMemoryFs({ '/main.ts': 'export const x = 1;' }),
            external: [],
            output: { sourcemap: true },
            plugins: [p],
        });
        expect(r.errors).toEqual([]);
        const by = (m: (a: { fileName: string }) => boolean) => (r.assets ?? []).find(m)!;
        const shape = (a: Record<string, unknown>) => {
            const { source: _s, ...rest } = a;
            return rest;
        };

        // A `.map` sidecar: no name, no source file.
        expect(shape(by((a) => a.fileName === 'main.js.map'))).toEqual({
            type: 'asset',
            fileName: 'main.js.map',
            names: [],
            originalFileName: null,
            originalFileNames: [],
        });
        // An explicit `fileName` keeps the exact path AND gets no name.
        expect(shape(by((a) => a.fileName === 'exact.txt'))).toEqual({
            type: 'asset',
            fileName: 'exact.txt',
            names: [],
            originalFileName: null,
            originalFileNames: [],
        });
        const named = by((a) => a.fileName.startsWith('assets/named-'));
        expect(named.name).toBe('named.txt');
        expect(named.names).toEqual(['named.txt']);
        expect(named.originalFileName).toBeNull();

        // The dedupe: ONE file, named after the FIRST emit, listing both — and the deprecated
        // singulars are the first element of their plural, which is the whole reason plurals exist.
        const dupes = (r.assets ?? []).filter((a) => a.fileName.startsWith('assets/dup'));
        expect(dupes, 'identical bytes are one file, not two').toHaveLength(1);
        expect(dupes[0].fileName).toMatch(/^assets\/dup1-/);
        expect(dupes[0].names).toEqual(['dup1.txt', 'dup2.txt']);
        expect(dupes[0].originalFileNames).toEqual(['/one.txt', '/two.txt']);
        expect(dupes[0].name).toBe('dup1.txt');
        expect(dupes[0].originalFileName).toBe('/one.txt');
        // The chunk carries its discriminant too.
        expect(r.chunks[0].type).toBe('chunk');
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

// A throwing hook used to escape as its bare message — `Error: transform exploded` — out of a build
// running many plugins over many modules, naming neither. rolldown 1.2.4 attributes every one
// (measured, llm/repro/_errsurf.mts): `[plugin <name>]` for resolveId, `[plugin <name>] <id>` for
// load and transform. These assert that format, in both pipelines.
describe('a throwing plugin hook names the plugin, and the module', () => {
    const FILES = { '/main.ts': "import { d } from './dep.ts';\nexport const got = d;\n", '/dep.ts': "export const d = 'D';\n" };
    const boom = (hook: 'resolveId' | 'load' | 'transform'): Plugin =>
        ({
            name: 'boom',
            [hook]: () => {
                throw new Error(`${hook} exploded`);
            },
        }) as Plugin;
    const failing = async (hook: 'resolveId' | 'load' | 'transform') => {
        try {
            await bundle({ entry: '/main.ts', fs: createMemoryFs(FILES), external: [], plugins: [boom(hook)] });
        } catch (e) {
            return e as Error;
        }
        throw new Error(`${hook} did not fail the build`);
    };

    it('names the plugin AND the file for load', async () => {
        const e = await failing('load');
        expect(e.message).toBe('[plugin boom] /main.ts load exploded');
        expect((e as { plugin?: string }).plugin, 'rollup hangs the plugin off the error too').toBe('boom');
    });

    it('names the plugin AND the file for transform', async () => {
        expect((await failing('transform')).message).toBe('[plugin boom] /main.ts transform exploded');
    });

    it('names the plugin only for resolveId — which is what rolldown reports', async () => {
        // The falsification arm for the id: it is attached where the hook HAS a module, and nowhere
        // else. A prefix that always appended something would fail here.
        expect((await failing('resolveId')).message).toBe('[plugin boom] resolveId exploded');
    });

    it('blames the plugin that threw, once, through a nested this.resolve', async () => {
        const thrower: Plugin = {
            name: 'thrower',
            resolveId: (spec) => {
                if (spec === 'nested') throw new Error('nested exploded');
                return null;
            },
        };
        const caller: Plugin = {
            name: 'caller',
            load(this: { resolve: (s: string, i: string) => Promise<unknown> }, id: string) {
                if (id !== '/main.ts') return null;
                return this.resolve('nested', '/main.ts').then(() => null);
            },
        } as unknown as Plugin;
        let message = '';
        try {
            await bundle({ entry: '/main.ts', fs: createMemoryFs(FILES), external: [], plugins: [thrower, caller] });
        } catch (e) {
            message = (e as Error).message;
        }
        // `thrower` threw; `caller` merely propagated. One prefix, and it is the culprit's.
        expect(message).toBe('[plugin thrower] nested exploded');
    });
});

// `this.meta` — the metadata block both oracles put on every plugin context. It was missing
// entirely, so `this.meta.watchMode` threw `Cannot read properties of undefined` (measured against
// rolldown 1.2.4: llm/repro/_ctxsurf.mts).
describe('this.meta', () => {
    const metaFrom = async (opts: Record<string, unknown> = {}) => {
        let seen: Record<string, unknown> | undefined;
        const r = await bundle({
            entry: '/main.ts',
            fs: createMemoryFs({ '/main.ts': 'export const a = 1;\n' }),
            external: [],
            ...opts,
            plugins: [
                {
                    name: 'peek',
                    transform(this: { meta: Record<string, unknown> }) {
                        seen = this.meta;
                        return null;
                    },
                } as unknown as Plugin,
            ],
        });
        expect(r.errors).toEqual([]);
        return seen;
    };

    it('carries the keys rolldown carries', async () => {
        const meta = await metaFrom();
        expect(Object.keys(meta ?? {}).sort()).toEqual(['rollupVersion', 'shakeupVersion', 'watchMode']);
    });

    it('claims a rollup API version, because plugins feature-detect on it', async () => {
        // The same claim rolldown hardcodes. Asserted exactly so that changing it is deliberate:
        // a plugin gating a code path on this string is the reason the field exists.
        expect((await metaFrom())?.rollupVersion).toBe('4.23.0');
    });

    it('the GENERATE-phase context carries the same meta', async () => {
        // There are three contexts — scan-time, post-build and the dev server's — and only the
        // scan-time one is on the transform path. A sabotage that gave the post-build context a
        // different `watchMode` passed every other test in this file, which is how this one exists.
        let fromTransform: unknown;
        let fromRenderChunk: unknown;
        let fromGenerateBundle: unknown;
        const r = await bundle({
            entry: '/main.ts',
            fs: createMemoryFs({ '/main.ts': 'export const a = 1;\n' }),
            external: [],
            plugins: [
                {
                    name: 'peek',
                    transform(this: { meta: unknown }) {
                        fromTransform = this.meta;
                        return null;
                    },
                    renderChunk(this: { meta: unknown }) {
                        fromRenderChunk = this.meta;
                        return null;
                    },
                    generateBundle(this: { meta: unknown }) {
                        fromGenerateBundle = this.meta;
                    },
                } as unknown as Plugin,
            ],
        });
        expect(r.errors).toEqual([]);
        expect(fromRenderChunk).toEqual(fromTransform);
        expect(fromGenerateBundle).toEqual(fromTransform);
    });

    it('watchMode is false by default and true when the host says so', async () => {
        // Both arms: a field that is always false would pass the first assertion alone.
        expect((await metaFrom())?.watchMode).toBe(false);
        expect((await metaFrom({ watchMode: true }))?.watchMode).toBe(true);
    });
});
