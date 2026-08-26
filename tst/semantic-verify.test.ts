import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { bundle } from '../src/bundle.ts';
import { setSemanticVerify } from '../src/passes/compress/index.ts';

// Phase 0 of llm/notes/incremental-vs-rebuild-plan.md — the standing guard.
//
// `Semantic` describes the AST; passes mutate the AST; nothing used to check that the description
// still matched. That single unchecked invariant has shipped FIVE miscompiles (blockFlatten scopes,
// coalesce `STALE SYM`, synthetic ids past the table, the deconflict type-only filter, and a sixth
// still masked by `refreshFull`). Each was found by a crash or a byte diff long after the causing edit.
//
// `SEMANTIC_VERIFY=1` differentially checks the maintained semantic against a fresh `analyze()` after
// every compress round. This test runs a real corpus under it, so a pass that mutates structure
// without maintaining the semantic fails HERE, naming the stage — rather than three stages later.
//
// Verified to work: with the `blockFlatten` scope-repointing fix removed, it reports
// `sym 223 'point' claims scope 57, which does not exist in truth (UNSAFE: stale after a structural
// move)`. With the fix in place, both corpora are clean.
const ROOT = '/Users/isaacmason/Development/crashcat/src';
const ENTRY = `${ROOT}/index.ts`;
const diskFs = {
    read: (i: string) => (existsSync(i) ? readFileSync(i, 'utf8') : null),
    exists: (i: string) => existsSync(i),
};

describe.skipIf(!existsSync(ENTRY))('the maintained semantic matches the tree', () => {
    // Generous timeout on purpose: verifying every round rebuilds the whole semantic per round, so
    // this is inherently far slower than a normal build. It is a correctness guard, not a benchmark.
    it('survives a full compress of a real TypeScript corpus', { timeout: 180_000 }, async () => {
        setSemanticVerify(true);
        // Also demand ZERO stale extras on a real corpus. This is the SAFE direction (an extra live
        // symbol costs a mangled name, not correctness), so it is not a suite-wide gate — a handful of
        // synthetic branch-collapse fixtures still leave one, because `collapseIf` drops a statement
        // transactionally and lifts the survivors back out. But corpus-level zero is the bar that
        // actually mattered: it is what made the post-compress rebuild removable, and a regression here
        // would silently make it load-bearing again.
        process.env.VERIFY_EXTRAS = '1';
        try {
            const r = await bundle({
                entry: ENTRY,
                fs: diskFs,
                external: ['math', 'math/shapes', 'three'],
                output: { minify: true, optimize: true },
            } as never);
            expect((r as { code: string }).code.length).toBeGreaterThan(0);
        } finally {
            setSemanticVerify(false);
            delete process.env.VERIFY_EXTRAS;
        }
    });
});
