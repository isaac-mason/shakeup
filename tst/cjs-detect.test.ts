import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import { parse } from '../src/parser/index.ts';

const build = async (files: Record<string, string>) => {
    const result = await bundle({ entry: '/main.js', fs: createMemoryFs(files), external: [] });
    expect(result.errors).toEqual([]);
    return result;
};

const warningsFor = async (main: string, rest: Record<string, string> = {}) =>
    (await build({ '/main.js': main, ...rest })).warnings;

// First consumer of CommonJS kind detection (see llm/notes/cjs.md §2.1). An ESM export keyword makes
// a file ESM outright — neither oracle reclassifies on the strength of a stray `module.exports =` —
// but in an ES module those names are undeclared globals, so the CJS-shaped code silently does
// nothing. rolldown warns here (`commonjs_variable_in_esm`); esbuild has no equivalent.
describe('CommonJS variables in an ES module', () => {
    it('warns on `module` when the file has ESM exports', async () => {
        const warnings = await warningsFor('export const a = 1;\nmodule.exports = { a };');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/'module' is a CommonJS variable/);
        expect(warnings[0]).toMatch(/^\/main\.js:\d+:/);
    });

    it('warns on `exports` when the file has ESM exports', async () => {
        const warnings = await warningsFor('export const a = 1;\nexports.foo = 2;');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/'exports' is a CommonJS variable/);
    });

    it('warns for `export default` and `export *` too', async () => {
        expect(await warningsFor('export default 1;\nexports.foo = 2;')).toHaveLength(1);
        expect(await warningsFor("export * from './a.js';\nexports.foo = 2;", { '/a.js': 'export const z = 1;' })).toHaveLength(1);
    });

    it('stays quiet for a clean ES module', async () => {
        expect(await warningsFor('export const a = 1;\nexport const b = a + 1;')).toEqual([]);
    });

    it('stays quiet for a file with no ESM export keyword', async () => {
        // Not reclassified and not WARNED about — it is simply not an ES module by this rule. Read
        // the warning channel directly: this source is separately an ERROR (unsupported CommonJS),
        // which the shared `build` helper asserts against.
        const r = await bundle({ entry: '/main.js', fs: createMemoryFs({ '/main.js': 'module.exports = { a: 1 };' }), external: [] });
        expect(r.warnings).toEqual([]);
    });

    it('stays quiet when the module declares its own `exports` binding', async () => {
        // The check reads `semantic.unresolved`, so a name that binds to a real declaration is not a
        // free reference — rolldown's `is_global_identifier_reference`, for free.
        expect(await warningsFor('export const a = 1;\nconst exports = {};\nexports.foo = 2;')).toEqual([]);
    });

    it('reports at most one warning per module', async () => {
        expect(await warningsFor('export const a = 1;\nmodule.exports = {};\nexports.x = 1;\nexports.y = 2;')).toHaveLength(1);
    });

    it('does not warn merely because an imported module is CJS-shaped', async () => {
        // The warning is about THIS file's own source, not its dependencies.
        expect(await warningsFor("import './dep.js';\nexport const a = 1;", { '/dep.js': 'globalThis.x = 1;' })).toEqual([]);
    });
});

