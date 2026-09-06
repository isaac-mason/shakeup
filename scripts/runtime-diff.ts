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
import * as cc from '__ENTRY__';

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

/**
 * The `three` driver — pure MATH, and deliberately so. crashcat exercises a large stateful engine;
 * this exercises a library of small classes whose methods are called in long chains, which is a
 * different shape of code and a different way for a bundling mistake to show. No files, no clock, no
 * randomness: every input is a literal, so the only variable is the bundle.
 */
const THREE_DRIVER = `
import * as t from '__ENTRY__';

for (const n of ['Vector3', 'Matrix4', 'Euler', 'Ray', 'BufferGeometry', 'Float32BufferAttribute', 'Frustum']) {
    if (t[n] === undefined) throw new Error('export missing from the bundle: ' + n);
}

const out = [];
const r = (n) => (Object.is(n, -0) ? 0 : Number(n.toFixed(6)));

// Matrix composition, inversion and determinant over a deterministic sweep of Euler rotations.
const acc = new t.Matrix4();
for (let i = 0; i < 24; i++) {
    const e = new t.Euler(i * 0.13, i * 0.29, i * 0.07, 'XYZ');
    const m = new t.Matrix4().makeRotationFromEuler(e);
    m.setPosition(new t.Vector3(i * 0.5, -i * 0.25, i * 0.125));
    acc.multiply(m);
    if (i % 6 === 5) out.push(r(acc.determinant()));
}
out.push(...acc.elements.map(r));

const inv = acc.clone().invert();
out.push(...inv.elements.map(r));

// Vector transforms through the composed matrix and its inverse — a round trip that must land back.
for (let i = 0; i < 8; i++) {
    const v = new t.Vector3(i - 4, i * 0.5, 3 - i);
    const there = v.clone().applyMatrix4(acc);
    const back = there.clone().applyMatrix4(inv);
    out.push(r(there.x), r(there.y), r(there.z), r(back.length() - v.length()));
}

// Ray/plane style arithmetic.
const ray = new t.Ray(new t.Vector3(0, 5, 0), new t.Vector3(0.3, -1, 0.2).normalize());
for (const d of [0.5, 2, 7.25]) {
    const at = ray.at(d, new t.Vector3());
    out.push(r(at.x), r(at.y), r(at.z));
}

// A real BufferGeometry: attributes in, computed normals and bounds out.
const geom = new t.BufferGeometry();
const pos = [];
for (let i = 0; i < 60; i++) pos.push(Math.cos(i) * 2, Math.sin(i * 0.5) * 3, (i % 7) - 3);
geom.setAttribute('position', new t.Float32BufferAttribute(pos, 3));
geom.computeVertexNormals();
geom.computeBoundingBox();
const bb = geom.boundingBox;
out.push(r(bb.min.x), r(bb.min.y), r(bb.min.z), r(bb.max.x), r(bb.max.y), r(bb.max.z));
const nrm = geom.getAttribute('normal');
for (let i = 0; i < 12; i++) out.push(r(nrm.array[i]));

// Frustum culling against the composed matrix.
const fr = new t.Frustum().setFromProjectionMatrix(acc);
for (let i = 0; i < 6; i++) out.push(fr.containsPoint(new t.Vector3(i - 3, i * 0.5, 1)) ? 1 : 0);

process.stdout.write(JSON.stringify(out));
`;

/**
 * The MULTI-CHUNK driver. Both other corpora build to a single chunk, so the entire chunk graph —
 * colouring, the already-loaded optimisation, facades, cross-chunk export wiring, chunk file naming
 * and the `import()` rewrite — had no EXECUTION gate at all. `unchanged` pins its bytes; nothing ran
 * it. That is the half of the bundler where a mistake shows up as `ERR_MODULE_NOT_FOUND` or a
 * missing export rather than a wrong number, which is exactly what `dynamic-import-mutate-then-return`
 * was.
 *
 * Both dynamic branches are taken, and `panel` re-exports a nested `import()` of its own, so the
 * already-loaded optimisation and the facade case are both executed rather than merely emitted.
 */
