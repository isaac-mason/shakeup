// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are JS source under test.
// Ported from oxc_minifier/tests/peephole/remove_unused_expression.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { type CompressOptions, defaultTreeShakeOptions, smallestOptions } from '../../src/passes/dce/options.ts';
import { defaultOptions, test, testOptions, testSame, testSameOptions, testSameSmallest, testSmallest } from './harness.ts';

describe('test_remove_unused_expression', () => {
    it('null', () => test('null', ''));
    it('true', () => test('true', ''));
    it('false', () => test('false', ''));
    it('1', () => test('1', ''));
    it('1n', () => test('1n', ''));
    it(";'s'", () => test(";'s'", ''));
    it('this', () => test('this', ''));
    it('/asdf/', () => test('/asdf/', ''));
    it('(function () {})', () => test('(function () {})', ''));
    it('(() => {})', () => test('(() => {})', ''));
    it('import.meta', () => test('import.meta', ''));
    it('var x; x', () => test('var x; x', 'var x'));
    it('x', () => test('x', 'x'));
    it('void 0', () => test('void 0', ''));
    it('void x', () => test('void x', 'x'));
});

describe('test_remove_unused_optional_chain_keeps_base_side_effects', () => {
    it("let log = []; (log.push('base'), null)?.x;", () => test("let log = []; (log.push('base'), null)?.x;", "[].push('base')"));
});

describe('test_remove_unused_this', () => {
    // In a derived class constructor, `this` before `super()` throws a ReferenceError,
    // so it must be kept (https://github.com/oxc-project/oxc/issues/21364).
    it('export class Foo extends Bar { constructor() { this; super(); } }', () =>
        test(
            'export class Foo extends Bar { constructor() { this; super(); } }',
            'export class Foo extends Bar { constructor() { this, super(); } }',
        ));
    // The `this` inside an arrow captures the enclosing derived constructor's `this`.
    it('export class Foo extends Bar { constructor() { (() => { this; })(); super(); } }', () =>
        test(
            'export class Foo extends Bar { constructor() { (() => { this; })(); super(); } }',
            'export class Foo extends Bar { constructor() { this, super(); } }',
        ));
    // Non-derived constructors always have `this` initialized — safe to drop.
    it('export class Foo { constructor() { this; } }', () =>
        test('export class Foo { constructor() { this; } }', 'export class Foo { constructor() {} }'));
    // Derived constructor, but `this` is after `super()` — safe to drop.
    it('export class Foo extends Bar { constructor() { super(); this; } }', () =>
        test(
            'export class Foo extends Bar { constructor() { super(); this; } }',
            'export class Foo extends Bar { constructor() { super(); } }',
        ));
    // Non-adjacent `super()` and `this` — `this` is dropped because `super()`
    // was called unconditionally in a preceding statement.
    it('export class Foo extends Bar { constructor() { super(); foo(); this; } }', () =>
        test(
            'export class Foo extends Bar { constructor() { super(); foo(); this; } }',
            'export class Foo extends Bar { constructor() { super(), foo(); } }',
        ));
    // Conditional `super()` — `this` must be kept.
    it('export class Foo extends Bar { constructor() { if (x) { super(); } this; } }', () =>
        test(
            'export class Foo extends Bar { constructor() { if (x) { super(); } this; } }',
            'export class Foo extends Bar { constructor() { x && super(), this; } }',
        ));
    it('export class Foo extends Bar { constructor() { x ? super() : foo(); this; } }', () =>
        test(
            'export class Foo extends Bar { constructor() { x ? super() : foo(); this; } }',
            'export class Foo extends Bar { constructor() { x ? super() : foo(), this; } }',
        ));
    // `super()` in closure — `this` must be kept (it's before the `super()` call).
    it('export class Foo extends Bar { constructor() { const s = () => super(); this; s(); } }', () =>
        test(
            'export class Foo extends Bar { constructor() { const s = () => super(); this; s(); } }',
            'export class Foo extends Bar { constructor() { this, super(); } }',
        ));
    // A regular function inside a derived constructor has its own `this` — safe to drop.
    it('export class Foo extends Bar { constructor() { (function() { this; })(); super(); } }', () =>
        test(
            'export class Foo extends Bar { constructor() { (function() { this; })(); super(); } }',
            'export class Foo extends Bar { constructor() { super(); } }',
        ));
    // Nested class constructor inside a derived constructor — the inner `this`
    // belongs to the inner constructor, not the outer one.
    it('export class A extends B { constructor() { class C { constructor() { this; } } super(); } }', () =>
        test(
            'export class A extends B { constructor() { class C { constructor() { this; } } super(); } }',
            'export class A extends B { constructor() { class C { constructor() {} } super(); } }',
        ));
    // A nested class's computed key uses the outer constructor's `this`, so a
    // bare access before `super()` must not be dropped.
    it('export class A extends B { constructor() { class C { [(this, f())]() {} } super(); } }', () =>
        testSame(
            'export class A extends B { constructor() {\n            class C { [(this, f())]() {} }\n            super();\n        } }',
        ));
    // In all other positions `this` is always initialized and can be dropped.
    it('{ this; }', () => test('{ this; }', ''));
    it('export class Foo { foo() { this; } }', () =>
        test('export class Foo { foo() { this; } }', 'export class Foo { foo() {} }'));
    it('export class Foo { static foo() { this; } }', () =>
        test('export class Foo { static foo() { this; } }', 'export class Foo { static foo() {} }'));
    it('export class Foo { static { this; } }', () => test('export class Foo { static { this; } }', 'export class Foo {}'));
    it('export function foo() { this; }', () => test('export function foo() { this; }', 'export function foo() {}'));
    it('export class Foo { get bar() { this; } }', () =>
        test('export class Foo { get bar() { this; } }', 'export class Foo { get bar() {} }'));
    it('export class Foo { set bar(v) { this; } }', () =>
        test('export class Foo { set bar(v) { this; } }', 'export class Foo { set bar(v) {} }'));
});

describe('test_new_constructor_side_effect', () => {
    it('new WeakSet()', () => test('new WeakSet()', ''));
    it('new WeakSet(null)', () => test('new WeakSet(null)', ''));
    it('new WeakSet(void 0)', () => test('new WeakSet(void 0)', ''));
    it('new WeakSet([])', () => test('new WeakSet([])', ''));
    it('new WeakSet([x])', () => testSame('new WeakSet([x])'));
    it('new WeakSet(x)', () => testSame('new WeakSet(x)'));
    it('throw new WeakSet()', () => testSame('throw new WeakSet()'));
    it('new WeakMap()', () => test('new WeakMap()', ''));
    it('new WeakMap(null)', () => test('new WeakMap(null)', ''));
    it('new WeakMap(void 0)', () => test('new WeakMap(void 0)', ''));
    it('new WeakMap([])', () => test('new WeakMap([])', ''));
    it('new WeakMap([x])', () => testSame('new WeakMap([x])'));
    it('new WeakMap(x)', () => testSame('new WeakMap(x)'));
    it('new Date()', () => test('new Date()', ''));
    it("new Date('')", () => test("new Date('')", ''));
    it('new Date(0)', () => test('new Date(0)', ''));
    it('new Date(null)', () => test('new Date(null)', ''));
    it('new Date(true)', () => test('new Date(true)', ''));
    it('new Date(false)', () => test('new Date(false)', ''));
    it('new Date(undefined)', () => test('new Date(undefined)', ''));
    it('new Date(x)', () => testSame('new Date(x)'));
    it('new Set()', () => test('new Set()', ''));
    it('new Set([1, 2, 3])', () => test('new Set([1, 2, 3])', ''));
    // Element side effects are preserved when the pure construction is dropped.
    it('new Set([foo(), bar()])', () => test('new Set([foo(), bar()])', 'foo(), bar();'));
    it('new Map([[foo(), bar()]])', () => test('new Map([[foo(), bar()]])', 'foo(), bar();'));
    // A string is a valid iterable of values for `Set`, but `Map`/`WeakSet`/`WeakMap`
    // require `[k, v]` entries / object keys, so a non-empty string argument throws and
    // is kept. An empty string yields no entries and stays pure for all of them.
    it('new Set("ab")', () => test('new Set("ab")', ''));
    it('new Map("")', () => test('new Map("")', ''));
    it('new WeakSet("")', () => test('new WeakSet("")', ''));
    it('new WeakMap("")', () => test('new WeakMap("")', ''));
    it('new Map("ab")', () => testSame('new Map("ab")'));
    it('new WeakSet("ab")', () => testSame('new WeakSet("ab")'));
    it('new WeakMap("ab")', () => testSame('new WeakMap("ab")'));
    it('new Set(null)', () => test('new Set(null)', ''));
    it('new Set(undefined)', () => test('new Set(undefined)', ''));
    it('new Set(void 0)', () => test('new Set(void 0)', ''));
    it('new Set(x)', () => testSame('new Set(x)'));
    it('new Map()', () => test('new Map()', ''));
    it('new Map([[1, 2], [3, 4]])', () => test('new Map([[1, 2], [3, 4]])', ''));
    it('new Map(null)', () => test('new Map(null)', ''));
    it('new Map(undefined)', () => test('new Map(undefined)', ''));
    it('new Map(void 0)', () => test('new Map(void 0)', ''));
    it('new Map(x)', () => testSame('new Map(x)'));
    // Map entries must be array literals, otherwise they are not iterable and throw.
    it('new Map([x])', () => testSame('new Map([x])'));
    it('new Map([1, 2])', () => testSame('new Map([1, 2])'));
    // WeakSet/WeakMap keys must be objects, so array-literal args throw.
    it('new WeakSet([1])', () => testSame('new WeakSet([1])'));
    it('new WeakMap([[1, 2]])', () => testSame('new WeakMap([[1, 2]])'));
    // Typed arrays allocate a zeroed buffer with no user code for a numeric-literal
    // length: a valid length is pure, and a too-large length is a max-length
    // RangeError the minifier is allowed to drop (see docs/ASSUMPTIONS.md).
    it('new Int8Array()', () => test('new Int8Array()', ''));
    it('new Uint8Array()', () => test('new Uint8Array()', ''));
    it('new Int8Array(8)', () => test('new Int8Array(8)', ''));
    it('new Int8Array(1024)', () => test('new Int8Array(1024)', ''));
    // Kept: `-1` throws a negative-length RangeError, `0n` throws a TypeError, an
    // object arg can run user code, and a shadowed `Int8Array` is not the builtin.
    it('new Int8Array(-1)', () => testSame('new Int8Array(-1)'));
    it('new Int8Array(0n)', () => testSame('new Int8Array(0n)'));
    it('new Int8Array(x)', () => testSame('new Int8Array(x)'));
    it('new Int8Array([1, 2])', () => testSame('new Int8Array([1, 2])'));
    it('var Int8Array; new Int8Array()', () => testSame('var Int8Array; new Int8Array()'));
});

