// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are JS source under test.
// Ported from oxc_minifier/tests/peephole/obscure_edge_cases.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { test, testSame } from './harness.ts';

describe('test_dead_code_elimination_edge_cases', () => {
    it('if (true) { foo(); } else { bar(); }', () => test('if (true) { foo(); } else { bar(); }', 'foo();'));
    it('if (false) { foo(); } else { bar(); }', () => test('if (false) { foo(); } else { bar(); }', 'bar();'));
    it('true ? foo() : bar()', () => test('true ? foo() : bar()', 'foo()'));
    it('false ? foo() : bar()', () => test('false ? foo() : bar()', 'bar()'));
    it('true && foo()', () => test('true && foo()', 'foo()'));
    it('false && foo()', () => test('false && foo()', ''));
    it('true || foo()', () => test('true || foo()', ''));
    it('false || foo()', () => test('false || foo()', 'foo()'));
    it('sideEffect() && false', () => test('sideEffect() && false', 'sideEffect()'));
    it('true || sideEffect()', () => test('true || sideEffect()', ''));
    it('if (5 > 3) { definite(); }', () => test('if (5 > 3) { definite(); }', 'definite();'));
    it('if (2 < 1) { never(); }', () => test('if (2 < 1) { never(); }', ''));
    it('if (0 === 0) { always(); }', () => test('if (0 === 0) { always(); }', 'always();'));
    it('if (1 !== 1) { never(); }', () => test('if (1 !== 1) { never(); }', ''));
});

describe('test_string_concatenation_edge_cases', () => {
    it("return 'hello ' + 'world'", () => test("return 'hello ' + 'world'", "return 'hello world'"));
    it("return 'count: ' + 42", () => test("return 'count: ' + 42", "return 'count: 42'"));
    it("return 42 + ' items'", () => test("return 42 + ' items'", "return '42 items'"));
    it("return getValue() + 'suffix'", () => testSame("return getValue() + 'suffix'"));
    it("return 'prefix' + sideEffect()", () => testSame("return 'prefix' + sideEffect()"));
    it("return obj['property']", () => test("return obj['property']", 'return obj.property'));
    it("return obj['validName123']", () => test("return obj['validName123']", 'return obj.validName123'));
    it("return obj['$special']", () => test("return obj['$special']", 'return obj.$special'));
    it("return obj['123invalid']", () => testSame("return obj['123invalid']"));
    it("return obj['key-with-dash']", () => testSame("return obj['key-with-dash']"));
    it("return obj['key with space']", () => testSame("return obj['key with space']"));
    it('return obj[dynamicKey]', () => testSame('return obj[dynamicKey]'));
    it("return obj['']", () => testSame("return obj['']"));
    it("return obj['class']", () => test("return obj['class']", 'return obj.class'));
    it("return obj['function']", () => test("return obj['function']", 'return obj.function'));
    it("return obj['prop' + 'name']", () => test("return obj['prop' + 'name']", 'return obj.propname'));
});

describe('test_typeof_optimization_edge_cases', () => {
    it('return typeof 42', () => test('return typeof 42', "return 'number'"));
    it("return typeof 'string'", () => test("return typeof 'string'", "return 'string'"));
    it('return typeof true', () => test('return typeof true', "return 'boolean'"));
    it('return typeof undefined', () => test('return typeof undefined', "return 'undefined'"));
    it('return typeof null', () => test('return typeof null', "return 'object'"));
    it('return typeof []', () => test('return typeof []', "return 'object'"));
    it('return typeof {}', () => test('return typeof {}', "return 'object'"));
    it('return typeof function(){}', () => test('return typeof function(){}', "return 'function'"));
    it("if (typeof 5 === 'number') { always(); }", () => test("if (typeof 5 === 'number') { always(); }", 'always();'));
    it("if (typeof 'test' !== 'string') { never(); }", () => test("if (typeof 'test' !== 'string') { never(); }", ''));
    it("typeof x === 'undefined'", () => test("typeof x === 'undefined'", ''));
    it('typeof unknownVar', () => test('typeof unknownVar', ''));
});

