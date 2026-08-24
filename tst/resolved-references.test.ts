import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { N, type Node, walk } from '../src/ast.ts';
import { tallyRefs } from '../src/analysis/movement.ts';
import { parse } from '../src/index.ts';

// `Semantic.resolvedReferences` is the reverse index (oxc `Scoping::resolved_references`) that lets a
// pass answer "how is this symbol used" in O(1) instead of walking the program. These pin that it is
// COMPLETE and CORRECT against the full-walk it is meant to replace (`tallyRefs`), on real code — the
// index is only safe to depend on if it never MISSES a reference (a missed reference is the unsafe
// direction: oxc's contract is "an added reference that was never recorded can cause incorrect output").

/** Total references per symbol, from the reverse index. */
function fromIndex(sem: ReturnType<typeof createSemantic>): Map<number, number> {
    const out = new Map<number, number>();
    for (let sym = 0; sym < sem.resolvedReferences.length; sym++) {
        const list = sem.resolvedReferences[sym];
        if (list !== undefined && list.length > 0 && sym !== 0) out.set(sym, list.length);
    }
    return out;
}

/**
 * Resolved reference NODES per symbol, from a full walk — the ground truth the index must contain.
 *
 * NOT `tallyRefs`' `reads + writes`: that bumps BOTH counters for one `x++` node ("GetValue +
 * PutValue"), so it double-counts update and compound-assignment operands. The index is node-based, so
 * the meaningful equivalence is "every resolved IdentifierReference appears exactly once".
 */
function fromWalk(program: Node): Map<number, number> {
    const out = new Map<number, number>();
    walk(program, (n) => {
        if (n.type === N.IdentifierReference) {
            const s = (n as { sym: number }).sym;
            if (s !== 0) out.set(s, (out.get(s) ?? 0) + 1);
        }
        return undefined;
    });
    return out;
}

function check(src: string, ts = false): { missing: string[]; extra: string[] } {
    const { program } = parse(src, { ts, jsx: false });
    const sem = createSemantic();
    analyze(sem, program);
    const idx = fromIndex(sem);
    const walked = fromWalk(program);
    const missing: string[] = [];
    const extra: string[] = [];
    for (const [sym, n] of walked) {
        const got = idx.get(sym) ?? 0;
        if (got < n) missing.push(`sym${sym}: index ${got} < walk ${n}`);
    }
    for (const [sym, n] of idx) {
        const w = walked.get(sym) ?? 0;
        if (n > w) extra.push(`sym${sym}: index ${n} > walk ${w}`);
    }
    return { missing, extra };
}

describe('resolvedReferences agrees with the full walk', () => {
    const CASES: [string, string][] = [
        ['straight line', 'function f(a){ let b = a; return b + b; }'],
        ['assignment write', 'function f(){ let a = 1; a = 2; return a; }'],
        ['update', 'function f(){ let a = 1; a++; return a; }'],
        ['closure capture', 'function f(a){ const g = () => a; return g(); }'],
        ['destructuring', 'function f(o){ const { x, y } = o; return x + y; }'],
        ['shadowing', 'function f(a){ { let a = 2; globalThis.g = a; } return a; }'],
        ['loop', 'function f(n){ let s = 0; for (let i = 0; i < n; i++) s += i; return s; }'],
        ['module scope', 'export const a = 1;\nexport function f(){ return a; }'],
        ['class', 'class K { m(){ return this.x; } }\nexport const k = new K();'],
    ];
    for (const [name, src] of CASES) {
        it(`no missing references: ${name}`, () => {
            const { missing } = check(src);
            expect(missing).toEqual([]);
        });
    }

    it('is complete across three.core.js', () => {
        const p = '/Users/isaacmason/Development/shakeup/llm/spikes/node_modules/three/build/three.core.js';
        if (!existsSync(p)) return;
        const { missing } = check(readFileSync(p, 'utf8'));
        expect(missing.slice(0, 10)).toEqual([]);
    }, 60000);

    it('is complete across a real TS module', () => {
        const p = '/Users/isaacmason/Development/crashcat/src/index.ts';
        if (!existsSync(p)) return;
        const { missing } = check(readFileSync(p, 'utf8'), true);
        expect(missing.slice(0, 10)).toEqual([]);
    }, 60000);

});

