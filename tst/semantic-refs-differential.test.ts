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

    // Symbol-INDEXED arrays now, so sweep the union of lengths rather than Map keys.
    const syms: number[] = [];
    for (let i = 1; i < Math.max(p.refs.length, sem.refs.length); i++) {
        if (p.refs[i] !== undefined || sem.refs[i] !== undefined) syms.push(i);
    }
    for (const s of syms) {
        const a = sem.refs[s];
        const b = p.refs[s];
        if ((a?.reads ?? 0) !== (b?.reads ?? 0) || (a?.writes ?? 0) !== (b?.writes ?? 0))
            problems.push(
                `sym ${s}: refs analyze={r:${a?.reads ?? 0},w:${a?.writes ?? 0}} prelude={r:${b?.reads ?? 0},w:${b?.writes ?? 0}}`,
            );
    }
    const useSyms = (() => { const o: number[] = []; for (let i = 1; i < Math.max(p.uses.length, sem.uses.length); i++) o.push(i); return o; })();
    for (const s of useSyms) {
        if ((sem.uses[s] ?? 0) !== (p.uses[s] ?? 0))
            problems.push(`sym ${s}: uses analyze=${sem.uses[s] ?? 0} prelude=${p.uses[s] ?? 0}`);
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
        // Added by a scrutiny pass over the shapes the first round of cases never reached. The first
        // two of these FAILED when written: `computePrelude`'s target walk skipped computed keys, so
        // it counted zero reads for `k` where `analyze` counts one. `analyze` is right — `k` is
        // evaluated at runtime to pick the property.
        ['computed key in a destructuring TARGET', 'let a; const k = "p"; ({ [k]: a } = o); g(a);'],
        ['nested computed key in a target', 'let a; const k = 1; ({ x: { [k]: a } } = o); g(a);'],
        ['array-hole target', 'let a; const k = 1; [ , a ] = xs; g(a, k);'],
        ['getter/setter object literal', 'const v = 1; const o = { get p(){ return v; }, set p(x){} };'],
        ['class computed member names', 'const k = "m"; class C { [k]() {} static [k + 1] = 2; }'],
        ['for await of target', 'let v; async function f(){ for await (v of xs) g(v); }'],
        ['member chain assignment', 'const o = {}; o.a.b = 1;'],
        ['logical assignment operators', 'let x = 1; x ||= 2; x &&= 3; x ??= 4;'],
        ['destructuring default reads', 'let a; const d = 1; ({ a = d } = o); g(a);'],
        ['rest element in an object target', 'let a, r; ({ a, ...r } = o); g(a, r);'],
        ['tagged template', 'const t = x => x; const v = 1; t`a${v}b`;'],
        ['optional chain call', 'const o = {}; o?.m?.(1);'],
    ];
    for (const [name, src] of cases) {
        it(name, () => expect(diff(src, false)).toEqual([]));
    }

    const three = 'llm/spikes/node_modules/three/build/three.core.js';
    it.skipIf(!existsSync(three))('agrees across three.core.js', () => {
        expect(diff(readFileSync(three, 'utf8'), false)).toEqual([]);
    }, 60000);

    const tsCases: [string, string][] = [
        ['ts: a type and a value sharing a name', 'type T = number; const T = 1; let x: T = T;'],
        ['ts: enum member reference', 'enum E { A = 1 } const v = E.A;'],
        ['ts: as / satisfies', 'const v = 1; const w = v as number; const z = v satisfies number;'],
        ['ts: decorator', 'const d = () => {}; class C { @d m() {} }'],
    ];
    for (const [name, src] of tsCases) {
        it(name, () => expect(diff(src, true)).toEqual([]));
    }

    const cc = '/Users/isaacmason/Development/crashcat/src/world.ts';
    it.skipIf(!existsSync(cc))('agrees across a real TS module', () => {
        expect(diff(readFileSync(cc, 'utf8'), true)).toEqual([]);
    }, 60000);
});
