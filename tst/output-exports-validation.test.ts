import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

// `output.exports` must be CONSISTENT with what the entry actually exports — rollup's `getExportMode`
// (`utils/getExportMode.ts:13-20`). We accepted any value silently and then suppressed the export
// line for `'none'`, so a misconfigured build emitted a chunk missing its exports instead of saying
// so. Three of rollup's samples cover it: `invalid-default-export-mode`, `export-type-mismatch`,
// `export-type-mismatch-c`.
describe('output.exports is validated against the entry surface', () => {
    const build = async (src: string, exportsMode: string) =>
        bundle({ entry: '/main.js', fs: createMemoryFs({ '/main.js': src }), output: { exports: exportsMode } as never });

    it("rejects 'default' when the entry also has named exports", async () => {
        const r = await build('export default 1;\nexport const foo = 2;', 'default');
        expect(r.errors[0]).toContain('"default" was specified for "output.exports"');
        // rollup's `printQuotedStringList`: more than one item joins with `and`.
        expect(r.errors[0]).toContain('has the following exports: "default" and "foo"');
    });

    it("rejects 'default' when the entry has only a named export", async () => {
        const r = await build('export const foo = 1;', 'default');
        // A single item is printed bare, with no `and`.
        expect(r.errors[0]).toContain('has the following exports: "foo"');
        expect(r.errors[0]).not.toContain(' and ');
    });

    it("rejects 'none' when the entry exports anything", async () => {
        const r = await build('export default 1;', 'none');
        expect(r.errors[0]).toContain('"none" was specified for "output.exports"');
        expect(r.errors[0]).toContain('has the following exports: "default"');
    });

    it("accepts 'default' when the entry exports only a default", async () => {
        const r = await build('export default 1;', 'default');
        expect(r.errors).toEqual([]);
    });

    it("accepts 'none' when the entry exports nothing", async () => {
        const r = await build('globalThis.side = 1;', 'none');
        expect(r.errors).toEqual([]);
    });

    it("leaves 'auto' and 'named' alone", async () => {
        for (const mode of ['auto', 'named']) {
            const r = await build('export default 1;\nexport const foo = 2;', mode);
            expect(r.errors, mode).toEqual([]);
        }
    });
});
