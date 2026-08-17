import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

const build = async (files: Record<string, string>) => {
    const result = await bundle({ entry: '/main.ts', fs: createMemoryFs(files), external: [] });
    expect(result.errors).toEqual([]);
    return result;
};

const PNG = 'PNG-BYTES-';

describe('new URL(…, import.meta.url) asset scanning', () => {
    it('emits the asset and rewrites the specifier to the emitted fileName', async () => {
        const result = await build({
            '/main.ts': 'export const logo = new URL("./logo.png", import.meta.url);',
            '/logo.png': PNG,
        });
        const asset = result.assets?.find((a) => a.fileName.includes('logo'));
        expect(asset).toBeDefined();
        expect(asset!.fileName).toMatch(/^assets\/logo-[0-9a-f]{8}\.png$/);
        expect(asset!.source).toBe(PNG);
        // The `new URL(...)` stays, but its specifier now points at the emitted asset.
        expect(result.code).toContain('import.meta.url');
        expect(result.code).toContain(asset!.fileName);
        expect(result.code).not.toContain('./logo.png');
    });

    it('dedups repeated references to the same asset into one emit', async () => {
        const result = await build({
            '/main.ts': [
                'export const a = new URL("./logo.png", import.meta.url);',
                'export const b = new URL("./logo.png", import.meta.url);',
            ].join('\n'),
            '/logo.png': PNG,
        });
        expect(result.assets?.filter((a) => a.fileName.includes('logo'))).toHaveLength(1);
    });

    it('leaves a non-relative URL untouched (not an asset)', async () => {
        const result = await build({
            '/main.ts': 'export const u = new URL("https://cdn.example.com/x.png", import.meta.url);',
        });
        expect(result.assets ?? []).toHaveLength(0);
        expect(result.code).toContain('https://cdn.example.com/x.png');
    });

    it('leaves a non-literal specifier untouched', async () => {
        const result = await build({
            '/main.ts': 'export const f = (p) => new URL(p, import.meta.url);',
        });
        expect(result.assets ?? []).toHaveLength(0);
    });

    it('does not treat a shadowed local URL as the asset idiom', async () => {
        const result = await build({
            '/main.ts': 'class URL { constructor(s) { this.s = s; } }\nexport const u = new URL("./logo.png", import.meta.url);',
            '/logo.png': PNG,
        });
        expect(result.assets ?? []).toHaveLength(0);
    });
});
