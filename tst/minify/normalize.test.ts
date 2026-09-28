// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are JS source under test.
// Ported from oxc_minifier/tests/peephole/normalize.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { type CompressOptions, smallestOptions } from '../../src/passes/minifier/options.ts';
import { defaultOptions, test, testOptions, testSame } from './harness.ts';

describe('test_while', () => {
    // Verify while loops are converted to FOR loops.
    it('while(c < b) foo()', () => test('while(c < b) foo()', 'for(; c < b;) foo()'));
});

describe('test_const_to_let', () => {
    it('const x = 1', () => testSame('const x = 1'));
    // keep top-level (can be replaced with "let" if it's ESM and not exported)
    it('{ const x = 1 }', () => test('{ const x = 1 }', '{ let x = 1 }'));
    it('{ const x = 1; x = 2 }', () => testSame('{ const x = 1; x = 2 }'));
    // keep assign error
    it("{ const x = 1; eval('x = 2') }", () => testSame("{ const x = 1; eval('x = 2') }"));
    // keep assign error
    it('{ const x = 1, y = 2 }', () => test('{ const x = 1, y = 2 }', '{ let x = 1, y = 2 }'));
    it('{ const { x } = { x: 1 } }', () => test('{ const { x } = { x: 1 } }', '{ let { x } = { x: 1 } }'));
    it('{ const [x] = [1] }', () => test('{ const [x] = [1] }', '{ let [x] = [1] }'));
    it('{ const [x = 1] = [] }', () => test('{ const [x = 1] = [] }', '{ let [x = 1] = [] }'));
    it('for (const x in y);', () => test('for (const x in y);', 'for (let x in y);'));
    // TypeError: Assignment to constant variable.
    it('for (const i = 0; i < 1; i++);', () => testSame('for (const i = 0; i < 1; i++);'));
    it('{ const { a, ...b } = foo; b = 123; }', () => testSame('{ const { a, ...b } = foo; b = 123; }'));
    it('{ const [a, ...b] = foo; b = 123; }', () => testSame('{ const [a, ...b] = foo; b = 123; }'));
    it('for (const x in [1, 2, 3]) x++', () => testSame('for (const x in [1, 2, 3]) x++'));
    it('for (const x of [1, 2, 3]) x++', () => testSame('for (const x of [1, 2, 3]) x++'));
    it('{ let foo; const bar = undefined; }', () => test('{ let foo; const bar = undefined; }', '{ let foo, bar; }'));
});

describe('test_void_ident', () => {
    it('var x; void x', () => test('var x; void x', 'var x'));
    it('void x', () => test('void x', 'x'));
    // reference error
});

// Leak regression: Normalize runs before the peephole fixed-point loop, but
// `PassChanges` is live from `MinifierState::new`, so Normalize's typed-helper
// drops are recorded like any pass's and consumed by
// `finish_normalize_pass`. A leaked read makes `x` look referenced, blocking
// unused-declaration removal.
describe('test_void_ident_does_not_leak_reference', () => {
    const options = smallestOptions();
    it('let x = 1; void x; console.log(2);', () => testOptions('let x = 1; void x; console.log(2);', 'console.log(2);', options));
});

describe('parens', () => {
    it('(((x)))', () => test('(((x)))', 'x'));
    it('(((a + b))) * c', () => test('(((a + b))) * c', '(a + b) * c'));
});

describe('drop_console', () => {
    const options: CompressOptions = { ...defaultOptions(), dropConsole: true };
    it('console.log()', () => testOptions('console.log()', '', options));
    it('(() => console.log())()', () => testOptions('(() => console.log())()', '', options));
    // After `console.log()` is dropped the IIFE body is side-effect-free, so
    // the whole dead call is removed. An empty result still proves the
    // return-position `console.*` call was dropped (otherwise the call would
    // keep the IIFE alive).
    it('(() => { try { return console.log() } catch {} })()', () =>
        testOptions('(() => { try { return console.log() } catch {} })()', '', options));
});

