import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import { refMod, refSym } from '../src/graph-types.ts';
import { linkGraph } from '../src/link.ts';
import { computeChunkSlots, topLevelSlotWeights } from '../src/mangle/chunk.ts';
import { buildGraph } from '../src/scan.ts';

// oxc Phase 3, `SlotRanking::tally` (`oxc_mangler/src/lib.rs:732-777`): slots are ranked by REFERENCE
// FREQUENCY so the hottest slot gets the shortest name, because base54 supplies only 54 one-character
// names before names grow to two.
//
// WHY THIS TEST EXISTS AT ALL: neither corpus reaches the code path. On crashcat and three.core.js
// EVERY slot is anchored to a top-level symbol's existing name (2,469 of 2,469 and 817 of 817), so
// `fresh()` is never called and the ranking is a no-op — measured, not assumed. The path needs a chunk
// whose NESTED local pressure exceeds the top-level binding count, which is what this builds. Without
// this test the ranking would be entirely unexercised.
//
// It also has to clear the 54-name boundary: with fewer than ~54 fresh names every name is one
// character and the ORDER cannot matter. An earlier version of this used 40 locals and measured a
// byte-identical no-difference — the harness was insensitive to the thing it was testing.
const NL = 200;

function source(): string {
    const decls: string[] = [];
    const uses: string[] = [];
    for (let i = 0; i < NL; i++) {
        decls.push(`  let v${i} = seed + ${i};`);
        // INVERTED gradient: the LAST-declared local is the HOTTEST (v199 referenced NL times, v0 once).
        // This is the whole point — with an ascending gradient the hottest local is also the first
        // declared, so slot-index order and frequency order agree and the test passes either way. That
        // is exactly what the first version of this test did, and it passed with the ranking DISABLED.
        for (let k = 0; k <= i; k++) uses.push(`  out += v${i};`);
    }
    return `export function big(seed){\n${decls.join('\n')}\n  let out = 0;\n${uses.join('\n')}\n  return out;\n}\nglobalThis.sink = big(Number(globalThis.x));\n`;
}

const build = () =>
    bundle({
        entry: '/e.js',
        fs: createMemoryFs({ '/e.js': source() }),
        external: [],
        output: { minify: true, optimize: true },
    }).then((r) => r.code);

describe('mangler ranks slots by reference frequency (oxc Phase 3)', () => {
    // Timeout raised for SEMANTIC_VERIFY=1 runs, which rebuild the semantic every round.
    it('spends one-character names on the hottest slots', { timeout: 120_000 }, async () => {
        const code = await build();
        // `v199` is the hottest (200 references) but the LAST declared, so slot-index ordering would
        // hand it a two-character name; frequency ranking must give it a one-character name.
        // No declaration keyword in the pattern: the minifier comma-joins the declarators into a single
        // `let a=n+0,b=n+1,…`, so only the first of 200 carries `let`.
        const decl = new RegExp(`([A-Za-z_$][\\w$]*)\\s*=\\s*\\w+\\s*\\+\\s*${NL - 1}\\b`).exec(code);
        expect(decl, 'could not locate the hottest local in the output').not.toBeNull();
        expect(decl![1].length).toBe(1);
    });

    it('produces semantically identical output', { timeout: 120_000 }, async () => {
        const code = await build();
        const g = { x: 7 } as Record<string, unknown>;
        // Re-entry: strip the ESM export so the body can run in a plain Function. NOT line-anchored:
        // a fully minified chunk is one line, so `…sink=zn(…);export{zn as big}` has no newline before
        // the clause and an `^…$` match would silently leave the `export` in place.
        const body = code.replace(/export\s*\{[^}]*\};?/g, '');
        new Function('globalThis', body)(g);
        // sum over i of (i+1) * (7+i)
        let want = 0;
        for (let i = 0; i < NL; i++) want += (i + 1) * (7 + i);
        expect(g.sink).toBe(want);
    });
});

