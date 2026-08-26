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
