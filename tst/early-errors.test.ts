import { describe, expect, it } from 'vitest';
import { ParseErrorCode } from '../src/parser/errors.ts';
import { parseWithDiagnostics } from '../src/parser/parser.ts';

// P1 item 9 of the alignment plan: EARLY ERRORS — the ones where the grammar accepts the shape and
// a later rule rejects it. shakeup accepted every construct below; `pnpm parserdiff` now carries
// each as a case, and this file is the CI gate on the same set plus the exact diagnostic.
//
// Every rule and every message here was read out of `oxc_parser` and then confirmed against the
// REAL oxc parser through `scripts/parser-diff.ts`, which is why the assertions are on the code and
// not on a remembered rule. Where the two could differ, node settled it.
const parse = (src: string, kind: 'module' | 'commonjs' | 'unambiguous' = 'module') =>
    parseWithDiagnostics(src, { ts: false, jsx: false, kind });

const errOf = (src: string, kind: 'module' | 'commonjs' | 'unambiguous' = 'module') => parse(src, kind).errors[0];
const ok = (src: string, kind: 'module' | 'commonjs' | 'unambiguous' = 'module') => parse(src, kind).errors;

describe('assignment targets', () => {
    // `f() = 1` parses fine right up to the `=`: the left side is only known to be a TARGET once
    // the operator is seen. The spec handles this with a cover grammar that reinterprets the
    // already-parsed expression; oxc converts it into a real `AssignmentTarget` node
    // (`js/grammar.rs`), shakeup keeps the expression and ports the validation half.
    it.each([
        ['a call', 'f() = 1;'],
        ['a number', '1 = 2;'],
        ['a string', '"s" = 1;'],
        ['`this`', 'this = 1;'],
        ['a binary expression', '(a + b) = 1;'],
        ['a sequence', '(a, b) = 1;'],
        ['a conditional', '(a ? b : c) = 1;'],
        ['a template', '`t` = 1;'],
        ['`new`', 'new f() = 1;'],
        ['a literal inside an array pattern', '[1] = b;'],
        ['a call inside an array pattern', '[f()] = [];'],
        ['a call inside an object pattern', '({ a: f() } = {});'],
    ])('rejects assignment to %s', (_label, src) => {
        expect(errOf(src)?.code).toBe(ParseErrorCode.InvalidAssignmentTarget);
    });

    it('rejects assignment to a member inside an optional chain', () => {
        // `a.b = 1` is fine and `a?.b = 1` is not — the difference is one flag on the link, so this
        // is the case that proves the check reads `optional` rather than just the node type.
        expect(ok('a.b = 1;')).toEqual([]);
        expect(errOf('a?.b = 1;')?.code).toBe(ParseErrorCode.InvalidAssignmentTarget);
        expect(errOf('[a?.b] = c;')?.code).toBe(ParseErrorCode.InvalidAssignmentTarget);
    });

    it.each([
        ['a compound operator', 'f() += 1;'],
        ['a logical operator', 'f() ||= 1;'],
        ['a prefix update', '++f();'],
        ['a postfix update', 'f()--;'],
        ['a prefix update on a literal', '++1;'],
    ])('rejects %s on a non-simple target', (_label, src) => {
        expect(errOf(src)?.code).toBe(ParseErrorCode.AssignmentNotSimple);
    });

    it('rejects a destructuring pattern under a compound operator', () => {
        // `[a] = b` destructures; `[a] += b` cannot, because a compound operator READS the target
        // first and a pattern has no value. Both oracles split exactly here.
        expect(ok('[a] = b;')).toEqual([]);
        expect(errOf('[a] += b;')?.code).toBe(ParseErrorCode.AssignmentNotSimple);
        expect(errOf('({ a } += b);')?.code).toBe(ParseErrorCode.AssignmentNotSimple);
    });

    it('rejects a call in an un-declared for-in/of head', () => {
        expect(errOf('for (f() in {}) ;')?.code).toBe(ParseErrorCode.InvalidAssignmentTarget);
        expect(errOf('for (f() of []) ;')?.code).toBe(ParseErrorCode.InvalidAssignmentTarget);
        expect(ok('for (a.b in c) ;')).toEqual([]);
        expect(ok('for ([a] of b) ;')).toEqual([]);
    });

    it('requires `=` for a destructuring default', () => {
        expect(ok('[a = 1] = b;')).toEqual([]);
        expect(errOf('[a ||= 1] = b;')?.code).toBe(ParseErrorCode.DefaultValueOperator);
    });

    it('requires rest to be last', () => {
        expect(ok('[...a] = b;')).toEqual([]);
        expect(errOf('[...a, b] = c;')?.code).toBe(ParseErrorCode.SpreadLastElement);
        expect(errOf('({ ...a, b } = c);')?.code).toBe(ParseErrorCode.SpreadLastElement);
    });

    it('restricts a rest target, more tightly in an object than in an array', () => {
        // The asymmetry is real and is oxc's (`grammar.rs:115-125` vs `:192-201`): an ARRAY rest
        // may hold a nested pattern, an OBJECT rest may not.
        expect(ok('[...[a]] = b;')).toEqual([]);
        expect(errOf('({ ...{ a } } = b);')?.code).toBe(ParseErrorCode.InvalidRestTarget);
        expect(errOf('[...f()] = b;')?.code).toBe(ParseErrorCode.InvalidRestTarget);
        expect(ok('({ ...a.b } = c);')).toEqual([]);
    });

    it('still accepts every valid destructuring shape', () => {
        // The check runs on every assignment in every file, so the accept side is the one that
        // would break real code if the walk were too strict.
        for (const src of [
            '[a, [b], { c }, ...d] = e;',
            '({ a = 1, b: c = 2, ...d } = e);',
            '[, a] = b;',
            '[a, , b] = c;',
            '({ [k]: a } = b);',
            '({ a: b.c } = d);',
            '[a.b, a[c]] = e;',
            '({} = a);',
            '([] = a);',
            'a = b = c;',
            '[{ a = 1 }] = b;',
            'for ({ a = 1 } of b) ;',
        ]) {
            expect(ok(src), src).toEqual([]);
        }
    });
});