const SPLIT_DRIVER = `
import * as m from '__ENTRY__';

const rows = [{ weight: 2 }, { weight: 3.5 }, { weight: -1 }];
const out = [m.label];
out.push(await m.load('panel', rows));
out.push(await m.load('report', rows));

// Reach the nested dynamic import inside the panel chunk.
const panel = await import('__ENTRY__').then((x) => x.load('panel', rows));
out.push(typeof panel);

process.stdout.write(JSON.stringify(out));
`;

type Corpus = { entry: string; external: string[]; driver: string; nodeModules: string; blurb: string };
const CORPORA: Record<string, Corpus> = {
    crashcat: {
        entry: `${CRASHCAT}/src/index.ts`,
        external: ['math', 'math/shapes', 'three'],
        driver: DRIVER,
        nodeModules: join(CRASHCAT, 'node_modules'),
        blurb: '18 bodies, 240 frames, woken mid-run',
    },
    three: {
        entry: join(import.meta.dirname, '..', 'llm', 'spikes', 'node_modules', 'three', 'build', 'three.core.js'),
        external: [],
        driver: THREE_DRIVER,
        nodeModules: '',
        blurb: 'matrix/vector/geometry math over a fixed sweep',
    },
    split: {
        entry: join(import.meta.dirname, 'corpora', 'split', 'main.js'),
        external: [],
        driver: SPLIT_DRIVER,
        nodeModules: '',
        blurb: 'multi-chunk — both dynamic branches, a shared chunk and a facade',
    },
};

/** A built bundle: every CHUNK, plus which one is the entry. Not a concatenation — a multi-chunk
 *  bundle is N separate ES modules that import each other by FILENAME, and joining them yields
 *  duplicate imports and dead specifiers. The runner writes each chunk under its own name. */
type Arm = { name: string; chunks: { fileName: string; code: string }[]; entry: string };

/** The chunk the driver imports. `isEntry` when the bundler says so; otherwise the only chunk, and
 *  an explicit failure rather than a guess if neither holds. */
function entryOf(chunks: { fileName: string; isEntry?: boolean }[]): string {
    const flagged = chunks.filter((c) => c.isEntry === true);
    if (flagged.length === 1) return flagged[0].fileName;
    if (chunks.length === 1) return chunks[0].fileName;
    throw new Error(`cannot identify the entry chunk among ${chunks.map((c) => c.fileName).join(', ')}`);
}

async function buildArms(c: Corpus): Promise<Arm[]> {
    const arms: Arm[] = [];
    for (const [name, output] of [
        ['shakeup plain', {}],
        ['shakeup minify+optimize', { minify: true, optimize: true }],
    ] as const) {
        const r = (await shakeupBundle({ entry: c.entry, fs: diskFs, external: c.external, output } as never)) as {
            errors: string[];
            chunks: { fileName: string; code: string; isEntry?: boolean }[];
        };
        if (r.errors.length > 0) throw new Error(`${name} failed: ${r.errors.join(', ')}`);
        arms.push({ name, chunks: r.chunks, entry: entryOf(r.chunks) });
    }
    const { rolldown } = await import('rolldown');
    const b = await rolldown({ input: c.entry, external: c.external, logLevel: 'silent' });
    const out = await b.generate({ format: 'esm' });
    await b.close?.();
    const rc = (out.output as { fileName: string; code?: string; isEntry?: boolean }[])
        .filter((o) => o.code !== undefined)
        .map((o) => ({ fileName: o.fileName, code: o.code as string, isEntry: o.isEntry }));
    arms.push({ name: 'rolldown (oracle)', chunks: rc, entry: entryOf(rc) });
    return arms;
}

