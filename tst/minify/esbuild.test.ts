// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are JS source under test.
// Ported from oxc_minifier/tests/peephole/esbuild.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { test } from './harness.ts';

describe('js_parser_test', () => {
    it("x = {['_proto_']: x}", () => test("x = {['_proto_']: x}", 'x = { _proto_: x };'));
    it("x = {['__proto__']: x}", () => test("x = {['__proto__']: x}", "x = { ['__proto__']: x };"));
    it("x = { '0': y }", () => test("x = { '0': y }", 'x = { 0: y };'));
    it("x = { '123': y }", () => test("x = { '123': y }", 'x = { 123: y };'));
    it("x = { '-123': y }", () => test("x = { '-123': y }", "x = { '-123': y };"));
    it("x = { '-0': y }", () => test("x = { '-0': y }", "x = { '-0': y };"));
    it("x = { '01': y }", () => test("x = { '01': y }", "x = { '01': y };"));
    it("x = { '-01': y }", () => test("x = { '-01': y }", "x = { '-01': y };"));
    it("x = { '0x1': y }", () => test("x = { '0x1': y }", "x = { '0x1': y };"));
    it("x = { '-0x1': y }", () => test("x = { '-0x1': y }", "x = { '-0x1': y };"));
    it("x = { '2147483647': y }", () => test("x = { '2147483647': y }", 'x = { 2147483647: y };'));
    it("x = { '2147483648': y }", () => test("x = { '2147483648': y }", "x = { '2147483648': y };"));
    it("x = { '-2147483648': y }", () => test("x = { '-2147483648': y }", "x = { '-2147483648': y };"));
    it("x = { '-2147483649': y }", () => test("x = { '-2147483649': y }", "x = { '-2147483649': y };"));
    it("x.x; y['y']", () => test("x.x; y['y']", 'x.x, y.y;'));
    it("({y: y, 'z': z} = x)", () => test("({y: y, 'z': z} = x)", '({ y, z } = x);'));
    it("var {y: y, 'z': z} = x", () => test("var {y: y, 'z': z} = x", 'var { y, z } = x;'));
    it("x = {y: 1, 'z': 2}", () => test("x = {y: 1, 'z': 2}", 'x = { y: 1, z: 2 };'));
    it("x = {y() {}, 'z'() {}}", () => test("x = {y() {}, 'z'() {}}", 'x = { y() {}, z() {} };'));
    it("x = {get y() {}, set 'z'(z) {}}", () => test("x = {get y() {}, set 'z'(z) {}}", 'x = { get y() {}, set z(z) {} };'));
    it("x = class {y = 1; 'z' = 2}", () => test("x = class {y = 1; 'z' = 2}", 'x = class { y = 1; z = 2;};'));
    it("x = class {y() {}; 'z'() {}}", () => test("x = class {y() {}; 'z'() {}}", 'x = class { y() { } z() { }};'));
    it("x = class {get y() {}; set 'z'(z) {}}", () =>
        test("x = class {get y() {}; set 'z'(z) {}}", 'x = class { get y() { } set z(z) { }};'));
    it('function foo() { return undefined }', () => test('function foo() { return undefined }', 'function foo() {}'));
    it('function* foo() { return undefined }', () => test('function* foo() { return undefined }', 'function* foo() {}'));
    it('async function foo() { return undefined }', () =>
        test('async function foo() { return undefined }', 'async function foo() {}'));
    it('async function* foo() { return undefined }', () =>
        test('async function* foo() { return undefined }', 'async function* foo() { return void 0;}'));
    it('var f; function f() {}', () => test('var f; function f() {}', 'var f;function f() {}'));
    it('function f() {} var f', () => test('function f() {} var f', 'function f() {}var f;'));
    it('function f() { x() } var f; function f() { y() }', () =>
        test('function f() { x() } var f; function f() { y() }', 'function f() { x();}var f;function f() { y();}'));
    it("class Foo { ['constructor'] = 0 }", () => test("class Foo { ['constructor'] = 0 }", "class Foo { ['constructor'] = 0;}"));
    it("class Foo { ['constructor']() {} }", () =>
        test("class Foo { ['constructor']() {} }", "class Foo { ['constructor']() { }}"));
    it("class Foo { *['constructor']() {} }", () =>
        test("class Foo { *['constructor']() {} }", "class Foo { *['constructor']() { }}"));
    it("class Foo { get ['constructor']() {} }", () =>
        test("class Foo { get ['constructor']() {} }", "class Foo { get ['constructor']() { }}"));
    it("class Foo { set ['constructor'](x) {} }", () =>
        test("class Foo { set ['constructor'](x) {} }", "class Foo { set ['constructor'](x) { }}"));
    it("class Foo { async ['constructor']() {} }", () =>
        test("class Foo { async ['constructor']() {} }", "class Foo { async ['constructor']() { }}"));
    it("class Foo { static ['constructor'] = 0 }", () =>
        test("class Foo { static ['constructor'] = 0 }", "class Foo { static ['constructor'] = 0;}"));
    it("class Foo { static ['constructor']() {} }", () =>
        test("class Foo { static ['constructor']() {} }", 'class Foo { static constructor() { }}'));
    it("class Foo { static *['constructor']() {} }", () =>
        test("class Foo { static *['constructor']() {} }", 'class Foo { static *constructor() { }}'));
    it("class Foo { static get ['constructor']() {} }", () =>
        test("class Foo { static get ['constructor']() {} }", 'class Foo { static get constructor() { }}'));
    it("class Foo { static set ['constructor'](x) {} }", () =>
        test("class Foo { static set ['constructor'](x) {} }", 'class Foo { static set constructor(x) { }}'));
    it("class Foo { static async ['constructor']() {} }", () =>
        test("class Foo { static async ['constructor']() {} }", 'class Foo { static async constructor() { }}'));
    it("class Foo { ['prototype'] = 0 }", () => test("class Foo { ['prototype'] = 0 }", 'class Foo { prototype = 0;}'));
    it("class Foo { ['prototype']() {} }", () => test("class Foo { ['prototype']() {} }", 'class Foo { prototype() { }}'));
    it("class Foo { *['prototype']() {} }", () => test("class Foo { *['prototype']() {} }", 'class Foo { *prototype() { }}'));
    it("class Foo { get ['prototype']() {} }", () =>
        test("class Foo { get ['prototype']() {} }", 'class Foo { get prototype() { }}'));
    it("class Foo { set ['prototype'](x) {} }", () =>
        test("class Foo { set ['prototype'](x) {} }", 'class Foo { set prototype(x) { }}'));
    it("class Foo { async ['prototype']() {} }", () =>
        test("class Foo { async ['prototype']() {} }", 'class Foo { async prototype() { }}'));
    it("class Foo { static ['prototype'] = 0 }", () =>
        test("class Foo { static ['prototype'] = 0 }", "class Foo { static ['prototype'] = 0;}"));
    it("class Foo { static ['prototype']() {} }", () =>
        test("class Foo { static ['prototype']() {} }", "class Foo { static ['prototype']() { }}"));
    it("class Foo { static *['prototype']() {} }", () =>
        test("class Foo { static *['prototype']() {} }", "class Foo { static *['prototype']() { }}"));
    it("class Foo { static get ['prototype']() {} }", () =>
        test("class Foo { static get ['prototype']() {} }", "class Foo { static get ['prototype']() { }}"));
    it("class Foo { static set ['prototype'](x) {} }", () =>
        test("class Foo { static set ['prototype'](x) {} }", "class Foo { static set ['prototype'](x) { }}"));
    it("class Foo { static async ['prototype']() {} }", () =>
        test("class Foo { static async ['prototype']() {} }", "class Foo { static async ['prototype']() { }}"));
    it("class Foo { constructor() {} ['constructor']() {} }", () =>
        test("class Foo { constructor() {} ['constructor']() {} }", "class Foo { constructor() { } ['constructor']() { }}"));
    it("class Foo { static constructor() {} static ['constructor']()", () =>
        test(
            "class Foo { static constructor() {} static ['constructor']() {} }",
            'class Foo { static constructor() { } static constructor() { }}',
        ));
    it("class x { '0' = y }", () => test("class x { '0' = y }", 'class x { 0 = y;}'));
    it("class x { '123' = y }", () => test("class x { '123' = y }", 'class x { 123 = y;}'));
    it("class x { ['-123'] = y }", () => test("class x { ['-123'] = y }", "class x { '-123' = y;}"));
    it("class x { '-0' = y }", () => test("class x { '-0' = y }", "class x { '-0' = y;}"));
    it("class x { '01' = y }", () => test("class x { '01' = y }", "class x { '01' = y;}"));
    it("class x { '-01' = y }", () => test("class x { '-01' = y }", "class x { '-01' = y;}"));
    it("class x { '0x1' = y }", () => test("class x { '0x1' = y }", "class x { '0x1' = y;}"));
    it("class x { '-0x1' = y }", () => test("class x { '-0x1' = y }", "class x { '-0x1' = y;}"));
    it("class x { '2147483647' = y }", () => test("class x { '2147483647' = y }", 'class x { 2147483647 = y;}'));
    it("class x { '2147483648' = y }", () => test("class x { '2147483648' = y }", "class x { '2147483648' = y;}"));
    it("class x { ['-2147483648'] = y }", () => test("class x { ['-2147483648'] = y }", "class x { '-2147483648' = y;}"));
    it("class x { ['-2147483649'] = y }", () => test("class x { ['-2147483649'] = y }", "class x { '-2147483649' = y;}"));
    it('class Foo { static {} }', () => test('class Foo { static {} }', 'class Foo {}'));
    it('class Foo { static { 123 } }', () => test('class Foo { static { 123 } }', 'class Foo {}'));
    it('class Foo { static { /* @__PURE__ */ foo() } }', () =>
        test('class Foo { static { /* @__PURE__ */ foo() } }', 'class Foo {}'));
    it('class Foo { static { foo() } }', () => test('class Foo { static { foo() } }', 'class Foo { static { foo(); }}'));
    it('x: break x', () => test('x: break x', ''));
    it('x: { break x; foo() }', () => test('x: { break x; foo() }', ''));
    it('(() => {}) ? a : b', () => test('(() => {}) ? a : b', 'a;'));
    it('x = `a${1 + `b${2}c` + 3}d`', () => test('x = `a${1 + `b${2}c` + 3}d`', "x = 'a1b2c3d';"));
    it('x = `${1}`', () => test('x = `${1}`', "x = '1';"));
    it('x = `${1n}`', () => test('x = `${1n}`', "x = '1';"));
    it('x = `${null}`', () => test('x = `${null}`', "x = 'null';"));
    it('x = `${undefined}`', () => test('x = `${undefined}`', "x = 'undefined';"));
    it('x = `${false}`', () => test('x = `${false}`', "x = 'false';"));
    it('x = `${true}`', () => test('x = `${true}`', "x = 'true';"));
    it('x = 1 ? a : b', () => test('x = 1 ? a : b', 'x = a;'));
    it('x = 0 ? a : b', () => test('x = 0 ? a : b', 'x = b;'));
    it('x; 1 ? 0 : ()=>{}; (()=>{})()', () => test('x; 1 ? 0 : ()=>{}; (()=>{})()', 'x;'));
    it('x; 0 ? ()=>{} : 1; (()=>{})()', () => test('x; 0 ? ()=>{} : 1; (()=>{})()', 'x;'));
    it('if (1) 0; else ()=>{}; (()=>{})()', () => test('if (1) 0; else ()=>{}; (()=>{})()', ''));
    it('if (0) ()=>{}; else 1; (()=>{})()', () => test('if (0) ()=>{}; else 1; (()=>{})()', ''));
    it('var a; while (1) ;', () => test('var a; while (1) ;', 'for (var a;;) ;'));
    it('let a; while (1) ;', () => test('let a; while (1) ;', 'let a;for (;;) ;'));
    it('const a=0; while (1) ;', () => test('const a=0; while (1) ;', 'const a = 0;for (;;) ;'));
    it('var a; for (var b;;) ;', () => test('var a; for (var b;;) ;', 'for (var a, b;;) ;'));
    it('let a; for (let b;;) ;', () => test('let a; for (let b;;) ;', 'let a;for (let b;;) ;'));
    it('const a=0; for (const b = 1;;) ;', () => test('const a=0; for (const b = 1;;) ;', 'const a = 0;for (let b = 1;;) ;'));
    it('export var a; while (1) ;', () => test('export var a; while (1) ;', 'export var a;for (;;) ;'));
    it('export let a; while (1) ;', () => test('export let a; while (1) ;', 'export let a;for (;;) ;'));
    it('export const a=0; while (1) ;', () => test('export const a=0; while (1) ;', 'export const a = 0;for (;;) ;'));
    it('export var a; for (var b;;) ;', () => test('export var a; for (var b;;) ;', 'export var a;for (var b;;) ;'));
    it('export let a; for (let b;;) ;', () => test('export let a; for (let b;;) ;', 'export let a;for (let b;;) ;'));
    it('export const a=0; for (const b = 1;;) ;', () =>
        test('export const a=0; for (const b = 1;;) ;', 'export const a = 0;for (let b = 1;;) ;'));
    it('var a; for (let b;;) ;', () => test('var a; for (let b;;) ;', 'var a;for (let b;;) ;'));
    it('let a; for (const b=0;;) ;', () => test('let a; for (const b=0;;) ;', 'let a;for (let b = 0;;) ;'));
    it('const a=0; for (var b;;) ;', () => test('const a=0; for (var b;;) ;', 'const a = 0;for (var b;;) ;'));
    it('a(); while (1) ;', () => test('a(); while (1) ;', 'for (a();;) ;'));
    it('a(); for (b();;) ;', () => test('a(); for (b();;) ;', 'for (a(), b();;) ;'));
    it('for (; ;) if (x) break;', () => test('for (; ;) if (x) break;', 'for (; !x; ) ;'));
    it('for (; ;) if (!x) break;', () => test('for (; ;) if (!x) break;', 'for (; x; ) ;'));
    it('for (; a;) if (x) break;', () => test('for (; a;) if (x) break;', 'for (; a && !x; ) ;'));
    it('for (; a;) if (!x) break;', () => test('for (; a;) if (!x) break;', 'for (; a && x; ) ;'));
    it('for (; ;) { if (x) break; y(); }', () => test('for (; ;) { if (x) break; y(); }', 'for (; !x; ) y();'));
    it('for (; a;) { if (x) break; y(); }', () => test('for (; a;) { if (x) break; y(); }', 'for (; a && !x; ) y();'));
    it('for (; ;) if (x) break; else y();', () => test('for (; ;) if (x) break; else y();', 'for (; !x; ) y();'));
    it('for (; a;) if (x) break; else y();', () => test('for (; a;) if (x) break; else y();', 'for (; a && !x; ) y();'));
    it('for (; ;) { if (x) break; else y(); z(); }', () =>
        test('for (; ;) { if (x) break; else y(); z(); }', 'for (; !x; ) y(), z();'));
    it('for (; a;) { if (x) break; else y(); z(); }', () =>
        test('for (; a;) { if (x) break; else y(); z(); }', 'for (; a && !x; ) y(), z();'));
    it('for (; ;) if (x) y(); else break;', () => test('for (; ;) if (x) y(); else break;', 'for (; x; ) y();'));
    it('for (; ;) if (!x) y(); else break;', () => test('for (; ;) if (!x) y(); else break;', 'for (; !x; ) y();'));
    it('for (; a;) if (x) y(); else break;', () => test('for (; a;) if (x) y(); else break;', 'for (; a && x; ) y();'));
    it('for (; a;) if (!x) y(); else break;', () => test('for (; a;) if (!x) y(); else break;', 'for (; a && !x; ) y();'));
    it('for (; ;) { if (x) y(); else break; z(); }', () =>
        test('for (; ;) { if (x) y(); else break; z(); }', 'for (; x; ) y(), z()'));
    it('for (; a;) { if (x) y(); else break; z(); }', () =>
        test('for (; a;) { if (x) y(); else break; z(); }', 'for (; a && x; ) y(), z()'));
    it('while (x) { if (1) break; z(); }', () => test('while (x) { if (1) break; z(); }', 'for (; x; ) break;'));
    it('while (x) { if (1) continue; z(); }', () => test('while (x) { if (1) continue; z(); }', 'for (; x; ) ;'));
    it('foo: while (a) while (x) { if (1) continue foo; z(); }', () =>
        test('foo: while (a) while (x) { if (1) continue foo; z(); }', 'foo: for (; a; ) for (; x; ) continue foo;'));
    it('while (x) { y(); if (1) break; z(); }', () =>
        test('while (x) { y(); if (1) break; z(); }', 'for (; x; ) { y(); break;}'));
    it('while (x) { y(); if (1) continue; z(); }', () => test('while (x) { y(); if (1) continue; z(); }', 'for (; x; ) y();'));
    it('while (x) { y(); debugger; if (1) continue; z(); }', () =>
        test('while (x) { y(); debugger; if (1) continue; z(); }', 'for (; x; ) { y(); debugger; }'));
    it('while (x) { let y = z(); if (1) continue; z(); }', () =>
        test('while (x) { let y = z(); if (1) continue; z(); }', 'for (; x; ) { let y = z();}'));
    it('while (x) { debugger; if (y) { if (1) break; z() } }', () =>
        test('while (x) { debugger; if (y) { if (1) break; z() } }', 'for (; x; ) { debugger; if (y) break; }'));
    it('while (x) { debugger; if (y) { if (1) continue; z() } }', () =>
        test('while (x) { debugger; if (y) { if (1) continue; z() } }', 'for (; x; ) { debugger; y; }'));
    it('while (x) { debugger; if (1) { if (1) break; z() } }', () =>
        test('while (x) { debugger; if (1) { if (1) break; z() } }', 'for (; x; ) { debugger; break; }'));
    it('while (x) { debugger; if (1) { if (1) continue; z() } }', () =>
        test('while (x) { debugger; if (1) { if (1) continue; z() } }', 'for (; x; ) debugger;'));
    it('while (x) { y(); continue }', () => test('while (x) { y(); continue }', 'for (; x; ) y();'));
    it('while (x) { if (y) { z(); continue } }', () =>
        test('while (x) { if (y) { z(); continue } }', 'for (; x; ) if (y) { z(); continue; }'));
    it('label: while (x) while (y) { z(); continue label }', () =>
        test('label: while (x) while (y) { z(); continue label }', 'label: for (; x; ) for (; y; ) { z(); continue label;}'));
    it('while (x) { if (y) continue; z(); }', () => test('while (x) { if (y) continue; z(); }', 'for (; x; ) y || z();'));
    it('while (x) { if (y) continue; else z(); w(); }', () =>
        test('while (x) { if (y) continue; else z(); w(); }', 'for (; x; ) y || (z(), w());'));
    it('while (x) { t(); if (y) continue; z(); }', () =>
        test('while (x) { t(); if (y) continue; z(); }', 'for (; x; ) t(), !y && z();'));
    it('while (x) { t(); if (y) continue; else z(); w(); }', () =>
        test('while (x) { t(); if (y) continue; else z(); w(); }', 'for (; x; ) t(), !y && (z(), w());'));
    it('while (x) { debugger; if (y) continue; z(); }', () =>
        test('while (x) { debugger; if (y) continue; z(); }', 'for (; x; ) { debugger; y || z(); }'));
    it('while (x) { debugger; if (y) continue; else z(); w(); }', () =>
        test('while (x) { debugger; if (y) continue; else z(); w(); }', 'for (; x; ) { debugger; y || (z(), w());}'));
    it('while (x) { if (y) continue; let y }', () =>
        test('while (x) { if (y) continue; let y }', 'for (; x; ) { if (y) continue; let y; }'));
    it('while (x) { if (y) continue; var y }', () => test('while (x) { if (y) continue; var y }', 'for (; x; ) if (!y) var y; '));
    it('console.log(undefined)', () => test('console.log(undefined)', 'console.log(void 0);'));
    it('console.log(+undefined)', () => test('console.log(+undefined)', 'console.log(NaN);'));
    it('console.log(undefined + undefined)', () => test('console.log(undefined + undefined)', 'console.log(NaN);'));
    it('const x = undefined', () => test('const x = undefined', 'const x = void 0;'));
    it('let x = undefined', () => test('let x = undefined', 'let x;'));
    it('var x = undefined', () => test('var x = undefined', 'var x = void 0;'));
    it('function foo(a) { if (!a) return undefined; a() }', () =>
        test('function foo(a) { if (!a) return undefined; a() }', 'function foo(a) { a && a(); }'));
    it('delete undefined', () => test('delete undefined', 'delete undefined;'));
    it('undefined--', () => test('undefined--', 'undefined--;'));
    it('undefined++', () => test('undefined++', 'undefined++;'));
    it('--undefined', () => test('--undefined', '--undefined;'));
    it('++undefined', () => test('++undefined', '++undefined;'));
    it('undefined = 1', () => test('undefined = 1', 'undefined = 1;'));
    it('[undefined] = 1', () => test('[undefined] = 1', '[undefined] = 1;'));
    it('({x: undefined} = 1)', () => test('({x: undefined} = 1)', '({ x: undefined } = 1);'));
    it("x['y']", () => test("x['y']", 'x.y;'));
    it("x['y z']", () => test("x['y z']", "x['y z'];"));
    it("x?.['y']", () => test("x?.['y']", 'x?.y;'));
    it("x?.['y z']", () => test("x?.['y z']", "x?.['y z'];"));
    it("x?.['y']()", () => test("x?.['y']()", 'x?.y();'));
    it("x?.['y z']()", () => test("x?.['y z']()", "x?.['y z']();"));
    it("x['y' + 'z']", () => test("x['y' + 'z']", 'x.yz;'));
    it("x?.['y' + 'z']", () => test("x?.['y' + 'z']", 'x?.yz;'));
    it("x['0']", () => test("x['0']", 'x[0];'));
    it("x['123']", () => test("x['123']", 'x[123];'));
    it("x['-123']", () => test("x['-123']", 'x[-123];'));
    it("x['-0']", () => test("x['-0']", "x['-0'];"));
    it("x['01']", () => test("x['01']", "x['01'];"));
    it("x['-01']", () => test("x['-01']", "x['-01'];"));
    it("x['0x1']", () => test("x['0x1']", "x['0x1'];"));
    it("x['-0x1']", () => test("x['-0x1']", "x['-0x1'];"));
    it("x['2147483647']", () => test("x['2147483647']", 'x[2147483647];'));
    it("x['2147483648']", () => test("x['2147483648']", "x['2147483648'];"));
    it("x['-2147483648']", () => test("x['-2147483648']", 'x[-2147483648];'));
    it("x['-2147483649']", () => test("x['-2147483649']", "x['-2147483649'];"));
    it('while(1) { while (1) {} }', () => test('while(1) { while (1) {} }', 'for (;;) for (;;) ;'));
    it('while(1) { const x = y; }', () => test('while(1) { const x = y; }', 'for (;;) { let x = y;}'));
    it('while(1) { let x; }', () => test('while(1) { let x; }', 'for (;;) { let x;}'));
    it('while(1) { var x; }', () => test('while(1) { var x; }', 'for (;;) var x;'));
    it('while(1) { class X {} }', () => test('while(1) { class X {} }', 'for (;;) { class X { }}'));
    it('while(1) { function x() {} }', () => test('while(1) { function x() {} }', 'for (;;) { function x() { }}'));
    it('while(1) { function* x() {} }', () => test('while(1) { function* x() {} }', 'for (;;) { function* x() { }}'));
    it('while(1) { async function x() {} }', () =>
        test('while(1) { async function x() {} }', 'for (;;) { async function x() { }}'));
    it('while(1) { async function* x() {} }', () =>
        test('while(1) { async function* x() {} }', 'for (;;) { async function* x() { }}'));
    it('function _() { x(); switch (y) { case z: return w; } }', () =>
        test('function _() { x(); switch (y) { case z: return w; } }', 'function _() { switch (x(), y) { case z:  return w; }}'));
    it('function _() { if (t) { x(); switch (y) { case z: return w; ', () =>
        test(
            'function _() { if (t) { x(); switch (y) { case z: return w; } } }',
            'function _() { if (t) switch (x(), y) { case z:  return w; } }',
        ));
    it("a = '' + 0", () => test("a = '' + 0", "a = '0';"));
    it("a = 0 + ''", () => test("a = 0 + ''", "a = '0';"));
    it("a = '' + b", () => test("a = '' + b", "a = '' + b;"));
    it("a = b + ''", () => test("a = b + ''", "a = b + '';"));
    it('a = [] + 0', () => test('a = [] + 0', "a = '0';"));
    it('a = 0 + []', () => test('a = 0 + []', "a = '0';"));
    it('a = [] + b', () => test('a = [] + b', 'a = [] + b;'));
    it('a = b + []', () => test('a = b + []', 'a = b + [];'));
    it('a = [b] + 0', () => test('a = [b] + 0', 'a = [b] + 0;'));
    it('a = 0 + [b]', () => test('a = 0 + [b]', 'a = 0 + [b];'));
    it("a = [1, 2] + ''", () => test("a = [1, 2] + ''", "a = '1,2';"));
    it("a = [1, 0, 2] + ''", () => test("a = [1, 0, 2] + ''", "a = '1,0,2';"));
    it("a = [1, null, 2] + ''", () => test("a = [1, null, 2] + ''", "a = '1,,2';"));
    it("a = [1, undefined, 2] + ''", () => test("a = [1, undefined, 2] + ''", "a = '1,,2';"));
    it("a = [1, true, 2] + ''", () => test("a = [1, true, 2] + ''", "a = '1,true,2';"));
    it("a = [1, false, 2] + ''", () => test("a = [1, false, 2] + ''", "a = '1,false,2';"));
    it("a = [1, , 2] + ''", () => test("a = [1, , 2] + ''", "a = '1,,2';"));
    it("a = [1, , ,] + ''", () => test("a = [1, , ,] + ''", "a = '1,,';"));
    it('a = {} + 0', () => test('a = {} + 0', "a = '[object Object]0';"));
    it('a = 0 + {}', () => test('a = 0 + {}', "a = '0[object Object]';"));
    it('a = {} + b', () => test('a = {} + b', 'a = {} + b;'));
    it('a = b + {}', () => test('a = b + {}', 'a = b + {};'));
    it('a = {toString:()=>1} + 0', () => test('a = {toString:()=>1} + 0', 'a = { toString: () => 1 } + 0;'));
    it('a = 0 + {toString:()=>1}', () => test('a = 0 + {toString:()=>1}', 'a = 0 + { toString: () => 1 };'));
    it("a = '' + `${b}`", () => test("a = '' + `${b}`", 'a = `${b}`;'));
    it("a = `${b}` + ''", () => test("a = `${b}` + ''", 'a = `${b}`;'));
    it("a = '' + typeof b", () => test("a = '' + typeof b", 'a = typeof b;'));
    it("a = typeof b + ''", () => test("a = typeof b + ''", 'a = typeof b;'));
    it('a = [] + `${b}`', () => test('a = [] + `${b}`', 'a = `${b}`;'));
    it('a = `${b}` + []', () => test('a = `${b}` + []', 'a = `${b}`;'));
    it('a = [] + typeof b', () => test('a = [] + typeof b', 'a = typeof b;'));
    it('a = typeof b + []', () => test('a = typeof b + []', 'a = typeof b;'));
    it('a = [b] + `${b}`', () => test('a = [b] + `${b}`', 'a = [b] + `${b}`;'));
    it('a = `${b}` + [b]', () => test('a = `${b}` + [b]', 'a = `${b}` + [b];'));
    it('a = {} + `${b}`', () => test('a = {} + `${b}`', 'a = `[object Object]${b}`;'));
    it('a = `${b}` + {}', () => test('a = `${b}` + {}', 'a = `${b}[object Object]`;'));
    it('a = {} + typeof b', () => test('a = {} + typeof b', 'a = {} + typeof b;'));
    it('a = typeof b + {}', () => test('a = typeof b + {}', 'a = typeof b + {};'));
    it('a = {toString:()=>1} + `${b}`', () => test('a = {toString:()=>1} + `${b}`', 'a = { toString: () => 1 } + `${b}`;'));
    it('a = `${b}` + {toString:()=>1}', () => test('a = `${b}` + {toString:()=>1}', 'a = `${b}` + { toString: () => 1 };'));
    it("a = '' + false", () => test("a = '' + false", "a = 'false';"));
    it("a = '' + true", () => test("a = '' + true", "a = 'true';"));
    it("a = false + ''", () => test("a = false + ''", "a = 'false';"));
    it("a = true + ''", () => test("a = true + ''", "a = 'true';"));
    it("a = 1 + false + ''", () => test("a = 1 + false + ''", "a = '1';"));
    it("a = 0 + true + ''", () => test("a = 0 + true + ''", "a = '1';"));
    it("a = '' + null", () => test("a = '' + null", "a = 'null';"));
    it("a = null + ''", () => test("a = null + ''", "a = 'null';"));
    it("a = '' + undefined", () => test("a = '' + undefined", "a = 'undefined';"));
    it("a = undefined + ''", () => test("a = undefined + ''", "a = 'undefined';"));
    it("a = '' + 0n", () => test("a = '' + 0n", "a = '0';"));
    it("a = '' + 1n", () => test("a = '' + 1n", "a = '1';"));
    it("a = '' + 123n", () => test("a = '' + 123n", "a = '123';"));
    it("a = '' + 1_2_3n", () => test("a = '' + 1_2_3n", "a = '123';"));
    it("a = '' + 0b0n", () => test("a = '' + 0b0n", "a = '0';"));
    it("a = '' + 0o0n", () => test("a = '' + 0o0n", "a = '0';"));
    it("a = '' + 0x0n", () => test("a = '' + 0x0n", "a = '0';"));
    it("a = '' + /a\\b/ig", () => test("a = '' + /a\\b/ig", "a = '/a\\\\b/ig';"));
    it("a = /a\\b/ig + ''", () => test("a = /a\\b/ig + ''", "a = '/a\\\\b/ig';"));
    it("''.length++", () => test("''.length++", "''.length++;"));
    it("''.length = a", () => test("''.length = a", "''.length = a;"));
    it("a = ''.len", () => test("a = ''.len", "a = ''.len;"));
    it('a = [].length', () => test('a = [].length', 'a = 0;'));
    it("a = ''.length", () => test("a = ''.length", 'a = 0;'));
    it('a = ``.length', () => test('a = ``.length', 'a = 0;'));
    it('a = b``.length', () => test('a = b``.length', 'a = b``.length;'));
    it("a = 'abc'.length", () => test("a = 'abc'.length", 'a = 3;'));
    it("a = '\u0227\u1e03\u010b'.length", () => test("a = '\u0227\u1e03\u010b'.length", 'a = 3;'));
    it("a = '\ud83d\udc6f\u200d\u2642\ufe0f'.length", () => test("a = '\ud83d\udc6f\u200d\u2642\ufe0f'.length", 'a = 5;'));
    it("a = 'abc'[-1]", () => test("a = 'abc'[-1]", "a = 'abc'[-1];"));
    it("a = 'abc'[-0]", () => test("a = 'abc'[-0]", "a = 'a';"));
    it("a = 'abc'[0]", () => test("a = 'abc'[0]", "a = 'a';"));
    it("a = 'abc'[2]", () => test("a = 'abc'[2]", "a = 'c';"));
    it("a = 'abc'[3]", () => test("a = 'abc'[3]", "a = 'abc'[3];"));
    it("a = 'abc'[NaN]", () => test("a = 'abc'[NaN]", "a = 'abc'[NaN];"));
    it("a = 'abc'[-1e100]", () => test("a = 'abc'[-1e100]", "a = 'abc'[-1e100];"));
    it("a = 'abc'[1e100]", () => test("a = 'abc'[1e100]", "a = 'abc'[1e100];"));
    it("a = 'abc'[-Infinity]", () => test("a = 'abc'[-Infinity]", "a = 'abc'[-Infinity];"));
    it("a = 'abc'[Infinity]", () => test("a = 'abc'[Infinity]", "a = 'abc'[Infinity];"));
    it('a = !(b == c)', () => test('a = !(b == c)', 'a = b != c;'));
    it('a = !(b != c)', () => test('a = !(b != c)', 'a = b == c;'));
    it('a = !(b === c)', () => test('a = !(b === c)', 'a = b !== c;'));
    it('a = !(b !== c)', () => test('a = !(b !== c)', 'a = b === c;'));
    it('function _() { if (!(a, b)) return c }', () =>
        test('function _() { if (!(a, b)) return c }', 'function _() { if (a, !b) return c; }'));
    it('a = !(b < c)', () => test('a = !(b < c)', 'a = !(b < c);'));
    it('a = !(b > c)', () => test('a = !(b > c)', 'a = !(b > c);'));
    it('a = !(b <= c)', () => test('a = !(b <= c)', 'a = !(b <= c);'));
    it('a = !(b >= c)', () => test('a = !(b >= c)', 'a = !(b >= c);'));
    it('a = !!b', () => test('a = !!b', 'a = !!b;'));
    it('a = !!!b', () => test('a = !!!b', 'a = !b;'));
    it('a = !!-b', () => test('a = !!-b', 'a = !!-b;'));
    it('a = !!void b', () => test('a = !!void b', 'a = !!void b;'));
    it('a = !!delete b', () => test('a = !!delete b', 'a = delete b;'));
    it('a = !!(b + c)', () => test('a = !!(b + c)', 'a = !!(b + c);'));
    it('a = !!(b == c)', () => test('a = !!(b == c)', 'a = b == c;'));
    it('a = !!(b != c)', () => test('a = !!(b != c)', 'a = b != c;'));
    it('a = !!(b === c)', () => test('a = !!(b === c)', 'a = b === c;'));
    it('a = !!(b !== c)', () => test('a = !!(b !== c)', 'a = b !== c;'));
    it('a = !!(b < c)', () => test('a = !!(b < c)', 'a = b < c;'));
    it('a = !!(b > c)', () => test('a = !!(b > c)', 'a = b > c;'));
    it('a = !!(b <= c)', () => test('a = !!(b <= c)', 'a = b <= c;'));
    it('a = !!(b >= c)', () => test('a = !!(b >= c)', 'a = b >= c;'));
    it('a = !!(b in c)', () => test('a = !!(b in c)', 'a = b in c;'));
    it('a = !!(b instanceof c)', () => test('a = !!(b instanceof c)', 'a = b instanceof c;'));
    it('a = !!(b && c)', () => test('a = !!(b && c)', 'a = !!(b && c);'));
    it('a = !!(b || c)', () => test('a = !!(b || c)', 'a = !!(b || c);'));
    it('a = !!(b ?? c)', () => test('a = !!(b ?? c)', 'a = !!(b ?? c);'));
    it('a = !!(!b && c)', () => test('a = !!(!b && c)', 'a = !!(!b && c);'));
    it('a = !!(!b || c)', () => test('a = !!(!b || c)', 'a = !!(!b || c);'));
    it('a = !!(!b ?? c)', () => test('a = !!(!b ?? c)', 'a = !b;'));
    it('a = !!(b && !c)', () => test('a = !!(b && !c)', 'a = !!(b && !c);'));
    it('a = !!(b || !c)', () => test('a = !!(b || !c)', 'a = !!(b || !c);'));
    it('a = !!(b ?? !c)', () => test('a = !!(b ?? !c)', 'a = !!(b ?? !c);'));
    it('a = !!(!b && !c)', () => test('a = !!(!b && !c)', 'a = !b && !c;'));
    it('a = !!(!b || !c)', () => test('a = !!(!b || !c)', 'a = !b || !c;'));
    it('a = !!(!b ?? !c)', () => test('a = !!(!b ?? !c)', 'a = !b;'));
    it('a = !!(b, c)', () => test('a = !!(b, c)', 'a = (b, !!c);'));
    it('a = Boolean(b); var Boolean', () => test('a = Boolean(b); var Boolean', 'a = Boolean(b);var Boolean;'));
    it('a = Boolean()', () => test('a = Boolean()', 'a = !1;'));
    it('a = Boolean(b)', () => test('a = Boolean(b)', 'a = !!b;'));
    it('a = Boolean(!b)', () => test('a = Boolean(!b)', 'a = !b;'));
    it('a = Boolean(!!b)', () => test('a = Boolean(!!b)', 'a = !!b;'));
    it('a = Boolean(b ? true : false)', () => test('a = Boolean(b ? true : false)', 'a = !!b;'));
    it('a = Boolean(b ? false : true)', () => test('a = Boolean(b ? false : true)', 'a = !b;'));
    it('a = Boolean(b ? c > 0 : c < 0)', () => test('a = Boolean(b ? c > 0 : c < 0)', 'a = b ? c > 0 : c < 0;'));
    it('a = Boolean((b | +c) !== 0)', () => test('a = Boolean((b | +c) !== 0)', 'a = !!(b | +c);'));
    it('a = Boolean(b ? (c | +d) !== 0 : (d | +e) !== 0)', () =>
        test('a = Boolean(b ? (c | +d) !== 0 : (d | +e) !== 0)', 'a = !!(b ? c | +d : d | +e);'));
    it('a = Number(x)', () => test('a = Number(x)', 'a = Number(x);'));
    it('a = Number(0n)', () => test('a = Number(0n)', 'a = Number(0n);'));
    it('a = Number(false); var Number', () => test('a = Number(false); var Number', 'a = Number(!1);var Number;'));
    it('a = Number(0xFFFF_FFFF_FFFF_FFFFn)', () =>
        test('a = Number(0xFFFF_FFFF_FFFF_FFFFn)', 'a = Number(0xFFFFFFFFFFFFFFFFn);'));
    it('a = Number()', () => test('a = Number()', 'a = 0;'));
    it('a = Number(-123)', () => test('a = Number(-123)', 'a = -123;'));
    it('a = Number(false)', () => test('a = Number(false)', 'a = 0;'));
    it('a = Number(true)', () => test('a = Number(true)', 'a = 1;'));
    it('a = Number(undefined)', () => test('a = Number(undefined)', 'a = NaN;'));
    it('a = Number(null)', () => test('a = Number(null)', 'a = 0;'));
    it('a = String(x)', () => test('a = String(x)', 'a = String(x);'));
    it("a = String('x'); var String", () => test("a = String('x'); var String", "a = String('x');var String;"));
    it('a = String()', () => test('a = String()', "a = '';"));
    it("a = String('x')", () => test("a = String('x')", "a = 'x';"));
    it('a = BigInt(x)', () => test('a = BigInt(x)', 'a = BigInt(x);'));
    it('a = BigInt(0n); var BigInt', () => test('a = BigInt(0n); var BigInt', 'a = BigInt(0n);var BigInt;'));
    it('a = BigInt()', () => test('a = BigInt()', 'a = BigInt();'));
    it("a = BigInt('0')", () => test("a = BigInt('0')", "a = BigInt('0');"));
    it('a = BigInt(0n)', () => test('a = BigInt(0n)', 'a = 0n;'));
    it("a = 'xy'.charCodeAt()", () => test("a = 'xy'.charCodeAt()", 'a = 120;'));
    it("a = 'xy'.charCodeAt(0)", () => test("a = 'xy'.charCodeAt(0)", 'a = 120;'));
    it("a = 'xy'.charCodeAt(1)", () => test("a = 'xy'.charCodeAt(1)", 'a = 121;'));
    it("a = 'xy'.charCodeAt(-1)", () => test("a = 'xy'.charCodeAt(-1)", 'a = NaN;'));
    it("a = 'xy'.charCodeAt(2)", () => test("a = 'xy'.charCodeAt(2)", 'a = NaN;'));
    it("a = '\ud83e\uddc0'.charCodeAt()", () => test("a = '\ud83e\uddc0'.charCodeAt()", 'a = 55358;'));
    it("a = '\ud83e\uddc0'.charCodeAt(0)", () => test("a = '\ud83e\uddc0'.charCodeAt(0)", 'a = 55358;'));
    it("a = '\ud83e\uddc0'.charCodeAt(1)", () => test("a = '\ud83e\uddc0'.charCodeAt(1)", 'a = 56768;'));
    it("a = '\ud83e\uddc0'.charCodeAt(-1)", () => test("a = '\ud83e\uddc0'.charCodeAt(-1)", 'a = NaN;'));
    it("a = '\ud83e\uddc0'.charCodeAt(2)", () => test("a = '\ud83e\uddc0'.charCodeAt(2)", 'a = NaN;'));
    it("a = 'xy'.charCodeAt(NaN)", () => test("a = 'xy'.charCodeAt(NaN)", 'a = 120;'));
    it("a = 'xy'.charCodeAt(-Infinity)", () => test("a = 'xy'.charCodeAt(-Infinity)", 'a = NaN;'));
    it("a = 'xy'.charCodeAt(Infinity)", () => test("a = 'xy'.charCodeAt(Infinity)", 'a = NaN;'));
    it("a = 'xy'.charCodeAt(0.5)", () => test("a = 'xy'.charCodeAt(0.5)", 'a = 120;'));
    it("a = 'xy'.charCodeAt(1e99)", () => test("a = 'xy'.charCodeAt(1e99)", 'a = NaN;'));
    it("a = 'xy'.charCodeAt('1')", () => test("a = 'xy'.charCodeAt('1')", 'a = 121;'));
    it("a = 'xy'.charCodeAt(1, 2)", () => test("a = 'xy'.charCodeAt(1, 2)", 'a = 121;'));
    it('a = String.fromCharCode()', () => test('a = String.fromCharCode()', "a = '';"));
    it('a = String.fromCharCode(0)', () => test('a = String.fromCharCode(0)', "a = '\\0';"));
    it('a = String.fromCharCode(120)', () => test('a = String.fromCharCode(120)', "a = 'x';"));
    it('a = String.fromCharCode(120, 121)', () => test('a = String.fromCharCode(120, 121)', "a = 'xy';"));
    it('a = String.fromCharCode(0x10000)', () => test('a = String.fromCharCode(0x10000)', "a = '\\0';"));
    it('a = String.fromCharCode(0x10078, 0x10079)', () => test('a = String.fromCharCode(0x10078, 0x10079)', "a = 'xy';"));
    it('a = String.fromCharCode(0x1_0000_FFFF)', () => test('a = String.fromCharCode(0x1_0000_FFFF)', "a = '\uffff';"));
    it('a = String.fromCharCode(NaN)', () => test('a = String.fromCharCode(NaN)', "a = '\\0';"));
    it('a = String.fromCharCode(-Infinity)', () => test('a = String.fromCharCode(-Infinity)', "a = '\\0';"));
    it('a = String.fromCharCode(Infinity)', () => test('a = String.fromCharCode(Infinity)', "a = '\\0';"));
    it('a = String.fromCharCode(null)', () => test('a = String.fromCharCode(null)', "a = '\\0';"));
    it('a = String.fromCharCode(undefined)', () => test('a = String.fromCharCode(undefined)', "a = '\\0';"));
    it("a = String.fromCharCode('123')", () => test("a = String.fromCharCode('123')", "a = '{';"));
    it('a = String.fromCharCode(x)', () => test('a = String.fromCharCode(x)', 'a = String.fromCharCode(x);'));
    it("a = String.fromCharCode('x')", () => test("a = String.fromCharCode('x')", "a = '\\0';"));
    it("a = String.fromCharCode('0.5')", () => test("a = String.fromCharCode('0.5')", "a = '\\0';"));
    it('a = false.toString()', () => test('a = false.toString()', "a = 'false';"));
    it('a = true.toString()', () => test('a = true.toString()', "a = 'true';"));
    it("a = 'xy'.toString()", () => test("a = 'xy'.toString()", "a = 'xy';"));
    it('a = 0 .toString()', () => test('a = 0 .toString()', "a = '0';"));
    it('a = (-0).toString()', () => test('a = (-0).toString()', "a = '0';"));
    it('a = 123 .toString()', () => test('a = 123 .toString()', "a = '123';"));
    it('a = (-123).toString()', () => test('a = (-123).toString()', "a = '-123';"));
    it('a = NaN.toString()', () => test('a = NaN.toString()', "a = 'NaN';"));
    it('a = Infinity.toString()', () => test('a = Infinity.toString()', "a = 'Infinity';"));
    it('a = (-Infinity).toString()', () => test('a = (-Infinity).toString()', "a = '-Infinity';"));
    it('a = /a\\b/ig.toString()', () => test('a = /a\\b/ig.toString()', "a = '/a\\\\b/ig';"));
    it('a = 100 .toString(0)', () => test('a = 100 .toString(0)', 'a = 100 .toString(0);'));
    it('a = 100 .toString(1)', () => test('a = 100 .toString(1)', 'a = 100 .toString(1);'));
    it('a = 100 .toString(2)', () => test('a = 100 .toString(2)', "a = '1100100';"));
    it('a = 100 .toString(5)', () => test('a = 100 .toString(5)', "a = '400';"));
    it('a = 100 .toString(8)', () => test('a = 100 .toString(8)', "a = '144';"));
    it('a = 100 .toString(13)', () => test('a = 100 .toString(13)', "a = '79';"));
    it('a = 100 .toString(16)', () => test('a = 100 .toString(16)', "a = '64';"));
    it('a = 10000 .toString(19)', () => test('a = 10000 .toString(19)', "a = '18d6';"));
    it('a = 10000 .toString(23)', () => test('a = 10000 .toString(23)', "a = 'iki';"));
    it('a = 1000000 .toString(29)', () => test('a = 1000000 .toString(29)', "a = '1c01m';"));
    it('a = 1000000 .toString(31)', () => test('a = 1000000 .toString(31)', "a = '12hi2';"));
    it('a = 1000000 .toString(36)', () => test('a = 1000000 .toString(36)', "a = 'lfls';"));
    it('a = 0 .toString(36)', () => test('a = 0 .toString(36)', "a = '0';"));
    it('a = (-0).toString(36)', () => test('a = (-0).toString(36)', "a = '0';"));
    it('a = false.toString(b)', () => test('a = false.toString(b)', 'a = (!1).toString(b);'));
    it('a = true.toString(b)', () => test('a = true.toString(b)', 'a = (!0).toString(b);'));
    it("a = 'xy'.toString(b)", () => test("a = 'xy'.toString(b)", "a = 'xy'.toString(b);"));
    it('a = 123 .toString(b)', () => test('a = 123 .toString(b)', 'a = 123 .toString(b);'));
    it('a = 0.5.toString()', () => test('a = 0.5.toString()', "a = '0.5';"));
    it('a = 1e99.toString(b)', () => test('a = 1e99.toString(b)', 'a = 1e99.toString(b);'));
    it('a = /./.toString(b)', () => test('a = /./.toString(b)', 'a = /./.toString(b);'));
    it('1 ? a() : b()', () => test('1 ? a() : b()', 'a();'));
    it('0 ? a() : b()', () => test('0 ? a() : b()', 'b();'));
    it('a ? a : b', () => test('a ? a : b', 'a || b;'));
    it('a ? b : a', () => test('a ? b : a', 'a && b;'));
    it('a.x ? a.x : b', () => test('a.x ? a.x : b', 'a.x ? a.x : b;'));
    it('a.x ? b : a.x', () => test('a.x ? b : a.x', 'a.x ? b : a.x;'));
    it('a ? b() : c()', () => test('a ? b() : c()', 'a ? b() : c();'));
    it('!a ? b() : c()', () => test('!a ? b() : c()', 'a ? c() : b();'));
    it('!!a ? b() : c()', () => test('!!a ? b() : c()', 'a ? b() : c();'));
    it('!!!a ? b() : c()', () => test('!!!a ? b() : c()', 'a ? c() : b();'));
    it('if (1) a(); else b()', () => test('if (1) a(); else b()', 'a();'));
    it('if (0) a(); else b()', () => test('if (0) a(); else b()', 'b();'));
    it('if (a) b(); else c()', () => test('if (a) b(); else c()', 'a ? b() : c();'));
    it('if (!a) b(); else c()', () => test('if (!a) b(); else c()', 'a ? c() : b();'));
    it('if (!!a) b(); else c()', () => test('if (!!a) b(); else c()', 'a ? b() : c();'));
    it('if (!!!a) b(); else c()', () => test('if (!!!a) b(); else c()', 'a ? c() : b();'));
    it('if (1) a()', () => test('if (1) a()', 'a();'));
    it('if (0) a()', () => test('if (0) a()', ''));
    it('if (a) b()', () => test('if (a) b()', 'a && b();'));
    it('if (!a) b()', () => test('if (!a) b()', 'a || b();'));
    it('if (!!a) b()', () => test('if (!!a) b()', 'a && b();'));
    it('if (!!!a) b()', () => test('if (!!!a) b()', 'a || b();'));
    it('if (1) {} else a()', () => test('if (1) {} else a()', ''));
    it('if (0) {} else a()', () => test('if (0) {} else a()', 'a();'));
    it('if (a) {} else b()', () => test('if (a) {} else b()', 'a || b();'));
    it('if (!a) {} else b()', () => test('if (!a) {} else b()', 'a && b();'));
    it('if (!!a) {} else b()', () => test('if (!!a) {} else b()', 'a || b();'));
    it('if (!!!a) {} else b()', () => test('if (!!!a) {} else b()', 'a && b();'));
    it('if (a) {} else throw b', () => test('if (a) {} else throw b', 'if (!a) throw b;'));
    it('if (!a) {} else throw b', () => test('if (!a) {} else throw b', 'if (a) throw b;'));
    it('a(); if (b) throw c', () => test('a(); if (b) throw c', 'if (a(), b) throw c;'));
    it('if (a) if (b) throw c', () => test('if (a) if (b) throw c', 'if (a && b) throw c;'));
    it('if (true) { let a = b; if (c) throw d }', () =>
        test('if (true) { let a = b; if (c) throw d }', '{ let a = b; if (c) throw d;}'));
    it('if (true) { if (a) throw b; if (c) throw d }', () =>
        test('if (true) { if (a) throw b; if (c) throw d }', 'if (a) throw b;if (c) throw d;'));
    it('if (false) throw a; else { let b = c; if (d) throw e }', () =>
        test('if (false) throw a; else { let b = c; if (d) throw e }', '{ let b = c; if (d) throw e;}'));
    it('if (false) throw a; else { if (b) throw c; if (d) throw e }', () =>
        test('if (false) throw a; else { if (b) throw c; if (d) throw e }', 'if (b) throw c;if (d) throw e;'));
    it('if (a) { if (b) throw c; else { let d = e; if (f) throw g } ', () =>
        test(
            'if (a) { if (b) throw c; else { let d = e; if (f) throw g } }',
            'if (a) { if (b) throw c; { let d = e; if (f) throw g; }}',
        ));
    it('if (a) { if (b) throw c; else if (d) throw e; else if (f) th', () =>
        test(
            'if (a) { if (b) throw c; else if (d) throw e; else if (f) throw g }',
            'if (a) { if (b) throw c; if (d) throw e; if (f) throw g;}',
        ));
    it('a = b ? true : false', () => test('a = b ? true : false', 'a = !!b;'));
    it('a = b ? false : true', () => test('a = b ? false : true', 'a = !b;'));
    it('a = !b ? true : false', () => test('a = !b ? true : false', 'a = !b;'));
    it('a = !b ? false : true', () => test('a = !b ? false : true', 'a = !!b;'));
    it('a = b == c ? true : false', () => test('a = b == c ? true : false', 'a = b == c;'));
    it('a = b != c ? true : false', () => test('a = b != c ? true : false', 'a = b != c;'));
    it('a = b === c ? true : false', () => test('a = b === c ? true : false', 'a = b === c;'));
    it('a = b !== c ? true : false', () => test('a = b !== c ? true : false', 'a = b !== c;'));
    it('a ? b(c) : b(d)', () => test('a ? b(c) : b(d)', 'a ? b(c) : b(d);'));
    it('let a = foo(); a ? b(c) : b(d)', () => test('let a = foo(); a ? b(c) : b(d)', 'foo() ? b(c) : b(d);'));
    it('let a = foo(), b = bar(); a ? b(c) : b(d)', () =>
        test('let a = foo(), b = bar(); a ? b(c) : b(d)', 'let a = foo(); bar()(a ? c : d);'));
    it('let a = foo(), b = bar(); a ? b(c, 0) : b(d)', () =>
        test('let a = foo(), b = bar(); a ? b(c, 0) : b(d)', 'let a = foo(), b = bar(); a ? b(c, 0) : b(d);'));
    it('let a = foo(), b = bar(); a ? b(c) : b(d, 0)', () =>
        test('let a = foo(), b = bar(); a ? b(c) : b(d, 0)', 'let a = foo(), b = bar(); a ? b(c) : b(d, 0);'));
    it('let a = foo(), b = bar(); a ? b(c, 0) : b(d, 1)', () =>
        test('let a = foo(), b = bar(); a ? b(c, 0) : b(d, 1)', 'let a = foo(), b = bar(); a ? b(c, 0) : b(d, 1);'));
    it('let a = foo(), b = bar(); a ? b(c, 0) : b(d, 0)', () =>
        test('let a = foo(), b = bar(); a ? b(c, 0) : b(d, 0)', 'let a = foo(); bar()(a ? c : d, 0);'));
    it('let a = foo(), b = bar(); a ? b(...c) : b(d)', () =>
        test('let a = foo(), b = bar(); a ? b(...c) : b(d)', 'let a = foo(), b = bar(); a ? b(...c) : b(d);'));
    it('let a = foo(), b = bar(); a ? b(c) : b(...d)', () =>
        test('let a = foo(), b = bar(); a ? b(c) : b(...d)', 'let a = foo(), b = bar(); a ? b(c) : b(...d);'));
    it('let a = foo(), b = bar(); a ? b(...c) : b(...d)', () =>
        test('let a = foo(), b = bar(); a ? b(...c) : b(...d)', 'let a = foo(); bar()(...a ? c : d);'));
    it('let a = foo(), b = bar(); a ? b(a) : b(c)', () =>
        test('let a = foo(), b = bar(); a ? b(a) : b(c)', 'let a = foo(); bar()(a || c);'));
    it('let a = foo(), b = bar(); a ? b(c) : b(a)', () =>
        test('let a = foo(), b = bar(); a ? b(c) : b(a)', 'let a = foo(); bar()(a && c);'));
    it('let a = foo(), b = bar(); a ? b(...a) : b(...c)', () =>
        test('let a = foo(), b = bar(); a ? b(...a) : b(...c)', 'let a = foo(); bar()(...a || c);'));
    it('let a = foo(), b = bar(); a ? b(...c) : b(...a)', () =>
        test('let a = foo(), b = bar(); a ? b(...c) : b(...a)', 'let a = foo(); bar()(...a && c);'));
    it('let a = foo(); a.x ? b(c) : b(d)', () => test('let a = foo(); a.x ? b(c) : b(d)', 'foo().x ? b(c) : b(d);'));
    it('let a = foo(), b = bar(); a.x ? b(c) : b(d)', () =>
        test('let a = foo(), b = bar(); a.x ? b(c) : b(d)', 'let a = foo(), b = bar(); a.x ? b(c) : b(d);'));
    it('let a = foo(), b = bar(); a ? b.y(c) : b.y(d)', () =>
        test('let a = foo(), b = bar(); a ? b.y(c) : b.y(d)', 'let a = foo(), b = bar(); a ? b.y(c) : b.y(d);'));
    it('let a = foo(), b = bar(); a.x ? b.y(c) : b.y(d)', () =>
        test('let a = foo(), b = bar(); a.x ? b.y(c) : b.y(d)', 'let a = foo(), b = bar(); a.x ? b.y(c) : b.y(d);'));
    it('a ? b : c ? b : d', () => test('a ? b : c ? b : d', 'a || c ? b : d;'));
    it('a ? b ? c : d : d', () => test('a ? b ? c : d : d', 'a && b ? c : d;'));
    it('a ? c : (b, c)', () => test('a ? c : (b, c)', 'a || b, c;'));
    it('a ? (b, c) : c', () => test('a ? (b, c) : c', 'a && b, c;'));
    it('a ? c : (b, d)', () => test('a ? c : (b, d)', 'a ? c : (b, d);'));
    it('a ? (b, c) : d', () => test('a ? (b, c) : d', 'a ? (b, c) : d;'));
    it('a ? b || c : c', () => test('a ? b || c : c', 'a && b || c;'));
    it('a ? b || c : d', () => test('a ? b || c : d', 'a ? b || c : d;'));
    it('a ? b && c : c', () => test('a ? b && c : c', 'a ? b && c : c;'));
    it('a ? c : b && c', () => test('a ? c : b && c', '(a || b) && c;'));
    it('a ? c : b && d', () => test('a ? c : b && d', 'a ? c : b && d;'));
    it('a ? c : b || c', () => test('a ? c : b || c', 'a ? c : b || c;'));
    it('a = b == null ? c : b', () => test('a = b == null ? c : b', 'a = b == null ? c : b;'));
    it('a = b != null ? b : c', () => test('a = b != null ? b : c', 'a = b == null ? c : b;'));
    it('let b = foo(); a = b == null ? c : b', () => test('let b = foo(); a = b == null ? c : b', 'a = foo() ?? c;'));
    it('let b = foo(); a = b != null ? b : c', () => test('let b = foo(); a = b != null ? b : c', 'a = foo() ?? c;'));
    it('let b = foo(); a = b == null ? b : c', () =>
        test('let b = foo(); a = b == null ? b : c', 'let b = foo(); a = b == null ? b : c;'));
    it('let b = foo(); a = b != null ? c : b', () =>
        test('let b = foo(); a = b != null ? c : b', 'let b = foo(); a = b == null ? b : c;'));
    it('let b = foo(); a = null == b ? c : b', () => test('let b = foo(); a = null == b ? c : b', 'a = foo() ?? c;'));
    it('let b = foo(); a = null != b ? b : c', () => test('let b = foo(); a = null != b ? b : c', 'a = foo() ?? c;'));
    it('let b = foo(); a = null == b ? b : c', () =>
        test('let b = foo(); a = null == b ? b : c', 'let b = foo(); a = b == null ? b : c;'));
    it('let b = foo(); a = null != b ? c : b', () =>
        test('let b = foo(); a = null != b ? c : b', 'let b = foo(); a = b == null ? b : c;'));
    it('let b = foo(); a = b.x == null ? c : b.x', () =>
        test('let b = foo(); a = b.x == null ? c : b.x', 'let b = foo(); a = b.x == null ? c : b.x;'));
    it('let b = foo(); a = b.x != null ? b.x : c', () =>
        test('let b = foo(); a = b.x != null ? b.x : c', 'let b = foo(); a = b.x == null ? c : b.x;'));
    it('let b = foo(); a = null == b.x ? c : b.x', () =>
        test('let b = foo(); a = null == b.x ? c : b.x', 'let b = foo(); a = b.x == null ? c : b.x;'));
    it('let b = foo(); a = null != b.x ? b.x : c', () =>
        test('let b = foo(); a = null != b.x ? b.x : c', 'let b = foo(); a = b.x == null ? c : b.x;'));
    it('let b = foo(); a = b === null ? c : b', () =>
        test('let b = foo(); a = b === null ? c : b', 'let b = foo(); a = b === null ? c : b;'));
    it('let b = foo(); a = b !== null ? b : c', () =>
        test('let b = foo(); a = b !== null ? b : c', 'let b = foo(); a = b === null ? c : b;'));
    it('let b = foo(); a = null === b ? c : b', () =>
        test('let b = foo(); a = null === b ? c : b', 'let b = foo(); a = b === null ? c : b;'));
    it('let b = foo(); a = null !== b ? b : c', () =>
        test('let b = foo(); a = null !== b ? b : c', 'let b = foo(); a = b === null ? c : b;'));
    it('let b = foo(); a = null === b || b === undefined ? c : b', () =>
        test('let b = foo(); a = null === b || b === undefined ? c : b', 'a = foo() ?? c;'));
    it('let b = foo(); a = b !== undefined && b !== null ? b : c', () =>
        test('let b = foo(); a = b !== undefined && b !== null ? b : c', 'a = foo() ?? c;'));
    it('a(b ? 0 : 0)', () => test('a(b ? 0 : 0)', 'a((b, 0));'));
    it('a(b ? +0 : -0)', () => test('a(b ? +0 : -0)', 'a(b ? 0 : -0);'));
    it('a(b ? +0 : 0)', () => test('a(b ? +0 : 0)', 'a((b, 0));'));
    it('a(b ? -0 : 0)', () => test('a(b ? -0 : 0)', 'a(b ? -0 : 0);'));
    it('a ? b : b', () => test('a ? b : b', 'a, b;'));
    it('let a; a ? b : b', () => test('let a; a ? b : b', 'let a; b;'));
    it('a ? -b : -b', () => test('a ? -b : -b', 'a, -b;'));
    it('a ? b.c : b.c', () => test('a ? b.c : b.c', 'a, b.c;'));
    it('a ? b?.c : b?.c', () => test('a ? b?.c : b?.c', 'a, b?.c;'));
    it('a ? b[c] : b[c]', () => test('a ? b[c] : b[c]', 'a, b[c];'));
    it('a ? b() : b()', () => test('a ? b() : b()', 'a, b();'));
    it('a ? b?.() : b?.()', () => test('a ? b?.() : b?.()', 'a, b?.();'));
    it('a ? b?.[c] : b?.[c]', () => test('a ? b?.[c] : b?.[c]', 'a, b?.[c];'));
    it('a ? b == c : b == c', () => test('a ? b == c : b == c', 'a, b, c;'));
    it('a ? b.c(d + e[f]) : b.c(d + e[f])', () => test('a ? b.c(d + e[f]) : b.c(d + e[f])', 'a, b.c(d + e[f]);'));
    it('a ? -b : !b', () => test('a ? -b : !b', 'a ? -b : b;'));
    it('a ? b() : b(c)', () => test('a ? b() : b(c)', 'a ? b() : b(c);'));
    it('a ? b(c) : b(d)', () => test('a ? b(c) : b(d)', 'a ? b(c) : b(d);'));
    it('a ? b?.c : b.c', () => test('a ? b?.c : b.c', 'a ? b?.c : b.c;'));
    it('a ? b?.() : b()', () => test('a ? b?.() : b()', 'a ? b?.() : b();'));
    it('a ? b?.[c] : b[c]', () => test('a ? b?.[c] : b[c]', 'a ? b?.[c] : b[c];'));
    it('a ? b == c : b != c', () => test('a ? b == c : b != c', 'a, b, c;'));
    it('a ? b.c(d + e[f]) : b.c(d + e[g])', () =>
        test('a ? b.c(d + e[f]) : b.c(d + e[g])', 'a ? b.c(d + e[f]) : b.c(d + e[g]);'));
    it('(a, b) ? c : d', () => test('(a, b) ? c : d', 'a, b ? c : d;'));
    it('function _() { return a && ((b && c) && (d && e)) }', () =>
        test('function _() { return a && ((b && c) && (d && e)) }', 'function _() { return a && b && c && d && e; }'));
    it('function _() { return a || ((b || c) || (d || e)) }', () =>
        test('function _() { return a || ((b || c) || (d || e)) }', 'function _() { return a || b || c || d || e; }'));
    it('function _() { return a ?? ((b ?? c) ?? (d ?? e)) }', () =>
        test('function _() { return a ?? ((b ?? c) ?? (d ?? e)) }', 'function _() { return a ?? b ?? c ?? d ?? e; }'));
    it('if (a) if (b) if (c) d', () => test('if (a) if (b) if (c) d', 'a && b && c && d;'));
    it('if (!a) if (!b) if (!c) d', () => test('if (!a) if (!b) if (!c) d', 'a || b || c || d;'));
    it('function _() { let a = foo(), b = bar(), c = baz(); return a', () =>
        test(
            'function _() { let a = foo(), b = bar(), c = baz(); return a != null ? a : b != null ? b : c }',
            'function _() { let a = foo(), b = bar(), c = baz(); return a ?? b ?? c; }',
        ));
    it('function _() { if (a) return c; if (b) return d; }', () =>
        test('function _() { if (a) return c; if (b) return d; }', 'function _() { if (a) return c;if (b) return d; }'));
    it('function _() { if (a) return c; if (b) return c; }', () =>
        test('function _() { if (a) return c; if (b) return c; }', 'function _() { if (a || b) return c; }'));
    it('function _() { if (a) return c; if (b) return; }', () =>
        test('function _() { if (a) return c; if (b) return; }', 'function _() { if (a) return c; b; }'));
    it('function _() { if (a) return; if (b) return c; }', () =>
        test('function _() { if (a) return; if (b) return c; }', 'function _() { if (!a && b) return c; }'));
    it('function _() { if (a) return; if (b) return; }', () =>
        test('function _() { if (a) return; if (b) return; }', 'function _() { a || b }'));
    it('if (a) throw c; if (b) throw d;', () => test('if (a) throw c; if (b) throw d;', 'if (a) throw c;if (b) throw d;'));
    it('if (a) throw c; if (b) throw c;', () => test('if (a) throw c; if (b) throw c;', 'if (a || b) throw c;'));
    it('while (x) { if (a) break; if (b) break; }', () =>
        test('while (x) { if (a) break; if (b) break; }', 'for (; x && !(a || b); ) ;'));
    it('while (x) { if (a) continue; if (b) continue; }', () =>
        test('while (x) { if (a) continue; if (b) continue; }', 'for (; x; ) a || b;'));
    it('while (x) { debugger; if (a) break; if (b) break; }', () =>
        test('while (x) { debugger; if (a) break; if (b) break; }', 'for (; x; ) { debugger; if (a || b) break;}'));
    it('while (x) { debugger; if (a) continue; if (b) continue; }', () =>
        test('while (x) { debugger; if (a) continue; if (b) continue; }', 'for (; x; ) { debugger; a || b; }'));
    it('x: while (x) y: while (y) { if (a) break x; if (b) break y; ', () =>
        test(
            'x: while (x) y: while (y) { if (a) break x; if (b) break y; }',
            'x: for (; x; ) y: for (; y; ) { if (a) break x; if (b) break y;}',
        ));
    it('if (x ? y : 0) foo()', () => test('if (x ? y : 0) foo()', 'x && y && foo();'));
    it('if (x ? y : 1) foo()', () => test('if (x ? y : 1) foo()', '(!x || y) && foo();'));
    it('if (x ? 0 : y) foo()', () => test('if (x ? 0 : y) foo()', '!x && y && foo();'));
    it('if (x ? 1 : y) foo()', () => test('if (x ? 1 : y) foo()', '(x || y) && foo();'));
    it('if (x ? y : 0) ; else foo()', () => test('if (x ? y : 0) ; else foo()', 'x && y || foo();'));
    it('if (x ? y : 1) ; else foo()', () => test('if (x ? y : 1) ; else foo()', '!x || y || foo();'));
    it('if (x ? 0 : y) ; else foo()', () => test('if (x ? 0 : y) ; else foo()', '!x && y || foo();'));
    it('if (x ? 1 : y) ; else foo()', () => test('if (x ? 1 : y) ; else foo()', 'x || y || foo();'));
    it('(x ? y : 0) && foo();', () => test('(x ? y : 0) && foo();', 'x && y && foo();'));
    it('(x ? y : 1) && foo();', () => test('(x ? y : 1) && foo();', '(!x || y) && foo();'));
    it('(x ? 0 : y) && foo();', () => test('(x ? 0 : y) && foo();', '!x && y && foo();'));
    it('(x ? 1 : y) && foo();', () => test('(x ? 1 : y) && foo();', '(x || y) && foo();'));
    it('(x ? y : 0) || foo();', () => test('(x ? y : 0) || foo();', 'x && y || foo();'));
    it('(x ? y : 1) || foo();', () => test('(x ? y : 1) || foo();', '!x || y || foo();'));
    it('(x ? 0 : y) || foo();', () => test('(x ? 0 : y) || foo();', '!x && y || foo();'));
    it('(x ? 1 : y) || foo();', () => test('(x ? 1 : y) || foo();', 'x || y || foo();'));
    it('if (!!a || !!b) throw 0', () => test('if (!!a || !!b) throw 0', 'if (a || b) throw 0;'));
    it('if (!!a && !!b) throw 0', () => test('if (!!a && !!b) throw 0', 'if (a && b) throw 0;'));
    it('if (!!a ? !!b : !!c) throw 0', () => test('if (!!a ? !!b : !!c) throw 0', 'if (a ? b : c) throw 0;'));
    it('if ((a + b) !== 0) throw 0', () => test('if ((a + b) !== 0) throw 0', 'if (a + b !== 0) throw 0;'));
    it('if ((a | +b) !== 0) throw 0', () => test('if ((a | +b) !== 0) throw 0', 'if (a | +b) throw 0;'));
    it('if ((a & +b) !== 0) throw 0', () => test('if ((a & +b) !== 0) throw 0', 'if (a & +b) throw 0;'));
    it('if ((a ^ +b) !== 0) throw 0', () => test('if ((a ^ +b) !== 0) throw 0', 'if (a ^ +b) throw 0;'));
    it('if ((a << +b) !== 0) throw 0', () => test('if ((a << +b) !== 0) throw 0', 'if (a << +b) throw 0;'));
    it('if ((a >> +b) !== 0) throw 0', () => test('if ((a >> +b) !== 0) throw 0', 'if (a >> +b) throw 0;'));
    it('if ((a >>> b) !== 0) throw 0', () => test('if ((a >>> b) !== 0) throw 0', 'if (a >>> b) throw 0;'));
    it('if (+a !== 0) throw 0', () => test('if (+a !== 0) throw 0', 'if (+a != 0) throw 0;'));
    it('if (~a !== 0) throw 0', () => test('if (~a !== 0) throw 0', 'if (~a !== 0) throw 0;'));
    it('if (0 != (a + b)) throw 0', () => test('if (0 != (a + b)) throw 0', 'if (a + b != 0) throw 0;'));
    it('if (0 != (a | +b)) throw 0', () => test('if (0 != (a | +b)) throw 0', 'if (a | +b) throw 0;'));
    it('if (0 != (a & +b)) throw 0', () => test('if (0 != (a & +b)) throw 0', 'if (a & +b) throw 0;'));
    it('if (0 != (a ^ +b)) throw 0', () => test('if (0 != (a ^ +b)) throw 0', 'if (a ^ +b) throw 0;'));
    it('if (0 != (a << +b)) throw 0', () => test('if (0 != (a << +b)) throw 0', 'if (a << +b) throw 0;'));
    it('if (0 != (a >> +b)) throw 0', () => test('if (0 != (a >> +b)) throw 0', 'if (a >> +b) throw 0;'));
    it('if (0 != (a >>> b)) throw 0', () => test('if (0 != (a >>> b)) throw 0', 'if (a >>> b) throw 0;'));
    it('if (0 != +a) throw 0', () => test('if (0 != +a) throw 0', 'if (+a != 0) throw 0;'));
    it('if (0 != ~a) throw 0', () => test('if (0 != ~a) throw 0', 'if (~a != 0) throw 0;'));
    it('if ((a + b) === 0) throw 0', () => test('if ((a + b) === 0) throw 0', 'if (a + b === 0) throw 0;'));
    it('if ((a | +b) === 0) throw 0', () => test('if ((a | +b) === 0) throw 0', 'if (!(a | +b)) throw 0;'));
    it('if ((a & +b) === 0) throw 0', () => test('if ((a & +b) === 0) throw 0', 'if (!(a & +b)) throw 0;'));
    it('if ((a ^ +b) === 0) throw 0', () => test('if ((a ^ +b) === 0) throw 0', 'if (!(a ^ +b)) throw 0;'));
    it('if ((a << +b) === 0) throw 0', () => test('if ((a << +b) === 0) throw 0', 'if (!(a << +b)) throw 0;'));
    it('if ((a >> +b) === 0) throw 0', () => test('if ((a >> +b) === 0) throw 0', 'if (!(a >> +b)) throw 0;'));
    it('if ((a >>> b) === 0) throw 0', () => test('if ((a >>> b) === 0) throw 0', 'if (!(a >>> b)) throw 0;'));
    it('if (+a === 0) throw 0', () => test('if (+a === 0) throw 0', 'if (+a == 0) throw 0;'));
    it('if (~a === 0) throw 0', () => test('if (~a === 0) throw 0', 'if (~a === 0) throw 0;'));
    it('if (0 == (a + b)) throw 0', () => test('if (0 == (a + b)) throw 0', 'if (a + b == 0) throw 0;'));
    it('if (0 == (a | +b)) throw 0', () => test('if (0 == (a | +b)) throw 0', 'if (!(a | +b)) throw 0;'));
    it('if (0 == (a & +b)) throw 0', () => test('if (0 == (a & +b)) throw 0', 'if (!(a & +b)) throw 0;'));
    it('if (0 == (a ^ +b)) throw 0', () => test('if (0 == (a ^ +b)) throw 0', 'if (!(a ^ +b)) throw 0;'));
    it('if (0 == (a << +b)) throw 0', () => test('if (0 == (a << +b)) throw 0', 'if (!(a << +b)) throw 0;'));
    it('if (0 == (a >> +b)) throw 0', () => test('if (0 == (a >> +b)) throw 0', 'if (!(a >> +b)) throw 0;'));
    it('if (0 == (a >>> b)) throw 0', () => test('if (0 == (a >>> b)) throw 0', 'if (!(a >>> b)) throw 0;'));
    it('if (0 == +a) throw 0', () => test('if (0 == +a) throw 0', 'if (+a == 0) throw 0;'));
    it('if (0 == ~a) throw 0', () => test('if (0 == ~a) throw 0', 'if (~a == 0) throw 0;'));
    it('function _() { if (a) { if (b) return c } else return d }', () =>
        test(
            'function _() { if (a) { if (b) return c } else return d }',
            'function _() { if (a) { if (b) return c;} else return d; }',
        ));
    it('function _() { if (a) while (1) { if (b) return c } else ret', () =>
        test(
            'function _() { if (a) while (1) { if (b) return c } else return d }',
            'function _() { if (a) { for (;;) if (b) return c;} else return d; }',
        ));
    it('function _() { if (a) for (;;) { if (b) return c } else retu', () =>
        test(
            'function _() { if (a) for (;;) { if (b) return c } else return d }',
            'function _() { if (a) { for (;;) if (b) return c;} else return d; }',
        ));
    it('function _() { if (a) for (x in y) { if (b) return c } else ', () =>
        test(
            'function _() { if (a) for (x in y) { if (b) return c } else return d }',
            'function _() { if (a) { for (x in y) if (b) return c;} else return d; }',
        ));
    it('function _() { if (a) for (x of y) { if (b) return c } else ', () =>
        test(
            'function _() { if (a) for (x of y) { if (b) return c } else return d }',
            'function _() { if (a) { for (x of y) if (b) return c;} else return d; }',
        ));
    // shakeup's parser rejects `with` in module code, which oxc leaves to its checker; the printer has no `with` either.
    it.skip('function _() { if (a) with (x) { if (b) return c } else retu', () =>
        test(
            'function _() { if (a) with (x) { if (b) return c } else return d }',
            'function _() { if (a) { with (x) if (b) return c;} else return d; }',
        ));
    it('function _() { if (a) x: { if (b) break x } else return c }', () =>
        test(
            'function _() { if (a) x: { if (b) break x } else return c }',
            'function _() { if (a) { x: if (b) break x;} else return c; }',
        ));
    it('function _() { let a = foo(); return a != null ? a.b : undef', () =>
        test('function _() { let a = foo(); return a != null ? a.b : undefined }', 'function _() { return foo()?.b; }'));
    it('function _() { let a = foo(); return a != null ? a[b] : unde', () =>
        test('function _() { let a = foo(); return a != null ? a[b] : undefined }', 'function _() { return foo()?.[b]; }'));
    it('function _() { let a = foo(); return a != null ? a(b) : unde', () =>
        test('function _() { let a = foo(); return a != null ? a(b) : undefined }', 'function _() { return foo()?.(b); }'));
    it('function _() { let a = foo(); return a == null ? undefined :', () =>
        test('function _() { let a = foo(); return a == null ? undefined : a.b }', 'function _() { return foo()?.b; }'));
    it('function _() { let a = foo(); return a == null ? undefined :', () =>
        test('function _() { let a = foo(); return a == null ? undefined : a[b] }', 'function _() { return foo()?.[b]; }'));
    it('function _() { let a = foo(); return a == null ? undefined :', () =>
        test('function _() { let a = foo(); return a == null ? undefined : a(b) }', 'function _() { return foo()?.(b); }'));
    it('function _() { let a = foo(); return null != a ? a.b : undef', () =>
        test('function _() { let a = foo(); return null != a ? a.b : undefined }', 'function _() { return foo()?.b; }'));
    it('function _() { let a = foo(); return null != a ? a[b] : unde', () =>
        test('function _() { let a = foo(); return null != a ? a[b] : undefined }', 'function _() { return foo()?.[b]; }'));
    it('function _() { let a = foo(); return null != a ? a(b) : unde', () =>
        test('function _() { let a = foo(); return null != a ? a(b) : undefined }', 'function _() { return foo()?.(b); }'));
    it('function _() { let a = foo(); return null == a ? undefined :', () =>
        test('function _() { let a = foo(); return null == a ? undefined : a.b }', 'function _() { return foo()?.b; }'));
    it('function _() { let a = foo(); return null == a ? undefined :', () =>
        test('function _() { let a = foo(); return null == a ? undefined : a[b] }', 'function _() { return foo()?.[b]; }'));
    it('function _() { let a = foo(); return null == a ? undefined :', () =>
        test('function _() { let a = foo(); return null == a ? undefined : a(b) }', 'function _() { return foo()?.(b); }'));
    it('function _() { return a != null ? a.b : undefined }', () =>
        test('function _() { return a != null ? a.b : undefined }', 'function _() { return a == null ? void 0 : a.b; }'));
    it('function _() { let a = foo(); return a != null ? a.b : null ', () =>
        test(
            'function _() { let a = foo(); return a != null ? a.b : null }',
            'function _() { let a = foo(); return a == null ? null : a.b; }',
        ));
    it('function _() { let a = foo(); return a != null ? b.a : undef', () =>
        test(
            'function _() { let a = foo(); return a != null ? b.a : undefined }',
            'function _() { return foo() == null ? void 0 : b.a; }',
        ));
    it('function _() { let a = foo(); return a != 0 ? a.b : undefine', () =>
        test(
            'function _() { let a = foo(); return a != 0 ? a.b : undefined }',
            'function _() { let a = foo(); return a == 0 ? void 0 : a.b; }',
        ));
    it('function _() { let a = foo(); return a !== null ? a.b : unde', () =>
        test(
            'function _() { let a = foo(); return a !== null ? a.b : undefined }',
            'function _() { let a = foo(); return a === null ? void 0 : a.b; }',
        ));
    it('function _() { let a = foo(); return a != undefined ? a.b : ', () =>
        test('function _() { let a = foo(); return a != undefined ? a.b : undefined }', 'function _() { return foo()?.b; }'));
    it('function _() { let a = foo(); return a != null ? a?.b : unde', () =>
        test('function _() { let a = foo(); return a != null ? a?.b : undefined }', 'function _() { return foo()?.b; }'));
    it('function _() { let a = foo(); return a != null ? a.b.c[d](e)', () =>
        test(
            'function _() { let a = foo(); return a != null ? a.b.c[d](e) : undefined }',
            'function _() { return foo()?.b.c[d](e); }',
        ));
    it('function _() { let a = foo(); return a != null ? a?.b.c[d](e', () =>
        test(
            'function _() { let a = foo(); return a != null ? a?.b.c[d](e) : undefined }',
            'function _() { return foo()?.b.c[d](e); }',
        ));
    it('function _() { let a = foo(); return a != null ? a.b.c?.[d](', () =>
        test(
            'function _() { let a = foo(); return a != null ? a.b.c?.[d](e) : undefined }',
            'function _() { return foo()?.b.c?.[d](e); }',
        ));
    it('function _() { let a = foo(); return a != null ? a?.b.c?.[d]', () =>
        test(
            'function _() { let a = foo(); return a != null ? a?.b.c?.[d](e) : undefined }',
            'function _() { return foo()?.b.c?.[d](e); }',
        ));
});

