/**
 * Run ROLLUP'S OWN test suite against shakeup.
 *
 * Run: `pnpm rollupsuite [limit]` · `pnpm rollupsuite --list <bucket-substring>` to name the samples
 * in a failure bucket.
 *
 * This is the standard conformance suite for this family of bundlers, and it is how rolldown
 * measures its own alignment: `packages/rollup-tests` proxies each Rollup test at Rolldown and
 * publishes the score (`src/status.md` — 1212 passed, 296 skipFailed, ~900 ignored across
 * categories). Rollup ships 2,260 cases; 808 of them are `function` tests, which BUNDLE a fixture,
 * RUN it, and let `assert` calls inside the fixture throw. Behaviour, written by the people who
 * defined the behaviour, rather than cases we thought to write.
 *
 * `_config.js` is EXECUTED, not pattern-matched. The first version of this harness read the file as
 * text and skipped anything mentioning `options:` or `plugins:`, which threw away 322 of 766
 * samples — including every one that exercises the plugin API shakeup deliberately models on
 * Rollup's. Executing it is easy: each file is plain CommonJS whose only free name is `defineTest`,
 * and shimming that is one line. What the config asks for is then honoured directly:
 *
 *   options.input/external/plugins/treeshake  → the corresponding shakeup option
 *   error / generateError                     → the build MUST fail
 *   exports(ns)                               → called on the entry's namespace, in the child
 *   runtimeError(err)                         → the module MUST throw, and the error is checked
 *   skip / solo                               → honoured as Rollup honours them
 *
 * Everything else is skipped with a NAMED REASON and counted. Nothing is dropped silently — a
 * suite that quietly ignores what it cannot do reports a score for a test set it did not run.
 *
 * Each case runs in a FRESH PROCESS. Sharing one is not an option: fixtures set globals, and an
 * earlier harness in this project produced a completely wrong reading by letting `globalThis` leak
 * between arms. The child re-`require`s `_config.js` for itself, which is what lets `exports()` and
 * `runtimeError()` — real functions, not data — run against the real namespace.
 *
 * The `form` samples (exact output TEXT) stay out of scope: they differ by formatting alone, which
 * is why rolldown ignores 163 of them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bundle } from '../src/bundle.ts';

const ROOT = 'llm/libs/rollup/test/function/samples';
const args = process.argv.slice(2);
const listIdx = args.indexOf('--list');
const LIST = listIdx >= 0 ? args[listIdx + 1] : null;
const LIMIT = Number(args.find((a) => /^\d+$/.test(a)) ?? Number.POSITIVE_INFINITY);

const diskFs = {
    read: (id: string) => (existsSync(id) && statSync(id).isFile() ? readFileSync(id, 'utf8') : null),
    exists: (id: string) => existsSync(id),
};

type Config = {
    description?: string;
    skip?: boolean;
    solo?: boolean;
    options?: Record<string, unknown>;
    error?: unknown;
    generateError?: unknown;
    runtimeError?: unknown;
    exports?: unknown;
    code?: unknown;
    warnings?: unknown;
    logs?: unknown;
    context?: unknown;
    before?: unknown;
    after?: unknown;
};

// `_config.js` is CommonJS and its only free name is `defineTest`. Rollup's own harness supplies it
// as a global that returns its argument unchanged.
(globalThis as Record<string, unknown>).defineTest = (t: unknown) => t;
const req = createRequire(resolve('scripts/rollup-suite.ts'));

type Bucket = { count: number; samples: string[] };
const buckets = new Map<string, Bucket>();
const bump = (key: string, sample: string) => {
    const b = buckets.get(key) ?? { count: 0, samples: [] };
    b.count++;
    if (b.samples.length < 200) b.samples.push(sample);
    buckets.set(key, b);
};
const skips = new Map<string, Bucket>();
const skip = (reason: string, sample: string) => {
    const b = skips.get(reason) ?? { count: 0, samples: [] };
    b.count++;
    if (b.samples.length < 200) b.samples.push(sample);
    skips.set(reason, b);
};

const dirs = readdirSync(ROOT).filter((d) => existsSync(join(ROOT, d, '_config.js')));

/** Load a sample's config, or null if the file itself cannot be evaluated. */
function loadConfig(dir: string): Config | null {
    try {
        const p = resolve(join(dir, '_config.js'));
        delete req.cache[p];
        return req(p) as Config;
    } catch {
        return null;
    }
}

