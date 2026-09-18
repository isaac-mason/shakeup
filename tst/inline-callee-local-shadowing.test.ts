import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

// A BLOCK splice puts the argument expressions and the callee's own locals in ONE scope:
//
//   { const nodeIndex = topo[idx * 5]; const topo = t.topo; let idx = nodeIndex; … }
//     ↑ the CALLER's `topo`/`idx`        ↑ the CALLEE's, which shadow them for the whole block
//
// so an argument that reads a name the callee happens to declare is a `ReferenceError: Cannot access
// 'topo' before initialization` — at runtime, in the one build where it matters. `buildSplice`
// α-renames a PARAMETER whose name an argument reads; a callee LOCAL is the same collision and needs
// the same rename. Found by crashcat's dbvt walk, where the caller and the helper both call the thing
// they are walking `topo` and the index `idx` — which is exactly how the collision happens in real
// numeric code: shared vocabulary, not coincidence.

const build = async (files: Record<string, string>, output: Record<string, unknown> = { optimize: true }) => {
    const r = await bundle({ input: '/m.js', fs: createMemoryFs(files), external: [], output } as never);
    expect(r.errors).toEqual([]);
    return r.chunks[0].code;
};
const run = (code: string, call: string) => {
    const js = code.replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '').replace(/\bexport\s+/g, '');
    return new Function(`${js}\nreturn (${call});`)();
};
const both = async (files: Record<string, string>, call: string) => ({
    on: run(await build(files), call),
    off: run(await build(files, { optimize: false }), call),
});

describe('a callee local that collides with an argument name', () => {
    it('does not capture the argument (local helper)', async () => {
        const { on, off } = await both(
            {
                '/m.js': `const store = { topo: [10, 20, 30, 40, 50, 60] };

function readNode(nodeIndex) {
    const topo = store.topo;
    let idx = nodeIndex;
    return topo[idx];
}

/* @optimize */
export function f(topo, idx) {
    return readNode(topo[idx * 2 + 1]);
}`,
            },
            'f([0, 1, 2, 3], 1)',
        );
        expect(on).toBe(off);
        expect(on).toBe(40);
    });

    it('does not capture the argument (imported helper)', async () => {
        const { on, off } = await both(
            {
                '/m.js': `import { readNode } from './h.js';
/* @optimize */
export function f(topo, idx) { return readNode(topo[idx * 2 + 1]); }`,
                '/h.js': `const store = { topo: [10, 20, 30, 40, 50, 60] };
export function readNode(nodeIndex) {
    const topo = store.topo;
    let idx = nodeIndex;
    return topo[idx];
}`,
            },
            'f([0, 1, 2, 3], 1)',
        );
        expect(on).toBe(off);
        expect(on).toBe(40);
    });

    // A local declared in a NESTED block of the callee only shadows within that block, but the
    // argument's prologue binding is read there too, so it collides just the same.
    it('does not capture the argument from a nested block', async () => {
        const { on, off } = await both(
            {
                '/m.js': `function pick(n) {
    let out = 0;
    for (let i = 0; i < 2; i++) {
        const base = [100, 200];
        out += base[i] + n;
    }
    return out;
}

/* @optimize */
export function f(base) { return pick(base[0]); }`,
            },
            'f([7])',
        );
        expect(on).toBe(off);
        expect(on).toBe(314);
    });
});
