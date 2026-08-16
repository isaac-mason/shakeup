import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs, type Fs } from '../src/fs.ts';
import type { Plugin, PluginCtx, ResolveIdResult } from '../src/plugin.ts';
import { EMPTY_MODULE_ID, nodeResolve } from '../src/plugins/node-resolve.ts';
import { loadResolveFixtures } from './fixtures/resolve.ts';
import { stubPluginCtx } from './plugin-ctx.ts';

type Probe = {
    fs: Fs;
    plugin: Plugin;
    resolve(specifier: string, importer: string | null): { id: ResolveIdResult; warnings: string[] };
};

type ProbeOverrides = { conditions?: string[]; extensions?: string[]; mainFields?: string[] };

function probe(overrides?: ProbeOverrides): Probe {
    const fs = createMemoryFs(loadResolveFixtures());
    const plugin = nodeResolve({ fs, ...overrides });
    const hook = plugin.resolveId as (ctx: PluginCtx, s: string, i: string | null) => ResolveIdResult;
    return {
        fs,
        plugin,
        resolve(specifier, importer) {
            const warnings: string[] = [];
            const ctx = stubPluginCtx(fs, (m) => warnings.push(m));
            const id = hook(ctx, specifier, importer);
            return { id, warnings };
        },
    };
}

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const APP = '/app/main.ts';

describe('nodeResolve: bare-specifier detection', () => {
    it('passes relative/absolute/virtual specifiers to core (null)', () => {
        const p = probe();
        expect(p.resolve('./local.ts', APP).id).toBe(null);
        expect(p.resolve('../up.ts', APP).id).toBe(null);
        expect(p.resolve('/abs.ts', APP).id).toBe(null);
        expect(p.resolve('\0virtual', APP).id).toBe(null);
    });

    it('splits @scope/pkg names requiring the slash', () => {
        const p = probe();
        expect(p.resolve('@scope/pkg', APP).id).toBe('/app/node_modules/@scope/pkg/index.js');
        expect(p.resolve('@scope/pkg/feature', APP).id).toBe('/app/node_modules/@scope/pkg/feature.js');
        expect(p.resolve('@scope', APP).id).toBe(null);
    });
});

describe('nodeResolve: exports condition matching (author order)', () => {
    it('author key order wins: {browser,import,default} -> browser', () => {
        const p = probe();
        expect(p.resolve('modern-exports', APP).id).toBe('/app/node_modules/modern-exports/browser.js');
    });

    it('conditions option narrows the active set (drop browser -> import wins)', () => {
        const p = probe({ conditions: ['import', 'module', 'default'] });
        expect(p.resolve('modern-exports', APP).id).toBe('/app/node_modules/modern-exports/import.js');
    });
});

describe('nodeResolve: wildcard specificity + null-block', () => {
    it('exact subpath key overrides the wildcard', () => {
        const p = probe();
        expect(p.resolve('wildcard-pkg/utils/special', APP).id).toBe('/app/node_modules/wildcard-pkg/dist/special-override.js');
    });

    it('wildcard captures and substitutes', () => {
        const p = probe();
        expect(p.resolve('wildcard-pkg/utils/foo', APP).id).toBe('/app/node_modules/wildcard-pkg/dist/utils/foo.js');
    });

    it('"." sugar-less object resolves via the dot key', () => {
        const p = probe();
        expect(p.resolve('wildcard-pkg', APP).id).toBe('/app/node_modules/wildcard-pkg/dist/main.js');
    });

    it('null target is author-blocked -> warn + null', () => {
        const p = probe();
        const { id, warnings } = p.resolve('wildcard-pkg/internal/secret', APP);
        expect(id).toBe(null);
        expect(warnings).toContainEqual(
            'Could not resolve "wildcard-pkg/internal/secret": The path "./internal/secret" is not exported by package "wildcard-pkg" — explicitly disabled by the package author',
        );
    });
});