describe('test_array_literal', () => {
    it('([])', () => test('([])', ''));
    it('([1])', () => test('([1])', ''));
    it('([a])', () => test('([a])', 'a'));
    it('var a; ([a])', () => test('var a; ([a])', 'var a;'));
    it('([foo()])', () => test('([foo()])', 'foo()'));
    it('[[foo()]]', () => test('[[foo()]]', 'foo()'));
    it('baz.map((v) => [v])', () => testSame('baz.map((v) => [v])'));
});

describe('test_array_literal_containing_spread', () => {
    it('([...c])', () => testSame('([...c])'));
    it('([4, ...c, a])', () => test('([4, ...c, a])', '[...c, a]'));
    it('var a; ([4, ...c, a])', () => test('var a; ([4, ...c, a])', 'var a; [...c]'));
    it('([foo(), ...c, bar()])', () => testSame('([foo(), ...c, bar()])'));
    it('([...a, b, ...c])', () => testSame('([...a, b, ...c])'));
    it('var b; ([...a, b, ...c])', () => test('var b; ([...a, b, ...c])', 'var b; [...a, ...c]'));
    it('([...b, ...c])', () => testSame('([...b, ...c])'));
    // It would also be fine if the spreads were split apart.
});

// Leak regression: `remove_unused_template_literal` drains the template's
// elements; an element that `remove_unused_expression` reports removable was
// silently discarded without a `drop_expression` walk, leaking its refs.
// Two computed keys keep `p` multi-use so single-use inlining can't paper
// over the leak; the stale reads then block unused-declaration removal.
describe('test_template_literal_drop_walks_removed_element_refs', () => {
    const options = smallestOptions();
    it("function f() { let p = 'metric'; let t = { [`${p}_x`]: 0, [`${p}_y`]: 0 }; void t; return 1; } g(f()", () =>
        testOptions(
            "function f() { let p = 'metric'; let t = { [`${p}_x`]: 0, [`${p}_y`]: 0 }; void t; return 1; } g(f());",
            'function f() { return 1; } g(f());',
            options,
        ));
});

// Regression: when `remove_unused_array_expr` elides a side-effect-free
// `SpreadElement`, the argument subtree must be walked through
// `drop_expression` so identifier references inside don't leak across
// passes (#22736).
//
// The spread argument is an array literal with two holes, so
// `try_flatten_array_expression_elements` (gated at < 2 holes) does not
// flatten it and the spread reaches the elision branch with `p`'s
// references still inside; `p` is multi-use so single-use inlining can't
// paper over the leak. Without the drop walk the stale reads keep `let p`
// alive and panic the under-prune debug guard.
describe('test_array_spread_drop_walks_argument_refs', () => {
    it('([...[function(){}]])', () => test('([...[function(){}]])', ''));
    it('([4, ...[function(){}], a])', () => test('([4, ...[function(){}], a])', 'a'));
    const options = smallestOptions();
    it("function f() { let p = 'metric'; [...[p, , , p]]; return 1; } g(f());", () =>
        testOptions(
            "function f() { let p = 'metric'; [...[p, , , p]]; return 1; } g(f());",
            'function f() { return 1; } g(f());',
            options,
        ));
});

describe('test_fold_unary_expression_statement', () => {
    it('typeof x', () => test('typeof x', ''));
    it('typeof x?.y', () => test('typeof x?.y', 'x?.y'));
    it('typeof x.y', () => test('typeof x.y', 'x.y'));
    it('typeof x.y.z()', () => test('typeof x.y.z()', 'x.y.z()'));
    it('void x', () => test('void x', 'x'));
    it('void x?.y', () => test('void x?.y', 'x?.y'));
    it('void x.y', () => test('void x.y', 'x.y'));
    it('void x.y.z()', () => test('void x.y.z()', 'x.y.z()'));
    it('!x', () => test('!x', 'x'));
    it('!x?.y', () => test('!x?.y', 'x?.y'));
    it('!x.y', () => test('!x.y', 'x.y'));
    it('!x.y.z()', () => test('!x.y.z()', 'x.y.z()'));
    it('-x.y.z()', () => testSame('-x.y.z()'));
    it('delete x', () => testSame('delete x'));
    it('delete x.y', () => testSame('delete x.y'));
    it('delete x.y.z()', () => testSame('delete x.y.z()'));
    it('+0n', () => testSame('+0n'));
    // Uncaught TypeError: Cannot convert a BigInt value to a number
    it('-0n', () => test('-0n', ''));
    it('-1n', () => test('-1n', ''));
});

describe('test_fold_sequence_expr', () => {
    it("('foo', 'bar', 'baz')", () => test("('foo', 'bar', 'baz')", ''));
    it("('foo', 'bar', baz())", () => test("('foo', 'bar', baz())", 'baz()'));
    it("('foo', bar(), baz())", () => test("('foo', bar(), baz())", 'bar(), baz()'));
    it('(() => {}, bar(), baz())', () => test('(() => {}, bar(), baz())', 'bar(), baz()'));
    it('(function k() {}, k(), baz())', () => test('(function k() {}, k(), baz())', 'k(), baz()'));
    it('(0, o.f)();', () => testSame('(0, o.f)();'));
    it('var obj = Object((null, 2, 3), 1, 2);', () =>
        test('var obj = Object((null, 2, 3), 1, 2);', 'var obj = Object(3, 1, 2);'));
    it('(0 instanceof 0, foo)', () => testSame('(0 instanceof 0, foo)'));
    it('(0 in 0, foo)', () => testSame('(0 in 0, foo)'));
    it('React.useEffect(() => (isMountRef.current = !1, () => { isMountRef.current = !0; }), [])', () =>
        testSame('React.useEffect(() => (isMountRef.current = !1, () => { isMountRef.current = !0; }), [])'));
});

describe('test_logical_expression', () => {
    it('var a; a != null && a.b()', () => test('var a; a != null && a.b()', 'var a; a?.b()'));
    it('var a; a == null || a.b()', () => test('var a; a == null || a.b()', 'var a; a?.b()'));
    it('a != null && a.b()', () => testSame('a != null && a.b()'));
    // a may have a getter
    it('a == null || a.b()', () => testSame('a == null || a.b()'));
    // a may have a getter
    it('var a; null != a && a.b()', () => test('var a; null != a && a.b()', 'var a; a?.b()'));
    it('var a; null == a || a.b()', () => test('var a; null == a || a.b()', 'var a; a?.b()'));
    it('x == null && y', () => test('x == null && y', 'x ?? y'));
    it('x != null || y', () => test('x != null || y', 'x ?? y'));
    it('v = x == null && y', () => testSame('v = x == null && y'));
    it('v = x != null || y', () => testSame('v = x != null || y'));
    it('a == null && (a = b)', () => test('a == null && (a = b)', 'a ??= b'));
    it('a != null || (a = b)', () => test('a != null || (a = b)', 'a ??= b'));
    it('v = a == null && (a = b)', () => testSame('v = a == null && (a = b)'));
    it('v = a != null || (a = b)', () => testSame('v = a != null || (a = b)'));
    it('void (x == null && y)', () => test('void (x == null && y)', 'x ?? y'));
    // https://github.com/oxc-project/oxc/pull/16802#discussion_r2619369597
    // Don't transform to ??= when base object may be mutated, but ?? is safe
    it('var x = {}; x.y != null || (x = {}, x.y = 3)', () =>
        test('var x = {}; x.y != null || (x = {}, x.y = 3)', 'var x = {}; x.y ?? (x = {}, x.y = 3)'));
    it('var x = {}; x.y == null && (x = {}, x.y = 3)', () =>
        test('var x = {}; x.y == null && (x = {}, x.y = 3)', 'var x = {}; x.y ?? (x = {}, x.y = 3)'));
    it('var x = {}; x.y != null || (a, x = {}, x.y = 3)', () =>
        test('var x = {}; x.y != null || (a, x = {}, x.y = 3)', 'var x = {}; x.y ?? (a, x = {}, x.y = 3)'));
    it('var x = { y: {} }; x.y.z != null || (x.y = {}, x.y.z = 3)', () =>
        test('var x = { y: {} }; x.y.z != null || (x.y = {}, x.y.z = 3)', 'var x = { y: {} }; x.y.z ?? (x.y = {}, x.y.z = 3)'));
    it("import { x, mutate } from 'm'; x.y != null || (mutate(), x.y = 3)", () =>
        test(
            "import { x, mutate } from 'm'; x.y != null || (mutate(), x.y = 3)",
            "import { x, mutate } from 'm'; x.y ?? (mutate(), x.y = 3)",
        ));
    // Safe to transform to ??= when base object is not mutated
    it('var x = {}; x.y != null || (foo(), x.y = 3)', () =>
        test('var x = {}; x.y != null || (foo(), x.y = 3)', 'var x = {}; x.y ??= (foo(), 3)'));
    it('var x = {}; x.y != null || (new Foo(), x.y = 3)', () =>
        test('var x = {}; x.y != null || (new Foo(), x.y = 3)', 'var x = {}; x.y ??= (new Foo(), 3)'));
    // x is not mutated, only x.y.z is assigned (doesn't affect x)
    it('var x = {}; x.y != null || (x.y.z = {}, x.y = 3)', () =>
        test('var x = {}; x.y != null || (x.y.z = {}, x.y = 3)', 'var x = {}; x.y ??= (x.y.z = {}, 3)'));
    it("typeof x != 'undefined' && x", () => test("typeof x != 'undefined' && x", ''));
    it("typeof x == 'undefined' || x", () => test("typeof x == 'undefined' || x", ''));
    it("typeof x < 'u' && x", () => test("typeof x < 'u' && x", ''));
    it("typeof x > 'u' || x", () => test("typeof x > 'u' || x", ''));
});

