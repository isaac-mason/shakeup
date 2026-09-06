import { describe, expect, it } from 'vitest';
import { parseWithDiagnostics } from '../src/parser/parser.ts';

// A bare `#name` is only ever the LEFT operand of `in` — the ergonomic brand check. shakeup accepted
// it anywhere an expression was allowed. Verified against `oxc-parser` on 11 shapes.
//
// The rule needs TWO tests, which is the interesting part. A lookahead at the primary site ("the next
// token must be `in`") catches `#f;` and `x in #f;`, but NOT `#f in #f in this`: that parses as
// `(#f in #f) in this`, and the inner `#f` genuinely is followed by `in`. Being the RIGHT operand is
// only visible once the binary node is built, so `parseBinary` checks that separately.
const accepts = (src: string): boolean =>
    parseWithDiagnostics(src, { ts: false, jsx: false, kind: 'unambiguous' }).errors.length === 0;

describe('a private name is only the left operand of `in`', () => {
    it('rejects a bare private name', () => {
        expect(accepts('class C { #f; m() { #f; } }')).toBe(false);
    });

    it('rejects a private name as the RIGHT operand of `in`', () => {
        expect(accepts('class C { #f; m() { x in #f; } }')).toBe(false);
    });

    it('rejects the nested form the lookahead alone cannot see', () => {
        // `#f in #f in this` is `(#f in #f) in this`. The second `#f` IS followed by `in`, so only
        // the `parseBinary` test catches it. This is the test262 fixture.
        expect(accepts('class C { #f; m() { #f in #f in this; } }')).toBe(false);
    });

    it('leaves the brand check and ordinary private access alone', () => {
        for (const src of [
            'class C { #f; m() { #f in this; } }',
            'class C { #f; m() { (#f in this); } }',
            'class C { #f; m() { #f in this in x; } }', // `(#f in this) in x` — the LHS is fine
            'class C { #f; m() { #f in this && 1; } }',
            'class C { #f; #g; m() { #f in this || #g in this; } }',
            'class C { #f; m() { if (#f in this) return 1; } }',
            'class C { #f; m() { this.#f; } }',
            'class C { #f; m() { this.#f = 1; } }',
        ])
            expect(accepts(src), src).toBe(true);
    });
});
