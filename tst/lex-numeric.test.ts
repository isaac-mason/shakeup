// Numeric literal validation. `scanNumber` scanned permissively — its loop swallowed every ASCII
// identifier character INTO the number token, the exact inverse of the rule oxc leans on hardest
// (`check_after_numeric_literal`, `lexer/numeric.rs:208`).
//
// A first probe put this at "12 of 33 cases". That was wrong by ~10x: oxc needs
// `showSemanticErrors: true` before it reports legacy-octal strict errors at all, because they live
// in oxc_semantic rather than the parser. The real figure was 128 of 201.
//
// node is the oracle here, not oxc — oxc has a bug in this exact area (see the last block).
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const accepted = (src: string) => parse(src, { ts: false, jsx: false }).errors.length === 0;
const agreesWithNode = (src: string): void => {
    let node = true;
    try {
        new Function(src);
    } catch {
        node = false;
    }
    expect(accepted(src), `${src} — node says ${node ? 'valid' : 'invalid'}`).toBe(node);
};

describe('rejects malformed numeric literals', () => {
    it.each([
        ['1_;', 'trailing separator'],
        ['1__0;', 'doubled separator'],
        ['0_1;', 'separator after a lone leading zero'],
        ['1._5;', 'separator leading a fraction'],
        ['1.5_;', 'separator trailing a fraction'],
        ['1e_1;', 'separator leading an exponent'],
        ['1e1_;', 'separator trailing an exponent'],
        ['0x_1;', 'separator leading a radix'],
        ['0x1_;', 'separator trailing a radix'],
        ['0x;', 'radix prefix with no digits'],
        ['0b;', ''],
        ['0o;', ''],
        ['0b2;', 'digit outside the radix'],
        ['0o8;', ''],
        ['0xg;', ''],
        ['1e;', 'exponent with no digits'],
        ['1E;', ''],
        ['1e+;', ''],
        ['1ee1;', 'two exponents'],
        ['1.5n;', 'BigInt suffix on a fraction'],
        ['1e3n;', 'BigInt suffix on an exponent'],
        ['09n;', 'BigInt suffix after a leading zero'],
        ['0777n;', ''],
        ['1N;', 'the suffix is lowercase-only'],
        ['1nn;', ''],
        ['0.toString();', 'a number running straight into an identifier'],
        ['1a;', ''],
        ['1$;', ''],
        ['1e1a;', ''],
        ['1.2.3;', 'two decimal points'],
        ['.5.5;', ''],
    ])('%s (%s)', (src) => {
        expect(() => new Function(src), 'node must agree it is invalid').toThrow();
        expect(accepted(src), src).toBe(false);
    });
});

describe('still accepts every well-formed literal', () => {
    it.each([
        '0;', '1;', '0.5;', '.5;', '5.;', '1e3;', '1E-3;', '0e0;', '.5e3;', '0.5e1;',
        '0x1f;', '0XABCn;', '0b101;', '0o17;', '1n;', '0x1fn;', '0n;',
        '1_000;', '1_000.5;', '0x1_f;', '1_0_0;', '0b1_0;', '0o1_7;', '1e1_0;',
        '01;', '0777;', '08;', '09;', '08.5;', '08e1;', '1..toString();',
    ])('%s', agreesWithNode);

    // oxc BUG, found while specifying this: `read_legacy_octal` (`numeric.rs:121`) matches only
    // lowercase `e`, so oxc rejects `08E1` while accepting `08e1`. node accepts both. We follow node.
    it.each(['08E1;', '09E1;', '08E+1;'])('%s — node, not oxc, is the oracle', agreesWithNode);
});
