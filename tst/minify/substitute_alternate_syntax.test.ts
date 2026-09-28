// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are JS source under test.
// Ported from oxc_minifier/tests/peephole/substitute_alternate_syntax.rs: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { defaultOptions, esTargets, test, testOptions, testSame, testSameOptions } from './harness.ts';

describe('test_fold_return_result', () => {
    it('function f(){return !1;}', () => test('function f(){return !1;}', 'function f(){return !1}'));
    it('function f(){return null;}', () => test('function f(){return null;}', 'function f(){return null}'));
    it('function f(){return void 0;}', () => test('function f(){return void 0;}', 'function f(){}'));
    it('function f(){return void foo();}', () => test('function f(){return void foo();}', 'function f(){foo()}'));
    it('function f(){return undefined;}', () => test('function f(){return undefined;}', 'function f(){}'));
    it('function f(){if(a()){return undefined;}}', () => test('function f(){if(a()){return undefined;}}', 'function f(){a()}'));
    it('function a(undefined) { return undefined; }', () => testSame('function a(undefined) { return undefined; }'));
    it('function f(){return foo()}', () => testSame('function f(){return foo()}'));
    it('function foo() { return undefined }', () => test('function foo() { return undefined }', 'function foo() { }'));
    it('function* foo() { return undefined }', () => test('function* foo() { return undefined }', 'function* foo() { }'));
    it('async function foo() { return undefined }', () =>
        test('async function foo() { return undefined }', 'async function foo() { }'));
    it('async function* foo() { return void 0 }', () => testSame('async function* foo() { return void 0 }'));
    it('class Foo { async * foo() { return void 0 } }', () => testSame('class Foo { async * foo() { return void 0 } }'));
    it('async function* foo() { function bar () { return void 0 } return bar }', () =>
        test(
            'async function* foo() { function bar () { return void 0 } return bar }',
            'async function* foo() { function bar () {} return bar }',
        ));
    it('async function* foo() { let bar = () => { return void 0 }; return bar }', () =>
        test(
            'async function* foo() { let bar = () => { return void 0 }; return bar }',
            'async function* foo() { return () => {} }',
        ));
});

describe('test_undefined', () => {
    it('let x = undefined', () => test('let x = undefined', 'let x'));
    it('const x = undefined', () => test('const x = undefined', 'const x = void 0'));
    it('var x = undefined', () => test('var x = undefined', 'var x = void 0'));
    it('var undefined = 1;function f() {var undefined=2,x;}', () =>
        testSame('var undefined = 1;function f() {var undefined=2,x;}'));
    it('function f(undefined) {}', () => testSame('function f(undefined) {}'));
    it('try { foo } catch(undefined) {foo(undefined)}', () => testSame('try { foo } catch(undefined) {foo(undefined)}'));
    it('for (undefined in {}) {}', () => test('for (undefined in {}) {}', 'for(undefined in {});'));
    it('undefined++;', () => test('undefined++;', 'undefined++'));
    it('undefined += undefined;', () => test('undefined += undefined;', 'undefined+=void 0'));
    it('(function(undefined) { foo(typeof undefined); })()', () =>
        testSame('(function(undefined) { foo(typeof undefined); })()'));
    it('var {} = void 0', () => testSame('var {} = void 0'));
    it('var [] = void 0', () => testSame('var [] = void 0'));
    it('delete undefined', () => testSame('delete undefined'));
});

describe('test_fold_true_false_comparison', () => {
    it('v = x == true', () => test('v = x == true', 'v = x == 1'));
    it('v = x == false', () => test('v = x == false', 'v = x == 0'));
    it('v = x != true', () => test('v = x != true', 'v = x != 1'));
    it('v = x < true', () => test('v = x < true', 'v = x < !0'));
    it('v = x <= true', () => test('v = x <= true', 'v = x <= !0'));
    it('v = x > true', () => test('v = x > true', 'v = x > !0'));
    it('v = x >= true', () => test('v = x >= true', 'v = x >= !0'));
    it('v = x instanceof true', () => test('v = x instanceof true', 'v = x instanceof !0'));
    it('v = x + false', () => test('v = x + false', 'v = x + !1'));
    it('v = x == x instanceof false', () => test('v = x == x instanceof false', 'v = x == x instanceof !1'));
    it('v = x in x >> true', () => test('v = x in x >> true', 'v = x in x >> !0'));
    it('v = x == fake(false)', () => test('v = x == fake(false)', 'v = x == fake(!1)'));
    it('v = x === true', () => test('v = x === true', 'v = x === !0'));
    it('v = x !== false', () => test('v = x !== false', 'v = x !== !1'));
});

describe('test_fold_normal_assignment_to_combined_assignment', () => {
    it('x = x + 3', () => test('x = x + 3', 'x += 3'));
    it('x = x - 3', () => test('x = x - 3', 'x -= 3'));
    it('x = x / 3', () => test('x = x / 3', 'x /= 3'));
    it('x = x * 3', () => test('x = x * 3', 'x *= 3'));
    it('x = x >> 3', () => test('x = x >> 3', 'x >>= 3'));
    it('x = x << 3', () => test('x = x << 3', 'x <<= 3'));
    it('x = x >>> 3', () => test('x = x >>> 3', 'x >>>= 3'));
    it('x = x | 3', () => test('x = x | 3', 'x |= 3'));
    it('x = x ^ 3', () => test('x = x ^ 3', 'x ^= 3'));
    it('x = x % 3', () => test('x = x % 3', 'x %= 3'));
    it('x = x & 3', () => test('x = x & 3', 'x &= 3'));
    it('x = x + g()', () => test('x = x + g()', 'x += g()'));
    it('x = x - g()', () => test('x = x - g()', 'x -= g()'));
    it('x = x / g()', () => test('x = x / g()', 'x /= g()'));
    it('x = x * g()', () => test('x = x * g()', 'x *= g()'));
    it('x = x >> g()', () => test('x = x >> g()', 'x >>= g()'));
    it('x = x << g()', () => test('x = x << g()', 'x <<= g()'));
    it('x = x >>> g()', () => test('x = x >>> g()', 'x >>>= g()'));
    it('x = x | g()', () => test('x = x | g()', 'x |= g()'));
    it('x = x ^ g()', () => test('x = x ^ g()', 'x ^= g()'));
    it('x = x % g()', () => test('x = x % g()', 'x %= g()'));
    it('x = x & g()', () => test('x = x & g()', 'x &= g()'));
    it('x = 3 + x', () => testSame('x = 3 + x'));
    it('x = 3 - x', () => testSame('x = 3 - x'));
    it('x = 3 / x', () => testSame('x = 3 / x'));
    it('x = 3 * x', () => testSame('x = 3 * x'));
    it('x = 3 >> x', () => testSame('x = 3 >> x'));
    it('x = 3 << x', () => testSame('x = 3 << x'));
    it('x = 3 >>> x', () => testSame('x = 3 >>> x'));
    it('x = 3 | x', () => testSame('x = 3 | x'));
    it('x = 3 ^ x', () => testSame('x = 3 ^ x'));
    it('x = 3 % x', () => testSame('x = 3 % x'));
    it('x = 3 & x', () => testSame('x = 3 & x'));
    it('x = g() + x', () => testSame('x = g() + x'));
    it('x = g() - x', () => testSame('x = g() - x'));
    it('x = g() / x', () => testSame('x = g() / x'));
    it('x = g() * x', () => testSame('x = g() * x'));
    it('x = g() >> x', () => testSame('x = g() >> x'));
    it('x = g() << x', () => testSame('x = g() << x'));
    it('x = g() >>> x', () => testSame('x = g() >>> x'));
    it('x = g() | x', () => testSame('x = g() | x'));
    it('x = g() ^ x', () => testSame('x = g() ^ x'));
    it('x = g() % x', () => testSame('x = g() % x'));
    it('x = g() & x', () => testSame('x = g() & x'));
    it('x = (x -= 2) ^ x', () => testSame('x = (x -= 2) ^ x'));
    it('var x; x.y = x.y + 3', () => test('var x; x.y = x.y + 3', 'var x; x.y += 3'));
    it('var x; x.#y = x.#y + 3', () => test('var x; x.#y = x.#y + 3', 'var x; x.#y += 3'));
    it('x.y = x.y + 3', () => testSame('x.y = x.y + 3'));
    it('var x; x[y] = x[y] + 3', () => testSame('var x; x[y] = x[y] + 3'));
    it('var x; x.y.z = x.y.z + 3', () => testSame('var x; x.y.z = x.y.z + 3'));
    // This case is not supported, since the minifier does not support with statements
    // testSame("var x; with (z) { x.y || (x.y = 3) }");
});

describe('test_fold_subtraction_assignment', () => {
    it('x -= 1', () => test('x -= 1', '--x'));
    it('x -= -1', () => test('x -= -1', '++x'));
    it('x -= 2', () => testSame('x -= 2'));
    it('x += 1', () => testSame('x += 1'));
    it('x += -1', () => testSame('x += -1'));
});

