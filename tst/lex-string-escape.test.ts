// `\x` and `\u` must be well formed in a STRING literal, in every mode. `\x` needs two hex digits,
// `\uXXXX` needs four, and `\u{…}` needs at least one hex digit, a closing brace, and a value that is
// a real code point — so `"\u{110000}"` is out of range and `"\u{1F_639}"` fails because a numeric
// separator is not a hex digit.
//
// THE BUCKET HAD TO BE SPLIT BEFORE ANY OF THIS WAS WRITTEN. Sitting next to these in the same
// test262 directory are `"\8"` and `"\01"`, which are LEGAL sloppy and errors only under strict mode
// — oxc raises those in `check_string_literal` on `ctx.strict_mode()`, so they are §2b and not this
// rule. Running each fixture through `oxc-parser` twice, with and without `showSemanticErrors`, is
// what separated them; the label "Invalid escape sequence" covers both.
//
// The predicate is shared with the template scanner, because the `\x` / `\u` half of the rule is
// identical there. Templates then add what strings do not have: the legacy octal and `\8` / `\9`
// forms are never legal in a template regardless of mode. Sharing it also fixed a hole on the
// template side — `` `\u{110000}` `` was accepted before, because the first cut checked the braces
// but not the VALUE.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors;

describe('a string rejects a malformed hex or unicode escape', () => {
    it.each([
        '"\\x"',
        '"\\x4"',
        '"\\xZZ"',
        '"\\u"',
        '"\\u1"',
        '"\\uAAA"',
        '"\\u000G"',
        '"\\u{}"',
        '"\\u{G}"',
        '"\\u{1F_639}"',
        '"\\u{110000}"',
        "'\\u'",
        "'\\u{1F_639}'",
    ])('%s', (src) => {
        expect(() => new Function(src), `node must agree ${src} is invalid`).toThrow();
        expect(errs(src), src).not.toEqual([]);
    });

    it('reports oxc’s message', () => {
        expect(errs('"\\u"')[0].msg).toBe('Invalid escape sequence');
    });
});

describe('what stays legal', () => {
    it.each([
        '"\\u0041"',
        '"\\u{1F639}"',
        '"\\u{0}"',
        '"\\u{10FFFF}"',
        '"\\x41"',
        '"\\n\\t\\r"',
        '"\\q"',
        '"\\0"',
        '"\\\\u"',
        '"plain"',
        '"a\\\nb"',
    ])('%s', (src) => {
        expect(() => new Function(src), `node must agree ${src} is valid`).not.toThrow();
        expect(errs(src), src).toEqual([]);
    });

    // The strict-mode neighbours. oxc's PARSER accepts both and raises them in `check_string_literal`
    // on `ctx.strict_mode()`, so accepting them here is what matching oxc means — they are two of the
    // 1,365 misses §2b would close, not a hole in this rule.
    it('legacy octal and `\\8` stay a CHECKER concern, as in oxc', () => {
        expect(errs('"\\01"')).toEqual([]);
        expect(errs('"\\8"')).toEqual([]);
    });

    // A template forbids exactly those two, which is why the predicate is split rather than shared
    // whole. `parse-template-escape.test.ts` owns that half.
    it('but a TEMPLATE still forbids them', () => {
        expect(errs('`\\01`;')).not.toEqual([]);
        expect(errs('`\\8`;')).not.toEqual([]);
    });

    it('and the shared predicate now catches an out-of-range code point in both', () => {
        expect(errs('"\\u{110000}"')).not.toEqual([]);
        expect(errs('`\\u{110000}`;')).not.toEqual([]);
    });
});
