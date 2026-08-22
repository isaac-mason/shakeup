import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (src: string, minify: boolean | { compress?: boolean; mangle?: boolean; whitespace?: boolean }) => {
    const result = await bundle({ entry: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), output: { minify } });
    expect(result.errors).toEqual([]);
    return result.code;
};

/** Build twice — compress-on and compress-off — and assert the two bundles produce identical runtime
 *  values for every exported key. Every substitution funnels through here so we never assert a
 *  syntactic swap without proving it preserved behavior. */
const assertParity = async (src: string) => {
    const on = await build(src, { compress: true });
    const off = await build(src, false);
    expect(await run(on)).toEqual(await run(off));
    return on;
};

describe('substitute-alternate-syntax extras (compress)', () => {
    // ── new Object() → {} , new Array() → [] (zero args, global) ──────────────────────────────────
    it('new Object() → {} and new Array() → [], behavior preserved', async () => {
        const src = [
            'export const o = new Object();',
            'export const a = new Array();',
            'export const ok = o instanceof Object && Array.isArray(a) && a.length === 0;',
        ].join('\n');
        const code = await assertParity(src);
        expect(code).toContain('{}');
        expect(code).toContain('[]');
        expect(code).not.toMatch(/new\s+Object/);
        expect(code).not.toMatch(/new\s+Array\s*\(\s*\)/);
        const m = await run(code);
        expect(m.o).toEqual({});
        expect(m.a).toEqual([]);
        expect(m.ok).toBe(true);
    });

    it('new Array(5) is NOT → [] (different length preserved)', async () => {
        const src = ['export const a = new Array(5);', 'export const len = a.length;'].join('\n');
        const code = await assertParity(src);
        // Must keep a real length-5 array — the empty-literal rewrite would break arity.
        const m = await run(code);
        expect(m.len).toBe(5);
        expect((m.a as unknown[]).length).toBe(5);
    });

    it('new Object(x) is NOT → {} (argument would be dropped)', async () => {
        const src = ['const x = { k: 1 };', 'export const same = new Object(x) === x;'].join('\n');
        const code = await assertParity(src);
        const m = await run(code);
        // Object(x) returns x itself for an object arg; {} would break that identity.
        expect(m.same).toBe(true);
    });

    it('a locally-shadowed Object/Array is NOT substituted', async () => {
        // The locals set an own field on the constructed instance, so their result is distinguishable
        // from the empty `{}`/`[]` the global rewrite would produce.
        const src = [
            'function f() {',
            '  const Object = function () { this.tag = "O"; };',
            '  const Array = function () { this.tag = "A"; };',
            '  return new Object().tag + new Array().tag;',
            '}',
            'export const out = f();',
        ].join('\n');
        const code = await assertParity(src);
        // Shadowed constructors resolve to the locals; `{}`/`[]` would have no `.tag` (→ "undefinedundefined").
        expect(code).not.toContain('{}');
        expect(code).not.toContain('[]');
        const m = await run(code);
        expect(m.out).toBe('OA');
    });

    // ── Boolean(x) → !!x (global, one arg) ────────────────────────────────────────────────────────
    it('Boolean(x) → !!x, behavior preserved', async () => {
        const src = [
            'export const a = Boolean(1);',
            'export const b = Boolean(0);',
            'export const c = Boolean("");',
            'export const d = Boolean("x");',
            'export const e = Boolean(null);',
        ].join('\n');
        const code = await assertParity(src);
        // Double-negation — the printer may space the operators (`! !x`); match either.
        expect(code).toMatch(/!\s*!/);
        expect(code).not.toMatch(/\bBoolean\s*\(/);
        const m = await run(code);
        expect(m.a).toBe(true);
        expect(m.b).toBe(false);
        expect(m.c).toBe(false);
        expect(m.d).toBe(true);
        expect(m.e).toBe(false);
    });

    it('Boolean(x) precedence: used in arithmetic / member position stays correct', async () => {
        const src = [
            'export const n = Boolean(2) + Boolean(0);', // true + false = 1
            'export const s = String(Boolean(3));', // "true"
        ].join('\n');
        const code = await assertParity(src);
        const m = await run(code);
        expect(m.n).toBe(1);
        expect(m.s).toBe('true');
    });

    it('Boolean(a, b) (2 args) is NOT touched', async () => {
        const src = ['export const v = Boolean(0, 1);'].join('\n');
        const code = await assertParity(src);
        // Conservative arity bail: keep the call verbatim.
        expect(code).toMatch(/\bBoolean\s*\(/);
        const m = await run(code);
        expect(m.v).toBe(false); // Boolean ignores the 2nd arg — first arg 0 → false
    });

    it('a locally-shadowed Boolean is NOT substituted', async () => {
        const src = [
            'function f() {',
            '  const Boolean = (x) => x + 100;',
            '  return Boolean(5);',
            '}',
            'export const out = f();',
        ].join('\n');
        const code = await assertParity(src);
        expect(code).not.toMatch(/!\s*!/);
        const m = await run(code);
        expect(m.out).toBe(105);
    });

    // ── new Error(…) → Error(…) ───────────────────────────────────────────────────────────────────
    it('new Error(msg) → Error(msg), behavior preserved', async () => {
        const src = [
            'const e = new Error("boom");',
            'export const msg = e.message;',
            'export const isErr = e instanceof Error;',
            'export const te = new TypeError("bad") instanceof TypeError;',
        ].join('\n');
        const code = await assertParity(src);
        expect(code).not.toMatch(/new\s+Error/);
        expect(code).not.toMatch(/new\s+TypeError/);
        const m = await run(code);
        expect(m.msg).toBe('boom');
        expect(m.isErr).toBe(true);
        expect(m.te).toBe(true);
    });

    it('a locally-shadowed Error is NOT stripped of new', async () => {
        const src = [
            'function f() {',
            '  const Error = function (m) { this.tag = "custom:" + m; };',
            '  return new Error("x").tag;', // needs `new` to build the instance
            '}',
            'export const out = f();',
        ].join('\n');
        const code = await assertParity(src);
        const m = await run(code);
        expect(m.out).toBe('custom:x');
    });

    // ── return undefined; → return; ──────────────────────────────────────────────────────────────
    it('return undefined; and return void 0; → return;, behavior preserved', async () => {
        const src = [
            'function a() { return undefined; }',
            'function b() { return void 0; }',
            'function c() { return; }',
            'export const ra = a();',
            'export const rb = b();',
            'export const rc = c();',
            'export const okA = a() === undefined;',
        ].join('\n');
        const code = await assertParity(src);
        const m = await run(code);
        expect(m.ra).toBe(undefined);
        expect(m.rb).toBe(undefined);
        expect(m.rc).toBe(undefined);
        expect(m.okA).toBe(true);
    });

    it('return <non-undefined> is untouched', async () => {
        const src = ['function f() { return 42; }', 'export const out = f();'].join('\n');
        const code = await assertParity(src);
        const m = await run(code);
        expect(m.out).toBe(42);
    });

    it('a locally-shadowed undefined in return position is NOT dropped', async () => {
        const src = [
            'function f() {',
            '  let undefined = 7;',
            '  return undefined;', // resolves to the local 7, must not become `return;`
            '}',
            'export const out = f();',
        ].join('\n');
        const code = await assertParity(src);
        const m = await run(code);
        expect(m.out).toBe(7);
    });

    // ── does not fire without compress ────────────────────────────────────────────────────────────
    it('none of the extras fire without compress', async () => {
        const src = [
            'export const o = new Object();',
            'export const a = new Array();',
            'export const b = Boolean(1);',
            'export const e = new Error("x").message;',
        ].join('\n');
        const code = await build(src, false);
        expect(code).toMatch(/new\s+Object/);
        expect(code).toMatch(/new\s+Array/);
        expect(code).toMatch(/\bBoolean\s*\(/);
        expect(code).toMatch(/new\s+Error/);
    });
});
