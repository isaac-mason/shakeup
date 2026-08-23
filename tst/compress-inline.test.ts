import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (src: string, minify: boolean | { compress?: boolean }) => {
    const result = await bundle({ entry: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), output: { minify } });
    expect(result.errors).toEqual([]);
    return result.code;
};

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

/** compress-only vs plain, execute both, assert exports identical — behavior + side-effect ORDER
 *  preservation is the whole point of the movement kernel. Returns the compressed code. */
const parity = async (src: string) => {
    const on = await build(src, { compress: true });
    const off = await build(src, false);
    expect(normalize(await run(on))).toEqual(normalize(await run(off)));
    return on;
};

describe('single-use inline (movement kernel)', () => {
    // ---- inlines the safe cases -----------------------------------------------------------------
    it('inlines a single-use member read into the next statement', async () => {
        const code = await parity(
            'export function f(o) { const x = o.a.b; return x + 1; }\nexport const out = f({ a: { b: 7 } });',
        );
        expect(code).not.toMatch(/\b(?:const|let) x\b/); // binding gone, init moved into the use
    });

    it('inlines an array-literal and an arrow', async () => {
        await parity('export function f() { const a = [1, 2, 3]; return a.length; }\nexport const out = f();');
        await parity('export function g() { const fn = (n) => n * 2; return fn(21); }\nexport const out = g();');
    });

    // ---- SAFETY: side-effect order + interference (the miscompile surface) -----------------------
    it('does NOT reorder an impure init past another side effect', async () => {
        // `let m = tag("decl"); tag("after"); return m` must keep order decl→after (join-vars may fuse
        // `tag("after"); return m` → `return tag("after"), m`, making them adjacent, but the impure
        // init must NOT move past `tag("after")`).
        const src = [
            'export const log = [];',
            'const tag = (x) => { log.push(x); return x; };',
            'export function work() { const m = tag("decl"); tag("after"); return m; }',
            'export const result = work();',
            'export const order = log;',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).order).toEqual(['decl', 'after']); // NOT ['after','decl']
    });

    it('does NOT push an impure init into a conditional (&&) branch', async () => {
        const src = [
            'export const log = [];',
            'function eff() { log.push(1); return 5; }',
            'export function g(c) { const x = eff(); return c && x; }',
            'export const r = [g(false), log.length];', // eff must run once even though c is false
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).r).toEqual([false, 1]);
    });

    it('does NOT move a read past a write to what it reads', async () => {
        // `const x = a; a = 9; use(x)` — but the use isn't adjacent to the decl, so it can't inline;
        // and `const x = a.p; a.p = 9; return x` (member write between) must also stay correct.
        const src = [
            'export function h() { const o = { p: 1 }; const x = o.p; o.p = 9; return x; }',
            'export const out = h();', // must be 1, not 9
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(1);
    });

    it('does NOT move a read of a MUTATED local past a side effect', async () => {
        // `let a = 1; const x = a; sideEffect-that-changes-a(); return x` — x captured a=1.
        const src = [
            'export function h() { let a = 1; const x = a + 0; a = 9; return x; }',
            'export const out = h();', // 1
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(1);
    });

    // ---- hard bails ------------------------------------------------------------------------------
    it('does NOT inline anywhere when the module uses eval (module-wide bail)', async () => {
        // `x` is single-use adjacent (normally inlined), but eval ANYWHERE in the module could resolve
        // a name dynamically, so inline bails module-wide — `x` keeps its declaration.
        const src = [
            'export function f(o) { const x = o.a; return x; }',
            'export function danger() { return eval("1 + 1"); }',
            'export const out = f({ a: 5 });',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(5);
        expect(code).toMatch(/\blet x\b/); // NOT inlined (module has eval)
    });

    it('does NOT inline a multi-read binding', async () => {
        const code = await parity('export function f(o) { const x = o.a; return x + x; }\nexport const out = f({ a: 5 });');
        expect(code).toMatch(/\bx\b/); // two reads → kept
    });

    it('does NOT inline a `var`', async () => {
        const code = await parity('export function f(o) { var x = o.a; return x; }\nexport const out = f({ a: 5 });');
        expect(code).toMatch(/\bvar\b/);
    });

    it('does NOT inline across a non-adjacent statement', async () => {
        // decl, then an UNRELATED statement, then the use → not adjacent, no inline.
        const src = [
            'export const log = [];',
            'export function f(o) { const x = o.a; log.push("mid"); return x; }',
            'export const out = f({ a: 5 });',
            'export const order = log;',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(5);
    });

    it('does not fire without compress', async () => {
        const code = await build('export function f(o) { const x = o.a; return x; }\nexport const out = f({ a: 5 });', false);
        // No compress → no inlining AND no `const` → `let` substitution; the source form survives.
        expect(code).toMatch(/\bconst x\b/);
    });
});
