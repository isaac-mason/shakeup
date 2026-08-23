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
 *  export (and any recorded `order`) is identical. A boolean-context rewrite is only legal if it
 *  preserves runtime value AND side-effect order exactly, so this is the load-bearing guard. */
const parity = async (src: string, keys: string[]) => {
    const plain = await build(src, false);
    const compressed = await build(src, { compress: true });
    const p = await run(plain);
    const q = await run(compressed);
    for (const k of keys) expect(q[k]).toStrictEqual(p[k]);
    return { plain, compressed, p, q };
};

describe('boolean-context (compress)', () => {
    // ---- `!!x` → `x` inside an `if` test (the canonical simplification) -----------------------
    it('collapses `if (!!x)` → `if (x)`', async () => {
        const src = [
            'const order = [];',
            'function go(x) { if (!!x) order.push("hit"); return order.length; }',
            'export const t = go(1);',
            'export const f = go(0);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['t', 'f', 'order2']);
        expect(q.t).toBe(1);
        expect(q.f).toBe(1); // go(0): the push did not run, but length is read after — still 1 from go(1)
        expect(q.order2).toStrictEqual(['hit']);
        expect(compressed).not.toMatch(/!!/); // the double-negation is gone
    });

    // ---- `while (!!x)` ------------------------------------------------------------------------
    it('collapses `while (!!x)` → `while (x)`', async () => {
        const src = [
            'const order = [];',
            'function go(n) { let i = n; while (!!i) { order.push(i); i--; } }',
            'go(3);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['order2']);
        expect(q.order2).toStrictEqual([3, 2, 1]);
        expect(compressed).not.toMatch(/!!/);
    });

    // ---- `!(!!x)` → `!x` (triple-not collapse via the `!`-argument boolean context) -----------
    it('collapses `!(!!x)` → `!x` (evaluates identically)', async () => {
        const src = [
            'const order = [];',
            'function go(x) { if (!(!!x)) order.push("neg"); }',
            'go(1); go(0);', // go(1): !(!!1) = !(true) = false → no push; go(0): !(!!0) = !(false) = true → push
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['order2']);
        expect(q.order2).toStrictEqual(['neg']);
        // at most a single `!` survives on the test — no `!!` remains
        expect(compressed).not.toMatch(/!!/);
    });

    // ---- `if (Boolean(x))` → `if (x)` ---------------------------------------------------------
    it('collapses `if (Boolean(x))` → `if (x)`', async () => {
        const src = [
            'const order = [];',
            'function go(x) { if (Boolean(x)) order.push("t"); }',
            'go("a"); go("");', // truthy string then falsy empty string
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['order2']);
        expect(q.order2).toStrictEqual(['t']);
        expect(compressed).not.toMatch(/Boolean\s*\(/); // the Boolean() wrapper is gone
    });

    // ---- `for` test and do-while both simplify ------------------------------------------------
    it('collapses `!!` in a `for` test and a `do/while` test', async () => {
        const src = [
            'const order = [];',
            'function loopFor(n) { for (let i = n; !!i; i--) order.push("f" + i); }',
            'function loopDo(n) { let i = n; do { order.push("d" + i); i--; } while (!!i); }',
            'loopFor(2); loopDo(2);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['order2']);
        expect(q.order2).toStrictEqual(['f2', 'f1', 'd2', 'd1']); // do-while: i=2 pushes d2,d1; i=0 stops
        expect(compressed).not.toMatch(/!!/);
    });

    // ---- `!!` inside `&&`/`||` operands feeding a boolean context -----------------------------
    it('collapses `if (!!a && !!b)` → `if (a && b)` (operands inherit the boolean context)', async () => {
        const src = [
            'const order = [];',
            'function go(a, b) { if (!!a && !!b) order.push("both"); }',
            'go(1, 1); go(1, 0); go(0, 1);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['order2']);
        expect(q.order2).toStrictEqual(['both']); // only the (1,1) call pushes
        expect(compressed).not.toMatch(/!!/);
    });

    // ================= ADVERSARIAL =================================================================

    // ---- `const b = !!x` is NOT a boolean context: `b` must hold the BOOLEAN, so keep `!!` -----
    it('does NOT simplify `const b = !!x` (b must stay a boolean, not the raw value)', async () => {
        const src = [
            'function typeOf(x) { const b = !!x; return typeof b; }',
            'export const t = typeOf(3);', // typeof true  === "boolean"
            'export const f = typeOf(0);', // typeof false === "boolean"
        ].join('\n');
        const { compressed, q } = await parity(src, ['t', 'f']);
        expect(q.t).toBe('boolean');
        expect(q.f).toBe('boolean');
        expect(compressed).toMatch(/! ?!/); // the coercion is load-bearing here — it must survive (printer may space it)
    });

    // ---- a SHADOWED `Boolean` is not the global — must not be stripped ------------------------
    it('does NOT strip a shadowed local `Boolean` (only the global qualifies)', async () => {
        const src = [
            'const order = [];',
            'function go(x) {',
            '  const Boolean = (v) => { order.push("call"); return true; };', // local shadow, always truthy
            '  if (Boolean(x)) order.push("in");',
            '}',
            'go(0);', // if global-strip fired, `if (0)` would skip both pushes — the shadow forces both
            'export const order2 = order;',
        ].join('\n');
        const { q } = await parity(src, ['order2']);
        // the local Boolean runs (pushes "call") and returns true → the body runs (pushes "in")
        expect(q.order2).toStrictEqual(['call', 'in']);
    });

    // ---- a `?:` ARM is NOT a boolean context (only the TEST is) --------------------------------
    it('does NOT simplify `!!` in a ternary ARM used as a value', async () => {
        const src = [
            'function pick(c, x) { return c ? !!x : "n"; }',
            'export const a = pick(1, 3);', // arm value is the BOOLEAN true, not 3
            'export const b = pick(1, 0);', // arm value is the BOOLEAN false, not 0
            'export const n = pick(0, 3);',
        ].join('\n');
        const { compressed, q } = await parity(src, ['a', 'b', 'n']);
        expect(q.a).toBe(true); // must be boolean true, NOT the number 3
        expect(q.b).toBe(false); // must be boolean false, NOT the number 0
        expect(q.n).toBe('n');
        expect(compressed).toMatch(/! ?!/); // the arm's coercion is load-bearing — it must survive (printer may space it)
    });

    // ---- the TEST of a `?:` in boolean context DOES simplify ----------------------------------
    it('collapses `!!` in the TEST arm of a boolean-context ternary', async () => {
        const src = [
            'const order = [];',
            'function go(x) { if (!!x ? true : false) order.push("y"); }',
            'go(1); go(0);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['order2']);
        expect(q.order2).toStrictEqual(['y']);
        expect(compressed).not.toMatch(/!!/); // the ternary's own test is a boolean context
    });

    // ---- does not fire without compress -------------------------------------------------------
    it('does not fire on a plain (minify:false) build', async () => {
        const code = await build('function go(x){ if (!!x) globalThis.z = 1; }\nexport const out = go;', false);
        expect(code).toMatch(/! ?!/); // untouched without compress (printer may space the negations)
    });
});
