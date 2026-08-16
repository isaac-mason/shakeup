import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import type { Graph } from '../src/module-graph.ts';

/** The ImportRecord for `specifier` on module `id` (or undefined). */
const recordOf = (graph: Graph, id: string, specifier: string) => {
    const idx = graph.byId.get(id);
    if (idx === undefined) return undefined;
    return graph.modules[idx].importRecords.find((r) => r.specifier === specifier);
};

describe('bundle: dynamic import() edges', () => {
    it('follows a dynamic edge, records it, and bundles the target', () => {
        const result = bundle({
            input: '/main.ts',
            fs: createMemoryFs({
                '/main.ts': "export const load = () => import('./lazy');",
                '/lazy.ts': "export const secret = 'lazy-payload';",
            }),
            external: [],
        });
        expect(result.errors).toEqual([]);
        // Target loaded into the graph.
        expect(result.graph!.byId.has('/lazy.ts')).toBe(true);
        // The edge is recorded as dynamic.
        const rec = recordOf(result.graph!, '/main.ts', './lazy');
        expect(rec).toBeDefined();
        expect(rec!.dynamic).toBe(true);
        // R3: the dynamic target becomes its OWN chunk; main is the entry chunk.
        expect(result.chunks).toHaveLength(2);
        const entryChunk = result.chunks.find((c) => c.isEntry)!;
        const lazyChunk = result.chunks.find((c) => c.isDynamicEntry)!;
        expect(entryChunk.moduleIds).toContain('/main.ts');
        expect(lazyChunk.moduleIds).toContain('/lazy.ts');
        expect(lazyChunk.code).toContain('lazy-payload');
        // The import() specifier is rewritten to the target chunk's logical path.
        expect(entryChunk.code).toMatch(/import\('\.\/lazy\.js'\)/);
        expect(entryChunk.code).not.toContain("import('./lazy')");
        // The lazy chunk exports its surface for the dynamic import.
        expect(lazyChunk.exports).toContain('secret');
    });

    it('tree-shakes a dynamic target as a whole-namespace root (both exports kept)', () => {
        const result = bundle({
            input: '/main.ts',
            fs: createMemoryFs({
                '/main.ts': "export const load = () => import('./lazy');",
                '/lazy.ts': ["export const used = 'USED_MARKER';", "export const unused = 'UNUSED_MARKER';"].join('\n'),
            }),
            external: [],
        });
        expect(result.errors).toEqual([]);
        // Dynamic import = whole-namespace root, so BOTH survive. Finer per-export dynamic
        // shaking is future work. R3: they live in the lazy chunk (its own chunk).
        const allCode = result.chunks.map((c) => c.code).join('\n');
        expect(allCode).toContain('USED_MARKER');
        expect(allCode).toContain('UNUSED_MARKER');
    });

    it('leaves non-literal import() as a runtime import with no edge', () => {
        const result = bundle({
            input: '/main.ts',
            fs: createMemoryFs({
                '/main.ts': [
                    'export const f = (p: string) => import(p);',
                    "export const g = (y: string) => import('./x' + y);",
                ].join('\n'),
            }),
            external: [],
        });
        expect(result.errors).toEqual([]);
        const mod = result.graph!.modules[result.graph!.byId.get('/main.ts')!];
        // No ImportRecord created for either non-literal import().
        expect(mod.importRecords).toHaveLength(0);
        // The literal import( text survives verbatim in the emit.
        expect(result.code).toContain('import(p)');
        expect(result.code).toContain("import('./x' + y)");
    });

    it('static + dynamic same specifier ⇒ one record, static dominates', () => {
        const result = bundle({
            input: '/main.ts',
            fs: createMemoryFs({
                '/main.ts': [
                    "import { x } from './dup';",
                    "export const load = () => import('./dup');",
                    'export const y = x;',
                ].join('\n'),
                '/dup.ts': 'export const x = 1;',
            }),
            external: [],
        });
        expect(result.errors).toEqual([]);
        const mod = result.graph!.modules[result.graph!.byId.get('/main.ts')!];
        const dupRecs = mod.importRecords.filter((r) => r.specifier === './dup');
        expect(dupRecs).toHaveLength(1);
        expect(dupRecs[0].dynamic).toBe(false);
        // Static edge ⇒ sync-ordered: /dup.ts before /main.ts in exec order.
        const order = result.linked!.order.map((i) => result.graph!.modules[i].id);
        expect(order.indexOf('/dup.ts')).toBeLessThan(order.indexOf('/main.ts'));
    });

    it('terminates on a cycle through a dynamic edge', () => {
        const result = bundle({
            input: '/a.ts',
            fs: createMemoryFs({
                '/a.ts': ['export const a = 1;', "export const load = () => import('./b');"].join('\n'),
                '/b.ts': ["import { a } from './a';", 'export const b = a + 1;'].join('\n'),
            }),
            external: [],
        });
        expect(result.errors).toEqual([]);
        // Both modules load exactly once; sortModules terminates.
        expect(result.graph!.byId.has('/a.ts')).toBe(true);
        expect(result.graph!.byId.has('/b.ts')).toBe(true);
        const order = result.linked!.order.map((i) => result.graph!.modules[i].id);
        expect(order.filter((id) => id === '/a.ts')).toHaveLength(1);
        expect(order.filter((id) => id === '/b.ts')).toHaveLength(1);
    });
});

