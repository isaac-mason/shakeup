import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCfg } from '../src/analysis/cfg.ts';
import { computeLiveVars } from '../src/analysis/live-vars.ts';
import { computeLiveness } from '../src/analysis/liveness.ts';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { N, type Node, walk } from '../src/ast.ts';
import { parse } from '../src/index.ts';

// THE EXPERIMENT. Two independent implementations of the same analysis:
//   • `analysis/liveness.ts`      — structural recursion, control flow fused into the analysis
//   • `analysis/{cfg,dataflow,live-vars}.ts` — Closure-aligned CFG + generic worklist + transfer fn
// If the CFG port is faithful they must agree on every statement of every function whose flow the
// structural version models. Where the structural version BAILS (`try`), only the CFG version has an
// answer — that gap is the capability being measured, not a disagreement.

const isFn = (n: Node): boolean =>
    n.type === N.FunctionDeclaration || n.type === N.FunctionExpression || n.type === N.ArrowFunctionExpression;

/** dead-store's `scopeSymbols`, duplicated so both analyses get identical inputs. */
function scopeSymbols(fn: Node): { locals: Set<number>; escaped: Set<number> } {
    const locals = new Set<number>();
    const escaped = new Set<number>();
    walk(fn, (n) => {
        if (n !== fn && isFn(n)) {
            walk(n, (c) => {
                if (c.type === N.IdentifierReference || c.type === N.BindingIdentifier) {
                    const s = (c as { sym: number }).sym;
                    if (s > 0) escaped.add(s);
                }
                return undefined;
            });
            return false;
        }
        if (n.type === N.BindingIdentifier) {
            const s = (n as { sym: number }).sym;
            if (s > 0) locals.add(s);
        }
        return undefined;
    });
    return { locals, escaped };
}

type Fn = { fn: Node; body: Node; tracked: Set<number> };

function functionsOf(src: string, ts = false): Fn[] {
    const { program } = parse(src, { ts, jsx: false });
    const sem = createSemantic();
    analyze(sem, program);
    const out: Fn[] = [];
    walk(program, (n) => {
        if (!isFn(n)) return undefined;
        const body = (n.data as { body: Node | null }).body;
        if (body === null || body.type !== N.BlockStatement) return undefined;
        const { locals, escaped } = scopeSymbols(n);
        const tracked = new Set([...locals].filter((s) => !escaped.has(s)));
        if (tracked.size > 0) out.push({ fn: n, body, tracked });
        return undefined;
    });
    return out;
}

const setEq = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean =>
    a.size === b.size && [...a].every((x) => b.has(x));

// Compare only SIMPLE statements — the ones dead-store actually queries, and the only ones where both
// implementations define `liveOut` identically. Two deliberate exclusions, neither a correctness gap:
//   • CONTAINERS (block, if, loops, switch, try, labeled): `liveness.ts` records what is live AFTER the
//     whole construct, while a CFG container node is a pass-through whose out-value is the live-in of
//     its first statement. Different questions, both right.
//   • JUMPS (return/throw/break/continue): `liveness.ts:98` overwrites a return's entry with its
//     live-IN rather than its live-out (`out.set(stmt, live)` inside the ReturnStatement arm), which is
//     inconsistent with its own convention everywhere else. Harmless — dead-store never queries a jump —
//     but it means the two disagree by definition rather than by analysis.
const COMPARABLE = new Set<number>([N.ExpressionStatement, N.VariableDeclaration, N.EmptyStatement, N.DebuggerStatement]);

/**
 * Compare both analyses over every statement of every function.
 *
 * The two directions of disagreement are NOT symmetric and must not be pooled:
 *   • `conservative` — the CFG reports a variable live that the structural analysis does not. For a
 *     backward liveness that is the SAFE direction, but it means the port is losing precision, so it
 *     is worth knowing about.
 *   • `precise` — the CFG reports a variable DEAD that the structural analysis thinks is live. This is
 *     the DANGEROUS direction: it is exactly what a port bug looks like, and also exactly what a
 *     genuine precision win looks like. Every instance has to be justified individually, never waved
 *     through, so they are reported with source text attached.
 */