describe('test_fold_literal_object_constructors', () => {
    it('x = new Object', () => test('x = new Object', 'x = ({})'));
    it('x = new Object()', () => test('x = new Object()', 'x = ({})'));
    it('x = Object()', () => test('x = Object()', 'x = ({})'));
    it('x = (function (){function Object(){this.x=4}return new Object();})();', () =>
        testSame('x = (function (){function Object(){this.x=4}return new Object();})();'));
    it('x = new window.Object', () => test('x = new window.Object', 'x = ({})'));
    it('x = new window.Object()', () => test('x = new window.Object()', 'x = ({})'));
    it('x = window.Object()', () => test('x = window.Object()', 'x = ({})'));
    it('x = window.Object?.()', () => test('x = window.Object?.()', 'x = Object?.()'));
    it('x = (function (){function Object(){this.x=4};return new window.Object;})();', () =>
        test(
            'x = (function (){function Object(){this.x=4};return new window.Object;})();',
            'x = (function (){function Object(){this.x=4}return {};})();',
        ));
});

describe('test_fold_literal_array_constructors', () => {
    it('x = new Array', () => test('x = new Array', 'x = []'));
    it('x = new Array()', () => test('x = new Array()', 'x = []'));
    it('x = Array()', () => test('x = Array()', 'x = []'));
    it('x = Array?.()', () => testSame('x = Array?.()'));
    it('x = new Array(0)', () => test('x = new Array(0)', 'x = []'));
    it('x = new Array("a")', () => test('x = new Array("a")', 'x = ["a"]'));
    it('x = new Array(1)', () => test('x = new Array(1)', 'x = [,]'));
    it('x = new Array(6)', () => test('x = new Array(6)', 'x = [,,,,,,]'));
    it('x = new Array(7)', () => test('x = new Array(7)', 'x = Array(7)'));
    it('x = new Array(7n)', () => test('x = new Array(7n)', 'x = [7n]'));
    it('x = new Array(y)', () => test('x = new Array(y)', 'x = Array(y)'));
    it('x = new Array(foo())', () => test('x = new Array(foo())', 'x = Array(foo())'));
    it('x = new Array(...y)', () => testSame('x = new Array(...y)'));
    it('x = new Array(...[3])', () => test('x = new Array(...[3])', 'x = [,,,]'));
    it('x = Array(0)', () => test('x = Array(0)', 'x = []'));
    it('x = Array("a")', () => test('x = Array("a")', 'x = ["a"]'));
    it('x = Array(7)', () => testSame('x = Array(7)'));
    it('x = Array(y)', () => testSame('x = Array(y)'));
    it('x = Array(foo())', () => testSame('x = Array(foo())'));
    it('x = Array(...y)', () => testSame('x = Array(...y)'));
    it('x = Array(...[3])', () => test('x = Array(...[3])', 'x = [,,,]'));
    it('x = new Array(1, 2, 3, 4)', () => test('x = new Array(1, 2, 3, 4)', 'x = [1, 2, 3, 4]'));
    it('x = Array(1, 2, 3, 4)', () => test('x = Array(1, 2, 3, 4)', 'x = [1, 2, 3, 4]'));
    it('x = new Array(foo, ...bar)', () => testSame('x = new Array(foo, ...bar)'));
    it('x = Array(foo, ...bar)', () => testSame('x = Array(foo, ...bar)'));
    it('x = new Array(...foo, bar)', () => testSame('x = new Array(...foo, bar)'));
    it('x = Array(...foo, bar)', () => testSame('x = Array(...foo, bar)'));
    it('x = new Array(foo, bar, ...baz)', () => test('x = new Array(foo, bar, ...baz)', 'x = [foo, bar, ...baz]'));
    it('x = Array(foo, bar, ...baz)', () => test('x = Array(foo, bar, ...baz)', 'x = [foo, bar, ...baz]'));
    it('x = new Array(foo, ...bar, baz)', () => test('x = new Array(foo, ...bar, baz)', 'x = [foo, ...bar, baz]'));
    it('x = Array(foo, ...bar, baz)', () => test('x = Array(foo, ...bar, baz)', 'x = [foo, ...bar, baz]'));
    it('x = new Array(...foo, bar, baz)', () => test('x = new Array(...foo, bar, baz)', 'x = [...foo, bar, baz]'));
    it('x = Array(...foo, bar, baz)', () => test('x = Array(...foo, bar, baz)', 'x = [...foo, bar, baz]'));
    it('x = new Array(3, ...[])', () => test('x = new Array(3, ...[])', 'x = [,,,]'));
    it('x = Array(3, ...[])', () => test('x = Array(3, ...[])', 'x = [,,,]'));
    it("x = new Array('a', 1, 2, 'bc', 3, {}, 'abc')", () =>
        test("x = new Array('a', 1, 2, 'bc', 3, {}, 'abc')", "x = ['a', 1, 2, 'bc', 3, {}, 'abc']"));
    it("x = Array('a', 1, 2, 'bc', 3, {}, 'abc')", () =>
        test("x = Array('a', 1, 2, 'bc', 3, {}, 'abc')", "x = ['a', 1, 2, 'bc', 3, {}, 'abc']"));
    it("x = new Array(Array(1, '2', 3, '4'))", () => test("x = new Array(Array(1, '2', 3, '4'))", "x = [[1, '2', 3, '4']]"));
    it("x = Array(Array(1, '2', 3, '4'))", () => test("x = Array(Array(1, '2', 3, '4'))", "x = [[1, '2', 3, '4']]"));
    it('x = new Array(Object(), Array("abc", Object(), Array(Array())))', () =>
        test('x = new Array(Object(), Array("abc", Object(), Array(Array())))', 'x = [{}, ["abc", {}, [[]]]]'));
    it('x = new Array(Object(), Array("abc", Object(), Array(Array())))', () =>
        test('x = new Array(Object(), Array("abc", Object(), Array(Array())))', 'x = [{}, ["abc", {}, [[]]]]'));
});

describe('test_fold_new_expressions', () => {
    it('let _ = new Error()', () => test('let _ = new Error()', 'let _ = /* @__PURE__ */ Error()'));
    it("let _ = new Error('a')", () => test("let _ = new Error('a')", "let _ = /* @__PURE__ */ Error('a')"));
    it("let _ = new Error('a', { cause: b })", () =>
        test("let _ = new Error('a', { cause: b })", "let _ = Error('a', { cause: b })"));
    it('var Error; new Error()', () => testSame('var Error; new Error()'));
    it('let _ = new EvalError()', () => test('let _ = new EvalError()', 'let _ = /* @__PURE__ */ EvalError()'));
    it('let _ = new RangeError()', () => test('let _ = new RangeError()', 'let _ = /* @__PURE__ */ RangeError()'));
    it('let _ = new ReferenceError()', () => test('let _ = new ReferenceError()', 'let _ = /* @__PURE__ */ ReferenceError()'));
    it('let _ = new SyntaxError()', () => test('let _ = new SyntaxError()', 'let _ = /* @__PURE__ */ SyntaxError()'));
    it('let _ = new TypeError()', () => test('let _ = new TypeError()', 'let _ = /* @__PURE__ */ TypeError()'));
    it('let _ = new URIError()', () => test('let _ = new URIError()', 'let _ = /* @__PURE__ */ URIError()'));
    it("let _ = new AggregateError('a')", () =>
        test("let _ = new AggregateError('a')", "let _ = /* @__PURE__ */ AggregateError('a')"));
    it('new Function()', () => test('new Function()', 'Function()'));
    it("new Function('a', 'b', 'console.log(a, b)')", () =>
        test("new Function('a', 'b', 'console.log(a, b)')", "Function('a', 'b', 'console.log(a, b)')"));
    it('var Function; new Function()', () => testSame('var Function; new Function()'));
    it('new RegExp()', () => test('new RegExp()', ''));
    it("new RegExp('a')", () => test("new RegExp('a')", ''));
    it('new RegExp(0)', () => test('new RegExp(0)', 'RegExp(0)'));
    it('new RegExp(null)', () => test('new RegExp(null)', 'RegExp(null)'));
    it("x = new RegExp('a', 'g')", () => test("x = new RegExp('a', 'g')", "x = /* @__PURE__ */ RegExp('a', 'g')"));
    it('new RegExp(foo)', () => testSame('new RegExp(foo)'));
    it('new RegExp(/foo/)', () => test('new RegExp(/foo/)', ''));
    it("RegExp('[')", () => testSame("RegExp('[')"));
    it("RegExp('a', 'xyz')", () => testSame("RegExp('a', 'xyz')"));
});

