// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are JS source under test.
// Ported from oxc_minifier/tests/peephole/remove_dead_code.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { smallestOptions } from '../../src/passes/minifier/options.ts';
import { defaultOptions, test, testOptions, testSame, testSameOptions } from './harness.ts';

const testUnused = (source: string, expected: string): void =>
    testOptions(source, expected, { ...defaultOptions(), unused: 'remove' });

describe('test_fold_block', () => {
    it('{{foo()}}', () => test('{{foo()}}', 'foo()'));
    it('{foo();{}}', () => test('{foo();{}}', 'foo()'));
    it('{{foo()}{}}', () => test('{{foo()}{}}', 'foo()'));
    it('{{foo()}{bar()}}', () => test('{{foo()}{bar()}}', 'foo(), bar()'));
    it('{if(false)foo(); {bar()}}', () => test('{if(false)foo(); {bar()}}', 'bar()'));
    it('{if(false)if(false)if(false)foo(); {bar()}}', () => test('{if(false)if(false)if(false)foo(); {bar()}}', 'bar()'));
    it("{'hi'}", () => test("{'hi'}", ''));
    it('{x==3}', () => test('{x==3}', 'x'));
    it('{`hello ${foo}`}', () => test('{`hello ${foo}`}', '`${foo}`'));
    it('{ (function(){x++}) }', () => test('{ (function(){x++}) }', ''));
    it('{ (function foo(){x++; foo()}) }', () => test('{ (function foo(){x++; foo()}) }', ''));
    it('function f(){return;}', () => test('function f(){return;}', 'function f(){}'));
    it('function f(){return 3;}', () => test('function f(){return 3;}', 'function f(){return 3}'));
    it('function f(){if(x)return; x=3; return; }', () =>
        test('function f(){if(x)return; x=3; return; }', 'function f(){ x ||= 3; }'));
    it('{x=3;;;y=2;;;}', () => test('{x=3;;;y=2;;;}', 'x=3, y=2'));
    // Cases to test for empty block.
    // test("while(x()){x}", "while(x());");
    it('while(x()){x()}', () => test('while(x()){x()}', 'for(;x();)x()'));
    // test("for(x=0;x<100;x++){x}", "for(x=0;x<100;x++);");
    // test("for(x in y){x}", "for(x in y);");
    // test("for (x of y) {x}", "for(x of y);");
    it('for (let x = 1; x <10; x++ ) {}', () => test('for (let x = 1; x <10; x++ ) {}', 'for (let x = 1; x <10; x++ );'));
    it('for (var x = 1; x <10; x++ ) {}', () => test('for (var x = 1; x <10; x++ ) {}', 'for (var x = 1; x <10; x++ );'));
    it('do { } while (true)', () => test('do { } while (true)', 'do;while(!0)'));
    it('function z(a) { { for (var i = 0; i < a; i++) {} foo() } bar() }', () =>
        test(
            'function z(a) {\n          {\n            for (var i = 0; i < a; i++) {}\n            foo()\n          }\n          bar()\n        }',
            'function z(a) {\n          for (var i = 0; i < a; i++);\n          foo(), bar()\n        }',
        ));
});

describe('test_remove_no_op_labelled_statement', () => {
    it('a: break a;', () => test('a: break a;', ''));
    it('a: { break a; }', () => test('a: { break a; }', ''));
    it("a: { break a; console.log('unreachable'); }", () => test("a: { break a; console.log('unreachable'); }", ''));
    it('a: { break a; var x = 1; } x = 2;', () => test('a: { break a; var x = 1; } x = 2;', 'var x = 2;'));
    it('b: { var x = 1; } x = 2;', () => test('b: { var x = 1; } x = 2;', 'b: var x = 1; x = 2;'));
    it('a: b: { var x = 1; } x = 2;', () => test('a: b: { var x = 1; } x = 2;', 'a: b: var x = 1; x = 2;'));
    it('foo:;', () => test('foo:;', ''));
});

