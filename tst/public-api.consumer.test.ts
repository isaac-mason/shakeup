import { describe, expect, it } from 'vitest';
import { analyze, createSemantic, N, type Node, type Program, parse, type Semantic, walk } from '../src/ast.ts';
import {
    asset,
    type BundleOptions,
    type BundleResult,
    bundle,
    createBuildContext,
    createMemoryFs,
    css,
    type Fs,
    json,
    type OutputAsset,
    type OutputChunk,
    type OutputOptions,
    type Plugin,
    worker,
} from '../src/index.ts';
import { createNodeFs } from '../src/node.ts';

// A CONSUMER-SHAPED test. `tst/public-api.test.ts` pins WHICH names are exported; this checks the
// surface is actually usable — that someone outside the repo can call the values and, crucially, NAME
// the types those values hand them. Values and types are published by different mechanisms (explicit
// named exports vs `export type *`), so it is entirely possible to export `bundle` while leaving
// `BundleResult` unnameable, and nothing else here would notice.
//
// The type assertions are the point and they are checked by `tsc`, not by vitest — every annotation
// below fails the build if the type is missing from the entry. The runtime assertions exist so the
// file is a real test rather than a compile-only fixture that could rot unnoticed.
//
// Written after a near-miss: the first version of this lived at the repo root, where `tsconfig.json`'s
// `include` (src, examples, tst) does not reach. It "passed" while being type-checked by nothing at
// all. It lives in `tst/` for that reason.

describe('the published API is usable from outside', () => {
    it('builds through the documented types', async () => {
        const fs: Fs = createMemoryFs({ '/a.js': 'export const x = 1;' });
        const output: OutputOptions = { minify: true };
        const opts: BundleOptions = { entry: '/a.js', fs, external: [], output };

        const result: BundleResult = await bundle(opts);
        const chunk: OutputChunk = result.chunks[0];
        // `assets` is OPTIONAL on `BundleResult` — absent rather than empty when a build emits none.
        // Worth knowing as a consumer, and this is where you find out.
        const assets: OutputAsset[] = result.assets ?? [];

        expect(result.errors).toEqual([]);
        expect(chunk.isEntry).toBe(true);
        expect(assets).toEqual([]);
    });

    it('drives an incremental context', async () => {
        const files: Record<string, string> = { '/a.js': 'export const x = 1;' };
        const ctx = createBuildContext({
            entry: '/a.js',
            fs: { read: (i) => files[i] ?? null, exists: (i) => i in files },
            external: [],
        });
        expect((await ctx.rebuild()).errors).toEqual([]);
    });

    it('types a plugin, and the built-ins satisfy that type', () => {
        const mine: Plugin = { name: 'mine', transform: (code: string) => ({ code }) };
        const all: Plugin[] = [mine, json(), css(), asset(), worker()];
        expect(all.map((p) => typeof p.name)).toEqual(['string', 'string', 'string', 'string', 'string']);
    });

    it('parses and analyses through shakeup/ast', () => {
        const program: Program = parse('const a = 1;', { ts: false, jsx: false }).program;
        const semantic: Semantic = createSemantic();
        analyze(semantic, program);
        let idents = 0;
        walk(program, (n: Node) => {
            if (n.type === N.BindingIdentifier) idents++;
            return undefined;
        });
        expect(idents).toBe(1);
    });

    it('exposes a real filesystem through shakeup/node', () => {
        const fs: Fs = createNodeFs();
        expect(fs.exists('/definitely/not/a/real/path')).toBe(false);
    });
});
