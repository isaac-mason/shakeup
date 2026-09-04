import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';
import type { ModuleInfo } from '../src/bundler/plugin.ts';

// Rollup keeps EXTERNAL modules in the module graph as `ExternalModule`s, each with its own
// `ModuleInfo` carrying `isExternal: true` and whatever `meta` the resolution attached — which is how
// `custom-external-module-options` reads back `{ 'test-plugin': { resolved: true } }` from `buildEnd`.
// shakeup does not make them modules (no source, no AST, no symbols), so `getModuleInfo` used to
// answer `null` for one and the fixture crashed reading `.meta` off it.
//
// rolldown is no help here: its `ModuleInfo` struct has neither `meta` nor `is_external`, and a
// section of its ignore list is titled "The `ModuleInfo` is not compatible with rollup". Rollup is
// the oracle for this one.
const build = async (files: Record<string, string>, opts: Record<string, unknown>) =>
    bundle({ entry: '/main.js', fs: createMemoryFs(files), ...opts } as never);

describe('getModuleInfo for an external module', () => {
    it('reports the `meta` a resolveId attached, as Rollup does', async () => {
        let info: ModuleInfo | null | undefined;
        const r = await build(
            { '/main.js': "import 'ext';\nexport const x = 1;\n" },
            {
                external: [],
                plugins: [
                    {
                        name: 'test-plugin',
                        resolveId(id: string) {
                            return id === 'ext' ? { id, external: true, meta: { 'test-plugin': { resolved: true } } } : null;
                        },
                    },
                    {
                        name: 'wrap-up',
                        buildEnd(this: { getModuleInfo: (id: string) => ModuleInfo | null }) {
                            info = this.getModuleInfo('ext');
                        },
                    },
                ],
            },
        );
        expect(r.errors).toEqual([]);
        expect(info?.meta).toEqual({ 'test-plugin': { resolved: true } });
        expect(info?.isExternal).toBe(true);
        expect(info?.code).toBe(null);
        expect(info?.hasDefaultExport).toBe(null);
        expect(info?.importers).toEqual(['/main.js']);
    });

    it('answers for an external declared by the `external` OPTION too, with empty meta', async () => {
        let info: ModuleInfo | null | undefined;
        await build(
            { '/main.js': "import 'ext';\nexport const x = 1;\n" },
            {
                external: ['ext'],
                plugins: [
                    {
                        name: 'wrap-up',
                        buildEnd(this: { getModuleInfo: (id: string) => ModuleInfo | null }) {
                            info = this.getModuleInfo('ext');
                        },
                    },
                ],
            },
        );
        expect(info?.isExternal).toBe(true);
        expect(info?.meta).toEqual({});
        expect(info?.importers).toEqual(['/main.js']);
    });

    it('separates dynamic importers from static ones', async () => {
        let info: ModuleInfo | null | undefined;
        await build(
            { '/main.js': "export const p = import('ext');\n" },
            {
                external: ['ext'],
                plugins: [
                    {
                        name: 'wrap-up',
                        buildEnd(this: { getModuleInfo: (id: string) => ModuleInfo | null }) {
                            info = this.getModuleInfo('ext');
                        },
                    },
                ],
            },
        );
        expect(info?.dynamicImporters).toEqual(['/main.js']);
        expect(info?.importers).toEqual([]);
    });

    it('still answers null for an id that is neither a module nor an external', async () => {
        let info: ModuleInfo | null | undefined;
        await build(
            { '/main.js': 'export const x = 1;\n' },
            {
                external: [],
                plugins: [
                    {
                        name: 'wrap-up',
                        buildEnd(this: { getModuleInfo: (id: string) => ModuleInfo | null }) {
                            info = this.getModuleInfo('nope');
                        },
                    },
                ],
            },
        );
        expect(info).toBe(null);
    });
});

// A plugin may resolve a specifier TO something the `external` OPTION covers — Rollup's
// `external-normalization` (#633) maps `'./dep.js'` to `'path'` under `external: ['path']`. Both
// oracles re-run the matcher over the RESOLVED id with `isResolved: true`: Rollup's
// `normalizeResolveIdResult`, and rolldown's `resolve_id_check_external.rs`
// (`external.call(resolved_id.id, importer, true)` for any result that did not declare `external`
// itself). Without it shakeup tried to LOAD `'path'` and failed with "cannot load module 'path'".
describe('a plugin resolving into the `external` option', () => {
    const build2 = async (files: Record<string, string>, opts: Record<string, unknown>) =>
        bundle({ entry: '/main.js', fs: createMemoryFs(files), ...opts } as never);

    it('externalises the resolved id and imports UNDER it', async () => {
        const r = await build2(
            { '/main.js': "export { resolve } from './dep.js';\n" },
            {
                external: ['path'],
                plugins: [{ name: 'p', resolveId: (id: string) => (id === './dep.js' ? 'path' : null) }],
            },
        );
        expect(r.errors).toEqual([]);
        const code = r.chunks.map((c) => c.code).join('\n');
        expect(code, "the emitted import names the RESOLVED id, not './dep.js'").toContain("'path'");
        expect(code).not.toContain('./dep.js');
    });

    it('applies to the OBJECT result form too, not just a bare string', async () => {
        // Rollup's `normalizeResolveIdResult` re-checks both forms; rolldown re-checks any result
        // whose own `external` is `false`. Only the string form was covered until this test.
        const r = await build2(
            { '/main.js': "export { resolve } from './dep.js';\n" },
            {
                external: ['path'],
                plugins: [{ name: 'p', resolveId: (id: string) => (id === './dep.js' ? { id: 'path' } : null) }],
            },
        );
        expect(r.errors).toEqual([]);
        const code = r.chunks.map((c) => c.code).join('\n');
        expect(code).toContain("'path'");
        expect(code).not.toContain('./dep.js');
    });

    it('keeps a RELATIVE source specifier when the id it resolved to is absolute', async () => {
        // `makeAbsoluteExternalsRelative` defaults to `'ifRelativeSource'`, so Rollup renormalizes an
        // absolute external id back to a relative path exactly when the source was relative.
        // Measured on rollup 4.63: `'./rel-lib.js'` -> `{ id: '<abs>/rel-lib.js', external: true }`
        // emits `from './rel-lib.js'`, while the same result for a BARE source emits the absolute id.
        const r = await build2(
            { '/main.js': "export { y } from './rel-lib.js';\n" },
            {
                external: [],
                plugins: [
                    {
                        name: 'p',
                        resolveId: (id: string) => (id === './rel-lib.js' ? { id: '/deep/rel-lib.js', external: true } : null),
                    },
                ],
            },
        );
        expect(r.errors).toEqual([]);
        const code = r.chunks.map((c) => c.code).join('\n');
        expect(code).toContain("'./rel-lib.js'");
        expect(code).not.toContain('/deep/rel-lib.js');
    });

    it('a string result the option does NOT cover is still loaded as a module', async () => {
        const r = await build2(
            { '/main.js': "export { y } from './dep.js';\n", '/real.js': 'export const y = 5;\n' },
            {
                external: ['path'],
                plugins: [{ name: 'p', resolveId: (id: string) => (id === './dep.js' ? '/real.js' : null) }],
            },
        );
        expect(r.errors).toEqual([]);
        expect(r.chunks.map((c) => c.code).join('\n')).toContain('5');
    });
});
