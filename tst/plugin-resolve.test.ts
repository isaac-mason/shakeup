import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';
import type { ModuleSideEffects, Plugin } from '../src/bundler/plugin.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (files: Record<string, string>, plugins: Plugin[] = [], external: string[] = []) => {
    const result = await bundle({ entry: '/main.ts', fs: createMemoryFs(files), external, plugins });
    expect(result.errors).toEqual([]);
    return result;
};

describe('plugin resolve/load contract (R1)', () => {
    it('resolveId object return resolves a virtual module', async () => {
        const virtual: Plugin = {
            name: 'virtual-config',
            resolveId: (spec) => (spec === 'virtual:config' ? { id: '\0virtual:config', moduleSideEffects: false } : null),
            load: (id) => (id === '\0virtual:config' ? 'export const version = "9.9.9";' : null),
        };
        const {
            chunks: [{ code }],
        } = await build({ '/main.ts': "import { version } from 'virtual:config';\nexport const v = version;" }, [virtual]);
        const mod = await run(code);
        expect(mod.v).toBe('9.9.9');
    });

    it('resolveId { external: true } keeps the import external', async () => {
        const externalize: Plugin = {
            name: 'externalize',
            resolveId: (spec) => (spec === 'lib-esque' ? { id: 'lib-esque', external: true } : null),
        };
        const {
            chunks: [{ code }],
        } = await build({ '/main.ts': "import { chunk } from 'lib-esque';\nexport const c = () => chunk([1], 1);" }, [
            externalize,
        ]);
        expect(code).toContain("from 'lib-esque'");
    });

    it("resolveId { external: 'absolute' } is also treated external", async () => {
        const externalize: Plugin = {
            name: 'externalize-abs',
            resolveId: (spec) => (spec === 'abs-lib' ? { id: '/abs/abs-lib', external: 'absolute' } : null),
        };
        const {
            chunks: [{ code }],
        } = await build({ '/main.ts': "import { x } from 'abs-lib';\nexport const c = () => x();" }, [externalize]);
        // The RESOLVED id, not the specifier the source wrote. Measured against rollup 4.63 on this
        // exact shape: it emits `import { x } from '/abs/abs-lib';` — and does so for `external: true`
        // as well, since `makeAbsoluteExternalsRelative`'s default only renormalizes an absolute id
        // when the SOURCE specifier was relative. This assertion used to read `from 'abs-lib'`, which
        // pinned shakeup's own behaviour rather than Rollup's.
        expect(code).toContain("from '/abs/abs-lib'");
    });

    it('moduleSideEffects: false drops an unused side-effect module', async () => {
        const files = {
            '/main.ts': "import './effect.ts';\nexport const out = 1;",
            '/effect.ts': 'globalThis.__EFFECT_MARKER__ = 42;',
        };
        const markPure: Plugin = {
            name: 'mark-pure',
            resolveId: (spec, importer) =>
                spec === './effect.ts' && importer !== null ? { id: '/effect.ts', moduleSideEffects: false } : null,
        };
        const {
            chunks: [{ code }],
            shaken,
        } = await build(files, [markPure]);
        expect(code).not.toContain('__EFFECT_MARKER__');
        expect(shaken!.dropped.length).toBeGreaterThan(0);
        const mod = await run(code);
        expect(mod.out).toBe(1);

        const kept = await build(files, []);
        expect(kept.chunks[0].code).toContain('__EFFECT_MARKER__');
    });

    it('external moduleSideEffects: false drops an unreferenced external import (B1)', async () => {
        // A plugin marks one external side-effect-free and another (default) side-effectful. Both
        // are imported but never referenced. The pure one's import is dropped entirely; the
        // side-effectful one is kept — the general form of the jsx-runtime prune.
        const plugin: Plugin = {
            name: 'ext-side-effects',
            resolveId: (spec) =>
                spec === 'clean-lib'
                    ? { id: 'clean-lib', external: true, moduleSideEffects: false }
                    : spec === 'sfx-lib'
                      ? { id: 'sfx-lib', external: true }
                      : null,
        };
        const {
            chunks: [{ code }],
        } = await build(
            {
                '/main.ts': ["import { a } from 'clean-lib';", "import { b } from 'sfx-lib';", 'export const out = 1;'].join(
                    '\n',
                ),
            },
            [plugin],
        );
        expect(code).not.toContain('clean-lib'); // side-effect-free + unreferenced → gone
        expect(code).toContain('sfx-lib'); // default side-effectful → kept
    });

    it("moduleSideEffects: 'no-treeshake' keeps every statement", async () => {
        const files = {
            '/main.ts': "import { used } from './lib.ts';\nexport const out = used;",
            '/lib.ts': ['export const used = 1;', 'const DEAD_BUT_KEPT = 99;', 'globalThis.__NT__ = DEAD_BUT_KEPT;'].join('\n'),
        };
        const noShake: Plugin = {
            name: 'no-shake',
            resolveId: (spec) => (spec === './lib.ts' ? { id: '/lib.ts', moduleSideEffects: 'no-treeshake' } : null),
        };
        const {
            chunks: [{ code }],
        } = await build(files, [noShake]);
        expect(code).toContain('DEAD_BUT_KEPT');
        expect(code).toContain('__NT__');
    });

    it('side-effect precedence: transform wins over load over resolveId', async () => {
        let final: unknown;
        const layered: Plugin = {
            name: 'layered',
            resolveId: (spec, importer) =>
                spec === './lib.ts' && importer !== null ? { id: '/lib.ts', moduleSideEffects: false } : null,
            load: (id) => (id === '/lib.ts' ? { code: 'export const used = 1;', moduleSideEffects: true } : null),
            transform: {
                filter: { id: /lib\.ts$/ },
                handler: (code) => ({ code, moduleSideEffects: false }),
            },
            buildEnd: function () {
                final = this.getModuleInfo('/lib.ts')?.moduleSideEffects;
            },
        };
        await build(
            { '/main.ts': "import { used } from './lib.ts';\nexport const out = used;", '/lib.ts': 'export const used = 1;' },
            [layered],
        );
        expect(final).toBe(false);
    });

    it('meta round-trips across plugins via getModuleInfo; getModuleIds enumerates', async () => {
        let readA: unknown;
        let ids: string[] = [];
        const setter: Plugin = {
            name: 'setter',
            resolveId: (spec, importer) => (spec === './a.ts' && importer !== null ? { id: '/a.ts', meta: { a: 1 } } : null),
        };
        const reader: Plugin = {
            name: 'reader',
            buildEnd: function () {
                const info = this.getModuleInfo('/a.ts');
                readA = (info?.meta.a as number | undefined) ?? undefined;
                ids = [...this.getModuleIds()];
            },
        };
        await build({ '/main.ts': "import { a } from './a.ts';\nexport const out = a;", '/a.ts': 'export const a = 1;' }, [
            setter,
            reader,
        ]);
        expect(readA).toBe(1);
        expect(ids.sort()).toEqual(['/a.ts', '/main.ts']);
    });

    it('this.resolve re-runs resolution and does not recurse', async () => {
        let resolved: string | null = null;
        const asker: Plugin = {
            name: 'asker',
            buildStart: async function () {
                const r = await this.resolve('./lib.ts', '/main.ts');
                resolved = r === null ? null : (r as { id: string }).id;
            },
        };
        // A resolveId hook that calls this.resolve on the SAME specifier must not loop:
        // the resolving-set guard sends it straight to baseResolve.
        let guardedId: string | null = null;
        const recursive: Plugin = {
            name: 'recursive',
            resolveId: async function (spec, importer) {
                if (spec === './lib.ts' && importer !== null) {
                    const r = await this.resolve('./lib.ts', importer);
                    guardedId = r === null ? null : (r as { id: string }).id;
                }
                return null;
            },
        };
        await build({ '/main.ts': "import { x } from './lib.ts';\nexport const out = x;", '/lib.ts': 'export const x = 1;' }, [
            asker,
            recursive,
        ]);
        expect(resolved).toBe('/lib.ts');
        expect(guardedId).toBe('/lib.ts');
    });

    it('load returning a SourceDescription applies code and side-effect flag', async () => {
        let sideEffects: ModuleSideEffects | undefined;
        const desc: Plugin = {
            name: 'desc',
            resolveId: (spec) => (spec === 'virtual:d' ? '\0d' : null),
            load: (id) =>
                id === '\0d' ? { code: 'globalThis.__D__ = 1;\nexport const d = 7;', moduleSideEffects: false } : null,
            buildEnd: function () {
                sideEffects = this.getModuleInfo('\0d')?.moduleSideEffects;
            },
        };
        const {
            chunks: [{ code }],
        } = await build({ '/main.ts': "import { d } from 'virtual:d';\nexport const v = d;" }, [desc]);
        const mod = await run(code);
        expect(mod.v).toBe(7);
        // The assignment is KEPT, and this assertion was inverted on 2026-09-06. `moduleSideEffects:
        // false` says the module may be OMITTED when nothing needs it — not that the effects of a
        // module that IS emitted may be deleted. This chunk still contains `const d = 7`, so dropping
        // `globalThis.__D__ = 1` from it was a silent behaviour change, the same bug that deleted
        // `registry.set(…)` and `console.log(…)` elsewhere (ROADMAP §2z47).
        //
        // rolldown emits neither: it constant-folds `d` into the consumer and then drops the module
        // WHOLE, which is a stronger result reached by cross-module inlining rather than by a
        // different side-effect rule. Give it a non-inlinable export and it keeps the effect exactly
        // as this now does (measured). Closing that gap is an inlining change, not this one.
        expect(code).toContain('__D__');
        expect(sideEffects).toBe(false);
    });
});
