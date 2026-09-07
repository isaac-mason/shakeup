import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';

// `renderChunk` is documented async in Rollup, and plugins written against it return promises. Ours
// was called synchronously: a returned Promise is an OBJECT, so the `{ code, map }` unwrap read
// `.code` off the promise, got `undefined`, and the result was silently discarded. Every plugin in
// the chain then saw the ORIGINAL chunk and the bundle was emitted unmodified — no error, no warning.
//
// The same shape as the `buildEnd` bug fixed alongside it, and the `[object Object]` one before that:
// a hook whose contract is wider than the driver assumed.
const files: Record<string, string> = { '/main.js': 'export const v = ORIGINAL;\n' };
const build = async (plugins: unknown[]) => {
    const fs = { read: (id: string) => files[id] ?? null, exists: (id: string) => id in files };
    const r = await bundle({ entry: '/main.js', fs, external: [], plugins: plugins as never, output: {} });
    expect(r.errors).toEqual([]);
    return r.chunks[0];
};

describe('renderChunk', () => {
    it('applies an ASYNC hook’s result', async () => {
        const c = await build([{ name: 'p', renderChunk: (code: string) => Promise.resolve(code.replace('ORIGINAL', 'ONE')) }]);
        expect(c.code).toContain('ONE');
    });

    it('chains hooks, each seeing the previous result', async () => {
        const seen: string[] = [];
        const c = await build([
            {
                name: 'a',
                renderChunk: (code: string) => {
                    seen.push(code);
                    return Promise.resolve(code.replace('ORIGINAL', 'ONE'));
                },
            },
            {
                name: 'b',
                renderChunk: (code: string) => {
                    seen.push(code);
                    return code.replace('ONE', 'TWO'); // sync form still works
                },
            },
            {
                name: 'c',
                renderChunk: (code: string) => {
                    seen.push(code);
                    return Promise.resolve(code.replace('TWO', 'THREE'));
                },
            },
        ]);
        expect(seen[1], 'b saw a’s output').toContain('ONE');
        expect(seen[2], 'c saw b’s output').toContain('TWO');
        expect(c.code).toContain('THREE');
    });

    it('accepts the `{ code }` object form, sync and async', async () => {
        const sync = await build([{ name: 'p', renderChunk: (code: string) => ({ code: code.replace('ORIGINAL', 'OBJ') }) }]);
        expect(sync.code).toContain('OBJ');
        const async_ = await build([
            { name: 'p', renderChunk: (code: string) => Promise.resolve({ code: code.replace('ORIGINAL', 'AOBJ') }) },
        ]);
        expect(async_.code).toContain('AOBJ');
    });

    it('leaves the chunk alone when a hook returns null or undefined', async () => {
        const c = await build([
            { name: 'n', renderChunk: () => null },
            { name: 'u', renderChunk: () => undefined },
        ]);
        expect(c.code).toContain('ORIGINAL');
    });
});

// The hook's ARGUMENTS. It was called with `code` alone, so a plugin could not tell which chunk it
// was rewriting. Measured against rolldown 1.2.4 on the same plugin (llm/repro/_rcsurf.mts): it
// passes `(code, chunk, outputOptions, meta)`.
describe('renderChunk — the chunk it hands over', () => {
    const SPLIT: Record<string, string> = {
        '/a.js': "import { s } from './shared.js';\nexport const A = `${s}a`;\n",
        '/b.js': "import { s } from './shared.js';\nexport const B = `${s}b`;\n",
        '/shared.js': "export const s = 'S';\n",
    };
    const split = async (plugin: unknown) => {
        const fs = { read: (id: string) => SPLIT[id] ?? null, exists: (id: string) => id in SPLIT };
        const r = await bundle({
            input: ['/a.js', '/b.js'],
            fs,
            external: [],
            plugins: [plugin] as never,
            output: { entryFileNames: '[name].js', chunkFileNames: '[name].js' },
        } as never);
        expect(r.errors).toEqual([]);
        return r;
    };

    it('carries exactly the fields rolldown puts on a RenderedChunk', async () => {
        // The field list is the alignment claim, and it was read off a real rolldown build. `code`
        // and `map` are deliberately ABSENT: the code passes hook to hook, so a chunk object
        // carrying a copy of it would go stale mid-chain — both oracles omit it for that reason.
        let keys: string[] = [];
        await split({
            name: 'p',
            renderChunk(_code: string, chunk: object) {
                if (keys.length === 0) keys = Object.keys(chunk).sort();
                return null;
            },
        });
        expect(keys).toEqual([
            'dynamicImports',
            'exports',
            'facadeModuleId',
            'fileName',
            'imports',
            'isDynamicEntry',
            'isEntry',
            'moduleIds',
            'modules',
            'name',
            'type',
        ]);
    });

    it('identifies WHICH chunk — fileName, isEntry and facadeModuleId', async () => {
        const seen = new Map<string, { isEntry: boolean; facadeModuleId: unknown }>();
        await split({
            name: 'p',
            renderChunk(_code: string, chunk: { fileName: string; isEntry: boolean; facadeModuleId: unknown }) {
                seen.set(chunk.fileName, { isEntry: chunk.isEntry, facadeModuleId: chunk.facadeModuleId });
                return null;
            },
        });
        expect(seen.get('a.js')).toEqual({ isEntry: true, facadeModuleId: '/a.js' });
        expect(seen.get('b.js')).toEqual({ isEntry: true, facadeModuleId: '/b.js' });
        // The shared chunk fronts no module, so it has no facade — the falsification arm for
        // facadeModuleId, which would otherwise pass by always returning an entry id.
        const shared = [...seen.entries()].find(([f]) => f !== 'a.js' && f !== 'b.js');
        expect(shared, 'the two entries share a chunk').toBeDefined();
        expect(shared?.[1]).toEqual({ isEntry: false, facadeModuleId: null });
    });

    it('hands over the whole chunk graph as meta.chunks, and the output options', async () => {
        let metaNames: string[] = [];
        let entryPattern: unknown;
        await split({
            name: 'p',
            renderChunk(_c: string, _chunk: object, outputOptions: { entryFileNames?: unknown }, meta: { chunks: Record<string, unknown> }) {
                metaNames = Object.keys(meta.chunks).sort();
                entryPattern = outputOptions.entryFileNames;
                return null;
            },
        });
        expect(metaNames).toContain('a.js');
        expect(metaNames).toContain('b.js');
        expect(metaNames.length, 'entries plus the shared chunk').toBe(3);
        expect(entryPattern, 'the same normalized options renderStart receives').toBe('[name].js');
    });

    it('the chunk object is a description, not the output — writing to it changes nothing', async () => {
        const r = await split({
            name: 'p',
            renderChunk(code: string, chunk: Record<string, unknown>) {
                chunk.fileName = '/hijacked.js';
                chunk.code = 'throw new Error("should not be emitted")';
                return code;
            },
        });
        expect(r.chunks.map((c) => c.fileName).sort()).not.toContain('/hijacked.js');
        for (const c of r.chunks) expect(c.code).not.toContain('should not be emitted');
    });
});
