import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createNodeFs } from '../src/node.ts';

// node's resolution is LOAD_AS_FILE then LOAD_AS_DIRECTORY, and step one means "X is a FILE". shakeup
// probed with `Fs.exists`, which on a real filesystem answers true for a DIRECTORY — so a directory
// `one/` sitting beside a file `one.js` won `import './one'`, and the build then failed with
// "cannot load module '<dir>/one'". Rollup's `findFile` checks `stats.isFile()` on an `lstat`;
// oxc-resolver's `FileSystem::metadata` returns `FileMetadata { is_file, is_dir, is_symlink }`.
// rollupsuite's `consistent-renaming-c` is exactly this layout.
//
// This has to run against a REAL filesystem: an in-memory Fs has no directories, so it cannot
// reproduce the bug at all — which is why nothing caught it.
const dir = join(tmpdir(), `shakeup-fs-isfile-${process.pid}`);
mkdirSync(join(dir, 'one'), { recursive: true });
writeFileSync(join(dir, 'one.js'), 'export default 1;\n');
writeFileSync(join(dir, 'one', 'index.js'), 'export default 2;\n');
writeFileSync(join(dir, 'main.js'), "import x from './one';\nexport const y = x;\n");
// The same clash one level down a PACKAGE subpath, which reaches the other resolver: bare specifiers
// go through `node-resolve.ts`'s `loadAsFile`, relative ones through `resolve.ts`'s `defaultResolve`.
// Both implement node's LOAD_AS_FILE and both had the bug.
mkdirSync(join(dir, 'node_modules', 'pkg', 'lib'), { recursive: true });
writeFileSync(join(dir, 'node_modules', 'pkg', 'package.json'), '{"name":"pkg","version":"1.0.0"}');
writeFileSync(join(dir, 'node_modules', 'pkg', 'lib.js'), 'export default 11;\n');
writeFileSync(join(dir, 'node_modules', 'pkg', 'lib', 'index.js'), 'export default 22;\n');
writeFileSync(join(dir, 'main3.js'), "import x from 'pkg/lib';\nexport const y = x;\n");
afterAll(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describe('load-as-FILE before load-as-directory', () => {
    it('a file wins over a directory of the same name', async () => {
        const r = await bundle({ entry: join(dir, 'main.js'), fs: createNodeFs(), external: [] } as never);
        expect(r.errors).toEqual([]);
        const code = r.chunks.map((c) => c.code).join('\n');
        expect(code, 'one.js, not one/index.js').toContain('1');
        expect(code).not.toContain('2');
    });

    it('the directory still resolves when nothing shadows it', async () => {
        writeFileSync(join(dir, 'main2.js'), "import x from './one/index.js';\nexport const y = x;\n");
        const r = await bundle({ entry: join(dir, 'main2.js'), fs: createNodeFs(), external: [] } as never);
        expect(r.errors).toEqual([]);
        expect(r.chunks.map((c) => c.code).join('\n')).toContain('2');
    });

    it('applies to a package subpath too, which is the OTHER resolver', async () => {
        const r = await bundle({ entry: join(dir, 'main3.js'), fs: createNodeFs(), external: [] } as never);
        expect(r.errors).toEqual([]);
        const code = r.chunks.map((c) => c.code).join('\n');
        expect(code, 'pkg/lib.js, not pkg/lib/index.js').toContain('11');
        expect(code).not.toContain('22');
    });

    it('survives the per-build fs memo wrapper', async () => {
        // `memoBuildFs` forwards every capability of the wrapped Fs, and had already silently dropped
        // `readBytes` once before. It dropped `isFile` too — the resolver fix alone changed nothing
        // until the wrapper passed the bit through. Two builds, so the memo is populated and reused.
        const fs = createNodeFs();
        expect(fs.isFile).toBeDefined();
        for (let i = 0; i < 2; i++) {
            const r = await bundle({ entry: join(dir, 'main.js'), fs, external: [] } as never);
            expect(r.errors).toEqual([]);
        }
    });
});
