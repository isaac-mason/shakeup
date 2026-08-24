import { describe, expect, it } from 'vitest';
import { buildCfg } from '../src/analysis/cfg.ts';
import { BOTTOM, computeReachingDefs, TOP } from '../src/analysis/reaching-defs.ts';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { N, type Node, walk } from '../src/ast.ts';
import { parse } from '../src/index.ts';

// Must-be-reaching definitions (Closure `MustBeReachingVariableDef`). The properties worth pinning are
// the three a structural walk cannot get right by construction: a single definition dominating a use,
// a MERGE of disagreeing definitions collapsing to BOTTOM, and a loop BACK-EDGE feeding a definition
// back to the top of the loop.

type Probe = {
    /** Which definition reaches the start of the statement whose source text is `at`, for symbol `name`? */
    def: (at: string, name: string) => 'entry' | 'bottom' | 'top' | string;
};

function analyse(src: string): Probe {
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
    const rd = computeReachingDefs(cfg, tracked);

    const stmts = new Map<string, Node>();
    walk(body, (n) => {
        if (n.type === N.ExpressionStatement || n.type === N.ReturnStatement || n.type === N.VariableDeclaration)
            stmts.set(src.slice(n.start, n.end).trim(), n);
        return undefined;
    });

    return {
        def: (at, name) => {
            const stmt = stmts.get(at);
            if (stmt === undefined) throw new Error(`no statement ${JSON.stringify(at)} in ${[...stmts.keys()]}`);
            const sym = symOfName.get(name);
            if (sym === undefined) throw new Error(`no symbol ${name}`);
            const d = rd.defIn(stmt, sym);
            if (d === TOP) return 'top';
            if (d === BOTTOM) return 'bottom';
            if (d === cfg.entry) return 'entry';
            const node = cfg.value[d];
            return node === null ? 'implicit-return' : src.slice(node.start, node.end).trim();
        },
    };
}

describe('must-be-reaching definitions', () => {
    it('a straight-line definition dominates the following use', () => {
        const p = analyse('function f(){ let a; a = 1; g(a); }');
        expect(p.def('g(a);', 'a')).toBe('a = 1;');
    });

    it('the LAST definition before the use is the one that reaches', () => {
        const p = analyse('function f(){ let a; a = 1; a = 2; g(a); }');
        expect(p.def('g(a);', 'a')).toBe('a = 2;');
    });

    it('a parameter reaches from the function entry', () => {
        const p = analyse('function f(x){ g(x); }');
        expect(p.def('g(x);', 'x')).toBe('entry');
    });

    it('DISAGREEING definitions on two paths merge to BOTTOM', () => {
        const p = analyse('function f(c){ let a; if (c) { a = 1; } else { a = 2; } g(a); }');
        expect(p.def('g(a);', 'a')).toBe('bottom');
    });

    it('the SAME definition on both paths still reaches', () => {
        // Nothing redefines `a` inside the branches, so the pre-branch definition dominates the use.
        const p = analyse('function f(c){ let a; a = 1; if (c) { g(1); } else { g(2); } h(a); }');
        expect(p.def('h(a);', 'a')).toBe('a = 1;');
    });

    it('a definition inside a branch does not reach past a merge with an undefined path', () => {
        const p = analyse('function f(c){ let a; a = 0; if (c) { a = 1; } g(a); }');
        expect(p.def('g(a);', 'a')).toBe('bottom');
    });

    it('a loop BACK-EDGE makes the in-loop definition non-unique at the loop head', () => {
        // First iteration reaches `a = 0`; later iterations reach `a = a + 1`. Two definitions arrive
        // at the loop condition, so the use inside the body cannot have a single reaching definition.
        const p = analyse('function f(n){ let a; a = 0; while (n) { g(a); a = a + 1; } }');
        expect(p.def('g(a);', 'a')).toBe('bottom');
    });

    it('a definition INSIDE the loop body reaches a later use in the same iteration', () => {
        const p = analyse('function f(n){ let a; while (n) { a = 1; g(a); } }');
        expect(p.def('g(a);', 'a')).toBe('a = 1;');
    });

    it('records what a definition DEPENDS on', () => {
        const { program } = parse('function f(b, c){ let a; a = b + c; g(a); }', { ts: false, jsx: false });
        const sem = createSemantic();
        analyze(sem, program);
        let body: Node | null = null;
        walk(program, (n) => {
            if (n.type === N.FunctionDeclaration && body === null) body = (n.data as { body: Node }).body;
            return undefined;
        });
        const tracked = new Set<number>();
        const nameOf = new Map<number, string>();
        walk(body as unknown as Node, (n) => {
            if (n.type === N.BindingIdentifier || n.type === N.IdentifierReference) {
                const s = (n as { sym: number }).sym;
                if (s > 0) {
                    tracked.add(s);
                    nameOf.set(s, n.name);
                }
            }
            return undefined;
        });
        const cfg = buildCfg(body as unknown as Node);
        const rd = computeReachingDefs(cfg, tracked);
        // Find the CFG node for `a = b + c;` BY SOURCE TEXT — picking "the last ExpressionStatement"
        // lands on `g(a);` instead, whose dependency is `a`.
        const SRC = 'function f(b, c){ let a; a = b + c; g(a); }';
        let defId = -1;
        for (let i = 1; i < cfg.value.length; i++) {
            const v = cfg.value[i];
            if (v !== null && SRC.slice(v.start, v.end).trim() === 'a = b + c;') defId = i;
        }
        expect(defId).toBeGreaterThan(0);
        const deps = [...rd.dependsOf(defId)].map((s) => nameOf.get(s)).sort();
        expect(deps).toEqual(['b', 'c']);
    });
});
