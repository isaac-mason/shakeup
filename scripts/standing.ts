/**
 * Where shakeup stands against the other bundlers, on a real corpus.
 *
 * Run: `pnpm standing` (crashcat) · `pnpm standing three` · `ROUNDS=15 pnpm standing`
 *
 * Design notes — every one of these is a lesson this repo paid for:
 *
 *  · BUNDLER TO BUNDLER. shakeup was long compared against `oxc-minify`, a single-file MINIFIER that
 *    does no scan/resolve/link/tree-shake/chunk/render. That inflated the gap ~2x and left the
 *    bundling stages with no counterpart. rolldown is the honest peer (Rust, and uses oxc inside);
 *    esbuild is a useful second.
 *  · PAIRED, WITH A CONTROL. This machine runs at load 9-45 with no CPU pinning, and labs reports a
 *    comparison resolution of ~+-33% here. Rounds alternate the tools and include shakeup measured
 *    against ITSELF; if that control does not land near 1.000x the numbers are not admissible.
 *  · CPU ALONGSIDE WALL. `cpu/wall` IS the parallelism factor. rolldown gets ~2.1x from spawning a
 *    task per module; shakeup is serial. Reporting wall alone attributes their threading to a
 *    constant-factor gap that is not there. CAVEAT: `process.cpuUsage()` only sees THIS process, so
 *    it is meaningful for shakeup (pure JS) and rolldown (napi, in-process threads) but NOT for
 *    esbuild, which does its work in a spawned binary — its CPU reads near zero and is suppressed.
 *  · SIZE IS PART OF THE STANDING. brotli is what actually ships.
 *  · VALIDITY GATE. Every output goes through `node --check`; a fast bundler that emits broken JS is
 *    not a faster bundler. shakeup shipped three miscompiles once because its own parser was the
 *    only oracle.
 */
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { bundle as shakeupBundle } from '../src/bundle.ts';

type Corpus = { name: string; entry: string; external: string[] };
const CORPORA: Record<string, Corpus> = {
    crashcat: { name: 'crashcat', entry: '/Users/isaacmason/Development/crashcat/src/index.ts', external: ['math', 'math/shapes', 'three'] },
    three: { name: 'three.core.js', entry: `${import.meta.dirname}/../llm/spikes/node_modules/three/build/three.core.js`, external: [] },
};

const which = process.argv[2] ?? 'crashcat';
const corpus = CORPORA[which];
if (corpus === undefined) throw new Error(`unknown corpus '${which}' (have: ${Object.keys(CORPORA).join(', ')})`);
if (!existsSync(corpus.entry)) throw new Error(`corpus entry not found: ${corpus.entry}`);

const diskFs = { read: (i: string) => (existsSync(i) ? readFileSync(i, 'utf8') : null), exists: (i: string) => existsSync(i) };
const gz = (s: string) => gzipSync(Buffer.from(s), { level: 9 }).length;
const br = (s: string) => brotliCompressSync(Buffer.from(s)).length;

type Run = { code: string; wallMs: number; cpuMs: number };
type Tool = { name: string; countsCpu: boolean; run: () => Promise<Run> };

async function timed(f: () => Promise<string>, countsCpu: boolean): Promise<Run> {
    const c0 = process.cpuUsage();
    const t0 = process.hrtime.bigint();
    const code = await f();
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const c = process.cpuUsage(c0);
    return { code, wallMs, cpuMs: countsCpu ? (c.user + c.system) / 1000 : 0 };
}

const TOOLS: Tool[] = [
    {
        name: 'shakeup',
        countsCpu: true,
        run: () => timed(async () => (await shakeupBundle({ entry: corpus.entry, fs: diskFs, external: corpus.external, output: { minify: true, optimize: true } } as never)).code, true),
    },
    {
        name: 'rolldown',
        countsCpu: true, // napi: native threads live in THIS process
        run: () =>
            timed(async () => {
                const { rolldown } = await import('rolldown');
                const b = await rolldown({ input: corpus.entry, external: corpus.external, logLevel: 'silent' });
                const out = await b.generate({ format: 'esm', minify: true });
                await b.close?.();
                return out.output.map((o: { code?: string }) => o.code ?? '').join('\n');
            }, true),
    },
    {
        name: 'esbuild',
        countsCpu: false, // work happens in a spawned binary; this process's CPU is not the story
        run: () =>
            timed(async () => {
                const esbuild = await import('esbuild');
                const r = await esbuild.build({
                    entryPoints: [corpus.entry], bundle: true, write: false, minify: true,
                    format: 'esm', external: corpus.external, logLevel: 'silent',
                });
                return r.outputFiles.map((f) => f.text).join('\n');
            }, false),
    },
];

