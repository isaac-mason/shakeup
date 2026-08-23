import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (src: string, minify: boolean | { compress?: boolean; mangle?: boolean; whitespace?: boolean }) => {
    const result = await bundle({ entry: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), output: { minify } });
    expect(result.errors).toEqual([]);
    return result.code;
};

/** Build the same source un-minified and compress-only, execute BOTH bundles, and assert every
 *  named export is identical — including any `order` array the program records call order into. A
 *  minimize-conditions rewrite is only legal if it preserves runtime value AND side-effect order
 *  exactly, so this is the load-bearing guard. */
const parity = async (src: string, keys: string[]) => {
    const plain = await build(src, false);
    const compressed = await build(src, { compress: true });
    const p = await run(plain);
    const q = await run(compressed);
    for (const k of keys) expect(q[k]).toStrictEqual(p[k]);
    return { plain, compressed, p, q };
};

describe('minimize-conditions (compress)', () => {
    // ---- rewrite 1: `if (a) b();` (no else) → `a && b();` -------------------------------------
    it('rewrites else-less if with a single expr statement into `a && b()`', async () => {
        const src = [
            'const order = [];',
            'function go(cond) { if (cond) order.push("hit"); return order.length; }',
            'export const t = go(true);',
            'export const f = go(false);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['t', 'f', 'order2']);
        expect(q.t).toBe(1);
        expect(q.f).toBe(1);
        expect(q.order2).toStrictEqual(['hit']);
        expect(compressed).toMatch(/&&/); // an `&&` appeared
        expect(compressed).not.toMatch(/\bif\s*\(cond\)/); // the if is gone
    });

    it('rewrites a single-statement BLOCK consequent too (`if (a) { b(); }`)', async () => {
        const src = [
            'const order = [];',
            'function go(cond) { if (cond) { order.push(1); } }',
            'go(true); go(false);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['order2']);
        expect(q.order2).toStrictEqual([1]);
        expect(compressed).toMatch(/&&/);
    });

    // ---- rewrite 2: `if (a) b(); else c();` → `a ? b() : c();` ---------------------------------
    it('rewrites if/else of expr statements into a ternary expression statement', async () => {
        const src = [
            'const order = [];',
            'function go(cond) { if (cond) order.push("y"); else order.push("n"); }',
            'go(true); go(false); go(true);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['order2']);
        expect(q.order2).toStrictEqual(['y', 'n', 'y']);
        expect(compressed).toMatch(/\?/);
        expect(compressed).toMatch(/:/);
        expect(compressed).not.toMatch(/\belse\b/);
    });

    // ---- rewrite 3: `if (a) return x; else return y;` → `return a ? x : y;` --------------------
    it('rewrites if/else of returns into a single ternary return', async () => {
        const src = [
            'function pick(cond) { if (cond) return "a"; else return "b"; }',
            'export const t = pick(true);',
            'export const f = pick(false);',
        ].join('\n');
        const { compressed, q } = await parity(src, ['t', 'f']);
        expect(q.t).toBe('a');
        expect(q.f).toBe('b');
        expect(compressed).toMatch(/return[^;]*\?/); // return over a ternary
        expect(compressed).not.toMatch(/\belse\b/);
    });

    it('rewrites the else-less follow-return form `if (a) return x; return y;`', async () => {
        const src = [
            'function pick(cond) { if (cond) return 10; return 20; }',
            'export const t = pick(true);',
            'export const f = pick(false);',
        ].join('\n');
        const { compressed, q } = await parity(src, ['t', 'f']);
        expect(q.t).toBe(10);
        expect(q.f).toBe(20);
        expect(compressed).toMatch(/return[^;]*\?/);
        // only ONE `return` survives in pick (the two collapsed into one ternary return)
        const returns = (compressed.match(/return/g) ?? []).length;
        expect(returns).toBe(1);
    });

    // ---- precedence: real nodes get parenthesized correctly by the printer --------------------
    it('parenthesizes a sequence test in `(a, b) && c()`', async () => {
        const src = [
            'const order = [];',
            'function go(x) { if ((order.push("a"), x)) order.push("b"); }',
            'go(1); go(0);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['order2']);
        // go(1): pushes "a" (from the sequence test) then "b"; go(0): pushes only "a".
        expect(q.order2).toStrictEqual(['a', 'b', 'a']);
        expect(compressed).toMatch(/\(.*,.*\)\s*&&/); // the sequence test kept its parens
    });

    // ---- ADVERSARIAL: multi-statement / declaration branches are NOT collapsed ----------------
    it('composes with join-vars: a two-expr branch is sequence-merged then collapsed to `a && (…)`', async () => {
        // minimize-conditions alone bails on a multi-statement branch, but join-vars first folds the
        // two `order.push` calls into one comma sequence, so the branch becomes a single statement
        // and DOES collapse — an emergent, behavior-preserving improvement from pass composition.
        const src = [
            'const order = [];',
            'function go(cond) { if (cond) { order.push(1); order.push(2); } }',
            'go(true); go(false);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['order2']);
        expect(q.order2).toStrictEqual([1, 2]); // order preserved: pushes only when cond truthy
        expect(compressed).toMatch(/&&/); // collapsed via the sequence-merged branch
        expect(compressed).not.toMatch(/\bif\s*\(cond\)/);
    });

    it('does NOT collapse a branch containing a let/const declaration', async () => {
        // `z` is read TWICE (inline/drop-unused leave it) in EFFECTFUL statements (remove-unused-expr
        // keeps them; join-vars fuses them into one sequence). The block then keeps a `let` + a
        // statement — never a single simple statement — so minimize-conditions bails. This is the
        // genuinely-irreducible branch that isolates its "don't collapse a decl branch" rule.
        const src = [
            'const order = [];',
            'function go(cond) { if (cond) { const z = order.push("z"); order.push(z + 10); order.push(z + 20); } }',
            'go(true); go(false);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['order2']);
        expect(q.order2).toStrictEqual(['z', 11, 21]);
        expect(compressed).toMatch(/\bif\b/); // a `let`-containing block never collapses
    });

    it('composes with drop-unused: an unused-const branch becomes a bare call then collapses', async () => {
        // The `const z` is never referenced, so drop-unused rewrites `const z = order.push("c")` to the
        // bare `order.push("c")` (keeping the impure effect); the branch is now a single expression
        // statement and minimize-conditions collapses it to `cond && order.push("c")`. Behavior-preserving.
        const src = [
            'const order = [];',
            'function go(cond) { if (cond) { const z = order.push("c"); } }',
            'go(true); go(false);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['order2']);
        expect(q.order2).toStrictEqual(['c']); // the push still ran (effect preserved), only when cond
        expect(compressed).toMatch(/&&/);
        expect(compressed).not.toMatch(/\bif\s*\(cond\)/);
    });

    it('does NOT collapse `if (a) return x; return;` (bare trailing return)', async () => {
        const src = [
            'function pick(cond) { if (cond) return 1; return; }',
            'export const t = pick(true);',
            'export const f = pick(false);',
        ].join('\n');
        const { compressed, q } = await parity(src, ['t', 'f']);
        expect(q.t).toBe(1);
        expect(q.f).toBe(undefined);
        expect(compressed).toMatch(/\bif\b/); // no fold — bare `return;` blocks the ternary
    });

    it('does NOT restructure an else-if chain (bails on the non-simple else branch)', async () => {
        const src = [
            'function pick(n) { if (n === 0) return "z"; else if (n === 1) return "o"; else return "m"; }',
            'export const a = pick(0);',
            'export const b = pick(1);',
            'export const c = pick(2);',
        ].join('\n');
        const { q } = await parity(src, ['a', 'b', 'c']);
        expect(q.a).toBe('z');
        expect(q.b).toBe('o');
        expect(q.c).toBe('m');
    });

    // ---- does not fire without compress -------------------------------------------------------
    it('does not fire on a plain (minify:false) build', async () => {
        const code = await build('function go(c){ if (c) globalThis.x = 1; }\nexport const out = go;', false);
        expect(code).toMatch(/\bif\s*\(c\)/);
        expect(code).not.toMatch(/c\s*&&/);
    });
});
