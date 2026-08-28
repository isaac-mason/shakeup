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
// FIXED. The wrapper and its interop namespace are now real SYMBOL REFS rather than chunk-local
// names, so they travel the ordinary cross-chunk machinery — the shape rolldown uses, where the
// wrapper is a `SymbolRef` pushed into `depended_symbols` (`compute_cross_chunk_links.rs:659`).
// A `require` edge is wired explicitly, since it is not a named import and nothing else would.
// And a chunk whose ENTRY is CommonJS now emits `export default require_main();` — without it a
// dynamically imported CommonJS module resolved to an empty namespace.
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
    it('D13 — a dynamically imported CommonJS module resolves', async () => {
        expect(
            await buildAndRun({
                '/c.cjs': 'module.exports = { k: 7 };',
                '/main.js': "export const x = import('./c.cjs').then((m) => m.default.k);",
            }),
        ).toBe(7);
    });

    it('D14 — a CommonJS module shared by two dynamic entries', async () => {
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

    it('D15 — CommonJS requiring CommonJS across a chunk boundary', async () => {
        expect(
            await buildAndRun({
                '/i.cjs': 'module.exports = 3;',
                '/d.cjs': "module.exports = require('./i.cjs') * 2;",
                '/main.js': "export const x = import('./d.cjs').then((m) => m.default);",
            }),
        ).toBe(6);
    });

    it('D16 — preserveModules with a CommonJS dependency', async () => {
        // The library case the native-namespace work was built for. Every module is its own chunk,
        // so a CommonJS dep ALWAYS crosses a boundary here.
        expect(
            await buildAndRun(
                { '/d.cjs': 'module.exports = { k: 7 };', '/main.js': "import d from './d.cjs';\nexport const x = d.k;" },
                '/main.js',
                {
                    preserveModules: true,
                },
            ),
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
        expect(
            await buildAndRun({
                '/d.cjs': 'module.exports = { k: 7 };',
                '/main.js': "import d from './d.cjs';\nexport const x = d.k;",
            }),
        ).toBe(7);
    });

    it('a dynamically imported ES module still resolves across chunks', async () => {
        // Proof the failure is about CommonJS, not about dynamic import or chunking generally.
        expect(
            await buildAndRun({
                '/e.js': 'export const k = 7;',
                '/main.js': "export const x = import('./e.js').then((m) => m.k);",
            }),
        ).toBe(7);
    });
});

// KNOWN GAP (cjs.md §7.20, D1) — `require()` of an ES module is EAGER. rolldown gives such a target
// an `__esm` lazy-init wrapper so the body runs at the CALL; shakeup evaluates it at its position in
// the concatenation. Two observable consequences, both asserted below.
//
// The fix is a real AST transform (rolldown's `misc/wrapped_esm` fixture): every binding hoisted to a
// bare `var` so the namespace getters can close over it, with the INITIALIZING statements moved into
// the closure. Marked `it.fails` until that lands.
describe('require() of an ES module is lazy', () => {
    const runOne = async (files: Record<string, string>) => {
        const r = await bundle({ entry: '/main.js', fs: createMemoryFs(files), external: [] });
        expect(r.errors).toEqual([]);
        return (await import(`data:text/javascript,${encodeURIComponent(r.chunks[0].code)}`)) as Record<string, unknown>;
    };

    it('does not run a target whose require is never reached', async () => {
        // The serious half: a module that should never execute does.
        const ns = await runOne({
            '/esm.js': 'globalThis.__ran = true;\nexport const a = 1;',
            '/d.cjs':
                "let v = 0;\nif (globalThis.__never) { v = require('./esm.js').a }\nmodule.exports = { v, ran: globalThis.__ran ?? false };",
            '/main.js': "import d from './d.cjs';\nexport const x = d;",
        });
        expect(ns.x).toEqual({ v: 0, ran: false });
    });

    it('runs the target AT the require call, not before it', async () => {
        const ns = await runOne({
            '/esm.js': 'globalThis.__log.push("esm");\nexport const a = 1;',
            '/d.cjs': [
                'globalThis.__log = [];',
                'globalThis.__log.push("before");',
                "const e = require('./esm.js');",
                'globalThis.__log.push("after");',
                'module.exports = { order: globalThis.__log.slice(), a: e.a };',
            ].join('\n'),
            '/main.js': "import d from './d.cjs';\nexport const x = d;",
        });
        expect(ns.x).toEqual({ order: ['before', 'esm', 'after'], a: 1 });
    });

    it('still resolves the required ES module’s values', async () => {
        // Guard: whatever the timing fix does, the values must keep working.
        const ns = await runOne({
            '/esm.js': 'export const a = 1;\nexport default 2;',
            '/d.cjs': "const e = require('./esm.js');\nmodule.exports = [e.a, e.default];",
            '/main.js': "import d from './d.cjs';\nexport const x = d;",
        });
        expect(ns.x).toEqual([1, 2]);
    });
});

// The lazy form × a chunk boundary — a product neither axis's tests covered. `esm_ns` and `init_esm`
// are declared by the producer chunk and referenced by the consumer's wrapper body, and nothing
// joined the two: the consumer emitted a bare side-effect `import './esm-….js'` and then called an
// undeclared `init_esm`. Pre-existing for the namespace half (a require of an ES module across a
// boundary always dangled); the init half arrived with D1.
describe('require() of an ES module across a chunk boundary', () => {
    it('resolves under preserveModules', async () => {
        expect(
            await buildAndRun(
                {
                    '/esm.js': 'export const a = 7;',
                    '/d.cjs': "module.exports = require('./esm.js').a;",
                    '/main.js': "import d from './d.cjs';\nexport const x = d;",
                },
                '/main.js',
                { preserveModules: true },
            ),
        ).toBe(7);
    });

    it('stays lazy across the boundary', async () => {
        // The timing guarantee must survive chunking, not just hold in one file.
        expect(
            await buildAndRun(
                {
                    '/esm.js': 'globalThis.__log.push("esm");\nexport const a = 1;',
                    '/d.cjs':
                        'globalThis.__log = ["before"];\n' +
                        "const e = require('./esm.js');\n" +
                        'globalThis.__log.push("after");\n' +
                        'module.exports = globalThis.__log.concat(e.a);',
                    '/main.js': "import d from './d.cjs';\nexport const x = d;",
                },
                '/main.js',
                { preserveModules: true },
            ),
        ).toEqual(['before', 'esm', 'after', 1]);
    });

    it('resolves through a dynamic import', async () => {
        expect(
            await buildAndRun({
                '/esm.js': 'export const a = 7;',
                '/d.cjs': "module.exports = require('./esm.js').a;",
                '/main.js': "export const x = import('./d.cjs').then((m) => m.default);",
            }),
        ).toBe(7);
    });

    it('a producer chunk still surfaces a NATIVE namespace when the module is not lazy', async () => {
        // Guard on the exclusion added to `nativeNsEligible`: it must only fire for lazy modules.
        const r = await build(
            { '/a.js': 'export const v = 1;', '/main.js': "import * as ns from './a.js';\nexport const x = ns.v;" },
            '/main.js',
            {
                preserveModules: true,
            },
        );
        expect(r.chunks.find((c) => c.isEntry)!.code).toMatch(/import \* as \w+ from/);
    });
});

// WHERE a statically imported module is evaluated. `cjs.md` §7.25d / rolldown's
// `esm_init_obligations.rs`: an `import` statement is what runs its target, so whatever runs it —
// `init_X()` for a lazily-initialised ES module, `var import_X = __toESM(require_X())` for a wrapped
// CommonJS one — has to be emitted for that statement rather than at the target's own slot.
//
// The order these assert is Node's, and `pnpm evalorder` checks the same shapes against Node and
// rolldown for real rather than against a recorded expectation.
describe('a statically imported module evaluates at its import, not at its slot', () => {
    // A DISTINCT GLOBAL PER TEST. `runChunks` evaluates in this process, so one shared `globalThis`
    // key accumulates every test's pushes and the second assertion sees the first test's entries.
    const decl = (k: string) => `globalThis.${k} = globalThis.${k} ?? [];\n`;
    const push = (k: string, v: string) => `globalThis.${k}.push('${v}');\n`;

    it('runs an earlier ESM import before a later CommonJS one', async () => {
        // `e` is required BY `b` and also imported by main. Emitting b's interop beside its wrapper
        // ran b — and so e — ahead of everything main does, giving [b, e]; Node gives [e, b].
        const K = 'ORDER_A';
        const x = await buildAndRun({
            '/e.js': `${decl(K)}${push(K, 'e')}export const v = 1;`,
            '/b.cjs': `${decl(K)}${push(K, 'b')}module.exports = require('./e.js').v;`,
            '/main.js':
                `${decl(K)}import './e.js';\nimport b from './b.cjs';\n${push(K, 'main')}` +
                `export const x = [b, globalThis.${K}.slice()];`,
        });
        expect((x as [number, string[]])[1]).toEqual(['e', 'b', 'main']);
    });

    it('runs a CommonJS import before a later ESM one', async () => {
        const K = 'ORDER_B';
        const x = await buildAndRun({
            '/e.js': `${decl(K)}${push(K, 'e')}export const v = 1;`,
            '/b.cjs': `${decl(K)}${push(K, 'b')}module.exports = require('./e.js').v;`,
            '/main.js':
                `${decl(K)}import b from './b.cjs';\nimport './e.js';\n${push(K, 'main')}` +
                `export const x = [b, globalThis.${K}.slice()];`,
        });
        expect((x as [number, string[]])[1]).toEqual(['b', 'e', 'main']);
    });

    it('HOISTS what an import emits above the importer body', async () => {
        // Import declarations are hoisted, so the target runs before ANY of the importer's own
        // statements — even ones written above the import. Emitting the interop at the statement's
        // textual position instead put `main` first, which Node does not do.
        const K = 'ORDER_C';
        const x = await buildAndRun({
            '/b.cjs': `${decl(K)}${push(K, 'b')}module.exports = 1;`,
            '/main.js':
                `${decl(K)}${push(K, 'main')}import b from './b.cjs';\n` + `export const x = [b, globalThis.${K}.slice()];`,
        });
        expect((x as [number, string[]])[1]).toEqual(['b', 'main']);
    });

    it('declares the interop namespace ONCE for two importers', async () => {
        // `init_X()` is idempotent so every importer can call it; a `var` decl is not, so exactly one
        // statement owns it and the rest emit nothing. Two decls would redeclare the binding and
        // build a second, non-identical namespace object — hence the identity assertion.
        const r = await build({
            '/d.cjs': 'module.exports = { n: 1 };',
            '/x.js': "import d from './d.cjs';\nexport const xd = d;",
            '/y.js': "import d from './d.cjs';\nexport const yd = d;",
            '/main.js': "import { xd } from './x.js';\nimport { yd } from './y.js';\nexport const x = [xd, yd, xd === yd];",
        });
        expect(r.code.match(/var import_d = /g)).toHaveLength(1);
        const entryChunk = r.chunks.find((c) => c.isEntry)!;
        const { ns, dispose } = await runChunks(r.chunks, entryChunk.fileName);
        try {
            expect(ns.x).toEqual([{ n: 1 }, { n: 1 }, true]);
        } finally {
            dispose();
        }
    });

    it('keeps a side-effect-only import of a lazy module alive', async () => {
        // The statement carries the only thing that ever evaluates the target, so treeshake must not
        // drop it as pure — `staticImportRunsTarget`. Dropping it left `e` never evaluated at all.
        // `e` is lazy because b CAN require it, but b never does — so main's bare import is the only
        // thing that ever evaluates it, and dropping that statement left `e` unevaluated entirely.
        const K = 'ORDER_D';
        const x = await buildAndRun({
            '/e.js': `${decl(K)}${push(K, 'e')}export const v = 1;`,
            '/b.cjs': `${decl(K)}${push(K, 'b')}module.exports = () => require('./e.js').v;`,
            '/main.js':
                `${decl(K)}import b from './b.cjs';\nimport './e.js';\n${push(K, 'main')}` +
                `export const x = [typeof b, globalThis.${K}.slice()];`,
        });
        expect((x as [string, string[]])[1]).toEqual(['b', 'e', 'main']);
    });
});
