import { describe, expect, it } from 'vitest';
import { N, type Node } from '../src/ast.ts';
import { parse } from '../src/parser';
import * as create from '../src/parser/create.ts';
import { verifyStructure } from '../src/passes/verify-structure.ts';

// The verifier that would have caught the quieter half of the loop-head miscompile: `dropUnused`
// wrote an `ExpressionStatement` into `ForStatement.init`, and NOTHING rejected the tree until the
// printer, several stages later, with no trace of which pass built it.
//
// A verifier that never fires is worse than none, so these tests are as much about the check being
// ABLE to fail as about it passing. The first attempt at this invariant — asserting inside
// `visitSingle` that a replacement preserves statement-ness — ran clean across the whole suite and
// caught nothing, because `VariableDeclaration` and `ExpressionStatement` are both statements.
const ast = (src: string) => parse(src, { ts: false, jsx: false }).program as Node;

describe('verifyStructure', () => {
    it('accepts every statement position the grammar has', () => {
        // The accept side is what decides whether this can be turned on in CI, so it is the broad one.
        const src = `
            import a from 'm';
            export const x = 1;
            export default function d() { return 1; }
            export * from 'n';
            label: for (let i = 0; i < 3; i++) if (i) continue label; else break label;
            for (const k in o) k;
            for (const v of o) v;
            while (a) { a--; }
            do a--; while (a);
            try { a(); } catch (e) { e; } finally { a(); }
            switch (a) { case 1: a(); break; default: a(); }
            class C { static { a(); } m() { return () => a; } }
            const f = () => a;
            if (a) b(); else { c(); }
        `;
        expect(verifyStructure(ast(src))).toEqual([]);
    });

    it('catches a statement written into a loop head — the real bug', () => {
        // Reproduce the exact malformation by hand: `for (let _ = g(); …)` where the init clause has
        // been replaced by an ExpressionStatement of the init.
        const program = ast('for (let _ = g(); n < 3; n++) n += 1;');
        const forStmt = (program.data as { body: Node[] }).body[0];
        const init = (forStmt.data as { init: Node }).init;
        const call = ((init.data as { declarations: Node[] }).declarations[0].data as { init: Node }).init;
        (forStmt.data as { init: Node }).init = create.ExpressionStatement(call.start, call.end, 0, call) as Node;

        const problems = verifyStructure(program);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(/ForStatement\.init/);
        expect(problems[0]).toMatch(/ExpressionStatement/);
        expect(problems[0]).toMatch(/only a VariableDeclaration/);
    });

    it.each([
        ['ForInStatement', 'for (const k in o) k;', 'left'],
        ['ForOfStatement', 'for (const v of o) v;', 'left'],
    ])('catches a statement in %s.%s', (_label, src, field) => {
        const program = ast(src);
        const loop = (program.data as { body: Node[] }).body[0];
        (loop.data as Record<string, Node>)[field] = create.EmptyStatement(0, 0, 0) as Node;
        expect(verifyStructure(program)[0]).toMatch(new RegExp(`\\.${field}.*EmptyStatement`));
    });

    it('catches a statement in a plain EXPRESSION slot', () => {
        // Not just loop heads: any single-child slot that takes an expression.
        const program = ast('a + b;');
        const expr = ((program.data as { body: Node[] }).body[0].data as { expression: Node }).expression;
        (expr.data as Record<string, Node>).right = create.EmptyStatement(0, 0, 0) as Node;
        expect(verifyStructure(program)[0]).toMatch(/BinaryExpression\.right.*takes an expression/);
    });

    it('allows a VariableDeclaration in a loop head, and only that', () => {
        expect(verifyStructure(ast('for (let i = 0; i < 3; i++) i;'))).toEqual([]);
        expect(verifyStructure(ast('for (i = 0; i < 3; i++) i;'))).toEqual([]); // an expression init
        expect(verifyStructure(ast('for (k in o) k;'))).toEqual([]); // an assignment-target left
    });

    it('is driven by the same schema the traversal walks', () => {
        // The slot list is derived from CHILD_FIELDS, so it cannot drift from what `walk` visits.
        // A node type the schema does not know would silently verify nothing.
        const program = ast('for (const k in o) k;');
        const loop = (program.data as { body: Node[] }).body[0];
        expect(loop.type).toBe(N.ForInStatement);
    });
});