/** Why shakeup cannot run this sample as written — or null if it can. Every reason is a STRUCTURAL
 *  limit (a non-goal, or an assertion about text rather than behaviour), never "this looks hard". */
function skipReason(c: Config): string | null {
    if (c.skip === true) return 'the sample marks itself `skip`';
    const o = (c.options ?? {}) as Record<string, unknown>;
    const out = (o.output ?? {}) as Record<string, unknown>;
    const format = out.format as string | undefined;
    // shakeup emits ES modules and nothing else — a stated non-goal, not a gap.
    if (format !== undefined && format !== 'es' && format !== 'esm' && format !== 'module') return `output format '${format}'`;
    if (o.preserveModules === true || out.preserveModules === true) return 'output.preserveModules';
    if (typeof c.code === 'function') return 'asserts on generated TEXT (`code`)';
    if (c.warnings !== undefined || c.logs !== undefined) return 'asserts on warnings/logs';
    if (typeof c.context === 'object' && c.context !== null) return 'needs a custom `context` global';
    if (typeof c.before === 'function' || typeof c.after === 'function') return 'needs before/after hooks';
    return null;
}

let pass = 0;
let buildFail = 0;
let runFail = 0;
const tmpDirs: string[] = [];
const loaded = dirs.map((d) => ({ d, c: loadConfig(join(ROOT, d)) }));
const soloed = loaded.filter((x) => x.c?.solo === true);
const selected = (soloed.length > 0 ? soloed : loaded).slice(0, LIMIT);

