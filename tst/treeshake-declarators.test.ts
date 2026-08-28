import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import type { Plugin } from '../src/plugin.ts';

// KNOWN GAP — dead DECLARATORS survive, and `minify: true` makes it worse than `minify: false`.
//
// shakeup's tree-shaker includes or drops whole STATEMENTS. `compress` runs BEFORE treeshake, and
// `joinVars` merges adjacent same-kind declarations into one statement — so a dead declarator gets
// welded to a live one and rides along. Liveness itself is correct (`live` is unchanged); only the
// granularity is wrong.
//
// rolldown, measured on the same fixtures, drops the dead declarator in BOTH shapes — separate
// declarations and a single multi-declarator statement, minified or not. So declarator-level
// granularity is the aligned target, and it closes the merge regression and the pre-existing
// multi-declarator limitation together.
//
// FIXED by two changes, which are coupled and neither works alone:
//   A `splitDeclarators` (scan) splits top-level multi-declarator statements, so statement-level
//     shaking reaches declarator granularity. Mirrors rolldown `split_multi_declarator` / esbuild's
//     one-part-per-declarator. Fixes the shape that exists in SOURCE.
//   B `weldStatements` moved `joinVars` out of the scan-time fixed point to RENDER, over the
//     live-filtered list — nothing that merges statements may run before liveness is computed.
const sideEffectFree: Plugin = {
    name: 'sef',
    resolveId: (spec, importer) => (spec === './pure.js' && importer ? { id: '/pure.js', moduleSideEffects: false } : null),
};

const build = async (pure: string, minify: boolean, external: string[] = []) => {
    const r = await bundle({
        entry: '/entry.js',
        fs: createMemoryFs({ '/pure.js': pure, '/entry.js': "import * as ns from './pure.js';\nexport const used = [ns.a];" }),
        plugins: [sideEffectFree],
        external,
        output: { minify },
    });
    expect(r.errors).toEqual([]);
    return r.code;
};

describe('dead declarators are dropped', () => {
    // Pure initialisers: no external call to muddy whether the statement has side effects, so this
    // isolates granularity alone. rolldown emits AAA only for both, minified and not.
    const SEPARATE = "var a = 'AAA';\nvar b = 'BBB';\nexport { a, b };";
    const MERGED = "var a = 'AAA', b = 'BBB';\nexport { a, b };";

    it('separate declarations, unminified (already correct)', async () => {
        const code = await build(SEPARATE, false);
        expect(code).toContain('AAA');
        expect(code).not.toContain('BBB');
    });

    it('separate declarations, MINIFIED — joinVars welds the dead one to the live one', async () => {
        const code = await build(SEPARATE, true);
        expect(code).not.toContain('BBB');
    });

    it('one statement with two declarators, unminified', async () => {
        // Fixed by `splitDeclarators`: one statement per declarator, so the shaker's statement
        // granularity reaches the declarator. rolldown and esbuild both split for this reason.
        const code = await build(MERGED, false);
        expect(code).not.toContain('BBB');
    });

    it('one statement with two declarators, minified', async () => {
        const code = await build(MERGED, true);
        expect(code).not.toContain('BBB');
    });

    it.each([
        ['var', "import { mk } from 'ext';\nvar a = mk('AAA');\nvar b = mk('BBB');\nexport { a, b };"],
        ['let', "import { mk } from 'ext';\nlet a = mk('AAA');\nlet b = mk('BBB');\nexport { a, b };"],
        ['const', "import { mk } from 'ext';\nconst a = mk('AAA');\nconst b = mk('BBB');\nexport { a, b };"],
    ])('%s declarations of an impure call: minify must not resurrect the dead one', async (_kind, pure) => {
        // The real-world shape — a rolldown-built chunk is runs of `var x = fn(…)` plus a trailing
        // `export { … }`. Here the assertion is INTERNAL CONSISTENCY, not rolldown parity: rolldown
        // keeps both (it cannot prove the external `mk` pure), while shakeup correctly drops the dead
        // one unminified. Minifying must not undo that.
        const unmin = await build(pure, false, ['ext']);
        const min = await build(pure, true, ['ext']);
        expect(unmin).not.toContain('BBB');
        expect(min).not.toContain('BBB'); // currently FAILS
    });

    // ── already correct: guards the surrounding behaviour ──

    it('a statement between the declarations blocks the merge', async () => {
        const code = await build(
            "import { mk } from 'ext';\nvar a = mk('AAA');\nglobalThis.f = 1;\nvar b = mk('BBB');\nexport { a, b };",
            true,
            ['ext'],
        );
        expect(code).not.toContain('BBB');
    });

    it('inline `export const` is unaffected', async () => {
        // These are ExportNamedDeclaration nodes, not merge candidates for joinVars.
        const code = await build("import { mk } from 'ext';\nexport const a = mk('AAA');\nexport const b = mk('BBB');", true, [
            'ext',
        ]);
        expect(code).not.toContain('BBB');
    });
});

describe('a symbol declared more than once keeps EVERY declaration', () => {
    // `var b = 3; var b = b - 1;` declares `b` twice. The liveness map is keyed by symbol, so the
    // second declaration used to overwrite the first and only the second was marked live — emitting
    // `var b = b - 1` with `b` undefined. That is a MISCOMPILE, not a missed optimisation: the
    // second declarator reads what the first wrote.
    //
    // Rollup's own suite catches it four ways, with the duplicate `var` as a loop body:
    // `unused-{while,do-while,for-in,for-of}-loop-declaration`.
    const evalOut = async (src: string): Promise<unknown> => {
        const r = await bundle({ entry: '/main.js', fs: createMemoryFs({ '/main.js': src }) });
        expect(r.errors).toEqual([]);
        const mod = (await import(`data:text/javascript,${encodeURIComponent(r.code)}`)) as { out: unknown };
        return mod.out;
    };

    it.each([
        ['plain redeclaration', 'var b = 3;\nvar b = b - 1;\nexport const out = b;', 2],
        ['inside a block', 'var b = 3;\n{ var b = b - 1; }\nexport const out = b;', 2],
        ['inside an if', 'var b = 3;\nif (b) var b = b - 1;\nexport const out = b;', 2],
        ['as a while body', 'var b = 3;\nwhile (b > 0) var b = b - 1;\nexport const out = b;', 0],
    ])('%s', async (_name, src, expected) => {
        expect(await evalOut(src)).toBe(expected);
    });

    it('keeps a side-effecting initializer on an unread binding in a loop body', async () => {
        // rollup's `unused-while-loop-declaration` verbatim: `unused` is never read, but `result--`
        // must still run once per iteration.
        const out = await evalOut(
            'let result = 3;\nvar b = 3;\nwhile (b > 0)\nvar b = b - 1, unused = result--, unused2 = 0;\nexport const out = [b, result];',
        );
        expect(out).toEqual([0, 0]);
    });
});
