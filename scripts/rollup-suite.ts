/**
 * Run ROLLUP'S OWN test suite against shakeup.
 *
 * Run: `pnpm rollupsuite [limit]`
 *
 * This is the standard conformance suite for this family of bundlers, and it is how rolldown
 * measures its own alignment: `packages/rollup-tests` proxies each Rollup test at Rolldown and
 * publishes the score (`src/status.md` — 1212 passed, 296 skipFailed, ~900 ignored across
 * categories). Rollup ships 2,260 cases; 808 of them are `function` tests, which BUNDLE a fixture,
 * RUN it, and let `assert` calls inside the fixture throw. That is exactly the shape worth adopting:
 * behaviour, written by the people who defined the behaviour, rather than cases we thought to write.
 *
 * Scope, deliberately narrow to start:
 *  · `function` samples only. The `form` samples compare exact output TEXT, which differs by
 *    formatting alone — rolldown ignores 163 of them for that reason and so would we.
 *  · Samples whose `_config.js` needs Rollup API surface shakeup does not model (plugins, `options`,
 *    `context`, expected `error`/`generateError`) are SKIPPED and counted, never silently dropped.
 *
 * Each case runs in a FRESH PROCESS. Sharing one is not an option: fixtures set globals, and an
 * earlier harness in this project produced a completely wrong reading by letting `globalThis` leak
 * between arms.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundle } from '../src/bundle.ts';

const ROOT = 'llm/libs/rollup/test/function/samples';
const LIMIT = Number(process.argv[2] ?? Number.POSITIVE_INFINITY);

const diskFs = {
    read: (id: string) => (existsSync(id) && statSync(id).isFile() ? readFileSync(id, 'utf8') : null),
    exists: (id: string) => existsSync(id),
};

/** Config keys that need Rollup API surface shakeup does not model. Read TEXTUALLY — executing
 *  `_config.js` would require Rollup's own `defineTest` and test context. */
const NEEDS_ROLLUP = /\b(options|plugins|context|error|generateError|solo)\s*:/;

type Bucket = { count: number; sample: string };
const buckets = new Map<string, Bucket>();
const bump = (key: string, sample: string) => {
    const b = buckets.get(key) ?? { count: 0, sample };
    b.count++;
    buckets.set(key, b);
};

const dirs = readdirSync(ROOT).filter((d) => existsSync(join(ROOT, d, '_config.js')) && existsSync(join(ROOT, d, 'main.js')));
let pass = 0;
let buildFail = 0;
let runFail = 0;
let skipped = 0;
const tmpDirs: string[] = [];

for (const d of dirs.slice(0, LIMIT)) {
    const dir = join(ROOT, d);
    if (NEEDS_ROLLUP.test(readFileSync(join(dir, '_config.js'), 'utf8'))) {
        skipped++;
        continue;
    }
    let chunks: { fileName: string; code: string; isEntry: boolean }[];
    try {
        const r = await bundle({ entry: join(dir, 'main.js'), fs: diskFs, external: [] });
        if (r.errors.length > 0) {
            buildFail++;
            bump(`BUILD ${r.errors[0].replace(/^[^:]*:\d*:?\s*/, '').slice(0, 52)}`, d);
            continue;
        }
        chunks = r.chunks;
    } catch (e) {
        buildFail++;
        bump(
            `BUILD THREW ${String((e as Error).message)
                .split('\n')[0]
                .slice(0, 46)}`,
            d,
        );
        continue;
    }

    const out = mkdtempSync(join(tmpdir(), 'rs-'));
    tmpDirs.push(out);
    writeFileSync(join(out, 'package.json'), '{"type":"module"}');
    for (const c of chunks) writeFileSync(join(out, c.fileName), c.code);
    // Rollup's fixtures call a BARE `assert`, which its harness supplies as context. A global is the
    // faithful equivalent, and it must be installed before the entry evaluates.
    const entry = chunks.find((c) => c.isEntry)?.fileName ?? 'main.js';
    writeFileSync(
        join(out, '__run.mjs'),
        `import assert from 'node:assert';\nglobalThis.assert = assert;\nawait import(${JSON.stringify(`./${entry}`)});\n`,
    );
    try {
        execFileSync(process.execPath, [join(out, '__run.mjs')], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 });
        pass++;
    } catch (e) {
        runFail++;
        const err = String((e as { stderr?: Buffer }).stderr ?? '');
        bump(`RUN ${(/(?:AssertionError|\w*Error)[^\n]*/.exec(err)?.[0] ?? 'unknown').slice(0, 52)}`, d);
    }
}

for (const t of tmpDirs) rmSync(t, { recursive: true, force: true });

const ran = pass + buildFail + runFail;
console.log(`\nrollup function suite — ${dirs.length} samples, ${skipped} skipped (need Rollup API shakeup does not model)`);
console.log(
    `ran ${ran} · PASS ${pass} (${((pass / Math.max(ran, 1)) * 100).toFixed(1)}%) · build-fail ${buildFail} · run-fail ${runFail}\n`,
);
for (const [k, b] of [...buckets.entries()].sort((a, c) => c[1].count - a[1].count).slice(0, 15)) {
    console.log(`${String(b.count).padStart(4)}  ${k}`);
    console.log(`      e.g. ${b.sample}`);
}