describe('bundle: multi-entry input', () => {
    it('produces named entries with a shared module included once', async () => {
        const result = bundle({
            input: { main: '/main.ts', admin: '/admin.ts' },
            fs: createMemoryFs({
                '/main.ts': ["import { util } from './shared';", 'export const m = util() + 1;'].join('\n'),
                '/admin.ts': ["import { util } from './shared';", 'export const admin = util() + 2;'].join('\n'),
                '/shared.ts': 'export const util = (): number => 10;',
            }),
            external: [],
        });
        expect(result.errors).toEqual([]);
        // Two named entries pointing at the right modules.
        expect(result.graph!.entries).toHaveLength(2);
        const names = result.graph!.entries.map((e) => e.name);
        expect(names).toEqual(['main', 'admin']);
        // R3: three chunks — main, admin, and a shared chunk holding /shared.ts once.
        expect(result.chunks).toHaveLength(3);
        const main = result.chunks.find((c) => c.name === 'main')!;
        const admin = result.chunks.find((c) => c.name === 'admin')!;
        const shared = result.chunks.find((c) => c.moduleIds.includes('/shared.ts'))!;
        expect(main.isEntry).toBe(true);
        expect(admin.isEntry).toBe(true);
        expect(shared.isEntry).toBe(false);
        expect(shared.moduleIds).toEqual(['/shared.ts']);
        // /shared.ts appears in exactly one chunk.
        const owners = result.chunks.filter((c) => c.moduleIds.includes('/shared.ts'));
        expect(owners).toHaveLength(1);
        // Both entry chunks import the shared chunk (cross-chunk static import).
        expect(main.imports).toContain(shared.name);
        expect(admin.imports).toContain(shared.name);
        // The shared chunk exports `util`.
        expect(shared.exports).toContain('util');
        // Cross-chunk import lines reference the shared chunk's logical path.
        expect(main.code).toContain(`from './${shared.name}.js'`);
    });

    it('input: string[] derives distinct names and dedups repeats', () => {
        const two = bundle({
            input: ['/a.ts', '/b.ts'],
            fs: createMemoryFs({
                '/a.ts': 'export const a = 1;',
                '/b.ts': 'export const b = 2;',
            }),
            external: [],
        });
        expect(two.errors).toEqual([]);
        expect(two.graph!.entries.map((e) => e.name)).toEqual(['a', 'b']);

        const dup = bundle({
            input: ['/a.ts', '/a.ts'],
            fs: createMemoryFs({ '/a.ts': 'export const a = 1;' }),
            external: [],
        });
        expect(dup.errors).toEqual([]);
        // Same module twice collapses to one entry.
        expect(dup.graph!.entries).toHaveLength(1);
    });

    it('errors when neither input nor entry is set, and when both are set', () => {
        const fs = createMemoryFs({ '/main.ts': 'export const x = 1;' });
        const neither = bundle({ fs } as never);
        expect(neither.errors).toContain("exactly one of 'input' or 'entry' must be set");
        const both = bundle({ input: '/main.ts', entry: '/main.ts', fs } as never);
        expect(both.errors).toContain("exactly one of 'input' or 'entry' must be set");
    });
});

describe('bundle: back-compat + stubs', () => {
    it('the `entry` alias still works and code === chunks[0].code', () => {
        const result = bundle({
            entry: '/main.ts',
            fs: createMemoryFs({ '/main.ts': 'export const x = 1;' }),
            external: [],
        });
        expect(result.errors).toEqual([]);
        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0].code).toBe(result.code);
        expect(result.chunks[0].isEntry).toBe(true);
        expect(result.chunks[0].name).toBe('main');
        expect(result.chunks[0].moduleIds).toContain('/main.ts');
    });

    it('accepts preserveEntrySignatures without changing output', () => {
        const files = { '/main.ts': "import { v } from './d';\nexport const r = v;", '/d.ts': 'export const v = 5;' };
        const withOpt = bundle({
            input: '/main.ts',
            fs: createMemoryFs(files),
            external: [],
            preserveEntrySignatures: 'strict',
        });
        const without = bundle({ input: '/main.ts', fs: createMemoryFs(files), external: [] });
        expect(withOpt.errors).toEqual([]);
        expect(without.errors).toEqual([]);
        // Inert: byte-identical output.
        expect(withOpt.code).toBe(without.code);
    });
});
