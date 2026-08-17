import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import type { Fs } from '../src/fs.ts';

// First-class async Fs: a browser/OPFS fs answers read/exists/realpath asynchronously. These tests
// prove the graph build awaits real Promises AND produces output byte-identical to a sync fs.
const FILES: Record<string, string> = {
    '/entry.ts': "import { a } from './a';\nimport { b } from './b';\nexport const t: number = a + b;",
    '/a.ts': "import { b } from './b';\nexport const a: number = b + 1;",
    '/b.ts': 'export const b = 2;',
};

const syncFs: Fs = { read: (id) => FILES[id] ?? null, exists: (id) => id in FILES };

// Every method resolves on a microtask, so the resolver + loader must genuinely await Promises.
const asyncFs: Fs = {
    read: async (id) => {
        await Promise.resolve();
        return FILES[id] ?? null;
    },
    exists: async (id) => {
        await Promise.resolve();
        return id in FILES;
    },
    realpath: async (id) => {
        await Promise.resolve();
        return id;
    },
};

describe('async Fs (first-class)', () => {
    it('bundles over an async fs byte-identical to a sync fs', async () => {
        const sync = await bundle({ entry: '/entry.ts', fs: syncFs, external: [] });
        const asyncResult = await bundle({ entry: '/entry.ts', fs: asyncFs, external: [] });
        expect(sync.errors).toEqual([]);
        expect(asyncResult.errors).toEqual([]);
        expect(asyncResult.chunks[0].code).toBe(sync.chunks[0].code);
    });

    it('resolves relative imports + walks the graph over an async fs', async () => {
        const r = await bundle({ entry: '/entry.ts', fs: asyncFs, external: [] });
        expect(r.errors).toEqual([]);
        expect(r.graph?.modules.length).toBe(3); // entry + a + b, deduped
    });

    it('probes extensions over an async fs (import without extension)', async () => {
        const files: Record<string, string> = {
            '/main.ts': "import { x } from './dep';\nexport const y = x;",
            '/dep.ts': 'export const x = 42;',
        };
        const fs: Fs = {
            read: async (id) => files[id] ?? null,
            exists: async (id) => id in files,
        };
        const r = await bundle({ entry: '/main.ts', fs, external: [] });
        expect(r.errors).toEqual([]); // './dep' resolved to '/dep.ts' via async extension probe
    });
});
