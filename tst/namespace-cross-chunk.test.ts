import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';
import { chunkCheckErrors, runChunks } from './exec-helpers.ts';

// CROSS-CHUNK namespace elision (ROADMAP §2z54). `import * as ns` whose every use is a static member
// read needs no object — each `ns.foo` names `foo`'s own binding. That was refused whenever a
// consumer sat in another chunk, because eliding changes what a chunk IMPORTS (one namespace
// binding becomes the individual members) and the wiring had already run. Both oracles do it anyway:
// rollup emits `import { v } from './a.js'` and rolldown's `resolve_member_expr_refs` never consults
// the chunk assignment at all.
//
// The failure mode is a DANGLING REFERENCE AT RUNTIME, not a diff — a member the rewrite names and
// no chunk imports. So every case here is EXECUTED, for the reason `runChunks` exists.
//
// Each fixture crosses the elision with another path that reads a namespace object, because that is
// where the bugs are: a member re-exported from a third module, a live `let`, a shadowing local, a
// `require`, an `export * as`, and two dynamic chunks wanting different members. All six were
// checked against node and rolldown as well; all three agree.
const build = async (files: Record<string, string>) => {
    const r = await bundle({ entry: '/main.js', external: [], fs: createMemoryFs(files), output: {} });
    expect(r.errors).toEqual([]);
    return r;
};

const got = async (files: Record<string, string>): Promise<unknown> => {
    const r = await build(files);
    // Every chunk must be a VALID module before it is run — see `chunkCheckErrors`. Running alone
    // does not establish this: under vitest a chunk exporting a name nothing declares loads fine.
    expect(chunkCheckErrors(r.chunks)).toEqual([]);
    const { ns, dispose } = await runChunks(r.chunks, r.chunks.find((c) => c.isEntry)!.fileName);
    try {
        return await (ns.got as () => unknown)();
    } finally {
        dispose();
    }
};

