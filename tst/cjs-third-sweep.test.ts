import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import type { Plugin } from '../src/plugin.ts';
import { runChunks } from './exec-helpers.ts';

// cjs.md §"NOT YET PROBED", third sweep. Five of six were already correct and are pinned here so
// they stay that way; the sixth — `renderChunk` returning rollup's `{ code, map }` object — silently
// emitted the string `[object Object]` as the whole chunk.
const build = async (files: Record<string, string>, opts: Record<string, unknown> = {}) => {
    const r = await bundle({ entry: '/main.js', external: [], fs: createMemoryFs(files), ...opts });
    expect(r.errors).toEqual([]);
    return r;
};

const run = async (files: Record<string, string>, opts: Record<string, unknown> = {}) => {
    const r = await build(files, opts);
    const { ns, dispose } = await runChunks(r.chunks, r.chunks.find((c) => c.isEntry)!.fileName);
    try {
        return await (ns.x as unknown);
    } finally {
        dispose();
    }
};

describe('renderChunk return shapes', () => {
    it('accepts rollup’s `{ code, map }` object', async () => {
        // Plugins written against rollup return the object form. It used to be assigned straight to
        // the chunk's code, so the emitted bundle WAS the string `[object Object]` — no error, no
        // warning. A returned `map` is still not composed; the existing warning covers that.
        const plugin: Plugin = { name: 'rc', renderChunk: (_c, code) => ({ code: `/*H*/\n${code}`, map: null }) };
        const r = await build({ '/d.cjs': 'module.exports = 7;', '/main.js': "import d from './d.cjs';\nexport const x = d;" }, { plugins: [plugin] });
        expect(r.code.startsWith('/*H*/\n')).toBe(true);
        expect(r.code).not.toContain('[object Object]');
    });

    it('still accepts a plain string', async () => {
        const plugin: Plugin = { name: 'rc', renderChunk: (_c, code) => `/*H*/\n${code}` };
        const r = await build({ '/d.cjs': 'module.exports = 7;', '/main.js': "import d from './d.cjs';\nexport const x = d;" }, { plugins: [plugin] });
        expect(r.code.startsWith('/*H*/\n')).toBe(true);
    });
});

describe('configurations verified correct, now pinned', () => {
    it('an incremental rebuild picks up an edited .cjs', async () => {
        // Warm `ParseCache` across two builds — the wrapper, its interop namespace and the export
        // map all have to be rebuilt, not reused from the first pass.
        const files: Record<string, string> = { '/d.cjs': 'module.exports = { k: 1 };', '/main.js': "import d from './d.cjs';\nexport const x = d.k;" };
        const cache = new Map();
        const first = await bundle({ entry: '/main.js', external: [], fs: createMemoryFs(files), cache });
        expect(first.errors).toEqual([]);
        files['/d.cjs'] = 'module.exports = { k: 2 };';
        const second = await bundle({ entry: '/main.js', external: [], fs: createMemoryFs(files), cache });
        expect(second.errors).toEqual([]);
        expect((await import(`data:text/javascript,${encodeURIComponent(first.code)}`)).x).toBe(1);
        expect((await import(`data:text/javascript,${encodeURIComponent(second.code)}`)).x).toBe(2);
    });

    it('a plugin-supplied virtual module can be required AND imported', async () => {
        const virt: Plugin = {
            name: 'v',
            resolveId: (_c, spec) => (spec === 'virtual:cjs' ? '\0virtual:cjs' : null),
            load: (_c, id) => (id === '\0virtual:cjs' ? 'module.exports = { z: 5 };' : null),
        };
        expect(await run({ '/d.cjs': "module.exports = require('virtual:cjs').z;", '/main.js': "import d from './d.cjs';\nexport const x = d;" }, { plugins: [virt] })).toBe(5);
        expect(await run({ '/main.js': "import v from 'virtual:cjs';\nexport const x = v.z;" }, { plugins: [virt] })).toBe(5);
    });

    it('mode-2 members resolve with tree-shaking active', async () => {
        expect(
            await run({
                '/d.cjs': 'module.exports = { a: 1 };',
                '/b.js': "export * from './d.cjs';\nexport const used = 1;\nexport const unused = 2;",
                '/main.js': "import * as ns from './b.js';\nexport const x = [ns.a, ns.used];",
            }),
        ).toEqual([1, 1]);
    });

    it('the same CommonJS module in two chunks under different isNodeMode', async () => {
        // Both interop objects have to travel their own chunk boundaries independently.
        expect(
            await run({
                '/d.cjs': "exports.__esModule = true;\nexports.default = 'R';",
                '/a.mjs': "import d from './d.cjs';\nexport const a = d;",
                '/b.js': "import d from './d.cjs';\nexport const b = d;",
                '/main.js': "export const x = Promise.all([import('./a.mjs'), import('./b.js')]).then(([p, q]) => [typeof p.a, q.b]);",
            }),
        ).toEqual(['object', 'R']);
    });

    it('sourcemaps stay accurate with a banner and intro above the helpers', async () => {
        // `banner`/`intro` sit above `helperLines` in `mapParts` too, so their line counts have to
        // be right as well.
        const r = await build({ '/d.cjs': 'function h() {\n    return globalThis.z;\n}\nmodule.exports = h();', '/main.js': "import d from './d.cjs';\nexport const x = d;" }, {
            output: { sourcemap: true, banner: '/*B1*/\n/*B2*/', intro: '/*I*/' },
        });
        const { decode } = await import('@jridgewell/sourcemap-codec');
        const lines = r.code.split('\n');
        const li = lines.findIndex((l) => l.includes('function h()'));
        const seg = (decode(r.map!.mappings)[li] ?? [])[0]!;
        expect({ source: r.map!.sources[seg[1]!], line: seg[2]! + 1 }).toEqual({ source: '/d.cjs', line: 1 });
    });
});