// The mirror of the warning above, and the first consumer of `ModuleDefFormat` (cjs.md §7.1b): a
// file DECLARED CommonJS — `.cjs`/`.cts`, or the nearest `package.json#type` — cannot contain ESM
// syntax. An error rather than a warning because, unlike a stray `module.exports` in ESM (which
// merely does nothing), such a file cannot be interpreted as declared at all. Port of oxc's
// `module_code` check (`oxc_semantic/src/checker/javascript.rs:532-548`).
describe('ESM syntax in a CommonJS-declared file', () => {
    const errorsFor = async (files: Record<string, string>, entry = '/main.js') =>
        (await bundle({ entry, fs: createMemoryFs(files), external: [] })).errors;

    const OK_MAIN = "import './a.cjs';\nexport const y = 1;";

    it('errors on `export` in a .cjs file', async () => {
        const errors = await errorsFor({ '/a.cjs': 'export const x = 1;', '/main.js': OK_MAIN });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/'export' statement in a CommonJS file/);
        expect(errors[0]).toMatch(/because of its \.cjs extension/);
    });

    it('errors on `import` in a .cjs file', async () => {
        const errors = await errorsFor({ '/a.cjs': "import './b.js';", '/b.js': 'globalThis.z = 1;', '/main.js': OK_MAIN });
        expect(errors[0]).toMatch(/'import' statement in a CommonJS file/);
    });

    it('errors under `"type": "commonjs"`, and says so', async () => {
        const errors = await errorsFor({
            '/pkg/package.json': '{"type":"commonjs"}',
            '/pkg/a.js': 'export const x = 1;',
            '/main.js': "import './pkg/a.js';\nexport const y = 1;",
        });
        expect(errors[0]).toMatch(/because the nearest package\.json declares "type": "commonjs"/);
    });

    it('accepts a .cjs file with no ESM syntax', async () => {
        expect(await errorsFor({ '/a.cjs': 'globalThis.q = 1;', '/main.js': OK_MAIN })).toEqual([]);
    });

    // The regression that matters most: a package.json with NO `type` field must mean UNKNOWN, not
    // CommonJS. Node's own default is CommonJS, but most packages ship no `type` and use ESM syntax
    // in `.js` — treating those as declared-CommonJS would reject the majority of real projects.
    // rolldown does the same (`resolver.rs:249-265`, both lookups return Option).
    it('a package.json without `type` decides nothing', async () => {
        expect(
            await errorsFor({ '/package.json': '{"name":"app"}', '/a.js': 'export const x = 1;', '/main.js': "import { x } from './a.js';\nexport { x };" }),
        ).toEqual([]);
    });

    it('a malformed package.json decides nothing', async () => {
        expect(
            await errorsFor({ '/package.json': '{ not json', '/a.js': 'export const x = 1;', '/main.js': "import { x } from './a.js';\nexport { x };" }),
        ).toEqual([]);
    });

    it('finds a ROOT package.json from a nested file', async () => {
        // A naive upward walk stops before probing `/package.json`, which would silently miss the
        // single most common layout: a root `"type"` covering sources in subdirectories.
        expect(
            await errorsFor({
                '/package.json': '{"type":"module"}',
                '/src/a.js': 'export const x = 1;',
                '/src/main.js': "import { x } from './a.js';\nexport { x };",
            }, '/src/main.js'),
        ).toEqual([]);
    });

    it('stops at the nearest boundary instead of inheriting a parent package', async () => {
        // `/sub` has its own package.json, so it does NOT inherit the root's "commonjs".
        const errors = await errorsFor({
            '/package.json': '{"type":"commonjs"}',
            '/sub/package.json': '{"name":"inner"}',
            '/sub/a.js': 'export const x = 1;',
            '/main.cjs': 'globalThis.q = 1;',
            '/main.js': "import { x } from './sub/a.js';\nexport { x };",
        });
        expect(errors.filter((e) => e.includes('/sub/a.js'))).toEqual([]);
    });
});

