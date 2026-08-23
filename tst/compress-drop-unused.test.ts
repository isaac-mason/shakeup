import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (src: string, minify: boolean | { compress?: boolean }) => {
    const result = await bundle({ entry: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), output: { minify } });
    expect(result.errors).toEqual([]);
    return result.code;
};

/** Build the source both un-minified and compress-only, execute both, and assert the exported `out`
 *  is bit-for-bit identical. EXECUTION PARITY is the load-bearing guard: drop-unused is only allowed
 *  if it preserves runtime behavior exactly. Returns both bundles + the shared `out`. */
const parity = async (src: string, expected?: unknown) => {
    const plain = await build(src, false);
    const compressed = await build(src, { compress: true });
    const plainOut = (await run(plain)).out;
    const compressedOut = (await run(compressed)).out;
    expect(compressedOut).toStrictEqual(plainOut);
    if (expected !== undefined) expect(compressedOut).toStrictEqual(expected);
    return { plain, compressed, out: compressedOut };
};

describe('drop-unused (compress)', () => {
    it('removes an unused local `const` with a PURE init', async () => {
        const src = `
            export function f() {
                const unusedPure = 1 + 2;   // no references anywhere → droppable (pure)
                return 'kept';
            }
            export const out = f();`;
        const { compressed, out } = await parity(src, 'kept');
        expect(out).toBe('kept');
        // The dead binding and its pure init are gone.
        expect(compressed).not.toMatch(/unusedPure/);
    });

    it('removes an unused local `let` with a PURE init', async () => {
        const src = `
            export function f() {
                let deadLet = [1, 2, 3];   // pure array literal, never read
                return 42;
            }
            export const out = f();`;
        const { compressed, out } = await parity(src, 42);
        expect(out).toBe(42);
        expect(compressed).not.toMatch(/deadLet/);
    });

    it('KEEPS the side effect of an unused local with an IMPURE init (records it still ran)', async () => {
        // The binding is dead but its initializer calls a function that pushes into an exported
        // array — proving the side effect executed even though the binding was removed.
        const src = `
            export const effects = [];
            function fx() { effects.push('ran'); return 7; }
            export function f() {
                const deadImpure = fx();   // binding unused; the call MUST still run
                return 'body';
            }
            export const out = (() => { const r = f(); return { r, effects: effects.slice() }; })();`;
        const plain = await build(src, false);
        const compressed = await build(src, { compress: true });
        const p = (await run(plain)).out as { r: string; effects: string[] };
        const q = (await run(compressed)).out as { r: string; effects: string[] };
        expect(q).toStrictEqual(p);
        expect(q.r).toBe('body');
        expect(q.effects).toEqual(['ran']); // the impure init's effect survived the drop
        // The dead binding name is gone, but the call that produced the effect remains.
        expect(compressed).not.toMatch(/deadImpure/);
        expect(compressed).toMatch(/fx\s*\(\s*\)/);
    });

    it('KEEPS a USED local binding', async () => {
        // Non-literal init + TWO reads so neither constant-propagation nor single-use inline removes
        // it — isolates drop-unused's "don't remove a referenced binding" behavior.
        const src = `
            export function f(x) {
                const used = x * 2;
                return used + used;   // referenced (twice) → must stay
            }
            export const out = f(5);`;
        const { compressed, out } = await parity(src, 20);
        expect(out).toBe(20);
        expect(compressed).toMatch(/used/); // the referenced binding is preserved
    });

    it('KEEPS an EXPORTED (module-scope) binding even if it looks unused (treeshake owns it)', async () => {
        // `helper` is exported → module scope → drop-unused must never touch it.
        const src = `
            export const helper = 123;
            export const out = 'ok';`;
        const { compressed } = await parity(src, 'ok');
        expect(compressed).toMatch(/helper/);
        const m = await run(compressed);
        expect(m.helper).toBe(123);
        expect(m.out).toBe('ok');
    });

    it('does NOT touch `var` (hoisting/redeclaration hazard)', async () => {
        const src = `
            export function f() {
                var v = 5;   // unused, but a var — never removed in v1
                return 'v-kept';
            }
            export const out = f();`;
        const { compressed, out } = await parity(src, 'v-kept');
        expect(out).toBe('v-kept');
        expect(compressed).toMatch(/\bvar\b/); // the var declaration survives
    });

    it('does NOT touch destructuring patterns (possible getter/iterator side effects)', async () => {
        // `a` is never referenced, but it comes from a destructuring bind whose act of destructuring
        // may run a getter — we conservatively keep the whole pattern.
        const src = `
            export const log = [];
            const source = { get a() { log.push('getter'); return 1; } };
            export function f() {
                const { a } = source;   // destructuring → NEVER removed; the getter must run
                return 'done';
            }
            export const out = (() => { const r = f(); return { r, log: log.slice() }; })();`;
        const plain = await build(src, false);
        const compressed = await build(src, { compress: true });
        const p = (await run(plain)).out as { r: string; log: string[] };
        const q = (await run(compressed)).out as { r: string; log: string[] };
        expect(q).toStrictEqual(p);
        expect(q.log).toEqual(['getter']); // destructuring getter still ran
    });

    it('KEEPS a binding used only inside a NESTED function/closure', async () => {
        // Non-literal init so constant-propagation leaves it — isolates the closure-capture case.
        const src = `
            export function f(x) {
                const captured = x + 98;           // referenced only by the closure below
                const g = () => captured + 1;
                return g;
            }
            export const out = f(1)();`;
        const { compressed, out } = await parity(src, 100);
        expect(out).toBe(100);
        expect(compressed).toMatch(/captured/); // the captured binding survives
    });

    it('treats a self-referencing init (`const x = x`) as used and BAILS', async () => {
        // `const x = x` references the outer/global `x` (or TDZ) — regardless, the init contains an
        // IdentifierReference, so our use-count is ≥1 and we never remove it. Parity proves behavior.
        const src = `
            var x = 5;                       // outer x (a var at module scope)
            export function f() {
                { const x = x + 1; return 'noref'; }   // never referenced after decl; self-ref in init
            }
            export const out = (() => { try { return f(); } catch (e) { return 'tdz'; } })();`;
        const plain = await build(src, false);
        const compressed = await build(src, { compress: true });
        expect((await run(compressed)).out).toStrictEqual((await run(plain)).out);
    });

    it('drops only the unused declarators in a multi-declarator PURE declaration, keeps the used one', async () => {
        const src = `
            export function f() {
                const a = 1, b = 2, c = 3;   // only b is referenced
                return b;
            }
            export const out = f();`;
        const { compressed, out } = await parity(src, 2);
        expect(out).toBe(2);
        // The two unused pure declarators are gone; the referenced one stays.
        expect(compressed).not.toMatch(/\ba\b\s*=\s*1/);
        expect(compressed).not.toMatch(/\bc\b\s*=\s*3/);
    });

    it('parity across a mixed program with used, unused-pure, unused-impure, var, and closures', async () => {
        const src = [
            'export const log = [];',
            'function eff(tag) { log.push(tag); return tag.length; }',
            'export function f() {',
            '    const usedPure = 3;',
            '    const deadPure = 100;',
            '    const deadImpure = eff("x");',
            '    var deadVar = 7;',
            '    const closed = 11;',
            '    const g = () => closed + usedPure;',
            '    return g();',
            '}',
            'export const out = (() => { const r = f(); return { r, log: log.slice() }; })();',
        ].join('\n');
        const plain = await build(src, false);
        const compressed = await build(src, { compress: true });
        const p = (await run(plain)).out as { r: number; log: string[] };
        const q = (await run(compressed)).out as { r: number; log: string[] };
        expect(q).toStrictEqual(p);
        expect(q.r).toBe(14); // closed(11) + usedPure(3)
        expect(q.log).toEqual(['x']); // deadImpure's effect ran; deadPure/deadVar/closed did nothing
    });

    it('does not fire when compress is explicitly disabled (plain build keeps the unused binding)', async () => {
        const src = `
            export function f() { const unusedPure = 1; return 'x'; }
            export const out = f();`;
        const code = await build(src, { compress: false });
        expect(code).toMatch(/unusedPure/);
        expect((await run(code)).out).toBe('x');
    });
});