describe('test_numeric_comparison_edge_cases', () => {
    it('return 5 > 3', () => test('return 5 > 3', 'return !0'));
    it('return 10 <= 5', () => test('return 10 <= 5', 'return !1'));
    it('return 7 === 7', () => test('return 7 === 7', 'return !0'));
    it('return 3 !== 5', () => test('return 3 !== 5', 'return !0'));
    it("return 'a' < 'b'", () => test("return 'a' < 'b'", 'return !0'));
    it("return 'hello' === 'hello'", () => test("return 'hello' === 'hello'", 'return !0'));
    it("return 'abc' !== 'def'", () => test("return 'abc' !== 'def'", 'return !0'));
    it('return null == undefined', () => test('return null == undefined', 'return !0'));
    it('return null === undefined', () => test('return null === undefined', 'return !1'));
    it('return null == null', () => test('return null == null', 'return !0'));
    it('return undefined === undefined', () => test('return undefined === undefined', 'return !0'));
    it('return 0 == false', () => test('return 0 == false', 'return !0'));
    it("return '' == false", () => test("return '' == false", 'return !0'));
    it("return '0' == false", () => test("return '0' == false", 'return !0'));
    it('return 0 === false', () => test('return 0 === false', 'return !1'));
    it('return NaN === NaN', () => test('return NaN === NaN', 'return !1'));
    it('return NaN == NaN', () => test('return NaN == NaN', 'return !1'));
    it('return NaN !== NaN', () => test('return NaN !== NaN', 'return !0'));
    it('return NaN != NaN', () => test('return NaN != NaN', 'return !0'));
});

describe('test_mathematical_expression_edge_cases', () => {
    it('return 1 / 0', () => testSame('return 1 / 0'));
    it('return -1 / 0', () => testSame('return -1 / 0'));
    it('return 0 / 0', () => test('return 0 / 0', 'return NaN'));
    it('return 2 + 3', () => test('return 2 + 3', 'return 5'));
    it('return 10 - 4', () => test('return 10 - 4', 'return 6'));
    it('return 3 * 7', () => test('return 3 * 7', 'return 21'));
    it('return 15 / 3', () => test('return 15 / 3', 'return 5'));
    it('NaN + 1', () => test('NaN + 1', ''));
    it('NaN * 0', () => test('NaN * 0', ''));
    it('NaN / NaN', () => test('NaN / NaN', ''));
    it('Infinity + 1', () => test('Infinity + 1', ''));
    it('Infinity - Infinity', () => test('Infinity - Infinity', ''));
    it('Infinity / Infinity', () => test('Infinity / Infinity', ''));
    it('Math.PI * 2', () => testSame('Math.PI * 2'));
    it('Math.E + 1', () => testSame('Math.E + 1'));
    it('-0 + 0', () => test('-0 + 0', ''));
    it('-0 * 1', () => test('-0 * 1', ''));
    it('1 / -0', () => test('1 / -0', ''));
});

describe('test_function_call_optimization_edge_cases', () => {
    it('return String(42)', () => test('return String(42)', "return '42'"));
    it("return Number('123')", () => test("return Number('123')", 'return 123'));
    it('return Boolean(1)', () => test('return Boolean(1)', 'return !0'));
    it('return Boolean(0)', () => test('return Boolean(0)', 'return !1'));
    it("console.log('test')", () => testSame("console.log('test')"));
    it('Object.keys(obj)', () => testSame('Object.keys(obj)'));
    it('Math.random()', () => test('Math.random()', ''));
    it('Date.now()', () => test('Date.now()', ''));
    it('Object(null)', () => test('Object(null)', ''));
    it("return 'hello'.length", () => test("return 'hello'.length", 'return 5'));
    it("return ''.length", () => test("return ''.length", 'return 0'));
    it('return [1, 2, 3].length', () => test('return [1, 2, 3].length', 'return 3'));
    it('return [].length', () => test('return [].length', 'return 0'));
});

describe('test_object_literal_edge_cases', () => {
    it("const obj = { 'key': 1 }", () => test("const obj = { 'key': 1 }", 'const obj = {key: 1};'));
    it("const obj = { 'validName': 1 }", () => test("const obj = { 'validName': 1 }", 'const obj = {validName: 1};'));
    it("const obj = { '123invalid': 1 }", () => testSame("const obj = { '123invalid': 1 }"));
    it("const obj = { 'key-with-dash': 1 }", () => testSame("const obj = { 'key-with-dash': 1 }"));
    it("const obj = { 'key with space': 1 }", () => testSame("const obj = { 'key with space': 1 }"));
    it("const obj = { '': 1 }", () => testSame("const obj = { '': 1 }"));
    it("const obj = { 'class': 1 }", () => test("const obj = { 'class': 1 }", 'const obj = { class: 1 };'));
    it("const obj = { ['key']: 1 }", () => test("const obj = { ['key']: 1 }", 'const obj = {key: 1};'));
    it('const obj = { [dynamicKey]: 1 }', () => testSame('const obj = { [dynamicKey]: 1 }'));
    it("const obj = { ['prop' + 'name']: 1 }", () => test("const obj = { ['prop' + 'name']: 1 }", 'const obj = {propname: 1};'));
});

