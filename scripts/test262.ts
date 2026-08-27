/**
 * Run TEST262 — the official ECMAScript conformance suite — against shakeup's parser.
 *
 * Run: `pnpm test262 [substring-filter]` · `pnpm test262 --list <bucket>` to name the failures in a
 * bucket.
 *
 * test262 is what oxc and meriyah both report against, and the parser equivalent of what
 * `pnpm rollupsuite` is for the bundler. `pnpm parsercorpus` already shows 100% agreement with oxc
 * across ~28,000 files of shipped real-world code, so what this adds is the LONG TAIL of the
 * grammar: the constructs nobody ships but the specification still defines.
 *
 * Only the parse-checkable half is meaningful here, and that is exactly the half oxc scores:
 *   · a test with `negative: { phase: parse }` MUST be rejected — a parse error or an early error;
 *   · every other test must be ACCEPTED, because a parser that cannot read a valid program is
 *     broken regardless of what the program then does at runtime.
 * A `negative` test at `runtime` or `resolution` phase is a POSITIVE test for a parser: the source
 * is valid, it just throws when executed.
 *
 * The file selection and the strict/module dispatch are transcribed from oxc's
 * `tasks/coverage/src/{load,tools}.rs` so the score is comparable to the one oxc publishes rather
 * than to a set of our own choosing. The one adaptation: shakeup has no separate strict-mode
 * switch, so the strict variant is run by PREPENDING a `"use strict"` directive, which is the
 * transformation test262's own INTERPRETING.md specifies.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseWithDiagnostics } from '../src/parser/parser.ts';

const ROOT = 'llm/libs/test262/test';
const args = process.argv.slice(2);
const listIdx = args.indexOf('--list');
const LIST = listIdx >= 0 ? args[listIdx + 1] : null;
const FILTER = args.find((a) => !a.startsWith('--') && a !== LIST) ?? null;

if (!existsSync(ROOT)) {
    console.error(
        `test262 is not checked out at ${ROOT}.\n\n  git clone --depth 1 https://github.com/tc39/test262 llm/libs/test262\n`,
    );
    process.exit(1);
}

/** oxc's skip list, verbatim (`load.rs:93-99`), so the denominator matches theirs.
 *  `staging` is unreviewed proposal material; `_FIXTURE` files are imported BY tests, never run;
 *  the annexB assignmenttargettype directory is a documentation tree, not tests. */
const skipPath = (p: string) =>
    p.includes('/staging/') ||
    p.endsWith('.md') ||
    p.includes('_FIXTURE') ||
    p.includes('annexB/language/expressions/assignmenttargettype');

type Meta = { negativeParse: boolean; flags: Set<string>; features: string[] };

/** The metadata block is YAML inside `/*--- … ---*​/`. Only three fields matter for a parse-only
 *  run, and each is line-oriented, so this reads them directly rather than pulling in a YAML
 *  parser — the same shape as oxc's `parse_meta`. */
function parseMeta(code: string): Meta {
    const start = code.indexOf('/*---');
    const end = code.indexOf('---*/');
    const flags = new Set<string>();
    let negativeParse = false;
    let features: string[] = [];
    if (start < 0 || end < 0) return { negativeParse, flags, features };
    const block = code.slice(start + 5, end);
    const fm = /flags:\s*\[([^\]]*)\]/.exec(block);
    if (fm !== null) for (const f of fm[1].split(',')) flags.add(f.trim());
    const feat = /features:\s*\[([^\]]*)\]/.exec(block);
    if (feat !== null) features = feat[1].split(',').map((f) => f.trim());
    // `negative:` is a nested mapping; `phase:` is the only key that decides anything here.
    const neg = block.indexOf('negative:');
    if (neg >= 0) {
        const phase = /phase:\s*(\w+)/.exec(block.slice(neg));
        negativeParse = phase !== null && phase[1] === 'parse';
    }
    return { negativeParse, flags, features };
}

const files: string[] = [];
(function walk(dir: string) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.js') && !skipPath(p)) files.push(p);
    }
})(ROOT);