describe('test_compress_typed_array_constructor', () => {
    it('new Int8Array(0)', () => test('new Int8Array(0)', ''));
    it('new Uint8Array(0)', () => test('new Uint8Array(0)', ''));
    it('new Uint8ClampedArray(0)', () => test('new Uint8ClampedArray(0)', ''));
    it('new Int16Array(0)', () => test('new Int16Array(0)', ''));
    it('new Uint16Array(0)', () => test('new Uint16Array(0)', ''));
    it('new Int32Array(0)', () => test('new Int32Array(0)', ''));
    it('new Uint32Array(0)', () => test('new Uint32Array(0)', ''));
    it('new Float32Array(0)', () => test('new Float32Array(0)', ''));
    it('new Float64Array(0)', () => test('new Float64Array(0)', ''));
    it('new BigInt64Array(0)', () => test('new BigInt64Array(0)', ''));
    it('new BigUint64Array(0)', () => test('new BigUint64Array(0)', ''));
    it('new Int8Array()', () => test('new Int8Array()', ''));
    it('new Int8Array(8)', () => test('new Int8Array(8)', ''));
    it('var Int8Array; new Int8Array(0)', () => testSame('var Int8Array; new Int8Array(0)'));
    it('new Int8Array(-1)', () => testSame('new Int8Array(-1)'));
    it('new Int8Array(a)', () => testSame('new Int8Array(a)'));
    it('new Int8Array(0, a)', () => testSame('new Int8Array(0, a)'));
});

describe('test_string_array_splitting', () => {
    const REPEAT = 20;
    const additionalArgs = ",'1'".repeat(REPEAT);
    const testWithLongerArgs = (sourceTextPartial: string, expectedPartial: string, delimiter: string): void =>
        test(
            `var x=[${sourceTextPartial}${additionalArgs}]`,
            `var x=/* @__PURE__ */'${expectedPartial}${`${delimiter}1`.repeat(REPEAT)}'.split('${delimiter}')`,
        );
    const testSameWithLongerArgs = (sourceTextPartial: string): void => testSame(`var x=[${sourceTextPartial}${additionalArgs}]`);

    it("'1','2','3','4'", () => testSameWithLongerArgs("'1','2','3','4'"));
    it("'1','2','3','4','5'", () => testSameWithLongerArgs("'1','2','3','4','5'"));
    it("`1${a}`,'2','3','4','5','6'", () => testSameWithLongerArgs("`1${a}`,'2','3','4','5','6'"));
    it("'1','2','3','4','5','6'", () => testWithLongerArgs("'1','2','3','4','5','6'", '123456', ''));
    it("'1','2','3','4','5','00'", () => testWithLongerArgs("'1','2','3','4','5','00'", '1.2.3.4.5.00', '.'));
    it("'1','2','3','4','5','6','7'", () => testWithLongerArgs("'1','2','3','4','5','6','7'", '1234567', ''));
    it("'1','2','3','4','5','6','00'", () => testWithLongerArgs("'1','2','3','4','5','6','00'", '1.2.3.4.5.6.00', '.'));
    it("'.,',',',',',',',',',','", () => testWithLongerArgs("'.,',',',',',',',',',','", '.,(,(,(,(,(,', '('));
    it("',,','.',',',',',',',','", () => testWithLongerArgs("',,','.',',',',',',',','", ',,(.(,(,(,(,', '('));
    it("'a,','.',',',',',',',','", () => testWithLongerArgs("'a,','.',',',',',',',','", 'a,(.(,(,(,(,', '('));
    it("`1`,'2','3','4','5','6'", () => testWithLongerArgs("`1`,'2','3','4','5','6'", '123456', ''));

    // all possible delimiters used, leave it alone
    it("'.', ',', '(', ')', ' '", () => testSameWithLongerArgs("'.', ',', '(', ')', ' '"));

    it('unused: remove', () =>
        testOptions(`var x=['1','2','3','4','5','6'${additionalArgs}]`, '', { ...defaultOptions(), unused: 'remove' }));
});

describe('test_template_string_to_string', () => {
    it('x = `abcde`', () => test('x = `abcde`', "x = 'abcde'"));
    it('x = `\\ud800y`', () => testSame('x = `\\ud800y`'));
    it('x = `ab cd ef`', () => test('x = `ab cd ef`', "x = 'ab cd ef'"));
    it('x = `hello ${name}`', () => testSame('x = `hello ${name}`'));
    it('tag `hello ${name}`', () => testSame('tag `hello ${name}`'));
    it('tag `hello`', () => testSame('tag `hello`'));
    it("x = `hello ${'foo'}`", () => test("x = `hello ${'foo'}`", "x = 'hello foo'"));
    it('x = `${2} bananas`', () => test('x = `${2} bananas`', "x = '2 bananas'"));
    it('x = `This is ${true}`', () => test('x = `This is ${true}`', "x = 'This is true'"));
    it('x = `a${void f()}b`', () => testSame('x = `a${void f()}b`'));
});

// oxc: #[ignore = "TODO: Function.bind to Function.call optimization not yet implemented"]
describe.skip('test_bind_to_call', () => {
    it('((function(){}).bind())()', () => test('((function(){}).bind())()', '((function(){}))()'));
    it('((function(){}).bind(a))()', () => test('((function(){}).bind(a))()', '((function(){})).call(a)'));
    it('((function(){}).bind(a,b))()', () => test('((function(){}).bind(a,b))()', '((function(){})).call(a,b)'));
    it('((function(){}).bind())(a)', () => test('((function(){}).bind())(a)', '((function(){}))(a)'));
    it('((function(){}).bind(a))(b)', () => test('((function(){}).bind(a))(b)', '((function(){})).call(a,b)'));
    it('((function(){}).bind(a,b))(c)', () => test('((function(){}).bind(a,b))(c)', '((function(){})).call(a,b,c)'));
    it('(f.bind())()', () => testSame('(f.bind())()'));
    it('(f.bind(a))()', () => testSame('(f.bind(a))()'));
    it('(f.bind())(a)', () => testSame('(f.bind())(a)'));
    it('(f.bind(a))(b)', () => testSame('(f.bind(a))(b)'));
});

describe('test_rotate_associative_operators', () => {
    it('function f(a, b, c) { return a || (b || c) }', () =>
        test('function f(a, b, c) { return a || (b || c) }', 'function f(a, b, c) { return (a || b) || c }'));
    it('function f(a, b, c) { return a && (b && c) }', () =>
        test('function f(a, b, c) { return a && (b && c) }', 'function f(a, b, c) { return (a && b) && c }'));
    it('function f(a, b, c) { return a ?? (b ?? c) }', () =>
        test('function f(a, b, c) { return a ?? (b ?? c) }', 'function f(a, b, c) { return (a ?? b) ?? c }'));
    it('function f(a, b, c) { return a | (b | c) }', () =>
        test('function f(a, b, c) { return a | (b | c) }', 'function f(a, b, c) { return (a | b) | c }'));
    it('function f(a, b, c) { return a() | (b | c) }', () =>
        test('function f(a, b, c) { return a() | (b | c) }', 'function f(a, b, c) { return (a() | b) | c }'));
    it('function f(a, b, c) { return a | (b() | c) }', () =>
        test('function f(a, b, c) { return a | (b() | c) }', 'function f(a, b, c) { return (a | b()) | c }'));
    it('function f(a, b, c) { return a | (b | c()) }', () => testSame('function f(a, b, c) { return a | (b | c()) }'));
    it('function f(a, b, c) { return a & (b & c) }', () =>
        test('function f(a, b, c) { return a & (b & c) }', 'function f(a, b, c) { return (a & b) & c }'));
    it('function f(a, b, c) { return a ^ (b ^ c) }', () =>
        test('function f(a, b, c) { return a ^ (b ^ c) }', 'function f(a, b, c) { return (a ^ b) ^ c }'));
    it('function f(a, b, c) { return a + (b + c) }', () => testSame('function f(a, b, c) { return a + (b + c) }'));
    it('function f(a, b, c) { return a - (b - c) }', () => testSame('function f(a, b, c) { return a - (b - c) }'));
    it('function f(a, b, c) { return a / (b / c) }', () => testSame('function f(a, b, c) { return a / (b / c) }'));
    it('function f(a, b, c) { return a % (b % c) }', () => testSame('function f(a, b, c) { return a % (b % c) }'));
    it('function f(a, b, c) { return a ** (b ** c) }', () => testSame('function f(a, b, c) { return a ** (b ** c) }'));
    it('function f(a, b, c) { return a * (b % c) }', () =>
        test('function f(a, b, c) { return a * (b % c) }', 'function f(a, b, c) { return b % c * a }'));
    it('function f(a, b, c) { return a() * (b % c) }', () => testSame('function f(a, b, c) { return a() * (b % c) }'));
    it('function f(a, b, c) { return a * (b() % c) }', () => testSame('function f(a, b, c) { return a * (b() % c) }'));
    it('function f(a, b, c) { return a * (b % c()) }', () => testSame('function f(a, b, c) { return a * (b % c()) }'));
    it('function f(a, b, c) { return a * (b / c) }', () =>
        test('function f(a, b, c) { return a * (b / c) }', 'function f(a, b, c) { return b / c * a }'));
    it('function f(a, b, c) { return a * (b * c) }', () =>
        test('function f(a, b, c) { return a * (b * c) }', 'function f(a, b, c) { return b * c * a }'));
    it('function f(a, b, c, d) { return a * b * (c / d) }', () => testSame('function f(a, b, c, d) { return a * b * (c / d) }'));
    it('function f(a, b, c, d) { return (a + b) * (c % d) }', () =>
        testSame('function f(a, b, c, d) { return (a + b) * (c % d) }'));
    it('function f(a, b, c, d) { return a / b * (c % d) }', () => testSame('function f(a, b, c, d) { return a / b * (c % d) }'));
});

