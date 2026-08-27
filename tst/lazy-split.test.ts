import { describe, expect, it } from 'vitest';
import type { Node } from '../src/ast.ts';
import { parse } from '../src/parser/index.ts';
import { lazySplit } from '../src/passes/lazy-split.ts';
import { printStmt } from '../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../src/print/printer.ts';

// cjs.md §7.25 / C1. A `require`d ES module moves inside an `__esm` closure so the require evaluates
// it at the call — but its bindings must stay visible at top level, both for the namespace object's
// getters and for any static importer. That is rolldown's declaration/initializer split, which
// rolldown builds for EVERY wrapped ESM module (`module_finalizers/impl_visit_mut.rs:283-331`) and
// which shakeup now also applies unconditionally. This is the pass that performs it.
const split = (src: string) => {
    const p = parse(src, { ts: false, jsx: false, kind: 'module' });
    expect(p.errors).toEqual([]);
    const s = lazySplit(p.program.data.body as Node[]);
    const render = (nodes: Node[]) => {
        const pr = createPrinter({ minify: false });
        for (const n of nodes) printStmt(pr, n);
        return finishPrinter(pr).trim();
    };
    return { hoisted: render(s.hoisted), functions: render(s.functions), body: render(s.body) };
};

describe('declaration/initializer split', () => {
    it('hoists a simple const and moves its initializer', () => {
        const r = split('const a = 1;');
        expect(r.hoisted).toBe('var a;');
        expect(r.body).toBe('a = 1;');
    });

    it('handles several declarators, including one with no initializer', () => {
        const r = split('let b = 2, c;');
        expect(r.hoisted).toBe('var b, c;');
        // `c` has no initializer, so there is nothing to run for it — the hoisted `var` is the whole
        // declaration.
        expect(r.body).toBe('b = 2;');
    });

    it('leaves function declarations OUTSIDE the closure', () => {
        // Functions hoist on their own, and a static importer may call one before the module has
        // been initialised — exactly as it could in ESM.
        const r = split('function f() { return 1 }');
        expect(r.hoisted).toBe('');
        expect(r.functions).toContain('function f()');
        expect(r.body).toBe('');
    });

    it('turns a class declaration into a hoisted binding plus an assignment', () => {
        // A class binding exists but is in TDZ until evaluated, so the initializer belongs inside.
        const r = split('class C { m() {} }');
        expect(r.hoisted).toBe('var C;');
        expect(r.body).toContain('C = class C');
    });

    it.each([
        ['object destructuring', 'const { p, q } = o;', 'var p, q;', '({ p, q } = o);'],
        ['nested destructuring', 'const { nest: { deep } } = o;', 'var deep;', '({ nest: { deep } } = o);'],
        ['array destructuring with rest', 'const [r, s, ...rest] = a;', 'var r, s, rest;', '[r,s,...rest] = a;'],
        ['a default value', 'const { d = 5 } = o;', 'var d;', '({ d = 5 } = o);'],
    ])('handles %s', (_label, src, hoisted, body) => {
        const r = split(src);
        expect(r.hoisted).toBe(hoisted);
        expect(r.body).toBe(body);
    });

    it('parenthesises an object destructuring assignment', () => {
        // Without parens an expression statement starting with `{` parses as a BLOCK. The printer
        // adds them for the assignment-target shape the parser produces from source, which is why
        // the pass retypes `ObjectPattern` to `ObjectExpression` rather than emitting the pattern.
        expect(split('const { p } = o;').body.startsWith('(')).toBe(true);
    });

    it('leaves ordinary statements in place, in order', () => {
        const r = split('side1();\nif (x) { side2() }\nfor (const i of y) side3(i);');
        expect(r.hoisted).toBe('');
        expect(r.body).toMatch(/side1\(\)[\s\S]*side2\(\)[\s\S]*side3\(/);
    });

    it('the split output is executable and preserves values', () => {
        const src =
            'const a = 1;\nlet b = a + 1;\nclass C { v() { return 3 } }\nconst { p } = { p: 4 };\nconst [q] = [5];\nfunction f() { return 6 }';
        const r = split(src);
        // Reassembled the way the emit will: hoisted vars, then functions, then the closure body.
        const program = `${r.hoisted}\n${r.functions}\nfunction init() {\n${r.body}\n}\ninit();\nout = [a, b, new C().v(), p, q, f()];`;
        const out = new Function(`let out; ${program} return out;`)() as unknown[];
        expect(out).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('bindings are readable BEFORE init runs, and undefined until then', () => {
        // The whole point: a static importer can name them; it just sees `undefined` before init.
        const r = split('const a = 1;');
        const out = new Function(
            `${r.hoisted}\nconst before = a;\nfunction init(){${r.body}}\ninit();\nreturn [before, a];`,
        )() as unknown[];
        expect(out).toEqual([undefined, 1]);
    });
});

describe('the split keeps every binding on ONE name', () => {
    // The hoisted `var` and the initializer assignments are SYNTHESIZED nodes. If they carry no
    // symbol they print the raw source name, while the namespace getters — built from the real
    // symbol — print the renamed one. Under `minify` that produced
    // `var e,t; ... {get a(){return a}}`: getters reading variables that do not exist. Only
    // `pnpm cjsdiff` caught it, so it is pinned here too.
    const files = {
        '/e.js': 'export const a = 1;\nexport let m = 2;',
        '/d.cjs': "const e = require('./e.js');\nmodule.exports = [e.a, e.m];",
        '/main.js': "import d from './d.cjs';\nexport const x = d;",
    };
    const run = async (minify: boolean) => {
        const { bundle } = await import('../src/bundle.ts');
        const { createMemoryFs } = await import('../src/fs.ts');
        const r = await bundle({ entry: '/main.js', fs: createMemoryFs(files), output: minify ? { minify: true } : {} });
        expect(r.errors).toEqual([]);
        return r.code;
    };

    it.each([false, true])('evaluates to the same values (minify: %s)', async (minify) => {
        const code = await run(minify);
        const mod = (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as { x: unknown };
        expect(mod.x).toEqual([1, 2]);
    });

    it('the hoisted binding follows DECONFLICTION renaming', async () => {
        // The case the symbol matters for now that mangling runs over the whole chunk: two modules
        // both declare `a`, so deconflict renames one. `lazySplit` SYNTHESIZES the hoisted `var` and
        // retypes the binding into the assignment target; if either loses its symbol it prints the
        // raw source name while the namespace getter prints the deconflicted one.
        //
        // `other.js` is imported FIRST so it keeps `a` and the lazy module is the one renamed —
        // the other order leaves the lazy binding on its source name and proves nothing.
        const { bundle } = await import('../src/bundle.ts');
        const { createMemoryFs } = await import('../src/fs.ts');
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({
                '/e.js': 'export const a = 1;\nexport let m = 2;',
                '/other.js': 'export let a = globalThis.__seed;\nexport function q() { a += 1; return a; }',
                '/d.cjs': "const e = require('./e.js');\nmodule.exports = [e.a, e.m];",
                '/main.js': "import { q } from './other.js';\nimport d from './d.cjs';\nexport const x = [d, q()];",
            }),
            output: {},
        });
        expect(r.errors).toEqual([]);
        // Whatever the getter returns is the authority — the hoisted `var` and the assignment must
        // both use that same name, and it must NOT be the un-deconflicted `a`.
        const getter = /get a\(\) \{ return ([A-Za-z$_][\w$]*); \}/.exec(r.code);
        expect(getter).not.toBeNull();
        const name = getter![1];
        expect(name).not.toBe('a');
        expect(r.code).toMatch(new RegExp(`var ${name.replace('$', '\\$')}, `));
        expect(r.code).toMatch(new RegExp(`${name.replace('$', '\\$')} = 1;`));
    });

    it('every namespace getter reads a variable the chunk actually assigns', async () => {
        // The invariant, stated without depending on how the chunk is printed: a getter body names
        // the hoisted binding, and the closure assigns that SAME binding. Under the bug the getters
        // read `a`/`m` (raw source names) while the closure assigned `e`/`t` (mangled) — so each
        // getter identifier existing as an assignment target is exactly the thing that broke.
        const code = await run(true);
        const getters = [...code.matchAll(/get \w+\(\)\{return ([A-Za-z$_][\w$]*);?\}/g)].map((m) => m[1]);
        expect(getters).toHaveLength(2);
        for (const g of getters) expect(code).toMatch(new RegExp(`[,;({]${g}=`));
    });
});
