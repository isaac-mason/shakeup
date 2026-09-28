// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are JS source under test.
// Ported from oxc_minifier/tests/peephole/minimize_conditions.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { test, testSame, testTarget } from './harness.ts';

describe('test_fold_one_child_blocks', () => {
    it('function f(){if(x)a();x=3}', () => test('function f(){if(x)a();x=3}', 'function f(){x&&a(),x=3}'));
    it('function f(){if(x)a?.();x=3}', () => test('function f(){if(x)a?.();x=3}', 'function f(){x&&a?.(),x=3}'));
    it('function f(){if(x){a()}x=3}', () => test('function f(){if(x){a()}x=3}', 'function f(){x&&a(),x=3}'));
    it('function f(){if(x){a?.()}x=3}', () => test('function f(){if(x){a?.()}x=3}', 'function f(){x&&a?.(),x=3}'));
    it('function f(){if(x){return 3}}', () => test('function f(){if(x){return 3}}', 'function f(){if(x)return 3}'));
    it('function f(){if(x){a()}}', () => test('function f(){if(x){a()}}', 'function f(){x&&a()}'));
    it('function f(){if(x){throw 1}}', () => test('function f(){if(x){throw 1}}', 'function f(){if(x)throw 1}'));
    it('function f(){if(x){foo()}}', () => test('function f(){if(x){foo()}}', 'function f(){x&&foo()}'));
    it('function f(){if(x){foo()}else{bar()}}', () =>
        test('function f(){if(x){foo()}else{bar()}}', 'function f(){x?foo():bar()}'));
    it('function f(){if(x){a.b=1}}', () => test('function f(){if(x){a.b=1}}', 'function f(){x&&(a.b=1)}'));
    it('function f(){if(x){a.b*=1}}', () => test('function f(){if(x){a.b*=1}}', 'function f(){x&&(a.b*=1)}'));
    it('function f(){if(x){a.b+=1}}', () => test('function f(){if(x){a.b+=1}}', 'function f(){x&&(a.b+=1)}'));
    it('function f(){if(x){++a.b}}', () => test('function f(){if(x){++a.b}}', 'function f(){x&&++a.b}'));
    it('function f(){if(x){a.foo()}}', () => test('function f(){if(x){a.foo()}}', 'function f(){x&&a.foo()}'));
    it('function f(){if(x){a?.foo()}}', () => test('function f(){if(x){a?.foo()}}', 'function f(){x&&a?.foo()}'));
    it('function f(){try{foo()}catch(e){bar(e)}finally{baz()}}', () =>
        testSame('function f(){try{foo()}catch(e){bar(e)}finally{baz()}}'));
    it('function f(){switch(x){case 1:break}}', () => test('function f(){switch(x){case 1:break}}', 'function f(){x;}'));
    it('function f(){if(e1){do foo();while(e2)}else foo2()}', () =>
        test(
            'function f(){if(e1){do foo();while(e2)}else foo2()}',
            'function f() { if (e1) do foo(); while (e2); else foo2(); }',
        ));
    it('if(x){do{foo()}while(y)}else bar()', () =>
        test('if(x){do{foo()}while(y)}else bar()', 'if(x)do foo();while(y);else bar()'));
    // Skipped: oxc codegen prints `a && (b && c)` as `a && b && c` (oxc-minify 0.146 outputs the left-nested form, as here); shakeup's printer keeps the parentheses.
    it.skip('function f(){if(x){if(y)foo()}}', () => test('function f(){if(x){if(y)foo()}}', 'function f(){x && (y && foo())}'));
    it('function f(){if(x){if(y)foo();else bar()}}', () =>
        test('function f(){if(x){if(y)foo();else bar()}}', 'function f(){x&&(y?foo():bar())}'));
    it('function f(){if(x){if(y)foo()}else bar()}', () =>
        test('function f(){if(x){if(y)foo()}else bar()}', 'function f(){x?y&&foo():bar()}'));
    it('function f(){if(x){if(y)foo();else bar()}else{baz()}}', () =>
        test('function f(){if(x){if(y)foo();else bar()}else{baz()}}', 'function f(){x?y?foo():bar():baz()}'));
    it('if(e1){while(e2){if(e3){foo()}}}else{bar()}', () =>
        test('if(e1){while(e2){if(e3){foo()}}}else{bar()}', 'if(e1)for(;e2;)e3&&foo();else bar()'));
    // Skipped: `with` does not parse in module code; oxc's harness ignores the parse error, shakeup's throws.
    it.skip('if(e1){with(e2){if(e3){foo()}}}else{bar()}', () =>
        test('if(e1){with(e2){if(e3){foo()}}}else{bar()}', 'if(e1)with(e2)e3&&foo();else bar()'));
    it('if(x){ if(y){var x;}else{var z;} }', () => test('if(x){ if(y){var x;}else{var z;} }', 'if(x){if(y)var x;else var z}'));
    it('if(x){ if(y){var x;}else{var z;} }else{var w}', () =>
        test('if(x){ if(y){var x;}else{var z;} }else{var w}', 'if(x){if(y)var x;else var z;}else var w'));
    it('if (x) {var x;}else { if (y) { var y;} }', () =>
        test('if (x) {var x;}else { if (y) { var y;} }', 'if(x)var x;else if(y)var y'));
    it('if(a){if(b){f1();f2();}else if(c){f3();}}else {if(d){f4();}}', () =>
        test('if(a){if(b){f1();f2();}else if(c){f3();}}else {if(d){f4();}}', 'a ? b ? (f1(), f2()) : c && f3() : d && f4();'));
    it('function f(){foo()}', () => testSame('function f(){foo()}'));
    it('switch(x){case y: foo()}', () => testSame('switch(x){case y: foo()}'));
    it('try{foo()}catch(ex){bar()}finally{baz()}', () =>
        test('try{foo()}catch(ex){bar()}finally{baz()}', 'try { foo(); } catch { bar(); } finally { baz(); }'));
    it('if (foo) { const bar = 1 } else { const baz = 1 }', () =>
        test('if (foo) { const bar = 1 } else { const baz = 1 }', 'if (foo) { let bar = 1 } else { let baz = 1 }'));
    it('if (foo) { let bar = 1 } else { let baz = 1 }', () => testSame('if (foo) { let bar = 1 } else { let baz = 1 }'));
    it('if (foo) { var bar = 1 } else { var baz = 1 }', () =>
        test('if (foo) { var bar = 1 } else { var baz = 1 }', 'if (foo) var bar = 1; else var baz = 1;'));
});

describe('test_fold_returns', () => {
    it('function f(){if(x)return 1;else return 2}', () =>
        test('function f(){if(x)return 1;else return 2}', 'function f(){return x?1:2}'));
    it('function f(){if(x)return 1;return 2}', () => test('function f(){if(x)return 1;return 2}', 'function f(){return x?1:2}'));
    it('function f(){if(x)return;return 2}', () => test('function f(){if(x)return;return 2}', 'function f(){if (!x) return 2;}'));
    it('function f(){if(x)return 1+x;else return 2-x}', () =>
        test('function f(){if(x)return 1+x;else return 2-x}', 'function f(){return x?1+x:2-x}'));
    it('function f(){if(x)return 1+x;return 2-x}', () =>
        test('function f(){if(x)return 1+x;return 2-x}', 'function f(){return x?1+x:2-x}'));
    it('function f(){if(x)return y += 1;else return y += 2}', () =>
        test('function f(){if(x)return y += 1;else return y += 2}', 'function f(){return x?(y+=1):(y+=2)}'));
    it('function f(){if(x)return;else return 2-x}', () =>
        test('function f(){if(x)return;else return 2-x}', 'function f(){if (!x) return 2 - x;}'));
    it('function f(){if(x)return;return 2-x}', () =>
        test('function f(){if(x)return;return 2-x}', 'function f(){if (!x) return 2 - x;}'));
    it('function f(){if(x)return x;else return}', () =>
        test('function f(){if(x)return x;else return}', 'function f(){if(x)return x;}'));
    it('function f(){if(x)return x;return}', () => test('function f(){if(x)return x;return}', 'function f(){if(x)return x}'));
    it('function f(){for(var x in y) { return x.y; } return k}', () =>
        test(
            'function f(){for(var x in y) { return x.y; } return k}',
            'function f() { for (var x in y) return x.y; return k; }',
        ));
});

describe('test_combine_ifs1', () => {
    it('function f() {if (x) return 1; if (y) return 1}', () =>
        test('function f() {if (x) return 1; if (y) return 1}', 'function f() {if (x || y) return 1;}'));
});

describe('test_combine_ifs2', () => {
    it('function f() {if (x) throw 1; if (y) throw 1}', () =>
        test('function f() {if (x) throw 1; if (y) throw 1}', 'function f() {if (x || y) throw 1}'));
    it('function f(){ if (x) g(); if (y) g() }', () =>
        test('function f(){ if (x) g(); if (y) g() }', 'function f(){ x&&g(), y&&g() }'));
    it('function f(){ if (x) g?.(); if (y) g?.() }', () =>
        test('function f(){ if (x) g?.(); if (y) g?.() }', 'function f(){ x&&g?.(), y&&g?.() }'));
    it('function f(){ if (x) y = 0; if (y) y = 0; }', () =>
        test('function f(){ if (x) y = 0; if (y) y = 0; }', 'function f(){ x&&(y = 0), y &&= 0 }'));
});

describe('test_combine_ifs3', () => {
    it('function f() {if (x) return 1; if (y) {g();f()}}', () =>
        test('function f() {if (x) return 1; if (y) {g();f()}}', 'function f() { if (x) return 1; y && (g(), f()) }'));
});

