import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import { runChunks } from './exec-helpers.ts';
import type { Platform } from '../src/resolve.ts';

// cjs.md D5 / Track 5 — the CommonJS runtime helpers used to be inlined into EVERY chunk that needed
// them. Measured on a code-split CommonJS build: six identical copies of the helper set across seven
// chunks, 9101 bytes of output of which 7650 were duplicated helpers. With a shared runtime chunk the
// same build is 3812 bytes.
//
// rolldown reaches this by making the runtime a real module in the graph
// (`runtime_module_task.rs`), which additionally lets it be tree-shaken and renamed per chunk;
// shakeup keeps the helpers as text, since the DUPLICATION was the cost rather than the
// representation. The output shape matches either way — rolldown's `cjs_compat/dynamic_cjs_entry`
// ships `rolldown-runtime.js` and its consumers import from it.
const TWO_CONSUMERS = {
    '/a.cjs': 'module.exports = 1;',
    '/b.cjs': 'module.exports = 2;',
    '/main.js': "export const x = Promise.all([import('./a.cjs'), import('./b.cjs')]).then((a) => a.map((m) => m.default));",
};

const build = async (files: Record<string, string>, opts: Record<string, unknown> = {}) => {
    const r = await bundle({ entry: '/main.js', external: [], fs: createMemoryFs(files), ...opts });
    expect(r.errors).toEqual([]);
    return r;
};

const run = async (files: Record<string, string>, opts: Record<string, unknown> = {}) => {
    const r = await build(files, opts);
    const { ns, dispose } = await runChunks(r.chunks, r.chunks.find((c) => c.isEntry)!.fileName);
    try {
        return { value: await (ns.x as unknown), chunks: r.chunks };
    } finally {
        dispose();
    }
};

const helperCopies = (chunks: { code: string }[], name: string) => chunks.reduce((n, c) => n + (c.code.match(new RegExp(`var ${name} =`, 'g')) ?? []).length, 0);

describe('the shared runtime chunk', () => {
    it('defines each helper once and every consumer imports it', async () => {
        const { value, chunks } = await run(TWO_CONSUMERS);
        expect(value).toEqual([1, 2]);
        expect(chunks.filter((c) => c.fileName.includes('runtime'))).toHaveLength(1);
        expect(helperCopies(chunks, '__toESM')).toBe(1);
        expect(helperCopies(chunks, '__commonJS')).toBe(1);
        const consumer = chunks.find((c) => c.code.includes('require_a'))!;
        expect(consumer.code).toMatch(/import \{[^}]*__commonJS[^}]*\} from '\.\/runtime[^']*\.js';/);
    });

    it('is NOT minted for a single consumer', async () => {
        // One consumer would pay an import statement and a second file to save one helper set. The
        // single-chunk path has to stay byte-identical to what it was.
        const { value, chunks } = await run({ '/c.cjs': 'module.exports = { k: 7 };', '/main.js': "import c from './c.cjs';\nexport const x = c.k;" });
        expect(value).toBe(7);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].code).toContain('var __toESM =');
    });

    it('is not minted for a bundle with no CommonJS at all', async () => {
        const { chunks } = await run({ '/a.js': 'export const a = 1;', '/main.js': "export const x = import('./a.js').then((m) => m.a);" });
        expect(chunks.some((c) => c.fileName.includes('runtime'))).toBe(false);
    });

    it('survives hashed filenames', async () => {
        const { value, chunks } = await run(TWO_CONSUMERS, { output: { entryFileNames: '[name]-[hash].js', chunkFileNames: '[name]-[hash].js' } });
        expect(value).toEqual([1, 2]);
        expect(chunks.some((c) => /runtime-[A-Za-z0-9_-]+\.js/.test(c.fileName))).toBe(true);
    });

    it('survives minification and sourcemaps', async () => {
        expect((await run(TWO_CONSUMERS, { output: { minify: true } })).value).toEqual([1, 2]);
        expect((await run(TWO_CONSUMERS, { output: { sourcemap: true } })).value).toEqual([1, 2]);
    });

    it('carries the node `createRequire` shim and its import', async () => {
        // The `__require` shim's node form needs an accompanying `import { createRequire }`, which
        // has to travel into the runtime chunk with it.
        const { value, chunks } = await run(
            {
                '/a.cjs': 'module.exports = typeof require;',
                '/b.cjs': 'module.exports = typeof require.resolve;',
                '/main.js': "export const x = Promise.all([import('./a.cjs'), import('./b.cjs')]).then((a) => a.map((m) => m.default));",
            },
            { platform: 'node' as Platform },
        );
        expect(value).toEqual(['function', 'function']);
        const rt = chunks.find((c) => c.fileName.includes('runtime'))!;
        expect(rt.code).toContain("import { createRequire } from 'node:module';");
    });

    it('serves mode-2 namespaces across chunks', async () => {
        const { value } = await run(
            { '/d.cjs': 'module.exports = { a: 1, b: 2 };', '/b.js': "export * from './d.cjs';", '/main.js': "import * as ns from './b.js';\nexport const x = [ns.a, ns.b];" },
            { output: { preserveModules: true } },
        );
        expect(value).toEqual([1, 2]);
    });

    it('each consumer imports only the helpers it uses', async () => {
        // The union lives in the runtime chunk; a consumer that only needs `__commonJS` must not
        // import `__exportAll` as well.
        const { chunks } = await run(TWO_CONSUMERS);
        const consumer = chunks.find((c) => c.code.includes('require_a'))!;
        expect(consumer.code).not.toContain('__exportAll');
    });
});
