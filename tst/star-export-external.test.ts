import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';

// `export * from '<external>'` in a barrel, with a consumer importing a name that can only come from
// that external. Per the spec the import resolves THROUGH the star export to the external's binding,
// so the honest lowering is a named import from the external — and if the external does not have the
// name, the host raises the link error the spec calls for.
//
// shakeup skipped external star sources entirely when matching an import, so it reported
// `'dirname' is not exported by` for valid code. That is the HARMFUL direction: rejecting a program
// that runs, and the pattern is ordinary — a barrel re-exporting from a dependency.
//
// rolldown lowers it differently: it builds a namespace object for the barrel and `__reExport`s the
// external into it at RUNTIME, so `dirname` becomes a member read that yields `undefined` when the
// external lacks it. That is the lenient reading; the named import is the spec-exact one, and it is
// also smaller. Divergence recorded deliberately.
const build = async (files: Record<string, string>, external: string[]) => {
    const fs = { read: (id: string) => files[id] ?? null, exists: (id: string) => id in files };
    const r = await bundle({ entry: '/main.js', fs, external, output: {} });
    return r;
};

describe('a name imported through `export * from <external>`', () => {
    const barrel = { '/mid.js': "export * from 'ext';\nexport const own = 1;\n" };

    it('resolves to the external instead of being reported missing', async () => {
        const r = await build({ ...barrel, '/main.js': "import { far } from './mid.js';\nexport const v = far;\n" }, ['ext']);
        expect(r.errors).toEqual([]);
        const code = r.chunks.map((c) => c.code).join('\n');
        expect(code).toMatch(/import\s*\{[^}]*far[^}]*\}\s*from\s*'ext'/);
    });

    it('still prefers a LOCAL export of the same name over the star', async () => {
        const r = await build(
            {
                '/mid.js': "export * from 'ext';\nexport const own = 'local';\n",
                '/main.js': "import { own } from './mid.js';\nexport const v = own;\n",
            },
            ['ext'],
        );
        expect(r.errors).toEqual([]);
        const code = r.chunks.map((c) => c.code).join('\n');
        expect(code).toContain("'local'");
        expect(code).not.toMatch(/import\s*\{[^}]*own[^}]*\}\s*from\s*'ext'/);
    });

    it('an ESM star source still wins over the external one', async () => {
        const r = await build(
            {
                '/inner.js': "export const far = 'esm';\n",
                '/mid.js': "export * from 'ext';\nexport * from './inner.js';\n",
                '/main.js': "import { far } from './mid.js';\nexport const v = far;\n",
            },
            ['ext'],
        );
        expect(r.errors).toEqual([]);
        const code = r.chunks.map((c) => c.code).join('\n');
        expect(code).toContain("'esm'");
    });

    it('a genuinely missing name is still reported when there is no external star', async () => {
        const r = await build({ '/mid.js': 'export const own = 1;\n', '/main.js': "import { nope } from './mid.js';\n" }, []);
        expect(r.errors.join()).toMatch(/'nope' is not exported by/);
    });
});
