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
 *  values for every exported key. Every substitution case funnels through here so we never assert a
 *  syntactic swap without proving it preserved behavior. */
const assertParity = async (src: string) => {
    const on = await build(src, { compress: true });
    const off = await build(src, false);
    expect(await run(on)).toEqual(await run(off));
    return on;
};

describe('substitute-alternate-syntax (compress)', () => {
    it('true → !0 and false → !1, behavior preserved', async () => {
        const src = 'export const a = true;\nexport const b = false;';
        const code = await assertParity(src);
        expect(code).toContain('!0');
        expect(code).toContain('!1');
        expect(code).not.toMatch(/\btrue\b/);
        expect(code).not.toMatch(/\bfalse\b/);
        const m = await run(code);
        expect(m.a).toBe(true);
        expect(m.b).toBe(false);
    });

    it('global undefined → void 0, behavior preserved', async () => {
        const src = 'export const u = undefined;\nexport const isU = undefined === undefined;';
        const code = await assertParity(src);
        expect(code).toContain('void 0');
        expect(code).not.toMatch(/\bundefined\b/);
        const m = await run(code);
        expect(m.u).toBe(undefined);
        expect(m.isU).toBe(true);
    });

    it('undefined in various expression positions stays behavior-correct (precedence parens)', async () => {
        const src = [
            'export const viaCall = (() => undefined)();',
            'export const cond = (1 > 0 ? undefined : 5);',
            'export const arr = [undefined, undefined];',
        ].join('\n');
        const code = await assertParity(src);
        expect(code).toContain('void 0');
        const m = await run(code);
        expect(m.viaCall).toBe(undefined);
        expect(m.cond).toBe(undefined);
        expect(m.arr).toEqual([undefined, undefined]);
    });

    // ── ADVERSARIAL ──────────────────────────────────────────────────────────────────────────────
    it('a locally-shadowed `undefined` is NOT substituted', async () => {
        // Legal non-strict nested rebind. A param-derived (non-literal) init so constant-propagation
        // leaves it — the inner `undefined` resolves to the local, must print its name not `void 0`.
        // Two reads so single-use inline leaves it. The init is `x + 1`, NOT a bare `x`: a bare
        // identifier init makes this an alias (`let undefined = x`), which alias-inline correctly
        // rewrites to `x` everywhere, dissolving the shadow before alternate-syntax ever sees it —
        // right, but it would stop this fixture from isolating alternate-syntax's shadow check.
        const src = ['function f(x) {', '  let undefined = x + 1;', '  return undefined + undefined;', '}', 'export const out = f(21);'].join('\n');
        const code = await assertParity(src);
        // The shadowed reference survives as the name `undefined` (bound to x + 1), not `void 0`.
        expect(code).toMatch(/\bundefined\b/);
        expect((await run(code)).out).toBe(44);
    });

    it('a property NAMED `undefined`/`true`/`false` is untouched', async () => {
        const src = [
            'const o = { undefined: 1, true: 2, false: 3 };',
            'export const a = o.undefined;',
            'export const b = o.true;',
            'export const c = o.false;',
        ].join('\n');
        const code = await assertParity(src);
        // Keys are IdentifierName, not references/literals — they must remain verbatim.
        expect(code).toMatch(/\bundefined\b/);
        expect(code).toMatch(/\btrue\b/);
        expect(code).toMatch(/\bfalse\b/);
        const m = await run(code);
        expect(m.a).toBe(1);
        expect(m.b).toBe(2);
        expect(m.c).toBe(3);
    });

    it('shorthand `{ undefined }` expands to `undefined: void 0`, behavior preserved', async () => {
        // The shorthand VALUE is a global `undefined` reference; expanding it must keep the object shape.
        const src = [
            'const undefinedRef = undefined;',
            'const o = { undefined: undefinedRef };',
            'export const has = "undefined" in o;',
            'export const val = o.undefined;',
        ].join('\n');
        const code = await assertParity(src);
        const m = await run(code);
        expect(m.has).toBe(true);
        expect(m.val).toBe(undefined);
    });

    it('does NOT fire without compress (plain build keeps literals)', async () => {
        const code = await build('export const a = true;\nexport const b = undefined;', false);
        expect(code).toMatch(/\btrue\b/);
        expect(code).toMatch(/\bundefined\b/);
        expect(code).not.toContain('!0');
        expect(code).not.toContain('void 0');
    });
});
