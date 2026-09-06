/**
 * DOES THE BUNDLE STILL DO THE SAME THING? A differential EXECUTION gate on a real corpus.
 *
 * Every other gate here checks a proxy. `unchanged` compares bytes against HEAD, `standing` runs
 * `node --check` (which is SYNTAX only — it would pass a bundle that throws on the first line),
 * `sizeattrib` measures shape, and `rollupsuite` executes but only rollup's fixtures, which are a
 * few lines each. Nothing RUNS a large real bundle, and nothing has ever compared shakeup's runtime
 * behaviour against rolldown's on one.
 *
 * That gap is not theoretical. Five commits on 2026-09-06 changed crashcat's output by ~25KB —
 * namespace elision, rewriting 433 `ns.foo` reads to bare bindings, inlining enum members, dropping
 * enum objects — and every one of them was validated by size, by `node --check`, and by fixtures
 * that do not resemble the code being changed. A wrong binding in a rewritten member read produces a
 * bundle that parses perfectly and computes the wrong answer.
 *
 * WHAT IT DOES. Bundles crashcat three ways — shakeup plain, shakeup minify+optimize, and ROLLDOWN
 * as the oracle — then runs the SAME driver against each and compares the results exactly. The
 * driver is a deterministic physics simulation using only the bundle's PUBLIC exports: build a
 * world, drop a stack of bodies, step them, WAKE them through the public setters, step again, and
 * read back every body's position, rotation and velocity. Any divergence in binding resolution, evaluation order, or dropped
 * initialisation shows up as different numbers.
 *
 * The minified arm matters as much as the plain one: mangling, compression and the cosmetic tier all
 * run only there, and `unchanged` can only tell you that output MOVED, never that it still works.
 *
 * Usage: `pnpm runtimediff`
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundle as shakeupBundle } from '../src/bundler/bundle.ts';

const CRASHCAT = '/Users/isaacmason/Development/crashcat';
const ENTRY = `${CRASHCAT}/src/index.ts`;
const EXTERNAL = ['math', 'math/shapes', 'three'];
const OUT = join(import.meta.dirname, '..', 'llm', '.runtimediff');

const diskFs = {
    read: (i: string) => (existsSync(i) && statSync(i).isFile() ? readFileSync(i, 'utf8') : null),
    exists: (i: string) => existsSync(i),
    isFile: (i: string) => existsSync(i) && statSync(i).isFile(),
};

/**
 * The simulation, written against the bundle's PUBLIC API only — the same surface a consumer gets,
 * which is the point: a test importing crashcat's internals would not exercise the bundling.
 *
 * Deterministic by construction. No `Math.random`, no `Date`, a fixed timestep, and positions laid
 * out arithmetically, so the only thing that can change the output is the bundle itself. Numbers are
 * rounded to 6 decimal places before hashing: the arms differ in mangled names and statement order,
 * never in arithmetic, and full float printing would make a legitimate re-association of a sum look
 * like a miscompile.
 */
const DRIVER = `
import { readFileSync } from 'node:fs';
import * as cc from './bundle.mjs';

cc.registerAll();

const settings = cc.createWorldSettings();
const BP_MOVING = cc.addBroadphaseLayer(settings);
const BP_STATIC = cc.addBroadphaseLayer(settings);
const L_MOVING = cc.addObjectLayer(settings, BP_MOVING);
const L_STATIC = cc.addObjectLayer(settings, BP_STATIC);
cc.enableCollision(settings, L_MOVING, L_MOVING);
cc.enableCollision(settings, L_MOVING, L_STATIC);
const world = cc.createWorld(settings);

// A floor, a stack of boxes that will settle onto it, and spheres that roll off the stack — enough
// contact, sleeping and constraint work to touch a wide slice of the bundle.
const floor = cc.box.create({ halfExtents: [50, 1, 50] });
cc.rigidBody.create(world, { shape: floor, objectLayer: L_STATIC, motionType: cc.MotionType.STATIC, position: [0, -1, 0] });

const boxShape = cc.box.create({ halfExtents: [0.5, 0.5, 0.5] });
const sphereShape = cc.sphere.create({ radius: 0.5 });
const bodies = [];
for (let i = 0; i < 12; i++) {
    bodies.push(cc.rigidBody.create(world, {
        shape: boxShape,
        objectLayer: L_MOVING,
        motionType: cc.MotionType.DYNAMIC,
        position: [((i % 3) - 1) * 0.6, 1 + i * 1.2, ((i % 2) - 0.5) * 0.4],
    }));
}
for (let i = 0; i < 6; i++) {
    bodies.push(cc.rigidBody.create(world, {
        shape: sphereShape,
        objectLayer: L_MOVING,
        motionType: cc.MotionType.DYNAMIC,
        position: [2 + i * 0.3, 4 + i * 0.9, -1.5 + i * 0.2],
    }));
}

// Let the stack settle so bodies actually go to sleep, then WAKE them through the public setters.
// Deliberate coverage: setPosition/setQuaternion/addForce/addTorque each take a 'wake' flag and call
// the module-level 'wake' function, which is the exact shape a rewritten namespace read can capture
// (sleep_ns.wake(world, body) becoming wake(world, body) inside a function whose parameter is named
// 'wake'). Without these calls the arms agreed even with that miscompile deliberately reintroduced —
// the workload simply never reached the code. A differential gate is only as good as what it runs.
for (let frame = 0; frame < 120; frame++) cc.updateWorld(world, undefined, 1 / 60);

cc.rigidBody.setPosition(world, bodies[0], [0.25, 6, 0.25], true);
cc.rigidBody.setQuaternion(world, bodies[1], [0, 0.3826834, 0, 0.9238795], true);
cc.rigidBody.setLinearVelocity(world, bodies[2], [1.5, 0, -0.5], true);
cc.rigidBody.addForce(world, bodies[3], [0, 250, 0], true);
cc.rigidBody.addTorque(world, bodies[4], [0, 12, 0], true);

for (let frame = 0; frame < 120; frame++) cc.updateWorld(world, undefined, 1 / 60);

const r = (n) => (Object.is(n, -0) ? 0 : Number(n.toFixed(6)));
const state = bodies.map((b) => {
    const mp = b.motionProperties;
    const vel = mp === undefined || mp === null ? [] : [...mp.linearVelocity, ...mp.angularVelocity];
    return [...b.position, ...b.quaternion, ...vel].map(r);
});
process.stdout.write(JSON.stringify(state));
`;

