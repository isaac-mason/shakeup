import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser';
import { formatError, ParseErrorCode } from '../src/parser/errors.ts';

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

// Found by `pnpm parserdiff` — oxc rejects an unterminated literal in every module goal, and shakeup
// accepted all three SILENTLY. `export const x = 'abc` parsed with `errors: []` and emitted
// `const x = 'abc;`, itself invalid JavaScript: a build that reported success produced a bundle that
// cannot load. An unterminated string also swallowed the rest of the file, since nothing stopped the
// scan at a line terminator.
describe('unterminated literals', () => {
    const msgs = (src: string) =>
        parse(src, { ts: false, jsx: false })
            .errors.map((e) => e.msg)
            .join(' | ');

    it('reports an unterminated string', () => {
        expect(msgs("var s = 'abc")).toMatch(/unterminated string/);
    });

    it('reports a string containing a raw line terminator', () => {
        // Only an ESCAPED line terminator may span lines; a raw one ends the literal.
        expect(msgs("var s = 'abc\ndef';")).toMatch(/unterminated string/);
    });

    it('reports a lone opening quote at end of input', () => {
        // The `closed` flag exists for exactly this: inspecting the previous character instead would
        // read the OPENING quote back and conclude the literal was terminated.
        expect(msgs("var s = '")).toMatch(/unterminated string/);
    });

    it('reports an unterminated template', () => {
        expect(msgs('var s = `abc')).toMatch(/unterminated template/);
    });

    it('reports an unterminated block comment', () => {
        expect(msgs('var s = 1; /* abc')).toMatch(/unterminated block comment/);
    });

    it.each([
        ['a plain string', "var s = 'abc';"],
        ['a string ending at EOF', "var s = 'abc'"],
        ['an escaped line continuation', "var s = 'a\\\nb';"],
        ['an escaped quote', "var s = 'a\\'b';"],
        ['a double-quoted string', 'var s = "abc";'],
        ['a template with a substitution', 'var s = `a${1}b`;'],
        ['a nested template', 'var s = `a${`b${c}d`}e`;'],
        ['a closed block comment', 'var s = 1; /* ok */'],
        ['a line comment at EOF', 'var s = 1; // ok'],
    ])('does not misfire on %s', (_label, src) => {
        expect(msgs(src)).not.toMatch(/unterminated/);
    });
});

// Found by `pnpm parsercorpus` — parsing every JS file in webpack/rspack/vite with shakeup and with
// the real oxc parser. 38 real files failed on this alone.
//
// The grammar's restriction is `async [no LineTerminator here] ArrowFunction`: it sits BETWEEN
// `async` and its parameters. shakeup tested `F_NL` on the `async` token itself, which asks whether
// there was a newline BEFORE `async` — always legal. So any multiline call taking an async arrow
// argument failed with `expected ')'`, which is about as common a shape as JavaScript has.
describe('async arrows after a line break', () => {
    const ok = (src: string) => parse(src, { ts: false, jsx: false }).errors.map((e) => e.msg);

    it.each([
        ['a newline before the argument', 'f("P",\n async (d) => { return 1; });'],
        ['every argument on its own line', 'f(\n "P",\n async (d) => {\n  return 1;\n }\n);'],
        ['a bare-parameter async arrow after a newline', 'f(\n async d => d);'],
        ['a zero-parameter async arrow after a newline', 'f(\n async () => 1);'],
        ['assignment across a line break', 'const g =\n async (d) => d;'],
        ['inside an array literal', '[\n async (d) => d,\n];'],
    ])('accepts %s', (_label, src) => {
        expect(ok(src)).toEqual([]);
    });

    it.each([
        ['a single-line call', 'f("P", async (d) => 1);'],
        ['`async` as a plain identifier', 'var async = 1; async;'],
        ['`async` then a newline then a call', 'async\n(d);'],
        ['an async function declaration', 'async function f() {}'],
        ['`async` then a newline then `function`', 'async\nfunction f() {}'],
        ['an async method', 'const o = { async m() {} };'],
    ])('does not regress %s', (_label, src) => {
        expect(ok(src)).toEqual([]);
    });
});