// The decisive equivalence: the index must reproduce `tallyRefs`' read/write COUNTS exactly, since that
// is the function it exists to replace. `x++` and `x += 1` count as BOTH a read and a write — oxc models
// this the same way (ReferenceFlags bits per Reference, not disjoint kinds).
describe('resolvedReferences reproduces tallyRefs read/write counts', () => {
    const countsFromIndex = (sem: ReturnType<typeof createSemantic>): Map<number, { reads: number; writes: number }> => {
        const out = new Map<number, { reads: number; writes: number }>();
        for (let sym = 1; sym < sem.resolvedReferences.length; sym++) {
            const list = sem.resolvedReferences[sym];
            if (list === undefined) continue;
            let reads = 0;
            let writes = 0;
            for (const e of list) {
                if (e.read) reads++;
                if (e.write) writes++;
            }
            if (reads > 0 || writes > 0) out.set(sym, { reads, writes });
        }
        return out;
    };

    const diff = (src: string, ts = false): string[] => {
        const { program } = parse(src, { ts, jsx: false });
        const sem = createSemantic();
        analyze(sem, program);
        const idx = countsFromIndex(sem);
        const walk2 = tallyRefs(program);
        const bad: string[] = [];
        for (const [sym, c] of walk2) {
            if (sym === 0) continue;
            const got = idx.get(sym) ?? { reads: 0, writes: 0 };
            if (got.reads !== c.reads || got.writes !== c.writes)
                bad.push(`sym${sym}: index r${got.reads}/w${got.writes} vs walk r${c.reads}/w${c.writes}`);
        }
        return bad;
    };

    const CASES: [string, string][] = [
        ['plain assignment', 'function f(){ let a = 1; a = 2; return a; }'],
        ['compound assignment', 'function f(){ let a = 1; a += 2; return a; }'],
        ['update', 'function f(){ let a = 1; a++; return a; }'],
        ['member target', 'function f(o){ o.x = 1; return o; }'],
        ['computed member target', 'function f(o, k){ o[k] = 1; return o; }'],
        ['destructuring assign', 'function f(o){ let a, b; ({ a, b } = o); return a + b; }'],
        ['array destructuring assign', 'function f(o){ let a; [a] = o; return a; }'],
        ['destructuring default', 'function f(o, d){ let a; [a = d] = o; return a; }'],
        ['for-of assign', 'function f(xs){ let x, s = 0; for (x of xs) s += x; return s; }'],
        ['for-in assign', 'function f(o){ let k, s = ""; for (k in o) s += k; return s; }'],
        ['for-of declare', 'function f(xs){ let s = 0; for (const x of xs) s += x; return s; }'],
        ['nested writes', 'function f(){ let a = 1, b = 2; a = b = 3; return a + b; }'],
    ];
    for (const [name, src] of CASES) {
        it(`matches on: ${name}`, () => {
            expect(diff(src)).toEqual([]);
        });
    }

    it('matches across three.core.js', () => {
        const p = '/Users/isaacmason/Development/shakeup/llm/spikes/node_modules/three/build/three.core.js';
        if (!existsSync(p)) return;
        expect(diff(readFileSync(p, 'utf8')).slice(0, 10)).toEqual([]);
    }, 60000);

    it('matches across a real TS module', () => {
        const p = '/Users/isaacmason/Development/crashcat/src/index.ts';
        if (!existsSync(p)) return;
        expect(diff(readFileSync(p, 'utf8'), true).slice(0, 10)).toEqual([]);
    }, 60000);
});
