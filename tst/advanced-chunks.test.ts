import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

describe('output.advancedChunks', () => {
    it('a test-based vendor group splits node_modules into its own chunk', async () => {
        const r = await bundle({
            input: { a: '/a.ts', b: '/b.ts' },
            fs: createMemoryFs({
                '/a.ts': "import { v } from './node_modules/lib';\nexport const av = v;",
                '/b.ts': "import { v } from './node_modules/lib';\nexport const bv = v;",
                '/node_modules/lib.ts': 'export const v = 9;',
            }),
            external: [],
            output: { advancedChunks: { groups: [{ name: 'vendor', test: /node_modules/ }] } },
        });
        expect(r.errors).toEqual([]);
        const vendor = r.chunks.find((c) => c.name === 'vendor')!;
        expect(vendor).toBeDefined();
        expect(vendor.moduleIds).toEqual(['/node_modules/lib.ts']);
        const a = r.chunks.find((c) => c.name === 'a')!;
        expect(a.imports).toContain(vendor.name);
    });

    it('string test matches by substring', async () => {
        const r = await bundle({
            input: { a: '/a.ts' },
            fs: createMemoryFs({
                '/a.ts': "import { v } from './vendor';\nexport const av = v;",
                '/vendor.ts': 'export const v = 1;',
            }),
            external: [],
            output: { advancedChunks: { groups: [{ name: 'libs', test: 'vendor' }] } },
        });
        expect(r.errors).toEqual([]);
        const libs = r.chunks.find((c) => c.name === 'libs')!;
        expect(libs.moduleIds).toEqual(['/vendor.ts']);
    });

    it('priority resolves an overlapping-group tie (higher priority wins)', async () => {
        // Both groups match /node_modules/react; the higher-priority `react` group captures it.
        const r = await bundle({
            input: { a: '/a.ts' },
            fs: createMemoryFs({
                '/a.ts': "import { r } from './node_modules/react';\nimport { l } from './node_modules/lodash';\nexport const v = r + l;",
                '/node_modules/react.ts': 'export const r = 1;',
                '/node_modules/lodash.ts': 'export const l = 2;',
            }),
            external: [],
            output: {
                advancedChunks: {
                    groups: [
                        { name: 'vendor', test: /node_modules/, priority: 1 },
                        { name: 'react', test: /node_modules[\\/]react/, priority: 2 },
                    ],
                },
            },
        });
        expect(r.errors).toEqual([]);
        const react = r.chunks.find((c) => c.name === 'react')!;
        const vendor = r.chunks.find((c) => c.name === 'vendor')!;
        expect(react.moduleIds).toEqual(['/node_modules/react.ts']);
        expect(vendor.moduleIds).toEqual(['/node_modules/lodash.ts']);
    });

    it('a function name produces per-module chunk names', async () => {
        const r = await bundle({
            input: { a: '/a.ts' },
            fs: createMemoryFs({
                '/a.ts': "import { x } from './node_modules/dep';\nexport const v = x;",
                '/node_modules/dep.ts': 'export const x = 1;',
            }),
            external: [],
            output: {
                advancedChunks: {
                    groups: [
                        {
                            name: (id) => (id.includes('node_modules') ? `pkg-${id.split('/').pop()!.replace('.ts', '')}` : null),
                        },
                    ],
                },
            },
        });
        expect(r.errors).toEqual([]);
        const pkg = r.chunks.find((c) => c.name === 'pkg-dep')!;
        expect(pkg).toBeDefined();
        expect(pkg.moduleIds).toEqual(['/node_modules/dep.ts']);
    });

    it('function name/test receive a graph-backed getModuleInfo meta', async () => {
        let seenNameId: string | undefined;
        let seenTestId: string | undefined;
        const r = await bundle({
            input: { a: '/a.ts' },
            fs: createMemoryFs({
                '/a.ts': "import { x } from './dep';\nexport const v = x;",
                '/dep.ts': 'export const x = 1;',
            }),
            external: [],
            output: {
                advancedChunks: {
                    groups: [
                        {
                            name: (id, meta) => {
                                if (id === '/dep.ts') seenNameId = meta.getModuleInfo(id)?.id;
                                return 'libs';
                            },
                            test: (id, meta) => {
                                if (id === '/dep.ts') seenTestId = meta.getModuleInfo(id)?.id;
                                return id.includes('dep');
                            },
                        },
                    ],
                },
            },
        });
        expect(r.errors).toEqual([]);
        expect(seenTestId).toBe('/dep.ts');
        expect(seenNameId).toBe('/dep.ts');
        expect(r.chunks.some((c) => c.name === 'libs')).toBe(true);
    });

    it('top-level minShareCount is a group fallback', async () => {
        // dep is shared by both entries (shareCount 2). minShareCount 2 lets it be captured.
        const r = await bundle({
            input: { a: '/a.ts', b: '/b.ts' },
            fs: createMemoryFs({
                '/a.ts': "import { x } from './dep';\nexport const av = x;",
                '/b.ts': "import { x } from './dep';\nexport const bv = x;",
                '/dep.ts': 'export const x = 1;',
            }),
            external: [],
            output: { advancedChunks: { minShareCount: 2, groups: [{ name: 'shared', test: 'dep' }] } },
        });
        expect(r.errors).toEqual([]);
        const shared = r.chunks.find((c) => c.name === 'shared')!;
        expect(shared.moduleIds).toEqual(['/dep.ts']);
    });

    it('advancedChunks wins over manualChunks when both are set (with a warning)', async () => {
        const r = await bundle({
            input: { a: '/a.ts' },
            fs: createMemoryFs({
                '/a.ts': "import { v } from './vendor';\nexport const y = v;",
                '/vendor.ts': 'export const v = 1;',
            }),
            external: [],
            output: {
                advancedChunks: { groups: [{ name: 'adv', test: 'vendor' }] },
                manualChunks: (id) => (id.includes('vendor') ? 'manual' : null),
            },
        });
        expect(r.errors).toEqual([]);
        expect(r.chunks.some((c) => c.name === 'adv')).toBe(true);
        expect(r.chunks.some((c) => c.name === 'manual')).toBe(false);
        expect(r.warnings.some((w) => w.includes('manualChunks is ignored'))).toBe(true);
    });
});

