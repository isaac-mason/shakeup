// oxc's tests for remove_unused_expression.rs (tests/peephole/remove_unused_expression.rs and the
// tree-shake cases in tests/peephole/dead_code_elimination.rs), run through `eliminateDeadCode` with
// `CompressOptions::dce()`. oxc runs most of the first file under full minification; the expectations
// here are tree-shake mode's, checked against rolldown 1.2.4 with `minify: false`.
import { describe, expect, it } from 'vitest';
import { verifyRefFacts } from '../../src/analysis/ref-facts.ts';
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

const parseModule = (source: string): Node => parse(source, { ts: false, jsx: false, kind: 'module' }).program;

function run(source: string, options: CompressOptions): string {
    const program = parseModule(source);
    const semantic = createSemantic();
    analyze(semantic, program, true);
    eliminateDeadCode(program, semantic, options, 'module', new Set(), true);
    expect(verifyRefFacts(semantic, program)).toEqual([]);
    return print(program);
}

/** oxc `test_with_options_source_type`: the output matches, and a second run changes nothing. */
function test(source: string, expected: string, options: CompressOptions = dceOptions()): void {
    const output = run(source, options);
    expect(output).toBe(print(parseModule(expected)));
    expect(run(output, options)).toBe(output);
}

const testSame = (source: string, options?: CompressOptions): void => test(source, source, options);

/** A function body, so the parameters and locals are resolved bindings. */
const inFunction = (body: string): string => `export function f(a, b, c) { ${body} }`;

const testInFunction = (body: string, expected: string): void => test(inFunction(body), inFunction(expected));

const testSameInFunction = (body: string): void => testInFunction(body, body);

