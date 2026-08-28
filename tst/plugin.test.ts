import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import type { Plugin } from '../src/plugin.ts';
import { json } from '../src/plugins/json.ts';

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
        const { code } = await build({ '/main.ts': "import { version } from 'virtual:config';\nexport const v = version;" }, [
            virtual,
        ]);
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
        const { code } = await build({ '/main.ts': 'export const build = __BUILD__;\nexport const mark = "MARK";' }, [
            replacer,
            patcher,
        ]);
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
        const { code } = await build(
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
        const { code } = await build(
            { '/main.ts': "import { chunk } from 'lodash-esque';\nexport const c = () => chunk([1], 1);" },
            [externalize],
        );
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
        const { code } = await build({ '/main.ts': 'export const x = 1;' }, [banner]);
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
