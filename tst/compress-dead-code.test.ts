import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (src: string) => {
    const result = await bundle({
        entry: '/m.ts',
        fs: createMemoryFs({ '/m.ts': src }),
        output: { minify: { compress: true } },
    });
    expect(result.errors).toEqual([]);
    return result.code;
};

describe('dead-code elimination (compress)', () => {
    it('if(true) collapses to the consequent (flattened) and drops the else', async () => {
        const src = `
            export function f() {
                if (true) { return 1; } else { return 2; }
            }
            export const out = f();`;
        const code = await build(src);
        expect(code).not.toMatch(/\belse\b/);
        expect(code).not.toContain('2'); // the dead else branch is gone
        expect((await run(code)).out).toBe(1);
    });

    it('if(false) collapses to the else branch', async () => {
        const src = `
            export function f() {
                if (false) { return 1; } else { return 2; }
            }
            export const out = f();`;
        const code = await build(src);
        expect(code).not.toContain('1');
        expect((await run(code)).out).toBe(2);
    });

    it('if(false) with no else is removed entirely', async () => {
        const src = `
            export function f() {
                if (false) { return 99; }
                return 7;
            }
            export const out = f();`;
        const code = await build(src);
        expect(code).not.toContain('99');
        expect((await run(code)).out).toBe(7);
    });

    it('recognizes !0 / !1 / 0 / "" as constant tests', async () => {
        const src = `
            export function a() { if (!0) return 'a1'; return 'a2'; }   // !0 = true
            export function b() { if (!1) return 'b1'; return 'b2'; }   // !1 = false
            export function c() { if (0) return 'c1'; return 'c2'; }    // 0 = false
            export function d() { if ("") return 'd1'; return 'd2'; }   // "" = false
            export function e() { if ("x") return 'e1'; return 'e2'; }  // "x" = true
            export const out = [a(), b(), c(), d(), e()];`;
        const code = await build(src);
        const out = (await run(code)).out as string[];
        expect(out).toEqual(['a1', 'b2', 'c2', 'd2', 'e1']);
    });

    it('drops unreachable statements after a return', async () => {
        const src = `
            export function f() {
                let x = 5;
                return x;
                x = 999;      // unreachable
                return 999;   // unreachable
            }
            export const out = f();`;
        const code = await build(src);
        expect(code).not.toContain('999');
        expect((await run(code)).out).toBe(5);
    });

    it('drops unreachable statements after a throw', async () => {
        const src = `
            export function f(go) {
                if (go) throw new Error('boom');
                return 'ok';
            }
            export function g() {
                function inner() { throw new Error('x'); const dead = 1; return dead; }
                try { inner(); } catch { return 'caught'; }
            }
            export const out = g();`;
        const code = await build(src);
        expect(code).not.toContain('dead');
        expect((await run(code)).out).toBe('caught');
    });

    it('folds a ternary with a constant test to the taken branch', async () => {
        const src = `
            export const a = true ? 'yes' : 'no';
            export const b = false ? 'yes' : 'no';
            export const c = 0 ? 'yes' : 'no';
            export const d = !0 ? 'yes' : 'no';`;
        const code = await build(src);
        const m = await run(code);
        expect(m.a).toBe('yes');
        expect(m.b).toBe('no');
        expect(m.c).toBe('no');
        expect(m.d).toBe('yes');
    });

    it('collapses an else-if chain with a constant inner test', async () => {
        const src = `
            export function f(n) {
                if (n === 1) return 'one';
                else if (true) return 'always';
                else return 'never';
            }
            export const out = [f(1), f(2)];`;
        const code = await build(src);
        expect(code).not.toContain('never');
        expect((await run(code)).out).toEqual(['one', 'always']);
    });

    // THE VAR-HOISTING LANDMINE: `if (false) { var x = ...; ... }` must NOT be eliminated, because
    // `var x` hoists into the function scope. Dropping the branch would leave `x` referenced-but-
    // undeclared. We bail conservatively, so `x` stays declared (value `undefined`) and the code runs.
    it('does NOT eliminate a dead branch that hoists a `var` (semantics preserved)', async () => {
        const src = `
            export function f() {
                if (false) { var x = 10; }
                return typeof x; // x is hoisted (declared, undefined) — must be "undefined", not a ReferenceError
            }
            export const out = f();`;
        const code = await build(src);
        // The bail keeps the var binding visible; executing proves semantics are intact.
        expect((await run(code)).out).toBe('undefined');
    });

    // A block-nested `function` declaration is a hoisting hazard we bail on (conservatively safe in
    // both strict and sloppy mode). We assert the branch is left intact in the output rather than a
    // runtime `typeof`, since in a module (strict mode) a block-scoped function does not leak anyway.
    it('does NOT eliminate a dead branch that contains a `function` declaration', async () => {
        const src = `
            export function f() {
                if (false) { function g() { return 42; } }
                return 'kept';
            }
            export const out = f();`;
        const code = await build(src);
        expect(code).toMatch(/function g\b/); // the branch (and its function decl) survives the bail
        expect((await run(code)).out).toBe('kept');
    });

    it('DOES eliminate a dead branch with only block-scoped (let/const/class) decls', async () => {
        const src = `
            export function f() {
                if (false) { let y = 1; const z = 2; class C {} }
                return 'clean';
            }
            export const out = f();`;
        const code = await build(src);
        // Block-scoped decls vanish safely with their block — the branch is gone.
        expect(code).not.toMatch(/\bclass C\b/);
        expect((await run(code)).out).toBe('clean');
    });
});
