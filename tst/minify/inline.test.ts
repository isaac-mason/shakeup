// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are JS source under test.
// Ported from oxc_minifier/tests/peephole/inline.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { smallestOptions } from '../../src/passes/dce/options.ts';
import { testOptions, testSameOptions, testSmallest } from './harness.ts';

// https://github.com/oxc-project/oxc/issues/24531
// A `var` assigned only inside a conditional holds its hoisted `undefined`
// on the untaken path; single-statement block flattening produces a
// brace-less `if (c) var x = v;` whose declarator has no block scope, so
// the value must not be treated as write-once.
describe('conditional_var_declarator_not_inlined', () => {
    const options = smallestOptions();
    it("function t() { if (window.x) { var callback = true } return () => callback ? 'ng' : 'ok'; } NOOP(t()", () =>
        testOptions(
            "function t() { if (window.x) { var callback = true } return () => callback ? 'ng' : 'ok'; } NOOP(t());",
            "function t() { if (window.x) var callback = !0; return () => callback ? 'ng' : 'ok'; } NOOP(t());",
            options,
        ));
    // The already-flattened form.
    it("function t() { if (window.x) var callback = true; return () => callback ? 'ng' : 'ok'; } NOOP(t());", () =>
        testOptions(
            "function t() { if (window.x) var callback = true; return () => callback ? 'ng' : 'ok'; } NOOP(t());",
            "function t() { if (window.x) var callback = !0; return () => callback ? 'ng' : 'ok'; } NOOP(t());",
            options,
        ));
});

describe('conditional_var_alternate_after_declarative_consequent_not_inlined', () => {
    // The alternate is still conditional when the consequent is itself
    // declarative and therefore has not ended the body's prelude.
    it("function t(c) { if (c) var a = 1; else var flag = true; return () => flag ? 'ng' : 'ok'; } NOOP(t())", () =>
        testSmallest(
            "function t(c) { if (c) var a = 1; else var flag = true; return () => flag ? 'ng' : 'ok'; } NOOP(t());",
            "function t(c) { if (c) var a = 1; else var flag = !0; return () => flag ? 'ng' : 'ok'; } NOOP(t());",
        ));
});

describe('conditional_var_is_not_assumed_fresh', () => {
    // The untaken path leaves `x` undefined, so dropping the member write would
    // remove a TypeError.
    it('export function f(a) { if (a) var x = {}; x.p = 1; }', () =>
        testSmallest(
            'export function f(a) { if (a) var x = {}; x.p = 1; }',
            'export function f(a) { if (a) var x = {}; x.p = 1; }',
        ));
});

describe('single_conditional_falsy_var_still_folds_in_boolean_context', () => {
    // Both possible values (`undefined` and `false`) are falsy, so the special
    // boolean-context fact remains valid for a symbol with one declaration.
    it("export function f(a) { if (a) var x = false; return x ? 'bad' : 'ok'; }", () =>
        testSmallest(
            "export function f(a) { if (a) var x = false; return x ? 'bad' : 'ok'; }",
            "export function f(a) { if (a) var x = !1; return 'ok'; }",
        ));
});

// https://github.com/oxc-project/oxc/issues/24603
describe('conditional_var_redeclarations_do_not_overwrite_reaching_values', () => {
    it("export function f(a) { if (a) var x = true; else var x = false; return x ? 'ok' : 'fail'; }", () =>
        testSmallest(
            "export function f(a) { if (a) var x = true; else var x = false; return x ? 'ok' : 'fail'; }",
            "export function f(a) { if (a) var x = !0; else var x = !1; return x ? 'ok' : 'fail'; }",
        ));
    // The result must not depend on which branch traversal visits last.
    it("export function f(a) { if (a) var x = false; else var x = true; return x ? 'ok' : 'fail'; }", () =>
        testSmallest(
            "export function f(a) { if (a) var x = false; else var x = true; return x ? 'ok' : 'fail'; }",
            "export function f(a) { if (a) var x = !1; else var x = !0; return x ? 'ok' : 'fail'; }",
        ));
});

