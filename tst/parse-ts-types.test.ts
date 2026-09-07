// TS type syntax we rejected. All HARMFUL — valid TypeScript that failed to build — found by the
// first differential ever run over the type grammar (4 of 45 cases, 3 harmful).
//
// The structural map had flagged `ts/types.rs` as 65 oxc functions to our 22 and called the cause
// UNMEASURED. It was missing coverage, not Rust verbosity.
import { describe, expect, it } from 'vitest';
import { N, type Node, walk } from '../src/ast/index.ts';
import { parse } from '../src/parser/index.ts';

const errs = (src: string) => parse(src, { ts: true, jsx: false }).errors;
const has = (src: string, type: number): boolean => {
    let found = false;
    walk(parse(src, { ts: true, jsx: false }).program as Node, (n) => {
        if (n.type === type) found = true;
    });
    return found;
};

describe('abstract construct signatures', () => {
    it.each(['type A = abstract new () => B;', 'type A = abstract new <T>(a: T) => B;'])('accepts %s', (src) => {
        expect(errs(src), src).toEqual([]);
        expect(has(src, N.TSConstructorType)).toBe(true);
    });

    it('still treats a bare `abstract` as an ordinary identifier', () => {
        expect(errs('let abstract = 1;')).toEqual([]);
        expect(errs('type abstract = 1;')).toEqual([]);
    });
});

describe('import types', () => {
    it.each([
        'type A = import("m").B;',
        'type A = import("m")<C>;',
        'type A = import("m", { with: { t: "json" } }).B;',
        'type A = typeof import("m");',
        'type A = typeof import("m").B;',
    ])('accepts %s', (src) => {
        expect(errs(src), src).toEqual([]);
    });
});

describe('type predicates', () => {
    // `asserts …` is a type in its own right and legal wherever a type may start. A bare `x is T` is
    // NOT — only where a RETURN type is expected. oxc draws the line in exactly this place, and the
    // negative case below is what pins it.
    it.each([
        'type A = asserts b is C;',
        'type A = asserts b;',
        'type P = (x: unknown) => asserts x is B;',
        'type P = (x: unknown) => x is B;',
        'function f(x: unknown): asserts x is B {}',
        'function f(x: unknown): x is B { return true }',
        'type C = abstract new (x: unknown) => x is B;',
    ])('accepts %s', (src) => {
        expect(errs(src), src).toEqual([]);
        expect(has(src, N.TSTypePredicate), 'builds a TSTypePredicate, not a placeholder').toBe(true);
    });

    it('rejects a bare predicate in plain type position', () => {
        expect(errs('type A = b is C;')).not.toEqual([]);
    });

    it('an ordinary annotation is not mistaken for a predicate', () => {
        expect(errs('let a: B = c;')).toEqual([]);
        expect(has('let a: B = c;', N.TSTypePredicate)).toBe(false);
    });
});

// `fnTypeAhead` — the raw-character scan that decides `(A, B) => C` (a function type) from `(A)` (a
// parenthesized one) — tracked brackets and quotes but not COMMENTS. Found by the devTransform
// corpus gate on shakeup's own `src/`, from a doc comment written in ordinary prose.
describe('a comment inside a function type’s parameter list', () => {
    const FN_TYPE = (doc: string) => `type R = (\n    a: string,\n    ${doc}\n    b?: number,\n) => string;\n`;

    it.each([
        ['an apostrophe: the quote scan ran to EOF and ate the closing paren', "/** the caller's id */"],
        ['an unbalanced paren in prose: `depth` never returned to 0', '/** as in import( */'],
        ['a line comment', "// the caller's id"],
        ['a multi-line block comment', "/** the caller's id\n     *  and more prose (unbalanced */"],
        ['a comment holding a quoted string', "/** pass `kind: 'entry'` here */"],
    ])('is skipped — %s', (_why, doc) => {
        const src = FN_TYPE(doc);
        expect(errs(src), src).toEqual([]);
        // Not merely error-free: the disambiguation must still reach the FUNCTION-type branch.
        expect(has(src, N.TSFunctionType), 'builds a TSFunctionType').toBe(true);
    });

    it('a comment does not turn a parenthesized type INTO a function type', () => {
        // The falsification arm: skipping comments must not make the scan see a `=>` that is not
        // there. `(A /* => */)` is a parenthesized type, whatever the prose says.
        const src = 'type R = (A /* => B */);\n';
        expect(errs(src)).toEqual([]);
        expect(has(src, N.TSFunctionType)).toBe(false);
    });
});
