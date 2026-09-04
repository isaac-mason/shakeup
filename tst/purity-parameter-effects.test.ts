import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';

// A parameter list is not decoration. A default value and a computed key in a destructuring pattern
// both RUN on every call, so they are part of what calling the function does — Rollup checks them
// explicitly in `FunctionBase.hasEffectsOnInteractionAtPath`, which loops the params and returns true
// on `parameter.hasEffects(context)`.
//
// shakeup summarized only the BODY, so
//
//     function test({ [getPatternValueWithEffect()]: value }) {}
//     test({ value: 'foo' });
//
// was a call to an empty function: provably pure, deleted whole, and the effect never ran. node runs
// the program and reports the effect happened. rollupsuite's `parameter-side-effects`.
const build = async (src: string) => {
    const r = await bundle({ entry: '/main.js', fs: createMemoryFs({ '/main.js': src }), external: [] } as never);
    expect(r.errors).toEqual([]);
    return r.chunks.map((c) => c.code).join('\n');
};
const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

describe('a call whose PARAMETERS have effects is not pure', () => {
    it('keeps a computed key in a destructuring pattern', async () => {
        const code = await build(
            [
                'let effect = false;',
                "function key() { effect = true; return 'value'; }",
                'function test({ [key()]: value }) {}',
                "test({ value: 'foo' });",
                'export const e = effect;',
            ].join('\n'),
        );
        expect((await run(code)).e).toBe(true);
    });

    it('keeps a side-effecting DEFAULT value', async () => {
        const code = await build(
            [
                'let n = 0;',
                'function bump() { n = 1; return 1; }',
                'function test(a = bump()) {}',
                'test();',
                'export const v = n;',
            ].join('\n'),
        );
        expect((await run(code)).v).toBe(1);
    });

    it('a FUNCTION-valued default is still inert — defining one runs nothing', async () => {
        // The nested-function skip has to hold inside a parameter too. node confirms: `test()` with
        // `cb = () => { effect = true }` leaves `effect` false, because the arrow is never called.
        const code = await build(
            [
                'let effect = false;',
                'function test(cb = () => { effect = true; }) {}',
                'test();',
                'export const e = effect;',
            ].join('\n'),
        );
        expect((await run(code)).e).toBe(false);
        expect(code, 'and the whole call is still shaken out').not.toContain('test(');
    });

    it('still elides a call whose parameters are inert', async () => {
        // The widening must stay narrow: an ordinary empty function with plain params is still pure.
        const code = await build(['function test(a, b = 1, { c } = {}) {}', 'test(2);', 'export const ok = 1;'].join('\n'));
        expect(code, 'the pure call is still shaken out').not.toContain('test(');
    });
});
