// oxc's `tests/peephole/dead_code_elimination.rs` cases that exercise `minimize_statements`, run
// through the tree-shake-only compressor with oxc's harness: `true`/`false` spelled as a comparison
// constant folding must reduce, the expected output printed from an uncompressed parse, and a second
// run over the result to check idempotency.

import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../../src/analysis/semantic.ts';
import { type Node, parse } from '../../src/ast.ts';
import { eliminateDeadCode } from '../../src/passes/dce/compressor.ts';
import { type CompressOptions, dceOptions, rolldownDceOptions } from '../../src/passes/dce/options.ts';
import { printModule } from '../../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../../src/print/printer.ts';

function print(program: Node): string {
    const printer = createPrinter({ minify: false });
    printModule(printer, program);
    return finishPrinter(printer).trim();
}

function run(source: string, options: CompressOptions | null): string {
    const { program } = parse(source, { ts: false, jsx: false, kind: 'module' });
    if (options !== null) {
        const semantic = createSemantic();
        analyze(semantic, program, true);
        eliminateDeadCode(program, semantic, options, 'module', new Set(), true);
    }
    return print(program);
}

function testWithOptions(source: string, expected: string, options: CompressOptions): void {
    const result = run(source, options);
    expect(result).toBe(run(expected, null));
    expect(run(result, options)).toBe(result);
}

function test(source: string, expected: string): void {
    const replaced = source
        .replaceAll('true', "('production' == 'production')")
        .replaceAll('false', "('production' == 'development')");
    testWithOptions(replaced, expected, dceOptions());
}

const testSame = (source: string): void => test(source, source);