const accepts = (src: string, kind: 'module' | 'unambiguous') => {
    try {
        return parseWithDiagnostics(src, { ts: false, jsx: false, kind }).errors.length === 0;
    } catch {
        return false;
    }
};

type Bucket = { count: number; samples: string[] };
const buckets = new Map<string, Bucket>();
const bump = (key: string, sample: string) => {
    const b = buckets.get(key) ?? { count: 0, samples: [] };
    b.count++;
    if (b.samples.length < 400) b.samples.push(sample);
    buckets.set(key, b);
};

/** Group a failure by the test262 directory it lives in — `language/expressions/class`, say. That
 *  is how the suite is organised by feature, so the bucket names a GRAMMAR AREA rather than a
 *  message, and points straight at what to work on next. */
const areaOf = (p: string) =>
    p
        .slice(ROOT.length + 1)
        .split('/')
        .slice(0, 3)
        .join('/');

let pass = 0;
let falseReject = 0; // valid program, shakeup rejected it — the harmful direction
let falseAccept = 0; // invalid program, shakeup accepted it — a missing early error
let negatives = 0;
/** `with` is a documented non-goal (ESM output is strict, so a `with` body cannot run), and it is
 *  scattered across many test262 directories rather than confined to one — counting it separately
 *  keeps the remaining number honest. */
let withRejects = 0;

for (const p of files) {
    if (FILTER !== null && !p.includes(FILTER)) continue;
    const code = readFileSync(p, 'utf8');
    const meta = parseMeta(code);
    const shouldFail = meta.negativeParse;
    if (shouldFail) negatives++;

    // The strict/module dispatch, following `tools.rs:84-110`. A test with no mode flag must hold
    // in BOTH modes, so it is run twice and only counts as a pass if both agree.
    let got: boolean;
    if (meta.flags.has('module')) got = accepts(code, 'module');
    else if (meta.flags.has('onlyStrict')) got = accepts(`"use strict";\n${code}`, 'unambiguous');
    else if (meta.flags.has('noStrict') || meta.flags.has('raw')) got = accepts(code, 'unambiguous');
    else got = accepts(code, 'unambiguous') && accepts(`"use strict";\n${code}`, 'unambiguous');

    if (got === !shouldFail) {
        pass++;
        continue;
    }
    if (shouldFail) {
        falseAccept++;
        bump(`ACCEPTED an invalid program  ${areaOf(p)}`, p);
    } else {
        falseReject++;
        if (/\bwith\s*\(/.test(code)) withRejects++;
        // A false rejection is bucketed by test262's own `features:` list where it has one — that
        // names the PROPOSAL rather than the directory, which is what decides whether the gap is a
        // bug or an unimplemented feature. Decorators and `with` both surface this way.
        bump(
            `REJECTED a valid program  [${/\bwith\s*\(/.test(code) ? '`with`, a stated non-goal' : (meta.features[0] ?? areaOf(p))}]`,
            p,
        );
    }
}

if (LIST !== null) {
    for (const [k, b] of buckets) if (k.includes(LIST)) console.log(`${k}\n  ${b.samples.join('\n  ')}`);
    process.exit(0);
}

const ran = pass + falseReject + falseAccept;
console.log(`\ntest262 — ${ran} tests (${negatives} of them negative-at-parse-phase)`);
console.log(`PASS ${pass} (${((pass / Math.max(ran, 1)) * 100).toFixed(2)}%)`);
console.log(
    `  rejected a VALID program:   ${falseReject}   ← the harmful direction (${withRejects} of them \`with\`, a stated non-goal)`,
);
console.log(`  accepted an INVALID program: ${falseAccept}   ← missing early errors\n`);
for (const [k, b] of [...buckets.entries()].sort((a, c) => c[1].count - a[1].count).slice(0, 40)) {
    console.log(`${String(b.count).padStart(5)}  ${k}`);
    console.log(`         e.g. ${b.samples[0].slice(ROOT.length + 1)}`);
}
