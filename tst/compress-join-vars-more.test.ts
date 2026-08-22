// Statement-fusion (oxc `minimize_statements.rs`) extension of the join-vars/sequences compress pass:
//   1. expr(s) → return  : `a(); b(); return x;` → `return (a(), b(), x);`
//   2. expr(s) → throw    : `a(); b(); throw x;`  → `throw (a(), b(), x);`
//   3. expr(s) → if-test  : `a(); if (t) …`       → `if ((a(), t)) …`
// Each case is comma-order-preserving, so both EXECUTION PARITY (compress-vs-plain exports) and the
// OBSERVABLE SIDE-EFFECT ORDER (an exported log array) must be identical. We also assert the syntactic
// fusion actually happened in the compressed output.
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
 *  compressed code back so the caller can also assert the syntactic fusion happened. */
const both = async (src: string): Promise<{ code: string; min: Record<string, unknown>; plain: Record<string, unknown> }> => {
    const code = await build(src, true);
    const plainCode = await build(src, false);
    const min = await run(code);
    const plain = await run(plainCode);
    expect(normalize(min)).toEqual(normalize(plain));
    return { code, min, plain };
};

describe('statement fusion (compress) — expr → return / throw / if-test', () => {
    // FUSION #1 — expression statements immediately before a `return <arg>` fold into the return arg
    // via a comma sequence. Order of the folded effects and the returned value is preserved.
    it('fuses preceding expression statements into a return argument', async () => {
        const src = `
            const log = [];
            const tag = (x) => { log.push(x); return x; };
            function work() {
                tag('e-1');
                tag('e-2');
                return tag('ret');
            }
            export const result = work();
            export const order = log;`;
        const { code, min, plain } = await both(src);
        expect(min.result).toBe('ret');
        expect(min.order).toEqual(['e-1', 'e-2', 'ret']);
        expect(min.order).toEqual(plain.order);
        // The two exprs fold into the return argument as one comma sequence (a `return` arg needs no
        // extra parens — `return a, b, x;` already parses as `return (a, b, x);`).
        expect(code).toMatch(/return tag\('e-1'\), tag\('e-2'\), tag\('ret'\)/);
    });

    // A single preceding expression statement also fuses (run length 1 + return).
    it('fuses a single preceding expression statement into a return argument', async () => {
        const src = `
            const log = [];
            const tag = (x) => { log.push(x); return x; };
            function work() {
                tag('only');
                return tag('ret');
            }
            export const result = work();
            export const order = log;`;
        const { code, min, plain } = await both(src);
        expect(min.result).toBe('ret');
        expect(min.order).toEqual(['only', 'ret']);
        expect(min.order).toEqual(plain.order);
        expect(code).toMatch(/return tag\('only'\), tag\('ret'\)/);
    });

    // FUSION #2 — expression statements immediately before a `throw <arg>` fold into the throw arg.
    // Caught so the side effects (and the throw itself) are observable without aborting the test.
    it('fuses preceding expression statements into a throw argument (caught)', async () => {
        const src = `
            const log = [];
            const tag = (x) => { log.push(x); return x; };
            function boom() {
                tag('t-1');
                tag('t-2');
                throw tag('err');
            }
            export const caught = (() => { try { boom(); } catch (e) { return e; } })();
            export const order = log;`;
        const { code, min, plain } = await both(src);
        expect(min.caught).toBe('err');
        expect(min.order).toEqual(['t-1', 't-2', 'err']);
        expect(min.order).toEqual(plain.order);
        // The two exprs fold into the throw argument as one comma sequence (`throw` needs no parens).
        expect(code).toMatch(/throw tag\('t-1'\), tag\('t-2'\), tag\('err'\)/);
    });

    // FUSION #3 — an expression statement immediately before an `if` folds into the if TEST. Both the
    // taken and not-taken branches must observe the folded effect exactly once, before the test.
    it('fuses a preceding expression statement into an if-test (taken branch)', async () => {
        const src = `
            const log = [];
            const tag = (x) => { log.push(x); return x; };
            function work(cond) {
                tag('pre');
                if (cond) {
                    tag('then');
                    return 'T';
                }
                tag('else');
                return 'F';
            }
            export const t = work(true);
            export const f = work(false);
            export const order = log;`;
        const { code, min, plain } = await both(src);
        expect(min.t).toBe('T');
        expect(min.f).toBe('F');
        // 'pre' effect runs before the test on BOTH invocations, in order.
        expect(min.order).toEqual(['pre', 'then', 'pre', 'else']);
        expect(min.order).toEqual(plain.order);
        // The `tag('pre')` expr folds into the if-test as `(tag('pre'), cond)`. (minimize-conditions
        // may then rewrite the whole `if` into a ternary, but the fused test survives as the ternary's
        // condition — either way the fused comma sequence `(tag('pre'), cond)` appears verbatim.)
        expect(code).toMatch(/\(tag\('pre'\), cond\)/);
    });

    // COMPOSITION — several expr statements before an if fold as one flat comma sequence into the test
    // (the SEQUENCES pass may pre-merge them; the fixed-point loop then fuses the merged sequence in,
    // and we flatten so it is `(a, b, test)` not `((a, b), test)`).
    it('fuses a run of expression statements into an if-test as one flat sequence', async () => {
        const src = `
            const log = [];
            const tag = (x) => { log.push(x); return x; };
            function work(cond) {
                tag('p-1');
                tag('p-2');
                if (cond) return 'yes';
                return 'no';
            }
            export const y = work(true);
            export const n = work(false);
            export const order = log;`;
        const { code, min, plain } = await both(src);
        expect(min.y).toBe('yes');
        expect(min.n).toBe('no');
        expect(min.order).toEqual(['p-1', 'p-2', 'p-1', 'p-2']);
        expect(min.order).toEqual(plain.order);
        // Flat, not nested: the two exprs and the test collapse into one comma list `tag('p-1'),
        // tag('p-2'), cond` — never a nested `(tag('p-1'), tag('p-2')), cond`. (Downstream passes may
        // fold the bodyless if into a ternary, but the flat fused sequence remains verbatim.)
        expect(code).toMatch(/tag\('p-1'\), tag\('p-2'\), cond/);
        expect(code).not.toMatch(/\(tag\('p-1'\), tag\('p-2'\)\), cond/);
    });

    // ADVERSARIAL — a bare `return;` (no argument) is NOT a fusion target in v1: we do not rewrite
    // `a(); return;` to `return a();`. The preceding exprs still SEQUENCE-fold, but the return stays.
    it('does NOT fuse into a bare argument-less return', async () => {
        const src = `
            const log = [];
            const tag = (x) => { log.push(x); return x; };
            function work() {
                tag('a');
                tag('b');
                return;
            }
            export const result = (work(), 'ok');
            export const order = log;`;
        const { code, min, plain } = await both(src);
        expect(min.result).toBe('ok');
        expect(min.order).toEqual(['a', 'b']);
        expect(min.order).toEqual(plain.order);
        // The exprs still comma-fold, but there is no `return (…)` fusion into a bare return.
        expect(code).toMatch(/tag\('a'\), tag\('b'\)/);
        expect(code).not.toMatch(/return \(/);
    });

    // ADVERSARIAL — a "use strict" directive-like string-literal statement must NOT fuse into the
    // following return (that would demote the directive). The real exprs still fold.
    it('does NOT fuse a directive-like statement into a following return', async () => {
        const src = `
            const log = [];
            const tag = (x) => { log.push(x); return x; };
            function work() {
                "use strict";
                tag('x');
                return tag('ret');
            }
            export const result = work();
            export const order = log;`;
        const { code, min, plain } = await both(src);
        expect(min.result).toBe('ret');
        expect(min.order).toEqual(['x', 'ret']);
        expect(min.order).toEqual(plain.order);
        // The directive is not swallowed into the return sequence.
        expect(code).not.toMatch(/return.*use strict/);
        // The real expr still fuses into the return.
        expect(code).toMatch(/return tag\('x'\), tag\('ret'\)/);
    });

    // ADVERSARIAL — a declaration between an expr and the return breaks the fusion run: the `let`
    // cannot be folded, so the return keeps its own argument and only what's adjacent can fuse.
    it('does NOT fuse across an intervening declaration before a return', async () => {
        const src = `
            const log = [];
            const tag = (x) => { log.push(x); return x; };
            function work() {
                tag('before');
                let mid = tag('decl');
                return mid;
            }
            export const result = work();
            export const order = log;`;
        const { code, min, plain } = await both(src);
        expect(min.result).toBe('decl');
        expect(min.order).toEqual(['before', 'decl']);
        expect(min.order).toEqual(plain.order);
        // `tag('before')` is separated from the return by the `let`, so it is not folded into `mid`.
        expect(code).not.toMatch(/return \(tag\('before'\)/);
    });
});