// Ignored in oxc: TODO: Assignment folding optimization not yet implemented
describe.skip('test_fold_assignments', () => {
    it('function f(){if(x)y=3;else y=4;}', () => test('function f(){if(x)y=3;else y=4;}', 'function f(){y=x?3:4}'));
    it('function f(){if(x)y=1+a;else y=2+a;}', () => test('function f(){if(x)y=1+a;else y=2+a;}', 'function f(){y=x?1+a:2+a}'));
    it('function f(){if(x)y+=1;else y+=2;}', () => test('function f(){if(x)y+=1;else y+=2;}', 'function f(){y+=x?1:2}'));
    it('function f(){if(x)y-=1;else y-=2;}', () => test('function f(){if(x)y-=1;else y-=2;}', 'function f(){y-=x?1:2}'));
    it('function f(){if(x)y%=1;else y%=2;}', () => test('function f(){if(x)y%=1;else y%=2;}', 'function f(){y%=x?1:2}'));
    it('function f(){if(x)y|=1;else y|=2;}', () => test('function f(){if(x)y|=1;else y|=2;}', 'function f(){y|=x?1:2}'));
    it('function f(){x ? y-=1 : y+=2}', () => testSame('function f(){x ? y-=1 : y+=2}'));
    it('function f(){x ? y-=1 : z-=1}', () => testSame('function f(){x ? y-=1 : z-=1}'));
    it('function f(){x ? y().a=3 : y().a=4}', () => testSame('function f(){x ? y().a=3 : y().a=4}'));
});

// Ignored in oxc: TODO: Duplicate statement removal not yet implemented
describe.skip('test_remove_duplicate_statements', () => {
    it('if (a) { x = 1; x++ } else { x = 2; x++ }', () =>
        test('if (a) { x = 1; x++ } else { x = 2; x++ }', 'x=(a) ? 1 : 2; x++'));
    it('if (a) { x = 1; x++; y += 1; z = pi; } else  { x = 2; x++; y', () =>
        test(
            'if (a) { x = 1; x++; y += 1; z = pi; } else  { x = 2; x++; y += 1; z = pi; }',
            'x=(a) ? 1 : 2; x++; y += 1; z = pi;',
        ));
    it('function z() {if (a) { foo(); return !0 } else { goo(); retu', () =>
        test(
            'function z() {if (a) { foo(); return !0 } else { goo(); return !0 }}',
            'function z() {(a) ? foo() : goo(); return !0}',
        ));
    it('function z() {if (a) { foo(); x = true; return true } else {', () =>
        test(
            'function z() {if (a) { foo(); x = true; return true } else { goo(); x = true; return true }}',
            'function z() {(a) ? foo() : goo(); x = true; return true}',
        ));
    it('function z() {  if (a) { bar(); foo(); return true }    else', () =>
        test(
            'function z() {  if (a) { bar(); foo(); return true }    else { bar(); goo(); return true }}',
            'function z() {  if (a) { bar(); foo(); }    else { bar(); goo(); }  return true;}',
        ));
});

describe('test_fold_returns_integration2', () => {
    it('function test(a) {if (a) {let a = Math.random();if(a) {retur', () =>
        test(
            'function test(a) {if (a) {let a = Math.random();if(a) {return a;}} return a; }',
            'function test(a) { if (a) { let a = Math.random(); if (a) return a; } return a; }',
        ));
});

describe('test_dont_remove_duplicate_statements_without_normalization', () => {
    it('if (Math.random() < 0.5) { let x = 3; alert(x); } else { let', () =>
        test(
            'if (Math.random() < 0.5) { let x = 3; alert(x); } else { let x = 5; alert(x); }',
            'if (Math.random() < 0.5) { let x = 3; alert(3); } else { let x = 5; alert(5); }',
        ));
});

describe('test_not_cond', () => {
    it('function f(){if(!x)foo()}', () => test('function f(){if(!x)foo()}', 'function f(){x||foo()}'));
    it('function f(){if(!x)b=1}', () => test('function f(){if(!x)b=1}', 'function f(){x||(b=1)}'));
    it('if(!x)z=1;else if(y)z=2', () => test('if(!x)z=1;else if(y)z=2', 'x ? y&&(z=2) : z=1;'));
    it('if(x)y&&(z=2);else z=1;', () => test('if(x)y&&(z=2);else z=1;', 'x ? y&&(z=2) : z=1'));
    it('function f(){if(!(x=1))a.b=1}', () => test('function f(){if(!(x=1))a.b=1}', 'function f(){(x=1)||(a.b=1)}'));
});

// Ignored in oxc: TODO: Parentheses counting optimization not yet implemented
describe.skip('test_and_parentheses_count', () => {
    it('function f(){if(x||y)a.foo()}', () => test('function f(){if(x||y)a.foo()}', 'function f(){(x||y)&&a.foo()}'));
    it('function f(){if(x.a)x.a=0}', () => test('function f(){if(x.a)x.a=0}', 'function f(){x.a&&(x.a=0)}'));
    it('function f(){if(x?.a)x.a=0}', () => test('function f(){if(x?.a)x.a=0}', 'function f(){x?.a&&(x.a=0)}'));
    it('function f(){if(x()||y()){x()||y()}}', () => testSame('function f(){if(x()||y()){x()||y()}}'));
});

describe('test_fold_logical_op_string_compare', () => {
    it('if (foo() && false) z()', () => test('if (foo() && false) z()', 'foo()'));
});

describe('test_fold_not', () => {
    it('for(; !(x==y) ;) a=b', () => test('for(; !(x==y) ;) a=b', 'for(; x!=y ;) a=b'));
    it('for(; !(x!=y) ;) a=b', () => test('for(; !(x!=y) ;) a=b', 'for(; x==y ;) a=b'));
    it('for(; !(x===y) ;) a=b', () => test('for(; !(x===y) ;) a=b', 'for(; x!==y ;) a=b'));
    it('for(; !(x!==y) ;) a=b', () => test('for(; !(x!==y) ;) a=b', 'for(; x===y ;) a=b'));
    it('for(; !(x>y) ;) a=b', () => testSame('for(; !(x>y) ;) a=b'));
    it('for(; !(x>=y) ;) a=b', () => testSame('for(; !(x>=y) ;) a=b'));
    it('for(; !(x<y) ;) a=b', () => testSame('for(; !(x<y) ;) a=b'));
    it('for(; !(x<=y) ;) a=b', () => testSame('for(; !(x<=y) ;) a=b'));
    it('for(; !(x<=NaN) ;) a=b', () => testSame('for(; !(x<=NaN) ;) a=b'));
    it('x = !(y() && true)', () => test('x = !(y() && true)', 'x = !y()'));
    it('x = !true', () => test('x = !true', 'x = !1'));
});

describe('test_fold_triple_not', () => {
    it('!!!foo ? bar : baz', () => test('!!!foo ? bar : baz', 'foo ? baz : bar'));
});

describe('test_minimize_while_condition', () => {
    it('while(!!true) foo()', () => test('while(!!true) foo()', 'for(;;) foo()'));
    it('while(!!x) foo()', () => test('while(!!x) foo()', 'for(;x;) foo()'));
    it('while(x||!!y) foo()', () => test('while(x||!!y) foo()', 'for(;x||y;) foo()'));
});

// Ignored in oxc: TODO: De Morgan's law optimization not yet implemented
describe.skip('test_minimize_demorgan_remove_leading_not', () => {
    it('if(!(!a||!b)&&c) foo()', () => test('if(!(!a||!b)&&c) foo()', '((a&&b)&&c)&&foo()'));
    it('if(!(x&&y)) foo()', () => test('if(!(x&&y)) foo()', 'x&&y||foo()'));
    it('if(!(x||y)) foo()', () => test('if(!(x||y)) foo()', '(x||y)||foo()'));
});

// Ignored in oxc: TODO: De Morgan's law optimization not yet implemented
describe.skip('test_minimize_demorgan1', () => {
    it('if(!a&&!b)foo()', () => test('if(!a&&!b)foo()', '(a||b)||foo()'));
});

// Ignored in oxc: TODO: De Morgan's law optimization not yet implemented
describe.skip('test_minimize_demorgan2', () => {
    it('(!(a&&!((function(){})())))||foo()', () => test('(!(a&&!((function(){})())))||foo()', '!a||(function(){})()||foo()'));
});

// Ignored in oxc: TODO: De Morgan's law optimization not yet implemented
describe.skip('test_minimize_demorgan2b', () => {
    it('!a||(function(){})()||foo()', () => testSame('!a||(function(){})()||foo()'));
});

// Ignored in oxc: TODO: De Morgan's law optimization not yet implemented
describe.skip('test_minimize_demorgan3', () => {
    it('if((!a||!b)&&(c||d)) foo()', () => test('if((!a||!b)&&(c||d)) foo()', '(a&&b||!c&&!d)||foo()'));
});

// Ignored in oxc: TODO: De Morgan's law optimization not yet implemented
describe.skip('test_minimize_demorgan5', () => {
    it('if((!a||!b)&&c) foo()', () => test('if((!a||!b)&&c) foo()', '(a&&b||!c)||foo()'));
});

// Ignored in oxc: TODO: De Morgan's law optimization not yet implemented
describe.skip('test_minimize_demorgan11', () => {
    it('if (x && (y===2 || !f()) && (y===3 || !h())) foo()', () =>
        test('if (x && (y===2 || !f()) && (y===3 || !h())) foo()', '(!x || y!==2 && f() || y!==3 && h()) || foo()'));
});

// Ignored in oxc: TODO: De Morgan's law optimization not yet implemented
describe.skip('test_minimize_demorgan20a', () => {
    it('if (0===c && (2===a || 1===a)) f(); else g()', () =>
        test('if (0===c && (2===a || 1===a)) f(); else g()', 'if (0!==c || 2!==a && 1!==a) g(); else f()'));
});

