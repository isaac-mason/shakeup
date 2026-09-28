import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';

// rolldown's default `optimization.inlineConst` (smart mode). Every expectation was read off rolldown
// 1.2.4 on the same fixture with `minify: false`, which leaves inlineConst as the only thing changing
// the code: with its default `dce-only` minify, oxc's own single-use substitution fuses a declaration
// into the next statement too, which is a different transform.
const build = async (files: Record<string, string>, input: string | string[] = '/main.js') => {
    const fs = { read: (id: string) => files[id] ?? null, exists: (id: string) => id in files };
    const r = await bundle({ input, fs, external: [], output: { minify: false } });
    expect(r.errors).toEqual([]);
    return r.chunks;
};
const code = async (files: Record<string, string>) => (await build(files)).map((c) => c.code).join('\n');

describe('exported constants are inlined at their reads', () => {
    const constants =
        'export const E = 5;\nexport const BIG = 12345;\nexport const S = "hello world";\nexport const NEG = -1;\nexport const HALF = 0.5;\n';

    it('inlines a small constant everywhere and a large one only where it is tested', async () => {
        const out = await code({
            '/c.js': constants,
            '/main.js':
                "import { E, BIG, S, NEG, HALF } from './c.js';\n" +
                "if (BIG) console.log('big');\n" +
                'console.log(E, BIG, S, NEG, HALF, x ** NEG, BIG && S, { E }, typeof E, E.toString());\n',
        });
        expect(out).toContain('if (12345) console.log("big");');
        expect(out).toContain('console.log(5, BIG, S, -1, HALF, x ** -1, 12345 && "hello world", { E: 5 }, typeof 5, 5 .toString());');
        // an imported read of a small constant keeps no declaration; a large one is still read by name
        expect(out).not.toMatch(/const E = /);
        expect(out).not.toMatch(/const NEG = /);
        expect(out).toContain('const BIG = 12345;');
        expect(out).toContain('const HALF = .5;');
    });

    it('does not inline a binding that is not exported', async () => {
        const out = await code({ '/main.js': 'const L = 7;\nexport const A = 1;\nconsole.log(L, A);\n' });
        expect(out).toContain('console.log(L, 1);');
        expect(out, 'an entry export keeps its declaration').toContain('const A = 1;');
    });

    it('does not inline a binding that is reassigned', async () => {
        const out = await code({
            '/c.js': 'export let C = 1;\nexport function bump() { C = 2; }\n',
            '/main.js': "import { C, bump } from './c.js';\nbump();\nconsole.log(C);\n",
        });
        expect(out).toContain('console.log(C);');
    });

    it('inlines a constant default export', async () => {
        const out = await code({ '/c.js': 'export default 7;\n', '/main.js': "import d from './c.js';\nconsole.log(d);\n" });
        expect(out).toContain('console.log(7);');
    });

    it('evaluates an initialiser against the constants declared before it, exported or not', async () => {
        const out = await code({
            '/c.js': 'const A = 2;\nexport const B = A * 3;\nexport const T = `x${B}`;\n',
            '/main.js': "import { B, T } from './c.js';\nconsole.log(B, T);\n",
        });
        // a template literal is not a value oxc evaluates, so `T` stays a read
        expect(out).toContain('console.log(6, T);');
        expect(out).toContain('const T = `x${6}`;');
        // read in its own module, so its declaration stays
        expect(out).toContain('const B = 6;');
    });

    it('inlines a large constant in a conditional test and leaves the other read', async () => {
        const out = await code({
            '/c.js': 'export const DEBUG = "production";\n',
            '/main.js': "import { DEBUG } from './c.js';\nconsole.log(DEBUG === 'production' ? 1 : 2, DEBUG);\n",
        });
        expect(out).toContain('console.log("production" === "production" ? 1 : 2, DEBUG);');
        expect(out).toContain('const DEBUG = "production";');
    });

    it('follows a re-export to the constant', async () => {
        const out = await code({
            '/c.js': 'export const E = 5;\n',
            '/i.js': "export { E } from './c.js';\n",
            '/main.js': "import { E } from './i.js';\nconsole.log(E);\n",
        });
        expect(out.trim()).toBe('console.log(5);');
    });

    it('drops a module whose only read is a small constant through its namespace', async () => {
        const out = await code({
            '/c.js': 'export const E = 5;\nexport const F = 6;\n',
            '/main.js': "import * as ns from './c.js';\nconsole.log(ns.E);\n",
        });
        expect(out.trim()).toBe('console.log(5);');
    });

    it('forms no shared chunk when every read of it prints a constant', async () => {
        const chunks = await build(
            {
                '/shared.js': 'export const s = 3;\nexport const t = 4;\n',
                '/a.js': "import * as m from './shared.js';\nexport const av = m.s + m.t;\n",
                '/b.js': "import * as m from './shared.js';\nexport const bv = m.s * m.t;\n",
            },
            ['/a.js', '/b.js'],
        );
        expect(chunks.map((c) => c.fileName).sort()).toEqual(['a.js', 'b.js']);
        expect(chunks.find((c) => c.fileName === 'a.js')?.code).toContain('const av = 3 + 4;');
    });

    it('inlines a namespace member read, keeping the declaration', async () => {
        const out = await code({
            '/c.js': 'export const E = 5;\nexport const BIG = 12345;\n',
            '/main.js': "import * as ns from './c.js';\nconsole.log(ns.E, ns.BIG);\n",
        });
        expect(out).toContain('console.log(5, BIG);');
        expect(out).toContain('const E = 5;');
    });

    it('does not import an inlined constant across a chunk boundary', async () => {
        const chunks = await build(
            {
                '/c.js': 'export const E = 5;\nexport const BIG = 12345;\n',
                '/a.js': "import { E } from './c.js';\nconsole.log(E);\n",
                '/b.js': "import * as ns from './c.js';\nimport { BIG } from './c.js';\nconsole.log(ns.E, BIG);\n",
            },
            ['/a.js', '/b.js'],
        );
        const byName = Object.fromEntries(chunks.map((c) => [c.fileName, c.code]));
        expect(byName['a.js'].trim()).toBe('console.log(5);');
        expect(byName['b.js']).toMatch(/^import \{ (\w+ as )?BIG \} from ['"]\.\/c-[\w-]+\.js['"];\s*console\.log\(5, BIG\);\s*$/);
    });
});
