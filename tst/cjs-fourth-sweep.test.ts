import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import { runChunks } from './exec-helpers.ts';

const build = async (files: Record<string, string>, opts: Record<string, unknown> = {}) => {
    const r = await bundle({ entry: '/main.js', external: [], fs: createMemoryFs(files), ...opts });
    expect(r.errors).toEqual([]);
    return r;
};

const kindOf = async (esrc: string) => {
    const r = await build({
        '/s.js': 'globalThis.__s = 1;',
        '/e.js': esrc,
        '/d.cjs': "try { require('./e.js') } catch (err) {}\nmodule.exports = 1;",
        '/main.js': "import d from './d.cjs';\nexport const x = d;",
    });
    return {
        kind: r.graph!.modules.find((m) => m.id === '/e.js')!.exportsKind,
        wrapped: [...r.linked!.cjsWrap.keys()].some((i) => r.graph!.modules[i].id === '/e.js'),
    };
};

// A module's FORMAT is a property of its source, not of what survives lowering. Classification read
// the post-lowering AST, and an `export` after an unconditional top-level `throw` is unreachable and
// gets eliminated — so `hasExport` came back false, the module fell through to `ExportsKind::None`,
// the link-stage require-promotion made it `commonjs`, and a genuine ES module was handed a
// `__commonJS` wrapper. Every importer then read the wrong shape, with no error and no warning.
//
// rolldown classifies in `ast_scanner` at parse time, which is where the two flags now come from.
describe('exports kind comes from the source, not the surviving AST', () => {
    it('an export after an unconditional throw still makes the module ESM', async () => {
        expect(await kindOf("throw new Error('b');\nexport const a = 1;")).toEqual({ kind: 'esm', wrapped: false });
    });

    it('the same module with the export first is unchanged', async () => {
        expect(await kindOf("export const a = 1;\nthrow new Error('b');")).toEqual({ kind: 'esm', wrapped: false });
    });

    it('`import` plus `module.exports` is still CommonJS', async () => {
        // The flags are SEPARATE for this reason: an export decides ESM outright (tier 1), while an
        // import only breaks the final tie. Folding them into one flag would have promoted this file
        // to ESM and diverged from rolldown's tiers.
        expect(await kindOf("import './s.js';\nmodule.exports = 1;")).toEqual({ kind: 'commonjs', wrapped: true });
    });

    it('`import` with no export and no CommonJS globals is ESM', async () => {
        expect(await kindOf("import './s.js';\nglobalThis.__q = 1;")).toEqual({ kind: 'esm', wrapped: false });
    });

    it('a module with neither is still `none`, then promoted by how it is imported', async () => {
        // D3's link-stage promotion must keep working — it is what the tier-4 `none` verdict feeds.
        const r = await build({
            '/e.js': 'globalThis.__q = 1;',
            '/d.cjs': "module.exports = require('./e.js');",
            '/main.js': "import d from './d.cjs';\nexport const x = d;",
        });
        expect(r.graph!.modules.find((m) => m.id === '/e.js')!.exportsKind).toBe('commonjs');
    });
});

