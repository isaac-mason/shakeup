import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import { runChunks } from './exec-helpers.ts';

// Track 4 — CommonJS ENTRY points, checked against the three rolldown fixtures that cover them,
// each read first-hand rather than relayed:
//   · `cjs_compat/cjs_entry`               → `export default require_main();`
//   · `cjs_compat/dynamic_cjs_entry`       → a CJS module reached as a DYNAMIC entry
//   · `misc/cjs_entry_as_dependency`       → two entries, one requiring the other
//   · `cjs_compat/multiple_circle_cjs_entries` → two entries that import each other
//
// Every assertion executes the built chunks from disk and compares VALUES, mirroring the `_test.mjs`
// each fixture ships.
const build = async (files: Record<string, string>, entry: string | string[]) => {
    const r = await bundle({ input: entry, external: [], fs: createMemoryFs(files) });
    expect(r.errors).toEqual([]);
    return r;
};

const importChunk = async (r: { chunks: { fileName: string; code: string }[] }, fileName: string) => {
    const { ns, dispose } = await runChunks(r.chunks, fileName);
    try {
        return await (ns.default as unknown);
    } finally {
        dispose();
    }
};

describe('CommonJS entry points', () => {
    it('a CommonJS entry exports its module.exports as default', async () => {
        // `cjs_entry`'s own assertion: `assert.equal(main, 'main')`.
        const r = await build({ '/main.js': "module.exports = 'main';" }, '/main.js');
        expect(r.code).toContain('export default require_main();');
        expect(await importChunk(r, 'main.js')).toBe('main');
    });

    it('a CommonJS module reached as a DYNAMIC entry resolves', async () => {
        const r = await build(
            { '/cjs.js': "module.exports = 'cjs';", '/main.js': "export default import('./cjs.js');" },
            '/main.js',
        );
        const { ns, dispose } = await runChunks(r.chunks, 'main.js');
        try {
            expect(((await ns.default) as { default: unknown }).default).toBe('cjs');
        } finally {
            dispose();
        }
    });

    it('two CommonJS entries, one requiring the other, share one instance', async () => {
        // `cjs_entry_as_dependency` asserts `main === main2` — the same object, not a copy — by
        // importing both entry files. That exact check CANNOT be written here: vitest's module
        // runner evaluates a chunk once per top-level `import()` of it, so importing `main2.js`
        // after `main.js` (which imports it transitively) yields a SECOND instance. Measured, not
        // assumed: a counter in `main2.js` reads 2 under vitest and 1 under plain Node.
        //
        // So identity is asserted from INSIDE a single import instead — the static import and the
        // `require` of the same module must land on one wrapper — plus the emitted shape, which is
        // what actually guarantees it: `main.js` imports the binding rather than redefining it.
        const r = await build(
            {
                '/main.js': [
                    "import main2 from './main2.js';",
                    "const again = require('./main2.js');",
                    'module.exports = { same: main2 === again, n: main2.n };',
                ].join('\n'),
                '/main2.js': [
                    'globalThis.__cjsEntryN = (globalThis.__cjsEntryN ?? 0) + 1;',
                    'module.exports = { n: globalThis.__cjsEntryN };',
                ].join('\n'),
            },
            ['/main.js', '/main2.js'],
        );
        const main2Chunk = r.chunks.find((c) => c.fileName === 'main2.js')!;
        const mainChunk = r.chunks.find((c) => c.fileName === 'main.js')!;
        expect(main2Chunk.code).toContain('var require_main2 =');
        expect(mainChunk.code).not.toContain('var require_main2 =');
        expect(mainChunk.code).toMatch(/import \{[^}]*\} from '\.\/main2\.js';/);
        expect(await importChunk(r, 'main.js')).toMatchObject({ same: true });
    });
});

// Found by probing `multiple_circle_cjs_entries`, and NOT specific to CommonJS: any two entries that
// import each other share a color, and the chunk keyed on that color was claimed by whichever came
// first. The second entry's output FILE was never emitted — no error, no warning, just N-1 files for
// N entries, and a missing-module failure for anyone importing it.
//
// The second entry now gets a facade: an entry chunk with no modules of its own that re-exports its
// entry module's surface from the chunk that holds it. rolldown emits exactly this.
describe('two entries in an import cycle each get an output file', () => {
    it('CommonJS — the facade imports the wrapper and calls it', async () => {
        const r = await build(
            { '/a.js': "import './b.js';\nmodule.exports = 'a';", '/b.js': "import './a.js';\nmodule.exports = 'b';" },
            ['/a.js', '/b.js'],
        );
        expect(r.chunks.map((c) => c.fileName).sort()).toEqual(['a.js', 'b.js']);
        expect(r.chunks.find((c) => c.fileName === 'b.js')!.code).toMatch(/import \{ require_b \} from '\.\/a\.js';/);
        expect(await importChunk(r, 'a.js')).toBe('a');
        expect(await importChunk(r, 'b.js')).toBe('b');
    });

    it('ES modules — same collapse, same fix', async () => {
        const r = await build(
            { '/a.js': "import './b.js';\nexport const a = 1;", '/b.js': "import './a.js';\nexport const b = 2;" },
            ['/a.js', '/b.js'],
        );
        expect(r.chunks.map((c) => c.fileName).sort()).toEqual(['a.js', 'b.js']);
        const { ns, dispose } = await runChunks(r.chunks, 'b.js');
        try {
            expect(ns.b).toBe(2);
        } finally {
            dispose();
        }
    });

    it('non-cyclic entries are unaffected', async () => {
        // Guard: the facade must only appear when two static entries genuinely share a chunk.
        const r = await build(
            { '/a.js': "import { b } from './b.js';\nexport const a = b + 1;", '/b.js': 'export const b = 2;' },
            ['/a.js', '/b.js'],
        );
        expect(r.chunks.map((c) => c.fileName).sort()).toEqual(['a.js', 'b.js']);
        expect(r.chunks.every((c) => c.code.trim() !== '')).toBe(true);
    });
});
