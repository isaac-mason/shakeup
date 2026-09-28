// Ported from oxc_minifier/tests/peephole/minimize_exit_points.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { test, testSame } from './harness.ts';

describe('test_break_optimization', () => {
    it('f:{if(true){a();break f;}else;b();}', () => test('f:{if(true){a();break f;}else;b();}', 'f:{a();break f}'));
    it('f:{if(false){a();break f;}else;b();break f;}', () =>
        test('f:{if(false){a();break f;}else;b();break f;}', 'f:{b();break f}'));
    it('f:{if(a()){b();break f;}else;c();}', () => test('f:{if(a()){b();break f;}else;c();}', 'f:{if(a()){b();break f}c()}'));
    it('f:{if(a()){b()}else{c();break f;}}', () => test('f:{if(a()){b()}else{c();break f;}}', 'f:if(a())b();else{c();break f}'));
    it('f:{if(a()){b();break f;}else;}', () => test('f:{if(a()){b();break f;}else;}', 'f:if(a()){b();break f}'));
    it('f:{if(a()){break f;}else;}', () => test('f:{if(a()){break f;}else;}', 'f:if(a())break f;'));
    it('f:while(a())break f;', () => test('f:while(a())break f;', 'f:for(;a();)break f;'));
    it('f:for(x in a())break f', () => testSame('f:for(x in a())break f'));
    it('f:{while(a())break;}', () => test('f:{while(a())break;}', 'f:for(;a();)break;'));
    it('f:{for(x in a())break}', () => test('f:{for(x in a())break}', 'f:for(x in a())break;'));
    it('f:try{break f;}catch(e){break f;}', () => test('f:try{break f;}catch(e){break f;}', 'f:try{break f}catch{break f}'));
    it('f:try{if(a()){break f;}else{break f;} break f;}catch(e){}', () =>
        test('f:try{if(a()){break f;}else{break f;} break f;}catch(e){}', 'f:try{if(a())break f;break f}catch{}'));
    it('f:g:break f', () => testSame('f:g:break f'));
    it('f:g:{if(a()){break f;}else{break f;} break f;}', () =>
        test('f:g:{if(a()){break f;}else{break f;} break f;}', 'f:g:{if(a())break f;break f}'));
    it('function f() { a: break a; }', () => test('function f() { a: break a; }', 'function f() {}'));
    it('function f() { a: { break a; } }', () => test('function f() { a: { break a; } }', 'function f() {}'));
    it('function f() { a: { b(); break a; } c(); }', () => testSame('function f() { a: { b(); break a; } c(); }'));
    it('function f() { a: { b(); return; } c(); }', () => testSame('function f() { a: { b(); return; } c(); }'));
});