// Parse-goal gating (cjs.md §7.1c), ported from oxc's `default_context`
// (`oxc_parser/src/lib.rs:866-882`): a CommonJS file's body is wrapped in a function, so top-level
// `return` and `new.target` are legal there and illegal in an ES module. Accepting them everywhere
// is not neutral — it destroys the very signal CJS kind detection reads (tier 2, §2.1).
describe('parse goal gates top-level return / new.target', () => {
    const parseErrs = (src: string, kind?: 'module' | 'commonjs') => parse(src, { ts: false, jsx: false, kind }).errors.map((e) => e.msg);

    it('rejects top-level return in an ES module', () => {
        expect(parseErrs('return 1;', 'module')).toEqual(['return statement is only allowed inside a function body']);
    });

    it('allows top-level return in a CommonJS file', () => {
        expect(parseErrs('return 1;', 'commonjs')).toEqual([]);
    });

    it('stays permissive by default (unambiguous)', () => {
        // The migration property: adopting the gate is not a breaking change for plain `.js`.
        expect(parseErrs('return 1;')).toEqual([]);
        expect(parseErrs('new.target;')).toEqual([]);
    });

    it('allows return inside any function form, in any goal', () => {
        for (const src of ['function f(){ return 1 }', 'const f = () => { return 1 };', 'const o = { m(){ return 1 } };']) {
            expect(parseErrs(src, 'module')).toEqual([]);
        }
    });

    it('treats a plain block as still top level', () => {
        // A `{ }` block is not a function body — depth must not be bumped for it.
        expect(parseErrs('{ return 1 }', 'module')).toEqual(['return statement is only allowed inside a function body']);
    });

    it('rejects top-level new.target in an ES module, allows it in CommonJS', () => {
        expect(parseErrs('new.target;', 'module')).toEqual(["'new.target' is only allowed inside a function body"]);
        expect(parseErrs('new.target;', 'commonjs')).toEqual([]);
    });

    it('a class static block enables new.target but not return', () => {
        // oxc's asymmetry (`js/function.rs:285` vs `js/statement.rs:710-713`) — hence two counters.
        expect(parseErrs('class C { static { new.target } }', 'module')).toEqual([]);
        expect(parseErrs('class C { static { return } }', 'module')).toEqual(['return statement is only allowed inside a function body']);
    });

    it('gates top-level await: allowed in a module, not in CommonJS, permissive by default', () => {
        // oxc's third gate (`is_module() -> and_await(true)`). When `await` is not in scope it parses
        // as an ORDINARY IDENTIFIER rather than erroring (oxc `js/expression.rs:89`), so the failure
        // surfaces as `await x` being two adjacent identifiers.
        expect(parseErrs('await x;', 'module')).toEqual([]);
        expect(parseErrs('await x;', 'commonjs')).not.toEqual([]);
        expect(parseErrs('await x;')).toEqual([]);
        // …which is exactly what keeps `await(1)` a CALL to a function named `await` in CommonJS.
        expect(parseErrs('await(1);', 'commonjs')).toEqual([]);
    });

    it('scopes await to the nearest function, not the nearest async ancestor', () => {
        expect(parseErrs('async function f(){ await x }', 'module')).toEqual([]);
        // A non-async function nested in an async one must NOT inherit `await`.
        expect(parseErrs('async function o(){ function i(){ await x } }', 'module')).not.toEqual([]);
        expect(parseErrs('async function o(){ const i = () => { await x } }', 'module')).not.toEqual([]);
        // A class static block is not an async context either.
        expect(parseErrs('class C { static { await x } }', 'module')).not.toEqual([]);
    });

    it('scopes an arrow with an EXPRESSION body, not just a block body', () => {
        // Regression: only the `{ }` form was scoped, so an expression-bodied async arrow inherited
        // the enclosing scope's `await` — which broke real code like
        // `async (a, b) => (await f(a)) ?? (await g(b))` nested inside a non-async function.
        expect(parseErrs('function o(){ return async (a) => (await a) ?? 1 }', 'module')).toEqual([]);
        expect(parseErrs('const f = async x => await x;', 'module')).toEqual([]);
        expect(parseErrs('function o(){ return (a) => await a }', 'module')).not.toEqual([]);
        // …and the same gap wrongly rejected `new.target` in an expression-bodied arrow.
        expect(parseErrs('const f = () => new.target;', 'module')).toEqual([]);
    });

    it('applies the goal end-to-end from the declared format', async () => {
        const errorsFor = async (files: Record<string, string>) =>
            (await bundle({ entry: '/main.js', fs: createMemoryFs(files), external: [] })).errors;
        const body = 'if (1) { return }\n';
        const parseErrOnly = (es: string[]) => es.filter((e) => e.includes('return statement is only allowed'));
        // `.cjs` → allowed; `.mjs` → rejected; plain `.js` with no declaration → permissive.
        // Filtered to the PARSE diagnostic: a top-level `return` also classifies the file as
        // CommonJS, which raises the separate "not supported yet" error tested below.
        expect(parseErrOnly(await errorsFor({ '/a.cjs': `${body}globalThis.x = 1;`, '/main.js': "import './a.cjs';\nexport const y = 1;" }))).toEqual([]);
        expect(parseErrOnly(await errorsFor({ '/a.mjs': `${body}export const x = 1;`, '/main.js': "import './a.mjs';\nexport const y = 1;" }))).toHaveLength(1);
        expect(parseErrOnly(await errorsFor({ '/a.js': `${body}export const x = 1;`, '/main.js': "import './a.js';\nexport const y = 1;" }))).toEqual([]);
        // …and `"type": "module"` makes a plain `.js` strict.
        expect(
            parseErrOnly(
                await errorsFor({
                    '/package.json': '{"type":"module"}',
                    '/a.js': `${body}export const x = 1;`,
                    '/main.js': "import './a.js';\nexport const y = 1;",
                }),
            ),
        ).toHaveLength(1);
    });
});

