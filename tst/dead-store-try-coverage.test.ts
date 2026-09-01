import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { runModule } from './exec-helpers.ts';

// The capability that justified moving dead-store onto the CFG, pinned directly now that the
// `setLivenessDriver` switch is gone and the CFG is the only driver.
//
// This file used to compare two drivers and assert they agreed. That comparison is vacuous with one
// driver — but the CASE it was built around is not, and it is the whole reason the migration happened:
// the structural walker bailed on any function containing `try` and skipped it entirely, so a dead
// store there survived. The CFG models exception edges and removes it.
//
// The differential itself did not disappear with the switch: `tst/cfg-equivalence.test.ts` still
// checks the CFG against `analysis/liveness.ts` statement by statement over three.core.js. That is
// where two-implementation agreement is asserted; this file asserts the behaviour that only one of
// them can produce.

const build = (src: string) => {
    const files: Record<string, string> = { '/e.js': src };
    return bundle({
        entry: '/e.js',
        fs: { read: (i) => files[i] ?? null, exists: (i) => i in files },
        external: [],
        output: { minify: { compress: true } },
    }).then((r) => r.code);
};

describe('dead stores inside try-containing functions are eliminated', () => {
    // `a = 1` is overwritten by `a = 2` before any read, so it is dead — but it sits in a function
    // containing `try`, which is precisely the shape the structural walker refused to analyse.
    const SRC =
        '/* @optimize */\nfunction f(p){ let a; a = 1; a = 2; try { g(p); } catch (e) {} return a; }\n' +
        'globalThis.g = () => {};\nexport const out = f(1);\n';

    it('removes the dead store', async () => {
        expect(await build(SRC)).not.toMatch(/a = 1/);
    });

    it('and the program still computes the same answer', async () => {
        // Not redundant with the above: deleting a store is only correct if nothing observed it.
        expect((await runModule(await build(SRC))).out).toBe(2);
    });

    it('keeps a store that IS read, in the same try shape', async () => {
        // The negative control. Without it, a pass that deleted every store in a try-containing
        // function would pass both assertions above.
        const LIVE =
            '/* @optimize */\nfunction f(p){ let a; a = 1; try { g(p); } catch (e) {} return a; }\n' +
            'globalThis.g = () => {};\nexport const out = f(1);\n';
        const code = await build(LIVE);
        expect((await runModule(code)).out).toBe(1);
    });
});