/** Independent oracle: node must accept the output as a module. */
function assertValid(name: string, code: string, dir: string): string {
    const p = join(dir, `${name}.mjs`);
    writeFileSync(p, code);
    try {
        execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
        return 'ok';
    } catch (e) {
        const err = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e);
        return `INVALID — ${/SyntaxError.*/.exec(err)?.[0] ?? err.slice(0, 80)}`;
    }
}

async function main(): Promise<void> {
    const ROUNDS = Number(process.env.ROUNDS ?? 10);
    const dir = mkdtempSync(join(tmpdir(), 'shakeup-standing-'));
    console.log(`corpus: ${corpus.name}  (${corpus.entry})`);
    // Load is worth printing: at load >~10 the comparisons below widen and the control starts to drift.
    console.log(`rounds: ${ROUNDS}   node ${process.versions.node}   ${cpus().length} cores   load ${loadavg()[0].toFixed(2)}\n`);

    // Correctness + size pass first (one run each), so a broken output is caught before timing it.
    const first: Record<string, Run> = {};
    for (const t of TOOLS) {
        try {
            first[t.name] = await t.run();
        } catch (e) {
            console.log(`  ${t.name}: FAILED — ${(e as Error).message.split('\n')[0]}`);
        }
    }
    console.log(`${'tool'.padEnd(10)}${'raw'.padStart(12)}${'gzip'.padStart(10)}${'brotli'.padStart(10)}   validity`);
    for (const t of TOOLS) {
        const r = first[t.name];
        if (r === undefined) continue;
        console.log(`${t.name.padEnd(10)}${r.code.length.toLocaleString().padStart(12)}${gz(r.code).toLocaleString().padStart(10)}${br(r.code).toLocaleString().padStart(10)}   ${assertValid(t.name, r.code, dir)}`);
    }

    // Timing: alternate tools each round, and measure shakeup a second time as the control.
    const live = TOOLS.filter((t) => first[t.name] !== undefined);
    const wall: Record<string, number[]> = {}; const cpu: Record<string, number[]> = {};
    for (const t of live) { wall[t.name] = []; cpu[t.name] = []; }
    wall['(control)'] = []; cpu['(control)'] = [];
    for (let w = 0; w < 2; w++) for (const t of live) await t.run();
    for (let r = 0; r < ROUNDS; r++) {
        const order = live.slice(r % live.length).concat(live.slice(0, r % live.length));
        for (const t of order) { const x = await t.run(); wall[t.name].push(x.wallMs); cpu[t.name].push(x.cpuMs); }
        const c = await TOOLS[0].run(); wall['(control)'].push(c.wallMs); cpu['(control)'].push(c.cpuMs);
    }
    const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2; };

    console.log(`\n${'tool'.padEnd(10)}${'wall'.padStart(10)}${'cpu'.padStart(10)}${'cpu/wall'.padStart(10)}${'vs shakeup'.padStart(16)}`);
    const base = med(wall['shakeup']);
    for (const t of live) {
        const w = med(wall[t.name]); const c = med(cpu[t.name]);
        const par = t.countsCpu ? (c / w).toFixed(2) + 'x' : '   n/a';
        const rel = t.name === 'shakeup' ? '—' : `${(base / w).toFixed(2)}x faster`;
        console.log(`${t.name.padEnd(10)}${(w.toFixed(1) + 'ms').padStart(10)}${(t.countsCpu ? c.toFixed(1) + 'ms' : 'n/a').padStart(10)}${par.padStart(10)}${rel.padStart(16)}`);
    }
    const ctrl = med(wall['(control)']);
    const ratio = base / ctrl;
    console.log(`\ncontrol (shakeup vs itself): ${ctrl.toFixed(1)}ms  ratio ${ratio.toFixed(3)}x`);
    console.log(Math.abs(ratio - 1) > 0.08
        ? '  CONTROL DRIFTED >8% — treat the comparisons above as indicative only.'
        : '  Control is flat; comparisons are admissible.');
    const rd = live.find((t) => t.name === 'rolldown');
    if (rd !== undefined) {
        const rw = med(wall['rolldown']); const rc = med(cpu['rolldown']);
        console.log(`\nrolldown gets ${(rc / rw).toFixed(2)}x from parallelism; shakeup ${(med(cpu['shakeup']) / base).toFixed(2)}x.`);
        console.log(`So the ${(base / rw).toFixed(2)}x wall gap is ~${((rc / rw) / (med(cpu['shakeup']) / base)).toFixed(2)}x threading and ~${(base / rw / ((rc / rw) / (med(cpu['shakeup']) / base))).toFixed(2)}x constant factor — the latter is the tractable half.`);
    }
}
main();
