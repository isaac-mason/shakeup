// Workspace-layout resolution tests (npm-resolution.md §Workspaces).
//
//  (a) pnpm .pnpm-store layout: a symlink-simulating Fs (real-path map + link
//      table; read/exists follow links, realpath canonicalizes) driven END-TO-END
//      through bundle(). Asserts nested store-only deps resolve via realpath, and
//      that one real file reachable through two link paths collapses to ONE module
//      (graph-level realpath canonicalization).
//
//  (b) install-free workspace resolution (§Workspaces item 2): NOT IMPLEMENTED
//      yet. Pinned as an expectation group asserting CURRENT behavior (unresolved
//      bare specifier -> warning + external) so the suite is green now and flips
//      red the moment the feature lands.

import { describe, expect, it } from 'vitest';
import type { Fs } from '../src/fs.ts';
import { normalizePath } from '../src/fs.ts';
import { bundle } from '../src/bundle.ts';
import { nodeResolve } from '../src/plugins/node-resolve.ts';

/* ------------------------------------------- symlink-simulating memory Fs */

// A memory Fs over a map of REAL (canonical) paths plus a link table mapping a
// link path -> its target real path. read/exists resolve a queried path through
// the link table (longest-prefix, iteratively), then hit the real map. realpath
// returns the fully-canonicalized path (identity for non-linked paths).
type SymlinkFs = Fs & { realpath(id: string): string };