// Regression tests for https://github.com/oxc-project/oxc/issues/21457.
//
// When `a == null && (a = b)` is converted to `a ??= b`, the LHS reference
// must be flagged as Read; otherwise unused-removal sees zero read references
// on the next iteration and strips the assignment, dropping the nullish guard.
//
// Each sub-case is a separate test so one regression doesn't mask the others.
describe('test_nullish_assign_preserves_guard', () => {
    const options = smallestOptions();
    it('let rafId; export function foo() { if (rafId == null) { rafId = requestAnimationFrame(() => { consol', () =>
        testOptions(
            "let rafId; export function foo() { if (rafId == null) { rafId = requestAnimationFrame(() => { console.log('callback'); }); } }",
            "let rafId; export function foo() { rafId ??= requestAnimationFrame(() => { console.log('callback'); }); }",
            options,
        ));
    it('let rafId; export function foo() { if (rafId != null) {} else { rafId = requestAnimationFrame(() => ', () =>
        testOptions(
            "let rafId; export function foo() { if (rafId != null) {} else { rafId = requestAnimationFrame(() => { console.log('callback'); }); } }",
            "let rafId; export function foo() { rafId ??= requestAnimationFrame(() => { console.log('callback'); }); }",
            options,
        ));
    it('let a; export function foo() { a == null && (a = compute()); }', () =>
        testOptions(
            'let a; export function foo() { a == null && (a = compute()); }',
            'let a; export function foo() { a ??= compute(); }',
            options,
        ));
    it('let a; export function foo() { a != null || (a = compute()); }', () =>
        testOptions(
            'let a; export function foo() { a != null || (a = compute()); }',
            'let a; export function foo() { a ??= compute(); }',
            options,
        ));
    // Member LHS goes through `remove_unused_member_assignment`, not the
    // identifier path, so it was never affected by the reference-flag bug.
    // Still covered here to pin down expected behavior under `smallest()`.
    it('export let o = {}; export function foo() { o.y == null && (o.y = compute()); }', () =>
        testOptions(
            'export let o = {}; export function foo() { o.y == null && (o.y = compute()); }',
            'export let o = {}; export function foo() { o.y ??= compute(); }',
            options,
        ));
});

describe('test_object_literal', () => {
    it('({})', () => test('({})', ''));
    it('({a:1})', () => test('({a:1})', ''));
    it('({a:foo()})', () => test('({a:foo()})', 'foo()'));
    it("({'a':foo()})", () => test("({'a':foo()})", 'foo()'));
    // Object-spread may trigger getters.
    it('({...a})', () => testSame('({...a})'));
    it('({...foo()})', () => testSame('({...foo()})'));
    // Spreading object literals is safe if contents are safe.
    it('({...{}})', () => test('({...{}})', ''));
    it('({...{a: 1}})', () => test('({...{a: 1}})', ''));
    it('({...{a: foo()}})', () => test('({...{a: foo()}})', 'foo()'));
    it('({ [{ foo: foo() }]: 0 })', () => test('({ [{ foo: foo() }]: 0 })', 'foo()'));
    it('({ foo: { foo: foo() } })', () => test('({ foo: { foo: foo() } })', 'foo()'));
    it('({ [bar()]: foo() })', () => test('({ [bar()]: foo() })', 'bar(), foo()'));
    it('({ ...baz, [bar()]: foo() })', () => test('({ ...baz, [bar()]: foo() })', '({ ...baz }), bar(), foo()'));
});

describe('test_fold_template_literal', () => {
    it('`a${b}c${d}e`', () => test('`a${b}c${d}e`', '`${b}${d}`'));
    it('`stuff ${x} ${1}`', () => test('`stuff ${x} ${1}`', '`${x}`'));
    it('`stuff ${1} ${y}`', () => test('`stuff ${1} ${y}`', '`${y}`'));
    it('`stuff ${x} ${y}`', () => test('`stuff ${x} ${y}`', '`${x}${y}`'));
    it('`stuff ${x ? 1 : 2} ${y}`', () => test('`stuff ${x ? 1 : 2} ${y}`', 'x, `${y}`'));
    it('`stuff ${x} ${y ? 1 : 2}`', () => test('`stuff ${x} ${y ? 1 : 2}`', '`${x}`, y'));
    it('`stuff ${x} ${y ? 1 : 2} ${z}`', () => test('`stuff ${x} ${y ? 1 : 2} ${z}`', '`${x}`, y, `${z}`'));
    it('`4${c}${+a}`', () => test('`4${c}${+a}`', '`${c}`, +a'));
    it('`${+foo}${c}${+bar}`', () => test('`${+foo}${c}${+bar}`', '+foo, `${c}`, +bar'));
    it('`${a}${+b}${c}`', () => test('`${a}${+b}${c}`', '`${a}`, +b, `${c}`'));
});

describe('test_fold_conditional_expression', () => {
    it('(1, foo()) ? 1 : 2', () => test('(1, foo()) ? 1 : 2', 'foo()'));
    it('foo() ? 1 : 2', () => test('foo() ? 1 : 2', 'foo()'));
    it('foo() ? 1 : bar()', () => test('foo() ? 1 : bar()', 'foo() || bar()'));
    it('foo() ? bar() : 2', () => test('foo() ? bar() : 2', 'foo() && bar()'));
    it('foo() ? bar() : baz()', () => testSame('foo() ? bar() : baz()'));
    it("typeof x == 'undefined' ? 0 : x", () => test("typeof x == 'undefined' ? 0 : x", ''));
    it("typeof x != 'undefined' ? x : 0", () => test("typeof x != 'undefined' ? x : 0", ''));
    it("typeof x > 'u' ? 0 : x", () => test("typeof x > 'u' ? 0 : x", ''));
    it("typeof x < 'u' ? x : 0", () => test("typeof x < 'u' ? x : 0", ''));
});

describe('test_fold_binary_expression', () => {
    it('var a, b; a === b', () => test('var a, b; a === b', 'var a, b;'));
    it('var a, b; a() === b', () => test('var a, b; a() === b', 'var a, b; a()'));
    it('var a, b; a === b()', () => test('var a, b; a === b()', 'var a, b; b()'));
    it('var a, b; a() === b()', () => test('var a, b; a() === b()', 'var a, b; a(), b()'));
    it('var a, b; a !== b', () => test('var a, b; a !== b', 'var a, b;'));
    it('var a, b; a == b', () => test('var a, b; a == b', 'var a, b;'));
    it('var a, b; a != b', () => test('var a, b; a != b', 'var a, b;'));
    it('var a, b; a < b', () => test('var a, b; a < b', 'var a, b;'));
    it('var a, b; a > b', () => test('var a, b; a > b', 'var a, b;'));
    it('var a, b; a <= b', () => test('var a, b; a <= b', 'var a, b;'));
    it('var a, b; a >= b', () => test('var a, b; a >= b', 'var a, b;'));
    it('var a, b; a + b', () => testSame('var a, b; a + b'));
    it("var a, b; 'a' + b", () => test("var a, b; 'a' + b", "var a, b; '' + b"));
    it("var a, b; a + '' + b", () => testSame("var a, b; a + '' + b"));
    it("var a, b, c; 'a' + (b === c)", () => test("var a, b, c; 'a' + (b === c)", 'var a, b, c;'));
    it("var a, b; 'a' + +b", () => test("var a, b; 'a' + +b", "var a, b; '' + +b"));
    // can be improved to "var a, b; +b"
    it("var a, b; a + ('' + b)", () => testSame("var a, b; a + ('' + b)"));
    it("var a, b, c; a + ('' + (b === c))", () => test("var a, b, c; a + ('' + (b === c))", "var a, b, c; a + ''"));
});

