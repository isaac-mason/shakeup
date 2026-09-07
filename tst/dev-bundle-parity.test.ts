import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import type { Fs } from '../src/bundler/fs.ts';
import { createDevServer } from '../src/bundler/runtime/dev-server.ts';
import { createModuleRunner } from '../src/bundler/runtime/module-runner.ts';
import { runChunks } from './exec-helpers.ts';

// shakeup has TWO pipelines that turn the same sources into runnable JS — the bundler and the dev
// server — and until now only the bundler's OUTPUT was gated. `dev-server.test.ts` covers resolution,
// plugins, caching and graph tracking, all by inspecting strings and structure; nothing asserted that
// the two pipelines AGREE on what a program means.
//
// So this runs the same fixture three ways and compares the value: node on the sources, the bundle,
// and the dev server through its module runner. Every case below was checked against node first.
const bothWays = async (files: Record<string, string>, entry = '/main.js'): Promise<[unknown, unknown]> => {
    const fs: Fs = { read: (id) => files[id] ?? null, exists: (id) => id in files };

    const r = await bundle({ entry, fs, external: [], output: {} });
    expect(r.errors, 'bundle').toEqual([]);
    const { ns, dispose } = await runChunks(r.chunks, (r.chunks.find((c) => c.isEntry) ?? r.chunks[0]).fileName);
    const fromBundle = await (ns.got as unknown);
    dispose();

    const server = createDevServer({ fs });
    const runner = createModuleRunner({
        resolveId: (spec, importer, extra) => server.resolveId(spec, importer, extra),
        fetchModule: async (id) => {
            const res = await server.fetchModule(id);
            if (res.errors.length > 0) throw new Error(res.errors.join('\n'));
            return res.code;
        },
        createImportMeta: (id) => ({ url: `sk://${id}` }),
    });
    const fromDev = await ((await runner.import(entry)) as { got: unknown }).got;

    return [fromBundle, fromDev];
};

const parity = async (files: Record<string, string>, want: unknown, entry = '/main.js') => {
    const [b, d] = await bothWays(files, entry);
    expect(b, 'bundle').toEqual(want);
    expect(d, 'dev server').toEqual(want);
};

describe('the dev server and the bundler agree on what a program means', () => {
    it('a live binding mutated through a function', async () => {
        await parity(
            {
                '/dep.js': 'export let n = 1;\nexport const bump = () => { n += 41; };\n',
                '/main.js': "import { n, bump } from './dep.js';\nbump();\nexport const got = n;\n",
            },
            42,
        );
    });

    it('circular ESM imports', async () => {
        await parity(
            {
                '/a.js': "import { tagB } from './b.js';\nexport const tagA = 'ta';\nexport const fromA = () => 'A' + tagB;\n",
                '/b.js': "import { tagA } from './a.js';\nexport const tagB = 'tb';\nexport const fromB = () => 'B' + tagA;\n",
                '/main.js':
                    "import { fromA } from './a.js';\nimport { fromB } from './b.js';\nexport const got = [fromA(), fromB()].join('|');\n",
            },
            'Atb|Bta',
        );
    });

    it('a re-export chain three deep', async () => {
        await parity(
            {
                '/leaf.js': "export const v = 'LEAF';\n",
                '/mid.js': "export { v } from './leaf.js';\n",
                '/top.js': "export { v as w } from './mid.js';\n",
                '/main.js': "import { w } from './top.js';\nexport const got = w;\n",
            },
            'LEAF',
        );
    });

    it('a dynamic import, top-level await, and a class static field', async () => {
        await parity({ '/main.js': "const v = await Promise.resolve('TLA');\nexport const got = v;\n" }, 'TLA');
        await parity(
            {
                '/panel.js': "export const r = () => 'PANEL';\n",
                '/main.js': "export const got = import('./panel.js').then((m) => m.r());\n",
            },
            'PANEL',
        );
        await parity(
            {
                '/dep.js': 'export default class C { static tag = "C"; m() { return C.tag; } }\n',
                '/main.js': "import C from './dep.js';\nexport const got = new C().m();\n",
            },
            'C',
        );
    });

    // TypeScript is where the two pipelines are MOST likely to drift: the bundler runs the full
    // `strip-ts`/`lower-ts` passes and the dev server runs `devTransform`. These are not erasable, so
    // node cannot be the oracle — the two arms are held to each other and to a written-out answer.
    it.each([
        [
            'enum, including the reverse map',
            {
                '/dep.ts': 'export enum E { A = 1, B, C = "c" }\n',
                '/main.ts': "import { E } from './dep.ts';\nexport const got = [E.A, E.B, E.C, E[1]].join('|');\n",
            },
            '1|2|c|A',
        ],
        [
            'const enum',
            {
                '/dep.ts': 'export const enum CE { X = 10, Y = 20 }\n',
                '/main.ts': "import { CE } from './dep.ts';\nexport const got = CE.X + CE.Y;\n",
            },
            30,
        ],
        [
            'nested namespace',
            {
                '/dep.ts': 'export namespace N { export const v = 7; export namespace Inner { export const w = 8; } }\n',
                '/main.ts': "import { N } from './dep.ts';\nexport const got = N.v + N.Inner.w;\n",
            },
            15,
        ],
        [
            'class parameter properties',
            {
                '/dep.ts':
                    'export class P { constructor(public a: number, private b: string) {} get t() { return this.a + this.b; } }\n',
                '/main.ts': "import { P } from './dep.ts';\nexport const got = new P(1, 'x').t;\n",
            },
            '1x',
        ],
    ])('TypeScript: %s', async (_n, files, want) => {
        await parity(files as Record<string, string>, want, '/main.ts');
    });
});