type Arm = { name: string; code: string };

async function buildArms(): Promise<Arm[]> {
    const arms: Arm[] = [];
    for (const [name, output] of [
        ['shakeup plain', {}],
        ['shakeup minify+optimize', { minify: true, optimize: true }],
    ] as const) {
        const r = (await shakeupBundle({ entry: ENTRY, fs: diskFs, external: EXTERNAL, output } as never)) as {
            errors: string[];
            chunks: { code: string }[];
        };
        if (r.errors.length > 0) throw new Error(`${name} failed: ${r.errors.join(', ')}`);
        arms.push({ name, code: r.chunks.map((c) => c.code).join('\n') });
    }
    const { rolldown } = await import('rolldown');
    const b = await rolldown({ input: ENTRY, external: EXTERNAL, logLevel: 'silent' });
    const out = await b.generate({ format: 'esm' });
    await b.close?.();
    arms.push({ name: 'rolldown (oracle)', code: out.output.map((o: { code?: string }) => o.code ?? '').join('\n') });
    return arms;
}

function run(arm: Arm, i: number): { ok: true; state: string } | { ok: false; err: string } {
    const dir = join(OUT, `arm${i}`);
    mkdirSync(dir, { recursive: true });
    // `math` and `three` are EXTERNAL, so the driver resolves them the way crashcat itself does.
    // A symlink rather than a copy — node walks up for `node_modules`, but this directory is not
    // under crashcat, so it needs one of its own.
    const nm = join(dir, 'node_modules');
    if (!existsSync(nm)) symlinkSync(join(CRASHCAT, 'node_modules'), nm, 'dir');
    writeFileSync(join(dir, 'bundle.mjs'), arm.code);
    writeFileSync(join(dir, 'run.mjs'), DRIVER);
    try {
        const out = execFileSync(process.execPath, [join(dir, 'run.mjs')], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 120_000,
        });
        return { ok: true, state: out.toString() };
    } catch (e) {
        const err = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e);
        // Each line TRUNCATED: a minified arm's stack frame quotes the offending source line, which
        // for a one-line bundle is the entire 400KB of it.
        const lines = err
            .trim()
            .split('\n')
            .map((l) => (l.length > 140 ? `${l.slice(0, 140)}…` : l));
        return { ok: false, err: lines.slice(0, 6).join('\n      ') };
    }
}

rmSync(OUT, { recursive: true, force: true });
const arms = await buildArms();
const results = arms.map((a, i) => ({ arm: a, res: run(a, i) }));

console.log(`\ndifferential EXECUTION — crashcat, 18 bodies, 240 frames, woken mid-run\n`);
let failed = false;
const oracle = results[results.length - 1];
if (!oracle.res.ok) {
    console.log(`  ORACLE FAILED TO RUN — ${oracle.arm.name}\n      ${oracle.res.err}`);
    failed = true;
}
for (const { arm, res } of results) {
    if (!res.ok) {
        console.log(`  ${arm.name.padEnd(26)} DID NOT RUN\n      ${res.err}`);
        failed = true;
        continue;
    }
    if (!oracle.res.ok) continue;
    const same = res.state === oracle.res.state;
    if (!same) failed = true;
    console.log(`  ${arm.name.padEnd(26)} ${same ? 'agrees with the oracle' : 'DIVERGES from the oracle'}`);
    if (!same) {
        const a = JSON.parse(res.state) as number[][];
        const b = JSON.parse(oracle.res.state) as number[][];
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            if (JSON.stringify(a[i]) === JSON.stringify(b[i])) continue;
            console.log(`      body ${i}: ${JSON.stringify(a[i])}\n         vs ${JSON.stringify(b[i])}`);
            break;
        }
    }
}
console.log(failed ? '\nRUNTIME DIFFERENTIAL FAILED\n' : '\nAll arms agree.\n');
process.exit(failed ? 1 : 0);