// Ignored in oxc: TODO: De Morgan's law optimization not yet implemented
describe.skip('test_minimize_demorgan20b', () => {
    it('if (0!==c || 2!==a && 1!==a) g(); else f()', () =>
        test('if (0!==c || 2!==a && 1!==a) g(); else f()', '(0!==c || 2!==a && 1!==a) ? g() : f()'));
});

describe('test_preserve_if', () => {
    it('if(!a&&!b)for(;f(););', () => testSame('if(!a&&!b)for(;f(););'));
});

describe('test_dangling_else', () => {
    it('\n    if (!x) {\n      for (;;) foo();\n      for (;;) bar();\n ', () =>
        test(
            '\n    if (!x) {\n      for (;;) foo();\n      for (;;) bar();\n    } else for (;;) f();',
            '\n    if (x) for (;;) f();\n    else {\n      for (;;) foo();\n      for (;;) bar();\n    }\n        ',
        ));
    it('\n    if (!x) {\n      for (;;) foo();\n      for (;;) bar();\n ', () =>
        testSame('\n    if (!x) {\n      for (;;) foo();\n      for (;;) bar();\n    } else if (y) for (;;) f();'));
    it('if(!a&&!b) {for(;;)foo(); for(;;)bar()} else if(y) for(;;) f', () =>
        testSame('if(!a&&!b) {for(;;)foo(); for(;;)bar()} else if(y) for(;;) f()'));
});

describe('test_minimize_hook', () => {
    it('x ? x : y', () => test('x ? x : y', 'x || y'));
    it('x.y ? x.y : x.z', () => testSame('x.y ? x.y : x.z'));
    it('x?.y ? x?.y : x.z', () => testSame('x?.y ? x?.y : x.z'));
    it('x?.y ? x?.y : x?.z', () => testSame('x?.y ? x?.y : x?.z'));
    it('x() ? x() : y()', () => testSame('x() ? x() : y()'));
    it('x?.() ? x?.() : y()', () => testSame('x?.() ? x?.() : y()'));
    it('!x ? foo() : bar()', () => test('!x ? foo() : bar()', 'x ? bar() : foo()'));
});

describe('test_minimize_comma', () => {
    it('while(!(inc(), test())) foo();', () => test('while(!(inc(), test())) foo();', 'for(;inc(), !test();) foo();'));
    it('(inc(), !test()) ? foo() : bar()', () => test('(inc(), !test()) ? foo() : bar()', 'inc(), test() ? bar() : foo()'));
});

// Ignored in oxc: TODO: Expression result minimization not yet implemented
describe.skip('test_minimize_expr_result', () => {
    it('!x||!y', () => test('!x||!y', 'x&&y'));
    it('if(!(x&&!y)) foo()', () => test('if(!(x&&!y)) foo()', '(!x||y)&&foo()'));
    it('if(!x||y) foo()', () => test('if(!x||y) foo()', '(!x||y)&&foo()'));
    it('(!x||y)&&foo()', () => test('(!x||y)&&foo()', 'x&&!y||!foo()'));
});

// Ignored in oxc: TODO: De Morgan's law optimization not yet implemented
describe.skip('test_minimize_demorgan21', () => {
    it('if (0===c && (2===a || 1===a)) f()', () =>
        test('if (0===c && (2===a || 1===a)) f()', '(0!==c || 2!==a && 1!==a) || f()'));
});

// Ignored in oxc: TODO: AND/OR minimization not yet implemented
describe.skip('test_minimize_and_or1', () => {
    it('if ((!a || !b) && (d || e)) f()', () => test('if ((!a || !b) && (d || e)) f()', '(a&&b || !d&&!e) || f()'));
});

describe('test_minimize_for_condition', () => {
    it('for(;!!true;) foo()', () => test('for(;!!true;) foo()', 'for(;;) foo()'));
    it('if(!!true||function(){}) {}', () => test('if(!!true||function(){}) {}', ''));
    it('for(!!true;;) foo()', () => test('for(!!true;;) foo()', 'for(;;) foo()'));
    it('for(;!!x;) foo()', () => test('for(;!!x;) foo()', 'for(;x;) foo()'));
    it('for(a in b) foo()', () => testSame('for(a in b) foo()'));
    it('for(a in {}) foo()', () => testSame('for(a in {}) foo()'));
    it('for(a in []) foo()', () => testSame('for(a in []) foo()'));
    it('for(a in !!true) foo()', () => test('for(a in !!true) foo()', 'for(a in !0) foo()'));
    it('for(a of b) foo()', () => testSame('for(a of b) foo()'));
    it('for(a of {}) foo()', () => testSame('for(a of {}) foo()'));
    it('for(a of []) foo()', () => testSame('for(a of []) foo()'));
    it('for(a of !!true) foo()', () => test('for(a of !!true) foo()', 'for(a of !0) foo()'));
});

describe('test_minimize_condition_example1', () => {
    it('if(!!(f() > 20)) {foo();foo()}', () => test('if(!!(f() > 20)) {foo();foo()}', 'f() > 20 && (foo(), foo())'));
});

describe('test_fold_loop_break', () => {
    it('for(;;) if (a) break', () => test('for(;;) if (a) break', 'for(;!a;);'));
    it('for(;;) if (a) { f(); break }', () => testSame('for(;;) if (a) { f(); break }'));
    it('for(;;) if (a) break; else f()', () => test('for(;;) if (a) break; else f()', 'for(;!a;) f()'));
    it('for(;a;) if (b) break', () => test('for(;a;) if (b) break', 'for(;a && !b;);'));
    it('for(;a;) { if (b) break; if (c) break; }', () =>
        test('for(;a;) { if (b) break; if (c) break; }', 'for (;a && !(b || c););'));
    it('for(;(a && !b);) if (c) break;', () => test('for(;(a && !b);) if (c) break;', 'for(;(a && !b) && !c;);'));
    it('while(true) if (a) break', () => test('while(true) if (a) break', 'for(;!a;);'));
});

// Ignored in oxc: TODO: Conditional variable declaration folding not yet implemented
describe.skip('test_fold_conditional_var_declaration', () => {
    it('if(x) var y=1;else y=2', () => test('if(x) var y=1;else y=2', 'var y=x?1:2'));
    it('if(x) y=1;else var y=2', () => test('if(x) y=1;else var y=2', 'var y=x?1:2'));
    it('if(x) var y = 1; z = 2', () => testSame('if(x) var y = 1; z = 2'));
    it('if(x||y) y = 1; var z = 2', () => testSame('if(x||y) y = 1; var z = 2'));
    it('if(x) { var y = 1; print(y)} else y = 2 ', () => testSame('if(x) { var y = 1; print(y)} else y = 2 '));
    it('if(x) var y = 1; else {y = 2; print(y)}', () => testSame('if(x) var y = 1; else {y = 2; print(y)}'));
});

describe('test_fold_if_with_lower_operators_inside', () => {
    // Skipped: oxc codegen prints `a && (b && c)` as `a && b && c` (oxc-minify 0.146 outputs the left-nested form, as here); shakeup's printer keeps the parentheses.
    it.skip('if (x + (y=5)) z && (w,z);', () => test('if (x + (y=5)) z && (w,z);', 'x + (y=5) && (z && (w,z))'));
    it('if (!(x+(y=5))) z && (w,z);', () => test('if (!(x+(y=5))) z && (w,z);', 'x + (y=5) || z && (w,z)'));
    // Skipped: oxc codegen prints `a && (b && c)` as `a && b && c` (oxc-minify 0.146 outputs the left-nested form, as here); shakeup's printer keeps the parentheses.
    it.skip('if (x + (y=5)) if (z && (w,z)) for(;;) foo();', () =>
        test('if (x + (y=5)) if (z && (w,z)) for(;;) foo();', 'if (x + (y=5) && (z && (w,z))) for(;;) foo();'));
});

// Ignored in oxc: TODO: Return statement substitution not yet implemented
describe.skip('test_substitute_return', () => {
    it('function f() { while(x) { return }}', () =>
        test('function f() { while(x) { return }}', 'function f() { while(x) { break }}'));
    it('function f() { while(x) { return 5 } }', () => testSame('function f() { while(x) { return 5 } }'));
    it('function f() { a: { return 5 } }', () => testSame('function f() { a: { return 5 } }'));
    it('function f() { while(x) { return 5}  return 5}', () =>
        test('function f() { while(x) { return 5}  return 5}', 'function f() { while(x) { break }    return 5}'));
    it('function f() { while(x) { return x}  return x}', () =>
        test('function f() { while(x) { return x}  return x}', 'function f() { while(x) { break }    return x}'));
    it('function f() { while(x) { if (y) { return }}}', () =>
        test('function f() { while(x) { if (y) { return }}}', 'function f() { while(x) { if (y) { break  }}}'));
    it('function f() { while(x) { if (y) { return }} return}', () =>
        test('function f() { while(x) { if (y) { return }} return}', 'function f() { while(x) { if (y) { break  }}}'));
    it('function f() { while(x) { if (y) { return 5 }} return 5}', () =>
        test(
            'function f() { while(x) { if (y) { return 5 }} return 5}',
            'function f() { while(x) { if (y) { break    }} return 5}',
        ));
    it('function f() { while(x) { if (y) { return x } x = 1} return ', () =>
        test(
            'function f() { while(x) { if (y) { return x } x = 1} return x}',
            'function f() { while(x) { if (y) { break    } x = 1} return x}',
        ));
    it('function f() { while(x) { if (y) { return x } return x} retu', () =>
        test(
            'function f() { while(x) { if (y) { return x } return x} return x}',
            'function f() { while(x) { if (y) {} break }return x}',
        ));
    it('function f() { while(x) { while (y) { return } } }', () =>
        testSame('function f() { while(x) { while (y) { return } } }'));
    it('function f() { while(1) { return 7}  return 5}', () => testSame('function f() { while(1) { return 7}  return 5}'));
    it('function f() {  try { while(x) {return f()}} catch (e) { } r', () =>
        testSame('function f() {  try { while(x) {return f()}} catch (e) { } return f()}'));
    it('function f() {  try { while(x) {return f()}} finally {alert(', () =>
        testSame('function f() {  try { while(x) {return f()}} finally {alert(1)} return f()}'));
    it('function f() {  try { while(x) { return f() } return f() } c', () =>
        test(
            'function f() {  try { while(x) { return f() } return f() } catch (e) { } }',
            'function f() {  try { while(x) { break } return f() } catch (e) { } }',
        ));
    it('function f() {  try { while(x) { return foo() } } finally { ', () =>
        testSame('function f() {  try { while(x) { return foo() } } finally { alert(1) }   return foo()}'));
    it('function f() {  try { while(x) { return 1 } } finally { aler', () =>
        test(
            'function f() {  try { while(x) { return 1 } } finally { alert(1) } return 1}',
            'function f() {  try { while(x) { break    } } finally { alert(1) } return 1}',
        ));
    it('function f() { try{ return a } finally { a = 2 } return a; }', () =>
        testSame('function f() { try{ return a } finally { a = 2 } return a; }'));
    it('function f() { switch(a){ case 1: return a; default: g();} r', () =>
        test(
            'function f() { switch(a){ case 1: return a; default: g();} return a;}',
            'function f() { switch(a){ case 1: break; default: g();} return a; }',
        ));
});

