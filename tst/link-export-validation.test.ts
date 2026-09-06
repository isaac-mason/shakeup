import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';

// Link validated what a module IMPORTS and never what it claims to EXPORT, so `export { nope }` and a
// re-export of a name the target does not have both built a graph with a dangling binding and emitted
// silently. rolldown errors on both — verified against it on Rollup's `missing-entry-export` and
// `circular-missed-reexports-2` fixtures before this existed.
const build = async (files: Record<string, string>, external: string[] = [], plugins?: unknown[]) => {
    const fs = { read: (id: string) => files[id] ?? null, exists: (id: string) => id in files };
    return bundle({ entry: '/main.js', fs, external, plugins: plugins as never, output: {} });
};

describe('link validates the export side', () => {
    it('rejects exporting a name this module does not define', async () => {
        // Reported by the CHECKER now, not link, and so in oxc's wording rather than Rollup's — the
        // single-module case is a toolchain-layer rule (`export { X }` names a local binding, and an
        // unresolved one is an early error even for a global). Link still owns the CROSS-module case
        // below, which the checker cannot see, and keeps Rollup's wording there. Confirmed no
        // rollupsuite sample asserts on the message: 535/547 with an empty failing-set diff either
        // way.
        const r = await build({ '/main.js': 'export { doesNotExist };\n' });
        expect(r.errors.join()).toMatch(/Export 'doesNotExist' is not defined/);
    });

    it('rejects re-exporting a name the target does not have', async () => {
        const r = await build({ '/dep.js': 'export const a = 1;\n', '/main.js': "export { nope } from './dep.js';\n" });
        expect(r.errors.join()).toMatch(/'nope' is not exported by/);
    });

    it('rejects a re-export chain that references itself', async () => {
        const r = await build({
            '/dep1.js': "export { doesNotExist } from './dep2.js';\n",
            '/dep2.js': "export { doesNotExist } from './dep1.js';\n",
            '/main.js': "export { doesNotExist } from './dep1.js';\n",
        });
        expect(r.errors.length).toBeGreaterThan(0);
    });

    it('accepts every valid shape it must not break', async () => {
        for (const files of [
            { '/dep.js': 'export const a = 1;\n', '/main.js': "export { a } from './dep.js';\n" },
            { '/dep.js': 'export const a = 1;\n', '/main.js': "export { a as b } from './dep.js';\n" },
            { '/dep.js': 'export const a = 1;\n', '/main.js': "export * as ns from './dep.js';\n" },
            { '/dep.js': 'export const a = 1;\n', '/main.js': "export * from './dep.js';\n" },
            { '/main.js': 'const a = 1;\nexport { a };\n' },
            { '/main.js': 'export default 1;\n' },
            { '/main.js': 'export default function f() {}\n' },
        ]) {
            const r = await build(files as Record<string, string>);
            expect(r.errors, JSON.stringify(files)).toEqual([]);
        }
    });

    it('says nothing about an EXTERNAL target, whose surface it cannot know', async () => {
        const r = await build({ '/main.js': "export { anything } from 'ext';\n" }, ['ext']);
        expect(r.errors).toEqual([]);
    });

    it('says nothing about a wrapped CommonJS target, whose surface is built at runtime', async () => {
        const r = await build({
            '/dep.cjs': 'exports.a = 1;\n',
            '/main.js': "export { whatever } from './dep.cjs';\n",
        });
        expect(r.errors).toEqual([]);
    });

    it('an ENTRY cannot be external', async () => {
        const r = await build({ '/main.js': 'export const a = 1;\n' }, [], [{ name: 'externalise', resolveId: () => false }]);
        expect(r.errors.join()).toMatch(/Entry module .* cannot be external/);
    });
});