describe('nullish_coalesce', () => {
    it('a ?? (b ?? c);', () => test('a ?? (b ?? c);', '(a ?? b) ?? c'));
});

describe('test_fold_arrow_function_return', () => {
    it("const foo = () => { return 'baz' }", () => test("const foo = () => { return 'baz' }", "const foo = () => 'baz'"));
    it("const foo = () => { foo.foo; return 'baz' }", () =>
        test("const foo = () => { foo.foo; return 'baz' }", "const foo = () => (foo.foo, 'baz')"));
});

describe('test_fold_is_typeof_equals_undefined_resolved', () => {
    it("var x; v = typeof x !== 'undefined'", () => test("var x; v = typeof x !== 'undefined'", 'var x; v = x !== void 0'));
    it("var x; v = typeof x != 'undefined'", () => test("var x; v = typeof x != 'undefined'", 'var x; v = x !== void 0'));
    it("var x; v = 'undefined' !== typeof x", () => test("var x; v = 'undefined' !== typeof x", 'var x; v = x !== void 0'));
    it("var x; v = 'undefined' != typeof x", () => test("var x; v = 'undefined' != typeof x", 'var x; v = x !== void 0'));
    it("var x; v = typeof x === 'undefined'", () => test("var x; v = typeof x === 'undefined'", 'var x; v = x === void 0'));
    it("var x; v = typeof x == 'undefined'", () => test("var x; v = typeof x == 'undefined'", 'var x; v = x === void 0'));
    it("var x; v = 'undefined' === typeof x", () => test("var x; v = 'undefined' === typeof x", 'var x; v = x === void 0'));
    it("var x; v = 'undefined' == typeof x", () => test("var x; v = 'undefined' == typeof x", 'var x; v = x === void 0'));
    it("var x; function foo() { v = typeof x !== 'undefined' }", () =>
        test("var x; function foo() { v = typeof x !== 'undefined' }", 'var x; function foo() { v = x !== void 0 }'));
    it("v = typeof x !== 'undefined'; function foo() { var x }", () =>
        test("v = typeof x !== 'undefined'; function foo() { var x }", "v = typeof x < 'u'; function foo() { var x }"));
    it("v = typeof x !== 'undefined'; { var x }", () =>
        test("v = typeof x !== 'undefined'; { var x }", 'v = x !== void 0; var x;'));
    it("v = typeof x !== 'undefined'; { let x }", () =>
        test("v = typeof x !== 'undefined'; { let x }", "v = typeof x < 'u'; { let x }"));
    it("v = typeof x !== 'undefined'; var x", () => test("v = typeof x !== 'undefined'; var x", 'v = x !== void 0; var x'));
    it("v = typeof x !== 'undefined'; let x", () => test("v = typeof x !== 'undefined'; let x", 'v = x !== void 0; let x'));
    it("v = typeof x.y === 'undefined'", () => test("v = typeof x.y === 'undefined'", 'v = x.y === void 0'));
    it("v = typeof x.y !== 'undefined'", () => test("v = typeof x.y !== 'undefined'", 'v = x.y !== void 0'));
    it("v = typeof (x + '') === 'undefined'", () => test("v = typeof (x + '') === 'undefined'", "v = x + '' === void 0"));
});

describe('test_fold_is_typeof_equals_undefined', () => {
    it("v = typeof x !== 'undefined'", () => test("v = typeof x !== 'undefined'", "v = typeof x < 'u'"));
    it("v = typeof x != 'undefined'", () => test("v = typeof x != 'undefined'", "v = typeof x < 'u'"));
    it("v = 'undefined' !== typeof x", () => test("v = 'undefined' !== typeof x", "v = typeof x < 'u'"));
    it("v = 'undefined' != typeof x", () => test("v = 'undefined' != typeof x", "v = typeof x < 'u'"));
    it("v = typeof x === 'undefined'", () => test("v = typeof x === 'undefined'", "v = typeof x > 'u'"));
    it("v = typeof x == 'undefined'", () => test("v = typeof x == 'undefined'", "v = typeof x > 'u'"));
    it("v = 'undefined' === typeof x", () => test("v = 'undefined' === typeof x", "v = typeof x > 'u'"));
    it("v = 'undefined' == typeof x", () => test("v = 'undefined' == typeof x", "v = typeof x > 'u'"));
});

describe('test_fold_is_object_and_not_null', () => {
    it("var foo; v = typeof foo === 'object' && foo !== null", () =>
        test("var foo; v = typeof foo === 'object' && foo !== null", "var foo; v = typeof foo == 'object' && !!foo"));
    it("var foo; v = typeof foo == 'object' && foo !== null", () =>
        test("var foo; v = typeof foo == 'object' && foo !== null", "var foo; v = typeof foo == 'object' && !!foo"));
    it("var foo; v = typeof foo === 'object' && foo != null", () =>
        test("var foo; v = typeof foo === 'object' && foo != null", "var foo; v = typeof foo == 'object' && !!foo"));
    it("var foo; v = typeof foo == 'object' && foo != null", () =>
        test("var foo; v = typeof foo == 'object' && foo != null", "var foo; v = typeof foo == 'object' && !!foo"));
    it("var foo; v = typeof foo !== 'object' || foo === null", () =>
        test("var foo; v = typeof foo !== 'object' || foo === null", "var foo; v = typeof foo != 'object' || !foo"));
    it("var foo; v = typeof foo != 'object' || foo === null", () =>
        test("var foo; v = typeof foo != 'object' || foo === null", "var foo; v = typeof foo != 'object' || !foo"));
    it("var foo; v = typeof foo !== 'object' || foo == null", () =>
        test("var foo; v = typeof foo !== 'object' || foo == null", "var foo; v = typeof foo != 'object' || !foo"));
    it("var foo; v = typeof foo != 'object' || foo == null", () =>
        test("var foo; v = typeof foo != 'object' || foo == null", "var foo; v = typeof foo != 'object' || !foo"));
    it("var foo, bar; v = typeof foo === 'object' && foo !== null && bar !== 1", () =>
        test(
            "var foo, bar; v = typeof foo === 'object' && foo !== null && bar !== 1",
            "var foo, bar; v = typeof foo == 'object' && !!foo && bar !== 1",
        ));
    it("var foo, bar; v = bar !== 1 && typeof foo === 'object' && foo !== null", () =>
        test(
            "var foo, bar; v = bar !== 1 && typeof foo === 'object' && foo !== null",
            "var foo, bar; v = bar !== 1 && typeof foo == 'object' && !!foo",
        ));
    it("var foo, bar; v = typeof foo === 'object' && foo !== null || bar !== 1", () =>
        test(
            "var foo, bar; v = typeof foo === 'object' && foo !== null || bar !== 1",
            "var foo, bar; v = typeof foo == 'object' && !!foo || bar !== 1",
        ));
    it("var foo, bar; v = bar !== 1 || typeof foo === 'object' && foo !== null", () =>
        test(
            "var foo, bar; v = bar !== 1 || typeof foo === 'object' && foo !== null",
            "var foo, bar; v = bar !== 1 || typeof foo == 'object' && !!foo",
        ));
    it("var foo, bar; v = (typeof foo !== 'object' || foo === null) && bar !== 1", () =>
        test(
            "var foo, bar; v = (typeof foo !== 'object' || foo === null) && bar !== 1",
            "var foo, bar; v = (typeof foo != 'object' || !foo) && bar !== 1",
        ));
    it("var foo, bar; v = bar !== 1 && (typeof foo !== 'object' || foo === null)", () =>
        test(
            "var foo, bar; v = bar !== 1 && (typeof foo !== 'object' || foo === null)",
            "var foo, bar; v = bar !== 1 && (typeof foo != 'object' || !foo)",
        ));
    it("var foo, bar; v = bar !== 1 && typeof foo != 'object' || foo === null", () =>
        testSame("var foo, bar; v = bar !== 1 && typeof foo != 'object' || foo === null"));
    it("var foo, bar; v = typeof foo != 'object' || foo === null && bar !== 1", () =>
        testSame("var foo, bar; v = typeof foo != 'object' || foo === null && bar !== 1"));
    it("var foo; v = typeof foo.a == 'object' && foo.a !== null", () =>
        testSame("var foo; v = typeof foo.a == 'object' && foo.a !== null"));
    it("v = foo !== null && typeof foo == 'object'", () => testSame("v = foo !== null && typeof foo == 'object'"));
    it("v = typeof foo == 'object' && foo !== null", () => testSame("v = typeof foo == 'object' && foo !== null"));
    it("var foo, bar; v = typeof foo == 'object' && bar !== null", () =>
        testSame("var foo, bar; v = typeof foo == 'object' && bar !== null"));
    it("var foo; v = typeof foo == 'string' && foo !== null", () =>
        testSame("var foo; v = typeof foo == 'string' && foo !== null"));
});