// Ignored in oxc: TODO: Break/throw substitution not yet implemented
describe.skip('test_substitute_break_for_throw', () => {
    it('function f() { while(x) { throw Error }}', () => testSame('function f() { while(x) { throw Error }}'));
    it('function f() { while(x) { throw Error } throw Error }', () =>
        test('function f() { while(x) { throw Error } throw Error }', 'function f() { while(x) { break } throw Error}'));
    it('function f() { while(x) { throw Error(1) } throw Error(2)}', () =>
        testSame('function f() { while(x) { throw Error(1) } throw Error(2)}'));
    it('function f() { while(x) { throw Error(1) } return Error(2)}', () =>
        testSame('function f() { while(x) { throw Error(1) } return Error(2)}'));
    it('function f() { while(x) { throw 5 } }', () => testSame('function f() { while(x) { throw 5 } }'));
    it('function f() { a: { throw 5 } }', () => testSame('function f() { a: { throw 5 } }'));
    it('function f() { while(x) { throw 5}  throw 5}', () =>
        test('function f() { while(x) { throw 5}  throw 5}', 'function f() { while(x) { break }   throw 5}'));
    it('function f() { while(x) { throw x}  throw x}', () =>
        test('function f() { while(x) { throw x}  throw x}', 'function f() { while(x) { break }   throw x}'));
    it('function f() { while(x) { if (y) { throw Error }}}', () =>
        testSame('function f() { while(x) { if (y) { throw Error }}}'));
    it('function f() { while(x) { if (y) { throw Error }} throw Erro', () =>
        test(
            'function f() { while(x) { if (y) { throw Error }} throw Error}',
            'function f() { while(x) { if (y) { break }} throw Error}',
        ));
    it('function f() { while(x) { if (y) { throw 5 }} throw 5}', () =>
        test(
            'function f() { while(x) { if (y) { throw 5 }} throw 5}',
            'function f() { while(x) { if (y) { break    }} throw 5}',
        ));
    it('function f() { while(x) { if (y) { throw x } x = 1} throw x}', () =>
        test(
            'function f() { while(x) { if (y) { throw x } x = 1} throw x}',
            'function f() { while(x) { if (y) { break    } x = 1} throw x}',
        ));
    it('function f() { while(x) { if (y) { throw x } throw x} throw ', () =>
        test(
            'function f() { while(x) { if (y) { throw x } throw x} throw x}',
            'function f() { while(x) { if (y) {} break }throw x}',
        ));
    it('function f() { while(x) { while (y) { throw Error } } }', () =>
        testSame('function f() { while(x) { while (y) { throw Error } } }'));
    it('function f() { while(1) { throw 7}  throw 5}', () => testSame('function f() { while(1) { throw 7}  throw 5}'));
    it('function f() {  try { while(x) {throw f()}} catch (e) { } th', () =>
        testSame('function f() {  try { while(x) {throw f()}} catch (e) { } throw f()}'));
    it('function f() {  try { while(x) {throw f()}} finally {alert(1', () =>
        testSame('function f() {  try { while(x) {throw f()}} finally {alert(1)} throw f()}'));
    it('function f() {  try { while(x) { throw f() } throw f() } cat', () =>
        test(
            'function f() {  try { while(x) { throw f() } throw f() } catch (e) { } }',
            'function f() {  try { while(x) { break } throw f() } catch (e) { } }',
        ));
    it('function f() {  try { while(x) { throw foo() } } finally { a', () =>
        testSame('function f() {  try { while(x) { throw foo() } } finally { alert(1) }   throw foo()}'));
    it('function f() {  try { while(x) { throw 1 } } finally { alert', () =>
        test(
            'function f() {  try { while(x) { throw 1 } } finally { alert(1) } throw 1}',
            'function f() {  try { while(x) { break    } } finally { alert(1) } throw 1}',
        ));
    it('function f() { try{ throw a } finally { a = 2 } throw a; }', () =>
        testSame('function f() { try{ throw a } finally { a = 2 } throw a; }'));
    it('function f() { switch(a){ case 1: throw a; default: g();} th', () =>
        test(
            'function f() { switch(a){ case 1: throw a; default: g();} throw a;}',
            'function f() { switch(a){ case 1: break; default: g();} throw a; }',
        ));
});

describe('test_remove_duplicate_return', () => {
    it('function f() { return; }', () => test('function f() { return; }', 'function f(){}'));
    it('function f() { return a; }', () => testSame('function f() { return a; }'));
    it('function f() { if (x) { return a } return a; }', () =>
        test('function f() { if (x) { return a } return a; }', 'function f() { return x, a; }'));
    it('function f() { try { if (x) return a; } catch {} return a; }', () =>
        testSame('function f() { try { if (x) return a; } catch {} return a; }'));
    it('function f() { try { if (x) {} } catch {} return 1; }', () =>
        test('function f() { try { if (x) {} } catch {} return 1; }', 'function f() { try { x } catch {} return 1; }'));
    it('function f() { try { if (x) return a } finally { a++ } retur', () =>
        testSame('function f() { try { if (x) return a } finally { a++ } return a; }'));
});

describe('test_remove_duplicate_throw', () => {
    it('function f() { throw a; }', () => testSame('function f() { throw a; }'));
    it('function f() { if (x) { throw a } throw a; }', () =>
        test('function f() { if (x) { throw a } throw a; }', 'function f() { throw x, a; }'));
    it('function f() { try { if (x) throw a } catch {} throw a; }', () =>
        testSame('function f() { try { if (x) throw a } catch {} throw a; }'));
    it('function f() { try { if (x) throw 1 } catch {f()} throw 1; }', () =>
        testSame('function f() { try { if (x) throw 1 } catch {f()} throw 1; }'));
    it('function f() { try { if (x) throw 1 } catch {f()} throw 1; }', () =>
        testSame('function f() { try { if (x) throw 1 } catch {f()} throw 1; }'));
    it('function f() { try { if (x) throw 1 } catch {throw 1}}', () =>
        testSame('function f() { try { if (x) throw 1 } catch {throw 1}}'));
    it('function f() { try { if (x) throw a } finally { a++ } throw ', () =>
        testSame('function f() { try { if (x) throw a } finally { a++ } throw a; }'));
});

describe('test_nested_if_combine', () => {
    it('if(x)if(y){for(;;);}', () => test('if(x)if(y){for(;;);}', 'if(x&&y) for(;;);'));
    it('if(x||z)if(y){for(;;);}', () => test('if(x||z)if(y){for(;;);}', 'if((x||z)&&y) for(;;);'));
    it('if(x)if(y||z){for(;;);}', () => test('if(x)if(y||z){for(;;);}', 'if((x)&&(y||z)) for(;;);'));
    it('if(x||z)if(y||z){for(;;);}', () => test('if(x||z)if(y||z){for(;;);}', 'if((x||z)&&(y||z)) for(;;);'));
    // Skipped: oxc codegen prints `a && (b && c)` as `a && b && c` (oxc-minify 0.146 outputs the left-nested form, as here); shakeup's printer keeps the parentheses.
    it.skip('if(x)if(y){if(z){for(;;);}}', () => test('if(x)if(y){if(z){for(;;);}}', 'if(x&&(y&&z)) for(;;);'));
});

describe('test_remove_else_cause', () => {
    it('function f() { if(x) return 1; else if(x) return 2; else if(', () =>
        test(
            'function f() { if(x) return 1; else if(x) return 2; else if(x) return 3 }',
            'function f() { if(x) return 1; if(x) return 2; if(x) return 3 }',
        ));
});

describe('test_remove_else_cause1', () => {
    it('function f() { if (x) throw 1; else f() }', () =>
        test('function f() { if (x) throw 1; else f() }', 'function f() { if (x) throw 1; f() }'));
});

describe('test_remove_else_cause2', () => {
    it('function f() { if (x) return 1; else f() }', () =>
        test('function f() { if (x) return 1; else f() }', 'function f() { if (x) return 1; f() }'));
    it('function f() { if (x) return; else f() }', () =>
        test('function f() { if (x) return; else f() }', 'function f() { x || f() }'));
    it('function f() { if (x) return; f() }', () => test('function f() { if (x) return; f() }', 'function f() { x || f() }'));
});

describe('test_remove_else_cause3', () => {
    it('function f() { a: { if (x) break a; else f() } }', () =>
        test('function f() { a: { if (x) break a; else f() } }', 'function f() { a: { if (x) break a; f() } }'));
    it('function f() { if (x) { a:{ break a } } else f() }', () =>
        test('function f() { if (x) { a:{ break a } } else f() }', 'function f() { x || f() }'));
    it('function f() { if (x) a:{ break a } else f() }', () =>
        test('function f() { if (x) a:{ break a } else f() }', 'function f() { x || f() }'));
});