describe('the dev server SAYS SO when it cannot run something', () => {
    // CommonJS is not a dev-server goal — the module runner evaluates ES modules, and shakeup's
    // position (`llm/notes/cjs.md`) is that dependencies are pre-seeded as ESM offline rather than
    // translated on the hot path. That is a decision, not a defect.
    //
    // The DEFECT was the silence. Served verbatim, a `.cjs` file reached the runner and threw
    // `ReferenceError: module is not defined` from inside the evaluated module — a runtime error with
    // no connection to its cause, from a `fetchModule` that reported success. The bundler handles the
    // same file correctly, so the two pipelines disagreed and only one said anything.
    const server = () =>
        createDevServer({ fs: { read: (id: string) => FILES[id] ?? null, exists: (id: string) => id in FILES } });
    const FILES: Record<string, string> = {
        '/dep.cjs': "module.exports = { d: 'D' };\n",
        '/esm.js': "export const d = 'D';\n",
        '/mod.mjs': "export const d = 'D';\n",
    };

    it('reports a clear error for a .cjs module instead of a runtime ReferenceError', async () => {
        const r = await server().fetchModule('/dep.cjs');
        expect(r.errors.join(' ')).toContain('CommonJS is not supported by the dev server');
        expect(r.errors.join(' '), 'and says what to do about it').toContain('Pre-build this dependency to ESM');
        expect(r.code, 'nothing is served').toBe('');
    });

    it('but the BUNDLER still handles the same file', async () => {
        const fs: Fs = {
            read: (id) => ({ ...FILES, '/main.js': "import d from './dep.cjs';\nexport const got = d.d;\n" })[id] ?? null,
            exists: () => true,
        };
        const r = await bundle({ entry: '/main.js', fs, external: [], output: {} });
        expect(r.errors).toEqual([]);
    });

    it('and an ES module is untouched — the check is the EXTENSION, not a guess at the source', async () => {
        // The falsification arm. A detector that sniffed for `module`/`exports`/`require` in the text
        // would flag ordinary ES modules that merely mention those words.
        for (const id of ['/esm.js', '/mod.mjs']) {
            const r = await server().fetchModule(id);
            expect(r.errors, id).toEqual([]);
            expect(r.code.length, id).toBeGreaterThan(0);
        }
    });
});

