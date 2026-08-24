import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { computePrelude } from '../src/passes/compress/prelude.ts';
import { parse } from '../src/index.ts';

// Phase A gate. `analyze` now maintains the reference facts (`refs`/`uses`/`shorthand`/`exported`)
// that `computePrelude` used to derive from two separate whole-program walks. The two must agree
// EXACTLY — a disagreement in the safe direction (analyze over-counting) only costs an optimization,
// but under-counting drops a binding that is still read, so this asserts equality, not a bound.
//
// `computePrelude` is kept solely as this differential's reference implementation.

function diff(src: string, ts: boolean): string[] {
    const { program } = parse(src, { ts, jsx: false });
    const sem = createSemantic();
    analyze(sem, program);
    const p = computePrelude(program);
    const problems: string[] = [];

    const syms = new Set<number>([...p.refs.keys(), ...sem.refs.keys()]);
    for (const s of syms) {
        const a = sem.refs.get(s);
        const b = p.refs.get(s);
        if ((a?.reads ?? 0) !== (b?.reads ?? 0) || (a?.writes ?? 0) !== (b?.writes ?? 0))
            problems.push(
                `sym ${s}: refs analyze={r:${a?.reads ?? 0},w:${a?.writes ?? 0}} prelude={r:${b?.reads ?? 0},w:${b?.writes ?? 0}}`,
            );
    }
    const useSyms = new Set<number>([...p.uses.keys(), ...sem.uses.keys()]);
    for (const s of useSyms) {
        if ((sem.uses.get(s) ?? 0) !== (p.uses.get(s) ?? 0))
            problems.push(`sym ${s}: uses analyze=${sem.uses.get(s) ?? 0} prelude=${p.uses.get(s) ?? 0}`);
    }
    for (const s of new Set([...p.shorthand, ...sem.shorthand]))
        if (p.shorthand.has(s) !== sem.shorthand.has(s)) problems.push(`sym ${s}: shorthand mismatch`);
    for (const s of new Set([...p.exported, ...sem.exported]))
        if (p.exported.has(s) !== sem.exported.has(s)) problems.push(`sym ${s}: exported mismatch`);
    return problems;
}

describe('analyze reference facts == computePrelude', () => {
    const cases: [string, string][] = [
        ['plain reads', 'const a = 1; f(a, a);'],
        ['writes', 'let x = 1; x = 2; x += 3; x++; --x;'],
        ['member target reads the object', 'const o = {}; o.p = 1; o[k] = 2;'],
        ['destructuring assignment writes', 'let a, b; [a, b] = xs; ({ a, b } = o);'],
        ['nested destructuring with defaults', 'let a, b; [a = 1, ...b] = xs;'],
        ['shorthand property', 'const x = 1; const o = { x };'],
        ['shorthand with default in pattern', 'let x; ({ x = 5 } = o); const p = { x };'],
        ['export specifier', 'const b = 1; export { b };'],
        ['export renamed', 'const b = 1; export { b as c };'],
        ['for-of assigns to the loop target', 'let v; for (v of xs) g(v);'],
        ['for-in with declaration', 'for (const k in o) g(k);'],
        ['for-of destructuring target', 'let a, b; for ([a, b] of xs) g(a, b);'],
        ['compound on a member', 'const o = {}; o.n += 1;'],
        ['binding identifiers are not references', 'function f(p) { return p; } class C {}'],
        ['shadowing', 'const a = 1; { const a = 2; g(a); } g(a);'],
        ['closure capture', 'let c = 0; function inc() { c++; } inc();'],
    ];
    for (const [name, src] of cases) {
        it(name, () => expect(diff(src, false)).toEqual([]));
    }

    const three = 'llm/spikes/node_modules/three/build/three.core.js';
    it.skipIf(!existsSync(three))('agrees across three.core.js', () => {
        expect(diff(readFileSync(three, 'utf8'), false)).toEqual([]);
    }, 60000);

    const cc = '/Users/isaacmason/Development/crashcat/src/world.ts';
    it.skipIf(!existsSync(cc))('agrees across a real TS module', () => {
        expect(diff(readFileSync(cc, 'utf8'), true)).toEqual([]);
    }, 60000);
});