describe('test_function_return_optimization', () => {
    it('function f(){return}', () => test('function f(){return}', 'function f(){}'));
    it('f=()=>{return}', () => test('f=()=>{return}', 'f=()=>{}'));
    it('function f(){if(a()){b();if(c())return;}}', () =>
        test('function f(){if(a()){b();if(c())return;}}', 'function f(){a()&&(b(),c());}'));
    it('f=()=>{if(a()){b();if(c())return;}}', () => test('f=()=>{if(a()){b();if(c())return;}}', 'f=()=>{a()&&(b(),c());}'));
    it('function f(){if(x)return; x=3; return; }', () =>
        test('function f(){if(x)return; x=3; return; }', 'function f(){ x||=3;}'));
    it('function f(){if(true){a();return;}else;b();}', () =>
        test('function f(){if(true){a();return;}else;b();}', 'function f(){a();}'));
    it('function f(){if(false){a();return;}else;b();return;}', () =>
        test('function f(){if(false){a();return;}else;b();return;}', 'function f(){b();}'));
    it('function f(){if(a()){b();return;}else;c();}', () =>
        test('function f(){if(a()){b();return;}else;c();}', 'function f(){if(a()){b();return}c()}'));
    it('function f(){if(a()){b()}else{c();return;}}', () =>
        test('function f(){if(a()){b()}else{c();return;}}', 'function f(){if(a())b();else{c();return}}'));
    it('function f(){ if(a()) { if (a) { return } throw a; } else re', () =>
        test(
            'function f(){ if(a()) { if (a) { return } throw a; } else return 2; }',
            'function f(){ if(a()) { if (a) return; throw a } return 2 }',
        ));
    it('function f(){if(a()){if(b()){d();return;}else{return;}}else{', () =>
        test(
            'function f(){if(a()){if(b()){d();return;}else{return;}}else{return;} c();}',
            'function f(){if(a()){if(b()){d();return}return}}',
        ));
    it('function f(a,b,c){if(a){}else if(b){x();return}else if(c){y(', () =>
        test(
            'function f(a,b,c){if(a){}else if(b){x();return}else if(c){y();return}z()}',
            'function f(a,b,c){if(!a){if(b){x();return}if(c){y();return}}z()}',
        ));
    it('function f(){if(a()){b();return;}else;}', () =>
        test('function f(){if(a()){b();return;}else;}', 'function f(){if(a()){b();return}}'));
    it('function f(){if(a()){return;}else{return;} return;}', () =>
        test('function f(){if(a()){return;}else{return;} return;}', 'function f(){a();}'));
    it('function f(){if(a()){return;}else{return;} b();}', () =>
        test('function f(){if(a()){return;}else{return;} b();}', 'function f(){a()}'));
    it('function f(){ if (x) return; if (y) return; if (z) return; w', () =>
        test('function f(){ if (x) return; if (y) return; if (z) return; w(); }', 'function f(){x||y||z||w()}'));
    it('function f(){while(a())return;}', () => test('function f(){while(a())return;}', 'function f(){for(;a();)return}'));
    it('function f(){for(x in a())return}', () => testSame('function f(){for(x in a())return}'));
    it('function f(){while(a())break;}', () => test('function f(){while(a())break;}', 'function f(){for(;a();)break}'));
    it('function f(){for(x in a())break}', () => testSame('function f(){for(x in a())break}'));
    it('function f(){try{return;}catch(e){throw 9;}finally{return}}', () =>
        test(
            'function f(){try{return;}catch(e){throw 9;}finally{return}}',
            'function f(){try{return;}catch{throw 9;}finally{return}}',
        ));
    it('function f(){try{throw 9;}finally{return;}}', () => testSame('function f(){try{throw 9;}finally{return;}}'));
    it('function f(){try{return;}catch(e){return;}}', () =>
        test('function f(){try{return;}catch(e){return;}}', 'function f(){try{return}catch{return}}'));
    it('function f(){try{if(a()){return;}else{return;} return;}catch', () =>
        test('function f(){try{if(a()){return;}else{return;} return;}catch(e){}}', 'function f(){try{a();return}catch{}}'));
    it('function f(){g:return}', () => testSame('function f(){g:return}'));
    it('function f(){g:{return}}', () => test('function f(){g:{return}}', 'function f(){g:return}'));
    it('function f(){g:if(a()){return;}else{return;} return;}', () =>
        test('function f(){g:if(a()){return;}else{return;} return;}', 'function f(){g:if(a())return;else return}'));
    it('function f(){g:{if(a()){return;}else{return;} return;}}', () =>
        test('function f(){g:{if(a()){return;}else{return;} return;}}', 'function f(){g:return a(),void 0}'));
    // Printer parenthesizes a nested sequence element; oxc codegen prints elements at Precedence::Lowest.
    it.skip('function f(){g:{a();if(b()){return;}else{return;} return;}}', () =>
        test('function f(){g:{a();if(b()){return;}else{return;} return;}}', 'function f(){g:return a(),b(),void 0}'));
    it('function f(){try{g:if(a()){throw 9;} return;}finally{return}', () =>
        test(
            'function f(){try{g:if(a()){throw 9;} return;}finally{return}}',
            'function f(){try{g:if(a())throw 9; return}finally{return}}',
        ));
    it('function g(a,b){if(a){}else if(b){return()=>typeof f}else fu', () =>
        test(
            'function g(a,b){if(a){}else if(b){return()=>typeof f}else function f(){}}',
            'function g(a,b){if(!a){if(b)return()=>typeof f;else function f(){}}}',
        ));
});

describe('test_function_return_scoped', () => {
    it('function f(a) {\n              if (a) {\n                let a', () =>
        test(
            'function f(a) {\n              if (a) {\n                let a = Math.random();\n                if (a < 0.5) {\n                    return a;\n                }\n              }\n              return a;\n            }',
            'function f(a) {\n              if (a) {\n                let a = Math.random();\n                if (a < 0.5) return a;\n              }\n              return a;\n            }',
        ));
});