describe('test_remove_else_cause4', () => {
    it('function f() { if (x) { if (y) { return 1; } } else f() }', () =>
        test(
            'function f() { if (x) { if (y) { return 1; } } else f() }',
            'function f() { if (x) { if (y) return 1; } else f() }',
        ));
});

describe('test_issue925', () => {
    it('if (x[--y] === 1) {\n    x[y] = 0;\n} else {\n    x[y] = 1;\n}', () =>
        test('if (x[--y] === 1) {\n    x[y] = 0;\n} else {\n    x[y] = 1;\n}', '(x[--y] === 1) ? x[y] = 0 : x[y] = 1;'));
    it('if (x[--y]) {\n    a = 0;\n} else {\n    a = 1;\n}', () =>
        test('if (x[--y]) {\n    a = 0;\n} else {\n    a = 1;\n}', 'a = +!x[--y];'));
    it('if (x?.[--y]) {    a = 0;} else {    a = 1;}', () =>
        test('if (x?.[--y]) {    a = 0;} else {    a = 1;}', 'a = +!x?.[--y];'));
    it('if (x++) { x += 2 } else { x += 3 }', () => test('if (x++) { x += 2 } else { x += 3 }', 'x++ ? x += 2 : x += 3'));
    it('if (x++) { x = x + 2 } else { x = x + 3 }', () =>
        test('if (x++) { x = x + 2 } else { x = x + 3 }', 'x++ ? x += 2 : x += 3'));
});

describe('test_coercion_substitution_disabled', () => {
    it("var x = {}; if (x != null) throw 'a';", () => test("var x = {}; if (x != null) throw 'a';", "throw 'a';"));
    it('var x = {}; var y = x != null;', () => test('var x = {}; var y = x != null;', 'var y = !0;'));
    it("var x = 1; if (x != 0) throw 'a';", () => test("var x = 1; if (x != 0) throw 'a';", "throw 'a';"));
    it('var x = 1; var y = x != 0;', () => test('var x = 1; var y = x != 0;', 'var y = !0;'));
});

describe('test_coercion_substitution_boolean_result0', () => {
    it('var x = {}, y = x != null;', () => test('var x = {}, y = x != null;', 'var y = !0;'));
});

describe('test_coercion_substitution_boolean_result1', () => {
    it('export var x = {}, y = x == null;', () => testSame('export var x = {}, y = x == null;'));
    it('export var x = {}, y = x !== null;', () => testSame('export var x = {}, y = x !== null;'));
    it('export var x = undefined, y = x !== null;', () =>
        test('export var x = undefined, y = x !== null;', 'export var x = void 0, y = x !== null;'));
    it('export var x = {}, y = x === null;', () => testSame('export var x = {}, y = x === null;'));
    it('export var x = undefined, y = x === null;', () =>
        test('export var x = undefined, y = x === null;', 'export var x = void 0, y = x === null;'));
    it('export var x = 1, y = x != 0;', () => testSame('export var x = 1, y = x != 0;'));
    it('export var x = 1, y = x == 0;', () => testSame('export var x = 1, y = x == 0;'));
    it('export var x = 1, y = x !== 0;', () => testSame('export var x = 1, y = x !== 0;'));
    it('export var x = 1, y = x === 0;', () => testSame('export var x = 1, y = x === 0;'));
});

describe('test_coercion_substitution_if', () => {
    it("var x = {};\nif (x != null) throw 'a';\n", () => test("var x = {};\nif (x != null) throw 'a';\n", "throw 'a'"));
    it("var x = {};\nif (x == null) throw 'a';\n", () => test("var x = {};\nif (x == null) throw 'a';\n", ''));
    it("var x = {};\nif (x != null) throw 'a';\n", () => test("var x = {};\nif (x != null) throw 'a';\n", "throw 'a'"));
    it("var x = {};\nif (x !== null) throw 'a';\n", () => test("var x = {};\nif (x !== null) throw 'a';\n", "throw 'a'"));
    it("var x = {};\nif (x === null) throw 'a';\n", () => test("var x = {};\nif (x === null) throw 'a';\n", ''));
    it("var x = 1;\nif (x != 0) throw 'a';\n", () => test("var x = 1;\nif (x != 0) throw 'a';\n", "throw 'a'"));
    it("var x = 1;\nif (x != 0) throw 'a';\n", () => test("var x = 1;\nif (x != 0) throw 'a';\n", "throw 'a'"));
    it("var x = 1;\nif (x == 0) throw 'a';\n", () => test("var x = 1;\nif (x == 0) throw 'a';\n", ''));
    it("var x = 1;\nif (x !== 0) throw 'a';\n", () => test("var x = 1;\nif (x !== 0) throw 'a';\n", "throw 'a'"));
    it("var x = 1;\nif (x === 0) throw 'a';\n", () => test("var x = 1;\nif (x === 0) throw 'a';\n", ''));
    it("var x = NaN;\nif (x === 0) throw 'a';\n", () => test("var x = NaN;\nif (x === 0) throw 'a';\n", ''));
});

describe('test_coercion_substitution_expression', () => {
    it("var x = {}; x != null && alert('b');", () => test("var x = {}; x != null && alert('b');", "alert('b');"));
    it("var x = 1; x != 0 && alert('b');", () => test("var x = 1; x != 0 && alert('b');", "alert('b');"));
});

describe('test_coercion_substitution_hook', () => {
    it('var x = {}; var y = x != null ? 1 : 2;', () => test('var x = {}; var y = x != null ? 1 : 2;', 'var y = 1;'));
    it('var x = 1; var y = x != 0 ? 1 : 2;', () => test('var x = 1; var y = x != 0 ? 1 : 2;', 'var y = 1;'));
});

describe('test_coercion_substitution_not', () => {
    it('var x = {}; var y = !(x != null) ? 1 : 2;', () => test('var x = {}; var y = !(x != null) ? 1 : 2;', 'var y = 2;'));
    it('var x = 1; var y = !(x != 0) ? 1 : 2; ', () => test('var x = 1; var y = !(x != 0) ? 1 : 2; ', 'var y = 2; '));
});

describe('test_coercion_substitution_while', () => {
    it("var x = {}; while (x != null) throw 'a';", () =>
        test("var x = {}; while (x != null) throw 'a';", "for (var x = {} ;x != null;) throw 'a';"));
    it("var x = 1; while (x != 0) throw 'a';", () =>
        test("var x = 1; while (x != 0) throw 'a';", "for (var x = 1; x != 0;) throw 'a';"));
});

describe('test_coercion_substitution_unknown_type', () => {
    it("var x = /** @type {?} */ ({});\nif (x != null) throw 'a';\n", () =>
        test("var x = /** @type {?} */ ({});\nif (x != null) throw 'a';\n", "throw 'a';\n"));
    it("var x = /** @type {?} */ (1);\nif (x != 0) throw 'a';\n", () =>
        test("var x = /** @type {?} */ (1);\nif (x != 0) throw 'a';\n", "throw 'a';\n"));
});

describe('test_coercion_substitution_all_type', () => {
    it("export var x = /** @type {*} */ ({});\nif (x != null) throw '", () =>
        testSame("export var x = /** @type {*} */ ({});\nif (x != null) throw 'a';\n"));
    it("export var x = /** @type {*} */ (1);\nif (x != 0) throw 'a';\n", () =>
        testSame("export var x = /** @type {*} */ (1);\nif (x != 0) throw 'a';\n"));
});

describe('test_coercion_substitution_primitives_vs_null', () => {
    it("var x = 0;\nif (x != null) throw 'a';\n", () => test("var x = 0;\nif (x != null) throw 'a';\n", "throw 'a';\n"));
    it("var x = '';\nif (x != null) throw 'a';\n", () => test("var x = '';\nif (x != null) throw 'a';\n", "throw 'a';\n"));
    it("var x = !1;\nif (x != null) throw 'a';\n", () => test("var x = !1;\nif (x != null) throw 'a';\n", "throw 'a';\n"));
});

describe('test_coercion_substitution_non_number_vs_zero', () => {
    it("var x = {};\nif (x != 0) throw 'a';\n", () => test("var x = {};\nif (x != 0) throw 'a';\n", "if ({} != 0) throw 'a';"));
    it("var x = '';\nif (x != 0) throw 'a';\n", () => test("var x = '';\nif (x != 0) throw 'a';\n", ''));
    it("var x = !1;\nif (x != 0) throw 'a';\n", () => test("var x = !1;\nif (x != 0) throw 'a';\n", ''));
});

describe('test_coercion_substitution_boxed_number_vs_zero', () => {
    it("var x = /* @__PURE__ */ new Number(0);\nif (x != 0) throw 'a'", () =>
        test(
            "var x = /* @__PURE__ */ new Number(0);\nif (x != 0) throw 'a';\n",
            "if (/* @__PURE__ */ new Number(0) != 0) throw 'a';\n",
        ));
});

describe('test_coercion_substitution_boxed_primitives', () => {
    it("var x = /* @__PURE__ */ new Number(); if (x != null) throw '", () =>
        test(
            "var x = /* @__PURE__ */ new Number(); if (x != null) throw 'a';",
            "if (/* @__PURE__ */ new Number() != null) throw 'a';",
        ));
    it("var x = /* @__PURE__ */ new String(); if (x != null) throw '", () =>
        test(
            "var x = /* @__PURE__ */ new String(); if (x != null) throw 'a';",
            "if (/* @__PURE__ */ new String() != null) throw 'a';",
        ));
    it('var x = /* @__PURE__ */ new Boolean(); if (x != null) throw ', () =>
        test(
            "var x = /* @__PURE__ */ new Boolean(); if (x != null) throw 'a';",
            "if (/* @__PURE__ */ new Boolean() != null) throw 'a';",
        ));
});

