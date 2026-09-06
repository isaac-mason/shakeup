import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';
import { runModule } from './exec-helpers.ts';

// `options.context` — "the value of `this` at the top level of each module", rolldown's
// `context?: string` and Rollup's option of the same name. It is the ESM sibling of a case shakeup
// already had: a CommonJS module's top-level `this` means `module.exports`, and the emitter has
// mapped those to `exports` all along (`generate/modules.ts`).
//
// UNSET is deliberately not "replace with `undefined`". rolldown rewrites an unset ESM top-level
// `this` to `void 0`; shakeup leaves the `this` in place, and the two agree because shakeup only
// emits ESM chunks — whose top-level `this` IS `undefined`, and whose lazy wrapper is an arrow that
// inherits rather than rebinds. The tests below pin that equivalence by RUNNING the output, not by
// comparing text.
const build = async (files: Record<string, string>, context?: string) => {
    const r = await bundle({ entry: '/main.js', external: [], fs: createMemoryFs(files), output: {}, context });
    expect(r.errors).toEqual([]);
    return r.chunks[0].code;
};

describe('options.context', () => {
    it('leaves top-level `this` alone by default, and it evaluates to undefined', async () => {
        const code = await build({ '/main.js': 'export const got = typeof this;\n' });
        expect(code).toContain('this');
        expect((await runModule(code)).got).toBe('undefined');
    });

    it('replaces it with the configured value', async () => {
        const code = await build({ '/main.js': 'export const got = typeof this;\n' }, 'globalThis');
        expect(code).not.toContain('typeof this');
        expect((await runModule(code)).got).toBe('object');
    });

    it('reaches an ARROW at the top level, which inherits the module`s `this`', async () => {
        // rolldown's `is_this_nested` is `Function && !Arrow`, so an arrow does NOT get its own
        // `this` and its body is still the module's top level. The parser's `topLevelThis` agrees
        // (arrows do not bump `thisDepth`), which is why this works without a special case.
        const code = await build({ '/main.js': 'export const got = () => typeof this;\n' }, 'globalThis');
        expect(code).not.toContain('typeof this');
        expect((await runModule(code)).got as () => string).toBeTypeOf('function');
        expect(((await runModule(code)).got as () => string)()).toBe('object');
    });

    it('does NOT reach a `this` inside an ordinary function, which has its own', async () => {
        // The falsification arm. A blanket text replacement would rewrite this one too and change
        // what the program means — `f.call(obj)` must still see `obj`.
        const code = await build(
            {
                '/main.js':
                    'function f() { return this === undefined ? "undefined" : this.tag; }\nexport const got = f.call({ tag: "OWN" });\n',
            },
            'globalThis',
        );
        expect(code, 'the nested `this` survives verbatim').toContain('this.tag');
        expect((await runModule(code)).got).toBe('OWN');
    });

    it('leaves a CommonJS module`s top-level `this` meaning module.exports', async () => {
        // A CJS module's top-level `this` is an EXPORT mechanism, not a global reference, and
        // `context` must not touch it — the existing `exports` mapping wins.
        const code = await build(
            {
                '/dep.cjs': "this.alpha = 'ALPHA';\n",
                '/main.js': "import dep from './dep.cjs';\nexport const got = dep.alpha;\n",
            },
            'globalThis',
        );
        expect(code).toContain('exports.alpha');
        expect(code).not.toContain('globalThis.alpha');
        expect((await runModule(code)).got).toBe('ALPHA');
    });
});
