// Two positions where `yield` / `await` are reserved that the earlier passes did not reach.
//
// 1. `void yield` INSIDE A GENERATOR. `yield` is an operator there, and a YieldExpression is not a
//    valid operand for a unary operator — so `void yield` has no parse. It reached `parseIdent` as a
//    plain REFERENCE because `parseUnary` takes its operand directly, never going through the
//    `yield` branch of `parseAssign`. The earlier fix (`640ced7`) only checked the BINDING role.
//    `void (yield)` stays legal: the parentheses make it an expression again.
//
// 2. `await` AS AN IDENTIFIER IN A CLASS STATIC BLOCK. This one needed a new piece of state, because
//    a static block reserves the word without being an async context — the two halves are different
//    rules and oxc splits them across two crates:
//      · `class C { static { var await; } }` — oxc's PARSER rejects it (it sets `[+Await]` there)
//      · `class C { static { await x } }`    — oxc's parser ACCEPTS it and its CHECKER raises
//                                              `class_static_block_await`
//    Having no checker, shakeup keeps both in the parser. The expression half was already settled
//    that way in `parse-top-level-await.test.ts`; this adds the identifier half. `CTX.Await` cannot
//    carry it — setting that bit would make `await x` parse as an AwaitExpression and undo the first
//    half — so a `staticBlockDepth` counter carries it instead.
//
// node agrees with oxc on every case below, which is why they are checked against it directly.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors;
const msg = (src: string) => errs(src)[0]?.msg;

const rejects = (src: string) => {
    expect(() => new Function(src), `node must agree ${src} is invalid`).toThrow();
    expect(errs(src), src).not.toEqual([]);
};

describe('`yield` cannot be a reference inside a generator', () => {
    it.each([
        'function* g() { void yield; }',
        'var gen = function *g() { void yield; };',
        'var gen = async function *() { void yield; };',
        'var C = class {*gen() { void yield; }};',
        'var C = class { static async *gen() { void yield; }};',
        'var obj = { *method() { void yield; } };',
        'var obj = { async *method() { void yield; } };',
        'function* g() { typeof yield; }',
        'function* g() { !yield; }',
    ])('%s', rejects);

    it('reports oxc’s message', () => {
        expect(msg('function* g() { void yield; }')).toBe('cannot use `yield` as an identifier in a generator context');
    });
});

describe('`await` is reserved as an identifier in a class static block', () => {
    it.each([
        'class C { static { var await; } }',
        'class C { static { let await = 1; } }',
        'class C { static { const await = 1; } }',
        'class C { static { function await() {} } }',
        'class C { static { try {} catch (await) {} } }',
        'class C { static { var [await] = []; } }',
        'class C { static { var { await } = {}; } }',
    ])('%s', rejects);

    it('reports oxc’s message', () => {
        expect(msg('class C { static { var await; } }')).toBe('cannot use `await` as an identifier in an async context');
    });

    it('and the await EXPRESSION half still errors, as already decided', () => {
        // `parse-top-level-await.test.ts` records why shakeup rejects this where oxc's parser does
        // not: oxc defers it to `check_class_static_block_await`, and we have no checker.
        expect(errs('class C { static { await x } }')).not.toEqual([]);
    });
});

describe('what stays legal', () => {
    it.each([
        'function* g() { yield; }',
        'function* g() { yield 1; }',
        'function* g() { yield* h(); }',
        'function* g() { void (yield); }',
        'function* g() { var x = yield; }',
        'function* g() { for (const x of y) yield x; }',
        'function f() { void yield; }',
        'var yield = 1;',
        'x.yield;',
        '({ yield: 1 });',
        'class C { static { var x = 1; } }',
        'class C { static { this.x = 1; } }',
        'class C { static { new.target; } }',
        'var await = 1;',
        'function f(await) {}',
        'class C { *m() { yield 1; } }',
    ])('%s', (src) => {
        expect(() => new Function(src), `node must agree ${src} is valid`).not.toThrow();
        expect(errs(src), src).toEqual([]);
    });

    it('the static-block rule does not leak into the class body around it', () => {
        expect(errs('class C { static { var x = 1; } m(await) {} }')).toEqual([]);
        expect(errs('class C { static { var x = 1; } } var await = 2;')).toEqual([]);
    });

    // The reservation applies DIRECTLY in the block and stops at every function boundary, arrows
    // included — both oracles agree, and test262 asserts it directly in
    // `expressions/class/static-init-await-reference.js`. Getting this wrong is not a missed error
    // but a WRONG REJECTION of valid code: a first cut without the boundary took test262's harmful
    // column from 5 to 26, which is why each nesting shape is pinned here rather than sampled.
    it.each([
        'var await = 0; class C { static { function f() { return await; } } }',
        'class C { static { function f() { var await; } } }',
        'var await = 0; class C { static { new (class { constructor(x = await) {} }); } }',
        'var await = 0; class C { static { (() => await); } }',
        'class C { static { (() => { var await; }); } }',
        'class C { static { ({ m() { var await; } }); } }',
        'class C { static { class D { static { var x; } } } }',
    ])('a function boundary inside a static block resets it: %s', (src) => {
        expect(() => new Function(src), `node must agree ${src} is valid`).not.toThrow();
        expect(errs(src), src).toEqual([]);
    });

    it('but a SECOND static block in the same class still reserves it', () => {
        expect(errs('class C { static { var x; } static { var await; } }')).not.toEqual([]);
    });
});
