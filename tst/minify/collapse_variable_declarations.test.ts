// Ported from oxc_minifier/tests/peephole/collapse_variable_declarations.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { test, testSame } from './harness.ts';

describe('test_collapsing', () => {
    it('var a;var b;', () => test('var a;var b;', 'var a,b;'));
    it('var a = 1;var b = 1;', () => test('var a = 1;var b = 1;', 'var a=1,b=1;'));
    it('var a, b;', () => testSame('var a, b;'));
    it('var a = 1, b = 1;', () => testSame('var a = 1, b = 1;'));
    it('var a;var b, c;var d;', () => test('var a;var b, c;var d;', 'var a,b,c,d;'));
    it('var a = 1;var b = 2, c = 3;var d = 4;', () => test('var a = 1;var b = 2, c = 3;var d = 4;', 'var a=1,b=2,c=3,d=4;'));
    it('var x = 2; foo(x); x = 3; x = 1; var y = 2; var z = 4; x = 5', () =>
        test(
            'var x = 2; foo(x); x = 3; x = 1; var y = 2; var z = 4; x = 5',
            'var x = 2; foo(x), x = 3, x = 1; var y = 2, z = 4; x = 5',
        ));
    it('/* comment */const a = 1; const b = 2', () =>
        test('/* comment */const a = 1; const b = 2', '/* comment */const a = 1, b = 2'));
});

describe('test_issue820', () => {
    it('function f(a){ var b=1; a=2; var c; }', () => testSame('function f(a){ var b=1; a=2; var c; }'));
});

describe('test_if_else_var_declarations', () => {
    it('if (x) var a = 1; else var b = 2;', () => testSame('if (x) var a = 1; else var b = 2;'));
});

describe('test_aggressive_redeclaration_in_for', () => {
    it('for(var x = 1; x = 2; x = 3) x = 4', () => testSame('for(var x = 1; x = 2; x = 3) x = 4'));
    it('for(var x = 1; y = 2; z = 3) {var a = 4}', () =>
        test('for(var x = 1; y = 2; z = 3) {var a = 4}', 'for(var x = 1; y = 2; z = 3) var a = 4'));
    it('var x; for(x = 1; x = 2; z = 3) x = 4', () => testSame('var x; for(x = 1; x = 2; z = 3) x = 4'));
});

describe('test_issue397', () => {
    it('var x; x = 5; var z = 7;', () => test('var x; x = 5; var z = 7;', 'var x = 5, z = 7'));
    it('var x; var y = 3; x = 5;', () => test('var x; var y = 3; x = 5;', 'var x, y = 3; x = 5;'));
    it('var a = 1; var x; var y = 3; x = 5;', () => test('var a = 1; var x; var y = 3; x = 5;', 'var a = 1, x, y = 3; x = 5;'));
    it('var x; var y = 3; x = 5; var z = 7;', () =>
        test('var x; var y = 3; x = 5; var z = 7;', 'var x, y = 3; x = 5; var z = 7;'));
});

describe('test_arguments_assignment', () => {
    it('function f() {arguments = 1;}', () => testSame('function f() {arguments = 1;}'));
});

describe('test_collapsing_let_const', () => {
    it('let a;let b;', () => test('let a;let b;', 'let a,b;'));
    it('const a = 1;const b = 1;', () => test('const a = 1;const b = 1;', 'const a=1,b=1;'));
    it('let a, b;', () => testSame('let a, b;'));
    it('let a = 1, b = 1;', () => testSame('let a = 1, b = 1;'));
    it('let a;let b, c;let d;', () => test('let a;let b, c;let d;', 'let a,b,c,d;'));
    it('let a = 1;let b = 2, c = 3;let d = 4;', () => test('let a = 1;let b = 2, c = 3;let d = 4;', 'let a=1,b=2,c=3,d=4;'));
    it('let a = 1; const b = 2;', () => testSame('let a = 1; const b = 2;'));
});

describe('test_if_else_var_declarations_let', () => {
    it('if (x) { let a = 1; } else { let b = 2; }', () => testSame('if (x) { let a = 1; } else { let b = 2; }'));
});

describe('test_aggressive_redeclaration_of_let_in_for', () => {
    it('for(let x = 1; x = 2; x = 3) x = 4', () => testSame('for(let x = 1; x = 2; x = 3) x = 4'));
    it('for(let x = 1; y = 2; z = 3) {let a = 4}', () => testSame('for(let x = 1; y = 2; z = 3) {let a = 4}'));
    it('let x; for(x = 1; x = 2; z = 3) x = 4', () => testSame('let x; for(x = 1; x = 2; z = 3) x = 4'));
});

describe('test_redeclaration_let_in_function', () => {
    it('function f() { let x = 1; let y = 2; let z = 3; x + y + z; }', () =>
        test('function f() { let x = 1; let y = 2; let z = 3; x + y + z; }', 'function f() { let x = 1, y = 2, z = 3; } '));
    it('var x = 1; function f() { let x = 1; let y = 2; x + y; }', () =>
        test('var x = 1; function f() { let x = 1; let y = 2; x + y; }', 'var x = 1; function f() { let x = 1, y = 2; } '));
    it('function f(x) { let y = 3; x = 4, x + y; }', () =>
        test('function f(x) { let y = 3; x = 4, x + y; }', 'function f(x) { let y = 3; x = 4, x + 3 }'));
});

describe('test_arrow_function', () => {
    it('var f = () => { let x = 1; let y = 2; x + y; }', () =>
        test('var f = () => { let x = 1; let y = 2; x + y; }', 'var f = () => { let x = 1, y = 2; }'));
    it('((x) => { x = 4; let y = 2; x + y; })()', () =>
        test('((x) => { x = 4; let y = 2; x + y; })()', '((x) => { x = 4; let y = 2; x + 2; })()'));
});