describe('test_fold_call_expression', () => {
    it('foo()', () => testSame('foo()'));
    it('/* @__PURE__ */ foo()', () => test('/* @__PURE__ */ foo()', ''));
    it('/* @__PURE__ */ foo(a)', () => test('/* @__PURE__ */ foo(a)', 'a'));
    it('/* @__PURE__ */ foo(a, b)', () => test('/* @__PURE__ */ foo(a, b)', 'a, b'));
    it('/* @__PURE__ */ foo(...a)', () => test('/* @__PURE__ */ foo(...a)', '[...a]'));
    it("/* @__PURE__ */ foo(...'a')", () => test("/* @__PURE__ */ foo(...'a')", ''));
    it('/* @__PURE__ */ new Foo()', () => test('/* @__PURE__ */ new Foo()', ''));
    it('/* @__PURE__ */ new Foo(a)', () => test('/* @__PURE__ */ new Foo(a)', 'a'));
    it('true && /* @__PURE__ */ noEffect()', () => test('true && /* @__PURE__ */ noEffect()', ''));
    it('false || /* @__PURE__ */ noEffect()', () => test('false || /* @__PURE__ */ noEffect()', ''));
    it('var foo = () => 1; foo(), foo()', () => test('var foo = () => 1; foo(), foo()', 'var foo = () => 1'));
    it('var foo = () => { bar() }; foo(), foo()', () => testSame('var foo = () => { bar() }; foo(), foo()'));
    it('const a = (x) => x, b = () => a(1);', () => testSame('const a = (x) => x, b = () => a(1);'));
});

describe('test_fold_iife', () => {
    it('var k = () => {}', () => testSame('var k = () => {}'));
    it('var k = function () {}', () => testSame('var k = function () {}'));
    it('var a = (() => {})()', () => test('var a = (() => {})()', 'var a = void 0;'));
    it('(() => {})()', () => test('(() => {})()', ''));
    it('(() => a())()', () => test('(() => a())()', 'a();'));
    it('(() => { a() })()', () => test('(() => { a() })()', 'a();'));
    it('(() => { return a() })()', () => test('(() => { return a() })()', 'a();'));
    it('(a => {})()', () => test('(a => {})()', ''));
    it('((a = foo()) => {})()', () => testSame('((a = foo()) => {})()'));
    it('(a => { a() })()', () => testSame('(a => { a() })()'));
    it('((...a) => {})()', () => test('((...a) => {})()', ''));
    it('((...a) => { a() })()', () => testSame('((...a) => { a() })()'));
    it('(() => { let b = a; b() })()', () => test('(() => { let b = a; b() })()', 'a();'));
    it('(() => { let b = a; return b() })()', () => test('(() => { let b = a; return b() })()', 'a();'));
    it('(async () => {})()', () => test('(async () => {})()', ''));
    it('(async () => { a() })()', () => testSame('(async () => { a() })()'));
    it('(async () => { let b = a; b() })()', () => test('(async () => { let b = a; b() })()', '(async () => { a() })();'));
    it('var a = (function() {})()', () => test('var a = (function() {})()', 'var a = void 0;'));
    it('a((() => b())());', () => test('a((() => b())());', 'a(b())'));
    it('a((() => true)());', () => test('a((() => true)());', 'a(!0)'));
    it('a((() => { return true })());', () => test('a((() => { return true })());', 'a(!0)'));
    it('var a = (function () { b() })()', () => testSame('var a = (function () { b() })()'));
    it('var a = (function () { return b() })()', () => testSame('var a = (function () { return b() })()'));
    it('var a = (function () { return this })()', () => testSame('var a = (function () { return this })()'));
    it('var a = (function () { return arguments })()', () => testSame('var a = (function () { return arguments })()'));
    it('var a = (function () { return new.target })()', () => testSame('var a = (function () { return new.target })()'));
    it('var a = (function () { return !0 })()', () => testSame('var a = (function () { return !0 })()'));
    it('a((function () { return !0 })());', () => testSame('a((function () { return !0 })());'));
    it('(function() {})()', () => test('(function() {})()', ''));
    it('(function*() {})()', () => test('(function*() {})()', ''));
    it('(async function() {})()', () => test('(async function() {})()', ''));
    it('(function() { a() })()', () => testSame('(function() { a() })()'));
    it('(function*() { a() })()', () => testSame('(function*() { a() })()'));
    it('(async function() { a() })()', () => testSame('(async function() { a() })()'));
    it('(() => x)()', () => test('(() => x)()', 'x;'));
    it('(() => { return x })()', () => test('(() => { return x })()', 'x;'));
    it('(function () { return x })()', () => testSame('(function () { return x })()'));
    it('var a = /* @__PURE__ */ (() => x)()', () => test('var a = /* @__PURE__ */ (() => x)()', 'var a = x'));
    it('var a = /* @__PURE__ */ (() => x)(y, z)', () => testSame('var a = /* @__PURE__ */ (() => x)(y, z)'));
    it('(/* @__PURE__ */ (() => !0)() ? () => x() : () => {})();', () =>
        test('(/* @__PURE__ */ (() => !0)() ? () => x() : () => {})();', 'x();'));
    it('/* @__PURE__ */ (() => x)()', () => test('/* @__PURE__ */ (() => x)()', ''));
    it('/* @__PURE__ */ (() => { return x })()', () => test('/* @__PURE__ */ (() => { return x })()', ''));
    it('/* @__PURE__ */ (() => x)(y, z)', () => test('/* @__PURE__ */ (() => x)(y, z)', 'y, z;'));
    it('function foo(x) { if (x) { return /* @__PURE__ */ (() => 42)() } return x }', () =>
        test(
            'function foo(x) { if (x) { return /* @__PURE__ */ (() => 42)() } return x }',
            'function foo(x) { return x && 42 }',
        ));
    it('function foo(x) { if (x) { return /* @__PURE__ */ (() => bar())() } return x }', () =>
        test(
            'function foo(x) { if (x) { return /* @__PURE__ */ (() => bar())() } return x }',
            'function foo(x) { return x && /* @__PURE__ */ bar() }',
        ));
    it('function foo(x) { if (x) { return /* @__PURE__ */ (() => { return 42 })() } return x }', () =>
        test(
            'function foo(x) { if (x) { return /* @__PURE__ */ (() => { return 42 })() } return x }',
            'function foo(x) { return x && 42 }',
        ));
    it('/* @__PURE__ */ (() => 42)()', () => test('/* @__PURE__ */ (() => 42)()', ''));
    it('function foo() { /* @__PURE__ */ (() => 42)() }', () =>
        test('function foo() { /* @__PURE__ */ (() => 42)() }', 'function foo() {}'));
    it('function foo(x) { if (x) { return (/* @__PURE__ */ (() => 42)(), foo) } return x }', () =>
        test(
            'function foo(x) { if (x) { return (/* @__PURE__ */ (() => 42)(), foo) } return x }',
            'function foo(x) { return x && foo }',
        ));
    // Empty-body IIFE called with arguments: drop the wrapper, args still
    // evaluate for side effects.
    it('(() => {})(a);', () => test('(() => {})(a);', 'a;'));
    it('((x, y) => {})(a, b);', () => test('((x, y) => {})(a, b);', 'a, b;'));
    it('((x) => {})(a, b);', () => test('((x) => {})(a, b);', 'a, b;'));
    it('(function(x) {})(a);', () => test('(function(x) {})(a);', 'a;'));
    it('var u = (() => {})(a)', () => test('var u = (() => {})(a)', 'var u = (a, void 0)'));
    // Rest binding to an identifier is safe (collected array unobserved).
    it('((x, ...r) => {})(a, b)', () => test('((x, ...r) => {})(a, b)', 'a, b;'));
    // Spread arg kept as `[...a]` to preserve iterator-protocol invocation.
    it('(() => {})(...a)', () => test('(() => {})(...a)', '[...a];'));
    // All-pure args → `void 0` directly (no single-element sequence).
    it('(() => {})(1, 2);', () => test('(() => {})(1, 2);', ''));
    // Negative cases — wrapper must NOT drop.
    it('(([x]) => {})(a)', () => testSame('(([x]) => {})(a)'));
    it('(({z}) => {})(a)', () => testSame('(({z}) => {})(a)'));
    it('((x = side()) => {})(a)', () => testSame('((x = side()) => {})(a)'));
    it('((...{x}) => {})(a)', () => testSame('((...{x}) => {})(a)'));
    it('(async () => {})(a)', () => testSame('(async () => {})(a)'));
    it('(function*() {})(a)', () => testSame('(function*() {})(a)'));
    it('(() => { foo() })(a)', () => testSame('(() => { foo() })(a)'));
    // Directive-only body: in module source the redundant `'use strict'` is
    // stripped upstream, then the empty-body path drops the wrapper.
    it("(function() { 'use strict' })(a)", () => test("(function() { 'use strict' })(a)", 'a;'));
});

