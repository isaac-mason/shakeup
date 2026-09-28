// oxc's own may_have_side_effects tests: `oxc_minifier/tests/ecmascript/may_have_side_effects.rs` and
// `may_have_side_effects_statements.rs`, with oxc's test context (globals by name, annotations on,
// property reads and unknown globals side-effectful).

import { describe, expect, it } from 'vitest';
import {
    assignmentTargetMayHaveSideEffects,
    type EngineTargets,
    type EsFeature,
    isPureFunction,
    mayHaveSideEffects,
    type PropertyReadSideEffects,
    type SideEffectsContext,
} from '../src/analysis/side-effects.ts';
import { N, type Node } from '../src/ast/index.ts';
import { parseWithDiagnostics } from '../src/parser/index.ts';

/** `javascript_globals::GLOBALS_BUILTIN` plus `arguments` and `URL`, the globals of oxc's test context. */
const BUILTIN_GLOBALS = `
    AggregateError Array ArrayBuffer AsyncDisposableStack Atomics BigInt BigInt64Array BigUint64Array
    Boolean DataView Date decodeURI decodeURIComponent DisposableStack encodeURI encodeURIComponent
    Error escape eval EvalError FinalizationRegistry Float16Array Float32Array Float64Array Function
    globalThis Infinity Int16Array Int32Array Int8Array isFinite isNaN Iterator JSON Map Math NaN
    Number Object parseFloat parseInt Promise Proxy RangeError ReferenceError Reflect RegExp Set
    SharedArrayBuffer String SuppressedError Symbol SyntaxError TypeError Uint16Array Uint32Array
    Uint8Array Uint8ClampedArray undefined unescape URIError WeakMap WeakRef WeakSet
    arguments URL
`
    .split(/\s+/)
    .filter((name) => name !== '');

type ContextOptions = {
    globals?: readonly string[];
    annotations?: boolean;
    pureFunctions?: readonly string[];
    propertyReadSideEffects?: PropertyReadSideEffects;
    propertyWriteSideEffects?: boolean;
    unknownGlobalSideEffects?: boolean;
    target?: EngineTargets | null;
};

function context(options: ContextOptions = {}): SideEffectsContext {
    const globals = new Set(options.globals ?? BUILTIN_GLOBALS);
    const pureFunctions = options.pureFunctions ?? [];
    return {
        isGlobalReference: (ident) => globals.has(ident.name),
        constantValueForReference: () => null,
        valueTypeForReference: () => null,
        engineTargets: options.target ?? null,
        annotations: options.annotations ?? true,
        manualPureFunctions: (callee) => isPureFunction(callee, pureFunctions),
        propertyReadSideEffects: options.propertyReadSideEffects ?? 'all',
        propertyWriteSideEffects: options.propertyWriteSideEffects ?? true,
        unknownGlobalSideEffects: options.unknownGlobalSideEffects ?? true,
    };
}

/** `EngineTargets::from_target("esXXXX")`: each queried feature is named for the edition that added it. */
function esTarget(edition: number): EngineTargets {
    return { supportsEsFeature: (feature: EsFeature) => Number(feature.slice(2, 6)) <= edition };
}
const ESNEXT = 9999;

function parseBody(source: string, ts = false): Node[] {
    const result = parseWithDiagnostics(source, { ts, jsx: false });
    if (result.errors.length > 0) throw new Error(`${source}: ${result.errors[0].msg}`);
    return result.program.data.body;
}

function firstExpression(source: string, ts = false): Node {
    const statement = parseBody(source, ts)[0];
    if (statement === undefined || statement.type !== N.ExpressionStatement) {
        throw new Error(`should have an expression statement body: ${source}`);
    }
    return statement.data.expression;
}

function firstStatementInFunction(source: string): Node {
    const declaration = parseBody(source)[0];
    if (declaration === undefined || declaration.type !== N.FunctionDeclaration || declaration.data.body === null) {
        throw new Error(`should have a function declaration: ${source}`);
    }
    const body = declaration.data.body;
    if (body.type !== N.BlockStatement) throw new Error(`should have a body: ${source}`);
    return body.data.body[0];
}

const DEFAULT_CONTEXT = context();

/** oxc `test` / `test_with_ctx`. */
const test = (source: string, expected: boolean, ctx: SideEffectsContext = DEFAULT_CONTEXT): void =>
    it(source, () => expect(mayHaveSideEffects(firstExpression(source), ctx)).toBe(expected));

/** oxc `test_with_global_variables`. */
const testWithGlobals = (source: string, globals: readonly string[], expected: boolean): void =>
    it(`${source} [globals: ${globals.join(', ')}]`, () =>
        expect(mayHaveSideEffects(firstExpression(source), context({ globals }))).toBe(expected));

/** oxc `test_with_target`. */
const testWithTarget = (source: string, edition: number, expected: boolean): void =>
    it(`${source} [target es${edition}]`, () =>
        expect(mayHaveSideEffects(firstExpression(source), context({ target: esTarget(edition) }))).toBe(expected));

/** oxc `test_ts`. */
const testTs = (source: string, expected: boolean): void =>
    it(source, () => expect(mayHaveSideEffects(firstExpression(source, true), DEFAULT_CONTEXT)).toBe(expected));

/** oxc `test_in_function`: the first statement of the function body. */
const testInFunction = (source: string, expected: boolean): void =>
    it(source, () => expect(mayHaveSideEffects(firstStatementInFunction(source), DEFAULT_CONTEXT)).toBe(expected));

/** oxc `test_assign_target_with_global_variables`: only the assignment's target. */
const testAssignTarget = (source: string, expected: boolean, globals: readonly string[] = []): void =>
    it(`${source} [target; globals: ${globals.join(', ')}]`, () => {
        const expression = firstExpression(source);
        if (expression.type !== N.AssignmentExpression) throw new Error(`should have an assignment expression: ${source}`);
        expect(assignmentTargetMayHaveSideEffects(expression.data.left, context({ globals }))).toBe(expected);
    });

/** `may_have_side_effects_statements.rs` `test`: the first statement. */
const testStatement = (source: string, expected: boolean): void =>
    it(source, () => expect(mayHaveSideEffects(parseBody(source)[0], DEFAULT_CONTEXT)).toBe(expected));

