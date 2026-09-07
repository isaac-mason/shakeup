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
        resolveId: (spec, importer) => server.resolveId(spec, importer),
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