describe('test_remove_side_effect_free_iife', () => {
    // https://github.com/oxc-project/oxc/issues/23777
    // Calling a function/arrow literal in place runs its body once; when the
    // body (and the args + params) are side-effect-free, the whole call is too,
    // so a discarded result drops entirely — even with a non-trivial body.
    it('(function () { function test() {} return test })()', () =>
        test('(function () { function test() {} return test })()', ''));
    it('(function () { return 1 })()', () => test('(function () { return 1 })()', ''));
    it('(function () { var x = 1; return x })()', () => test('(function () { var x = 1; return x })()', ''));
    it('(function () { let a = 1, b = 2; return a + b })()', () =>
        test('(function () { let a = 1, b = 2; return a + b })()', ''));
    it('(function () { return new.target })()', () => test('(function () { return new.target })()', ''));
    it('(function () { if (1) { return 2 } else { return 3 } })()', () =>
        test('(function () { if (1) { return 2 } else { return 3 } })()', ''));
    it('(function foo() { return foo })()', () => test('(function foo() { return foo })()', ''));
    // Args that are themselves side-effect-free drop with the call.
    it('(function (a, b) { return a })(1, 2)', () => test('(function (a, b) { return a })(1, 2)', ''));
    it('(function (...rest) { return rest })()', () => test('(function (...rest) { return rest })()', ''));
    // The exact issue reproduction: an unused `var` initialized by the IIFE.
    const remove: CompressOptions = { ...defaultOptions(), unused: 'remove' };
    it('var unused = (function () { function test() {} return test })()', () =>
        testOptions('var unused = (function () { function test() {} return test })()', '', remove));
    // Negative cases — the call has real side effects and must be kept.
    it('(function () { sideEffect() })()', () => testSame('(function () { sideEffect() })()'));
    // global call in body
    it('(function () { return sideEffect() })()', () => testSame('(function () { return sideEffect() })()'));
    // global call in return
    it('(function () { globalRead })()', () => testSame('(function () { globalRead })()'));
    // global read can throw ReferenceError
    it('(function () { throw 1 })()', () => testSame('(function () { throw 1 })()'));
    // throws
    it('(function () { for (;;) sideEffect() })()', () => testSame('(function () { for (;;) sideEffect() })()'));
    // loop body
    it('(function (a) { return a })(sideEffect())', () => testSame('(function (a) { return a })(sideEffect())'));
    // side-effect-bearing argument
    it('(function (a = sideEffect()) { })()', () => testSame('(function (a = sideEffect()) { })()'));
    // param default runs user code
    it('(function ({ x }) { })(obj)', () => testSame('(function ({ x }) { })(obj)'));
    // destructuring param reads properties
    it('(function* () { return 1 })()', () => testSame('(function* () { return 1 })()'));
    // generator: kept conservatively
    it('(async function () { return 1 })()', () => testSame('(async function () { return 1 })()'));
    // async: kept conservatively
    // `this` / `arguments` reads are kept conservatively: the shared
    // side-effect analysis treats them as potentially effectful.
    it('(function () { return this })()', () => testSame('(function () { return this })()'));
    it('(function () { return arguments })()', () => testSame('(function () { return arguments })()'));
});

describe('no_side_effects', () => {
    const check = (source: string): void => {
        test(`${source}; f()`, source);
        test(`${source}; new f()`, source);
        // TODO https://github.com/evanw/esbuild/issues/3511
        // test(`${source}; html\`\``, source);
    };
    it('/* @__NO_SIDE_EFFECTS__ */ function f() {}', () => check('/* @__NO_SIDE_EFFECTS__ */ function f() {}'));
    it('/* @__NO_SIDE_EFFECTS__ */ export function f() {}', () => check('/* @__NO_SIDE_EFFECTS__ */ export function f() {}'));
    // Skipped: resolveNoSideEffects (analysis/purity.ts) does not resolve an annotation before `export default function`
    it.skip('/* @__NO_SIDE_EFFECTS__ */ export default function f() {}', () =>
        check('/* @__NO_SIDE_EFFECTS__ */ export default function f() {}'));
    it('export default /* @__NO_SIDE_EFFECTS__ */ function f() {}', () =>
        check('export default /* @__NO_SIDE_EFFECTS__ */ function f() {}'));
    it('const f = /* @__NO_SIDE_EFFECTS__ */ function() {}', () => check('const f = /* @__NO_SIDE_EFFECTS__ */ function() {}'));
    it('export const f = /* @__NO_SIDE_EFFECTS__ */ function() {}', () =>
        check('export const f = /* @__NO_SIDE_EFFECTS__ */ function() {}'));
    it('/* @__NO_SIDE_EFFECTS__ */ const f = function() {}', () => check('/* @__NO_SIDE_EFFECTS__ */ const f = function() {}'));
    it('/* @__NO_SIDE_EFFECTS__ */ export const f = function() {}', () =>
        check('/* @__NO_SIDE_EFFECTS__ */ export const f = function() {}'));
    it('const f = /* @__NO_SIDE_EFFECTS__ */ () => {}', () => check('const f = /* @__NO_SIDE_EFFECTS__ */ () => {}'));
    it('export const f = /* @__NO_SIDE_EFFECTS__ */ () => {}', () =>
        check('export const f = /* @__NO_SIDE_EFFECTS__ */ () => {}'));
    it('/* @__NO_SIDE_EFFECTS__ */ const f = () => {}', () => check('/* @__NO_SIDE_EFFECTS__ */ const f = () => {}'));
    it('/* @__NO_SIDE_EFFECTS__ */ export const f = () => {}', () =>
        check('/* @__NO_SIDE_EFFECTS__ */ export const f = () => {}'));
});

describe('treeshake_options_annotations_false', () => {
    const options: CompressOptions = { ...defaultOptions(), treeshake: { ...defaultTreeShakeOptions(), annotations: false } };
    it('function test() { bar } /* @__PURE__ */ test()', () =>
        testSameOptions('function test() { bar } /* @__PURE__ */ test()', options));
    it('function test() {} /* @__PURE__ */ new test()', () =>
        testSameOptions('function test() {} /* @__PURE__ */ new test()', options));
    const options2: CompressOptions = { ...defaultOptions(), treeshake: { ...defaultTreeShakeOptions(), annotations: true } };
    it('function test() {} /* @__PURE__ */ test()', () =>
        testOptions('function test() {} /* @__PURE__ */ test()', 'function test() {}', options2));
    it('function test() {} /* @__PURE__ */ new test()', () =>
        testOptions('function test() {} /* @__PURE__ */ new test()', 'function test() {}', options2));
});

describe('remove_unused_assignment_expression', () => {
    const options = smallestOptions();
    it('var x = 1; x = 2;', () => testOptions('var x = 1; x = 2;', '', options));
    it('var x = 1; x = foo();', () => testOptions('var x = 1; x = foo();', 'foo()', options));
    it("var x = 1; x = 2, eval('x')", () => testSameOptions("var x = 1; x = 2, eval('x')", options));
    it('export var foo; foo = 0;', () => testSameOptions('export var foo; foo = 0;', options));
    it('var x = 1; x = 2, foo(x)', () => testSameOptions('var x = 1; x = 2, foo(x)', options));
    it('function foo() { return t = x(); } foo();', () => testSameOptions('function foo() { return t = x(); } foo();', options));
    it('function foo() { var t; return t = x(); } foo();', () =>
        testOptions('function foo() { var t; return t = x(); } foo();', 'function foo() { return x(); } foo();', options));
    it('function foo(t) { return t = x(); } foo();', () =>
        testSameOptions('function foo(t) { return t = x(); } foo();', options));
    it('let x = 1; x = 2;', () => testOptions('let x = 1; x = 2;', '', options));
    it('let x = 1; x = foo();', () => testOptions('let x = 1; x = foo();', 'foo()', options));
    it('export let foo; foo = 0;', () => testSameOptions('export let foo; foo = 0;', options));
    it('let x = 1; x = 2, foo(x)', () => testSameOptions('let x = 1; x = 2, foo(x)', options));
    it('function foo() { return t = x(); } foo();', () => testSameOptions('function foo() { return t = x(); } foo();', options));
    it('function foo() { let t; return t = x(); } foo();', () =>
        testOptions('function foo() { let t; return t = x(); } foo();', 'function foo() { return x() } foo()', options));
    it('function foo(t) { return t = x(); } foo();', () =>
        testSameOptions('function foo(t) { return t = x(); } foo();', options));
    // For loops
    it('for (let i;;) i = 0', () => testOptions('for (let i;;) i = 0', 'for (;;);', options));
    // `i` reads as the implicit `undefined`, but `void 0` prints longer than a
    // mangled identifier read, so the read (and thus the decl) stays (rolldown#10174).
    it('for (let i;;) foo(i)', () => testSameOptions('for (let i;;) foo(i)', options));
    it('for (let i;;) i = 0, foo(i)', () => testSameOptions('for (let i;;) i = 0, foo(i)', options));
    it('for (let i in []) foo(i)', () => testSameOptions('for (let i in []) foo(i)', options));
    it('for (let element of list) element && (element.foo = bar)', () =>
        testSameOptions('for (let element of list) element && (element.foo = bar)', options));
    it('for (let key in obj) key && (obj[key] = bar)', () =>
        testSameOptions('for (let key in obj) key && (obj[key] = bar)', options));
    it('var a; ({ a: a } = {})', () => testOptions('var a; ({ a: a } = {})', 'var a; ({ a } = {})', options));
    it('var a; b = ({ a: a })', () => testOptions('var a; b = ({ a: a })', 'var a; b = ({ a })', options));
    it('let foo = {}; foo = 1', () => testOptions('let foo = {}; foo = 1', '', options));
    it('let bracketed = !1; for(;;) bracketed = !bracketed, log(bracketed)', () =>
        testSameOptions('let bracketed = !1; for(;;) bracketed = !bracketed, log(bracketed)', options));
    const options2 = smallestOptions();
    const sourceType = 'script';
    it('var x = 1; x = 2;', () => testOptions('var x = 1; x = 2;', 'var x = 1; x = 2;', options2, sourceType));
    it('var x = 1; x = 2, foo(x)', () =>
        testOptions('var x = 1; x = 2, foo(x)', 'var x = 1; x = 2, foo(x)', options2, sourceType));
    it('function foo() { var x = 1; x = 2, bar() } foo()', () =>
        testOptions('function foo() { var x = 1; x = 2, bar() } foo()', 'function foo() { bar() } foo()', options2, sourceType));
});