describe('test_regex_literal_edge_cases', () => {
    it("/abc/.test('abc')", () => testSame("/abc/.test('abc')"));
    it("/abc/.test('def')", () => testSame("/abc/.test('def')"));
    it("/\\d+/.test('123')", () => testSame("/\\d+/.test('123')"));
    it("/\\d+/.test('abc')", () => testSame("/\\d+/.test('abc')"));
    it('/complex(?:pattern)+/.test(input)', () => testSame('/complex(?:pattern)+/.test(input)'));
    it('new RegExp(pattern).test(input)', () => testSame('new RegExp(pattern).test(input)'));
    it('regex.test(input)', () => testSame('regex.test(input)'));
    it("/abc/i.test('ABC')", () => testSame("/abc/i.test('ABC')"));
    it("/abc/i.test('def')", () => testSame("/abc/i.test('def')"));
});

describe('test_array_method_edge_cases', () => {
    it('return [1, 2, 3].indexOf(2)', () => testSame('return [1, 2, 3].indexOf(2)'));
    it('return [1, 2, 3].indexOf(5)', () => testSame('return [1, 2, 3].indexOf(5)'));
    it("return ['a', 'b', 'c'].includes('b')", () => testSame("return ['a', 'b', 'c'].includes('b')"));
    it("return ['a', 'b', 'c'].includes('d')", () => testSame("return ['a', 'b', 'c'].includes('d')"));
    it('return [1, 2, 3].slice(1)', () => testSame('return [1, 2, 3].slice(1)'));
    it('return [1, 2].concat([3, 4])', () => test('return [1, 2].concat([3, 4])', 'return [\n\t1,\n\t2,\n\t3,\n\t4\n];'));
    it('[1, 2, 3].forEach(fn)', () => testSame('[1, 2, 3].forEach(fn)'));
    it('arr.push(item)', () => testSame('arr.push(item)'));
    it('arr.pop()', () => testSame('arr.pop()'));
    it('arr.map(fn)', () => testSame('arr.map(fn)'));
});

describe('test_assignment_optimization_edge_cases', () => {
    it('x = x + 1', () => test('x = x + 1', 'x += 1'));
    it('x = x - 1', () => test('x = x - 1', '--x'));
    it('x = x * 2', () => test('x = x * 2', 'x *= 2'));
    it('x = x / 2', () => test('x = x / 2', 'x /= 2'));
    it('obj.prop = obj.prop + 1', () => testSame('obj.prop = obj.prop + 1'));
    it('arr[i] = arr[i] + 1', () => testSame('arr[i] = arr[i] + 1'));
    it('this.prop = this.prop + 1', () => test('this.prop = this.prop + 1', 'this.prop += 1'));
});

describe('test_side_effect_analysis_edge_cases', () => {
    it('42;', () => test('42;', ''));
    it("'hello';", () => test("'hello';", "'hello';"));
    it('true;', () => test('true;', ''));
    it('1 + 2 + 3;', () => test('1 + 2 + 3;', ''));
    it("console.log('side effect');", () => testSame("console.log('side effect');"));
    it('obj.method();', () => testSame('obj.method();'));
    it('globalVar = 5;', () => testSame('globalVar = 5;'));
    it('delete obj.prop;', () => testSame('delete obj.prop;'));
    it('++counter;', () => testSame('++counter;'));
    it("1 + 2; console.log('keep'); 3 + 4;", () => test("1 + 2; console.log('keep'); 3 + 4;", "console.log('keep');"));
    it('obj.prop;', () => testSame('obj.prop;'));
    it("obj['computed'];", () => test("obj['computed'];", 'obj.computed;'));
});

