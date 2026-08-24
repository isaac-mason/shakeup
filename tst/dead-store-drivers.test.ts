import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { bundle } from '../src/bundle.ts';
import { getLivenessDriver, type LivenessDriver, setLivenessDriver } from '../src/passes/compress/dead-store.ts';
import { runModule } from './exec-helpers.ts';

// Phase 2 of the CFG migration: dead-store can run on either liveness driver. These pin the two
// properties that make the switch safe to flip — identical OUTPUT on real code, and a strictly larger
// set of functions ANALYSED.

const withDriver = async <T>(d: LivenessDriver, fn: () => Promise<T>): Promise<T> => {
    const prev = getLivenessDriver();
    setLivenessDriver(d);
    try {
        return await fn();
    } finally {
        setLivenessDriver(prev);
    }
};

const build = (src: string, minify: boolean | { compress: boolean } = true) => {
    const files: Record<string, string> = { '/e.js': src };
    return bundle({
        entry: '/e.js',
        fs: { read: (i) => files[i] ?? null, exists: (i) => i in files },
        external: [],
        output: { minify },
    }).then((r) => r.code);
};

describe('liveness drivers produce identical output', () => {
    it('byte-identical on three.core.js under full minify', async () => {
        const src = readFileSync(
            '/Users/isaacmason/Development/shakeup/llm/spikes/node_modules/three/build/three.core.js',
            'utf8',
        );
        const a = await withDriver('structural', () => build(src));
        const b = await withDriver('cfg', () => build(src));
        expect(b).toBe(a);
        expect(a.length).toBeGreaterThan(300_000);
    }, 120000);
});

describe('the CFG driver covers what the structural one skips', () => {
    // `a = 1` is overwritten by `a = 2` before any read, so it is dead. The structural walker bails on
    // the whole function because of the `try`; the CFG models exception edges and removes the store.
    const SRC =
        'function f(p){ let a; a = 1; a = 2; try { g(p); } catch (e) {} return a; }\n' +
        'globalThis.g = () => {};\nexport const out = f(1);\n';

    it('structural keeps a dead store in a function containing try', async () => {
        const code = await withDriver('structural', () => build(SRC, { compress: true }));
        expect(code).toMatch(/a = 1/);
        expect((await runModule(code)).out).toBe(2);
    });

    it('cfg removes it, with the same runtime result', async () => {
        const code = await withDriver('cfg', () => build(SRC, { compress: true }));
        expect(code).not.toMatch(/a = 1/);
        expect((await runModule(code)).out).toBe(2);
    });
});