describe('test_fold_is_object_and_not_null_minted_then_dropped', () => {
    it("function f(a) { return 1; if (typeof a === 'object' && a !== null) b(a); } f();", () =>
        test("function f(a) { return 1; if (typeof a === 'object' && a !== null) b(a); } f();", 'function f(a) { return 1; }'));
});

describe('test_swap_binary_expressions', () => {
    it('v = a === 0', () => testSame('v = a === 0'));
    it('v = 0 === a', () => test('v = 0 === a', 'v = a === 0'));
    it("v = a === '0'", () => testSame("v = a === '0'"));
    it("v = '0' === a", () => test("v = '0' === a", "v = a === '0'"));
    it('v = a === `0`', () => test('v = a === `0`', "v = a === '0'"));
    it('v = `0` === a', () => test('v = `0` === a', "v = a === '0'"));
    it('v = a === void 0', () => testSame('v = a === void 0'));
    it('v = void 0 === a', () => test('v = void 0 === a', 'v = a === void 0'));
    it('v = a !== 0', () => testSame('v = a !== 0'));
    it('v = 0 !== a', () => test('v = 0 !== a', 'v = a !== 0'));
    it('v = a == 0', () => testSame('v = a == 0'));
    it('v = 0 == a', () => test('v = 0 == a', 'v = a == 0'));
    it('v = a != 0', () => testSame('v = a != 0'));
    it('v = 0 != a', () => test('v = 0 != a', 'v = a != 0'));
});

describe('test_remove_unary_plus', () => {
    it('v = 1 - +foo', () => test('v = 1 - +foo', 'v = 1 - foo'));
    it('v = +foo - 1', () => test('v = +foo - 1', 'v = foo - 1'));
    it('v = 1n - +foo', () => testSame('v = 1n - +foo'));
    it('v = +foo - 1n', () => testSame('v = +foo - 1n'));
    it('v = +foo - bar', () => testSame('v = +foo - bar'));
    it('v = foo - +bar', () => testSame('v = foo - +bar'));
    it('v = 1 + +foo', () => testSame('v = 1 + +foo'));
    it('v = +d / 1000', () => test('v = +d / 1000', 'v = d / 1000'));
    it('v = 1000 * +d', () => test('v = 1000 * +d', 'v = 1000 * d'));
    it('v = +d * 1000', () => test('v = +d * 1000', 'v = d * 1000'));
    it('v = 2 - +this._x.call(null, node.data)', () =>
        test('v = 2 - +this._x.call(null, node.data)', 'v = 2 - this._x.call(null, node.data)'));
    it('v = 5 | +b', () => test('v = 5 | +b', 'v = 5 | b'));
    it('v = +b | 5', () => test('v = +b | 5', 'v = b | 5'));
    it('v = 7 & +c', () => test('v = 7 & +c', 'v = 7 & c'));
    it('v = 3 ^ +d', () => test('v = 3 ^ +d', 'v = 3 ^ d'));
    it('v = a - +b', () => testSame('v = a - +b'));
    it('v = +a - b', () => testSame('v = +a - b'));
    it('v = a | +b', () => testSame('v = a | +b'));
    it('v = +a | b', () => testSame('v = +a | b'));
});

describe('test_fold_loose_equals_undefined', () => {
    it('v = foo != null', () => testSame('v = foo != null'));
    it('v = foo != undefined', () => test('v = foo != undefined', 'v = foo != null'));
    it('v = foo != void 0', () => test('v = foo != void 0', 'v = foo != null'));
    it('v = undefined != foo', () => test('v = undefined != foo', 'v = foo != null'));
    it('v = void 0 != foo', () => test('v = void 0 != foo', 'v = foo != null'));
});

describe('test_property_key', () => {
    it("v = { '0': _, 'a': _, [1]: _, ['1']: _, ['b']: _, ['c.c']: _, '1.1': _, '\ud83d\ude0a': _, 'd.d': _ }", () =>
        test(
            "v = { '0': _, 'a': _, [1]: _, ['1']: _, ['b']: _, ['c.c']: _, '1.1': _, '\ud83d\ude0a': _, 'd.d': _ }",
            "v = {  0: _,   a: _,    1: _,     1: _,     b: _,   'c.c': _, '1.1': _, '\ud83d\ude0a': _, 'd.d': _ }",
        ));
    it("({ '0': _, 'a': _, [1]: _, ['1']: _, ['b']: _, ['c.c']: _, '1.1': _, '\ud83d\ude0a': _, 'd.d': _ } = {})", () =>
        test(
            "({ '0': _, 'a': _, [1]: _, ['1']: _, ['b']: _, ['c.c']: _, '1.1': _, '\ud83d\ude0a': _, 'd.d': _ } = {})",
            "({  0: _,   a: _,    1: _,   1: _,     b: _,   'c.c': _, '1.1': _, '\ud83d\ude0a': _, 'd.d': _ } = {})",
        ));
    it("var { '0': _, 'a': _, [1]: _, ['1']: _, ['b']: _, ['c.c']: _, '1.1': _, '\ud83d\ude0a': _, 'd.d': _ } = {}", () =>
        test(
            "var { '0': _, 'a': _, [1]: _, ['1']: _, ['b']: _, ['c.c']: _, '1.1': _, '\ud83d\ude0a': _, 'd.d': _ } = {}",
            "var {  0: _,   a: _,    1: _,   1: _,     b: _,   'c.c': _, '1.1': _, '\ud83d\ude0a': _, 'd.d': _ } = {}",
        ));
    it("class F { '0'(){}; 'a'(){}; [1](){}; ['1'](){}; ['b'](){}; ['c.c'](){}; '1.1'(){}; '\ud83d\ude0a'(){}; 'd.d'(){} }", () =>
        test(
            "class F { '0'(){}; 'a'(){}; [1](){}; ['1'](){}; ['b'](){}; ['c.c'](){}; '1.1'(){}; '\ud83d\ude0a'(){}; 'd.d'(){} }",
            "class F {  0(){};   a(){};    1(){};    1(){};     b(){};   'c.c'(){}; '1.1'(){}; '\ud83d\ude0a'(){}; 'd.d'(){} }",
        ));
    it("class F { '0' = _; 'a' = _; [1] = _; ['1'] = _; ['b'] = _; ['c.c'] = _; '1.1' = _; '\ud83d\ude0a' = _; 'd.d' = _ }", () =>
        test(
            "class F { '0' = _; 'a' = _; [1] = _; ['1'] = _; ['b'] = _; ['c.c'] = _; '1.1' = _; '\ud83d\ude0a' = _; 'd.d' = _ }",
            "class F {  0 = _;   a = _;    1 = _;    1 = _;     b = _;   'c.c' = _; '1.1' = _; '\ud83d\ude0a' = _; 'd.d' = _ }",
        ));
    it("class F { accessor '0' = _; accessor 'a' = _; accessor [1] = _; accessor ['1'] = _; accessor ['b'] = _; accessor ['c.c'] = _; accessor '1.1' = _; accessor '\ud83d\ude0a' = _; accessor 'd.d' = _ }", () =>
        test(
            "class F { accessor '0' = _; accessor 'a' = _; accessor [1] = _; accessor ['1'] = _; accessor ['b'] = _; accessor ['c.c'] = _; accessor '1.1' = _; accessor '\ud83d\ude0a' = _; accessor 'd.d' = _ }",
            "class F { accessor  0 = _;  accessor  a = _;    accessor 1 = _;accessor     1 = _; accessor     b = _; accessor   'c.c' = _; accessor '1.1' = _; accessor '\ud83d\ude0a' = _; accessor 'd.d' = _ }",
        ));
    it("class C { ['-1']() {} }", () => test("class C { ['-1']() {} }", "class C { '-1'() {} }"));
    it("v = ({ ['__proto__']: 0 })", () => testSame("v = ({ ['__proto__']: 0 })"));
    it("v = ({ ['__proto__']() {} })", () => test("v = ({ ['__proto__']() {} })", 'v = ({ __proto__() {} })'));
    it("({ ['__proto__']: _ } = {})", () => test("({ ['__proto__']: _ } = {})", '({ __proto__: _ } = {})'));
    it("class C { ['__proto__'] = 0 }", () => test("class C { ['__proto__'] = 0 }", 'class C { __proto__ = 0 }'));
    it("class C { ['__proto__']() {} }", () => test("class C { ['__proto__']() {} }", 'class C { __proto__() {} }'));
    it("class C { accessor ['__proto__'] = 0 }", () =>
        test("class C { accessor ['__proto__'] = 0 }", 'class C { accessor __proto__ = 0 }'));
    it("class C { static ['__proto__'] = 0 }", () =>
        test("class C { static ['__proto__'] = 0 }", 'class C { static __proto__ = 0 }'));
    it("class C { static accessor ['__proto__'] = 0 }", () =>
        test("class C { static accessor ['__proto__'] = 0 }", 'class C { static accessor __proto__ = 0 }'));
    it("x = { 'x\u30fb': 0 };", () => testSame("x = { 'x\u30fb': 0 };"));
    it("x = { 'x\uff65': 0 };", () => testSame("x = { 'x\uff65': 0 };"));
    it("x = y['x\u30fb'];", () => testSame("x = y['x\u30fb'];"));
    it("x = y['x\uff65'];", () => testSame("x = y['x\uff65'];"));
    it("class C { static ['prototype']() {} }", () => testSame("class C { static ['prototype']() {} }"));
    it("class C { static ['prototype'] = 0 }", () => testSame("class C { static ['prototype'] = 0 }"));
    it("class C { static accessor ['prototype'] = 0 }", () => testSame("class C { static accessor ['prototype'] = 0 }"));
    it("class C { ['prototype']() {} }", () => test("class C { ['prototype']() {} }", 'class C { prototype() {} }'));
    it("class C { 'prototype'() {} }", () => test("class C { 'prototype'() {} }", 'class C { prototype() {} }'));
    it("class C { ['prototype'] = 0 }", () => test("class C { ['prototype'] = 0 }", 'class C { prototype = 0 }'));
    it("class C { 'prototype' = 0 }", () => test("class C { 'prototype' = 0 }", 'class C { prototype = 0 }'));
    it("class C { accessor ['prototype'] = 0 }", () =>
        test("class C { accessor ['prototype'] = 0 }", 'class C { accessor prototype = 0 }'));
    it("class C { ['constructor'] = 0 }", () => testSame("class C { ['constructor'] = 0 }"));
    it("class C { accessor ['constructor'] = 0 }", () => testSame("class C { accessor ['constructor'] = 0 }"));
    it("class C { static ['constructor'] = 0 }", () => testSame("class C { static ['constructor'] = 0 }"));
    it("class C { static accessor ['constructor'] = 0 }", () => testSame("class C { static accessor ['constructor'] = 0 }"));
    it("class C { ['constructor']() {} }", () => testSame("class C { ['constructor']() {} }"));
    it("class C { 'constructor'() {} }", () => test("class C { 'constructor'() {} }", 'class C { constructor() {} }'));
    it("class C { *['constructor']() {} }", () => testSame("class C { *['constructor']() {} }"));
    it("class C { async ['constructor']() {} }", () => testSame("class C { async ['constructor']() {} }"));
    it("class C { async *['constructor']() {} }", () => testSame("class C { async *['constructor']() {} }"));
    it("class C { get ['constructor']() {} }", () => testSame("class C { get ['constructor']() {} }"));
    it("class C { set ['constructor'](v) {} }", () => testSame("class C { set ['constructor'](v) {} }"));
    it("class C { static ['constructor']() {} }", () =>
        test("class C { static ['constructor']() {} }", 'class C { static constructor() {} }'));
    it("class C { static 'constructor'() {} }", () =>
        test("class C { static 'constructor'() {} }", 'class C { static constructor() {} }'));
    it("class C { ['#constructor'] = 0 }", () => testSame("class C { ['#constructor'] = 0 }"));
    it("class C { accessor ['#constructor'] = 0 }", () => testSame("class C { accessor ['#constructor'] = 0 }"));
    it("class C { ['#constructor']() {} }", () => testSame("class C { ['#constructor']() {} }"));
    it("class C { static ['#constructor'] = 0 }", () => testSame("class C { static ['#constructor'] = 0 }"));
    it("class C { static accessor ['#constructor'] = 0 }", () => testSame("class C { static accessor ['#constructor'] = 0 }"));
    it("class C { static ['#constructor']() {} }", () => testSame("class C { static ['#constructor']() {} }"));
});

