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
