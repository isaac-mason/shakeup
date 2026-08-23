import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (src: string, minify: boolean | { compress?: boolean; mangle?: boolean; whitespace?: boolean }) => {
    const result = await bundle({ entry: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), output: { minify } });
    expect(result.errors).toEqual([]);
    return result.code;
};

/** Build the same source both un-minified and compress-only, execute both bundles, and assert EVERY
 *  exported key is identical (side-effect order included via an exported `log` array where used). A
 *  rewrite is only legal if it preserves runtime behavior bit-for-bit. Returns both codes + the shared
 *  export bag so a test can additionally assert the *shape* of the compressed output. */
const parity = async (src: string) => {
    const plain = await build(src, false);
    const compressed = await build(src, { compress: true });
    const p = await run(plain);
    const q = await run(compressed);
    // Compare only DATA exports (the `out` bag etc.); exported functions differ cosmetically between
    // builds (formatting/renaming) yet are exercised through the data results, so skip them.
    for (const k of Object.keys(p)) {
        if (typeof p[k] === 'function') continue;
        expect(q[k]).toStrictEqual(p[k]);
    }
    return { plain, compressed, p, q };
};

describe('minimize-logical (compress)', () => {
    // ---- 1. nullish-coalesce collapse: `x === null || x === undefined` → `x == null` ------------
    it('collapses `x === null || x === undefined` → `x == null`', async () => {
        const src = [
            'export function f(x) { return x === null || x === undefined; }',
            'export const out = [f(null), f(undefined), f(0), f(""), f(1), f({})];',
        ].join('\n');
        const { compressed } = await parity(src);
        expect((await run(compressed)).out).toStrictEqual([true, true, false, false, false, false]);
        expect(compressed).toMatch(/==\s*null/); // collapsed to loose `== null`
        expect(compressed).not.toMatch(/===\s*null/); // the strict pair is gone
    });

    it('collapses the reversed order `x === undefined || x === null` → `x == null`', async () => {
        const src = [
            'export function f(x) { return x === undefined || x === null; }',
            'export const out = [f(null), f(undefined), f(0), f(1)];',
        ].join('\n');
        const { compressed } = await parity(src);
        expect((await run(compressed)).out).toStrictEqual([true, true, false, false]);
        expect(compressed).toMatch(/==\s*null/);
        expect(compressed).not.toMatch(/===/);
    });

    it('collapses the `&&` dual `x !== null && x !== undefined` → `x != null`', async () => {
        const src = [
            'export function f(x) { return x !== null && x !== undefined; }',
            'export const out = [f(null), f(undefined), f(0), f(1), f({})];',
        ].join('\n');
        const { compressed } = await parity(src);
        expect((await run(compressed)).out).toStrictEqual([false, false, true, true, true]);
        expect(compressed).toMatch(/!=\s*null/);
        expect(compressed).not.toMatch(/!==/);
    });

    it('collapses a left-nested chain `a === null || a === undefined || rest` → `a == null || rest`', async () => {
        const src = [
            'export function f(x, y) { return x === null || x === undefined || y; }',
            'export const out = [f(null, 0), f(undefined, 0), f(1, 0), f(1, 7)];',
        ].join('\n');
        const { compressed } = await parity(src);
        expect((await run(compressed)).out).toStrictEqual([true, true, 0, 7]);
        expect(compressed).toMatch(/==\s*null/);
    });

    // ---- 2. compound / logical assignment ------------------------------------------------------
    it('folds `a = a + b` → `a += b` (and it still returns the assigned value)', async () => {
        const src = ['export function f(a, b) { return a = a + b; }', 'export const out = [f(2, 3), f(10, -4)];'].join('\n');
        const { compressed } = await parity(src);
        expect((await run(compressed)).out).toStrictEqual([5, 6]);
        expect(compressed).toMatch(/\+=/);
        expect(compressed).not.toMatch(/=\s*a\s*\+/); // the `= a +` read+write is gone
    });

    it('folds every arithmetic/bitwise/shift compound (`- * / % ** & | ^ << >> >>>`)', async () => {
        const cases: Array<[string, number, number, number]> = [
            ['-', 10, 3, 7],
            ['*', 4, 5, 20],
            ['/', 20, 4, 5],
            ['%', 10, 3, 1],
            ['**', 2, 5, 32],
            ['&', 6, 3, 2],
            ['|', 4, 1, 5],
            ['^', 5, 1, 4],
            ['<<', 1, 4, 16],
            ['>>', 16, 2, 4],
            ['>>>', -1, 28, 15],
        ];
        for (const [op, a, b, want] of cases) {
            const src = [`export function f(a, b) { return a = a ${op} b; }`, `export const out = f(${a}, ${b});`].join('\n');
            const { compressed } = await parity(src);
            expect((await run(compressed)).out).toBe(want);
            expect(compressed).toContain(`${op}=`);
        }
    });

    it('folds `a = a || b` → `a ||= b`, `a = a && b` → `a &&= b`, `a = a ?? b` → `a ??= b`', async () => {
        const or = ['export function f(a, b) { return a = a || b; }', 'export const out = [f(0, 9), f(5, 9), f("", "x")];'].join(
            '\n',
        );
        expect((await parity(or)).q.out).toStrictEqual([9, 5, 'x']);
        expect(await build(or, { compress: true })).toMatch(/\|\|=/);

        const and = ['export function f(a, b) { return a = a && b; }', 'export const out = [f(0, 9), f(5, 9), f(1, 0)];'].join(
            '\n',
        );
        expect((await parity(and)).q.out).toStrictEqual([0, 9, 0]);
        expect(await build(and, { compress: true })).toMatch(/&&=/);

        const nul = [
            'export function f(a, b) { return a = a ?? b; }',
            'export const out = [f(null, 9), f(undefined, 9), f(0, 9), f(5, 9)];',
        ].join('\n');
        expect((await parity(nul)).q.out).toStrictEqual([9, 9, 0, 5]);
        expect(await build(nul, { compress: true })).toMatch(/\?\?=/);
    });

    it('preserves `||=`/`&&=` short-circuit: the RHS is NOT evaluated when it should not be', async () => {
        // `a ||= sideEffect()` must NOT run sideEffect() when `a` is truthy; `a &&= sideEffect()` must
        // NOT run it when `a` is falsy. Parity against the un-minified build proves the fold kept the
        // short-circuit (both builds must record the same call log).
        const src = [
            'let log = [];',
            'function bump(tag, v) { log.push(tag); return v; }',
            'export function orTest(a) { a = a || bump("or", 42); return a; }',
            'export function andTest(a) { a = a && bump("and", 42); return a; }',
            'export const out = { or1: orTest(7), or2: orTest(0), and1: andTest(0), and2: andTest(7), log };',
        ].join('\n');
        const { compressed } = await parity(src);
        const r = (await run(compressed)).out as Record<string, unknown>;
        // or1: a=7 truthy → no bump; or2: a=0 falsy → bump("or"); and1: a=0 falsy → no bump;
        // and2: a=7 truthy → bump("and").
        expect(r.or1).toBe(7);
        expect(r.or2).toBe(42);
        expect(r.and1).toBe(0);
        expect(r.and2).toBe(42);
        expect(r.log).toStrictEqual(['or', 'and']);
    });

    // ---- ADVERSARIAL: must NOT fire ------------------------------------------------------------
    it('does NOT collapse when the two null-checks reference DIFFERENT variables', async () => {
        // `a === null || b === undefined` is NOT `a == null` — must stay a two-operand logical.
        const src = [
            'export function f(a, b) { return a === null || b === undefined; }',
            'export const out = [f(null, 1), f(1, undefined), f(1, 1)];',
        ].join('\n');
        const { compressed } = await parity(src);
        expect((await run(compressed)).out).toStrictEqual([true, true, false]);
        // Both strict comparisons survive (no bogus collapse).
        expect(compressed).toMatch(/===\s*null/);
    });

    it('does NOT collapse two same-kind checks (`a === null || a === null`)', async () => {
        const src = [
            'export function f(a) { return a === null || a === null; }',
            'export const out = [f(null), f(undefined), f(0)];',
        ].join('\n');
        const { compressed } = await parity(src);
        // `undefined` must stay FALSE (only strict-null matches) — a collapse to `== null` would wrongly
        // return true for undefined.
        expect((await run(compressed)).out).toStrictEqual([true, false, false]);
        expect(compressed).not.toMatch(/[^=!]=\s*null/); // no loose `== null` was introduced
    });

    it('does NOT fold a MEMBER-target compound assignment (`o.x = o.x + c`)', async () => {
        // A member target evaluated twice in `o.x = o.x + c` vs once in `o.x += c` differs under a
        // getter/proxy; we bail for v1. Parity still holds (no rewrite), and the source shape survives.
        const src = ['export function f(c) { const o = { x: 10 }; o.x = o.x + c; return o.x; }', 'export const out = f(5);'].join(
            '\n',
        );
        const { compressed } = await parity(src);
        expect((await run(compressed)).out).toBe(15);
        expect(compressed).not.toMatch(/\.x\s*\+=/); // member compound NOT formed
    });

    it('does NOT fold `a = b + c` when the RHS left operand is a DIFFERENT variable', async () => {
        const src = ['export function f(a, b, c) { return a = b + c; }', 'export const out = f(1, 2, 3);'].join('\n');
        const { compressed } = await parity(src);
        expect((await run(compressed)).out).toBe(5);
        expect(compressed).not.toMatch(/\+=/); // `a = b + c` is NOT a compound (a !== b)
    });

    it('does NOT introduce `??=` when the target has an observable read side effect via a getter', async () => {
        // The target here is a MEMBER (`box.v`), so tryCompoundAssign bails outright — a getter on `box`
        // reading `box.v` would be evaluated a different number of times under `??=`. Parity confirms
        // behavior (call log) is preserved and no `??=` is formed on the member.
        const src = [
            'let reads = [];',
            'export function f() {',
            '  const box = { _v: null, get v() { reads.push(1); return this._v; }, set v(x) { this._v = x; } };',
            '  box.v = box.v ?? 7;',
            '  return { v: box._v, reads: reads.length };',
            '}',
            'export const out = f();',
        ].join('\n');
        const { compressed } = await parity(src);
        expect((await run(compressed)).out).toStrictEqual({ v: 7, reads: 1 });
        expect(compressed).not.toMatch(/\?\?=/); // member `??=` NOT formed
    });

    it('does not fire without compress (plain build keeps the un-collapsed forms)', async () => {
        const src = [
            'export function f(x) { return x === null || x === undefined; }',
            'export function g(a, b) { return a = a + b; }',
            'export const out = [f(null), g(2, 3)];',
        ].join('\n');
        const code = await build(src, false);
        expect(code).toMatch(/===\s*null/);
        expect(code).not.toMatch(/\+=/);
        expect((await run(code)).out).toStrictEqual([true, 5]);
    });
});