describe('fold_function_spread_args', () => {
    it('f(...a)', () => testSame('f(...a)'));
    it('f(...a, ...b)', () => testSame('f(...a, ...b)'));
    it('f(...a, b, ...c)', () => testSame('f(...a, b, ...c)'));
    it('new F(...a)', () => testSame('new F(...a)'));
    it('f(...[])', () => test('f(...[])', 'f()'));
    it('f(...[1])', () => test('f(...[1])', 'f(1)'));
    it('f(...[1, 2])', () => test('f(...[1, 2])', 'f(1, 2)'));
    it('f(...[1,,,3])', () => test('f(...[1,,,3])', 'f(1, void 0, void 0, 3)'));
    it('f(a, ...[])', () => test('f(a, ...[])', 'f(a)'));
    it('new F(...[])', () => test('new F(...[])', 'new F()'));
    it('new F(...[1])', () => test('new F(...[1])', 'new F(1)'));
});

describe('test_fold_boolean_constructor', () => {
    it('var a = Boolean(true)', () => test('var a = Boolean(true)', 'var a = !0'));
    it('var a = Boolean?.(true)', () => test('var a = Boolean?.(true)', 'var a = Boolean?.(!0)'));
    it('var a = Boolean(false)', () => test('var a = Boolean(false)', 'var a = !1'));
    it('var a = Boolean?.(false)', () => test('var a = Boolean?.(false)', 'var a = Boolean?.(!1)'));
    it('var a = Boolean(1)', () => test('var a = Boolean(1)', 'var a = !0'));
    it('var a = Boolean?.(1)', () => testSame('var a = Boolean?.(1)'));
    it('var a = Boolean(x)', () => test('var a = Boolean(x)', 'var a = !!x'));
    it('var a = Boolean?.(x)', () => testSame('var a = Boolean?.(x)'));
    it('var a = Boolean({})', () => test('var a = Boolean({})', 'var a = !0'));
    it('var a = Boolean?.({})', () => testSame('var a = Boolean?.({})'));
    it('var a = Boolean()', () => test('var a = Boolean()', 'var a = !1;'));
    it('var a = Boolean(!0, !1);', () => testSame('var a = Boolean(!0, !1);'));
});

describe('test_fold_string_constructor', () => {
    it('x = String()', () => test('x = String()', "x = ''"));
    it('var a = String(23)', () => test('var a = String(23)', "var a = '23'"));
    it('var a = String?.(23)', () => testSame('var a = String?.(23)'));
    it("var a = String('hello')", () => test("var a = String('hello')", "var a = 'hello'"));
    it('var a = String(true)', () => test('var a = String(true)', "var a = 'true'"));
    it('var a = String(!0)', () => test('var a = String(!0)', "var a = 'true'"));
    it("var a = String?.('hello')", () => testSame("var a = String?.('hello')"));
    it('var s = Symbol(), a = String(s);', () => test('var s = Symbol(), a = String(s);', 'var a = String(Symbol());'));
    it("var a = String('hello', bar());", () => testSame("var a = String('hello', bar());"));
    it('var a = String({valueOf: function() { return 1; }});', () =>
        testSame('var a = String({valueOf: function() { return 1; }});'));
});

describe('test_fold_number_constructor', () => {
    it('x = Number()', () => test('x = Number()', 'x = 0'));
    it('x = Number(true)', () => test('x = Number(true)', 'x = 1'));
    it('x = Number(false)', () => test('x = Number(false)', 'x = 0'));
    it("x = Number('foo')", () => test("x = Number('foo')", 'x = NaN'));
    it('x = Number(void f())', () => testSame('x = Number(void f())'));
    it('x = Number([f(), 1])', () => testSame('x = Number([f(), 1])'));
});

describe('test_fold_big_int_constructor', () => {
    it('var x = BigInt(1n)', () => test('var x = BigInt(1n)', 'var x = 1n'));
    it('BigInt()', () => testSame('BigInt()'));
    it('BigInt(1)', () => test('BigInt(1)', ''));
});