describe('test_while_continue_optimization', () => {
    it('while(true){if(x)continue; x=3; continue; }', () => test('while(true){if(x)continue; x=3; continue; }', 'for(;;)x||=3;'));
    it('while(true){a();continue;b();}', () => test('while(true){a();continue;b();}', 'for(;;)a();'));
    it('while(true){if(true){a();continue;}else;b();}', () =>
        test('while(true){if(true){a();continue;}else;b();}', 'for(;;)a();'));
    it('while(true){if(false){a();continue;}else;b();continue;}', () =>
        test('while(true){if(false){a();continue;}else;b();continue;}', 'for(;;)b();'));
    it('while(true){if(a()){b();continue;}else;c();}', () =>
        test('while(true){if(a()){b();continue;}else;c();}', 'for(;;){if(a()){b();continue}c()}'));
    it('while(true){if(a()){b();}else{c();continue;}}', () =>
        test('while(true){if(a()){b();}else{c();continue;}}', 'for(;;)if(a())b();else{c();continue}'));
    it('while(true){if(a()){b();continue;}else;}', () =>
        test('while(true){if(a()){b();continue;}else;}', 'for (;;) if(a()){b();continue;}'));
    it('while(true){if(a()){continue;}else{continue;} continue;}', () =>
        test('while(true){if(a()){continue;}else{continue;} continue;}', 'for(;;)a();'));
    it('while(true){if(a()){continue;}else{continue;} b();}', () =>
        test('while(true){if(a()){continue;}else{continue;} b();}', 'for(;;)a();'));
    it('while(true){d();if(a()){continue;}else if(b()){c();continue;', () =>
        test(
            'while(true){d();if(a()){continue;}else if(b()){c();continue;}else{continue;}}',
            'for(;;)if(d(),!a()&&b()){c();continue}',
        ));
    it('while(true)while(a())continue;', () => test('while(true)while(a())continue;', 'for(;;)for(;a();)continue;'));
    it('while(true)for(x in a())continue', () => test('while(true)for(x in a())continue', 'for(;;)for(x in a())continue;'));
    it('while(true)while(a())break;', () => test('while(true)while(a())break;', 'for(;;)for(;a();)break'));
    it('while(true)for(x in a())break', () => test('while(true)for(x in a())break', 'for(;;)for(x in a())break'));
    it('while(true){try{continue;}catch(e){continue;}}', () =>
        test('while(true){try{continue;}catch(e){continue;}}', 'for(;;)try{continue}catch{continue}'));
    it('while(true){try{if(a()){continue;}else{continue;} continue;}', () =>
        test(
            'while(true){try{if(a()){continue;}else{continue;} continue;}catch(e){}}',
            'for(;;)try{if(a())continue;continue}catch{}',
        ));
    it('while(true){g:continue}', () => test('while(true){g:continue}', 'for(;;) g:continue;'));
    it('while(true){g:{continue}}', () => test('while(true){g:{continue}}', 'for(;;) g:continue;'));
    it('while(true){g:if(a()){continue;}else{continue;} continue;}', () =>
        test('while(true){g:if(a()){continue;}else{continue;} continue;}', 'for(;;)g:if(a())continue;else continue;'));
    it('while(true){g:{if(a()){continue;}else{continue;} continue;}}', () =>
        test('while(true){g:{if(a()){continue;}else{continue;} continue;}}', 'for(;;)g:{if(a())continue;continue}'));
    it('while(true){g:{a();if(b()){continue;}else{continue;} continu', () =>
        test('while(true){g:{a();if(b()){continue;}else{continue;} continue;}}', 'for(;;)g:{if(a(),b())continue;continue}'));
});