describe('redeclared_falsy_var_is_not_assumed_falsy', () => {
    // The dirty prelude withholds the first declaration's constant. A nested
    // reader can consume its independently cached boolean-falsy fact before
    // traversal reaches the later declaration.
    it("export function outer() { sideEffect(); var x = false; function read() { return x ? 'T' : 'F'; } var", () =>
        testSmallest(
            "export function outer() { sideEffect(); var x = false; function read() { return x ? 'T' : 'F'; } var x = true; return read(); }",
            "export function outer() { sideEffect(); var x = !1; function read() { return x ? 'T' : 'F'; } var x = !0; return read(); }",
        ));
    // A conditional `var` that redeclares a parameter may leave the argument
    // value untouched, so the falsy initializer is not the only runtime value.
    it("export function f(x, c) { if (c) var x = false; return x ? 'T' : 'F'; }", () =>
        testSmallest(
            "export function f(x, c) { if (c) var x = false; return x ? 'T' : 'F'; }",
            "export function f(x, c) { if (c) var x = !1; return x ? 'T' : 'F'; }",
        ));
});

describe('redeclared_var_facts_are_disabled_before_first_use', () => {
    // A nested function is traversed before the later declaration. Semantic
    // redeclaration metadata must suppress the first declaration's constant
    // immediately; invalidating the slot on the second visit is too late.
    it("export function outer() { var x = false; function read() { return x ? 'ok' : 'fail'; } var x = true;", () =>
        testSmallest(
            "export function outer() { var x = false; function read() { return x ? 'ok' : 'fail'; } var x = true; return read(); }",
            "export function outer() { var x = !1; function read() { return x ? 'ok' : 'fail'; } var x = !0; return read(); }",
        ));
});

describe('redeclared_var_fact_invalidation_is_conservative', () => {
    // Both declarations execute in order, so folding to `2` would be sound.
    // Keep the conservative output until the fact cache can model declaration
    // positions without weakening the early-consumer protection above.
    it('export function f() { var x = 1; var x = 2; return () => x; }', () =>
        testSmallest(
            'export function f() { var x = 1; var x = 2; return () => x; }',
            'export function f() { var x = 1, x = 2; return () => x; }',
        ));
});

describe('redeclared_vars_are_not_assumed_fresh', () => {
    // The last declaration visited is fresh, but the other branch may alias an
    // external object with an observable setter.
    it('export function f(a, o) { if (a) var x = o; else var x = {}; x.p = 1; }', () =>
        testSmallest(
            'export function f(a, o) { if (a) var x = o; else var x = {}; x.p = 1; }',
            'export function f(a, o) { if (a) var x = o; else var x = {}; x.p = 1; }',
        ));
    // As with constants, a nested consumer may run after a later declaration
    // even though traversal sees it while the first declaration's fact is set.
    it('export function outer(o) { var x = {}; function write() { x.p = 1; } var x = o; write(); }', () =>
        testSmallest(
            'export function outer(o) { var x = {}; function write() { x.p = 1; } var x = o; write(); }',
            'export function outer(o) { var x = {}; function write() { x.p = 1; } var x = o; write(); }',
        ));
});

describe('conditional_labeled_var_declarator_not_inlined', () => {
    // A label introduces no scope, so the ancestry check must reject this
    // conditional body explicitly.
    it("function t(c) { if (c) L: var flag = true; return () => flag ? 'ng' : 'ok'; } NOOP(t());", () =>
        testSmallest(
            "function t(c) { if (c) L: var flag = true; return () => flag ? 'ng' : 'ok'; } NOOP(t());",
            "function t(c) { if (c) L: var flag = !0; return () => flag ? 'ng' : 'ok'; } NOOP(t());",
        ));
});

