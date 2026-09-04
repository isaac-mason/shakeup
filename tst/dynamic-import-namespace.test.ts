import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';

// `import(m)` must resolve to M's module namespace — exactly the names `m` exports — whatever chunk
// `m` was placed in. The chunk is a packaging decision; the namespace is a language guarantee.
//
// shakeup rewrites a dynamic import to the PATH OF THE CHUNK holding the target, so when that chunk
// also holds other modules whose bindings other chunks need, the chunk exports more than the module
// does and those extra names show up in the namespace. Two ways in, both exercised here:
//
//   1. `optimizeColors` merges a module into a dynamic entry's chunk when it is provably already
//      loaded (rolldown does the same — `dynamic_already_loaded.rs`), and the merged module's
//      exports then have to be re-exported for the OTHER dynamic chunk that needs them.
//   2. A dynamic entry landing in a chunk a STATIC entry already owns, where the leak is the whole
//      static surface.
//
// The fix is Rollup's, and shakeup already had the mechanism for static entries: a facade chunk that
// re-exports only the entry module's own surface. It is now minted for dynamic entries too, in
// `wireAndDeconflict` — after the entry-map loop, because a re-export is wired BY that loop and the
// leak does not exist yet when it starts.
const build = async (files: Record<string, string>, entry: string) => {
    const fs = { read: (id: string) => files[id] ?? null, exists: (id: string) => id in files };
    const r = await bundle({ entry, fs, external: [], output: {} });
    expect(r.errors).toEqual([]);
    return r;
};

/** The export names a chunk presents, read off its `export { … }` clauses. */
const exportNames = (code: string): string[] => {
    const names = new Set<string>();
    for (const m of code.matchAll(/^export \{([^}]*)\};?$/gm))
        for (const part of m[1].split(',')) names.add((part.includes(' as ') ? part.split(' as ')[1] : part).trim());
    return [...names].filter((n) => n !== '').sort();
};

describe('a dynamic import yields the MODULE’s namespace, not its chunk’s', () => {
    it('does not leak a module merged into the dynamic entry’s chunk', async () => {
        // `sharedDynamic` is reachable from both dynamic entries, so it may be merged into `dyn1`'s
        // chunk — but `dyn2` still needs it, so that chunk must re-export it. `dyn1` itself does not.
        const r = await build(
            {
                '/shared.js': 'export const shared = true;',
                '/sharedDynamic.js': 'export const sharedDynamic = true;',
                '/dyn2.js': "export { sharedDynamic } from './sharedDynamic.js';",
                '/dyn1.js':
                    "import { sharedDynamic } from './sharedDynamic.js';\n" +
                    'export const used = sharedDynamic;\n' +
                    "export const p = import('./dyn2.js');\n" +
                    "export { shared } from './shared.js';",
                '/main.js': "import { shared } from './shared.js';\nexport const p = import('./dyn1.js');\nexport { shared };",
            },
            '/main.js',
        );
        // Find the chunk `main` dynamically imports, and read what it exports.
        const main = r.chunks.find((c) => c.isEntry)!;
        const target = /import\('\.\/([^']+)'\)/.exec(main.code)?.[1];
        expect(target, 'main should dynamically import a chunk').toBeDefined();
        const dyn1Chunk = r.chunks.find((c) => c.fileName === target)!;
        expect(exportNames(dyn1Chunk.code)).toEqual(['p', 'shared', 'used']);
    });

    it('does not leak a static entry’s surface when a dynamic entry lands in its chunk', async () => {
        const r = await build(
            {
                '/dep.js': 'export const a = 1;\nexport const b = 2;',
                '/lazy.js': "export { a } from './dep.js';",
                '/main.js':
                    "import { a, b } from './dep.js';\n" +
                    'export const both = a + b;\n' +
                    "export const p = import('./lazy.js');",
            },
            '/main.js',
        );
        const main = r.chunks.find((c) => c.isEntry)!;
        const target = /import\('\.\/([^']+)'\)/.exec(main.code)?.[1];
        if (target === undefined) return; // inlined into the entry — nothing to leak
        const lazyChunk = r.chunks.find((c) => c.fileName === target)!;
        expect(exportNames(lazyChunk.code)).toEqual(['a']);
    });
});
