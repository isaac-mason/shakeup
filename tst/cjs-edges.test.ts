import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';
import type { Platform } from '../src/bundler/resolve.ts';
import { runChunks } from './exec-helpers.ts';

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
            {
                '/d.cjs': "const p = require('node:path');\nmodule.exports = typeof p.join;",
                '/main.js': "import d from './d.cjs';\nexport const x = d;",
            },
            { platform: 'node' as Platform, external: ['node:path'] },
        );
        expect(value).toBe('function');
    });

    it('off node it throws a NAMED error rather than `require is not defined`', async () => {
        const r = await build(
            { '/d.cjs': "module.exports = require('ext');", '/main.js': "import d from './d.cjs';\nexport const x = d;" },
            { external: ['ext'] },
        );
        expect(r.errors).toEqual([]);
        expect(r.chunks[0].code).toContain("__require('ext')");
    });

    it('a DYNAMIC require is still a build error — it has no specifier to defer', async () => {
        const r = await build({
            '/d.cjs': 'module.exports = require(globalThis.n);',
            '/main.js': "import d from './d.cjs';\nexport const x = d;",
        });
        expect(r.errors.join('\n')).toMatch(/cannot statically resolve this require\(\)/);
    });
});

describe('import() of a CommonJS module with codeSplitting off', () => {
    it('resolves to the interop namespace, so `.default` exists', async () => {
        // The target folds into the importer's chunk, and the override pointed at `namespaceOf` —
        // which for a CommonJS module is not the interop object. `m.default.k` read `undefined`.
        expect(
            await run(
                {
                    '/c.cjs': 'module.exports = { k: 7 };',
                    '/main.js': "export const x = import('./c.cjs').then((m) => m.default.k);",
                },
                { output: { codeSplitting: false } },
            ),
        ).toBe(7);
    });

    it('an ES target is unaffected', async () => {
        expect(
            await run(
                { '/c.js': 'export const k = 7;', '/main.js': "export const x = import('./c.js').then((m) => m.k);" },
                { output: { codeSplitting: false } },
            ),
        ).toBe(7);
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
        expect(
            await run({
                '/e.js': 'export const a = 7;',
                '/d.cjs': "module.exports = require('./e.js').a;",
                '/main.js': "import d from './d.cjs';\nexport const x = d;",
            }),
        ).toBe(7);
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
        expect(
            await run({
                '/e.js': 'export const v = await Promise.resolve(7);',
                '/main.js': "import { v } from './e.js';\nexport const x = v;",
            }),
        ).toBe(7);
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
            {
                '/d.cjs': 'module.exports = 1;',
                '/main.js': "import { join } from 'node:path';\nimport d from './d.cjs';\nexport const x = [typeof join, d];",
            },
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

// The oracles DISAGREE on `__commonJS`, and only esbuild matches Node. A CommonJS module whose body
// throws is deleted from Node's require cache and RE-RUNS on the next `require()` — measured on
// Node 24: a module that throws once then succeeds gives `["THREW:first", {ran:2}]`.
//
// rolldown's `__commonJS` (`runtime-base.js:25-31`) has no `try`, so `mod` keeps the HALF-POPULATED
// exports object from the failed run and the second require hands that back. shakeup had transcribed
// rolldown's, and returned `{}` where Node returns `{ran:2}` — silently.
//
// esbuild's form (`runtime.go:201-207`) resets `mod = 0` in a `catch`, which is why it also does not
// null `cb` after the first call: a retry needs it.
describe('a CommonJS module that throws re-runs on the next require', () => {
    const build = async (files: Record<string, string>) => {
        const r = await bundle({ entry: '/main.js', external: [], fs: createMemoryFs(files) });
        expect(r.errors).toEqual([]);
        return (await import(`data:text/javascript,${encodeURIComponent(r.chunks[0].code)}`)) as { x: unknown };
    };

    it('matches Node: the failed run is not cached', async () => {
        const ns = await build({
            '/t.cjs':
                "globalThis.__retryN = (globalThis.__retryN ?? 0) + 1;\nif (globalThis.__retryN === 1) throw new Error('first');\nmodule.exports = { ran: globalThis.__retryN };",
            '/d.cjs':
                "const out = [];\nfor (let i = 0; i < 2; i++) { try { out.push(require('./t.cjs')) } catch (e) { out.push('THREW:' + e.message) } }\nmodule.exports = out;",
            '/main.js': "import d from './d.cjs';\nexport const x = d;",
        });
        expect(ns.x).toEqual(['THREW:first', { ran: 2 }]);
    });

    it('a module that succeeds still evaluates exactly once', async () => {
        // The memoization must survive the `try` — otherwise every require re-runs the body.
        const ns = await build({
            '/t.cjs': 'globalThis.__onceN = (globalThis.__onceN ?? 0) + 1;\nmodule.exports = { n: globalThis.__onceN };',
            '/d.cjs': "const a = require('./t.cjs');\nconst b = require('./t.cjs');\nmodule.exports = [a.n, b.n, a === b];",
            '/main.js': "import d from './d.cjs';\nexport const x = d;",
        });
        expect(ns.x).toEqual([1, 1, true]);
    });

    it('an ES module’s error stays STICKY — the opposite, and deliberate', async () => {
        // Spec: an ES module that throws during evaluation rethrows the same error forever. The two
        // helpers are asymmetric on purpose; `__esm` keeps its `err` cache.
        const ns = await build({
            '/e.js':
                "globalThis.__esmRetryN = (globalThis.__esmRetryN ?? 0) + 1;\nthrow new Error('boom' + globalThis.__esmRetryN);\nexport const a = 1;",
            '/d.cjs':
                "const out = [];\nfor (let i = 0; i < 2; i++) { try { require('./e.js') } catch (e) { out.push(e.message) } }\nmodule.exports = out;",
            '/main.js': "import d from './d.cjs';\nexport const x = d;",
        });
        expect(ns.x).toEqual(['boom1', 'boom1']);
    });
});

// An eighth configuration that had never been RUN: one module `require()`s an ES module while
// ANOTHER imports the same module as a namespace. The namespace analysis only classifies
// `import * as ns` BINDINGS, so the `require` — which the emitter lowers to
// `(init_dep(), __toCommonJS(dep_ns))` and whose result the requiring code may do anything to — was
// invisible to it, and the object was narrowed to `main.js`'s reads and then elided outright.
//
// Both failures are silent at build time. node and rolldown agree on the answer below.
describe('require() of an ES module that a sibling also imports as a namespace', () => {
    const files = {
        '/dep.js': "export const alpha = 'ALPHA';\nexport const beta = 'BETA';\n",
        '/mid.cjs': "const all = require('./dep.js');\nmodule.exports.keys = Object.keys(all).join(',');\n",
        '/main.js': "import * as ns from './dep.js';\nimport mid from './mid.cjs';\nexport const x = [ns.alpha, mid.keys];\n",
    };

    it('keeps the WHOLE surface — the require reads keys nothing names statically', async () => {
        // Narrowed to `main.js`'s single read, this answered `'alpha'`. `beta` is exported and never
        // named by any `ns.` read, which is exactly the member narrowing would drop.
        expect(await run(files)).toEqual(['ALPHA', 'alpha,beta']);
    });

    it('builds the object at all — eliding it left `__toCommonJS` naming an undeclared local', async () => {
        // The elision arm of the same cause, and the louder one: `ReferenceError: dep_ns is not
        // defined` at load. Asserted on the TEXT as well as by running, because a future change that
        // reintroduces the elision would fail this with a message that names the cause.
        const r = await build(files);
        expect(r.errors).toEqual([]);
        const code = r.chunks.map((c) => c.code).join('\n');
        const named = /__toCommonJS\((\w+)\)/.exec(code);
        expect(named, 'the require should still lower through __toCommonJS').not.toBeNull();
        expect(code, 'the namespace object it names must be declared').toMatch(
            new RegExp(`(?:var|const|let) ${named?.[1]} = \\{`),
        );
    });
});

// A ninth never-run configuration, and the loudest: the emitted chunk did not PARSE.
//
// `export { default as t } from './x.cjs'` binds `t` to a CommonJS member, which renders as
// `import_x.default`. That is valid wherever a bare name is — except an export specifier, whose local
// MUST be an identifier. The chunk came out as `export { import_x.default as thing }`, a SyntaxError,
// from a build that reported no errors at all.
//
// rolldown declares a local and exports that (`var thing = import_dep.default; export { got, thing }`)
// and this does the same, with the name deconflicted during wiring.
describe('re-exporting a CommonJS binding on a chunk`s export clause', () => {
    const dep = { '/dep.cjs': "module.exports = { d: 'DEFAULT' };\nmodule.exports.alpha = 'A';\n" };

    // The re-export is a PURE one: `export { X } from './y'` creates no local binding, so `x` is
    // computed through a separate `import` rather than by naming `thing`. Both fixtures were run
    // under node first — naming `thing` here is a `ReferenceError` in real JS too, and would have
    // been read as a shakeup bug.
    it.each([
        [
            'the entry re-exports `default`',
            "export { default as thing } from './dep.cjs';\nimport dep from './dep.cjs';\nexport const x = dep.d;",
            'DEFAULT',
        ],
        [
            'the entry re-exports a NAMED member',
            "export { alpha as thing } from './dep.cjs';\nimport dep from './dep.cjs';\nexport const x = dep.alpha;",
            'A',
        ],
    ])('%s', async (_name, main, want) => {
        // `run` executes through `runChunks`, which since §2z54 also runs shakeup's own checker over
        // every chunk — so an unparseable export clause fails here rather than silently shipping.
        expect(await run({ ...dep, '/main.js': main })).toBe(want);
    });

    it('a DYNAMIC chunk re-exporting `default` gets the same treatment', async () => {
        expect(
            await run({
                ...dep,
                '/mid.js': "export { default as thing } from './dep.cjs';",
                '/main.js': "export const x = import('./mid.js').then((m) => m.thing.d);",
            }),
        ).toBe('DEFAULT');
    });

    it('but a whole-namespace re-export needs no alias — it is already an identifier', async () => {
        // The falsification arm: without it, the assertions above would be pinning "we never emit an
        // export clause" rather than "we alias only what has to be aliased".
        //
        // It does NOT cover the `bind.name !== NAME_NAMESPACE` condition in `chunk-graph.ts`, and
        // sabotaging that condition proves it — the output is byte-identical, because the emitter
        // gates on `!isIdentName(local)` and a namespace local always is one. That condition is
        // documented there as belt-and-braces rather than left looking load-bearing.
        const main = "export * as ns from './dep.cjs';\nimport * as ns2 from './dep.cjs';\nexport const x = ns2.alpha;";
        const r = await build({ ...dep, '/main.js': main });
        expect(r.errors).toEqual([]);
        const code = r.chunks.map((c) => c.code).join('\n');
        expect(code, 'the namespace is exported directly, with no `var ns = …` line').toMatch(/export \{[^}]*\bas ns\b/);
        expect(await run({ ...dep, '/main.js': main })).toBe('A');
    });
});

// An eleventh never-run configuration: a dynamic `import()` of a CommonJS module, from a package
// whose `package.json` says `"type": "module"`.
//
// The interop namespace comes in two flavours — `__toESM(x)` and node-mode `__toESM(x, 1)` — and an
// importer gets one or the other by its own `defFormat`. Every consumer of that pair picks with
// `isEsmFormat(mod.defFormat) ? cjsNamespaceNode : cjsNamespace`; the dynamic-import rewrite read
// only the non-node map. So under `"type": "module"` the lookup missed and fell through to
// `namespaceOf` — which for a CommonJS target is an EMPTY object, because a CJS module has no ESM
// export map. `(await import('./dep.cjs')).beta` came out `undefined`, from a build with no errors.
//
// The `package.json` is load-bearing: without it these same fixtures pass, which is why the crossing
// had never been run.
describe('dynamic import() of a CommonJS module under "type": "module"', () => {
    const pkg = { '/package.json': '{"name":"x","type":"module"}' };

    it('resolves to the interop namespace, not an empty synthesized one', async () => {
        expect(
            await run({
                ...pkg,
                '/dep.cjs': "exports.alpha = 'A';\nexports.beta = 'B';\n",
                '/mid.cjs': "const d = require('./dep.cjs');\nmodule.exports.viaRequire = d.alpha;\n",
                '/main.js':
                    "import mid from './mid.cjs';\n" +
                    "export const x = Promise.all([mid.viaRequire, import('./dep.cjs').then((m) => m.beta)]);",
            }),
        ).toEqual(['A', 'B']);
    });

    it('and the SAME instance each time, so a mutation between imports is visible', async () => {
        expect(
            await run({
                ...pkg,
                '/dep.cjs': 'exports.n = 1;\nexports.bump = () => { exports.n += 1; };\n',
                '/main.js':
                    "import d from './dep.cjs';\n" +
                    'export const x = (async () => {\n' +
                    "  (await import('./dep.cjs')).default.bump();\n" +
                    "  return [d.n, (await import('./dep.cjs')).default.n];\n" +
                    '})();',
            }),
        ).toEqual([2, 2]);
    });

    it('still works WITHOUT the package.json — the non-node flavour', async () => {
        // The falsification arm: the fix picks a map by `defFormat`, so it must not have simply
        // swapped one hard-coded map for the other. Same shape, no `package.json`, and the target is
        // statically imported too so it stays in THIS chunk — the branch the fix is in.
        expect(
            await run({
                '/dep.cjs': "exports.beta = 'B';\n",
                '/main.js':
                    "import d from './dep.cjs';\n" +
                    "export const x = Promise.all([d.beta, import('./dep.cjs').then((m) => m.beta)]);",
            }),
        ).toEqual(['B', 'B']);
    });
});

// A twelfth never-run configuration: a CommonJS module reached by NOTHING but a dynamic `import()`,
// so it becomes its own chunk and the CROSS-chunk branch runs rather than the one above.
//
// That chunk exports only `export default require_dep();` — a CJS module has no named ESM surface —
// so a bare `import()` of it answers a namespace whose every named member is `undefined`. Both
// oracles convert at the SITE; rolldown emits
// `import("./dep.js").then((m) => __toESM(m.default, 1)).then((m) => m.beta)`.
//
// The helper had to follow: `helpersNeededBy` asked whether a module in the chunk IS a CJS target,
// and for a cross-chunk dynamic import the target lives elsewhere — so `__toESM` went missing and the
// chunk referenced an undeclared name.
describe('a CommonJS module reached only by dynamic import()', () => {
    const dyn = "export const x = import('./dep.cjs').then((m) => m.beta);";
    const dep = { '/dep.cjs': "exports.beta = 'B';\n" };

    it('converts at the import site', async () => {
        expect(await run({ ...dep, '/main.js': dyn })).toBe('B');
    });

    it('and in node mode under "type": "module"', async () => {
        expect(await run({ ...dep, '/package.json': '{"name":"x","type":"module"}', '/main.js': dyn })).toBe('B');
    });

    it('picks the node-mode flag from the importer, not a constant', async () => {
        const plain = await build({ ...dep, '/main.js': dyn });
        const node = await build({ ...dep, '/package.json': '{"name":"x","type":"module"}', '/main.js': dyn });
        const site = (r: { chunks: { code: string }[] }) =>
            (/import\([^)]*\)\.then\(\(m\) => __toESM\([^)]*\)\)/.exec(r.chunks.map((c) => c.code).join('\n')) ?? [''])[0];
        expect(site(plain), 'no importer package.json — the plain flavour').toContain('__toESM(m.default)');
        expect(site(node), '"type": "module" — node mode').toContain('__toESM(m.default, 1)');
    });

    it('leaves the SAME-chunk case alone', async () => {
        // The falsification arm. When the target is in this chunk there is already an interop
        // binding to name, and the site must keep using it rather than re-converting a `default`
        // that is not on a chunk boundary at all.
        const r = await build({
            ...dep,
            '/main.js':
                "import d from './dep.cjs';\nexport const x = Promise.all([d.beta, import('./dep.cjs').then((m) => m.beta)]);",
        });
        const code = r.chunks.map((c) => c.code).join('\n');
        expect(code, 'same chunk: resolve to the interop binding').toMatch(/Promise\.resolve\(\)\.then\(\(\) => import_dep\b/);
        expect(code, 'and not through a cross-chunk conversion').not.toContain('__toESM(m.default');
    });
});
