import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

// `const-prop` replaces reads of a primitive-valued `const`/`let` with the literal. An export
// specifier's `local` is an IdentifierReference too — but it NAMES the export, it is not a value
// read. Substituting there rewrote `export { used }` into `export { 1 }`; `extractRecords` then
// recorded `symbol: 0` and every importer failed to link with `'used' is not exported`.
//
// Measured blast radius on three.core.js: **329 exports before the fix, 444 after** — shakeup was
// silently dropping 115 of three.js's public exports, every numeric constant written as
// `const ACESFilmicToneMapping = 1; export { ACESFilmicToneMapping };`. The bundle got 2.6KB SMALLER
// for it, which is why nothing noticed.
//
// `var` escaped by accident (const-prop excludes it for hoisting reasons) and inline `export const`
// escapes because there is no separate specifier to rewrite — the two shapes people write most both
// dodged the bug, which is how it survived.
const build = async (files: Record<string, string>, output: Record<string, unknown> = {}) =>
    bundle({ entry: '/main.js', external: [], fs: createMemoryFs(files), output });

const run = async (
    dep: string,
    main = "import { used } from './d.js';\nexport const x = used;",
    output: Record<string, unknown> = {},
) => {
    const r = await build({ '/d.js': dep, '/main.js': main }, output);
    expect(r.errors).toEqual([]);
    return (await import(`data:text/javascript,${encodeURIComponent(r.code)}`)) as { x: unknown };
};

describe('two-statement exports survive constant propagation', () => {
    it.each([
        ['const', 'const used = 1;\nexport { used };', 1],
        ['let', 'let used = 1;\nexport { used };', 1],
        ['var', 'var used = 1;\nexport { used };', 1],
        ['a string constant', "const used = 'hello';\nexport { used };", 'hello'],
        ['a boolean constant', 'const used = false;\nexport { used };', false],
        ['under an alias', 'const u = 1;\nexport { u as used };', 1],
        ['alongside other exports', 'const used = 1;\nconst other = 2;\nexport { used, other };', 1],
        ['when also read locally', 'const used = 1;\nglobalThis.__cpz = used;\nexport { used };', 1],
    ])('exports %s', async (_label, dep, expected) => {
        expect((await run(dep)).x).toEqual(expected);
    });

    it('keeps every export of a constants module', async () => {
        // The three.js shape, minimised: a wall of `const NAME = <literal>` with one export list.
        const names = Array.from({ length: 12 }, (_, i) => `K${i}`);
        const dep = `${names.map((n, i) => `const ${n} = ${i};`).join('\n')}\nexport { ${names.join(', ')} };`;
        const r = await build({ '/d.js': dep, '/main.js': `export * from './d.js';` });
        expect(r.errors).toEqual([]);
        const ns = (await import(`data:text/javascript,${encodeURIComponent(r.code)}`)) as Record<string, unknown>;
        expect(names.filter((n) => ns[n] === undefined)).toEqual([]);
    });

    // ── the optimisation must still happen everywhere it is safe ──

    it('still inlines a NON-exported constant', async () => {
        const r = await build({ '/main.js': 'const k = 41;\nexport const x = k + 1;' }, { minify: true, optimize: true });
        expect(r.errors).toEqual([]);
        expect(r.code).not.toMatch(/\b41\b/); // folded to 42, so the operand is gone
    });

    it('still eliminates a feature flag', async () => {
        // The transform const-prop exists for: `const DEBUG = false; if (DEBUG) {…}` → branch gone.
        const r = await build(
            { '/main.js': "const DEBUG = false;\nif (DEBUG) { globalThis.__cpdbg = 'KEPT' }\nexport const x = 1;" },
            { minify: true, optimize: true },
        );
        expect(r.errors).toEqual([]);
        expect(r.code).not.toContain('KEPT');
    });

    it('still inlines reads of an EXPORTED constant, sparing only the specifier', async () => {
        // Only the specifier node is spared, not the whole binding — disqualifying the symbol cost
        // 2.6KB on three.js for no correctness gain.
        const r = await build(
            {
                '/d.js': 'const used = 7;\nglobalThis.__cpq = used * 2;\nexport { used };',
                '/main.js': "import { used } from './d.js';\nexport const x = used;",
            },
            {
                minify: true,
                optimize: true,
            },
        );
        expect(r.errors).toEqual([]);
        expect(r.code).toMatch(/__cpq\s*=\s*14/); // the local read folded, so it did inline there
    });
});
