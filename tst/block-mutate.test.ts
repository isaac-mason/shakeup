import { describe, expect, it } from 'vitest';
import { N, type Node } from '../src/ast.ts';
import { parse } from '../src/index.ts';
import { mutateForBlockInline } from '../src/passes/optimize/block-mutate.ts';
import { printModule } from '../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../src/print/printer.ts';

/** Parse `function f(...) { ... }` and hand back its param names + body statements. */
function fnParts(src: string): { params: string[]; body: Node[] } {
    const prog = parse(src, { ts: false, jsx: false }).program;
    const decl = (prog.data as { body: Node[] }).body.find((s) => s.type === N.FunctionDeclaration)!;
    const d = decl.data as { params: Node[]; body: Node };
    return {
        // A param is a `FormalParameter` wrapping the binding pattern; the name lives on the pattern.
        params: d.params.map((p) => ((p.data as { pattern: Node }).pattern).name),
        body: [...((d.body.data as { body: Node[] }).body)],
    };
}

function printStmt(stmt: Node): string {
    const prog = parse('0;', { ts: false, jsx: false }).program;
    (prog.data as { body: Node[] }).body = [stmt];
    const p = createPrinter({ minify: false });
    printModule(p, prog);
    return finishPrinter(p).trim();
}

const mutate = (src: string, args: string[], needsResult = true) => {
    const { params, body } = fnParts(src);
    const argNodes = args.map((a) => {
        const prog = parse(`(${a});`, { ts: false, jsx: false }).program;
        const stmt = (prog.data as { body: Node[] }).body[0];
        return (stmt.data as { expression: Node }).expression;
    });
    return mutateForBlockInline({ bodyStmts: body, params, args: argNodes, label: 'L', resultName: '_r', needsResult });
};

/** Execution oracle: the mutated block must compute what CALLING the function computes. */
const runBoth = async (src: string, args: string[]) => {
    const out = mutate(src, args);
    const inlined = `let _r; ${printStmt(out.block)} export const viaBlock = _r;`;
    const called = `${src}\nexport const viaCall = f(${args.join(', ')});`;
    const load = async (code: string) => (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as any;
    return { block: (await load(inlined)).viaBlock, call: (await load(called)).viaCall };
};

describe('block-mutate (function body → statement)', () => {
    it('a sole TRAILING return falls through — no label, no break', () => {
        const out = mutate('function f(a) { g(); return a + 1; }', ['2']);
        const code = printStmt(out.block);
        expect(code).not.toContain('break');
        expect(code).not.toContain('L:');
        expect(code).toContain('_r = a + 1');
        expect(out.hasResultWrite).toBe(true);
    });

    it('an EARLY return becomes `result = X; break LABEL` inside a labeled block', () => {
        const code = printStmt(mutate('function f(a) { if (a) return 1; return 2; }', ['0']).block);
        expect(code).toMatch(/^L:/);
        expect(code).toContain('break L');
        expect(code).toContain('_r = 1');
        expect(code).toContain('_r = 2'); // the trailing one still falls through
    });

    it('rewrites a return sitting in a BARE clause slot (no array to splice)', () => {
        // `if (a) return 1;` has no statement list around the return.
        const code = printStmt(mutate('function f(a) { if (a) return 1; return 2; }', ['0']).block);
        expect(code).toMatch(/if \(a\)\s*\{/); // became a block
    });

    it('a body that falls off the end assigns undefined, not a stale value', () => {
        const out = mutate('function f(a) { g(a); }', ['1']);
        expect(printStmt(out.block)).toContain('_r = void 0');
        expect(out.hasResultWrite).toBe(true);
    });

    it('statement position (needsResult false) drops the value and keeps only effects', () => {
        const out = mutate('function f(a) { if (a) return h(); return 1; }', ['1'], false);
        const code = printStmt(out.block);
        expect(code).not.toContain('_r');
        expect(code).toContain('h()'); // effectful returned expression is kept
        expect(out.hasResultWrite).toBe(false);
    });

    it('binds params as const, or let when the body REBINDS them', () => {
        expect(printStmt(mutate('function f(a) { return a; }', ['1']).block)).toContain('const a = 1');
        expect(printStmt(mutate('function f(a) { a = a + 1; return a; }', ['1']).block)).toContain('let a = 1');
        // A member write mutates the object, not the binding — stays const.
        expect(printStmt(mutate('function f(a) { a.x = 1; return a; }', ['{}']).block)).toContain('const a =');
    });

    it('leaves a NESTED function’s return alone', () => {
        const code = printStmt(mutate('function f(a) { const g = () => { return 7; }; return g() + a; }', ['1']).block);
        expect(code).toContain('return 7'); // untouched
        expect((code.match(/break L/g) ?? []).length).toBe(0);
    });

    // ── execution oracle ──────────────────────────────────────────────────────────────────────
    for (const [name, src, args] of [
        ['trailing return', 'function f(a) { return a + 1; }', ['41']],
        ['early return', 'function f(a) { if (a > 0) return "pos"; return "neg"; }', ['5']],
        ['early return, other branch', 'function f(a) { if (a > 0) return "pos"; return "neg"; }', ['-5']],
        ['falls off the end', 'function f(a) { const x = a; }', ['1']],
        ['loop with early return', 'function f(n) { for (let i = 0; i < n; i++) { if (i === 2) return i; } return -1; }', ['5']],
        ['nested fn', 'function f(a) { const g = () => a * 2; return g(); }', ['21']],
    ] as const) {
        it(`computes the same value as calling it — ${name}`, async () => {
            const { block, call } = await runBoth(src, [...args]);
            expect(block).toEqual(call);
        });
    }
});
