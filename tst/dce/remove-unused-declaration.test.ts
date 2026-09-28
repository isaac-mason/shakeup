import { describe, expect, it } from 'vitest';
import { verifyRefFacts } from '../../src/analysis/ref-facts.ts';
import { analyze, createSemantic } from '../../src/analysis/semantic.ts';
import { type Node, parse } from '../../src/ast.ts';
import { eliminateDeadCode } from '../../src/passes/dce/compressor.ts';
import { type CompressOptions, dceOptions } from '../../src/passes/dce/options.ts';
import type { SourceType } from '../../src/passes/dce/state.ts';
import { printModule } from '../../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../../src/print/printer.ts';

// Ports of oxc's tests for remove_unused_declaration.rs, run through the tree-shake-only compressor
// (`CompressOptions::dce()`, as `tests/peephole/dead_code_elimination.rs` runs it). Cases oxc runs
// with `CompressOptions::smallest()` keep their input; the expected output is the tree-shake result.

function parseProgram(source: string, sourceType: SourceType): Node {
    return parse(source, { ts: false, jsx: false, kind: sourceType }).program;
}

function print(program: Node): string {
    const printer = createPrinter({ minify: false });
    printModule(printer, program);
    return finishPrinter(printer).trim();
}

function run(source: string, sourceType: SourceType, options: CompressOptions): { code: string; iterations: number } {
    const program = parseProgram(source, sourceType);
    const semantic = createSemantic();
    analyze(semantic, program, sourceType === 'module');
    const { iterations } = eliminateDeadCode(program, semantic, options, sourceType, new Set(), true);
    expect(verifyRefFacts(semantic, program)).toEqual([]);
    return { code: print(program), iterations };
}

/** oxc `test_with_options_source_type`: compare with the printed expected source, then check idempotency. */
function test(
    source: string,
    expected: string,
    sourceType: SourceType = 'module',
    options: CompressOptions = dceOptions(),
): number {
    const first = run(source, sourceType, options);
    expect(first.code).toBe(print(parseProgram(expected, sourceType)));
    expect(run(first.code, sourceType, options).code).toBe(first.code);
    return first.iterations;
}

const testSame = (source: string, sourceType: SourceType = 'module', options: CompressOptions = dceOptions()): void => {
    test(source, source, sourceType, options);
};

const keepUnused = (): CompressOptions => ({ ...dceOptions(), unused: 'keep' });

const invalidImportSideEffects = (): CompressOptions => ({
    ...dceOptions(),
    treeshake: { ...dceOptions().treeshake, invalidImportSideEffects: true },
});

describe('remove_unused_function_declaration', () => {
    it('removes an unreferenced function declaration', () => {
        test('function foo() {}', '');
        testSame('function foo() { bar } foo()');
        testSame('export function foo() {} foo()');
        testSame("function foo() { bar } eval('foo()')");
    });

    it('removes an unused local function', () => {
        test('function f() { function inner() {} return 1; } console.log(f());', 'function f() { return 1; } console.log(f());');
    });

    it('keeps functions in the Script root', () => {
        testSame('function foo() {}', 'script');
        test('function outer() { function foo() {} return 1 } outer()', 'function outer() { return 1 } outer()', 'script');
    });

    it('keeps everything with unused: keep', () => {
        // keep_recursive_function_with_unused_keep_option
        testSame('function f() { f() }', 'module', keepUnused());
        testSame('function f() { f() }', 'commonjs', keepUnused());
        testSame('function outer() { function f() { f() } }', 'script', keepUnused());
    });
});

