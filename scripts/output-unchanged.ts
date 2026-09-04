/**
 * Does the working tree still emit byte-identical output to a git ref?
 *
 * Run: `pnpm unchanged` (vs HEAD) · `pnpm unchanged 80650c2`
 *
 * This is the gate for any change that is supposed to be purely a performance change. It is NOT the
 * same as the internal rebuild-vs-maintain parity check, which only proves the current tree is
 * self-consistent — a refactor can be self-consistent and still have changed what we emit.
 *
 * Both trees are loaded in ONE process (the baseline extracted with `git archive`), so there is no
 * cross-run drift to explain away: outputs either hash the same or they do not.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ref = process.argv[2] ?? 'HEAD';
const root = join(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), `shakeup-${ref.replace(/[^\w]/g, '')}-`));
execFileSync('bash', ['-c', `git -C ${root} archive ${ref} src | tar -x -C ${dir}`]);

const diskFs = { read: (i: string) => (existsSync(i) ? readFileSync(i, 'utf8') : null), exists: (i: string) => existsSync(i) };
const CC = '/Users/isaacmason/Development/crashcat/src/index.ts';
const THREE = join(root, 'llm/spikes/node_modules/three/build/three.core.js');

// LIBRARY-CONSUMER corpus. crashcat and three.core.js are both "everything live"; this one imports 8
// names from three's 650KB ESM build and discards the rest, which is the shape real applications have
// and the only one where tree-shaking decides the output. Staged next to `node_modules` so the bare
// `three` specifier resolves with no bundler-specific alias config — the same file is then usable by
// rolldown and esbuild in `pnpm standing`.
const CONSUMER_SRC = join(root, 'scripts/corpora/three-consumer.js');
const CONSUMER = join(root, 'llm/spikes/three-consumer-entry.js');
// MULTI-CHUNK corpus. The other three corpora build to ONE chunk each — measured, not assumed — so
// the entire chunk-graph engine (colouring, the already-loaded optimisation, facades, cross-chunk
// export wiring, chunk file naming) had no byte-level gate. This one has two dynamic branches, a
// module shared by both, a module that is both statically imported and a dynamic target, and a
// dynamic import nested inside a dynamic chunk. In-tree, so it never SKIPs.
const SPLIT = join(root, 'scripts/corpora/split/main.js');
if (existsSync(CONSUMER_SRC) && existsSync(dirname(THREE))) writeFileSync(CONSUMER, readFileSync(CONSUMER_SRC, 'utf8'));
const CASES: { name: string; opts: () => Record<string, unknown> }[] = [
    {
        name: 'crashcat minify+optimize',
        opts: () => ({
            entry: CC,
            fs: diskFs,
            external: ['math', 'math/shapes', 'three'],
            output: { minify: true, optimize: true },
        }),
    },
    {
        name: 'crashcat minify, no opt',
        opts: () => ({
            entry: CC,
            fs: diskFs,
            external: ['math', 'math/shapes', 'three'],
            output: { minify: true, optimize: false },
        }),
    },
    { name: 'crashcat plain', opts: () => ({ entry: CC, fs: diskFs, external: ['math', 'math/shapes', 'three'], output: {} }) },
    { name: 'three minify', opts: () => ({ entry: THREE, fs: diskFs, output: { minify: true } }) },
    { name: 'three-consumer minify', opts: () => ({ entry: CONSUMER, fs: diskFs, output: { minify: true } }) },
    { name: 'three-consumer plain', opts: () => ({ entry: CONSUMER, fs: diskFs, output: {} }) },
    { name: 'three plain', opts: () => ({ entry: THREE, fs: diskFs, output: {} }) },
    { name: 'split plain', opts: () => ({ entry: SPLIT, fs: diskFs, output: {} }) },
    { name: 'split minify', opts: () => ({ entry: SPLIT, fs: diskFs, output: { minify: true } }) },
    {
        // `manualChunks` forces a partition the colouring would not choose, which is the other half of
        // the engine: a group that cuts across the reachability colours.
        name: 'split manualChunks',
        opts: () => ({
            entry: SPLIT,
            fs: diskFs,
            output: { manualChunks: { vendor: [join(root, 'scripts/corpora/split/util.js')] } },
        }),
    },
];
const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * EVERY chunk, not just the entry's.
 *
 * This read `chunks[0].code`, which was harmless while every corpus produced one chunk and silently
 * wrong the moment one did not: a change that repartitioned the non-entry chunks, renamed them, or
 * moved a binding between them compared byte-identical. File NAMES are included deliberately — they
 * carry the content hash, so a chunking change shows up here even when the entry text is untouched.
 *
 * Like `entryOf` below, this script loads TWO layouts at once — the working tree and an archived git
 * ref — so it must read a result from either era. A ref from before the `BundleResult.code` alias was
 * removed still returns `code`, and reading only `chunks` there would compare `''` against real
 * output and report a spurious CHANGED (or, if both sides went empty, a spurious IDENTICAL — which is
 * worse).
 */
const entryCodeOf = (r: unknown): string => {
    const o = r as { chunks?: { fileName?: string; code?: string }[]; code?: string };
    if (o.chunks === undefined) return o.code ?? '';
    return [...o.chunks]
        .sort((a, b) => (a.fileName ?? '').localeCompare(b.fileName ?? ''))
        .map((c) => `// ${c.fileName ?? '?'}\n${c.code ?? ''}`)
        .join('\n');
};

/** `bundle.ts` moved under `src/bundler/` — a ref from before that move still has it at the old
 *  path, and this script must load BOTH sides, so it probes rather than assuming one layout. */
const entryOf = (base: string): string => {
    for (const p of ['src/bundler/bundle.ts', 'src/bundle.ts']) if (existsSync(join(base, p))) return join(base, p);
    throw new Error(`no bundle.ts under ${base}`);
};

async function main(): Promise<void> {
    const { bundle: cur } = await import(entryOf(root));
    const { bundle: base } = await import(entryOf(dir));
    console.log(`baseline: ${ref}   working tree vs that\n`);
    let allSame = true;
    for (const c of CASES) {
        if (!existsSync((c.opts() as { entry: string }).entry)) {
            console.log(`  SKIP      ${c.name} (corpus missing)`);
            continue;
        }
        const a = entryCodeOf(await base(c.opts()));
        const b = entryCodeOf(await cur(c.opts()));
        const same = a === b;
        if (!same) allSame = false;
        console.log(
            `  ${same ? 'IDENTICAL' : 'CHANGED  '} ${c.name.padEnd(26)} ${h(a)} -> ${h(b)}   ${a.length.toLocaleString()}b${same ? '' : ` -> ${b.length.toLocaleString()}b (${b.length - a.length >= 0 ? '+' : ''}${b.length - a.length})`}`,
        );
    }
    console.log(allSame ? '\nOutput unchanged.' : '\nOUTPUT CHANGED — not a pure performance change.');
    if (!allSame) process.exitCode = 1;
}
main();