describe('constant_evaluation_test', () => {
    it('x = +5', () => test('x = +5', 'x = 5;'));
    it('x = -5', () => test('x = -5', 'x = -5;'));
    it('x = ~5', () => test('x = ~5', 'x = -6;'));
    it('x = !5', () => test('x = !5', 'x = !1;'));
    it('x = typeof 5', () => test('x = typeof 5', "x = 'number';"));
    it("x = +''", () => test("x = +''", 'x = 0;'));
    it('x = +[]', () => test('x = +[]', 'x = 0;'));
    it('x = +{}', () => test('x = +{}', 'x = NaN;'));
    it('x = +/1/', () => test('x = +/1/', 'x = NaN;'));
    it('x = +[1]', () => test('x = +[1]', 'x = 1;'));
    it("x = +'123'", () => test("x = +'123'", 'x = 123;'));
    it("x = +'-123'", () => test("x = +'-123'", 'x = -123;'));
    it("x = +'0x10'", () => test("x = +'0x10'", 'x = 16;'));
    it('x = +{toString:()=>1}', () => test('x = +{toString:()=>1}', 'x = +{ toString: () => 1 };'));
    it('x = +{valueOf:()=>1}', () => test('x = +{valueOf:()=>1}', 'x = +{ valueOf: () => 1 };'));
    it('x = 3 + 6', () => test('x = 3 + 6', 'x = 9;'));
    it('x = 3 - 6', () => test('x = 3 - 6', 'x = -3;'));
    it('x = 3 * 6', () => test('x = 3 * 6', 'x = 18;'));
    it('x = 3 / 6', () => test('x = 3 / 6', 'x = 3 / 6;'));
    it('x = 3 % 6', () => test('x = 3 % 6', 'x = 3;'));
    it('x = 3 ** 6', () => test('x = 3 ** 6', 'x = 729;'));
    it('x = 0 / 0', () => test('x = 0 / 0', 'x = NaN;'));
    it('x = 123 / 0', () => test('x = 123 / 0', 'x = Infinity;'));
    it('x = 123 / -0', () => test('x = 123 / -0', 'x = -Infinity;'));
    it('x = -123 / 0', () => test('x = -123 / 0', 'x = -Infinity;'));
    it('x = -123 / -0', () => test('x = -123 / -0', 'x = Infinity;'));
    it('x = 3 < 6', () => test('x = 3 < 6', 'x = !0;'));
    it('x = 3 > 6', () => test('x = 3 > 6', 'x = !1;'));
    it('x = 3 <= 6', () => test('x = 3 <= 6', 'x = !0;'));
    it('x = 3 >= 6', () => test('x = 3 >= 6', 'x = !1;'));
    it('x = 3 == 6', () => test('x = 3 == 6', 'x = !1;'));
    it('x = 3 != 6', () => test('x = 3 != 6', 'x = !0;'));
    it('x = 3 === 6', () => test('x = 3 === 6', 'x = !1;'));
    it('x = 3 !== 6', () => test('x = 3 !== 6', 'x = !0;'));
    it("x = 'a' < 'b'", () => test("x = 'a' < 'b'", 'x = !0;'));
    it("x = 'a' > 'b'", () => test("x = 'a' > 'b'", 'x = !1;'));
    it("x = 'a' <= 'b'", () => test("x = 'a' <= 'b'", 'x = !0;'));
    it("x = 'a' >= 'b'", () => test("x = 'a' >= 'b'", 'x = !1;'));
    it("x = 'ab' < 'abc'", () => test("x = 'ab' < 'abc'", 'x = !0;'));
    it("x = 'ab' > 'abc'", () => test("x = 'ab' > 'abc'", 'x = !1;'));
    it("x = 'ab' <= 'abc'", () => test("x = 'ab' <= 'abc'", 'x = !0;'));
    it("x = 'ab' >= 'abc'", () => test("x = 'ab' >= 'abc'", 'x = !1;'));
    it("x = '\ud801\ude69' < '\ufb21'", () => test("x = '\ud801\ude69' < '\ufb21'", 'x = !0;'));
    it("x = '\ud801\ude69' > '\ufb21'", () => test("x = '\ud801\ude69' > '\ufb21'", 'x = !1;'));
    it("x = '\ud801\ude69' <= '\ufb21'", () => test("x = '\ud801\ude69' <= '\ufb21'", 'x = !0;'));
    it("x = '\ud801\ude69' >= '\ufb21'", () => test("x = '\ud801\ude69' >= '\ufb21'", 'x = !1;'));
    it('x = 3 in 6', () => test('x = 3 in 6', 'x = 3 in 6;'));
    it('x = 3 instanceof 6', () => test('x = 3 instanceof 6', 'x = 3 instanceof 6;'));
    it('x = (3, 6)', () => test('x = (3, 6)', 'x = 6;'));
    it('x = 10 << 0', () => test('x = 10 << 0', 'x = 10;'));
    it('x = 10 << 1', () => test('x = 10 << 1', 'x = 20;'));
    it('x = 10 << 16', () => test('x = 10 << 16', 'x = 655360;'));
    it('x = 10 << 17', () => test('x = 10 << 17', 'x = 10 << 17;'));
    it('x = 10 >> 0', () => test('x = 10 >> 0', 'x = 10;'));
    it('x = 10 >> 1', () => test('x = 10 >> 1', 'x = 5;'));
    it('x = 10 >>> 0', () => test('x = 10 >>> 0', 'x = 10;'));
    it('x = 10 >>> 1', () => test('x = 10 >>> 1', 'x = 5;'));
    it('x = -10 >>> 1', () => test('x = -10 >>> 1', 'x = -10 >>> 1;'));
    it('x = -1 >>> 0', () => test('x = -1 >>> 0', 'x = -1 >>> 0;'));
    it('x = -123 >>> 5', () => test('x = -123 >>> 5', 'x = -123 >>> 5;'));
    it('x = -123 >>> 6', () => test('x = -123 >>> 6', 'x = 67108862;'));
    it('x = 3 & 6', () => test('x = 3 & 6', 'x = 2;'));
    it('x = 3 | 6', () => test('x = 3 | 6', 'x = 7;'));
    it('x = 3 ^ 6', () => test('x = 3 ^ 6', 'x = 5;'));
    it('x = 3 && 6', () => test('x = 3 && 6', 'x = 6;'));
    it('x = 3 || 6', () => test('x = 3 || 6', 'x = 3;'));
    it('x = 3 ?? 6', () => test('x = 3 ?? 6', 'x = 3;'));
});

