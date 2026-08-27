import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import type { Plugin } from '../src/plugin.ts';

// P1 step 1 of the alignment plan: the LOADER STAGE. `ModuleType` has declared
// `json | text | base64 | dataurl | binary` for a long time and `moduleTypeOf()` already returned
// `'json'` for a `.json` file — but only `ts`/`tsx` were ever acted on, so every other type fell
// through to the JavaScript parser and `.json` failed with `expected ';'`.
//
// JSON is compiled to ES module SOURCE rather than a synthetic AST, which is what makes the module
// ORDINARY — tree-shaking, folding and inlining all apply with no special cases. rolldown does the
// same: one `var` per top-level key plus an object literal for `default`.
const build = async (files: Record<string, string>, main: string, opts: Record<string, unknown> = {}) =>
    bundle({ entry: '/main.js', external: [], fs: createMemoryFs({ ...files, '/main.js': main }), ...opts });

const run = async (files: Record<string, string>, main: string, opts: Record<string, unknown> = {}) => {
    const r = await build(files, main, opts);
    expect(r.errors).toEqual([]);
    return (await import(`data:text/javascript,${encodeURIComponent(r.code)}`)) as { x: unknown };
};

const D = { '/d.json': '{"used":1,"unused":2,"nested":{"a":[1,2]},"with-dash":3}' };

describe('JSON modules', () => {
    it('a default import gets the whole document', async () => {
        expect((await run(D, "import d from './d.json';\nexport const x = d;")).x).toEqual({
            used: 1,
            unused: 2,
            nested: { a: [1, 2] },
            'with-dash': 3,
        });
    });

    it('named imports bind top-level keys', async () => {
        // rolldown supports this; esbuild rejects it ("No matching export"). A deliberate split,
        // taken toward rolldown — recorded in the alignment plan rather than assumed as parity.
        expect((await run(D, "import { used, unused } from './d.json';\nexport const x = [used, unused];")).x).toEqual([1, 2]);
    });

    it('a namespace import sees EVERY key plus default', async () => {
        // `with-dash` is here now: a non-identifier key is exported under its literal string name
        // (`export { _with_dash as "with-dash" }`) — arbitrary module namespace names. rolldown does
        // the same; its `__exportAll` carries `"with-dash": () => …`.
        expect((await run(D, "import * as ns from './d.json';\nexport const x = Object.keys(ns).sort();")).x).toEqual([
            'default',
            'nested',
            'unused',
            'used',
            'with-dash',
        ]);
    });

    it('a non-identifier key can be imported by name', async () => {
        expect((await run(D, 'import { "with-dash" as w } from "./d.json";\nexport const x = w;')).x).toBe(3);
    });

    it('a reserved-word key can be imported by name', async () => {
        expect((await run({ '/r.json': '{"class":4}' }, 'import { "class" as c } from "./r.json";\nexport const x = c;')).x).toBe(
            4,
        );
    });

    it.each([
        ['an array document', '[1,2,3]', [1, 2, 3]],
        ['a primitive document', '42', 42],
        ['a null document', 'null', null],
        ['an empty object', '{}', {}],
    ])('handles %s', async (_label, json, expected) => {
        expect((await run({ '/a.json': json }, "import a from './a.json';\nexport const x = a;")).x).toEqual(expected);
    });

    it('a key named `default` is reachable, and does not double up the default export', async () => {
        // Two hazards, both real: `"default"` sanitises to `_default`, the name the default-export
        // object uses (silent redeclaration); and exporting it BY NAME would emit a second
        // `export default`. It stays reachable through the default object, as it is in Node.
        expect(
            (
                await run(
                    { '/r.json': '{"class":1,"default":2,"ok":3}' },
                    "import d from './r.json';\nexport const x = [d.class, d.default, d.ok];",
                )
            ).x,
        ).toEqual([1, 2, 3]);
    });

    it('a `__proto__` key stays a property and does not set the prototype', async () => {
        // `{"__proto__": v}` as a LITERAL key sets the prototype; a computed key does not.
        expect(
            (
                await run(
                    { '/x.json': '{"__proto__":{"bad":1},"ok":2}' },
                    "import d from './x.json';\nexport const x = [d.ok, Object.getPrototypeOf(d) === Object.prototype];",
                )
            ).x,
        ).toEqual([2, true]);
    });

    it('keys that sanitise to the same name stay distinct', async () => {
        expect(
            (await run({ '/r.json': '{"a-b":1,"a_b":2}' }, "import d from './r.json';\nexport const x = [d['a-b'], d.a_b];")).x,
        ).toEqual([1, 2]);
    });

    it('preserves string escapes and unicode', async () => {
        expect(
            (
                await run(
                    { '/q.json': '{"s":"he said \\"hi\\"","u":"\\u00e9"}' },
                    "import d from './q.json';\nexport const x = [d.s, d.u];",
                )
            ).x,
        ).toEqual(['he said "hi"', 'é']);
    });

    it('can be `require`d from a CommonJS module', async () => {
        expect(
            (
                await run(
                    { ...D, '/c.cjs': "module.exports = require('./d.json').used;" },
                    "import c from './c.cjs';\nexport const x = c;",
                )
            ).x,
        ).toBe(1);
    });

    it('reports invalid JSON as a JSON error', async () => {
        // Before the loader existed the file went to the JavaScript parser and produced
        // `expected ';'` — the right file, the wrong reason.
        const r = await build({ '/b.json': '{oops}' }, "import b from './b.json';\nexport const x = b;");
        expect(r.errors.join('\n')).toMatch(/invalid JSON/);
    });

    it('a transforming plugin still owns the module', async () => {
        // `@rollup/plugin-json` and friends turn `.json` into `export default …` in a `transform`
        // hook. Running the built-in loader afterwards fed that JavaScript to `JSON.parse`.
        const plugin: Plugin = {
            name: 'json',
            transform: (_c, code, id) =>
                id.endsWith('.json') ? `export default ${code};\nexport const marker = 'PLUGIN';` : null,
        };
        expect((await run(D, "import { marker } from './d.json';\nexport const x = marker;", { plugins: [plugin] })).x).toBe(
            'PLUGIN',
        );
    });
});
