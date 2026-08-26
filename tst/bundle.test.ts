import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (files: Record<string, string>, external: string[] = []) => {
    const result = await bundle({ entry: '/main.ts', fs: createMemoryFs(files), external });
    expect(result.errors).toEqual([]);
    return result;
};

describe('bundle: executable output', () => {
    it('bundles + executes a multi-module TS package (types stripped, renames applied)', async () => {
        const { code } = await build({
            '/main.ts': [
                "import { add } from './math';",
                "import { one } from './util';",
                'export const result: number = add(one(), 2);',
                "export { scale } from './math';",
            ].join('\n'),
            '/math.ts': [
                'export interface V { n: number }',
                'export const add = (a: number, b: number): number => a + b;',
                'export function scale(v: number, s: number): number { return v * s; }',
            ].join('\n'),
            '/util.ts': ['const add = (x: number): number => x + 1;', 'export const one = (): number => add(0);'].join('\n'),
        });
        const mod = await run(code);
        expect(mod.result).toBe(3);
        expect((mod.scale as (a: number, b: number) => number)(3, 4)).toBe(12);
    });

    it('re-export chains, star exports, and namespace imports execute', async () => {
        const { code } = await build({
            '/main.ts': [
                "import * as lib from './lib';",
                "import { thing } from './barrel';",
                'export const viaNs = lib.double(thing);',
            ].join('\n'),
            '/lib.ts': 'export const double = (x: number) => x * 2;',
            '/barrel.ts': "export * from './a';",
            '/a.ts': 'export const thing = 21;',
        });
        const mod = await run(code);
        expect(mod.viaNs).toBe(42);
    });

    it('default exports (named + anonymous) execute', async () => {
        const { code } = await build({
            '/main.ts': [
                "import anon from './anon';",
                "import named from './named';",
                'export const sum = anon() + named();',
            ].join('\n'),
            '/anon.ts': 'export default function () { return 7; }',
            '/named.ts': 'export default function seven() { return 35; }',
        });
        const mod = await run(code);
        expect(mod.sum).toBe(42);
    });

    it('enums lower and execute inside a bundle (no export keyword leakage)', async () => {
        const { code } = await build({
            '/main.ts': ["import { Motion } from './motion';", 'export const kind = Motion[Motion.DYNAMIC];'].join('\n'),
            '/motion.ts': 'export enum Motion { STATIC = 0, DYNAMIC = 1 }',
        });
        expect(code).not.toMatch(/export var/);
        const mod = await run(code);
        expect(mod.kind).toBe('DYNAMIC');
    });

    it('enum + namespace IIFE params are real uids: mangle to 1 char, no collisions', async () => {
        // `generateUid` mints REAL symbols (oxc's `generate_uid`), so the enum/namespace IIFE params
        // `_E`/`_N`/`_M` deconflict + mangle like any nested local instead of staying verbatim.
        // A namespace param joins the body's own scope, so it can't collide with the body vars.
        const { code } = await bundle({
            entry: '/main.ts',
            fs: createMemoryFs({
                '/main.ts': [
                    'export enum E { A, B }',
                    'namespace N { const x = 5; export const y = x + 1; export namespace M { export const c = 7; } }',
                    'export const out = [E.B, N.y, N.M.c];',
                ].join('\n'),
            }),
            output: { minify: true },
        });
        // The verbatim underscore names are gone — they mangled to short base54 names.
        expect(code).not.toMatch(/_E\b|_N\b|_M\b/);
        const mod = await run(code);
        expect(mod.out).toEqual([1, 6, 7]);
    });

    it('import-equals aliases lower and execute', async () => {
        const { code } = await build({
            '/main.ts': ["import { lib } from './lib';", 'import dbl = lib.util.double;', 'export const out = dbl(21);'].join(
                '\n',
            ),
            '/lib.ts': 'export const lib = { util: { double: (x: number) => x * 2 } };',
        });
        expect(code).not.toMatch(/\bimport dbl\b|import =/);
        const mod = await run(code);
        expect(mod.out).toBe(42);
    });

    it('external imports hoist and dedupe; externals stay imports', async () => {
        const { code } = await build(
            {
                '/main.ts': [
                    "import { platform } from 'node:process';",
                    "export { arch } from './other';",
                    'export const p = platform;',
                ].join('\n'),
                '/other.ts': "import { arch } from 'node:process';\nexport { arch };",
            },
            ['node:process'],
        );
        expect(code.match(/from 'node:process'/g)?.length).toBe(1);
        const mod = await run(code);
        expect(typeof mod.p).toBe('string');
        expect(typeof mod.arch).toBe('string');
    });

    it('shorthand object properties survive renames', async () => {
        const { code } = await build({
            '/main.ts': ["import { pack } from './a';", 'const value = 5;', 'export const packed = pack(value);'].join('\n'),
            '/a.ts': 'const value = 10;\nexport const pack = (v: number) => ({ value, v });',
        });
        const mod = await run(code);
        expect(mod.packed).toEqual({ value: 10, v: 5 });
    });

    it('type-only graphs produce runtime-clean output', async () => {
        const { code } = await build({
            '/main.ts': [
                "import type { Shape } from './types';",
                "import { area } from './types';",
                'export const a: number = area({ w: 3, h: 4 } as Shape);',
            ].join('\n'),
            '/types.ts': [
                'export interface Shape { w: number; h: number }',
                'export type Alias = Shape;',
                'export const area = (s: Shape): number => s.w * s.h;',
            ].join('\n'),
        });
        expect(code).not.toMatch(/interface|Alias/);
        const mod = await run(code);
        expect(mod.a).toBe(12);
    });
});

