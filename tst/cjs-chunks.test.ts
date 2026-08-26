import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import { runChunks } from './exec-helpers.ts';

// KNOWN GAP — CommonJS is single-chunk only. `cjsWrap`/`cjsNamespace` mint chunk-local NAMES that
// never reach the cross-chunk wiring, so a consumer chunk emits `import_d.default` with no import
// for `import_d` and the reference dangles at load.
//
// This intersection had NO coverage of any kind, which is exactly why it went unnoticed: the
// splitting tests execute their output but never see a `require`, and the 75 CommonJS tests see
// plenty of `require` but never a second chunk. Both axes looked well covered; their product was
// empty.
//
// The `it.fails` cases assert the CORRECT behaviour and therefore fail today; they are marked so the
// suite stays green while the gap is open. Fixing it turns them red — flip to plain `it` then.
//
// Assertions EXECUTE the built output from disk, following rolldown's own harness (358 `_test.mjs`
// fixtures import `./dist/main.js` and assert on values). A text assertion cannot see a dangling
// reference — `import_d.default` is a perfectly plausible-looking string.
const build = async (files: Record<string, string>, entry = '/main.js', output: Record<string, unknown> = {}) => {
    const r = await bundle({ entry, fs: createMemoryFs(files), external: [], output });
    expect(r.errors).toEqual([]);
    return r;
};

/** Build, run from disk, return the entry's exports (awaiting a promise-valued `x`). */
const buildAndRun = async (files: Record<string, string>, entry = '/main.js', output: Record<string, unknown> = {}) => {
    const r = await build(files, entry, output);
    const entryChunk = r.chunks.find((c) => c.isEntry)!;
    const { ns, dispose } = await runChunks(r.chunks, entryChunk.fileName);
    try {
        return await (ns.x as unknown);
    } finally {
        dispose();
    }
};

describe('CommonJS across chunk boundaries', () => {
    it.fails('D13 — a dynamically imported CommonJS module resolves', async () => {
        expect(
            await buildAndRun({
                '/c.cjs': 'module.exports = { k: 7 };',
                '/main.js': "export const x = import('./c.cjs').then((m) => m.default.k);",
            }),
        ).toBe(7);
    });

    it.fails('D14 — a CommonJS module shared by two dynamic entries', async () => {
        // Fails with `import_s is not defined`: the namespace binding is minted in the shared
        // chunk but never exported from it, so neither consumer can name it.
        expect(
            await buildAndRun({
                '/s.cjs': 'module.exports = { k: 7 };',
                '/a.js': "import s from './s.cjs';\nexport const a = s.k;",
                '/b.js': "import s from './s.cjs';\nexport const b = s.k;",
                '/main.js': "export const x = Promise.all([import('./a.js'), import('./b.js')]).then(([p, q]) => p.a + q.b);",
            }),
        ).toBe(14);
    });

    it.fails('D15 — CommonJS requiring CommonJS across a chunk boundary', async () => {
        expect(
            await buildAndRun({
                '/i.cjs': 'module.exports = 3;',
                '/d.cjs': "module.exports = require('./i.cjs') * 2;",
                '/main.js': "export const x = import('./d.cjs').then((m) => m.default);",
            }),
        ).toBe(6);
    });

    it.fails('D16 — preserveModules with a CommonJS dependency', async () => {
        // The library case the native-namespace work was built for. Every module is its own chunk,
        // so a CommonJS dep ALWAYS crosses a boundary here.
        expect(
            await buildAndRun({ '/d.cjs': 'module.exports = { k: 7 };', '/main.js': "import d from './d.cjs';\nexport const x = d.k;" }, '/main.js', {
                preserveModules: true,
            }),
        ).toBe(7);
    });

    it('a CommonJS module reached from two static entries lands in a shared chunk', async () => {
        // Assumed broken when this file was written; it is not. Static-entry sharing already works,
        // which narrows D13-D16 to the DYNAMIC / preserveModules paths.
        const r = await build(
            {
                '/s.cjs': 'module.exports = { k: 5 };',
                '/a.js': "import s from './s.cjs';\nexport const x = s.k + 1;",
                '/b.js': "import s from './s.cjs';\nexport const x = s.k + 2;",
                '/main.js': "export * from './a.js';",
            },
            '/main.js',
        );
        const { ns, dispose } = await runChunks(r.chunks, r.chunks.find((c) => c.isEntry)!.fileName);
        try {
            expect(ns.x).toBe(6);
        } finally {
            dispose();
        }
    });

    // ── already correct: guards the single-chunk behaviour these must not regress ──

    it('single-chunk CommonJS still resolves', async () => {
        expect(await buildAndRun({ '/d.cjs': 'module.exports = { k: 7 };', '/main.js': "import d from './d.cjs';\nexport const x = d.k;" })).toBe(7);
    });

    it('a dynamically imported ES module still resolves across chunks', async () => {
        // Proof the failure is about CommonJS, not about dynamic import or chunking generally.
        expect(await buildAndRun({ '/e.js': 'export const k = 7;', '/main.js': "export const x = import('./e.js').then((m) => m.k);" })).toBe(7);
    });
});
