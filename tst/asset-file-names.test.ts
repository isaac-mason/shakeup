import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';
import type { Plugin } from '../src/bundler/plugin.ts';

// `output.assetFileNames` was IGNORED. `resolveEmittedFileName` hard-coded
// `assets/<stem>-<hash><ext>`, which is the DEFAULT pattern — so every build looked right and the
// option did nothing. Found by crossing a `new URL()` asset with code splitting and a pattern.
//
// The four placeholders are the ones rollup defines for an asset (`FileEmitter.ts:83-88`) and
// rolldown accepts — probed, all four render: `[name]`, `[hash]`, `[hash:N]`, `[ext]`, `[extname]`.
// There is no `[dirname]`; that one is chunks-only.
//
// The option is an OUTPUT option that has to reach SCAN, because an asset's fileName is embedded in
// module CODE at transform time — a `new URL()` site is rewritten to it — long before the generate
// stage names chunks. That is why it lives on `GraphOptions` and on the `Graph`.
const emitter: Plugin = {
    name: 'emit',
    buildStart: function () {
        this.emitFile({ type: 'asset', name: 'logo.txt', source: 'L' });
        this.emitFile({ type: 'asset', fileName: 'exact/thing.txt', source: 'E' });
    },
};

const build = async (assetFileNames: string | undefined, extra: Record<string, string> = {}, plugins: Plugin[] = [emitter]) => {
    const r = await bundle({
        entry: '/main.js',
        external: [],
        fs: createMemoryFs({ '/main.js': 'export const x = 1;\n', ...extra }),
        output: assetFileNames === undefined ? {} : { assetFileNames },
        plugins,
    });
    expect(r.errors).toEqual([]);
    return r;
};
const names = (r: { assets?: { fileName: string }[] }) => (r.assets ?? []).map((a) => a.fileName).sort();

describe('output.assetFileNames', () => {
    it.each([
        [undefined, 'assets/logo-<hash>.txt'],
        ['static/[name]-[hash][extname]', 'static/logo-<hash>.txt'],
        ['[name][extname]', 'logo.txt'],
        ['a/[name].[ext]', 'a/logo.txt'],
        ['h/[hash:8][extname]', 'h/<hash>.txt'],
    ])('renders %s', async (pattern, want) => {
        const got = names(await build(pattern)).filter((n) => !n.startsWith('exact/'));
        expect(got.map((n) => n.replace(/[0-9a-f]{8}/, '<hash>'))).toEqual([want]);
    });

    it('never patterns an explicit fileName — that is a demand for a path', async () => {
        // Both oracles leave it exactly as given under every pattern (probed).
        for (const p of [undefined, 'static/[name]-[hash][extname]', 'a/[name].[ext]']) {
            expect(names(await build(p))).toContain('exact/thing.txt');
        }
    });

    it('rejects a placeholder it does not define, by name', async () => {
        // `renderNamePattern` validates, so a typo is an error rather than a literal `[dirname]` in
        // the output path. `[dirname]` is a CHUNK placeholder and genuinely not available here.
        const r = await bundle({
            entry: '/main.js',
            external: [],
            fs: createMemoryFs({ '/main.js': 'export const x = 1;\n' }),
            output: { assetFileNames: '[dirname]/[name][extname]' },
            plugins: [emitter],
        });
        expect(r.errors.join(' ')).toContain('"[dirname]" is not a valid placeholder');
    });

    it('applies to a `new URL()` asset, and the rewritten URL agrees with the emitted path', async () => {
        // The crossing that found this. The site in the code and the asset in the output have to be
        // the same string, or the bundle 404s at runtime.
        const r = await build('img/[name].[ext]', { '/logo.txt': 'LOGO' }, [{ name: 'none', buildStart: () => {} }]);
        expect(names(r)).toEqual([]);
        const r2 = await bundle({
            entry: '/main.js',
            external: [],
            fs: createMemoryFs({ '/main.js': 'export const u = new URL("./logo.txt", import.meta.url);\n', '/logo.txt': 'LOGO' }),
            output: { assetFileNames: 'img/[name].[ext]' },
        });
        expect(r2.errors).toEqual([]);
        expect(names(r2)).toEqual(['img/logo.txt']);
        expect(r2.chunks[0].code, 'the rewritten specifier matches the emitted asset').toContain('"img/logo.txt"');
    });
});