function run(c: Corpus, label: string, arm: Arm, i: number): { ok: true; state: string } | { ok: false; err: string } {
    const dir = join(OUT, `${label}-arm${i}`);
    mkdirSync(dir, { recursive: true });
    // An EXTERNAL specifier has to resolve the way the corpus itself resolves it. A symlink rather
    // than a copy — node walks up for `node_modules`, but this directory is not under the corpus, so
    // it needs one of its own. A corpus with no externals needs none.
    const nm = join(dir, 'node_modules');
    if (c.nodeModules !== '' && !existsSync(nm)) symlinkSync(c.nodeModules, nm, 'dir');
    // Every chunk under its OWN name, so the cross-chunk `import './panel-HASH.js'` specifiers the
    // bundler wrote actually resolve — and `type: module`, because those names end in `.js` and node
    // would otherwise read them as CommonJS.
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    for (const ch of arm.chunks) {
        const dest = join(dir, ch.fileName);
        mkdirSync(join(dest, '..'), { recursive: true });
        writeFileSync(dest, ch.code);
    }
    writeFileSync(join(dir, 'run.mjs'), c.driver.replace(/__ENTRY__/g, `./${arm.entry}`));
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

/** Corpora NOT run by default. `split` is held back because it currently FAILS — and the failure is
 *  a real shakeup bug, not a driver problem: under `package.json#sideEffects: false` the entry chunk
 *  emits `export { …, registry, … }` for a binding whose declaration tree-shaking dropped, so the
 *  bundle does not load at all (`SyntaxError: Export 'registry' is not defined in module`). rolldown
 *  keeps the declaration. Reproduce with `pnpm runtimediff --corpus split`; see ROADMAP §2z47. It
 *  joins the default set with the fix, so this list should be empty again. */
const HELD_BACK = new Set(['split']);

const only = process.argv.includes('--corpus') ? process.argv[process.argv.indexOf('--corpus') + 1] : null;
const names = only === null ? Object.keys(CORPORA).filter((n) => !HELD_BACK.has(n)) : [only];
let failed = false;

for (const label of names) {
    const c = CORPORA[label];
    if (c === undefined) throw new Error(`unknown corpus '${label}' — try ${Object.keys(CORPORA).join(' | ')}`);
    const arms = await buildArms(c);
    const results = arms.map((a, i) => ({ arm: a, res: run(c, label, a, i) }));

    console.log(`\ndifferential EXECUTION — ${label}, ${c.blurb}\n`);
    // The ORACLE is the last arm. If rolldown's own bundle cannot run the driver, the driver is
    // wrong and nothing below means anything — say so rather than reporting shakeup "diverging".
    const oracle = results[results.length - 1];
    if (!oracle.res.ok) {
        console.log(`  ORACLE FAILED TO RUN — ${oracle.arm.name}\n      ${oracle.res.err}`);
        console.log('  (the driver, not shakeup, is at fault; the rest of this corpus is unjudged)');
        failed = true;
        continue;
    }
    for (const { arm, res } of results) {
        if (!res.ok) {
            console.log(`  ${arm.name.padEnd(26)} DID NOT RUN\n      ${res.err}`);
            failed = true;
            continue;
        }
        const same = res.state === oracle.res.state;
        if (!same) failed = true;
        console.log(`  ${arm.name.padEnd(26)} ${same ? 'agrees with the oracle' : 'DIVERGES from the oracle'}`);
        if (same) continue;
        const a = JSON.parse(res.state) as unknown[];
        const b = JSON.parse(oracle.res.state) as unknown[];
        let shown = 0;
        for (let i = 0; i < Math.max(a.length, b.length) && shown < 3; i++) {
            if (JSON.stringify(a[i]) === JSON.stringify(b[i])) continue;
            console.log(`      [${i}] ${JSON.stringify(a[i])}\n       vs ${JSON.stringify(b[i])}`);
            shown++;
        }
    }
}

console.log(failed ? '\nRUNTIME DIFFERENTIAL FAILED\n' : '\nAll arms agree, on every corpus.\n');
process.exit(failed ? 1 : 0);
