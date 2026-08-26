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
        const r = await build({ '/e.js': 'globalThis.__q = 1;', '/d.cjs': "module.exports = require('./e.js');", '/main.js': "import d from './d.cjs';\nexport const x = d;" });
        expect(r.graph!.modules.find((m) => m.id === '/e.js')!.exportsKind).toBe('commonjs');
    });
});

describe('fourth sweep — configurations verified correct', () => {
    it('mode-2 alongside an external star source', async () => {
        const r = await build(
            { '/d.cjs': 'module.exports = { a: 1 };', '/b.js': "export * from './d.cjs';\nexport * from 'ext';", '/main.js': "import { a } from './b.js';\nexport const x = a;" },
            { external: ['ext'] },
        );
        expect(r.code).toBeTruthy();
    });

    it('a `.cjs` that is both an entry AND a dependency of another entry', async () => {
        const r = await bundle({
            input: ['/d.cjs', '/main.js'],
            external: [],
            fs: createMemoryFs({ '/d.cjs': 'module.exports = { k: 7 };', '/main.js': "import d from './d.cjs';\nexport const x = d.k;" }),
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
        const r = await build({ '/d.cjs': 'module.exports = 7;', '/main.js': "import d from './d.cjs';\nexport const x = d;" }, {
            output: { sourcemap: true, banner: '//# sourceMappingURL=fake.map' },
        });
        // Ours is emitted LAST, which is the one a consumer honours.
        expect(r.code.trimEnd().endsWith('//# sourceMappingURL=main.js.map')).toBe(true);
    });
});