describe('test_fold_useless_for', () => {
    it('for(;false;) { foo() }', () => test('for(;false;) { foo() }', ''));
    it('for(;void 0;) { foo() }', () => test('for(;void 0;) { foo() }', ''));
    it('for(;undefined;) { foo() }', () => test('for(;undefined;) { foo() }', ''));
    it('for(;true;) foo()', () => test('for(;true;) foo() ', 'for(;;) foo() '));
    it('for(;;) foo()', () => testSame('for(;;) foo()'));
    it('for(;false;) { var a = 0; }', () => test('for(;false;) { var a = 0; }', 'var a'));
    it('for(;false;) { const a = 0; }', () => test('for(;false;) { const a = 0; }', ''));
    it('for(;false;) { let a = 0; }', () => test('for(;false;) { let a = 0; }', ''));
    // Make sure it plays nice with minimizing
    it('for(;false;) { foo(); continue }', () => test('for(;false;) { foo(); continue }', ''));
    it('for (var { c, x: [d] } = {}; 0;);', () => test('for (var { c, x: [d] } = {}; 0;);', 'var { c, x: [d] } = {};'));
    it('for (var se = [1, 2]; false;);', () => test('for (var se = [1, 2]; false;);', 'var se = [1, 2];'));
    it('for (var se = [1, 2]; false;) { var a = 0; }', () =>
        test('for (var se = [1, 2]; false;) { var a = 0; }', 'var se = [1, 2], a;'));
    it('for (foo = bar; false;) {}', () => test('for (foo = bar; false;) {}', 'for (foo = bar; !1;);'));
    // test("l1:for(;false;) {  }", "");
});

describe('test_minimize_loop_with_constant_condition_vanilla_for', () => {
    it('for(;true;) foo()', () => test('for(;true;) foo()', 'for(;;) foo()'));
    it('for(;0;) foo()', () => test('for(;0;) foo()', ''));
    it('for(;0.0;) foo()', () => test('for(;0.0;) foo()', ''));
    it('for(;NaN;) foo()', () => test('for(;NaN;) foo()', ''));
    it('for(;null;) foo()', () => test('for(;null;) foo()', ''));
    it('for(;undefined;) foo()', () => test('for(;undefined;) foo()', ''));
    it("for(;'';) foo()", () => test("for(;'';) foo()", ''));
});

describe('test_fold_try_statement', () => {
    it('try { throw 0 } catch (e) { foo() }', () =>
        test('try { throw 0 } catch (e) { foo() }', 'try { throw 0 } catch { foo() }'));
    it('try {} catch (e) { var foo }', () => test('try {} catch (e) { var foo }', 'try {} catch { var foo }'));
    it('try {} catch (e) { var foo; bar() } finally {}', () =>
        test('try {} catch (e) { var foo; bar() } finally {}', 'try {} catch { var foo }'));
    it('try {} catch (e) { var foo; bar() } finally { baz() }', () =>
        test('try {} catch (e) { var foo; bar() } finally { baz() }', 'try {} catch { var foo } finally { baz() }'));
    it('try {} catch (e) { foo() }', () => test('try {} catch (e) { foo() }', ''));
    it('try {} catch (e) { foo() } finally {}', () => test('try {} catch (e) { foo() } finally {}', ''));
    it('try {} finally { foo() }', () => test('try {} finally { foo() }', 'foo()'));
    it('try {} catch (e) { foo() } finally { bar() }', () => test('try {} catch (e) { foo() } finally { bar() }', 'bar()'));
    it('try {} finally { var x = foo() }', () => test('try {} finally { var x = foo() }', 'var x = foo()'));
    it('try {} catch (e) { foo() } finally { var x = bar() }', () =>
        test('try {} catch (e) { foo() } finally { var x = bar() }', 'var x = bar()'));
    it('try {} finally { let x = foo() }', () => test('try {} finally { let x = foo() }', '{ let x = foo() }'));
    it('try {} catch (e) { foo() } finally { let x = bar() }', () =>
        test('try {} catch (e) { foo() } finally { let x = bar() }', '{ let x = bar();}'));
    it('try {} catch (e) { } finally {}', () => test('try {} catch (e) { } finally {}', ''));
    it('try { foo() } catch (e) { bar() } finally {}', () =>
        test('try { foo() } catch (e) { bar() } finally {}', 'try { foo() } catch { bar() }'));
    it('try { foo() } catch { bar() } finally { baz() }', () => testSame('try { foo() } catch { bar() } finally { baz() }'));
    // Leak regression: when the empty `try` drops, the catch arm's write-ref
    // to `x` must be walked into `PassChanges`, else the stale write blocks
    // constant inlining of `x`.
    const options = smallestOptions();
    it("let x = 'initial'; try {} catch (e) { x = 'unexpected'; } console.log(x);", () =>
        testOptions(
            "let x = 'initial'; try {} catch (e) { x = 'unexpected'; } console.log(x);",
            "console.log('initial');",
            options,
        ));
});

