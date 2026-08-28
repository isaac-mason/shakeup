import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

// An ENTRY's `export * from '<external>'` is part of its public export surface, but the names it
// contributes are not statically known — so it appears in no export map, nothing roots it, and the
// tree-shaker removed it. `export * from 'path'` simply vanished and every name it re-exported came
// back `undefined`. rollup emits the statement verbatim.
//
// A non-entry external star is a different case and is still reported as dropped: in a concatenated
// bundle there is nowhere to put it.
describe("an entry's external export-star survives tree-shaking", () => {
    const build = async (files: Record<string, string>, external: string[], treeshake?: false) => {
        const r = await bundle({ entry: '/main.js', fs: createMemoryFs(files), external, treeshake });
        expect(r.errors).toEqual([]);
        return r.code;
    };

    it('emits the star for an entry', async () => {
        const code = await build({ '/main.js': "export * from 'ext';\nexport const local = 1;" }, ['ext']);
        expect(code).toContain("export * from 'ext'");
    });

    it('survives alongside local exports that override it', async () => {
        // rollup's `override-external-namespace`: locals shadow the star per the ES spec, and the
        // star must still be there for everything else.
        const code = await build({ '/main.js': "export * from 'ext';\nexport const dirname = 'defined';\nexport let resolve;" }, [
            'ext',
        ]);
        expect(code).toContain("export * from 'ext'");
        expect(code).toMatch(/export\s*\{[^}]*dirname/);
    });

    it('is emitted with tree-shaking off too — the fix did not just disable shaking', async () => {
        const code = await build({ '/main.js': "export * from 'ext';\nexport const local = 1;" }, ['ext'], false);
        expect(code).toContain("export * from 'ext'");
    });

    it('a star from a BUNDLED module is still resolved, not passed through', async () => {
        const code = await build({ '/main.js': "export * from './lib.js';", '/lib.js': 'export const a = 1;' }, []);
        expect(code).not.toContain('export * from');
        expect(code).toMatch(/export\s*\{[^}]*a/);
    });
});