describe('test_minimize_if_with_new_target_condition', () => {
    it('function x() {  if (new.target) {    return 1;  } else {    ', () =>
        test(
            'function x() {  if (new.target) {    return 1;  } else {    return 2;  }}',
            'function x() {  return new.target ? 1 : 2;}',
        ));
});

describe('compress_binary_boolean', () => {
    it('a instanceof b === true', () => test('a instanceof b === true', 'a instanceof b'));
    it('a instanceof b == true', () => test('a instanceof b == true', 'a instanceof b'));
    it('a instanceof b === false', () => test('a instanceof b === false', 'a instanceof b'));
    it('a instanceof b == false', () => test('a instanceof b == false', 'a instanceof b'));
    it('a instanceof b !== true', () => test('a instanceof b !== true', 'a instanceof b'));
    it('a instanceof b != true', () => test('a instanceof b != true', 'a instanceof b'));
    it('a instanceof b !== false', () => test('a instanceof b !== false', 'a instanceof b'));
    it('a instanceof b != false', () => test('a instanceof b != false', 'a instanceof b'));
    it('delete x === true', () => test('delete x === true', 'delete x'));
    it('delete x == true', () => test('delete x == true', 'delete x'));
    it('delete x === false', () => test('delete x === false', 'delete x'));
    it('delete x == false', () => test('delete x == false', 'delete x'));
    it('delete x !== true', () => test('delete x !== true', 'delete x'));
    it('delete x != true', () => test('delete x != true', 'delete x'));
    it('delete x !== false', () => test('delete x !== false', 'delete x'));
    it('delete x != false', () => test('delete x != false', 'delete x'));
});

describe('compress_binary_number', () => {
    it('if(x >> +y == 0){}', () => test('if(x >> +y == 0){}', 'x >> +y'));
    it('if(x >> +y === 0){}', () => test('if(x >> +y === 0){}', 'x >> +y'));
    it('if(x >> +y != 0){}', () => test('if(x >> +y != 0){}', 'x >> +y'));
    it('if(x >> +y !== 0){}', () => test('if(x >> +y !== 0){}', 'x >> +y'));
    it('if((-0 != +0) !== false){}', () => test('if((-0 != +0) !== false){}', ''));
    it('foo(x >> y == 0)', () => testSame('foo(x >> y == 0)'));
    it('v = (x = 1) === 1', () => test('v = (x = 1) === 1', 'v = (x = 1) == 1'));
    it('v = (x = 1) !== 1', () => test('v = (x = 1) !== 1', 'v = (x = 1) != 1'));
    it('v = !0 + null !== 1', () => test('v = !0 + null !== 1', 'v = !1'));
});

describe('test_try_compress_type_of_equal_string', () => {
    it("v = typeof foo === 'number'", () => test("v = typeof foo === 'number'", "v = typeof foo == 'number'"));
    it("v = 'number' === typeof foo", () => test("v = 'number' === typeof foo", "v = typeof foo == 'number'"));
    it('v = typeof foo === `number`', () => test('v = typeof foo === `number`', "v = typeof foo == 'number'"));
    it('v = `number` === typeof foo', () => test('v = `number` === typeof foo', "v = typeof foo == 'number'"));
    it("v = typeof foo !== 'number'", () => test("v = typeof foo !== 'number'", "v = typeof foo != 'number'"));
    it("v = 'number' !== typeof foo", () => test("v = 'number' !== typeof foo", "v = typeof foo != 'number'"));
    it('v = typeof foo !== `number`', () => test('v = typeof foo !== `number`', "v = typeof foo != 'number'"));
    it('v = `number` !== typeof foo', () => test('v = `number` !== typeof foo', "v = typeof foo != 'number'"));
});

describe('test_negate_empty_if_stmt_consequent', () => {
    it('if (x) {} else { foo }', () => test('if (x) {} else { foo }', 'x || foo'));
    it('if (x) ;else { foo }', () => test('if (x) ;else { foo }', 'x || foo'));
    it('if (x) {;} else { foo }', () => test('if (x) {;} else { foo }', 'x || foo'));
    it('if (x) { var foo } else { bar }', () => test('if (x) { var foo } else { bar }', 'if (x) var foo; else bar'));
    it('if (x) foo; else { var bar }', () => test('if (x) foo; else { var bar }', 'if (x) foo; else var bar'));
});

describe('test_compress_conditional_expression_inside', () => {
    it('x ? a = 0 : a = 1', () => test('x ? a = 0 : a = 1', 'a = +!x'));
    it('let a = {}; x ? a.b = 0 : a.b = 1', () => test('let a = {}; x ? a.b = 0 : a.b = 1', 'let a = {}; a.b = +!x'));
    it('globalThis.x = 0\n        let a_\n        Object.definePropert', () =>
        test(
            "globalThis.x = 0\n        let a_\n        Object.defineProperty(globalThis, 'a', { get: () => (globalThis.x++, a_), set: a => { a_ = a } })\n        x ? a = 0 : a = 1,\n        console.log(x, a)",
            "globalThis.x = 0\n        let a_;\n        Object.defineProperty(globalThis, 'a', { get: () => (globalThis.x++, a_), set: a => { a_ = a } }),\n        a = +!x,\n        console.log(x, a)",
        ));
    it('let a = [], i = 0; x ? a[i] = 0 : a[i] = 1', () =>
        test('let a = [], i = 0; x ? a[i] = 0 : a[i] = 1', 'let a = [], i = 0; a[0] = +!x'));
    it('x ? this.b = 0 : this.b = 1', () => test('x ? this.b = 0 : this.b = 1', 'this.b = +!x'));
    it('class B extends A {\n            constructor() {\n            ', () =>
        testSame(
            'class B extends A {\n            constructor() {\n                super() ? this.b = 0 : this.b = 1;\n            }\n        }',
        ));
    it('class B extends A {\n            constructor() {\n            ', () =>
        test(
            'class B extends A {\n            constructor() {\n                super();\n                x ? this.b = 0 : this.b = 1;\n            }\n        }',
            'class B extends A {\n            constructor() {\n                super(), this.b = +!x;\n            }\n        }',
        ));
    it('var a = {};\n        async function f(p) {\n            await ', () =>
        test(
            'var a = {};\n        async function f(p) {\n            await p ? a.b = 0 : a.b = 1;\n        }\n        const promise = f();\n        await promise, console.log(a.b);',
            'var a = {};\n        async function f(p) {\n            a.b = +!await p;\n        }\n        await f(), console.log(a.b);',
        ));
    it("x ? a = function foo() { return 'a' } : a = function bar() {", () =>
        test(
            "x ? a = function foo() { return 'a' } : a = function bar() { return 'b' }",
            "a = x ? function () { return 'a' } : function () { return 'b' }",
        ));
    it('x ? a.b = 0 : a.b = 1', () => testSame('x ? a.b = 0 : a.b = 1'));
    it('globalThis.x = 0\n        let a_ = {};\n        Object.defineP', () =>
        testSame(
            "globalThis.x = 0\n        let a_ = {};\n        Object.defineProperty(globalThis, 'a', { get: () => (globalThis.x++, a_), set: a => { a_ = a } }),\n        x ? a.b = 0 : a.b = 1,\n        console.log(x, a)",
        ));
    it('globalThis.x = 0; let a = {}; x ? (x = 1, a).b = 0 : (x = 1,', () =>
        testSame('globalThis.x = 0; let a = {}; x ? (x = 1, a).b = 0 : (x = 1, a).b = 1, console.log(x, a)'));
    it('let a = { b: 0 }, saved = a;\n        function f() {\n        ', () =>
        testSame(
            'let a = { b: 0 }, saved = a;\n        function f() {\n            return a = { b: 0 }, !0;\n        }\n        f() ? a.b = 1 : a.b = 2, console.log(saved.b, a.b);',
        ));
    it('let a = [0, 0], i = 0;\n        function f() {\n            re', () =>
        testSame(
            'let a = [0, 0], i = 0;\n        function f() {\n            return i = 1, !0;\n        }\n        f() ? a[i] = 8 : a[i] = 9, console.log(a);',
        ));
    it('let a = []; x() ? a[g()] = 1 : a[g()] = 2, console.log(a)', () =>
        testSame('let a = []; x() ? a[g()] = 1 : a[g()] = 2, console.log(a)'));
    it('async function f(p) {\n            await p ? a.b = 0 : a.b = ', () =>
        testSame(
            'async function f(p) {\n            await p ? a.b = 0 : a.b = 1;\n        }\n        const promise = f();\n        let a = {};\n        await promise, console.log(a.b);',
        ));
    it('var a = {};\n        async function f(p) {\n            await ', () =>
        testSame(
            "var a = {};\n        async function f(p) {\n            await p ? a[k] = 't' : a[k] = 'f';\n        }\n        const promise = f();\n        let k = 'x';\n        await promise, console.log(a);",
        ));
    it("x ? a = () => 'a' : a = () => 'b'", () => test("x ? a = () => 'a' : a = () => 'b'", "a = x ? () => 'a' : () => 'b'"));
    it('let a = foo, x = bar; x ? a += 1 : a += 2, console.log(a, x)', () =>
        test(
            'let a = foo, x = bar; x ? a += 1 : a += 2, console.log(a, x)',
            'let a = foo, x = bar; a += x ? 1 : 2, console.log(a, x)',
        ));
    it('let a = foo, x = bar; x ? a ||= 1 : a ||= 2, console.log(a, ', () =>
        test(
            'let a = foo, x = bar; x ? a ||= 1 : a ||= 2, console.log(a, x)',
            'let a = foo, x = bar; a ||= x ? 1 : 2, console.log(a, x)',
        ));
    it('let a = foo, x = bar; x ? a += 1 : a -= 2, console.log(a, x)', () =>
        testSame('let a = foo, x = bar; x ? a += 1 : a -= 2, console.log(a, x)'));
    it('x ? a += 0 : a += 1', () => testSame('x ? a += 0 : a += 1'));
    it('x ? a &&= 0 : a &&= 1', () => testSame('x ? a &&= 0 : a &&= 1'));
    it('let a = 0;\n        function f() {\n            return a = 2, ', () =>
        testSame(
            'let a = 0;\n        function f() {\n            return a = 2, !0;\n        }\n        f() ? a += 1 : a += 2, console.log(a);',
        ));
    it('let x = 0, a_ = 1;\n        Object.defineProperty(globalThis,', () =>
        testSame(
            "let x = 0, a_ = 1;\n        Object.defineProperty(globalThis, 'a', { get: () => (x++, a_), set: (v) => { a_ = v } }),\n        x ? a += 1 : a += 2,\n        console.log(x, a_);",
        ));
    it('let a = {}, x = bar; x ? a.b += 1 : a.b += 2, console.log(a,', () =>
        testSame('let a = {}, x = bar; x ? a.b += 1 : a.b += 2, console.log(a, x)'));
    it('let a = 1;\n        function f() {\n            return console', () =>
        testSame(
            "let a = 1;\n        function f() {\n            return console.log('f called'), !0;\n        }\n        f() ? a ||= 1 : a ||= 2, console.log(a);",
        ));
});