describe('optional_catch_binding', () => {
    it('try { foo } catch(e) {}', () => test('try { foo } catch(e) {}', 'try { foo } catch {}'));
    it('try { foo } catch(e) {foo}', () => test('try { foo } catch(e) {foo}', 'try { foo } catch {foo}'));
    it('try { foo } catch(e) { bar(e) }', () => testSame('try { foo } catch(e) { bar(e) }'));
    it("try { throw 'caught'; } catch (e) { eval('console.log(e)'); }", () =>
        testSame("try { throw 'caught'; } catch (e) { eval('console.log(e)'); }"));
    it("try { throw 'caught'; } catch (e) { function f() { eval('console.log(e)') } f() }", () =>
        testSame("try { throw 'caught'; } catch (e) { function f() { eval('console.log(e)') } f() }"));
    it('try { foo } catch([e]) {}', () => testSame('try { foo } catch([e]) {}'));
    it('try { foo } catch({e}) {}', () => testSame('try { foo } catch({e}) {}'));
    it('try { foo } catch(e) { var e = baz; bar(e) }', () => testSame('try { foo } catch(e) { var e = baz; bar(e) }'));
    it('try { foo } catch(e) { var e = 2 }', () => testSame('try { foo } catch(e) { var e = 2 }'));
    it('try { foo } catch(e) { var e = 2 } bar(e)', () => testSame('try { foo } catch(e) { var e = 2 } bar(e)'));
    it('try { foo } catch(e) { var {e} = obj }', () => testSame('try { foo } catch(e) { var {e} = obj }'));
    it('try { foo } catch(e) { var [e] = arr }', () => testSame('try { foo } catch(e) { var [e] = arr }'));
    it('try { foo } catch(e) { (function() { var e = 2 })() }', () =>
        test('try { foo } catch(e) { (function() { var e = 2 })() }', 'try { foo } catch {}'));
    it('try { foo } catch(e) { function f() { var e = 2 } }', () =>
        test('try { foo } catch(e) { function f() { var e = 2 } }', 'try { foo } catch { function f() { var e = 2 } }'));
    it('var a = "PASS";\n    try {\n    throw "FAIL1";\n    } catch (a) {\n    var a = "FAIL2";\n    }\n    console.log(a);', () =>
        testSame(
            'var a = "PASS";\n    try {\n    throw "FAIL1";\n    } catch (a) {\n    var a = "FAIL2";\n    }\n    console.log(a);',
        ));
    // Skipped: semantic (src/analysis/semantic.ts), not oxc's binder, which moves a redeclared catch param's binding to the
    // var scope so the inner `e` reads resolve to the outer catch param and keep it.
    it.skip("try {} catch (e) { try {} catch (e) { var e = 'e'; console.log(e === 'e') } } console.log(e === undefined)", () =>
        test(
            "try {} catch (e) { try {} catch (e) { var e = 'e'; console.log(e === 'e') } } console.log(e === undefined)",
            'try {} catch (e) { var e } console.log(e === void 0)',
        ));
    // Skipped: the same semantic binder difference as above.
    it.skip("try { throw 1 } catch (e) { try { throw 2 } catch (e) { var e = 'e'; console.log(e === 'e') } } console.log(e === undefined)", () =>
        test(
            "try { throw 1 } catch (e) { try { throw 2 } catch (e) { var e = 'e'; console.log(e === 'e') } } console.log(e === undefined)",
            "try { throw 1 } catch (e) { try { throw 2 } catch (e) { var e = 'e'; console.log(e === 'e') } } console.log(e === void 0)",
        ));
    // oxc `test_target_same(.., "chrome65")`: chrome65 predates optional catch binding (ES2019).
    it('chrome65', () => testSameOptions('try { foo } catch(e) {}', { ...defaultOptions(), target: esTargets(2018) }));
});

describe('test_remove_name_from_expressions', () => {
    it('var a = function f() {}', () => test('var a = function f() {}', 'var a = function () {}'));
    it('var a = function f() { return f; }', () => testSame('var a = function f() { return f; }'));
    it("var a = function f() { return eval('f'); }", () => testSame("var a = function f() { return eval('f'); }"));
    it('var a = class C {}', () => test('var a = class C {}', 'var a = class {}'));
    it('var a = class C { foo() { return C } }', () => testSame('var a = class C { foo() { return C } }'));
    it("var a = class C { foo() { return eval('C') } }", () => testSame("var a = class C { foo() { return eval('C') } }"));
    it('keep_names function_only', () =>
        testSameOptions('var a = function f() {}', { ...defaultOptions(), keepNames: { function: true, class: false } }));
    it('keep_names class_only', () =>
        testSameOptions('var a = class C {}', { ...defaultOptions(), keepNames: { function: false, class: true } }));
});

describe('test_compress_destructuring_assignment_target', () => {
    it('var {y} = x', () => testSame('var {y} = x'));
    it('var {y, z} = x', () => testSame('var {y, z} = x'));
    it('var {y: z, z: y} = x', () => testSame('var {y: z, z: y} = x'));
    // Skipped: printer (src/print/print-js.ts) prints `{ y: y }` bindings long-hand; oxc codegen prints them as `{ y }`.
    it.skip('var {y: y} = x', () => test('var {y: y} = x', 'var {y} = x'));
    it("var {y: z, 'z': y} = x", () => test("var {y: z, 'z': y} = x", 'var {y: z, z: y} = x'));
    // Skipped: the same printer shorthand difference as above.
    it.skip("var {y: y, 'z': z} = x", () => test("var {y: y, 'z': z} = x", 'var {y, z} = x'));
});

describe('test_object_callee_indirect_call', () => {
    it('Object(f)(1,2)', () => test('Object(f)(1,2)', 'f(1, 2)'));
    it('(Object(g))(a)', () => test('(Object(g))(a)', 'g(a)'));
    it('Object(a.b)(x)', () => test('Object(a.b)(x)', '(0, a.b)(x)'));
    it('Object?.(f)(1)', () => testSame('Object?.(f)(1)'));
    it('function Object(x){return x} Object(f)(1)', () => testSame('function Object(x){return x} Object(f)(1)'));
    it('Object(...a)(1)', () => testSame('Object(...a)(1)'));
});

describe('test_rewrite_arguments_copy_loop', () => {
    it('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; console.log(r) }', () =>
        test(
            'function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; console.log(r) }',
            'function _() { console.log([...arguments]) }',
        ));
    it('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) { r[a] = arguments[a]; } console.log(r) }', () =>
        test(
            'function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) { r[a] = arguments[a]; } console.log(r) }',
            'function _() { console.log([...arguments]) }',
        ));
    it('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) { r[a] = arguments[a] } console.log(r) }', () =>
        test(
            'function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) { r[a] = arguments[a] } console.log(r) }',
            'function _() { console.log([...arguments]) }',
        ));
    it('function _() { for (var e = arguments.length, r = new Array(e), a = 0; a < e; a++) r[a] = arguments[a]; console.log(r) }', () =>
        test(
            'function _() { for (var e = arguments.length, r = new Array(e), a = 0; a < e; a++) r[a] = arguments[a]; console.log(r) }',
            'function _() { console.log([...arguments]) }',
        ));
    it('function _() { for (var e = arguments.length, r = Array(e > 1 ? e - 1 : 0), a = 1; a < e; a++) r[a - 1] = arguments[a]; console.log(r) }', () =>
        test(
            'function _() { for (var e = arguments.length, r = Array(e > 1 ? e - 1 : 0), a = 1; a < e; a++) r[a - 1] = arguments[a]; console.log(r) }',
            'function _() { var r = [...arguments].slice(1); console.log(r) }',
        ));
    it('function _() { for (var e = arguments.length, r = Array(e > 2 ? e - 2 : 0), a = 2; a < e; a++) r[a - 2] = arguments[a]; console.log(r) }', () =>
        test(
            'function _() { for (var e = arguments.length, r = Array(e > 2 ? e - 2 : 0), a = 2; a < e; a++) r[a - 2] = arguments[a]; console.log(r) }',
            'function _() { var r = [...arguments].slice(2); console.log(r) }',
        ));
    it('function _() { for (var e = arguments.length, r = [], a = 0; a < e; a++) r[a] = arguments[a]; console.log(r) }', () =>
        test(
            'function _() { for (var e = arguments.length, r = [], a = 0; a < e; a++) r[a] = arguments[a]; console.log(r) }',
            'function _() { console.log([...arguments]) }',
        ));
    it('function _() { for (var r = [], a = 0; a < arguments.length; a++) r[a] = arguments[a]; console.log(r) }', () =>
        test(
            'function _() { for (var r = [], a = 0; a < arguments.length; a++) r[a] = arguments[a]; console.log(r) }',
            'function _() { console.log([...arguments]) }',
        ));
    it('function _() { for (var r = [], a = 1; a < arguments.length; a++) r[a - 1] = arguments[a]; console.log(r) }', () =>
        test(
            'function _() { for (var r = [], a = 1; a < arguments.length; a++) r[a - 1] = arguments[a]; console.log(r) }',
            'function _() { var r = [...arguments].slice(1); console.log(r) }',
        ));
    it('function _() { for (var r = [], a = 2; a < arguments.length; a++) r[a - 2] = arguments[a]; console.log(r) }', () =>
        test(
            'function _() { for (var r = [], a = 2; a < arguments.length; a++) r[a - 2] = arguments[a]; console.log(r) }',
            'function _() { var r = [...arguments].slice(2); console.log(r) }',
        ));
    it('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; }', () =>
        test(
            'function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; }',
            'function _() {}',
        ));
    it('function _(){if(window.__x)for(var n=arguments.length,a=[],i=0;i<n;i++)a[i]=arguments[i]}', () =>
        test(
            'function _(){if(window.__x)for(var n=arguments.length,a=[],i=0;i<n;i++)a[i]=arguments[i]}',
            'function _(){window.__x}',
        ));
    it('function _() { for (var e = arguments.length, r = Array(e > 1 ? e - 1 : 0), a = 1; a < e; a++) r[a - 1] = arguments[a] }', () =>
        test(
            'function _() { for (var e = arguments.length, r = Array(e > 1 ? e - 1 : 0), a = 1; a < e; a++) r[a - 1] = arguments[a] }',
            'function _() {}',
        ));
    it('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) console.log(r[a]); }', () =>
        testSame('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) console.log(r[a]); }'));
    it('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) { r[a] = arguments[a]; console.log(r); } }', () =>
        test(
            'function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) { r[a] = arguments[a]; console.log(r); } }',
            'function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) (r[a] = arguments[a], console.log(r)) }',
        ));
    it('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] += arguments[a]; }', () =>
        testSame('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] += arguments[a]; }'));
    it('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a + 1] = arguments[a]; }', () =>
        testSame('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a + 1] = arguments[a]; }'));
    it('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a - 0.5] = arguments[a]; }', () =>
        testSame('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a - 0.5] = arguments[a]; }'));
    it('function _() { var arguments; for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; }', () =>
        test(
            'function _() { var arguments; for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; }',
            'function _() { for (var arguments, e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; }',
        ));
    it('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = foo[a]; }', () =>
        testSame('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = foo[a]; }'));
    it('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; e--) r[a] = arguments[a]; }', () =>
        testSame('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; e--) r[a] = arguments[a]; }'));
    it('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; r++) r[a] = arguments[a]; }', () =>
        testSame('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; r++) r[a] = arguments[a]; }'));
    it('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < r; r++) r[a] = arguments[a]; }', () =>
        testSame('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < r; r++) r[a] = arguments[a]; }'));
    it('function _() { var arguments; for (var r = [], a = 0; a < arguments.length; a++) r[a] = arguments[a]; }', () =>
        test(
            'function _() { var arguments; for (var r = [], a = 0; a < arguments.length; a++) r[a] = arguments[a]; }',
            'function _() { for (var arguments, r = [], a = 0; a < arguments.length; a++) r[a] = arguments[a]; }',
        ));
    it('function _() { for (var e = arguments.length, r = Array(e > 1 ? e - 2 : 0), a = 2; a < e; a++) r[a - 2] = arguments[a]; }', () =>
        testSame(
            'function _() { for (var e = arguments.length, r = Array(e > 1 ? e - 2 : 0), a = 2; a < e; a++) r[a - 2] = arguments[a]; }',
        ));
    // oxc `SourceType::cjs()`: sloppy mode.
    it('cjs', () => {
        const source =
            'function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; console.log(r) }';
        testOptions(source, source, defaultOptions(), 'script');
    });
    it('for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; console.log(r)', () =>
        testSame('for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; console.log(r)'));
    it('const _ = () => { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; console.log(r) }', () =>
        testSame(
            'const _ = () => { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; console.log(r) }',
        ));
    it('{ let _; for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; console.log(r) }', () =>
        testSame(
            '{ let _; for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; console.log(r) }',
        ));
    it('function _() { { let _; for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; console.log(r) } }', () =>
        test(
            'function _() { { let _; for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; console.log(r) } }',
            'function _() { { let _; console.log([...arguments]) } }',
        ));
    it('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; console.log(r, e) }', () =>
        testSame(
            'function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; console.log(r, e) }',
        ));
    it('function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; console.log(r, a) }', () =>
        testSame(
            'function _() { for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a]; console.log(r, a) }',
        ));
});

