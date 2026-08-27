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
];
const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function main(): Promise<void> {
    const { bundle: cur } = await import(join(root, 'src/bundle.ts'));
    const { bundle: base } = await import(join(dir, 'src/bundle.ts'));
    console.log(`baseline: ${ref}   working tree vs that\n`);
    let allSame = true;
    for (const c of CASES) {
        if (!existsSync((c.opts() as { entry: string }).entry)) {
            console.log(`  SKIP      ${c.name} (corpus missing)`);
            continue;
        }
        const a = (await base(c.opts())).code as string;
        const b = (await cur(c.opts())).code as string;
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
