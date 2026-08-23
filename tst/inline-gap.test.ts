import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { runModule } from './exec-helpers.ts';

// Single-use inline across a GAP — compilecat `inline_variables` path 1 (`single_use_safe`), which
// inlines any def→use pair in the function rather than only the adjacent one. See the GAP note in
// src/passes/compress/inline.ts. Refusals are asserted by EXECUTION: moving an initializer past a
// statement that changes what it reads is a silent wrong-value bug, not a crash.

const build = async (src: string) => {
    const files: Record<string, string> = { '/e.js': src };
    const r = await bundle({
        entry: '/e.js',
        fs: { read: (i) => files[i] ?? null, exists: (i) => i in files },
        external: [],
        output: { minify: { compress: true } }, // inline is cosmetic → 'full' only
    });
    return r.code;
};

describe('single-use inline — non-adjacent use', () => {
    it('moves a freely-movable init past intervening statements', async () => {
        const code = await build(
            'function f(p) {\n  const v = p + 1;\n  if (globalThis.c) globalThis.a = 1;\n  return v;\n}\n' +
                'export const out = f(41);\n',
        );
        expect(code).not.toMatch(/\bv =/); // the declaration is gone
        expect((await runModule(code)).out).toBe(42);
    });

    it('moves past a gap that earlier passes folded into a sequence expression', async () => {
        // `a = 1; b = 2; return v` becomes `return (a = 1, b = 2, v)` before inline runs, so the gap
        // is no longer statements at all — it is assignments inside the use expression. A free init
        // must still reach the target past them.
        const code = await build(
            'function f(p) {\n  const v = p + 1;\n  globalThis.a = 1;\n  globalThis.b = 2;\n  return v;\n}\n' +
                'export const out = f(41);\n',
        );
        expect(code).not.toMatch(/\bv =/);
        expect((await runModule(code)).out).toBe(42);
    });

    it('still handles the adjacent case (no regression)', async () => {
        const code = await build('function f(p) {\n  const v = p * 2;\n  return v;\n}\nexport const out = f(21);\n');
        expect(code).not.toMatch(/\bv =/);
        expect((await runModule(code)).out).toBe(42);
    });
});

describe('single-use inline — gap refusals (each guards a wrong value)', () => {
    it('REFUSES to cross a `var` initialization of a symbol the init reads', async () => {
        // The trap: `var p = 5` is NOT a write in the ref tally, so `p` looks immutable and the init
        // looks freely movable. Moving it past the assignment would read 5 instead of undefined.
        const src =
            'function f() {\n  const v = p;\n  var p = 5;\n  globalThis.gap = 1;\n  return v;\n}\n' +
            'export const out = f();\n';
        expect((await runModule(await build(src))).out).toBe(undefined); // never 5
    });

    it('REFUSES to cross a plain reassignment of a symbol the init reads', async () => {
        const src =
            'function f(q) {\n  let p = q;\n  const v = p + 1;\n  p = 100;\n  globalThis.gap = 1;\n  return v;\n}\n' +
            'export const out = f(41);\n';
        expect((await runModule(await build(src))).out).toBe(42); // never 101
    });

    it('REFUSES to cross an update (`++`) of a symbol the init reads', async () => {
        const src =
            'function f(q) {\n  let p = q;\n  const v = p + 1;\n  p++;\n  globalThis.gap = 1;\n  return v;\n}\n' +
            'export const out = f(41);\n';
        expect((await runModule(await build(src))).out).toBe(42); // never 43
    });

    it('REFUSES to move an IMPURE init across a gap (its effect would reorder)', async () => {
        const src =
            'function f() {\n  const v = globalThis.log.push(1);\n  globalThis.log.push(2);\n  return v;\n}\n' +
            'globalThis.log = [];\nexport const out = [f(), globalThis.log.join("")];\n';
        const { out } = (await runModule(await build(src))) as unknown as { out: [number, string] };
        expect(out[1]).toBe('12'); // the effects keep their original order
    });

    it('REFUSES when the init reads a global and the gap may change it', async () => {
        // An unresolved read is mutable by definition (any call in the gap could change it).
        const src =
            'function f() {\n  const v = globalThis.n;\n  globalThis.n = 99;\n  return v;\n}\n' +
            'globalThis.n = 1;\nexport const out = f();\n';
        expect((await runModule(await build(src))).out).toBe(1); // never 99
    });

    it('does not inline a read nested in a loop body (a different statement list)', async () => {
        const src =
            'function f(p) {\n  const v = p + 1;\n  let t = 0;\n  for (let i = 0; i < 3; i++) t += v;\n  return t;\n}\n' +
            'export const out = f(1);\n';
        expect((await runModule(await build(src))).out).toBe(6);
    });
});