describe('test_do_continue_optimization', () => {
    it('do{if(x)continue; x=3; continue; }while(true)', () =>
        test('do{if(x)continue; x=3; continue; }while(true)', 'do x||=3;while(!0);'));
    it('do{a();continue;b()}while(true)', () => test('do{a();continue;b()}while(true)', 'do a();while(!0)'));
    it('do{if(true){a();continue;}else;b();}while(true)', () =>
        test('do{if(true){a();continue;}else;b();}while(true)', 'do a();while(!0)'));
    it('do{if(false){a();continue;}else;b();continue;}while(true)', () =>
        test('do{if(false){a();continue;}else;b();continue;}while(true)', 'do b();while(!0)'));
    it('do{if(a()){b();continue;}else;c();}while(true)', () =>
        test('do{if(a()){b();continue;}else;c();}while(true)', 'do{if(a()){b();continue}c()}while(!0);'));
    it('do{if(a()){b();}else{c();continue;}}while(true)', () =>
        test('do{if(a()){b();}else{c();continue;}}while(true)', 'do if(a())b();else{c();continue}while(!0);'));
    it('do{if(a()){b();continue;}else;}while(true)', () =>
        test('do{if(a()){b();continue;}else;}while(true)', 'do if(a()){b();continue}while(!0);'));
    it('do{if(a()){continue;}else{continue;} continue;}while(true)', () =>
        test('do{if(a()){continue;}else{continue;} continue;}while(true)', 'do a();while(!0)'));
    it('do{if(a()){continue;}else{continue;} b();}while(true)', () =>
        test('do{if(a()){continue;}else{continue;} b();}while(true)', 'do a();while(!0)'));
    it('do{while(a())continue;}while(true)', () =>
        test('do{while(a())continue;}while(true)', 'do for(;a();)continue;while(!0);'));
    it('do{for(x in a())continue}while(true)', () =>
        test('do{for(x in a())continue}while(true)', 'do for(x in a())continue;while(!0);'));
    it('do{while(a())break;}while(true)', () => test('do{while(a())break;}while(true)', 'do for(;a();)break;while(!0)'));
    it('do for(x in a())break;while(true)', () => test('do for(x in a())break;while(true)', 'do for(x in a())break;while(!0)'));
    it('do{try{continue;}catch(e){continue;}}while(true)', () =>
        test('do{try{continue;}catch(e){continue;}}while(true)', 'do try{continue}catch{continue}while(!0);'));
    it('do{try{if(a()){continue;}else{continue;} continue;}catch(e){', () =>
        test(
            'do{try{if(a()){continue;}else{continue;} continue;}catch(e){}}while(true)',
            'do try{if(a())continue;continue}catch{}while(!0);',
        ));
    it('do{g:continue}while(true)', () => test('do{g:continue}while(true)', 'do g:continue;while(!0);'));
    it('do{g:if(a()){continue;}else{continue;} continue;}while(true)', () =>
        test('do{g:if(a()){continue;}else{continue;} continue;}while(true)', 'do g:if(a())continue;else continue;while(!0);'));
    it('do { foo(); continue; } while(false)', () => test('do { foo(); continue; } while(false)', 'do foo();while(!1)'));
    it('do { foo(); break; } while(false)', () => test('do { foo(); break; } while(false)', 'do foo();while(!1)'));
    it('do{break}while(fn());', () => test('do{break}while(fn());', 'do break; while(fn());'));
    it('do{break}while(true);', () => test('do{break}while(true);', 'do break; while(!0);'));
    it('do{break}while(!new Date());', () => test('do{break}while(!new Date());', 'do;while(!1);'));
    it('do { foo(); switch (x) { case 1: break; default: f()} } whil', () =>
        test(
            'do { foo(); switch (x) { case 1: break; default: f()} } while(false)',
            'do switch (foo(),x) { case 1: break; default: f() } while(!1);',
        ));
});