function createSymlinkFs(realFiles: Record<string, string>, links: Record<string, string>): SymlinkFs {
    const files = new Map(Object.entries(realFiles));
    // link entries sorted by descending length so the longest matching link wins.
    const linkEntries = Object.entries(links).sort((a, b) => b[0].length - a[0].length);

    // Resolve every symlinked prefix in `path` to its target, iterating until no
    // link applies (handles chained/nested links). Mirrors realpathSync.
    const canonical = (path: string): string => {
        let cur = normalizePath(path);
        // iterate to a fixed point (bounded to avoid cycles)
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

/* --------------------------------------------- (a) pnpm store layout e2e */

describe('workspace: pnpm .pnpm-store layout (realpath canonicalization)', () => {
    // /repo/node_modules/liba          -> .pnpm/liba@1.0.0/node_modules/liba  (link)
    // liba depends on libb, present ONLY in the store, linked next to liba:
    //   /repo/node_modules/.pnpm/liba@1.0.0/node_modules/libb -> .pnpm/libb@1.0.0/node_modules/libb
    // libb's real files live at /repo/node_modules/.pnpm/libb@1.0.0/node_modules/libb
    const STORE = '/repo/node_modules/.pnpm';
    const realFiles: Record<string, string> = {
        '/repo/src/main.ts': "import { a } from 'liba';\nexport const value = a;",
    };
    // liba real location (in the store)
    realFiles[STORE + '/liba@1.0.0/node_modules/liba/package.json'] = JSON.stringify({
        name: 'liba',
        version: '1.0.0',
        exports: { '.': './index.js' },
    });
    realFiles[STORE + '/liba@1.0.0/node_modules/liba/index.js'] =
        "import { b } from 'libb';\nexport const a = 'liba->' + b;";
    // libb real location (a DIFFERENT store dir)
    realFiles[STORE + '/libb@1.0.0/node_modules/libb/package.json'] = JSON.stringify({
        name: 'libb',
        version: '1.0.0',
        exports: { '.': './index.js' },
    });
    realFiles[STORE + '/libb@1.0.0/node_modules/libb/index.js'] = "export const b = 'libb';";

    const links: Record<string, string> = {
        // top-level dependency link
        '/repo/node_modules/liba': STORE + '/liba@1.0.0/node_modules/liba',
    };
    // libb linked into liba's private node_modules (store-internal)
    links[STORE + '/liba@1.0.0/node_modules/libb'] = STORE + '/libb@1.0.0/node_modules/libb';

    it('resolves a store-only nested dep via realpath and executes end-to-end', () => {
        const fs = createSymlinkFs(realFiles, links);
        const result = bundle({ entry: '/repo/src/main.ts', fs, plugins: [nodeResolve({ fs })] });
        expect(result.errors).toEqual([]);
        expect(result.graph).not.toBeNull();

        // main + liba + libb == 3 modules, each keyed by its CANONICAL store path.
        const ids = result.graph!.modules.map((m) => m.id).sort();
        expect(ids).toEqual([
            '/repo/node_modules/.pnpm/liba@1.0.0/node_modules/liba/index.js',
            '/repo/node_modules/.pnpm/libb@1.0.0/node_modules/libb/index.js',
            '/repo/src/main.ts',
        ]);
    });

    it('produces the correct executed value through the link graph', async () => {
        const fs = createSymlinkFs(realFiles, links);
        const result = bundle({ entry: '/repo/src/main.ts', fs, plugins: [nodeResolve({ fs })] });
        expect(result.errors).toEqual([]);
        const mod = (await import(
            `data:text/javascript,${encodeURIComponent(result.code)}`
        )) as Record<string, unknown>;
        expect(mod.value).toBe('liba->libb');
    });
});

/* ------------------ (a') dedup: one real file via two link paths = 1 module */

describe('workspace: pnpm dedup (one store file, two link paths -> one module)', () => {
    // libc lives once in the store and is linked into BOTH liba and libd's private
    // node_modules. main imports both liba and libd; each imports libc. The single
    // real libc/index.js must appear as ONE module (no duplicate canonical id).
    const STORE = '/repo/node_modules/.pnpm';
    const realFiles: Record<string, string> = {
        '/repo/src/main.ts':
            "import { a } from 'liba';\nimport { d } from 'libd';\nexport const value = a + '|' + d;",
    };
    realFiles[STORE + '/liba@1.0.0/node_modules/liba/package.json'] = JSON.stringify({
        name: 'liba',
        exports: { '.': './index.js' },
    });
    realFiles[STORE + '/liba@1.0.0/node_modules/liba/index.js'] =
        "import { c } from 'libc';\nexport const a = 'a:' + c;";
    realFiles[STORE + '/libd@1.0.0/node_modules/libd/package.json'] = JSON.stringify({
        name: 'libd',
        exports: { '.': './index.js' },
    });
    realFiles[STORE + '/libd@1.0.0/node_modules/libd/index.js'] =
        "import { c } from 'libc';\nexport const d = 'd:' + c;";
    // the ONE real libc
    realFiles[STORE + '/libc@1.0.0/node_modules/libc/package.json'] = JSON.stringify({
        name: 'libc',
        exports: { '.': './index.js' },
    });
    realFiles[STORE + '/libc@1.0.0/node_modules/libc/index.js'] = "export const c = 'libc';";

    const links: Record<string, string> = {
        '/repo/node_modules/liba': STORE + '/liba@1.0.0/node_modules/liba',
        '/repo/node_modules/libd': STORE + '/libd@1.0.0/node_modules/libd',
    };
    // libc linked into BOTH packages' private node_modules, pointing at ONE store dir
    links[STORE + '/liba@1.0.0/node_modules/libc'] = STORE + '/libc@1.0.0/node_modules/libc';
    links[STORE + '/libd@1.0.0/node_modules/libc'] = STORE + '/libc@1.0.0/node_modules/libc';

    it('the doubly-linked store file collapses to a single canonical module', () => {
        const fs = createSymlinkFs(realFiles, links);
        const result = bundle({ entry: '/repo/src/main.ts', fs, plugins: [nodeResolve({ fs })] });
        expect(result.errors).toEqual([]);
        const ids = result.graph!.modules.map((m) => m.id);
        const libcId = '/repo/node_modules/.pnpm/libc@1.0.0/node_modules/libc/index.js';
        // exactly one libc module despite two independent reach paths
        expect(ids.filter((id) => id === libcId)).toEqual([libcId]);
        expect(ids.length).toBe(4); // main + liba + libd + libc
    });

    it('executes with the shared libc', async () => {
        const fs = createSymlinkFs(realFiles, links);
        const result = bundle({ entry: '/repo/src/main.ts', fs, plugins: [nodeResolve({ fs })] });
        expect(result.errors).toEqual([]);
        const mod = (await import(
            `data:text/javascript,${encodeURIComponent(result.code)}`
        )) as Record<string, unknown>;
        expect(mod.value).toBe('a:libc|d:libc');
    });
});

/* ------------- (b) install-free workspace resolution: NOT IMPLEMENTED yet */

// §Workspaces item 2: read root package.json#workspaces globs, build a
// member-name -> dir map, consult it BEFORE the node_modules walk. This lets a
// pure source snapshot (ZERO node_modules) bundle in the browser. It is NOT
// implemented. These tests pin the CURRENT behavior so the suite stays green and
// flips red when the feature lands (mirrors the KNOWN-LIMITATION exemplar pattern).
describe('workspace: install-free member resolution (NOT IMPLEMENTED — pinned)', () => {
    // Monorepo: root declares workspaces; two members import each other by name;
    // there are NO node_modules and NO symlinks. A real install-free resolver would
    // resolve "@ws/b" -> /repo/packages/b via the workspaces map.
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
        return bundle({ entry: '/repo/packages/a/index.js', fs, plugins: [nodeResolve({ fs })] });
    };

    it('KNOWN LIMITATION: member "@ws/b" is treated as unresolved external (warn), not resolved', () => {
        const result = build();
        // The cross-member bare import cannot resolve without node_modules or a
        // workspaces map, so core externalizes it with the loud warning.
        expect(result.warnings).toContainEqual(
            "'@ws/b' (imported by '/repo/packages/a/index.js') could not be resolved — " +
                'treated as external. Add it to `external` or use a resolver plugin to silence this.',
        );
        // No hard error (bare specifiers externalize, not error).
        expect(result.errors).toEqual([]);
    });

    it('KNOWN LIMITATION: the workspace member does NOT enter the graph', () => {
        const result = build();
        const ids = result.graph!.modules.map((m) => m.id);
        expect(ids).not.toContain('/repo/packages/b/index.js');
        // only the entry module is in the graph
        expect(ids).toEqual(['/repo/packages/a/index.js']);
    });

    it('WILL FLIP when install-free workspace resolution lands (§Workspaces item 2)', () => {
        // Sentinel: when the feature is implemented, "@ws/b" resolves and this
        // expectation must be inverted (member resolves, no warning, 2 modules).
        const result = build();
        const resolvedMemberInGraph = result
            .graph!.modules.some((m) => m.id === '/repo/packages/b/index.js');
        expect(resolvedMemberInGraph).toBe(false);
    });
});