describe('test_fold_if_statement', () => {
    it('if (foo) {}', () => test('if (foo) {}', 'foo'));
    it('if (foo) {} else {}', () => test('if (foo) {} else {}', 'foo'));
    it('if (false) {}', () => test('if (false) {}', ''));
    it('if (true) {}', () => test('if (true) {}', ''));
    it('if (false) { var a; console.log(a) }', () => test('if (false) { var a; console.log(a) }', 'if (0) var a'));
    it('if (false) { var a; console.log(a) }', () => testUnused('if (false) { var a; console.log(a) }', ''));
});

describe('test_fold_conditional', () => {
    it('true ? foo() : bar()', () => test('true ? foo() : bar()', 'foo()'));
    it('false ? foo() : bar()', () => test('false ? foo() : bar()', 'bar()'));
    it('foo() ? bar() : baz()', () => testSame('foo() ? bar() : baz()'));
    it('foo && false ? foo() : bar()', () => test('foo && false ? foo() : bar()', '(foo, bar());'));
    it('var a; (true ? a : 0)()', () => test('var a; (true ? a : 0)()', 'var a; a()'));
    it('var a; (true ? a.b : 0)()', () => test('var a; (true ? a.b : 0)()', 'var a; (0, a.b)()'));
    it('var a; (false ? 0 : a)()', () => test('var a; (false ? 0 : a)()', 'var a; a()'));
    it('var a; (false ? 0 : a.b)()', () => test('var a; (false ? 0 : a.b)()', 'var a; (0, a.b)()'));
});

describe('test_remove_empty_static_block', () => {
    it('class Foo { static {}; foo }', () => test('class Foo { static {}; foo }', 'class Foo { foo }'));
    it('class Foo { static { foo() } }', () => testSame('class Foo { static { foo() } }'));
});

describe('keep_module_syntax', () => {
    it('throw foo; export let bar', () => testSame('throw foo; export let bar'));
    it('throw foo; export default bar', () => testSame('throw foo; export default bar'));
});

describe('remove_empty_spread_arguments', () => {
    it('foo(...[])', () => test('foo(...[])', 'foo()'));
    it('new Foo(...[])', () => test('new Foo(...[])', 'new Foo()'));
});

describe('remove_unreachable', () => {
    it('while(true) { break a; unreachable;}', () => test('while(true) { break a; unreachable;}', 'for(;;) break a'));
    it('while(true) { continue a; unreachable;}', () => test('while(true) { continue a; unreachable;}', 'for(;;) continue a'));
    it('while(true) { throw a; unreachable;}', () => test('while(true) { throw a; unreachable;}', 'for(;;) throw a'));
    it('while(true) { return a; unreachable;}', () => test('while(true) { return a; unreachable;}', 'for(;;) return a'));
    // A kept function declaration (not a dead IIFE) so the unreachable `var a`
    // after `return` is preserved under `unused: Keep`.
    it('function f() { return; var a }', () => test('function f() { return; var a }', 'function f() { return; var a }'));
    it('(function () { return; var a })()', () => testUnused('(function () { return; var a })()', ''));
    // https://github.com/rolldown/rolldown/issues/10184
    // A statement that never completes normally also terminates the list:
    // a block pinned by its lexical declaration, or a try/catch where both
    // blocks jump.
    it('function f() { { const a = g(); a.x = a; return a; } h(); }', () =>
        test(
            'function f() { { const a = g(); a.x = a; return a; } h(); }',
            'function f() { { let a = g(); return a.x = a, a; } }',
        ));
    it('function f() { try { return g(); } catch { return h(); } i(); }', () =>
        test(
            'function f() { try { return g(); } catch { return h(); } i(); }',
            'function f() { try { return g(); } catch { return h(); } }',
        ));
    // Negative: the block can complete normally, so the tail stays.
    it('function f(c) { { let a = g(); if (c) return a; } return foo(); }', () =>
        testSame('function f(c) { { let a = g(); if (c) return a; } return foo(); }'));
    // Hoisting survivors trailing the jump inside the block — a kept
    // `function` declaration or a `var` stub re-emitted by `KeepVar` — don't
    // hide that the block terminates.
    it('function f() { { const a = g(); a.x = a; return a; function g() { return {} } } h(); }', () =>
        test(
            'function f() { { const a = g(); a.x = a; return a; function g() { return {} } } h(); }',
            'function f() { { let a = g(); return a.x = a, a; function g() { return {} } } }',
        ));
    it('function f() { use(() => x); { let a = g(); use(a); return a; var x = h(); } tail(); }', () =>
        test(
            'function f() { use(() => x); { let a = g(); use(a); return a; var x = h(); } tail(); }',
            'function f() { use(() => x); { let a = g(); return use(a), a; var x; } }',
        ));
});

