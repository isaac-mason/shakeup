import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';

// `resolveDynamicImport` is tried BEFORE `resolveId` for an `import()`, and falls through to it when
// every hook declines. rolldown's `resolve_id_with_plugins` has exactly that shape — a
// `plugin_driver.resolve_dynamic_import(...)` branch guarded on `ImportKind::DynamicImport`, before
// the ordinary `resolve_id` call — and Rollup's hook is `first` with the same fallback. rolldown
// declines only the variant that hands the hook an AST node for a non-literal specifier; the string
// form is what this is.
//
// The second half is the EMITTED id. `resolveDynamicImport` returning `'asdf'` for `'./asdf'` under
// `external: ['asdf']` has to emit `import('asdf')` — emitting the original relative specifier makes
// the runtime resolve a path that was never the resolution. rollupsuite's `dynamic-import-rewriting`.
const build = async (files: Record<string, string>, opts: Record<string, unknown>) => {
    const r = await bundle({ entry: '/main.js', fs: createMemoryFs(files), ...opts } as never);
    expect(r.errors).toEqual([]);
    return r.chunks.map((c) => c.code).join('\n');
};

describe('resolveDynamicImport', () => {
    const files = { '/main.js': "export const p = import('./asdf');\n", '/real.js': 'export const v = 1;\n' };

    it('resolves an `import()` and emits it under the RESOLVED id', async () => {
        const code = await build(files, {
            external: ['asdf'],
            plugins: [{ name: 'p', resolveDynamicImport: () => 'asdf' }],
        });
        expect(code).toContain("import('asdf')");
        expect(code, 'not the specifier as written').not.toContain('./asdf');
    });

    it('is NOT consulted for a static import', async () => {
        let seen = 0;
        const code = await build(
            { '/main.js': "export { v } from './real.js';\n", '/real.js': 'export const v = 1;\n' },
            {
                external: [],
                plugins: [
                    {
                        name: 'p',
                        resolveDynamicImport() {
                            seen++;
                            return null;
                        },
                    },
                ],
            },
        );
        expect(seen, 'a static import never reaches the dynamic hook').toBe(0);
        expect(code).toContain('const v = 1');
    });

    it('falls through to resolveId when every dynamic hook declines', async () => {
        const code = await build(files, {
            external: [],
            plugins: [
                { name: 'decline', resolveDynamicImport: () => null },
                { name: 'fallback', resolveId: (id: string) => (id === './asdf' ? '/real.js' : null) },
            ],
        });
        expect(code, 'resolveId got the resolution').toContain('const v = 1');
    });

    it('wins over resolveId when both would answer', async () => {
        const code = await build(files, {
            external: ['asdf'],
            plugins: [
                { name: 'dyn', resolveDynamicImport: () => 'asdf' },
                { name: 'static', resolveId: (id: string) => (id === './asdf' ? '/real.js' : null) },
            ],
        });
        expect(code).toContain("import('asdf')");
        expect(code, 'resolveId did not get to answer').not.toContain('const v = 1');
    });
});