describe('nodeResolve: fallback arrays', () => {
    it('skips an invalid first member, uses the second', () => {
        const p = probe();
        expect(p.resolve('fallback-array-pkg', APP).id).toBe('/app/node_modules/fallback-array-pkg/good.js');
    });
});

describe('nodeResolve: exports terminal + exact resolution', () => {
    it('resolves the declared entry', () => {
        const p = probe();
        expect(p.resolve('exports-terminal-pkg', APP).id).toBe('/app/node_modules/exports-terminal-pkg/entry.js');
    });

    it('exports miss never falls back to main -> warn + null', () => {
        const p = probe();
        const { id, warnings } = p.resolve('exports-terminal-pkg/missing', APP);
        expect(id).toBe(null);
        expect(warnings).toContainEqual(
            'Could not resolve "exports-terminal-pkg/missing": The path "./missing" is not exported by package "exports-terminal-pkg"',
        );
    });

    it('exact target with no probing fails when only .js exists -> warn + null', () => {
        const p = probe();
        const { id, warnings } = p.resolve('exact-only-pkg', APP);
        expect(id).toBe(null);
        expect(warnings).toContainEqual(
            'Could not resolve "exact-only-pkg": The module "./lib/thing" was not found on the file system',
        );
    });
});

describe('nodeResolve: no-conditions-match diagnosis', () => {
    it('lists both the package conditions and the active set', () => {
        const p = probe();
        const { id, warnings } = p.resolve('no-conditions-pkg', APP);
        expect(id).toBe(null);
        expect(warnings).toContainEqual(
            'Could not resolve "no-conditions-pkg": None of the conditions in the package definition ("require", "node") match any of the currently active conditions ("import", "browser", "default")',
        );
    });
});

describe('nodeResolve: legacy resolution (no exports)', () => {
    it('browser main field wins over module and main', () => {
        const p = probe();
        expect(p.resolve('legacy-pkg', APP).id).toBe('/app/node_modules/legacy-pkg/browser.js');
    });

    it('main-only package resolves via main', () => {
        const p = probe();
        expect(p.resolve('legacy-main-only', APP).id).toBe('/app/node_modules/legacy-main-only/entry.js');
    });

    it('mainFields option can prefer module', () => {
        const p = probe({ mainFields: ['module', 'main'] });
        expect(p.resolve('legacy-pkg', APP).id).toBe('/app/node_modules/legacy-pkg/module.js');
    });
});

describe('nodeResolve: browser object remapping', () => {
    it('remaps a relative own-file import inside the package to the browser build', () => {
        const p = probe();
        const importer = '/app/node_modules/browser-object-pkg/entry.js';
        expect(p.resolve('./node-impl.js', importer).id).toBe('/app/node_modules/browser-object-pkg/browser-impl.js');
    });

    it('a false-mapped relative import becomes the empty-module sentinel', () => {
        const p = probe();
        const importer = '/app/node_modules/browser-object-pkg/entry.js';
        expect(p.resolve('./disabled.js', importer).id).toBe(EMPTY_MODULE_ID);
    });

    it('the load hook returns empty source for the sentinel', () => {
        const p = probe();
        const loadHook = p.plugin.load as (ctx: PluginCtx, id: string) => string | null | undefined;
        expect(loadHook(stubPluginCtx(p.fs), EMPTY_MODULE_ID)).toBe('');
    });

    it('a relative import outside any browser-map package passes to core', () => {
        const p = probe();
        expect(p.resolve('./node-impl.js', '/app/node_modules/legacy-pkg/main.js').id).toBe(null);
    });
});

describe('nodeResolve: self-reference', () => {
    it('a package importing itself by name resolves via its own exports', () => {
        const p = probe();
        const importer = '/app/node_modules/self-ref-pkg/index.js';
        expect(p.resolve('self-ref-pkg/helper', importer).id).toBe('/app/node_modules/self-ref-pkg/helper.js');
        expect(p.resolve('self-ref-pkg', importer).id).toBe('/app/node_modules/self-ref-pkg/index.js');
    });
});

