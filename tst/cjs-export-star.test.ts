import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import { runChunks } from './exec-helpers.ts';

// cjs.md §7.4 / Track 6 — `export * from '<commonjs>'`, namespace construction MODE 2 of §4.4.
// Previously a loud build error ("not supported yet"). A CommonJS module's export surface is only
// known at runtime, so the re-exporter's namespace becomes an `__exportAll` object of getter thunks
// for the names it DOES know, extended by `__reExport` with the CommonJS members:
//
//     var b_exports = /* @__PURE__ */ __exportAll({ own: () => own });
//     __reExport(b_exports, /* @__PURE__ */ __toESM(require_d()));
//
// which is rolldown's `cjs_compat/reexport_commonjs` and `exoprt_star_of_cjs` verbatim. A NAMED
// import through the star is answered separately, as a member read on the CommonJS interop namespace
// — esbuild's `importDynamicFallback`, "rewrite the import to a property access"
// (`linker.go:2704-2718`).
//
// Everything here EXECUTES: mode 2 is entirely about what exists at runtime, so a text assertion
// would prove nothing.
const D = { '/d.cjs': 'module.exports = { a: 1, b: 2 };' };

const run = async (files: Record<string, string>, output: Record<string, unknown> = {}) => {
    const r = await bundle({ entry: '/main.js', external: [], output, fs: createMemoryFs(files) });
    expect(r.errors).toEqual([]);
    const { ns, dispose } = await runChunks(r.chunks, r.chunks.find((c) => c.isEntry)!.fileName);
    try {
        return { value: await (ns.x as unknown), chunks: r.chunks };
    } finally {
        dispose();
    }
};

describe('export * from a CommonJS module', () => {
    it('forwards a named import through the star', async () => {
        const { value } = await run({
            ...D,
            '/b.js': "export * from './d.cjs';",
            '/main.js': "import { a, b } from './b.js';\nexport const x = [a, b];",
        });
        expect(value).toEqual([1, 2]);
    });

    it('builds a namespace that carries the runtime names', async () => {
        const { value } = await run({
            ...D,
            '/b.js': "export * from './d.cjs';",
            '/main.js': "import * as ns from './b.js';\nexport const x = [ns.a, ns.b, Object.prototype.toString.call(ns)];",
        });
        expect(value).toEqual([1, 2, '[object Module]']);
    });

    it('merges the star with the re-exporter’s own exports', async () => {
        const { value } = await run({
            ...D,
            '/b.js': "export * from './d.cjs';\nexport const own = 9;",
            '/main.js': "import * as ns from './b.js';\nexport const x = [ns.a, ns.own, Object.keys(ns).sort()];",
        });
        expect(value).toEqual([1, 9, ['a', 'b', 'own']]);
    });

    it('does NOT forward `default`', async () => {
        // `__reExport` passes `'default'` as `__copyProps`'s `except` key, and the star loop refuses
        // the name outright. True of every bundler and of Node.
        const { value } = await run({
            '/d.cjs': "module.exports = { a: 1, default: 'NO' };",
            '/b.js': "export * from './d.cjs';",
            '/main.js': "import * as ns from './b.js';\nexport const x = [ns.a, ns.default ?? null];",
        });
        expect(value).toEqual([1, null]);
    });

    it('an own export shadows the CommonJS one', async () => {
        // `__copyProps` skips a key the target already owns, so the statically-known name wins —
        // which is also the order `matchImport` uses, trying every ESM star source before the
        // CommonJS fallback.
        const { value } = await run({
            '/d.cjs': "module.exports = { a: 'CJS' };",
            '/b.js': "export * from './d.cjs';\nexport const a = 'OWN';",
            '/main.js': "import * as ns from './b.js';\nexport const x = ns.a;",
        });
        expect(value).toBe('OWN');
    });

    it('chains through two star hops', async () => {
        // The outer module does not star from CommonJS directly, so it is only mode-2 by
        // PROPAGATION — and its `__reExport` copies from the inner mode-2 object rather than from a
        // wrapper. rolldown's `exoprt_star_of_cjs` is this exact chain. Without the fixed-point pass
        // the outer namespace was a static literal and every member read `undefined`.
        const { value } = await run({
            ...D,
            '/c.js': "export * from './d.cjs';",
            '/b.js': "export * from './c.js';",
            '/main.js': "import * as ns from './b.js';\nexport const x = [ns.a, ns.b];",
        });
        expect(value).toEqual([1, 2]);
    });
});

// Mode 2 × chunking — the product that had no coverage, and where both halves were broken.
describe('export * from CommonJS across chunk boundaries', () => {
    it('preserveModules — the producer imports the wrapper it names', async () => {
        // The `__reExport` line names `require_d`, which is not a named import, so nothing carried it
        // across and the producer chunk called an undeclared binding.
        const { value } = await run(
            {
                ...D,
                '/b.js': "export * from './d.cjs';",
                '/main.js': "import * as ns from './b.js';\nexport const x = [ns.a, ns.b];",
            },
            { preserveModules: true },
        );
        expect(value).toEqual([1, 2]);
    });

    it('a dynamically imported mode-2 module resolves its members', async () => {
        // Its names cannot be chunk exports — half of them only exist after `__reExport` runs — so
        // the chunk exports the OBJECT and the import site unwraps it. Before this the target chunk
        // exported nothing at all and every member was `undefined`, with no error.
        const { value, chunks } = await run({
            ...D,
            '/b.js': "export * from './d.cjs';",
            '/main.js': "export const x = import('./b.js').then((m) => [m.a, m.b]);",
        });
        expect(chunks.length).toBeGreaterThan(1);
        expect(value).toEqual([1, 2]);
    });
});