describe('test_remove_dead_expr_nullish_related', () => {
    it('var a; a != null && a.b()', () => test('var a; a != null && a.b()', 'var a; a?.b();'));
    it('var a; a == null || a.b()', () => test('var a; a == null || a.b()', 'var a; a?.b();'));
    it('var a; null != a && a.b()', () => test('var a; null != a && a.b()', 'var a; a?.b();'));
    it('var a; null == a || a.b()', () => test('var a; null == a || a.b()', 'var a; a?.b();'));
    it('var a; a == null && a.b()', () => test('var a; a == null && a.b()', 'var a; a ?? a.b();'));
    it('var a; a != null || a.b()', () => test('var a; a != null || a.b()', 'var a; a ?? a.b();'));
    it('var a; null == a && a.b()', () => test('var a; null == a && a.b()', 'var a; a ?? a.b();'));
    it('var a; null != a || a.b()', () => test('var a; null != a || a.b()', 'var a; a ?? a.b();'));
    it('x = a != null && a.b()', () => test('x = a != null && a.b()', 'x = a != null && a.b();'));
    it('x = a == null || a.b()', () => test('x = a == null || a.b()', 'x = a == null || a.b();'));
    it('var a; if (a != null) a.b()', () => test('var a; if (a != null) a.b()', 'var a; a?.b();'));
    it('var a; if (a == null) ; else a.b()', () => test('var a; if (a == null) ; else a.b()', 'var a; a?.b();'));
    it('var a; if (a == null) a.b()', () => test('var a; if (a == null) a.b()', 'var a; a ?? a.b();'));
    it('var a; if (a != null) ; else a.b()', () => test('var a; if (a != null) ; else a.b()', 'var a; a ?? a.b();'));
    it('x(y ?? 1)', () => test('x(y ?? 1)', 'x(y ?? 1);'));
    it('x(y.z ?? 1)', () => test('x(y.z ?? 1)', 'x(y.z ?? 1);'));
    it('x(y[z] ?? 1)', () => test('x(y[z] ?? 1)', 'x(y[z] ?? 1);'));
    it('x(0 ?? 1)', () => test('x(0 ?? 1)', 'x(0);'));
    it('x(0n ?? 1)', () => test('x(0n ?? 1)', 'x(0n);'));
    it("x('' ?? 1)", () => test("x('' ?? 1)", "x('');"));
    it('x(/./ ?? 1)', () => test('x(/./ ?? 1)', 'x(/./);'));
    it('x({} ?? 1)', () => test('x({} ?? 1)', 'x({});'));
    it('x((() => {}) ?? 1)', () => test('x((() => {}) ?? 1)', 'x((() => {}));'));
    it('x(class {} ?? 1)', () => test('x(class {} ?? 1)', 'x(class {});'));
    it('x(function() {} ?? 1)', () => test('x(function() {} ?? 1)', 'x(function() {});'));
    it('x(null ?? 1)', () => test('x(null ?? 1)', 'x(1);'));
    it('x(undefined ?? 1)', () => test('x(undefined ?? 1)', 'x(1);'));
    it('x(void y ?? 1)', () => test('x(void y ?? 1)', 'x((y, 1));'));
    it('x(+y ?? 1)', () => test('x(+y ?? 1)', 'x(+y);'));
    it('x(!y ?? 1)', () => test('x(!y ?? 1)', 'x(!y);'));
    it('x(delete y ?? 1)', () => test('x(delete y ?? 1)', 'x(delete y);'));
    it('x(typeof y ?? 1)', () => test('x(typeof y ?? 1)', 'x(typeof y);'));
    it('x((y, 0) ?? 1)', () => test('x((y, 0) ?? 1)', 'x((y, 0));'));
    it('x((y, !z) ?? 1)', () => test('x((y, !z) ?? 1)', 'x((y, !z));'));
    it('x((y, null) ?? 1)', () => test('x((y, null) ?? 1)', 'x((y, 1));'));
    it('x((y, void z) ?? 1)', () => test('x((y, void z) ?? 1)', 'x((y, z, 1));'));
    it('x((y >>> z) ?? 1)', () => test('x((y >>> z) ?? 1)', 'x(y >>> z);'));
    it('x((y < z) ?? 1)', () => test('x((y < z) ?? 1)', 'x(y < z);'));
    it('x((y > z) ?? 1)', () => test('x((y > z) ?? 1)', 'x(y > z);'));
    it('x((y <= z) ?? 1)', () => test('x((y <= z) ?? 1)', 'x(y <= z);'));
    it('x((y >= z) ?? 1)', () => test('x((y >= z) ?? 1)', 'x(y >= z);'));
    it('x((y == z) ?? 1)', () => test('x((y == z) ?? 1)', 'x(y == z);'));
    it('x((y != z) ?? 1)', () => test('x((y != z) ?? 1)', 'x(y != z);'));
    it('x((y === z) ?? 1)', () => test('x((y === z) ?? 1)', 'x(y === z);'));
    it('x((y !== z) ?? 1)', () => test('x((y !== z) ?? 1)', 'x(y !== z);'));
    it('x((y || z) ?? 1)', () => test('x((y || z) ?? 1)', 'x((y || z) ?? 1);'));
    it('x((y && z) ?? 1)', () => test('x((y && z) ?? 1)', 'x((y && z) ?? 1);'));
    it('x((y ?? z) ?? 1)', () => test('x((y ?? z) ?? 1)', 'x(y ?? z ?? 1);'));
});

