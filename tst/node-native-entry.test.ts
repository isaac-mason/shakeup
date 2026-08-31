import { execFileSync } from 'node:child_process';
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

    it('exports a substantial surface, so a silently-empty module cannot pass', () => {
        const n = Number(loadUnderNode(entry('../src/index.ts')).slice(3));
        expect(n).toBeGreaterThan(100);
    });

    it('the node subentry loads too', () => {
        expect(loadUnderNode(entry('../src/node/index.ts'))).toMatch(/^OK \d+$/);
    });
});