describe('closure compiler tests', () => {
    test('[1]', false);
    test('[1, 2]', false);
    test('i++', true);
    test('[b, [a, i++]]', true);
    test('i=3', true);
    test('[0, i=3]', true);
    test('b()', true);
    test('[1, b()]', true);
    test('b.b=4', true);
    test('b.b--', true);
    test('i--', true);
    test('a[0][i=4]', true);
    test('a += 3', true);
    test('a, b, z += 4', true);
    test('a ? c : d++', true);
    test('a ?? b++', true);
    test('a + c++', true);
    test('a + c - d()', true);
    test('(function() { })', false);
    test('(function() { i++ })', false);
    test('[function a(){}]', false);
    test('(class { })', false);
    test('(class { method() { i++ } })', false);
    test('(class { [computedName()]() {} })', true);
    test('(class { [computedName]() {} })', false);
    test('(class Foo extends Bar { })', false);
    test('(class extends foo() { })', true);
    test('a', false);
    test('a.b', true);
    test('a.b.c', true);
    test('[b, c, [d, [e]]]', false);
    test('({a: x, b: y, c: z})', false);
    test('({a, b, c})', false);
    test('/abc/gi', false);
    test("('a')", false);
    test('0', false);
    test('a + c', true);
    test("'c' + a[0]", true);
    test('a[0][1]', true);
    test("'a' + c", true);
    test("'a' + a.name", true);
    test('1, 2, 3', false);
    test('a, b, 3', false);
    test('(function(a, b) {  })', false);
    test('a ? c : d', false);
    test('a ?? b', false);
    test('`template`', false);
    test('`template${name}`', true);
    test('`${name}template`', true);
    test('`${naming()}template`', true);
    test('templateFunction`template`', true);
    test('st = `${name}template`', true);
    test('tempFunc = templateFunction`template`', true);
    // Only portable, valid RegExp constructions are pure: an invalid or post-ES5 pattern may throw.
    test("new RegExp('foobar', 'i')", false);
    test("new RegExp('foobar', 2)", true);
    test("new RegExp(SomethingWacky(), 'i')", true);
    test("new RegExp('[')", true);
    test("new RegExp('a', 'xyz')", true);
    test(String.raw`new RegExp('\\p{Ll}', 'u')`, true);
    test("new RegExp('(?<name>a)')", true);
    test("new RegExp('(?<=a)b')", true);
    test("new RegExp('(?s:a)')", true);
    test("new RegExp('a', 'u')", true);
    test("new RegExp('a', 'y')", true);
    test("new RegExp('a', 's')", true);
    test("new RegExp('a', 'd')", true);
    test("new RegExp('a', 'v')", true);
    test("new RegExp('a', 'gim')", false);
    test('new RegExp(/a/)', false);
    test("new RegExp(/a/, 'i')", true);
    testWithTarget("new RegExp(/a/, 'i')", 2015, false);
    testWithTarget("new RegExp(/a/, 'u')", 2015, false);
    testWithTarget("new RegExp(/a/, '!')", ESNEXT, true);
    testWithTarget("new RegExp(/a/, 'uv')", ESNEXT, true);
    testWithTarget(String.raw`new RegExp('\\p{Ll}', 'u')`, 2018, false);
    testWithTarget("new RegExp('(?<name>a)')", 2025, false);
    test(String.raw`new RegExp('[\uD801-\uD800]')`, true);
    test(String.raw`RegExp('\\p{Ll}', 'u')`, true);
    test("RegExp('a', 'gim')", false);
    test("RegExp(/a/, 'i')", true);
    testWithTarget("RegExp(/a/, 'i')", 2015, false);
    test('new SomeClassINeverHeardOf()', true);
    test('this.foo = 4', true);
    test('a.foo = 4', true);
    test('(function() { return n; })().foo = 4', true);
    test('([]).foo = bar()', true);
    test('undefined', false);
    test('void 0', false);
    test('void foo()', true);
    test('-Infinity', false);
    test('Infinity', false);
    test('NaN', false);
    test('delete a.b', true);
    test('Math.random();', false);
    // `Math` is a known global, so reading it is side-effect-free.
    test('Math.random(Math);', false);
    testWithGlobals('Math.random(seed);', ['seed'], true);

    // ARRAYLIT-ITER_SPREAD
    test('[...[]]', false);
    test('[...[1]]', false);
    test('[...[i++]]', true);
    test("[...'string']", false);
    test('[...`templatelit`]', false);
    test('[...`templatelit ${safe}`]', true);
    test('[...`templatelit ${unsafe()}`]', true);
    test('[...f()]', true);
    test('[...5]', true);
    test('[...null]', true);
    test('[...true]', true);

    // CALL-ITER_SPREAD
    test('Math.sin(...[i++])', true);
    test('Math.sin(...`templatelit ${unsafe()}`)', true);
    test('Math.sin(...f())', true);
    test('Math.sin(...5)', true);
    test('Math.sin(...null)', true);
    test('Math.sin(...true)', true);

    // NEW-ITER_SPREAD
    test('new Object(...[i++])', true);
    test('new Object(...`templatelit ${unsafe()}`)', true);
    test('new Object(...f())', true);
    test('new Object(...5)', true);
    test('new Object(...null)', true);
    test('new Object(...true)', true);

    // OBJECT_SPREAD
    test('({...x})', true);
    test('({...{}})', false);
    test('({...{a:1}})', false);
    test('({...{a:i++}})', true);
    test('({...{a:f()}})', true);
    test('({...f()})', true);

    // OBJECT_REST
    test('({...x} = something)', true);
    test('({a, ...x} = something)', true);

    // ITER_REST
    test("([...x] = 'safe')", true);
    test('(function(...x) { })', false);

    // COMPUTED_PROP - OBJECTLIT
    test('({[a]: x})', false);
    test('({[a()]: x})', true);
    test('({[a]: x()})', true);
    test('({ get [a]() {} })', false);
    test('({ get [a()]() {} })', true);
    test('({ set [a](x) {} })', false);
    test('({ set [a()](x) {} })', true);

    // COMPUTED_PROP - CLASS
    test('(class C { [a]() {} })', false);
    test('(class C { [a()]() {} })', true);
    test('(class C { get [a]() {} })', false);
    test('(class C { get [a()]() {} })', true);
    test('(class C { set [a](x) {} })', false);
    test('(class C { set [a()](x) {} })', true);

    // GETTER_DEF
    test('({ get a() {} })', false);
    test('(class C { get a() {} })', false);

    // Getter use
    test('x.normal;', true);
    test('x?.normal;', true);
    test('({normal} = foo());', true);

    // SETTER_DEF
    test('({ set a(x) {} })', false);
    test('(class C { set a(x) {} })', false);

    // SETTER_USE
    test('x.normal = 0;', true);

    // MEMBER_FUNCTION_DEF
    test('({ a(x) {} })', false);
    test('(class C { a(x) {} })', false);

    // MEMBER_FIELD_DEF
    test('(class C { x=2; })', false);
    test('(class C { x; })', false);
    test('(class C { x })', false);
    test('(class C { x \n y })', false);
    test('(class C { static x=2; })', false);
    test('(class C { static x; })', false);
    test('(class C { static x })', false);
    test('(class C { static x \n static y })', false);
    test('(class C { x = alert(1); })', false);
    test('(class C { static x = alert(1); })', true);

    // COMPUTED_FIELD_DEF
    test('(class C { [x]; })', false);
    test("(class C { ['x']=2; })", false);
    test("(class C { 'x'=2; })", false);
    test('(class C { 1=2; })', false);
    test('(class C { static [x]; })', false);
    test("(class C { static ['x']=2; })", false);
    test("(class C { static 'x'=2; })", false);
    test('(class C { static 1=2; })', false);
    test("(class C { ['x'] = alert(1); })", false);
    test("(class C { static ['x'] = alert(1); })", true);
    test('(class C { static [alert(1)] = 2; })', true);

    // CLASS_STATIC_BLOCK
    test('(class C { static {} })', false);
    test('(class C { static { [1]; } })', false);
    test('(class C { static { let x; } })', false);
    test('(class C { static { const x =1 ; } })', false);
    test('(class C { static { var x; } })', false);
    test('(class C { static { this.x = 1; } })', true);
    test('(class C { static { function f() { } } })', false);
    test('(class C { static { (function () {} )} })', false);
    test('(class C { static { ()=>{} } })', false);

    // SUPER calls
    test('super()', true);
    test('super.foo()', true);

    // RegExp instance methods and the string RegExp ops have global side effects.
    test("(/abc/gi).test('')", true);
    test('(/abc/gi).test(a)', true);
    test("(/abc/gi).exec('')", true);
    test("(/abc/gi).foo('')", true);
    test("''.match('a')", true);
    test("''.match(/(a)/)", true);
    test("''.replace('a')", true);
    test("''.search('a')", true);
    test("''.split('a')", true);
    test("''.foo('a')", true);
    test("''.match(a)", true);

    // Dynamic import changes global state.
    test("import('./module.js')", true);
});

