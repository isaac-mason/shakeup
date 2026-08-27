import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import { parse } from '../src/parser/index.ts';

// `using r = res()` / `await using` — explicit resource management. 7 webpack files, and the first
// construct found by `pnpm parsercorpus` that BOTH oracles parse AND bundle: they emit it verbatim,
// so there is nothing to lower. That makes it a feature to support, not one to refuse — unlike
// `import source` and `with`.
//
// The grammar is contextual and NARROWER than `let`: only a BindingIdentifier (no destructuring) and
// no LineTerminator after the keyword. Each boundary below was confirmed against `oxc-parser`, which
// reads `using [a] = r()` as a MEMBER assignment, `using = 1` as an assignment, and `using\n a = r()`
// as two statements.
const errs = (src: string) => parse(src, { ts: false, jsx: false, kind: 'module' }).errors;
const build = async (src: string, opts: Record<string, unknown> = {}) =>
    bundle({ entry: '/main.js', external: [], fs: createMemoryFs({ '/main.js': src }), ...opts });

describe('using declarations', () => {
    it.each([
        ['inside a function', 'function f() { using a = r(); }'],
        ['with several declarators', 'function f() { using a = r(), b = s(); }'],
        ['at the top level of a module', 'using a = r();'],
    ])('parses %s', (_label, src) => {
        expect(errs(src)).toEqual([]);
    });

    it('records the declaration kind', () => {
        const fn = parse('function f() { using a = r(); }', { ts: false, jsx: false, kind: 'module' }).program.data.body[0];
        const inner = (fn.data as { body: { data: { body: { data: { kind: string } }[] } } }).body.data.body[0];
        expect(inner.data.kind).toBe('using');
    });

    it.each([
        ['`using` as a plain binding', 'const using = 1;'],
        ['`using` as an assignment target', 'using = 1;'],
        ['a member access on `using`', 'function f() { using.a = 1; }'],
        ['a computed access (NOT destructuring)', 'function f() { using [a] = r(); }'],
        ['a call to a function named `using`', 'function f() { using(1); }'],
        ['a line break after the keyword', 'function f() { using\n a = r(); }'],
    ])('keeps %s an expression', (_label, src) => {
        expect(errs(src)).toEqual([]);
    });

    describe('await using', () => {
        it.each([
            ['in an async function', 'async function f() { await using a = r(); }'],
            ['in a plain function (oxc is lenient here too)', 'function f() { await using a = r(); }'],
            ['at the top level of a module', 'await using a = r();'],
        ])('parses %s', (_label, src) => {
            expect(errs(src)).toEqual([]);
        });

        it('records the `await using` kind', () => {
            const fn = parse('async function f() { await using a = r(); }', { ts: false, jsx: false, kind: 'module' }).program
                .data.body[0];
            const inner = (fn.data as { body: { data: { body: { data: { kind: string } }[] } } }).body.data.body[0];
            expect(inner.data.kind).toBe('await using');
        });

        it.each([
            ['awaiting a variable named `using`', 'async function f() { const using = 1; await using; }'],
            ['awaiting a call to a `using`-prefixed name', 'async function f() { await usingFoo(); }'],
            ['an ordinary await', 'async function f() { await x; }'],
        ])('leaves %s alone', (_label, src) => {
            expect(errs(src)).toEqual([]);
        });

        it('emits `await using` verbatim', async () => {
            const r = await build('export async function f() {\n  await using a = g();\n  return 1;\n}\nexport const x = 1;');
            expect(r.errors).toEqual([]);
            expect(r.code).toMatch(/await using a = g\(\)/);
        });
    });

    describe('in a for-of head', () => {
        it.each([
            ['`for (using x of xs)`', 'function f() { for (using x of xs) {} }'],
            ['`for (await using x of xs)`', 'async function f() { for (await using x of xs) {} }'],
        ])('parses %s', (_label, src) => {
            expect(errs(src)).toEqual([]);
        });

        it('`for (using of xs)` still iterates INTO a variable named `using`', () => {
            // The spec preserves this meaning, so `using` followed by `of` is never a declaration.
            // Treating it as one made the head expect a second `of` and fail.
            expect(errs('function f() { for (using of xs) {} }')).toEqual([]);
        });

        it.each([
            ['an ordinary const head', 'function f() { for (const x of xs) {} }'],
            ['a classic three-part head', 'function f() { for (let i = 0; i < 1; i++) {} }'],
            ['`for await`', 'async function f() { for await (const x of xs) {} }'],
            ['a bare target', 'function f() { for (x of xs) {} }'],
            ['a for-in head', 'function f() { for (var x in o) {} }'],
        ])('does not disturb %s', (_label, src) => {
            expect(errs(src)).toEqual([]);
        });

        it('emits the for-of `using` head verbatim', async () => {
            const r = await build('export function f() {\n  for (using x of globalThis.xs) { x.t() }\n}\nexport const x = 1;');
            expect(r.errors).toEqual([]);
            expect(r.code).toMatch(/for \(using x of/);
        });
    });

    describe('bundling', () => {
        it('emits `using` verbatim, as both oracles do', async () => {
            const r = await build('export function f() {\n  using a = g(), b = h();\n  return 1;\n}\nexport const x = 1;');
            expect(r.errors).toEqual([]);
            expect(r.code).toMatch(/using a = g\(\), b = h\(\)/);
        });

        it('survives minification', async () => {
            const r = await build('export function f() {\n  using r = g();\n  return 1;\n}\nexport const x = 1;', {
                output: { minify: true },
            });
            expect(r.errors).toEqual([]);
            expect(r.code).toContain('using');
        });

        it('an UNUSED `using` binding is never dropped', async () => {
            // The bug this guards: dropping an unused binding and keeping its initializer for side
            // effects is correct for `let`/`const` and WRONG here — it deletes the `[Symbol.dispose]`
            // call that runs at scope exit, which is the whole point of the declaration.
            // `using r = { … }` was being rewritten to a bare expression statement.
            const r = await build(
                'export function f() {\n  using r = { [Symbol.dispose]() {} };\n  return 1;\n}\nexport const x = 1;',
            );
            expect(r.errors).toEqual([]);
            expect(r.code).toMatch(/using r =/);
        });

        it('the disposal actually runs', async () => {
            const r = await build(
                'function f() {\n  using r = { [Symbol.dispose]() { globalThis.__usingDisposed = true } };\n  return 1;\n}\nconst v = f();\nexport const x = [v, globalThis.__usingDisposed ?? false];',
            );
            expect(r.errors).toEqual([]);
            const ns = (await import(`data:text/javascript,${encodeURIComponent(r.code)}`)) as { x: unknown };
            expect(ns.x).toEqual([1, true]);
        });

        it('an unused `const` IS still reduced to its initializer', async () => {
            // The bail must be scoped to `using` — the ordinary optimisation has to keep working.
            const r = await build('export function f() {\n  const c = g();\n  return 1;\n}\nexport const x = 1;');
            expect(r.errors).toEqual([]);
            expect(r.code).not.toMatch(/const c =/);
        });
    });
});
