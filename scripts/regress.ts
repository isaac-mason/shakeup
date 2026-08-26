// Did a change actually make the bundler faster? Compare the WORKING TREE against a git ref.
//
// Run: `pnpm regress <ref>`   e.g. `pnpm regress HEAD~5`   (default: the merge-base with origin/main)
//
// WHY THIS EXISTS. `pnpm standing` compares shakeup against rolldown/esbuild IN ONE PROCESS, which is
// right for a cross-tool ratio but useless for "did my change help": two bundler trees co-resident in
// one process penalise the allocation-heavier one, and that trap already inflated a reported speedup
// ~2x once (see llm/notes/perf-findings.md §7). Self-comparison needs the two versions to never share
// a heap.
//
// So: the baseline is checked out into a git WORKTREE, and every measurement runs in its OWN process.
// Trials ALTERNATE (A,B,A,B,…) so any drift in machine load spreads across both sides instead of
// landing on whichever ran second. A CONTROL trial compares the working tree against ITSELF; if that
// does not come out near 1.00, the machine is too noisy and the comparison is not admissible — which
// is the check that has been missing every time a micro-win failed to show up end to end.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const ref = process.argv[2] ?? execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: ROOT, encoding: 'utf8' }).trim();
const TRIALS = Number(process.env.TRIALS ?? 7);
const CORPUS = process.env.CORPUS ?? '/Users/isaacmason/Development/crashcat/src/index.ts';
const EXTERNAL = ['math', 'math/shapes', 'three'];

/** One measurement process: warm up, then report the MEDIAN of several bundles from that tree. */
const RUNNER = `
import { existsSync, readFileSync } from 'node:fs';
import { bundle } from './src/bundle.ts';
const diskFs = { read: (i) => (existsSync(i) ? readFileSync(i, 'utf8') : null), exists: (i) => existsSync(i) };
const opts = { entry: ${JSON.stringify(CORPUS)}, fs: diskFs, external: ${JSON.stringify(EXTERNAL)}, output: { minify: true, optimize: true } };
// Warm the JIT hard before measuring: the first bundles in a process are dominated by tsx compile and
// tier-up, and that noise is what made a same-tree control drift 11%.
for (let i = 0; i < 8; i++) await bundle(opts);
let best = Infinity;
for (let i = 0; i < 12; i++) {
    const t0 = process.hrtime.bigint();
    await bundle(opts);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
}
// MIN, not median: the fastest run is the one least disturbed by whatever else the machine was doing.
console.log(best.toFixed(2));
`;

function prepare(dir: string): void {
    writeFileSync(join(dir, '_regress_runner.mjs'), RUNNER);
}

/** Median wall-ms for one tree, measured in a FRESH process. */
function measure(dir: string): number {
    const out = execFileSync('npx', ['tsx', '_regress_runner.mjs'], { cwd: dir, encoding: 'utf8' });
    return Number(out.trim().split('\n').pop());
}

const wt = join(tmpdir(), `shakeup-regress-${ref.replace(/[^\w]/g, '_')}`);
rmSync(wt, { recursive: true, force: true });
execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, ref], { cwd: ROOT });
if (!existsSync(join(wt, 'node_modules'))) symlinkSync(join(ROOT, 'node_modules'), join(wt, 'node_modules'));
prepare(wt);
prepare(ROOT);

try {
    const now: number[] = [];
    const base: number[] = [];
    const ctrl: number[] = [];
    process.stdout.write(`baseline ${ref}\ntrials   `);
    for (let i = 0; i < TRIALS; i++) {
        // ALTERNATE, and take the control from the same alternation so it sees the same conditions.
        now.push(measure(ROOT));
        base.push(measure(wt));
        ctrl.push(measure(ROOT));
        process.stdout.write('.');
    }
    const med = (a: number[]): number => [...a].sort((x, y) => x - y)[a.length >> 1];
    const n = med(now);
    const b = med(base);
    const c = med(ctrl);
    const control = c / n;
    console.log('\n');
    console.log(`  baseline (${ref})   ${b.toFixed(1)} ms`);
    console.log(`  working tree        ${n.toFixed(1)} ms`);
    console.log(`  control (tree/tree) ${control.toFixed(3)}x`);
    console.log('');
    const speedup = b / n;
    const verdict =
        Math.abs(control - 1) > 0.03
            ? `CONTROL DRIFTED ${((control - 1) * 100).toFixed(1)}% — machine too noisy, NOT admissible`
            : `${speedup.toFixed(3)}x  (${speedup > 1 ? '-' : '+'}${Math.abs((1 - 1 / speedup) * 100).toFixed(1)}% wall)`;
    console.log(`  working tree vs baseline: ${verdict}`);
} finally {
    rmSync(join(ROOT, '_regress_runner.mjs'), { force: true });
    execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT });
}
