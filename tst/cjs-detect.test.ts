import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

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
        // Not reclassified and not warned about — it simply is not an ES module by this rule.
        expect(await warningsFor('module.exports = { a: 1 };')).toEqual([]);
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
