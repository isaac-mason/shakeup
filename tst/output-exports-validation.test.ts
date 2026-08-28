import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

// `output.exports` must be CONSISTENT with what the entry actually exports — rollup's `getExportMode`
// (`utils/getExportMode.ts:13-20`). We accepted any value silently and then suppressed the export
// line for `'none'`, so a misconfigured build emitted a chunk missing its exports instead of saying
// so. Three of rollup's samples cover it: `invalid-default-export-mode`, `export-type-mismatch`,
// `export-type-mismatch-c`.
describe('output.exports is validated against the entry surface', () => {
    const build = async (src: string, exportsMode: string) =>
        bundle({ entry: '/main.js', fs: createMemoryFs({ '/main.js': src }), output: { exports: exportsMode } as never });

    it("rejects 'default' when the entry also has named exports", async () => {
        const r = await build('export default 1;\nexport const foo = 2;', 'default');
        expect(r.errors[0]).toContain('"default" was specified for "output.exports"');
        // rollup's `printQuotedStringList`: more than one item joins with `and`.
        expect(r.errors[0]).toContain('has the following exports: "default" and "foo"');
    });

    it("rejects 'default' when the entry has only a named export", async () => {
        const r = await build('export const foo = 1;', 'default');
        // A single item is printed bare, with no `and`.
        expect(r.errors[0]).toContain('has the following exports: "foo"');
        expect(r.errors[0]).not.toContain(' and ');
    });

    it("rejects 'none' when the entry exports anything", async () => {
        const r = await build('export default 1;', 'none');
        expect(r.errors[0]).toContain('"none" was specified for "output.exports"');
        expect(r.errors[0]).toContain('has the following exports: "default"');
    });

    it("accepts 'default' when the entry exports only a default", async () => {
        const r = await build('export default 1;', 'default');
        expect(r.errors).toEqual([]);
    });

    it("accepts 'none' when the entry exports nothing", async () => {
        const r = await build('globalThis.side = 1;', 'none');
        expect(r.errors).toEqual([]);
    });

    it("leaves 'auto' and 'named' alone", async () => {
        for (const mode of ['auto', 'named']) {
            const r = await build('export default 1;\nexport const foo = 2;', mode);
            expect(r.errors, mode).toEqual([]);
        }
    });
});

describe('manualChunks rejects a module claimed by two chunks', () => {
    // A module belongs to ONE manual chunk. rollup errors (`logInvalidChunk`) rather than picking a
    // winner — and our group machinery WOULD have picked one, by priority, because that is the
    // `advancedChunks` model rather than this one. A silent arbitrary winner is the bad outcome.
    it('throws naming both chunks', async () => {
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({ '/main.js': "import './dep.js';\nexport const a = 1;", '/dep.js': 'export const d = 1;' }),
            output: { manualChunks: { dep1: ['/dep.js'], dep2: ['/dep.js'] } } as never,
        });
        expect(r.errors[0]).toContain('to the "dep2" chunk as it is already in the "dep1" chunk');
    });

    it('allows the same module listed twice under ONE chunk name', async () => {
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({ '/main.js': "import './dep.js';\nexport const a = 1;", '/dep.js': 'export const d = 1;' }),
            output: { manualChunks: { dep1: ['/dep.js', '/dep.js'] } } as never,
        });
        expect(r.errors).toEqual([]);
    });

    it('leaves distinct assignments alone', async () => {
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({
                '/main.js': "import './a.js';\nimport './b.js';\nexport const x = 1;",
                '/a.js': 'export const a = 1;',
                '/b.js': 'export const b = 2;',
            }),
            output: { manualChunks: { ca: ['/a.js'], cb: ['/b.js'] } } as never,
        });
        expect(r.errors).toEqual([]);
    });
});

