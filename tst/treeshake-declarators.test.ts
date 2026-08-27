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
// `it.fails` marks what is currently broken so the suite stays green; fixing it turns them red.
const sideEffectFree: Plugin = {
    name: 'sef',
    resolveId: (_c, spec, importer) => (spec === './pure.js' && importer ? { id: '/pure.js', moduleSideEffects: false } : null),
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

    it.fails('separate declarations, MINIFIED — joinVars welds the dead one to the live one', async () => {
        const code = await build(SEPARATE, true);
        expect(code).not.toContain('BBB');
    });

    it.fails('one statement with two declarators, unminified', async () => {
        // Pre-existing, not a regression: the shaker cannot split a statement. rolldown can.
        const code = await build(MERGED, false);
        expect(code).not.toContain('BBB');
    });

    it.fails('one statement with two declarators, minified', async () => {
        const code = await build(MERGED, true);
        expect(code).not.toContain('BBB');
    });

    it.fails.each([
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
        const code = await build("import { mk } from 'ext';\nvar a = mk('AAA');\nglobalThis.f = 1;\nvar b = mk('BBB');\nexport { a, b };", true, ['ext']);
        expect(code).not.toContain('BBB');
    });

    it('inline `export const` is unaffected', async () => {
        // These are ExportNamedDeclaration nodes, not merge candidates for joinVars.
        const code = await build("import { mk } from 'ext';\nexport const a = mk('AAA');\nexport const b = mk('BBB');", true, ['ext']);
        expect(code).not.toContain('BBB');
    });
});