// The PLUGIN SURFACE, dev vs bundle. The same plugin object goes into both pipelines; a hook that
// runs in one and not the other is a silent behaviour change for anyone who writes plugins. Each
// case below was MEASURED against the bundler first (llm/repro/_resolvesurf.mts) — the assertion on
// the bundler is not scaffolding, it is the reference the dev assertion is judged against.
describe('the dev server and the bundler present the same plugin surface', () => {
    const FILES: Record<string, string> = {
        '/dep.js': "export const d = 'D';\n",
        '/lazy.js': "export const l = 'L';\n",
        '/main.js': "import { d } from './dep.js';\nexport const got = d;\nexport const lazy = () => import('./lazy.js');\n",
    };
    const fs: Fs = { read: (id) => FILES[id] ?? null, exists: (id) => id in FILES };

    /** run `plugin` through the dev pipeline, importing (and awaiting the dynamic import of) main. */
    const throughDev = async (plugin: unknown, entry = '/main.js') => {
        const server = createDevServer({ fs, plugins: [plugin as never] });
        const runner = createModuleRunner({
            resolveId: (spec, importer, extra) => server.resolveId(spec, importer, extra),
            fetchModule: async (id) => {
                const res = await server.fetchModule(id);
                if (res.errors.length > 0) throw new Error(res.errors.join('\n'));
                return res.code;
            },
            createImportMeta: (id) => ({ url: `sk://${id}` }),
        });
        const ns = (await runner.import(entry)) as { lazy?: () => Promise<unknown> };
        await ns.lazy?.();
    };

    const throughBundle = async (plugin: unknown, entry = '/main.js') => {
        const r = await bundle({ entry, fs, external: [], output: {}, plugins: [plugin as never] });
        expect(r.errors, 'bundle').toEqual([]);
    };

    it('fires buildStart — ONCE, however many modules are served', async () => {
        // It never fired at all: a plugin doing setup in `buildStart` silently did nothing in dev.
        let n = 0;
        await throughDev({ name: 'p', buildStart: () => void n++ });
        expect(n).toBe(1);
    });

    it('runs resolveDynamicImport for a dynamic import', async () => {
        // Dev never entered that chain, so the hook was dead code under the dev server.
        const seen: string[] = [];
        const plugin = { name: 'p', resolveDynamicImport: (spec: string) => (seen.push(spec), null) };
        await throughBundle(plugin);
        expect(seen, 'bundle').toContain('./lazy.js');
        seen.length = 0;
        await throughDev(plugin);
        expect(seen, 'dev').toContain('./lazy.js');
    });

    it("gives resolveId the import's KIND, not `import-statement` for everything", async () => {
        const kinds = new Map<string, Set<string>>();
        const plugin = {
            name: 'p',
            resolveId: (spec: string, _i: string | undefined, extra: { kind: string }) => {
                (kinds.get(spec) ?? kinds.set(spec, new Set()).get(spec))?.add(extra.kind);
                return null;
            },
        };
        await throughDev(plugin);
        expect([...(kinds.get('./lazy.js') ?? [])], 'dynamic').toContain('dynamic-import');
        expect([...(kinds.get('./dep.js') ?? [])], 'static').toEqual(['import-statement']);
    });

    it('resolves the ENTRY, with isEntry and kind=entry', async () => {
        // `runner.import` used the caller's specifier as an id verbatim.
        const entries: string[] = [];
        const plugin = {
            name: 'p',
            resolveId: (spec: string, importer: string | undefined, extra: { isEntry: boolean; kind: string }) => {
                if (extra.isEntry) entries.push(`${spec} ${importer === undefined ? 'undefined' : importer} ${extra.kind}`);
                return null;
            },
        };
        await throughBundle(plugin);
        expect(entries, 'bundle').toEqual(['/main.js undefined entry']);
        entries.length = 0;
        await throughDev(plugin);
        expect(entries, 'dev').toEqual(['/main.js undefined entry']);
    });

    it('lets a plugin REWRITE the entry, in both pipelines', async () => {
        // The payoff of resolving the entry: it is a resolution like any other.
        const plugin = { name: 'p', resolveId: (spec: string) => (spec === 'app' ? '/main.js' : null) };
        await throughBundle(plugin, 'app');
        await throughDev(plugin, 'app');
    });

    it('carries `custom` through this.resolve — including a SECOND call with different custom', async () => {
        // `custom` is Rollup's plugin-to-plugin channel; dev dropped it. The second call also had to
        // defeat dev's resolve cache, which keyed on (importer, spec) alone and reused the first
        // answer — so it reached the plugin with the FIRST call's custom, or not at all.
        const got: unknown[] = [];
        const plugin = {
            name: 'p',
            resolveId: (_s: string, _i: string | undefined, extra: { custom?: unknown }) => {
                if (extra.custom !== undefined) got.push(extra.custom);
                return null;
            },
            load(this: { resolve: (s: string, i: string, o: unknown) => Promise<unknown> }, id: string) {
                if (id !== '/main.js') return null;
                return Promise.all([
                    this.resolve('./dep.js', '/main.js', { custom: { tag: 1 } }),
                    this.resolve('./dep.js', '/main.js', { custom: { tag: 2 } }),
                ]).then(() => null);
            },
        };
        await throughDev(plugin);
        expect(got).toEqual([{ tag: 1 }, { tag: 2 }]);
    });
});