describe('remove_unused_class_expression', () => {
    const options = smallestOptions();
    // extends
    it('(class {})', () => testOptions('(class {})', '', options));
    it('(class extends Foo {})', () => testOptions('(class extends Foo {})', 'Foo', options));
    // static block
    it('(class { static {} })', () => testOptions('(class { static {} })', '', options));
    it('(class { static { foo } })', () => testSameOptions('(class { static { foo } })', options));
    // method
    it('(class { foo() {} })', () => testOptions('(class { foo() {} })', '', options));
    it('(class { [foo]() {} })', () => testOptions('(class { [foo]() {} })', 'foo', options));
    it('(class { static foo() {} })', () => testOptions('(class { static foo() {} })', '', options));
    it('(class { static [foo]() {} })', () => testOptions('(class { static [foo]() {} })', 'foo', options));
    it('(class { [1]() {} })', () => testOptions('(class { [1]() {} })', '', options));
    it('(class { static [1]() {} })', () => testOptions('(class { static [1]() {} })', '', options));
    // property
    it('(class { foo })', () => testOptions('(class { foo })', '', options));
    it('(class { foo = bar })', () => testOptions('(class { foo = bar })', '', options));
    it('(class { foo = 1 })', () => testOptions('(class { foo = 1 })', '', options));
    // TODO: would be nice if this is removed but the one with `this` is kept.
    it('(class { static foo = bar })', () => testSameOptions('(class { static foo = bar })', options));
    it('(class { static foo = this.bar = {} })', () => testSameOptions('(class { static foo = this.bar = {} })', options));
    it('(class { static foo = 1 })', () => testOptions('(class { static foo = 1 })', '', options));
    it('(class { [foo] = bar })', () => testOptions('(class { [foo] = bar })', 'foo', options));
    it('(class { [foo] = 1 })', () => testOptions('(class { [foo] = 1 })', 'foo', options));
    it('(class { static [foo] = bar })', () => testSameOptions('(class { static [foo] = bar })', options));
    it('(class { static [foo] = 1 })', () => testOptions('(class { static [foo] = 1 })', 'foo', options));
    // accessor
    it('(class { accessor foo = 1 })', () => testOptions('(class { accessor foo = 1 })', '', options));
    it('(class { accessor [foo] = 1 })', () => testOptions('(class { accessor [foo] = 1 })', 'foo', options));
    // order
    it('(class extends A { [B] = C; [D]() {} })', () =>
        testOptions('(class extends A { [B] = C; [D]() {} })', 'A, B, D', options));
    // decorators
    // Skipped: shakeup's printer drops decorators, so the idempotency run sees an undecorated class and removes it
    it.skip('(class { @dec foo() {} })', () => testSameOptions('(class { @dec foo() {} })', options));
    // Skipped: shakeup's printer drops decorators, so the idempotency run sees an undecorated class and removes it
    it.skip('(@dec class {})', () => testSameOptions('(@dec class {})', options));
    // TypeError
    it('(class extends (() => {}) {})', () => testSameOptions('(class extends (() => {}) {})', options));
});

describe('test_property_write_side_effects', () => {
    const options: CompressOptions = {
        ...smallestOptions(),
        unused: 'remove',
        treeshake: { ...defaultTreeShakeOptions(), propertyWriteSideEffects: false, propertyReadSideEffects: 'none' },
    };
    // Issue #14207: drop function declarations with property assignments
    it('function A() {} A.from = () => {};', () => testOptions('function A() {} A.from = () => {};', '', options));
    // Function declaration + multiple property assignments
    it('function A() {} A.foo = 1; A.bar = 2;', () => testOptions('function A() {} A.foo = 1; A.bar = 2;', '', options));
    // Class declaration + property assignment
    it('class A {} A.foo = 1;', () => testOptions('class A {} A.foo = 1;', '', options));
    // Property write is kept when variable is read elsewhere (statement fusion merges them)
    it('function A() {} A.foo = 1; console.log(A);', () =>
        testOptions('function A() {} A.foo = 1; console.log(A);', 'function A() {} A.foo = 1, console.log(A);', options));
    // Assignment RHS with side effects: the RHS is hoisted, the write dropped
    // (same as the default path — see
    // `test_drop_write_only_property_assignments_by_default`).
    it('function A() {} A.foo = sideEffect();', () =>
        testOptions('function A() {} A.foo = sideEffect();', 'sideEffect();', options));
    // Property assignment on global (not local binding) should be kept
    it('globalObj.foo = 1;', () => testSameOptions('globalObj.foo = 1;', options));
    // Object literal + property assignment (fresh value, safe to drop)
    it('const B = {}; B.foo = 1;', () => testOptions('const B = {}; B.foo = 1;', '', options));
    // Arrow function + property assignment (fresh value, safe to drop)
    it('const C = () => {}; C.foo = 1;', () => testOptions('const C = () => {}; C.foo = 1;', '', options));
    // Function expression + property assignment (fresh value, safe to drop)
    it('const D = function() {}; D.foo = 1;', () => testOptions('const D = function() {}; D.foo = 1;', '', options));
    // Variable initialized from another binding (not fresh, could alias)
    it('const b = a; b.foo = 1;', () => testSameOptions('const b = a; b.foo = 1;', options));
    // Alias where nothing is exported: inlining resolves alias, then everything drops
    it('const a = {}; const b = a; b.foo = 1;', () => testOptions('const a = {}; const b = a; b.foo = 1;', '', options));
    // Alias where target is exported: must preserve the property write
    it('const a = {}; const b = a; b.add = 1; export { a };', () =>
        testOptions(
            'const a = {}; const b = a; b.add = 1; export { a };',
            'const a = {}, b = a; b.add = 1; export { a };',
            options,
        ));
    it('const a = {}; const b = a; b.add = 1; export { b };', () =>
        testOptions('const a = {}; const b = a; b.add = 1; export { b };', 'const b = {}; b.add = 1; export { b };', options));
    it('const a = {}; const b = a; a.add = 1; export { b };', () =>
        testOptions(
            'const a = {}; const b = a; a.add = 1; export { b };',
            'const a = {}, b = a; a.add = 1; export { b };',
            options,
        ));
    // Chained member expression: b.a.add = 1 must be preserved
    // because b.a could alias exported a
    it('const a = {}; const b = { a }; b.a.add = 1; export { a };', () =>
        testOptions(
            'const a = {}; const b = { a }; b.a.add = 1; export { a };',
            'const a = {}, b = { a }; b.a.add = 1; export { a };',
            options,
        ));
    // Exported function: property write must be preserved (observable by importers)
    it('export function A() {} A.foo = 1;', () => testSameOptions('export function A() {} A.foo = 1;', options));
    // Classes with static setters should NOT be dropped — setters trigger side effects
    it('class A { static set foo(v) { console.log(v); } } A.foo = 1;', () =>
        testSameOptions('class A { static set foo(v) { console.log(v); } } A.foo = 1;', options));
    // Object literals with setters should NOT be dropped
    it('const obj = { set foo(v) { console.log(v); } }; obj.foo = 1;', () =>
        testSameOptions('const obj = { set foo(v) { console.log(v); } }; obj.foo = 1;', options));
    // Class expression with static setter should NOT be dropped
    it('const A = class { static set foo(v) { console.log(v); } }; A.foo = 1;', () =>
        testSameOptions('const A = class { static set foo(v) { console.log(v); } }; A.foo = 1;', options));
    // Static accessor auto-generates setter — must NOT be dropped
    it('class A { static accessor foo = 0; } A.foo = 1;', () =>
        testSameOptions('class A { static accessor foo = 0; } A.foo = 1;', options));
    // Any static property with a value prevents removal (matches SWC behavior)
    it('class A { static b = 0; } A.b = 1;', () => testSameOptions('class A { static b = 0; } A.b = 1;', options));
    // Static property whose value contains a setter — must NOT be dropped
    it('class A { static b = { set x(v) { console.log(v); } }; } A.b = 1;', () =>
        testSameOptions('class A { static b = { set x(v) { console.log(v); } }; } A.b = 1;', options));
    // Object literal with nested setter in property value
    it('const obj = { bar: { set x(v) { console.log(v); } } }; obj.bar = 1;', () =>
        testSameOptions('const obj = { bar: { set x(v) { console.log(v); } } }; obj.bar = 1;', options));
    // Deeply nested setter in property value (depth 2+)
    it('const obj = { bar: { baz: { set x(v) { console.log(v); } } } }; obj.bar = 1;', () =>
        testSameOptions('const obj = { bar: { baz: { set x(v) { console.log(v); } } } }; obj.bar = 1;', options));
    // Inherited static setter via extends — B.foo triggers A's static setter
    // We can't statically detect inherited setters, but B extends A means
    // B has a read reference to A, so A is preserved. B itself is fresh
    // (no own static setters), but the extends clause is a side effect.
    it('class A { static set foo(v) { console.log(v); } } class B extends A {} B.foo = 1;', () =>
        testSameOptions('class A { static set foo(v) { console.log(v); } } class B extends A {} B.foo = 1;', options));
    // Object.defineProperty installs setter dynamically — foo has a read reference
    // in the first argument, so foo is not considered unused
    it("const foo = () => {}; Object.defineProperty(foo, 'bar', { set: (v) => { console.log(v); } }); foo.ba", () =>
        testOptions(
            "const foo = () => {}; Object.defineProperty(foo, 'bar', { set: (v) => { console.log(v); } }); foo.bar = 1;",
            "const foo = () => {}; Object.defineProperty(foo, 'bar', { set: (v) => { console.log(v); } }), foo.bar = 1;",
            options,
        ));
    it("const foo = []; Object.defineProperty(foo, 'bar', { set: (v) => { console.log(v); } }); foo.bar = 1;", () =>
        testOptions(
            "const foo = []; Object.defineProperty(foo, 'bar', { set: (v) => { console.log(v); } }); foo.bar = 1;",
            "const foo = []; Object.defineProperty(foo, 'bar', { set: (v) => { console.log(v); } }), foo.bar = 1;",
            options,
        ));
    // Non-static setters are fine — property writes on the class itself won't trigger them
    it('class A { set foo(v) { console.log(v); } } A.bar = 1;', () =>
        testOptions('class A { set foo(v) { console.log(v); } } A.bar = 1;', '', options));
    // A static getter (get-only) makes a write to its key throw in strict mode,
    // so a class with any static accessor is no longer treated as a fresh value —
    // its writes are kept (conservative for an unrelated key like `bar`, sound).
    it('class A { static get foo() { return 1; } } A.bar = 1;', () =>
        testSameOptions('class A { static get foo() { return 1; } } A.bar = 1;', options));
    // __proto__ assignment can install setters that make subsequent property writes
    // side-effectful. When both __proto__ write and property write exist, preserve all.
    it("const a = {}; a.__proto__ = { set a(v) { console.log('setter'); } }; a.a = 1;", () =>
        testOptions(
            "const a = {}; a.__proto__ = { set a(v) { console.log('setter'); } }; a.a = 1;",
            "const a = {}; a.__proto__ = { set a(v) { console.log('setter'); } }, a.a = 1;",
            options,
        ));
    it("class A {} A.__proto__ = { set a(v) { console.log('setter'); } }; A.a = 1;", () =>
        testOptions(
            "class A {} A.__proto__ = { set a(v) { console.log('setter'); } }; A.a = 1;",
            "class A {} A.__proto__ = { set a(v) { console.log('setter'); } }, A.a = 1;",
            options,
        ));
    // __proto__ write alone (no subsequent property write) — safe to drop,
    // the setter is installed but never triggered.
    it("const a = {}; a.__proto__ = { set a(v) { console.log('setter'); } };", () =>
        testOptions("const a = {}; a.__proto__ = { set a(v) { console.log('setter'); } };", '', options));
    // Property write alone (no __proto__) — safe to drop, no setter exists.
    it('const a = {}; a.a = 1;', () => testOptions('const a = {}; a.a = 1;', '', options));
    // Computed member expression could be `"__proto__"`, must be treated as potential proto write
    it("const a = {}; a[b] = { set a(v) { console.log('setter'); } }; a.a = 1;", () =>
        testOptions(
            "const a = {}; a[b] = { set a(v) { console.log('setter'); } }; a.a = 1;",
            "const a = {}; a[b] = { set a(v) { console.log('setter'); } }, a.a = 1;",
            options,
        ));
    // Literal non-string keys can't coerce to `"__proto__"` but are kept
    // conservatively — see `MemberWriteEffect::MayMutatePrototype`.
    it('const a = {}; a[null] = 1; a.a = 1;', () =>
        testOptions('const a = {}; a[null] = 1; a.a = 1;', 'const a = {}; a[null] = 1, a.a = 1;', options));
    // `__proto__` in object literal initializer installs setters via prototype chain
    it("const a = { __proto__: { set a(v) { console.log('setter'); } } }; a.a = 1;", () =>
        testSameOptions("const a = { __proto__: { set a(v) { console.log('setter'); } } }; a.a = 1;", options));
    it("class A {} A.__proto__ = { set a(v) { console.log('setter'); } }; A.a = 1;", () =>
        testOptions(
            "class A {} A.__proto__ = { set a(v) { console.log('setter'); } }; A.a = 1;",
            "class A {} A.__proto__ = { set a(v) { console.log('setter'); } }, A.a = 1;",
            options,
        ));
    // `__proto__` assignment inside a hoisted function — traversal reaches the
    // function body only AFTER `obj.a = 1`, so the old per-pass tracking never saw
    // it in time and wrongly dropped `obj.a = 1`. `MayMutatePrototype` is
    // recorded by `Normalize` before the fixed-point loop, so it is caught
    // regardless of order. `f` has an observable side effect (`g()`), so it is
    // not tree-shaken:
    // the setter really is installed when `f()` runs, and the sibling `obj.a = 1`
    // that would trigger it must survive.
    it("const obj = {}; f(); obj.a = 1; function f() { g(); obj.__proto__ = { set a(v) { console.log('hello'", () =>
        testOptions(
            "const obj = {}; f(); obj.a = 1; function f() { g(); obj.__proto__ = { set a(v) { console.log('hello'); } }; }",
            "const obj = {};\nf(), obj.a = 1;\nfunction f() {\n\tg(), obj.__proto__ = { set a(v) {\n\t\tconsole.log('hello');\n\t} };\n}\n",
            options,
        ));
    // Destructuring proto write (`[o.__proto__] = [x]`) is now caught by the
    // Normalize scan (the old per-pass tracking only saw `=` assignments), so the
    // sibling `o.a = 1` is kept.
    it('var o = {}; [o.__proto__] = [x]; o.a = 1;', () =>
        testOptions('var o = {}; [o.__proto__] = [x]; o.a = 1;', 'var o = {};\n[o.__proto__] = [x], o.a = 1;\n', options));
    // Default options (property_write_side_effects: true) also drop these now —
    // see `test_drop_write_only_property_assignments_by_default`.
    const defaultOpts: CompressOptions = { ...smallestOptions(), unused: 'remove' };
    it('function A() {} A.from = () => {};', () => testOptions('function A() {} A.from = () => {};', '', defaultOpts));
});

