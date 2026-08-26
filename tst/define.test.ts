import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

const build = async (main: string, define?: Record<string, string>, minify = false) => {
    const result = await bundle({
        entry: '/main.js',
        fs: createMemoryFs({ '/main.js': main }),
        external: [],
        define,
        output: minify ? { minify: true } : {},
    });
    expect(result.errors).toEqual([]);
    return result.chunks[0].code;
};

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const PROD = { 'process.env.NODE_ENV': '"production"', __DEV__: 'false' };

// Compile-time global replacement (esbuild/Vite `define`), ported from oxc's
// `replace_global_defines.rs`. Substitution is only half of it: the point is that the substituted
// literal then folds and the dead branch is deleted — which is what makes real dependencies both
// smaller AND runnable on a browser target, where `process` does not exist at all.
describe('define', () => {
    it('replaces a dotted global and lets the dead branch be eliminated', async () => {
        const code = await build("if (process.env.NODE_ENV !== 'production') { console.log('DEV_MARKER') }\nexport const x = 1;", PROD);
        expect(code).not.toContain('DEV_MARKER');
        expect(code).not.toContain('process');
        expect(await run(code)).toMatchObject({ x: 1 });
    });

    it('replaces a bare identifier', async () => {
        expect(await run(await build('export const y = __DEV__ ? 1 : 2;', PROD))).toMatchObject({ y: 2 });
    });

    it('leaves a SHADOWED binding of the same name alone', async () => {
        // Only free references are replaced — oxc's `is_global_or_ambient_reference`, which here is
        // just `sym === 0`. Substituting a local would change what the program means.
        const code = await build('export function f(process){ return process.env.NODE_ENV }\n', PROD);
        expect(code).toContain('process');
        const f = (await run(code)).f as (p: unknown) => unknown;
        expect(f({ env: { NODE_ENV: 'local' } })).toBe('local');
    });

    it('never replaces an assignment target', async () => {
        // `process.env.NODE_ENV = x` must not become `"production" = x`, which would not parse.
        const code = await build('globalThis.process = { env: {} };\nprocess.env.NODE_ENV = "x";\nexport const z = 1;', PROD);
        expect(code).toContain('process.env.NODE_ENV =');
        expect(await run(code)).toMatchObject({ z: 1 });
    });

    it('does nothing when no define is configured', async () => {
        expect(await build('export const w = process.env.NODE_ENV;')).toContain('process.env.NODE_ENV');
    });

    it('treats the value as JS SOURCE, not as a string', async () => {
        // `'"production"'` yields a string; `'false'` yields a boolean; `'1+1'` yields an expression.
        expect(await run(await build('export const a = FLAG;', { FLAG: '{ nested: [1, 2] }' }))).toMatchObject({ a: { nested: [1, 2] } });
        expect(await run(await build('export const a = FLAG;', { FLAG: '1 + 1' }))).toMatchObject({ a: 2 });
    });

    it('substitutes every occurrence with independent nodes', async () => {
        const code = await build('export const a = [__DEV__, __DEV__, __DEV__];', PROD);
        expect(await run(code)).toMatchObject({ a: [false, false, false] });
    });
});

// `strValue` required a literal's raw source to begin with `"`, so single-quoted strings never
// folded: `"x" === "x"` became `!0` while `'x' === 'x'` survived to the output. Single quotes are
// ubiquitous, so this silently disabled string folding across most real code — and it defeated
// `define` outright, since a substituted value and the source it is compared against rarely share a
// quote style.
describe('constant folding of single-quoted strings', () => {
    const folds = async (expr: string) => {
        const code = await build(`export const a = ${expr};`, undefined, true);
        return { code, value: (await run(code)).a };
    };

    it('folds regardless of quote style, in either position', async () => {
        for (const expr of [`"x" === "x"`, `'x' === 'x'`, `"x" === 'x'`, `'x' === "x"`]) {
            const { code, value } = await folds(expr);
            expect(value).toBe(true);
            expect(code).not.toContain('==='); // actually folded, not merely correct
        }
    });

    it('folds inequality and ordering', async () => {
        expect((await folds(`'a' !== 'b'`)).value).toBe(true);
        expect((await folds(`'a' < 'b'`)).value).toBe(true);
    });

    it('handles escapes that differ between the two quote styles', async () => {
        expect((await folds(`'a"b' === 'a"b'`)).value).toBe(true); // bare " inside single quotes
        expect((await folds(`'it\\'s' === "it's"`)).value).toBe(true); // \' vs plain '
        expect((await folds(`'a\\\\b' === "a\\\\b"`)).value).toBe(true); // escaped backslash
        expect((await folds(`'\\n' === "\\n"`)).value).toBe(true);
    });

    it('BAILS rather than mis-folding a JS-only escape', async () => {
        // `\x41` is not valid JSON, so `JSON.parse` rejects it and no fold happens. The cost is a
        // missed optimization; the alternative — guessing — would be a wrong answer.
        const { code, value } = await folds(`'\\x41' === 'A'`);
        expect(value).toBe(true); // still correct at runtime
        expect(code).toContain('==='); // …but deliberately not folded
    });
});
