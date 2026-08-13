/**
 * G2 semantic differential — eslint-scope over meriyah's ESTree as an
 * independent oracle for our scope/symbol/reference model (src/semantic.ts).
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
 * actionable table. The exceptions ledger starts empty; entries need a reason.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as meriyah from 'meriyah';
import * as escope from 'eslint-scope';
import { parse } from '../src/parser.ts';
import { A, createAst, walk, text, N, type Ast, type NodeId } from '../src/ast.ts';
import { analyze, createSemantic, symbolOf, type Semantic } from '../src/analysis/semantic.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const THREE = resolve(REPO, 'llm/spikes/node_modules/three/build/three.core.js');

/* ------------------------------------------------------------------ helpers */

/** meriyah with `ranges:true` puts .start/.end on every node; the estree types
 *  don't declare them, so read positions through this narrowing helper. */
const pos = (n: unknown): number => (n as { start: number }).start;
const nameOf = (n: unknown): string => (n as { name: string }).name;

type Analyzed = { ast: Ast; program: NodeId; sem: Semantic };

function analyzeSource(src: string, ts: boolean): Analyzed {
    const { ast, program } = parse(createAst(), src, { ts });
    expect(ast.errors).toEqual([]);
    const sem = createSemantic();
    analyze(sem, ast, program);
    return { ast, program, sem };
}

/** Map a start offset -> our Ident NodeId (Ident-typed nodes only). */
function identByStart(ast: Ast): Map<number, NodeId> {
    const m = new Map<number, NodeId>();
    for (let id = 1; id < ast.nodeCount; id++) {
        if (ast.type[id] === N.Ident) m.set(ast.start[id], id);
    }
    return m;
}

/** every Ident NodeId (in source order) whose text is `name`. */
function identsNamed(a: Analyzed, name: string): NodeId[] {
    const out: NodeId[] = [];
    walk(a.ast, a.program, (id) => {
        if (a.ast.type[id] === N.Ident && text(a.ast, id) === name) out.push(id);
    });
    return out;
}

/** resolved symbol id for the (single) Ident named `name` matching a predicate. */
function symAt(a: Analyzed, name: string, start: number): number {
    const id = identsNamed(a, name).find((n) => a.ast.start[n] === start);
    expect(id, `no Ident "${name}" @${start}`).toBeDefined();
    return symbolOf(a.sem, id!);
}

/** start offset of the declaring Ident for a resolved symbol. */
function declStart(a: Analyzed, sym: number): number {
    return a.ast.start[a.sem.symDecl[sym]];
}

/* ============================================================ LAYER 1: oracle */

/**
 * DOCUMENTED ADJUSTMENTS to the eslint-scope oracle on three.core.js. Each is a
 * structural modelling difference, NOT a silent skip: it carries a reason and a
 * minimal repro. If the residual after applying these is non-empty, the suite
 * fails with a table.
 *
 * A1 (unresolved `arguments`): eslint-scope materializes an implicit `arguments`
 *     variable inside every non-arrow function scope, so references to
 *     `arguments` resolve there and never appear in globalScope.through. Our v1
 *     does not model the implicit `arguments` binding (see the "Known v1
 *     simplifications" comment in src/semantic.ts — params+body share one scope,
 *     no implicit bindings), so every `arguments` use lands in `unresolved`.
 *     Repro: `function f(){ return arguments.length; }` — eslint-scope resolves
 *     `arguments`; our symbolOf is 0 and it's pushed to `unresolved`.
 *     Adjustment: exclude Idents literally named `arguments` from BOTH the
 *     unresolved-set comparison (they are ours-only) — but assert that the
 *     ours-only residual is EXACTLY the set of `arguments` uses, nothing else.
 *
 * A2 (declared-symbol count): our model gives a class declaration ONE symbol
 *     bound from both namespaces (src/semantic.ts declareDualNs — a single
 *     identity so exports/renames can't split, which the bundler requires).
 *     eslint-scope models a class declaration as TWO variables (the outer-scope
 *     binding + the class's own inner name binding). So:
 *         ours == theirs - namedClassDeclCount
 *     (class EXPRESSIONS have only the inner name on both sides: 1 == 1.)
 */