describe('unconditional_var_declarator_positions_still_inline', () => {
    const options = smallestOptions();
    // Unconditional declarators at the body top keep inlining.
    it("function t() { var flag = false; return () => flag ? 'a' : 'b'; } NOOP(t());", () =>
        testOptions(
            "function t() { var flag = false; return () => flag ? 'a' : 'b'; } NOOP(t());",
            "function t() { return () => 'b'; } NOOP(t());",
            options,
        ));
    // Direct declarations terminate at the module's ProgramBody ancestor.
    it("var flag = true; export function f() { return flag ? 'a' : 'b'; }", () =>
        testOptions(
            "var flag = true; export function f() { return flag ? 'a' : 'b'; }",
            "export function f() { return 'a'; }",
            options,
        ));
    // Export declarations add one transparent ancestry wrapper before the
    // module's ProgramBody ancestor.
    it("export var flag = true; export function f() { return flag ? 'a' : 'b'; }", () =>
        testOptions(
            "export var flag = true; export function f() { return flag ? 'a' : 'b'; }",
            "export var flag = !0; export function f() { return 'a'; }",
            options,
        ));
});

// https://github.com/oxc-project/oxc/issues/13051
describe('readonly_var', () => {
    // Top-level `var` with constant initializer, only read from inside a hoisted
    // function that is called after the declaration. Safe to inline because no
    // statement before the `var` can run code that reads it.
    it('var used = false; function test() { if (used) return 123; return 321; } log(test());', () =>
        testSmallest(
            'var used = false; function test() { if (used) return 123; return 321; } log(test());',
            'function test() { return 321; } log(test());',
        ));
    // Multiple readonly vars in a row — every preceding statement is itself a
    // safe `var = literal` so each one is inlineable in turn.
    it('var a = 1; var b = 2; function f() { return a + b; } log(f());', () =>
        testSmallest('var a = 1; var b = 2; function f() { return a + b; } log(f());', 'function f() { return 3; } log(f());'));
});

describe('readonly_var_unsafe_preceding_call', () => {
    // sapphi-red's case: a preceding call could invoke `output` before `foo` is
    // assigned. The read inside `output` would see `undefined`, so inlining
    // `foo` to `true` would change observable behavior — `foo` must stay.
    it("output(); var foo = true; function output() { if (!foo) log('foo'); }", () =>
        testSmallest(
            "output(); var foo = true; function output() { if (!foo) log('foo'); }",
            "output(); var foo = !0; function output() { foo || log('foo'); }",
        ));
});

describe('readonly_var_unsafe_preceding_read', () => {
    // A preceding statement reads the var before its initializer runs;
    // the read must observe `undefined`, not the constant.
    it('var y = foo; var foo = 1; log(y);', () =>
        testSmallest('var y = foo; var foo = 1; log(y);', 'var y = foo, foo = 1; log(y);'));
    // Canonical hoisting trap: the name is used directly before its own `var`
    // declaration, so the read sees the hoisted `undefined`. `console.log(a)`
    // must print `undefined`, never `0`. Doubly guarded — the read is in the
    // same call frame (does not cross a function boundary) and the preceding
    // call ends the declarative prelude.
    it('console.log(a); var a = 0;', () => testSmallest('console.log(a); var a = 0;', 'console.log(a); var a = 0;'));
});

describe('readonly_var_reassigned', () => {
    // `foo` has a write reference, so even though `var foo = 1;` is at the top,
    // inlining is unsafe.
    it('var foo = 1; foo = 2; log(foo);', () =>
        testSmallest('var foo = 1; foo = 2; log(foo);', 'var foo = 1; foo = 2, log(foo);'));
});

describe('readonly_var_reassigned_cross_function_read', () => {
    // The read crosses a function boundary (the gap this path targets), but
    // `foo` is also reassigned. The predicate's read-loop ignores writes, so it
    // relies on the downstream cached write-reference guard in
    // `inline_identifier_reference` to block inlining — substituting `1` would be
    // wrong once `foo = 2` runs before `f()` is called.
    it('var foo = 1; foo = 2; function f() { return foo; } log(f());', () =>
        testSmallest(
            'var foo = 1; foo = 2; function f() { return foo; } log(f());',
            'var foo = 1; foo = 2; function f() { return foo; } log(f());',
        ));
});

