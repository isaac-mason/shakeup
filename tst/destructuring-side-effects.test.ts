import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

// DESTRUCTURING READS PROPERTIES, and a property read can run a getter. We judged a declarator by its
// INIT alone — `obj` is a bare identifier, therefore pure — and dropped the whole statement, losing
// the side effect:
//
//     Object.defineProperty(obj, 'x', { get() { ++effects } });
//     const { x } = obj;        // x unused, but the getter must STILL fire
//
// All three oracles keep it, measured on this exact input: rollup's `propertyReadSideEffects`
// defaults to true, and rolldown and esbuild agree. rollup's `propertyReadSideEffects-always` sample
// counts four reads; we produced three.
const HEAD = "let effects = 0;\nvar obj = {};\nObject.defineProperty(obj, 'x', { get() { ++effects; } });\nlet value;\n";

const effectsOf = async (stmt: string): Promise<unknown> => {
    const r = await bundle({
        entry: '/main.js',
        fs: createMemoryFs({ '/main.js': `${HEAD}${stmt}\nexport const n = effects;` }),
    });
    expect(r.errors).toEqual([]);
    return ((await import(`data:text/javascript,${encodeURIComponent(r.code)}`)) as { n: unknown }).n;
};

describe('an unused destructuring declaration still performs its reads', () => {
    it.each([
        ['object pattern declaration', 'const {x} = obj;'],
        ['destructuring assignment', '({x: value} = obj);'],
        ['member expression statement', 'obj.x;'],
        ['computed member statement', 'obj["x"];'],
        ['nested pattern', 'const {x: {} = {}} = obj;'],
        ['pattern with a default', 'const {x = 1} = obj;'],
    ])('%s', async (_name, stmt) => {
        expect(await effectsOf(stmt)).toBe(1);
    });

    it("all four of rollup's reads fire together", async () => {
        const n = await effectsOf('({x: value} = obj);\nobj.x;\nobj["x"];\nconst {x} = obj;');
        expect(n).toBe(4);
    });

    it('a plain unused binding is still dropped — this did not disable shaking', async () => {
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({ '/main.js': 'const unused = 1;\nexport const a = 2;' }),
        });
        expect(r.errors).toEqual([]);
        expect(r.code).not.toContain('unused');
    });
});
