// Where does a bundle's wall time go, by STAGE. `pnpm stages`
//
// Two things this does that ad-hoc probes kept getting wrong, both of which produced hours of false
// conclusions before they were noticed:
//
//  1. IT MEASURES A COMPILED BUILD, NOT `tsx`. Running the source through `tsx` transpiles it with
//     esbuild's `keepNames: true`, which injects a `__name(fn, "fn")` call — a runtime
//     `defineProperty` — at EVERY function definition. Measured on crashcat that is 7.2% of the CPU
//     profile (`__name` 155ms + the `name` setter 163ms of 4,395ms) and **14% of wall**: 240ms under
//     `tsx` versus 206ms compiled. Every number recorded before 2026-09-01 was taken through `tsx`
//     and is inflated by roughly that much.
//
//  2. IT ATTRIBUTES ASYNC WORK. Rolling profile samples up to an ancestor `buildGraph` frame puts
//     ~75% of the bundle in "outside any stage", because `buildGraph` is async and the call tree does
//     not survive `await`. Each sample is instead rolled up to its OUTERMOST `/src/` frame, which is
//     the entry point of that async continuation and accounts for 100% of samples.
//
// A flat self-time listing hid both: the `keepNames` overhead was split across two files where it
// read as ~2% noise in each, and the stage mixture made every stage look uniformly cool.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

type Frame = { functionName: string; url: string };
type ProfileNode = { id: number; callFrame: Frame; children?: number[] };
type Profile = { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] };

const CORPUS = {
    entry: process.env.STAGES_ENTRY ?? '/Users/isaacmason/Development/crashcat/src/index.ts',
    external: (process.env.STAGES_EXTERNAL ?? 'math,math/shapes,three').split(',').filter(Boolean),
};
/** Compress is a separate investigation with its own dynamics; default to the BUNDLER alone. */
const MINIFY = process.env.STAGES_MINIFY === '1';
const ROUNDS = Number(process.env.STAGES_ROUNDS ?? 11);

const med = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const ms = (us: number): string => (us / 1000).toFixed(0);

/** Compile the bundler the way it would actually ship — no `keepNames`, no loader in the hot path. */
async function compileSubject(dir: string): Promise<string> {
    const out = join(dir, 'subject.mjs');
    await build({
        entryPoints: ['src/bundler/bundle.ts'],
        bundle: true,
        format: 'esm',
        platform: 'node',
        outfile: out,
        keepNames: false,
        packages: 'external',
        logLevel: 'error',
    });
    return out;
}

/** Outermost `/src/` frame for a sample — the async-safe stage attribution. */
function outermostSrc(id: number, byId: Map<number, ProfileNode>, parent: Map<number, number>): string {
    let cur: number | undefined = id;
    let last = '(node internals / gc)';
    let guard = 0;
    while (cur !== undefined && guard++ < 500) {
        const n = byId.get(cur);
        if (n === undefined) break;
        const u = n.callFrame.url;
        if (u.includes('subject.mjs')) last = n.callFrame.functionName || '(anon)';
        cur = parent.get(cur);
    }
    return last;
}

async function main(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'shakeup-stages-'));
    try {
        const subject = await compileSubject(dir);
        const { bundle } = (await import(subject)) as { bundle: (o: unknown) => Promise<unknown> };
        const { existsSync, readFileSync } = await import('node:fs');
        const fs = {
            read: (i: string) => (existsSync(i) ? readFileSync(i, 'utf8') : null),
            exists: (i: string) => existsSync(i),
        };
        const opts = { ...CORPUS, fs, output: { minify: MINIFY, optimize: false } };

        for (let i = 0; i < 4; i++) await bundle(opts); // warm past the JIT tiers

        // WALL, with a control arm. A control that is not ~1.00x means the number is not admissible;
        // three measurements were discarded for exactly this before the script existed.
        const W: number[] = [];
        const C: number[] = [];
        for (let i = 0; i < ROUNDS; i++) {
            let t = performance.now();
            await bundle(opts);
            W.push(performance.now() - t);
            t = performance.now();
            await bundle(opts);
            C.push(performance.now() - t);
        }
        const wall = med(W);
        const ctl = med(C) / wall;

        // PROFILE
        const session = new Session();
        session.connect();
        const post = (m: string, p?: object): Promise<Record<string, unknown>> =>
            new Promise((res, rej) => session.post(m, p as never, (e, r) => (e ? rej(e) : res(r as never))));
        await post('Profiler.enable');
        await post('Profiler.setSamplingInterval', { interval: 150 });
        await post('Profiler.start');
        for (let i = 0; i < ROUNDS; i++) await bundle(opts);
        const profile = ((await post('Profiler.stop')) as { profile: Profile }).profile;

        const byId = new Map(profile.nodes.map((n) => [n.id, n]));
        const parent = new Map<number, number>();
        for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
        const self = new Map<number, number>();
        for (let i = 0; i < profile.samples.length; i++)
            self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0));

        const byStage = new Map<string, number>();
        const inner = new Map<string, Map<string, number>>();
        let total = 0;
        for (const [id, t] of self) {
            const stage = outermostSrc(id, byId, parent);
            byStage.set(stage, (byStage.get(stage) ?? 0) + t);
            total += t;
            const n = byId.get(id)!;
            const key = n.callFrame.functionName || '(anon)';
            const m = inner.get(stage) ?? new Map<string, number>();
            m.set(key, (m.get(key) ?? 0) + t);
            inner.set(stage, m);
        }

        console.log(`\ncorpus  ${CORPUS.entry}`);
        console.log(`config  minify=${MINIFY} optimize=false   subject=COMPILED (keepNames off)`);
        console.log(
            `\nwall ${wall.toFixed(0)}ms   control ${ctl.toFixed(3)}x ${ctl > 1.05 || ctl < 0.95 ? '<- NOT ADMISSIBLE' : '(ok)'}`,
        );
        console.log(`\nstages (inclusive, async-safe, 100% of ${ms(total)}ms sampled):\n`);
        for (const [k, v] of [...byStage.entries()].sort((a, b) => b[1] - a[1]))
            console.log(`${ms(v).padStart(7)}ms ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`);

        for (const [stage, v] of [...byStage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
            const m = inner.get(stage)!;
            console.log(`\n  --- inside ${stage} (${ms(v)}ms) ---`);
            for (const [k, t] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10))
                console.log(`  ${ms(t).padStart(7)}ms ${((t / v) * 100).toFixed(1).padStart(5)}%  ${k}`);
        }

        // Guard: if a build helper ever shows up again, say so rather than let it hide as noise.
        const helper = [...self.entries()].reduce((acc, [id, t]) => {
            const fn = byId.get(id)?.callFrame.functionName ?? '';
            return fn === '__name' || fn === 'set name' || fn === 'set filename' ? acc + t : acc;
        }, 0);
        if (helper > total * 0.005)
            console.log(
                `\nWARNING: build-helper overhead ${ms(helper)}ms (${((helper / total) * 100).toFixed(1)}%) — is the subject compiled?`,
            );
        writeFileSync(join(dir, 'last.cpuprofile'), JSON.stringify(profile));
        console.log(`\nprofile: ${join(dir, 'last.cpuprofile')}`);
    } finally {
        // Leave the profile behind for inspection; only the built subject is disposable.
        rmSync(join(dir, 'subject.mjs'), { force: true });
    }
}

await main();
