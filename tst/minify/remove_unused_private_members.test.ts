// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are JS source under test.
// Ported from oxc_minifier/tests/peephole/remove_unused_private_members.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { test, testSame } from './harness.ts';

describe('test_remove_unused_private_fields', () => {
    it('class C { #unused = 1; #used = 2; method() { return this.#used; } } new C();', () =>
        test(
            'class C { #unused = 1; #used = 2; method() { return this.#used; } } new C();',
            'class C { #used = 2; method() { return this.#used; } } new C();',
        ));
    it('class C { #unused = 1; #used = 2; method(foo) { return #used in foo; } } new C();', () =>
        test(
            'class C { #unused = 1; #used = 2; method(foo) { return #used in foo; } } new C();',
            'class C { #used = 2; method(foo) { return #used in foo; } } new C();',
        ));
    it('class C { #unused; #used; method() { return this.#used; } } new C();', () =>
        test(
            'class C { #unused; #used; method() { return this.#used; } } new C();',
            'class C { #used; method() { return this.#used; } } new C();',
        ));
    it('class C { #a = 1; #b = 2; #c = 3; } new C();', () =>
        test('class C { #a = 1; #b = 2; #c = 3; } new C();', 'class C { } new C();'));
    it('class C { static #unused = 1; static #used = 2; static method() { return C.#used; } }', () =>
        test(
            'class C { static #unused = 1; static #used = 2; static method() { return C.#used; } }',
            'class C { static #used = 2; static method() { return C.#used; } }',
        ));
    it('class C { public = 1; #unused = 2; #used = 3; method() { return this.public + this.#used; } } new C(', () =>
        test(
            'class C { public = 1; #unused = 2; #used = 3; method() { return this.public + this.#used; } } new C();',
            'class C { public = 1; #used = 3; method() { return this.public + this.#used; } } new C();',
        ));
    it('class C { #unused = foo(); method() { return 1; } } new C();', () =>
        testSame('class C { #unused = foo(); method() { return 1; } } new C();'));
    it("class C { #used = 1; method() { return eval('this.#used'); } } new C();", () =>
        testSame("class C { #used = 1; method() { return eval('this.#used'); } } new C();"));
});

describe('test_remove_unused_private_methods', () => {
    it('class C { #unusedMethod() { return 1; } #usedMethod() { return 2; } method() { return this.#usedMeth', () =>
        test(
            'class C { #unusedMethod() { return 1; } #usedMethod() { return 2; } method() { return this.#usedMethod(); } } new C();',
            'class C { #usedMethod() { return 2; } method() { return this.#usedMethod(); } } new C();',
        ));
    it('class C { #a() {} #b() {} #c() {} } new C();', () =>
        test('class C { #a() {} #b() {} #c() {} } new C();', 'class C { } new C();'));
    it('class C { static #unusedMethod() { return 1; } static #usedMethod() { return 2; } static method() { ', () =>
        test(
            'class C { static #unusedMethod() { return 1; } static #usedMethod() { return 2; } static method() { return C.#usedMethod(); } }',
            'class C { static #usedMethod() { return 2; } static method() { return C.#usedMethod(); } }',
        ));
    it('class C { #helper() { return 1; } method() { return this.#helper(); } } new C();', () =>
        testSame('class C { #helper() { return 1; } method() { return this.#helper(); } } new C();'));
    it("class C { #helper() { return 1; } method() { return eval('this.#helper()'); } } new C();", () =>
        testSame("class C { #helper() { return 1; } method() { return eval('this.#helper()'); } } new C();"));
});

describe('test_remove_unused_private_accessors', () => {
    it('class C { accessor #unused = 1; accessor #used = 2; method() { return this.#used; } } new C();', () =>
        test(
            'class C { accessor #unused = 1; accessor #used = 2; method() { return this.#used; } } new C();',
            'class C { accessor #used = 2; method() { return this.#used; } } new C();',
        ));
    it('class C { accessor #unused = foo(); method() { return 1; } } new C();', () =>
        testSame('class C { accessor #unused = foo(); method() { return 1; } } new C();'));
});

describe('test_nested_classes', () => {
    it('class Outer { #shared = 1; #unusedOuter = 2; method() { return this.#shared; } getInner() { return c', () =>
        test(
            'class Outer {\n            #shared = 1;\n            #unusedOuter = 2;\n\n            method() {\n                return this.#shared;\n            }\n\n            getInner() {\n                return class Inner {\n                    #shared = 3;\n                    #unusedInner = 4;\n\n                    method() {\n                        return this.#shared;\n                    }\n                };\n            }\n        } new Outer();',
            'class Outer {\n            #shared = 1;\n\n            method() {\n                return this.#shared;\n            }\n\n            getInner() {\n                return class {\n                    #shared = 3;\n\n                    method() {\n                        return this.#shared;\n                    }\n                };\n            }\n        } new Outer();',
        ));
    it('class Outer { #shared = 1; getInner() { let self = this; return class { method() { return self.#shar', () =>
        testSame(
            'class Outer {\n            #shared = 1;\n\n            getInner() {\n                let self = this;\n                return class {\n                    method() {\n                        return self.#shared;\n                    }\n                };\n            }\n        } new Outer();',
        ));
});