for (const { d, c } of selected) {
    const dir = join(ROOT, d);
    if (c === null) {
        skip('`_config.js` could not be evaluated', d);
        continue;
    }
    const why = skipReason(c);
    if (why !== null) {
        skip(why, d);
        continue;
    }
    const o = (c.options ?? {}) as Record<string, unknown>;
    // An expected build error is a PASS when it happens and a failure when it does not — the same
    // polarity as an assertion, so these samples run rather than being skipped.
    const wantsError = c.error !== undefined || c.generateError !== undefined;
    // `input` comes in three shapes in this suite: a path, an array of paths, and a name→path map
    // (multi-entry). shakeup bundles ONE entry here, so a multi-entry sample is skipped by name
    // rather than silently reduced to its first entry.
    const rawInput = o.input;
    let input: string | undefined;
    if (typeof rawInput === 'string') input = rawInput;
    else if (Array.isArray(rawInput)) {
        if (rawInput.length > 1) {
            skip('multiple entry points', d);
            continue;
        }
        input = rawInput[0] as string;
    } else if (typeof rawInput === 'object' && rawInput !== null) {
        const vals = Object.values(rawInput as Record<string, string>);
        if (vals.length > 1) {
            skip('multiple entry points', d);
            continue;
        }
        input = vals[0];
    }
    const entry = input === undefined ? join(dir, 'main.js') : resolve(dir, input);
    if (!existsSync(entry)) {
        skip('entry does not exist (multi-input or virtual)', d);
        continue;
    }

    let chunks: { fileName: string; code: string; isEntry: boolean }[];
    try {
        const r = await bundle({
            entry,
            fs: diskFs,
            external: (o.external ?? []) as string[],
            plugins: o.plugins as never,
            treeshake: o.treeshake === false ? false : undefined,
        });
        if (r.errors.length > 0) {
            if (wantsError) {
                pass++;
                continue;
            }
            buildFail++;
            bump(`BUILD ${r.errors[0].replace(/^[^:]*:\d*:?\s*/, '').slice(0, 52)}`, d);
            continue;
        }
        chunks = r.chunks;
    } catch (e) {
        if (wantsError) {
            pass++;
            continue;
        }
        buildFail++;
        bump(
            `BUILD THREW ${String((e as Error).message)
                .split('\n')[0]
                .slice(0, 46)}`,
            d,
        );
        continue;
    }
    if (wantsError) {
        buildFail++;
        // Split by WHICH error Rollup expects. `error` is a failure during `rollup()` — the build,
        // which shakeup does — so a miss there is a missing validation. `generateError` is a failure
        // during `generate()`, and most of those validate an output format shakeup does not emit.
        bump(
            c.error !== undefined
                ? 'NO ERROR: build validation missing (`error`)'
                : 'NO ERROR: output validation missing (`generateError`)',
            d,
        );
        continue;
    }

    const out = mkdtempSync(join(tmpdir(), 'rs-'));
    tmpDirs.push(out);
    writeFileSync(join(out, 'package.json'), '{"type":"module"}');
    for (const ch of chunks) writeFileSync(join(out, ch.fileName), ch.code);
    const entryFile = chunks.find((ch) => ch.isEntry)?.fileName ?? 'main.js';
    // The child re-loads `_config.js` so `exports()` and `runtimeError()` — functions, which cannot
    // cross a process boundary — run in the process that holds the real namespace. Rollup's fixtures
    // also call a BARE `assert`, which its harness supplies as context; a global is the faithful
    // equivalent and must be installed before the entry evaluates.
    writeFileSync(
        join(out, '__run.mjs'),
        [
            "import assert from 'node:assert';",
            "import { createRequire } from 'node:module';",
            'globalThis.assert = assert;',
            'globalThis.defineTest = (t) => t;',
            `const cfg = createRequire(${JSON.stringify(`${out}/`)})(${JSON.stringify(resolve(dir, '_config.js'))});`,
            'let ns, thrown = null;',
            `try { ns = await import(${JSON.stringify(`./${entryFile}`)}); } catch (e) { thrown = e; }`,
            'if (cfg.runtimeError) {',
            '  if (thrown === null) throw new Error("expected a runtime error, module evaluated cleanly");',
            '  await cfg.runtimeError(thrown);',
            '} else if (thrown !== null) throw thrown;',
            // Rollup generates these fixtures with `exports: 'auto', format: 'cjs'` and hands
            // `config.exports` the resulting `module.exports` (`test/function/index.js:107-160`).
            // shakeup emits ES modules, so the namespace has to be reshaped into what `auto` would
            // have produced or the assertions test the wrong object: a Module namespace is frozen,
            // null-prototype and never callable, which is why `exports()`, `exports.hasOwnProperty`
            // and `String(exports)` all failed on samples that are not actually broken.
            'let exp;',
            'if (ns !== undefined) {',
            '  const keys = Object.keys(ns);',
            "  exp = keys.length === 1 && keys[0] === 'default' ? ns.default : Object.assign({}, ns);",
            '}',
            'if (cfg.exports) await cfg.exports(exp);',
        ].join('\n'),
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

if (LIST !== null) {
    for (const [k, b] of [...buckets, ...skips]) if (k.includes(LIST)) console.log(`${k}\n  ${b.samples.join('\n  ')}`);
    process.exit(0);
}

const skipped = [...skips.values()].reduce((n, b) => n + b.count, 0);
const ran = pass + buildFail + runFail;
console.log(`\nrollup function suite — ${selected.length} samples, ${skipped} skipped`);
console.log(
    `ran ${ran} · PASS ${pass} (${((pass / Math.max(ran, 1)) * 100).toFixed(1)}%) · build-fail ${buildFail} · run-fail ${runFail}\n`,
);
console.log('SKIPPED, by reason:');
for (const [k, b] of [...skips.entries()].sort((a, c) => c[1].count - a[1].count))
    console.log(`${String(b.count).padStart(4)}  ${k}`);
console.log('\nFAILURES, by bucket:');
for (const [k, b] of [...buckets.entries()].sort((a, c) => c[1].count - a[1].count).slice(0, 20)) {
    console.log(`${String(b.count).padStart(4)}  ${k}`);
    console.log(`      e.g. ${b.samples[0]}`);
}
