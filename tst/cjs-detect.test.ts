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
