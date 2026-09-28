import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (src: string, minify: boolean | { compress?: boolean; mangle?: boolean; whitespace?: boolean }) => {
    const result = await bundle({ entry: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), output: { minify } });
    expect(result.errors).toEqual([]);
    return result.chunks[0].code;
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

/** Code with every space removed — these builds enable compress but not whitespace minification, so
 *  `1 / 0` and `1/0` are the same output. */
const tight = (code: string): string => code.replace(/\s+/g, '');

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

    // ---- `Infinity` -> `1/0`, and the two guards that make identifier substitution safe ----

    it('global Infinity → 1/0, behavior preserved', async () => {
        const src = 'export const a = Infinity;\nexport const b = -Infinity;\nexport const c = 1 / Infinity;';
        const code = await assertParity(src);
        expect(tight(code)).toContain('1/0');
        expect(code).not.toMatch(/\bInfinity\b/);
        const m = await run(code);
        expect(m.a).toBe(Infinity);
        expect(m.b).toBe(-Infinity);
        expect(m.c).toBe(0);
    });

    it('parenthesises 1/0 wherever a division would rebind', async () => {
        // oxc wraps when `minify && precedence >= Multiply`, or when negative and `>= Prefix`
        // (`codegen/gen.rs`). Unparenthesised, `2*1/0` is `(2*1)/0` — still Infinity by luck — but
        // `1/1/0` is `(1/1)/0`, which is Infinity where `1/(1/0)` is 0. The parity check is what
        // actually decides this; the text assertions only say where the parens landed.
        // an unknown operand, so the per-module dead-code pass has nothing to fold first
        const code = await assertParity(
            'export const a = (globalThis.k ?? 2) * Infinity;\nexport const b = (globalThis.k ?? 1) / Infinity;\nexport const c = -Infinity;',
        );
        expect(tight(code)).toContain('*(1/0)');
        expect(tight(code)).toContain('/(1/0)');
        expect(tight(code)).toContain('-(1/0)');
    });

    it('a locally-shadowed `Infinity` is NOT substituted', async () => {
        // The falsification arm for the `sym === 0` gate. Written the way the `undefined` shadow
        // test above is, and for the same reason: a LITERAL init (`let Infinity = 3`) is
        // constant-propagated away, so the fixture passes with the gate deleted and proves nothing.
        // A param-derived init survives, and two reads keep single-use inline off it.
        const src = ['function f(x) {', '  let Infinity = x + 1;', '  return Infinity + Infinity;', '}', 'export const out = f(21);'].join('\n');
        const code = await assertParity(src);
        expect(code).toMatch(/\bInfinity\b/);
        expect(tight(code)).not.toContain('1/0');
        expect((await run(code)).out).toBe(44);
    });

    it('never substitutes into an assignment TARGET', async () => {
        // `undefined = 1` is valid syntax — a no-op in sloppy mode, a TypeError in strict — and
        // `void 0 = 1` does not parse at all. Six shapes reach the identifier hook; each one used to
        // emit output a browser rejects, from a build reporting no errors. oxc cannot hit this: its
        // assignment targets are a different node type from its expressions.
        const shapes = [
            'undefined = 1;',
            'undefined++;',
            '[undefined] = v;',
            '({ undefined } = v);',
            '({ k: undefined } = v);',
            'for (undefined in v) {}',
            'Infinity = 1;',
            '[Infinity] = v;',
        ];
        for (const shape of shapes) {
            const code = await build(`export function f(v) { ${shape} }`, { compress: true });
            // The real assertion: it PARSES. `new Function` throws a SyntaxError otherwise.
            expect(() => new Function(code.replace(/export\s*\{[^}]*\};?/g, '')), shape).not.toThrow();
            expect(code, shape).not.toContain('void 0=');
            expect(code, shape).not.toContain('1/0=');
        }
    });

    it('still substitutes a destructuring DEFAULT, which is a read', async () => {
        // The falsification arm for the target guard: marking the whole pattern subtree would be
        // safe and would quietly stop optimising every default in the program.
        const code = await build('export function f(v) { let a; [a = undefined] = v; return a; }', { compress: true });
        expect(code).toContain('void 0');
    });

    it('never substitutes the argument of `delete`', async () => {
        // `delete undefined` is `false`; `delete void 0` is `true`. Same for `delete Infinity` vs
        // `delete 1/0`. oxc bails via `is_unary_delete_ancestor`, walking up through sequences.
        //
        // Reached through a COMMONJS module, which is sloppy — `delete <identifier>` is a
        // SyntaxError in strict mode, so an ES module cannot express it and shakeup rejects it.
        const src = { '/m.ts': 'import { f, g, h } from "./c.cjs";\nexport const r = [f(), g(), h()];' };
        const cjs = 'exports.f = () => delete undefined;\nexports.g = () => delete Infinity;\nexports.h = () => delete (0, Infinity);';
        const result = await bundle({
            entry: '/m.ts',
            fs: createMemoryFs({ ...src, '/c.cjs': cjs }),
            output: { minify: { compress: true } },
        });
        expect(result.errors).toEqual([]);
        const code = result.chunks[0].code;
        expect(tight(code)).toContain('deleteundefined');
        expect(tight(code)).toContain('deleteInfinity');
        // Through a sequence, too — `delete (0, X)` is `true` either way, but oxc walks through it
        // and so does this.
        expect(tight(code)).toContain('delete(0,Infinity)');
    });

    it('does NOT fire without compress (plain build keeps literals)', async () => {
        const code = await build('export const a = true;\nexport const b = undefined;', false);
        expect(code).toMatch(/\btrue\b/);
        expect(code).not.toContain('!0');
        // `undefined` -> `void 0` is the per-module dead-code pass's normalize, not this substitution;
        // rolldown prints the same with minification off
        expect(code).toContain('void 0');
    });
});
