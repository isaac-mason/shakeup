import { decode } from '@jridgewell/sourcemap-codec';
import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

// cjs.md §"NOT YET PROBED" — sourcemap accuracy for a wrapped module. It was listed as "partially
// probed; the text splice makes it suspect", and the suspicion was right, twice over:
//
//  1. `helperLines` was in the emitted `parts` but MISSING from `mapParts`, so every mapped line sat
//     ~30 generated lines above where it belonged. This was NOT specific to wrapping — any chunk
//     carrying CommonJS runtime helpers had a wholesale-offset map, including its plain ES modules.
//  2. CommonJS wrapping is a text splice — the body is re-indented inside `__commonJS(… => { … })` —
//     but the part's segments still described the UNWRAPPED text, so its line count disagreed with
//     what `joinParts` derives from `part.code`.
//
// Both were silent: a map that decodes cleanly and has the right `sources` looks fine. Only
// resolving a specific generated line back to its original catches it, which is what these do.
const D_CJS = ['const A = 1;', 'function helper() {', '    return A + globalThis.z;', '}', 'module.exports = helper();'].join(
    '\n',
);

/** Resolve one output line to `source:line`, or null when unmapped. */
const resolve = (code: string, map: { mappings: string; sources: (string | null)[] }, needle: string) => {
    const lines = code.split('\n');
    const li = lines.findIndex((l) => l.includes(needle));
    expect(li, `"${needle}" not found in output`).toBeGreaterThanOrEqual(0);
    const seg = (decode(map.mappings)[li] ?? [])[0];
    return seg === undefined || seg.length < 4 ? null : { source: map.sources[seg[1]!], line: seg[2]! + 1, column: seg[3] };
};

const build = async (files: Record<string, string>) => {
    const r = await bundle({ entry: '/main.js', external: [], fs: createMemoryFs(files), output: { sourcemap: true } });
    expect(r.errors).toEqual([]);
    return { code: r.code, map: r.map! };
};

describe('sourcemaps survive CommonJS wrapping', () => {
    it('a wrapped body maps to its own source lines', async () => {
        const { code, map } = await build({ '/d.cjs': D_CJS, '/main.js': "import d from './d.cjs';\nexport const x = d;" });
        expect(resolve(code, map, 'const A = 1;')).toEqual({ source: '/d.cjs', line: 1, column: 0 });
        expect(resolve(code, map, 'function helper()')).toEqual({ source: '/d.cjs', line: 2, column: 0 });
        expect(resolve(code, map, 'module.exports = helper();')).toEqual({ source: '/d.cjs', line: 5, column: 0 });
    });

    it('the four-column indent is reflected in the mapping', async () => {
        // The body's original column 4 must still read as column 4 in the source, with the
        // generated column shifted by the wrapper's indent rather than the source column.
        const { code, map } = await build({ '/d.cjs': D_CJS, '/main.js': "import d from './d.cjs';\nexport const x = d;" });
        expect(resolve(code, map, 'globalThis.z')).toEqual({ source: '/d.cjs', line: 3, column: 4 });
    });

    it('an ES module in the SAME chunk is not collateral damage', async () => {
        // The helper-block offset hit every module in the chunk, not just the wrapped one — this is
        // the assertion that would have caught it first.
        //
        // `const x` is main.js LINE 2, and this expected line 1 until the interop namespace moved to
        // the import statement it belongs to. It read 1 because main's import emitted nothing at all,
        // so `const x` was the first generated line of main's region and took the region's opening
        // segment. Now the statement emits `var import_d = …` and carries line 1 itself, and the line
        // after it maps to the line after it. Both are asserted, since the pair is the real claim.
        const { code, map } = await build({ '/d.cjs': D_CJS, '/main.js': "import d from './d.cjs';\nexport const x = d;" });
        expect(resolve(code, map, 'var import_d')).toEqual({ source: '/main.js', line: 1, column: 0 });
        expect(resolve(code, map, 'const x =')).toEqual({ source: '/main.js', line: 2, column: 0 });
    });

    it('a bundle with no CommonJS still maps correctly', async () => {
        // Guard on the helper-block insertion: it must not shift anything when there are no helpers.
        // Written so nothing folds away — a `const` initialised from a literal is inlined and its
        // line disappears from the output entirely.
        const { code, map } = await build({
            '/d.js': 'function helper() {\n    return globalThis.z;\n}\nexport default helper();',
            '/main.js': "import d from './d.js';\nexport const x = d;",
        });
        expect(resolve(code, map, 'function helper()')).toEqual({ source: '/d.js', line: 1, column: 0 });
        expect(resolve(code, map, 'globalThis.z')).toEqual({ source: '/d.js', line: 2, column: 4 });
        expect(resolve(code, map, 'const x =')).toEqual({ source: '/main.js', line: 1, column: 0 });
    });

    it('a lazily-initialised ES module maps through its __esm closure', async () => {
        // Two header lines here, not one — the namespace binding is hoisted above the closure.
        const { code, map } = await build({
            '/e.js': 'function inner() {\n    return globalThis.z;\n}\nexport const v = inner();',
            '/d.cjs': "module.exports = require('./e.js').v;",
            '/main.js': "import d from './d.cjs';\nexport const x = d;",
        });
        expect(code).toContain('__esm(');
        expect(resolve(code, map, 'function inner()')).toEqual({ source: '/e.js', line: 1, column: 0 });
        expect(resolve(code, map, 'globalThis.z')).toEqual({ source: '/e.js', line: 2, column: 4 });
    });
});