describe('test_variable_elimination_edge_cases', () => {
    it('var unused = 5;', () => testSame('var unused = 5;'));
    it("let unused = 'hello';", () => testSame("let unused = 'hello';"));
    it('const unused = true', () => test('const unused = true', 'const unused = !0'));
    it('var used = 5; console.log(used);', () => test('var used = 5; console.log(used);', 'console.log(5);'));
    it("let used = 'hello'; return used;", () =>
        test("let used = 'hello'; return used;", "let used = 'hello';\nreturn 'hello';"));
    it('const used = true; if (used) foo();', () => test('const used = true; if (used) foo();', 'const used = !0;\nfoo();'));
    it("const y = 'hello'; return y;", () => test("const y = 'hello'; return y;", "const y = 'hello';\nreturn 'hello';"));
    it('var x = sideEffect(); console.log(x);', () => testSame('var x = sideEffect(); console.log(x);'));
    it('var x = 5; x = 10; console.log(x);', () =>
        test('var x = 5; x = 10; console.log(x);', 'var x = 5;\nx = 10, console.log(x);'));
    it('let x = 5; if (condition) x = 10; console.log(x);', () =>
        test('let x = 5; if (condition) x = 10; console.log(x);', 'let x = 5;\ncondition && (x = 10), console.log(x);'));
});

describe('test_loop_optimization_edge_cases', () => {
    it('while (false) { neverExecuted(); }', () => test('while (false) { neverExecuted(); }', ''));
    it('for (; false;) { neverExecuted(); }', () => test('for (; false;) { neverExecuted(); }', ''));
    it('while (true) { infiniteLoop(); }', () => test('while (true) { infiniteLoop(); }', 'for (;;) infiniteLoop();'));
    it('do { executedOnce(); } while (false);', () =>
        test('do { executedOnce(); } while (false);', 'do\n\texecutedOnce();\nwhile (!1);'));
    it('do { body(); } while (true);', () => test('do { body(); } while (true);', 'do\n\tbody();\nwhile (!0);'));
    it('for (var i = 0; i < 0; i++) { neverExecuted(); }', () =>
        test('for (var i = 0; i < 0; i++) { neverExecuted(); }', 'for (var i = 0; i < 0; i++) neverExecuted();'));
    it('for (var i = 5; i < 3; i++) { neverExecuted(); }', () =>
        test('for (var i = 5; i < 3; i++) { neverExecuted(); }', 'for (var i = 5; i < 3; i++) neverExecuted();'));
    it('for (var i = 0; i < 3; i++) { executed(); }', () =>
        test('for (var i = 0; i < 3; i++) { executed(); }', 'for (var i = 0; i < 3; i++) executed();'));
});

describe('test_switch_statement_edge_cases', () => {
    it('switch (2) { case 1: a(); break; case 2: b(); break; case 3:', () =>
        testSame('switch (2) { case 1: a(); break; case 2: b(); break; case 3: c(); }'));
    it("switch ('test') { case 'foo': a(); break; case 'test': b(); ", () =>
        testSame("switch ('test') { case 'foo': a(); break; case 'test': b(); break; default: c(); }"));
    it('switch (5) { case 1: a(); break; case 2: b(); break; }', () =>
        test('switch (5) { case 1: a(); break; case 2: b(); break; }', 'switch (5) { case 1: a(); break; case 2: b(); }'));
    it('switch (5) { case 1: a(); break; default: b(); break; }', () =>
        test('switch (5) { case 1: a(); break; default: b(); break; }', 'switch (5) { case 1: a(); break; default: b(); }'));
    it('switch (1) { case 1: a(); case 2: b(); break; case 3: c(); }', () =>
        testSame('switch (1) { case 1: a(); case 2: b(); break; case 3: c(); }'));
});

describe('test_try_catch_optimization_edge_cases', () => {
    it('try { safeCode(); } catch (e) { handleError(e); }', () => testSame('try { safeCode(); } catch (e) { handleError(e); }'));
    it('try { code(); } finally { cleanup(); }', () => testSame('try { code(); } finally { cleanup(); }'));
    it('try { code(); } catch (e) { handle(e); } finally { cleanup()', () =>
        testSame('try { code(); } catch (e) { handle(e); } finally { cleanup(); }'));
    it('try { riskyCode(); } catch (e) { handleError(e); }', () =>
        testSame('try { riskyCode(); } catch (e) { handleError(e); }'));
    it('try { eval(code); } catch (e) { handleError(e); }', () => testSame('try { eval(code); } catch (e) { handleError(e); }'));
});

