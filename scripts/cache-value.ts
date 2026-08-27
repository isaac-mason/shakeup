// What is the per-module COMPRESS cache actually worth?
//
// shakeup runs compress during SCAN, per module, and stores the compressed AST in `CachedParse`.
// rolldown instead minifies the whole chunk at generate time, AFTER tree-shaking. That divergence is
// the root of several design constraints — compress cannot be freely reordered, and the module AST
// cannot be mutated to drop dead statements, because the next build reuses it under different
// liveness. "We can't do what rolldown does" kept being asserted rather than measured. This measures
// it, so the question is settled with a number instead of an argument.
//
// A = today (compress cached).  B = compress re-run on every cached module — what an incremental
// rebuild would cost if compress moved after tree-shaking.
//
// INTERLEAVED in ONE process so JIT and GC drift hit both arms equally. A sequential version of this
// reported B as FASTER than A (adding work made it quicker), which is how noisy separate-process
// timing is here — the median moved 2x between runs.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createBuildContext } from '../src/bundle.ts';

const fs = {
    read: (i: string) => (existsSync(i) ? readFileSync(i, 'utf8') : null),
    exists: (i: string) => existsSync(i),
    realpath: (i: string) => (existsSync(i) ? realpathSync(i) : i),
};
const ENTRY = '/Users/isaacmason/Development/crashcat/src/index.ts';
if (!existsSync(ENTRY)) {
    console.log('  crashcat corpus not present — skipped');
    process.exit(0);
}
const opts = { entry: ENTRY, fs, external: ['math', 'math/shapes', 'three'] };
const MODES: [string, object][] = [
    ['minify: true  (watch + production build)', { minify: true, optimize: true }],
    ['minify: false (the usual watch build)   ', { minify: false, optimize: true }],
];


const med = (a: number[]): number => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
};

for (const [label, output] of MODES) {
    const ctx = createBuildContext({ ...opts, output } as never);
    await ctx.rebuild(); // warm the caches
    const A: number[] = [];
    const B: number[] = [];
    for (let i = 0; i < 25; i++) {
        for (const [recompress, out] of [[false, A], [true, B]] as [boolean, number[]][]) {
            if (recompress) process.env.RECOMPRESS_CACHED = '1';
            else delete process.env.RECOMPRESS_CACHED;
            ctx.invalidate(ENTRY);
            const t = performance.now();
            await ctx.rebuild();
            out.push(performance.now() - t);
        }
    }
    ctx.close();
    const a = med(A);
    const b = med(B);
    console.log(`  ${label}`);
    console.log(`     cached ${a.toFixed(1)} ms   re-run ${b.toFixed(1)} ms   →  worth ${(b - a).toFixed(1)} ms  (${(b / a).toFixed(2)}x)`);
}