describe('`yield` outside a generator', () => {
    // `yield` is contextual, and oxc models it as the exact mirror of `await`: an OPERATOR only
    // where the enclosing function is a generator, an ordinary identifier everywhere else. That
    // single rule produces both halves — the rejections below and the acceptances after them.
    it.each([
        ['a plain function', 'function f() { yield 1 }'],
        ['an object method', 'var o = { m() { yield 1 } };'],
        ['a class method', 'class C { m() { yield 1 } }'],
        ['an async function', 'async function f() { yield 1 }'],
        ['a function nested in a generator', 'function* g() { function h() { yield 1 } }'],
        ['an arrow nested in a generator', 'function* g() { (() => yield 1) }'],
    ])('rejects `yield x` in %s', (_label, src) => {
        expect(ok(src)).not.toEqual([]);
    });

    it('treats `yield` as an identifier outside a generator', () => {
        // The half that would break real code if `yield` were made a hard keyword. Each of these is
        // accepted by oxc at both module and script goal.
        for (const src of ['var yield = 1;', 'yield;', 'function f() { yield => 1 }', 'function f(a = yield) {}']) {
            expect(ok(src), src).toEqual([]);
        }
    });

    it('rejects BINDING `yield` inside a generator', () => {
        expect(errOf('function* g() { var yield = 1 }')?.code).toBe(ParseErrorCode.IdentifierInGenerator);
        expect(ok('function* g() { yield 1 }')).toEqual([]);
        expect(ok('var o = { *m() { yield 1 } };')).toEqual([]);
        expect(ok('async function* g() { yield 1 }')).toEqual([]);
    });

    it('does not reject binding `await` at the top level of a script', () => {
        // `awaitOk` is seeded TRUE at top level for the permissive `unambiguous` goal, so the
        // binding check needs a guard the `yield` one does not. Without it this regressed, and
        // `pnpm parserdiff` caught it in the same run that introduced it.
        expect(ok('var await = 1;', 'unambiguous')).toEqual([]);
        expect(errOf('async function f() { var await = 1 }')?.code).toBe(ParseErrorCode.IdentifierInAsync);
    });
});

describe('constructor form', () => {
    it.each([
        ['a generator', 'class C { *constructor() {} }', ParseErrorCode.ConstructorGenerator],
        ['async', 'class C { async constructor() {} }', ParseErrorCode.ConstructorAsync],
        ['an async generator', 'class C { async *constructor() {} }', ParseErrorCode.ConstructorGenerator],
        ['a getter', 'class C { get constructor() {} }', ParseErrorCode.ConstructorAccessor],
        ['a setter', 'class C { set constructor(v) {} }', ParseErrorCode.ConstructorAccessor],
        ['a string-keyed generator', 'class C { *"constructor"() {} }', ParseErrorCode.ConstructorGenerator],
    ])('rejects a constructor that is %s', (_label, src, code) => {
        expect(errOf(src)?.code).toBe(code);
    });

    it("rejects an element named '#constructor'", () => {
        expect(errOf('class C { #constructor() {} }')?.code).toBe(ParseErrorCode.PrivateNameConstructor);
        expect(ok('class C { #constructorish() {} }')).toEqual([]);
    });

    it('leaves static and computed members named `constructor` alone', () => {
        // A `static constructor` is an ordinary method that happens to share the name, and a
        // computed key is not the name at all. Both oracles accept every form here.
        for (const src of [
            'class C { static *constructor() {} }',
            'class C { static get constructor() {} }',
            'class C { static async constructor() {} }',
            'class C { ["constructor"]() {} }',
            'class C { constructor() {} }',
            'class C { "constructor"() {} }',
            'class C { constructorish() {} }',
        ]) {
            expect(ok(src), src).toEqual([]);
        }
    });
});

describe('`new.target` and arrows', () => {
    it('rejects `new.target` in a top-level arrow', () => {
        // An arrow rebinds neither `this` nor `new.target`, so it cannot INTRODUCE one either.
        // node: "SyntaxError: new.target expression is not allowed here".
        expect(errOf('const f = () => new.target;')?.code).toBe(ParseErrorCode.TopLevelNewTarget);
        expect(errOf('const f = () => { new.target };')?.code).toBe(ParseErrorCode.TopLevelNewTarget);
    });

    it('accepts it when an enclosing function supplies one', () => {
        expect(ok('function f() { return () => new.target }')).toEqual([]);
        expect(ok('class C { m() { return () => new.target } }')).toEqual([]);
        expect(ok('class C { static { new.target } }')).toEqual([]);
    });
});