// Kind detection's four tiers (cjs.md §2.1) driving the real thing: a CommonJS module is lowered to
// a `__commonJS` closure and reached through `__toESM`, matching the shapes traced out of rolldown
// in cjs.md §4.4/§4.5. Assertions EXECUTE the bundle — a plausible-looking wrapper that returns the
// wrong object would pass any text check.
describe('CommonJS modules are wrapped and interoperate', () => {
    const runCjs = async (files: Record<string, string>) => {
        const r = await bundle({ entry: '/main.js', fs: createMemoryFs(files), external: [] });
        expect(r.errors).toEqual([]);
        return { code: r.chunks[0].code, ns: (await import(`data:text/javascript,${encodeURIComponent(r.chunks[0].code)}`)) as Record<string, unknown> };
    };

    it('default-imports `module.exports`', async () => {
        const { ns } = await runCjs({ '/d.cjs': 'module.exports = { a: 1, b: 2 };', '/main.js': "import d from './d.cjs';\nexport const x = d.a + d.b;" });
        expect(ns.x).toBe(3);
    });

    it('named-imports an `exports.foo` property', async () => {
        const { ns } = await runCjs({ '/d.cjs': 'exports.foo = 7;', '/main.js': "import { foo } from './d.cjs';\nexport const x = foo;" });
        expect(ns.x).toBe(7);
    });

    it('namespace-imports a CommonJS module', async () => {
        const { ns } = await runCjs({ '/d.cjs': 'exports.a = 1; exports.b = 2;', '/main.js': "import * as m from './d.cjs';\nexport const x = [m.a, m.b];" });
        expect(ns.x).toEqual([1, 2]);
    });

    it('honours the `__esModule` marker (the common transpiled-ESM shape)', async () => {
        // Pattern 3 in cjs.md §2 — what TypeScript and Babel emit, so the most common real dep.
        // `__toESM` must bind `import d` to `exports.default`, NOT to the whole exports object.
        const { ns } = await runCjs({
            '/d.cjs': 'Object.defineProperty(exports, "__esModule", { value: true });\nexports.default = 5;\nexports.n = 9;',
            '/main.js': "import d, { n } from './d.cjs';\nexport const x = [d, n];",
        });
        expect(ns.x).toEqual([5, 9]);
    });

    it('handles a bare function export', async () => {
        const { ns } = await runCjs({ '/d.cjs': 'module.exports = function(){ return 4 };', '/main.js': "import d from './d.cjs';\nexport const x = d();" });
        expect(ns.x).toBe(4);
    });

    it('evaluates the body once, however many importers there are', async () => {
        // `__commonJS` memoizes on `mod ||`. This is also what makes a cycle observe PARTIAL exports
        // rather than re-running the body, which is Node's behaviour.
        const { ns } = await runCjs({
            '/d.cjs': 'globalThis.__n = (globalThis.__n || 0) + 1;\nmodule.exports = { n: globalThis.__n };',
            '/main.js': "import a from './d.cjs';\nimport b from './d.cjs';\nexport const x = [a.n, b.n];",
        });
        expect(ns.x).toEqual([1, 1]);
    });

    it('binds only the wrapper params the body uses', async () => {
        // rolldown emits `(exports)` for a module that never mentions `module` (cjs.md §4.4).
        const { code } = await runCjs({ '/d.cjs': 'exports.foo = 1;', '/main.js': "import { foo } from './d.cjs';\nexport const x = foo;" });
        expect(code).toMatch(/__commonJS\(\(exports\) =>/);
        const withModule = await runCjs({ '/d.cjs': 'module.exports = { foo: 1 };', '/main.js': "import d from './d.cjs';\nexport const x = d.foo;" });
        expect(withModule.code).toMatch(/__commonJS\(\(exports, module\) =>/);
    });

    it('marks the wrapper pure so an unused one can be dropped', async () => {
        const { code } = await runCjs({ '/d.cjs': 'module.exports = { a: 1 };', '/main.js': "import d from './d.cjs';\nexport const x = d.a;" });
        expect(code).toContain('/* @__PURE__ */ __commonJS');
    });

    it('still bundles a .cjs that uses no CommonJS feature, without a wrapper', async () => {
        const { code } = await runCjs({ '/a.cjs': 'globalThis.q = 1;', '/main.js': "import './a.cjs';\nexport const y = 1;" });
        expect(code).not.toContain('__commonJS');
    });

    it('does not wrap a module that declares its own `exports`', async () => {
        const { code } = await runCjs({
            '/a.js': 'const exports = {};\nexports.foo = 1;\nglobalThis.q = exports;',
            '/main.js': "import './a.js';\nexport const y = 1;",
        });
        expect(code).not.toContain('__commonJS');
    });
});

// A CJS-wrapped module's body is a closure, so deconflict deliberately skips its top-level symbols
// — they cannot collide with the chunk root. That skip removes their `finalNames` entries, and the
// mangler's step 5 anchors `slotName[slot] = existing ?? originalName`. Folded into the chunk's ROOT
// scope they would be `isTopLevel`, so an ESM binding and a wrapped-CJS binding sharing an original
// name would anchor TWO slots to that one name — and nested symbols inheriting those slots would
// collide with no liveness guarantee. Giving the wrapper its own unified scope removes the premise,
// and as a side effect lets the CJS blob be mangled at all.
describe('mangling a CJS-wrapped module', () => {
    const buildMin = async (files: Record<string, string>) => {
        const r = await bundle({ entry: '/main.js', fs: createMemoryFs(files), external: [], output: { minify: true } });
        expect(r.errors).toEqual([]);
        return { code: r.chunks[0].code, ns: (await import(`data:text/javascript,${encodeURIComponent(r.chunks[0].code)}`)) as Record<string, unknown> };
    };

    it('mangles the wrapped body instead of leaving it verbatim', async () => {
        const { code, ns } = await buildMin({
            '/dep.cjs': [
                'var longNameAlpha = 10;',
                'var longNameBeta = 20;',
                'function longFnGamma(){ return longNameAlpha + longNameBeta }',
                'module.exports = { v: longFnGamma() };',
            ].join('\n'),
            '/main.js': "import d from './dep.cjs';\nfunction outerHelper(q){ return q * 2 }\nexport const x = [d.v, outerHelper(3)];",
        });
        expect(ns.x).toEqual([30, 6]);
        expect(code).not.toContain('longNameAlpha');
        expect(code).not.toContain('longFnGamma');
    });

    it('survives a wrapped module whose top-level names match the ESM side', async () => {
        // Real pre-minified npm CJS ships exactly these base54 identifiers, which is why this is the
        // default case rather than a rarity: `deconflictChunk` seeds `taken` from claimed names, and
        // `makeMangleClaim` hands out `e, t, n, r, i, a, o, s…` in order.
        const { ns } = await buildMin({
            '/dep.cjs': [
                'var e = 1, t = 2, n = 3;',
                'function r(i){ return i + e + t + n }',
                'module.exports = { v: r(4) };',
            ].join('\n'),
            '/main.js': [
                "import d from './dep.cjs';",
                'function e(x){ return x + 1 }',
                'function t(x){ return e(x) * 2 }',
                'const n = t(5);',
                'export const x = [d.v, n];',
            ].join('\n'),
        });
        expect(ns.x).toEqual([10, 12]);
    });

    it('keeps the wrapper and its namespace distinct from user bindings', async () => {
        const { ns } = await buildMin({
            '/dep.cjs': 'module.exports = { v: 1 };',
            '/main.js': [
                "import d from './dep.cjs';",
                'function require_dep(){ return 99 }',
                'function import_dep(){ return 98 }',
                'export const x = [d.v, require_dep(), import_dep()];',
            ].join('\n'),
        });
        expect(ns.x).toEqual([1, 99, 98]);
    });
});

// `require("./x")` inside a CommonJS module lowers to the target's wrapper call. The wrapper returns
// `module.exports`, which is exactly what `require` should produce — the consumer is CommonJS and
// wants a CommonJS exports object, so no interop conversion applies in this direction.
describe('require() between CommonJS modules', () => {
    const runCjs = async (files: Record<string, string>) => {
        const r = await bundle({ entry: '/main.js', fs: createMemoryFs(files), external: [] });
        expect(r.errors).toEqual([]);
        return { code: r.chunks[0].code, ns: (await import(`data:text/javascript,${encodeURIComponent(r.chunks[0].code)}`)) as Record<string, unknown> };
    };

    it('lowers a require to the wrapper call', async () => {
        const { code, ns } = await runCjs({
            '/inner.cjs': 'module.exports = { n: 21 };',
            '/outer.cjs': "const inner = require('./inner.cjs');\nmodule.exports = { v: inner.n * 2 };",
            '/main.js': "import d from './outer.cjs';\nexport const x = d.v;",
        });
        expect(ns.x).toBe(42);
        expect(code).not.toMatch(/require\(['"]/); // no literal require survives
    });

    it('handles the facade re-export shape', async () => {
        // cjs.md §2 pattern 4: `module.exports = require('./other')`.
        const { ns } = await runCjs({
            '/inner.cjs': 'module.exports = { z: 3 };',
            '/outer.cjs': "module.exports = require('./inner.cjs');",
            '/main.js': "import d from './outer.cjs';\nexport const x = d.z;",
        });
        expect(ns.x).toBe(3);
    });

    it('follows a chain of requires', async () => {
        const { ns } = await runCjs({
            '/a.cjs': 'module.exports = 1;',
            '/b.cjs': "module.exports = require('./a.cjs') + 1;",
            '/c.cjs': "module.exports = require('./b.cjs') + 1;",
            '/main.js': "import d from './c.cjs';\nexport const x = d;",
        });
        expect(ns.x).toBe(3);
    });

    it('lowers EVERY require of a specifier, not just the first', async () => {
        // `addRecord` dedupes by specifier and used to downgrade the record's kind to `static` on the
        // second hit, silently leaving later `require` calls un-lowered — they then reached the
        // output verbatim and threw `require is not defined` in an ES module.
        const { code, ns } = await runCjs({
            '/i.cjs': 'globalThis.__k = (globalThis.__k || 0) + 1;\nmodule.exports = globalThis.__k;',
            '/o.cjs': "module.exports = [require('./i.cjs'), require('./i.cjs')];",
            '/main.js': "import d from './o.cjs';\nexport const x = d;",
        });
        expect(code).not.toMatch(/require\(['"]/);
        expect(ns.x).toEqual([1, 1]); // memoized: the body ran once
    });

    it('keeps a specifier that is both imported and required lowered', async () => {
        const { code, ns } = await runCjs({
            '/dep.cjs': 'module.exports = { n: 5 };',
            '/mid.cjs': "module.exports = require('./dep.cjs').n;",
            '/main.js': "import a from './dep.cjs';\nimport b from './mid.cjs';\nexport const x = [a.n, b];",
        });
        expect(code).not.toMatch(/require\(['"]/);
        expect(ns.x).toEqual([5, 5]);
    });
});

// cjs.md §2 pattern 7. This called for a loud rejection from the start and went unimplemented, with
// the worst possible result: the call reached the output VERBATIM, the build reported no error, and
// the bundle threw `require is not defined` at runtime. A browser bundle has no module registry to
// resolve against, so there is nothing to lower a computed specifier to.
describe('require() that cannot be resolved statically', () => {
    const errorsFor = async (files: Record<string, string>) =>
        (await bundle({ entry: '/main.js', fs: createMemoryFs(files), external: [] })).errors;
    const MAIN = "import d from './d.cjs';\nexport const x = d;";

    it('rejects a computed specifier instead of emitting it', async () => {
        const errors = await errorsFor({
            '/d.cjs': 'const which = globalThis.flag ? "a" : "b";\nmodule.exports = require(which);',
            '/main.js': MAIN,
        });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/cannot statically resolve this require\(\)/);
        expect(errors[0]).toMatch(/specifier is not a string literal/);
    });

    it('rejects a concatenated specifier', async () => {
        expect((await errorsFor({ '/d.cjs': 'module.exports = require("./" + name);', '/main.js': MAIN }))[0]).toMatch(/not a string literal/);
    });

    it('reports the wrong arity distinctly', async () => {
        expect((await errorsFor({ '/d.cjs': 'module.exports = require();', '/main.js': MAIN }))[0]).toMatch(/it takes 0 arguments/);
    });

    it('does not fire for a literal require', async () => {
        expect(await errorsFor({ '/i.cjs': 'module.exports = 1;', '/d.cjs': "module.exports = require('./i.cjs');", '/main.js': MAIN })).toEqual([]);
    });

    it('does not fire for a LOCAL function named require', async () => {
        // The check keys on a free reference, so somebody else's `require` helper is not Node's.
        expect(
            await errorsFor({
                '/d.cjs': 'function require(x){ return x * 2 }\nmodule.exports = require(21);',
                '/main.js': MAIN,
            }),
        ).toEqual([]);
    });
});

// cjs.md §2.4 — a whole missing lowering, found by auditing §7.14 rather than by the audit's own
// hypothesis. A CommonJS body is CALLED with `module.exports` as its receiver, so top-level `this`
// is an export mechanism. Untreated, `this.v = 1` exported nothing and the UMD probe
// `typeof this === "object"` silently took the wrong branch — pattern 10, "must work".
describe('top-level `this` in a CommonJS module', () => {
    const runDep = async (dep: string) => {
        const r = await bundle({ entry: '/main.js', fs: createMemoryFs({ '/d.cjs': dep, '/main.js': "import d from './d.cjs';\nexport const x = d.v;" }), external: [] });
        expect(r.errors).toEqual([]);
        return (await import(`data:text/javascript,${encodeURIComponent(r.chunks[0].code)}`)) as Record<string, unknown>;
    };

    it('treats `this.v = …` as an export', async () => {
        expect((await runDep('this.v = 42;')).x).toBe(42);
    });

    it('makes the UMD `typeof this === "object"` probe take the CommonJS branch', async () => {
        expect((await runDep('if (typeof this === "object") { module.exports = { v: 42 } } else { this.v = 0 }')).x).toBe(42);
    });

    it('rewrites `this` inside an arrow, which does not rebind it', async () => {
        expect((await runDep('const f = () => { this.v = 42 };\nf();')).x).toBe(42);
    });

    it('leaves `this` alone inside a function, which DOES rebind it', async () => {
        expect((await runDep('function f(){ return this === undefined }\nmodule.exports = { v: f.call(undefined) ? 42 : 0 };')).x).toBe(42);
    });

    it('leaves a method`s own `this` alone', async () => {
        expect((await runDep('const o = { m(){ return this.k }, k: 42 };\nmodule.exports = { v: o.m() };')).x).toBe(42);
    });

    it('leaves a class field`s `this` alone', async () => {
        expect((await runDep('class C { k = 42; get(){ return this.k } }\nmodule.exports = { v: new C().get() };')).x).toBe(42);
    });

    it('leaves an arrow nested inside a function bound to that function', async () => {
        expect((await runDep('function f(){ const g = () => this; return g() }\nmodule.exports = { v: f.call({ k: 42 }).k };')).x).toBe(42);
    });

    it('wraps a module whose ONLY CommonJS signal is top-level `this`', async () => {
        // No `module`/`exports` reference and no top-level return — tier 3 classifies it CommonJS by
        // extension, but without counting `this` it was never wrapped, and the import failed with
        // "'default' is not exported".
        const r = await bundle({ entry: '/main.js', fs: createMemoryFs({ '/d.cjs': 'this.v = 42;', '/main.js': "import d from './d.cjs';\nexport const x = d.v;" }), external: [] });
        expect(r.errors).toEqual([]);
        expect(r.chunks[0].code).toContain('__commonJS');
    });
});

// Re-exporting FROM a CommonJS module — the barrel shape, and how most packages are actually
// consumed. `matchImport` used to recurse into the CJS target looking for a named export it cannot
// have (its surface is built at runtime), then blame the RE-EXPORTER for not providing the name.
describe('re-exporting from a CommonJS module', () => {
    const runFiles = async (files: Record<string, string>) => {
        const r = await bundle({ entry: '/main.js', fs: createMemoryFs(files), external: [] });
        expect(r.errors).toEqual([]);
        return (await import(`data:text/javascript,${encodeURIComponent(r.chunks[0].code)}`)) as Record<string, unknown>;
    };
    const D = { '/d.cjs': 'exports.a = 1; exports.b = 2;' };

    it('forwards a named export', async () => {
        expect((await runFiles({ ...D, '/b.js': "export { a } from './d.cjs';", '/main.js': "import { a } from './b.js';\nexport const x = a;" })).x).toBe(1);
    });

    it('forwards a renamed export', async () => {
        expect((await runFiles({ ...D, '/b.js': "export { a as z } from './d.cjs';", '/main.js': "import { z } from './b.js';\nexport const x = z;" })).x).toBe(1);
    });

    it('forwards `default`', async () => {
        expect(
            (await runFiles({ '/d.cjs': 'module.exports = 9;', '/b.js': "export { default } from './d.cjs';", '/main.js': "import v from './b.js';\nexport const x = v;" }))
                .x,
        ).toBe(9);
    });

    it('forwards a namespace', async () => {
        expect(
            (await runFiles({ ...D, '/b.js': "export * as ns from './d.cjs';", '/main.js': "import { ns } from './b.js';\nexport const x = [ns.a, ns.b];" })).x,
        ).toEqual([1, 2]);
    });

    it('forwards through two hops of barrel', async () => {
        expect(
            (await runFiles({
                ...D,
                '/b.js': "export { a } from './d.cjs';",
                '/c.js': "export { a } from './b.js';",
                '/main.js': "import { a } from './c.js';\nexport const x = a;",
            })).x,
        ).toBe(1);
    });

    it('reports `export * from` a CommonJS module against the RIGHT file', async () => {
        // Not supported yet (cjs.md §7.4 — it needs the runtime `__reExport` namespace, "mode 2" of
        // §4.4). What matters here is that the diagnostic names the re-exporter and the real cause,
        // rather than claiming the barrel is missing a name it was never going to declare.
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({ ...D, '/b.js': "export * from './d.cjs';", '/main.js': "import { a } from './b.js';\nexport const x = a;" }),
            external: [],
        });
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0]).toMatch(/^\/b\.js: 'export \* from/);
        expect(r.errors[0]).toMatch(/that module is CommonJS/);
        expect(r.errors[0]).not.toMatch(/is not exported by/);
    });
});
