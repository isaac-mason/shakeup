import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import type { OutputOptions } from '../src/bundle.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (files: Record<string, string>, output?: OutputOptions) => {
    const result = await bundle({ entry: '/main.ts', fs: createMemoryFs(files), external: [], output });
    expect(result.errors).toEqual([]);
    return result;
};

const OPS = 'export const AAA = () => 111;\nexport const BBB = () => 222;';

describe('dynamic-import member narrowing', () => {
    it('narrows a same-chunk (inlined) dynamic import to the members read', async () => {
        const { code } = await build(
            { '/main.ts': 'export const load = async () => (await import("./ops")).AAA();', '/ops.ts': OPS },
            { codeSplitting: false },
        );
        expect(code).toContain('AAA');
        expect(code).not.toContain('BBB');
        const mod = await run(code);
        expect(await (mod.load as () => Promise<number>)()).toBe(111);
    });

    it('narrows a same-chunk destructured dynamic import', async () => {
        const { code } = await build(
            { '/main.ts': 'export const load = async () => { const { AAA } = await import("./ops"); return AAA(); };', '/ops.ts': OPS },
            { codeSplitting: false },
        );
        expect(code).not.toContain('BBB');
        const mod = await run(code);
        expect(await (mod.load as () => Promise<number>)()).toBe(111);
    });

    it('narrows a cross-chunk dynamic import — the lazy chunk drops unused exports', async () => {
        const { chunks } = await build({
            '/main.ts': 'export const load = async () => (await import("./ops")).AAA();',
            '/ops.ts': OPS,
        });
        const lazy = chunks.find((c) => c.isDynamicEntry);
        expect(lazy).toBeDefined();
        expect(lazy!.code).toContain('AAA');
        expect(lazy!.code).not.toContain('BBB');
    });

    it('keeps the whole surface when the dynamic result escapes', async () => {
        const { code } = await build(
            { '/main.ts': 'export const load = () => import("./ops").then((m) => globalThis.sink = m);', '/ops.ts': OPS },
            { codeSplitting: false },
        );
        expect(code).toContain('AAA');
        expect(code).toContain('BBB'); // escaped → whole surface retained
    });

    it('unions static named imports with dynamic member reads', async () => {
        const { code } = await build(
            {
                '/main.ts': [
                    'import { AAA } from "./ops";',
                    'export const eager = AAA();',
                    'export const load = async () => (await import("./ops")).BBB();',
                ].join('\n'),
                '/ops.ts': `${OPS}\nexport const CCC = () => 333;`,
            },
            { codeSplitting: false },
        );
        expect(code).toContain('AAA');
        expect(code).toContain('BBB');
        expect(code).not.toContain('CCC'); // read by neither consumer
        const mod = await run(code);
        expect(mod.eager).toBe(111);
        expect(await (mod.load as () => Promise<number>)()).toBe(222);
    });
});
