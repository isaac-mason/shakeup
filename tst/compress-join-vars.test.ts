import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (src: string, compress: boolean) => {
    const result = await bundle({
        entry: '/m.ts',
        fs: createMemoryFs({ '/m.ts': src }),
        output: { minify: compress ? { compress: true } : false },
    });
    expect(result.errors).toEqual([]);
    return result.code;
};

/** A function's identity/source legitimately differs compress-vs-plain, so compare exports generically:
 *  functions collapse to a sentinel, everything else compares structurally. */
function normalize(v: unknown): unknown {
    if (typeof v === 'function') return '$fn';
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === 'object') {
        const o: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as object)) o[k] = normalize(val);
        return o;
    }
    return v;
}

/** Bundle both ways, assert identical exports (execution parity, functions normalized), and hand the
 *  compressed code back so the caller can also assert the syntactic merge happened. */
const both = async (src: string): Promise<{ code: string; min: Record<string, unknown>; plain: Record<string, unknown> }> => {
    const code = await build(src, true);
    const plainCode = await build(src, false);
    const min = await run(code);
    const plain = await run(plainCode);
    expect(normalize(min)).toEqual(normalize(plain));
    return { code, min, plain };
};

describe('join-vars + sequences (compress)', () => {
    it('merges consecutive same-kind var declarations into one', async () => {
        const src = `
            export function f() {
                var a = 1;
                var b = 2;
                var c = 3;
                return a + b + c;
            }
            export const out = f();`;
        const { code, min } = await both(src);
        expect(min.out).toBe(6);
        // Exactly one `var ` keyword survives inside f (the three merged into one declaration).
        expect(code.match(/\bvar /g) ?? []).toHaveLength(1);
    });

    it('merges consecutive let declarations, and separately const declarations', async () => {
        // Non-literal inits (param-derived) so constant-propagation leaves the bindings for join-vars.
        const src = `
            export function f(x) {
                let a = x + 1;
                let b = x + 2;
                const c = x + 3;
                const d = x + 4;
                return a + b + c + d;
            }
            export const out = f(10);`;
        const { code, min } = await both(src);
        expect(min.out).toBe(50);
        // The two lets fuse to one, the two consts fuse to one.
        expect(code.match(/\blet /g) ?? []).toHaveLength(1);
        expect(code).toMatch(/let a = x \+ 1, b = x \+ 2/);
        expect(code).toMatch(/const c = x \+ 3, d = x \+ 4/);
    });

    it('folds consecutive expression statements into one comma sequence', async () => {
        const src = `
            export function f() {
                let s = '';
                s += 'a';
                s += 'b';
                s += 'c';
                return s;
            }
            export const out = f();`;
        const { code, min } = await both(src);
        expect(min.out).toBe('abc');
        // The three `s+=…` statements fold into one comma sequence: `s += 'a', s += 'b', s += 'c'`.
        expect(code).toMatch(/s \+= 'a', s \+= 'b', s \+= 'c'/);
    });

    // OBSERVABLE ORDER: record var-init and expr-statement effects into an exported array; the array's
    // contents (and order) must be identical minified vs not, proving left-to-right order is preserved.
    it('preserves observable order of var inits and expression statements', async () => {
        const src = `
            const log = [];
            const tag = (x) => { log.push(x); return x; };
            function work() {
                var a = tag('v-a');
                var b = tag('v-b');
                var c = tag('v-c');
                tag('e-1');
                tag('e-2');
                tag('e-3');
                return a + '|' + b + '|' + c;
            }
            export const result = work();
            export const order = log;`;
        const { min, plain } = await both(src);
        expect(min.order).toEqual(['v-a', 'v-b', 'v-c', 'e-1', 'e-2', 'e-3']);
        expect(min.order).toEqual(plain.order);
        expect(min.result).toBe('v-a|v-b|v-c');
    });

    // ADVERSARIAL: `var` then `let` are DIFFERENT kinds → must NOT merge into one declaration.
    it('does NOT merge a var declaration with an adjacent let declaration', async () => {
        // Non-literal inits so constant-propagation leaves both bindings for the (non-)merge check.
        const src = `
            export function f(x) {
                var a = x + 1;
                let b = x + 2;
                return a + b;
            }
            export const out = f(10);`;
        const { code, min } = await both(src);
        expect(min.out).toBe(23);
        // Both keywords must remain — no cross-kind fusion.
        expect(code).toMatch(/\bvar /);
        expect(code).toMatch(/\blet /);
        // The var run and the let run are each a single declarator (not fused across kinds).
        expect(code).not.toMatch(/var a = .* b =/);
        expect(code).not.toMatch(/let a = .* b =/);
    });

    // ADVERSARIAL: a non-expression statement between two expression statements breaks the sequence run.
    it('does NOT fold expression statements across an intervening non-expression statement', async () => {
        const src = `
            const log = [];
            const tag = (x) => { log.push(x); return x; };
            function work() {
                tag('before');
                let mid = tag('decl');   // a declaration breaks the expr-statement run
                tag('after');
                return mid;
            }
            export const result = work();
            export const order = log;`;
        const { code, min } = await both(src);
        expect(min.order).toEqual(['before', 'decl', 'after']);
        expect(min.result).toBe('decl');
        // The two tag() expr-statements are separated by the `let`, so they are NOT fused: no comma
        // sequence joining "before" directly to "after".
        expect(code).not.toMatch(/tag\('before'\), tag\('after'\)/);
    });

    // A "use strict" prologue is a string-literal expression statement; it must not be swallowed into a
    // comma sequence (which would strip its directive meaning). We assert the following expr-statements
    // still fold while the directive stays a standalone statement.
    it('does not fold a string-literal (directive-like) expression statement into a sequence', async () => {
        const src = `
            const log = [];
            const tag = (x) => { log.push(x); return x; };
            function work() {
                "use strict";
                tag('x');
                tag('y');
                return 'done';
            }
            export const result = work();
            export const order = log;`;
        const { code, min } = await both(src);
        expect(min.order).toEqual(['x', 'y']);
        expect(min.result).toBe('done');
        // The directive is not comma-joined to a following call.
        expect(code).not.toMatch(/use strict', /);
        // The two real calls still fold.
        expect(code).toMatch(/tag\('x'\), tag\('y'\)/);
    });
});
