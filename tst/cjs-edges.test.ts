import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import { runChunks } from './exec-helpers.ts';
import type { Platform } from '../src/resolve.ts';

// cjs.md §"NOT YET PROBED" — the seven configurations three audit passes had never RUN. Five of them
// were broken, and every one failed silently or opaquely: a build that reported no errors produced
// output that threw at load. This file is the sweep, one describe per item.
//
// The pattern is the point: probing a configuration never run found five defects; re-reading the
// code that had already been reviewed found none.
const build = async (files: Record<string, string>, opts: Record<string, unknown> = {}) =>
    bundle({ entry: '/main.js', external: [], fs: createMemoryFs(files), ...opts });

const run = async (files: Record<string, string>, opts: Record<string, unknown> = {}) => {
    const r = await build(files, opts);
    expect(r.errors).toEqual([]);
    const { ns, dispose } = await runChunks(r.chunks, r.chunks.find((c) => c.isEntry)!.fileName);
    try {
        return await (ns.x as unknown);
    } finally {
        dispose();
    }
};

describe('§7.6 — require() of an external', () => {
    it('routes through the shim, which is a real require on node', async () => {
        // Was emitted verbatim and threw `require is not defined in ES module scope`. Both oracles
        // route an unbundlable require through the shim: esbuild wraps the call with
        // `valueToSubstituteForRequire` (`js_parser.go:15788-15791`), and rolldown's shim error
        // points at "bundling-cjs#require-external-modules".
        const value = await run(
            { '/d.cjs': "const p = require('node:path');\nmodule.exports = typeof p.join;", '/main.js': "import d from './d.cjs';\nexport const x = d;" },
            { platform: 'node' as Platform, external: ['node:path'] },
        );
        expect(value).toBe('function');
    });

    it('off node it throws a NAMED error rather than `require is not defined`', async () => {
        const r = await build({ '/d.cjs': "module.exports = require('ext');", '/main.js': "import d from './d.cjs';\nexport const x = d;" }, { external: ['ext'] });
        expect(r.errors).toEqual([]);
        expect(r.code).toContain("__require('ext')");
    });

    it('a DYNAMIC require is still a build error — it has no specifier to defer', async () => {
        const r = await build({ '/d.cjs': 'module.exports = require(globalThis.n);', '/main.js': "import d from './d.cjs';\nexport const x = d;" });
        expect(r.errors.join('\n')).toMatch(/cannot statically resolve this require\(\)/);
    });
});

describe('import() of a CommonJS module with codeSplitting off', () => {
    it('resolves to the interop namespace, so `.default` exists', async () => {
        // The target folds into the importer's chunk, and the override pointed at `namespaceOf` —
        // which for a CommonJS module is not the interop object. `m.default.k` read `undefined`.
        expect(await run({ '/c.cjs': 'module.exports = { k: 7 };', '/main.js': "export const x = import('./c.cjs').then((m) => m.default.k);" }, { output: { codeSplitting: false } })).toBe(7);
    });

    it('an ES target is unaffected', async () => {
        expect(await run({ '/c.js': 'export const k = 7;', '/main.js': "export const x = import('./c.js').then((m) => m.k);" }, { output: { codeSplitting: false } })).toBe(7);
    });
});