describe('recursive function removal', () => {
    it('removes dead recursive cycles', () => {
        // dce_recursive_unused_functions / remove_recursive_unused_function_declaration
        test('function f() { f() }', '');
        test('function c() { d() } function d() { c() }', '');
        test('function f() { console.log(1); f() }', '');
        test('function f() { return f }', '');
        test('function f() { g(f) }', '');
    });

    it('finds owners through nested scopes of every kind', () => {
        // remove_recursive_functions_through_nested_scope_kinds
        test('function a(p = b) { { return () => function () { return class { m() { b() } } } } } function b() { a() }', '');
        // remove_recursive_unused_nested_in_live_function
        test('function live() { function inner() { inner() } return 1; } g(live());', 'function live() { return 1; } g(live());');
    });

    it('keeps cycles with live references', () => {
        // keep_recursive_functions_referenced_outside_registered_functions
        testSame('function a() { b() } function b() { a() } use(() => a, function () { b() }, class { m() { a() } });');
        // keep_recursive_function_with_live_references
        testSame('function f() { f() } console.log(f);');
        testSame('function f() { f() } f = null;');
        testSame("function o() { function f() { f() } eval('x') } o();");
        testSame("eval('x'); function f() { f() }");
        // dce_recursive_unused_functions
        testSame('class A { m() { new B(); } } class B { m() { new A(); } }');
    });

    it('keeps exported and otherwise observable functions', () => {
        // module_export_observability_kinds
        testSame('export function f() { f(); }');
        testSame('function f() { f(); } export { f };');
        testSame('export default function f() { f(); }');
        testSame('function f() { f(); } export default f;');
        // export_observability_ignores_declarations_inside_exported_arrow
        test(
            'export default () => { function nested() {} nested(); }; function dead1() { dead2() } function dead2() { dead1() }',
            'export default () => {};',
        );
    });

    it('analyzes CommonJS and Script local functions', () => {
        // dce_recursive_unused_functions_in_commonjs_and_script / analyze_commonjs_and_script_local_functions
        test("function c() { d() } function d() { c() } console.log('k');", "console.log('k');", 'commonjs');
        test(
            'function outer() { function c() { d() } function d() { c() } return 1 }',
            'function outer() { return 1 }',
            'script',
        );
        testSame('function f() { f() }', 'script');
        testSame('function f() { f() } module.exports = f;', 'commonjs');
        testSame('function f() { f() } exports.f = f;', 'commonjs');
        // keep_non_module_recursive_functions_reachable_by_eval
        testSame("eval('f()'); function f() { f() }", 'commonjs');
        testSame("function outer() { eval('f()'); function f() { f() } }", 'script');
    });

    it('keeps sloppy duplicate block functions', () => {
        // dce_keeps_sloppy_duplicate_block_functions
        const source = '{ function f() { return 1 } } { function f() { return f } } console.log(typeof f());';
        testSame(source, 'script');
        testSame(source, 'commonjs');
    });

    it('keeps Script-global functions but removes their local dead cycles', () => {
        // keep_commonjs_references_and_script_global_functions
        testSame('{ function f() { f() } }', 'script');
        test(
            'function f() {} function outer() { function d1() { console.log(f); d2() } function d2() { d1() } return 1 } f.x = 1;',
            'function f() {} function outer() { return 1 } f.x = 1;',
            'script',
        );
    });
});

describe('remove_unused_class_declaration', () => {
    it('removes an unused class, keeping what its evaluation runs', () => {
        test('class C {}', '');
        testSame('export class C {}');
        testSame("class C {} eval('C')");
        test('class C extends Foo {}', 'Foo;');
        test('class C { static {} }', '');
        testSame('class C { static { foo } }');
        test('class C { foo() {} }', '');
        test('class C { [foo]() {} }', 'foo;');
        test('class C { static foo() {} }', '');
        test('class C { static [foo]() {} }', 'foo;');
        test('class C { [1]() {} }', '');
        test('class C { foo = bar }', '');
        test('class C { foo = 1 }', '');
        testSame('class C { static foo = bar }');
        testSame('class C { static foo = this.bar = {} }');
        test('class C { static foo = 1 }', '');
        test('class C { [foo] = bar }', 'foo;');
        testSame('class C { static [foo] = bar }');
        test('class C { static [foo] = 1 }', 'foo;');
        test('class _ extends A { [B] = C; [D]() {} }', 'A, B, D;');
        testSame('class C extends (() => {}) {}');
    });

    it('removes an unused local class', () => {
        test('function f() { class C {} return 1; } console.log(f());', 'function f() { return 1; } console.log(f());');
    });

    it('keeps classes in the Script root', () => {
        // keep_in_script_mode
        testSame('class C {}', 'script');
        test('class C {}', '', 'commonjs');
    });
});

