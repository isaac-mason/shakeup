import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';

// `for (const v of xs) {}` is NEVER effect-free, however empty its body: it calls
// `xs[Symbol.iterator]()` and then `.next()` until done, and both are ordinary user code. shakeup's
// function-purity walk did not mention the loop forms at all, so a function whose whole body was one
// was summarised as pure and every discarded call to it was dropped.
//
// Rollup's `preserve-for-of-iterable` is the fixture: an iterator whose `next()` mutates a module
// binding, and an assertion that the mutation happened. rolldown keeps the call; we dropped it, so
// the assertion read `undefined` instead of 5.
const build = async (files: Record<string, string>) => {
    const fs = { read: (id: string) => files[id] ?? null, exists: (id: string) => id in files };
    const r = await bundle({ entry: '/main.js', fs, external: [], output: {} });
    expect(r.errors).toEqual([]);
    return r.chunks.map((c) => c.code).join('\n');
};

describe('a loop is not effect-free just because its body is empty', () => {
    it('keeps a discarded call whose body is a for...of', async () => {
        const code = await build({
            '/loops.js': 'export const iterate = (xs) => { for (const v of xs) {} };\n',
            '/main.js': "import { iterate } from './loops.js';\nexport const xs = [];\niterate(xs);\n",
        });
        expect(code).toContain('iterate(');
    });

    it('keeps it for `for await...of` too', async () => {
        const code = await build({
            '/loops.js': 'export const drain = async (xs) => { for await (const v of xs) {} };\n',
            '/main.js': "import { drain } from './loops.js';\nexport const xs = [];\ndrain(xs);\n",
        });
        expect(code).toContain('drain(');
    });

    it('keeps it for a for...in, whose enumeration a Proxy can observe', async () => {
        const code = await build({
            '/loops.js': 'export const keys = (o) => { for (const k in o) {} };\n',
            '/main.js': "import { keys } from './loops.js';\nexport const o = {};\nkeys(o);\n",
        });
        expect(code).toContain('keys(');
    });

    it('still drops a call whose body really is inert', async () => {
        // The guard must not become "any function with a statement is impure".
        const code = await build({
            '/loops.js': 'export const nothing = (x) => { let y = x; };\n',
            '/main.js': "import { nothing } from './loops.js';\nexport const x = 1;\nnothing(x);\n",
        });
        expect(code).not.toContain('nothing(');
    });
});
