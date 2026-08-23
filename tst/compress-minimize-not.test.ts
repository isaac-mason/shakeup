import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (src: string, minify: boolean | { compress?: boolean; mangle?: boolean; whitespace?: boolean }) => {
    const result = await bundle({ entry: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), output: { minify } });
    expect(result.errors).toEqual([]);
    return result.code;
};

/** Build the same source un-minified and compress-only, execute BOTH bundles, and assert every named
 *  export is byte-for-byte identical at runtime. A minimize-not rewrite is legal only if it preserves
 *  the runtime boolean/value EXACTLY — including the adversarial `NaN` inputs — so this is the guard. */
const parity = async (src: string, keys: string[]) => {
    const plain = await build(src, false);
    const compressed = await build(src, { compress: true });
    const p = await run(plain);
    const q = await run(compressed);
    for (const k of keys) expect(q[k]).toStrictEqual(p[k]);
    return { plain, compressed, p, q };
};

describe('minimize-not (compress)', () => {
    // ---- rewrite 1: EQUALITY FLIPS (the four safe operators) -----------------------------------
    it('flips `!(a === b)` → `a !== b` (execution parity over === edge inputs)', async () => {
        const src = [
            'export function f(a, b) { return !(a === b); }',
            // cover NaN (NaN===NaN is false → !false = true), 0/-0, and equal values
            'export const nan = f(NaN, NaN);',
            'export const eq = f(1, 1);',
            'export const ne = f(1, 2);',
            'export const zero = f(0, -0);',
        ].join('\n');
        const { compressed, q } = await parity(src, ['nan', 'eq', 'ne', 'zero']);
        expect(q.nan).toBe(true);
        expect(q.eq).toBe(false);
        expect(q.ne).toBe(true);
        expect(q.zero).toBe(false);
        expect(compressed).toMatch(/!==/); // the flipped operator appeared
        expect(compressed).not.toMatch(/!\s*\(/); // the outer `!(` is gone
    });

    it('flips `!(a !== b)` → `a === b`', async () => {
        const src = [
            'export function f(a, b) { return !(a !== b); }',
            'export const nan = f(NaN, NaN);',
            'export const eq = f(1, 1);',
            'export const ne = f(1, 2);',
        ].join('\n');
        const { compressed, q } = await parity(src, ['nan', 'eq', 'ne']);
        expect(q.nan).toBe(false);
        expect(q.eq).toBe(true);
        expect(q.ne).toBe(false);
        expect(compressed).toMatch(/===/);
    });

    it('flips `!(a == b)` → `a != b` and `!(a != b)` → `a == b`', async () => {
        const src = [
            'export function loose(a, b) { return !(a == b); }',
            'export function looseNe(a, b) { return !(a != b); }',
            // == coercion edge cases must survive: null == undefined, 0 == "", NaN == NaN
            'export const l1 = loose(null, undefined);', // null==undefined true → !true = false
            'export const l2 = loose(0, "");', // 0=="" true → false
            'export const l3 = loose(NaN, NaN);', // false → true
            'export const n1 = looseNe(null, undefined);', // null!=undefined false → !false = true
            'export const n2 = looseNe(NaN, NaN);', // NaN!=NaN true → false
        ].join('\n');
        const { compressed, q } = await parity(src, ['l1', 'l2', 'l3', 'n1', 'n2']);
        expect(q.l1).toBe(false);
        expect(q.l2).toBe(false);
        expect(q.l3).toBe(true);
        expect(q.n1).toBe(true);
        expect(q.n2).toBe(false);
        expect(compressed).toMatch(/!=/);
        // a bare `==` (not `===`) survives from the `!(a != b)` → `a == b` flip
        expect(compressed).toMatch(/[^=!]==[^=]/);
    });

    // ---- rewrite 1 ADVERSARIAL: RELATIONAL operators must NOT flip (the NaN landmine) ----------
    it('does NOT flip `!(a < b)` → `a >= b` — they DIFFER for NaN (miscompile guard)', async () => {
        const src = [
            'export function f(a, b) { return !(a < b); }',
            // NaN < 1 is false, so !(NaN<1) is TRUE. But NaN >= 1 is FALSE. A relational flip here
            // would return false — the classic miscompile. Parity + explicit assert catch it.
            'export const nanL = f(NaN, 1);',
            'export const nanR = f(1, NaN);',
            'export const lt = f(1, 2);',
            'export const gt = f(2, 1);',
        ].join('\n');
        const { compressed, q } = await parity(src, ['nanL', 'nanR', 'lt', 'gt']);
        expect(q.nanL).toBe(true); // !(NaN < 1) === true  — NOT the `>=` answer (false)
        expect(q.nanR).toBe(true); // !(1 < NaN) === true
        expect(q.lt).toBe(false); // !(1 < 2) === false
        expect(q.gt).toBe(true); // !(2 < 1) === true
        // the relational stayed under a `!` — no `>=` was minted, and `<` is intact
        expect(compressed).not.toMatch(/>=/);
        expect(compressed).toMatch(/</);
    });

    it('does NOT flip `!(a <= b)`, `!(a > b)`, `!(a >= b)` (all relational stay under `!`)', async () => {
        const src = [
            'export function le(a, b) { return !(a <= b); }',
            'export function gt(a, b) { return !(a > b); }',
            'export function ge(a, b) { return !(a >= b); }',
            'export const leNan = le(NaN, 1);', // !(NaN<=1) = !false = true; (NaN>1) would be false → miscompile
            'export const gtNan = gt(NaN, 1);', // !(NaN>1) = !false = true; (NaN<=1) false
            'export const geNan = ge(NaN, 1);', // !(NaN>=1) = !false = true; (NaN<1) false
        ].join('\n');
        const { compressed, q } = await parity(src, ['leNan', 'gtNan', 'geNan']);
        expect(q.leNan).toBe(true);
        expect(q.gtNan).toBe(true);
        expect(q.geNan).toBe(true);
        // no relational operator was flipped away (all three still print with their original operator)
        expect(compressed).toMatch(/<=/);
        expect(compressed).toMatch(/>=/);
    });

    // ---- rewrite 2: DOUBLE/TRIPLE NEGATION ----------------------------------------------------
    it('collapses `!!!x` → `!x` (inner arg is a `!`, always boolean)', async () => {
        const src = [
            'export function f(x) { return !!!x; }',
            'export const t = f(0);', // !!!0 = !!(true) ... = !false? -> !!!0 === true
            'export const fl = f(1);', // !!!1 === false
            'export const und = f(undefined);',
            'export const obj = f({});',
        ].join('\n');
        const { compressed, q } = await parity(src, ['t', 'fl', 'und', 'obj']);
        expect(q.t).toBe(true);
        expect(q.fl).toBe(false);
        expect(q.und).toBe(true);
        expect(q.obj).toBe(false);
        // exactly ONE `!` remains in the returned expression (the triple collapsed to single)
        const bangs = (compressed.match(/!/g) ?? []).length;
        expect(bangs).toBe(1);
    });

    it('collapses `!!(a === b)` → `a === b` (inner arg is a comparison, boolean-typed)', async () => {
        const src = [
            'export function f(a, b) { return !!(a === b); }',
            'export const eq = f(1, 1);',
            'export const ne = f(1, 2);',
            'export const nan = f(NaN, NaN);',
        ].join('\n');
        const { compressed, q } = await parity(src, ['eq', 'ne', 'nan']);
        expect(q.eq).toBe(true);
        expect(q.ne).toBe(false);
        expect(q.nan).toBe(false);
        // both `!` collapsed away — no `!` survives, the `===` stands alone
        expect(compressed).not.toMatch(/!/);
        expect(compressed).toMatch(/===/);
    });

    // ---- rewrite 2 ADVERSARIAL: `!!x` on a NON-boolean must NOT collapse to `x` ----------------
    it('does NOT collapse `!!x` → `x` for a non-boolean x (that needs a boolean context)', async () => {
        const src = [
            'export function f(x) { return !!x; }',
            // if `!!x` wrongly became `x`, f("") would return "" (falsy string) not the boolean false,
            // and f(2) would return 2 not true. Parity + strict boolean asserts catch the regression.
            'export const emptyStr = f("");',
            'export const num = f(2);',
            'export const obj = f({});',
            'export const nul = f(null);',
        ].join('\n');
        const { compressed, q } = await parity(src, ['emptyStr', 'num', 'obj', 'nul']);
        expect(q.emptyStr).toBe(false); // NOT ""
        expect(q.num).toBe(true); // NOT 2
        expect(q.obj).toBe(true);
        expect(q.nul).toBe(false);
        // the double-bang is preserved (still coerces to boolean; printer may space it as `! !x`)
        expect(compressed).toMatch(/!\s*!x/);
    });

    // ---- rewrite 3: DE MORGAN (only when it doesn't add parens; equality leaves only) ----------
    it('applies De Morgan `!(a === b && c === d)` → `a !== b || c !== d`', async () => {
        const src = [
            'export function f(a, b, c, d) { return !(a === b && c === d); }',
            'export const bothEq = f(1, 1, 2, 2);', // !(true && true) = false
            'export const oneNe = f(1, 1, 2, 3);', // !(true && false) = true
            'export const nan = f(NaN, NaN, 2, 2);', // !(false && true) = true
        ].join('\n');
        const { compressed, q } = await parity(src, ['bothEq', 'oneNe', 'nan']);
        expect(q.bothEq).toBe(false);
        expect(q.oneNe).toBe(true);
        expect(q.nan).toBe(true);
        // the `&&` chain became a `||` of flipped comparisons; the outer `!(` is gone
        expect(compressed).toMatch(/!==/);
        expect(compressed).toMatch(/\|\|/);
        expect(compressed).not.toMatch(/&&/);
    });

    it('applies De Morgan `!(a === b || c === d)` → `a !== b && c !== d`', async () => {
        const src = [
            'export function f(a, b, c, d) { return !(a === b || c === d); }',
            'export const neither = f(1, 2, 3, 4);', // !(false || false) = true
            'export const oneEq = f(1, 1, 3, 4);', // !(true || false) = false
        ].join('\n');
        const { compressed, q } = await parity(src, ['neither', 'oneEq']);
        expect(q.neither).toBe(true);
        expect(q.oneEq).toBe(false);
        expect(compressed).toMatch(/&&/);
        expect(compressed).toMatch(/!==/);
    });

    // ---- rewrite 3 ADVERSARIAL: De Morgan BAILS on a relational leaf --------------------------
    it('does NOT De Morgan `!(a < b && c === d)` — a relational leaf blocks the whole chain', async () => {
        const src = [
            'export function f(a, b, c, d) { return !(a < b && c === d); }',
            // if De Morgan wrongly fired, the `<` leaf would flip to `>=` and miscompile under NaN.
            'export const nanLt = f(NaN, 1, 2, 2);', // !(false && true) = true; a `>=`/`||` form under NaN diverges
            'export const t = f(1, 2, 3, 3);', // !(true && true) = false
            'export const f2 = f(2, 1, 3, 3);', // !(false && true) = true
        ].join('\n');
        const { compressed, q } = await parity(src, ['nanLt', 't', 'f2']);
        expect(q.nanLt).toBe(true);
        expect(q.t).toBe(false);
        expect(q.f2).toBe(true);
        // no relational flip happened — `>=`/`<=` were never minted, the `<` and `&&` stay under `!`
        expect(compressed).not.toMatch(/>=/);
        expect(compressed).toMatch(/</);
        expect(compressed).toMatch(/&&/);
    });

    it('does NOT De Morgan when it would ADD parens (paren-delta > 0)', async () => {
        // `!(a === b || (c === d && e === f))`: De Morgan makes the OUTER `||`→`&&` and the nested
        // `&&`→`||`, so the nested `||` now sits under an `&&` and needs parens it did not before
        // (delta = +2 > 0). oxc bails; so must we. Parity across all-equal / one-differs inputs.
        const src = [
            'export function f(a, b, c, d, e, g) { return !(a === b || (c === d && e === g)); }',
            'export const all = f(1, 1, 2, 2, 3, 3);', // !(true || …) = false
            'export const none = f(1, 9, 2, 9, 3, 9);', // !(false || (false&&…)) = true
            'export const nested = f(1, 9, 2, 2, 3, 3);', // !(false || (true&&true)) = false
        ].join('\n');
        const { q } = await parity(src, ['all', 'none', 'nested']);
        expect(q.all).toBe(false);
        expect(q.none).toBe(true);
        expect(q.nested).toBe(false);
    });

    // ---- DELIBERATE NON-PORT: `!(a, b)` is left for minimize-conditions (not distributed here) --
    it('does NOT distribute `!` over a sequence — minimize-conditions owns `!(seq)`', async () => {
        // oxc's minimize_unary distributes `!(a, b)` → `a, !b`, but we intentionally skip it so
        // minimize-conditions can flip `if (!(a, b)) c()` → `(a, b) || c()` (it needs the `!(seq)`
        // intact). Runtime parity still holds; we just verify the sequence-value semantics survive.
        const src = [
            'const order = [];',
            'export function f(x) { return !(order.push("s"), x === 1); }',
            'export const eq = f(1);', // pushes "s", then !(true) = false
            'export const ne = f(2);', // pushes "s", then !(false) = true
            'export const order2 = order;',
        ].join('\n');
        const { q } = await parity(src, ['eq', 'ne', 'order2']);
        expect(q.eq).toBe(false);
        expect(q.ne).toBe(true);
        // side-effect (push "s") ran once per call, before the negated value — order preserved
        expect(q.order2).toStrictEqual(['s', 's']);
    });

    // ---- does not fire without compress -------------------------------------------------------
    it('does not fire on a plain (minify:false) build', async () => {
        const code = await build('export function f(a, b){ return !(a === b); }', false);
        expect(code).toMatch(/!\s*\(/); // the `!(` is intact
        expect(code).not.toMatch(/!==/);
    });
});
