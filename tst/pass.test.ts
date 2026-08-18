import { describe, expect, it } from 'vitest';
import { N, type Node, node, parse } from '../src/index.ts';
import { type Pass, runPasses } from '../src/pass/traverse.ts';
import { printModule } from '../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../src/print/printer.ts';

const print = (program: Node): string => {
    const p = createPrinter({ minify: false });
    printModule(p, program);
    return finishPrinter(p).trim();
};

describe('pass traverse — AST-as-IR mutation substrate', () => {
    it('replaces nodes, drops list elements, and composes passes in one traversal', () => {
        const src = 'const a = foo;\ndebugger;\nbar(foo);\n';
        const { program } = parse(src, { ts: false, jsx: false });

        const rename: Pass<null> = {
            name: 'rename',
            enter: (n) => (n.type === N.IdentifierReference && n.name === 'foo' ? node(N.IdentifierReference, n.start, n.end, 'baz', null) : undefined),
            exit: null,
        };
        const dropDebugger: Pass<null> = {
            name: 'drop-debugger',
            enter: (n) => (n.type === N.DebuggerStatement ? null : undefined),
            exit: null,
        };

        runPasses(program, [dropDebugger, rename], null);
        const out = print(program);

        expect(out).not.toContain('debugger'); // dropped from the statement list
        expect(out).not.toContain('foo'); // every reference renamed
        expect(out).toContain('baz');
        expect(program.data.body.length).toBe(2); // debugger statement compacted out
        expect(parse(out, { ts: false, jsx: false }).errors).toEqual([]); // still valid JS
    });

    it('exit-order replacement is visible (later pass sees earlier rewrite)', () => {
        const { program } = parse('x;\n', { ts: false, jsx: false });
        const seen: string[] = [];
        const first: Pass<null> = {
            name: 'x->y',
            enter: (n) => (n.type === N.IdentifierReference && n.name === 'x' ? node(N.IdentifierReference, n.start, n.end, 'y', null) : undefined),
            exit: null,
        };
        const observe: Pass<null> = {
            name: 'observe',
            enter: (n) => {
                if (n.type === N.IdentifierReference) seen.push(n.name); // must see 'y', not 'x'
                return undefined;
            },
            exit: null,
        };
        runPasses(program, [first, observe], null);
        expect(seen).toEqual(['y']);
    });
});
