import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { tallyRefs } from '../src/analysis/movement.ts';
import { walkRefIdents } from '../src/analysis/refs.ts';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { N, type Node, walkChildren } from '../src/ast.ts';
import { parse } from '../src/index.ts';
import { computePrelude } from '../src/passes/compress/prelude.ts';

// The compress prelude replaces FOUR independent full-program pre-passes with one walk. It is only
// safe if it reproduces each of them exactly — so these compare against the originals, on real code.

/** The original `countUses` from drop-unused. */
function countUses(program: Node): Map<number, number> {
    const uses = new Map<number, number>();
    walkRefIdents(program, (ident) => {
        if (ident.type !== N.IdentifierReference) return;
        if (ident.sym === 0) return;
        uses.set(ident.sym, (uses.get(ident.sym) ?? 0) + 1);
    });
    return uses;
}
/** The original shorthand scan from const-prop / alias-inline. */
function shorthandOf(program: Node): Set<number> {
    const out = new Set<number>();
    walkRefIdents(program, (ident, shp) => {
        if (shp !== null && ident.type === N.IdentifierReference) out.add(ident.sym);
    });
    return out;
}
/** The original `scanExports` from alias-inline. */
function exportedOf(program: Node): Set<number> {
    const out = new Set<number>();
    const scan = (n: Node): void => {
        if (n.type === N.ExportSpecifier) {
            const local = (n.data as { local: Node }).local;
            if (local.type === N.IdentifierReference) out.add((local as { sym: number }).sym);
        }
        walkChildren(n, scan);
    };
    scan(program);
    return out;
}

function diffs(src: string, ts = false): string[] {
    const { program } = parse(src, { ts, jsx: false });
    const sem = createSemantic();
    analyze(sem, program);
    const p = computePrelude(program);
    const bad: string[] = [];

    const refs = tallyRefs(program);
    for (const [sym, c] of refs) {
        const g = p.refs.get(sym);
        if (g === undefined) bad.push(`refs sym${sym}: missing`);
        else if (g.reads !== c.reads || g.writes !== c.writes)
            bad.push(`refs sym${sym}: prelude r${g.reads}/w${g.writes} vs tally r${c.reads}/w${c.writes}`);
    }
    for (const [sym] of p.refs) if (!refs.has(sym)) bad.push(`refs sym${sym}: extra`);

    const uses = countUses(program);
    for (const [sym, n] of uses) if ((p.uses.get(sym) ?? 0) !== n) bad.push(`uses sym${sym}: ${p.uses.get(sym)} vs ${n}`);
    for (const [sym] of p.uses) if (!uses.has(sym)) bad.push(`uses sym${sym}: extra`);

    const sh = shorthandOf(program);
    for (const s of sh) if (!p.shorthand.has(s)) bad.push(`shorthand sym${s}: missing`);
    for (const s of p.shorthand) if (!sh.has(s)) bad.push(`shorthand sym${s}: extra`);

    const ex = exportedOf(program);
    for (const s of ex) if (s !== 0 && !p.exported.has(s)) bad.push(`exported sym${s}: missing`);
    for (const s of p.exported) if (!ex.has(s)) bad.push(`exported sym${s}: extra`);

    return bad;
}

describe('computePrelude reproduces all four pre-passes', () => {
    const CASES: [string, string][] = [
        ['plain + compound + update', 'function f(){ let a = 1; a += 2; a++; return a; }'],
        ['member targets', 'function f(o, k){ o.x = 1; o[k] = 2; return o; }'],
        ['destructuring assign', 'function f(o){ let a, b; ({ a, b } = o); [a] = o; return a + b; }'],
        ['destructuring default', 'function f(o, d){ let a; [a = d] = o; return a; }'],
        ['for-of assign vs declare', 'function f(xs){ let x, s = 0; for (x of xs) s += x; for (const y of xs) s += y; return s; }'],
        ['shorthand property', 'function f(a){ const o = { a }; return o; }'],
        ['shorthand with default', 'function f(o){ const { a = 1 } = o; return a; }'],
        ['bare export specifier', 'const b = 1;\nexport { b };\n'],
        ['export + alias', 'const b = 1;\nexport { b as c };\n'],
        ['chained assignment', 'function f(){ let a, b; a = b = 3; return a + b; }'],
        ['class + this', 'class K { m(){ return this.x; } }\nexport const k = new K();'],
    ];
    for (const [name, src] of CASES) {
        it(`matches on: ${name}`, () => {
            expect(diffs(src)).toEqual([]);
        });
    }

    it('matches across three.core.js', () => {
        const p = '/Users/isaacmason/Development/shakeup/llm/spikes/node_modules/three/build/three.core.js';
        if (!existsSync(p)) return;
        expect(diffs(readFileSync(p, 'utf8')).slice(0, 10)).toEqual([]);
    }, 60000);

    it('matches across a real TS module', () => {
        const p = '/Users/isaacmason/Development/crashcat/src/index.ts';
        if (!existsSync(p)) return;
        expect(diffs(readFileSync(p, 'utf8'), true).slice(0, 10)).toEqual([]);
    }, 60000);
});