describe('test_drop_write_only_property_assignments_by_default', () => {
    // Under DEFAULT options (`property_write_side_effects: true` untouched —
    // that stays rolldown's tree-shaking knob), full-minify mode drops property
    // assignments whose base is a provably-unused, fresh, non-escaping local
    // binding (terser parity). See `docs/ASSUMPTIONS.md`.
    // Headline: one `displayName` write must not keep an entire module alive.
    // (The `(function(){...})()` wrapper itself survives only because plain-
    // function IIFE inlining is a separate, pre-existing limitation —
    // `substitute_iife_call` unwraps arrow bodies only.)
    it("(function() { var r = require('react'); var o = function(e, t) { return r.create(e, t); }; o.display", () =>
        testSmallest(
            "(function() { var r = require('react'); var o = function(e, t) { return r.create(e, t); }; o.displayName = 'X'; })();",
            "(function() { require('react'); })();",
        ));
    it("(() => { var r = require('react'); var o = function(e, t) { return r.create(e, t); }; o.displayName ", () =>
        testSmallest(
            "(() => { var r = require('react'); var o = function(e, t) { return r.create(e, t); }; o.displayName = 'X'; })();",
            "require('react');",
        ));
    // Pure RHS: the whole statement drops, for every fresh-value init shape.
    it('var o = {}; o.x = 1;', () => testSmallest('var o = {}; o.x = 1;', ''));
    it('var o = []; o.x = 1;', () => testSmallest('var o = []; o.x = 1;', ''));
    it('var o = () => {}; o.x = 1;', () => testSmallest('var o = () => {}; o.x = 1;', ''));
    it('var o = function() {}; o.x = 1;', () => testSmallest('var o = function() {}; o.x = 1;', ''));
    it('var o = class {}; o.x = 1;', () => testSmallest('var o = class {}; o.x = 1;', ''));
    it('function o() {} o.x = 1;', () => testSmallest('function o() {} o.x = 1;', ''));
    // Impure RHS: the RHS is hoisted in place, the write dropped.
    it('var o = {}; o.x = impure();', () => testSmallest('var o = {}; o.x = impure();', 'impure();'));
    // Value position: a plain assignment's value IS the RHS value.
    it('var o = {}; use(o.x = impure());', () => testSmallest('var o = {}; use(o.x = impure());', 'use(impure());'));
    // Computed keys: literal string/number keys are safe...
    it("var o = {}; o['x'] = 1;", () => testSmallest("var o = {}; o['x'] = 1;", ''));
    it('var o = {}; o[0] = 1;', () => testSmallest('var o = {}; o[0] = 1;', ''));
    // ...but expression keys could evaluate to `"__proto__"` (installing
    // setters) or have their own effects, and `__proto__` itself never drops.
    it('var o = {}; o[k()] = 1;', () => testSameSmallest('var o = {}; o[k()] = 1;'));
    it('var o = {}; o[b] = 1;', () => testSameSmallest('var o = {}; o[b] = 1;'));
    it('var o = {}; o.__proto__ = x;', () => testSameSmallest('var o = {}; o.__proto__ = x;'));
    it("var o = {}; o['__proto__'] = x;", () => testSmallest("var o = {}; o['__proto__'] = x;", 'var o = {}; o.__proto__ = x;'));
    // Escapes: any non-member-write use of the binding blocks the drop.
    it('var o = {}; o.x = 1; use(o);', () => testSmallest('var o = {}; o.x = 1; use(o);', 'var o = {}; o.x = 1, use(o);'));
    it('var o = {}; o.x = o;', () => testSameSmallest('var o = {}; o.x = o;'));
    it('var o = {}; o.x = () => o;', () => testSameSmallest('var o = {}; o.x = () => o;'));
    it('export var o = {}; o.x = 1;', () => testSameSmallest('export var o = {}; o.x = 1;'));
    // Read-modify interference (hazard): compound/logical/update ops READ the
    // property, so sibling plain writes must survive — dropping
    // `o.x = { valueOf: f }` would delete the observable `f()` call from
    // `+=`'s coercion.
    it('var o = {}; o.x = { valueOf: f }; o.x += 1;', () =>
        testSmallest('var o = {}; o.x = { valueOf: f }; o.x += 1;', 'var o = {}; o.x = { valueOf: f }, o.x += 1;'));
    it('var o = {}; o.x += 1;', () => testSameSmallest('var o = {}; o.x += 1;'));
    it('var o = {}; o.y ||= 2; o.x = 1;', () =>
        testSmallest('var o = {}; o.y ||= 2; o.x = 1;', 'var o = {}; o.y ||= 2, o.x = 1;'));
    it('var o = {}; o.x++; o.y = 1;', () => testSmallest('var o = {}; o.x++; o.y = 1;', 'var o = {}; o.x++, o.y = 1;'));
    // Formed-compound staleness: the loop rewrites `o.y = o.y + 1` to
    // `o.y += 1` (dropping the plain read that blocked the counts predicate);
    // the hazard set must still block the sibling plain write.
    it('var o = {}; o.x = evil; o.y = o.y + 1;', () =>
        testSmallest('var o = {}; o.x = evil; o.y = o.y + 1;', 'var o = {}; o.x = evil, o.y += 1;'));
    // Chained-write base (hazard): dropping `a.b = {}` while `a.b.c = 1`
    // survives would throw at runtime.
    it('var a = {}; a.b = {}; a.b.c = 1;', () =>
        testSmallest('var a = {}; a.b = {}; a.b.c = 1;', 'var a = {}; a.b = {}, a.b.c = 1;'));
    // `__proto__` write in a hoisted function runs before the property write —
    // the hazard scan is execution-order independent because `Normalize` seeds
    // the facts before the fixed-point loop.
    it('const obj = {}; f(); obj.a = 1; function f() { obj.__proto__ = { set a(v) { console.log(v); } }; }', () =>
        testSmallest(
            'const obj = {}; f(); obj.a = 1; function f() { obj.__proto__ = { set a(v) { console.log(v); } }; }',
            'const obj = {}; f(), obj.a = 1; function f() { obj.__proto__ = { set a(v) { console.log(v); } }; }',
        ));
    // Single-level `delete` neither reads the property nor triggers setters:
    // the plain write drops, the delete stays.
    it('var o = {}; o.x = 1; delete o.x;', () => testSmallest('var o = {}; o.x = 1; delete o.x;', 'var o = {}; delete o.x;'));
    // Chained delete reads the intermediate object — everything stays.
    it('var a = {}; a.b = {}; delete a.b.c;', () =>
        testSmallest('var a = {}; a.b = {}; delete a.b.c;', 'var a = {}; a.b = {}, delete a.b.c;'));
    // Setter observation via the object itself: not a fresh value.
    it('class A { static set foo(v) { console.log(v); } } A.foo = 1;', () =>
        testSameSmallest('class A { static set foo(v) { console.log(v); } } A.foo = 1;'));
    it('var o = { set x(v) { console.log(v) } }; o.x = 1;', () =>
        testSameSmallest('var o = { set x(v) { console.log(v) } }; o.x = 1;'));
    // Gates.
    // Script-mode top-level vars are global state.
    it('var o = {}; o.x = 1;', () => testOptions('var o = {}; o.x = 1;', 'var o = {}; o.x = 1;', smallestOptions(), 'script'));
    // Direct eval can observe anything.
    it("export function f() { var o = {}; o.x = 1; eval(''); }", () =>
        testSmallest(
            "export function f() { var o = {}; o.x = 1; eval(''); }",
            "export function f() { var o = {}; o.x = 1, eval(''); }",
        ));
    // --- Kind-aware key denylist ---
    // A write that would throw a strict-mode `TypeError`, or observably coerce,
    // is NOT dead even though the base binding is otherwise unused.
    // Function objects (fn-expr / arrow / fn-decl): `name` and `length` are
    // non-writable own props; `caller` / `arguments` are the %ThrowTypeError%
    // poison. Class objects (class-expr / class-decl) share those. All throw.
    for (const [form, sep] of [
        ['var o = function() {}', ';'],
        ['var o = () => {}', ';'],
        ['function o() {}', ''],
        ['var o = class {}', ';'],
        ['class o {}', ''],
    ]) {
        for (const key of ['caller', 'arguments', 'name', 'length']) {
            it(`${form}${sep} o.${key} = 1;`, () => testSameSmallest(`${form}${sep} o.${key} = 1;`));
        }
    }
    // A class's `prototype` is non-writable (throws), so it stays. A plain
    // function's `prototype` IS writable, so that write still drops.
    it('var o = class {}; o.prototype = 1;', () => testSameSmallest('var o = class {}; o.prototype = 1;'));
    it('class o {} o.prototype = 1;', () => testSameSmallest('class o {} o.prototype = 1;'));
    it('var f = function() {}; f.prototype = {};', () => testSmallest('var f = function() {}; f.prototype = {};', ''));
    it('function f() {} f.prototype = {};', () => testSmallest('function f() {} f.prototype = {};', ''));
    // Array `length`: `a.length = -1` throws a `RangeError`; `a.length = {...}`
    // runs a `valueOf` coercion. Both kept; a computed string key counts too.
    it('var a = []; a.length = -1;', () => testSameSmallest('var a = []; a.length = -1;'));
    it('var a = []; a.length = { valueOf() { g(); } };', () =>
        testSameSmallest('var a = []; a.length = { valueOf() { g(); } };'));
    it("var a = []; a['length'] = 1;", () => testSmallest("var a = []; a['length'] = 1;", 'var a = []; a.length = 1;'));
    // A numeric index write is an ordinary array write — still drops.
    it('var a = []; a[0] = 1;', () => testSmallest('var a = []; a[0] = 1;', ''));
    // `name` / `length` on an object literal are ordinary writable props: the
    // denylist is kind-scoped, so Object-kind bases still drop.
    it('var o = {}; o.length = 5;', () => testSmallest('var o = {}; o.length = 5;', ''));
    it("var o = {}; o.name = 'n';", () => testSmallest("var o = {}; o.name = 'n';", ''));
    // Instance-private write (`o.#x = 1`) is a brand check that throws unless
    // `o` is an instance of the declaring class — a fresh literal never is.
    it('export class C { #x; m() { var o = {}; o.#x = 1; } }', () =>
        testSameSmallest('export class C { #x; m() { var o = {}; o.#x = 1; } }'));
    // A class with a static block, a static getter, or a decorator is not a
    // fresh value (arbitrary code runs / a write to that key throws), so a
    // later write to it survives.
    it('class o { static { g(); } } o.x = 1;', () => testSameSmallest('class o { static { g(); } } o.x = 1;'));
    it('class o { static get foo() { return 1; } } o.foo = 1;', () =>
        testSameSmallest('class o { static get foo() { return 1; } } o.foo = 1;'));
    // Skipped: shakeup's printer drops decorators, so the idempotency run sees an undecorated class and removes it
    it.skip('@dec class o {} o.x = 1;', () => testSameSmallest('@dec class o {} o.x = 1;'));
    // unused: Keep (default_options()) / KeepAssign keep the write.
    it('function A() {} A.from = () => {};', () => testSame('function A() {} A.from = () => {};'));
    const keepAssign: CompressOptions = { ...smallestOptions(), unused: 'keep-assign' };
    it('function A() {} A.from = () => {};', () => testSameOptions('function A() {} A.from = () => {};', keepAssign));
});