describe('test_uncollapsable_declarations', () => {
    it('let x = 1; var y = 2; const z = 3', () => testSame('let x = 1; var y = 2; const z = 3'));
    it('let x = 1; var y = 2; let z = 3;', () => testSame('let x = 1; var y = 2; let z = 3;'));
});

describe('test_mixed_declaration_types', () => {
    it('let x = 1; let z = 3; var y = 2;', () => test('let x = 1; let z = 3; var y = 2;', 'let x = 1, z = 3; var y = 2;'));
    it('let x = 1; let y = 2; var z = 3; var a = 4;', () =>
        test('let x = 1; let y = 2; var z = 3; var a = 4;', 'let x = 1, y = 2; var z = 3, a = 4'));
});

describe('test_for', () => {
    it('a = 0; for(; a < 2 ; a++) foo()', () => test('a = 0; for(; a < 2 ; a++) foo()', 'for(a = 0; a < 2 ; a++) foo();'));
    it('var a = 0; for(; c < b ; c++) foo()', () =>
        test('var a = 0; for(; c < b ; c++) foo()', 'for(var a = 0; c < b ; c++) foo()'));
    it('var a = 0; var b = 0; for(; c < b ; c++) foo()', () =>
        test('var a = 0; var b = 0; for(; c < b ; c++) foo()', 'for(var a = 0, b = 0; c < b ; c++) foo()'));
    it('var a = 0; a:for(; c < b ; c++) foo()', () => testSame('var a = 0; a:for(; c < b ; c++) foo()'));
    it('var a = 0; a:b:for(; c < b ; c++) foo()', () => testSame('var a = 0; a:b:for(; c < b ; c++) foo()'));
    it('let a = 0; for(; c < b ; c++) foo()', () => testSame('let a = 0; for(; c < b ; c++) foo()'));
    it('const a = 0; for(; c < b ; c++) foo()', () => testSame('const a = 0; for(; c < b ; c++) foo()'));
    it('if(x){var a = 0; for(; c < b; c++) foo()}', () =>
        test('if(x){var a = 0; for(; c < b; c++) foo()}', 'if(x)for(var a = 0; c < b; c++) foo()'));
    it('init(); for(; a < 2 ; a++) foo()', () => test('init(); for(; a < 2 ; a++) foo()', 'for(init(); a < 2 ; a++) foo();'));
    it('function f(){ var a; for(; a < 2 ; a++) foo() }', () =>
        test('function f(){ var a; for(; a < 2 ; a++) foo() }', 'function f(){ for(var a; a < 2 ; a++) foo() }'));
    it('function f(){ for(; a < 2 ; a++) foo() }', () => testSame('function f(){ for(; a < 2 ; a++) foo() }'));
    it('[a, b] = [1, 2]; for (; a < 2; a = b++) foo();', () =>
        test('[a, b] = [1, 2]; for (; a < 2; a = b++) foo();', 'for ([a, b] = [1, 2]; a < 2; a = b++) foo();'));
    it('var [a, b] = [1, 2]; for (; a < 2; a = b++) foo();', () =>
        test('var [a, b] = [1, 2]; for (; a < 2; a = b++) foo();', 'for (var [a, b] = [1, 2]; a < 2; a = b++) foo();'));
});

describe('test_for_in', () => {
    it('var a; for(a in b) foo()', () => test('var a; for(a in b) foo()', 'for (var a in b) foo()'));
    it('a = 0; for(a in b) foo()', () => test('a = 0; for(a in b) foo()', 'for (a in a = 0, b) foo();'));
    it('var a = 0; for(a in b) foo()', () => testSame('var a = 0; for(a in b) foo()'));
    it('var a; a:for(a in b) foo()', () => testSame('var a; a:for(a in b) foo()'));
    it('var a; a:b:for(a in b) foo()', () => testSame('var a; a:b:for(a in b) foo()'));
    it('if(x){var a; for(a in b) foo()}', () => test('if(x){var a; for(a in b) foo()}', 'if(x) for(var a in b) foo()'));
    it('init(); for(a in b) foo()', () => test('init(); for(a in b) foo()', 'for (a in init(), b) foo();'));
    it('function f(){ for(a in b) foo() }', () => testSame('function f(){ for(a in b) foo() }'));
    it('var a; var b; for ([a, b] in c) foo();', () =>
        test('var a; var b; for ([a, b] in c) foo();', 'var a, b; for ([a, b] in c) foo();'));
});

describe('test_for_of', () => {
    it('var a; for (a of b) foo()', () => test('var a; for (a of b) foo()', 'for (var a of b) foo()'));
    it('a = 0; for (a of b) foo()', () => testSame('a = 0; for (a of b) foo()'));
    it('var a = 0; for (a of b) foo()', () => testSame('var a = 0; for (a of b) foo()'));
    it('var a; a: for (a of b) foo()', () => testSame('var a; a: for (a of b) foo()'));
    it('var a; a: b: for (a of b) foo()', () => testSame('var a; a: b: for (a of b) foo()'));
    it('if (x) { var a; for (a of b) foo() }', () =>
        test('if (x) { var a; for (a of b) foo() }', 'if (x) for (var a of b) foo()'));
    it('init(); for (a of b) foo()', () => testSame('init(); for (a of b) foo()'));
    it('function f() { for (a of b) foo() }', () => testSame('function f() { for (a of b) foo() }'));
    it('var a; var b; for ([a, b] of c) foo();', () =>
        test('var a; var b; for ([a, b] of c) foo();', 'var a, b; for ([a, b] of c) foo();'));
});
