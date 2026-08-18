import { describe, expect, it } from 'vitest';
import { formatError, ParseErrorCode } from '../src/parser/errors.ts';
import { parse } from '../src/parser';

const first = (src: string, ts = true, jsx = false) => parse(src, { ts, jsx }).errors[0];

describe('errors.ts', () => {
    it('every code has a template', () => {
        for (const [name, code] of Object.entries(ParseErrorCode)) {
            const msg = formatError(code, []);
            expect(msg, `missing template for ${name}`).toBeTruthy();
        }
    });

    it('substitutes %0', () => {
        expect(formatError(ParseErrorCode.Expected, ["';'"])).toBe("expected ';'");
        expect(formatError(ParseErrorCode.ExpectedInJSX, ["'}'"])).toBe("expected '}' in JSX");
        expect(formatError(ParseErrorCode.UnexpectedChar, ['@'])).toBe("unexpected character '@'");
    });

    it('parse sites carry the right code + message (unchanged wording)', () => {
        const oc = first('new a?.b()');
        expect(oc.code).toBe(ParseErrorCode.NewOptionalChain);
        expect(oc.msg).toBe('optional chain is not allowed in a new expression');

        const tag = first('a?.b`x`');
        expect(tag.code).toBe(ParseErrorCode.TaggedOptionalChain);
        expect(tag.msg).toBe('tagged template cannot be used with an optional chain');

        // expectP funnels the "expected 'X'" family through one parameterized code.
        const paren = first('foo(1');
        expect(paren.code).toBe(ParseErrorCode.Expected);
        expect(paren.msg).toBe("expected ')'");
    });

    it('unexpected-token messages name the offending token', () => {
        const e = first('1 + @', false);
        expect(e.code).toBe(ParseErrorCode.UnexpectedInExpression);
        expect(e.msg).toBe("unexpected token '@' in expression");
    });
});