describe('nodeResolve: node_modules shadowing', () => {
    it('an importer in a nested package gets the nested copy', () => {
        const p = probe();
        const deep = '/app/packages/deep/consumer.js';
        expect(p.resolve('dup', deep).id).toBe('/app/packages/deep/node_modules/dup/index.js');
    });

    it('an importer at the app root gets the shallow copy', () => {
        const p = probe();
        expect(p.resolve('dup', APP).id).toBe('/app/node_modules/dup/index.js');
    });
});

describe('nodeResolve: end-to-end bundle + execute', () => {
    const buildAndRun = async (mainSource: string): Promise<Record<string, unknown>> => {
        const files = loadResolveFixtures();
        files[APP] = mainSource;
        const fs = createMemoryFs(files);
        const result = bundle({ entry: APP, fs, plugins: [nodeResolve({ fs })] });
        expect(result.errors).toEqual([]);
        return run(result.code);
    };

    it('bundles several packages through the plugin and executes them', async () => {
        const mod = await buildAndRun(
            "import { impl as a } from 'modern-exports';\n" +
                "import { impl as b } from 'wildcard-pkg/utils/foo';\n" +
                "import { impl as c } from 'legacy-pkg';\n" +
                "import { impl as d } from '@scope/pkg/feature';\n" +
                "import { impl as e } from 'self-ref-pkg';\n" +
                "import { impl as f } from 'fallback-array-pkg';\n" +
                'export const a2 = a, b2 = b, c2 = c, d2 = d, e2 = e, f2 = f;',
        );
        expect(mod.a2).toBe('modern-browser');
        expect(mod.b2).toBe('wildcard-utils-foo');
        expect(mod.c2).toBe('legacy-browser');
        expect(mod.d2).toBe('scoped-feature');
        expect(mod.e2).toBe('self-ref-helper');
        expect(mod.f2).toBe('fallback-good');
    });

    it('browser object remap + false stub work through the real import graph', async () => {
        const mod = await buildAndRun(
            "import { impl, stubKeys } from 'browser-object-pkg';\n" + 'export const impl2 = impl, keys2 = stubKeys;',
        );
        expect(mod.impl2).toBe('browser-impl');
        expect(mod.keys2).toBe(0);
    });

    it('nested shadowing resolves deep dep for a deep importer', async () => {
        const mod = await buildAndRun("export { v } from './packages/deep/consumer.js';");
        expect(mod.v).toBe('dup-deep');
    });
});

import { createMemoryFs as mkFs } from '../src/fs.ts';

function probeFs(files: Record<string, string>, overrides: Partial<Parameters<typeof nodeResolve>[0]> = {}) {
    const fs = mkFs(files);
    const plugin = nodeResolve({ fs, ...overrides });
    const hook = plugin.resolveId as (ctx: PluginCtx, s: string, i: string | null) => ResolveIdResult;
    return {
        resolve(specifier: string, importer: string | null) {
            const warnings: string[] = [];
            const id = hook(
                stubPluginCtx(fs, (m) => warnings.push(m)),
                specifier,
                importer,
            );
            return { id, warnings };
        },
    };
}

