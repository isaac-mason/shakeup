/**
 * G2 semantic differential — eslint-scope over meriyah's ESTree as an
 * independent oracle for our scope/symbol/reference model (src/analysis/semantic.ts).
 *
 * Three layers:
 *   1. eslint-scope differential on three.core.js (position-keyed): resolved
 *      references, unresolved-globals set, declared-symbol count.
 *   2. TS-side hand-written snippet expectations (eslint-scope can't oracle TS).
 *   3. Reuse/warm test: re-analyze with the same Semantic struct on a second
 *      source; no bindings from the first source may leak.
 *
 * Discipline (mirrors tst/differential.test.ts's KNOWN_DIFFS): every divergence
 * from the oracle is either (a) a documented structural ADJUSTMENT with a reason
 * and a minimal repro, or (b) a genuine bug that fails the suite with an
 * actionable table.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as meriyah from 'meriyah';
import * as escope from 'eslint-scope';
import { parse } from '../src/parser.ts';
import { walk, N, isIdentifier, type Node } from '../src/ast.ts';
import { analyze, createSemantic, symbolOf, type Semantic } from '../src/analysis/semantic.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const THREE = resolve(REPO, 'llm/spikes/node_modules/three/build/three.core.js');

/* ------------------------------------------------------------------ helpers */

/** meriyah with `ranges:true` puts .start/.end on every node; the estree types
 *  don't declare them, so read positions through this narrowing helper. */
const pos = (n: unknown): number => (n as { start: number }).start;
const nameOf = (n: unknown): string => (n as { name: string }).name;

type Analyzed = { program: Node; sem: Semantic; nodeCount: number };

function analyzeSource(src: string, ts: boolean): Analyzed {
    const { program, errors, nodeCount } = parse(src, { ts });
    expect(errors).toEqual([]);
    const sem = createSemantic();
    analyze(sem, program, nodeCount);
    return { program, sem, nodeCount };
}

/** Map a start offset -> our symbol-carrying identifier node. Only the resolving
 * roles (IdentifierReference / BindingIdentifier) are indexed: an eslint-scope
 * reference always sits at a resolving position, and a pure-name role
 * (IdentifierName/LabelIdentifier) can share a start with a resolving one (e.g.
 * `export { a }` — local ref + exported name at the same offset) and must not
 * shadow it in this map. */
function identByStart(a: Analyzed): Map<number, Node> {
    const m = new Map<number, Node>();
    walk(a.program, (n) => {
        if (n.type === N.IdentifierReference || n.type === N.BindingIdentifier) m.set(n.start, n);
    });
    return m;
}

/** every Ident node (in source order) whose name is `name`. */
function identsNamed(a: Analyzed, name: string): Node[] {
    const out: Node[] = [];
    walk(a.program, (n) => {
        if (isIdentifier(n.type) && n.name === name) out.push(n);
    });
    return out;
}

/** resolved symbol id for the (single) Ident named `name` matching a start. */
function symAt(a: Analyzed, name: string, start: number): number {
    const id = identsNamed(a, name).find((n) => n.start === start);
    expect(id, `no Ident "${name}" @${start}`).toBeDefined();
    return symbolOf(a.sem, id!);
}

/** start offset of the declaring Ident for a resolved symbol. */
function declStart(a: Analyzed, sym: number): number {
    return a.sem.symDecl[sym]!.start;
}

/* ============================================================ LAYER 1: oracle */

/**
 * DOCUMENTED ADJUSTMENTS to the eslint-scope oracle on three.core.js.
 *
 * A1 (unresolved `arguments`): eslint-scope materializes an implicit `arguments`
 *     variable inside every non-arrow function scope. Our v1 does not model the
 *     implicit `arguments` binding (params+body share one scope, no implicit
 *     bindings), so every `arguments` use lands in `unresolved`. Adjustment:
 *     exclude Idents literally named `arguments` from the unresolved-set
 *     comparison, and assert the ours-only residual is EXACTLY `arguments` uses.
 *
 * A2 (declared-symbol count): our model gives a class declaration ONE symbol
 *     bound from both namespaces (declareDualNs). eslint-scope models a class
 *     declaration as TWO variables (outer-scope binding + inner name binding).
 *     So: ours == theirs - namedClassDeclCount.
 */

type RefDiverge = { start: number; name: string; kind: string; ours: string; theirs: string; excerpt: string };

