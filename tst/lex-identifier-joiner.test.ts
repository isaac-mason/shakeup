// ZWNJ (U+200C) and ZWJ (U+200D) are IdentifierPart but NOT IdentifierStart. So `a‍b` is an
// identifier and `‍a` is not — escaped or literal, and both oracles agree on every combination.
//
// The lexer used to hand-list these two as its ONLY position-sensitive code points, treating every
// other non-ASCII character as an identifier character. It now carries the real tables — `\p{ID_Start}`
// and `\p{ID_Continue}`, which the engine already ships — so the pair falls out for free rather than
// being special-cased, and the cases this file used to pin as "legal by design" are judged on their
// merits instead. One of them, `var \u{1F600}`, turned out to be invalid JavaScript that both node
// and oxc reject; it had survived because the "what stays legal" block did not consult node. It does
// now.
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

    // A wrong character class here would reject real code in bulk, so the shapes that must keep
    // working are pinned rather than left to `pnpm parsercorpus` to discover — and every one is
    // checked against node first, which is what a pin is worth.
    it.each([
        'var abc;',
        'var $a, _b, a1;',
        'var café;',
        'var Ünïcödé;',
        'var 変数;',
        'var переменная;',
        'var \\u0061bc;',
        'var π = 3;',
        'class C { \\u0061field; }',
        'var obj = { a\\u200D_b: 1 };',
    ])('%s', (src) => {
        expect(() => new Function(src), `node must agree ${JSON.stringify(src)} is valid`).not.toThrow();
        expect(errs(src), src).toEqual([]);
    });

    // Astral code points split both ways, so a per-code-UNIT test would be wrong in both directions:
    // an emoji is no identifier character at all, while `\u{1D400}` MATHEMATICAL BOLD CAPITAL A is a
    // perfectly ordinary `ID_Start` letter. Testing the lone high surrogate would have rejected the
    // second — a harmful regression, not a missing error — which is why the scan joins the pair.
    it.each(['var \\u{1F600};', `var ${String.fromCodePoint(0x1f600)};`])('rejects the astral non-letter %s', (src) => {
        expect(() => new Function(src), `node must agree ${JSON.stringify(src)} is invalid`).toThrow();
        expect(errs(src)[0].msg).toBe(`Invalid Character \`${String.fromCodePoint(0x1f600)}\``);
    });

    it.each([`var ${String.fromCodePoint(0x1d400)};`, `var a${String.fromCodePoint(0x1d400)}b;`])(
        'accepts the astral letter %s',
        (src) => {
            expect(() => new Function(src), `node must agree ${JSON.stringify(src)} is valid`).not.toThrow();
            expect(errs(src), src).toEqual([]);
        },
    );

    // A PRIVATE name has its own scan loop, and its own fixture for the same reason: without one,
    // that loop's whole character test could be deleted and every other test still passed.
    it.each([
        ['class C { #a' + String.fromCodePoint(0x2e2f) + '; }', false],
        ['class C { #a' + String.fromCodePoint(0x1f600) + '; }', false],
        ['class C { #a' + String.fromCodePoint(0x1d400) + '; }', true],
        ['class C { #' + String.fromCodePoint(0x1d400) + '; }', true],
        ['class C { #\u5909\u6570; }', true],
    ])('a private name: %s', (src, ok) => {
        const nodeAccepts = (() => {
            try {
                new Function(src);
                return true;
            } catch {
                return false;
            }
        })();
        expect(nodeAccepts, `node's verdict on ${JSON.stringify(src)}`).toBe(ok);
        expect(errs(src).length === 0, src).toBe(ok);
    });

    // A MIXED identifier — part escape, part raw — re-enters the escaped scanner from the name's
    // start, so its raw branch has to classify non-ASCII characters too. Without a fixture here the
    // whole branch could be deleted and every other test still passed.
    it.each([
        ['var a\\u0062' + String.fromCodePoint(0x2e2f) + ';', false],
        ['var a\\u0062' + String.fromCodePoint(0x1f600) + ';', false],
        ['var a\\u0062' + String.fromCodePoint(0x1d400) + ';', true],
        ['var ' + String.fromCodePoint(0x1d400) + '\\u0062;', true],
    ])('a mixed escaped/raw identifier: %s', (src, ok) => {
        const nodeAccepts = (() => {
            try {
                new Function(src);
                return true;
            } catch {
                return false;
            }
        })();
        expect(nodeAccepts, `node's verdict on ${JSON.stringify(src)}`).toBe(ok);
        expect(errs(src).length === 0, src).toBe(ok);
    });

    // U+2E2F VERTICAL TILDE derives as a letter but is `Pattern_Syntax`, which `ID_Start` excludes —
    // the case the accept-everything lexer got wrong, and four of test262's rejections.
    it.each(['var a\\u2E2F;', 'var \\u2E2Fa;', `var a${String.fromCodePoint(0x2e2f)};`])(
        'rejects %s, which derives as a letter but is Pattern_Syntax',
        (src) => {
            expect(() => new Function(src), `node must agree ${JSON.stringify(src)} is invalid`).toThrow();
            expect(errs(src), src).not.toEqual([]);
        },
    );
});