describe('readonly_var_reader_declared_before_var', () => {
    // Known limitation: when the reading function is declared *before* the var,
    // the symbol's constant isn't recorded until `exit_variable_declarator` —
    // after `f`'s body (and its `foo` reference) was already visited in source
    // order. The in-pass design can't reach back, so this otherwise-safe case is
    // conservatively left un-inlined. Asserted to make any future improvement a
    // conscious change rather than a silent one.
    it('function f() { return foo; } var foo = true; log(f());', () =>
        testSmallest(
            'function f() { return foo; } var foo = true; log(f());',
            'function f() { return foo; } var foo = !0; log(f());',
        ));
});

describe('readonly_var_with_imports_present', () => {
    // A circular importer can observe ANY module-private var our exported
    // functions/classes close over, regardless of export status. As long as the
    // module has any static import, skip program-scope inlining outright.
    // Non-exported var captured by an exported function — the cyclic-closure
    // hazard Codex flagged. Must NOT inline.
    it("import './b.js'; var flag = true; export function check() { return flag; }", () =>
        testSmallest(
            "import './b.js'; var flag = true; export function check() { return flag; }",
            "import './b.js'; var flag = !0; export function check() { return flag; }",
        ));
    // A write-once falsy `var` read only in boolean context (`if (DEBUG)`) folds
    // even with imports present: the cyclic-import hazard is that an observer sees
    // the hoisted `undefined` instead of the init value, but in boolean context
    // `undefined` and the falsy init are indistinguishable (`if (undefined)` ===
    // `if (false)`), and an importer cannot write the binding to make it truthy.
    // So `DEBUG` collapses and `log` becomes a no-op. (boolean_falsy, #14001)
    it("import './side-effect.js'; var DEBUG = false; function log(x) { if (DEBUG) console.log(x); } log('hi", () =>
        testSmallest(
            "import './side-effect.js'; var DEBUG = false; function log(x) { if (DEBUG) console.log(x); } log('hi');",
            "import './side-effect.js';",
        ));
    // Imports are hoisted, so an import appearing *after* the var in source
    // still triggers the gate — the pre-scan checks the whole body.
    it("var flag = true; import './b.js'; export function check() { return flag; }", () =>
        testSmallest(
            "var flag = true; import './b.js'; export function check() { return flag; }",
            "var flag = !0; import './b.js'; export function check() { return flag; }",
        ));
});

describe('readonly_var_with_reexports_present', () => {
    // `export * from` and `export { … } from` are module loaders too — they
    // evaluate foreign modules and create the same cyclic-eval hazard.
    it("export * from './other.js'; var flag = true; export function check() { return flag; }", () =>
        testSmallest(
            "export * from './other.js'; var flag = true; export function check() { return flag; }",
            "export * from './other.js'; var flag = !0; export function check() { return flag; }",
        ));
    it("export { y } from './y.js'; var flag = true; export function check() { return flag; }", () =>
        testSmallest(
            "export { y } from './y.js'; var flag = true; export function check() { return flag; }",
            "export { y } from './y.js'; var flag = !0; export function check() { return flag; }",
        ));
});

describe('readonly_var_through_declarative_exports', () => {
    // `export function …`, `export var <literal>`, `export { … }`, and
    // `export default function …` are declarative wrappers — no user code runs
    // at module init, so the body's declarative prelude continues through them
    // and a later var stays inlineable.
    it('export function helper() {} export var A = 1; var b = 2; function f() { return b; } log(f());', () =>
        testSmallest(
            'export function helper() {} export var A = 1; var b = 2; function f() { return b; } log(f());',
            'export function helper() {} export var A = 1; function f() { return 2; } log(f());',
        ));
    it('export default function helper() {} var b = 2; function f() { return b; } log(f());', () =>
        testSmallest(
            'export default function helper() {} var b = 2; function f() { return b; } log(f());',
            'export default function helper() {} function f() { return 2; } log(f());',
        ));
});

