import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

const build = async (files: Record<string, string>, preserveModules = true) => {
    const result = await bundle({
        entry: '/main.js',
        fs: createMemoryFs(files),
        external: [],
        output: preserveModules ? { preserveModules: true } : {},
    });
    expect(result.errors).toEqual([]);
    return result;
};

const dirs: string[] = [];
afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Write every chunk to a real directory and import the entry through Node's own ESM loader.
 *  Multi-file output cannot be executed from a `data:` URL (relative specifiers do not resolve),
 *  and — more to the point — the whole claim under test is that the RUNTIME supplies the namespace.
 *  Asserting on emitted text would prove nothing about that. */
const runChunks = async (chunks: { fileName: string; code: string }[]): Promise<Record<string, unknown>> => {
    const dir = mkdtempSync(join(tmpdir(), 'shakeup-pm-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    for (const c of chunks) writeFileSync(join(dir, c.fileName), c.code);
    return (await import(pathToFileURL(join(dir, 'main.js')).href)) as Record<string, unknown>;
};

const chunkFor = (chunks: { fileName: string; code: string }[], startsWith: string) =>
    chunks.find((c) => c.fileName.startsWith(startsWith))!;

// Under `preserveModules` every module is its own chunk, so a namespace import always crosses a
// chunk boundary — and across a boundary the host can build the namespace itself. Emitting a real
// `import * as ns from './a.js'` is smaller than a synthesized object AND spec-exact for free: live
// bindings, `[object Module]`, non-writable. This is the shape library consumers expect to see.
describe('preserveModules: namespaces are native', () => {
    const LIB = {
        '/a.js': 'export let v = 1;\nexport function bump(){ v = 2 }\nexport const c = 3;',
        '/main.js': [
            "import * as ns from './a.js';",
            'ns.bump();',
            'export const got = ns.v;',
            'export const tag = Object.prototype.toString.call(ns);',
            'export const readonly = (() => { try { ns.v = 9; return false } catch { return true } })();',
        ].join('\n'),
    };

    it('emits a native star import and no synthesized namespace object', async () => {
        const { chunks } = await build(LIB);
        const main = chunkFor(chunks, 'main');
        expect(main.code).toMatch(/import \* as \w+ from '\.\/a-[^']+\.js';/);
        for (const c of chunks) {
            expect(c.code).not.toContain('Object.freeze');
            expect(c.code).not.toContain('Symbol.toStringTag');
        }
    });

    it('the producer surfaces its own export names', async () => {
        const { chunks } = await build(LIB);
        const a = chunkFor(chunks, 'a-');
        expect(a.code).toMatch(/export \{[^}]*\bv\b[^}]*\}/);
        expect(a.code).toMatch(/export \{[^}]*\bbump\b[^}]*\}/);
        expect(a.code).not.toContain('_ns');
    });

    it('executes with real ESM namespace semantics', async () => {
        const { chunks } = await build(LIB);
        const mod = await runChunks(chunks);
        expect(mod.got).toBe(2); // live binding, not a snapshot
        expect(mod.tag).toBe('[object Module]');
        expect(mod.readonly).toBe(true);
    });

    it('a re-exporting barrel still resolves every member', async () => {
        // `barrel` re-exports from `a`, so its export surface is NOT all its own locals and the
        // native path is not eligible. The synthesized object is built in barrel's chunk, which
        // therefore has to IMPORT `x` from a's chunk — it used to reference an undeclared local and
        // throw a ReferenceError on load (pre-existing, reproduced at 41f7bd0).
        const { chunks } = await build({
            '/a.js': 'export const x = 1;',
            '/barrel.js': "export { x } from './a.js';\nexport const own = 2;",
            '/main.js': "import * as ns from './barrel.js';\nexport const got = [ns.x, ns.own];",
        });
        expect(await runChunks(chunks)).toMatchObject({ got: [1, 2] });
    });

    it('handles a namespace of a module that itself imports one', async () => {
        const { chunks } = await build({
            '/leaf.js': 'export const n = 5;',
            '/mid.js': "import * as leaf from './leaf.js';\nexport const doubled = leaf.n * 2;",
            '/main.js': "import * as mid from './mid.js';\nexport const got = mid.doubled;",
        });
        expect(await runChunks(chunks)).toMatchObject({ got: 10 });
    });
});

// The synthesized object is only NEEDED when there is no module boundary to hang a namespace on.
describe('single-chunk bundles still synthesize a namespace object', () => {
    it('builds the object inline when target and consumer share a chunk', async () => {
        const { chunks } = await build(
            {
                '/a.js': 'export let v = 1;\nexport function bump(){ v = 2 }',
                '/main.js': "import * as ns from './a.js';\nns.bump();\nexport const got = ns.v;",
            },
            false,
        );
        expect(chunks).toHaveLength(1);
        expect(chunks[0].code).toMatch(/const \w+_ns = \{/);
        // Not frozen — neither oracle freezes a namespace, and freezing would block the
        // `__reExport` chain that `export * from 'cjs'` needs.
        expect(chunks[0].code).not.toContain('Object.freeze');
        // …and the tag is defined separately so it stays NON-enumerable.
        expect(chunks[0].code).toMatch(/Object\.defineProperty\(\w+_ns, Symbol\.toStringTag/);
        expect(await runChunks(chunks)).toMatchObject({ got: 2 });
    });
});