describe('the __esm error cache', () => {
    it('an evaluation failure is STICKY — the module runs once and rethrows', async () => {
        // Why `__esm` was transcribed from rolldown (`runtime-base.js:17-23`) rather than written:
        // the obvious one-liner `(fn && (res = fn((fn = 0))), res)` drops the `err` cache, so a
        // second `require()` of a module whose body threw RE-EVALUATES it. The ESM spec requires the
        // same error every time. Asserted by the counter in the message: two `boom1`, not `boom1`
        // then `boom2`, and not a single entry.
        const r = await build({
            '/e.js':
                "globalThis.__stickyN = (globalThis.__stickyN ?? 0) + 1;\nthrow new Error('boom' + globalThis.__stickyN);\nexport const a = 1;",
            '/d.cjs':
                "const out = [];\nfor (let i = 0; i < 2; i++) { try { require('./e.js') } catch (e) { out.push(e.message) } }\nmodule.exports = out;",
            '/main.js': "import d from './d.cjs';\nexport const x = d;",
        });
        expect(r.code).toMatch(/__esm\(/);
        expect((await import(`data:text/javascript,${encodeURIComponent(r.code)}`)).x).toEqual(['boom1', 'boom1']);
    });
});

describe('fourth sweep — configurations verified correct', () => {
    it('a plugin with an explicitly-null hook is tolerated', async () => {
        // `{ transform: cond ? fn : null }` is a common shape and rollup treats null as absent. It
        // used to take the object branch of the hook normalizer and crash the entire build.
        const r = await bundle({
            entry: '/main.js',
            external: [],
            fs: createMemoryFs({ '/main.js': 'export const x = 1;' }),
            plugins: [{ name: 'p', transform: null, resolveId: null, renderChunk: null } as never],
        });
        expect(r.errors).toEqual([]);
        expect(r.code).toContain('const x = 1;');
    });

    it('mode-2 alongside an external star source', async () => {
        const r = await build(
            {
                '/d.cjs': 'module.exports = { a: 1 };',
                '/b.js': "export * from './d.cjs';\nexport * from 'ext';",
                '/main.js': "import { a } from './b.js';\nexport const x = a;",
            },
            { external: ['ext'] },
        );
        expect(r.code).toBeTruthy();
    });

    it('a `.cjs` that is both an entry AND a dependency of another entry', async () => {
        const r = await bundle({
            input: ['/d.cjs', '/main.js'],
            external: [],
            fs: createMemoryFs({
                '/d.cjs': 'module.exports = { k: 7 };',
                '/main.js': "import d from './d.cjs';\nexport const x = d.k;",
            }),
        });
        expect(r.errors).toEqual([]);
        const entryNames = r.chunks.filter((c) => c.isEntry).map((c) => c.fileName);
        expect(entryNames).toHaveLength(2);
        const { ns, dispose } = await runChunks(r.chunks, 'main.js');
        try {
            expect(ns.x).toBe(7);
        } finally {
            dispose();
        }
    });

    it('a banner carrying its own sourceMappingURL does not suppress ours', async () => {
        const r = await build(
            { '/d.cjs': 'module.exports = 7;', '/main.js': "import d from './d.cjs';\nexport const x = d;" },
            {
                output: { sourcemap: true, banner: '//# sourceMappingURL=fake.map' },
            },
        );
        // Ours is emitted LAST, which is the one a consumer honours.
        expect(r.code.trimEnd().endsWith('//# sourceMappingURL=main.js.map')).toBe(true);
    });
});

// Fifth sweep. The first group generalizes the classification bug: the fix must hold for ANY reason
// an export disappears during lowering, not just an unconditional `throw`.
describe('fifth sweep', () => {
    const run = async (files: Record<string, string>, opts: Record<string, unknown> = {}) => {
        const r = await build(files, opts);
        const { ns, dispose } = await runChunks(r.chunks, r.chunks.find((c) => c.isEntry)!.fileName);
        try {
            return { value: await (ns.x as unknown), chunks: r.chunks };
        } finally {
            dispose();
        }
    };

    it.each([
        ['a dead `if (false)` block before the export', 'if (false) { globalThis.q = 1 }\nexport const a = 1;'],
        ['an unknown call before the export', 'globalThis.__x();\nexport const a = 1;'],
        ['the export first, dead code after', 'export const a = 1;\nif (false) { globalThis.q = 1 }'],
    ])('stays ESM with %s', async (_label, src) => {
        expect((await kindOf(src)).kind).toBe('esm');
    });

    it('require of a module a plugin marked side-effect-free', async () => {
        const plugin = {
            name: 'se',
            resolveId: (spec: string) => (spec === './o.cjs' ? { id: '/o.cjs', moduleSideEffects: false } : null),
        };
        expect(
            (
                await run(
                    {
                        '/o.cjs': 'module.exports = 3;',
                        '/d.cjs': "module.exports = require('./o.cjs') * 2;",
                        '/main.js': "import d from './d.cjs';\nexport const x = d;",
                    },
                    { plugins: [plugin] },
                )
            ).value,
        ).toBe(6);
    });

    it('mode-2 × preserveModules × minify together', async () => {
        const { value, chunks } = await run(
            {
                '/d.cjs': 'module.exports = { a: 1, b: 2 };',
                '/b.js': "export * from './d.cjs';\nexport const own = 9;",
                '/main.js': "import * as ns from './b.js';\nexport const x = [ns.a, ns.b, ns.own];",
            },
            { output: { preserveModules: true, minify: true } },
        );
        expect(chunks.length).toBeGreaterThan(1);
        expect(value).toEqual([1, 2, 9]);
    });

    it('import() of a mode-2 module with codeSplitting off', async () => {
        expect(
            (
                await run(
                    {
                        '/d.cjs': 'module.exports = { a: 1 };',
                        '/b.js': "export * from './d.cjs';",
                        '/main.js': "export const x = import('./b.js').then((m) => m.a);",
                    },
                    { output: { codeSplitting: false } },
                )
            ).value,
        ).toBe(1);
    });

    it('one CommonJS file reached through two spellings of its path is one instance', async () => {
        // `'./d.cjs'` and `'././d.cjs'` must resolve to a single module — otherwise the body runs
        // twice and the two importers see different objects.
        expect(
            (
                await run({
                    '/d.cjs': 'globalThis.__dupN = (globalThis.__dupN ?? 0) + 1;\nmodule.exports = { n: globalThis.__dupN };',
                    '/a.js': "import d from './d.cjs';\nexport const a = d;",
                    '/b.js': "import d from '././d.cjs';\nexport const b = d;",
                    '/main.js': "import { a } from './a.js';\nimport { b } from './b.js';\nexport const x = [a.n, b.n, a === b];",
                })
            ).value,
        ).toEqual([1, 1, true]);
    });
});
