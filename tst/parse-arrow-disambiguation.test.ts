// Arrow disambiguation — the cases `arrowAheadFromParen` got wrong.
//
// Both bugs came from the same root cause: we scanned forward over raw CHARACTERS hunting for `=>`,
// where oxc classifies from the HEAD in a few tokens (`oxc_parser/src/js/arrow.rs`). The scan
// re-implemented the lexer badly (no regex case), and the ts-colon speculation it fell back on had no
// notion of whether a return type was admissible in context.
//
// Every fixture here is valid JavaScript. That is the whole point, so it is asserted rather than
// assumed: an invalid fixture makes a CORRECT rejection look like a bug, which wasted a cycle on
// `/)/ ` and `/(/ ` — neither of which is a valid regex at all.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errorsFor = (src: string, ts: boolean): unknown[] => parse(src, { ts, jsx: false }).errors;

/** Both parser modes must accept it, and V8 must agree it is valid in the first place. */
function acceptsBothModes(src: string): void {
    expect(() => new Function(`return (${src})`)).not.toThrow();
    expect(errorsFor(src, false), `js mode: ${src}`).toEqual([]);
    expect(errorsFor(src, true), `ts mode: ${src}`).toEqual([]);
}

describe('bug 1 — regex literals in parenthesized arrow parameters', () => {
    // The scan counted brackets inside a regex as structure, so the matching `)` was found in the
    // wrong place and the `=>` after it was never seen.
    it.each([
        String.raw`(x = /[)]/) => x`,
        String.raw`(x = /\)/) => x`,
        String.raw`(x = /[(]/) => x`,
        String.raw`(x = /\(/) => x`,
        String.raw`(x = /[}]/) => x`,
        String.raw`(x = /[{]/) => x`,
    ])('%s', acceptsBothModes);

    // Passed even before the fix, because `{` and `}` happen to balance. Kept so a regression that
    // reintroduces character counting cannot hide behind it.
    it('(x = /a{1}/) => x — balanced by luck, not by handling', () => {
        acceptsBothModes(String.raw`(x = /a{1}/) => x`);
    });

    it.each([`(x = "a)b") => x`, `(x = 'a)b') => x`, '(x = `a)b`) => x', `(x = 1) => x`])(
        'control, never broken: %s',
        acceptsBothModes,
    );
});

describe('bug 2 — an arrow body must not eat the conditional’s `:`', () => {
    // oxc's own worked example (`arrow.rs:372-385`). Parsing the first arrow's body reaches
    // `({ y })`; the ts-colon speculation then accepted `({ y }) : z => ({ z })` as an arrow with
    // return type `z`, consuming the `:` that terminates the conditional. oxc guards this with
    // `allow_return_type_in_arrow_function`. `js` mode never had the bug — there is no return type to
    // mis-parse — so the ts assertion is the one that matters.
    it.each([
        `x ? y => ({ y }) : z => ({ z })`,
        `x ? y => (a) : z => (b)`,
        `f(x ? y => ({y}) : z => ({z}))`,
        `x ? y => (a) : (z) => (b)`,
    ])('%s', acceptsBothModes);

    it.each([`x ? (y) => ({ y }) : (z) => ({ z })`, `cond ? (a) : (b)`, `a ? (b) => c : d`])(
        'control, never broken: %s',
        acceptsBothModes,
    );

    // The escape hatch at `arrow.rs:386-399`: a SECOND colon means the return type is allowed after
    // all, and the second colon terminates the conditional. ts-only syntax, so no `new Function`.
    it.each([`a ? (x): string => x : null`, `a() ? (b: number, c?: string): void => d() : e`])(
        'ts-only, must keep working: %s',
        (src) => {
            expect(errorsFor(src, true), src).toEqual([]);
        },
    );
});

describe('speculation must not leak parser state', () => {
    // `saveState` rewinds 8 of `ParserState`'s 42 fields. The other 34 are assumed not to matter,
    // and nothing checks that assumption — so a speculative parse that runs over an annotation
    // records it, rewinds, and records it AGAIN on the real parse.
    //
    // Caught after the Tristate port introduced it: `(a, …)` never speculated under the old
    // character scan, so widening speculation exposed a latent hole. Benign today only because
    // `resolveNoSideEffects` does `new Set(positions)` — do not rely on that.
    it.each([
        [`(a, /*@__NO_SIDE_EFFECTS__*/ function f(){})`, 1],
        [`(x = 1, /*@__NO_SIDE_EFFECTS__*/ function g(){})`, 1],
        [`/*@__NO_SIDE_EFFECTS__*/ function f(){}`, 1],
    ])('records one annotation, not one per speculation: %s', (src, expected) => {
        for (const ts of [false, true]) {
            expect(parse(src, { ts, jsx: false }).noSideEffectsAt, `${ts ? 'ts' : 'js'}: ${src}`).toHaveLength(expected);
        }
    });
});

describe('async arrow parameters are inside the async context', () => {
    // "It is a Syntax Error if ArrowParameters Contains AwaitExpression is true." Found by running
    // oxc's async-arrow path (`js/arrow.rs:33-56`) against us: both of these were accepted.
    // test262 48,786 -> 48,789 on the fix.
    //
    // The pair matters. `(await) => 1` is LEGAL at top level in the permissive goal — `await` is an
    // ordinary identifier in a script — so the rule cannot be "await is never a parameter". It is
    // reserved only once the arrow is known to be async, which is why oxc unions the await context
    // before parsing parameters rather than checking the name afterwards.
    const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors;

    it.each([`async await => 1`, `async (await) => 1`, `async (a, await) => 1`, `async (await = 1) => 1`])(
        'rejects %s',
        (src) => {
            expect(() => new Function(`${src};`)).toThrow(); // node agrees it is invalid
            expect(errs(src), src).not.toEqual([]);
        },
    );

    it.each([`(await) => 1`, `async x => x`, `async (x) => x`, `async () => 1`, `async (a, b) => a`])(
        'still accepts %s',
        (src) => {
            expect(() => new Function(`${src};`)).not.toThrow();
            expect(errs(src), src).toEqual([]);
        },
    );
});
