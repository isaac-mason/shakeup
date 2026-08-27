import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import type { Fs } from '../src/fs.ts';
import type { Plugin } from '../src/plugin.ts';

// `package.json#sideEffects`, read through the resolver (rolldown returns the owning manifest from
// `resolve`; shakeup now does too). Laid out as pnpm does it — `node_modules/pkg` is a SYMLINK into
// the store — because that is the case the whole feature exists for and the one that broke first.
const STORE = '/app/node_modules/.pnpm/pkg@1/node_modules';
const LINK = '/app/node_modules/pkg';
const REAL = `${STORE}/pkg`;

const fsFor = (sideEffects: unknown, extra: Record<string, string> = {}): Fs => {
    const files: Record<string, string> = {
        '/app/src/index.js': "import { Widget } from 'pkg';\nexport const v = Widget();",
        [`${REAL}/package.json`]: JSON.stringify({ name: 'pkg', main: 'index.js', ...(sideEffects === undefined ? {} : { sideEffects }) }),
        [`${REAL}/index.js`]: "import './register.js';\nimport './styles.css.js';\nexport const Widget = () => 1;",
        [`${REAL}/register.js`]: 'globalThis.__REGISTER__ = 1;',
        [`${REAL}/styles.css.js`]: 'globalThis.__STYLES__ = 1;',
        ...extra,
    };
    const map = (id: string) => (id.startsWith(LINK) ? REAL + id.slice(LINK.length) : id);
    return { read: (id) => files[map(id)] ?? null, exists: (id) => map(id) in files, realpath: (id) => map(id) };
};

const build = async (sideEffects: unknown, plugins: Plugin[] = []) => {
    const r = await bundle({ entry: '/app/src/index.js', fs: fsFor(sideEffects), plugins });
    expect(r.errors).toEqual([]);
    return r.code;
};

describe('package.json sideEffects', () => {
    it('absent: keeps side-effectful modules (per-statement analysis)', async () => {
        const code = await build(undefined);
        expect(code).toContain('__REGISTER__');
        expect(code).toContain('__STYLES__');
    });

    it('false: drops modules nothing is imported from', async () => {
        const code = await build(false);
        expect(code).not.toContain('__REGISTER__');
        expect(code).not.toContain('__STYLES__');
    });

    it('true: keeps them', async () => {
        const code = await build(true);
        expect(code).toContain('__REGISTER__');
    });

    it('glob array: only the matching file keeps its side effects', async () => {
        // Globs are relative to the PACKAGE DIRECTORY, which under pnpm is the realpath'd store
        // path, not the symlink — getting that base wrong matches nothing at all.
        const code = await build(['*.css.js']);
        expect(code).not.toContain('__REGISTER__');
        expect(code).toContain('__STYLES__');
    });

    it('a plugin outranks the manifest', async () => {
        // rolldown precedence (`normalize_side_effects`): hook, then option, then package.json.
        const keepAll: Plugin = { name: 'keep', resolveId: (_c, spec, imp) => (spec === './register.js' && imp ? { id: `${REAL}/register.js`, moduleSideEffects: true } : null) };
        const code = await build(false, [keepAll]);
        expect(code).toContain('__REGISTER__');
    });
});

// A side-effect-free module still has to keep the statements that AUGMENT a live binding. These are
// the shapes that fooled a statement-shape matcher, in the order they were discovered — `compress`
// runs BEFORE treeshake, so by then the writes have been folded far from the top level.
describe('bindings keep their augmentations under sideEffects: false', () => {
    const sef: Plugin = { name: 'sef', resolveId: (_c, spec, imp) => (spec === './lib.js' && imp ? { id: '/lib.js', moduleSideEffects: false } : null) };
    const run = async (lib: string, compress: boolean) => {
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({ '/lib.js': lib, '/main.js': "import { A } from './lib.js';\nexport const v = A.UP;" }),
            plugins: [sef],
            output: { minify: { whitespace: false, mangle: false, compress } },
        });
        expect(r.errors).toEqual([]);
        return (await import(`data:text/javascript,${encodeURIComponent(r.code)}`)) as Record<string, unknown>;
    };

    const CASES: [string, string][] = [
        ['a lone assignment', 'export class A {}\nA.UP = 1;'],
        // joinVars merges adjacent statements into one SequenceExpression.
        ['adjacent assignments (merged into a sequence)', 'export class A {}\nA.UP = 1;\nA.DOWN = 2;\nA.LEFT = 3;'],
        // …and FUSES a run into a following control statement, which `minimizeConditions` may then
        // rewrite into `test && (…)`, burying the writes in a logical operand.
        ['assignments followed by an if (fused into its test)', 'export class A {}\nA.UP = 1;\nA.DOWN = 2;\nif (typeof window !== "undefined") { globalThis.x = 1; }'],
        ['prototype augmentation', 'export class A {}\nA.prototype.tag = "a";\nA.UP = 1;'],
    ];

    it.each(CASES)('%s — compress full', async (_label, lib) => {
        expect((await run(lib, true)).v).toBe(1);
    });

    it.each(CASES)('%s — compress dce', async (_label, lib) => {
        expect((await run(lib, false)).v).toBe(1);
    });
});
