import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';

// `ns.foo()` passes the NAMESPACE as `this`, so the callee can read any member of it — including ones
// no consumer names. Narrowing the namespace to the members read statically is therefore unsound for
// a member CALL. Rollup's `dynamic-import-call-method-with-this-await` is
//
//     export function test() { return this.value; }   // dep.js
//     const n = await import('./dep.js'); n.test();   // main.js
//
// and `value` was narrowed away, so the call answered `undefined`. ROLLDOWN HAS THE SAME BUG —
// verified, its output drops `value` identically. Alignment is the rule here, but not against a
// program that returns the wrong answer; Rollup is right and this follows Rollup.
//
// The widening is deliberately confined to a namespace that is actually BUILT. Where the object is
// ELIDED, `ns.foo()` becomes `foo()` and `this` is lost — and that is Rollup's own behaviour, not a
// gap: given the static form of the fixture above it emits `function test() { return this.value; }`
// / `const r = test();`. Following Rollup means keeping the elision there too.
const build = async (files: Record<string, string>) => {
    const fs = { read: (id: string) => files[id] ?? null, exists: (id: string) => id in files };
    const r = await bundle({ entry: '/main.js', fs, external: [], output: {} });
    expect(r.errors).toEqual([]);
    return r.chunks.map((c) => c.code).join('\n');
};
describe('a namespace member CALL keeps the whole surface', () => {
    const dep = 'export function test() { return this.value; }\nexport const value = 42;\nexport const unused = 7;\n';

    it('keeps a member the callee reads off `this`, through a dynamic import', async () => {
        const code = await build({
            '/dep.js': dep,
            '/main.js': "export const run = async () => { const n = await import('./dep.js'); return n.test(); };\n",
        });
        // Not executed here — a dynamic import splits this into two chunks, which a `data:` URL
        // cannot resolve between. The RUNTIME proof is rollupsuite's own
        // `dynamic-import-call-method-with-this-await`, which asserts the call answers 'OK'.
        expect(code, 'value is reachable as this.value').toContain('42');
        expect(code, 'the whole surface is kept, not just the called member').toContain('7');
    });

    it('narrows anyway when the callee cannot mention `this`', async () => {
        // The whole-surface widening is gated on the DEFINING module containing a `this` at all.
        // Without that gate this costs 1,704 minified bytes on crashcat for nothing.
        const code = await build({
            '/dep.js': 'export const test = () => 42;\nexport const unused = 7;\n',
            '/main.js': "export const run = async () => { const n = await import('./dep.js'); return n.test(); };\n",
        });
        expect(code).toContain('42');
        expect(code, 'no arrow can read the namespace off `this`').not.toContain('7');
    });

    it('a static namespace is still elided, losing `this` exactly as Rollup does', async () => {
        const code = await build({
            '/dep.js': dep,
            '/main.js': "import * as ns from './dep.js';\nexport const v = ns.test();\n",
        });
        expect(code, 'no namespace object is built').not.toContain('__proto__');
        expect(code, 'nothing reads `unused`').not.toContain('7');
    });

    it('still narrows when members are only READ, never called', async () => {
        const code = await build({
            '/dep.js': dep,
            '/main.js': "export const run = async () => { const n = await import('./dep.js'); return n.value; };\n",
        });
        expect(code).toContain('42');
        expect(code, 'nothing reads `unused`').not.toContain('7');
    });
});