describe('readonly_var_export_default_expression_breaks_prelude', () => {
    // `export default <expr>` evaluates the expression at module init, which
    // can call user code. A later var must not inline.
    it('export default sideEffect(); var b = 2; function f() { return b; } log(f());', () =>
        testSmallest(
            'export default sideEffect(); var b = 2; function f() { return b; } log(f());',
            'export default sideEffect(); var b = 2; function f() { return b; } log(f());',
        ));
});

describe('readonly_var_unsafe_destructuring_default_prelude', () => {
    // A preceding destructuring var with a default-call evaluates the call
    // before `flag = true`. If `flag` were inlined inside `inner`, the call
    // would observe `true` instead of the required hoisted `undefined`.
    it("var [x = inner()] = ''; var flag = true; function inner() { return flag; } log(x);", () =>
        testSmallest(
            "var [x = inner()] = ''; var flag = true; function inner() { return flag; } log(x);",
            "var [x = inner()] = '', flag = !0; function inner() { return flag; } log(x);",
        ));
});

describe('readonly_var_in_function_body', () => {
    // #2: same declarative-prelude analysis, applied to function bodies. The
    // var sits at the function's body scope and is read from a nested function,
    // which substitute_single_use_symbol can't reach.
    it('function outer() { var flag = false; function inner() { return flag ? 1 : 2; } return inner(); } log', () =>
        testSmallest(
            'function outer() { var flag = false; function inner() { return flag ? 1 : 2; } return inner(); } log(outer());',
            'function outer() { function inner() { return 2; } return inner(); } log(outer());',
        ));
});

describe('readonly_var_in_function_body_unsafe_preceding_call', () => {
    // Same hoisting hazard as top-level: an observable call before the var
    // inside the function body could invoke a hoisted inner function that
    // reads `flag` as `undefined`. Skip.
    it('function outer() { sideEffect(); var flag = true; function inner() { return flag; } return inner(); ', () =>
        testSmallest(
            'function outer() { sideEffect(); var flag = true; function inner() { return flag; } return inner(); } log(outer());',
            'function outer() { sideEffect(); var flag = !0; function inner() { return flag; } return inner(); } log(outer());',
        ));
});

describe('readonly_var_script_mode', () => {
    // Top-level `var` in script mode creates a property on the global object;
    // another script can mutate it between this line and a later function call.
    // Don't inline.
    it('var used = false; function test() { if (used) return 123; return 321; } log(test());', () =>
        testOptions(
            'var used = false; function test() { if (used) return 123; return 321; } log(test());',
            'var used = !1; function test() { return used ? 123 : 321; } log(test());',
            smallestOptions(),
            'script',
        ));
});

describe('readonly_var_after_type_declaration', () => {
    // Type-only declarations (`type`, `interface`) are erased and run no code,
    // so they don't end the declarative prelude — a following readonly var
    // stays inlineable.
    // Skipped: shakeup's printer does not print TSTypeAliasDeclaration
    it.skip('type T = number; interface I {} var b = 2; function f() { return b; } log(f());', () =>
        testOptions(
            'type T = number; interface I {} var b = 2; function f() { return b; } log(f());',
            'type T = number; interface I {} function f() { return 2; } log(f());',
            smallestOptions(),
            'typescript',
        ));
});