// Same leak class as `test_void_ident_does_not_leak_reference`: dropped
// `console.*` calls (statement position and expression position) contain
// argument subtrees whose resolved references must be deleted from scoping.
describe('drop_console_does_not_leak_references', () => {
    const options: CompressOptions = { ...smallestOptions(), dropConsole: true };
    // Statement position.
    it('let x = 1; console.log(x); foo(2);', () => testOptions('let x = 1; console.log(x); foo(2);', 'foo(2);', options));
    // Expression position: the call is replaced with `void 0`.
    it('let x = 1; foo(console.log(x));', () => testOptions('let x = 1; foo(console.log(x));', 'foo(void 0);', options));
});

describe('drop_debugger', () => {
    const options: CompressOptions = { ...defaultOptions(), dropDebugger: true };
    it('debugger', () => testOptions('debugger', '', options));
});

describe('fold_number_nan', () => {
    it('foo(Number.NaN)', () => test('foo(Number.NaN)', 'foo(NaN)'));
    it('var Number; foo(Number.NaN)', () => testSame('var Number; foo(Number.NaN)'));
    it('let Number; foo((void 0).NaN)', () => testSame('let Number; foo((void 0).NaN)'));
});

describe('pure_constructors', () => {
    it('new AggregateError', () => test('new AggregateError', 'AggregateError()'));
    it('new ArrayBuffer', () => test('new ArrayBuffer', ''));
    it('new Boolean', () => test('new Boolean', ''));
    it('new DataView', () => test('new DataView', 'new DataView()'));
    it('new Date', () => test('new Date', ''));
    it('new Error', () => test('new Error', ''));
    it('new EvalError', () => test('new EvalError', ''));
    it('new Map', () => test('new Map', ''));
    it('new Number', () => test('new Number', ''));
    it('new Object', () => test('new Object', ''));
    it('new RangeError', () => test('new RangeError', ''));
    it('new ReferenceError', () => test('new ReferenceError', ''));
    // RegExp with no arguments is valid (returns /(?:)/) and can be removed
    it('new RegExp', () => test('new RegExp', ''));
    it('new Set', () => test('new Set', ''));
    it('new String', () => test('new String', ''));
    it('new SyntaxError', () => test('new SyntaxError', ''));
    it('new TypeError', () => test('new TypeError', ''));
    it('new URIError', () => test('new URIError', ''));
    it('new WeakMap', () => test('new WeakMap', ''));
    it('new WeakSet', () => test('new WeakSet', ''));
    it('new AggregateError(null)', () => test('new AggregateError(null)', 'AggregateError(null)'));
    it('new ArrayBuffer(null)', () => test('new ArrayBuffer(null)', ''));
    it('new Boolean(null)', () => test('new Boolean(null)', ''));
    it('new DataView(null)', () => testSame('new DataView(null)'));
    it('new Date(null)', () => test('new Date(null)', ''));
    it('new Error(null)', () => test('new Error(null)', ''));
    it('new EvalError(null)', () => test('new EvalError(null)', ''));
    it('new Map(null)', () => test('new Map(null)', ''));
    it('new Number(null)', () => test('new Number(null)', ''));
    it('new Object(null)', () => test('new Object(null)', ''));
    it('new RangeError(null)', () => test('new RangeError(null)', ''));
    it('new ReferenceError(null)', () => test('new ReferenceError(null)', ''));
    // null is not a string literal, can't statically validate
    it('new RegExp(null)', () => test('new RegExp(null)', 'RegExp(null)'));
    it('new Set(null)', () => test('new Set(null)', ''));
    it('new String(null)', () => test('new String(null)', ''));
    it('new SyntaxError(null)', () => test('new SyntaxError(null)', ''));
    it('new TypeError(null)', () => test('new TypeError(null)', ''));
    it('new URIError(null)', () => test('new URIError(null)', ''));
    it('new WeakMap(null)', () => test('new WeakMap(null)', ''));
    it('new WeakSet(null)', () => test('new WeakSet(null)', ''));
    it('new AggregateError(undefined)', () => test('new AggregateError(undefined)', 'AggregateError(void 0)'));
    it('new ArrayBuffer(undefined)', () => test('new ArrayBuffer(undefined)', ''));
    it('new Boolean(undefined)', () => test('new Boolean(undefined)', ''));
    it('new DataView(void 0)', () => testSame('new DataView(void 0)'));
    it('new Date(undefined)', () => test('new Date(undefined)', ''));
    it('new Error(undefined)', () => test('new Error(undefined)', ''));
    it('new EvalError(undefined)', () => test('new EvalError(undefined)', ''));
    it('new Map(undefined)', () => test('new Map(undefined)', ''));
    it('new Number(undefined)', () => test('new Number(undefined)', ''));
    it('new Object(undefined)', () => test('new Object(undefined)', ''));
    it('new RangeError(undefined)', () => test('new RangeError(undefined)', ''));
    it('new ReferenceError(undefined)', () => test('new ReferenceError(undefined)', ''));
    // undefined is not a string literal, can't statically validate
    it('new RegExp(undefined)', () => test('new RegExp(undefined)', 'RegExp(void 0)'));
    it('new Set(undefined)', () => test('new Set(undefined)', ''));
    it('new String(undefined)', () => test('new String(undefined)', ''));
    it('new SyntaxError(undefined)', () => test('new SyntaxError(undefined)', ''));
    it('new TypeError(undefined)', () => test('new TypeError(undefined)', ''));
    it('new URIError(undefined)', () => test('new URIError(undefined)', ''));
    it('new WeakMap(undefined)', () => test('new WeakMap(undefined)', ''));
    it('new WeakSet(undefined)', () => test('new WeakSet(undefined)', ''));
    it('new AggregateError(0)', () => test('new AggregateError(0)', 'AggregateError(0)'));
    it('new ArrayBuffer(0)', () => test('new ArrayBuffer(0)', ''));
    it('new Boolean(0)', () => test('new Boolean(0)', ''));
    it('new DataView(0)', () => testSame('new DataView(0)'));
    it('new Date(0)', () => test('new Date(0)', ''));
    it('new Error(0)', () => test('new Error(0)', ''));
    it('new EvalError(0)', () => test('new EvalError(0)', ''));
    it('new Map(0)', () => testSame('new Map(0)'));
    it('new Number(0)', () => test('new Number(0)', ''));
    it('new Object(0)', () => test('new Object(0)', ''));
    it('new RangeError(0)', () => test('new RangeError(0)', ''));
    it('new ReferenceError(0)', () => test('new ReferenceError(0)', ''));
    // 0 is not a string literal, can't statically validate
    it('new RegExp(0)', () => test('new RegExp(0)', 'RegExp(0)'));
    it('new Set(0)', () => testSame('new Set(0)'));
    it('new String(0)', () => test('new String(0)', ''));
    it('new SyntaxError(0)', () => test('new SyntaxError(0)', ''));
    it('new TypeError(0)', () => test('new TypeError(0)', ''));
    it('new URIError(0)', () => test('new URIError(0)', ''));
    it('new WeakMap(0)', () => testSame('new WeakMap(0)'));
    it('new WeakSet(0)', () => testSame('new WeakSet(0)'));
    it('new AggregateError(10n)', () => test('new AggregateError(10n)', 'AggregateError(10n)'));
    it('new ArrayBuffer(10n)', () => testSame('new ArrayBuffer(10n)'));
    it('new Boolean(10n)', () => test('new Boolean(10n)', ''));
    it('new DataView(10n)', () => testSame('new DataView(10n)'));
    it('new Date(10n)', () => testSame('new Date(10n)'));
    it('new Error(10n)', () => test('new Error(10n)', ''));
    it('new EvalError(10n)', () => test('new EvalError(10n)', ''));
    it('new Map(10n)', () => testSame('new Map(10n)'));
    it('new Number(10n)', () => test('new Number(10n)', ''));
    it('new Object(10n)', () => test('new Object(10n)', ''));
    it('new RangeError(10n)', () => test('new RangeError(10n)', ''));
    it('new ReferenceError(10n)', () => test('new ReferenceError(10n)', ''));
    // 10n is not a string literal, can't statically validate
    it('new RegExp(10n)', () => test('new RegExp(10n)', 'RegExp(10n)'));
    it('new Set(10n)', () => testSame('new Set(10n)'));
    it('new String(10n)', () => test('new String(10n)', ''));
    it('new SyntaxError(10n)', () => test('new SyntaxError(10n)', ''));
    it('new TypeError(10n)', () => test('new TypeError(10n)', ''));
    it('new URIError(10n)', () => test('new URIError(10n)', ''));
    it('new WeakMap(10n)', () => testSame('new WeakMap(10n)'));
    it('new WeakSet(10n)', () => testSame('new WeakSet(10n)'));
    it("new AggregateError('')", () => test("new AggregateError('')", ''));
    it("new ArrayBuffer('')", () => test("new ArrayBuffer('')", ''));
    it("new Boolean('')", () => test("new Boolean('')", ''));
    it("new DataView('')", () => testSame("new DataView('')"));
    it("new Date('')", () => test("new Date('')", ''));
    it("new Error('')", () => test("new Error('')", ''));
    it("new EvalError('')", () => test("new EvalError('')", ''));
    it("new Map('')", () => test("new Map('')", ''));
    it("new Number('')", () => test("new Number('')", ''));
    it("new Object('')", () => test("new Object('')", ''));
    it("new RangeError('')", () => test("new RangeError('')", ''));
    it("new ReferenceError('')", () => test("new ReferenceError('')", ''));
    // Empty string is a valid pattern (matches everything)
    it("new RegExp('')", () => test("new RegExp('')", ''));
    it("new Set('')", () => test("new Set('')", ''));
    it("new String('')", () => test("new String('')", ''));
    it("new SyntaxError('')", () => test("new SyntaxError('')", ''));
    it("new TypeError('')", () => test("new TypeError('')", ''));
    it("new URIError('')", () => test("new URIError('')", ''));
    it("new WeakMap('')", () => test("new WeakMap('')", ''));
    it("new WeakSet('')", () => test("new WeakSet('')", ''));
    it('new AggregateError(!0)', () => test('new AggregateError(!0)', 'AggregateError(!0)'));
    it('new ArrayBuffer(!0)', () => test('new ArrayBuffer(!0)', ''));
    it('new Boolean(!0)', () => test('new Boolean(!0)', ''));
    it('new DataView(!0)', () => testSame('new DataView(!0)'));
    it('new Date(!0)', () => test('new Date(!0)', ''));
    it('new Error(!0)', () => test('new Error(!0)', ''));
    it('new EvalError(!0)', () => test('new EvalError(!0)', ''));
    it('new Map(!0)', () => testSame('new Map(!0)'));
    it('new Number(!0)', () => test('new Number(!0)', ''));
    it('new Object(!0)', () => test('new Object(!0)', ''));
    it('new RangeError(!0)', () => test('new RangeError(!0)', ''));
    it('new ReferenceError(!0)', () => test('new ReferenceError(!0)', ''));
    // !0 is not a string literal, can't statically validate
    it('new RegExp(!0)', () => test('new RegExp(!0)', 'RegExp(!0)'));
    it('new Set(!0)', () => testSame('new Set(!0)'));
    it('new String(!0)', () => test('new String(!0)', ''));
    it('new SyntaxError(!0)', () => test('new SyntaxError(!0)', ''));
    it('new TypeError(!0)', () => test('new TypeError(!0)', ''));
    it('new URIError(!0)', () => test('new URIError(!0)', ''));
    it('new WeakMap(!0)', () => testSame('new WeakMap(!0)'));
    it('new WeakSet(!0)', () => testSame('new WeakSet(!0)'));
    it('new AggregateError([])', () => test('new AggregateError([])', ''));
    it('new ArrayBuffer([])', () => test('new ArrayBuffer([])', ''));
    it('new Boolean([])', () => test('new Boolean([])', ''));
    it('new DataView([])', () => testSame('new DataView([])'));
    it('new Date([])', () => test('new Date([])', ''));
    it('new Error([])', () => test('new Error([])', ''));
    it('new EvalError([])', () => test('new EvalError([])', ''));
    it('new Map([])', () => test('new Map([])', ''));
    it('new Number([])', () => test('new Number([])', ''));
    it('new Object([])', () => test('new Object([])', ''));
    it('new RangeError([])', () => test('new RangeError([])', ''));
    it('new ReferenceError([])', () => test('new ReferenceError([])', ''));
    // Array arguments are object type, so conversion doesn't happen
    it('new RegExp([])', () => testSame('new RegExp([])'));
    it('new Set([])', () => test('new Set([])', ''));
    it('new String([])', () => test('new String([])', ''));
    it('new SyntaxError([])', () => test('new SyntaxError([])', ''));
    it('new TypeError([])', () => test('new TypeError([])', ''));
    it('new URIError([])', () => test('new URIError([])', ''));
    it('new WeakMap([])', () => test('new WeakMap([])', ''));
    it('new WeakSet([])', () => test('new WeakSet([])', ''));
    it('new AggregateError(a)', () => test('new AggregateError(a)', 'AggregateError(a)'));
    it('new ArrayBuffer(a)', () => testSame('new ArrayBuffer(a)'));
    it('new Boolean(a)', () => testSame('new Boolean(a)'));
    it('new DataView(a)', () => testSame('new DataView(a)'));
    it('new Date(a)', () => testSame('new Date(a)'));
    it('new Error(a)', () => test('new Error(a)', 'Error(a)'));
    it('new EvalError(a)', () => test('new EvalError(a)', 'EvalError(a)'));
    it('new Map(a)', () => testSame('new Map(a)'));
    it('new Number(a)', () => testSame('new Number(a)'));
    it('new Object(a)', () => testSame('new Object(a)'));
    it('new RangeError(a)', () => test('new RangeError(a)', 'RangeError(a)'));
    it('new ReferenceError(a)', () => test('new ReferenceError(a)', 'ReferenceError(a)'));
    it('new RegExp(a)', () => testSame('new RegExp(a)'));
    it('new Set(a)', () => testSame('new Set(a)'));
    it('new String(a)', () => testSame('new String(a)'));
    it('new SyntaxError(a)', () => test('new SyntaxError(a)', 'SyntaxError(a)'));
    it('new TypeError(a)', () => test('new TypeError(a)', 'TypeError(a)'));
    it('new URIError(a)', () => test('new URIError(a)', 'URIError(a)'));
    it('new WeakMap(a)', () => testSame('new WeakMap(a)'));
    it('new WeakSet(a)', () => testSame('new WeakSet(a)'));
});