describe('test_minimize_exit_statements', () => {
    it('function foo() { x(); return; }', () => test('function foo() { x(); return; }', 'function foo() { x();}'));
    it('let foo = function() { x(); return; }', () =>
        test('let foo = function() { x(); return; }', 'let foo = function() { x();};'));
    it('let foo = () => { x(); return; }', () => test('let foo = () => { x(); return; }', 'let foo = () => { x();};'));
    it('function foo() { x(); return y; }', () => test('function foo() { x(); return y; }', 'function foo() { return x(), y;}'));
    it('let foo = function() { x(); return y; }', () =>
        test('let foo = function() { x(); return y; }', 'let foo = function() { return x(), y;};'));
    it('let foo = () => { x(); return y; }', () => test('let foo = () => { x(); return y; }', 'let foo = () => (x(), y);'));
    it('x(); return;', () => test('x(); return;', 'x();return;'));
    it('function foo() { a = b; if (a) return a; if (b) c = b; retur', () =>
        test(
            'function foo() { a = b; if (a) return a; if (b) c = b; return c; }',
            'function foo() { return a = b, a || (b && (c = b), c);}',
        ));
    it('function foo() { a = b; if (a) return; if (b) c = b; return ', () =>
        test(
            'function foo() { a = b; if (a) return; if (b) c = b; return c; }',
            'function foo() { if (a = b, !a) return b && (c = b), c;}',
        ));
    it('function foo() { if (!a) return b; return c; }', () =>
        test('function foo() { if (!a) return b; return c; }', 'function foo() { return a ? c : b;}'));
    it('if (1) return a(); else return b()', () => test('if (1) return a(); else return b()', 'return a();'));
    it('if (0) return a(); else return b()', () => test('if (0) return a(); else return b()', 'return b();'));
    it('if (a) return b(); else return c()', () => test('if (a) return b(); else return c()', 'return a ? b() : c();'));
    it('if (!a) return b(); else return c()', () => test('if (!a) return b(); else return c()', 'return a ? c() : b();'));
    it('if (!!a) return b(); else return c()', () => test('if (!!a) return b(); else return c()', 'return a ? b() : c();'));
    it('if (!!!a) return b(); else return c()', () => test('if (!!!a) return b(); else return c()', 'return a ? c() : b();'));
    it('if (1) return a(); return b()', () => test('if (1) return a(); return b()', 'return a();'));
    it('if (0) return a(); return b()', () => test('if (0) return a(); return b()', 'return b();'));
    it('if (a) return b(); return c()', () => test('if (a) return b(); return c()', 'return a ? b() : c();'));
    it('if (!a) return b(); return c()', () => test('if (!a) return b(); return c()', 'return a ? c() : b();'));
    it('if (!!a) return b(); return c()', () => test('if (!!a) return b(); return c()', 'return a ? b() : c();'));
    it('if (!!!a) return b(); return c()', () => test('if (!!!a) return b(); return c()', 'return a ? c() : b();'));
    it('if (a) return b; else return c; return d;', () => test('if (a) return b; else return c; return d;', 'return a ? b : c;'));
    it('function x() { if (y) return; z(); }', () => test('function x() { if (y) return; z(); }', 'function x() { y || z();}'));
    it('function x() { if (y) return; else z(); w(); }', () =>
        test('function x() { if (y) return; else z(); w(); }', 'function x() { y || (z(), w());}'));
    it('function x() { t(); if (y) return; z(); }', () =>
        test('function x() { t(); if (y) return; z(); }', 'function x() { t(), !y && z();}'));
    it('function x() { t(); if (y) return; else z(); w(); }', () =>
        test('function x() { t(); if (y) return; else z(); w(); }', 'function x() { t(), !y && (z(), w());}'));
    it('function x() { debugger; if (y) return; z(); }', () =>
        test('function x() { debugger; if (y) return; z(); }', 'function x() { debugger; y || z();}'));
    it('function x() { debugger; if (y) return; else z(); w(); }', () =>
        test('function x() { debugger; if (y) return; else z(); w(); }', 'function x() { debugger; y || (z(), w());}'));
    it('function x() { if (y) { if (z) return; } }', () =>
        test('function x() { if (y) { if (z) return; } }', 'function x() { y && z;}'));
    it('function x() { if (y) { if (z) return; w(); } }', () =>
        test('function x() { if (y) { if (z) return; w(); } }', 'function x() { if (y) { if (z) return; w(); }}'));
    it('function foo(x) { if (!x.y) {} else return x }', () =>
        test('function foo(x) { if (!x.y) {} else return x }', 'function foo(x) { if (x.y) return x;}'));
    it('function foo(x) { if (!x.y) return undefined; return x }', () =>
        test('function foo(x) { if (!x.y) return undefined; return x }', 'function foo(x) { if (x.y) return x;}'));
    it('function x() { if (y) return; function y() {} }', () =>
        test('function x() { if (y) return; function y() {} }', 'function x() { if (y) return; function y() { }}'));
    it('function x() { if (y) return; let y }', () =>
        test('function x() { if (y) return; let y }', 'function x() { if (y) return; let y;}'));
    it('function x() { if (y) return; var y }', () =>
        test('function x() { if (y) return; var y }', 'function x() { if (!y) var y;}'));
    it('function foo() { a = b; if (a) throw a; if (b) c = b; throw ', () =>
        test(
            'function foo() { a = b; if (a) throw a; if (b) c = b; throw c; }',
            'function foo() { throw a = b, a || (b && (c = b), c);}',
        ));
    it('function foo() { if (!a) throw b; throw c; }', () =>
        test('function foo() { if (!a) throw b; throw c; }', 'function foo() { throw a ? c : b;}'));
    it('if (1) throw a(); else throw b()', () => test('if (1) throw a(); else throw b()', 'throw a();'));
    it('if (0) throw a(); else throw b()', () => test('if (0) throw a(); else throw b()', 'throw b();'));
    it('if (a) throw b(); else throw c()', () => test('if (a) throw b(); else throw c()', 'throw a ? b() : c();'));
    it('if (!a) throw b(); else throw c()', () => test('if (!a) throw b(); else throw c()', 'throw a ? c() : b();'));
    it('if (!!a) throw b(); else throw c()', () => test('if (!!a) throw b(); else throw c()', 'throw a ? b() : c();'));
    it('if (!!!a) throw b(); else throw c()', () => test('if (!!!a) throw b(); else throw c()', 'throw a ? c() : b();'));
    it('if (1) throw a(); throw b()', () => test('if (1) throw a(); throw b()', 'throw a();'));
    it('if (0) throw a(); throw b()', () => test('if (0) throw a(); throw b()', 'throw b();'));
    it('if (a) throw b(); throw c()', () => test('if (a) throw b(); throw c()', 'throw a ? b() : c();'));
    it('if (!a) throw b(); throw c()', () => test('if (!a) throw b(); throw c()', 'throw a ? c() : b();'));
    it('if (!!a) throw b(); throw c()', () => test('if (!!a) throw b(); throw c()', 'throw a ? b() : c();'));
    it('if (!!!a) throw b(); throw c()', () => test('if (!!!a) throw b(); throw c()', 'throw a ? c() : b();'));
});

