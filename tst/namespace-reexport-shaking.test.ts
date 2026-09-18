import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';

// `export * as ns from './m'` used to force m's WHOLE export surface to survive, whoever did it and
// whether or not the namespace ever escaped. A package barrel does exactly that —
//
//   math/index.js   export * as vec3 from './vec3.js';
//   consumer.js     import { vec3 } from 'math';   vec3.dot(a, b)
//
// — so importing one function out of a math package retained all sixty. On crashcat that pinned 389
// functions alive that rolldown drops, which is essentially the whole size gap between them.
//
// The surface only has to stay whole when the namespace is REACHABLE FROM AN ENTRY'S exports, where
// something outside the bundle can hold it and read anything off it. A barrel that is merely internal
// plumbing is analyzable like any other namespace: if every use is a static member read, the unread
// members are dead.
const build = async (files: Record<string, string>, entry = '/main.js') => {
    const fs = { read: (id: string) => files[id] ?? null, exists: (id: string) => id in files };
    const r = await bundle({ entry, fs, external: [], output: {} });
    expect(r.errors).toEqual([]);
    return r.chunks.map((c) => c.code).join('\n');
};

const MEMBERS =
    'export function dot(a, b) { return a[0] * b[0]; }\nexport function unusedA() { return 1; }\nexport function unusedB() { return 2; }\n';

// The two spellings of a barrel. The SECOND is what `math` actually ships, and it is the one that
// went wrong: the re-export is a BARE REFERENCE to the namespace binding, which reads as "something
// observes this whole" unless the forwarding is recognized for what it is. Writing only the first
// spelling is why the earlier version of this test passed while crashcat kept all 60 members.
const BARRELS: [name: string, index: string][] = [
    ['export * as', "export * as vec3 from './vec3.js';\n"],
    ['import * as + export', "import * as vec3 from './vec3.js';\nexport { vec3 };\n"],
];
const LIB = { '/vec3.js': MEMBERS, '/index.js': BARRELS[1][1] };

describe('a namespace re-exported by an internal barrel', () => {
    it.each(BARRELS)('does not pin its unread members alive (%s)', async (_name, index) => {
        const code = await build({
            '/vec3.js': MEMBERS,
            '/index.js': index,
            '/main.js': "import { vec3 } from './index.js';\nexport const got = vec3.dot([1], [2]);\n",
        });
        expect(code).toContain('function dot');
        expect(code, 'unread member shaken').not.toContain('unusedA');
        expect(code, 'unread member shaken').not.toContain('unusedB');
    });

    // The entry's own surface is the line. Re-exporting the namespace publishes it, and anything
    // outside the bundle can read any member off it, so every member has to survive.
    it('keeps the whole surface when the entry re-exports the namespace', async () => {
        const code = await build({
            ...LIB,
            '/main.js': "export { vec3 } from './index.js';\n",
        });
        expect(code).toContain('unusedA');
        expect(code).toContain('unusedB');
    });

    it('keeps the whole surface when a consumer observes the namespace whole', async () => {
        const code = await build({
            ...LIB,
            '/main.js': "import { vec3 } from './index.js';\nexport const got = Object.keys(vec3);\n",
        });
        expect(code).toContain('unusedA');
    });

    it('preserves behaviour', async () => {
        const code = await build({
            ...LIB,
            '/main.js': "import { vec3 } from './index.js';\nexport const got = vec3.dot([3], [4]);\n",
        });
        const js = code.replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '').replace(/\bexport\s+/g, '');
        expect(new Function(`${js}\nreturn got;`)()).toBe(12);
    });
});