// A write-once falsy `var` flag read only in boolean context folds even past a
// dirty declarative prelude — the bundled `var hydrating = false` shape read by
// `if (hydrating)` throughout a framework runtime (Svelte/Vue, #14001). The
// value-context constant is withheld for hoisting safety, but `undefined`
// (pre-init) and the falsy init are indistinguishable in boolean context.
describe('fold_writeonce_falsy_var_in_boolean_context', () => {
    // Multiple same-frame boolean reads.
    it('var h = false; if (h) a(); if (h) b()', () => testSmallest('var h = false; if (h) a(); if (h) b()', ''));
    // Read inside a function, past a side-effectful prelude (`g()` runs first):
    // the hoisting gate withholds value-context folding; boolean context is sound.
    it('g(); var h = false; function f() { if (h) a() } f()', () =>
        testSmallest('g(); var h = false; function f() { if (h) a() } f()', 'g();'));
    // Value context must NOT fold (a pre-init read would observe `undefined`).
    it('g(); var h = false; function f() { sink(h) } f()', () =>
        testSmallest('g(); var h = false; function f() { sink(h) } f()', 'g(); var h = !1; function f() { sink(h); } f();'));
    // Reassigned => not write-once => not folded.
    it('var h = false; h = 1; if (h) a()', () =>
        testSmallest('var h = false; h = 1; if (h) a()', 'var h = !1; h = 1, h && a();'));
    // Script mode: a top-level `var` is a global another script can reassign, so
    // an in-module write count of 0 doesn't prove write-once — not folded.
    it('var h = false; function f() { if (h) a() } f()', () =>
        testOptions(
            'var h = false; function f() { if (h) a() } f()',
            'var h = !1; function f() { h && a(); } f();',
            smallestOptions(),
            'script',
        ));
});

describe('r', () => {
    const options = smallestOptions();
    it('const foo = 1; log(foo)', () => testOptions('const foo = 1; log(foo)', 'log(1)', options));
    it('export const foo = 1; log(foo)', () =>
        testOptions('export const foo = 1; log(foo)', 'export const foo = 1; log(1)', options));
    it('let foo = 1; log(foo)', () => testOptions('let foo = 1; log(foo)', 'log(1)', options));
    it('export let foo = 1; log(foo)', () => testOptions('export let foo = 1; log(foo)', 'export let foo = 1; log(1)', options));
});

// https://github.com/oxc-project/oxc/issues/20282
// Dead code guarded by a condition that depends on a read-only `const` is
// eliminated even when the `const` is referenced more than once. The value is
// resolved through `SymbolValue` constant tracking during constant evaluation,
// not single-use inlining, so the old refcount==1 restriction no longer blocks
// it.
describe('dead_code_depending_on_const', () => {
    // Exact reproduction from the issue: `ENABLE_PKG` is always `false`, so the
    // guarded call and both now-unused declarations are removed.
    it("const MODE = 'production'; const ENABLE_PKG = MODE === 'foo' || MODE === 'bar'; if (ENABLE_PKG) { lo", () =>
        testSmallest(
            "const MODE = 'production';\n         const ENABLE_PKG = MODE === 'foo' || MODE === 'bar';\n         if (ENABLE_PKG) { longFunction() }",
            '',
        ));
    // Commenter's variant: `MODE` is read twice (in `ENABLE_PKG`'s initializer
    // and in the `if` test), yet the dead branch still folds away.
    it("const MODE = 'production'; const ENABLE_PKG = MODE === 'foo'; if (MODE !== 'production') { longFunct", () =>
        testSmallest(
            "const MODE = 'production';\n         const ENABLE_PKG = MODE === 'foo';\n         if (MODE !== 'production') { longFunction() }",
            '',
        ));
    // Negative case: a reassigned binding is not a constant, so the guard must
    // be preserved (no flow-sensitive last-write analysis here).
    it("let MODE = 'production'; MODE = 'dev'; if (MODE !== 'production') { longFunction() }", () =>
        testSmallest(
            "let MODE = 'production'; MODE = 'dev'; if (MODE !== 'production') { longFunction() }",
            "let MODE = 'production'; MODE = 'dev', MODE !== 'production' && longFunction();",
        ));
    // Negative case: a non-constant initializer leaves the guard intact (the
    // value is inlined, but the call is not eliminated).
    it("const MODE = globalThis.mode; if (MODE !== 'production') { longFunction() }", () =>
        testSmallest(
            "const MODE = globalThis.mode; if (MODE !== 'production') { longFunction() }",
            "globalThis.mode !== 'production' && longFunction();",
        ));
});