describe('identifier reference', () => {
    testWithGlobals('a', ['a'], true);
    test('NaN', false);
});

describe('simple expressions', () => {
    test('1n', false);
    test('true', false);
    test('import.meta', false);
    test('(() => {})', false);
    // `this` in a derived class before `super()` is a ReferenceError.
    test('this', true);
});

describe('template literal', () => {
    test('``', false);
    test('`a`', false);
    test('`${1}`', false);
    test('`${[]}`', false);
    test('`${Symbol()}`', true);
    test("`${{ toString() { console.log('sideeffect') } }}`", true);
    test("`${{ valueOf() { console.log('sideeffect') } }}`", true);
    test("`${{ [s]() { console.log('sideeffect') } }}`", true);
    test('`${a}`', true);
    test('`${a()}`', true);
    test('`${a() === b}`', true);
});

describe('unary expressions', () => {
    test("delete 'foo'", true);
    test('delete foo()', true);

    test("void 'foo'", false);
    test('void foo()', true);
    test("!'foo'", false);
    test('!foo()', true);

    test("typeof 'foo'", false);
    testWithGlobals('typeof a', ['a'], false);
    testWithGlobals('typeof (0, a)', ['a'], true);
    test('typeof foo()', true);

    test('+0', false);
    test('+0n', true);
    test('+null', false);
    test('+true', false);
    test("+'foo'", false);
    test('+`foo`', false);
    test('+/foo/', false);
    test('+Infinity', false);
    test('+NaN', false);
    test('+undefined', false);
    test('+[]', false);
    test('+[foo()]', true);
    test('+foo()', true);
    test('+foo', true);
    test('+Symbol()', true);
    test('+{}', false);
    test('+{ valueOf() { return Symbol() } }', true);

    test('-0', false);
    test('-0n', false);
    test('-null', false);
    test('-true', false);
    test("-'foo'", false);
    test('-`foo`', false);
    test('-/foo/', false);
    test('-Infinity', false);
    test('-NaN', false);
    test('-undefined', false);
    test('-[]', false);
    test('-[foo()]', true);
    test('-foo()', true);
    test('-foo', true);
    test('-Symbol()', true);
    test('-{}', false);
    test('-{ valueOf() { return Symbol() } }', true);

    test('~0', false);
    test("~'foo'", false);
    test('~foo()', true);
    test('~foo', true);
});

describe('logical expressions', () => {
    test('a || b', false);
    test('a() || b', true);
    test('a && b', false);
    test('a() && b', true);
    test('a ?? b', false);
    test('a() ?? b', true);
});

describe('other expressions', () => {
    test('(foo)', false);
    test('(foo())', true);

    test('a ? b : c', false);
    test('a() ? b : c', true);

    test('a, b', false);
    test('a(), b', true);
    test('a, b()', true);
});

describe('binary expressions', () => {
    test('a === b', false);
    test('a() === b', true);
    test('a !== b', false);
    test('a() !== b', true);

    test('a == b', false);
    test('a() == b', true);
    // These have a side effect, which the ToPrimitive assumption ignores.
    test("'' == { toString() { console.log('sideeffect') } }", false);
    test("'' == { valueOf() { console.log('sideeffect') } }", false);
    test("'' == { [s]() { console.log('sideeffect') } }", false);
    test('a != b', false);
    test('a() != b', true);

    test('a < b', false);
    test('a() < b', true);
    test("'' < { toString() { console.log('sideeffect') } }", false);
    test("'' < { valueOf() { console.log('sideeffect') } }", false);
    test("'' < { [s]() { console.log('sideeffect') } }", false);
    test('a > b', false);
    test('a() > b', true);
    test('a >= b', false);
    test('a() >= b', true);
    test('a <= b', false);
    test('a() <= b', true);

    test("'' + ''", false);
    test("'' + ``", false);
    test("'' + `${foo()}`", true);
    test("'' + null", false);
    test("'' + 0", false);
    test("'' + 0n", false);
    test("'' + true", false);
    test("'' + /a/", false);
    test("'' + []", false);
    test("'' + [foo()]", true);
    test("'' + Symbol()", true);
    test("'' + Infinity", false);
    test("'' + NaN", false);
    test("'' + undefined", false);
    test("'' + s", true);
    test("Symbol() + ''", true);
    test("'' + {}", false);
    test("'' + { toString() { return Symbol() } }", true);
    test("'' + { valueOf() { return Symbol() } }", true);
    test("'' + { [s]() { return Symbol() } }", true);
    test('/a/ + 1', false);
    test('[] + 1', false);
    test('({} + 1)', false);
    test('0 + 1', false);
    test('0 + null', false);
    test('0 + true', false);
    test('0 + a', true);
    test('0n + 1n', false);
    test('0n + a', true);
    test('a + b', true);

    test('0n - 1n', false);
    test('0n - 0', true);
    test('0n - a', true);
    test('a - 0n', true);
    test('0n - a()', true);
    test('0 - 1', false);
    test('0 - a', true);
    test("0 - ''", false);
    test('0 - ``', false);
    test('0 - true', false);
    test('0 - /a/', false);
    test('0 - []', false);
    test('0 - [foo()]', true);
    test('0 - Infinity', false);
    test('0 - NaN', false);
    test('0 - undefined', false);
    test('null - Infinity', false);
    test('0 - {}', false);
    test("'' - { toString() { return Symbol() } }", true);
    test("'' - { valueOf() { return Symbol() } }", true);
    test("'' - { [s]() { return Symbol() } }", true);
    test('a - b', true);
    test('0 * 1', false);
    test('0 * a', true);
    test('0 / 1', false);
    test('0 / a', true);
    test('0 % 1', false);
    test('0 % a', true);
    test('0 << 1', false);
    test('0 << a', true);
    test('0 | 1', false);
    test('0 | a', true);
    test('0 >> 1', false);
    test('0 >> a', true);
    test('0 ^ 1', false);
    test('0 ^ a', true);
    test('0 & 1', false);
    test('0 & a', true);
    test('0 ** 1', false);
    test('0 ** a', true);
    test('1n ** (-1n)', true);
    test('1n / 0n', true);
    test('1n % 0n', true);
    test('0n >>> 1n', true);

    test('[] instanceof 1', true);
    test("[] instanceof { [Symbol.hasInstance]() { throw 'foo' } }", true);
    test('[] instanceof Object', false);
    test('a instanceof Object', true);

    test('a in b', true);
});