function collectRefDivergences(src: string, sm: escope.ScopeManager, a: Analyzed): RefDiverge[] {
    const byStart = identByStart(a);
    const diffs: RefDiverge[] = [];
    for (const scope of sm.scopes) {
        for (const r of scope.references) {
            const v = r.resolved;
            if (!v || v.defs.length < 1) continue; // only resolved-to-a-real-def refs
            const start = pos(r.identifier);
            const name = nameOf(r.identifier);
            const ourNode = byStart.get(start);
            if (ourNode === undefined) {
                diffs.push({
                    start,
                    name,
                    kind: 'no-ident',
                    ours: 'no Ident node at this start',
                    theirs: `resolved to "${v.name}"`,
                    excerpt: src.slice(start - 8, start + 12),
                });
                continue;
            }
            const sym = symbolOf(a.sem, ourNode);
            if (sym === 0) {
                diffs.push({
                    start,
                    name,
                    kind: 'unresolved',
                    ours: 'symbolOf === 0',
                    theirs: `resolved to "${v.name}"`,
                    excerpt: src.slice(start - 8, start + 12),
                });
                continue;
            }
            const ourDecl = declStart(a, sym);
            const theirDecls = new Set<number>([
                ...v.defs.map((d) => pos(d.name)),
                ...v.identifiers.map((i) => pos(i)),
            ]);
            if (!theirDecls.has(ourDecl)) {
                diffs.push({
                    start,
                    name,
                    kind: 'decl-mismatch',
                    ours: `decl @${ourDecl}`,
                    theirs: `decl @${[...theirDecls].join(',')}`,
                    excerpt: src.slice(start - 8, start + 12),
                });
            }
        }
    }
    return diffs;
}

function fmtRefTable(diffs: RefDiverge[]): string {
    const rows = diffs
        .slice(0, 40)
        .map(
            (d) =>
                `  @${String(d.start).padStart(8)} ${d.name.padEnd(16)} [${d.kind}] ours=${d.ours} theirs=${d.theirs}  src=${JSON.stringify(d.excerpt)}`,
        )
        .join('\n');
    return `\nRESOLVED-REFERENCE divergences vs eslint-scope (${diffs.length} total, first 40):\n${rows}\n`;
}

describe('semantic differential vs eslint-scope (three.core.js)', () => {
    const src = readFileSync(THREE, 'utf8');
    const estree = meriyah.parse(src, { module: true, next: true, ranges: true });
    const sm = escope.analyze(estree as unknown as Parameters<typeof escope.analyze>[0], {
        ecmaVersion: 2022,
        sourceType: 'module',
    });
    const a = analyzeSource(src, false);

    it('every resolved eslint-scope reference resolves to the same declaration for us', () => {
        const diffs = collectRefDivergences(src, sm, a);
        if (diffs.length > 0) expect.fail(fmtRefTable(diffs));
        expect(diffs).toEqual([]);
    });

    it('unresolved-globals set matches (modulo A1: implicit `arguments`)', () => {
        const gs = sm.globalScope!;
        const theirThrough = new Set<number>(gs.through.map((r) => pos(r.identifier)));
        const ourUnres = new Set<number>(a.sem.unresolved.map((n) => n.start));

        const oursOnly = [...ourUnres].filter((s) => !theirThrough.has(s));
        const theirsOnly = [...theirThrough].filter((s) => !ourUnres.has(s));

        // A1: the ONLY ours-only entries permitted are `arguments` uses.
        const startToName = new Map<number, string>();
        for (const n of a.sem.unresolved) startToName.set(n.start, n.name);
        const oursOnlyNonArguments = oursOnly.filter((s) => startToName.get(s) !== 'arguments');

        if (oursOnlyNonArguments.length > 0 || theirsOnly.length > 0) {
            const o = oursOnlyNonArguments
                .slice(0, 20)
                .map((s) => `  OURS-only @${s} "${startToName.get(s)}" :: ${JSON.stringify(src.slice(s - 8, s + 12))}`)
                .join('\n');
            const t = theirsOnly
                .slice(0, 20)
                .map((s) => `  THEIRS-only @${s} :: ${JSON.stringify(src.slice(s - 8, s + 12))}`)
                .join('\n');
            expect.fail(
                `\nUNRESOLVED-SET divergence beyond documented adjustment A1 (implicit \`arguments\`):\n${o}\n${t}\n`,
            );
        }

        expect(oursOnly.every((s) => startToName.get(s) === 'arguments')).toBe(true);
        expect(theirsOnly).toEqual([]);
        expect(oursOnly.length).toBeGreaterThan(0);
    });

    it('declared-symbol count matches eslint-scope variables-with-a-def (A2)', () => {
        let theirVarsWithDef = 0;
        for (const scope of sm.scopes) {
            for (const v of scope.variables) if (v.defs.length >= 1) theirVarsWithDef++;
        }
        const ourSymbols = a.sem.symCount - 1;
        // A2 adjustment: eslint-scope's outer+inner class-name pair vs our single
        // dual-namespace symbol — subtract one per NAMED CLASS DECLARATION.
        let namedClassDecls = 0;
        walk(a.program, (n) => {
            if (n.type === N.ClassDeclaration && n.data.id !== null) namedClassDecls++;
        });
        const expected = theirVarsWithDef - namedClassDecls;
        if (ourSymbols !== expected) {
            expect.fail(
                `\nDeclared-symbol count mismatch: ours(symCount-1)=${ourSymbols}, theirs(vars-with-def)=${theirVarsWithDef},\n` +
                    `namedClassDecls=${namedClassDecls}, expected ours == theirs - namedClassDecls == ${expected}.\n` +
                    `See A2 doc comment: one dual-namespace symbol per class decl on our side vs eslint-scope's\n` +
                    `outer+inner variable pair. Re-derive rather than slacken if this drifts.\n`,
            );
        }
        expect(ourSymbols).toBe(expected);
    });
});