// https://github.com/rolldown/rolldown/issues/10174
// A never-assigned binding with no initializer reads as `undefined`, but the
// textual inline prints `void 0` — longer than a mangled identifier read plus
// its share of a declaration, and with no initializer there is nothing whose
// removal pays for it. Keep the read; constant-driven folds still see the
// value through `SymbolValue` tracking.
describe('keep_value_context_read_of_uninitialized_binding', () => {
    const options = smallestOptions();
    // The exact rolldown#10174 shape: a value-context assignment read.
    it('let undefinedVar; export let value; export function reset() { value = undefinedVar; }', () =>
        testOptions(
            'let undefinedVar; export let value; export function reset() { value = undefinedVar; }',
            'let undefinedVar; export let value; export function reset() { value = undefinedVar; }',
            options,
        ));
    // Multi-read value context.
    it('let u; export function f() { g(u), g(u); }', () =>
        testOptions('let u; export function f() { g(u), g(u); }', 'let u; export function f() { g(u), g(u); }', options));
    // Near-misses: folds that consume the value must keep working without the
    // textual inline — evaluation resolves the read through `SymbolValue`.
    it('let u; export function f() { return u; }', () =>
        testOptions('let u; export function f() { return u; }', 'export function f() {}', options));
    it('let u; export function f() { if (u) g(); }', () =>
        testOptions('let u; export function f() { if (u) g(); }', 'export function f() {}', options));
    it('let u; export function f() { return u === void 0; }', () =>
        testOptions('let u; export function f() { return u === void 0; }', 'export function f() { return !0; }', options));
    // Near-miss: an explicit `undefined` initializer still inlines — the inline
    // eliminates the `= void 0` initializer text along with the declaration.
    it('const foo = undefined; export function f() { g(foo); }', () =>
        testOptions('const foo = undefined; export function f() { g(foo); }', 'export function f() { g(void 0); }', options));
});

describe('small_value', () => {
    const options = smallestOptions();
    it('const foo = 999; log(foo), log(foo)', () =>
        testOptions('const foo = 999; log(foo), log(foo)', 'log(999), log(999)', options));
    it('const foo = -99; log(foo), log(foo)', () =>
        testOptions('const foo = -99; log(foo), log(foo)', 'log(-99), log(-99)', options));
    it('const foo = 1000; log(foo), log(foo)', () => testSameOptions('const foo = 1000; log(foo), log(foo)', options));
    it('const foo = -100; log(foo), log(foo)', () => testSameOptions('const foo = -100; log(foo), log(foo)', options));
    it('const foo = 0n; log(foo), log(foo)', () => testSameOptions('const foo = 0n; log(foo), log(foo)', options));
    it("const foo = 'aaa'; log(foo), log(foo)", () =>
        testOptions("const foo = 'aaa'; log(foo), log(foo)", "log('aaa'), log('aaa')", options));
    it("const foo = 'aaaa'; log(foo), log(foo)", () => testSameOptions("const foo = 'aaaa'; log(foo), log(foo)", options));
    it('const foo = true; log(foo), log(foo)', () =>
        testOptions('const foo = true; log(foo), log(foo)', 'log(!0), log(!0)', options));
    it('const foo = false; log(foo), log(foo)', () =>
        testOptions('const foo = false; log(foo), log(foo)', 'log(!1), log(!1)', options));
    it('const foo = undefined; log(foo), log(foo)', () =>
        testOptions('const foo = undefined; log(foo), log(foo)', 'log(void 0), log(void 0)', options));
    it('const foo = null; log(foo), log(foo)', () =>
        testOptions('const foo = null; log(foo), log(foo)', 'log(null), log(null)', options));
    it("const o = 'o'; const d = 'd'; const boolean = false; var frag = `<p autocapitalize=\"${`w${o}r${d}s`}", () =>
        testOptions(
            '\n        const o = \'o\';\n        const d = \'d\';\n        const boolean = false;\n        var frag = `<p autocapitalize="${`w${o}r${d}s`}" contenteditable="${boolean}"/>`;\n        console.log(frag);\n        ',
            'console.log(\'<p autocapitalize="words" contenteditable="false"/>\');',
            options,
        ));
});