describe('object expression', () => {
    test('({})', false);
    test('({a: 1})', false);
    test('({a: foo()})', true);
    test('({1: 1})', false);
    test('({[1]: 1})', false);
    test('({[1n]: 1})', false);
    test("({['1']: 1})", false);
    // These have a side effect, which the ToPrimitive assumption ignores.
    test("({[{ toString() { console.log('sideeffect') } }]: 1})", false);
    test("({[{ valueOf() { console.log('sideeffect') } }]: 1})", false);
    test("({[{ [s]() { console.log('sideeffect') } }]: 1})", false);
    test('({[foo]: 1})', false);
    test('({[foo()]: 1 })', true);
    test('({...a})', true);
    test('({...[]})', false);
    test('({...[...a]})', true);
    test("({...'foo'})", false);
    test('({...`foo`})', false);
    test('({...`foo${1}`})', false);
    test('({...`foo${foo}`})', true);
    test('({...`foo${foo()}`})', true);
    test('({...foo()})', true);
    test('({...{}})', false);
    test('({...{a: 1}})', false);
    test('({...{a: foo()}})', true);
    test('({...{[foo()]: 1}})', true);
    // Spreading runs getters, not setters.
    test('({...{get a() {}}})', true);
    test('({...{get a() { return 1 }}})', true);
    test('({...{set a(v) {}}})', false);
});

describe('array expression', () => {
    test('[]', false);
    test('[1]', false);
    test('[foo()]', true);
    test('[,]', false);
    test('[...a]', true);
    test('[...[]]', false);
    test('[...[...a]]', true);
    test("[...'foo']", false);
    test('[...`foo`]', false);
    test('[...`foo${1}`]', false);
    test('[...`foo${foo}`]', true);
    test('[...`foo${foo()}`]', true);
    test('[...foo()]', true);
    testInFunction('function foo() { [...arguments] }', false);
});

describe('class expression', () => {
    test('(class {})', false);
    test('(@foo class {})', true);
    test('(class extends a {})', false);
    test('(class extends foo() {})', true);
    test('(class extends (() => {}) {})', true);
    test('(class { static {} })', false);
    test('(class { static { 1; } })', false);
    test('(class { static { foo(); } })', true);
    test('(class { a() {} })', false);
    test('(class { [1]() {} })', false);
    test('(class { [1n]() {} })', false);
    test('(class { #a() {} })', false);
    test('(class { [foo()]() {} })', true);
    test('(class { @foo a() {} })', true);
    test('(class { a; })', false);
    test('(class { 1; })', false);
    test('(class { [1]; })', false);
    test('(class { [1n]; })', false);
    test('(class { #a; })', false);
    test('(class { @foo a; })', true);
    test('(class { [foo()] = 1 })', true);
    test('(class { a = foo() })', false);
    test('(class { static a; })', false);
    test('(class { static 1; })', false);
    test('(class { static [1]; })', false);
    test('(class { static [1n]; })', false);
    test('(class { static #a; })', false);
    test('(class { static [foo()] = 1 })', true);
    test('(class { static a = foo() })', true);
    test('(class { accessor [foo()]; })', true);
    test('(class { static accessor [foo()]; })', true);
    test('(class { accessor a = 1; })', false);
    test('(class { accessor a = foo(); })', true);
    test('(class { static accessor a = 1; })', false);
    test('(class { static accessor a = foo(); })', true);
    test('(class { #x; static { #x in {}; } })', false);
    test('(class { #x; static { #x in foo(); } })', true);
    // shakeup's parser does not accept parameter decorators.
    it.fails('(class { a(@foo x) {} })', () =>
        expect(mayHaveSideEffects(firstExpression('(class { a(@foo x) {} })', true), DEFAULT_CONTEXT)).toBe(true));
    it.fails('(class { a(@foo x, @bar y) {} })', () =>
        expect(mayHaveSideEffects(firstExpression('(class { a(@foo x, @bar y) {} })', true), DEFAULT_CONTEXT)).toBe(true));
    testTs('(class { a(x) {} })', false);
});

describe('property access', () => {
    test('a.length', true);
    test('a?.length', true);
    test("'a'.length", false);
    test("'a'?.length", false);
    test('[].length', false);
    test("[]['length']", false);
    test('[][`length`]', false);
    test('[][`length${foo()}`]', true);
    test("(foo() + '').length", true);

    test('a[0]', true);
    test("''[-1]", true);
    test("''[0.3]", true);
    test("''[0]", true);
    test("'a'[0]", false);
    test("'a'[0n]", false);
    test("'a'[1]", true);
    test("'あ'[0]", false);
    test("'あ'[1]", true);
    test("'\u{1F600}'[0]", false);
    test("'\u{1F600}'[1]", false);
    test("'\u{1F600}'[2]", true);

    test('[][-1]', true);
    test('[][0.3]', true);
    test('[][0]', true);
    test('[1][0]', false);
    test('[1][0n]', false);
    test('[1][1]', true);
    test('[,][0]', false);
    test('[...[], 1][0]', false);
    test('[...[1]][0]', false);
    test("[...'a'][0]", false);
    test("[...'a'][1]", true);

    test('import.meta.url', true);
    test("import.meta['url']", true);
    test('import.meta[`url`]', true);
    testInFunction('function f() { new.target.url }', true);
    test("[...'\u{1F600}'][0]", false);
    test("[...'\u{1F600}'][1]", true);
    test('[...a, 1][0]', true);
});

describe('known global identifiers', () => {
    test('Math', false);
    test('Array', false);
    test('Object', false);
    test('JSON', false);
    test('Reflect', false);
    test('Symbol', false);
    test('Promise', false);
    test('Map', false);
    test('Set', false);
    test('WeakMap', false);
    test('WeakSet', false);
    test('parseInt', false);
    test('parseFloat', false);
    test('isNaN', false);
    test('isFinite', false);
    test('encodeURI', false);
    test('decodeURI', false);
    test('globalThis', false);

    testWithGlobals('console', ['console'], false);
    testWithGlobals('document', ['document'], false);
    testWithGlobals('window', ['window'], false);
    testWithGlobals('fetch', ['fetch'], false);

    testWithGlobals('SomeUnknownGlobal', ['SomeUnknownGlobal'], true);
});

