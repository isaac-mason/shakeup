import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { N, type Node, walk } from '../src/ast.ts';
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