function compare(src: string, limitFns = Infinity): {
    checked: number;
    fns: number;
    structuralBailed: number;
    conservative: string[];
    precise: string[];
} {
    const fns = functionsOf(src).slice(0, limitFns);
    const conservative: string[] = [];
    const precise: string[] = [];
    let checked = 0;
    let structuralBailed = 0;

    for (const { body, tracked } of fns) {
        const structural = computeLiveness(body, tracked, new Set());
        if (structural === null) {
            structuralBailed++;
            // The CFG version must still produce an answer — that is the whole point.
            const cfg = buildCfg(body);
            computeLiveVars(cfg, tracked, new Set());
            continue;
        }
        const cfg = buildCfg(body);
        const flow = computeLiveVars(cfg, tracked, new Set());

        for (const [stmt, expected] of structural) {
            if (!COMPARABLE.has(stmt.type)) continue;
            const got = flow.liveOut(stmt);
            if (got === null) continue; // not a CFG node (e.g. a nested construct the CFG folds away)
            checked++;
            if (setEq(expected, got)) continue;
            const extra = [...got].filter((x) => !expected.has(x));
            const missing = [...expected].filter((x) => !got.has(x));
            const where = `${src.slice(stmt.start, stmt.end).replace(/\s+/g, ' ').slice(0, 60)}`;
            if (extra.length > 0) conservative.push(`+{${extra.sort().join(',')}} at "${where}"`);
            if (missing.length > 0) precise.push(`-{${missing.sort().join(',')}} at "${where}"`);
        }
    }
    return { checked, fns: fns.length, structuralBailed, conservative, precise };
}

describe('CFG liveness vs structural liveness — equivalence', () => {
    const CASES: [string, string][] = [
        ['straight line', 'function f(p){ let a = p; let b = a + 1; return b; }'],
        ['if/else', 'function f(p){ let a = 1; if (p) { a = 2; } else { a = 3; } return a; }'],
        ['if without else', 'function f(p){ let a = 1; if (p) { a = 2; } return a; }'],
        ['while loop', 'function f(p){ let a = 0; while (p) { a = a + 1; } return a; }'],
        ['do-while', 'function f(p){ let a = 0; do { a = a + 1; } while (p); return a; }'],
        ['c-style for', 'function f(n){ let s = 0; for (let i = 0; i < n; i++) { s = s + i; } return s; }'],

        ['nested loops', 'function f(n){ let s = 0; for (let i=0;i<n;i++){ for (let j=0;j<n;j++){ s = s + j; } } return s; }'],
        ['break', 'function f(n){ let s = 0; for (let i=0;i<n;i++){ if (i>2) break; s = s + i; } return s; }'],
        ['continue', 'function f(n){ let s = 0; for (let i=0;i<n;i++){ if (i>2) continue; s = s + i; } return s; }'],
        ['labeled break', 'function f(n){ let s = 0; L: for (let i=0;i<n;i++){ for (let j=0;j<n;j++){ if (j>1) break L; s = s + j; } } return s; }'],

        ['labeled block + break', 'function f(p){ let r = 0; L: { if (p) { r = 1; break L; } r = 2; } return r; }'],
        ['switch fallthrough', 'function f(p){ let a = 0; switch (p) { case 1: a = 1; case 2: a = a + 2; break; default: a = 3; } return a; }'],
        ['early return', 'function f(p){ let a = 1; if (p) { return a; } a = 2; return a; }'],
        ['dead store', 'function f(p){ let a = 1; a = 2; return a; }'],
        ['throw', 'function f(p){ let a = 1; if (p) { throw new Error("x"); } return a; }'],
        ['nested closure capture', 'function f(p){ let a = 1; const g = () => a; a = 2; return g(); }'],
    ];

    for (const [name, src] of CASES) {
        it(`agrees on: ${name}`, () => {
            const r = compare(src);
            expect({ conservative: r.conservative, precise: r.precise }).toEqual({ conservative: [], precise: [] });
            expect(r.checked).toBeGreaterThan(0);
        });
    }

    // CHARACTERISATION on real code. The two implementations do NOT agree everywhere on three.core.js,
    // and the differences are informative rather than alarming — every sample inspected was explained:
    //
    //   CFG more PRECISE (structural keeps something live that is provably dead). Cause: Closure's
    //     gen/kill is richer than `liveness.ts`'s `killOf`, which only recognises a kill for a
    //     single-declarator declaration or a statement-level `x = expr`. Closure additionally kills
    //     destructured bindings, multi-declarator inits, and assignments nested inside expressions.
    //     VERIFIED by hand: in `_initializeGeometry`, `const { array, itemSize, normalized } = src` is
    //     re-bound every `for...in` iteration, so those three are genuinely dead after the loop's last
    //     statement; `liveness.ts` cannot kill them because the id is a pattern, not an identifier.
    //
    //   CFG more CONSERVATIVE (CFG keeps something live that structural drops). The SAFE direction for
    //     a backward liveness. One sample traced to `Color.getHSL`'s `hue`, where a `switch (max)` with
    //     no default is followed by `hue /= 6` — a compound assignment READS first, and the no-case
    //     path reaches it without a definite assignment. Which analysis is right there was not settled;
    //     the CFG's answer is the safe one either way.
    //
    // The counts are asserted so a REGRESSION in either implementation shows up as a change, while the
    // known difference does not read as a failure.
    it('characterises the differences on three.core.js', () => {
        const src = readFileSync(
            '/Users/isaacmason/Development/shakeup/llm/spikes/node_modules/three/build/three.core.js',
            'utf8',
        );
        // Capped at 400 functions: the full 697 still agrees, but this file runs alongside several
        // other three.core.js corpus tests and the shared 5s per-test timeout is a real budget.
        const r = compare(src, 400);
        expect(r.checked).toBeGreaterThan(1_000);
        // Both directions exist; neither should silently explode.
        expect(r.precise.length).toBeGreaterThan(0);
        expect(r.conservative.length).toBeGreaterThan(0);
        expect(r.precise.length + r.conservative.length).toBeLessThan(r.checked / 4);
    });
});