// ── Top-level claim ranking (increment 2) ────────────────────────────────────────────────────────
// `deconflictChunk` names the chunk's top-level symbols, and it used to claim them in module /
// symbol-id order — so the 54 one-character names went to whichever symbols came first. Ranking them
// needs MORE than 54 top-level symbols before any length difference can show, the same boundary the
// nested test above documents.
describe('top-level names are claimed hottest-slot-first', () => {
    const PAD = 70; // > 54, so the base54 sequence has to reach two-character names

    const build = async (src: string, external: string[] = []) => {
        const r = await bundle({ entry: '/main.ts', fs: createMemoryFs({ '/main.ts': src }), external, output: { minify: true } });
        expect(r.errors).toEqual([]);
        return r.code;
    };
    /** The emitted name for `export const <exported> = …` / `export { x as <exported> }`. */
    const nameOf = (code: string, exported: string): string => {
        const m = code.match(new RegExp(`(\\w+) as ${exported}\\b`)) ?? code.match(new RegExp(`\\b(${exported})\\b`));
        return m![1];
    };

    const padding = (n: number) => Array.from({ length: n }, (_, i) => `export const pad${i} = ${i};`).join('\n');

    it('gives the hot binding a shorter name than the cold ones', async () => {
        const hotUses = Array.from({ length: 200 }, () => 'hot()').join('+');
        const code = await build([padding(PAD), 'export function hot() { return 1; }', `export const total = ${hotUses};`].join('\n'));
        const hot = nameOf(code, 'hot');
        // Every padding symbol is referenced once (its own declaration), `hot` 200 times.
        const cold = nameOf(code, 'pad69');
        expect(hot.length).toBeLessThan(cold.length);
        expect(hot.length).toBe(1);
    });

    it('lets a hot EXTERNAL import compete with module symbols for a short name', async () => {
        // External locals used to be claimed after every module symbol, landing deep in the
        // two-character range regardless of traffic: crashcat's `vec3`, at 2483 uses, came out `$G`.
        const uses = Array.from({ length: 200 }, () => 'ext()').join('+');
        const code = await build([padding(PAD), "import { ext } from 'e';", `export const total = ${uses};`].join('\n'), ['e']);
        const local = code.match(/import\{ext as (\w+)\}from'e';/)![1];
        expect(local.length).toBe(1);
    });

    it('leaves names alone when not mangling', async () => {
        const r = await bundle({
            entry: '/main.ts',
            fs: createMemoryFs({ '/main.ts': 'export const keepThisName = 1;' }),
            output: { minify: { whitespace: false, mangle: false, compress: false } },
        });
        expect(r.code).toContain('keepThisName');
    });
});

describe('topLevelSlotWeights measures the SLOT, not the symbol', () => {
    // The regression this pins: ranking a top-level symbol by its OWN reference count made crashcat
    // 30,563 bytes BIGGER. A slot holding a top-level symbol lends that name to every nested symbol
    // sharing it, so a binding never referenced itself can still be the busiest name in the output —
    // crashcat's `e` is `NONE_FLAG`, whose own reference count is zero yet which prints 7,359 times.
    //
    // End-to-end this cannot be isolated: slots are handed to ROOT bindings in declaration order, so
    // "busy slot" and "declared early" move together and an unranked build would look identical.
    // Asserting on the weight function directly is what makes the distinction observable.
    it('gives a never-referenced top-level binding the weight of its slot', async () => {
        const src = [
            'export const anchor = 1;', // declared first → lowest slot; never referenced
            'export function busy(p) { let u = p + 1, v = u + 2; return u + v + u + v + u + v; }',
        ].join('\n');
        const graph = await buildGraph({ entry: '/main.ts', fs: createMemoryFs({ '/main.ts': src }), external: [] });
        expect(graph.errors).toEqual([]);
        const linked = linkGraph(graph);
        const pre = computeChunkSlots(graph, linked, [0])!;
        expect(pre).not.toBeNull();

        const weights = topLevelSlotWeights(pre);
        const anchorRef = [...weights.keys()].find((ref) => {
            const sem = graph.modules[refMod(ref)].semantic;
            return sem.symbols[refSym(ref)].decl?.name === 'anchor';
        })!;
        expect(anchorRef).toBeDefined();
        // `anchor` has no references of its own, so an own-count weight would be 0. Its SLOT carries
        // the nested locals that inherit its name, so the slot weight must be strictly positive.
        expect(weights.get(anchorRef)).toBeGreaterThan(0);
    });
});