describe('remove_unused_import_specifiers', () => {
    it('drops unused specifiers and keeps the side-effect import', () => {
        test("import a from 'a'", "import 'a';");
        test("import a from 'a'; foo()", "import 'a'; foo();");
        testSame("import a from 'a'", 'module', invalidImportSideEffects());
        test("import { a } from 'a'", "import 'a';");
        test("import { a, b } from 'a'", "import 'a';");
        test("import * as a from 'a'", "import 'a';");
        test("import a, { b } from 'a'", "import 'a';");
        test("import a, * as b from 'a'", "import 'a';");
        testSame("import a from 'a'; foo(a);");
        testSame("import { a } from 'a'; foo(a);");
        testSame("import * as a from 'a'; foo(a);");
        testSame("import a, { b } from 'a'; foo(a, b);");
        test("import { a, b } from 'a'; foo(a);", "import { a } from 'a'; foo(a);");
        test("import { a, b, c } from 'a'; foo(b);", "import { b } from 'a'; foo(b);");
        test("import a, { b } from 'a'; foo(a);", "import a from 'a'; foo(a);");
        test("import a, { b } from 'a'; foo(b);", "import { b } from 'a'; foo(b);");
        testSame("import 'a';");
        test("import {} from 'a'", "import 'a';");
        test("import a from 'a' with { type: 'json' }", "import 'a' with { type: 'json' };");
        test("import {} from 'a' with { type: 'json' }", "import 'a' with { type: 'json' };");
        test("import { a as b } from 'a'", "import 'a';");
        testSame("import { a as b } from 'a'; foo(b);");
        testSame("import { a } from 'a'; export { a };");
    });

    it('drops specifiers only referenced from dead code', () => {
        test("import a from 'a'; import { b } from 'b'; if (false) { console.log(b) }", "import 'a'; import 'b';");
    });

    it('keeps imports when direct eval is present', () => {
        testSame("import { a } from 'a'; eval('a');");
        testSame("import a from 'a'; eval('a');");
        testSame("import * as a from 'a'; eval('a');");
        testSame("import { a } from 'a'; function f() { eval('a'); }");
    });

    it('removes unused phase imports whole', () => {
        // remove_unused_import_source_statement / remove_unused_import_defer_statements
        test("import source a from 'a'", '');
        testSame("import source a from 'a'; foo(a);");
        testSame("import source a from 'a'", 'module', invalidImportSideEffects());
        test("import defer * as a from 'a'", '');
        testSame("import defer * as a from 'a'; foo(a);");
        testSame("import defer * as a from 'a'; foo(a.bar);");
        testSame("import defer * as a from 'a'", 'module', invalidImportSideEffects());
    });
});

describe('unused declarator removal (should_remove_unused_declarator)', () => {
    it('removes unused declarators', () => {
        // remove_unused_variable_declaration, in tree-shake mode
        test('var x', '');
        test('var x = 1', '');
        test('var [] = []', '');
        test('var [] = [1]', '');
        test("var [] = 'foo'", '');
        testSame('export var f = () => { var [] = arguments }');
        test('export function f() { var [] = arguments }', 'export function f() { arguments; }');
        testSame('globalThis.f = function () { var [] = arguments }', 'commonjs');
        testSame('var [] = arguments');
        testSame('var [] = null');
        testSame('var [] = void 0');
        testSame('var [] = 1');
        testSame('var [] = a');
        test('var {} = {}', '');
        test('var {} = { a: 1 }', '');
        testSame('var {} = null');
        testSame('var {} = a');
        testSame('var {} = void 0');
        testSame('var x; foo(x)');
        testSame('export var x');
        testSame('using x = foo');
        testSame('await using x = foo');
    });

    it('removes self-recursive function-valued declarators', () => {
        // dce_recursive_unused_functions / remove_self_recursive_function_valued_declarators
        test('var f = function() { f() }', '');
        test('const f = () => f()', '');
        test('let f = function(value = f()) {};', '');
        test('let f = (value = f()) => value;', '');
        test('var f = function() { f() }', '', 'commonjs');
        test('function outer() { const f = () => f(); return 1 }', 'function outer() { return 1 }', 'script');
        // keep_reachable_self_recursive_function_valued_declarators
        testSame('const f = function() { f() }; use(f);');
        testSame('let f = () => f(); f = other;');
        testSame('export const f = () => f();');
        testSame('var f = () => f()', 'script');
        // Declarator cycles are not graph candidates.
        testSame('const a = () => b(); const b = () => a();');
    });

    it('converges a function and var redeclaration on the count pass', () => {
        // recursive_function_var_redeclaration_converges_on_count_pass
        expect(test('function f() { f() } var f;', '')).toBe(2);
        // A capped run removes the function but still sees its body reference, so it keeps `var f`.
        const capped = run('function f() { f() } var f;', 'module', { ...dceOptions(), maxIterations: 0 });
        expect(capped).toEqual({ code: print(parseProgram('var f;', 'module')), iterations: 0 });
    });

    it('drops a cycle whose only outside reference is dead code', () => {
        // dce_recursive_unused_functions / dropped_direct_eval_converges_after_liveness_refresh
        test('if (false) c(); function c() { d() } function d() { c() }', '');
        expect(test("if (false) eval('x'); function f() { f() }", '')).toBe(2);
        test('if (false) g(); function g() { f() } function f() { f() }', '', 'commonjs');
        test(
            "function outer() { if (false) eval('x'); function f() { f() } return 1 }",
            'function outer() { return 1 }',
            'script',
        );
    });

    it('keeps observable bindings a dead cycle held the last read of', () => {
        // dce_recursive_unused_functions
        test(
            'export var f; var f = 0; function d1() { console.log(f); d2() } function d2() { d1() } f = 1;',
            'export var f; var f = 0; f = 1;',
        );
        test(
            'var f = 1; function d1() { f; d2() } function d2() { d1() } if (false) for (var f of xs) {} export {};',
            'export {};',
        );
    });
});