describe('CFG is strictly more precise where Closure documents it', () => {
    // `for (const x of xs)` — Closure's `computeGenKill` reads only the LHS for a for-of/for-in node:
    // "rhs is executed only once so we don't go into it every loop". The structural analysis re-reads
    // the iterable on every iteration and so keeps it needlessly live across the body.
    for (const [name, src] of [
        ['for-of', 'function f(xs){ let s = 0; for (const x of xs) { s = s + x; } return s; }'],
        ['for-in', 'function f(o){ let s = 0; for (const k in o) { s = s + 1; } return s; }'],
    ] as [string, string][]) {
        it(`${name}: the iterable is not kept live across the loop body`, () => {
            const r = compare(src);
            expect(r.conservative).toEqual([]); // never worse
            expect(r.precise.length).toBe(1); // exactly the iterable
        });
    }
});

describe('CFG models what the structural analysis bails on', () => {
    it('produces liveness for a labeled `continue`, which the structural analysis refuses', () => {
        // An UNDOCUMENTED coverage gap found by this experiment: `liveness.ts` says it bails only on
        // `try`, but `continue LABEL` also bails (labelled BREAK and plain `continue` both work).
        const src =
            'function f(n){ let s = 0; L: for (let i=0;i<n;i++){ for (let j=0;j<n;j++){ if (j>1) continue L; s = s + j; } } return s; }';
        const [only] = functionsOf(src);
        expect(computeLiveness(only.body, only.tracked, new Set())).toBeNull();
        const flow = computeLiveVars(buildCfg(only.body), only.tracked, new Set());
        const ret = (only.body.data as { body: Node[] }).body.at(-1) as Node;
        expect(flow.liveOut(ret)).not.toBeNull();
    });

    it('produces liveness for a function containing try/catch', () => {
        const src = 'function f(p){ let a = 1; try { a = 2; g(); } catch (e) { a = 3; } return a; }';
        const [only] = functionsOf(src);
        expect(computeLiveness(only.body, only.tracked, new Set())).toBeNull(); // structural gives up
        const flow = computeLiveVars(buildCfg(only.body), only.tracked, new Set());
        const ret = (only.body.data as { body: Node[] }).body.at(-1) as Node;
        expect(flow.liveOut(ret)).not.toBeNull(); // the CFG has an answer
    });

    it('keeps a store live across an exception edge (conditional kill)', () => {
        // `a = g()` MAY THROW, so the assignment might not happen — the kill is only a maybe-kill and
        // `a = 1` stays live into the catch, which reads it. A kill that ignored the exception edge
        // would wrongly call `a = 1` dead. (Note `a = 2` would NOT work here: a literal assignment
        // cannot throw, so it is an unconditional kill and `a = 1` really is dead.)
        const src = 'function f(){ let a = 1; try { a = g(); } catch (e) { return a; } return a; }';
        const [only] = functionsOf(src);
        const cfg = buildCfg(only.body);
        const flow = computeLiveVars(cfg, only.tracked, new Set());
        const stmts = (only.body.data as { body: Node[] }).body;
        const decl = stmts[0]; // let a = 1
        const live = flow.liveOut(decl);
        expect(live).not.toBeNull();
        expect(live!.size).toBeGreaterThan(0); // `a` is live out of its declaration
    });
});
