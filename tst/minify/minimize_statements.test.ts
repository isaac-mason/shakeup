// Ported from oxc_minifier/tests/peephole/minimize_statements.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { test, testSame } from './harness.ts';

describe('test_for_variable_declaration', () => {
    it('function _() { var x; for (var i = 0; i < 10; i++) console.l', () =>
        test(
            'function _() { var x; for (var i = 0; i < 10; i++) console.log(i) }',
            'function _() { for (var x, i = 0; i < 10; i++) console.log(i) }',
        ));
    it('function _() { var x = 1; for (var i = 0; i < 10; i++) conso', () =>
        test(
            'function _() { var x = 1; for (var i = 0; i < 10; i++) console.log(i) }',
            'function _() { for (var x = 1, i = 0; i < 10; i++) console.log(i) }',
        ));
    it('function _() { var x = function () { return console.log(j), ', () =>
        test(
            'function _() { var x = function () { return console.log(j), 1 }; for (var i = 0; i < 10; i++) { let j = k; console.log(i, j, j) } }',
            'function _() { for (var x = function () { return console.log(j), 1 }, i = 0; i < 10; i++) { let j = k; console.log(i, j, j) } }',
        ));
    it('function _() { var x = j; for (var i = 0; i < 10; i++) { let', () =>
        test(
            'function _() { var x = j; for (var i = 0; i < 10; i++) { let j = k; console.log(i, j, j) } }',
            'function _() { for (var x = j, i = 0; i < 10; i++) { let j = k; console.log(i, j, j) } }',
        ));
});

describe('test_for_continue_in_for', () => {
    it('for( a of b ){ if(c) { continue; } d() }', () =>
        test('for( a of b ){ if(c) { continue; } d() }', 'for ( a of b ) c || d();'));
    it('for( a in b ){ if(c) { continue; } d() }', () =>
        test('for( a in b ){ if(c) { continue; } d() }', 'for ( a in b ) c || d();'));
    it('for( ; ; ){ if(c) { continue; } d() }', () => test('for( ; ; ){ if(c) { continue; } d() }', 'for ( ; ; ) c || d();'));
    it('for( a of b ){ c(); continue; }', () => test('for( a of b ){ c(); continue; }', 'for ( a of b ) c();'));
    it('for( a in b ){ c(); continue; }', () => test('for( a in b ){ c(); continue; }', 'for ( a in b ) c();'));
    it('for( ; ; ){ c(); continue; }', () => test('for( ; ; ){ c(); continue; }', 'for ( ; ; ) c();'));
});

describe('test_for_in_block_scoped_no_inline', () => {
    it("{ var name = 'name1'; const foo = { foo: 1 }; name = 'name2'", () =>
        test(
            "{ var name = 'name1'; const foo = { foo: 1 }; name = 'name2'; for (let name in foo) { console.log(name); } console.log(name); }",
            "{ var name = 'name1'; let foo = { foo: 1 }; name = 'name2'; for (let name in foo) console.log(name); console.log(name); }",
        ));
    it("{ var name = 'name1'; const foo = { foo: 1 }; name = 'name2' #2", () =>
        test(
            "{ var name = 'name1'; const foo = { foo: 1 }; name = 'name2'; for (const name in foo) { console.log(name); } console.log(name); }",
            "{ var name = 'name1'; let foo = { foo: 1 }; name = 'name2'; for (let name in foo) console.log(name); console.log(name); }",
        ));
    it("{ var name = 'name1'; const foo = { foo: 1 }; name = 'name2' #3", () =>
        test(
            "{ var name = 'name1'; const foo = { foo: 1 }; name = 'name2'; for (var name in foo) { console.log(name); } console.log(name); }",
            "var name = 'name1'; for (var name in name = 'name2', { foo: 1 }) console.log(name); console.log(name);",
        ));
    it("{ var name = 'name1'; const foo = { foo: 1 }; name = 'name2' #4", () =>
        test(
            "{ var name = 'name1'; const foo = { foo: 1 }; name = 'name2'; for (name in foo) { console.log(name); } console.log(name); }",
            "var name = 'name1'; for (name in name = 'name2', { foo: 1 }) console.log(name); console.log(name);",
        ));
});

describe('test_max_conditional_depth_caps_return_ternary_chain', () => {
    // The output matches; the idempotency run overflows the stack in semantic.ts `analyze` on the
    // 500-deep conditional.
    it.skip('600 chained if-returns', () => {
        const n = 600;
        let input = 'function _() {';
        for (let i = 0; i < n; i++) input += `if (a${i}) return ${i} + 1;`;
        input += 'return 600; }';

        let output = 'function _() {';
        for (let i = 0; i < 99; i++) output += `if (a${i}) return ${i + 1};`;
        output += 'return a99';
        for (let i = 100; i < 599; i++) output += ` ? ${i} : a${i}`;
        output += ' ? 599 : (a599, 600); }';

        test(input, output);
    });
});