describe('test_flatten_values', () => {
    it('const a = undefined', () => test('const a = undefined', 'const a = void 0;'));
    it('let a = undefined', () => test('let a = undefined', 'let a;'));
    it('let {} = undefined', () => test('let {} = undefined', 'let {} = void 0;'));
    it('let [] = undefined', () => test('let [] = undefined', 'let [] = void 0;'));
    it('var a = undefined', () => test('var a = undefined', 'var a = void 0;'));
    it('var {} = undefined', () => test('var {} = undefined', 'var {} = void 0;'));
    it('var [] = undefined', () => test('var [] = undefined', 'var [] = void 0;'));
    it('x = foo(1, ...[], 2)', () => test('x = foo(1, ...[], 2)', 'x = foo(1, 2);'));
    it('x = foo(1, ...2, 3)', () => test('x = foo(1, ...2, 3)', 'x = foo(1, ...2, 3);'));
    it('x = foo(1, ...[2], 3)', () => test('x = foo(1, ...[2], 3)', 'x = foo(1, 2, 3);'));
    it('x = foo(1, ...[2, 3], 4)', () => test('x = foo(1, ...[2, 3], 4)', 'x = foo(1, 2, 3, 4);'));
    it('x = foo(1, ...[2, ...y, 3], 4)', () => test('x = foo(1, ...[2, ...y, 3], 4)', 'x = foo(1, 2, ...y, 3, 4);'));
    it('x = foo(1, ...{a, b}, 4)', () => test('x = foo(1, ...{a, b}, 4)', 'x = foo(1, ...{ a, b }, 4);'));
    it('x = foo(1, ...[,2,,], 3)', () => test('x = foo(1, ...[,2,,], 3)', 'x = foo(1, void 0, 2, void 0, 3);'));
    it('x = new foo(1, ...[], 2)', () => test('x = new foo(1, ...[], 2)', 'x = new foo(1, 2);'));
    it('x = new foo(1, ...2, 3)', () => test('x = new foo(1, ...2, 3)', 'x = new foo(1, ...2, 3);'));
    it('x = new foo(1, ...[2], 3)', () => test('x = new foo(1, ...[2], 3)', 'x = new foo(1, 2, 3);'));
    it('x = new foo(1, ...[2, 3], 4)', () => test('x = new foo(1, ...[2, 3], 4)', 'x = new foo(1, 2, 3, 4);'));
    it('x = new foo(1, ...[2, ...y, 3], 4)', () => test('x = new foo(1, ...[2, ...y, 3], 4)', 'x = new foo(1, 2, ...y, 3, 4);'));
    it('x = new foo(1, ...{a, b}, 4)', () => test('x = new foo(1, ...{a, b}, 4)', 'x = new foo(1, ...{ a, b }, 4);'));
    it('x = new foo(1, ...[,2,,], 3)', () => test('x = new foo(1, ...[,2,,], 3)', 'x = new foo(1, void 0, 2, void 0, 3);'));
    it('x = [1, ...[], 2]', () => test('x = [1, ...[], 2]', 'x = [1, 2];'));
    it('x = [1, ...2, 3]', () => test('x = [1, ...2, 3]', 'x = [1, ...2, 3];'));
    it('x = [1, ...[2], 3]', () => test('x = [1, ...[2], 3]', 'x = [1, 2, 3];'));
    it('x = [1, ...[2, 3], 4]', () => test('x = [1, ...[2, 3], 4]', 'x = [1, 2, 3, 4];'));
    it('x = [1, ...[2, ...y, 3], 4]', () => test('x = [1, ...[2, ...y, 3], 4]', 'x = [1, 2, ...y, 3, 4];'));
    it('x = [1, ...{a, b}, 4]', () => test('x = [1, ...{a, b}, 4]', 'x = [1, ...{ a, b }, 4];'));
    it('x = [1, ...[,2,,], 3]', () => test('x = [1, ...[,2,,], 3]', 'x = [1, ...[,2,,], 3];'));
    it("x = {['y']: z}", () => test("x = {['y']: z}", 'x = { y: z };'));
    it("x = {['y']() {}}", () => test("x = {['y']() {}}", 'x = { y() {} };'));
    it("x = {get ['y']() {}}", () => test("x = {get ['y']() {}}", 'x = { get y() {} };'));
    it("x = {set ['y'](z) {}}", () => test("x = {set ['y'](z) {}}", 'x = { set y(z) {} };'));
    it("x = {async ['y']() {}}", () => test("x = {async ['y']() {}}", 'x = { async y() {} };'));
    it("({['y']: z} = x)", () => test("({['y']: z} = x)", '({ y: z } = x);'));
    it('x = {a, ...{}, b}', () => test('x = {a, ...{}, b}', 'x = { a, b };'));
    it('x = {a, ...b, c}', () => test('x = {a, ...b, c}', 'x = { a, ...b, c };'));
    it('x = {a, ...{b}, c}', () => test('x = {a, ...{b}, c}', 'x = { a, b, c };'));
    it('x = {a, ...{b() {}}, c}', () => test('x = {a, ...{b() {}}, c}', 'x = { a, b() {}, c };'));
    it('x = {a, ...{b, c}, d}', () => test('x = {a, ...{b, c}, d}', 'x = { a, b, c, d };'));
    it('x = {a, ...{b, ...y, c}, d}', () => test('x = {a, ...{b, ...y, c}, d}', 'x = { a, b, ...y, c, d };'));
    it('x = {a, ...[b, c], d}', () => test('x = {a, ...[b, c], d}', 'x = { a, ...[b, c], d };'));
    it('x = {a, ...{[b]: c}, d}', () => test('x = {a, ...{[b]: c}, d}', 'x = { a, [b]: c, d };'));
    it('x = {a, ...{[b]() {}}, c}', () => test('x = {a, ...{[b]() {}}, c}', 'x = { a, [b]() {}, c };'));
    it('x = {a, ...{b, get c() { return y++ }, d}, e}', () =>
        test('x = {a, ...{b, get c() { return y++ }, d}, e}', 'x = { a, ...{ b, get c() { return y++;}, d }, e };'));
    it('x = {a, ...{b, set c(_) { throw _ }, d}, e}', () =>
        test('x = {a, ...{b, set c(_) { throw _ }, d}, e}', 'x = { a, ...{ b, set c(_) { throw _;}, d }, e };'));
    it('x = {a, ...{b, __proto__: c, d}, e}', () =>
        test('x = {a, ...{b, __proto__: c, d}, e}', 'x = { a, ...{ b, __proto__: c, d }, e };'));
    it("x = {a, ...{b, ['__proto__']: c, d}, e}", () =>
        test("x = {a, ...{b, ['__proto__']: c, d}, e}", "x = { a, b, ['__proto__']: c, d, e };"));
    it('x = {a, ...{b, __proto__() {}, c}, d}', () =>
        test('x = {a, ...{b, __proto__() {}, c}, d}', 'x = { a, b, __proto__() {}, c, d };'));
    it('x = {a, ...true, b}', () => test('x = {a, ...true, b}', 'x = { a, b };'));
    it('x = {a, ...null, b}', () => test('x = {a, ...null, b}', 'x = { a, b };'));
    it('x = {a, ...void 0, b}', () => test('x = {a, ...void 0, b}', 'x = { a, b };'));
    it('x = {a, ...123, b}', () => test('x = {a, ...123, b}', 'x = { a, b };'));
    it('x = {a, ...123n, b}', () => test('x = {a, ...123n, b}', 'x = { a, b };'));
    it('x = {a, .../x/, b}', () => test('x = {a, .../x/, b}', 'x = { a, b };'));
    it('x = {a, ...function(){}, b}', () => test('x = {a, ...function(){}, b}', 'x = { a, b };'));
    it('x = {a, ...()=>{}, b}', () => test('x = {a, ...()=>{}, b}', 'x = { a, b };'));
    it("x = {a, ...'123', b}", () => test("x = {a, ...'123', b}", "x = { a, ...'123', b };"));
    it('x = {a, ...[1, 2, 3], b}', () => test('x = {a, ...[1, 2, 3], b}', 'x = { a, ...[1, 2, 3], b };'));
    it('var a = () => {}', () => test('var a = () => {}', 'var a = () => {};'));
    it('var a = () => 123', () => test('var a = () => 123', 'var a = () => 123;'));
    it('var a = () => {return}', () => test('var a = () => {return}', 'var a = () => {};'));
    it('var a = () => {return 123}', () => test('var a = () => {return 123}', 'var a = () => 123;'));
    it('var a = () => {throw 123}', () => test('var a = () => {throw 123}', 'var a = () => { throw 123;};'));
    it('var a = (() => {})()', () => test('var a = (() => {})()', 'var a = void 0;'));
    it('(() => {})()', () => test('(() => {})()', ''));
    it('(() => a())()', () => test('(() => a())()', 'a();'));
    it('(() => { a() })()', () => test('(() => { a() })()', 'a();'));
    it('(() => { return a() })()', () => test('(() => { return a() })()', 'a();'));
    it('(() => { let b = a; b() })()', () => test('(() => { let b = a; b() })()', 'a();'));
    it('(() => { let b = a; return b() })()', () => test('(() => { let b = a; return b() })()', 'a();'));
    it('(async () => {})()', () => test('(async () => {})()', ''));
    it('(async () => { a() })()', () => test('(async () => { a() })()', '(async () => { a() })();'));
    it('(async () => { let b = a; b() })()', () => test('(async () => { let b = a; b() })()', '(async () => { a() })();'));
    it('(async () => { let b = a; return b() })()', () =>
        test('(async () => { let b = a; return b() })()', '(async () => a())();'));
    it('var a = (function() {})()', () => test('var a = (function() {})()', 'var a = void 0;'));
    it('(function() {})()', () => test('(function() {})()', ''));
    it('(function*() {})()', () => test('(function*() {})()', ''));
    it('(async function() {})()', () => test('(async function() {})()', ''));
    it('(function() { a() })()', () => test('(function() { a() })()', '(function() { a();})();'));
    it('(function*() { a() })()', () => test('(function*() { a() })()', '(function* () { a();})();'));
    it('(async function() { a() })()', () => test('(async function() { a() })()', '(async function() { a();})();'));
    it('(() => x)()', () => test('(() => x)()', 'x;'));
    it('/* @__PURE__ */ (() => x)()', () => test('/* @__PURE__ */ (() => x)()', ''));
    it('/* @__PURE__ */ (() => x)(y, z)', () => test('/* @__PURE__ */ (() => x)(y, z)', 'y, z;'));
    it('_ = `a${x}b${y}c`', () => test('_ = `a${x}b${y}c`', '_ = `a${x}b${y}c`;'));
    it("_ = `a${x}b${'y'}c`", () => test("_ = `a${x}b${'y'}c`", '_ = `a${x}byc`;'));
    it("_ = `a${'x'}b${y}c`", () => test("_ = `a${'x'}b${y}c`", '_ = `axb${y}c`;'));
    it("_ = `a${'x'}b${'y'}c`", () => test("_ = `a${'x'}b${'y'}c`", "_ = 'axbyc';"));
    it('tag`a${x}b${y}c`', () => test('tag`a${x}b${y}c`', 'tag`a${x}b${y}c`;'));
    it("tag`a${x}b${'y'}c`", () => test("tag`a${x}b${'y'}c`", "tag`a${x}b${'y'}c`;"));
    it("tag`a${'x'}b${y}c`", () => test("tag`a${'x'}b${y}c`", "tag`a${'x'}b${y}c`;"));
    it("tag`a${'x'}b${'y'}c`", () => test("tag`a${'x'}b${'y'}c`", "tag`a${'x'}b${'y'}c`;"));
    it('(1, x)``', () => test('(1, x)``', 'x``;'));
    it('(1, x.y)``', () => test('(1, x.y)``', '(0, x.y)``;'));
    it('(1, x[y])``', () => test('(1, x[y])``', '(0, x[y])``;'));
    it('(true && x)``', () => test('(true && x)``', 'x``;'));
    it('(true && x.y)``', () => test('(true && x.y)``', '(0, x.y)``;'));
    it('(true && x[y])``', () => test('(true && x[y])``', '(0, x[y])``;'));
    it('(false || x)``', () => test('(false || x)``', 'x``;'));
    it('(false || x.y)``', () => test('(false || x.y)``', '(0, x.y)``;'));
    it('(false || x[y])``', () => test('(false || x[y])``', '(0, x[y])``;'));
    it('(null ?? x)``', () => test('(null ?? x)``', 'x``;'));
    it('(null ?? x.y)``', () => test('(null ?? x.y)``', '(0, x.y)``;'));
    it('(null ?? x[y])``', () => test('(null ?? x[y])``', '(0, x[y])``;'));
    it('return typeof (123, x)', () => test('return typeof (123, x)', 'return typeof (0, x);'));
    it('return typeof (123, x.y)', () => test('return typeof (123, x.y)', 'return typeof x.y;'));
    it('return typeof (123, x); var x', () => test('return typeof (123, x); var x', 'return typeof x;var x;'));
    it('return typeof (true && x)', () => test('return typeof (true && x)', 'return typeof (0, x);'));
    it('return typeof (true && x.y)', () => test('return typeof (true && x.y)', 'return typeof x.y;'));
    it('return typeof (true && x); var x', () => test('return typeof (true && x); var x', 'return typeof x;var x;'));
    it('return typeof (false || x)', () => test('return typeof (false || x)', 'return typeof (0, x);'));
    it('return typeof (false || x.y)', () => test('return typeof (false || x.y)', 'return typeof x.y;'));
    it('return typeof (false || x); var x', () => test('return typeof (false || x); var x', 'return typeof x;var x;'));
    it("return typeof x !== 'undefined'", () => test("return typeof x !== 'undefined'", "return typeof x < 'u';"));
    it("return typeof x != 'undefined'", () => test("return typeof x != 'undefined'", "return typeof x < 'u';"));
    it("return 'undefined' !== typeof x", () => test("return 'undefined' !== typeof x", "return typeof x < 'u';"));
    it("return 'undefined' != typeof x", () => test("return 'undefined' != typeof x", "return typeof x < 'u';"));
    it("return typeof x === 'undefined'", () => test("return typeof x === 'undefined'", "return typeof x > 'u';"));
    it("return typeof x == 'undefined'", () => test("return typeof x == 'undefined'", "return typeof x > 'u';"));
    it("return 'undefined' === typeof x", () => test("return 'undefined' === typeof x", "return typeof x > 'u';"));
    it("return 'undefined' == typeof x", () => test("return 'undefined' == typeof x", "return typeof x > 'u';"));
    it('return typeof x === y', () => test('return typeof x === y', 'return typeof x === y;'));
    it('return typeof x !== y', () => test('return typeof x !== y', 'return typeof x !== y;'));
    it('return y === typeof x', () => test('return y === typeof x', 'return y === typeof x;'));
    it('return y !== typeof x', () => test('return y !== typeof x', 'return y !== typeof x;'));
    it("return typeof x === 'string'", () => test("return typeof x === 'string'", "return typeof x == 'string';"));
    it("return typeof x !== 'string'", () => test("return typeof x !== 'string'", "return typeof x != 'string';"));
    it("return 'string' === typeof x", () => test("return 'string' === typeof x", "return typeof x == 'string';"));
    it("return 'string' !== typeof x", () => test("return 'string' !== typeof x", "return typeof x != 'string';"));
    it('return a === 0', () => test('return a === 0', 'return a === 0;'));
    it('return a !== 0', () => test('return a !== 0', 'return a !== 0;'));
    it('return +a === 0', () => test('return +a === 0', 'return +a == 0;'));
    it('return +a !== 0', () => test('return +a !== 0', 'return +a != 0;'));
    it('return -a === 0', () => test('return -a === 0', 'return -a === 0;'));
    it('return -a !== 0', () => test('return -a !== 0', 'return -a !== 0;'));
    it("return a === ''", () => test("return a === ''", "return a === '';"));
    it("return a !== ''", () => test("return a !== ''", "return a !== '';"));
    it("return (a + '!') === 'a!'", () => test("return (a + '!') === 'a!'", "return a + '!' == 'a!';"));
    it("return (a + '!') !== 'a!'", () => test("return (a + '!') !== 'a!'", "return a + '!' != 'a!';"));
    it("return (a += '!') === 'a!'", () => test("return (a += '!') === 'a!'", "return (a += '!') == 'a!';"));
    it("return (a += '!') !== 'a!'", () => test("return (a += '!') !== 'a!'", "return (a += '!') != 'a!';"));
    it('return a === false', () => test('return a === false', 'return a === !1;'));
    it('return a === true', () => test('return a === true', 'return a === !0;'));
    it('return a !== false', () => test('return a !== false', 'return a !== !1;'));
    it('return a !== true', () => test('return a !== true', 'return a !== !0;'));
    it('return !a === false', () => test('return !a === false', 'return !!a;'));
    it('return !a === true', () => test('return !a === true', 'return !a;'));
    it('return !a !== false', () => test('return !a !== false', 'return !a;'));
    it('return !a !== true', () => test('return !a !== true', 'return !!a;'));
    it('return a === !b', () => test('return a === !b', 'return a === !b;'));
    it('return a === !b', () => test('return a === !b', 'return a === !b;'));
    it('return a !== !b', () => test('return a !== !b', 'return a !== !b;'));
    it('return a !== !b', () => test('return a !== !b', 'return a !== !b;'));
    it('return !a === !b', () => test('return !a === !b', 'return !a == !b;'));
    it('return !a === !b', () => test('return !a === !b', 'return !a == !b;'));
    it('return !a !== !b', () => test('return !a !== !b', 'return !a != !b;'));
    it('return !a !== !b', () => test('return !a !== !b', 'return !a != !b;'));
    it('return (a, -1n) !== -1', () => test('return (a, -1n) !== -1', 'return a, !0;'));
    it('return (a, ~1n) !== -1', () => test('return (a, ~1n) !== -1', 'return a, !0;'));
    it('return (a -= 1n) !== -1', () => test('return (a -= 1n) !== -1', 'return (a -= 1n) !== -1;'));
    it('return (a *= 1n) !== -1', () => test('return (a *= 1n) !== -1', 'return (a *= 1n) !== -1;'));
    it('return (a **= 1n) !== -1', () => test('return (a **= 1n) !== -1', 'return (a **= 1n) !== -1;'));
    it('return (a /= 1n) !== -1', () => test('return (a /= 1n) !== -1', 'return (a /= 1n) !== -1;'));
    it('return (a %= 1n) !== -1', () => test('return (a %= 1n) !== -1', 'return (a %= 1n) !== -1;'));
    it('return (a &= 1n) !== -1', () => test('return (a &= 1n) !== -1', 'return (a &= 1n) !== -1;'));
    it('return (a |= 1n) !== -1', () => test('return (a |= 1n) !== -1', 'return (a |= 1n) !== -1;'));
    it('return (a ^= 1n) !== -1', () => test('return (a ^= 1n) !== -1', 'return (a ^= 1n) !== -1;'));
    it('return -(a, b)', () => test('return -(a, b)', 'return a, -b;'));
    it('return +(a, b)', () => test('return +(a, b)', 'return a, +b;'));
    it('return ~(a, b)', () => test('return ~(a, b)', 'return a, ~b;'));
    it('return !(a, b)', () => test('return !(a, b)', 'return a, !b;'));
    it('return void (a, b)', () => test('return void (a, b)', 'a, b; return;'));
    it('return typeof (a, b)', () => test('return typeof (a, b)', 'return typeof (a, b);'));
    it('return delete (a, b)', () => test('return delete (a, b)', 'return delete (a, b);'));
    it('return (a, b) && c', () => test('return (a, b) && c', 'return a, b && c;'));
    it('return (a, b) == c', () => test('return (a, b) == c', 'return a, b == c;'));
    it('return (a, b) + c', () => test('return (a, b) + c', 'return a, b + c;'));
    it('return a && (b, c)', () => test('return a && (b, c)', 'return a && (b, c);'));
    it('return a == (b, c)', () => test('return a == (b, c)', 'return a == (b, c);'));
    it('return a + (b, c)', () => test('return a + (b, c)', 'return a + (b, c);'));
    it('return (a && b) && c', () => test('return (a && b) && c', 'return a && b && c;'));
    it('return a && (b && c)', () => test('return a && (b && c)', 'return a && b && c;'));
    it('return (a || b) && c', () => test('return (a || b) && c', 'return (a || b) && c;'));
    it('return a && (b || c)', () => test('return a && (b || c)', 'return a && (b || c);'));
    it('return (a || b) || c', () => test('return (a || b) || c', 'return a || b || c;'));
    it('return a || (b || c)', () => test('return a || (b || c)', 'return a || b || c;'));
    it('return (a && b) || c', () => test('return (a && b) || c', 'return a && b || c;'));
    it('return a || (b && c)', () => test('return a || (b && c)', 'return a || b && c;'));
    it('return a === void 0', () => test('return a === void 0', 'return a === void 0;'));
    it('return a !== void 0', () => test('return a !== void 0', 'return a !== void 0;'));
    it('return void 0 === a', () => test('return void 0 === a', 'return a === void 0;'));
    it('return void 0 !== a', () => test('return void 0 !== a', 'return a !== void 0;'));
    it('return a == void 0', () => test('return a == void 0', 'return a == null;'));
    it('return a != void 0', () => test('return a != void 0', 'return a != null;'));
    it('return void 0 == a', () => test('return void 0 == a', 'return a == null;'));
    it('return void 0 != a', () => test('return void 0 != a', 'return a != null;'));
    it('return a === null || a === undefined', () => test('return a === null || a === undefined', 'return a == null;'));
    it('return a === null || a !== undefined', () =>
        test('return a === null || a !== undefined', 'return a === null || a !== void 0;'));
    it('return a !== null || a === undefined', () =>
        test('return a !== null || a === undefined', 'return a !== null || a === void 0;'));
    it('return a === null && a === undefined', () =>
        test('return a === null && a === undefined', 'return a === null && a === void 0;'));
    it('return a.x === null || a.x === undefined', () =>
        test('return a.x === null || a.x === undefined', 'return a.x === null || a.x === void 0;'));
    it('return a === undefined || a === null', () => test('return a === undefined || a === null', 'return a == null;'));
    it('return a === undefined || a !== null', () =>
        test('return a === undefined || a !== null', 'return a === void 0 || a !== null;'));
    it('return a !== undefined || a === null', () =>
        test('return a !== undefined || a === null', 'return a !== void 0 || a === null;'));
    it('return a === undefined && a === null', () =>
        test('return a === undefined && a === null', 'return a === void 0 && a === null;'));
    it('return a.x === undefined || a.x === null', () =>
        test('return a.x === undefined || a.x === null', 'return a.x === void 0 || a.x === null;'));
    it('return a !== null && a !== undefined', () => test('return a !== null && a !== undefined', 'return a != null;'));
    it('return a !== null && a === undefined', () =>
        test('return a !== null && a === undefined', 'return a !== null && a === void 0;'));
    it('return a === null && a !== undefined', () =>
        test('return a === null && a !== undefined', 'return a === null && a !== void 0;'));
    it('return a !== null || a !== undefined', () =>
        test('return a !== null || a !== undefined', 'return a !== null || a !== void 0;'));
    it('return a.x !== null && a.x !== undefined', () =>
        test('return a.x !== null && a.x !== undefined', 'return a.x !== null && a.x !== void 0;'));
    it('return a !== undefined && a !== null', () => test('return a !== undefined && a !== null', 'return a != null;'));
    it('return a !== undefined && a === null', () =>
        test('return a !== undefined && a === null', 'return a !== void 0 && a === null;'));
    it('return a === undefined && a !== null', () =>
        test('return a === undefined && a !== null', 'return a === void 0 && a !== null;'));
    it('return a !== undefined || a !== null', () =>
        test('return a !== undefined || a !== null', 'return a !== void 0 || a !== null;'));
    it('return a.x !== undefined && a.x !== null', () =>
        test('return a.x !== undefined && a.x !== null', 'return a.x !== void 0 && a.x !== null;'));
    it('x = function y() {}', () => test('x = function y() {}', 'x = function() {};'));
    it('x = function y() { return y }', () => test('x = function y() { return y }', 'x = function y() { return y;};'));
    it("x = function y() { return eval('y') }", () =>
        test("x = function y() { return eval('y') }", "x = function y() { return eval('y');};"));
    it('x = function y() { if (0) return y }', () => test('x = function y() { if (0) return y }', 'x = function() {};'));
    it("class x {['y'] = z}", () => test("class x {['y'] = z}", 'class x { y = z;}'));
    it("class x {['y']() {}}", () => test("class x {['y']() {}}", 'class x { y() { }}'));
    it("class x {get ['y']() {}}", () => test("class x {get ['y']() {}}", 'class x { get y() { }}'));
    it("class x {set ['y'](z) {}}", () => test("class x {set ['y'](z) {}}", 'class x { set y(z) { }}'));
    it("class x {async ['y']() {}}", () => test("class x {async ['y']() {}}", 'class x { async y() { }}'));
    it("x = class {['y'] = z}", () => test("x = class {['y'] = z}", 'x = class { y = z;};'));
    it("x = class {['y']() {}}", () => test("x = class {['y']() {}}", 'x = class { y() { }};'));
    it("x = class {get ['y']() {}}", () => test("x = class {get ['y']() {}}", 'x = class { get y() { }};'));
    it("x = class {set ['y'](z) {}}", () => test("x = class {set ['y'](z) {}}", 'x = class { set y(z) { }};'));
    it("x = class {async ['y']() {}}", () => test("x = class {async ['y']() {}}", 'x = class { async y() { }};'));
    it('x = class y {}', () => test('x = class y {}', 'x = class {};'));
    it('x = class y { foo() { return y } }', () =>
        test('x = class y { foo() { return y } }', 'x = class y { foo() { return y; }};'));
    it('x = class y { foo() { if (0) return y } }', () =>
        test('x = class y { foo() { if (0) return y } }', 'x = class { foo() { }};'));
});

