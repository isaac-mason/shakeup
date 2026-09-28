// Port of oxc_minifier/tests/mangler/mod.rs and its snapshots, plus the unit tests of oxc_mangler's
// `base54.rs` and `keep_names.rs`. oxc mangles without compressing and prints unminified; the expected text
// is parsed and printed the same way, so only names are compared.
import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../../src/analysis/semantic.ts';
import { N, type Node, parse } from '../../src/ast.ts';
import { base54 } from '../../src/mangle/base54.ts';
import { collectNameSymbols, keepNamesAllTrue, type MangleOptionsKeepNames } from '../../src/mangle/keep-names.ts';
import { build, defaultMangleOptions, type MangleOptions } from '../../src/mangle/mangler.ts';
import { printModule } from '../../src/print/print-js.ts';
import { createPrinter, finishPrinter, type PrinterConfig } from '../../src/print/printer.ts';

type SourceType = 'unambiguous' | 'script';

function parseProgram(source: string, sourceType: SourceType): { program: Node; isModule: boolean } {
    const { program, errors } = parse(source, { ts: false, jsx: false, kind: sourceType === 'script' ? 'script' : 'module' });
    if (errors !== undefined && errors.length > 0) throw new Error(`does not parse: ${source}\n${errors.join('\n')}`);
    // `SourceType::mjs().with_unambiguous(true)`: a module only when it has module syntax.
    const isModule =
        sourceType === 'unambiguous' &&
        (program.data as { body: Node[] }).body.some(
            (s) =>
                s.type === N.ImportDeclaration ||
                s.type === N.ExportNamedDeclaration ||
                s.type === N.ExportDefaultDeclaration ||
                s.type === N.ExportAllDeclaration,
        );
    return { program, isModule };
}

function print(program: Node, cfg: PrinterConfig = {}): string {
    const printer = createPrinter({ minify: false }, cfg);
    printModule(printer, program);
    return finishPrinter(printer);
}

function mangleWithSourceType(source: string, options: MangleOptions, sourceType: SourceType): string {
    const { program, isModule } = parseProgram(source, sourceType);
    const { names, classPrivateMappings } = build(options, program, isModule);
    return print(program, {
        nameOf: (node) => (node.sym === 0 ? node.name : (names.get(node.sym) ?? node.name)),
        privateMemberMappings: classPrivateMappings,
    });
}

const mangle = (source: string, options: MangleOptions = defaultMangleOptions()): string =>
    mangleWithSourceType(source, options, 'unambiguous');

const printed = (source: string, sourceType: SourceType = 'unambiguous'): string =>
    print(parseProgram(source, sourceType).program);

function test(source: string, expected: string, options: MangleOptions = defaultMangleOptions()): void {
    expect(mangle(source, options), `for source\n${source}`).toBe(printed(expected));
}

/** A snapshot entry: the case, then oxc's output for it. */
type Snapshot = [source: string, output: string];

function checkSnapshots(cases: Snapshot[], options: MangleOptions, sourceType: SourceType = 'unambiguous'): void {
    for (const [source, output] of cases) {
        expect(mangleWithSourceType(source, options, sourceType), `for source\n${source}`).toBe(printed(output, sourceType));
    }
}

describe('base54', () => {
    it('test_base54', () => {
        expect(base54(0)).toBe('e');
        expect(base54(52)).toBe('Q');
        expect(base54(53)).toBe('$');
        expect(base54(54)).toBe('ee');
        expect(base54(55)).toBe('te');
        expect(base54(4294967295)).toBe('xKrTKr');
    });
});