describe('known global property reads', () => {
    test('Math.PI', false);
    test('Math.E', false);
    test('Math.abs', false);
    test('Math.floor', false);
    test('Math.random', false);
    test('Math.unknownProp', true);

    test('Object.keys', false);
    test('Object.create', false);
    test('Object.assign', false);
    test('Object.prototype', false);
    test('Object.unknownProp', true);

    test('Reflect.apply', false);
    test('Reflect.get', false);
    test('Reflect.unknownProp', true);

    test('Symbol.iterator', false);
    test('Symbol.asyncIterator', false);
    test('Symbol.unknownProp', true);

    test('JSON.parse', false);
    test('JSON.stringify', false);
    test('JSON.unknownProp', true);

    testWithGlobals('console.log', ['console'], false);
    testWithGlobals('console.error', ['console'], false);
    testWithGlobals('console.warn', ['console'], false);
    testWithGlobals('console.unknownMethod', ['console'], true);
});

describe('known global property deep', () => {
    test('Object.prototype.hasOwnProperty', false);
    test('Object.prototype.isPrototypeOf', false);
    test('Object.prototype.toString', false);
    test('Object.prototype.valueOf', false);
    test('Object.prototype.propertyIsEnumerable', false);
    test('Object.prototype.unknownProp', true);

    test('Math.PI.toString', true);
    test('Array.prototype.push', true);
});

describe('new expressions', () => {
    test('new AggregateError', true);
    test('new DataView', true);
    test('new Symbol', true);
    test('new Set', false);
    test('new Map', false);
    test('new WeakSet', false);
    test('new WeakMap', false);
    test('new ArrayBuffer', false);
    test('new Date', false);
    test('new Boolean', false);
    test('new Error', false);
    test('new EvalError', false);
    test('new RangeError', false);
    test('new ReferenceError', false);
    test('new RegExp', false);
    test('new SyntaxError', false);
    test('new TypeError', false);
    test('new URIError', false);
    test('new Number', false);
    test('new Object', false);
    test('new String', false);

    test('new Int8Array', false);
    test('new Uint8Array', false);
    test('new Uint8ClampedArray', false);
    test('new Int16Array', false);
    test('new Uint16Array', false);
    test('new Int32Array', false);
    test('new Uint32Array', false);
    test('new Float32Array', false);
    test('new Float64Array', false);
    test('new BigInt64Array', false);
    test('new BigUint64Array', false);

    // ToPrimitive is assumed pure, but ToString and ToNumber throw on a Symbol.
    test('new String()', false);
    test("new String('hello')", false);
    test('new String(123)', false);
    test('new String(true)', false);
    test('new String(null)', false);
    test('new String(x)', true);
    test('new String({})', false);
    test("new String({toString() { return 'x' }})", true);

    test('new Number()', false);
    test('new Number(123)', false);
    test("new Number('42')", false);
    test('new Number(true)', false);
    test('new Number(null)', false);
    test('new Number(x)', true);
    test('new Number({})', false);
    test('new Number({valueOf() { return 1 }})', true);

    // ToNumber throws on a Symbol or a BigInt.
    test('new Date()', false);
    test('new Date(0)', false);
    test("new Date('2024')", false);
    test('new Date(x)', true);
    test('new Date(0n)', true);

    test('new ArrayBuffer()', false);
    test('new ArrayBuffer(16)', false);
    test('new ArrayBuffer(x)', true);
    test('new ArrayBuffer(0n)', true);

    // An object argument is iterated, and a BigInt throws in ToNumber.
    test('new Uint8Array(16)', false);
    test('new Int8Array(x)', true);
    test('new Float64Array({})', true);
    test('new Float64Array({[Symbol.iterator]() {}})', true);

    test('new Object(x)', false);
    test('new Object({})', false);

    test('new Boolean(x)', false);
    test('new Boolean({})', false);

    test('new Error()', false);
    test("new Error('msg')", false);
    test('new Error(x)', true);
    test('new TypeError(x)', true);
    test('new Error({})', false);

    // Collections iterate their argument, so only no argument, null, undefined and array literals are pure.
    test('new Set(null)', false);
    test('new Map(null)', false);
    test('new WeakSet(null)', false);
    test('new WeakMap(null)', false);
    test('new Set(undefined)', false);
    test('new Map(undefined)', false);
    test('new Set([])', false);
    test('new Set([1, 2, 3])', false);
    test('new Map([])', false);
    test('new Map([[1, 2], [3, 4]])', false);
    test('new WeakSet([])', false);
    test('new WeakMap([])', false);
    test('new WeakMap([[{}, 1]])', false);
    test('new Set(x)', true);
    test('new Map(x)', true);
    test('new WeakSet(x)', true);
    test('new WeakMap(x)', true);
    test('new Set(false)', true);
    test('new Map({})', true);
    test('new Map([x])', true);
    test('new Map([x, []])', true);
    test('new Map([[], x])', true);
});