describe('test_summary_invalidation_preserves_member_write_hazard', () => {
    // Both initializers keep the dense fresh-value kind intact. Clearing the
    // function summary by removing its shared metadata entry would lose the
    // `||=` hazard and incorrectly drop `foo.x = 1`.
    it('var foo = function() {}; var foo = function() {}; foo.x = 1; foo.x ||= send();', () =>
        testSmallest(
            'var foo = function() {}; var foo = function() {}; foo.x = 1; foo.x ||= send();',
            'var foo = function() {}, foo = function() {}; foo.x = 1, foo.x ||= send();',
        ));
});

describe('test_update_expression_respects_property_read_side_effects', () => {
    // `obj.prop++` performs an implicit read, so it's side-effectful when
    // `property_read_side_effects` is `All` — even if writes are free.
    const options: CompressOptions = {
        ...smallestOptions(),
        unused: 'remove',
        treeshake: { ...defaultTreeShakeOptions(), propertyWriteSideEffects: false, propertyReadSideEffects: 'all' },
    };
    it("import { counter } from './c'; counter.value++; console.log(counter);", () =>
        testOptions(
            "import { counter } from './c'; counter.value++; console.log(counter);",
            "import { counter } from './c'; counter.value++, console.log(counter);",
            options,
        ));
    it("import { counter } from './c'; ++counter.count; console.log(counter);", () =>
        testOptions(
            "import { counter } from './c'; ++counter.count; console.log(counter);",
            "import { counter } from './c'; ++counter.count, console.log(counter);",
            options,
        ));
    it("import { counter } from './c'; counter['another']--; console.log(counter);", () =>
        testOptions(
            "import { counter } from './c'; counter['another']--; console.log(counter);",
            "import { counter } from './c'; counter.another--, console.log(counter);",
            options,
        ));
    // Static block runs on class evaluation.
    it("import { counter } from './c'; (class { static { ++counter.count; } }); console.log(counter);", () =>
        testOptions(
            "import { counter } from './c'; (class { static { ++counter.count; } }); console.log(counter);",
            "import { counter } from './c'; (class { static { ++counter.count; } }), console.log(counter);",
            options,
        ));
    // Computed key runs on class evaluation; class body is unused, so only the key's side effect is extracted.
    it("import { counter } from './c'; class A { [counter.another++] = 123; } console.log(counter);", () =>
        testOptions(
            "import { counter } from './c'; class A { [counter.another++] = 123; } console.log(counter);",
            "import { counter } from './c'; counter.another++, console.log(counter);",
            options,
        ));
});
