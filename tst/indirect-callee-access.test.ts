import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';

// Folding `(true && o.f)` to `o.f` is free everywhere EXCEPT in a call's callee or a tagged
// template's tag: `(true && o.f)()` calls `f` with `this === undefined`, `o.f()` with `this === o`.
// oxc's `should_keep_indirect_access` exists for exactly this, and its doc comment names the case:
//
//     let o = { f() { assert.ok(this !== o); } }; (true && o.f)(); (true && o.f)``;
//
// The fix both bundlers use is to fold to `(0, o.f)` — a sequence expression whose value is the
// function but whose reference is not a member reference. shakeup folded to `o.f`, silently changing
// `this`. rollupsuite's `sequence-expressions-template-tag`; node confirms all three forms give
// `this !== o`.
const build = async (src: string, opt = false) => {
    const r = await bundle({
        entry: '/main.js',
        fs: createMemoryFs({ '/main.js': src }),
        external: [],
        ...(opt ? { output: { minify: true, optimize: true } } : {}),
    } as never);
    expect(r.errors).toEqual([]);
    return r.chunks.map((c) => c.code).join('\n');
};
const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const SRC = [
    'let o = { f() { return this !== o; } };',
    'export const seq = (1, o.f)();',
    'export const and = (true && o.f)();',
    'export const cond = (true ? o.f : false)();',
    'export const tagged = (true && o.f)``;',
].join('\n');

describe('a folded callee keeps its access indirect', () => {
    for (const opt of [false, true]) {
        it(`preserves \`this\` through every fold${opt ? ' (minify+optimize)' : ''}`, async () => {
            const mod = await run(await build(SRC, opt));
            expect(mod.seq, 'sequence').toBe(true);
            expect(mod.and, 'logical').toBe(true);
            expect(mod.cond, 'conditional').toBe(true);
            expect(mod.tagged, 'tagged template').toBe(true);
        });
    }

    it('does NOT wrap where `this` is not at stake', async () => {
        // Only the callee/tag position binds `this`. Wrapping an argument or an assignment RHS would
        // be pure bloat, so the guard has to stay narrow.
        const code = await build(
            [
                'const o = { f: 1 };',
                'export const g = (x) => x;',
                'export const v = (true && o.f);',
                'export const w = [true ? o.f : 0];',
                // An ARGUMENT of a call, whose parent IS a CallExpression — the case a parent-type
                // check gets wrong. Only the callee slot binds `this`.
                'export const a = g(true && o.f);',
                'export const b = g(true ? o.f : 0);',
            ].join('\n'),
            true,
        );
        expect(code).not.toContain('(0,');
    });
});
