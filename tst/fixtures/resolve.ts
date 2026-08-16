// Fixture node_modules tree for the nodeResolve plugin tests. Realistic on-disk
// layout under /app; loaded into a memory Fs. Packages are designed
// adversarially to exercise each resolution rule.

/** The complete fixture file tree: absolute posix path -> file contents. */
export const resolveFixtures: Record<string, string> = {
    /* ------------------------------------------------ the consuming app */
    '/app/package.json': JSON.stringify({ name: 'app', private: true }),

    /* -------------------- modern-exports: sugar form, author-order wins */
    // conditions ordered {browser, import, default}; each points at a distinct
    // file. Our active set has both browser and import, so browser (first) wins.
    '/app/node_modules/modern-exports/package.json': JSON.stringify({
        name: 'modern-exports',
        exports: {
            browser: './browser.js',
            import: './import.js',
            default: './default.js',
        },
    }),
    '/app/node_modules/modern-exports/browser.js': "export const impl = 'modern-browser';",
    '/app/node_modules/modern-exports/import.js': "export const impl = 'modern-import';",
    '/app/node_modules/modern-exports/default.js': "export const impl = 'modern-default';",

    /* ---------------- wildcard-pkg: specificity + exact override + null */
    '/app/node_modules/wildcard-pkg/package.json': JSON.stringify({
        name: 'wildcard-pkg',
        exports: {
            '.': './dist/main.js',
            './utils/special': './dist/special-override.js', // exact beats the wildcard
            './utils/*': './dist/utils/*.js',
            './internal/*': null, // author-blocked
        },
    }),
    '/app/node_modules/wildcard-pkg/dist/main.js': "export const impl = 'wildcard-main';",
    '/app/node_modules/wildcard-pkg/dist/utils/foo.js': "export const impl = 'wildcard-utils-foo';",
    '/app/node_modules/wildcard-pkg/dist/special-override.js': "export const impl = 'wildcard-special';",
    '/app/node_modules/wildcard-pkg/dist/internal/secret.js': "export const impl = 'should-be-blocked';",

    /* ------------------ fallback-array-pkg: first array member invalid */
    '/app/node_modules/fallback-array-pkg/package.json': JSON.stringify({
        name: 'fallback-array-pkg',
        exports: {
            '.': ['bad-no-dot-slash', './good.js'], // first is invalid target -> skipped
        },
    }),
    '/app/node_modules/fallback-array-pkg/good.js': "export const impl = 'fallback-good';",

    /* ------------- exports-terminal-pkg: exports + main, miss must error */
    '/app/node_modules/exports-terminal-pkg/package.json': JSON.stringify({
        name: 'exports-terminal-pkg',
        main: './legacy-main.js', // must NEVER be used when exports is present
        exports: {
            '.': './entry.js',
            // no "./missing" key -> importing it must fail, not fall back to main
        },
    }),
    '/app/node_modules/exports-terminal-pkg/entry.js': "export const impl = 'terminal-entry';",
    '/app/node_modules/exports-terminal-pkg/legacy-main.js': "export const impl = 'legacy-fallback';",

    /* --------------- exact-only-pkg: exact target, only .js exists -> fail */
    '/app/node_modules/exact-only-pkg/package.json': JSON.stringify({
        name: 'exact-only-pkg',
        exports: {
            '.': './lib/thing', // no extension; only ./lib/thing.js on disk
        },
    }),
    '/app/node_modules/exact-only-pkg/lib/thing.js': "export const impl = 'exact-only';",

    /* --------------------- legacy-pkg: browser/module/main all present */
    '/app/node_modules/legacy-pkg/package.json': JSON.stringify({
        name: 'legacy-pkg',
        main: './main.js',
        module: './module.js',
        browser: './browser.js', // browser wins for browser platform
    }),
    '/app/node_modules/legacy-pkg/browser.js': "export const impl = 'legacy-browser';",
    '/app/node_modules/legacy-pkg/module.js': "export const impl = 'legacy-module';",
    '/app/node_modules/legacy-pkg/main.js': "export const impl = 'legacy-main';",

    /* ------------------------------ legacy-main-only: only main present */
    '/app/node_modules/legacy-main-only/package.json': JSON.stringify({
        name: 'legacy-main-only',
        main: './entry.js',
    }),
    '/app/node_modules/legacy-main-only/entry.js': "export const impl = 'main-only';",

    /* --------------- browser-object-pkg: string remap + false stub */
    // entry imports its own './node-impl.js' (remapped to './browser-impl.js')
    // and './disabled.js' (mapped to false -> empty module).
    '/app/node_modules/browser-object-pkg/package.json': JSON.stringify({
        name: 'browser-object-pkg',
        main: './entry.js',
        browser: {
            './node-impl.js': './browser-impl.js',
            './disabled.js': false,
        },
    }),
    '/app/node_modules/browser-object-pkg/entry.js':
        "import { platform } from './node-impl.js';\n" +
        "import * as stub from './disabled.js';\n" +
        'export const impl = platform;\n' +
        'export const stubKeys = Object.keys(stub).length;',
    '/app/node_modules/browser-object-pkg/node-impl.js': "export const platform = 'node-impl';",
    '/app/node_modules/browser-object-pkg/browser-impl.js': "export const platform = 'browser-impl';",
    '/app/node_modules/browser-object-pkg/disabled.js': "export const boom = (() => { throw new Error('should not run'); })();",

    /* ---------------------------- @scope/pkg with a subpath export */
    '/app/node_modules/@scope/pkg/package.json': JSON.stringify({
        name: '@scope/pkg',
        exports: {
            '.': './index.js',
            './feature': './feature.js',
        },
    }),
    '/app/node_modules/@scope/pkg/index.js': "export const impl = 'scoped-index';",
    '/app/node_modules/@scope/pkg/feature.js': "export const impl = 'scoped-feature';",

    /* ------------------ self-ref-pkg: imports itself by name via exports */
    '/app/node_modules/self-ref-pkg/package.json': JSON.stringify({
        name: 'self-ref-pkg',
        exports: {
            '.': './index.js',
            './helper': './helper.js',
        },
    }),
    '/app/node_modules/self-ref-pkg/index.js': "import { help } from 'self-ref-pkg/helper';\nexport const impl = help;",
    '/app/node_modules/self-ref-pkg/helper.js': "export const help = 'self-ref-helper';",

    /* --------------- no-conditions-pkg: condition sets never match */
    '/app/node_modules/no-conditions-pkg/package.json': JSON.stringify({
        name: 'no-conditions-pkg',
        exports: {
            '.': {
                require: './cjs.js',
                node: './node.js',
            },
        },
    }),
    '/app/node_modules/no-conditions-pkg/cjs.js': "export const impl = 'nope';",
    '/app/node_modules/no-conditions-pkg/node.js': "export const impl = 'nope';",

    /* ---------- nested shadowing: dup at /app and at /app/packages/deep */
    '/app/node_modules/dup/package.json': JSON.stringify({ name: 'dup', exports: { '.': './index.js' } }),
    '/app/node_modules/dup/index.js': "export const impl = 'dup-shallow';",
    '/app/packages/deep/package.json': JSON.stringify({ name: 'deep', private: true }),
    '/app/packages/deep/node_modules/dup/package.json': JSON.stringify({
        name: 'dup',
        exports: { '.': './index.js' },
    }),
    '/app/packages/deep/node_modules/dup/index.js': "export const impl = 'dup-deep';",
    '/app/packages/deep/consumer.js': "import { impl } from 'dup';\nexport const v = impl;",
};

/** Build a memory-Fs-compatible record from the fixture tree. */
export function loadResolveFixtures(): Record<string, string> {
    return { ...resolveFixtures };
}