describe('test_remove_dead_expr', () => {
    it('null', () => test('null', ''));
    it('void 0', () => test('void 0', ''));
    it('void 0', () => test('void 0', ''));
    it('false', () => test('false', ''));
    it('true', () => test('true', ''));
    it('123', () => test('123', ''));
    it('123n', () => test('123n', ''));
    it("'abc'", () => test("'abc'", "'abc';"));
    it("0; 'abc'", () => test("0; 'abc'", ''));
    it("'abc'; 'use strict'", () => test("'abc'; 'use strict'", "'abc';"));
    it("function f() { 'abc'; 'use strict' }", () => test("function f() { 'abc'; 'use strict' }", "function f() { 'abc'; }"));
    it('this', () => test('this', ''));
    it('/regex/', () => test('/regex/', ''));
    it('(function() {})', () => test('(function() {})', ''));
    it('(() => {})', () => test('(() => {})', ''));
    it('import.meta', () => test('import.meta', ''));
    it('+x', () => test('+x', '+x;'));
    it('-x', () => test('-x', '-x;'));
    it('!x', () => test('!x', 'x;'));
    it('~x', () => test('~x', '~x;'));
    it('++x', () => test('++x', '++x;'));
    it('--x', () => test('--x', '--x;'));
    it('x++', () => test('x++', 'x++;'));
    it('x--', () => test('x--', 'x--;'));
    it('void x', () => test('void x', 'x;'));
    it('delete x', () => test('delete x', 'delete x;'));
    it('typeof x', () => test('typeof x', ''));
    it('typeof x()', () => test('typeof x()', 'x();'));
    it('typeof (0, x)', () => test('typeof (0, x)', 'x;'));
    it('typeof (0 || x)', () => test('typeof (0 || x)', 'x;'));
    it('typeof (1 && x)', () => test('typeof (1 && x)', 'x;'));
    it('typeof (1 ? x : 0)', () => test('typeof (1 ? x : 0)', 'x;'));
    it('typeof (0 ? 1 : x)', () => test('typeof (0 ? 1 : x)', 'x;'));
    it('a + b', () => test('a + b', 'a + b;'));
    it('a - b', () => test('a - b', 'a - b;'));
    it('a * b', () => test('a * b', 'a * b;'));
    it('a / b', () => test('a / b', 'a / b;'));
    it('a % b', () => test('a % b', 'a % b;'));
    it('a ** b', () => test('a ** b', 'a ** b;'));
    it('a & b', () => test('a & b', 'a & b;'));
    it('a | b', () => test('a | b', 'a | b;'));
    it('a ^ b', () => test('a ^ b', 'a ^ b;'));
    it('a << b', () => test('a << b', 'a << b;'));
    it('a >> b', () => test('a >> b', 'a >> b;'));
    it('a >>> b', () => test('a >>> b', 'a >>> b;'));
    it('a === b', () => test('a === b', 'a, b;'));
    it('a !== b', () => test('a !== b', 'a, b;'));
    it('a == b', () => test('a == b', 'a, b;'));
    it('a != b', () => test('a != b', 'a, b;'));
    it('a, b', () => test('a, b', 'a, b;'));
    it("a + '' == b", () => test("a + '' == b", "a + '', b;"));
    it("a + '' != b", () => test("a + '' != b", "a + '', b;"));
    it("a + '' == b + ''", () => test("a + '' == b + ''", "a + '', b + '';"));
    it("a + '' != b + ''", () => test("a + '' != b + ''", "a + '', b + '';"));
    it("a + '' == (b | c)", () => test("a + '' == (b | c)", "a + '', b | c;"));
    it("a + '' != (b | c)", () => test("a + '' != (b | c)", "a + '', b | c;"));
    it("typeof a == b + ''", () => test("typeof a == b + ''", "b + '';"));
    it("typeof a != b + ''", () => test("typeof a != b + ''", "b + '';"));
    it("typeof a == 'b'", () => test("typeof a == 'b'", ''));
    it("typeof a != 'b'", () => test("typeof a != 'b'", ''));
    it('Object', () => test('Object', ''));
    it('Object()', () => test('Object()', ''));
    it('NonObject', () => test('NonObject', 'NonObject;'));
    it('var bound; unbound', () => test('var bound; unbound', 'var bound;unbound;'));
    it('var bound; bound', () => test('var bound; bound', 'var bound;'));
    it('foo, 123, bar', () => test('foo, 123, bar', 'foo, bar;'));
    it('[[foo,, 123,, bar]]', () => test('[[foo,, 123,, bar]]', 'foo, bar;'));
    it('var bound; [123, unbound, ...unbound, 234]', () =>
        test('var bound; [123, unbound, ...unbound, 234]', 'var bound;[unbound, ...unbound];'));
    it('var bound; [123, bound, ...bound, 234]', () => test('var bound; [123, bound, ...bound, 234]', 'var bound;[...bound];'));
    it('({foo, x: 123, [y]: 123, z: z, bar})', () => test('({foo, x: 123, [y]: 123, z: z, bar})', 'foo, y, z, bar;'));
    it('var bound; ({x: 123, unbound, ...unbound, [unbound]: null, y', () =>
        test(
            'var bound; ({x: 123, unbound, ...unbound, [unbound]: null, y: 234})',
            'var bound; unbound, {...unbound}, unbound;',
        ));
    it('var bound; ({x: 123, bound, ...bound, [bound]: null, y: 234}', () =>
        test('var bound; ({x: 123, bound, ...bound, [bound]: null, y: 234})', 'var bound; ({...bound});'));
    it('var bound; ({x: 123, bound, ...bound, [bound]: foo(), y: 234', () =>
        test('var bound; ({x: 123, bound, ...bound, [bound]: foo(), y: 234})', 'var bound; ({...bound}), foo();'));
    it('console.log(1, foo(), bar())', () => test('console.log(1, foo(), bar())', 'console.log(1, foo(), bar());'));
    it('/* @__PURE__ */ console.log(1, foo(), bar())', () =>
        test('/* @__PURE__ */ console.log(1, foo(), bar())', 'foo(), bar();'));
    it('new TestCase(1, foo(), bar())', () => test('new TestCase(1, foo(), bar())', 'new TestCase(1, foo(), bar());'));
    it('/* @__PURE__ */ new TestCase(1, foo(), bar())', () =>
        test('/* @__PURE__ */ new TestCase(1, foo(), bar())', 'foo(), bar();'));
    it('let x = (1, 2)', () => test('let x = (1, 2)', 'let x = 2;'));
    it('let x = (y, 2)', () => test('let x = (y, 2)', 'let x = (y, 2);'));
    it('let x = (/* @__PURE__ */ foo(bar), 2)', () => test('let x = (/* @__PURE__ */ foo(bar), 2)', 'let x = (bar, 2);'));
    it('let x = (2, y)', () => test('let x = (2, y)', 'let x = y;'));
    it('let x = (2, y)()', () => test('let x = (2, y)()', 'let x = y();'));
    it('let x = (true && y)()', () => test('let x = (true && y)()', 'let x = y();'));
    it('let x = (false || y)()', () => test('let x = (false || y)()', 'let x = y();'));
    it('let x = (null ?? y)()', () => test('let x = (null ?? y)()', 'let x = y();'));
    it('let x = (1 ? y : 2)()', () => test('let x = (1 ? y : 2)()', 'let x = y();'));
    it('let x = (0 ? 1 : y)()', () => test('let x = (0 ? 1 : y)()', 'let x = y();'));
    it('let x = (2, y.z)', () => test('let x = (2, y.z)', 'let x = y.z;'));
    it('let x = (2, y.z)()', () => test('let x = (2, y.z)()', 'let x = (0, y.z)();'));
    it('let x = (true && y.z)()', () => test('let x = (true && y.z)()', 'let x = (0, y.z)();'));
    it('let x = (false || y.z)()', () => test('let x = (false || y.z)()', 'let x = (0, y.z)();'));
    it('let x = (null ?? y.z)()', () => test('let x = (null ?? y.z)()', 'let x = (0, y.z)();'));
    it('let x = (1 ? y.z : 2)()', () => test('let x = (1 ? y.z : 2)()', 'let x = (0, y.z)();'));
    it('let x = (0 ? 1 : y.z)()', () => test('let x = (0 ? 1 : y.z)()', 'let x = (0, y.z)();'));
    it('let x = (2, y[z])', () => test('let x = (2, y[z])', 'let x = y[z];'));
    it('let x = (2, y[z])()', () => test('let x = (2, y[z])()', 'let x = (0, y[z])();'));
    it('let x = (true && y[z])()', () => test('let x = (true && y[z])()', 'let x = (0, y[z])();'));
    it('let x = (false || y[z])()', () => test('let x = (false || y[z])()', 'let x = (0, y[z])();'));
    it('let x = (null ?? y[z])()', () => test('let x = (null ?? y[z])()', 'let x = (0, y[z])();'));
    it('let x = (1 ? y[z] : 2)()', () => test('let x = (1 ? y[z] : 2)()', 'let x = (0, y[z])();'));
    it('let x = (0 ? 1 : y[z])()', () => test('let x = (0 ? 1 : y[z])()', 'let x = (0, y[z])();'));
    it('delete (x)', () => test('delete (x)', 'delete x;'));
    it('delete (x); var x', () => test('delete (x); var x', 'delete x;var x;'));
    it('delete (x.y)', () => test('delete (x.y)', 'delete x.y;'));
    it('delete (x[y])', () => test('delete (x[y])', 'delete x[y];'));
    it('delete (x?.y)', () => test('delete (x?.y)', 'delete x?.y;'));
    it('delete (x?.[y])', () => test('delete (x?.[y])', 'delete x?.[y];'));
    it('delete (2, x)', () => test('delete (2, x)', 'delete (0, x);'));
    it('delete (2, x); var x', () => test('delete (2, x); var x', 'delete (0, x);var x;'));
    it('delete (2, x.y)', () => test('delete (2, x.y)', 'delete (0, x.y);'));
    it('delete (2, x[y])', () => test('delete (2, x[y])', 'delete (0, x[y]);'));
    it('delete (2, x?.y)', () => test('delete (2, x?.y)', 'delete (0, x?.y);'));
    it('delete (2, x?.[y])', () => test('delete (2, x?.[y])', 'delete (0, x?.[y]);'));
    it('delete (true && x)', () => test('delete (true && x)', 'delete (0, x);'));
    it('delete (false || x)', () => test('delete (false || x)', 'delete (0, x);'));
    it('delete (null ?? x)', () => test('delete (null ?? x)', 'delete (0, x);'));
    it('delete (1 ? x : 2)', () => test('delete (1 ? x : 2)', 'delete (0, x);'));
    it('delete (0 ? 1 : x)', () => test('delete (0 ? 1 : x)', 'delete (0, x);'));
    it('delete (NaN)', () => test('delete (NaN)', 'delete NaN;'));
    it('delete (Infinity)', () => test('delete (Infinity)', 'delete Infinity;'));
    it('delete (-Infinity)', () => test('delete (-Infinity)', 'delete -Infinity;'));
    it('delete (1, NaN)', () => test('delete (1, NaN)', 'delete (0, NaN);'));
    it('delete (1, Infinity)', () => test('delete (1, Infinity)', 'delete (0, Infinity);'));
    it('delete (1, -Infinity)', () => test('delete (1, -Infinity)', 'delete -Infinity;'));
    it('foo ? 1 : 2', () => test('foo ? 1 : 2', 'foo;'));
    it('foo ? 1 : bar', () => test('foo ? 1 : bar', 'foo || bar;'));
    it('foo ? bar : 2', () => test('foo ? bar : 2', 'foo && bar;'));
    it('foo ? bar : baz', () => test('foo ? bar : baz', 'foo ? bar : baz;'));
    it('foo && bar', () => test('foo && bar', 'foo && bar;'));
    it('var foo; foo && bar', () => test('var foo; foo && bar', 'var foo;foo && bar;'));
    it('var bar; foo && bar', () => test('var bar; foo && bar', 'var bar;foo;'));
    it('var foo, bar; foo && bar', () => test('var foo, bar; foo && bar', 'var foo, bar;'));
    it('foo || bar', () => test('foo || bar', 'foo || bar;'));
    it('var foo; foo || bar', () => test('var foo; foo || bar', 'var foo;foo || bar;'));
    it('var bar; foo || bar', () => test('var bar; foo || bar', 'var bar;foo;'));
    it('var foo, bar; foo || bar', () => test('var foo, bar; foo || bar', 'var foo, bar;'));
    it('foo ?? bar', () => test('foo ?? bar', 'foo ?? bar;'));
    it('var foo; foo ?? bar', () => test('var foo; foo ?? bar', 'var foo;foo ?? bar;'));
    it('var bar; foo ?? bar', () => test('var bar; foo ?? bar', 'var bar;foo;'));
    it('var foo, bar; foo ?? bar', () => test('var foo, bar; foo ?? bar', 'var foo, bar;'));
    it('tag`a${b}c${d}e`', () => test('tag`a${b}c${d}e`', 'tag`a${b}c${d}e`;'));
    it('`a${b}c${d}e`', () => test('`a${b}c${d}e`', '`${b}${d}`;'));
    it('`stuff ${x} ${1}`', () => test('`stuff ${x} ${1}`', '`${x}`;'));
    it('`stuff ${1} ${y}`', () => test('`stuff ${1} ${y}`', '`${y}`;'));
    it('`stuff ${x} ${y}`', () => test('`stuff ${x} ${y}`', '`${x}${y}`;'));
    it('`stuff ${x ? 1 : 2} ${y}`', () => test('`stuff ${x ? 1 : 2} ${y}`', 'x, `${y}`;'));
    it('`stuff ${x} ${y ? 1 : 2}`', () => test('`stuff ${x} ${y ? 1 : 2}`', '`${x}`, y;'));
    it('`stuff ${x} ${y ? 1 : 2} ${z}`', () => test('`stuff ${x} ${y ? 1 : 2} ${z}`', '`${x}`, y, `${z}`;'));
    it("'a' + b + 'c' + d", () => test("'a' + b + 'c' + d", "'' + b + d;"));
    it("a + 'b' + c + 'd'", () => test("a + 'b' + c + 'd'", "a + '' + c;"));
    it("a + b + 'c' + 'd'", () => test("a + b + 'c' + 'd'", "a + b + '';"));
    it("'a' + 'b' + c + d", () => test("'a' + 'b' + c + d", "'' + c + d;"));
    it("(a + '') + (b + '')", () => test("(a + '') + (b + '')", "a + (b + '');"));
});

