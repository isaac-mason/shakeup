import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

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
        // Re-entry: strip the ESM export so the body can run in a plain Function.
        const body = code.replace(/^export\s*\{[^}]*\};?\s*$/m, '');
        new Function('globalThis', body)(g);
        // sum over i of (i+1) * (7+i)
        let want = 0;
        for (let i = 0; i < NL; i++) want += (i + 1) * (7 + i);
        expect(g.sink).toBe(want);
    });
});
