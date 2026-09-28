// oxc's tree-shake-only tests for remove_dead_code.rs (tests/peephole/dead_code_elimination.rs), run
// through `eliminateDeadCode` with `CompressOptions::dce()`.
import { describe, expect, it } from 'vitest';
import { verifyRefFacts } from '../../src/analysis/ref-facts.ts';
import { analyze, createSemantic } from '../../src/analysis/semantic.ts';
import { type Node, parse } from '../../src/ast.ts';
import { eliminateDeadCode } from '../../src/passes/dce/compressor.ts';
import { type CompressOptions, dceOptions } from '../../src/passes/dce/options.ts';
import { printModule } from '../../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../../src/print/printer.ts';

function print(program: Node): string {
    const printer = createPrinter({ minify: false });
    printModule(printer, program);
    return finishPrinter(printer).trim();
}

const parseModule = (source: string): Node => parse(source, { ts: false, jsx: false, kind: 'module' }).program;

function run(source: string, options: CompressOptions): { output: string; iterations: number } {
    const program = parseModule(source);
    const semantic = createSemantic();
    analyze(semantic, program, true);
    const { iterations } = eliminateDeadCode(program, semantic, options, 'module', new Set(), true);
    expect(verifyRefFacts(semantic, program)).toEqual([]);
    return { output: print(program), iterations };
}

/** oxc `test_with_options_source_type`: the output matches, and a second run changes nothing. */
function expectDce(source: string, expected: string, options: CompressOptions = dceOptions()): number {
    const { output, iterations } = run(source, options);
    expect(output).toBe(print(parseModule(expected)));
    expect(run(output, options).output).toBe(output);
    return iterations;
}

/** oxc `test`: `true`/`false` become comparisons only constant evaluation can fold. */
const withFoldableBooleans = (source: string): string =>
    source.replaceAll('true', "('production' == 'production')").replaceAll('false', "('production' == 'development')");

const test = (source: string, expected: string): void => void expectDce(withFoldableBooleans(source), expected);
const testSame = (source: string): void => test(source, source);

const dropLabelOptions = (...labels: string[]): CompressOptions => ({ ...dceOptions(), dropLabels: new Set(labels) });

