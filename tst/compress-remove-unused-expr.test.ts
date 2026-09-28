import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (src: string, minify: boolean | { compress?: boolean }) => {
    const result = await bundle({ entry: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), output: { minify } });
    expect(result.errors).toEqual([]);
    return result.chunks[0].code;
};

/** No compress at all: `minify: false` still runs the per-module dead-code pass whenever tree-shaking is
 *  on, as rolldown's does, so this turns tree-shaking off too. */
const buildUntouched = async (src: string) => {
    const result = await bundle({ entry: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), treeshake: false, output: { minify: false } });
    expect(result.errors).toEqual([]);
    return result.chunks[0].code;
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

/** compress-only vs plain, execute both, assert exports identical — including side-effect ORDER. */
const parity = async (src: string) => {
    const on = await build(src, { compress: true });
    const off = await build(src, false);
    expect(normalize(await run(on))).toEqual(normalize(await run(off)));
    return on;
};

describe('remove-unused-expression (compress)', () => {
    it('drops a fully pure expression statement', async () => {
        const code = await parity(
            'export function f() { 1 + 2; "dead"; [1, 2, 3]; typeof f; return 5; }\nexport const out = f();',
        );
        expect(code).not.toMatch(/"dead"/);
        expect(code).not.toMatch(/typeof/);
    });

    it('strips pure parts of a sequence, keeping effects', async () => {
        const src = [
            'export const log = [];',
            'function eff(x) { log.push(x); }',
            'export function f() { (eff("a"), 5, eff("b")); return log.length; }',
            'export const out = f();',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(2); // both effs kept, `5` dropped
    });

    it('keeps only effectful array elements', async () => {
        const src = [
            'export const log = [];',
            'function eff() { log.push(1); return 9; }',
            'export function f() { [1, eff(), 3, eff()]; return log.length; }',
            'export const out = f();',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(2);
    });

    it('strips a pure right operand of `&&`, keeping the guard + effect ordering', async () => {
        const src = [
            'export const log = [];',
            'function eff() { log.push(1); return true; }',
            'export function f(c) { c && (eff(), 0); return log.length; }',
            'export const out = [f(true), f(false)];', // eff runs only when c truthy
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toEqual([1, 1]);
    });

    it('KEEPS a member read (getter-conservative — no pure-getter assumption)', async () => {
        const src = [
            'export const log = [];',
            'const o = { get a() { log.push("get"); return 1; } };',
            'export function f() { o.a; return log.length; }',
            'export const out = f();', // the getter must still fire
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(1);
    });

    it('KEEPS an impure call (its effect cannot be stripped)', async () => {
        const src = [
            'export const log = [];',
            'function eff() { log.push(1); }',
            'export function f() { eff(); return log.length; }',
            'export const out = f();',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe(1);
        expect(code).toMatch(/eff|push/);
    });

    // oxc `test_fold_call_expression`: `/* @__PURE__ */ foo(a, b)` → `a, b`, `foo(...a)` → `[...a]`, `foo(...'a')` → ``.
    it('reduces a discarded pure call to what its arguments do, in order', async () => {
        const src = [
            'export const log = [];',
            'function make(...parts) { log.push("make"); return parts; }',
            'function eff(x) { log.push(x); return x; }',
            'export function f() { /* @__PURE__ */ make(eff("a"), 1, eff("b")); /* @__PURE__ */ make(); return log.join(","); }',
            'export const out = f();',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe('a,b');
    });

    it("keeps a pure call's spread of an unknown iterable, and drops one of a string", async () => {
        const src = [
            'export const log = [];',
            'function make() { log.push("make"); }',
            'const iterable = { *[Symbol.iterator]() { log.push("iterated"); } };',
            'export function f() { /* @__PURE__ */ make(...iterable); /* @__PURE__ */ make(..."ab"); return log.join(","); }',
            'export const out = f();',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe('iterated');
    });

    it('reduces a discarded pure `new` to its arguments', async () => {
        const src = [
            'export const log = [];',
            'class Thing { constructor() { log.push("built"); } }',
            'function eff(x) { log.push(x); }',
            'export function f() { /* @__PURE__ */ new Thing(eff("arg")); return log.join(","); }',
            'export const out = f();',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe('arg');
    });

    // oxc `test_object_literal`: `({ ...baz, [bar()]: foo() })` → `({ ...baz }), bar(), foo()`.
    it('keeps only the effectful keys, values and spreads of a discarded object, in order', async () => {
        const src = [
            'export const log = [];',
            'function eff(x) { log.push(x); return x; }',
            'const source = { get a() { log.push("spread"); return 1; } };',
            'export function f() { ({ plain: 1, ...source, [eff("key")]: eff("value"), nested: { deep: eff("deep") } }); return log.join(","); }',
            'export const out = f();',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe('spread,key,value,deep');
        expect(code).not.toMatch(/plain/);
    });

    // oxc `test_fold_conditional_expression`: `foo() ? 1 : bar()` → `foo() || bar()`, `foo() ? bar() : 2` → `foo() && bar()`.
    it('reduces a discarded conditional to its test and the effectful branch', async () => {
        const src = [
            'export const log = [];',
            'function eff(x) { log.push(x); return x; }',
            'export function f() { eff(true) ? 1 : eff("else"); eff(false) ? 1 : eff("else"); eff(true) ? eff("then") : 2; eff(0) ? 1 : 2; return log.join(","); }',
            'export const out = f();',
        ].join('\n');
        const code = await parity(src);
        expect((await run(code)).out).toBe('true,false,else,true,then,0');
    });

    it('does not fire when compress and tree-shaking are off', async () => {
        const code = await buildUntouched('export function f() { [1, 2, 3]; return 5; }\nexport const out = f();');
        expect(code).toMatch(/\[1,\s?2,\s?3\]/); // dead array literal kept without compress
    });
});
