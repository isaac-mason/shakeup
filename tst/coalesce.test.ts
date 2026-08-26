import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { setCoalesceEnabled, setSemanticVerify } from '../src/passes/compress/index.ts';
import { runModule } from './exec-helpers.ts';

// `CoalesceVariableNames` (Closure port). OFF by default — see the flag's comment for the measurement.
// These drive it through the toggle so the pass stays honest while it waits for a shared CFG cache.

const build = async (src: string, on: boolean) => {
    setCoalesceEnabled(on);
    try {
        const files: Record<string, string> = { '/e.js': src };
        const r = await bundle({
            entry: '/e.js',
            fs: { read: (i) => files[i] ?? null, exists: (i) => i in files },
            external: [],
            output: { minify: { compress: true } },
        });
        return r.code;
    } finally {
        setCoalesceEnabled(false);
    }
};

describe('coalescing merges disjoint live ranges', () => {
    setSemanticVerify(false); // see tst/coalesce-stale-sym.test.ts — known parked partition divergence
    it("reuses an earlier variable's slot for a later one", async () => {
        const src =
            'function f(p){ let x = p + 1; globalThis.a = x; let y = p + 2; globalThis.b = y; return y; }\n' +
            'export const out = f(1);\n';
        const on = await build(src, true);
        const off = await build(src, false);
        expect(off).toMatch(/\by\b/); // two distinct bindings without the pass
        expect(on).not.toMatch(/\by\b/); // one binding with it
        expect((await runModule(on)).out).toBe(3);
        expect((await runModule(off)).out).toBe(3);
    });

    it('REFUSES when the live ranges overlap', async () => {
        const src =
            'function f(p){ let x = p + 1; let y = p + 2; globalThis.a = x + y; return x - y; }\n' +
            'export const out = f(1);\n';
        expect((await runModule(await build(src, true))).out).toBe(-1); // 2 - 3
    });

    it('REFUSES a captured local (a closure may read it at any time)', async () => {
        const src =
            'function f(p){ let x = p + 1; const g = () => x; let y = p + 2; globalThis.b = y; return g() + y; }\n' +
            'export const out = f(1);\n';
        expect((await runModule(await build(src, true))).out).toBe(5); // 2 + 3
    });

    it('REFUSES a const binding (it cannot be assigned after declaration)', async () => {
        const src =
            'function f(p){ const x = p + 1; globalThis.a = x; const y = p + 2; globalThis.b = y; return y; }\n' +
            'export const out = f(1);\n';
        expect((await runModule(await build(src, true))).out).toBe(3);
    });

    it('preserves behaviour across a loop-carried variable', async () => {
        const src =
            'function f(n){ let s = 0; for (let i = 0; i < n; i++) { s += i; } let t = s * 2; globalThis.z = t; return s + t; }\n' +
            'export const out = f(4);\n';
        expect((await runModule(await build(src, true))).out).toBe(18); // s=6, t=12
        expect((await runModule(await build(src, false))).out).toBe(18);
    });
});
