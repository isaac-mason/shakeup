// Two lexer bugs, both HARMFUL — valid JavaScript we rejected. Found by enumerating test262's
// harmful buckets, which no plan had ever listed; they were 17 of the ~74 non-`with` misses.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors;

describe('Unicode Zs is whitespace', () => {
    // The set was ` ` and `﻿` only, so every other space class lexed as an identifier
    // character. test262 has one file per class, which is why this was 14 misses rather than one.
    it.each([
        [' ', 'ogham space mark'],
        [' ', 'en quad'],
        [' ', 'em quad'],
        [' ', 'en space'],
        [' ', 'em space'],
        [' ', 'three-per-em space'],
        [' ', 'four-per-em space'],
        [' ', 'six-per-em space'],
        [' ', 'figure space'],
        [' ', 'punctuation space'],
        [' ', 'thin space'],
        [' ', 'hair space'],
        [' ', 'narrow no-break space'],
        [' ', 'medium mathematical space'],
        ['　', 'ideographic space'],
        [' ', 'no-break space'],
        ['﻿', 'byte order mark'],
    ])('%s separates tokens (%s)', (ws) => {
        const src = `var x = /a/g${ws};`;
        expect(() => new Function(src), 'node must agree it is valid').not.toThrow();
        expect(errs(src)).toEqual([]);
        expect(errs(`var${ws}y = 1;`)).toEqual([]);
    });
});

describe('a block comment spanning a line break triggers ASI', () => {
    // The probe was `indexOf('\\n')`, so a comment whose only line break was CR, U+2028 or U+2029
    // did not count — and the statement after it did not get its automatic semicolon.
    it.each([
        ['\r', 'carriage return'],
        [' ', 'line separator'],
        [' ', 'paragraph separator'],
    ])('%s inside a comment counts as a newline (%s)', (br) => {
        const src = `var x = 1/*${br}*/var y = 2;`;
        expect(() => new Function(src), 'node must agree it is valid').not.toThrow();
        expect(errs(src)).toEqual([]);
    });

    it('a comment with no line break still does NOT trigger ASI', () => {
        expect(errs('var x = 1/* c */var y = 2;')).not.toEqual([]);
    });
});