describe('test_minifier_safety_boundaries', () => {
    // shakeup's parser rejects `with` in module code, which oxc leaves to its checker; the printer has no `with` either.
    it.skip('with (obj) { prop = value; }', () => test('with (obj) { prop = value; }', 'with(obj) prop = value;'));
    it("(1, eval)('code')", () => test("(1, eval)('code')", "(0, eval)('code')"));
    it("arguments[0] = 'modified';", () => testSame("arguments[0] = 'modified';"));
    it('obj = { get prop() { return this._prop; } }', () => testSame('obj = { get prop() { return this._prop; } }'));
    it('obj = { set prop(v) { this._prop = v; } }', () => testSame('obj = { set prop(v) { this._prop = v; } }'));
    it('new Proxy(obj, handler)', () => testSame('new Proxy(obj, handler)'));
    it('Reflect.get(obj, prop)', () => testSame('Reflect.get(obj, prop)'));
    it('obj[computedKey]', () => testSame('obj[computedKey]'));
    it('obj[key()]', () => testSame('obj[key()]'));
});

describe('test_esm_minification_edge_cases', () => {
    it("import { a, b } from 'module';", () => testSame("import { a, b } from 'module';"));
    it("import { a as x, b as y } from 'module';", () => testSame("import { a as x, b as y } from 'module';"));
    it("import * as ns from 'module';", () => testSame("import * as ns from 'module';"));
    it("import defaultExport from 'module';", () => testSame("import defaultExport from 'module';"));
    it("import defaultExport, { a, b } from 'module';", () => testSame("import defaultExport, { a, b } from 'module';"));
    it("import defaultExport, * as ns from 'module';", () => testSame("import defaultExport, * as ns from 'module';"));
    it("import 'side-effect-module';", () => testSame("import 'side-effect-module';"));
    it('export { a, b };', () => testSame('export { a, b };'));
    it('export { a as x, b as y };', () => testSame('export { a as x, b as y };'));
    it("export * from 'module';", () => testSame("export * from 'module';"));
    it("export * as ns from 'module';", () => testSame("export * as ns from 'module';"));
    it("export { a, b } from 'module';", () => testSame("export { a, b } from 'module';"));
    it("export { a as x, b as y } from 'module';", () => testSame("export { a as x, b as y } from 'module';"));
    it('export default value;', () => testSame('export default value;'));
    it('export default function() {}', () => testSame('export default function() {}'));
    it('export default class {}', () => testSame('export default class {}'));
    it('export var a = 1 + 2;', () => test('export var a = 1 + 2;', 'export var a = 3;'));
    it("export let b = 'hello' + ' world';", () => test("export let b = 'hello' + ' world';", "export let b = 'hello world';"));
    it("export const c = true ? 'yes' : 'no';", () => test("export const c = true ? 'yes' : 'no';", "export const c = 'yes';"));
    it('export function f() { return 2 + 3; }', () =>
        test('export function f() { return 2 + 3; }', 'export function f() { return 5; }'));
    it("export class C { method() { return 'a' + 'b'; } }", () =>
        test("export class C { method() { return 'a' + 'b'; } }", "export class C { method() { return 'ab'; } }"));
    it("import('./module.js')", () => testSame("import('./module.js')"));
    it('import(`./modules/${name}.js`)', () => testSame('import(`./modules/${name}.js`)'));
    it("import('prefix' + 'suffix')", () => test("import('prefix' + 'suffix')", "import('prefixsuffix')"));
    it('import(`module-${1 + 2}`)', () => test('import(`module-${1 + 2}`)', "import('module-3')"));
    it("import('./module.js', { assert: { type: 'json' } })", () =>
        testSame("import('./module.js', { assert: { type: 'json' } })"));
    it("import('./module.js', { with: { type: 'json' } })", () => testSame("import('./module.js', { with: { type: 'json' } })"));
    it("import('./module.js', { assert: { type: 'js' + 'on' } })", () =>
        test("import('./module.js', { assert: { type: 'js' + 'on' } })", "import('./module.js', { assert: { type: 'json' } })"));
    it('import.meta.url', () => testSame('import.meta.url'));
    it("import.meta.resolve('./module.js')", () => testSame("import.meta.resolve('./module.js')"));
    it('import.meta.hot', () => testSame('import.meta.hot'));
    it('import.meta.env', () => testSame('import.meta.env'));
    it("import.meta.resolve('prefix' + 'suffix')", () =>
        test("import.meta.resolve('prefix' + 'suffix')", "import.meta.resolve('prefixsuffix')"));
    it("await import('./dynamic.js')", () => testSame("await import('./dynamic.js')"));
    it("const data = await import('./data.json', { assert: { type: '", () =>
        testSame("const data = await import('./data.json', { assert: { type: 'json' } });"));
    it('const result = await (1 + 2);', () => test('const result = await (1 + 2);', 'const result = await 3;'));
    it("export { default as myDefault } from './other.js';", () =>
        testSame("export { default as myDefault } from './other.js';"));
    it("import('./polyfill.js').then(() => import('./main.js'));", () =>
        testSame("import('./polyfill.js').then(() => import('./main.js'));"));
    it("export const computed = obj['prop' + 'erty'];", () =>
        test("export const computed = obj['prop' + 'erty'];", 'export const computed = obj.property;'));
    it("const { ['computed' + 'Name']: value } = module;", () =>
        test("const { ['computed' + 'Name']: value } = module;", 'const { computedName: value } = module;'));
    it("import('./modules/' + (true ? 'prod' : 'dev') + '.js')", () =>
        test("import('./modules/' + (true ? 'prod' : 'dev') + '.js')", "import('./modules/prod.js')"));
    it('ns.exported', () => testSame('ns.exported'));
    it("ns['exported']", () => test("ns['exported']", 'ns.exported'));
    it("ns['prop' + 'name']", () => test("ns['prop' + 'name']", 'ns.propname'));
});

