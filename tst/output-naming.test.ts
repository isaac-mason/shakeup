import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

const NO_HASH = /!~\{/; // placeholder delimiter — must never leak into output

describe('output naming — [name] and patterns', () => {
    it('[name] comes from the entry name; entries carry no hash by default', async () => {
        const r = await bundle({
            input: '/main.ts',
            fs: createMemoryFs({ '/main.ts': 'export const x = 1;' }),
            external: [],
        });
        expect(r.errors).toEqual([]);
        expect(r.chunks[0].fileName).toBe('main.js');
    });

    it('object-input name override drives [name]', async () => {
        const r = await bundle({
            input: { app: '/main.ts' },
            fs: createMemoryFs({ '/main.ts': 'export const x = 1;' }),
            external: [],
        });
        expect(r.chunks.find((c) => c.isEntry)!.fileName).toBe('app.js');
    });

    it('custom entryFileNames pattern with [hash] hashes the entry too', async () => {
        const r = await bundle({
            input: '/main.ts',
            fs: createMemoryFs({ '/main.ts': 'export const x = 1;' }),
            external: [],
            output: { entryFileNames: '[name]-[hash].js' },
        });
        expect(r.chunks[0].fileName).toMatch(/^main-[0-9A-Za-z_-]{8}\.js$/);
    });
});

describe('output naming — [hash] stability & size', () => {
    const files = {
        '/a.ts': "import { s } from './shared';\nexport const av = s + 1;",
        '/b.ts': "import { s } from './shared';\nexport const bv = s + 2;",
        '/shared.ts': 'export const s = 40;',
    };
    const build = async (extra: Record<string, unknown> = {}) =>
        bundle({ input: { a: '/a.ts', b: '/b.ts' }, fs: createMemoryFs(files), external: [], output: extra });

    it('shared chunk gets a hashed name of DEFAULT_HASH_SIZE (8) chars', async () => {
        const r = await build();
        const shared = r.chunks.find((c) => !c.isEntry)!;
        expect(shared.fileName).toMatch(/^shared-[0-9A-Za-z_-]{8}\.js$/);
    });

    it('[hash:12] widens the hash to 12 chars', async () => {
        const r = await build({ chunkFileNames: '[name]-[hash:12].js' });
        const shared = r.chunks.find((c) => !c.isEntry)!;
        expect(shared.fileName).toMatch(/^shared-[0-9A-Za-z_-]{12}\.js$/);
    });

    it('bundling twice yields byte-identical filenames (determinism)', async () => {
        const one = await build();
        const two = await build();
        expect(one.chunks.map((c) => c.fileName)).toEqual(two.chunks.map((c) => c.fileName));
    });

    it('no placeholder leaks into any chunk code or filename', async () => {
        const r = await build();
        for (const c of r.chunks) {
            expect(c.fileName).not.toMatch(NO_HASH);
            expect(c.code).not.toMatch(NO_HASH);
        }
    });
});

describe('output naming — [hash] change-propagation across chunks (THE test)', () => {
    // A imports B (shared). B is a shared/non-entry chunk → hashed. A is an entry.
    const filesWith = (bBody: string, aBody: string) => ({
        '/a.ts': `import { s } from './shared';\n${aBody}`,
        '/b.ts': "import { s } from './shared';\nexport const bv = s;",
        '/shared.ts': bBody,
    });
    const build = async (bBody: string, aBody = 'export const av = s + 1;') =>
        bundle({
            input: { a: '/a.ts', b: '/b.ts' },
            fs: createMemoryFs(filesWith(bBody, aBody)),
            external: [],
        });

    const sharedName = (r: Awaited<ReturnType<typeof build>>) =>
        r.chunks.find((c) => c.moduleIds.includes('/shared.ts'))!.fileName;
    const entryA = (r: Awaited<ReturnType<typeof build>>) => r.chunks.find((c) => c.name === 'a')!;

    it('changing the shared chunk source changes its hash AND updates importers', async () => {
        const base = await build('export const s = 40;');
        const changed = await build('export const s = 999;');

        const sharedBase = sharedName(base);
        const sharedChanged = sharedName(changed);
        // The shared chunk's hash changed.
        expect(sharedChanged).not.toBe(sharedBase);
        // Chunk A embeds the shared chunk's path — its import specifier tracks the new name.
        expect(entryA(base).code).toContain(`from './${sharedBase}'`);
        expect(entryA(changed).code).toContain(`from './${sharedChanged}'`);
    });

    it('changing ONLY entry A does not change the shared chunk hash', async () => {
        const base = await build('export const s = 40;', 'export const av = s + 1;');
        const changedA = await build('export const s = 40;', 'export const av = s + 12345;');
        // Shared chunk source is untouched → its hash is stable (entries are not hashed).
        expect(sharedName(changedA)).toBe(sharedName(base));
    });

    it("A's import path string equals B's final filename", async () => {
        const r = await build('export const s = 40;');
        const shared = sharedName(r);
        expect(entryA(r).code).toContain(`from './${shared}'`);
    });
});

describe('output naming — hashCharacters', () => {
    const build = async (hashCharacters: 'base64' | 'base36' | 'hex') =>
        bundle({
            input: { a: '/a.ts', b: '/b.ts' },
            fs: createMemoryFs({
                '/a.ts': "import { s } from './shared';\nexport const av = s;",
                '/b.ts': "import { s } from './shared';\nexport const bv = s;",
                '/shared.ts': 'export const s = 1;',
            }),
            external: [],
            output: { hashCharacters, chunkFileNames: '[name]-[hash].js' },
        });
    const hashOf = (r: Awaited<ReturnType<typeof build>>) =>
        r.chunks
            .find((c) => !c.isEntry)!
            .fileName.replace(/^shared-/, '')
            .replace(/\.js$/, '');

    it('hex → [0-9a-f]', async () => expect(hashOf(await build('hex'))).toMatch(/^[0-9a-f]{8}$/));
    it('base36 → [0-9a-z]', async () => expect(hashOf(await build('base36'))).toMatch(/^[0-9a-z]{8}$/));
    it('base64 → url-safe set', async () => expect(hashOf(await build('base64'))).toMatch(/^[0-9A-Za-z_-]{8}$/));
});

describe('output naming — sanitizeFileName', () => {
    // A group name with invalid chars is sanitized to '_'.
    const build = async (opt?: boolean | ((n: string) => string)) =>
        bundle({
            input: { app: '/app.ts' },
            fs: createMemoryFs({
                '/app.ts': "import { v } from './vendor';\nexport const y = v;",
                '/vendor.ts': 'export const v = 1;',
            }),
            external: [],
            output: {
                manualChunks: (id) => (id.includes('vendor') ? 'a?b*c' : null),
                chunkFileNames: '[name].js', // no hash → the sanitized name is visible
                ...(opt === undefined ? {} : { sanitizeFileName: opt }),
            },
        });

    it('default sanitizer replaces ? and * with _', async () => {
        const r = await build();
        const vendor = r.chunks.find((c) => c.moduleIds.includes('/vendor.ts'))!;
        expect(vendor.fileName).toBe('a_b_c.js');
    });

    it('sanitizeFileName:false leaves the raw name', async () => {
        const r = await build(false);
        const vendor = r.chunks.find((c) => c.moduleIds.includes('/vendor.ts'))!;
        expect(vendor.fileName).toBe('a?b*c.js');
    });

    it('a custom sanitizer fn is applied', async () => {
        const r = await build((n) => n.replace(/[?*]/g, 'X'));
        const vendor = r.chunks.find((c) => c.moduleIds.includes('/vendor.ts'))!;
        expect(vendor.fileName).toBe('aXbXc.js');
    });

    it('/ subdirectory in the pattern survives (not sanitized away)', async () => {
        const r = await bundle({
            input: '/main.ts',
            fs: createMemoryFs({ '/main.ts': 'export const x = 1;' }),
            external: [],
            output: { entryFileNames: 'nested/[name].js' },
        });
        expect(r.chunks[0].fileName).toBe('nested/main.js');
    });
});

describe('output naming — makeUnique collision', () => {
    it('two non-hashed chunks resolving to the same name get a numeric suffix', async () => {
        // a&b share x1, c&d share x2 → two distinct shared chunks. A constant chunkFileNames
        // (no [name]/[hash]) forces both to 'shared.js' → the second collides → 'shared2.js'.
        const r = await bundle({
            input: { a: '/a.ts', b: '/b.ts', c: '/c.ts', d: '/d.ts' },
            fs: createMemoryFs({
                '/a.ts': "import { x } from './x1';\nexport const av = x;",
                '/b.ts': "import { x } from './x1';\nexport const bv = x;",
                '/c.ts': "import { y } from './x2';\nexport const cv = y;",
                '/d.ts': "import { y } from './x2';\nexport const dv = y;",
                '/x1.ts': 'export const x = 1;',
                '/x2.ts': 'export const y = 2;',
            }),
            external: [],
            output: { chunkFileNames: 'shared.js' }, // constant name, no [name]/[hash] → collision
        });
        expect(r.errors).toEqual([]);
        const nonEntry = r.chunks
            .filter((c) => !c.isEntry)
            .map((c) => c.fileName)
            .sort();
        expect(nonEntry).toHaveLength(2);
        // Deterministic: first reserves shared.js, second collides → shared2.js.
        expect(nonEntry).toEqual(['shared.js', 'shared2.js']);
    });
});

describe('output naming — file vs dir', () => {
    it('output.file with >1 chunk errors', async () => {
        const r = await bundle({
            input: { a: '/a.ts', b: '/b.ts' },
            fs: createMemoryFs({
                '/a.ts': "import { s } from './shared';\nexport const av = s;",
                '/b.ts': "import { s } from './shared';\nexport const bv = s;",
                '/shared.ts': 'export const s = 1;',
            }),
            external: [],
            output: { file: 'out.js' },
        });
        expect(r.errors[0]).toMatch(/output\.file.*single-chunk/);
    });

    it('output.file single chunk uses its basename', async () => {
        const r = await bundle({
            input: '/main.ts',
            fs: createMemoryFs({ '/main.ts': 'export const x = 1;' }),
            external: [],
            output: { file: 'dist/bundle.js' },
        });
        expect(r.chunks[0].fileName).toBe('bundle.js');
    });
});

describe('output naming — banner/footer/intro/outro', () => {
    const files = { '/main.ts': 'export const x = 1;' };
    it('string banner/footer/intro/outro prepend/append exactly', async () => {
        const r = await bundle({
            input: '/main.ts',
            fs: createMemoryFs(files),
            external: [],
            output: { banner: '/* B */', footer: '/* F */', intro: 'const I = 0;', outro: 'const O = 0;' },
        });
        const lines = r.code.split('\n');
        expect(lines[0]).toBe('/* B */');
        expect(lines[1]).toBe('const I = 0;');
        expect(r.code).toContain('const O = 0;');
        expect(r.code.trimEnd().endsWith('/* F */')).toBe(true);
    });

    it('function-form banner receives a PreRenderedChunk', async () => {
        let received: unknown;
        const r = await bundle({
            input: '/main.ts',
            fs: createMemoryFs(files),
            external: [],
            output: {
                banner: (chunk) => {
                    received = chunk;
                    return `// entry=${chunk.isEntry} name=${chunk.name}`;
                },
            },
        });
        expect(r.code.split('\n')[0]).toBe('// entry=true name=main');
        expect((received as { type: string }).type).toBe('chunk');
    });
});

describe('output — exports mode & stubs', () => {
    it("exports:'none' suppresses the entry export line", async () => {
        const r = await bundle({
            input: '/main.ts',
            fs: createMemoryFs({ '/main.ts': 'export const x = 1;' }),
            external: [],
            output: { exports: 'none' },
        });
        expect(r.code).not.toContain('export {');
    });

    it('minify is accepted and produces whitespace-minified output', async () => {
        const r = await bundle({
            input: '/main.ts',
            fs: createMemoryFs({ '/main.ts': 'export const x = 1;\nexport function f(a) {\n    return a + 1;\n}' }),
            external: [],
            output: { minify: true },
        });
        expect(r.errors).toEqual([]);
        const code = r.chunks[0].code;
        expect(code).not.toContain('\n    '); // no indentation
        expect(code).toMatch(/let \w+=1/); // whitespace stripped; local mangled; const→let
        expect(code).toContain(' as x'); // public export name preserved via alias
    });

    it('keepNames / topLevelVar are accepted with a not-implemented warning', async () => {
        const r = await bundle({
            input: '/main.ts',
            fs: createMemoryFs({ '/main.ts': 'export const x = 1;' }),
            external: [],
            output: { keepNames: true, topLevelVar: true },
        });
        expect(r.errors).toEqual([]);
        expect(r.warnings.some((w) => /keepNames is not implemented/.test(w))).toBe(true);
        expect(r.warnings.some((w) => /topLevelVar is not implemented/.test(w))).toBe(true);
    });
});