describe('remove_unused_expression (tree-shake only)', () => {
    it('test_remove_unused_expression', () => {
        test('null', '');
        test('true', '');
        test('false', '');
        test('1', '');
        test('1n', '');
        test(";'s'", '');
        test('this', '');
        test('/asdf/', '');
        test('(function () {})', '');
        test('(() => {})', '');
        test('import.meta', '');
        test('var x; x', '');
        testSame('x');
        test('void 0', '');
        test('void x', 'x');
    });

    it('test_remove_unused_optional_chain_keeps_base_side_effects', () => {
        test("let log = []; (log.push('base'), null)?.x;", "[].push('base')");
    });

    it('test_remove_unused_this', () => {
        // `this` before `super()` in a derived constructor throws.
        testSame('export class Foo extends Bar { constructor() { this; super(); } }');
        testSame('export class Foo extends Bar { constructor() { (() => { this; })(); super(); } }');
        test('export class Foo { constructor() { this; } }', 'export class Foo { constructor() {} }');
        test(
            'export class Foo extends Bar { constructor() { super(); this; } }',
            'export class Foo extends Bar { constructor() { super(); } }',
        );
        test(
            'export class Foo extends Bar { constructor() { super(); foo(); this; } }',
            'export class Foo extends Bar { constructor() { super(); foo(); } }',
        );
        test(
            'export class Foo extends Bar { constructor() { if (x) { super(); } this; } }',
            'export class Foo extends Bar { constructor() { if (x) super(); this; } }',
        );
        test(
            'export class Foo extends Bar { constructor() { (function() { this; })(); super(); } }',
            'export class Foo extends Bar { constructor() { super(); } }',
        );
        test(
            'export class A extends B { constructor() { class C { constructor() { this; } } super(); } }',
            'export class A extends B { constructor() { super(); } }',
        );
        // A nested class's computed key uses the outer constructor's `this`.
        test(
            'export class A extends B { constructor() { class C { [(this, f())]() {} } super(); } }',
            'export class A extends B { constructor() { this, f(); super(); } }',
        );

        test('{ this; }', '');
        test('export class Foo { foo() { this; } }', 'export class Foo { foo() {} }');
        test('export class Foo { static foo() { this; } }', 'export class Foo { static foo() {} }');
        test('export class Foo { static { this; } }', 'export class Foo { static {} }');
        test('export function foo() { this; }', 'export function foo() {}');
        test('export class Foo { get bar() { this; } }', 'export class Foo { get bar() {} }');
        test('export class Foo { set bar(v) { this; } }', 'export class Foo { set bar(v) {} }');
    });

    it('test_new_constructor_side_effect', () => {
        test('new WeakSet()', '');
        test('new WeakSet(null)', '');
        testSame('new WeakSet([x])');
        testSame('new WeakSet(x)');
        testSame('throw new WeakSet()');
        test('new Date()', '');
        testSame('new Date(x)');
        test('new Set([1, 2, 3])', '');
        // Element side effects are kept when the pure construction is dropped.
        test('new Set([foo(), bar()])', 'foo(), bar();');
        test('new Map([[foo(), bar()]])', 'foo(), bar();');
        testSame('new Map([x])');
        test('new Int8Array(8)', '');
        testSame('new Int8Array(-1)');
    });

    it('test_array_literal', () => {
        test('([])', '');
        test('([1])', '');
        testInFunction('([a])', '');
        test('([foo()])', 'foo()');
        test('[[foo()]]', 'foo()');
        testSame('baz.map((v) => [v])');
    });

    it('test_array_literal_containing_spread', () => {
        testSame('([...c])');
        test('([4, ...c, a])', '[...c, a]');
        testInFunction('([4, ...c, a])', '[...c]');
        testSame('([foo(), ...c, bar()])');
        testSame('([...a, b, ...c])');
        testInFunction('([...a, b, ...c])', '[...a, ...c]');
        testSame('([...b, ...c])');
    });

    it('test_array_spread_drop_walks_argument_refs', () => {
        test('([...[function(){}]])', '');
        test('([4, ...[function(){}], a])', 'a');
    });

    it('test_fold_unary_expression_statement', () => {
        test('typeof x', '');
        test('typeof x?.y', 'x?.y');
        test('typeof x.y', 'x.y');
        test('typeof x.y.z()', 'x.y.z()');
        test('void x', 'x');
        test('void x?.y', 'x?.y');
        test('void x.y.z()', 'x.y.z()');
        test('!x', 'x');
        test('!x?.y', 'x?.y');
        test('!x.y.z()', 'x.y.z()');
        testSame('-x.y.z()');
        testSame('delete x');
        testSame('delete x.y');
        testSame('+0n');
        test('-0n', '');
        test('-1n', '');
    });

    it('test_fold_sequence_expr', () => {
        test("('foo', 'bar', 'baz')", '');
        test("('foo', 'bar', baz())", 'baz()');
        test("('foo', bar(), baz())", 'bar(), baz()');
        test('(() => {}, bar(), baz())', 'bar(), baz()');
        testSame('(0, o.f)();');
        testSame('(0 instanceof 0, foo)');
        testSame('(0 in 0, foo)');
    });

    it('test_logical_expression', () => {
        testInFunction('a != null && a.b()', 'a?.b()');
        testInFunction('a == null || a.b()', 'a?.b()');
        testInFunction('null != a && a.b()', 'a?.b()');
        testInFunction('null == a || a.b()', 'a?.b()');
        // A global `a` may have a getter.
        testSame('x != null && x.b()');
        testSame('x == null || x.b()');

        test('x == null && y', 'x ?? y');
        test('x != null || y', 'x ?? y');
        testSame('v = x == null && y');
        testSame('v = x != null || y');
        test('void (x == null && y)', 'x ?? y');
        testInFunction('a == null && (a = b)', 'a ??= b');
        testInFunction('a != null || (a = b)', 'a ??= b');

        // `??=` would capture a base object the right-hand side reassigns.
        testInFunction('var x = {}; x.y != null || (x = {}, x.y = 3)', 'var x = {}; x.y ?? (x = {}, x.y = 3)');
        testInFunction('var x = {}; x.y == null && (x = {}, x.y = 3)', 'var x = {}; x.y ?? (x = {}, x.y = 3)');
        testInFunction('var x = {}; x.y != null || (foo(), x.y = 3)', 'var x = {}; x.y ?? (foo(), x.y = 3)');

        test("typeof x != 'undefined' && x", '');
        test("typeof x == 'undefined' || x", '');
        test("typeof x < 'u' && x", '');
        test("typeof x > 'u' || x", '');

        // The boolean-context left side is simplified.
        testInFunction('!!a && b()', 'a && b()');
        testInFunction('(a ? !!b : !!c) && g()', '(a ? b : c) && g()');
    });

    it('keeps the cjs-module-lexer hint', () => {
        testSame('0 && (module.exports = { a });');
    });

    it('test_nullish_assign_preserves_guard', () => {
        test(
            'let a; export function foo() { a == null && (a = compute()); }',
            'let a; export function foo() { a ??= compute(); }',
        );
        test(
            'let a; export function foo() { a != null || (a = compute()); }',
            'let a; export function foo() { a ??= compute(); }',
        );
        test(
            'export let o = {}; export function foo() { o.y == null && (o.y = compute()); }',
            'export let o = {}; export function foo() { o.y ??= compute(); }',
        );
    });

    it('test_object_literal', () => {
        test('({})', '');
        test('({a:1})', '');
        test('({a:foo()})', 'foo()');
        test("({'a':foo()})", 'foo()');
        // Object spread may trigger getters.
        testSame('({...a})');
        testSame('({...foo()})');
        test('({...{}})', '');
        test('({...{a: 1}})', '');
        test('({...{a: foo()}})', 'foo()');
        test('({ [{ foo: foo() }]: 0 })', 'foo()');
        test('({ foo: { foo: foo() } })', 'foo()');
        test('({ [bar()]: foo() })', 'bar(), foo()');
        test('({ ...baz, [bar()]: foo() })', '({ ...baz }), bar(), foo()');
    });

    it('test_fold_template_literal', () => {
        test('`a${b}c${d}e`', '`${b}${d}`');
        test('`stuff ${x} ${1}`', '`${x}`');
        test('`stuff ${1} ${y}`', '`${y}`');
        test('`stuff ${x} ${y}`', '`${x}${y}`');
        test('`stuff ${x ? 1 : 2} ${y}`', 'x, `${y}`');
        test('`stuff ${x} ${y ? 1 : 2}`', '`${x}`, y');
        test('`stuff ${x} ${y ? 1 : 2} ${z}`', '`${x}`, y, `${z}`');
        test('`4${c}${+a}`', '`${c}`, +a');
        test('`${+foo}${c}${+bar}`', '+foo, `${c}`, +bar');
        test('`${a}${+b}${c}`', '`${a}`, +b, `${c}`');
    });

    it('test_fold_conditional_expression', () => {
        test('(1, foo()) ? 1 : 2', 'foo()');
        test('foo() ? 1 : 2', 'foo()');
        test('foo() ? 1 : bar()', 'foo() || bar()');
        test('foo() ? bar() : 2', 'foo() && bar()');
        testSame('foo() ? bar() : baz()');
        test("typeof x == 'undefined' ? 0 : x", '');
        test("typeof x != 'undefined' ? x : 0", '');
        test("typeof x > 'u' ? 0 : x", '');
        test("typeof x < 'u' ? x : 0", '');
    });

    it('test_fold_binary_expression', () => {
        testInFunction('a === b', '');
        testInFunction('a() === b', 'a()');
        testInFunction('a === b()', 'b()');
        testInFunction('a() === b()', 'a(), b()');
        testInFunction('a !== b; a == b; a != b; a < b; a > b; a <= b; a >= b', '');

        testSameInFunction('a + b');
        testInFunction("'a' + b", "'' + b");
        testSameInFunction("a + '' + b");
        testInFunction("'a' + (b === c)", '');
        testInFunction("'a' + +b", "'' + +b");
        testSameInFunction("a + ('' + b)");
        testInFunction("a + ('' + (b === c))", "a + ''");
    });

    it('test_fold_call_expression', () => {
        testSame('foo()');
        test('/* @__PURE__ */ foo()', '');
        test('/* @__PURE__ */ foo(a)', 'a');
        test('/* @__PURE__ */ foo(a, b)', 'a, b');
        test('/* @__PURE__ */ foo(...a)', '[...a]');
        test("/* @__PURE__ */ foo(...'a')", '');
        test('/* @__PURE__ */ new Foo()', '');
        test('/* @__PURE__ */ new Foo(a)', 'a');
        test('true && /* @__PURE__ */ noEffect()', '');
        test('false || /* @__PURE__ */ noEffect()', '');
    });

    it('remove_pure_function_calls', () => {
        test('function noop() {} noop()', '');
        test('var foo = () => 1; foo(), foo()', '');
        test('var foo = function() {}; foo()', '');
        testSame('function foo() { bar() } foo()');
        testSameInFunction('var bar = () => { baz() }; bar(), bar();');
    });

    it('preserve_iife_in_dce_mode', () => {
        testSame('export const x = /* @__PURE__ */ (() => foo())();');
        testSame('export const x = (() => foo())();');
        testSame('export const x = (() => 42)();');
        testSame('(function () { function t() {} return t })();');
        testSame('(function () { return 1 })();');
        test('var u = (function () { return 1 })();', '(function () { return 1 })();');
        testSame('(function () { return 1 })(), foo();');
    });

    it('treeshake_options_annotations_false', () => {
        const options = rolldownDceOptions(undefined, { annotations: false });
        testSame('function test() { bar } /* @__PURE__ */ test()', options);
        testSame('function test() { bar } /* @__PURE__ */ new test()', options);
        test('/* @__PURE__ */ foo()', '');
    });

    it('remove_unused_assignment_expression', () => {
        test('var x = 1; x = 2;', '');
        test('var x = 1; x = foo();', 'foo()');
        testSame('var x = 1; x = 2, eval("x")');
        testSame('export var foo; foo = 0;');
        testSame('export let foo; foo = 0;');
        testSame('var x = 1; x = 2, foo(x)');
        testSame('function foo() { return t = x(); } foo();');
        test('function foo() { var t; return t = x(); } foo();', 'function foo() { return x(); } foo();');
        testSame('function foo(t) { return t = x(); } foo();');
        test('let x = 1; x = 2;', '');
        test('let x = 1; x = foo();', 'foo()');
        test('function foo() { let t; return t = x(); } foo();', 'function foo() { return x() } foo()');
        testInFunction('let i; for (;;) i = 0', 'for (;;);');
        test('let foo = {}; foo = 1', '');
        // A `const` write throws.
        testSame('const x = 1; x = 2;');
    });

    it('remove_unused_class_expression', () => {
        test('(class {})', '');
        test('(class extends Foo {})', 'Foo');
        test('(class { static {} })', '');
        testSame('(class { static { foo } })');
        test('(class { foo() {} })', '');
        test('(class { [foo]() {} })', 'foo');
        test('(class { static foo() {} })', '');
        test('(class { static [foo]() {} })', 'foo');
        test('(class { [1]() {} })', '');
        test('(class { foo })', '');
        test('(class { foo = bar })', '');
        testSame('(class { static foo = bar })');
        testSame('(class { static foo = this.bar = {} })');
        test('(class { static foo = 1 })', '');
        test('(class { [foo] = bar })', 'foo');
        testSame('(class { static [foo] = bar })');
        test('(class { static [foo] = 1 })', 'foo');
        test('(class { accessor foo = 1 })', '');
        test('(class { accessor [foo] = 1 })', 'foo');
        test('(class extends A { [B] = C; [D]() {} })', 'A, B, D');
        testSame('(class extends (() => {}) {})');
    });

    it('test_property_write_side_effects', () => {
        const options = rolldownDceOptions(undefined, { propertyWriteSideEffects: false });
        const testOptions = (body: string, expected: string): void => test(inFunction(body), inFunction(expected), options);
        const testSameOptions = (body: string): void => testOptions(body, body);

        // Fresh object and function values with only member writes.
        testOptions('const B = {}; B.foo = 1;', '');
        testOptions('const C = () => {}; C.foo = 1;', '');
        testOptions('const D = function() {}; D.foo = 1;', '');
        testOptions('const E = []; E.a = 1; const F = class {}; F.x = 1;', '');
        // Not a fresh value, so it may alias.
        testSameOptions('const b2 = x; b2.foo = 1;');
        // An effectful right-hand side keeps the write in tree-shake mode.
        testSameOptions('const q = {}; q.a = sideEffect();');
        // Setters make the write observable.
        testSameOptions('const obj = { set foo(v) { console.log(v); } }; obj.foo = 1;');
        // A `__proto__` write may install a setter a sibling write triggers.
        testSameOptions('const q = {}; q.__proto__ = { set a(v) { console.log(1); } }; q.a = 1;');
        testSameOptions('const q = {}; q[b] = { set a(v) { console.log(1); } }; q.a = 1;');
        testOptions('const q = {}; q.__proto__ = { set a(v) { console.log(1); } };', '');
        // Global objects are not local bindings.
        test('globalObj.foo = 1;', 'globalObj.foo = 1;', options);
    });

    it('dce_keeps_write_only_property_assignments', () => {
        testSame(
            '(function() {\n\tvar r = require("react");\n\tvar o = function(e, t) {\n\t\treturn r.create(e, t);\n\t};\n\to.displayName = "X";\n})();',
        );
    });
});