describe('remove_unused_expressions_in_sequence', () => {
    it('true, foo();', () => test('true, foo();', 'foo();'));
    it('(0, foo)();', () => test('(0, foo)();', 'foo();'));
    it('(0, foo)``;', () => test('(0, foo)``;', 'foo``;'));
    it('(0, foo)?.();', () => test('(0, foo)?.();', 'foo?.();'));
    it('(0, eval)();', () => testSame('(0, eval)();'));
    // this can be compressed to `eval?.()`
    it('(0, eval)``;', () => testSame('(0, eval)``;'));
    // this can be compressed to `eval?.()`
    it('(0, eval)?.();', () => testSame('(0, eval)?.();'));
    // this can be compressed to `eval?.()`
    it('var eval; (0, eval)();', () => test('var eval; (0, eval)();', 'var eval; eval();'));
    it('(0, foo.bar)();', () => testSame('(0, foo.bar)();'));
    it('(0, foo.bar)``;', () => testSame('(0, foo.bar)``;'));
    it('(0, foo.bar)?.();', () => testSame('(0, foo.bar)?.();'));
    it('(true, foo.bar)();', () => test('(true, foo.bar)();', '(0, foo.bar)();'));
    it('(true, true, foo.bar)();', () => test('(true, true, foo.bar)();', '(0, foo.bar)();'));
    it('var foo; (true, foo.bar)();', () => test('var foo; (true, foo.bar)();', 'var foo; (0, foo.bar)();'));
    it('var foo; (true, true, foo.bar)();', () => test('var foo; (true, true, foo.bar)();', 'var foo; (0, foo.bar)();'));
    // Regression: a >=3 element sequence in indirect-access position whose
    // second-to-last element is already `0` must converge. Re-wrapping the
    // already-`0` element re-records a mutation every iteration, spinning
    // the fixed-point loop into the 10-iteration debug_assert.
    it('(sideEffect(), 0, foo.bar)();', () => testSame('(sideEffect(), 0, foo.bar)();'));
    it('delete (sideEffect(), 0, foo.bar);', () => testSame('delete (sideEffect(), 0, foo.bar);'));
    it('typeof (0, foo);', () => test('typeof (0, foo);', 'foo'));
    it('v = typeof (0, foo);', () => testSame('v = typeof (0, foo);'));
    it('var foo; typeof (0, foo);', () => test('var foo; typeof (0, foo);', 'var foo;'));
    it('var foo; v = typeof (0, foo);', () => test('var foo; v = typeof (0, foo);', 'var foo; v = typeof foo'));
    it('typeof 0', () => test('typeof 0', ''));
    it('delete (0, foo);', () => testSame('delete (0, foo);'));
    it('delete (0, foo.#bar);', () => testSame('delete (0, foo.#bar);'));
    it('delete (0, foo.bar);', () => testSame('delete (0, foo.bar);'));
    it('delete (0, foo[bar]);', () => testSame('delete (0, foo[bar]);'));
    it('delete (0, foo?.bar);', () => testSame('delete (0, foo?.bar);'));
});

describe('remove_unused_expressions_in_for', () => {
    it('var i; for (i = 0, 0; i < 10; i++) foo(i);', () =>
        test('var i; for (i = 0, 0; i < 10; i++) foo(i);', 'var i; for (i = 0; i < 10; i++) foo(i);'));
    it('var i; for (i = 0; i < 10; 0, i++, 0) foo(i);', () =>
        test('var i; for (i = 0; i < 10; 0, i++, 0) foo(i);', 'var i; for (i = 0; i < 10; i++) foo(i);'));
});

describe('remove_constant_value', () => {
    it("const foo = false; if (foo) { console.log('foo') }", () =>
        test("const foo = false; if (foo) { console.log('foo') }", 'const foo = !1;'));
});