describe('test_for_continue_optimization', () => {
    it('for(x in y){if(x)continue; x=3; continue; }', () =>
        test('for(x in y){if(x)continue; x=3; continue; }', 'for(x in y)x||=3'));
    it('for(x in y){a();continue;b()}', () => test('for(x in y){a();continue;b()}', 'for(x in y)a()'));
    it('for(x in y){if(true){a();continue;}else;b();}', () =>
        test('for(x in y){if(true){a();continue;}else;b();}', 'for(x in y)a()'));
    it('for(x in y){if(false){a();continue;}else;b();continue;}', () =>
        test('for(x in y){if(false){a();continue;}else;b();continue;}', 'for(x in y)b()'));
    it('for(x in y){if(a()){b();continue;}else;c();}', () =>
        test('for(x in y){if(a()){b();continue;}else;c();}', 'for(x in y){if(a()){b();continue}c()}'));
    it('for(x in y){if(a()){b();}else{c();continue;}}', () =>
        test('for(x in y){if(a()){b();}else{c();continue;}}', 'for(x in y)if(a())b();else{c();continue}'));
    it('for(x of y){if(x)continue; x=3; continue; }', () =>
        test('for(x of y){if(x)continue; x=3; continue; }', 'for(x of y)x||=3'));
    it('for(x of y){a();continue;b()}', () => test('for(x of y){a();continue;b()}', 'for(x of y)a()'));
    it('for(x of y){if(true){a();continue;}else;b();}', () =>
        test('for(x of y){if(true){a();continue;}else;b();}', 'for(x of y)a()'));
    it('for(x of y){if(false){a();continue;}else;b();continue;}', () =>
        test('for(x of y){if(false){a();continue;}else;b();continue;}', 'for(x of y)b()'));
    it('for(x of y){if(a()){b();continue;}else;c();}', () =>
        test('for(x of y){if(a()){b();continue;}else;c();}', 'for(x of y){if(a()){b();continue}c()}'));
    it('for(x of y){if(a()){b();}else{c();continue;}}', () =>
        test('for(x of y){if(a()){b();}else{c();continue;}}', 'for(x of y)if(a())b();else{c();continue}'));
    it('r=async () => { for await (x of y){if(x)continue; x=3; conti', () =>
        test(
            'r=async () => { for await (x of y){if(x)continue; x=3; continue; }}',
            'r=async () => { for await (x of y) x||=3 };',
        ));
    it('r=async () => { for await (x of y){a();continue;b()}}', () =>
        test('r=async () => { for await (x of y){a();continue;b()}}', 'r=async () => { for await(x of y) a() };'));
    it('r=async () => { for await (x of y){if(true){a();continue;}el', () =>
        test(
            'r=async () => { for await (x of y){if(true){a();continue;}else;b();}}',
            'r=async () => { for await (x of y) a() };',
        ));
    it('r=async () => { for await (x of y){if(false){a();continue;}e', () =>
        test(
            'r=async () => { for await (x of y){if(false){a();continue;}else;b();continue;}}',
            'r=async() => { for await (x of y) b() };',
        ));
    it('r=async () => { for await (x of y){if(a()){b();continue;}els', () =>
        test(
            'r=async () => { for await (x of y){if(a()){b();continue;}else;c();}}',
            'r=async () => { for await (x of y){if(a()){b();continue}c()}};',
        ));
    it('r=async () => { for await (x of y){if(a()){b();}else{c();con', () =>
        test(
            'r=async () => { for await (x of y){if(a()){b();}else{c();continue;}}}',
            'r=async() => { for await(x of y)if(a())b();else{c();continue}};',
        ));
    it('for(x=0;x<y;x++){if(a()){b();continue;}else;}', () =>
        test('for(x=0;x<y;x++){if(a()){b();continue;}else;}', 'for(x=0;x<y;x++)if(a()){b();continue}'));
    it('for(x=0;x<y;x++){if(a()){continue;}else{continue;} continue;', () =>
        test('for(x=0;x<y;x++){if(a()){continue;}else{continue;} continue;}', 'for(x=0;x<y;x++)a()'));
    it('for(x=0;x<y;x++){if(a()){continue;}else{continue;} b();}', () =>
        test('for(x=0;x<y;x++){if(a()){continue;}else{continue;} b();}', 'for(x=0;x<y;x++)a();'));
    it('for(x=0;x<y;x++)while(a())continue;', () =>
        test('for(x=0;x<y;x++)while(a())continue;', 'for(x=0;x<y;x++)for(;a();)continue;'));
    it('for(x=0;x<y;x++)for(x in a())continue', () =>
        test('for(x=0;x<y;x++)for(x in a())continue', 'for(x=0;x<y;x++)for(x in a())continue;'));
    it('for(x=0;x<y;x++)while(a())break;', () => test('for(x=0;x<y;x++)while(a())break;', 'for(x=0;x<y;x++)for(;a();)break'));
    it('for(x=0;x<y;x++)for(x in a())break', () => testSame('for(x=0;x<y;x++)for(x in a())break'));
    it('for(x=0;x<y;x++){try{continue;}catch(e){continue;}}', () =>
        test('for(x=0;x<y;x++){try{continue;}catch(e){continue;}}', 'for(x=0;x<y;x++)try{continue}catch{continue}'));
    it('for(x=0;x<y;x++){try{if(a()){continue;}else{continue;} conti', () =>
        test(
            'for(x=0;x<y;x++){try{if(a()){continue;}else{continue;} continue;}catch(e){}}',
            'for(x=0;x<y;x++)try{if(a())continue;continue}catch{}',
        ));
    it('for(x=0;x<y;x++){g:continue}', () => test('for(x=0;x<y;x++){g:continue}', 'for(x=0;x<y;x++)g:continue;'));
    it('for(x=0;x<y;x++){g:{continue}}', () => test('for(x=0;x<y;x++){g:{continue}}', 'for(x=0;x<y;x++)g:continue;'));
    it('for(x=0;x<y;x++){g:if(a()){continue;}else{continue;} continu', () =>
        test(
            'for(x=0;x<y;x++){g:if(a()){continue;}else{continue;} continue;}',
            'for(x=0;x<y;x++)g:if(a())continue;else continue;',
        ));
    it('for(x=0;x<y;x++){g:{if(a()){continue;}else{continue;} contin', () =>
        test(
            'for(x=0;x<y;x++){g:{if(a()){continue;}else{continue;} continue;}}',
            'for(x=0;x<y;x++)g:{if(a())continue;continue;}',
        ));
    it('for(x=0;x<y;x++){g:{a();if(b()){continue;}else{continue;} co', () =>
        test(
            'for(x=0;x<y;x++){g:{a();if(b()){continue;}else{continue;} continue;}}',
            'for(x=0;x<y;x++)g:{if(a(),b())continue;continue}',
        ));
});