describe('call expressions', () => {
    test('AggregateError()', true);
    test('DataView()', true);
    test('Set()', true);
    test('Map()', true);
    test('WeakSet()', true);
    test('WeakMap()', true);
    test('ArrayBuffer()', true);
    test('Date()', false);
    test('Boolean()', false);
    test('Error()', false);
    test("Error('msg')", false);
    test('Error(x)', true);
    test('EvalError()', false);
    test('RangeError()', false);
    test('ReferenceError()', false);
    test('RegExp()', false);
    test('SyntaxError()', false);
    test('TypeError()', false);
    test('URIError()', false);
    test('Number()', false);
    test('Object()', false);
    test('String()', false);
    test('Symbol()', false);
    test('String({})', false);
    test('String([1, 2, 3])', false);
    test("String({ toString() { return 'x' } })", false);
    test('String(obj)', false);
    test('Number({})', false);
    test('Number({ valueOf() { return 1 } })', true);
    test('Number(Symbol())', true);
    test('Number(obj)', true);
    test('Boolean({})', false);
    test('Boolean(obj)', false);
    test('BigInt()', true);
    test('BigInt(123)', false);
    test('BigInt(123n)', false);
    test('BigInt(true)', false);
    test('BigInt(false)', false);
    test("BigInt('456')", false);
    test("BigInt('abc')", true);
    test('BigInt(1.5)', true);
    test('BigInt(undefined)', true);
    test('BigInt(null)', true);
    test('BigInt({})', true);
    test('BigInt({ valueOf() { return 1 } })', true);
    test('BigInt(obj)', true);
    test('Symbol({})', false);
    test("Symbol({ toString() { return 'x' } })", true);
    test('Symbol(obj)', true);
    test('Symbol(Symbol())', true);

    test('decodeURI()', false);
    test('decodeURIComponent()', false);
    test('encodeURI()', false);
    test('encodeURIComponent()', false);
    test('escape()', false);
    test('isFinite()', false);
    test('isNaN()', false);
    test('parseFloat()', false);
    test('parseInt()', false);

    test('Array.isArray()', false);
    test('Array.of()', false);

    test('ArrayBuffer.isView()', false);

    test('Date.now()', false);
    test('Date.parse()', false);
    test('Date.UTC()', false);

    for (const method of [
        'abs',
        'acos',
        'acosh',
        'asin',
        'asinh',
        'atan',
        'atan2',
        'atanh',
        'cbrt',
        'ceil',
        'clz32',
        'cos',
        'cosh',
        'exp',
        'expm1',
        'floor',
        'fround',
        'hypot',
        'imul',
        'log',
        'log10',
        'log1p',
        'log2',
        'max',
        'min',
        'pow',
        'random',
        'round',
        'sign',
        'sin',
        'sinh',
        'sqrt',
        'tan',
        'tanh',
        'trunc',
    ]) {
        test(`Math.${method}()`, false);
    }

    test('Number.isFinite()', false);
    test('Number.isInteger()', false);
    test('Number.isNaN()', false);
    test('Number.isSafeInteger()', false);
    test('Number.parseFloat()', false);
    test('Number.parseInt()', false);

    // These throw on an `undefined` receiver or are kept; `Object.is()` is `Object.is(undefined, undefined)`.
    test('Object.create()', true);
    test('Object.getOwnPropertyDescriptor()', true);
    test('Object.getOwnPropertyDescriptors()', true);
    test('Object.getOwnPropertyNames()', true);
    test('Object.getOwnPropertySymbols()', true);
    test('Object.getPrototypeOf()', true);
    test('Object.hasOwn()', true);
    test('Object.is()', false);
    test('Object.keys()', true);
    test('Object.isExtensible()', false);
    test('Object.isFrozen()', false);
    test('Object.isSealed()', false);

    test('String.fromCharCode()', false);
    test('String.fromCodePoint()', false);
    test('String.raw()', true);

    test('Symbol.for()', false);
    test('Symbol.keyFor()', true);

    test('URL.canParse()', true);

    for (const typedArray of [
        'BigInt64Array',
        'BigUint64Array',
        'Float32Array',
        'Float64Array',
        'Int16Array',
        'Int32Array',
        'Int8Array',
        'Uint16Array',
        'Uint32Array',
        'Uint8Array',
        'Uint8ClampedArray',
    ]) {
        test(`${typedArray}.of()`, false);
    }

    // May have side effects if shadowed.
    testWithGlobals('Date()', [], true);
    testWithGlobals('Object.create()', [], true);
});

describe('proxy-sensitive Object methods', () => {
    test('Object.keys({})', false);
    test('Object.keys([])', false);
    test('Object.keys(42)', false);
    test("Object.keys('s')", false);
    test('Object.keys(true)', false);
    test('Object.keys(10n)', false);
    test('Object.keys({ get a() { f() } })', false);
    test('Object["keys"]({})', false);
    test("Object.getOwnPropertyDescriptor({}, 'x')", false);
    test('Object.getOwnPropertyDescriptors({})', false);
    test('Object.getOwnPropertyNames({})', false);
    test('Object.getOwnPropertySymbols({})', false);
    test('Object.getPrototypeOf({})', false);
    test("Object.hasOwn({}, 'x')", false);
    test('Object.isExtensible({})', false);
    test('Object.isFrozen({})', false);
    test('Object.isSealed({})', false);

    test('Object.isExtensible(null)', false);
    test('Object.isFrozen(undefined)', false);
    test('Object.isSealed(42)', false);
    test('Object.isExtensible(x)', true);
    test('Object.isFrozen(new Proxy({}, {}))', true);
    test('Object.isSealed(...x)', true);

    test('Object.keys(x)', true);
    test('Object.keys(new Proxy({}, {}))', true);
    test('Object.keys(null)', true);
    test('Object.keys(undefined)', true);
    test('Object.keys(...x)', true);
    test("Object.getOwnPropertyDescriptor(x, 'x')", true);
    test('Object.getPrototypeOf(x)', true);
    test("Object.hasOwn(x, 'x')", true);
    test('Object["keys"](x)', true);

    test('Object.values({})', true);
    test('Object.entries({})', true);
    test('Object.values(x)', true);
    test('Object.values({ get a() { f() } })', true);

    test('Object.is(1, 2)', false);
    test('Object.is(f(), 2)', true);

    test('Object.create({})', false);
    test('Object.create([])', false);
    test('Object.create(null)', false);
    test('Object.create(x)', true);
    test('Object.create(42)', true);
    test('Object.create(undefined)', true);
    test('Object.create({}, x)', true);
    test('Object.create({}, {})', true);
});

describe('throwing global calls', () => {
    test('String.raw()', true);
    test('String.raw({})', true);
    test('String.raw(x)', true);
    test('Symbol.keyFor()', true);
    test('Symbol.keyFor(42)', true);
    test('Symbol.keyFor(x)', true);
    test('URL.canParse()', true);
    test("URL.canParse('x')", false);
    test('URL.canParse(x)', false);

    test('String.fromCodePoint(-1)', true);
    test('String.fromCodePoint(1.5)', true);
    test('String.fromCodePoint(0x110000)', true);
    test('String.fromCodePoint(65)', false);
    test('String.fromCodePoint(0, 0x10FFFF)', false);
    test('String.fromCodePoint(0, -1)', true);
    test('String.fromCodePoint(x)', false);
    test('String.fromCharCode(-1)', false);
    test('String.fromCharCode(1.5)', false);

    test('Math.abs(10n)', true);
    test('Math.floor(10n)', true);
    test('Math.max(1, 10n)', true);
    test('Date.UTC(10n)', true);
    test('String.fromCharCode(10n)', true);
    test('String.fromCodePoint(10n)', true);
    test('isNaN(10n)', true);
    test('isFinite(10n)', true);
    test('Math.abs(1)', false);
    test('Math.floor(1.5)', false);
    test('Math.max(1, 2)', false);
    test('Date.UTC(2020, 0)', false);
    test('parseInt(10n)', false);
    test('parseFloat(10n)', false);
    test('decodeURI(10n)', false);
    test('Number.parseInt(10n)', false);
    test('Date.parse(10n)', false);
    test('Symbol.for(10n)', false);
});

