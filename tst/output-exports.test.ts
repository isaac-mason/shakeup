import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';

// `output.exports` — what an ENTRY chunk is allowed to export. Rollup's `getExportMode`
// (`utils/getExportMode.ts`), which shakeup mirrors: `'default'` demands the entry export exactly
// `default`, `'none'` demands it export nothing, and a mismatch is an error rather than a silently
// reshaped bundle.
//
// Two crossings got it wrong in opposite directions, both found by executing fixtures against node
// and rolldown rather than by reading the rule:
//
//   • a COMMONJS entry has no ESM export map, so validating against that map saw an empty list and
//     rejected `'default'` while ACCEPTING `'none'` — which then dropped the entry's only export;
//   • a DYNAMIC entry chunk was validated at all, which no oracle does.
const build = (files: Record<string, string>, output: Record<string, unknown>, entry = '/main.js') =>
    bundle({ entry, external: [], fs: createMemoryFs(files), output });

describe('output.exports and a CommonJS entry', () => {
    // A CJS entry's emitted surface is `export default require_main();` — exactly `default`, and
    // nothing the export MAP knows about.
    const cjs = { '/main.cjs': "module.exports = { d: 'DEFAULT' };\n" };

    it("accepts 'default'", async () => {
        const r = await build(cjs, { exports: 'default' }, '/main.cjs');
        expect(r.errors).toEqual([]);
        expect(r.chunks[0].code).toContain('export default require_main();');
    });

    it("rejects 'none', naming the export it would otherwise have dropped", async () => {
        const r = await build(cjs, { exports: 'none' }, '/main.cjs');
        expect(r.errors.join(' ')).toContain('"none" was specified for "output.exports"');
        expect(r.errors.join(' '), 'names the surface, not an empty list').toContain('"default"');
    });
});

describe('output.exports and a DYNAMIC entry chunk', () => {
    // Rollup gates this on `facadeModule.info.isEntry` (`Chunk.ts:412`) — the user-declared entry,
    // not a dynamic one — and rolldown agrees. Both fixtures below are builds rolldown accepts.
    it("does not validate a dynamic chunk under 'default'", async () => {
        const r = await build(
            {
                '/panel.js': 'export const a = 1;\nexport const b = 2;\n',
                '/main.js': "export default async () => (await import('./panel.js')).a;\n",
            },
            { exports: 'default' },
        );
        expect(r.errors, 'the dynamic chunk exports `a` and `b`, and that is allowed').toEqual([]);
        expect(r.chunks).toHaveLength(2);
    });

    it("does not strip a dynamic chunk's exports under 'none'", async () => {
        // The dangerous half: suppressing them leaves `import()` resolving to an empty namespace,
        // from a build that reports success.
        const r = await build(
            {
                '/panel.js': "export const a = 'PANEL';\n",
                '/main.js': "globalThis.__out = import('./panel.js').then((m) => m.a);\n",
            },
            { exports: 'none' },
        );
        expect(r.errors).toEqual([]);
        const panel = r.chunks.find((c) => c.fileName.startsWith('panel'))!;
        expect(panel.code, 'the dynamic chunk still exports what `import()` reads').toMatch(/export \{[^}]*\ba\b/);
        // …while the STATIC entry, which exports nothing, is genuinely suppressed.
        expect(r.chunks.find((c) => c.fileName === 'main.js')!.code).not.toMatch(/^export /m);
    });
});

describe('an ESM entry is still validated against its own surface', () => {
    // The falsification arm for both fixes above: neither is "stop validating".
    it.each([
        ['export default 1;\n', 'default', true],
        ['export default 1;\n', 'none', false],
        ['export const a = 1;\n', 'default', false],
        ['console.log(1);\n', 'none', true],
    ])('%s with exports:%s', async (src, mode, ok) => {
        const r = await build({ '/main.js': src }, { exports: mode });
        if (ok) expect(r.errors).toEqual([]);
        else expect(r.errors.join(' ')).toContain('was specified for "output.exports"');
    });
});
