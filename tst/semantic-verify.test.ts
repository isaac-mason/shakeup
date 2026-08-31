import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setSemanticVerify, setVerifyExtras } from '../src/analysis/ref-facts.ts';
import { bundle } from '../src/bundle.ts';

// END-TO-END guard for the incremental semantic (llm/notes/incremental-vs-rebuild-plan.md).
//
// `Semantic` describes the AST; passes mutate the AST; for a long time nothing checked that the
// description still matched. That single unchecked invariant shipped SIX miscompiles — `blockFlatten`
// scopes (twice), the `STALE SYM` crash that disabled `coalesce`, an ambient global renamed out of
// existence, and `flowInline` moving a block-scoped reference out of its block. Each was found by a
// crash or a byte diff, long after the causing edit.
//
// Three assertions per corpus, and each earns its place:
//   1. SEMANTIC_VERIFY — the maintained semantic matches a fresh `analyze()` at every mutation
//      boundary, for every fact that could MISCOMPILE. This is what names the offending stage.
//   2. VERIFY_EXTRAS — zero STALE symbols. Safe-direction (an extra live symbol costs a mangled name,
//      not correctness), but corpus-level zero is exactly what made the post-compress rebuild
//      removable; a regression here would silently make it load-bearing again.
//   3. node --check — the bytes we emit actually parse. Bookkeeping can be self-consistent and still
//      produce broken output; two of the six miscompiles looked fine until the code was run.
//
// BOTH corpora, because they exercise different shapes: crashcat is real TypeScript (enums,
// namespaces, param properties, directives), three.core.js is large hand-written JS. Measured by
// sabotage rather than assumed — reverting a known fix and seeing which corpus notices:
//   • `blockFlatten` scope repointing  -> crashcat ONLY (three does not reproduce it)
//   • `normalize`'s while->for scope   -> BOTH
// So neither corpus subsumes the other, and dropping either would lose real coverage.
const CORPORA: [name: string, entry: string, external: string[]][] = [
    ['crashcat (TypeScript)', '/Users/isaacmason/Development/crashcat/src/index.ts', ['math', 'math/shapes', 'three']],
    ['three.core.js (JavaScript)', join(import.meta.dirname, '../llm/spikes/node_modules/three/build/three.core.js'), []],
];
const diskFs = {
    read: (i: string) => (existsSync(i) ? readFileSync(i, 'utf8') : null),
    exists: (i: string) => existsSync(i),
};

describe('the maintained semantic matches the tree, end to end', () => {
    for (const [name, entry, external] of CORPORA) {
        // Generous timeout: verifying rebuilds the whole semantic at every boundary, so this is far
        // slower than a normal build by design. It is a correctness guard, not a benchmark.
        it.skipIf(!existsSync(entry))(
            `${name}: no divergence, no stale symbols, valid output`,
            { timeout: 300_000 },
            async () => {
                setSemanticVerify(true);
                setVerifyExtras(true);
                let code: string;
                try {
                    const r = await bundle({ entry, fs: diskFs, external, output: { minify: true, optimize: true } } as never);
                    code = (r as { code: string }).code;
                } finally {
                    setSemanticVerify(false);
                    setVerifyExtras(false);
                }
                expect(code.length).toBeGreaterThan(0);

                const f = join(mkdtempSync(join(tmpdir(), 'sv-')), 'b.mjs');
                writeFileSync(f, code);
                expect(() => execFileSync(process.execPath, ['--check', f])).not.toThrow();
            },
        );
    }
});
