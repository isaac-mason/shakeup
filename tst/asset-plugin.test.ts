import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createDevServer } from '../src/runtime/dev-server.ts';
import { createMemoryFs, type Fs } from '../src/fs.ts';
import { createModuleRunner } from '../src/runtime/module-runner.ts';
import { asset } from '../src/plugins/asset.ts';

const FILES = {
    '/main.ts': "import u from './data.txt?url';\nexport const url = u;",
    '/data.txt': 'hello asset',
};

describe('asset plugin — ?url imports', () => {
    it('BUILD mode: emits the asset + default-exports its content-hashed fileName', async () => {
        const r = await bundle({
            input: '/main.ts',
            fs: createMemoryFs(FILES),
            external: [],
            output: {},
            plugins: [asset()],
        });
        expect(r.errors).toEqual([]);

        // the bytes are emitted as an output asset with a hashed name.
        const emitted = (r.assets ?? []).filter((a) => a.fileName.startsWith('assets/data-'));
        expect(emitted).toHaveLength(1);
        expect(emitted[0].fileName).toMatch(/^assets\/data-[0-9a-f]{8}\.txt$/);
        expect(emitted[0].source).toBe('hello asset');

        // the import resolves to that fileName.
        expect(r.code).toContain(emitted[0].fileName);
    });

    it('DEV mode: url() maps the path to a served URL, NO emission', async () => {
        const r = await bundle({
            input: '/main.ts',
            fs: createMemoryFs(FILES),
            external: [],
            output: {},
            plugins: [asset({ url: (p) => `/@project${p}` })],
        });
        expect(r.errors).toEqual([]);
        expect(r.code).toContain('/@project/data.txt');
        expect((r.assets ?? []).some((a) => a.fileName.startsWith('assets/'))).toBe(false);
    });

    it('DEV SERVER path: runner evaluates a ?url import to the url() string (makecat path)', async () => {
        const fs: Fs = { read: (id) => (FILES as Record<string, string>)[id] ?? null, exists: (id) => id in FILES };
        const server = createDevServer({ fs, plugins: [asset({ url: (p) => `/@project${p}` })] });
        const runner = createModuleRunner({
            resolveId: (spec, importer) => server.resolveId(spec, importer),
            fetchModule: async (id) => {
                const r = await server.fetchModule(id);
                if (r.errors.length) throw new Error(r.errors.join('\n'));
                return r.code;
            },
            createImportMeta: (id) => ({ url: `sk://${id}` }),
        });
        const ns = (await runner.import('/main.ts')) as { url: string };
        expect(ns.url).toBe('/@project/data.txt');
    });

    it('dedupes: two ?url imports of the same asset emit one file', async () => {
        const r = await bundle({
            input: '/main.ts',
            fs: createMemoryFs({
                '/main.ts': "import a from './data.txt?url';\nimport b from './data.txt?url';\nexport const both = [a, b];",
                '/data.txt': 'hello asset',
            }),
            external: [],
            output: {},
            plugins: [asset()],
        });
        expect(r.errors).toEqual([]);
        expect((r.assets ?? []).filter((a) => a.fileName.startsWith('assets/data-'))).toHaveLength(1);
    });
});
