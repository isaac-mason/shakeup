import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import type { Fs } from '../src/fs.ts';
import { normalizePath } from '../src/fs.ts';

type SymlinkFs = Fs & { realpath(id: string): string };

function createSymlinkFs(realFiles: Record<string, string>, links: Record<string, string>): SymlinkFs {
    const files = new Map(Object.entries(realFiles));
    const linkEntries = Object.entries(links).sort((a, b) => b[0].length - a[0].length);

    const canonical = (path: string): string => {
        let cur = normalizePath(path);
        for (let i = 0; i < 32; i++) {
            let changed = false;
            for (const [link, target] of linkEntries) {
                if (cur === link) {
                    cur = normalizePath(target);
                    changed = true;
                    break;
                }
                if (cur.startsWith(link + '/')) {
                    cur = normalizePath(target + cur.slice(link.length));
                    changed = true;
                    break;
                }
            }
            if (!changed) break;
        }
        return cur;
    };

    return {
        read: (id) => files.get(canonical(id)) ?? null,
        exists: (id) => files.has(canonical(id)),
        realpath: (id) => canonical(id),
    };
}

describe('workspace: pnpm .pnpm-store layout (realpath canonicalization)', () => {
    const STORE = '/repo/node_modules/.pnpm';
    const realFiles: Record<string, string> = {
        '/repo/src/main.ts': "import { a } from 'liba';\nexport const value = a;",
    };
    realFiles[STORE + '/liba@1.0.0/node_modules/liba/package.json'] = JSON.stringify({
        name: 'liba',
        version: '1.0.0',
        exports: { '.': './index.js' },
    });
    realFiles[STORE + '/liba@1.0.0/node_modules/liba/index.js'] = "import { b } from 'libb';\nexport const a = 'liba->' + b;";
    realFiles[STORE + '/libb@1.0.0/node_modules/libb/package.json'] = JSON.stringify({
        name: 'libb',
        version: '1.0.0',
        exports: { '.': './index.js' },
    });
    realFiles[STORE + '/libb@1.0.0/node_modules/libb/index.js'] = "export const b = 'libb';";

    const links: Record<string, string> = {
        '/repo/node_modules/liba': STORE + '/liba@1.0.0/node_modules/liba',
    };
    links[STORE + '/liba@1.0.0/node_modules/libb'] = STORE + '/libb@1.0.0/node_modules/libb';

    it('resolves a store-only nested dep via realpath and executes end-to-end', () => {
        const fs = createSymlinkFs(realFiles, links);
        const result = bundle({ entry: '/repo/src/main.ts', fs });
        expect(result.errors).toEqual([]);
        expect(result.graph).not.toBeNull();

        const ids = result.graph!.modules.map((m) => m.id).sort();
        expect(ids).toEqual([
            '/repo/node_modules/.pnpm/liba@1.0.0/node_modules/liba/index.js',
            '/repo/node_modules/.pnpm/libb@1.0.0/node_modules/libb/index.js',
            '/repo/src/main.ts',
        ]);
    });

    it('produces the correct executed value through the link graph', async () => {
        const fs = createSymlinkFs(realFiles, links);
        const result = bundle({ entry: '/repo/src/main.ts', fs });
        expect(result.errors).toEqual([]);
        const mod = (await import(`data:text/javascript,${encodeURIComponent(result.code)}`)) as Record<string, unknown>;
        expect(mod.value).toBe('liba->libb');
    });
});

describe('workspace: pnpm dedup (one store file, two link paths -> one module)', () => {
    const STORE = '/repo/node_modules/.pnpm';
    const realFiles: Record<string, string> = {
        '/repo/src/main.ts': "import { a } from 'liba';\nimport { d } from 'libd';\nexport const value = a + '|' + d;",
    };
    realFiles[STORE + '/liba@1.0.0/node_modules/liba/package.json'] = JSON.stringify({
        name: 'liba',
        exports: { '.': './index.js' },
    });
    realFiles[STORE + '/liba@1.0.0/node_modules/liba/index.js'] = "import { c } from 'libc';\nexport const a = 'a:' + c;";
    realFiles[STORE + '/libd@1.0.0/node_modules/libd/package.json'] = JSON.stringify({
        name: 'libd',
        exports: { '.': './index.js' },
    });
    realFiles[STORE + '/libd@1.0.0/node_modules/libd/index.js'] = "import { c } from 'libc';\nexport const d = 'd:' + c;";
    realFiles[STORE + '/libc@1.0.0/node_modules/libc/package.json'] = JSON.stringify({
        name: 'libc',
        exports: { '.': './index.js' },
    });
    realFiles[STORE + '/libc@1.0.0/node_modules/libc/index.js'] = "export const c = 'libc';";

    const links: Record<string, string> = {
        '/repo/node_modules/liba': STORE + '/liba@1.0.0/node_modules/liba',
        '/repo/node_modules/libd': STORE + '/libd@1.0.0/node_modules/libd',
    };
    links[STORE + '/liba@1.0.0/node_modules/libc'] = STORE + '/libc@1.0.0/node_modules/libc';
    links[STORE + '/libd@1.0.0/node_modules/libc'] = STORE + '/libc@1.0.0/node_modules/libc';

    it('the doubly-linked store file collapses to a single canonical module', () => {
        const fs = createSymlinkFs(realFiles, links);
        const result = bundle({ entry: '/repo/src/main.ts', fs });
        expect(result.errors).toEqual([]);
        const ids = result.graph!.modules.map((m) => m.id);
        const libcId = '/repo/node_modules/.pnpm/libc@1.0.0/node_modules/libc/index.js';
        expect(ids.filter((id) => id === libcId)).toEqual([libcId]);
        expect(ids.length).toBe(4);
    });

    it('executes with the shared libc', async () => {
        const fs = createSymlinkFs(realFiles, links);
        const result = bundle({ entry: '/repo/src/main.ts', fs });
        expect(result.errors).toEqual([]);
        const mod = (await import(`data:text/javascript,${encodeURIComponent(result.code)}`)) as Record<string, unknown>;
        expect(mod.value).toBe('a:libc|d:libc');
    });
});

describe('workspace: install-free member resolution', () => {
    const files: Record<string, string> = {
        '/repo/package.json': JSON.stringify({
            name: 'root',
            private: true,
            workspaces: ['packages/*'],
        }),
        '/repo/packages/a/package.json': JSON.stringify({
            name: '@ws/a',
            exports: { '.': './index.js' },
        }),
        '/repo/packages/a/index.js': "import { b } from '@ws/b';\nexport const a = 'a+' + b;",
        '/repo/packages/b/package.json': JSON.stringify({
            name: '@ws/b',
            exports: { '.': './index.js' },
        }),
        '/repo/packages/b/index.js': "export const b = 'b';",
    };

    const build = () => {
        const map = new Map(Object.entries(files));
        const fs: Fs = {
            read: (id) => map.get(id) ?? null,
            exists: (id) => map.has(id),
        };
        return bundle({ entry: '/repo/packages/a/index.js', fs });
    };

    it('resolves "@ws/b" via the root `workspaces` field (no node_modules install)', () => {
        const result = build();
        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([]);
        const ids = result.graph!.modules.map((m) => m.id);
        expect(ids).toEqual(['/repo/packages/a/index.js', '/repo/packages/b/index.js']);
    });
});
