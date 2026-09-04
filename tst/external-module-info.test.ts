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
