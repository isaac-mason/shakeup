/**
 * SAME-INSTANT A/B: does the working tree emit fewer bytes than a git ref, on the same corpus?
 *
 * `pnpm sizeab` (vs HEAD) · `pnpm sizeab 80650c2` · `--corpus three`
 *
 * Why this exists rather than "run `pnpm sizeattrib` before and after". The corpora are LIVE trees —
 * crashcat is a sibling checkout under active development — so two runs minutes apart can differ
 * because the INPUT changed, not the compiler. That happened: a helper measured at -414 raw against a
 * bundle built earlier was actually -2,495 against the same sources, and the tell was that
 * rolldown's own bytes had moved between the two runs, which nothing in shakeup can cause.
 *
 * Both trees are loaded in ONE process (the ref extracted with `git archive`) and build the SAME
 * files back to back, so the corpus cannot move between the arms. Same construction as
 * `output-unchanged.ts` — that gate answers "did the bytes change", this one answers "how many".
 *
 * Reports raw, gzip AND brotli. They do not always agree: a change can win raw and lose brotli
 * (ROADMAP §2z92), and brotli is what ships.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const CORPORA: Record<string, { entry: string; external: string[] }> = {
    crashcat: { entry: '/Users/isaacmason/Development/crashcat/src/index.ts', external: ['math', 'math/shapes', 'three'] },
    three: { entry: `${import.meta.dirname}/../llm/spikes/node_modules/three/build/three.core.js`, external: [] },
};

const argv = process.argv.slice(2);
const which = argv.includes('--corpus') ? argv[argv.indexOf('--corpus') + 1] : 'crashcat';
const corpus = CORPORA[which];
if (corpus === undefined) throw new Error(`unknown corpus '${which}' — try ${Object.keys(CORPORA).join(' | ')}`);
const ref = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--corpus') ?? 'HEAD';

const root = join(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), `shakeup-ab-${ref.replace(/[^\w]/g, '')}-`));
execFileSync('bash', ['-c', `git -C ${root} archive ${ref} src | tar -x -C ${dir}`]);

const diskFs = {
    read: (i: string) => (existsSync(i) && statSync(i).isFile() ? readFileSync(i, 'utf8') : null),
    exists: (i: string) => existsSync(i),
    isFile: (i: string) => existsSync(i) && statSync(i).isFile(),
};

type Bundle = (o: unknown) => Promise<{ chunks: { code: string }[] }>;
const opts = { entry: corpus.entry, fs: diskFs, external: corpus.external, output: { minify: true, optimize: true } };
const build = async (b: Bundle): Promise<string> => (await b(opts)).chunks.map((c) => c.code).join('\n');

const baseline = ((await import(`${dir}/src/bundler/bundle.ts`)) as { bundle: Bundle }).bundle;
const working = ((await import(`${root}/src/bundler/bundle.ts`)) as { bundle: Bundle }).bundle;

const measure = (s: string): number[] => {
    const b = Buffer.from(s);
    return [b.length, gzipSync(b).length, brotliCompressSync(b).length];
};
const before = measure(await build(baseline));
const after = measure(await build(working));

const row = (label: string, xs: (number | string)[]): string =>
    label.padEnd(16) + xs.map((x) => String(x).padStart(10)).join('');
console.log(`\ncorpus: ${which}   baseline: ${ref}\n`);
console.log(row('', ['raw', 'gzip', 'brotli']));
console.log(row(ref, before));
console.log(row('working tree', after));
console.log(row('delta', after.map((x, i) => `${x - before[i] >= 0 ? '+' : ''}${x - before[i]}`)));
if (after.some((x, i) => x - before[i] > 0) && after.some((x, i) => x - before[i] < 0))
    console.log('\n  THE METRICS DISAGREE — brotli is what ships; say so out loud before landing this.');
