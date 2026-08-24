import { describe, expect, it } from 'vitest';
import { BRANCH, buildCfg } from '../src/analysis/cfg.ts';
import { type DataflowSpec, solve } from '../src/analysis/dataflow.ts';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { N, type Node, walk } from '../src/ast.ts';
import { parse } from '../src/index.ts';

// Exercises the two parts of the framework that backward liveness never touches:
//   • the FORWARD direction
//   • BRANCHED analyses — a distinct lattice value per OUTGOING EDGE (Closure `isBranched()` /
//     `createFlowBrancher`, the mechanism its `TypeInference` is built on)
//
// The analysis here is a deliberately tiny MUST-analysis — which symbols are KNOWN TRUTHY at each
// point. It exists to prove the mechanism, not to optimise anything.
//
// **This is the capability that justifies an explicit CFG.** On `if (x)` the ON_TRUE edge carries "x is
// truthy" while ON_FALSE carries "x is not" — two different facts leaving ONE node. A structural
// recursion over the AST has nowhere to put that: it has a single value flowing into each branch's
// subtree, so every analysis wanting the refinement must re-derive it per construct, by hand.

type Facts = Uint32Array;

/** Build the known-truthy analysis over one function, and query it by statement source text. */
function analyse(src: string) {
    const { program } = parse(src, { ts: false, jsx: false });
    const sem = createSemantic();
    analyze(sem, program);

    let fnBody: Node | null = null;
    walk(program, (n) => {
        if (n.type === N.FunctionDeclaration && fnBody === null) fnBody = (n.data as { body: Node }).body;
        return undefined;
    });
    const body = fnBody as unknown as Node;

    // Dense index over every symbol in the function.
    const index = new Map<number, number>();
    const nameOf = new Map<number, string>();
    walk(body, (n) => {
        if (n.type === N.IdentifierReference || n.type === N.BindingIdentifier) {
            const s = (n as { sym: number }).sym;
            if (s > 0 && !index.has(s)) {
                index.set(s, index.size);
                nameOf.set(s, n.name);
            }
        }
        return undefined;
    });

    const W = Math.max(1, (index.size + 31) >>> 5);
    const cfg = buildCfg(body);
    const set = (a: Facts, i: number): void => {
        a[i >>> 5] |= 1 << (i & 31);
    };
    const clear = (a: Facts, i: number): void => {
        a[i >>> 5] &= ~(1 << (i & 31));
    };
    const changedSince = (before: Facts, now: Facts): boolean => {
        for (let w = 0; w < W; w++) if (before[w] !== now[w]) return true;
        return false;
    };
    /** The symbol a branching node tests, when it tests a bare identifier. */
    const testSym = (n: Node): number | null => {
        const t = (n.data as { test?: Node } | null)?.test;
        return t != null && t.type === N.IdentifierReference ? (t as { sym: number }).sym : null;
    };

    const spec: DataflowSpec<Facts> = {
        forward: true,
        // MUST analysis: the initial estimate is TOP (everything known) so a not-yet-computed
        // predecessor cannot wrongly weaken the intersection; the boundary is BOTTOM (nothing known).
        alloc: () => new Uint32Array(W).fill(0xffffffff),
        boundary: (dst) => dst.fill(0),
        copy: (dst, s) => dst.set(s),
        joinInto: (dst, s) => {
            for (let w = 0; w < W; w++) dst[w] = (dst[w] & s[w]) >>> 0;
        },
        transfer: (dst, srcVal, node) => {
            const before = Uint32Array.from(dst);
            dst.set(srcVal);
            // `x = <truthy literal>` establishes the fact; any other assignment to x destroys it.
            if (node.type === N.ExpressionStatement) {
                const e = (node.data as { expression: Node }).expression;
                if (e.type === N.AssignmentExpression) {
                    const d = e.data as { left: Node; right: Node };
                    if (d.left.type === N.IdentifierReference) {
                        const i = index.get((d.left as { sym: number }).sym);
                        if (i !== undefined) {
                            if (d.right.type === N.NumericLiteral && Number(d.right.name) !== 0) set(dst, i);
                            else clear(dst, i);
                        }
                    }
                }
            }
            return changedSince(before, dst);
        },
        branch: (dst, out, node, _id, edge) => {
            const before = Uint32Array.from(dst);
            dst.set(out);
            const s = testSym(node);
            if (s !== null) {
                const i = index.get(s);
                if (i !== undefined) {
                    if (edge === BRANCH.ON_TRUE) set(dst, i);
                    else if (edge === BRANCH.ON_FALSE) clear(dst, i);
                }
            }
            return changedSince(before, dst);
        },
    };

    const { inAt } = solve(cfg, spec);

    const stmts = new Map<string, Node>();
    walk(body, (n) => {
        if (n.type === N.ExpressionStatement) stmts.set(src.slice(n.start, n.end).trim(), n);
        return undefined;
    });

    return (text: string): string[] => {
        const stmt = stmts.get(text);
        if (stmt === undefined) throw new Error(`no statement ${JSON.stringify(text)} in ${[...stmts.keys()]}`);
        const id = cfg.idOf.get(stmt);
        if (id === undefined) return [];
        const bits = inAt[id];
        const out: string[] = [];
        for (const [sym, i] of index)
            if ((bits[i >>> 5] & (1 << (i & 31))) !== 0) out.push(nameOf.get(sym) ?? String(sym));
        return out.sort();
    };
}

describe('forward branched dataflow (per-edge lattice values)', () => {
    it('refines a condition differently on the TRUE and FALSE edges', () => {
        const at = analyse('function f(x){ if (x) { g(x); } else { h(x); } }');
        expect(at('g(x);')).toEqual(['x']); // ON_TRUE edge: x is known truthy
        expect(at('h(x);')).toEqual([]); // ON_FALSE edge: it is not
    });

    it('carries the refinement through a loop condition', () => {
        const at = analyse('function f(x){ while (x) { g(x); } h(x); }');
        expect(at('g(x);')).toEqual(['x']);
        expect(at('h(x);')).toEqual([]);
    });

    it('an assignment establishes and then destroys the fact', () => {
        const at = analyse('function f(){ let a; a = 1; g(a); a = 0; h(a); }');
        expect(at('g(a);')).toEqual(['a']);
        expect(at('h(a);')).toEqual([]);
    });

    it('a fact known on only ONE path does not survive the merge (intersection join)', () => {
        const at = analyse('function f(p){ let a; if (p) { a = 1; } else { a = 0; } g(a); }');
        expect(at('g(a);')).toEqual([]);
    });

    it('a fact known on BOTH paths does survive the merge', () => {
        const at = analyse('function f(p){ let a; if (p) { a = 1; } else { a = 2; } g(a); }');
        expect(at('g(a);')).toEqual(['a']);
    });

    it('nested conditions accumulate refinements', () => {
        const at = analyse('function f(x,y){ if (x) { if (y) { g(x); } } }');
        expect(at('g(x);')).toEqual(['x', 'y']);
    });
});
