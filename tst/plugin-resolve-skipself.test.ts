import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';

// `this.resolve(..., { skipSelf })` takes the CALLING PLUGIN out of the loop for THAT
// (specifier, importer) — not the whole pipeline, and not that plugin for every specifier.
//
// rolldown models it as a triple, `HookResolveIdSkipped { plugin_idx, importer, specifier }`
// (`native_plugin_context.rs:96-108`), accumulated down a chain of nested calls. shakeup's previous
// guard was keyed on (specifier, importer) alone and short-circuited straight to the base resolver,
// which is coarser in both directions: it skipped plugins that should have run, and it kept skipping
// a plugin for specifiers it had never been asked about.
const build = async (files: Record<string, string>, plugins: unknown[]) => {
    const fs = { read: (id: string) => files[id] ?? null, exists: (id: string) => id in files };
    const r = await bundle({ entry: '/main.js', fs, external: [], plugins: plugins as never, output: {} });
    expect(r.errors).toEqual([]);
    return r.chunks.map((c) => c.code).join('\n');
};

describe('this.resolve skipSelf', () => {
    const files = { '/main.js': "import 'x';\n", '/a.js': "globalThis.__which = 'a';\n", '/b.js': "globalThis.__which = 'b';\n" };

    it('skips only the CALLING plugin, so a later plugin still resolves', async () => {
        const code = await build(files, [
            {
                name: 'first',
                async resolveId(id: string) {
                    // Without skipSelf this would recurse forever; with it, `second` answers.
                    if (id === 'x')
                        return (await (this as never as { resolve: (s: string) => Promise<{ id: string } | null> }).resolve('x'))
                            ?.id;
                    return null;
                },
            },
            { name: 'second', resolveId: (id: string) => (id === 'x' ? '/a.js' : null) },
        ]);
        expect(code).toContain("'a'");
    });

    it('skipSelf: false lets the caller see its own hook again', async () => {
        let seen = 0;
        const code = await build(files, [
            {
                name: 'only',
                async resolveId(id: string) {
                    if (id !== 'x') return null;
                    seen++;
                    if (seen > 1) return '/b.js';
                    return (
                        await (
                            this as never as { resolve: (s: string, i: null, o: unknown) => Promise<{ id: string } | null> }
                        ).resolve('x', null, { skipSelf: false })
                    )?.id;
                },
            },
        ]);
        expect(seen, 'the hook ran twice — it was not skipped').toBe(2);
        expect(code).toContain("'b'");
    });

    it('a plugin skipped for one specifier still resolves ANOTHER', async () => {
        // The discriminating case for the guard being a TRIPLE rather than a plugin id. `first` is
        // skipped for `x` while its nested resolution runs; inside that, `second` asks for `y`, and
        // `first` must still answer — it was only ever taken out of the loop for `x`.
        //
        // Asserting on the INNER result, not the final bundle: the outer pipeline retries `second`
        // for `x` with an empty skip set, so a wrong inner answer is silently recovered and the
        // emitted code looks identical either way. That made the first version of this test pass
        // against a deliberately plugin-keyed guard.
        type Ctx = { resolve: (s: string) => Promise<{ id: string } | null> };
        let innerY: string | undefined;
        await build(files, [
            {
                name: 'first',
                async resolveId(id: string) {
                    if (id === 'x') return (await (this as never as Ctx).resolve('x'))?.id;
                    if (id === 'y') return '/b.js';
                    return null;
                },
            },
            {
                name: 'second',
                async resolveId(id: string) {
                    // Only reached because `first` skipped itself for `x`.
                    if (id !== 'x') return null;
                    const seen = (await (this as never as Ctx).resolve('y'))?.id;
                    innerY ??= seen;
                    return seen ?? '/a.js';
                },
            },
        ]);
        expect(innerY, '`first` was skipped for `x`, not for `y`').toBe('/b.js');
    });

    it('stops a pair of plugins that each re-resolve under a DIFFERENT importer (Rollup #5768)', async () => {
        // Neither plugin is ever skipped by the other's entry, because each changes the importer, so
        // the accumulated set grows without either being taken out of the loop. The guard is that
        // adding an entry ALREADY present means this plugin has been called before with the same id
        // and importer — the chain cannot progress, so the resolution is null and the caller's own
        // fallback takes over. Without it this recurses until the stack dies.
        type Ctx = { resolve: (s: string, i: string) => Promise<{ id: string } | null> };
        const files2 = { '/main.js': "import 'x';\n", '/a.js': "globalThis.__which = 'a';\n" };
        const code = await build(files2, [
            {
                name: 'r1',
                async resolveId(id: string) {
                    if (id !== 'x') return null;
                    return (await (this as never as Ctx).resolve(id, 'foo'))?.id ?? '/a.js';
                },
            },
            {
                name: 'r2',
                async resolveId(id: string) {
                    if (id !== 'x') return null;
                    return (await (this as never as Ctx).resolve(id, 'bar'))?.id ?? null;
                },
            },
        ]);
        expect(code).toContain("'a'");
    });
});