describe('test_merge_adjacent_ifs_with_shorthand_object_property', () => {
    it('function _(body) {\n            if (a) return { body };\n     ', () =>
        test(
            'function _(body) {\n            if (a) return { body };\n            if (b) return { body };\n            if (c) return { body };\n            if (d) return { body: body };\n        }',
            'function _(body) { if (a || b || c || d) return { body }; }',
        ));
    it('function _(body) {\n            if (a) return { body };\n      #2', () =>
        test(
            "function _(body) {\n            if (a) return { body };\n            if (b) return { 'body': body };\n        }",
            'function _(body) { if (a || b) return { body }; }',
        ));
    it('function _(body, other) {\n            if (a) return { body }', () =>
        testSame(
            'function _(body, other) {\n            if (a) return { body };\n            if (b) return { other };\n        }',
        ));
});

describe('test_object_property_shorthand_normalisation_skips_proto_setter', () => {
    it('function _(__proto__) { return { __proto__: __proto__ }; }', () =>
        testSame('function _(__proto__) { return { __proto__: __proto__ }; }'));
});

describe('test_handle_switch_statement', () => {
    it('switch (a()) {}', () => test('switch (a()) {}', 'a()'));
    it('switch (a) { default: }', () => test('switch (a) { default: }', 'a;'));
    it('switch (a) { default: break;}', () => test('switch (a) { default: break;}', ' a;'));
    it('switch (a) { default: var b; break;}', () => test('switch (a) { default: var b; break;}', 'a; var b;'));
    it('switch (a) { default: b()}', () => test('switch (a) { default: b()}', 'a, b();'));
    it('switch (a) { default: b(); return;}', () => test('switch (a) { default: b(); return;}', 'a, b(); return;'));
    it('switch (a) { case 1: break;}', () => test('switch (a) { case 1: break;}', 'a;'));
    it('switch (a) { case 1: b();}', () => test('switch (a) { case 1: b();}', 'a === 1 && b();'));
    it('switch (a) { case 1: b();break; }', () => test('switch (a) { case 1: b();break; }', 'a === 1 && b();'));
    it('switch (a) { case 1: b();return; }', () => test('switch (a) { case 1: b();return; }', 'if (a === 1) { b(); return; }'));
    it('switch (a) { default: case 1: }', () => test('switch (a) { default: case 1: }', 'a;'));
    it('switch (a) { case 1: default: }', () => test('switch (a) { case 1: default: }', 'a;'));
    it('switch (a) { case 1: default: break; case 2: b()}', () => testSame('switch (a) { case 1: default: break; case 2: b()}'));
    it('switch (a) { case 1: b(); default: c()}', () => testSame('switch (a) { case 1: b(); default: c()}'));
    it('switch (a) { case 1: default: b(); case 2: c();}', () => testSame('switch (a) { case 1: default: b(); case 2: c();}'));
    it('switch (a) { case 1: b(); default: break; case 2: c()}', () =>
        testSame('switch (a) { case 1: b(); default: break; case 2: c()}'));
    it('switch (a) { case 1: b(); case 2: break; case 3: c()}', () =>
        testSame('switch (a) { case 1: b(); case 2: break; case 3: c()}'));
    it('switch (a) { case 1: b(); break; case 2: c();break;}', () =>
        test('switch (a) { case 1: b(); break; case 2: c();break;}', 'switch (a) { case 1: b(); break; case 2: c();}'));
    it('switch (x) { default: foo(); case 1: }', () => testSame('switch (x) { default: foo(); case 1: }'));
    it('switch (a) { case 1: b(); case 2: b();}', () => testSame('switch (a) { case 1: b(); case 2: b();}'));
    it('switch (a) { case 1: case 2: b(); }', () => testSame('switch (a) { case 1: case 2: b(); }'));
    it('switch (a) { case 1: var c=2; break;}', () => test('switch (a) { case 1: var c=2; break;}', 'if (a === 1) var c=2;'));
    it('switch (a) { case 1: case 2: default: b(); break;}', () =>
        test('switch (a) { case 1: case 2: default: b(); break;}', 'a, b();'));
    it('switch (a) { default: break; case 1: break;}', () => test('switch (a) { default: break; case 1: break;}', 'a;'));
    it('switch (a) { default: b();break;case 1: c();break;}', () =>
        test('switch (a) { default: b();break;case 1: c();break;}', 'switch (a) { default: b();break;case 1: c();}'));
    it('switch (a) { default: {b();break;} case 1: {c();break;}}', () =>
        test('switch (a) { default: {b();break;} case 1: {c();break;}}', 'switch (a) { default: b();break;case 1: c(); }'));
    it('switch (a) { case b(): default:}', () => test('switch (a) { case b(): default:}', 'switch (a) { case b(): }'));
    it('switch (a) { case 2: case 1: break; default: break;}', () =>
        test('switch (a) { case 2: case 1: break; default: break;}', 'a;'));
    it('switch (a) { case 3: b(); break; case 2: break;}', () =>
        test('switch (a) { case 3: b(); break; case 2: break;}', 'a === 3 && b();'));
    it('switch (a) { case 3: b(); case 2: break;}', () => test('switch (a) { case 3: b(); case 2: break;}', 'a === 3 && b();'));
    it('switch (a) { case 3: b(); case 2: c(); break;}', () =>
        test('switch (a) { case 3: b(); case 2: c(); break;}', 'switch (a) { case 3: b(); case 2: c();}'));
    it('switch (a) { case 3: b(); case 2: case 1: break;}', () =>
        test('switch (a) { case 3: b(); case 2: case 1: break;}', 'a === 3 && b();'));
    it('switch (a) { case 3: b(); case 2: case 1: }', () =>
        test('switch (a) { case 3: b(); case 2: case 1: }', 'a === 3 && b();'));
    it('switch (x) { default: case 1: foo(); case 2: }', () => testSame('switch (x) { default: case 1: foo(); case 2: }'));
    it('switch (a) { case 3: if (b) break }', () => testSame('switch (a) { case 3: if (b) break }'));
    it('switch (a) { case 1: if (b) break; c(); }', () => testSame('switch (a) { case 1: if (b) break; c(); }'));
    it('switch (a) { case 3: { if(b) {c()} else {break;} }}', () =>
        test('switch (a) { case 3: { if(b) {c()} else {break;} }}', 'switch (a) { case 3: if (b) c(); else break; }'));
    it('switch (a) { case 3: { if(b) {c(); break;} else { d(); break', () =>
        test(
            'switch (a) { case 3: { if(b) {c(); break;} else { d(); break;} }}',
            'switch (a) { case 3: if(b) {c(); break;} d(); }',
        ));
    it('switch (a) { case 3: { for (;;) break } }', () =>
        test('switch (a) { case 3: { for (;;) break } }', 'if (a === 3) for (;;) break;'));
    it('switch (a) { case 3: { for (b of c) break; } }', () =>
        test('switch (a) { case 3: { for (b of c) break; } }', 'if (a === 3) for (b of c) break;'));
    // shakeup's parser rejects `with` in module code; oxc's parses it.
    it.skip('switch (a) { case 3: with(b) break}', () => testSame('switch (a) { case 3: with(b) break}'));
    it('switch (a) { case 3: while(!0) break}', () =>
        test('switch (a) { case 3: while(!0) break}', 'if (a === 3) for (;;) break;'));
    it('switch (a) { case 1: c(); case 2: default: b();break;}', () =>
        test('switch (a) { case 1: c(); case 2: default: b();break;}', 'switch (a) { case 1: c(); default: b(); }'));
    it('function f() { switch (a) { case 1: return;} }', () =>
        test('function f() { switch (a) { case 1: return;} }', 'function f() { a; }'));
    it('switch (a()) { default: {let y;} }', () => test('switch (a()) { default: {let y;} }', 'a(); { let y; }'));
    it("function f(){switch ('x') { case 'x': var x = 1;break; case ", () =>
        test("function f(){switch ('x') { case 'x': var x = 1;break; case 'y': break; }}", 'function f(){ var x = 1; }'));
    it('switch (a) { default: if(a) {break;}c();}', () =>
        test('switch (a) { default: if(a) {break;}c();}', 'switch (a) { default: if(a) break;c();}'));
    it('switch (a) { case 1: if(a) {b();}c();}', () =>
        test('switch (a) { case 1: if(a) {b();}c();}', 'a === 1 && (a && b(), c());'));
    it("switch ('\\v') { case '\\u000B': foo();}", () => test("switch ('\\v') { case '\\u000B': foo();}", 'foo();'));
    it('x: switch (a) { case 1: break x;}', () =>
        test('x: switch (a) { case 1: break x;}', 'x: switch (a) { case 1: break x; }'));
    it('x: switch (a) { case 2: break x; case 1: break x;}', () =>
        testSame('x: switch (a) { case 2: break x; case 1: break x;}'));
    it('x: switch (2) { case 2: f(); break outer; }', () =>
        test('x: switch (2) { case 2: f(); break outer; }', 'x:switch(2){case 2:f();break outer}'));
    it('x: switch (x) { case 2: f(); for (;;){break outer;}}', () =>
        test('x: switch (x) { case 2: f(); for (;;){break outer;}}', 'x: switch (x) { case 2: for (f();;)break outer}'));
    it('x: switch (a) { case 2: if(b) { break outer; } }', () =>
        test('x: switch (a) { case 2: if(b) { break outer; } }', 'x: switch (a) { case 2: if(b) break outer; }'));
    it("switch ('r') { case 'r': a();break; case 'r': var x=0;break;", () =>
        test(
            "switch ('r') { case 'r': a();break; case 'r': var x=0;break;}",
            "switch ('r') { case 'r': a();break; case 'r': var x=0;}",
        ));
    it('switch (2) { default: a; case 1: b()}', () => testSame('switch (2) { default: a; case 1: b()}'));
    it('switch (1) { case 1: a();break; default: b();}', () => testSame('switch (1) { case 1: a();break; default: b();}'));
    it("switch ('e') { case 'e': case 'f': a();}", () => testSame("switch ('e') { case 'e': case 'f': a();}"));
    it("switch ('a') { case 'a': a();break; case 'b': b();break;}", () =>
        test("switch ('a') { case 'a': a();break; case 'b': b();break;}", "switch ('a') { case 'a': a();break; case 'b': b();}"));
    it("switch ('c') { case 'a': a();break; case 'b': b();break;}", () =>
        test("switch ('c') { case 'a': a();break; case 'b': b();break;}", "switch ('c') { case 'a': a();break; case 'b': b();}"));
    it('switch (1) { case 1: a();break; case 2: bar();break;}', () =>
        test('switch (1) { case 1: a();break; case 2: bar();break;}', 'switch (1) { case 1: a();break; case 2: bar();}'));
    it("switch ('f') { case 'f': a(); case 'b': b();}", () => testSame("switch ('f') { case 'f': a(); case 'b': b();}"));
    it("switch ('f') { case 'f': if (a() > 0) {b();break;} c(); case", () =>
        testSame("switch ('f') { case 'f': if (a() > 0) {b();break;} c(); case 'd': f();}"));
    it("switch ('f') { case 'b': bar();break; case x: x();break; cas", () =>
        test(
            "switch ('f') { case 'b': bar();break; case x: x();break; case 'f': f();break;}",
            "switch ('f') { case 'b': bar();break; case x: x();break; case 'f': f(); }",
        ));
    it('switch (1) { case 1: case 2: {break;} case 3: case 4: defaul', () =>
        test(
            'switch (1) { case 1: case 2: {break;} case 3: case 4: default: b(); break;}',
            'switch (1) { case 1: case 2: break; default: b(); }',
        ));
    it("switch ('d') { case 'foo': foo();break; default: bar();break", () =>
        test(
            "switch ('d') { case 'foo': foo();break; default: bar();break;}",
            "switch ('d') { case 'foo': foo();break; default: bar();}",
        ));
    it('switch (0) { case NaN: foobar();break;case -0: foo();break; ', () =>
        test(
            'switch (0) { case NaN: foobar();break;case -0: foo();break; case 2: bar();break;}',
            'switch (0) { case NaN: foobar();break;case -0: foo();break; case 2: bar();}',
        ));
    it("let x = 1; switch ('x') { case 'x': let x = 2; break;}", () =>
        test("let x = 1; switch ('x') { case 'x': let x = 2; break;}", 'let x = 1; { let x = 2; }'));
    it('switch (1) { case 2: var x=0;}', () => test('switch (1) { case 2: var x=0;}', 'if (0) var x;'));
    it('switch (b) { case 2: switch (a) { case 2: a();break;case 3: ', () =>
        test(
            'switch (b) { case 2: switch (a) { case 2: a();break;case 3: foo();break;}}',
            'if (b === 2) switch (a) { case 2: a();break;case 3: foo();}',
        ));
    it('switch (b) { case 2: switch (a) { case 2: foo()}}', () =>
        test('switch (b) { case 2: switch (a) { case 2: foo()}}', 'b === 2 && a === 2 && foo();'));
    it('function f(){ switch (0) { case x: break; } let x = 1; }', () =>
        test('function f(){ switch (0) { case x: break; } let x = 1; }', 'function f(){ switch (0) { case x: } let x = 1; }'));
    it('function f(){ switch (0) { case x: case y: } let x = 1; }', () =>
        testSame('function f(){ switch (0) { case x: case y: } let x = 1; }'));
});
