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
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bundle } from '../src/bundler/bundle.ts';

// ABSOLUTE, as Rollup's own runner is: its fixtures build ids with `path.join(__dirname, …)` and
// compare plugin arguments against them, so a relative root silently fails those comparisons. Four
// samples were failing on that alone — `custom-path-resolver-sync` returns `false` for anything it
// does not recognise, so a relative entry specifier became "entry cannot be external".
const ROOT = resolve('llm/libs/rollup/test/function/samples');
// A FIXTURE'S floating promise must not kill the run. Several samples do
//
//     const p = this.load({ id });                  // stored, deliberately not awaited yet
//     assert.strictEqual(this.getModuleInfo(id).x, null);   // may throw first
//
// and when the assert throws, `p` — already rejected — is never awaited. Node's default is to
// terminate the process on an unhandled rejection, which took the WHOLE SUITE down on one sample and
// made everything after it unmeasurable. The sample still fails through its own assertion path; this
// only stops one fixture's bookkeeping from ending the run.
process.on('unhandledRejection', () => {});

const args = process.argv.slice(2);
const listIdx = args.indexOf('--list');
const LIST = listIdx >= 0 ? args[listIdx + 1] : null;
const LIMIT = Number(args.find((a) => /^\d+$/.test(a)) ?? Number.POSITIVE_INFINITY);
// `--only <substring>` runs just the matching samples, through the SAME pipeline — a 12-minute suite
// is not a debugging loop. Never a substitute for the full run before committing.
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

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

/**
 * Samples that fail on a feature ROLLDOWN ITSELF does not implement, read from rolldown's own list of
 * Rollup tests it ignores (`packages/rollup-tests/src/ignored-by-unsupported-features.md`, 49
 * categories).
 *
 * shakeup's bundler targets rolldown, so a Rollup feature rolldown declines is a non-goal here too —
 * `syntheticNamedExports` is the clean case: rolldown says outright it is not supported, and four of
 * our failures are its samples. Counting those as shakeup gaps overstated the deficit by HALF: 38 of
 * 74 failures were in this file.
 *
 * They still RUN, and still count in `ran`. This only re-LABELS a failure, so nothing is hidden and
 * no coverage is lost — the day shakeup passes one it simply leaves the bucket. Skipping them would
 * have been the easy version and the dishonest one.
 *
 * Degrades to empty when the vendored rolldown is absent.
 */
function rolldownNonGoals(): Map<string, string> {
    const out = new Map<string, string>();
    const md = 'llm/libs/rolldown/packages/rollup-tests/src/ignored-by-unsupported-features.md';
    if (!existsSync(md)) return out;
    let section = '';
    for (const line of readFileSync(md, 'utf8').split('\n')) {
        if (line.startsWith('### ')) section = line.slice(4).trim();
        const m = /^\s*-\s*rollup@(?:form|function)@(.+?):/.exec(line);
        // The last `@` segment is the sample directory; earlier ones are Rollup's own grouping.
        if (m !== null && section !== '') out.set(m[1].split('@').pop() as string, section);
    }
    return out;
}
const NON_GOALS = rolldownNonGoals();
let nonGoal = 0;

