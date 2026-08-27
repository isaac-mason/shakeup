import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import { ParseErrorCode } from '../src/parser/errors.ts';
import { parseWithDiagnostics } from '../src/parser/parser.ts';

// P1 item 5 of the alignment plan: `var a = 5; a` evaluates to 5 in node — valid JavaScript
// that shakeup REJECTED with `unexpected character '\'`. Rejecting valid input is the harmful
// direction regardless of how rare it is.
//
// The interner keys every identifier by SOURCE POSITION, which is why this was real work: the
// source says `a` and the name is `a`, so an escaped identifier needs a cooked value and a
// string-keyed intern. The slow path is entered only from the branch that was already ending the
// identifier loop, so the ordinary identifier scan — the parser's hottest loop — is untouched.
const parse = (src: string) => parseWithDiagnostics(src, { ts: false, jsx: false, kind: 'module' });
const errOf = (src: string) => parse(src).errors[0];
const ok = (src: string) => parse(src).errors;

describe('escaped identifiers', () => {
    it.each([
        ['a whole identifier', 'var \\u0061 = 1; a;'],
        ['an escape in continue position', 'var a\\u0062c = 1; abc;'],
        ['several escapes', 'var \\u0061\\u0062 = 1;'],
        ['the `\\u{…}` form', 'var \\u{61}bc = 1;'],
        ['a member name', 'o.\\u0061;'],
        ['a property key', 'var x = { \\u0061: 1 };'],
        ['a class name', 'class \\u0043 {}'],
        ['a function name', 'function \\u0066(){}'],
        ['a digit in continue position', 'var a\\u0031 = 1;'],
        ['a non-ASCII escape', 'var \\u00e9 = 1;'],
        ['a label', 'label\\u0031: for (;;) break label1;'],
        ['an import alias', 'import { a as \\u0062 } from "m";'],
        ['an export specifier', 'var \\u0061 = 1; export { \\u0061 };'],
        ['an assignment target', 'a\\u0062c = 1;'],
    ])('accepts %s', (_label, src) => {
        expect(ok(src), src).toEqual([]);
    });

    it('binds the DECODED name, not the source text', async () => {
        // The product, not the feature: two spellings of the same name must be the same binding,
        // and the bundle must run.
        const r = await bundle({
            entry: '/main.js',
            external: [],
            fs: createMemoryFs({
                '/dep.js': 'export const \\u0076alue = 41;\nexport function \\u0066n(a\\u0062c) { return a\\u0062c + 1; }',
                '/main.js': 'import { value, fn } from "./dep.js";\nexport const x = fn(value);',
            }),
        });
        expect(r.errors).toEqual([]);
        const m = (await import(`data:text/javascript,${encodeURIComponent(r.code)}`)) as { x: number };
        expect(m.x).toBe(42);
    });

    it('keeps the source SPAN even though the name is cooked', () => {
        // Positions come from the escaped source; only the name is decoded. A span taken from the
        // cooked length would point into the middle of the next token.
        const p = parse('var \\u0061bc = 1;');
        expect(p.errors).toEqual([]);
        expect(p.program.data.body).toHaveLength(1);
    });

    it.each([
        ['a leading digit', 'var \\u0031 = 1;', ParseErrorCode.InvalidEscapedIdentChar],
        ['a space', 'var \\u0020 = 1;', ParseErrorCode.InvalidEscapedIdentChar],
        ['a `\\x` escape', 'var \\x61 = 1;', ParseErrorCode.InvalidUnicodeEscape],
        ['a truncated escape', 'var \\u00;', ParseErrorCode.InvalidUnicodeEscape],
        ['a bare backslash-u', 'var \\u;', ParseErrorCode.InvalidUnicodeEscape],
    ])('rejects %s', (_label, src, code) => {
        expect(errOf(src)?.code).toBe(code);
    });

    it('rejects a surrogate pair written as two escapes', () => {
        // `😀` is two lone surrogates, not one code point, and neither half is a valid
        // identifier character on its own. oxc rejects it; so does this.
        expect(errOf('var \\uD83D\\uDE00 = 1;')?.code).toBe(ParseErrorCode.InvalidUnicodeEscape);
    });

    it('rejects an escaped RESERVED word where the word would be reserved', () => {
        expect(errOf('var \\u0069f = 1;')?.code).toBe(ParseErrorCode.EscapedKeyword);
        expect(errOf('var \\u0074his = 1;')?.code).toBe(ParseErrorCode.EscapedKeyword);
    });

    it('allows the same spelling where a reserved word is legal', () => {
        // The split is exactly `parseIdent` vs `parseNameAsIdent`: a property key and a member name
        // may be reserved words, so an escaped one stays legal there.
        expect(ok('var a = { \\u0069f: 1 };')).toEqual([]);
        expect(ok('x.\\u0069f;')).toEqual([]);
    });

    it('allows an escaped CONTEXTUAL keyword as an identifier', () => {
        // `async`, `let` and friends are not reserved, so nothing about the escape makes them so.
        expect(ok('var \\u0061sync = 1;')).toEqual([]);
    });
});
