import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createDevServer } from '../src/runtime/dev-server.ts';
import { createMemoryFs, type Fs } from '../src/fs.ts';
import { createModuleRunner } from '../src/runtime/module-runner.ts';
import { worker } from '../src/plugins/worker.ts';

const lib = '/lib.ts';
const files = (spec: string) => ({
    '/main.ts': `import W from '${spec}';\nexport const Ctor = W;`,
    '/task.worker.ts': "import { compute } from './lib';\nonmessage = (e) => postMessage(compute(e.data));",
    [lib]: 'export const compute = (n: number): number => n * 42;',
});

describe('worker plugin — ?worker imports', () => {
    it('?worker&inline: blobs a self-contained nested bundle (deps inlined) as a WorkerWrapper', async () => {
        const r = await bundle({
            input: '/main.ts',
            fs: createMemoryFs(files('./task.worker.ts?worker&inline')),
            external: [],
            output: {},
            plugins: [worker()],
        });
        expect(r.errors).toEqual([]);
        expect(r.code).toContain('WorkerWrapper');
        // the worker's dep is inlined into the embedded blob code, not left as an import.
        expect(r.code).toContain('n * 42');
        expect(r.code).toContain('createObjectURL');
        expect((r.assets ?? []).some((a) => a.fileName.includes('worker'))).toBe(false);
    });

    it('plain ?worker (BUILD): emits a separate worker chunk + new Worker(new URL(...))', async () => {
        const r = await bundle({
            input: '/main.ts',
            fs: createMemoryFs(files('./task.worker.ts?worker')),
            external: [],
            output: {},
            plugins: [worker()],
        });
        expect(r.errors).toEqual([]);
        // the worker graph is emitted as its own chunk (deps inlined into it)...
        const chunk = (r.assets ?? []).find((a) => a.fileName.startsWith('assets/task.worker-'));
        expect(chunk).toBeDefined();
        expect(chunk!.source).toContain('n * 42');
        // ...and the main module loads it by URL, not as a blob.
        expect(r.code).toContain('new URL(');
        expect(r.code).toContain(chunk!.fileName);
        expect(r.code).not.toContain('createObjectURL');
    });

    it('DEV SERVER: a plain ?worker falls back to inline (no output sink) + default-exports the ctor', async () => {
        const f = files('./task.worker.ts?worker');
        const fs: Fs = { read: (id) => (f as Record<string, string>)[id] ?? null, exists: (id) => id in f };
        const server = createDevServer({ fs, plugins: [worker()] });
        const runner = createModuleRunner({
            resolveId: (spec, importer) => server.resolveId(spec, importer),
            fetchModule: async (id) => {
                const res = await server.fetchModule(id);
                if (res.errors.length) throw new Error(res.errors.join('\n'));
                return res.code;
            },
            createImportMeta: (id) => ({ url: `sk://${id}` }),
        });
        // `self`/`Worker` are absent in node → the wrapper evaluates but constructs nothing until
        // called, so importing it is safe.
        const ns = (await runner.import('/main.ts')) as { Ctor: unknown };
        expect(typeof ns.Ctor).toBe('function');
    });
});