describe('minimize_statements in tree-shake mode', () => {
    it('flattens a block that does not care about scope', () => {
        test('function foo() { { bar } } foo()', 'function foo() { bar } foo()');
        test(
            'export function baz() { if (true) { foo; return } foo; if (true) { bar; return } bar; }',
            'export function baz() { foo }',
        );
    });

    it('re-emits hoisted vars from dead code and drops what they orphan', () => {
        test(
            `function f() {
              KEEP();
              return () => {
                var x;
              }
              REMOVE;
              function KEEP() { FOO }
              REMOVE;
            } f()`,
            `function f() {
              KEEP();
              return () => { }
              function KEEP() { FOO }
            } f()`,
        );
        test(
            `export function f() {
                var x = {};
                throw new Error('boom');
                module.exports = x;
             }`,
            "export function f() { throw new Error('boom'); }",
        );
    });

    it('matches terser dead-code cases', () => {
        test(
            `function f() {
                a();
                b();
                x = 10;
                return;
                if (x) {
                    y();
                }
            } f()`,
            `function f() {
                a();
                b();
                x = 10;
            } f()`,
        );
        test(
            `function f() {
                g();
                x = 10;
                throw new Error("foo");
                if (true) {
                    y();
                    var x;
                    function g(){};
                    (function(){
                        var q;
                        function y(){};
                    })();
                }
            }
            f();
            `,
            `function f() {
                g();
                x = 10;
                throw new Error("foo");
                var x;
            }
            f();
            `,
        );
    });

    it('inlines single-use declarations into the next statement', () => {
        test(
            `
var a1 = 'a1'
var a2 = 'a2'
var a3 = 'a3'
var a4 = 'a4'
var a5 = 'a5'
var a6 = 'a6'
var a7 = 'a7'
var a8 = 'a8'
var a9 = 'a9'
var a10 = 'a10'
var a11 = 'a11'
var a12 = 'a12'
var a13 = 'a13'
var a14 = 'a14'
var a15 = 'a15'
var a16 = 'a16'
var a17 = 'a17'
var a18 = 'a18'
var a19 = 'a19'
var a20 = 'a20'
var arr = [
  a1,
  a2,
  a3,
  a4,
  a5,
  a6,
  a7,
  a8,
  a9,
  a10,
  a11,
  a12,
  a13,
  a14,
  a15,
  a16,
  a17,
  a18,
  a19,
  a20
]
console.log(arr)
            `,
            `
console.log([
  'a1',
  'a2',
  'a3',
  'a4',
  'a5',
  'a6',
  'a7',
  'a8',
  'a9',
  'a10',
  'a11',
  'a12',
  'a13',
  'a14',
  'a15',
  'a16',
  'a17',
  'a18',
  'a19',
  'a20'
])
            `,
        );
        test(
            'export function f() { var ab = new ArrayBuffer(1); var dv = new DataView(ab); foo(dv); }',
            'export function f() {\n\tvar dv = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(1));\n\tfoo(dv);\n}',
        );
    });

    it('keeps a function whose name must be kept and write-only property assignments', () => {
        testSame(
            '(function() {\n\tvar r = require("react");\n\tvar o = function(e, t) {\n\t\treturn r.create(e, t);\n\t};\n\to.displayName = "X";\n})();',
        );
    });

    it('keeps the side-effect-free IIFE initializer of a removed declarator', () => {
        test('var u = (function () { return 1 })();', '(function () { return 1 })();');
        testSame('for (var u = (function () { return 1 })(); cond;) bar();');
    });

    it('removes the unreachable statements after a terminating statement', () => {
        test(
            'export function f() {\n\tif (true) {\n\t\tconst fn = () => 1;\n\t\tfn.stop = fn;\n\t\treturn fn;\n\t}\n\tconst fn = () => 2;\n\tfn.stop = fn;\n\treturn fn;\n}',
            'export function f() {\n\t{\n\t\tconst fn = () => 1;\n\t\tfn.stop = fn;\n\t\treturn fn;\n\t}\n}',
        );
        test(
            'export function f(c) { if (c) { return 1; } else { return 2; } foo(); }',
            'export function f(c) { if (c) return 1; else return 2; }',
        );
        test(
            'export function f() { try { return g(); } catch { return h(); } i(); }',
            'export function f() { try { return g(); } catch { return h(); } }',
        );
        test(
            'export function f() {\n\tif (true) {\n\t\tconst a = 1;\n\t\tuse(a);\n\t\treturn a;\n\t}\n\tvar x = g();\n}',
            'export function f() {\n\t{\n\t\tconst a = 1;\n\t\tuse(a);\n\t\treturn a;\n\t}\n}',
        );
        test(
            'export function f() {\n\tuse(() => x);\n\tif (true) {\n\t\tconst a = 1;\n\t\tuse(a);\n\t\treturn a;\n\t}\n\tvar x = g();\n}',
            'export function f() {\n\tuse(() => x);\n\t{\n\t\tconst a = 1;\n\t\tuse(a);\n\t\treturn a;\n\t}\n\tvar x;\n}',
        );
        testSame(
            'export function f() {\n\t{\n\t\tconst a = g();\n\t\tuse(a);\n\t\treturn a;\n\t}\n\tfunction g() {\n\t\treturn 2;\n\t}\n}',
        );
        testSame('export function f(c) {\n\t{\n\t\tlet a = g();\n\t\tif (c) return a;\n\t}\n\treturn foo();\n}');
        test(
            'export function f() {\n\t{\n\t\tconst a = g();\n\t\ta.x = a;\n\t\treturn a;\n\t\tfunction g() {\n\t\t\treturn {};\n\t\t}\n\t}\n\ttail();\n}',
            'export function f() {\n\t{\n\t\tconst a = g();\n\t\ta.x = a;\n\t\treturn a;\n\t\tfunction g() {\n\t\t\treturn {};\n\t\t}\n\t}\n}',
        );
        test(
            'export function f() {\n\tuse(() => x);\n\t{\n\t\tlet a = g();\n\t\tuse(a);\n\t\treturn a;\n\t\tvar x = h();\n\t}\n\ttail();\n}',
            'export function f() {\n\tuse(() => x);\n\t{\n\t\tlet a = g();\n\t\tuse(a);\n\t\treturn a;\n\t\tvar x;\n\t}\n}',
        );
        testSame(
            'export function f(c) {\n\t{\n\t\tif (c) return g();\n\t\tfunction g() {\n\t\t\treturn 1;\n\t\t}\n\t}\n\treturn tail();\n}',
        );
    });
});

