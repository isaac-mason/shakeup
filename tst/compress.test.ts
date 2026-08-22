import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const build = async (src: string, minify: boolean | { compress?: boolean; mangle?: boolean; whitespace?: boolean }) => {
    const result = await bundle({ entry: '/m.ts', fs: createMemoryFs({ '/m.ts': src }), output: { minify } });
    expect(result.errors).toEqual([]);
    return result.code;
};

describe('compress driver (minify P4)', () => {
    it('drop-debugger: removes `debugger` under compress, preserves behavior', async () => {
        const src = 'export function f(x) { debugger; return x + 1; }\nexport const out = f(41);';
        const code = await build(src, true);
        expect(code).not.toMatch(/\bdebugger\b/);
        expect((await run(code)).out).toBe(42);
    });

    it('drop-debugger does NOT fire without compress', async () => {
        const src = 'export function f() { debugger; return 1; }\nexport const out = f();';
        // whitespace+mangle only — compress opted out, so `debugger` survives.
        const code = await build(src, { whitespace: true, mangle: true });
        expect(code).toMatch(/\bdebugger\b/);
    });

    it('compress is off by default (plain build keeps debugger)', async () => {
        const code = await build('export function f() { debugger; return 1; }\nexport const out = f();', false);
        expect(code).toMatch(/\bdebugger\b/);
    });

    it('minify object form runs ONLY the named stage (compress-only)', async () => {
        const src = 'export function longName(argument) { debugger; return argument; }\nexport const out = longName(7);';
        const code = await build(src, { compress: true });
        expect(code).not.toMatch(/\bdebugger\b/); // compress ran
        expect(code).toMatch(/longName|argument/); // mangle did NOT run (names intact)
        expect((await run(code)).out).toBe(7);
    });
});
