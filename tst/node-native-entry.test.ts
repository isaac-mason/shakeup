import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// `package.json` ships `"." -> "./src/index.ts"` — raw TypeScript. Node 24 strips types by default,
// so a consumer's `import('shakeup')` runs our source through node's OWN resolver and stripper, and
// both are stricter than the toolchain we develop under:
//
//   • resolution is exact — no extensionless `./foo`, no directory `./foo` meaning `./foo/index.ts`
//   • stripping is erase-only — no `enum`, `namespace`, or parameter properties
//
// tsx and vitest tolerate all of that, so NOTHING in this suite could see it: the package entry was
// broken for every node-24 consumer (`ERR_UNSUPPORTED_DIR_IMPORT`, then `ERR_UNSUPPORTED_TYPESCRIPT_
// SYNTAX`) while 2344 tests passed. Fixing it took 200 specifier rewrites and retiring 2 enums.
//
// This test is the only thing that can catch a regression, and it must run node as a SUBPROCESS —
// importing from inside vitest uses vitest's resolver and proves nothing.
const entry = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const loadUnderNode = (path: string): string =>
    execFileSync(
        process.execPath,
        ['-e', `import(${JSON.stringify(path)}).then(m=>console.log('OK '+Object.keys(m).length),e=>{console.log('FAIL '+e.code);process.exitCode=1})`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();

describe('the published entry loads under plain node', () => {
    it('resolves and strips with no flags', () => {
        // Not `toContain('OK')` — a FAIL line would also have to be asserted against.
        expect(loadUnderNode(entry('../src/index.ts'))).toMatch(/^OK \d+$/);
    });

    it('actually exports something, so a silently-empty module cannot pass', () => {
        // Was `> 100`, calibrated to the 148-export `export *` surface. The entry is curated now and
        // exports 16 values on purpose, so this is back to what it was always for: proving the module
        // evaluated rather than resolving to nothing. The EXACT list is pinned by
        // `tst/public-api.test.ts`, which is the stronger guard.
        const n = Number(loadUnderNode(entry('../src/index.ts')).slice(3));
        expect(n).toBeGreaterThan(5);
    });

    it('the node subentry loads too', () => {
        expect(loadUnderNode(entry('../src/node.ts'))).toMatch(/^OK \d+$/);
    });

    it('the toolchain entry (shakeup/ast) loads too', () => {
        // A second `exports` entry is a second thing that can be broken by an extensionless specifier
        // or an un-strippable construct, and it reaches a different half of the tree.
        expect(loadUnderNode(entry('../src/ast.ts'))).toMatch(/^OK \d+$/);
    });
});

// The other half of shipping raw TypeScript: a consumer TYPECHECKS our sources too, so every import
// in `src/` has to resolve for someone who installed shakeup and none of our devDependencies.
//
// `src/ast/estree.ts` imported `@typescript-eslint/types` for a single `satisfies` clause. Runtime
// was fine — it was `import type`, which node's erase-only stripping removes, and the tests above
// prove that — so nothing here could see it, and a downstream consumer hit TS2307 on a package that
// advertises zero dependencies. `src/ast.ts` even documents estree as withheld from both entries for
// exactly this reason; the import one level down defeated it. The check now lives in
// `tst/estree-names.type-check.ts`, where devDependencies are legal.
describe('src/ imports nothing a consumer would not have', () => {
    const SRC = fileURLToPath(new URL('../src', import.meta.url));

    /** every bare (non-relative, non-`node:`) specifier imported anywhere under `src/`. */
    const bareSpecifiers = (): { file: string; spec: string }[] => {
        const out: { file: string; spec: string }[] = [];
        const walk = (dir: string): void => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const p = join(dir, e.name);
                if (e.isDirectory()) {
                    walk(p);
                    continue;
                }
                if (!e.name.endsWith('.ts')) continue;
                // Import STATEMENTS only — a specifier inside a comment or a template that generates
                // code is not an import, and matching text would flag both.
                for (const m of readFileSync(p, 'utf8').matchAll(
                    /^\s*(?:import|export)\s[^\n]*?from\s+'([^']+)'|^\s*import\s+'([^']+)'/gm,
                )) {
                    const spec = m[1] ?? m[2];
                    if (spec.startsWith('.') || spec.startsWith('node:')) continue;
                    out.push({ file: p.slice(SRC.length + 1), spec });
                }
            }
        };
        walk(SRC);
        return out;
    };

    it('imports only relative paths and node: builtins', () => {
        const deps = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
            dependencies?: Record<string, string>;
        };
        // If shakeup ever takes a real runtime dependency, importing it is legal — the rule is that
        // a consumer must HAVE it, and `dependencies` is what makes that true.
        const allowed = new Set(Object.keys(deps.dependencies ?? {}));
        const offenders = bareSpecifiers().filter(({ spec }) => !allowed.has(spec.split('/').slice(0, 2).join('/')) && !allowed.has(spec));
        expect(offenders).toEqual([]);
    });
});