// Confirmed against rolldown 1.2.4 with `minify: false`, which runs this pass over each module.
describe('minimize_statements against rolldown', () => {
    const rolldown = (source: string, expected: string): void => testWithOptions(source, expected, rolldownDceOptions());

    it('removes empty switch cases', () => {
        rolldown(
            'export function f(x) { switch (x) { case 0: foo(); break; case 1: default: } }',
            'export function f(x) { switch (x) { case 0: foo(); } }',
        );
        rolldown('export function f(x) { switch (x) { case 1: case 2: } }', 'export function f(x) {}');
        rolldown(
            'export function f(x) { switch (x) { case 0: foo(); break; } }',
            'export function f(x) { switch (x) { case 0: foo(); } }',
        );
        rolldown('export function f(x) { switch (g()) { default: } }', 'export function f(x) { g(); }');
    });

    it('moves a preceding var into a for-of head', () => {
        rolldown('export function f(b) { var a; for (a of b) g(a); }', 'export function f(b) { for (var a of b) g(a); }');
    });

    it('drops an undefined return value and the trailing bare return', () => {
        rolldown('export function f() { g(); return void 0; }', 'export function f() { g(); }');
        rolldown('export function f() { return void g(); }', 'export function f() { g(); }');
    });

    it('merges assignments into the preceding declaration', () => {
        rolldown('export function f() { var a; a = b(); return a + a; }', 'export function f() { var a = b(); return a + a; }');
        rolldown(
            'export function f() { let a; a = b(); return a + a; }',
            'export function f() { let a; a = b(); return a + a; }',
        );
        rolldown(
            'export function f() { var a, c; a = b(), c = d(), e(); return a + a + c + c; }',
            'export function f() { var a = b(), c = d(); e(); return a + a + c + c; }',
        );
    });

    it('removes unused for-init declarators', () => {
        rolldown(
            'export function f() { for (var i = 0, u = 1; i < 3; i++) g(i); }',
            'export function f() { for (var i = 0; i < 3; i++) g(i); }',
        );
    });

    it('substitutes a single-use declaration where reordering is safe', () => {
        rolldown('export function f() { const x = g(); return h(x); }', 'export function f() { const x = g(); return h(x); }');
        rolldown(
            'export function f() { const x = g(); k(); return h(x); }',
            'export function f() { const x = g(); k(); return h(x); }',
        );
        rolldown('export function f() { const x = g(); if (x) h(); }', 'export function f() { if (g()) h(); }');
        rolldown('export function f() { const x = g(); throw x; }', 'export function f() { throw g(); }');
        rolldown('export function f(o) { const x = g(); o.p = x; }', 'export function f(o) { o.p = g(); }');
        rolldown('export function f() { const x = g(); y = x; }', 'export function f() { y = g(); }');
        rolldown(
            'export function f() { const x = g(); for (const k of x) h(k); }',
            'export function f() { const x = g(); for (const k of x) h(k); }',
        );
        rolldown(
            'export async function f() { const x = g(); return await x; }',
            'export async function f() { return await g(); }',
        );
        rolldown('export function f(a) { const x = a.b; return x(); }', 'export function f(a) { const x = a.b; return x(); }');
        rolldown(
            'export function f() { const x = g(); return { __proto__: x }; }',
            'export function f() { return { __proto__: g() }; }',
        );
        rolldown(
            'export function f() { const __proto__ = g(); return { __proto__ }; }',
            'export function f() { return { ["__proto__"]: g() }; }',
        );
    });

    it('removes a trailing continue or break that ends a loop body', () => {
        rolldown('export function f() { for (;;) { g(); continue; } }', 'export function f() { for (;;) g(); }');
        rolldown('export function f() { while (c()) { g(); continue; } }', 'export function f() { while (c()) g(); }');
        rolldown('export function f() { do { g(); break; } while (false) }', 'export function f() { do g(); while (false); }');
    });

    it('flattens blocks without lexical declarations', () => {
        rolldown(
            'export function f() { { let a = g(); h(a, a); } { k(); } }',
            'export function f() { { let a = g(); h(a, a); } k(); }',
        );
    });
});
