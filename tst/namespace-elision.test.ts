import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';

// A synthesized namespace object that nothing can observe is pure cost. When every appearance of an
// `import * as ns` binding is a STATIC member read, the object never needs to exist: each `ns.foo`
// can name `foo`'s own binding directly.
//
// This is measured, not speculative. On crashcat, shakeup emits 63 namespace objects and rolldown
// emits ZERO; eliding them and rewriting their 899 member reads is worth 20,645 raw / 3,415 brotli —
// about 70% of the raw size gap against rolldown, from one root cause. rolldown decides this with
// `ModuleNamespaceIncludedReason`, only materialising a namespace that is "semantically observed".
//
// shakeup already computes the fact: `analyzeNsUsage` sets `escapes` on any appearance that is not a
// static member read — a bare reference, a call, `ns[x]`, a destructure, a reassignment. It was only
// ever used to NARROW the object's members, never to skip building it.
const build = async (files: Record<string, string>, entry = '/main.js') => {
    const fs = { read: (id: string) => files[id] ?? null, exists: (id: string) => id in files };
    const r = await bundle({ entry, fs, external: [], output: {} });
    expect(r.errors).toEqual([]);
    return r.chunks.map((c) => c.code).join('\n');
};

describe('a namespace object nothing can observe is not built', () => {
    const dep = 'export const a = 1;\nexport function b() { return 2; }\nexport const unused = 3;\n';

    it('elides it when every use is a static member read', async () => {
        const code = await build({
            '/dep.js': dep,
            '/main.js': "import * as ns from './dep.js';\nexport const got = ns.a + ns.b();\n",
        });
        expect(code, 'no namespace object').not.toContain('__proto__: null');
        expect(code, 'no toStringTag stamp').not.toContain('Symbol.toStringTag');
        // The reads became direct references to the members' own bindings.
        expect(code).toMatch(/got = a \+ b\(\)/);
    });

    it.each([
        ['a bare reference', "import * as ns from './dep.js';\nexport const got = ns;\n"],
        ['a call argument', "import * as ns from './dep.js';\nexport const got = Object.keys(ns);\n"],
        ['a computed read', "import * as ns from './dep.js';\nexport const got = ns['a'];\n"],
        ['a destructure', "import * as ns from './dep.js';\nconst { a } = ns;\nexport const got = a;\n"],
    ])('but keeps it when the binding escapes — %s', async (_name, main) => {
        const code = await build({ '/dep.js': dep, '/main.js': main });
        expect(code, 'the object is still needed').toContain('__proto__: null');
    });

    it('renames a consumer binding that would capture the rewrite, rather than refusing', async () => {
        // `dep.mutate(…)` inside `function test(mutate){…}` cannot be EMITTED as `mutate(…)` — the
        // parameter wins. An ordinary `import { mutate }` never has this problem: the reference is in
        // the graph before deconfliction, and `deshadowLocals` renames the parameter off it.
        //
        // So does this one. `linked.elidableNs` hands the decision to deconfliction, which is why
        // the answer is to rename the PARAMETER and keep the elision — the direction rollup takes in
        // `ChildScope.deconflict`. Refusing the elision instead (the first cut, which Rollup's
        // `argument-treeshaking-parameter-conflict` caught) cost 7,362 raw bytes on crashcat.
        const code = await build({
            '/dep.js': 'export let value = 0;\nexport const mutate = () => value++;\n',
            '/main.js':
                "import * as dep from './dep.js';\nfunction test(mutate) { dep.mutate(); return mutate; }\nexport const got = [test(41), dep.value];\n",
        });
        expect(code, 'no namespace object').not.toContain('__proto__: null');
        expect(code, 'the capturing parameter moved aside').toMatch(/function test\(mutate\$1\)/);
        // The point of the rename, asserted by RUNNING it: `mutate()` has to reach the import and
        // `return mutate$1` has to reach the parameter. Reinstating the capture makes this `[fn, 0]`.
        expect(new Function(`${code.replace(/export .*$/gm, '')}\nreturn got;`)()).toEqual([41, 1]);
    });

    it('keeps it when a member is ASSIGNED to, so the getter is still there to throw', async () => {
        // `ns.v = 9` is not a read. ESM renders a live member as a getter with no setter, so the
        // assignment throws — behaviour that exists only if the OBJECT does. Eliding here would emit
        // `v = 9`, quietly assigning the producer's binding instead of throwing, and every use in
        // this fixture IS a static member read, so nothing else refuses it.
        //
        // rolldown never reaches the question: it REFUSES the program with `[ASSIGN_TO_IMPORT]
        // Cannot assign to import 'v'` (verified). shakeup accepts it and lets the getter throw,
        // which `tst/bundle.test.ts` pins deliberately — so the object has to survive.
        const code = await build({
            '/dep.js': 'export let v = 1;\n',
            '/main.js': [
                "import * as ns from './dep.js';",
                'let threw = false;',
                'try { ns.v = 9 } catch { threw = true }',
                'export const got = [threw, ns.v];',
            ].join('\n'),
        });
        expect(code, 'the object survives to carry the getter').toContain('__proto__: null');
        // Executed as a real module, so the assignment is in strict mode and actually throws.
        const mod = await import(`data:text/javascript,${encodeURIComponent(code)}`);
        expect(mod.got).toEqual([true, 1]);
    });

    it('keeps it for a dynamic import, whose namespace is a real runtime value', async () => {
        const code = await build({
            '/dep.js': dep,
            '/main.js': "export const p = import('./dep.js').then((m) => m.a);\n",
        });
        // The dynamic target becomes its own chunk and `import()` resolves to a real Module
        // namespace, so there is nothing to elide — but nothing may break either.
        expect(code).toContain('import(');
    });
});

