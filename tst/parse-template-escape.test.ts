// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are JS SOURCE under test,
// so `${x}` inside a quoted string is the subject, not a mistaken template literal.
// An undefined escape sequence is an error in an UNTAGGED template and legal in a TAGGED one. That
// split is the whole rule: a tag receives the raw strings plus a `cooked` of `undefined`, so
// `` tag`\x` `` has a meaning, while `` `\x` `` has only the cooked value and so has none.
//
// It is therefore not something the lexer can decide. `scanTemplatePart` records `F_BAD_ESCAPE` on
// the token and `parseTemplate` raises or not depending on a `tagged` flag its CALLER passes, since
// only the caller knows whether a tag preceded the backtick. oxc reaches the same answer the same
// way, with one message for every bad form; node distinguishes them further ("Invalid hexadecimal
// escape sequence", "Octal escape sequences are not allowed in template strings") but agrees case for
// case on accept/reject, which is what the fixtures below assert.
//
// Only the forms a template can get wrong are checked: `\x` and `\u` need their digits, and the
// legacy octal / `\8` / `\9` escapes that sloppy STRING literals may still carry are never legal in a
// template. `\n`, `\0`, and an unknown-but-harmless `\q` all stay legal.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors;

describe('an untagged template rejects an undefined escape', () => {
    it.each([
        '`\\x`;',
        '`\\x4`;',
        '`\\xg`;',
        '`\\u`;',
        '`\\u00`;',
        '`\\u{}`;',
        '`\\u{G}`;',
        '`\\01`;',
        '`\\1`;',
        '`\\8`;',
        '`\\9`;',
        '`${x}\\x`;',
        '`a${x}b${y}\\u`;',
    ])('%s', (src) => {
        expect(() => new Function(src), `node must agree ${src} is invalid`).toThrow();
        expect(errs(src), src).not.toEqual([]);
    });

    it('reports oxc’s message', () => {
        expect(errs('`\\x`;')[0].msg).toBe('Bad escape sequence in untagged template literal');
    });
});

describe('a tagged template accepts the same escapes', () => {
    it.each([
        'tag`\\x`;',
        'tag`\\u`;',
        'tag`\\01`;',
        'tag`\\8`;',
        'tag`${x}\\x`;',
        'String.raw`\\x`;',
        'tag.prop`\\u`;',
        'tag()`\\x`;',
    ])('%s', (src) => {
        expect(() => new Function(src), `node must agree ${src} is valid`).not.toThrow();
        expect(errs(src), src).toEqual([]);
    });
});

describe('what stays legal', () => {
    // A lexer change touches every file, so the escapes ordinary code actually uses are pinned
    // explicitly rather than left to `pnpm parsercorpus` to discover.
    it.each([
        '`plain`;',
        '`a${b}c`;',
        '`\\n\\t\\r\\\\\\``;',
        '`\\0`;',
        '`\\x41\\u0041\\u{1F600}`;',
        '`\\v\\f\\b`;',
        '`\\$`;',
        '`\\{`;',
        '`\\q`;',
        '`${`nested ${x}`}`;',
        '`multi\nline`;',
        '`${a}${b}${c}`;',
        '`\\u{0}`;',
        '`\\u{10FFFF}`;',
        '`a\\\\b`;',
    ])('%s', (src) => {
        expect(() => new Function(src), `node must agree ${src} is valid`).not.toThrow();
        expect(errs(src), src).toEqual([]);
    });

    it('`\\0` is the NUL escape and stays legal, but `\\01` is a legacy octal', () => {
        expect(errs('`\\0`;')).toEqual([]);
        expect(errs('`\\01`;')).not.toEqual([]);
    });
});
