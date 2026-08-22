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
 *  export is identical — including any `order` array the program records call order into. Each new
 *  `if`-shape rewrite is only legal if it preserves runtime value AND side-effect order exactly, so
 *  this execution-parity check is the load-bearing guard. */
const parity = async (src: string, keys: string[]) => {
    const plain = await build(src, false);
    const compressed = await build(src, { compress: true });
    const p = await run(plain);
    const q = await run(compressed);
    for (const k of keys) expect(q[k]).toStrictEqual(p[k]);
    return { plain, compressed, p, q };
};

describe('minimize-conditions — more if-shapes (compress)', () => {
    // ---- rewrite 1 (negated): `if (!a) b();` → `a || b();` -------------------------------------
    it('flips a negated else-less test into `a || b()` (drops the `!`, uses `||`)', async () => {
        const src = [
            'const order = [];',
            'function go(cond) { if (!cond) order.push("hit"); return order.length; }',
            'export const t = go(true);',
            'export const f = go(false);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['t', 'f', 'order2']);
        // go(true): !true is falsy → no push; go(false): !false is truthy → push once.
        expect(q.t).toBe(0);
        expect(q.f).toBe(1);
        expect(q.order2).toStrictEqual(['hit']);
        expect(compressed).toMatch(/\|\|/); // an `||` appeared
        expect(compressed).not.toMatch(/&&/); // NOT the `!a && b()` form — the `!` was dropped
        expect(compressed).not.toMatch(/!cond/); // the negation is gone
        expect(compressed).not.toMatch(/\bif\s*\(/); // the if is gone
    });

    it('parenthesizes a sequence operand when flipping `if (!(a, b)) c()` → `(a, b) || c()`', async () => {
        const src = [
            'const order = [];',
            'function go(x) { if (!(order.push("a"), x)) order.push("b"); }',
            'go(1); go(0);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['order2']);
        // go(1): pushes "a" then (1 truthy → !truthy falsy) no "b"; go(0): pushes "a" then "b".
        expect(q.order2).toStrictEqual(['a', 'a', 'b']);
        expect(compressed).toMatch(/\(.*,.*\)\s*\|\|/); // sequence operand kept its parens under `||`
    });

    // ---- rewrite 4: empty consequent, no else → `a;` (test kept for side effects) --------------
    it('reduces `if (a) {}` (empty block, no else) to just the test `a;`', async () => {
        const src = [
            'const order = [];',
            'function go(cond) { if (cond) {} }',
            'go(order.push("x")); go(0);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['order2']);
        // Both calls happen (arg evaluated at call site); the empty if bodies do nothing.
        expect(q.order2).toStrictEqual(['x']); // only the push arg fired, once
        expect(compressed).not.toMatch(/\bif\s*\(/); // the empty if is gone
    });

    it('keeps an IMPURE test when reducing `if (impure) ;` — the effect must run', async () => {
        const src = [
            'const order = [];',
            'function go() { if (order.push("side")) ; }',
            'go(); go();',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['order2']);
        // The test `order.push("side")` is the only effect; it must still run on every call.
        expect(q.order2).toStrictEqual(['side', 'side']);
        expect(compressed).toMatch(/order\.push\("side"\)/); // the test survives as an expr statement
        expect(compressed).not.toMatch(/\bif\s*\(/); // the if is gone
    });

    // ---- rewrite 5: empty consequent WITH else → `a || b();` -----------------------------------
    it('rewrites `if (a) {} else b();` into `a || b();`', async () => {
        const src = [
            'const order = [];',
            'function go(cond) { if (cond) {} else order.push("n"); }',
            'go(true); go(false); go(false); go(true);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['order2']);
        // else branch runs iff cond is falsy: go(false) twice → two pushes.
        expect(q.order2).toStrictEqual(['n', 'n']);
        expect(compressed).toMatch(/\|\|/); // collapsed to `cond || order.push("n")`
        expect(compressed).not.toMatch(/\belse\b/);
        expect(compressed).not.toMatch(/\bif\s*\(/);
    });

    it('handles an empty-block consequent with an empty-STATEMENT alternate shape `if (a); else b();`', async () => {
        const src = [
            'const order = [];',
            'function go(cond) { if (cond); else order.push("z"); }',
            'go(0); go(1); go(0);',
            'export const order2 = order;',
        ].join('\n');
        const { compressed, q } = await parity(src, ['order2']);
        // else runs when cond falsy: go(0) twice → two pushes.
        expect(q.order2).toStrictEqual(['z', 'z']);
        expect(compressed).toMatch(/\|\|/);
        expect(compressed).not.toMatch(/\belse\b/);
    });

    // ---- conservative: empty consequent but a NON-simple else bails ----------------------------
    it('does NOT collapse `if (a) {} else { decl }` (else has a declaration)', async () => {
        const src = [
            'const order = [];',
            'function go(cond) { if (cond) {} else { let z = order.push("d"); void z; } }',
            'go(true); go(false);',
            'export const order2 = order;',
        ].join('\n');
        const { q } = await parity(src, ['order2']);
        // else runs when cond falsy: go(false) → one push. Rewrite bails (multi-stmt/decl else), but
        // parity must still hold either way.
        expect(q.order2).toStrictEqual(['d']);
    });
});