/** collect resolved-reference divergences (position-keyed). */
type RefDiverge = { start: number; name: string; kind: string; ours: string; theirs: string; excerpt: string };

function collectRefDivergences(src: string, sm: escope.ScopeManager, a: Analyzed): RefDiverge[] {
    const byStart = identByStart(a.ast);
    const diffs: RefDiverge[] = [];
    for (const scope of sm.scopes) {
        for (const r of scope.references) {
            const v = r.resolved;
            if (!v || v.defs.length < 1) continue; // only resolved-to-a-real-def refs
            const start = pos(r.identifier);
            const name = nameOf(r.identifier);
            const ourId = byStart.get(start);
            if (ourId === undefined) {
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
            const sym = symbolOf(a.sem, ourId);
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
            // eslint-scope's def name ranges AND the variable's identifier ranges
            // are both acceptable declaring positions (redeclared vars have many).
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
    // meriyah's ESTree types differ nominally from @types/estree (and its nodes
    // carry .start/.end from ranges:true that the estree types don't declare);
    // eslint-scope only reads structurally, so cast at the boundary.
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
        const ourUnres = new Set<number>(a.sem.unresolved.map((id) => a.ast.start[id]));

        const oursOnly = [...ourUnres].filter((s) => !theirThrough.has(s));
        const theirsOnly = [...theirThrough].filter((s) => !ourUnres.has(s));

        // A1: the ONLY ours-only entries permitted are `arguments` uses.
        const startToName = new Map<number, string>();
        for (const id of a.sem.unresolved) startToName.set(a.ast.start[id], text(a.ast, id));
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

        // Positive assertion of the adjustment: every ours-only entry is `arguments`.
        expect(oursOnly.every((s) => startToName.get(s) === 'arguments')).toBe(true);
        expect(theirsOnly).toEqual([]);
        // Sanity: three.core.js really does use `arguments` (non-trivial adjustment).
        expect(oursOnly.length).toBeGreaterThan(0);
    });

    it('declared-symbol count matches eslint-scope variables-with-a-def (A2)', () => {
        // eslint-scope: variables carrying >=1 def. `arguments` variables have 0
        // defs so they're already excluded; global scope has 0 user variables
        // (no module/global machinery vars for this input); no `var` redeclaration
        // and no function-expression-name scopes in three.core.js — all verified
        // by the spike, so the count is a clean structural comparison.
        let theirVarsWithDef = 0;
        for (const scope of sm.scopes) {
            for (const v of scope.variables) if (v.defs.length >= 1) theirVarsWithDef++;
        }
        const ourSymbols = a.sem.symCount - 1;
        // A2 adjustment: eslint-scope's outer+inner class-name pair vs our single
        // dual-namespace symbol — subtract one per NAMED CLASS DECLARATION.
        let namedClassDecls = 0;
        walk(a.ast, a.program, (id) => {
            if (a.ast.type[id] === N.ClassDecl && A.ClassDecl.id(a.ast, id) !== 0) namedClassDecls++;
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

/*
 * (History: this harness originally found that the parser consumed `<T>` lists
 * without emitting TSTypeParams/TSTypeParam nodes — raw list refs were stored
 * into child slots unwrapped, so FuncDecl.typeParams even aliased the first
 * param Ident. Fixed in the main loop: tryParseTypeParams/tryParseTypeArgsInType
 * now wrap their lists in proper nodes; the pinned known-bug guard below became
 * the positive regression test.)
 */

describe('semantic TS snippet expectations', () => {
    it('interface name resolves in the type namespace (TSTypeRef head)', () => {
        const a = analyzeSource('interface Foo {}\nlet x: Foo;', true);
        const decl = identsNamed(a, 'Foo')[0];
        const use = identsNamed(a, 'Foo').find((id) => a.ast.start[id] === 24)!;
        expect(symbolOf(a.sem, use)).not.toBe(0);
        expect(a.sem.symDecl[symbolOf(a.sem, use)]).toBe(decl);
    });

    it('type-alias name resolves in the type namespace', () => {
        const a = analyzeSource('type Bar = number;\nlet y: Bar;', true);
        const use = identsNamed(a, 'Bar').find((id) => a.ast.start[id] === 26)!;
        expect(symbolOf(a.sem, use)).not.toBe(0);
        expect(declStart(a, symbolOf(a.sem, use))).toBe(5);
    });

    it('class resolves from BOTH value and type namespaces', () => {
        const a = analyzeSource('class C {}\nlet z: C = new C();', true);
        const typeUse = symAt(a, 'C', 18); // `: C` — type namespace
        const valueUse = symAt(a, 'C', 26); // `new C()` — value namespace
        expect(typeUse).not.toBe(0);
        expect(valueUse).not.toBe(0);
        // both declaring idents are the class name at start 6
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

        // enum member initializer references an outer value binding
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
            // a real TSTypeParams node (with its TSTypeParam child) exists
            let tpNodes = 0;
            walk(a.ast, a.program, (id) => {
                if (a.ast.type[id] === N.TSTypeParams || a.ast.type[id] === N.TSTypeParam) tpNodes++;
            });
            expect(tpNodes, `no type-param nodes for: ${src}`).toBeGreaterThanOrEqual(2);
            // every `TP` occurrence resolves to the SAME symbol (decl + all refs)
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

        // Source A: `alpha` is a real binding, referenced.
        const A1 = parse(createAst(), 'const alpha = 1; alpha;', { ts: false });
        expect(A1.ast.errors).toEqual([]);
        analyze(sem, A1.ast, A1.program);
        const aIdents: NodeId[] = [];
        walk(A1.ast, A1.program, (id) => {
            if (A1.ast.type[id] === N.Ident && text(A1.ast, id) === 'alpha') aIdents.push(id);
        });
        expect(aIdents.length).toBe(2);
        expect(symbolOf(sem, aIdents[1])).not.toBe(0); // resolved in A

        // Source B (same Semantic struct): references `alpha` but never declares
        // it. If A's bindings leaked, `alpha` would (wrongly) resolve here.
        const B = parse(createAst(), 'const beta = 2; alpha; beta;', { ts: false });
        expect(B.ast.errors).toEqual([]);
        analyze(sem, B.ast, B.program);

        const bAlpha: NodeId[] = [];
        const bBeta: NodeId[] = [];
        walk(B.ast, B.program, (id) => {
            if (B.ast.type[id] !== N.Ident) return;
            const t = text(B.ast, id);
            if (t === 'alpha') bAlpha.push(id);
            if (t === 'beta') bBeta.push(id);
        });

        // `alpha` is now a stale name from A: must be unresolved in B.
        expect(bAlpha.length).toBe(1);
        expect(symbolOf(sem, bAlpha[0])).toBe(0);
        expect(sem.unresolved.map((id) => text(B.ast, id))).toContain('alpha');

        // `beta` (declared in B) resolves normally.
        const betaUse = bBeta.find((id) => symbolOf(sem, id) !== 0 && B.ast.start[id] > 16);
        expect(betaUse).toBeDefined();
        expect(symbolOf(sem, betaUse!)).not.toBe(0);
        expect(sem.unresolved.map((id) => text(B.ast, id))).not.toContain('beta');
    });

    it('symbol tables reset between runs (symCount reflects only the latest source)', () => {
        const sem = createSemantic();

        const big = parse(createAst(), 'const a=1,b=2,c=3,d=4,e=5;', { ts: false });
        analyze(sem, big.ast, big.program);
        const afterBig = sem.symCount;
        expect(afterBig - 1).toBe(5);

        const small = parse(createAst(), 'const only = 1;', { ts: false });
        analyze(sem, small.ast, small.program);
        expect(sem.symCount - 1).toBe(1); // not carried over from the bigger run
    });
});