describe('option VALUES are validated even for options we do not act on', () => {
    // Worth doing precisely BECAUSE `interop`/`generatedCode` are unimplemented: silently ignoring an
    // option a user set is a worse failure than rejecting a bad value for it — the build looks
    // configured and is not. These reject invalid VALUES only; everything rollup accepts is still
    // accepted (and then ignored), so nothing that works today breaks.
    const build = async (output: Record<string, unknown>) =>
        bundle({ entry: '/main.js', fs: createMemoryFs({ '/main.js': 'export const a = 1;' }), output: output as never });

    it.each([
        ['generatedCode string', { generatedCode: 'some-string' }, 'for option "output.generatedCode"'],
        ['generatedCode preset', { generatedCode: { preset: 'some-string' } }, 'for option "output.generatedCode.preset"'],
        ['interop', { interop: 'true' }, 'for option "output.interop"'],
    ])('rejects an invalid %s', async (_name, output, fragment) => {
        const r = await build(output);
        expect(r.errors[0]).toContain(fragment);
        expect(r.errors[0]).toContain('Invalid value');
    });

    it.each([
        ['generatedCode es5', { generatedCode: 'es5' }],
        ['generatedCode es2015', { generatedCode: 'es2015' }],
        ['generatedCode object preset', { generatedCode: { preset: 'es2015' } }],
        ['generatedCode object without preset', { generatedCode: { symbols: true } }],
        ['interop auto', { interop: 'auto' }],
        ['interop defaultOnly', { interop: 'defaultOnly' }],
    ])('still accepts a valid %s', async (_name, output) => {
        const r = await build(output);
        expect(r.errors).toEqual([]);
    });

    it('reports through errors rather than throwing', async () => {
        // A config mistake is not an exception — callers read `result.errors`.
        await expect(build({ interop: 'nonsense' })).resolves.toBeDefined();
    });
});

describe('sourcemapIgnoreList must answer with a boolean', () => {
    // A user function that returns nothing let `undefined` fall through as a silent "not ignored" —
    // the misconfiguration that looks like it worked. rollup validates the return instead.
    const build = async (fn: unknown) =>
        bundle({
            entry: '/main.js',
            fs: createMemoryFs({ '/main.js': 'export const a = 1;' }),
            output: { sourcemap: true, sourcemapIgnoreList: fn } as never,
        });

    it('rejects a function returning undefined', async () => {
        const r = await build(() => undefined);
        expect(r.errors[0]).toContain('sourcemapIgnoreList function must return a boolean.');
    });

    it('rejects a function returning a truthy non-boolean', async () => {
        const r = await build(() => 'yes');
        expect(r.errors[0]).toContain('sourcemapIgnoreList function must return a boolean.');
    });

    it.each([
        ['returning true', () => true],
        ['returning false', () => false],
    ])('accepts a function %s', async (_name, fn) => {
        const r = await build(fn);
        expect(r.errors).toEqual([]);
    });

    it('leaves the non-function forms alone', async () => {
        for (const v of [true, false, 'node_modules', /node_modules/]) {
            const r = await build(v);
            expect(r.errors, String(v)).toEqual([]);
        }
    });
});

describe('manualChunks and inlineDynamicImports are mutually exclusive', () => {
    // `inlineDynamicImports` collapses everything into ONE chunk, so there is nothing for
    // `manualChunks` to assign. We silently dropped one of them; rollup rejects the combination.
    const FILES = { '/main.js': "import('./lib.js');\nexport const a = 1;", '/lib.js': 'export const l = 1;' };

    it('rejects both together', async () => {
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs(FILES),
            output: { inlineDynamicImports: true, manualChunks: { lib: ['/lib.js'] } } as never,
        });
        expect(r.errors[0]).toContain('Invalid value for option "output.manualChunks"');
        expect(r.errors[0]).toContain('not supported for "output.inlineDynamicImports"');
    });

    it.each([
        ['inlineDynamicImports alone', { inlineDynamicImports: true }],
        ['manualChunks alone', { manualChunks: { lib: ['/lib.js'] } }],
    ])('accepts %s', async (_name, output) => {
        const r = await bundle({ entry: '/main.js', fs: createMemoryFs(FILES), output: output as never });
        expect(r.errors).toEqual([]);
    });
});