describe('call-like expressions', () => {
    test('foo()', true);
    test('/* #__PURE__ */ foo()', false);
    test('/* #__PURE__ */ foo(1)', false);
    test('/* #__PURE__ */ foo(bar())', true);
    test('/* #__PURE__ */ foo(...[])', false);
    test('/* #__PURE__ */ foo(...[1])', false);
    test('/* #__PURE__ */ foo(...[bar()])', true);
    test('/* #__PURE__ */ foo(...bar)', true);
    test('/* #__PURE__ */ foo(...`foo`)', false);
    test('/* #__PURE__ */ foo(...`${1}`)', false);
    test('/* #__PURE__ */ foo(...`${bar}`)', true);
    test('/* #__PURE__ */ foo(...`${bar()}`)', true);
    test('/* #__PURE__ */ (() => { foo() })()', false);
    test('foo?.()', true);
    test('/* #__PURE__ */ foo?.()', false);

    test('new Foo()', true);
    test('/* #__PURE__ */ new Foo()', false);
    test('/* #__PURE__ */ new Foo(1)', false);
    test('/* #__PURE__ */ new Foo(bar())', true);
    test('/* #__PURE__ */ new Foo(...[])', false);
    test('/* #__PURE__ */ new Foo(...[1])', false);
    test('/* #__PURE__ */ new Foo(...[bar()])', true);
    test('/* #__PURE__ */ new Foo(...bar)', true);
    test('/* #__PURE__ */ new Foo(...`foo`)', false);
    test('/* #__PURE__ */ new Foo(...`${1}`)', false);
    test('/* #__PURE__ */ new Foo(...`${bar}`)', true);
    test('/* #__PURE__ */ new Foo(...`${bar()}`)', true);
    test('/* #__PURE__ */ new class { constructor() { foo() } }()', false);

    const withoutAnnotations = context({ annotations: false });
    test('/* #__PURE__ */ foo()', true, withoutAnnotations);
    test('/* #__PURE__ */ new Foo()', true, withoutAnnotations);
});

describe('manual pure functions', () => {
    const ctx = context({ pureFunctions: ['foo', 'Foo'] });
    test('foo()', false, ctx);
    test('foo(1)', false, ctx);
    test('foo(bar())', true, ctx);
    test('bar()', true, ctx);
    test('new Foo()', false, ctx);
    test('new Foo(1)', false, ctx);
    test('new Foo(bar())', true, ctx);
    test('new Bar()', true, ctx);
    test('foo``', false, ctx);
    test('foo`1`', false, ctx);
    test('foo`${bar()}`', true, ctx);
    test('bar``', true, ctx);
});

describe('manual pure functions with dotted names', () => {
    const consoleCtx = context({ pureFunctions: ['console'] });
    test('console()', false, consoleCtx);
    test('console.log()', false, consoleCtx);
    test('console.log(bar())', true, consoleCtx);
    test('other.log()', true, consoleCtx);
    const consoleLogCtx = context({ pureFunctions: ['console.log'] });
    test('console.log()', false, consoleLogCtx);
    test('console.warn()', true, consoleLogCtx);
    test('console.log.foo()', false, consoleLogCtx);
});

describe('property read side effects', () => {
    const allCtx = context({ propertyReadSideEffects: 'all' });
    const noneCtx = context({ propertyReadSideEffects: 'none' });

    test('foo.bar', true, allCtx);
    test('foo.bar', false, noneCtx);
    test('foo[0]', false, noneCtx);
    test('foo[0n]', false, noneCtx);
    test('foo[bar()]', true, noneCtx);
    test('foo[bar]', true, allCtx);
    test('foo[bar]', false, noneCtx);
    test('foo[bar()]', true, allCtx);
    test('foo.#bar', true, allCtx);
    test('foo.#bar', false, noneCtx);
    test('foo().#bar', true, allCtx);
    test('foo().#bar', true, noneCtx);
    test('({ bar } = foo)', true, allCtx);

    test('({...foo})', true, allCtx);
    test('({...foo})', false, noneCtx);
    test('({...foo()})', true, allCtx);
    test('({...foo()})', true, noneCtx);
});

describe('unknown global side effects', () => {
    test('foo', true, context({ unknownGlobalSideEffects: true, globals: ['foo'] }));
    test('foo', false, context({ unknownGlobalSideEffects: false, globals: ['foo'] }));
});

describe('object with ToPrimitive-related properties overridden', () => {
    test('+{}', false);
    test('+{ foo: 0 }', false);
    test('+{ toString() { return Symbol() } }', true);
    test('+{ valueOf() { return Symbol() } }', true);
    test("+{ 'toString'() { return Symbol() } }", true);
    test("+{ 'valueOf'() { return Symbol() } }", true);
    test("+{ ['toString']() { return Symbol() } }", true);
    test("+{ ['valueOf']() { return Symbol() } }", true);
    test('+{ [`toString`]() { return Symbol() } }', true);
    test('+{ [`valueOf`]() { return Symbol() } }', true);
    test('+{ [Symbol.toPrimitive]() { return Symbol() } }', true);
    test('+{ ...foo }', true);
    test('+{ ...[] }', false);
    test("+{ ...'foo' }", false);
    test('+{ ...`foo` }', false);
    test('+{ ...`foo${1}` }', false);
    test('+{ ...`foo${foo}` }', true);
    test('+{ ...`foo${foo()}` }', true);
    test('+{ ...{ toString() { return Symbol() } } }', true);
    test('+{ ...{ valueOf() { return Symbol() } } }', true);
    test('+{ ...{ [Symbol.toPrimitive]() { return Symbol() } } }', true);
});

describe('typeof guard patterns', () => {
    testWithGlobals("typeof x !== 'undefined' && x", ['x'], false);
    testWithGlobals("typeof x != 'undefined' && x", ['x'], false);
    testWithGlobals("'undefined' !== typeof x && x", ['x'], false);
    testWithGlobals("'undefined' != typeof x && x", ['x'], false);
    testWithGlobals("typeof x === 'undefined' || x", ['x'], false);
    testWithGlobals("typeof x == 'undefined' || x", ['x'], false);
    testWithGlobals("'undefined' === typeof x || x", ['x'], false);
    testWithGlobals("'undefined' == typeof x || x", ['x'], false);
    testWithGlobals("typeof x < 'u' && x", ['x'], false);
    testWithGlobals("typeof x <= 'u' && x", ['x'], false);
    testWithGlobals("'u' > typeof x && x", ['x'], false);
    testWithGlobals("'u' >= typeof x && x", ['x'], false);
    testWithGlobals("typeof x > 'u' || x", ['x'], false);
    testWithGlobals("typeof x >= 'u' || x", ['x'], false);
    testWithGlobals("'u' < typeof x || x", ['x'], false);
    testWithGlobals("'u' <= typeof x || x", ['x'], false);

    testWithGlobals("typeof x === 'undefined' ? 0 : x", ['x'], false);
    testWithGlobals("typeof x == 'undefined' ? 0 : x", ['x'], false);
    testWithGlobals("'undefined' === typeof x ? 0 : x", ['x'], false);
    testWithGlobals("'undefined' == typeof x ? 0 : x", ['x'], false);
    testWithGlobals("typeof x !== 'undefined' ? x : 0", ['x'], false);
    testWithGlobals("typeof x != 'undefined' ? x : 0", ['x'], false);
    testWithGlobals("'undefined' !== typeof x ? x : 0", ['x'], false);
    testWithGlobals("'undefined' != typeof x ? x : 0", ['x'], false);

    testWithGlobals("typeof x !== 'undefined' && (x + foo())", ['x'], true);
    testWithGlobals("typeof x === 'undefined' || (x + foo())", ['x'], true);
    testWithGlobals("typeof x === 'undefined' ? foo() : x", ['x'], true);
    testWithGlobals("typeof x !== 'undefined' ? x : foo()", ['x'], true);
    testWithGlobals("typeof foo() !== 'undefined' && x", ['x'], true);
    testWithGlobals("typeof foo() === 'undefined' || x", ['x'], true);
    testWithGlobals("typeof foo() === 'undefined' ? 0 : x", ['x'], true);
    testWithGlobals("typeof y !== 'undefined' && x", ['x', 'y'], true);
    testWithGlobals("typeof y === 'undefined' || x", ['x', 'y'], true);
    testWithGlobals("typeof y === 'undefined' ? 0 : x", ['x', 'y'], true);

    test("typeof localVar !== 'undefined' && localVar", false);
    test("typeof localVar === 'undefined' || localVar", false);
    test("typeof localVar === 'undefined' ? 0 : localVar", false);

    // oxc notes this one could be improved.
    testWithGlobals("typeof x !== 'undefined' && typeof y !== 'undefined' && x && y", ['x', 'y'], true);
});