describe('output.manualChunks', () => {
    it('fn form still works (regression) and does not pull deps into the chunk', async () => {
        const r = await bundle({
            input: { app: '/app.ts' },
            fs: createMemoryFs({
                '/app.ts': "import { v } from './vendor';\nexport const y = v;",
                '/vendor.ts': "import { u } from './util';\nexport const v = u + 1;",
                '/util.ts': 'export const u = 1;',
            }),
            external: [],
            output: { manualChunks: (id) => (id.includes('vendor') ? 'vendor' : null) },
        });
        expect(r.errors).toEqual([]);
        const vendor = r.chunks.find((c) => c.name === 'vendor')!;
        // fn form: only the named module lands in the chunk (deps NOT pulled in).
        expect(vendor.moduleIds).toEqual(['/vendor.ts']);
    });

    it('object form { name: [ids] } lands listed modules plus their deps in the chunk', async () => {
        const r = await bundle({
            input: { app: '/app.ts' },
            fs: createMemoryFs({
                '/app.ts': "import { v } from './vendor';\nexport const y = v;",
                '/vendor.ts': "import { u } from './util';\nexport const v = u + 1;",
                '/util.ts': 'export const u = 1;',
            }),
            external: [],
            output: { manualChunks: { vendor: ['/vendor.ts'] } },
        });
        expect(r.errors).toEqual([]);
        const vendor = r.chunks.find((c) => c.name === 'vendor')!;
        expect(vendor).toBeDefined();
        // object form pulls deps recursively → util lands in the same chunk.
        expect(vendor.moduleIds.slice().sort()).toEqual(['/util.ts', '/vendor.ts']);
        const app = r.chunks.find((c) => c.name === 'app')!;
        expect(app.moduleIds).toEqual(['/app.ts']);
    });
});