describe('bundle: unsupported TS constructs fail loudly (not silent broken JS)', () => {
    const bundleErr = async (src: string): Promise<string[]> =>
        (await bundle({ entry: '/main.ts', fs: createMemoryFs({ '/main.ts': src }) })).errors;

    it('value namespaces lower and execute (flat)', async () => {
        const { code } = await bundle({
            entry: '/main.ts',
            fs: createMemoryFs({ '/main.ts': 'namespace NS { export const v = 42; }\nexport const out = NS.v;' }),
        });
        expect(code).not.toMatch(/namespace/);
        // biome-ignore lint/security/noGlobalEval: test-only
        expect(new Function(`${code.replace(/export /g, '')}\nreturn out;`)()).toBe(42);
    });

    it('nested value namespaces lower and execute (N.M.c)', async () => {
        const { code } = await bundle({
            entry: '/main.ts',
            fs: createMemoryFs({
                '/main.ts': 'namespace A { export namespace B { export const c = 7; } }\nexport const out = A.B.c;',
            }),
        });
        expect(code).not.toMatch(/namespace/);
        // biome-ignore lint/security/noGlobalEval: test-only
        expect(new Function(`${code.replace(/export /g, '')}\nreturn out;`)()).toBe(7);
    });

    it('a namespace with an unhandled member is rejected loudly', async () => {
        expect((await bundleErr('namespace N { const a = 1; export { a }; }')).length).toBeGreaterThan(0);
    });

    it('import-equals with require() (CommonJS) is rejected loudly', async () => {
        expect((await bundleErr('import fs = require("fs");\nexport const x = fs;')).join('\n')).toMatch(/require\(\)/);
    });

    // `collectUnsupported` is now SKIPPED unless the lowering reports that one of the two constructs
    // it diagnoses survived (`sawUnloweredTs`) — it used to walk every TS module to look. A wrong flag
    // silences a diagnostic rather than changing output, so byte-identical bundles would NOT catch it;
    // these cases are the gate.
    it('a value namespace the lowering cannot handle is still rejected loudly', async () => {
        const errs = await bundleErr('const a = 1;\nnamespace NS { export { a }; }\nexport const y = 1;');
        expect(errs.join('\n')).toMatch(/value namespaces are not supported/);
    });

    it('a value namespace the lowering DOES handle produces no error', async () => {
        expect(await bundleErr('namespace NS { export const v = 1; }\nexport const y = NS.v;')).toEqual([]);
    });

    it('declare namespace / declare global still erase cleanly (no error)', async () => {
        expect(await bundleErr('declare namespace Foo { const x: number; }\nexport const y = 1;')).toEqual([]);
        expect(await bundleErr('declare global { const G: number; }\nexport const z = 2;')).toEqual([]);
    });
});