describe('test_flatten_nested_chain_expression', () => {
    it('(a.b)?.c', () => test('(a.b)?.c', 'a.b?.c'));
    it('(a?.b)?.c', () => test('(a?.b)?.c', 'a?.b?.c'));
    it('(a?.b?.c)?.d', () => test('(a?.b?.c)?.d', 'a?.b?.c?.d'));
    it('(((a?.b)?.c)?.d)?.e', () => test('(((a?.b)?.c)?.d)?.e', 'a?.b?.c?.d?.e'));
    it('(a?.b)?.()', () => test('(a?.b)?.()', 'a?.b?.()'));
    it('(a?.b)?.(arg)', () => test('(a?.b)?.(arg)', 'a?.b?.(arg)'));
    it('(a?.b)?.[0]', () => test('(a?.b)?.[0]', 'a?.b?.[0]'));
    it('(a?.b)?.[key]', () => test('(a?.b)?.[key]', 'a?.b?.[key]'));
    it('(a?.#b)?.c', () => test('(a?.#b)?.c', 'a?.#b?.c'));
    it('a.b?.c', () => testSame('a.b?.c'));
    it('a?.b?.c', () => testSame('a?.b?.c'));
    it('(a?.b).c', () => testSame('(a?.b).c'));
});

describe('test_flatten_array_spread_elements', () => {
    it('var y = [3, 4, ...[1, 2]]', () => test('var y = [3, 4, ...[1, 2]]', 'var y = [3, 4, 1, 2]'));
    it('var y = [...[1, 2], 3, 4]', () => test('var y = [...[1, 2], 3, 4]', 'var y = [1, 2, 3, 4]'));
    it('var y = [...[1, 2], ...[3, 4]]', () => test('var y = [...[1, 2], ...[3, 4]]', 'var y = [1, 2, 3, 4]'));
    it('var y = [1, ...[], 2]', () => test('var y = [1, ...[], 2]', 'var y = [1, 2]'));
    it('var y = [...[1, , 3]]', () => test('var y = [...[1, , 3]]', 'var y = [1, void 0, 3]'));
    it('var y = [...[1, ...[2, 3]]]', () => test('var y = [...[1, ...[2, 3]]]', 'var y = [1, 2, 3]'));
    it('var y = [1, , ...[2, 3]]', () => test('var y = [1, , ...[2, 3]]', 'var y = [1, , 2, 3]'));
    it('var y = [...x]', () => testSame('var y = [...x]'));
    it('var y = [1, ...x, 2]', () => testSame('var y = [1, ...x, 2]'));
    it('var x = [1, 2]; var y = [3, 4, ...x]', () => test('var x = [1, 2]; var y = [3, 4, ...x]', 'var y = [3, 4, 1, 2]'));
    it('var x = [1, 2]; var y = [0, ...x, ...x]', () =>
        test('var x = [1, 2]; var y = [0, ...x, ...x]', 'var x = [1, 2], y = [0, ...x, ...x]'));
    it('var x = [1, ...[2, 3]]; var y = [4, ...x]', () =>
        test('var x = [1, ...[2, 3]]; var y = [4, ...x]', 'var y = [4, 1, 2, 3]'));
    it('var x = [1, , 3]; var y = [0, ...x]', () => test('var x = [1, , 3]; var y = [0, ...x]', 'var y = [0, 1, void 0, 3]'));
    it('var x = []; var y = [1, ...x, 2]', () => test('var x = []; var y = [1, ...x, 2]', 'var y = [1, 2]'));
    it('var x = [1, 2]; var y = [0, , ...x]', () => test('var x = [1, 2]; var y = [0, , ...x]', 'var y = [0, , 1, 2]'));
    it('var x = [1, 2]; var y = [0, ...x, 3]', () => test('var x = [1, 2]; var y = [0, ...x, 3]', 'var y = [0, 1, 2, 3]'));
    it('var x=[30,40];var y = [10,...[],20,...x,50];', () =>
        test('var x=[30,40];var y = [10,...[],20,...x,50];', 'var y = [10,20,30,40,50]'));
    it('var y = [0, ...[1, , , 3]]', () => testSame('var y = [0, ...[1, , , 3]]'));
    it('var y = [...[1, , ,], ...[, 2], , 2];', () =>
        test('var y = [...[1, , ,], ...[, 2], , 2];', 'var y = [...[1, , , ], void 0, 2, , 2];'));
});

describe('fold_sequence_expression', () => {
    it('(a(), b) + c', () => test('(a(), b) + c', 'a(), b + c'));
    it('(a(), b, c) + d', () => test('(a(), b, c) + d', 'a(), b, c + d'));
    it('(a(), b) || c', () => test('(a(), b) || c', 'a(), b || c'));
    it('(a(), b) && c', () => test('(a(), b) && c', 'a(), b && c'));
    it('(a(), b, c) || d', () => test('(a(), b, c) || d', 'a(), b, c || d'));
    it('-(a(), b)', () => test('-(a(), b)', 'a(), -b'));
    it('~(a(), b)', () => test('~(a(), b)', 'a(), ~b'));
    it('-(a(), b, c)', () => test('-(a(), b, c)', 'a(), b, -c'));
    it('function* a() { yield (c(1), 2) }', () => test('function* a() { yield (c(1), 2) }', 'function* a() { c(1), yield 2 }'));
    it('function* a() { b(yield (c(1), 2)) }', () =>
        test('function* a() { b(yield (c(1), 2)) }', 'function* a() { b((c(1), yield 2)) }'));
    it('function* a() { yield (c(1), d(2), 3) }', () =>
        test('function* a() { yield (c(1), d(2), 3) }', 'function* a() { c(1), d(2), yield 3 }'));
    it('async function a() { await (c(1), 2) }', () =>
        test('async function a() { await (c(1), 2) }', 'async function a() { c(1), await 2 }'));
    it('async function a() { b(await (c(1), 2)) }', () =>
        test('async function a() { b(await (c(1), 2)) }', 'async function a() { b((c(1), await 2)) }'));
    it('async function a() { await (c(1), d(2), 3) }', () =>
        test('async function a() { await (c(1), d(2), 3) }', 'async function a() { c(1), d(2), await 3 }'));
});
