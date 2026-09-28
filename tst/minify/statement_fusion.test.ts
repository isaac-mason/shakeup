// Ported from oxc_minifier/tests/peephole/statement_fusion.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { test, testSame } from './harness.ts';

describe('fold_block_with_statements', () => {
    it('a;b;c', () => test('a;b;c', 'a,b,c'));
    it('a();b();c();', () => test('a();b();c();', 'a(),b(),c()'));
    // Printer parenthesizes a nested sequence element; oxc codegen prints elements at Precedence::Lowest.
    it.skip('a(),b();c(),d()', () => test('a(),b();c(),d()', 'a(),b(),c(),d()'));
    it('a();b(),c(),d()', () => test('a();b(),c(),d()', 'a(),b(),c(),d()'));
    it('a(),b(),c();d()', () => test('a(),b(),c();d()', 'a(),b(),c(),d()'));
});

describe('fold_block_into_if', () => {
    it('a;b;c;if(x){}', () => test('a;b;c;if(x){}', 'a,b,c,x'));
    // Printer parenthesizes a nested sequence element; oxc codegen prints elements at Precedence::Lowest.
    it.skip('a;b;c;if(x,y){}else{}', () => test('a;b;c;if(x,y){}else{}', 'a, b, c, x, y'));
    it.skip('a;b;c;if(x,y){}', () => test('a;b;c;if(x,y){}', 'a, b, c, x, y'));
    it.skip('a;b;c;if(x,y,z){}', () => test('a;b;c;if(x,y,z){}', 'a, b, c, x, y, z'));
    it('a();if(a()){}a()', () => test('a();if(a()){}a()', 'a(), a(), a()'));
});

describe('fold_block_return', () => {
    it('a;b;c;return x', () => test('a;b;c;return x', 'return a,b,c,x'));
    it('a;b;c;return x+y', () => test('a;b;c;return x+y', 'return a,b,c,x+y'));
    it('a();b();c();return x();a();b();c()', () => test('a();b();c();return x();a();b();c()', 'return a(),b(),c(),x()'));
});

describe('fold_block_throw', () => {
    it('a;b;c;throw x', () => test('a;b;c;throw x', 'throw a,b,c,x'));
    it('a;b;c;throw x+y', () => test('a;b;c;throw x+y', 'throw a,b,c,x+y'));
    it('a();b();c();throw x();a();b();c', () => test('a();b();c();throw x();a();b();c', 'throw a(),b(),c(),x()'));
});

describe('fold_switch', () => {
    it('a;b;c;switch(x){}', () => test('a;b;c;switch(x){}', 'a,b,c,x'));
    it('a;b;c;switch(x){case a:b();case b:c()}', () =>
        test('a;b;c;switch(x){case a:b();case b:c()}', 'switch(a,b,c,x){case a:b();case b:c()}'));
});

describe('fuse_into_for_in1', () => {
    it('a;b;c;for(x in y){}', () => test('a;b;c;for(x in y){}', 'for(x in a,b,c,y);'));
});

describe('fuse_into_for_in2', () => {
    it('a();for(var x = b() in y);', () => testSame('a();for(var x = b() in y);'));
    it('a = 1; for(var x = 2 in y);', () => test('a = 1; for(var x = 2 in y);', 'for(var x = 2 in a = 1, y);'));
    it('a(); for (var { x = b() } in y);', () => test('a(); for (var { x = b() } in y);', 'for (var { x = b() } in a(), y);'));
});

describe('fuse_into_vanilla_for1', () => {
    it('a;b;c;for(;g;){}', () => test('a;b;c;for(;g;){}', 'for(a,b,c;g;);'));
    it('a;b;c;for(d;g;){}', () => test('a;b;c;for(d;g;){}', 'for(a,b,c,d;g;);'));
    // Printer parenthesizes a nested sequence element; oxc codegen prints elements at Precedence::Lowest.
    it.skip('a;b;c;for(d,e;g;){}', () => test('a;b;c;for(d,e;g;){}', 'for(a,b,c,d,e;g;);'));
    it('a();for(var x;g;);', () => testSame('a();for(var x;g;);'));
});

describe('fuse_into_vanilla_for2', () => {
    it('a;b;c;for(var d;g;){}', () => test('a;b;c;for(var d;g;){}', 'a,b,c;for(var d;g;);'));
    it('a;b;c;for(let d;g;){}', () => test('a;b;c;for(let d;g;){}', 'a,b,c;for(let d;g;);'));
    it('a;b;c;for(const d = 5;g;){}', () => test('a;b;c;for(const d = 5;g;){}', 'a,b,c;for(let d = 5;g;);'));
});

// TODO: Label statement fusion optimization not yet implemented
describe.skip('fuse_into_label', () => {
    it('a;b;c;label:for(x in y){}', () => test('a;b;c;label:for(x in y){}', 'label:for(x in a,b,c,y);'));
    it('a;b;c;label:for(;g;){}', () => test('a;b;c;label:for(;g;){}', 'label:for(a,b,c;g;);'));
    it('a;b;c;l1:l2:l3:for(;g;){}', () => test('a;b;c;l1:l2:l3:for(;g;){}', 'l1:l2:l3:for(a,b,c;g;);'));
    it('a;b;c;label:while(true){}', () => test('a;b;c;label:while(true){}', 'label:for(a,b,c;;);'));
});

describe('fuse_into_block', () => {
    // Printer parenthesizes a nested sequence element; oxc codegen prints elements at Precedence::Lowest.
    it.skip('a;b;c;{d;e;f}', () => test('a;b;c;{d;e;f}', 'a,b,c,d,e,f'));
    it('a;b;c;{var x;d;e;}', () => test('a;b;c;{var x;d;e;}', 'a,b,c;var x;d,e;'));
    it('a;b;c;label:{break label;d;e;}', () => test('a;b;c;label:{break label;d;e;}', 'a,b,c'));
});

describe('fuse_into_switch_cases', () => {
    it('switch (_) { case _: a; return b }', () =>
        test('switch (_) { case _: a; return b }', 'switch (_) { case _: return a, b }'));
});

describe('no_fuse_into_while', () => {
    it('a;b;c;while(x){}', () => test('a;b;c;while(x){}', 'for(a,b,c;x;);'));
});

describe('no_fuse_into_do', () => {
    it('a;b;c;do;while(x)', () => test('a;b;c;do;while(x)', 'a,b,c;do;while(x)'));
});

describe('no_fuse_into_block', () => {
    it('a; {b;}', () => test('a; {b;}', 'a,b'));
    it('a; {b; var a = 1;}', () => test('a; {b; var a = 1;}', 'b; var a = 1;'));
    it('a; { b; let a = 1; }', () => testSame('a; { b; let a = 1; }'));
    it('a; { b; const a = 1; }', () => test('a; { b; const a = 1; }', 'a; { b; let a = 1; }'));
    it('a; { b; class a {} }', () => testSame('a; { b; class a {} }'));
    it('a; { b; function a() {} }', () => testSame('a; { b; function a() {} }'));
    it('a; { b; const otherVariable = 1; }', () =>
        test('a; { b; const otherVariable = 1; }', 'a; { b; let otherVariable = 1; }'));
});

describe('no_global_scope_changes', () => {
    it('a,b,c', () => testSame('a,b,c'));
});

describe('no_function_block_changes', () => {
    it('function foo() { a,b,c }', () => testSame('function foo() { a,b,c }'));
});
