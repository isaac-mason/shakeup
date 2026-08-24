import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { bundle } from '../src/bundle.ts';

// `output.optimize` gates the directive tier (default true). crashcat authors 32 @optimize + 10 @inline
// + 1 @sroa directives, so it is the corpus that actually exercises the tier — toggling the option must
// change the output there, and both settings must produce valid JS.
const ROOT = '/Users/isaacmason/Development/crashcat/src';
const ENTRY = `${ROOT}/index.ts`;
const EXTERNAL = ['math', 'math/shapes', 'three'];
const diskFs = {
    read: (i: string) => (existsSync(i) ? readFileSync(i, 'utf8') : null),
    exists: (i: string) => existsSync(i),
};

describe.skipIf(!existsSync(ENTRY))('output.optimize gates the directive tier', () => {
    const build = (optimize: boolean) =>
        bundle({ entry: ENTRY, fs: diskFs, external: EXTERNAL, output: { minify: true, optimize } }).then((r) => r.code);

    it('optimize:false changes the output vs the default (directives are ignored)', async () => {
        const on = await build(true);
        const off = await build(false);
        expect(off).not.toBe(on); // the tier did something; disabling it is observable
    }, 180000);

    it('both settings produce valid, parseable JS', async () => {
        const { parse } = await import('../src/index.ts');
        for (const opt of [true, false]) {
            const code = await build(opt);
            expect(() => parse(code, { ts: false, jsx: false })).not.toThrow();
        }
    }, 180000);
});