describe('remove_unused_use_strict_directive', () => {
    const options = defaultOptions();
    const sourceType = 'commonjs';
    it("'use strict'; function _() { 'use strict' }", () =>
        testOptions("'use strict'; function _() { 'use strict' }", "'use strict'; function _() {  }", options, sourceType));
    it("function _() { 'use strict'; function __() { 'use strict' } }", () =>
        testOptions(
            "function _() { 'use strict'; function __() { 'use strict' } }",
            "function _() { 'use strict'; function __() { } }",
            options,
            sourceType,
        ));
    it("'use strict'; function _() { 'use strict' }", () =>
        test("'use strict'; function _() { 'use strict' }", 'function _() {}'));
    it("'use strict';", () => test("'use strict';", ''));
});

// Legal comments anchored to a removed `"use strict"` directive are rescued
// by the same preserved-comment orphan flush used for #19750: the
// directive's `span.start` is gone, but the orphan re-anchors at the next
// surviving statement. Pin that for the legal-comment subset of #19748.
// Normal comments above a removed directive are not covered; only comments
// with file-level meaning are preserved when their anchor is removed.

describe('preserve_legal_comment_above_removed_use_strict', () => {
    // Both `//!` and `/*! ... */` forms.
    it("//! license 'use strict'; export function foo(){}", () =>
        test("//! license\n'use strict';\nexport function foo(){}", '//! license\nexport function foo() {}'));
    it("/*! banner */ 'use strict'; export function foo(){}", () =>
        test("/*! banner */\n'use strict';\nexport function foo(){}", '/*! banner */\nexport function foo() {}'));
});

describe('preserve_legal_comment_above_removed_inner_function_use_strict', () => {
    // Redundant inner `"use strict"` is dropped under a strict outer scope;
    // the comment must stay inside the function body, not escape outward.
    it("//! outer 'use strict'; export function f() { //! inner 'use strict'; bar(); }", () =>
        test(
            "//! outer\n'use strict';\nexport function f() {\n  //! inner\n  'use strict';\n  bar();\n}",
            '//! outer\nexport function f() {\n\t//! inner\n\tbar();\n}',
        ));
});