describe('test_advanced_esm_patterns', () => {
    it("export { a } from './module.js';", () => testSame("export { a } from './module.js';"));
    it("export { a as b } from './module.js';", () => testSame("export { a as b } from './module.js';"));
    it("export * from './module.js';", () => testSame("export * from './module.js';"));
    it("export * as namespace from './module.js';", () => testSame("export * as namespace from './module.js';"));
    it("import(condition ? './a.js' : './b.js')", () =>
        test("import(condition ? './a.js' : './b.js')", "import(condition ? './a.js' : './b.js')"));
    it("import(true ? './production.js' : './development.js')", () =>
        test("import(true ? './production.js' : './development.js')", "import('./production.js')"));
    it("import(false ? './production.js' : './development.js')", () =>
        test("import(false ? './production.js' : './development.js')", "import('./development.js')"));
    it("import('./data.json', { assert: { type: 'js' + 'on' } })", () =>
        test("import('./data.json', { assert: { type: 'js' + 'on' } })", "import('./data.json', { assert: { type: 'json' } })"));
    it("import('./styles.css', { with: { type: 'cs' + 's' } })", () =>
        test("import('./styles.css', { with: { type: 'cs' + 's' } })", "import('./styles.css', { with: { type: 'css' } })"));
    it("const url = import.meta.url + '/relative';", () =>
        test("const url = import.meta.url + '/relative';", "const url = import.meta.url + '/relative';"));
    it("import.meta.resolve('./' + 'module' + '.js')", () =>
        test("import.meta.resolve('./' + 'module' + '.js')", "import.meta.resolve('./module.js')"));
    it("import.meta.resolve('module-' + (2 + 3))", () =>
        test("import.meta.resolve('module-' + (2 + 3))", "import.meta.resolve('module-5')"));
    it("const mod = await import('./' + 'dynamic' + '.js');", () =>
        test("const mod = await import('./' + 'dynamic' + '.js');", "const mod = await import('./dynamic.js');"));
    it('await (async () => 1 + 2)()', () => test('await (async () => 1 + 2)()', 'await (async () => 3)()'));
    it("if (true) { import('./conditional.js'); }", () =>
        test("if (true) { import('./conditional.js'); }", "import('./conditional.js');"));
    it("if (false) { import('./never.js'); }", () => test("if (false) { import('./never.js'); }", ''));
    it('for (const module of modules) { await import(module); }', () =>
        test('for (const module of modules) { await import(module); }', 'for (let module of modules) await import(module);'));
    it('const cache = new Map(); const getModule = (name) => cache.g', () =>
        test(
            'const cache = new Map(); const getModule = (name) => cache.get(name) ?? import(name);',
            'const cache = /* @__PURE__ */ new Map(), getModule = (name) => cache.get(name) ?? import(name);',
        ));
    it("const { ['prop' + 'name']: value } = await import('./module.", () =>
        test(
            "const { ['prop' + 'name']: value } = await import('./module.js');",
            "const { propname: value } = await import('./module.js');",
        ));
    it("if (true) import('./polyfill.js');", () => test("if (true) import('./polyfill.js');", "import('./polyfill.js');"));
    it("if (false) import('./polyfill.js');", () => test("if (false) import('./polyfill.js');", ''));
    it("const createModule = () => import('./factory.js');", () =>
        testSame("const createModule = () => import('./factory.js');"));
    it("const createModule = () => import('prefix' + 'Factory' + '.j", () =>
        test(
            "const createModule = () => import('prefix' + 'Factory' + '.js');",
            "const createModule = () => import('prefixFactory.js');",
        ));
});