// A namespace that IS materialised gets its members narrowed to what consumers read. That set was
// unioned across the whole consumer MODULE, which made it independent of liveness: a member named
// only by code the shaker drops stayed in the bundle and got stamped onto the object.
//
// rolldown resolves member-expr refs per REFERENCE (`bind_imports_and_exports.rs`), and a reference
// inside a dropped statement is not one — it emits neither the member nor its declaration. Isolated
// in `llm/repro/expandns`; ROADMAP §2z52.
//
// The shape needs the object to actually exist, so these fixtures put a consumer in ANOTHER chunk:
// elision is refused across chunks (the wiring imports the namespace, not the members), which is
// exactly when the narrowed surface becomes something the emitter writes out.
describe('the narrowed surface follows liveness', () => {
    const files = (body: string) => ({
        '/dep.js': "export const kept = 1;\nexport function deadOnly() { return 'DEADCODE_MARKER'; }\n",
        '/panel.js': `import * as ns from './dep.js';\n${body}\nexport const render = () => ns.kept;\n`,
        '/main.js':
            "import * as ns from './dep.js';\nexport const load = () => import('./panel.js');\nexport const seed = ns.kept;\n",
    });

    it('drops a member whose only read is in a statement that gets shaken', async () => {
        const code = await build(files('function neverUsed() { return ns.deadOnly(); }'));
        expect(code, 'the fixture must MATERIALISE the object, or it tests nothing').toContain('__proto__: null');
        expect(code, 'the only read of it was dropped').not.toContain('DEADCODE_MARKER');
        expect(code, 'so it is not stamped onto the namespace either').not.toContain('deadOnly');
        expect(code, 'the live member survives').toContain('kept');
    });

    // The falsification arm. One reference away from the test above — if this went green too, the
    // assertions above would be pinning "we never emit it", not "we drop it when it is dead".
    it('keeps that same member as soon as one live statement reads it', async () => {
        const code = await build(files('export function used() { return ns.deadOnly(); }'));
        expect(code).toContain('__proto__: null');
        expect(code).toContain('DEADCODE_MARKER');
        expect(code).toContain('deadOnly');
    });
});
