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

// ── exception edges, the part that is load-bearing now ────────────────────────────────────────────
//
// With the switch gone, the CFG's exception modelling is the ONLY thing standing between dead-store
// and a miscompile. The dangerous direction is not "fails to remove a dead store" — that is a missed
// optimisation — it is removing a store that an exception makes LIVE:
//
//     let a; a = 1; try { g(p); a = 2; } catch (e) {} return a;
//
// `a = 2` looks like it kills `a = 1`, and on the normal path it does. But if `g(p)` throws, `a = 2`
// never runs and `return a` observes 1. An analysis that treats a try block as straight-line deletes
// `a = 1` and silently changes the answer.
//
// These assert RUNTIME RESULTS on both the throwing and non-throwing path, deliberately, rather than
// matching text. The probe that built this table showed why: in the `read in catch` shape the store
// really is gone from the output and the program is still correct, because const-propagation rewrote
// the read instead. Text says "removed", execution says "correct", and only one of those is the
// property worth pinning.
describe('stores kept alive by an exception edge are not deleted', () => {
    const f = async (body: string) => {
        const src =
            `/* @optimize */\nfunction f(p){ ${body} }\n` +
            `globalThis.g = (p) => { if (p) throw new Error('x'); };\nglobalThis.h = () => {};\n` +
            `export const thrown = f(1);\nexport const clean = f(0);\n`;
        const ns = (await runModule(await build(src))) as { thrown: unknown; clean: unknown };
        return [ns.thrown, ns.clean];
    };

    it.each([
        // shape                                                                      throws  normal
        ['overwrite inside try — throw skips the kill', 'let a; a = 1; try { g(p); a = 2; } catch(e){} return a;', 1, 2],
        ['the catch block reads it', 'let a; a = 1; try { g(p); a = 2; } catch(e){ return a; } return a;', 1, 2],
        ['a finally clause intervenes', 'let a; a = 1; try { g(p); a = 2; } catch(e){} finally { h(); } return a;', 1, 2],
        ['both arms assign, so the first IS dead', 'let a; a = 1; try { g(p); a = 2; } catch(e){ a = 3; } return a;', 3, 2],
        ['dead before the try entirely', 'let a; a = 1; a = 2; try { g(p); } catch(e){} return a;', 2, 2],
        ['dead after the try entirely', 'let a; try { g(p); } catch(e){} a = 1; a = 2; return a;', 2, 2],
        ['nested try, inner throw skips the kill', 'let a; a = 1; try { try { g(p); a = 2; } finally { h(); } } catch(e){} return a;', 1, 2],
    ])('%s', async (_label, body, whenThrows, whenNot) => {
        expect(await f(body)).toEqual([whenThrows, whenNot]);
    });
});