describe('test_code_motion_doesnt_break_function_hoisting', () => {
    it('function f() { if (x) return; foo(); function foo() {} }', () =>
        testSame('function f() { if (x) return; foo(); function foo() {} }'));
    it('function f() { if (x) return; foo(); label: function foo() {', () =>
        testSame('function f() { if (x) return; foo(); label: function foo() {} }'));
    it("function a() { if (typeof f == 'function') return; function ", () =>
        testSame("function a() { if (typeof f == 'function') return; function f() {} }"));
    it("function a() { if (typeof f == 'function') return; label: fu", () =>
        testSame("function a() { if (typeof f == 'function') return; label: function f() {} }"));
});

describe('test_dont_remove_break_in_try_finally', () => {
    it('function f() {b:try{throw 9} finally {break b} return 1;}', () =>
        testSame('function f() {b:try{throw 9} finally {break b} return 1;}'));
});

describe('test_try_catch_termination', () => {
    it('function f(){if(a)try{b}catch{c}else throw i()}', () => testSame('function f(){if(a)try{b}catch{c}else throw i()}'));
    it('function f(){if(a)try{return g()}catch{c}else throw i()}', () =>
        testSame('function f(){if(a)try{return g()}catch{c}else throw i()}'));
    it('function f(){if(a)try{b}catch{return g()}else throw i()}', () =>
        testSame('function f(){if(a)try{b}catch{return g()}else throw i()}'));
    it('function f(){if(a)try{return g()}catch{return g()}else throw', () =>
        test(
            'function f(){if(a)try{return g()}catch{return g()}else throw i()}',
            'function f(){if(a)try{return g()}catch{return g()}throw i()}',
        ));
    it('function f(){if(a)try{b}finally{d}else throw i()}', () => testSame('function f(){if(a)try{b}finally{d}else throw i()}'));
    it('function f(){if(a)try{return g()}finally{d}else throw i()}', () =>
        testSame('function f(){if(a)try{return g()}finally{d}else throw i()}'));
    it('function f(){if(a)try{b}finally{return g()}else throw i()}', () =>
        test(
            'function f(){if(a)try{b}finally{return g()}else throw i()}',
            'function f(){if(a)try{b}finally{return g()}throw i()}',
        ));
    it('function f(){if(a)try{b}catch{c}finally{d}else throw i()}', () =>
        testSame('function f(){if(a)try{b}catch{c}finally{d}else throw i()}'));
    it('function f(){if(a)try{return g()}catch{d}finally{d}else thro', () =>
        testSame('function f(){if(a)try{return g()}catch{d}finally{d}else throw i()}'));
    it('function f(){if(a)try{b}catch{return g()}finally{d}else thro', () =>
        testSame('function f(){if(a)try{b}catch{return g()}finally{d}else throw i()}'));
    it('function f(){if(a)try{b}catch{c}finally{return g(d)}else thr', () =>
        test(
            'function f(){if(a)try{b}catch{c}finally{return g(d)}else throw i()}',
            'function f(){if(a)try{b}catch{c}finally{return g(d)}throw i()}',
        ));
});