describe('assignment targets', () => {
    testAssignTarget('a = 1', false);
    testAssignTarget('String = 1', false);
    testAssignTarget('({ a } = 1)', true);
    testAssignTarget('([a] = 1)', true);
    // The setter of `a.b` runs in PutValue, which is not part of the target's evaluation.
    testAssignTarget('a.b = 1', false);
    // An undeclared `a` is a ReferenceError in strict mode.
    testAssignTarget('a.b = 1', true, ['a']);
    testAssignTarget('(foo(), a).b = 1', true);
    testAssignTarget("a['b'] = 1", false);
    testAssignTarget('a[foo()] = 1', true);
    testAssignTarget("a['b'] = 1", true, ['a']);
    testAssignTarget('a.#b = 1', false);
    testAssignTarget('a.#b = 1', true, ['a']);
    testAssignTarget('(foo(), a).#b = 1', true);
});

describe('property write side effects', () => {
    const writeCtx = context({ propertyWriteSideEffects: true });
    test('a.b = 1', true, writeCtx);
    test('a.b += 1', true, writeCtx);
    test('a.b++', true, writeCtx);

    const noWriteCtx = context({ propertyWriteSideEffects: false, propertyReadSideEffects: 'all' });
    test('a.b = 1', false, noWriteCtx);
    test("a['b'] = 1", false, noWriteCtx);
    test('a.#b = 1', false, noWriteCtx);

    // A compound assignment or update reads the target.
    test('a.b += 1', true, noWriteCtx);
    test('a.b -= 1', true, noWriteCtx);
    test('a.b &&= 1', true, noWriteCtx);
    test("a['b'] += 1", true, noWriteCtx);
    test('a.#b += 1', true, noWriteCtx);
    test('a.b++', true, noWriteCtx);
    test('a.b--', true, noWriteCtx);
    test('++a.b', true, noWriteCtx);
    test("a['b']++", true, noWriteCtx);
    test('a.#b++', true, noWriteCtx);

    // Compound assignments and updates also coerce, so they stay side-effectful with reads and writes off.
    const noSideEffectsCtx = context({ propertyWriteSideEffects: false, propertyReadSideEffects: 'none' });
    test('a.b = 1', false, noSideEffectsCtx);
    test('a.b += 1', true, noSideEffectsCtx);
    test('a.b++', true, noSideEffectsCtx);
    test("a['b'] += 1", true, noSideEffectsCtx);
    test("a['b']++", true, noSideEffectsCtx);
    test('a.#b += 1', true, noSideEffectsCtx);
    test('a.#b++', true, noSideEffectsCtx);

    test('(foo()).b = 1', true, noSideEffectsCtx);
    test('a[foo()] = 1', true, noSideEffectsCtx);
});

describe('statements', () => {
    describe('block', () => {
        testStatement('{}', false);
        testStatement('{ ; ; }', false);
        testStatement('{ foo() }', true);
        testStatement('{ ; ; foo() }', true);
    });

    describe('do while', () => {
        testStatement('do { foo() } while (true)', true);
        testStatement('do {} while (foo())', true);
        testStatement('do {} while (true)', false);
    });

    describe('expression', () => {
        testStatement('1', false);
        testStatement('foo()', true);
    });

    describe('if', () => {
        testStatement('if (foo()) {}', true);
        testStatement('if (true) { foo() }', true);
        testStatement('if (true) {}', false);
    });

    describe('labeled', () => {
        testStatement('label: foo()', true);
        testStatement('label: 1', false);
    });

    describe('return', () => {
        testInFunction('function _() { return foo() }', true);
        testInFunction('function _() { return 1 }', false);
    });

    describe('switch', () => {
        testStatement('switch (foo()) {}', true);
        testStatement('switch (true) { case foo(): }', true);
        testStatement('switch (true) { case true: foo() }', true);
        testStatement('switch (true) { case true: true }', false);
    });

    describe('try', () => {
        testStatement('try { foo() } catch {}', true);
        testStatement('try { true } catch ({}) {}', true);
        testStatement('try { true } catch { foo() }', true);
        testStatement('try { true } finally { foo() }', true);
        testStatement('try { true } catch (e) { true } finally { true }', false);
    });

    describe('while', () => {
        testStatement('while (true) { foo() }', true);
        testStatement('while (foo()) {}', true);
        testStatement('while (true) {}', false);
    });

    describe('declarations', () => {
        testStatement('await using a = null', true);
        testStatement('await using a = true', true);
        testStatement('using a = null', false);
        testStatement('using a = void 0', false);
        testStatement('using a = null, b = 1', true);
        testStatement('using a = void foo()', true);
        testStatement('var a = foo()', true);
        testStatement('var a = true', false);
        testStatement('let a = foo()', true);
        testStatement('let a = true', false);
        testStatement('const a = foo()', true);
        testStatement('const a = true', false);

        testStatement('var [a] = []', true);
        testStatement('var [a = foo()] = []', true);
        testStatement('var [[a] = [foo()]] = []', true);
        testStatement('var [a] = foo', true);
        testStatement('var {a} = {}', true);
        testStatement('var {a = foo()} = {}', true);
        testStatement('var {a} = foo', true);
    });

    describe('others', () => {
        testStatement('for (var a in b) {}', true);
        testStatement('for (var a of b) {}', true);
        testStatement('for (;;) {}', true);
        testStatement('throw 1', true);
        testStatement('with (a) {}', true);
        testStatement('debugger', true);

        testStatement("import 'a'", true);
        testStatement("export * from 'a'", true);
        testStatement('export { a }', true);
    });
});
