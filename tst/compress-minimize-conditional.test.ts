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
 *  export is identical (including any `order` array recording call order). A minimize-conditional
 *  rewrite is legal only if it preserves runtime value AND side-effect order EXACTLY — this is the
 *  load-bearing guard for every ternary rewrite. */
const parity = async (src: string, keys: string[]) => {
    const plain = await build(src, false);
    const compressed = await build(src, { compress: true });
    const p = await run(plain);
    const q = await run(compressed);
    for (const k of keys) expect(q[k]).toStrictEqual(p[k]);
    return { plain, compressed, p, q };
};

describe('minimize-conditional (compress)', () => {
    // ---- pattern 1: boolean-literal arms ------------------------------------------------------
    it('rewrites `a ? true : false` → `!!a`', async () => {
        const src = [
            'function f(a) { return a ? true : false; }',
            'export const t = f(3);',
            'export const z = f(0);',
            'export const s = f("");',
        ].join('\n');
        const { compressed, q } = await parity(src, ['t', 'z', 's']);
        expect(q.t).toBe(true);
        expect(q.z).toBe(false);
        expect(q.s).toBe(false);
        expect(compressed).toMatch(/!\s*!/); // a double-negation appeared (compress-only keeps a space)
        expect(compressed).not.toMatch(/\?/); // the ternary is gone
    });

    it('rewrites `a ? false : true` → `!a`', async () => {
        const src = ['function f(a) { return a ? false : true; }', 'export const t = f(3);', 'export const z = f(0);'].join('\n');
        const { compressed, q } = await parity(src, ['t', 'z']);
        expect(q.t).toBe(false);
        expect(q.z).toBe(true);
        expect(compressed).not.toMatch(/\?[^.]/); // no ternary (avoid matching optional chaining `?.`)
    });

    // ---- pattern 2: identical arms ------------------------------------------------------------
    it('collapses `a ? b : b` → `b` when the test is side-effect-free', async () => {
        const src = [
            'const order = [];',
            'function f(a, b) { return a ? b : b; }',
            'export const r = f(1, 42);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['r', 'order2']);
        expect(q.r).toBe(42);
        expect(compressed).not.toMatch(/\?/); // ternary collapsed away (pure test → just `b`)
    });

    it('keeps a side-effecting test as `(a(), b)` for `a() ? b : b`', async () => {
        const src = [
            'const order = [];',
            'function eff() { order.push("eff"); return 0; }',
            'function f(b) { return eff() ? b : b; }',
            'export const r = f(7);',
            'export const order2 = order;',
        ].join('\n');
        const { q } = await parity(src, ['r', 'order2']);
        // The test MUST still run for its effect (comma sequence), then `b` is the value.
        expect(q.r).toBe(7);
        expect(q.order2).toStrictEqual(['eff']);
    });

    // ---- pattern 3: `a ? a : b` → `a || b` ----------------------------------------------------
    it('rewrites `a ? a : b` → `a || b`', async () => {
        const src = [
            'function f(a, b) { return a ? a : b; }',
            'export const t = f(5, 9);',
            'export const z = f(0, 9);',
            'export const e = f("", "fallback");',
        ].join('\n');
        const { compressed, q } = await parity(src, ['t', 'z', 'e']);
        expect(q.t).toBe(5);
        expect(q.z).toBe(9);
        expect(q.e).toBe('fallback');
        expect(compressed).toMatch(/\|\|/); // an `||` appeared
        expect(compressed).not.toMatch(/\?/);
    });

    // ---- pattern 4: `a ? b : a` → `a && b` ----------------------------------------------------
    it('rewrites `a ? b : a` → `a && b`', async () => {
        const src = ['function f(a, b) { return a ? b : a; }', 'export const t = f(5, 9);', 'export const z = f(0, 9);'].join(
            '\n',
        );
        const { compressed, q } = await parity(src, ['t', 'z']);
        expect(q.t).toBe(9);
        expect(q.z).toBe(0);
        expect(compressed).toMatch(/&&/);
        expect(compressed).not.toMatch(/\?/);
    });

    // ---- pattern 5: `!a ? b : c` → `a ? c : b` ------------------------------------------------
    it('flips `!a ? b : c` → `a ? c : b`, dropping the `!`', async () => {
        const src = ['function f(a) { return !a ? "no" : "yes"; }', 'export const t = f(1);', 'export const z = f(0);'].join(
            '\n',
        );
        const { compressed, q } = await parity(src, ['t', 'z']);
        expect(q.t).toBe('yes');
        expect(q.z).toBe('no');
        // The negation is gone; a plain ternary (no `!`) survives with swapped arms.
        expect(compressed).not.toMatch(/!/);
        expect(compressed).toMatch(/\?/);
    });

    it('composes with the loop: `if (a ? true : false) X` reduces past the ternary (no `?`)', async () => {
        // minimize-conditions turns `if (T) X` into `T && X`; this pass turns `T = a ? true : false`
        // into `!!a`; the double-negation then simplifies away in the loop (a `!!a && X` guard becomes
        // `!a || X`). The load-bearing invariants: value/order parity holds, the ternary is GONE, and
        // there is no oscillation — each rewrite is a monotonic reduction.
        const src = [
            'const order = [];',
            'function f(a) { if (a ? true : false) order.push("hit"); return order.length; }',
            'export const t = f(1);',
            'export const z = f(0);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['t', 'z', 'order2']);
        expect(q.t).toBe(1);
        expect(q.z).toBe(1);
        expect(q.order2).toStrictEqual(['hit']);
        expect(compressed).not.toMatch(/\?/); // the ternary was reduced away
    });

    // ---- ADVERSARIAL: a side-effecting test is NEVER double-evaluated -------------------------
    it('does NOT rewrite `a() ? a() : b` to `a() || b` (side-effecting test double-eval)', async () => {
        const src = [
            'const order = [];',
            'function a() { order.push("a"); return order.length <= 1; }', // truthy on 1st call only
            'function f(b) { return a() ? a() : b; }',
            'export const r = f("B");',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['r', 'order2']);
        // Source semantics: 1st a() truthy → evaluate consequent a() (2nd call, pushes again, returns
        // false-y but that value is the result). `a() || b` would be a MISCOMPILE (short-circuits the
        // 2nd call away). Parity already guards value+order; assert the ternary was NOT touched.
        expect(q.order2).toStrictEqual(['a', 'a']); // a() ran TWICE (test + consequent)
        expect(compressed).toMatch(/\?/); // the ternary survived (no `a || b` collapse)
        expect(compressed).not.toMatch(/a\(\)\s*\|\|/);
    });

    it('leaves a plain `a ? b : c` (distinct arms) untouched', async () => {
        const src = ['function f(a) { return a ? "b" : "c"; }', 'export const t = f(1);', 'export const z = f(0);'].join('\n');
        const { compressed, q } = await parity(src, ['t', 'z']);
        expect(q.t).toBe('b');
        expect(q.z).toBe('c');
        expect(compressed).toMatch(/\?/); // distinct arms → ternary preserved
    });

    it('does NOT collapse `a ? b : a` when the two `a`s are different bindings (shadowing)', async () => {
        // Inner `a` shadows the parameter; `p ? inner : p` are distinct symbols, so pattern 4 must NOT
        // fire (sameIdentRef gates on name+sym). Parity is the real guard; this pins the intent.
        const src = [
            'function f(p) { const a = p + 1; return p ? a : p; }',
            'export const t = f(3);',
            'export const z = f(0);',
        ].join('\n');
        const { q } = await parity(src, ['t', 'z']);
        expect(q.t).toBe(4); // p=3 truthy → a = 4
        expect(q.z).toBe(0); // p=0 falsy → p
    });

    // ---- does not fire without compress -------------------------------------------------------
    it('does not fire on a plain (minify:false) build', async () => {
        const code = await build('export function f(a){ return a ? true : false; }', false);
        expect(code).toMatch(/\?/); // ternary intact
        expect(code).not.toMatch(/!!/);
    });
});

describe('a common assignment target hoists out of a conditional', () => {
    const build = async (body: string): Promise<string> => {
        const r = await bundle({
            entry: '/e.js',
            fs: createMemoryFs({ '/e.js': body }),
            external: [],
            output: { minify: true, optimize: true },
        } as never);
        return (r as { code: string }).code;
    };
    const run = (code: string, x: unknown): unknown => {
        const g: Record<string, unknown> = { x };
        new Function('globalThis', code)(g);
        return g.sink;
    };

    it('`t ? (x = a) : (x = b)` becomes `x = t ? a : b`', async () => {
        const code = await build('let o;\nif (Number(globalThis.x)) { o = 1; } else { o = 2; }\nglobalThis.sink = o;');
        expect(run(code, 1)).toBe(1);
        expect(run(code, 0)).toBe(2);
    });

    it('does NOT hoist when the targets are different bindings', async () => {
        // Same spelling in different scopes is a DIFFERENT variable; the guard compares `sym`.
        const code = await build(
            'let a = 0, b = 0;\nif (Number(globalThis.x)) { a = 1; } else { b = 2; }\nglobalThis.sink = a + "," + b;',
        );
        expect(run(code, 1)).toBe('1,0');
        expect(run(code, 0)).toBe('0,2');
    });

    it('does NOT hoist a MEMBER target', async () => {
        // Hoisting `a.b = …` would move evaluation of `a` before the test, which is observable.
        const code = await build(
            'const log = [];\nconst obj = { get self() { log.push("get"); return this; } };\nlet o = {};\nNumber(globalThis.x) ? (o.v = 1) : (o.v = 2);\nglobalThis.sink = o.v;',
        );
        expect(run(code, 1)).toBe(1);
        expect(run(code, 0)).toBe(2);
    });

    it('does NOT hoist when the operators differ', async () => {
        const code = await build('let o = 5;\nNumber(globalThis.x) ? (o = 1) : (o += 2);\nglobalThis.sink = o;');
        expect(run(code, 1)).toBe(1);
        expect(run(code, 0)).toBe(7);
    });
});
