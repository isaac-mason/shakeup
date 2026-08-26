import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

// oxc `replace_known_methods`: `try_fold_number_constants` (lib.rs:480) and the regex `"source"` arm
// (lib.rs:445). Established by DIFFERENTIAL against the real `oxc-minify` package, not by reading the
// Rust — oxc emits `1/0`, `2**53-1` and `2**-52` for these, and we now match.
//
// `Infinity` and `NaN` have no literal form (see fold-constants.ts), so they are spelled `1/0` and
// `0/0` — same length as the identifiers, and unlike a bare `NaN` they cannot be shadowed.
const build = async (body: string): Promise<string> => {
    const src = `let o;\n${body}\nglobalThis.sink = o;\n`;
    const r = await bundle({ entry: '/e.js', fs: createMemoryFs({ '/e.js': src }), external: [], output: { minify: true, optimize: true } } as never);
    return (r as { code: string }).code;
};
/** Run the minified module and hand back what it assigned. */
const evaluate = (code: string): unknown => {
    const g: Record<string, unknown> = {};
    new Function('globalThis', code)(g);
    return g.sink;
};

describe('known Number/RegExp members fold (oxc replace_known_methods)', () => {
    it.each([
        ['Number.NaN', '0/0', Number.NaN],
        ['Number.POSITIVE_INFINITY', '1/0', Number.POSITIVE_INFINITY],
        ['Number.MAX_SAFE_INTEGER', '2**53-1', Number.MAX_SAFE_INTEGER],
        ['Number.EPSILON', '2**-52', Number.EPSILON],
    ])('%s -> %s', async (expr, spelling, value) => {
        const code = await build(`o = ${expr};`);
        expect(code).toContain(spelling);
        expect(code).not.toContain(expr);
        expect(Object.is(evaluate(code), value)).toBe(true);
    });

    it('a regex literal .source folds to its pattern', async () => {
        const code = await build('o = /ab+/gi.source;');
        expect(code).toContain('"ab+"');
        expect(evaluate(code)).toBe('ab+');
    });

    it('parenthesises the folded binary expression where precedence demands it', async () => {
        // The folds emit BinaryExpressions, so any tighter-binding context must parenthesise them.
        const code = await build('o = Number.NaN ** 2;');
        expect(code).toContain('(0/0)**2');
        expect(Object.is(evaluate(code), Number.NaN ** 2)).toBe(true);
    });

    it('leaves a SHADOWED Number alone', async () => {
        // Gated on `sym === 0` (the global). A local binding must suppress the fold entirely.
        const code = await build('{ const Number = { EPSILON: 5 }; o = Number.EPSILON; }');
        expect(code).not.toContain('2**-52');
        expect(evaluate(code)).toBe(5);
    });

    it('leaves an optional access alone', async () => {
        const code = await build('o = Number?.EPSILON;');
        expect(code).not.toContain('2**-52');
        expect(evaluate(code)).toBe(Number.EPSILON);
    });

    it('leaves a regex .source needing escapes alone', async () => {
        // The pattern is re-spelled as a double-quoted string with NO escaping, so a `"` or backslash
        // in the pattern must bail rather than produce a broken literal.
        const code = await build(String.raw`o = /a\d"b/.source;`);
        expect(evaluate(code)).toBe(String.raw`a\d"b`);
    });
});
describe('known call folds (oxc replace_known_methods)', () => {
    it('Array.of(a,b) -> [a,b]', async () => {
        const code = await build('o = Array.of(1, 2);');
        expect(code).toContain('[1,2]');
        expect(evaluate(code)).toEqual([1, 2]);
    });

    it('Array.of with a SPREAD still folds', async () => {
        // `Array.of(...xs)` and `[...xs]` build the same array — unlike `Array(...)`, whose
        // single-numeric-argument form means a length.
        const code = await build('const xs = [1, 2]; o = Array.of(...xs);');
        expect(evaluate(code)).toEqual([1, 2]);
    });

    it('leaves a SHADOWED Array.of alone', async () => {
        const code = await build('{ const Array = { of: () => 9 }; o = Array.of(1, 2); }');
        expect(evaluate(code)).toBe(9);
    });

    it('"a".concat("b","c") -> "abc"', async () => {
        const code = await build('o = "a".concat("b", "c");');
        expect(code).toContain('"abc"');
        expect(code).not.toContain('concat');
        expect(evaluate(code)).toBe('abc');
    });

    it('folds a concat whose parts contain escapes', async () => {
        // The fold splices RAW inner text, so an escape must survive verbatim rather than be decoded.
        const code = await build('o = "a\\n".concat("b");');
        expect(evaluate(code)).toBe('a\nb');
    });

    it('leaves MIXED quote delimiters alone', async () => {
        // Splicing `"a"` with `'b"c'` would terminate the literal early at the inner `"`.
        const code = await build(`o = "a".concat('b"c');`);
        expect(evaluate(code)).toBe('ab"c');
    });

    it('leaves a non-literal concat argument alone', async () => {
        const code = await build('o = "a".concat(String(globalThis.x));');
        expect(code).toContain('concat');
        expect(evaluate(code)).toBe('aundefined');
    });

    it('folds a concat CHAIN across fixed-point rounds', async () => {
        // Innermost folds first; the outer call sees a CallExpression object and bails that round.
        const code = await build('o = "a".concat("b").concat("c");');
        expect(code).not.toContain('concat');
        expect(evaluate(code)).toBe('abc');
    });
});