describe('test_esm_module_patterns', () => {
    it("export * from './components/Button.js';", () => testSame("export * from './components/Button.js';"));
    it("export * from './components/Input.js';", () => testSame("export * from './components/Input.js';"));
    it("export { default as Button } from './components/Button.js';", () =>
        testSame("export { default as Button } from './components/Button.js';"));
    it("export const config = env === 'prod' ? prodConfig : devConfi", () =>
        test(
            "export const config = env === 'prod' ? prodConfig : devConfig;",
            "export const config = env === 'prod' ? prodConfig : devConfig;",
        ));
    it("export const isProduction = 'production' === 'production';", () =>
        test("export const isProduction = 'production' === 'production';", 'export const isProduction = !0;'));
    it('const obj = { [computedName]: value }; export { obj };', () =>
        testSame('const obj = { [computedName]: value }; export { obj };'));
    it("const obj = { ['static' + 'Name']: value }; export { obj };", () =>
        test(
            "const obj = { ['static' + 'Name']: value }; export { obj };",
            'const obj = { staticName: value }; export { obj };',
        ));
    it('export default (() => { return 1 + 2; })();', () =>
        test('export default (() => { return 1 + 2; })();', 'export default 3;'));
    it('export default (async () => { return await fetchData(); })()', () =>
        test(
            'export default (async () => { return await fetchData(); })();',
            'export default (async () => await fetchData())();',
        ));
    it("console.log('before'); import './side-effect.js'; console.lo", () =>
        testSame("console.log('before'); import './side-effect.js'; console.log('after');"));
    it('let moduleVar = 5 + 3; export { moduleVar };', () =>
        test('let moduleVar = 5 + 3; export { moduleVar };', 'let moduleVar = 8; export { moduleVar };'));
    it("const moduleConst = 'hello' + ' world'; export default modul", () =>
        test(
            "const moduleConst = 'hello' + ' world'; export default moduleConst;",
            "const moduleConst = 'hello world'; export default 'hello world';",
        ));
    it("import React from 'react';", () => testSame("import React from 'react';"));
    it("import { Component } from '@org/package';", () => testSame("import { Component } from '@org/package';"));
    it("import utils from '#internal/utils';", () => testSame("import utils from '#internal/utils';"));
    it("new Worker(new URL('./worker.js', import.meta.url));", () =>
        testSame("new Worker(new URL('./worker.js', import.meta.url));"));
    it("new Worker(new URL('./' + 'worker' + '.js', import.meta.url)", () =>
        test(
            "new Worker(new URL('./' + 'worker' + '.js', import.meta.url));",
            "new Worker(new URL('./worker.js', import.meta.url));",
        ));
    it('document.head.appendChild(Object.assign(document.createEleme', () =>
        testSame(
            "document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'modulepreload', href: './module.js' }));",
        ));
    it("const container = await window.__webpack_init_sharing__('def", () =>
        testSame("const container = await window.__webpack_init_sharing__('default');"));
    it("const factory = await container.get('./Component');", () =>
        testSame("const factory = await container.get('./Component');"));
    it('import(`./modules/${1 + 2}.js`)', () => test('import(`./modules/${1 + 2}.js`)', "import('./modules/3.js')"));
    it("export const path = `./dist/${'app' + '.js'}`;", () =>
        test("export const path = `./dist/${'app' + '.js'}`;", "export const path = './dist/app.js';"));
    it("const loader = condition ? () => import('./a.js') : () => im", () =>
        test(
            "const loader = condition ? () => import('./a.js') : () => import('./b.js');",
            "const loader = condition ? () => import('./a.js') : () => import('./b.js');",
        ));
    it("const loader = true ? () => import('./production.js') : () =", () =>
        test(
            "const loader = true ? () => import('./production.js') : () => import('./dev.js');",
            "const loader = () => import('./production.js');",
        ));
    it("import('module-' + (version || 'latest'))", () =>
        test("import('module-' + (version || 'latest'))", "import('module-' + (version || 'latest'))"));
    it("import('module-' + (2 + 3))", () => test("import('module-' + (2 + 3))", "import('module-5')"));
});