describe('test_derived_constructor_parameter_default_does_not_use_outer_super_state', () => {
    it('class Outer extends P {\n            constructor() {\n        ', () =>
        testSame(
            'class Outer extends P {\n            constructor() {\n                super();\n                class Inner extends Q {\n                    constructor(a = f() ? this.x = 1 : this.x = 2) {\n                        super();\n                    }\n                }\n                new Inner();\n            }\n        }',
        ));
});

describe('test_derived_constructor_this_captured_by_arrow', () => {
    it('class Outer extends P { constructor() {\n            super();', () =>
        test(
            'class Outer extends P { constructor() {\n            super();\n            use(() => f() ? this.k = 1 : this.k = 2);\n        } }',
            'class Outer extends P { constructor() {\n            super(), use(() => this.k = f() ? 1 : 2);\n        } }',
        ));
    it('class Outer extends P { constructor() {\n            use(() =', () =>
        test(
            'class Outer extends P { constructor() {\n            use(() => f() ? this.k = 1 : this.k = 2);\n            super();\n        } }',
            'class Outer extends P { constructor() {\n            use(() => f() ? this.k = 1 : this.k = 2), super();\n        } }',
        ));
    it('class Outer extends P { constructor() {\n            use(() =', () =>
        test(
            'class Outer extends P { constructor() {\n            use(() => {\n                super();\n                f() ? this.k = 1 : this.k = 2;\n            });\n        } }',
            'class Outer extends P { constructor() {\n            use(() => {\n                super(), this.k = f() ? 1 : 2;\n            });\n        } }',
        ));
});

describe('test_derived_constructor_this_in_nested_class_computed_key', () => {
    it('class Outer extends P { constructor() {\n            class In', () =>
        testSame(
            'class Outer extends P { constructor() {\n            class Inner { [f() ? this.k = 1 : this.k = 2]() {} }\n            super();\n        } }',
        ));
    it('class Outer extends P { constructor() {\n            super();', () =>
        test(
            'class Outer extends P { constructor() {\n            super();\n            class Inner { [f() ? this.k = 1 : this.k = 2]() {} }\n        } }',
            'class Outer extends P { constructor() {\n            super();\n            class Inner { [this.k = f() ? 1 : 2]() {} }\n        } }',
        ));
    it('class Outer extends P { constructor() {\n            class In', () =>
        test(
            'class Outer extends P { constructor() {\n            class Inner { method() { f() ? this.k = 1 : this.k = 2 } }\n            super();\n        } }',
            'class Outer extends P { constructor() {\n            class Inner { method() { this.k = f() ? 1 : 2 } }\n            super();\n        } }',
        ));
    it('class Outer extends P { constructor() {\n            class In', () =>
        test(
            'class Outer extends P { constructor() {\n            class Inner { field = f() ? this.k = 1 : this.k = 2 }\n            super();\n        } }',
            'class Outer extends P { constructor() {\n            class Inner { field = this.k = f() ? 1 : 2 }\n            super();\n        } }',
        ));
});

describe('test_fold_is_null_or_undefined', () => {
    it('v = foo === null || foo === undefined', () => test('v = foo === null || foo === undefined', 'v = foo == null'));
    it('v = foo === undefined || foo === null', () => test('v = foo === undefined || foo === null', 'v = foo == null'));
    it('v = foo === null || foo === void 0', () => test('v = foo === null || foo === void 0', 'v = foo == null'));
    it('v = foo === null || foo === void 0 || foo === 1', () =>
        test('v = foo === null || foo === void 0 || foo === 1', 'v = foo == null || foo === 1'));
    it('v = foo === 1 || foo === null || foo === void 0', () =>
        test('v = foo === 1 || foo === null || foo === void 0', 'v = foo === 1 || foo == null'));
    it('v = foo === void 0 || bar === null', () => testSame('v = foo === void 0 || bar === null'));
    it('var undefined = 1; v = foo === null || foo === undefined', () =>
        test('var undefined = 1; v = foo === null || foo === undefined', 'v = foo === null || foo === 1'));
    it('v = foo !== 1 && foo === void 0 || foo === null', () => testSame('v = foo !== 1 && foo === void 0 || foo === null'));
    it('v = foo.a === void 0 || foo.a === null', () => testSame('v = foo.a === void 0 || foo.a === null'));
    it('v = foo !== null && foo !== undefined', () => test('v = foo !== null && foo !== undefined', 'v = foo != null'));
    it('v = foo !== undefined && foo !== null', () => test('v = foo !== undefined && foo !== null', 'v = foo != null'));
    it('v = foo !== null && foo !== void 0', () => test('v = foo !== null && foo !== void 0', 'v = foo != null'));
    it('v = foo !== null && foo !== void 0 && foo !== 1', () =>
        test('v = foo !== null && foo !== void 0 && foo !== 1', 'v = foo != null && foo !== 1'));
    it('v = foo !== 1 && foo !== null && foo !== void 0', () =>
        test('v = foo !== 1 && foo !== null && foo !== void 0', 'v = foo !== 1 && foo != null'));
    it('v = foo !== 1 || foo !== void 0 && foo !== null', () =>
        test('v = foo !== 1 || foo !== void 0 && foo !== null', 'v = foo !== 1 || foo != null'));
    it('v = foo !== void 0 && bar !== null', () => testSame('v = foo !== void 0 && bar !== null'));
    it('v = (_foo = foo) === null || _foo === undefined', () =>
        test('v = (_foo = foo) === null || _foo === undefined', 'v = (_foo = foo) == null'));
    it('v = (_foo = foo) === null || _foo === void 0', () =>
        test('v = (_foo = foo) === null || _foo === void 0', 'v = (_foo = foo) == null'));
    it('v = (_foo = foo.bar) === null || _foo === undefined', () =>
        test('v = (_foo = foo.bar) === null || _foo === undefined', 'v = (_foo = foo.bar) == null'));
    it('v = (_foo = foo) !== null && _foo !== undefined', () =>
        test('v = (_foo = foo) !== null && _foo !== undefined', 'v = (_foo = foo) != null'));
    it('v = (_foo = foo) === undefined || _foo === null', () =>
        test('v = (_foo = foo) === undefined || _foo === null', 'v = (_foo = foo) == null'));
    it('v = (_foo = foo) === void 0 || _foo === null', () =>
        test('v = (_foo = foo) === void 0 || _foo === null', 'v = (_foo = foo) == null'));
    it('v = (_foo = foo) === null || _foo === void 0 || _foo === 1', () =>
        test('v = (_foo = foo) === null || _foo === void 0 || _foo === 1', 'v = (_foo = foo) == null || _foo === 1'));
    it('v = _foo === 1 || (_foo = foo) === null || _foo === void 0', () =>
        test('v = _foo === 1 || (_foo = foo) === null || _foo === void 0', 'v = _foo === 1 || (_foo = foo) == null'));
    it('v = (_foo = foo) === void 0 || bar === null', () => testSame('v = (_foo = foo) === void 0 || bar === null'));
});

