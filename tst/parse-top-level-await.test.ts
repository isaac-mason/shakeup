// `await` in a file whose module goal is not declared yet.
//
// We used to seed await-as-OPERATOR for the permissive `unambiguous` goal, which made `var await = 1`
// unparseable — legal script that a bundler must handle. Flipping the seed just broke the other
// direction. oxc resolves it per OCCURRENCE with a one-token peek (`is_unambiguous_await`,
// `js/expression.rs:1685`): `await x` can only be the operator, while `await;`, `await = 1`,
// `await instanceof F` and `await (x)` can only be the identifier. No re-parse, no deferred errors.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string, kind: string) => parse(src, { ts: false, jsx: false, kind } as never).errors;

describe('goal undeclared: the next token decides', () => {
    it.each([
        ['var await = 1; await;', 'identifier — nothing can follow `await;`'],
        ['await: 1;', 'a label'],
        ['x = await;', 'identifier'],
        ['await = 1;', 'identifier — `=` cannot start an operand'],
        ['var x = await instanceof Function;', 'identifier — a binary operator follows'],
        ['await (x);', 'a CALL to a function named await'],
        ['await\nx;', 'a line break makes it ASI-ambiguous, so identifier'],
        ['({ await: 1 });', 'a property name'],
    ])('%s is the identifier (%s)', (src) => {
        expect(errs(src, 'unambiguous'), src).toEqual([]);
    });

    it.each([
        ['await x;', 'an identifier cannot be followed by another'],
        ["const ns = await import('x'); ns.a;", ''],
        ['import y from "m"; await x;', ''],
    ])('%s is the operator (%s)', (src) => {
        expect(errs(src, 'unambiguous'), src).toEqual([]);
    });
});

describe('a DECLARED goal is not permissive', () => {
    it('a script rejects top-level await', () => {
        expect(() => new Function('await x;')).toThrow();
        expect(errs('await x;', 'commonjs')).not.toEqual([]);
    });

    it('…which is what keeps `await(1)` a call there', () => {
        expect(errs('await(1);', 'commonjs')).toEqual([]);
    });

    it('a module rejects await as an identifier', () => {
        expect(errs('var await = 1;', 'module')).not.toEqual([]);
    });
});

describe('the peek does not leak into scopes that reserve await', () => {
    // A class static block is not a function scope, so a naive "top level" test lets the peek fire
    // there. node rejects it; oxc ACCEPTS it, and node is right.
    it('a class static block reserves await', () => {
        expect(() => new Function('class C { static { await x } }')).toThrow();
        expect(errs('class C { static { await x } }', 'unambiguous')).not.toEqual([]);
        expect(errs('class C { static { await x } }', 'module')).not.toEqual([]);
    });

    it.each(['async function o(){ function i(){ await x } }', 'async function o(){ const i = () => { await x } }'])(
        'a non-async function nested in an async one does not inherit await: %s',
        (src) => {
            expect(errs(src, 'module'), src).not.toEqual([]);
        },
    );
});