/* ================================================= LAYER 2: TS snippet oracle */

describe('semantic TS snippet expectations', () => {
    it('interface name resolves in the type namespace (TSTypeRef head)', () => {
        const a = analyzeSource('interface Foo {}\nlet x: Foo;', true);
        const decl = identsNamed(a, 'Foo')[0];
        const use = identsNamed(a, 'Foo').find((n) => n.start === 24)!;
        expect(symbolOf(a.sem, use)).not.toBe(0);
        expect(a.sem.symDecl[symbolOf(a.sem, use)]).toBe(decl);
    });

    it('type-alias name resolves in the type namespace', () => {
        const a = analyzeSource('type Bar = number;\nlet y: Bar;', true);
        const use = identsNamed(a, 'Bar').find((n) => n.start === 26)!;
        expect(symbolOf(a.sem, use)).not.toBe(0);
        expect(declStart(a, symbolOf(a.sem, use))).toBe(5);
    });

    it('class resolves from BOTH value and type namespaces', () => {
        const a = analyzeSource('class C {}\nlet z: C = new C();', true);
        const typeUse = symAt(a, 'C', 18); // `: C` — type namespace
        const valueUse = symAt(a, 'C', 26); // `new C()` — value namespace
        expect(typeUse).not.toBe(0);
        expect(valueUse).not.toBe(0);
        expect(declStart(a, typeUse)).toBe(6);
        expect(declStart(a, valueUse)).toBe(6);
    });

    it('enum resolves from both namespaces; member init sees outer const (value ns)', () => {
        const a = analyzeSource('enum E { A, B }\nlet e: E = E.A;', true);
        const typeUse = symAt(a, 'E', 23); // `: E`
        const valueUse = symAt(a, 'E', 27); // `E.A`
        expect(typeUse).not.toBe(0);
        expect(valueUse).not.toBe(0);
        expect(declStart(a, typeUse)).toBe(5);
        expect(declStart(a, valueUse)).toBe(5);

        const b = analyzeSource('const K = 5;\nenum E2 { X = K }', true);
        const kUse = symAt(b, 'K', 27);
        expect(kUse).not.toBe(0);
        expect(declStart(b, kUse)).toBe(6);
    });

    it('`import type` binding resolves for a later type reference', () => {
        const a = analyzeSource('import type { T } from "./m";\nlet a: T;', true);
        const use = symAt(a, 'T', 37);
        expect(use).not.toBe(0);
        expect(declStart(a, use)).toBe(14); // the imported local `T`
    });

    it('`typeof X` in type position resolves X in the VALUE namespace', () => {
        const a = analyzeSource('const obj = { a: 1 };\ntype O = typeof obj;', true);
        const use = symAt(a, 'obj', 38); // inside `typeof obj`
        expect(use).not.toBe(0);
        expect(declStart(a, use)).toBe(6); // the const `obj`
    });

    it('shadowing across nested functions resolves to the specific declaring ident', () => {
        const a = analyzeSource('const v = 1;\nfunction g() { const v = 2; return v; }', false);
        const outer = symAt(a, 'v', 6); // outer const v
        const innerDecl = symAt(a, 'v', 34); // inner const v
        const innerUse = symAt(a, 'v', 48); // `return v` -> inner
        expect(declStart(a, outer)).toBe(6);
        expect(declStart(a, innerDecl)).toBe(34);
        expect(declStart(a, innerUse)).toBe(34); // shadows outer
        expect(outer).not.toBe(innerUse);
    });

    it('var declarations hoist out of blocks to the enclosing function/module scope', () => {
        const a = analyzeSource('{ var h = 1; }\nh;', false);
        const decl = symAt(a, 'h', 6);
        const use = symAt(a, 'h', 15); // `h;` after the block
        expect(decl).not.toBe(0);
        expect(use).toBe(decl); // hoisted binding is visible outside the block
    });

    it('catch parameter binds and its body reference resolves to it', () => {
        const a = analyzeSource('try {} catch (err) { err; }', false);
        const param = symAt(a, 'err', 14);
        const use = symAt(a, 'err', 21);
        expect(param).not.toBe(0);
        expect(use).toBe(param);
    });

    it('regression: type parameters resolve inside their scope (all declaration forms)', () => {
        const forms = [
            'function f<TP>(x: TP): TP { return x; }',
            'const g = <TP>(x: TP): TP => x;',
            'class C<TP> { m(x: TP) { return x; } }',
            'interface I<TP> { x: TP; }',
            'type A<TP> = TP[];',
        ];
        for (const src of forms) {
            const a = analyzeSource(src, true);
            let tpNodes = 0;
            walk(a.program, (n) => {
                if (n.type === N.TSTypeParameterDeclaration || n.type === N.TSTypeParameter) tpNodes++;
            });
            expect(tpNodes, `no type-param nodes for: ${src}`).toBeGreaterThanOrEqual(2);
            const ids = identsNamed(a, 'TP');
            expect(ids.length, `no TP idents found in: ${src}`).toBeGreaterThanOrEqual(2);
            const sym = symbolOf(a.sem, ids[0]);
            expect(sym, `TP unresolved in: ${src}`).not.toBe(0);
            for (const id of ids) expect(symbolOf(a.sem, id), `TP diverged in: ${src}`).toBe(sym);
        }
    });
});

