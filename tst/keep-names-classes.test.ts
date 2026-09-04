import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';

// Deconfliction renames a class binding when two modules declare the same name, and `class foo {}`
// emitted as `class foo$1 {}` then answers `foo$1` from `.name`. Rollup fixes this UNCONDITIONALLY by
// moving the original name onto the class itself — verified on rollup 4.63, which emits
// `let foo$3 = class foo {}` and converts renamed class DECLARATIONS to that form too. rolldown makes
// it opt-in as `keepNames` (off by default) and injects a `__name` helper instead.
//
// shakeup takes rolldown's option and default with Rollup's zero-runtime mechanism.
const build = async (files: Record<string, string>, keepNames?: boolean) => {
    const r = await bundle({
        entry: '/main.js',
        fs: createMemoryFs(files),
        external: [],
        // OMITTED when undefined — the default has to be exercised as an absent option, not as an
        // explicit `false`, or a normalizer defaulting the wrong way would go unnoticed.
        output: keepNames === undefined ? {} : { keepNames },
    } as never);
    expect(r.errors).toEqual([]);
    return r.chunks.map((c) => c.code).join('\n');
};
const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const TWO_DECLS = {
    '/main.js': "import { a } from './a.js';\nimport { b } from './b.js';\nexport const names = [a, b];\n",
    '/a.js': 'class foo {}\nexport const a = foo.name;\n',
    '/b.js': 'class foo {}\nexport const b = foo.name;\n',
};

describe('keepNames, for classes', () => {
    it('is OFF by default — a renamed class reports its renamed name', async () => {
        const mod = await run(await build(TWO_DECLS));
        expect(mod.names, 'the default matches rolldown and esbuild, not Rollup').toEqual(['foo', 'foo$1']);
    });

    it('preserves the name of a renamed class DECLARATION', async () => {
        const code = await build(TWO_DECLS, true);
        expect(code).toContain('class foo');
        expect((await run(code)).names).toEqual(['foo', 'foo']);
    });

    it('preserves the name of an anonymous class EXPRESSION in a renamed binding', async () => {
        const code = await build(
            {
                '/main.js': "import { a } from './a.js';\nimport { b } from './b.js';\nexport const names = [a, b];\n",
                '/a.js': 'let foo = class {};\nexport const a = foo.name;\n',
                '/b.js': 'let foo = class {};\nexport const b = foo.name;\n',
            },
            true,
        );
        expect((await run(code)).names).toEqual(['foo', 'foo']);
    });

    it('a STATIC INITIALISER reads the class through its original name — the outer `let` is in TDZ', async () => {
        // `let C$1 = class C { static x = C$1; }` throws "Cannot access 'C$1' before initialization":
        // a static initialiser runs while the class is being defined. Only the class's own binding is
        // in scope. This is why Rollup's `useOriginalName` exists and why shakeup mirrors it.
        const code = await build(
            {
                '/main.js': "import { a } from './a.js';\nimport { b } from './b.js';\nexport const v = [a, b];\n",
                '/a.js': 'class C { static self = C; }\nexport const a = C.self.name;\n',
                '/b.js': 'class C { static self = C; }\nexport const b = C.self.name;\n',
            },
            true,
        );
        expect((await run(code)).v).toEqual(['C', 'C']);
    });

    it('does NOT preserve a name that would capture something the class reaches', async () => {
        // Naming the class introduces a binding inside its scope. Here the inner class extends the
        // OUTER `bar`, so calling it `bar` would make it inherit from itself. Correctness wins over
        // the name: rollupsuite's `class-name-conflict-2`.
        const code = await build(
            {
                // Two modules both declare `bar`, so one is renamed — and THAT one is a class whose
                // heritage clause reaches the other. Preserving its name would rewrite
                // `class bar$1 extends bar` into `class bar extends bar`.
                '/main.js': "import { r } from './x.js';\nimport { s } from './y.js';\nexport const v = [r, s];\n",
                '/x.js': 'export class bar { static base = 1; }\nexport const r = bar.base;\n',
                '/y.js': [
                    "import { bar as outer } from './x.js';",
                    'class bar extends outer { static base2 = 2; }',
                    'export const s = [bar.base, bar.base2];',
                ].join('\n'),
            },
            true,
        );
        expect(code, 'never emits a class that extends itself').not.toContain('class bar extends bar');
        expect((await run(code)).v).toEqual([1, [1, 2]]);
    });
});