describe('alignment regressions (vs esbuild)', () => {
    it('D3: importer browser map disables a bare specifier (postcss stubbing pattern)', () => {
        const p = probeFs({
            '/app/package.json': '{ "name": "app", "browser": { "source-map-js": false } }',
            '/app/src/a.js': '',
            '/app/node_modules/source-map-js/package.json': '{ "main": "index.js" }',
            '/app/node_modules/source-map-js/index.js': '',
        });
        expect(p.resolve('source-map-js', '/app/src/a.js').id).toBe(EMPTY_MODULE_ID);
    });

    it('D3: importer browser map remaps a bare specifier to a relative file (tapable pattern)', () => {
        const p = probeFs({
            '/app/node_modules/tapable-ish/package.json':
                '{ "name": "tapable-ish", "main": "main.js", "browser": { "util": "./lib/util-browser.js" } }',
            '/app/node_modules/tapable-ish/main.js': '',
            '/app/node_modules/tapable-ish/lib/util-browser.js': '',
        });
        expect(p.resolve('util', '/app/node_modules/tapable-ish/main.js').id).toBe(
            '/app/node_modules/tapable-ish/lib/util-browser.js',
        );
    });

    it('D3: bare-to-bare browser remap re-resolves as a package (no loop)', () => {
        const p = probeFs({
            '/app/package.json': '{ "browser": { "heavy-dep": "light-dep" } }',
            '/app/src/a.js': '',
            '/app/node_modules/light-dep/package.json': '{ "main": "index.js" }',
            '/app/node_modules/light-dep/index.js': '',
        });
        expect(p.resolve('heavy-dep', '/app/src/a.js').id).toBe('/app/node_modules/light-dep/index.js');
    });

    it('D3: browser scope propagates past an intermediate package.json without a map', () => {
        const p = probeFs({
            '/app/package.json': '{ "browser": { "stub-me": false } }',
            '/app/packages/inner/package.json': '{ "name": "inner" }',
            '/app/packages/inner/src/b.js': '',
            '/app/node_modules/stub-me/package.json': '{ "main": "index.js" }',
            '/app/node_modules/stub-me/index.js': '',
        });
        expect(p.resolve('stub-me', '/app/packages/inner/src/b.js').id).toBe(EMPTY_MODULE_ID);
    });

    it('D2: exports: null means NO exports map — legacy main fallback (esbuild package_json.go:808-810)', () => {
        const p = probeFs({
            '/app/src/a.js': '',
            '/app/node_modules/null-exports/package.json': '{ "main": "index.js", "exports": null }',
            '/app/node_modules/null-exports/index.js': '',
        });
        const r = p.resolve('null-exports', '/app/src/a.js');
        expect(r.id).toBe('/app/node_modules/null-exports/index.js');
        expect(r.warnings).toEqual([]);
    });

    it('D4: extensionless browser key matches the extension-resolved file', () => {
        const p = probeFs({
            '/app/node_modules/extless/package.json':
                '{ "name": "extless", "main": "./lib/impl", "browser": { "./lib/impl": "./lib/impl-browser.js" } }',
            '/app/node_modules/extless/lib/impl.js': '',
            '/app/node_modules/extless/lib/impl-browser.js': '',
            '/app/src/a.js': '',
        });
        expect(p.resolve('extless', '/app/src/a.js').id).toBe('/app/node_modules/extless/lib/impl-browser.js');
    });

    it('D1: percent-encoded separators in exports targets are invalid (esmHandlePostConditions)', () => {
        const p = probeFs({
            '/app/src/a.js': '',
            '/app/node_modules/enc/package.json': '{ "name": "enc", "exports": { ".": "./a%2fb.js" } }',
            '/app/node_modules/enc/a%2fb.js': '',
        });
        const r = p.resolve('enc', '/app/src/a.js');
        expect(r.id).toBe(null);
        expect(r.warnings.join(' ')).toMatch(/must not include encoded/);
    });

    it('D5: defaults align to lineage — no module condition, TS-first extensions', () => {
        const p = probeFs({
            '/app/src/a.js': '',
            '/app/node_modules/mod-cond/package.json':
                '{ "name": "mod-cond", "exports": { "module": "./m.js", "default": "./d.js" } }',
            '/app/node_modules/mod-cond/m.js': '',
            '/app/node_modules/mod-cond/d.js': '',
            '/app/node_modules/ts-first/package.json': '{ "main": "./impl" }',
            '/app/node_modules/ts-first/impl.ts': '',
            '/app/node_modules/ts-first/impl.js': '',
        });
        expect(p.resolve('mod-cond', '/app/src/a.js').id).toBe('/app/node_modules/mod-cond/d.js');
        expect(p.resolve('ts-first', '/app/src/a.js').id).toBe('/app/node_modules/ts-first/impl.ts');
    });
});