// A two-statement re-export (`import { x } from './a'; export { x }`) binds an exported name to a
// local that is ITSELF an import. `matchImport` used to hand back the importing module's own symbol
// for these, which has no declaration in the output and roots nothing in the source — so the bundle
// silently emitted a dangling `export { x }` and dropped `./a` entirely (`errors: []`). It only
// showed up when the binding was not ALSO referenced locally, since a local use roots it by the
// normal path. Executable assertions, because the failure mode was a chunk that would not load.
describe('bundle: two-statement re-export', () => {
    it('re-exports a named import and keeps its source module', async () => {
        const { code } = await build({
            '/main.ts': "import { v } from './a';\nexport { v };",
            '/a.ts': 'export const v = 1;',
        });
        expect(await run(code)).toMatchObject({ v: 1 });
    });

    it('re-exports a named import under a new name', async () => {
        const { code } = await build({
            '/main.ts': "import { v } from './a';\nexport { v as w };",
            '/a.ts': 'export const v = 1;',
        });
        expect(await run(code)).toMatchObject({ w: 1 });
    });

    it('re-exports a default import', async () => {
        const { code } = await build({
            '/main.ts': "import d from './a';\nexport { d };",
            '/a.ts': 'export default 42;',
        });
        expect(await run(code)).toMatchObject({ d: 42 });
    });

    it('re-exports a namespace import', async () => {
        const { code } = await build({
            '/main.ts': "import * as ns from './a';\nexport { ns };",
            '/a.ts': 'export const v = 1;\nexport const w = 2;',
        });
        expect((await run(code)).ns).toMatchObject({ v: 1, w: 2 });
    });

    it('still roots the binding when it is also used locally', async () => {
        const { code } = await build({
            '/main.ts': "import { v } from './a';\nexport const doubled = v * 2;\nexport { v };",
            '/a.ts': 'export const v = 21;',
        });
        expect(await run(code)).toMatchObject({ v: 21, doubled: 42 });
    });
});

// `export * as ns from './a'` at an ENTRY. `namespaceOf` grows while export maps are built (this
// form is a named EXPORT, so the `namedImports` loop never registers its target), and linkGraph
// used to build namespace-target maps BEFORE the entry's own map existed — so the target's map was
// never built at all. One missing map, two silent symptoms: nothing in the target was rooted, and
// the namespace object rendered as `Object.freeze({})`. Worked from a non-entry barrel, because
// there the consumer's named import registered the target in time.
describe('bundle: export * as ns', () => {
    it('materializes the namespace at an entry and keeps the target module', async () => {
        const { code } = await build({
            '/main.ts': "export * as ns from './a';",
            '/a.ts': 'export const v = 1;\nexport const w = 2;',
        });
        expect((await run(code)).ns).toMatchObject({ v: 1, w: 2 });
    });

    it('materializes it through a non-entry barrel too', async () => {
        const { code } = await build({
            '/main.ts': "import { ns } from './barrel';\nexport const got = ns.v;",
            '/barrel.ts': "export * as ns from './a';",
            '/a.ts': 'export const v = 1;\nexport const w = 2;',
        });
        expect(await run(code)).toMatchObject({ got: 1 });
    });

    it('handles a chain of namespace re-exports', async () => {
        const { code } = await build({
            '/main.ts': "export * as outer from './mid';",
            '/mid.ts': "export * as inner from './a';",
            '/a.ts': 'export const v = 7;',
        });
        expect((await run(code)).outer).toMatchObject({ inner: { v: 7 } });
    });
});
