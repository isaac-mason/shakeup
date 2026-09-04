import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';

// `treeshake.moduleSideEffects` — Rollup's option, and rolldown's (`treeshake.rs:206`).
//
// PRECEDENCE is the part worth pinning, and it is rolldown's `normalize_side_effects`
// (`ecma_module_view_factory.rs:171`): a plugin hook first, then THIS option, then
// `package.json#sideEffects`, then per-statement analysis. `true` is not "assume side effects" — it
// is DEFER, which is what rolldown's `ModuleSideEffects::Boolean(true) => None` says.
const files: Record<string, string> = {
    '/effect.js': 'globalThis.__ran = (globalThis.__ran ?? 0) + 1;\nexport const unused = 1;\n',
    '/other.js': 'globalThis.__other = true;\nexport const alsoUnused = 2;\n',
    '/main.js': "import './effect.js';\nimport './other.js';\nexport const x = 1;\n",
};
const build = async (treeshake?: unknown) => {
    const fs = { read: (id: string) => files[id] ?? null, exists: (id: string) => id in files };
    const r = await bundle({ entry: '/main.js', fs, external: [], treeshake: treeshake as never, output: {} });
    expect(r.errors).toEqual([]);
    return r.chunks.map((c) => c.code).join('\n');
};

describe('treeshake.moduleSideEffects', () => {
    it('defaults to keeping a bare import’s top-level effect', async () => {
        const code = await build(undefined);
        expect(code).toContain('__ran');
        expect(code).toContain('__other');
    });

    it('`true` DEFERS rather than asserting — same output as the default', async () => {
        expect(await build({ moduleSideEffects: true })).toBe(await build(undefined));
    });

    it('`false` drops every module nothing uses', async () => {
        const code = await build({ moduleSideEffects: false });
        expect(code).not.toContain('__ran');
        expect(code).not.toContain('__other');
    });

    it('a FUNCTION decides per module, and `undefined` defers', async () => {
        const only = await build({ moduleSideEffects: (id: string) => (id === '/effect.js' ? false : undefined) });
        expect(only, 'asked to drop').not.toContain('__ran');
        expect(only, 'deferred, so kept').toContain('__other');
    });

    it('the function is told whether the module is external', async () => {
        const seen: [string, boolean][] = [];
        await build({
            moduleSideEffects: (id: string, external: boolean) => {
                seen.push([id, external]);
                return undefined;
            },
        });
        expect(seen.length).toBeGreaterThan(0);
        expect(
            seen.every(([, ext]) => ext === false),
            'nothing here is external',
        ).toBe(true);
    });

    it('the option OUTRANKS `package.json#sideEffects`', async () => {
        // The half of the precedence a memory fixture without a manifest cannot reach: a package
        // declaring `sideEffects: true` fills the same slot the option would, and the option has to
        // win. Placing it only as the FINAL default would let the manifest beat it — which is the
        // wrong order, and a sabotage of the merge point is invisible without this fixture.
        const pkgFiles: Record<string, string> = {
            '/node_modules/dep/package.json': '{"name":"dep","version":"1.0.0","main":"index.js","sideEffects":true}',
            '/node_modules/dep/index.js': 'globalThis.__dep = true;\nexport const depUnused = 1;\n',
            '/main.js': "import 'dep';\nexport const x = 1;\n",
        };
        const fs = { read: (id: string) => pkgFiles[id] ?? null, exists: (id: string) => id in pkgFiles };
        const run = async (treeshake?: unknown) => {
            const r = await bundle({ entry: '/main.js', fs, external: [], treeshake: treeshake as never, output: {} });
            expect(r.errors).toEqual([]);
            return r.chunks.map((c) => c.code).join('\n');
        };
        expect(await run(undefined), 'the manifest says it has effects').toContain('__dep');
        expect(await run({ moduleSideEffects: false }), 'the option overrides it').not.toContain('__dep');
    });

    it('a plugin hook OUTRANKS the option, which is rolldown’s order', async () => {
        const fs = { read: (id: string) => files[id] ?? null, exists: (id: string) => id in files };
        const r = await bundle({
            entry: '/main.js',
            fs,
            external: [],
            treeshake: { moduleSideEffects: false } as never,
            plugins: [
                {
                    name: 'keep-effect',
                    transform(code: string, id: string) {
                        return id === '/effect.js' ? { code, moduleSideEffects: true } : null;
                    },
                },
            ] as never,
            output: {},
        });
        expect(r.errors).toEqual([]);
        const code = r.chunks.map((c) => c.code).join('\n');
        expect(code, 'the hook said keep it').toContain('__ran');
        expect(code, 'the option still governs the rest').not.toContain('__other');
    });
});