describe('R4 resolve:{} config (core relative probe)', () => {
    const moduleIds = (r: ReturnType<typeof bundle>) => r.chunks[0].moduleIds;

    it('extensions: a custom order resolves the earlier ext first', () => {
        const r = bundle({
            input: '/main.ts',
            fs: createMemoryFs({
                '/main.ts': "export { v } from './x';",
                '/x.mjs': 'export const v = 1;',
                '/x.ts': 'export const v = 2;',
            }),
            external: [],
            resolve: { extensions: ['.mjs', '.ts'] },
        });
        expect(r.errors).toEqual([]);
        expect(moduleIds(r)).toContain('/x.mjs');
        expect(moduleIds(r)).not.toContain('/x.ts');
    });

    it('extensionAlias: {".js":[".ts"]} makes ./x.js resolve x.ts', () => {
        const r = bundle({
            input: '/main.ts',
            fs: createMemoryFs({
                '/main.ts': "export { v } from './x.js';",
                '/x.ts': 'export const v = 1;',
            }),
            external: [],
            resolve: { extensionAlias: { '.js': ['.ts'] } },
        });
        expect(r.errors).toEqual([]);
        expect(moduleIds(r)).toContain('/x.ts');
    });

    it('alias: {"@":"/src"} rewrites @/foo → /src/foo', () => {
        const r = bundle({
            input: '/src/main.ts',
            fs: createMemoryFs({
                '/src/main.ts': "export { v } from '@/foo';",
                '/src/foo.ts': 'export const v = 1;',
            }),
            external: [],
            resolve: { alias: { '@': '/src' } },
        });
        expect(r.errors).toEqual([]);
        expect(moduleIds(r)).toContain('/src/foo.ts');
    });

    it('mainFiles: a directory import resolves the configured index basename', () => {
        const r = bundle({
            input: '/main.ts',
            fs: createMemoryFs({
                '/main.ts': "export { v } from './lib';",
                '/lib/main.ts': 'export const v = 1;',
            }),
            external: [],
            resolve: { mainFiles: ['main', 'index'] },
        });
        expect(r.errors).toEqual([]);
        expect(moduleIds(r)).toContain('/lib/main.ts');
    });

    it('symlinks:false disables the fs.realpath deref', () => {
        // An fs whose realpath maps /link/x.ts → /real/x.ts. With symlinks:true (default) the
        // module id is canonicalized; with symlinks:false the symlinked path is preserved.
        const files = new Map<string, string>([
            ['/main.ts', "export { v } from './link/x';"],
            ['/real/x.ts', 'export const v = 1;'],
        ]);
        const canon = (id: string): string => (id.startsWith('/link/') ? `/real/${id.slice('/link/'.length)}` : id);
        const fs = {
            read: (id: string) => files.get(canon(id)) ?? null,
            exists: (id: string) => files.has(canon(id)),
            realpath: (id: string) => canon(id),
        };
        const withDeref = bundle({ input: '/main.ts', fs, external: [] });
        expect(withDeref.errors).toEqual([]);
        expect(withDeref.chunks[0].moduleIds).toContain('/real/x.ts');

        const noDeref = bundle({ input: '/main.ts', fs, external: [], resolve: { symlinks: false } });
        expect(noDeref.errors).toEqual([]);
        expect(noDeref.chunks[0].moduleIds).toContain('/link/x.ts');
    });

    it('platform/mainFields SENTINEL — accepted + stored but not consumed by the core probe', () => {
        // The core relative probe does not read package.json fields; mainFields/conditionNames are
        // a NOT-IMPLEMENTED seam (they only take effect once the npm-field resolver consumes them).
        // Passing them must not error and must not change core relative resolution. (Mirrors the
        // resolve.workspace.test.ts sentinel.)
        const r = bundle({
            input: '/main.ts',
            fs: createMemoryFs({
                '/main.ts': "export { v } from './x';",
                '/x.ts': 'export const v = 1;',
            }),
            external: [],
            platform: 'node',
            resolve: { mainFields: ['module', 'main'], conditionNames: ['custom'] },
        });
        expect(r.errors).toEqual([]);
        expect(r.chunks[0].moduleIds).toContain('/x.ts');
    });
});