describe('a namespace read across a chunk boundary imports the members, not the object', () => {
    it('resolves a member that is itself re-exported from a THIRD module', async () => {
        // The shape that produced the original `ReferenceError` on the same-chunk path
        // (`preserve-modules-namespace`): the member's binding lives in neither the consuming chunk
        // nor the namespace's own module.
        expect(
            await got({
                '/leaf.js': "export const deep = 'DEEP';",
                '/barrel.js': "export { deep } from './leaf.js';\nexport const own = 'OWN';",
                '/panel.js': "import * as ns from './barrel.js';\nexport const render = () => ns.deep + ns.own;",
                '/main.js':
                    "import * as ns from './barrel.js';\n" +
                    "export const load = () => import('./panel.js');\n" +
                    'export const seed = ns.own;\n' +
                    'export const got = async () => (await load()).render();',
            }),
        ).toBe('DEEPOWN');
    });

    it('keeps a LIVE binding live — a `let` reassigned from the other chunk', async () => {
        // An ESM namespace exposes live bindings. Elided, the read becomes a direct reference to the
        // producer's binding, which is live for the same reason — but only if the import is wired to
        // the binding rather than to a copy of its value.
        //
        // Asserted from INSIDE the lazy chunk. The natural assertion also compares the entry's own
        // view (`[render(), ns.n]`, `[42, 42]` under node and rolldown) and cannot be made here:
        // vitest double-evaluates a chunk, so the entry's `n` and the one the lazy chunk imported are
        // two instances. `render()` alone reads the bump and the value through the same instance,
        // which is the property this is about.
        expect(
            await got({
                '/dep.js': 'export let n = 1;\nexport const bump = () => { n += 41; };',
                '/panel.js': "import * as ns from './dep.js';\nexport const render = () => { ns.bump(); return ns.n; };",
                '/main.js':
                    "import * as ns from './dep.js';\n" +
                    "export const load = () => import('./panel.js');\n" +
                    'export const seed = ns.n;\n' +
                    'export const got = async () => (await load()).render();',
            }),
        ).toBe(42);
    });

    it('renames a consumer local that would capture the rewritten read', async () => {
        // `ns.value` becomes `value`, inside a function whose PARAMETER is also `value`. Same
        // question `deshadowLocals` answers for a same-chunk elision, now with the producer in
        // another chunk — so the name it must not collide with arrived as an import local.
        expect(
            await got({
                '/dep.js': "export const value = 'REAL';",
                '/panel.js':
                    "import * as ns from './dep.js';\n" +
                    "function outer(value) { return ns.value + '/' + value; }\n" +
                    "export const render = () => outer('PARAM');",
                '/main.js':
                    "import * as ns from './dep.js';\n" +
                    "export const load = () => import('./panel.js');\n" +
                    'export const seed = ns.value;\n' +
                    'export const got = async () => (await load()).render();',
            }),
        ).toBe('REAL/PARAM');
    });

    it('does NOT elide a target something also `require`s — that reads the whole object', async () => {
        // §2z55's rule, met with a chunk boundary. The `require` lowers to `__toCommonJS(dep_ns)`, so
        // the object has to exist AND carry every member; the cross-chunk reader still gets its
        // member directly.
        expect(
            await got({
                '/dep.js': "export const alpha = 'ALPHA';\nexport const beta = 'BETA';",
                '/mid.cjs': "const all = require('./dep.js');\nmodule.exports.keys = Object.keys(all).join(',');",
                '/panel.js': "import * as ns from './dep.js';\nexport const render = () => ns.alpha;",
                '/main.js':
                    "import * as ns from './dep.js';\n" +
                    "import mid from './mid.cjs';\n" +
                    "export const load = () => import('./panel.js');\n" +
                    'export const got = async () => [ns.alpha, mid.keys, (await load()).render()];',
            }),
        ).toEqual(['ALPHA', 'alpha,beta', 'ALPHA']);
    });

    it('does NOT elide a target that is also `export * as` re-exported — that is public API', async () => {
        expect(
            await got({
                '/dep.js': "export const alpha = 'ALPHA';\nexport const beta = 'BETA';",
                '/panel.js': "import * as ns from './dep.js';\nexport const render = () => ns.alpha;",
                '/main.js':
                    "import * as ns from './dep.js';\n" +
                    "export * as depNs from './dep.js';\n" +
                    "export const load = () => import('./panel.js');\n" +
                    'export const got = async () => [ns.alpha, (await load()).render()];',
            }),
        ).toEqual(['ALPHA', 'ALPHA']);
    });

    it('gives two dynamic chunks the DIFFERENT members each of them reads', async () => {
        // The member sets are per-target, not per-chunk, so this is the case that catches a chunk
        // being handed only the other chunk's members.
        expect(
            await got({
                '/dep.js': "export const a = 'A';\nexport const b = 'B';\nexport const unused = 'U';",
                '/p1.js': "import * as ns from './dep.js';\nexport const r = () => ns.a;",
                '/p2.js': "import * as ns from './dep.js';\nexport const r = () => ns.b;",
                '/main.js': "export const got = async () => [(await import('./p1.js')).r(), (await import('./p2.js')).r()];",
            }),
        ).toEqual(['A', 'B']);
    });

    it('builds no namespace object at all for the plain case', async () => {
        // The point of the change, asserted on the TEXT as well: without this, all six cases above
        // would still pass with the object rebuilt and every read going through it.
        const r = await build({
            '/dep.js': 'export function kept(x) { return x * 2; }\nexport function also(x) { return x - 1; }',
            '/panel.js': "import * as ns from './dep.js';\nexport const render = (v) => ns.kept(v) + ns.also(v);",
            '/main.js':
                "import * as ns from './dep.js';\n" +
                "export const load = () => import('./panel.js');\n" +
                'export const seed = (v) => ns.kept(v);',
        });
        expect(chunkCheckErrors(r.chunks)).toEqual([]);
        const code = r.chunks.map((c) => c.code).join('\n');
        expect(code, 'no synthesized namespace').not.toContain('__proto__: null');
        expect(code, 'the lazy chunk imports the members it reads').toMatch(/import \{[^}]*\bkept\b[^}]*\balso\b/);
    });
});
