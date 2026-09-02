// ZWNJ (U+200C) and ZWJ (U+200D) are IdentifierPart but NOT IdentifierStart. So `a‍b` is an
// identifier and `‍a` is not — escaped or literal, and both oracles agree on every combination.
//
// These are the ONLY two code points this lexer distinguishes by position. It otherwise treats every
// non-ASCII character as an identifier character rather than carrying the Unicode ID_Start /
// ID_Continue tables, which is a deliberate simplification documented on `scanEscapedIdent`: applying
// real tables to escapes alone would reject `\u{1F600}` while accepting the same emoji written
// literally. Two named exceptions are not those tables, and this test does not claim otherwise — the
// "what stays legal" block below pins exactly how permissive the lexer remains.
//
// Every fixture writes the joiners as `\u` ESCAPES or builds them with `String.fromCharCode`. Written
// literally they are INVISIBLE, so a normalised or deleted one leaves a fixture that still passes
// while testing nothing. The first test asserts the code points directly.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors;
const ZWJ = String.fromCharCode(0x200d);
const ZWNJ = String.fromCharCode(0x200c);

describe('a joiner control may not start an identifier', () => {
    it('the fixtures really contain the joiners', () => {
        expect(ZWJ.codePointAt(0)).toBe(0x200d);
        expect(ZWNJ.codePointAt(0)).toBe(0x200c);
    });

    it.each([
        ['escaped ZWJ, class field', 'var C = class { \\u200D_ZWJ; };'],
        ['escaped ZWNJ, class field', 'var C = class { \\u200C_ZWNJ; };'],
        ['escaped ZWJ, var', 'var \\u200D_a;'],
        ['escaped ZWNJ, var', 'var \\u200C_a;'],
        ['literal ZWJ, var', `var ${ZWJ}a;`],
        ['literal ZWNJ, var', `var ${ZWNJ}a;`],
        ['literal ZWJ, function name', `function ${ZWJ}f(){}`],
    ])('%s', (_name, src) => {
        expect(() => new Function(src), `node must agree ${JSON.stringify(src)} is invalid`).toThrow();
        expect(errs(src), JSON.stringify(src)).not.toEqual([]);
    });

    it('reports oxc’s message, with the character in it', () => {
        expect(errs(`var ${ZWJ}a;`)[0].msg).toBe(`Invalid Character \`${ZWJ}\``);
        expect(errs('var \\u200C_a;')[0].msg).toBe(`Invalid Character \`${ZWNJ}\``);
    });
});

describe('what stays legal', () => {
    it.each([
        ['ZWJ as a part, literal', `var a${ZWJ}b;`],
        ['ZWNJ as a part, literal', `var a${ZWNJ}b;`],
        ['ZWJ as a part, escaped', 'var a\\u200D_b;'],
        ['ZWNJ as a part, escaped', 'var a\\u200C_b;'],
    ])('%s', (_name, src) => {
        expect(() => new Function(src), `node must agree ${JSON.stringify(src)} is valid`).not.toThrow();
        expect(errs(src), JSON.stringify(src)).toEqual([]);
    });

    // The lexer stays permissive about every OTHER non-ASCII character, by design. A wrong character
    // class here would reject real code in bulk, so the shapes that must keep working are pinned
    // rather than left to `pnpm parsercorpus` to discover.
    it.each([
        'var abc;',
        'var $a, _b, a1;',
        'var café;',
        'var Ünïcödé;',
        'var 変数;',
        'var переменная;',
        'var \\u0061bc;',
        'var \\u{1F600};',
        'var π = 3;',
        'class C { \\u0061field; }',
        'var obj = { a\\u200D_b: 1 };',
    ])('%s', (src) => {
        expect(errs(src), src).toEqual([]);
    });
});