describe('test_meta_property_url_getter_side_effects', () => {
    it("Object.defineProperty(import.meta, 'url', { get() { console.", () =>
        test(
            "Object.defineProperty(import.meta, 'url', { get() { console.log('import.meta.url'); return 'virtual:' } }); import.meta.url;",
            "Object.defineProperty(import.meta, 'url', { get() { return console.log('import.meta.url'), 'virtual:'; } }), import.meta.url;",
        ));
    it('class A { constructor() { new.target.url; } } class B extend', () =>
        testSame(
            "class A { constructor() { new.target.url; } } class B extends A { static get url() { console.log('url!'); } constructor() { super(); } } new B();",
        ));
});

describe('test_bigint_edge_cases', () => {
    it('return 1n + 2n', () => test('return 1n + 2n', 'return 3n'));
    it('return 10n * 5n', () => testSame('return 10n * 5n'));
    it('return 100n / 4n', () => testSame('return 100n / 4n'));
    it('return 123n > 456n', () => test('return 123n > 456n', 'return !1'));
    it('return 456n > 123n', () => test('return 456n > 123n', 'return !0'));
    it('1n + 2', () => testSame('1n + 2'));
    it('BigInt(5) + 3', () => testSame('BigInt(5) + 3'));
});

describe('test_unicode_string_edge_cases', () => {
    it("return '\ud83d\ude80'.length", () => test("return '\ud83d\ude80'.length", 'return 2'));
    it("return '\ud835\udcbd\ud835\udc52\ud835\udcc1\ud835\udcc1\ud835\udc5c'.length", () =>
        test("return '\ud835\udcbd\ud835\udc52\ud835\udcc1\ud835\udcc1\ud835\udc5c'.length", 'return 10'));
    it("return '\\u0048\\u0065\\u006C\\u006C\\u006F'", () => testSame("return '\\u0048\\u0065\\u006C\\u006C\\u006F'"));
    it("return '\\u{1F680}'", () => testSame("return '\\u{1F680}'"));
    it("return '\u00e9' === '\\u0065\\u0301'", () => test("return '\u00e9' === '\\u0065\\u0301'", 'return !1'));
});

describe('test_performance_regression_patterns', () => {
    it('a ? b ? c ? d ? e ? f ? g ? h ? i : j : k : l : m : n : o : ', () =>
        testSame('a ? b ? c ? d ? e ? f ? g ? h ? i : j : k : l : m : n : o : p : q'));
    it('obj.prop + obj.prop + obj.prop + obj.prop + obj.prop', () =>
        testSame('obj.prop + obj.prop + obj.prop + obj.prop + obj.prop'));
    it('((((((((((a))))))))))', () => testSame('((((((((((a))))))))))'));
    it('veryLongVariableNameThatMightCauseProblemsInTheMinifier = 1;', () =>
        testSame('veryLongVariableNameThatMightCauseProblemsInTheMinifier = 1;'));
    it('const obj = {a:1,b:2,c:3,d:4,e:5,f:6,g:7,h:8,i:9,j:10,k:11,l', () =>
        testSame('const obj = {a:1,b:2,c:3,d:4,e:5,f:6,g:7,h:8,i:9,j:10,k:11,l:12,m:13,n:14,o:15,p:16,q:17,r:18,s:19,t:20}'));
});

describe('test_annotation_comments_preserved_in_dynamic_import', () => {
    it("export async function init() { const bar = 'some-url'.slice(", () =>
        test(
            "export async function init() { const bar = 'some-url'.slice(0); return await import(/* @vite-ignore */ /* webpackIgnore: true */ bar); }",
            "export async function init() { let bar = 'some-url'; return await import(/* @vite-ignore */ /* webpackIgnore: true */ 'some-url'); }",
        ));
});

describe('test_exponentiation_negative_bigint_base', () => {
    it('x = (0n + -1n) ** 2n', () => test('x = (0n + -1n) ** 2n', 'x = (-1n) ** 2n'));
    it('x = 2n ** 3n', () => testSame('x = 2n ** 3n'));
});
