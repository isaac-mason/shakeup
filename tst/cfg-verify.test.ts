import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BRANCH, buildCfg, IMPLICIT_RETURN, verifyCfg } from '../src/analysis/cfg.ts';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { N, type Node, walk } from '../src/ast.ts';
import { parse } from '../src/index.ts';

// Phase 0c of the CFG migration: assert the graph is WELL-FORMED, independently of whether its answers
// are right (that is cfg-equivalence.test.ts's job). A malformed graph produces plausible-but-wrong
// dataflow silently — the same failure mode that let the chunk mangler crash every multi-module full
// minify for months without a single test noticing.

const isRoot = (n: Node): boolean =>
    n.type === N.FunctionDeclaration || n.type === N.FunctionExpression || n.type === N.ArrowFunctionExpression;

function bodiesOf(src: string): Node[] {
    const { program } = parse(src, { ts: false, jsx: false });
    const sem = createSemantic();
    analyze(sem, program);
    const out: Node[] = [program];
    walk(program, (n) => {
        if (!isRoot(n)) return undefined;
        const b = (n.data as { body: Node | null }).body;
        if (b !== null && b.type === N.BlockStatement) out.push(b);
        return undefined;
    });
    return out;
}

const TRICKY: [string, string][] = [
    ['try/finally + return', 'function f(){ try { return 1; } finally { g(); } }'],
    ['try/catch/finally + break', 'function f(){ for(;;){ try { break; } catch(e) { } finally { g(); } } }'],
    ['nested finally', 'function f(){ try { try { return 1; } finally { a(); } } finally { b(); } }'],
    ['continue crossing finally', 'function f(n){ for(let i=0;i<n;i++){ try { continue; } finally { g(); } } }'],
    ['labeled break out of try', 'function f(){ L: { try { break L; } finally { g(); } } h(); }'],
    ['labeled block', 'function f(p){ L: { if (p) break L; g(); } h(); }'],
    ['labeled continue', 'function f(n){ L: for(let i=0;i<n;i++){ for(let j=0;j<n;j++){ if (j) continue L; g(); } } }'],
    ['switch no default', 'function f(p){ switch(p){ case 1: a(); } b(); }'],
    ['switch default first', 'function f(p){ switch(p){ default: a(); case 1: b(); } }'],
    ['switch empty', 'function f(p){ switch(p){} b(); }'],
    ['switch fallthrough', 'function f(p){ switch(p){ case 1: a(); case 2: b(); break; default: c(); } }'],
    ['async/await', 'async function f(){ const a = await g(); return a; }'],
    ['generator', 'function* f(){ yield 1; yield 2; }'],
    ['for-await', 'async function f(xs){ for await (const x of xs) g(x); }'],
    ['optional chain', 'function f(o){ return o?.a?.b; }'],
    ['do-while', 'function f(){ do { g(); } while (h()); }'],
    ['infinite for', 'function f(){ for(;;){ g(); } }'],
    ['while(true) with break', 'function f(){ while(true){ if (g()) break; } h(); }'],
    ['unreachable after return', 'function f(){ return 1; g(); h(); }'],
    ['nested fn skipped', 'function f(){ function g(){ return 1; } return g(); }'],
    ['throw in catch', 'function f(){ try { g(); } catch(e){ throw e; } }'],
    ['empty function', 'function f(){}'],
    ['for-in over call', 'function f(o){ for (const k in o.get()) g(k); }'],
    ['comma + ternary', 'function f(a,b){ return (a(), b ? c() : d()); }'],
];

describe('CFG structural validity', () => {
    for (const [name, src] of TRICKY) {
        it(`is well-formed: ${name}`, () => {
            for (const body of bodiesOf(src)) expect(verifyCfg(buildCfg(body))).toEqual([]);
        });
    }

    it('is well-formed across every function in three.core.js', () => {
        const src = readFileSync(
            '/Users/isaacmason/Development/shakeup/llm/spikes/node_modules/three/build/three.core.js',
            'utf8',
        );
        const bodies = bodiesOf(src);
        const problems: string[] = [];
        for (const body of bodies) {
            const v = verifyCfg(buildCfg(body));
            if (v.length > 0) problems.push(`@${body.start}: ${v.slice(0, 3).join(' | ')}`);
            if (problems.length > 8) break;
        }
        expect({ bodies: bodies.length > 500, problems }).toEqual({ bodies: true, problems: [] });
    }, 30000);

});

// A verifier that never fires proves nothing. Each case corrupts a VALID graph in one specific way and
// asserts the corresponding invariant catches it.
describe('the verifier actually detects corruption', () => {
    const fresh = () => buildCfg(bodiesOf('function f(p){ let a = 1; if (p) { a = 2; } else { a = 3; } return a; }')[1]);

    it('catches a dangling successor', () => {
        const cfg = fresh();
        cfg.succ[1].push(9999);
        cfg.succBranch[1].push(BRANCH.UNCOND);
        expect(verifyCfg(cfg).join(' ')).toMatch(/dangling succ/);
    });

    it('catches a one-sided edge (succ with no matching pred)', () => {
        const cfg = fresh();
        cfg.succ[1].push(2);
        cfg.succBranch[1].push(BRANCH.ON_EX);
        expect(verifyCfg(cfg).join(' ')).toMatch(/no matching pred/);
    });

    it('catches a one-sided edge (pred with no matching succ)', () => {
        const cfg = fresh();
        cfg.pred[2].push(3);
        cfg.predBranch[2].push(BRANCH.ON_EX);
        expect(verifyCfg(cfg).join(' ')).toMatch(/has no matching succ/);
    });

    it('catches a duplicate edge', () => {
        const cfg = fresh();
        cfg.succ[1].push(cfg.succ[1][0]);
        cfg.succBranch[1].push(cfg.succBranch[1][0]);
        cfg.pred[cfg.succ[1][0]].push(1);
        cfg.predBranch[cfg.succ[1][0]].push(cfg.succBranch[1][0]);
        expect(verifyCfg(cfg).join(' ')).toMatch(/duplicate edge/);
    });

    it('catches a conditional edge from a non-branching node', () => {
        const cfg = fresh();
        // node 1 is the function body block — an unconditional container, never a brancher.
        cfg.succBranch[1][0] = BRANCH.ON_TRUE;
        cfg.predBranch[cfg.succ[1][0]][0] = BRANCH.ON_TRUE;
        expect(verifyCfg(cfg).join(' ')).toMatch(/conditional edge from a non-branching node/);
    });

    it('catches a successor on the implicit return', () => {
        const cfg = fresh();
        cfg.succ[IMPLICIT_RETURN].push(1);
        cfg.succBranch[IMPLICIT_RETURN].push(BRANCH.UNCOND);
        cfg.pred[1].push(IMPLICIT_RETURN);
        cfg.predBranch[1].push(BRANCH.UNCOND);
        expect(verifyCfg(cfg).join(' ')).toMatch(/implicit return must have no successors/);
    });

    it('accepts the uncorrupted graph', () => {
        expect(verifyCfg(fresh())).toEqual([]);
    });
});
