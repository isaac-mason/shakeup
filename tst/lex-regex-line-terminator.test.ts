// A regex literal may not span a line. `RegularExpressionChar` excludes LineTerminator, and so does
// the `RegularExpressionNonTerminator` that may follow a backslash — so `/a\⏎b/` is unterminated
// exactly as `/a⏎b/` is.
//
// The bug was the one that keeps recurring in this lexer: only `\n` was treated as a terminator.
// `\r`, U+2028 and U+2029 are the other three, and the line-comment scanner had the identical hole —
// where it was worse than a missed error, because a comment that never ended silently discarded the
// rest of the file (ROADMAP §0). The shared `isLineTerminator` helper now names all four in one
// place so the next scanner cannot repeat it.
//
// U+2028 / U+2029 are written as `\u` ESCAPES, not literal characters. Written literally they survive
// some edits and not others — this file lost them once while being written — and a degraded fixture
// would still PASS, because `/a b/` is a valid regex that neither oracle rejects. The escape is what
// the parser sees either way. `the fixtures really contain what they claim` asserts the code points
// of the actual array below, so a future "simplification" back to literals cannot pass quietly.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors;

const SPANNING: [string, string][] = [
    ['LF', 'var x = /a\nb/;'],
    ['CR', 'var x = /a\rb/;'],
    ['LS', 'var x = /a\u2028b/;'],
    ['PS', 'var x = /a\u2029b/;'],
    ['bare CR', '/\r/'],
    ['inside a class', 'var x = /[a\nb]/;'],
    ['after a backslash, LF', 'var x = /a\\\nb/;'],
    ['after a backslash, CR', 'var x = /a\\\rb/;'],
];

describe('a line terminator ends a regex literal', () => {
    it('the fixtures really contain what they claim', () => {
        const codePointOf = (name: string) => {
            const src = SPANNING.find(([n]) => n === name)?.[1] ?? '';
            return src.codePointAt(10);
        };
        expect(codePointOf('LF')).toBe(10);
        expect(codePointOf('CR')).toBe(13);
        expect(codePointOf('LS')).toBe(0x2028);
        expect(codePointOf('PS')).toBe(0x2029);
    });

    it.each(SPANNING)('%s', (_name, src) => {
        expect(() => new Function(src), `node must agree ${JSON.stringify(src)} is invalid`).toThrow();
        expect(errs(src), JSON.stringify(src)).not.toEqual([]);
    });

    it('reports oxc’s message', () => {
        expect(errs('var x = /a\rb/;')[0].msg).toBe('unterminated regex');
    });
});

describe('what stays legal', () => {
    it.each([
        'var x = /ab/;',
        'var x = /a\\nb/;',
        'var x = /[a-z]+/gi;',
        'var x = /[/]/;',
        'var x = /a\\/b/;',
        'var x = /\\r\\n/;',
        'var x = /a{1,2}/;',
        'var x = /(?<name>a)/u;',
        'var x = /[\\]]/;',
        'x = a / b / c;',
    ])('%s', (src) => {
        expect(() => new Function(src), `node must agree ${src} is valid`).not.toThrow();
        expect(errs(src), src).toEqual([]);
    });

    it('an ESCAPED terminator is text, not a line break', () => {
        // `/\r/` written as backslash-r is the escape and stays legal; only a RAW carriage return
        // ends the literal. The test262 fixture that found this bug is the raw one.
        expect(errs('var x = /\\r/;')).toEqual([]);
        expect(errs('var x = /\r/;')).not.toEqual([]);
    });
});