describe('test_inline_single_use_variable', () => {
    it('var foo; function wrapper(arg0, arg1) {var x = foo; return x', () =>
        test(
            'var foo; function wrapper(arg0, arg1) {var x = foo; return x}',
            'var foo; function wrapper(arg0, arg1) { return foo;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; return ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; return x}',
            'var foo; function wrapper(arg0, arg1) { return foo;}',
        ));
    it('var foo; function wrapper(arg0, arg1) {const x = foo; return', () =>
        test(
            'var foo; function wrapper(arg0, arg1) {const x = foo; return x}',
            'var foo; function wrapper(arg0, arg1) { return foo;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; if (fal', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; if (false) x++; return x}',
            'var foo; function wrapper(arg0, arg1) { return foo;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; if (tru', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; if (true) x++; return x}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; return x++, x;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; return ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; return x + x}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; return x + x;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; return ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; return +x}',
            'var foo; function wrapper(arg0, arg1) { return +foo;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; return ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; return -x}',
            'var foo; function wrapper(arg0, arg1) { return -foo;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; return ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; return !x}',
            'var foo; function wrapper(arg0, arg1) { return !foo;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; return ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; return ~x}',
            'var foo; function wrapper(arg0, arg1) { return ~foo;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; return ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; return void x}',
            'var foo; function wrapper(arg0, arg1) { let x = foo;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; return ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; return typeof x}',
            'var foo; function wrapper(arg0, arg1) { return typeof foo;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; return ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; return `<${x}>`}',
            'var foo; function wrapper(arg0, arg1) { return `<${foo}>`;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; return ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; return x + 2}',
            'var foo; function wrapper(arg0, arg1) { return foo + 2;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; return ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; return 2 + x}',
            'var foo; function wrapper(arg0, arg1) { return 2 + foo;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; return ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; return x + arg0}',
            'var foo; function wrapper(arg0, arg1) { return foo + arg0;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; return ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; return arg0 + x}',
            'var foo; function wrapper(arg0, arg1) { return arg0 + foo;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; return ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; return x + fn()}',
            'var foo; function wrapper(arg0, arg1) { return foo + fn();}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; return ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; return fn() + x}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; return fn() + x;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; return ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; return x + undef}',
            'var foo; function wrapper(arg0, arg1) { return foo + undef;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; return ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; return undef + x}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; return undef + x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); return x + 2}', () =>
        test('function wrapper(arg0, arg1) { let x = fn(); return x + 2}', 'function wrapper(arg0, arg1) { return fn() + 2;}'));
    it('function wrapper(arg0, arg1) { let x = fn(); return 2 + x}', () =>
        test('function wrapper(arg0, arg1) { let x = fn(); return 2 + x}', 'function wrapper(arg0, arg1) { return 2 + fn();}'));
    it('function wrapper(arg0, arg1) { let x = fn(); return x + arg0', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); return x + arg0}',
            'function wrapper(arg0, arg1) { return fn() + arg0;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); return arg0.a +', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); return arg0.a + x}',
            'function wrapper(arg0, arg1) { let x = fn(); return arg0.a + x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); return x + fn2(', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); return x + fn2()}',
            'function wrapper(arg0, arg1) { return fn() + fn2();}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); return fn2() + ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); return fn2() + x}',
            'function wrapper(arg0, arg1) { let x = fn(); return fn2() + x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); return x + unde', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); return x + undef}',
            'function wrapper(arg0, arg1) { return fn() + undef;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); return undef + ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); return undef + x}',
            'function wrapper(arg0, arg1) { let x = fn(); return undef + x;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; ++x}', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; ++x}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; ++x;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; --x}', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; --x}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; --x;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; x++}', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; x++}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; x++;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; x--}', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; x--}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; x--;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; delete ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; delete x}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; delete x;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; x = 2}', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; x = 2}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; x = 2;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; x += 2}', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; x += 2}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; x += 2;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; x ||= 2', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; x ||= 2}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; x ||= 2;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; arg0 = ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; arg0 = x}',
            'var foo; function wrapper(arg0, arg1) { arg0 = foo;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; arg0 +=', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; arg0 += x}',
            'var foo; function wrapper(arg0, arg1) { arg0 += foo;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; arg0 ||', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; arg0 ||= x}',
            'var foo; function wrapper(arg0, arg1) { arg0 ||= foo;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); arg0 = x}', () =>
        test('function wrapper(arg0, arg1) { let x = fn(); arg0 = x}', 'function wrapper(arg0, arg1) { arg0 = fn();}'));
    it('function wrapper(arg0, arg1) { let x = fn(); arg0 += x}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); arg0 += x}',
            'function wrapper(arg0, arg1) { let x = fn(); arg0 += x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); arg0 ||= x}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); arg0 ||= x}',
            'function wrapper(arg0, arg1) { let x = fn(); arg0 ||= x;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; y.z = x', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; y.z = x}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; y.z = x;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; y.z += ', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; y.z += x}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; y.z += x;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; y.z ||=', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; y.z ||= x}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; y.z ||= x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); y.z = x}', () =>
        test('function wrapper(arg0, arg1) { let x = fn(); y.z = x}', 'function wrapper(arg0, arg1) { let x = fn(); y.z = x;}'));
    it('function wrapper(arg0, arg1) { let x = fn(); y.z += x}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); y.z += x}',
            'function wrapper(arg0, arg1) { let x = fn(); y.z += x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); y.z ||= x}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); y.z ||= x}',
            'function wrapper(arg0, arg1) { let x = fn(); y.z ||= x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return x ? y : ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return x ? y : z;}',
            'function wrapper(arg0, arg1) { return arg0 ? y : z;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1 ? x', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1 ? x : y;}',
            'function wrapper(arg0, arg1) { return arg1 ? arg0 : y;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1 ? y', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1 ? y : x;}',
            'function wrapper(arg0, arg1) { return arg1 ? y : arg0;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return x || y;}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return x || y;}',
            'function wrapper(arg0, arg1) { return arg0 || y;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return x && y;}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return x && y;}',
            'function wrapper(arg0, arg1) { return arg0 && y;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return x ?? y;}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return x ?? y;}',
            'function wrapper(arg0, arg1) { return arg0 ?? y;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1 || ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1 || x;}',
            'function wrapper(arg0, arg1) { return arg1 || arg0;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1 && ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1 && x;}',
            'function wrapper(arg0, arg1) { return arg1 && arg0;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1 ?? ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1 ?? x;}',
            'function wrapper(arg0, arg1) { return arg1 ?? arg0;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return y ? x : ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return y ? x : z;}',
            'function wrapper(arg0, arg1) { let x = arg0; return y ? x : z;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return y ? z : ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return y ? z : x;}',
            'function wrapper(arg0, arg1) { let x = arg0; return y ? z : x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return (arg1 ? ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return (arg1 ? 1 : 2) ? x : 3;}',
            'function wrapper(arg0, arg1) { return arg0;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return (arg1 ? ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return (arg1 ? 1 : 2) ? 3 : x;}',
            'function wrapper(arg0, arg1) { let x = arg0; return 3;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return (arg1 ? ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return (arg1 ? y : 1) ? x : 2;}',
            'function wrapper(arg0, arg1) { let x = arg0; return !arg1 || y ? x : 2;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return (arg1 ? ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return (arg1 ? 1 : y) ? x : 2;}',
            'function wrapper(arg0, arg1) { let x = arg0; return arg1 || y ? x : 2;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return (arg1 ? ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return (arg1 ? y : 1) ? 2 : x;}',
            'function wrapper(arg0, arg1) { let x = arg0; return !arg1 || y ? 2 : x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return (arg1 ? ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return (arg1 ? 1 : y) ? 2 : x;}',
            'function wrapper(arg0, arg1) { let x = arg0; return arg1 || y ? 2 : x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return y || x;}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return y || x;}',
            'function wrapper(arg0, arg1) { let x = arg0; return y || x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return y && x;}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return y && x;}',
            'function wrapper(arg0, arg1) { let x = arg0; return y && x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return y ?? x;}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return y ?? x;}',
            'function wrapper(arg0, arg1) { let x = arg0; return y ?? x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); return x ? arg0', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); return x ? arg0 : y;}',
            'function wrapper(arg0, arg1) { return fn() ? arg0 : y;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); return arg0 ? x', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); return arg0 ? x : y;}',
            'function wrapper(arg0, arg1) { let x = fn(); return arg0 ? x : y;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); return arg0 ? y', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); return arg0 ? y : x;}',
            'function wrapper(arg0, arg1) { let x = fn(); return arg0 ? y : x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); return x || arg', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); return x || arg0;}',
            'function wrapper(arg0, arg1) { return fn() || arg0;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); return x && arg', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); return x && arg0;}',
            'function wrapper(arg0, arg1) { return fn() && arg0;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); return x ?? arg', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); return x ?? arg0;}',
            'function wrapper(arg0, arg1) { return fn() ?? arg0;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); return arg0 || ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); return arg0 || x;}',
            'function wrapper(arg0, arg1) { let x = fn(); return arg0 || x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); return arg0 && ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); return arg0 && x;}',
            'function wrapper(arg0, arg1) { let x = fn(); return arg0 && x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); return arg0 ?? ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); return arg0 ?? x;}',
            'function wrapper(arg0, arg1) { let x = fn(); return arg0 ?? x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); let y = x[prop]', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); let y = x[prop]; let z = y.val; throw z}',
            'function wrapper(arg0, arg1) { throw fn()[prop].val;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(), y = x[prop], z ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(), y = x[prop], z = y.val; throw z}',
            'function wrapper(arg0, arg1) { throw fn()[prop].val;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); let y = x[prop]', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); let y = x[prop]; let z = y.val; return z}',
            'function wrapper(arg0, arg1) { return fn()[prop].val;}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(), y = x[prop], z ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(), y = x[prop], z = y.val; return z}',
            'function wrapper(arg0, arg1) { return fn()[prop].val;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; let y =', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; let y = ++x; return y}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; return ++x;}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; let y =', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; let y = x; return [x, y]}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; return [x, x];}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; let y =', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; let y = ++x; return [x, y]}',
            'var foo; function wrapper(arg0, arg1) { let x = foo, y = ++x; return [x, y];}',
        ));
    it('var foo; function wrapper(arg0, arg1) { let x = foo; let y =', () =>
        test(
            'var foo; function wrapper(arg0, arg1) { let x = foo; let y = {valueOf() { x = 1 }}; let z = x; return [y == 1, z]}',
            'var foo; function wrapper(arg0, arg1) { let x = foo; return [{ valueOf() { x = 1; } } == 1, x];}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return [...x];}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return [...x];}',
            'function wrapper(arg0, arg1) { return [...arg0];}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return [x, ...a', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return [x, ...arg1];}',
            'function wrapper(arg0, arg1) { return [arg0, ...arg1];}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return [...arg1', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return [...arg1, x];}',
            'function wrapper(arg0, arg1) { let x = arg0; return [...arg1, x];}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1(...', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1(...x);}',
            'function wrapper(arg0, arg1) { return arg1(...arg0);}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1(x, ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1(x, ...arg1);}',
            'function wrapper(arg0, arg1) { return arg1(arg0, ...arg1);}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1(...', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1(...arg1, x);}',
            'function wrapper(arg0, arg1) { let x = arg0; return arg1(...arg1, x);}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; arg1(x);}', () =>
        test('function wrapper(arg0, arg1) { let x = arg0; arg1(x);}', 'function wrapper(arg0, arg1) { arg1(arg0);}'));
    it('function wrapper(arg0, arg1) { let x = arg0; throw x;}', () =>
        test('function wrapper(arg0, arg1) { let x = arg0; throw x;}', 'function wrapper(arg0, arg1) { throw arg0;}'));
    it('function wrapper(arg0, arg1) { let x = arg0; return x;}', () =>
        test('function wrapper(arg0, arg1) { let x = arg0; return x;}', 'function wrapper(arg0, arg1) { return arg0;}'));
    it('function wrapper(arg0, arg1) { let x = arg0; if (x) return 1', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; if (x) return 1;}',
            'function wrapper(arg0, arg1) { if (arg0) return 1;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; switch (x) { ca', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; switch (x) { case 0: return 1; }}',
            'function wrapper(arg0, arg1) { if (arg0 === 0) return 1; }',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; let y = x; retu', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; let y = x; return y + y;}',
            'function wrapper(arg0, arg1) { let y = arg0; return y + y;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; do {} while (x)', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; do {} while (x);}',
            'function wrapper(arg0, arg1) { let x = arg0; do ; while (x);}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; while (x) retur', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; while (x) return 1;}',
            'function wrapper(arg0, arg1) { let x = arg0; for (; x; ) return 1;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; for (; x; ) ret', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; for (; x; ) return 1;}',
            'function wrapper(arg0, arg1) { let x = arg0; for (; x; ) return 1;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1?.[x', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.[x];}',
            'function wrapper(arg0, arg1) { return arg1?.[arg0];}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1?.(x', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.(x);}',
            'function wrapper(arg0, arg1) { return arg1?.(arg0);}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); return arg1?.[x', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); return arg1?.[x];}',
            'function wrapper(arg0, arg1) { let x = fn(); return arg1?.[x];}',
        ));
    it('function wrapper(arg0, arg1) { let x = fn(); return arg1?.(x', () =>
        test(
            'function wrapper(arg0, arg1) { let x = fn(); return arg1?.(x);}',
            'function wrapper(arg0, arg1) { let x = fn(); return arg1?.(x);}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1?.a ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.a === x;}',
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.a === x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1?.[0', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.[0] === x;}',
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.[0] === x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1?.(0', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.(0) === x;}',
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.(0) === x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1?.a[', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.a[x];}',
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.a[x];}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1?.a(', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.a(x);}',
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.a(x);}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1?.[a', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.[a][x];}',
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.[a][x];}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1?.[a', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.[a](x);}',
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.[a](x);}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1?.(a', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.(a)[x];}',
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.(a)[x];}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1?.(a', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.(a)(x);}',
            'function wrapper(arg0, arg1) { let x = arg0; return arg1?.(a)(x);}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return {x};}', () =>
        test('function wrapper(arg0, arg1) { let x = arg0; return {x};}', 'function wrapper(arg0, arg1) { return { x: arg0 };}'));
    it('function wrapper(arg0, arg1) { let x = arg0; return {x: y, y', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return {x: y, y: x};}',
            'function wrapper(arg0, arg1) { let x = arg0; return { x: y, y: x };}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return {x: arg1', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return {x: arg1, y: x};}',
            'function wrapper(arg0, arg1) { return { x: arg1, y: arg0 };}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return {[x]: 0}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return {[x]: 0};}',
            'function wrapper(arg0, arg1) { return { [arg0]: 0 };}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return {[y]: x}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return {[y]: x};}',
            'function wrapper(arg0, arg1) { let x = arg0; return { [y]: x };}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return {[arg1]:', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return {[arg1]: x};}',
            'function wrapper(arg0, arg1) { let x = arg0; return { [arg1]: x };}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return {y() {},', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return {y() {}, x};}',
            'function wrapper(arg0, arg1) { return { y() { }, x: arg0 };}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return {[y]() {', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return {[y]() {}, x};}',
            'function wrapper(arg0, arg1) { let x = arg0; return { [y]() { }, x };}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return {...x};}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return {...x};}',
            'function wrapper(arg0, arg1) { return { ...arg0 };}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return {...x, y', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return {...x, y};}',
            'function wrapper(arg0, arg1) { return { ...arg0, y };}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return {x, ...y', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return {x, ...y};}',
            'function wrapper(arg0, arg1) { return { x: arg0, ...y };}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return {...y, x', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return {...y, x};}',
            'function wrapper(arg0, arg1) { let x = arg0; return { ...y, x };}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return `a${x}b$', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return `a${x}b${y}c`;}',
            'function wrapper(arg0, arg1) { return `a${arg0}b${y}c`;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return `a${y}b$', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return `a${y}b${x}c`;}',
            'function wrapper(arg0, arg1) { let x = arg0; return `a${y}b${x}c`;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return `a${arg1', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return `a${arg1}b${x}c`;}',
            'function wrapper(arg0, arg1) { return `a${arg1}b${arg0}c`;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return x`y`;}', () =>
        test('function wrapper(arg0, arg1) { let x = arg0; return x`y`;}', 'function wrapper(arg0, arg1) { return arg0`y`;}'));
    it('function wrapper(arg0, arg1) { let x = arg0; return y`a${x}b', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return y`a${x}b`;}',
            'function wrapper(arg0, arg1) { let x = arg0; return y`a${x}b`;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return arg1`a${', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return arg1`a${x}b`;}',
            'function wrapper(arg0, arg1) { return arg1`a${arg0}b`;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return import(x', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return import(x);}',
            'function wrapper(arg0, arg1) { return import(arg0);}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return [import(', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return [import(y), x];}',
            'function wrapper(arg0, arg1) { let x = arg0; return [import(y), x];}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; return [import(', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0; return [import(arg1), x];}',
            'function wrapper(arg0, arg1) { return [import(arg1), arg0];}',
        ));
    it('function wrapper(arg0, arg1) {return async () => { let x = a', () =>
        test(
            'function wrapper(arg0, arg1) {return async () => { let x = arg0; await x; };}',
            'function wrapper(arg0, arg1) { return async () => { await arg0; };}',
        ));
    it('function wrapper(arg0, arg1) {return async () => { let x = a', () =>
        test(
            'function wrapper(arg0, arg1) {return async () => { let x = arg0; await y; return x; };}',
            'function wrapper(arg0, arg1) { return async () => { let x = arg0; return await y, x; };}',
        ));
    it('function wrapper(arg0, arg1) {return async () => { let x = a', () =>
        test(
            'function wrapper(arg0, arg1) {return async () => { let x = arg0; await arg1; return x; };}',
            'function wrapper(arg0, arg1) { return async () => { let x = arg0; return await arg1, x; };}',
        ));
    it('function wrapper(arg0, arg1) {return function* () { let x = ', () =>
        test(
            'function wrapper(arg0, arg1) {return function* () { let x = arg0; yield x; };}',
            'function wrapper(arg0, arg1) { return function* () { yield arg0; };}',
        ));
    it('function wrapper(arg0, arg1) {return function* () { let x = ', () =>
        test(
            'function wrapper(arg0, arg1) {return function* () { let x = arg0; yield; return x; };}',
            'function wrapper(arg0, arg1) { return function* () { let x = arg0; return yield, x; };}',
        ));
    it('function wrapper(arg0, arg1) {return function* () { let x = ', () =>
        test(
            'function wrapper(arg0, arg1) {return function* () { let x = arg0; yield y; return x; };}',
            'function wrapper(arg0, arg1) { return function* () { let x = arg0; return yield y, x; };}',
        ));
    it('function wrapper(arg0, arg1) {return function* () { let x = ', () =>
        test(
            'function wrapper(arg0, arg1) {return function* () { let x = arg0; yield arg1; return x; };}',
            'function wrapper(arg0, arg1) { return function* () { let x = arg0; return yield arg1, x; };}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0; x()}', () =>
        test('function wrapper(arg0, arg1) { let x = arg0; x()}', 'function wrapper(arg0, arg1) { arg0();}'));
    it('function wrapper(arg0, arg1) { let x = arg0; (0, x)()}', () =>
        test('function wrapper(arg0, arg1) { let x = arg0; (0, x)()}', 'function wrapper(arg0, arg1) { arg0();}'));
    it('function wrapper(arg0, arg1) { let x = arg0.foo; x.bar()}', () =>
        test('function wrapper(arg0, arg1) { let x = arg0.foo; x.bar()}', 'function wrapper(arg0, arg1) { arg0.foo.bar();}'));
    it('function wrapper(arg0, arg1) { let x = arg0.foo; x[bar]()}', () =>
        test('function wrapper(arg0, arg1) { let x = arg0.foo; x[bar]()}', 'function wrapper(arg0, arg1) { arg0.foo[bar]();}'));
    it('function wrapper(arg0, arg1) { let x = arg0.foo; x()}', () =>
        test('function wrapper(arg0, arg1) { let x = arg0.foo; x()}', 'function wrapper(arg0, arg1) { let x = arg0.foo; x();}'));
    it('function wrapper(arg0, arg1) { let x = arg0[foo]; x()}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0[foo]; x()}',
            'function wrapper(arg0, arg1) { let x = arg0[foo]; x();}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0?.foo; x()}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0?.foo; x()}',
            'function wrapper(arg0, arg1) { let x = arg0?.foo; x();}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0?.[foo]; x()}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0?.[foo]; x()}',
            'function wrapper(arg0, arg1) { let x = arg0?.[foo]; x();}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0.foo; (0, x)()}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0.foo; (0, x)()}',
            'function wrapper(arg0, arg1) { let x = arg0.foo; x();}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0[foo]; (0, x)()}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0[foo]; (0, x)()}',
            'function wrapper(arg0, arg1) { let x = arg0[foo]; x();}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0?.foo; (0, x)()}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0?.foo; (0, x)()}',
            'function wrapper(arg0, arg1) { let x = arg0?.foo; x();}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0?.[foo]; (0, x)()', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0?.[foo]; (0, x)()}',
            'function wrapper(arg0, arg1) { let x = arg0?.[foo]; x();}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0(); arg1() + x}', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0(); arg1() + x}',
            'function wrapper(arg0, arg1) { let x = arg0(); arg1() + x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = arg0(); /* @__PURE__ ', () =>
        test(
            'function wrapper(arg0, arg1) { let x = arg0(); /* @__PURE__ */ arg1() + x}',
            'function wrapper(arg0, arg1) { let x = arg0(); /* @__PURE__ */ arg1() + x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = /* @__PURE__ */ arg0(', () =>
        test(
            'function wrapper(arg0, arg1) { let x = /* @__PURE__ */ arg0(); arg1() + x}',
            'function wrapper(arg0, arg1) { let x = /* @__PURE__ */ arg0(); arg1() + x;}',
        ));
    it('function wrapper(arg0, arg1) { let x = /* @__PURE__ */ arg0(', () =>
        test(
            'function wrapper(arg0, arg1) { let x = /* @__PURE__ */ arg0(); /* @__PURE__ */ arg1() + x}',
            'function wrapper(arg0, arg1) { /* @__PURE__ */ arg1() + /* @__PURE__ */ arg0();}',
        ));
});

