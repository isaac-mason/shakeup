import { describe, expect, it } from 'vitest';
import { buildCfg } from '../src/analysis/cfg.ts';
import { computeReachingUses } from '../src/analysis/reaching-uses.ts';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { N, type Node, walk } from '../src/ast.ts';
import { parse } from '../src/index.ts';

// Maybe-reaching (upward-exposed) uses — Closure `MaybeReachingVariableUse`. The key questions for its
// consumer (`FlowSensitiveInlineVariables`) are counting: how many uses does a definition's value
// reach? The pass inlines when the answer is exactly one.

/** Build the analysis and expose "the uses reaching the point AFTER statement `at`, for `name`", as the
 *  source texts of those use statements. */
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

    const tracked = new Set<number>();
    const symOfName = new Map<string, number>();
    walk(body, (n) => {
        if (n.type === N.BindingIdentifier || n.type === N.IdentifierReference) {
            const s = (n as { sym: number }).sym;
            if (s > 0) {
                tracked.add(s);
                if (!symOfName.has(n.name)) symOfName.set(n.name, s);
            }
        }
        return undefined;
    });

    const cfg = buildCfg(body);
    const ru = computeReachingUses(cfg, tracked);

    const byText = new Map<string, Node>();
    walk(body, (n) => {
        if (n.type === N.ExpressionStatement || n.type === N.ReturnStatement || n.type === N.VariableDeclaration)
            byText.set(src.slice(n.start, n.end).trim(), n);
        return undefined;
    });

    return {
        // Uses of `name` reaching the point AFTER `at`, as sorted source texts.
        usesAfter: (at: string, name: string): string[] => {
            const stmt = byText.get(at);
            if (stmt === undefined) throw new Error(`no statement ${JSON.stringify(at)} in ${[...byText.keys()]}`);
            const id = cfg.idOf.get(stmt);
            const sym = symOfName.get(name);
            if (id === undefined || sym === undefined) return [];
            return ru
                .usesOutAt(id, sym)
                .map((useId) => {
                    const node = cfg.value[useId];
                    return node === null ? '<exit>' : src.slice(node.start, node.end).trim();
                })
                .sort();
        },
    };
}

describe('maybe-reaching uses (upward-exposed)', () => {
    it('a definition with exactly one downstream use', () => {
        const a = analyse('function f(){ let x; x = 1; g(x); }');
        expect(a.usesAfter('x = 1;', 'x')).toEqual(['g(x);']);
    });

    it('a definition whose value reaches TWO uses', () => {
        const a = analyse('function f(){ let x; x = 1; g(x); h(x); }');
        expect(a.usesAfter('x = 1;', 'x')).toEqual(['g(x);', 'h(x);']);
    });

    it('a redefinition CUTS the earlier value off from later uses', () => {
        // After `x = 1`, the only reachable use before `x = 2` is `g(x)`. `h(x)` reads the 2.
        const a = analyse('function f(){ let x; x = 1; g(x); x = 2; h(x); }');
        expect(a.usesAfter('x = 1;', 'x')).toEqual(['g(x);']);
        expect(a.usesAfter('x = 2;', 'x')).toEqual(['h(x);']);
    });

    it('a use on EACH branch is exposed at the split (union / MAY)', () => {
        const a = analyse('function f(c){ let x; x = 1; if (c) { g(x); } else { h(x); } }');
        expect(a.usesAfter('x = 1;', 'x')).toEqual(['g(x);', 'h(x);']);
    });

    it('no downstream use means no exposed use', () => {
        const a = analyse('function f(){ let x; x = 1; g(1); }');
        expect(a.usesAfter('x = 1;', 'x')).toEqual([]);
    });

    it('a self-referential store keeps its own read exposed to the store before it', () => {
        // `x = x + 1` reads x, so after `x = 1` the reachable use of the 1 is exactly that read.
        const a = analyse('function f(){ let x; x = 1; x = x + 1; g(x); }');
        expect(a.usesAfter('x = 1;', 'x')).toEqual(['x = x + 1;']);
    });

    it('a loop exposes an in-body use back across the back-edge', () => {
        const a = analyse('function f(n){ let x; x = 0; while (n) { g(x); } }');
        // The value from `x = 0` reaches the in-loop use `g(x)`.
        expect(a.usesAfter('x = 0;', 'x')).toEqual(['g(x);']);
    });
});