type Bucket = { count: number; samples: string[] };
const buckets = new Map<string, Bucket>();
const bump = (key: string, sample: string) => {
    // A failure on a feature ROLLDOWN ITSELF declines is re-labelled, not hidden: it still ran, still
    // counts in `ran`, and leaves this bucket the day shakeup passes it. See {@link rolldownNonGoals}.
    const nonGoalReason = NON_GOALS.get(sample);
    const k = nonGoalReason === undefined ? key : `ROLLDOWN NON-GOAL — ${nonGoalReason}`;
    if (nonGoalReason !== undefined) nonGoal++;
    const b = buckets.get(k) ?? { count: 0, samples: [] };
    b.count++;
    if (b.samples.length < 200) b.samples.push(sample);
    buckets.set(k, b);
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
    // `treeshake.moduleSideEffects` is IMPLEMENTED now and forwarded below, so those samples run
    // again. The other options a sample may set — `propertyReadSideEffects`,
    // `tryCatchDeoptimization`, `unknownGlobalSideEffects`, `preset` — tune how AGGRESSIVE shaking
    // is within a module that is already included. Ignoring them leaves us more conservative,
    // which costs bytes and not correctness, and those samples pass today; skipping on them
    // measured 3 fewer passes for nothing.
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
const selected = (soloed.length > 0 ? soloed : loaded).filter((x) => ONLY === null || x.d.includes(ONLY)).slice(0, LIMIT);

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
    let inputName: string | undefined;
    if (typeof rawInput === 'string') input = rawInput;
    else if (Array.isArray(rawInput)) {
        if (rawInput.length > 1) {
            skip('multiple entry points', d);
            continue;
        }
        input = rawInput[0] as string;
    } else if (typeof rawInput === 'object' && rawInput !== null) {
        const entries = Object.entries(rawInput as Record<string, string>);
        if (entries.length > 1) {
            skip('multiple entry points', d);
            continue;
        }
        // KEEP THE KEY. It is the entry NAME, and `[name]` in `output.entryFileNames` substitutes it
        // — which is the whole point of `input-name-validation*`, where the name is `/test` or
        // `../test` and rollup rejects it. Collapsing to `Object.values(...)[0]` threw the name away,
        // so those samples could never fail the way they are meant to.
        [inputName, input] = entries[0];
    }
    const entry = input === undefined ? join(dir, 'main.js') : resolve(dir, input);
    if (!existsSync(entry)) {
        skip('entry does not exist (multi-input or virtual)', d);
        continue;
    }

    let chunks: { fileName: string; code: string; isEntry: boolean }[];
    try {
        const r = await bundle({
            ...(inputName === undefined ? { entry } : { input: { [inputName]: entry } }),
            fs: diskFs,
            external: (o.external ?? []) as string[],
            plugins: o.plugins as never,
            // Forward the whole option. Only `treeshake: false` used to survive, so an OBJECT was
            // dropped silently and the behavioural difference it asked for was reported as an
            // unexplained assertion failure.
            treeshake: o.treeshake as never,
            // FORWARD `options.output`. It used to be dropped, which silently made every sample that
            // asserts on an output OPTION unfailable-and-unpassable: `entryFileNames`,
            // `chunkFileNames`, interop and validation cases never reached the bundler at all, so 38
            // `generateError` samples were being reported as shakeup gaps when the harness had thrown
            // the input away. `skipReason` still filters the formats and `preserveModules` we do not
            // implement, so nothing unsupported gets through here.
            // ADAPT ROLLUP'S DEFAULTS, as rolldown's own Rollup-test harness does
            // (`packages/rollup-tests/test/function/index.js:106` force-enables `keepNames` for the
            // `class-name-conflict` samples, "to avoid other tests snapshot changed").
            //
            // `generatedCode.symbols` is a DEFAULT the two oracles disagree on: Rollup's is `false`
            // (`es5`), rolldown's is `true` (`GeneratedCodeOptions::default() == es2015()`), and
            // shakeup's bundler follows rolldown. Left alone, three samples failed on the presence of
            // `Symbol.toStringTag` and nothing else, which measures the disagreement rather than
            // shakeup. A sample that sets the option itself still wins.
            output: {
                generatedCode: { symbols: false },
                ...((o.output ?? {}) as Record<string, unknown>),
            } as never,
            // Rollup's own runner does `process.chdir(directory)` before each sample
            // (`test/function/index.js:72`), so a plugin's `this.resolve('./main.js')` — which has no
            // importer and therefore resolves against the cwd — lands in the SAMPLE directory.
            // shakeup takes the same directory as an explicit option rather than mutating global
            // process state from a harness that also stages files.
            resolve: { cwd: dir },
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
    // Rollup ships STUB PACKAGES for the fixtures that import a bare `external` specifier
    // (`test/node_modules/external.js`, `external-esm`). Its own runner resolves them because it
    // executes from inside the repo; we run the bundle from a temp directory, so without this link
    // `import foo from 'external'` fails with ERR_MODULE_NOT_FOUND — a gap in OUR runner, not a
    // defect in the bundle it produced.
    const stubs = resolve('llm/libs/rollup/test/node_modules');
    if (existsSync(stubs)) {
        const nm = join(out, 'node_modules');
        mkdirSync(nm, { recursive: true });
        for (const name of readdirSync(stubs)) {
            const from = join(stubs, name);
            if (statSync(from).isDirectory()) {
                try {
                    symlinkSync(from, join(nm, name), 'dir');
                } catch {
                    // A pre-existing link or a filesystem that refuses one.
                }
                continue;
            }
            // A stub shipped as a bare FILE (`external.js`) is resolvable for `require('external')`
            // and NOT for `import 'external'`: node's ESM resolver does no extension guessing in
            // node_modules. Rollup runs these fixtures as CommonJS, so the file form is enough there;
            // we emit ESM. Wrapping it in a real package directory is what makes the same stub
            // resolve — a gap in OUR runner, not in the bundle it produced.
            if (!name.endsWith('.js')) continue;
            const pkg = join(nm, name.slice(0, -3));
            mkdirSync(pkg, { recursive: true });
            writeFileSync(join(pkg, 'package.json'), '{"type":"commonjs","main":"index.js"}');
            writeFileSync(join(pkg, 'index.js'), readFileSync(from, 'utf8'));
        }
    }
    // A fixture may declare its own RELATIVE imports external (`external-function-always-true`
    // returns true for everything with an importer). Those specifiers are emitted verbatim, so the
    // files have to exist beside the chunks. Link the fixture's own files in, skipping anything a
    // chunk will overwrite.
    const chunkNames = new Set(chunks.map((ch) => ch.fileName));
    for (const name of readdirSync(dir)) {
        if (name === '_config.js' || chunkNames.has(name)) continue;
        try {
            symlinkSync(join(dir, name), join(out, name));
        } catch {
            // Same tolerance as above.
        }
    }
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
            // LIVE, not a snapshot. `Object.assign({}, ns)` COPIES each binding once, so any fixture
            // that mutates state and then re-reads an export saw the stale value — `toggled` still
            // false after `await exports.test()`, `foo` still undefined after `exports.defineFooBar()`.
            // Rollup's own harness hands over a CommonJS `module.exports`, where those reads ARE live.
            // Getters reproduce that while keeping the object plain: own + enumerable so
            // `hasOwnProperty` and `Object.keys` behave, configurable and writable-through so a
            // fixture may overwrite an export.
            'let exp;',
            'if (ns !== undefined) {',
            '  const keys = Object.keys(ns);',
            "  if (keys.length === 1 && keys[0] === 'default') exp = ns.default;",
            '  else {',
            '    exp = {};',
            '    const own = new Map();',
            '    for (const k of keys) {',
            '      Object.defineProperty(exp, k, {',
            '        get: () => (own.has(k) ? own.get(k) : ns[k]),',
            '        set: (v) => { own.set(k, v); },',
            '        enumerable: true,',
            '        configurable: true,',
            '      });',
            '    }',
            '  }',
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
// TWO rates, because they answer different questions. The first is against every sample that ran;
// the second excludes the failures on features rolldown itself does not implement, which is the
// honest measure of shakeup against its actual alignment target. Both are printed so neither can be
// quoted without the other.
const attempted = Math.max(ran - nonGoal, 1);
console.log(
    `ran ${ran} · PASS ${pass} (${((pass / Math.max(ran, 1)) * 100).toFixed(1)}%) · build-fail ${buildFail} · run-fail ${runFail}`,
);
console.log(
    `  of the failures, ${nonGoal} are features ROLLDOWN does not support either — against the rest: ${pass}/${attempted} (${((pass / attempted) * 100).toFixed(1)}%)\n`,
);
console.log('SKIPPED, by reason:');
for (const [k, b] of [...skips.entries()].sort((a, c) => c[1].count - a[1].count))
    console.log(`${String(b.count).padStart(4)}  ${k}`);
console.log('\nFAILURES, by bucket:');
for (const [k, b] of [...buckets.entries()].sort((a, c) => c[1].count - a[1].count).slice(0, 20)) {
    console.log(`${String(b.count).padStart(4)}  ${k}`);
    console.log(`      e.g. ${b.samples[0]}`);
}

// The bucket table above is TRUNCATED — 20 buckets, one sample each — and a truncated view has twice
// hidden a regression behind a net-zero delta: a change fixed one sample and broke another, and the
// only number that moved was inside a bucket that never printed. So dump the whole failing SET, one
// name per line, sorted, for `diff`. Under `llm/` because it is a local working artifact, not output.
const failing = [...buckets.values()].flatMap((b) => b.samples).sort();
if (ONLY === null) {
    // Only a FULL run may write it. A `--only` run's set is a subset, and silently overwriting the
    // baseline with one would make the next diff show a pile of phantom fixes.
    writeFileSync(join(import.meta.dirname, '..', 'llm', 'rollupsuite-failing.txt'), `${failing.join('\n')}\n`);
    console.log(
        `\nfull failing set (${failing.length}) written to llm/rollupsuite-failing.txt — diff it against the previous run`,
    );
}