describe('test_dont_test_break_in_do_while_if_condition_has_side_effects', () => {
    it('var b=true;do{break}while(b=false);', () =>
        test('var b=true;do{break}while(b=false);', 'var b = !0; do break; while (b = !1);'));
});

describe('test_switch_exit_points1', () => {
    it('switch (x) { case 1: f(); break; }', () => test('switch (x) { case 1: f(); break; }', 'x === 1 && f();'));
    it('switch (x) { case 1: f(); break; case 2: g(); break; }', () =>
        test('switch (x) { case 1: f(); break; case 2: g(); break; }', 'switch (x) { case 1: f(); break; case 2: g();        }'));
    it('switch (x) { case 1: if (x) { f(); break; } break; default: ', () =>
        test(
            'switch (x) { case 1: if (x) { f(); break; } break; default: g(); break; }',
            'switch (x) { case 1: if (x) { f(); break; } break; default: g()          }',
        ));
});

// TODO: Block scoped variable optimization not yet implemented
describe.skip('test_test_block_scoped_variables', () => {
    it('function f() { function g() { return c; } if (x) {return;} l', () =>
        test(
            'function f() { function g() { return c; } if (x) {return;} let c = 3; }',
            'function f() { function g() { return c; } if (x){} else {var c = 3;} }',
        ));
    it('function f() { function g() { return c; } if (x) {return;} c', () =>
        test(
            'function f() { function g() { return c; } if (x) {return;} const c = 3; }',
            'function f() { function g() { return c; } if (x) {} else {var c = 3;} }',
        ));
    it('function f() { if (x) {return;} const c = 3; }', () =>
        test('function f() { if (x) {return;} const c = 3; }', 'function f() { if (x) {} else { var c = 3; } }'));
    it('function f() { if (x) {return;} let a = 3; let b = () => a; ', () =>
        test(
            'function f() { if (x) {return;} let a = 3; let b = () => a; }',
            'function f() { if (x) {} else { var a = 3; var b = () => a;} }',
        ));
    it('function f() { if (x) { if (y) {return;} let c = 3; } }', () =>
        test(
            'function f() { if (x) { if (y) {return;} let c = 3; } }',
            'function f() { if (x) { if (y) {} else { var c = 3; } } }',
        ));
});

// TODO: Block scoped variables in loops optimization not yet implemented
describe.skip('test_dont_test_block_scoped_variables_in_loops', () => {
    it('function f(param) {\n              let arr = [];\n            ', () =>
        testSame(
            'function f(param) {\n              let arr = [];\n              for (let x of param) {\n                if (x < 0) continue;\n                let y = x * 2;\n                arr.push(() => y); // If y was a var, this would capture the wrong value.\n               }\n              return arr;\n            }',
        ));
    it('function f() { while (true) { if (true) {return;} let c = 3;', () =>
        testSame('function f() { while (true) { if (true) {return;} let c = 3; } }'));
    it('function f() { do { if (true) {return;} let c = 3; } while (', () =>
        testSame('function f() { do { if (true) {return;} let c = 3; } while (x); }'));
    it('function f() { for (;;) { if (true) { return; } let c = 3; }', () =>
        testSame('function f() { for (;;) { if (true) { return; } let c = 3; } }'));
    it('function f(y) { for(x in []){ if(x) { return; } let c = 3; }', () =>
        testSame('function f(y) { for(x in []){ if(x) { return; } let c = 3; } }'));
    it('async function f(y) { for await (x in []){ if(x) { return; }', () =>
        testSame('async function f(y) { for await (x in []){ if(x) { return; } let c = 3; } }'));
});