describe('keep_names', () => {
    function collect(options: MangleOptionsKeepNames, source: string): string[] {
        const { program } = parseProgram(source, 'unambiguous');
        const semantic = createSemantic(true);
        analyze(semantic, program, true);
        const symbols = collectNameSymbols(options, semantic, program);
        const names: string[] = [];
        for (let symbolId = 0; symbolId < symbols.length; symbolId++) {
            if (symbols[symbolId] === 1) names.push(semantic.symbols[symbolId].decl?.name ?? '');
        }
        return names;
    }
    const functionOnly: MangleOptionsKeepNames = { function: true, class: false };
    const classOnly: MangleOptionsKeepNames = { function: false, class: true };

    it('test_declarations', () => {
        expect(collect(functionOnly, 'function foo() {}')).toEqual(['foo']);
        expect(collect(classOnly, 'class Foo {}')).toEqual(['Foo']);
    });

    it('test_simple_declare_init', () => {
        expect(collect(functionOnly, 'var foo = function() {}')).toEqual(['foo']);
        expect(collect(functionOnly, 'var foo = (function() {})')).toEqual(['foo']);
        expect(collect(functionOnly, 'var foo = () => {}')).toEqual(['foo']);
        expect(collect(functionOnly, 'var foo = (() => {})')).toEqual(['foo']);
        expect(collect(classOnly, 'var Foo = class {}')).toEqual(['Foo']);
        expect(collect(classOnly, 'var Foo = (class {})')).toEqual(['Foo']);
    });

    it('test_simple_assign', () => {
        expect(collect(functionOnly, 'var foo; foo = function() {}')).toEqual(['foo']);
        expect(collect(functionOnly, 'var foo; foo = () => {}')).toEqual(['foo']);
        expect(collect(classOnly, 'var Foo; Foo = class {}')).toEqual(['Foo']);

        expect(collect(functionOnly, 'var foo; foo ||= function() {}')).toEqual(['foo']);
        expect(collect(functionOnly, 'var foo = 1; foo &&= function() {}')).toEqual(['foo']);
        expect(collect(functionOnly, 'var foo; foo ??= function() {}')).toEqual(['foo']);
    });

    it('test_default_declarations', () => {
        expect(collect(functionOnly, 'var [foo = function() {}] = []')).toEqual(['foo']);
        expect(collect(functionOnly, 'var [foo = () => {}] = []')).toEqual(['foo']);
        expect(collect(classOnly, 'var [Foo = class {}] = []')).toEqual(['Foo']);
        expect(collect(functionOnly, 'var { foo = function() {} } = {}')).toEqual(['foo']);
    });

    it('test_default_assign', () => {
        expect(collect(functionOnly, 'var foo; [foo = function() {}] = []')).toEqual(['foo']);
        expect(collect(functionOnly, 'var foo; [foo = () => {}] = []')).toEqual(['foo']);
        expect(collect(classOnly, 'var Foo; [Foo = class {}] = []')).toEqual(['Foo']);
        expect(collect(functionOnly, 'var foo; ({ foo = function() {} } = {})')).toEqual(['foo']);
    });

    it('test_for_in_declaration', () => {
        expect(collect(functionOnly, 'for (var foo = function() {} in []) {}')).toEqual(['foo']);
        expect(collect(functionOnly, 'for (var foo = () => {} in []) {}')).toEqual(['foo']);
        expect(collect(classOnly, 'for (var Foo = class {} in []) {}')).toEqual(['Foo']);
    });
});