describe('circular require() of an ES module', () => {
    // Node REFUSES both directions — measured on Node 24:
    //   Error [ERR_REQUIRE_CYCLE_MODULE]: Cannot require() ES Module <a> in a cycle. (from <b>)
    // shakeup emitted them and failed at load with `Cannot access 'a_ns' before initialization`,
    // which says nothing about the real problem.
    it('reports a CommonJS → ESM → CommonJS cycle', async () => {
        const r = await build({
            '/a.cjs': "const e = require('./b.js');\nmodule.exports = { b: e.v };",
            '/b.js': "import a from './a.cjs';\nexport const v = 'b';\nexport const seen = a;",
            '/main.js': "import a from './a.cjs';\nexport const x = a;",
        });
        expect(r.errors.join('\n')).toMatch(/leads back to '\/a\.cjs'/);
        expect(r.errors.join('\n')).toMatch(/ERR_REQUIRE_CYCLE_MODULE/);
    });

    it('reports an ESM → CommonJS → ESM cycle', async () => {
        const r = await build({
            '/a.js': "import b from './b.cjs';\nexport const got = b;",
            '/b.cjs': "const a = require('./a.js');\nmodule.exports = { got: a.v };",
            '/main.js': "import { got } from './a.js';\nexport const x = got;",
        });
        expect(r.errors.join('\n')).toMatch(/leads back to '\/b\.cjs'/);
    });

    it('an ACYCLIC require of an ES module is untouched', async () => {
        // The guard must be about the cycle, not about require-of-ESM, which is the whole point of
        // the `__esm` lazy init.
        expect(await run({ '/e.js': 'export const a = 7;', '/d.cjs': "module.exports = require('./e.js').a;", '/main.js': "import d from './d.cjs';\nexport const x = d;" })).toBe(7);
    });

    it('a cycle closed through a DYNAMIC import is allowed', async () => {
        // `import()` does not force synchronous evaluation, so it breaks the cycle — which is what
        // Node's own error message suggests doing.
        const r = await build({
            '/a.cjs': "module.exports = { load: () => import('./b.js') };",
            '/b.js': "import a from './a.cjs';\nexport const v = typeof a.load;",
            '/main.js': "import d from './a.cjs';\nexport const x = typeof d.load;",
        });
        expect(r.errors).toEqual([]);
    });
});

describe('§7.5 — top-level await inside a wrapper', () => {
    it('is a build error, not a SyntaxError at load', async () => {
        // A wrapper closure is a synchronous arrow, so the body stopped parsing: the bundle threw
        // `Unexpected reserved word` from a build that reported nothing. Making the closure `async`
        // is not a fix — `require()` cannot wait on a promise. Node refuses the same combination
        // (ERR_REQUIRE_ASYNC_MODULE).
        const r = await build({
            '/e.js': 'export const v = await Promise.resolve(7);',
            '/d.cjs': "module.exports = require('./e.js').v;",
            '/main.js': "import d from './d.cjs';\nexport const x = d;",
        });
        expect(r.errors.join('\n')).toMatch(/top-level await/);
        expect(r.errors.join('\n')).toMatch(/ERR_REQUIRE_ASYNC_MODULE/);
    });

    it('top-level await with no wrapper still builds and runs', async () => {
        expect(await run({ '/e.js': 'export const v = await Promise.resolve(7);', '/main.js': "import { v } from './e.js';\nexport const x = v;" })).toBe(7);
    });

    it('`await` inside a function in a required module is fine', async () => {
        // The flag must be TOP-level only — `fnDepth === 0` — or every async helper in a CommonJS
        // dependency would be rejected.
        expect(
            await run({
                '/e.js': 'export async function f() { return await Promise.resolve(7) }',
                '/d.cjs': "module.exports = require('./e.js').f;",
                '/main.js': "import d from './d.cjs';\nexport const x = d();",
            }),
        ).toBe(7);
    });
});

describe('the configurations that were already correct', () => {
    it('require() inside try/catch — the optional-dependency pattern', async () => {
        expect(
            await run({
                '/opt.cjs': "module.exports = 'OPT';",
                '/d.cjs': "let v;\ntry { v = require('./opt.cjs') } catch { v = null }\nmodule.exports = v;",
                '/main.js': "import d from './d.cjs';\nexport const x = d;",
            }),
        ).toBe('OPT');
    });

    it('a CommonJS module importing an external', async () => {
        const value = await run(
            { '/d.cjs': 'module.exports = 1;', '/main.js': "import { join } from 'node:path';\nimport d from './d.cjs';\nexport const x = [typeof join, d];" },
            { external: ['node:path'] },
        );
        expect(value).toEqual(['function', 1]);
    });

    it('__toCommonJS stamps __esModule on a required ES module', async () => {
        expect(
            await run({
                '/e.js': 'export const a = 1;',
                '/d.cjs': "const e = require('./e.js');\nmodule.exports = Object.keys(e).concat(e.__esModule ? 'M' : '-');",
                '/main.js': "import d from './d.cjs';\nexport const x = d;",
            }),
        ).toEqual(['a', 'M']);
    });
});
