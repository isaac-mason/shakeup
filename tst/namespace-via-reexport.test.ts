import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';

// A namespace does not have to arrive as `import * as ns`. The shape a numeric package actually
// ships is a barrel of `export * as`:
//
//   math/index.js   export * as vec3 from './vec3.js';
//   consumer.js     import { vec3 } from 'math';  …  vec3.dot(a, b)
//
// `vec3` is a NAMED import whose bind resolves to a namespace, and `namespaceTargets` only ever
// collected `import * as` bindings — so every one of these was left as a materialised object and a
// property load. On crashcat that is 3524 `ns.member(…)` calls on the hot path, and it is the whole
// reason its solver runs ~2x slower through shakeup than through rolldown: `vec3_ns.dot(a, b)` where
// rolldown emits `dot$2(a, b)`.
const build = async (files: Record<string, string>, entry = '/main.js') => {
    const fs = { read: (id: string) => files[id] ?? null, exists: (id: string) => id in files };
    const r = await bundle({ entry, fs, external: [], output: {} });
    expect(r.errors).toEqual([]);
    return r.chunks.map((c) => c.code).join('\n');
};

const FILES = {
    '/vec3.js': 'export function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }\nexport const ZERO = 0;\n',
    '/index.js': "export * as vec3 from './vec3.js';\n",
};

describe('a namespace reached through `export * as` and a named import', () => {
    it('rewrites its member reads to the members own bindings', async () => {
        const code = await build({
            ...FILES,
            '/main.js': "import { vec3 } from './index.js';\nexport const got = vec3.dot([1, 2], [3, 4]);\n",
        });
        expect(code).not.toMatch(/\bvec3\w*\.dot\(/);
        expect(code).toMatch(/got = dot\(/);
    });

    // Elision needs everything rewriting needs AND proof the object is unobservable. That used to be
    // unreachable through a barrel — the re-export marked the target `forceWhole` — so the object was
    // built even when every consumer only read static members off it.
    it('elides the object when nothing observes it', async () => {
        const code = await build({
            ...FILES,
            '/main.js': "import { vec3 } from './index.js';\nexport const got = vec3.dot([1, 2], [3, 4]);\n",
        });
        expect(code, 'no namespace object').not.toContain('__proto__: null');
    });

    // The object is public API here, so it must still exist — but the INTERNAL read should not go
    // through it. Building the object and rewriting a read are separate questions.
    it('still rewrites the read when the namespace is also re-exported', async () => {
        const code = await build({
            ...FILES,
            '/main.js':
                "import { vec3 } from './index.js';\nexport { vec3 };\nexport const got = vec3.dot([1, 2], [3, 4]);\n",
        });
        expect(code).toMatch(/got = dot\(/);
    });

    it('keeps the object when something observes it whole', async () => {
        const code = await build({
            ...FILES,
            '/main.js': "import { vec3 } from './index.js';\nexport const got = Object.keys(vec3);\n",
        });
        expect(code).toContain('__proto__: null');
    });

    it('preserves behaviour', async () => {
        const code = await build({
            ...FILES,
            '/main.js': "import { vec3 } from './index.js';\nexport const got = vec3.dot([1, 2], [3, 4]);\n",
        });
        const js = code.replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '').replace(/\bexport\s+/g, '');
        expect(new Function(`${js}\nreturn got;`)()).toBe(11);
    });
});
