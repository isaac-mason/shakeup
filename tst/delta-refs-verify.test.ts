import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { parse } from '../src/index.ts';
import { runCompress, setDeltaMode } from '../src/passes/compress/index.ts';

// The compress loop maintains reference counts INCREMENTALLY (oxc `PassChanges`/`flush_pass_changes`):
// every subtree the traversal drops has its references subtracted, every subtree it inserts has them
// added, and nothing re-walks the program. `'verify'` mode additionally recomputes ground truth after
// each round and throws on any divergence — oxc's `debug_assert_no_over_prune`/`no_under_prune`.
//
// WHY THIS TEST EXISTS RATHER THAN A CODE REVIEW. The hazard is a pass that MOVES a subtree and then
// drops its old parent: the move gets counted as a removal, the maintained count falls below reality,
// and a binding that is still referenced looks unused and is deleted. Reviewing for that by hand found
// two of the six real sites. Verification found all six — including `drop-unused`'s
// `n.data.declarations = kept`, which bypasses every `ctx` helper and which no amount of reading the
// mutation API would have surfaced. Both corpora were CLEAN the whole time, so byte-identical output
// would have signed off on a broken implementation.
//
// Run `DELTA_MODE=verify pnpm test` to put the entire suite under this check.
function verifyCompress(src: string, ts: boolean): void {
    const { program } = parse(src, { ts, jsx: false });
    const sem = createSemantic();
    analyze(sem, program);
    setDeltaMode('verify');
    try {
        runCompress(program, sem, 'full');
    } finally {
        setDeltaMode('on');
    }
}

describe('incremental reference facts match ground truth every round', () => {
    const cases: [string, string][] = [
        ['single-use inline moves an init across a statement', 'function f(a){ const t = a + 1; return t * 2; }'],
        ['chained inline', 'function f(a){ const x = a + 1; const y = x + 2; return y; }'],
        ['drop-unused removes some declarators', 'function f(a){ let u = 1, v = a, w = 2; return v; }'],
        ['dead tail after return', 'function f(a){ return a; const z = a + 1; g(z); }'],
        ['collapsed if', 'function f(a){ if (true) { return a; } else { return -a; } }'],
        ['pure expression statement dropped', 'function f(a){ 1 + 2; return a; }'],
        ['partially discarded expression', 'function f(a){ (g(), 1 + 2); return a; }'],
        ['if/return folded with a trailing return', 'function f(a){ if (a) return 1; return 2; }'],
        ['alias inline', 'function f(a){ const b = a; return b + b; }'],
        ['const propagation', 'function f(){ const k = 3; return k + k; }'],
        ['empty if collapses to its test', 'function f(a){ if (a) {} return 1; }'],
        ['nested blocks flattened', 'function f(a){ { const q = a; { return q; } } }'],
        ['reassigned binding is not inlined', 'function f(a){ let t = a; t = a + 1; return t; }'],
        ['shorthand property read', 'function f(a){ const x = a; return { x }; }'],
        ['destructuring target', 'function f(o){ let a, b; ({ a, b } = o); return a + b; }'],
        ['loop with an assigned target', 'function f(xs){ let v, s = 0; for (v of xs) s += v; return s; }'],
    ];
    for (const [name, src] of cases) {
        it(name, () => expect(() => verifyCompress(src, false)).not.toThrow());
    }

    const three = 'llm/spikes/node_modules/three/build/three.core.js';
    it.skipIf(!existsSync(three))('holds across three.core.js', () => {
        expect(() => verifyCompress(readFileSync(three, 'utf8'), false)).not.toThrow();
    }, 120000);

    const cc = '/Users/isaacmason/Development/crashcat/src/world.ts';
    it.skipIf(!existsSync(cc))('holds across a real TS module', () => {
        expect(() => verifyCompress(readFileSync(cc, 'utf8'), true)).not.toThrow();
    }, 60000);
});
