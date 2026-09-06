import { describe, expect, it } from 'vitest';
import { parseWithDiagnostics } from '../src/parser/parser.ts';

// `({} = 1)` is a destructuring assignment. `({}) = 1` is a SyntaxError — the parentheses stop the
// cover grammar reinterpreting the literal as a pattern, so what is left is an attempt to assign to
// an object literal. A parenthesised IDENTIFIER or member is unaffected: `(x) = 1` and `(x.y) = 1`
// are both fine, and so is `((x)) = 1`.
//
// shakeup accepted every parenthesised form. Three test262 fixtures under
// `language/expressions/assignmenttargettype` are exactly this rule — `({}) = 1`,
// `() => ({}) = 1`, `async () => ({}) = 1` — and oxc rejects all of them with "Cannot assign to this
// expression". Verified against `oxc-parser` on 23 shapes before writing it.
//
// Parentheses are not kept in the AST and `Node` has no flags word (its shape is fixed
// deliberately), so the parser records the start offsets of parenthesised object and array literals
// in `ParserState.parenLiteral`, alongside `coverInit`.
const accepts = (src: string): boolean =>
    parseWithDiagnostics(src, { ts: false, jsx: false, kind: 'unambiguous' }).errors.length === 0;

describe('a parenthesised destructuring target', () => {
    it('is rejected as an assignment target', () => {
        for (const src of ['({}) = 1;', '([]) = 1;', '({a}) = 1;', '([a]) = 1;', '(({a})) = b;'])
            expect(accepts(src), src).toBe(false);
    });

    it('is rejected in a for-in/of head', () => {
        for (const src of ['for (({}) of x) ;', 'for (({}) in x) ;']) expect(accepts(src), src).toBe(false);
        expect(accepts('for ({} of x) ;'), 'unparenthesised is fine').toBe(true);
    });

    it('is rejected when NESTED inside another pattern', () => {
        for (const src of ['[({})] = x;', '({ a: ({}) } = x);']) expect(accepts(src), src).toBe(false);
    });

    it('is rejected inside an arrow body', () => {
        // The three test262 fixtures this came from.
        for (const src of ['() => ({}) = 1;', 'async () => ({}) = 1;']) expect(accepts(src), src).toBe(false);
    });

    it('leaves the unparenthesised forms, and parenthesised SIMPLE targets, alone', () => {
        for (const src of [
            '({} = 1);',
            '([] = 1);',
            '({a} = b);',
            '([a] = b);',
            '(x) = 1;', // a parenthesised identifier IS assignable
            '(x.y) = 1;',
            '((x)) = 1;',
            '({a} = b) => a;',
            'var {a} = b;',
            '[a, ...b] = c;',
            '({...a} = b);',
        ])
            expect(accepts(src), src).toBe(true);
    });
});
