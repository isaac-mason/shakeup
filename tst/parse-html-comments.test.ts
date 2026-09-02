// Annex B.1.1 HTML-like comments. Legacy web compatibility, and oxc implements them — so not having
// them was a divergence, not a scoping choice.
//
// `<!--` opens a line comment anywhere; `-->` only where it is the first token on its line, which is
// what keeps `x --> y` meaning `x-- > y`. Script-only: in a real module goal both stay ordinary
// punctuation and the parser rejects them. oxc `lexer/punctuation.rs:21-80`.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string, kind?: string) => parse(src, { ts: false, jsx: false, ...(kind ? { kind } : {}) } as never).errors;

describe('script goal accepts HTML-like comments', () => {
    it.each(['var x=0;\n--> c\nx;', 'var x=0; <!-- c', '<!-- c\nvar x=1;', 'var x = 1 <!--2;', 'var a=1;\n-->\na;'])(
        '%s',
        (src) => {
            expect(() => new Function(src), 'node must agree it is valid').not.toThrow();
            expect(errs(src), src).toEqual([]);
        },
    );
});

describe('but never at the cost of real operators', () => {
    // `-->` mid-line is post-decrement followed by `>`. Getting this wrong would silently change
    // the meaning of ordinary arithmetic.
    it.each(['x --> y;', 'x-->y;', 'a-- > b;', '1 < 2;', 'a < b;'])('%s stays an operator', (src) => {
        expect(() => new Function(src)).not.toThrow();
        expect(errs(src), src).toEqual([]);
    });
});

describe('module goal rejects them', () => {
    it.each(['var x=0;\n--> c\nx;', 'var x=0; <!-- c', '<!-- c\nvar x=1;'])('%s', (src) => {
        expect(errs(src, 'module'), src).not.toEqual([]);
    });

    it('while ordinary operators still parse there', () => {
        expect(errs('x --> y;', 'module')).toEqual([]);
        expect(errs('1 < 2;', 'module')).toEqual([]);
    });
});
