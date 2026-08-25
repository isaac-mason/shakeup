import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { setLowerSemanticMode } from '../src/scan.ts';

// The TS/JSX lowering stage no longer rebuilds the semantic from scratch. The pre-lowering one is
// MAINTAINED across the lowering — scope-owning nodes the passes mint are registered
// (`attachScopeNode`), reference movement is recorded through the traversal's `RefDelta`, and symbols
// whose declaration is erased are evicted from module scope. That removes one full `analyze()` per TS
// module: 287 -> 190 `analyze()` calls and 388,787 -> 258,810 `visit()` calls on a crashcat bundle,
// i.e. a third of all semantic walking.
//
// WHY THIS TEST EXISTS. Byte-identical output does NOT prove the maintained semantic is right — a
// stale table mostly costs optimizations, so wrong bookkeeping shows up as slightly larger output on
// SOME OTHER codebase rather than as a failure here. `'verify'` mode rebuilds ground truth after the
// lowering and throws on any divergence that could miscompile: a reference the tree contains but the
// table has lost (`dropUnused` would delete a live binding), a scope-owning node with no `nodeScope`
// entry (names resolve from the wrong scope), or a node->symbol partition mismatch.
//
// It found three real defects that review had missed, all of the same shape — a pass mutating the
// tree OUTSIDE the traversal's mutation API, so the automatic ref bookkeeping never fired:
//   * `lowerParamProps` installs `this.x = x` by assigning `body.data.body` directly (UNDER-count);
//   * `qualifyMemberRefs` rewrites `A` -> `_E.A` in place BEFORE the enclosing `replaceWith`, so the
//     `prev` it walks is already mutated (UNDER-count);
//   * `tsStrip` erases type annotations by nulling fields, never subtracting their references.
//
// Run `LOWER_SEMANTIC_MODE=verify pnpm test` to put the whole suite under this check.
const FIXTURES: Record<string, string> = {
    '/enum.ts': `export enum E { A, B = 2, C = B, D = 'x' }\nexport const used = E.A + E.C;\n`,
    '/param-props.ts': `export class P {\n  constructor(private x: number, readonly y: string, z: number) { this.w = z; }\n  w: number;\n}\n`,
    '/assertions.ts': `declare const g: { f(): number };\nexport const a = g.f()!;\nexport const b = (a as unknown) as number;\n`,
    '/type-only.ts': `import type { Thing } from './thing';\nexport interface Shape { t: Thing }\nexport type Alias = Shape;\nexport const v: Alias = { t: null as unknown as Thing };\n`,
    '/thing.ts': `export type Thing = { n: number };\nexport const marker = 1;\n`,
    '/ns.ts': `export namespace NS { export const inner = 1; export function f() { return inner; } }\nexport const q = NS.f();\n`,
    '/entry.ts': `import { used } from './enum.ts';\nimport { P } from './param-props.ts';\nimport { a, b } from './assertions.ts';\nimport { v } from './type-only.ts';\nimport { q } from './ns.ts';\nexport const out = [used, new P(1, 'y', 3), a, b, v, q];\n`,
};

const fs = {
    read: (id: string) => FIXTURES[id] ?? null,
    exists: (id: string) => id in FIXTURES,
};

async function build(mode: 'rebuild' | 'maintain' | 'verify', minify: unknown): Promise<string> {
    setLowerSemanticMode(mode);
    try {
        return (await bundle({ entry: '/entry.ts', fs, output: { minify } as never })).code;
    } finally {
        setLowerSemanticMode('maintain');
    }
}

describe('semantic maintained across the TS/JSX lowering', () => {
    for (const [label, minify] of [
        ['plain', false],
        ['minified', true],
    ] as const) {
        it(`${label}: verify mode finds no divergence that could miscompile`, async () => {
            await expect(build('verify', minify)).resolves.toBeTypeOf('string');
        });

        it(`${label}: maintaining produces byte-identical output to rebuilding`, async () => {
            const rebuilt = await build('rebuild', minify);
            const maintained = await build('maintain', minify);
            expect(maintained).toBe(rebuilt);
            expect(maintained).toContain('out');
        });
    }
});
