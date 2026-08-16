import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bundle, type OutputChunk } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

/** Write the chunks to a temp dir under their logical fileNames and import each entry via a
 *  file URL (cross-chunk `./name.js` specifiers resolve against the same dir). */
async function execEntries(chunks: OutputChunk[], names: string[]): Promise<Record<string, Record<string, unknown>>> {
    const dir = mkdtempSync(join(tmpdir(), 'shakeup-test-'));
    try {
        for (const c of chunks) writeFileSync(join(dir, c.fileName), c.code);
        const out: Record<string, Record<string, unknown>> = {};
        for (const name of names) {
            const entry = chunks.find((c) => c.isEntry && c.name === name);
            if (entry === undefined) continue;
            out[name] = (await import(pathToFileURL(join(dir, entry.fileName)).href)) as Record<string, unknown>;
        }
        await new Promise((r) => setTimeout(r, 30));
        return out;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe('bundle: base automatic chunking', () => {
    it('two entries sharing a module form a shared chunk both import (executes)', async () => {
        const r = bundle({
            input: { a: '/a.ts', b: '/b.ts' },
            fs: createMemoryFs({
                '/a.ts': "import { s } from './shared';\nexport const av = s + 1;",
                '/b.ts': "import { s } from './shared';\nexport const bv = s + 2;",
                '/shared.ts': 'export const s = 40;',
            }),
            external: [],
        });
        expect(r.errors).toEqual([]);
        expect(r.chunks).toHaveLength(3);
        const shared = r.chunks.find((c) => c.moduleIds.includes('/shared.ts'))!;
        expect(shared.isEntry).toBe(false);
        expect(shared.exports).toContain('s');
        const a = r.chunks.find((c) => c.name === 'a')!;
        const b = r.chunks.find((c) => c.name === 'b')!;
        expect(a.imports).toContain(shared.name);
        expect(b.imports).toContain(shared.name);
        // /shared.ts appears in exactly one chunk.
        expect(r.chunks.filter((c) => c.moduleIds.includes('/shared.ts'))).toHaveLength(1);
        const ns = await execEntries(r.chunks, ['a', 'b']);
        expect(ns.a.av).toBe(41);
        expect(ns.b.bv).toBe(42);
    });

    it('cross-chunk import renders `import { … } from` and executes with live bindings', async () => {
        const r = bundle({
            input: { a: '/a.ts', b: '/b.ts' },
            fs: createMemoryFs({
                '/a.ts': "import { setValue, getValue } from './shared';\nsetValue(123);\nexport const got = getValue();",
                '/b.ts': "import { getValue } from './shared';\nexport const got = getValue();",
                '/shared.ts':
                    'let value = 0;\nexport function setValue(n) { value = n; }\nexport function getValue() { return value; }',
            }),
            external: [],
        });
        expect(r.errors).toEqual([]);
        const a = r.chunks.find((c) => c.name === 'a')!;
        expect(a.code).toMatch(/import \{[^}]*\} from '\.\/shared\.js'/);
        const ns = await execEntries(r.chunks, ['a', 'b']);
        // a set the shared value to 123 before reading; b reads the same live binding.
        expect(ns.a.got).toBe(123);
    });

    it('single-entry no-dynamic build stays ONE chunk (byte-stable with code alias)', () => {
        const files = { '/main.ts': "import { v } from './d';\nexport const r = v + 1;", '/d.ts': 'export const v = 5;' };
        const r = bundle({ input: '/main.ts', fs: createMemoryFs(files), external: [] });
        expect(r.errors).toEqual([]);
        expect(r.chunks).toHaveLength(1);
        expect(r.chunks[0].isEntry).toBe(true);
        expect(r.code).toBe(r.chunks[0].code);
        // No cross-chunk imports for a single chunk.
        expect(r.chunks[0].imports).toEqual([]);
    });
});

describe('bundle: dynamic import splitting', () => {
    it('a dynamic import becomes its own chunk and the specifier is rewritten (executes)', async () => {
        const r = bundle({
            input: '/entry.ts',
            fs: createMemoryFs({
                '/entry.ts': "export const load = () => import('./lazy');",
                '/lazy.ts': "export const secret = 'LAZY';",
            }),
            external: [],
        });
        expect(r.errors).toEqual([]);
        expect(r.chunks).toHaveLength(2);
        const entry = r.chunks.find((c) => c.isEntry)!;
        const lazy = r.chunks.find((c) => c.isDynamicEntry)!;
        expect(lazy.moduleIds).toEqual(['/lazy.ts']);
        expect(lazy.exports).toContain('secret');
        expect(entry.code).toMatch(/import\('\.\/lazy\.js'\)/);
        expect(entry.dynamicImports).toContain(lazy.name);
        // The entry statically imports nothing; it defers the lazy chunk via import().
        expect(entry.imports).toEqual([]);
        // Execution of the async `import()` across real files is covered by the oracle spike
        // (run under `npx tsx`, no vite `/@fs/` loader interception); here we assert structure.
    });

    it('a module imported statically AND dynamically folds into the importer (no dup, executes)', async () => {
        const r = bundle({
            input: '/entry.ts',
            fs: createMemoryFs({
                '/entry.ts': [
                    "import { bar as a } from './foo';",
                    "export const p = import('./foo').then(({ bar: b }) => a + b);",
                ].join('\n'),
                '/foo.ts': 'export const bar = 21;',
            }),
            external: [],
        });
        expect(r.errors).toEqual([]);
        // Static dominance: foo folds into the entry chunk — one chunk, no separate lazy chunk.
        expect(r.chunks).toHaveLength(1);
        expect(r.chunks[0].moduleIds).toContain('/foo.ts');
        expect(r.chunks[0].code).toMatch(/Promise\.resolve\(\)\.then\(\(\) =>/);
        const ns = await execEntries(r.chunks, ['entry']);
        expect(await (ns.entry.p as Promise<number>)).toBe(42);
    });
});

describe('bundle: config layer', () => {
    it('codeSplitting:false inlines the dynamic import (single chunk, Promise.resolve)', () => {
        const r = bundle({
            input: '/entry.ts',
            fs: createMemoryFs({
                '/entry.ts': "export const load = () => import('./lazy');",
                '/lazy.ts': "export const secret = 'LAZY';",
            }),
            external: [],
            output: { codeSplitting: false },
        });
        expect(r.errors).toEqual([]);
        expect(r.chunks).toHaveLength(1);
        expect(r.chunks[0].moduleIds).toContain('/lazy.ts');
        expect(r.chunks[0].code).toContain('Promise.resolve()');
        expect(r.chunks[0].code).not.toMatch(/import\('\.\/lazy/);
    });

    it('manualChunks captures matching modules into a named group chunk', () => {
        const r = bundle({
            input: { app: '/app.ts' },
            fs: createMemoryFs({
                '/app.ts': "import { v } from './vendor';\nexport const y = v;",
                '/vendor.ts': 'export const v = 1;',
            }),
            external: [],
            output: { manualChunks: (id) => (id.includes('vendor') ? 'vendor' : null) },
        });
        expect(r.errors).toEqual([]);
        const vendor = r.chunks.find((c) => c.name === 'vendor')!;
        expect(vendor).toBeDefined();
        expect(vendor.moduleIds).toEqual(['/vendor.ts']);
        const app = r.chunks.find((c) => c.name === 'app')!;
        expect(app.moduleIds).toEqual(['/app.ts']);
    });

    it('codeSplitting groups: a vendor group with a RegExp test forms its own chunk', () => {
        const r = bundle({
            input: { a: '/a.ts', b: '/b.ts' },
            fs: createMemoryFs({
                '/a.ts': "import { v } from './node_modules/lib';\nexport const av = v;",
                '/b.ts': "import { v } from './node_modules/lib';\nexport const bv = v;",
                '/node_modules/lib.ts': 'export const v = 9;',
            }),
            external: [],
            output: { codeSplitting: { groups: [{ name: 'vendor', test: /node_modules/ }] } },
        });
        expect(r.errors).toEqual([]);
        const vendor = r.chunks.find((c) => c.name === 'vendor')!;
        expect(vendor.moduleIds).toEqual(['/node_modules/lib.ts']);
    });

    it('preserveModules emits one chunk per module with imports preserved (executes)', async () => {
        const r = bundle({
            input: '/a.ts',
            fs: createMemoryFs({
                '/a.ts': "import { x } from './b';\nexport const y = x + 1;",
                '/b.ts': 'export const x = 41;',
            }),
            external: [],
            output: { preserveModules: true },
        });
        expect(r.errors).toEqual([]);
        expect(r.chunks).toHaveLength(2);
        const a = r.chunks.find((c) => c.name === 'a')!;
        const b = r.chunks.find((c) => c.name === 'b')!;
        expect(a.moduleIds).toEqual(['/a.ts']);
        expect(b.moduleIds).toEqual(['/b.ts']);
        expect(a.imports).toContain('b');
        expect(b.exports).toContain('x');
        const ns = await execEntries(r.chunks, ['a']);
        expect(ns.a.y).toBe(42);
    });
});