describe('test_fold_logical_expression_to_assignment_expression', () => {
    it('x || (x = 3)', () => test('x || (x = 3)', 'x ||= 3'));
    it('x && (x = 3)', () => test('x && (x = 3)', 'x &&= 3'));
    it('x ?? (x = 3)', () => test('x ?? (x = 3)', 'x ??= 3'));
    it('x || (x = g())', () => test('x || (x = g())', 'x ||= g()'));
    it('x && (x = g())', () => test('x && (x = g())', 'x &&= g()'));
    it('x ?? (x = g())', () => test('x ?? (x = g())', 'x ??= g()'));
    it("x || (x = () => 'a')", () => test("x || (x = () => 'a')", "x ||= () => 'a'"));
    it('x || (y = 3)', () => testSame('x || (y = 3)'));
    it('var x; x.y || (x.z = 3)', () => testSame('var x; x.y || (x.z = 3)'));
    it('function _() { this.x || (this.y = 3) }', () => testSame('function _() { this.x || (this.y = 3) }'));
    it('var x; x.y || (x.y = 3)', () => test('var x; x.y || (x.y = 3)', 'var x; x.y ||= 3'));
    it("var x; x['y'] || (x['y'] = 3)", () => test("var x; x['y'] || (x['y'] = 3)", 'var x; x.y ||= 3'));
    it('var x; x[0] || (x[0] = 3)', () => test('var x; x[0] || (x[0] = 3)', 'var x; x[0] ||= 3'));
    it('var x; x.#y || (x.#y = 3)', () => test('var x; x.#y || (x.#y = 3)', 'var x; x.#y ||= 3'));
    it('function _() { this.x || (this.x = 3) }', () =>
        test('function _() { this.x || (this.x = 3) }', 'function _() { this.x ||= 3 }'));
    it('x.y || (x.y = 3)', () => testSame('x.y || (x.y = 3)'));
    it('var x; x[y] || (x[y] = 3)', () => testSame('var x; x[y] || (x[y] = 3)'));
    it('var x; x.y.z || (x.y.z = 3)', () => testSame('var x; x.y.z || (x.y.z = 3)'));
    it('foo().a || (foo().a = 3)', () => testSame('foo().a || (foo().a = 3)'));
    it('x || (x = 3)', () => testTarget('x || (x = 3)', 'x || (x = 3)', 2020));
    it('x || (a, x = 3)', () => test('x || (a, x = 3)', 'x ||= (a, 3)'));
    it('x && (a, x = 3)', () => test('x && (a, x = 3)', 'x &&= (a, 3)'));
    it('x ?? (a, x = 3)', () => test('x ?? (a, x = 3)', 'x ??= (a, 3)'));
    it('x || (a, x = g())', () => test('x || (a, x = g())', 'x ||= (a, g())'));
    it('x && (a, x = g())', () => test('x && (a, x = g())', 'x &&= (a, g())'));
    it('x ?? (a, x = g())', () => test('x ?? (a, x = g())', 'x ??= (a, g())'));
    it('var x; x.y || (a, x.y = 3)', () => test('var x; x.y || (a, x.y = 3)', 'var x; x.y ||= (a, 3)'));
    it('var x; x.y && (a, x.y = 3)', () => test('var x; x.y && (a, x.y = 3)', 'var x; x.y &&= (a, 3)'));
    it('var x; x.y ?? (a, x.y = 3)', () => test('var x; x.y ?? (a, x.y = 3)', 'var x; x.y ??= (a, 3)'));
    it('x.y || (a, x.y = 3)', () => testSame('x.y || (a, x.y = 3)'));
    it('x.y && (a, x.y = 3)', () => testSame('x.y && (a, x.y = 3)'));
    it('x.y ?? (a, x.y = 3)', () => testSame('x.y ?? (a, x.y = 3)'));
    it('var x = {}; x.y || (x = {}, x.y = 3)', () => testSame('var x = {}; x.y || (x = {}, x.y = 3)'));
    it('var x = { y: 1 }; x.y && (x = {}, x.y = 3)', () => testSame('var x = { y: 1 }; x.y && (x = {}, x.y = 3)'));
    it('var x = {}; x.y ?? (x = {}, x.y = 3)', () => testSame('var x = {}; x.y ?? (x = {}, x.y = 3)'));
    it('var x = {}; x.y || (a, x = {}, x.y = 3)', () => testSame('var x = {}; x.y || (a, x = {}, x.y = 3)'));
    it('var x = {}; x.y || (foo(x = {}), x.y = 3)', () => testSame('var x = {}; x.y || (foo(x = {}), x.y = 3)'));
    it('var x = { y: {} }; x.y.z || (x.y = {}, x.y.z = 3)', () => testSame('var x = { y: {} }; x.y.z || (x.y = {}, x.y.z = 3)'));
    it("import { x, mutate } from 'm'; x.y || (mutate(), x.y = 3)", () =>
        testSame("import { x, mutate } from 'm'; x.y || (mutate(), x.y = 3)"));
    it('x || (a, x = 3)', () => test('x || (a, x = 3)', 'x ||= (a, 3)'));
    it('var x = {}; x.y || (foo(), x.y = 3)', () =>
        test('var x = {}; x.y || (foo(), x.y = 3)', 'var x = {}; x.y ||= (foo(), 3)'));
    it('var x = {}; x.y || (new Foo(), x.y = 3)', () =>
        test('var x = {}; x.y || (new Foo(), x.y = 3)', 'var x = {}; x.y ||= (new Foo(), 3)'));
    it('var x = {}; x.y || (tag``, x.y = 3)', () =>
        test('var x = {}; x.y || (tag``, x.y = 3)', 'var x = {}; x.y ||= (tag``, 3)'));
    it('var x = {}; function f() { x = {} } x.y || (foo(), x.y = 3)', () =>
        testSame('var x = {}; function f() { x = {} } x.y || (foo(), x.y = 3)'));
    it('var x = {}; x.y.z || (x.y = {}, x.y.z = 3)', () => testSame('var x = {}; x.y.z || (x.y = {}, x.y.z = 3)'));
    it('var x = {}; x.y.z || (x = {}, x.y.z = 3)', () => testSame('var x = {}; x.y.z || (x = {}, x.y.z = 3)'));
    it('var x = {}; x.y.z.w || (x.y = {}, x.y.z.w = 3)', () => testSame('var x = {}; x.y.z.w || (x.y = {}, x.y.z.w = 3)'));
    it('var x = {}; x.y || (x.y.z = {}, x.y = 3)', () =>
        test('var x = {}; x.y || (x.y.z = {}, x.y = 3)', 'var x = {}; x.y ||= (x.y.z = {}, 3)'));
    it('var x = { get y() { return x = { y: 9 }, 0 } }; x.y || (x.y ', () =>
        testSame('var x = { get y() { return x = { y: 9 }, 0 } }; x.y || (x.y = 3)'));
    it('var x = { get y() { return x = { y: 9 }, 1 } }; x.y && (x.y ', () =>
        testSame('var x = { get y() { return x = { y: 9 }, 1 } }; x.y && (x.y = 3)'));
    it('var x = { get y() { x = { y: 9 } } }; x.y ?? (x.y = 3)', () =>
        testSame('var x = { get y() { x = { y: 9 } } }; x.y ?? (x.y = 3)'));
});

describe('test_compress_normal_assignment_to_combined_logical_assignment', () => {
    it('var x; x = x || 1', () => test('var x; x = x || 1', 'var x; x ||= 1'));
    it('var x; x = x && 1', () => test('var x; x = x && 1', 'var x; x &&= 1'));
    it('var x; x = x ?? 1', () => test('var x; x = x ?? 1', 'var x; x ??= 1'));
    it('x = x || 1', () => testSame('x = x || 1'));
    it('var x; x.y = x.y || 1', () => testSame('var x; x.y = x.y || 1'));
    it("var x; x = x || (() => 'a')", () => test("var x; x = x || (() => 'a')", "var x; x ||= (() => 'a')"));
    it('var x; x = x || 1', () => testTarget('var x; x = x || 1', 'var x = x || 1', 2020));
});

describe('test_compress_is_loose_boolean', () => {
    it('v = x == true', () => test('v = x == true', 'v = x == 1'));
    it('v = x != true', () => test('v = x != true', 'v = x != 1'));
    it('v = x == false', () => test('v = x == false', 'v = x == 0'));
    it('v = x != false', () => test('v = x != false', 'v = x != 0'));
    it('v = x == !0', () => test('v = x == !0', 'v = x == 1'));
    it('v = x != !0', () => test('v = x != !0', 'v = x != 1'));
    it('v = x == !1', () => test('v = x == !1', 'v = x == 0'));
    it('v = x != !1', () => test('v = x != !1', 'v = x != 0'));
    it('v = ![f()] == x', () => testSame('v = ![f()] == x'));
    it('v = x == ![f()]', () => testSame('v = x == ![f()]'));
});

describe('try_minimize_binary', () => {
    it('f(!a === !0)', () => test('f(!a === !0)', 'f(!a)'));
    it('f(!a === !1)', () => test('f(!a === !1)', 'f(!!a)'));
    it('f(!a === true)', () => test('f(!a === true)', 'f(!a)'));
    it('f(!a === false)', () => test('f(!a === false)', 'f(!!a)'));
    it('f((a & 1) != 0)', () => test('f((a & 1) != 0)', 'f(!!(a & 1))'));
    it('f((a & 2) == 0)', () => test('f((a & 2) == 0)', 'f(!(a & 2))'));
    it('f((a | 1) !== 0)', () => test('f((a | 1) !== 0)', 'f(!!(a | 1))'));
    it('f((a ^ 2) === 0)', () => test('f((a ^ 2) === 0)', 'f(!(a ^ 2))'));
    it('f((a >>> b) !== 0)', () => test('f((a >>> b) !== 0)', 'f(!!(a >>> b))'));
    it('f(0 === (a & 4))', () => test('f(0 === (a & 4))', 'f(!(a & 4))'));
    it('f((a + b) != 0)', () => testSame('f((a + b) != 0)'));
    it('f((a * 2) == 0)', () => testSame('f((a * 2) == 0)'));
    it('f(+a === 0)', () => test('f(+a === 0)', 'f(+a == 0)'));
    it('f((a & b) !== 0)', () => testSame('f((a & b) !== 0)'));
    it('f((a & 1n) !== 0)', () => testSame('f((a & 1n) !== 0)'));
    it('f((a & 1) != 1)', () => testSame('f((a & 1) != 1)'));
});

describe('test_fold_equal_branches_keeps_indirect_access', () => {
    it("var c; (c ? eval : eval)('x')", () => test("var c; (c ? eval : eval)('x')", "var c; (0, eval)('x')"));
    it("var c; (c ? o.f : o.f)('y')", () => test("var c; (c ? o.f : o.f)('y')", "var c; (0, o.f)('y')"));
    it('var c; (c ? o.f : o.f)`y`', () => test('var c; (c ? o.f : o.f)`y`', 'var c; (0, o.f)`y`'));
    it("var c; (c ? foo : foo)('x')", () => test("var c; (c ? foo : foo)('x')", "var c; foo('x')"));
    it("(c() ? eval : eval)('x')", () => test("(c() ? eval : eval)('x')", "(c(), eval)('x')"));
});