describe('test_remove_dead_expr_other', () => {
    it('if (1) a(); else { ; }', () => test('if (1) a(); else { ; }', 'a();'));
    it('if (1) a(); else { b() }', () => test('if (1) a(); else { b() }', 'a();'));
    it('if (1) a(); else { const b = c }', () => test('if (1) a(); else { const b = c }', 'a();'));
    it('if (1) a(); else { let b }', () => test('if (1) a(); else { let b }', 'a();'));
    it('if (1) a(); else { throw b }', () => test('if (1) a(); else { throw b }', 'a();'));
    it('if (1) a(); else { return b }', () => test('if (1) a(); else { return b }', 'a();'));
    it('b: { if (x) a(); else { break b } }', () => test('b: { if (x) a(); else { break b } }', 'b: if (x) a(); else break b;'));
    it('b: { if (0) a(); else { break b } }', () => test('b: { if (0) a(); else { break b } }', ''));
    it('b: while (1) if (x) a(); else { continue b }', () =>
        test('b: while (1) if (x) a(); else { continue b }', 'b: for (;;) if (x) a(); else continue b;'));
    it('b: while (1) if (0) a(); else { continue b }', () =>
        test('b: while (1) if (0) a(); else { continue b }', 'b: for (;;) continue b;'));
    it('if (1) a(); else { class b {} }', () => test('if (1) a(); else { class b {} }', 'a();'));
    it('if (1) a(); else { debugger }', () => test('if (1) a(); else { debugger }', 'a();'));
    it('if (1) a(); else { switch (1) { case 1: b() } }', () => test('if (1) a(); else { switch (1) { case 1: b() } }', 'a();'));
    it('if (0) { let a = 1} else a()', () => test('if (0) { let a = 1} else a()', 'a();'));
    it('if (1) { let a = 1} else a()', () => test('if (1) { let a = 1} else a()', '{ let a = 1;}'));
    it('if (0) a(); else { let a = 1}', () => test('if (0) a(); else { let a = 1}', '{ let a = 1;}'));
    it('if (1) a(); else { let a = 1}', () => test('if (1) a(); else { let a = 1}', 'a();'));
    it('if (1) a(); else { var a = b }', () => test('if (1) a(); else { var a = b }', 'if (1) a(); else var a;'));
    it('if (1) a(); else { var [a] = b }', () => test('if (1) a(); else { var [a] = b }', 'if (1) a(); else var a;'));
    it('if (1) a(); else { var {x: a} = b }', () => test('if (1) a(); else { var {x: a} = b }', 'if (1) a(); else var a;'));
    it('if (1) a(); else { var [] = b }', () => test('if (1) a(); else { var [] = b }', 'a();'));
    it('if (1) a(); else { var {} = b }', () => test('if (1) a(); else { var {} = b }', 'a();'));
    it('if (1) a(); else { for(;;){var a} }', () => test('if (1) a(); else { for(;;){var a} }', 'if (1) a(); else var a;'));
    it('if (1) { a(); b() } else { var a; var b; }', () =>
        test('if (1) { a(); b() } else { var a; var b; }', 'if (1) a(), b(); else var a, b;'));
    it('if (1) a(); else { switch (1) { case 1: case 2: var a } }', () =>
        test('if (1) a(); else { switch (1) { case 1: case 2: var a } }', 'if (1) a(); else var a;'));
    it("import 'x' assert {'ty pe': 'json'}", () =>
        test("import 'x' assert {'ty pe': 'json'}", "import 'x' assert { 'ty pe': 'json' };"));
    it("import(x ? 'y' : 'z', {assert: {'a': 'b'}})", () =>
        test("import(x ? 'y' : 'z', {assert: {'a': 'b'}})", "import(x ? 'y' : 'z', { assert: { a: 'b' } });"));
    it("import(x ? 'y' : 'z', {assert: {'a a': 'b'}})", () =>
        test("import(x ? 'y' : 'z', {assert: {'a a': 'b'}})", "import(x ? 'y' : 'z', { assert: { 'a a': 'b' } });"));
    it("import 'x' with {'ty pe': 'json'}", () =>
        test("import 'x' with {'ty pe': 'json'}", "import 'x' with { 'ty pe': 'json' };"));
    it("import(x ? 'y' : 'z', {with: {'a': 'b'}})", () =>
        test("import(x ? 'y' : 'z', {with: {'a': 'b'}})", "import(x ? 'y' : 'z', { with: { a: 'b' } });"));
    it("import(x ? 'y' : 'z', {with: {'a a': 'b'}})", () =>
        test("import(x ? 'y' : 'z', {with: {'a a': 'b'}})", "import(x ? 'y' : 'z', { with: { 'a a': 'b' } });"));
    it('try { throw 0 } catch (e) { console.log(0) }', () =>
        test('try { throw 0 } catch (e) { console.log(0) }', 'try { throw 0;} catch { console.log(0);}'));
    it('try { throw 0 } catch (e) { console.log(0, e) }', () =>
        test('try { throw 0 } catch (e) { console.log(0, e) }', 'try { throw 0;} catch (e) { console.log(0, e);}'));
    it('try { throw 0 } catch (e) { 0 && console.log(0, e) }', () =>
        test('try { throw 0 } catch (e) { 0 && console.log(0, e) }', 'try { throw 0;} catch {}'));
    it('try { thrower() } catch ([a]) { console.log(0) }', () =>
        test('try { thrower() } catch ([a]) { console.log(0) }', 'try { thrower();} catch ([a]) { console.log(0);}'));
    it('try { thrower() } catch ({ a }) { console.log(0) }', () =>
        test('try { thrower() } catch ({ a }) { console.log(0) }', 'try { thrower();} catch ({ a }) { console.log(0);}'));
    it('try { throw 1 } catch (x) { y(x); var x = 2; y(x) }', () =>
        test('try { throw 1 } catch (x) { y(x); var x = 2; y(x) }', 'try { throw 1;} catch (x) { y(x); var x = 2; y(x);}'));
    it('try { throw 1 } catch (x) { var x = 2; y(x) }', () =>
        test('try { throw 1 } catch (x) { var x = 2; y(x) }', 'try { throw 1;} catch (x) { var x = 2; y(x);}'));
    it('try { throw 1 } catch (x) { var x = 2; y(x) } console.log(x)', () =>
        test(
            'try { throw 1 } catch (x) { var x = 2; y(x) } console.log(x)',
            'try { throw 1;} catch (x) { var x = 2; y(x);} console.log(x)',
        ));
    it('try { throw 1 } catch (x) { var x = 2 }; y(x)', () =>
        test('try { throw 1 } catch (x) { var x = 2 }; y(x)', 'try { throw 1;} catch (x) { var x = 2;} y(x);'));
    it("try { throw 1 } catch (x) { eval('x') }", () =>
        test("try { throw 1 } catch (x) { eval('x') }", "try { throw 1;} catch (x) { eval('x');}"));
    it("if (y) try { throw 1 } catch (x) {} else eval('x')", () =>
        test("if (y) try { throw 1 } catch (x) {} else eval('x')", "if (y) try { throw 1;} catch {}else eval('x');"));
    it('try { throw 0 } catch (e) { foo() }', () =>
        test('try { throw 0 } catch (e) { foo() }', 'try { throw 0;} catch { foo();}'));
    it('try {} catch (e) { var foo }', () => test('try {} catch (e) { var foo }', 'try {} catch { var foo;}'));
    it('try {} catch (e) { foo() }', () => test('try {} catch (e) { foo() }', ''));
    it('try {} catch (e) { foo() } finally {}', () => test('try {} catch (e) { foo() } finally {}', ''));
    it('try {} finally { foo() }', () => test('try {} finally { foo() }', 'foo();'));
    it('try {} catch (e) { foo() } finally { bar() }', () => test('try {} catch (e) { foo() } finally { bar() }', 'bar();'));
    it('try {} finally { var x = foo() }', () => test('try {} finally { var x = foo() }', 'var x = foo();'));
    it('try {} catch (e) { foo() } finally { var x = bar() }', () =>
        test('try {} catch (e) { foo() } finally { var x = bar() }', 'var x = bar();'));
    it('try {} finally { let x = foo() }', () => test('try {} finally { let x = foo() }', '{ let x = foo();}'));
    it('try {} catch (e) { foo() } finally { let x = bar() }', () =>
        test('try {} catch (e) { foo() } finally { let x = bar() }', '{ let x = bar();}'));
    it('using x = {}', () => test('using x = {}', 'using x = {};'));
    it('using x = (foo, y)', () => test('using x = (foo, y)', 'using x = (foo, y);'));
    it('using x = null, y = z', () => test('using x = null, y = z', 'using x = null, y = z;'));
    it('using x = z, y = undefined', () => test('using x = z, y = undefined', 'using x = z, y = void 0;'));
});

describe('prune_empty_case_before_default', () => {
    it('switch (x) { case 0: foo(); break; case 1: default: bar() }', () =>
        test(
            'switch (x) { case 0: foo(); break; case 1: default: bar() }',
            'switch (x) { case 0: foo(); break; default: bar();}',
        ));
    it('switch (x) { case 0: foo(); break; case 1: case 2: case 3: d', () =>
        test(
            'switch (x) { case 0: foo(); break; case 1: case 2: case 3: default: bar() }',
            'switch (x) { case 0: foo(); break; default: bar();}',
        ));
    it('switch (x) { case 0: foo(); break; case y: default: bar() }', () =>
        test(
            'switch (x) { case 0: foo(); break; case y: default: bar() }',
            'switch (x) { case 0: foo(); break; case y: default: bar();}',
        ));
    it('switch (x) { default: case 1: bar() }', () =>
        test('switch (x) { default: case 1: bar() }', 'switch (x) { default: case 1: bar();}'));
    it("switch (x) { case 'a': case 'b': default: bar() }", () =>
        test("switch (x) { case 'a': case 'b': default: bar() }", 'x, bar();'));
    it('switch (x) { case null: default: bar() }', () => test('switch (x) { case null: default: bar() }', 'x, bar();'));
    it('switch (x) { case 1n: case 2n: default: bar() }', () =>
        test('switch (x) { case 1n: case 2n: default: bar() }', 'x, bar();'));
    it('switch (x) { case 0: case 1: foo(); case 2: case 3: default:', () =>
        test(
            'switch (x) { case 0: case 1: foo(); case 2: case 3: default: bar() }',
            'switch (x) { case 0: case 1: foo(); default: bar();}',
        ));
    it('switch (x) { default: bar() }', () => test('switch (x) { default: bar() }', 'x, bar();'));
    it('switch (x) { case 0: foo(); case 1: }', () => test('switch (x) { case 0: foo(); case 1: }', 'x === 0 && foo();'));
});

// `test_mangle_boolean_with_side_effects` builds its cases from value lists with `format!`.
describe('test_mangle_boolean_with_side_effects', () => {
    for (const value of ['!1', '""', '0', '0n', 'null', 'void 0']) {
        it(`falsy without side effects: ${value}`, () => {
            test(`y(x && ${value})`, `y(x && ${value});`);
            test(`y(x || ${value})`, `y(x || ${value});`);
            test(`y(!(x && ${value}))`, `y(!(x && ${value}));`);
            test(`y(!(x || ${value}))`, 'y(!x);');
            test(`if (x && ${value}) y`, 'x;');
            test(`if (x || ${value}) y`, 'x && y;');
            test(`if (x && ${value}) y; else z`, 'x, z;');
            test(`if (x || ${value}) y; else z`, 'x ? y : z;');
            test(`y(x && ${value} ? y : z)`, 'y((x, z));');
            test(`y(x || ${value} ? y : z)`, 'y(x ? y : z);');
            test(`while (${value}) x()`, '');
            test(`for (; ${value}; ) x()`, '');
        });
    }
    for (const value of ['!0', '" "', '1', '1n', '/./', '(() => {\n})', 'function() {\n}', '[1, 2]', '{ a: 0 }']) {
        it(`truthy without side effects: ${value}`, () => {
            test(`y(x && ${value})`, `y(x && ${value});`);
            test(`y(x || ${value})`, `y(x || ${value});`);
            test(`y(!(x && ${value}))`, 'y(!x);');
            test(`y(!(x || ${value}))`, `y(!(x || ${value}));`);
            test(`if (x && ${value}) y`, 'x && y;');
            test(`if (x || ${value}) y`, 'x, y;');
            test(`if (x && ${value}) y; else z`, 'x ? y : z;');
            test(`if (x || ${value}) y; else z`, 'x, y;');
            test(`y(x && ${value} ? y : z)`, 'y(x ? y : z);');
            test(`y(x || ${value} ? y : z)`, 'y((x, y));');
            test(`while (${value}) x()`, 'for (; ; ) x();');
            test(`for (; ${value}; ) x()`, 'for (; ; ) x();');
        });
    }
    for (const value of ['void foo()']) {
        it(`falsy with side effects: ${value}`, () => {
            test(`y(x && ${value})`, `y(x && ${value});`);
            test(`y(x || ${value})`, `y(x || ${value});`);
            test(`y(!(x && ${value}))`, `y(!(x && ${value}));`);
            test(`y(!(x || ${value}))`, `y(!(x || ${value}));`);
            test(`if (x || ${value}) y`, `(x || ${value}) && y;`);
            test(`if (x || ${value}) y; else z`, `x || ${value} ? y : z;`);
            test(`y(x || ${value} ? y : z)`, `y(x || ${value} ? y : z);`);
            test(`while (${value}) x()`, `for (; ${value}; ) x();`);
            test(`for (; ${value}; ) x()`, `for (; ${value}; ) x();`);
        });
    }
    for (const value of ['typeof foo()', '[foo()]', '{ [foo()]: 0 }']) {
        it(`truthy with side effects: ${value}`, () => {
            test(`y(x && ${value})`, `y(x && ${value});`);
            test(`y(x || ${value})`, `y(x || ${value});`);
            test(`y(!(x || ${value}))`, `y(!(x || ${value}));`);
            test(`y(!(x && ${value}))`, `y(!(x && ${value}));`);
            test(`if (x && ${value}) y`, `x && ${value} && y;`);
            test(`if (x && ${value}) y; else z`, `x && ${value} ? y : z;`);
            test(`y(x && ${value} ? y : z)`, `y(x && ${value} ? y : z);`);
            test(`while (${value}) x()`, `for (; ${value}; ) x();`);
            test(`for (; ${value}; ) x()`, `for (; ${value}; ) x();`);
        });
    }
});
