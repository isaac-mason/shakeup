import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

// cjs.md D4 / Track 7 — `isNodeMode`, the second argument to `__toESM`.
//
// An importer that is ESM BY FILE FORMAT (`.mjs`/`.mts`/`"type": "module"`) must follow Node, and
// Node IGNORES the `__esModule` marker: `import d from './x.cjs'` hands back the whole
// `module.exports`. An importer whose format is unknown — a bare `.js` with no `package.json#type`,
// which is the ordinary bundler case — keeps the transpiler convention and unwraps `.default`.
//
// rolldown gates this on exactly `def_format.is_esm()`
// (`normal_module.rs:181-183`, `should_consider_node_esm_spec_for_static_import`) and emits
// `__toESM(require_d(), 1)`.
//
// The expected value for the `.mjs` case was not derived from the spec — it was MEASURED by running
// the same two files through Node, which printed
// `[{"__esModule":true,"default":"REAL","named":"N"},"N"]`.
const CJS = ["exports.__esModule = true;", "exports.default = 'REAL';", "exports.named = 'N';"].join('\n');

const run = async (files: Record<string, string>, entry: string) => {
    const r = await bundle({ entry, external: [], fs: createMemoryFs(files) });
    expect(r.errors).toEqual([]);
    const ns = (await import(`data:text/javascript,${encodeURIComponent(r.code)}`)) as { x: unknown };
    return { value: ns.x, code: r.code };
};

describe('isNodeMode is decided per importer', () => {
    it('an .mjs importer gets the whole module.exports as default', async () => {
        const { value, code } = await run({ '/d.cjs': CJS, '/main.mjs': "import d, { named } from './d.cjs';\nexport const x = [d, named];" }, '/main.mjs');
        expect(value).toEqual([{ __esModule: true, default: 'REAL', named: 'N' }, 'N']);
        expect(code).toMatch(/__toESM\(require_d\(\), 1\)/);
    });

    it('a plain .js importer keeps honouring `__esModule`', async () => {
        // Unknown format — the ordinary bundler case, and the transpiler convention applies.
        const { value, code } = await run({ '/d.cjs': CJS, '/main.js': "import d, { named } from './d.cjs';\nexport const x = [d, named];" }, '/main.js');
        expect(value).toEqual(['REAL', 'N']);
        expect(code).toMatch(/__toESM\(require_d\(\)\)/);
    });

    it('a module imported BOTH ways materializes both objects', async () => {
        // The two values genuinely differ, so one shared namespace cannot serve both importers.
        const { value, code } = await run(
            {
                '/d.cjs': CJS,
                '/a.mjs': "import d from './d.cjs';\nexport const a = d;",
                '/b.js': "import d from './d.cjs';\nexport const b = d;",
                '/main.js': "import { a } from './a.mjs';\nimport { b } from './b.js';\nexport const x = [a, b];",
            },
            '/main.js',
        );
        expect(value).toEqual([{ __esModule: true, default: 'REAL', named: 'N' }, 'REAL']);
        expect(code).toMatch(/__toESM\(require_d\(\), 1\)/);
        expect(code).toMatch(/__toESM\(require_d\(\)\);/);
    });

    it('a CommonJS module without `__esModule` is unaffected by the mode', async () => {
        // The marker is the only thing `isNodeMode` short-circuits, so a plain `module.exports`
        // object must read the same from either kind of importer.
        const plain = { '/d.cjs': 'module.exports = { k: 7 };' };
        const esm = await run({ ...plain, '/main.mjs': "import d from './d.cjs';\nexport const x = d.k;" }, '/main.mjs');
        const js = await run({ ...plain, '/main.js': "import d from './d.cjs';\nexport const x = d.k;" }, '/main.js');
        expect(esm.value).toBe(7);
        expect(js.value).toBe(7);
    });
});