/* ================================================ LAYER 3: reuse / warm reruns */

describe('semantic reuse (warm re-analyze does not leak bindings)', () => {
    it('a name declared only in source A does not resolve in source B', () => {
        const sem = createSemantic();

        const A1 = parse('const alpha = 1; alpha;', { ts: false });
        expect(A1.errors).toEqual([]);
        analyze(sem, A1.program, A1.nodeCount);
        const aIdents: Node[] = [];
        walk(A1.program, (n) => {
            if (isIdentifier(n.type) && n.name === 'alpha') aIdents.push(n);
        });
        expect(aIdents.length).toBe(2);
        expect(symbolOf(sem, aIdents[1])).not.toBe(0); // resolved in A

        const B = parse('const beta = 2; alpha; beta;', { ts: false });
        expect(B.errors).toEqual([]);
        analyze(sem, B.program, B.nodeCount);

        const bAlpha: Node[] = [];
        const bBeta: Node[] = [];
        walk(B.program, (n) => {
            if (!isIdentifier(n.type)) return;
            if (n.name === 'alpha') bAlpha.push(n);
            if (n.name === 'beta') bBeta.push(n);
        });

        // `alpha` is now a stale name from A: must be unresolved in B.
        expect(bAlpha.length).toBe(1);
        expect(symbolOf(sem, bAlpha[0])).toBe(0);
        expect(sem.unresolved.map((n) => n.name)).toContain('alpha');

        // `beta` (declared in B) resolves normally.
        const betaUse = bBeta.find((n) => symbolOf(sem, n) !== 0 && n.start > 16);
        expect(betaUse).toBeDefined();
        expect(symbolOf(sem, betaUse!)).not.toBe(0);
        expect(sem.unresolved.map((n) => n.name)).not.toContain('beta');
    });

    it('symbol tables reset between runs (symCount reflects only the latest source)', () => {
        const sem = createSemantic();

        const big = parse('const a=1,b=2,c=3,d=4,e=5;', { ts: false });
        analyze(sem, big.program, big.nodeCount);
        const afterBig = sem.symCount;
        expect(afterBig - 1).toBe(5);

        const small = parse('const only = 1;', { ts: false });
        analyze(sem, small.program, small.nodeCount);
        expect(sem.symCount - 1).toBe(1); // not carried over from the bigger run
    });
});