describe('a constant interpolation folds into the template text', () => {
    it.each([
        ['`x${2}y`', 'x2y'],
        ['`a${1 + 1}b${3}c`', 'a2b3c'],
        ['`${true}`', 'true'],
        ['`${null}`', 'null'],
    ])('%s', async (expr, want) => {
        const code = await build(`o = ${expr};`);
        expect(code).not.toContain('${');
        expect(evaluate(code)).toBe(want);
    });

    it('leaves a STRING interpolation alone', async () => {
        // A string's text can contain a backtick, a backslash or a `${`, and folding it in without
        // escaping would produce a syntax error — or worse, an injected interpolation.
        const code = await build('o = `a${"`b"}c`;');
        expect(evaluate(code)).toBe('a`bc');
    });

    it('leaves a NON-constant interpolation alone', async () => {
        const code = await build('o = `n${String(globalThis.x)}m`;');
        expect(code).toContain('${');
        expect(evaluate(code)).toBe('nundefinedm');
    });
});

describe('typeof comparisons use the loose operator', () => {
    // A CONSTANT operand would let `fold-constants` reduce `typeof x` to its literal type first, so
    // the rule under test would never see a `typeof` at all. Use a runtime value.
    it.each([
        ['typeof x === "number"', true],
        ['typeof x !== "number"', false],
        ['"number" === typeof x', true],
    ])('%s', async (expr, want) => {
        const code = await build(`const x = Number(globalThis.q ?? 1);\no = ${expr};`);
        expect(code).not.toContain('==='); // `typeof` always yields a string, so `==` is identical
        expect(code).not.toContain('!==');
        expect(evaluate(code)).toBe(want);
    });

    it('leaves a NON-string right operand strict', async () => {
        // `typeof x === 0` is always false; `typeof x == 0` coerces the type string to a number.
        const code = await build('const x = Number(globalThis.q ?? 1);\no = typeof x === 0;');
        expect(evaluate(code)).toBe(false);
    });

    it('leaves an ordinary strict comparison alone', async () => {
        const code = await build('const x = "1";\no = x === 1;');
        expect(evaluate(code)).toBe(false); // `==` here would be TRUE — the operator must not change
    });
});

describe('string comparisons fold like numeric ones', () => {
    it.each([
        ['"a" === "a"', true],
        ['"a" === "b"', false],
        ['"a" !== "b"', true],
        ['"a" == "a"', true],
        ['"a" < "b"', true],
        ['"b" <= "a"', false],
    ])('%s', async (expr, want) => {
        // `1 === 1` already folded; the string case was missing entirely and survived to the output.
        // Both operands being strings makes loose and strict coincide, and `<`/`>` is the lexicographic
        // comparison JS performs.
        const code = await build(`o = ${expr};`);
        expect(code).not.toContain('==');
        expect(evaluate(code)).toBe(want);
    });

    it('leaves a MIXED comparison alone', async () => {
        // `"1" == 1` is true by coercion but `"1" === 1` is false — not a case to fold blind.
        const code = await build('o = "1" === 1;');
        expect(evaluate(code)).toBe(false);
    });
});
