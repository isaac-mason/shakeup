import { decode } from '@jridgewell/sourcemap-codec';
import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

const FILES = {
    '/main.ts': "import { add } from './math';\nexport const r: number = add(2, 3);",
    '/math.ts': 'export const add = (a: number, b: number): number => a + b;',
    '/node_modules/lib.ts': 'export const libv = 7;',
};
const build = (output: Record<string, unknown>) => bundle({ input: '/main.ts', fs: createMemoryFs(FILES), external: [], output });

describe('output sourcemap variants', () => {
    it('inline → data-URL comment in code, NO .map asset', async () => {
        const r = await build({ sourcemap: 'inline' });
        expect(r.errors).toEqual([]);
        expect(r.code).toMatch(/\/\/# sourceMappingURL=data:application\/json;/);
        expect(r.assets ?? []).toHaveLength(0);
        // inline chunks carry their map object too.
        expect(r.map).toBeDefined();
    });

    it('hidden → .map asset present, NO sourceMappingURL comment', async () => {
        const r = await build({ sourcemap: 'hidden' });
        expect(r.errors).toEqual([]);
        expect(r.code).not.toContain('sourceMappingURL');
        expect((r.assets ?? []).some((a) => a.fileName === 'main.js.map')).toBe(true);
    });

    it('true → .map asset AND sourceMappingURL=<name>.map comment', async () => {
        const r = await build({ sourcemap: true });
        expect(r.errors).toEqual([]);
        expect(r.code).toContain('//# sourceMappingURL=main.js.map');
        expect((r.assets ?? []).some((a) => a.fileName === 'main.js.map')).toBe(true);
    });

    it('the emitted .map asset is valid JSON with the right sources', async () => {
        const r = await build({ sourcemap: true });
        const asset = (r.assets ?? []).find((a) => a.fileName === 'main.js.map')!;
        const map = JSON.parse(asset.source) as { sources: string[]; file: string };
        expect(map.sources).toEqual(['/math.ts', '/main.ts']);
        expect(map.file).toBe('main.js');
    });
});

describe('output sourcemap — sourcesContent & ignoreList', () => {
    it('sourcemapExcludeSources drops sourcesContent (keeps sources + mappings)', async () => {
        const r = await build({ sourcemap: true, sourcemapExcludeSources: true });
        expect(r.map!.sources.length).toBeGreaterThan(0);
        expect(r.map!.sourcesContent).toBeUndefined();
        expect(r.map!.mappings.length).toBeGreaterThan(0);
    });

    it('sourcemapIgnoreList RegExp populates x_google_ignoreList with the right indices', async () => {
        const r = await bundle({
            input: '/main2.ts',
            fs: createMemoryFs({
                '/main2.ts': "import { libv } from './node_modules/lib';\nexport const v = libv;",
                '/node_modules/lib.ts': 'export const libv = 7;',
            }),
            external: [],
            output: { sourcemap: true, sourcemapIgnoreList: /node_modules/ },
        });
        expect(r.errors).toEqual([]);
        const nmIdx = r.map!.sources.findIndex((s) => s?.includes('node_modules'));
        expect(nmIdx).toBeGreaterThanOrEqual(0);
        expect(r.map!.x_google_ignoreList).toContain(nmIdx);
    });

    it('sourcemapIgnoreList:false → field absent', async () => {
        const r = await build({ sourcemap: true, sourcemapIgnoreList: false });
        expect(r.map!.x_google_ignoreList).toBeUndefined();
    });
});

describe('output sourcemap — banner line offset (the footgun)', async () => {
    it('a 2-line banner shifts mapped segments down exactly 2 lines', async () => {
        const noBanner = await build({ sourcemap: true });
        const withBanner = await build({ sourcemap: true, banner: '/* line1 */\n/* line2 */' });
        expect(withBanner.errors).toEqual([]);

        // The banner occupies the first two generated lines (unmapped). Every mapped segment in
        // `withBanner` must be the SAME segment as `noBanner` shifted down by 2 lines — i.e. the
        // banner contributed unmapped generated lines and the source columns didn't drift.
        const base = decode(noBanner.map!.mappings);
        const shifted = decode(withBanner.map!.mappings);
        // First two lines of the banner build are unmapped.
        expect(shifted[0] ?? []).toHaveLength(0);
        expect(shifted[1] ?? []).toHaveLength(0);
        // Line k in base equals line k+2 in shifted.
        for (let k = 0; k < base.length; k++) {
            expect(shifted[k + 2] ?? []).toEqual(base[k] ?? []);
        }
    });

    it('the entry statement still traces to its original source line under a banner', async () => {
        const r = await build({ sourcemap: true, banner: '/* b1 */\n/* b2 */' });
        const decoded = decode(r.map!.mappings);
        const mainIdx = r.map!.sources.indexOf('/main.ts');
        let found = false;
        for (const line of decoded) {
            for (const seg of line) {
                if (seg.length >= 4 && seg[1] === mainIdx) found = true;
            }
        }
        expect(found).toBe(true);
    });
});