describe('remove_dead_code (tree-shake only)', () => {
    it('dce_if_statement', () => {
        test('if (true) { foo }', 'foo');
        test('if (true) { foo } else { bar }', 'foo');
        test('if (false) { foo } else { bar }', 'bar');

        test('if (xxx) { foo } else if (false) { bar }', 'if (xxx) foo');
        test('if (xxx) { foo } else if (false) { bar } else { baz }', 'if (xxx) foo; else baz');
        test('if (xxx) { foo } else if (false) { bar } else if (false) { baz }', 'if (xxx) foo');
        test('if (xxx) { foo } else if (false) { bar } else if (false) { baz } else { quaz }', 'if (xxx) foo; else quaz');
        test('if (xxx) { foo } else if (true) { bar } else if (false) { baz }', 'if (xxx) foo; else bar');
        test('if (xxx) { foo } else if (false) { bar } else if (true) { baz }', 'if (xxx) foo; else baz');
        test('if (xxx) { foo } else if (true) { bar } else if (true) { baz }', 'if (xxx) foo; else bar');
        test(
            'if (xxx) { foo } else if (false) { var a; var b; } else if (false) { var c; var d; } f(a,b,c,d)',
            'if (xxx) foo; else if (0) var a, b; else if (0) var c, d; f(a,b,c,d)',
        );

        test('if (!false) { foo }', 'foo');
        test('if (!true) { foo } else { bar }', 'bar');

        test('if (!false && xxx) { foo }', 'if (xxx) foo');
        test('if (!true && yyy) { foo } else { bar }', 'bar');
        test('if (xxx && false) { foo } else { bar }', 'if (xxx && false); else bar');

        test('if (true || xxx) { foo }', 'foo');
        test('if (false || xxx) { foo }', 'if (xxx) foo');
        test('if (xxx || true) { foo } else { bar }', 'if (xxx || true) foo');

        test("if ('production' == 'production') { foo } else { bar }", 'foo');
        test("if ('development' == 'production') { foo } else { bar }", 'bar');

        test("if ('production' === 'production') { foo } else { bar }", 'foo');
        test("if ('development' === 'production') { foo } else { bar }", 'bar');

        // Shadowed `undefined` as a variable should not be erased.
        testSame("function foo(undefined) { if (!undefined) throw Error('') } foo()");

        test('function foo() { if (undefined) { bar } } foo()', '');
        test('function foo() { { bar } } foo()', 'function foo() { bar } foo()');

        test('if (true) { foo; } if (true) { foo; }', 'foo; foo;');
        test(
            'export function baz() { if (true) { foo; return } foo; if (true) { bar; return } bar; }',
            'export function baz() { foo }',
        );

        // nested expression
        test('const a = { fn: function() { if (true) { foo; } } }; bar(a)', 'bar({ fn: function() { foo; } })');

        // parenthesized
        test('if (!!(false)) { REMOVE; } else { KEEP; }', 'KEEP');

        // typeof
        test("if (typeof 1 !== 'number') { REMOVE; }", '');
        test("if (typeof false !== 'boolean') { REMOVE; }", '');
        test("if (typeof 1 === 'string') { REMOVE; }", '');

        test(
            `if (unknown)
                for (var x = 1; x-- > 0; )
                    if (foo++, false) foo++;
                    else 'Side effect free code to be dropped';
                else throw new Error();`,
            `if (unknown) {
                for (var x = 1; x-- > 0;) if (foo++, false);
               } else throw new Error();`,
        );
    });

    it('dce_while_statement', () => {
        testSame('while (true);');
        testSame('while (false);');
    });

    it('dce_conditional_expression', () => {
        test('false ? foo : bar;', 'bar');
        test('true ? foo : bar;', 'foo');

        test('!true ? foo : bar;', 'bar');
        test('!false ? foo : bar;', 'foo');

        test('!!false ? foo : bar;', 'bar');
        test('!!true ? foo : bar;', 'foo');

        test('const foo = true ? A : B', 'A');
        test('const foo = false ? A : B', 'B');
    });

    it('dce_var_hoisting', () => {
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
            `function f() {
              KEEP();
              return function g() {
                var x;
              }
              REMOVE;
              function KEEP() {}
              REMOVE;
            } f()`,
            '',
        );
    });

    it('dce_from_terser', () => {
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
            f();`,
            `function f() {
                g();
                x = 10;
                throw new Error("foo");
                var x;
            }
            f();`,
        );
        test(
            `if (0) {
                let foo = 6;
                const bar = 12;
                class Baz {};
                var qux;
            }
            console.log(foo, bar, Baz);`,
            'console.log(foo, bar, Baz);',
        );
    });

    it('dropped_direct_eval_converges_after_liveness_refresh', () => {
        expect(expectDce(withFoldableBooleans("if (false) eval('x'); function f() { f() }"), '')).toBe(2);
    });

    it('drop_labels', () => {
        expectDce('PURE: { foo(); bar(); }', '', dropLabelOptions('PURE'));
        expectDce('PURE: { foo(); } TEST: { bar(); } OTHER: { baz(); }', 'OTHER: baz();', dropLabelOptions('PURE', 'TEST'));
        expectDce('PURE: { PURE: { foo(); } }', '', dropLabelOptions('PURE'));
        expectDce('PURE: { var x = 1; foo(x); }', '', dropLabelOptions('PURE'));
    });

    it('remove_pure_function_calls', () => {
        test('function noop() {} noop()', '');
        test('var foo = () => 1; foo(), foo()', '');
        test('var foo = function() {}; foo()', '');
        testSame('function foo() { bar() } foo()');
    });

    it('test_fold_if_keep_var_filter_converges', () => {
        testSame('function f() {\n\tif (0) var x, y;\n\ty = 1;\n\treturn y;\n}\nf();');
    });

    it('dce_remove_unreachable_after_terminating_statement', () => {
        test(
            'export function f(c) { if (c) { return 1; } else { return 2; } foo(); }',
            'export function f(c) { if (c) return 1; else return 2; }',
        );
        test(
            'export function f() { try { return g(); } catch { return h(); } i(); }',
            'export function f() { try { return g(); } catch { return h(); } }',
        );
    });
});

// Cases for the branches the oxc suite above does not reach in tree-shake mode, checked against
// rolldown 1.2.4 with `minify: false`.
describe('remove_dead_code branches', () => {
    it('folds labeled statements that only break themselves', () => {
        expectDce('a: break a; foo();', 'foo();');
        expectDce('a: { break a; var x = 1; } foo(x);', 'var x; foo(x);');
        expectDce('a: ; foo();', 'foo();');
        expectDce('a: { foo(); break a; }', 'a: { foo(); break a; }');
    });

    it('folds try statements', () => {
        expectDce('try {} catch (e) { foo(); } bar();', 'bar();');
        expectDce('try {} catch (e) { var x = foo(); } bar(x);', 'try {} catch (e) { var x; } bar(x);');
        expectDce('try { foo(); } catch (e) {} finally {}', 'try { foo(); } catch (e) {}');
        expectDce('try {} finally { foo(); }', 'foo();');
    });

    it('folds for statements with a constant test', () => {
        expectDce('for (;false;) foo();', '');
        expectDce(
            'export function f() { for (var i = 0; false;) { var x = foo(); } bar(i, x); }',
            'export function f() { var i = 0, x; bar(i, x); }',
        );
        expectDce('for (let i = 0; false;) foo();', '');
        expectDce('for (;true;) foo();', 'for (;;) foo();');
        expectDce('for (1; x; 2) foo();', 'for (; x;) foo();');
    });

    it('keeps an indirect access in callee and operand positions', () => {
        expectDce('(1 ? a.b : 0)();', '(0, a.b)();');
        expectDce('(1 ? eval : 0)("x");', '(0, eval)("x");');
        expectDce('(1 ? foo : 0)();', 'foo();');
        expectDce('(x(), 1 ? a.b : 0)();', '(x(), a.b)();');
        expectDce('bar(typeof (1 ? foo : 0));', 'bar(typeof (0, foo));');
        expectDce('delete (1 ? a.b : 0);', 'delete (0, a.b);');
        expectDce('(1, 2, a.b)();', '(0, a.b)();');
    });

    it('replaces calls to side-effect-free functions that return undefined', () => {
        expectDce('function g() {} g(1, a(), ...b);', 'a(), [...b];');
        expectDce('function g() {} g();', '');
    });

    it('unwraps single-statement blocks unless a declaration pins them', () => {
        expectDce('{ foo(); }', 'foo();');
        expectDce('export function f() { { let x = foo(); bar(x); } }', 'export function f() { { let x = foo(); bar(x); } }');
        expectDce('if (a) { if (b) c(); else d(); } else e();', 'if (a) { if (b) c(); else d(); } else e();');
        expectDce('if (a) { if (b) c(); } else e();', 'if (a) { if (b) c(); } else e();');
        expectDce('while (x) {}', 'while (x);');
    });
});