describe('mangler', () => {
    it('direct_eval', () => {
        const options = defaultMangleOptions();

        // Symbols in scopes with direct eval should NOT be mangled
        expect(mangle("function foo() { let NO_MANGLE; eval('') }", options)).toBe(
            printed('function foo() {\n\tlet NO_MANGLE;\n\teval("");\n}\n'),
        );

        // Nested direct eval: parent scope also should not mangle
        expect(mangle("function foo() { let NO_MANGLE; function bar() { eval('') } }", options)).toBe(
            printed('function foo() {\n\tlet NO_MANGLE;\n\tfunction bar() {\n\t\teval("");\n\t}\n}\n'),
        );

        // Sibling scope without direct eval should be mangled
        let mangled = mangle("function foo() { let NO_MANGLE; eval('') } function bar() { let SHOULD_MANGLE; }", options);
        expect(mangled).toContain('NO_MANGLE');
        expect(mangled).not.toContain('SHOULD_MANGLE');

        // Child function scope without direct eval CAN be mangled
        mangled = mangle("function foo() { eval(''); function bar() { let CAN_MANGLE; } }", options);
        expect(mangled).not.toContain('CAN_MANGLE');

        // Indirect eval should still allow mangling
        mangled = mangle("function foo() { let SHOULD_MANGLE; (0, eval)('') }", options);
        expect(mangled).not.toContain('SHOULD_MANGLE');

        test(
            'var e = () => {}; var foo = (bar) => e(bar); var pt = (() => { eval("") })();',
            'var e = () => {}; var foo = (t) => e(t); var pt = (() => { eval(""); })();',
        );

        test(
            'var e = () => {}; var foo = (bar) => e(bar); var pt = (() => { eval("") })();',
            'var e = () => {}; var foo = (t) => e(t); var pt = (() => { eval(""); })();',
            { ...defaultMangleOptions(), topLevel: true },
        );

        test(
            "function outer() { let e = 1; eval(''); function inner() { let longNameToMangle = 2; console.log(e); } }",
            'function outer() { let e = 1; eval(""); function inner() { let t = 2; console.log(e); } }',
        );

        test(
            "function evalScope() { let x = 1; eval(''); } function siblingScope() { let longName = 2; console.log(longName); }",
            'function evalScope() {let x = 1; eval(""); } function siblingScope() { let e = 2; console.log(e); }',
        );
    });

    it('mangler', () => {
        const cases: Snapshot[] = [
            ['function foo(a) {a}', 'function foo(e) {\n\te;\n}'],
            ['function foo(a) { let _ = { x } }', 'function foo(e) {\n\tlet t = { x };\n}'],
            ['function foo(a) { let { x } = y }', 'function foo(e) {\n\tlet { x: t } = y;\n}'],
            ['var x; function foo(a) { ({ x } = y) }', 'var x;\nfunction foo(e) {\n\t({x} = y);\n}'],
            ["import { x } from 's'; export { x }", 'import { x as e } from "s";\nexport { e as x };'],
            [
                "Object.defineProperty(exports, '__esModule', { value: true })",
                'Object.defineProperty(exports, "__esModule", { value: true });',
            ],
            [
                "var exports = {}; Object.defineProperty(exports, '__esModule', { value: true })",
                'var exports = {};\nObject.defineProperty(exports, "__esModule", { value: true });',
            ],
            [
                "function _(exports) { Object.defineProperty(exports, '__esModule', { value: true }) }",
                'function _(e) {\n\tObject.defineProperty(e, "__esModule", { value: true });\n}',
            ],
            ['function _() { console.log(arguments) }', 'function _() {\n\tconsole.log(arguments);\n}'],
            [
                'function foo(foo_a, foo_b, foo_c) {}; function bar(bar_a, bar_b, bar_c) {}',
                'function foo(e, t, n) {}\n;\nfunction bar(e, t, n) {}',
            ],
            ['function _() { function foo() { var x; foo; } }', 'function _() {\n\tfunction e() {\n\t\tvar t;\n\t\te;\n\t}\n}'],
            [
                'function _() { var x; function foo() { var y; function bar() { x } } }',
                'function _() {\n\tvar e;\n\tfunction t() {\n\t\tvar t;\n\t\tfunction n() {\n\t\t\te;\n\t\t}\n\t}\n}',
            ],
            ['function _() { function x(a) {} }', 'function _() {\n\tfunction e(e) {}\n}'],
            ['function _() { function x(a) { x } }', 'function _() {\n\tfunction e(t) {\n\t\te;\n\t}\n}'],
            ['function _() { var x; { var y }}', 'function _() {\n\tvar e;\n\t{\n\t\tvar t;\n\t}\n}'],
            ['function _() { var x; { let y }}', 'function _() {\n\tvar e;\n\t{\n\t\tlet e;\n\t}\n}'],
            ['function _() { let x; { let y }}', 'function _() {\n\tlet e;\n\t{\n\t\tlet e;\n\t}\n}'],
            ['function _() { var x; { const y = 1 }}', 'function _() {\n\tvar e;\n\t{\n\t\tconst e = 1;\n\t}\n}'],
            ['function _() { let x; { const y = 1 }}', 'function _() {\n\tlet e;\n\t{\n\t\tconst e = 1;\n\t}\n}'],
            ['function _() { var x; { class Y{} }}', 'function _() {\n\tvar e;\n\t{\n\t\tclass e {}\n\t}\n}'],
            ['function _() { let x; { class Y{} }}', 'function _() {\n\tlet e;\n\t{\n\t\tclass e {}\n\t}\n}'],
            [
                'function _() { var x; try { throw 0 } catch (e) { e } }',
                'function _() {\n\tvar e;\n\ttry {\n\t\tthrow 0;\n\t} catch (e) {\n\t\te;\n\t}\n}',
            ],
            [
                'function _() { var x; try { throw 0 } catch (e) { var e } }',
                'function _() {\n\tvar e;\n\ttry {\n\t\tthrow 0;\n\t} catch (t) {\n\t\tvar t;\n\t}\n}',
            ],
            [
                'function _() { var x; try { throw 0 } catch { var e } }',
                'function _() {\n\tvar e;\n\ttry {\n\t\tthrow 0;\n\t} catch {\n\t\tvar t;\n\t}\n}',
            ],
            ['function _() { var x; var y; }', 'function _() {\n\tvar e;\n\tvar t;\n}'],
            ['function _() { var x; let y; }', 'function _() {\n\tvar e;\n\tlet t;\n}'],
            ['function _() { { var x; var y; } }', 'function _() {\n\t{\n\t\tvar e;\n\t\tvar t;\n\t}\n}'],
            ['function _() { { var x; let y; } }', 'function _() {\n\t{\n\t\tvar e;\n\t\tlet t;\n\t}\n}'],
            [
                'function _() { let a; { let b; { let c; { let d; var x; } } } }',
                'function _() {\n\tlet e;\n\t{\n\t\tlet e;\n\t\t{\n\t\t\tlet e;\n\t\t\t{\n\t\t\t\tlet e;\n\t\t\t\tvar t;\n\t\t\t}\n\t\t}\n\t}\n}',
            ],
            [
                'function _() { let a; { let b; { let c; { console.log(a); let d; var x; } } } }',
                'function _() {\n\tlet e;\n\t{\n\t\tlet n;\n\t\t{\n\t\t\tlet n;\n\t\t\t{\n\t\t\t\tconsole.log(e);\n\t\t\t\tlet n;\n\t\t\t\tvar t;\n\t\t\t}\n\t\t}\n\t}\n}',
            ],
            [
                'function _() {\n          if (bar) var a = 0;\n          else {\n            let b = 0;\n            var a = 1;\n          }\n        }',
                'function _() {\n\tif (bar) var e = 0;\n\telse {\n\t\tlet t = 0;\n\t\tvar e = 1;\n\t}\n}',
            ],
        ];
        const topLevelCases: Snapshot[] = [
            ['function foo(a) {a}', 'function e(e) {\n\te;\n}'],
            ['export function foo() {}; foo()', 'export function foo() {}\n;\nfoo();'],
            ['export default function foo() {}; foo()', 'export default function e() {}\n;\ne();'],
            ['export const foo = 1; foo', 'export const foo = 1;\nfoo;'],
            ['const foo = 1; foo; export { foo }', 'const e = 1;\ne;\nexport { e as foo };'],
        ];
        const keepNameCases: Snapshot[] = [
            ['function _() { function foo() { var x } }', 'function _() {\n\tfunction foo() {\n\t\tvar e;\n\t}\n}'],
            ['function _() { var foo = function() { var x } }', 'function _() {\n\tvar foo = function() {\n\t\tvar e;\n\t};\n}'],
            ['function _() { var foo = () => { var x } }', 'function _() {\n\tvar foo = () => {\n\t\tvar e;\n\t};\n}'],
            [
                'function _() { class Foo { foo() { var x } } }',
                'function _() {\n\tclass Foo {\n\t\tfoo() {\n\t\t\tvar e;\n\t\t}\n\t}\n}',
            ],
            [
                'function _() { var Foo = class { foo() { var x } } }',
                'function _() {\n\tvar Foo = class {\n\t\tfoo() {\n\t\t\tvar e;\n\t\t}\n\t};\n}',
            ],
        ];
        checkSnapshots(cases, defaultMangleOptions());
        checkSnapshots(topLevelCases, { ...defaultMangleOptions(), topLevel: true });
        checkSnapshots(keepNameCases, { ...defaultMangleOptions(), keepNames: keepNamesAllTrue() });
    });

    it('private_member_mangling', () => {
        const cases: Snapshot[] = [
            [
                'class Foo { #privateField = 1; method() { return this.#privateField; } }',
                'class Foo {\n\t#e = 1;\n\tmethod() {\n\t\treturn this.#e;\n\t}\n}',
            ],
            [
                'class Foo { #a = 1; #b = 2; method() { return this.#a + this.#b; } }',
                'class Foo {\n\t#e = 1;\n\t#t = 2;\n\tmethod() {\n\t\treturn this.#e + this.#t;\n\t}\n}',
            ],
            [
                'class Foo { #method() { return 1; } publicMethod() { return this.#method(); } }',
                'class Foo {\n\t#e() {\n\t\treturn 1;\n\t}\n\tpublicMethod() {\n\t\treturn this.#e();\n\t}\n}',
            ],
            [
                'class Foo { #field; #method() { return this.#field; } get() { return this.#method(); } }',
                'class Foo {\n\t#e;\n\t#t() {\n\t\treturn this.#e;\n\t}\n\tget() {\n\t\treturn this.#t();\n\t}\n}',
            ],
            [
                'class Foo { #x; check() { return #x in this; } }',
                'class Foo {\n\t#e;\n\tcheck() {\n\t\treturn #e in this;\n\t}\n}',
            ],
            [
                'class Outer { #outerField = 1; inner() { return class Inner { #innerField = 2; get() { return this.#innerField; } }; } }',
                'class Outer {\n\t#e = 1;\n\tinner() {\n\t\treturn class e {\n\t\t\t#t = 2;\n\t\t\tget() {\n\t\t\t\treturn this.#t;\n\t\t\t}\n\t\t};\n\t}\n}',
            ],
            [
                'class Outer { #shared = 1; getInner() { let self = this; return class { method() { return self.#shared; } }; } }',
                'class Outer {\n\t#e = 1;\n\tgetInner() {\n\t\tlet e = this;\n\t\treturn class {\n\t\t\tmethod() {\n\t\t\t\treturn e.#e;\n\t\t\t}\n\t\t};\n\t}\n}',
            ],
            [
                'class Outer { #shared = 1; getInner() { return class { #shared = 2; method() { return this.#shared; } }; } }',
                'class Outer {\n\t#e = 1;\n\tgetInner() {\n\t\treturn class {\n\t\t\t#t = 2;\n\t\t\tmethod() {\n\t\t\t\treturn this.#t;\n\t\t\t}\n\t\t};\n\t}\n}',
            ],
            [
                'class Foo { publicField = 1; #privateField = 2; getSum() { return this.publicField + this.#privateField; } }',
                'class Foo {\n\tpublicField = 1;\n\t#e = 2;\n\tgetSum() {\n\t\treturn this.publicField + this.#e;\n\t}\n}',
            ],
            [
                'class A { #field = 1; #method() { return this.#field; } } class B { #field = 2; #method() { return this.#field; } }',
                'class A {\n\t#e = 1;\n\t#t() {\n\t\treturn this.#e;\n\t}\n}\nclass B {\n\t#e = 2;\n\t#t() {\n\t\treturn this.#e;\n\t}\n}',
            ],
            [
                'class A { #field = 1; #method() { return this.#field; } } class B { #field2 = 2; #method2() { return this.#field2; } }',
                'class A {\n\t#e = 1;\n\t#t() {\n\t\treturn this.#e;\n\t}\n}\nclass B {\n\t#e = 2;\n\t#t() {\n\t\treturn this.#e;\n\t}\n}',
            ],
            [
                'class Outer { #shared = 1; #getInner() { return class { #method() { return this.#shared; } }; } }',
                'class Outer {\n\t#e = 1;\n\t#t() {\n\t\treturn class {\n\t\t\t#n() {\n\t\t\t\treturn this.#e;\n\t\t\t}\n\t\t};\n\t}\n}',
            ],
        ];
        checkSnapshots(cases, defaultMangleOptions());
    });

    it('function_expression_name_shadowed', () => {
        // `var` shadow.
        test(
            'function _() { var x; var f = function foo() { var foo = x; } }',
            'function _() { var e; var t = function t() { var t = e; } }',
        );
        // Parameter shadow.
        test(
            'function _() { var x; (function foo(foo) { foo + x })() }',
            'function _() { var e; (function t(t) { t + e; })(); }',
        );
        // `var` inside an `else` block, still hoisting through the block scope to the fn-expr scope.
        test(
            'function _() { var x; var f = function foo() { if (x) {} else { var foo = x; } } }',
            'function _() { var e; var t = function t() { if (e) {} else { var t = e; } } }',
        );
    });

    it('shadowed_fn_expr_mangle_is_idempotent', () => {
        const cases = [
            'function _() { var x; var f = function foo() { var foo = x; } }',
            `
        (function() {
            var a = 1;
            var b = function foo() { var foo = a; };
            var c = function bar() { var bar = a; };
        })();
        `,
        ];
        for (const source of cases) {
            const pass1 = mangle(source);
            expect(mangle(pass1), `idempotency for\n${source}`).toBe(pass1);
        }
    });

    it('destructured_exports_keep_names', () => {
        test(
            "import syntax from 's';\n export const { tokenize, parse, find } = syntax;",
            "import e from 's';\n export const { tokenize, parse, find } = e;",
        );
        test(
            "import syntax from 's';\n export const [first, second, ...rest] = syntax;",
            "import e from 's';\n export const [first, second, ...rest] = e;",
        );
        test(
            "import syntax from 's';\n export const { a: renamed, b: { nested = 1 } } = syntax;",
            "import e from 's';\n export const { a: renamed, b: { nested = 1 } } = e;",
        );
    });

    it('reserved_names', () => {
        const options: MangleOptions = { ...defaultMangleOptions(), reserved: new Set(['exports', 'module']) };

        // UMD factory parameter named `exports`.
        test(
            `(function (global, factory) {
             typeof exports === 'object' && typeof module !== 'undefined'
                 ? factory(exports)
                 : factory((global.lib = {}));
         })(this, function (exports) {
             function queue(worker) { return worker; }
             exports.queue = queue;
         });`,
            `(function (e, t) {
             typeof exports === 'object' && typeof module !== 'undefined'
                 ? t(exports)
                 : t((e.lib = {}));
         })(this, function (exports) {
             function t(e) { return e; }
             exports.queue = t;
         });`,
            options,
        );

        // CommonJS wrapper parameters named `module` and `exports`.
        test(
            `(function (module, exports) {
             function helper(value) { return value; }
             module.exports.helper = helper;
             exports.other = helper;
         })(m, m.exports);`,
            `(function (module, exports) {
             function t(e) { return e; }
             module.exports.helper = t;
             exports.other = t;
         })(m, m.exports);`,
            options,
        );

        // Off by default: `exports` is renamed like any other binding.
        test(
            `(function (factory) { factory(exports); })(function (exports) {
             function queue(worker) { return worker; }
             exports.queue = queue;
         });`,
            `(function (e) { e(exports); })(function (e) {
             function t(e) { return e; }
             e.queue = t;
         });`,
        );
    });

    it('annex_b_block_scoped_function', () => {
        const cases: Snapshot[] = [
            [
                'function _() { var x = 1; if (true) { function y() {} } use(x); }',
                'function _() {\n\tvar e = 1;\n\tif (true) {\n\t\tfunction t() {}\n\t}\n\tuse(e);\n}',
            ],
            [
                'function _() { var x = 1; try { function y() {} } finally {} use(x); }',
                'function _() {\n\tvar e = 1;\n\ttry {\n\t\tfunction t() {}\n\t} finally {}\n\tuse(e);\n}',
            ],
            [
                'function _() { var x = 1; { function y() {} } use(x); }',
                'function _() {\n\tvar e = 1;\n\t{\n\t\tfunction t() {}\n\t}\n\tuse(e);\n}',
            ],
            [
                'function _(x) { if (true) { function y() {} } use(x); }',
                'function _(e) {\n\tif (true) {\n\t\tfunction t() {}\n\t}\n\tuse(e);\n}',
            ],
            [
                'function _() { var x = 1; { { if (true) { function y() {} } } } use(x); }',
                'function _() {\n\tvar e = 1;\n\t{\n\t\t{\n\t\t\tif (true) {\n\t\t\t\tfunction t() {}\n\t\t\t}\n\t\t}\n\t}\n\tuse(e);\n}',
            ],
            [
                'function _() { var x = 1; if (true) { function y() {} function z() {} } use(x); }',
                'function _() {\n\tvar e = 1;\n\tif (true) {\n\t\tfunction t() {}\n\t\tfunction n() {}\n\t}\n\tuse(e);\n}',
            ],
            [
                'function _() { var x = 1; if (true) { function y() { return x; } } use(x); }',
                'function _() {\n\tvar e = 1;\n\tif (true) {\n\t\tfunction t() {\n\t\t\treturn e;\n\t\t}\n\t}\n\tuse(e);\n}',
            ],
            [
                'function _() { function foo() { var x; use(x); } function bar() { if (true) { function baz() {} use(baz); } } }',
                'function _() {\n\tfunction e() {\n\t\tvar e;\n\t\tuse(e);\n\t}\n\tfunction t() {\n\t\tif (true) {\n\t\t\tfunction e() {}\n\t\t\tuse(e);\n\t\t}\n\t}\n}',
            ],
            [
                'console.log(typeof foo); if (true) { function foo() { return 1; } }',
                'console.log(typeof foo);\nif (true) {\n\tfunction foo() {\n\t\treturn 1;\n\t}\n}',
            ],
        ];
        checkSnapshots(cases, defaultMangleOptions(), 'script');
    });
});