describe('remove_empty_function', () => {
    const options = smallestOptions();
    it('function foo() {} foo()', () => testOptions('function foo() {} foo()', '', options));
    it('function foo() {} foo(); foo()', () => testOptions('function foo() {} foo(); foo()', '', options));
    it('var foo = () => {}; foo()', () => testOptions('var foo = () => {}; foo()', '', options));
    it('var foo = () => {}; foo(a)', () => testOptions('var foo = () => {}; foo(a)', 'a', options));
    it('var foo = () => {}; foo(a, b)', () => testOptions('var foo = () => {}; foo(a, b)', 'a, b', options));
    it('var foo = () => {}; foo(...a, b)', () => testOptions('var foo = () => {}; foo(...a, b)', '[...a], b', options));
    it('var foo = () => {}; foo(...a, ...b)', () =>
        testOptions('var foo = () => {}; foo(...a, ...b)', '[...a], [...b]', options));
    it('var foo = () => {}; x = foo()', () => testOptions('var foo = () => {}; x = foo()', 'x = void 0', options));
    it('var foo = () => {}; x = foo(a(), b())', () =>
        testOptions('var foo = () => {}; x = foo(a(), b())', 'x = (a(), b(), void 0)', options));
    it('var foo = function () {}; foo()', () => testOptions('var foo = function () {}; foo()', '', options));
    it('var foo = (a = 0) => {}; foo()', () => testOptions('var foo = (a = 0) => {}; foo()', '', options));
    it('var foo = (a = side_effect()) => {}; foo()', () =>
        testOptions('var foo = (a = side_effect()) => {}; foo()', '((a = side_effect()) => {})()', options));
    it('function foo(a = side_effect()) {} foo()', () => testSameOptions('function foo(a = side_effect()) {} foo()', options));
    it('function foo({}) {} foo()', () => testSameOptions('function foo({}) {} foo()', options));
    it('var foo = ({}) => {}; foo()', () => testOptions('var foo = ({}) => {}; foo()', '(({}) => {})()', options));
    it('var foo = function ({}) {}; foo()', () =>
        testOptions('var foo = function ({}) {}; foo()', '(function ({}) {})()', options));
    it('async function foo({}) {} foo()', () => testSameOptions('async function foo({}) {} foo()', options));
    it('var foo = async ({}) => {}; foo()', () =>
        testOptions('var foo = async ({}) => {}; foo()', '(async ({}) => {})()', options));
    it('var foo = async function ({}) {}; foo()', () =>
        testOptions('var foo = async function ({}) {}; foo()', '(async function ({}) {})()', options));
    it('function* foo({}) {} foo()', () => testSameOptions('function* foo({}) {} foo()', options));
    it('var foo = function*({}) {}; foo()', () =>
        testOptions('var foo = function*({}) {}; foo()', '(function*({}) {})()', options));
});

describe('redeclared_pure_function_is_not_folded_var', () => {
    it("var foo = (u) => {}; if (g) var foo = (a) => { console.log(a); }; foo('x');", () =>
        testSame("var foo = (u) => {}; if (g) var foo = (a) => { console.log(a); }; foo('x');"));
});

describe('redeclared_pure_function_is_not_folded_function_declaration', () => {
    it("function foo(u) {} function foo(a) { console.log(a); } foo('x');", () =>
        testOptions(
            "function foo(u) {} function foo(a) { console.log(a); } foo('x');",
            "function foo(u) {} function foo(a) { console.log(a); } foo('x');",
            defaultOptions(),
            'script',
        ));
});

describe('direct_eval_rebound_function_is_not_folded', () => {
    it('function foo() {} eval("foo = () => side_effect()"); foo();', () =>
        test(
            'function foo() {} eval("foo = () => side_effect()"); foo();',
            'function foo() {} eval("foo = () => side_effect()"), foo();',
        ));
});

describe('nested_direct_eval_rebound_function_is_not_folded', () => {
    it('function foo() {} function g() { eval("foo = () => side_effect()") } g(); foo();', () =>
        test(
            'function foo() {} function g() { eval("foo = () => side_effect()") } g(); foo();',
            'function foo() {} function g() { eval("foo = () => side_effect()") } g(), foo();',
        ));
});

describe('removed_direct_eval_reenables_pure_function_folding', () => {
    it('function foo() {} if (0) eval("foo = () => side_effect()"); foo();', () =>
        testOptions('function foo() {} if (0) eval("foo = () => side_effect()"); foo();', '', smallestOptions(), 'commonjs'));
});

describe('script_root_rebound_function_is_not_folded', () => {
    it('function foo() {} globalThis.foo = () => side_effect(); foo();', () =>
        testOptions(
            'function foo() {} globalThis.foo = () => side_effect(); foo();',
            'function foo() {} globalThis.foo = () => side_effect(), foo();',
            defaultOptions(),
            'script',
        ));
});

describe('non_redeclared_pure_function_still_folds', () => {
    it('const foo = (u) => {}; foo(1)', () => test('const foo = (u) => {}; foo(1)', 'const foo = (u) => {};'));
    it('function foo() {} foo()', () =>
        testOptions('function foo() {} foo()', 'function foo() {}', defaultOptions(), 'commonjs'));
});
