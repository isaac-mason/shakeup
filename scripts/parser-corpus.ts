/**
 * Real-world parser conformance: parse every JavaScript file in `node_modules` with shakeup and with
 * the real oxc parser, and report where the two disagree.
 *
 * Run: `pnpm parsercorpus [dir]`
 *
 * `pnpm parserdiff` asks "do we agree on this construct" — hand-written cases, so it measures what I
 * thought to test. This asks the question that actually decides priority: **on code people really
 * ship, what would shakeup fail to build?** The two answers differ sharply, and guessing between them
 * is how a rare spec gap gets called "most likely to block a real build".
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseSync } from 'oxc-parser';
import { parse } from '../src/parser/index.ts';

const root = process.argv[2] ?? 'node_modules';
// Skipped files are reported, never silently dropped.
//
// KNOWN: a run over a populated `node_modules` DIES — `FATAL ERROR: Ineffective mark-compacts near
// heap limit`. It is not accumulation and not a leak (both were measured and ruled out); a single
// 347-byte input sends shakeup's parser into unbounded allocation. See `parser-perf-plan.md` and the
// fixture at `llm/repro/parser-oom.js`. Until that is fixed, point this at a source tree
// (`pnpm parsercorpus llm/libs/webpack`) rather than at `node_modules`.
const MAX_BYTES = Number(process.env.MAX_BYTES ?? 4_000_000);

const files: string[] = [];
const walk = (d: string, depth = 0): void => {
    if (depth > 8) return;
    let ents: ReturnType<typeof readdirSync>;
    try {
        ents = readdirSync(d, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of ents) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
            if (e.name !== '.bin') walk(p, depth + 1);
        } else if (/\.(js|mjs|cjs)$/.test(e.name)) files.push(p);
    }
};
walk(root);

/** The module goal a real file actually gets: extension first, then the nearest `package.json#type`.
 *  Approximating `.js` as CommonJS instead produced 42 bogus `import.meta` rejections — every one an
 *  ESM package's `.js` file. A conformance number is worthless if the harness feeds the wrong goal. */
const pkgTypeCache = new Map<string, string>();
const nearestType = (file: string): string => {
    let d = dirname(file);
    for (let i = 0; i < 12; i++) {
        const cached = pkgTypeCache.get(d);
        if (cached !== undefined) return cached;
        const pj = join(d, 'package.json');
        if (existsSync(pj)) {
            let t = 'commonjs';
            try {
                t = (JSON.parse(readFileSync(pj, 'utf8')) as { type?: string }).type === 'module' ? 'module' : 'commonjs';
            } catch {
                /* malformed package.json → the default */
            }
            pkgTypeCache.set(d, t);
            return t;
        }
        const up = dirname(d);
        if (up === d) break;
        d = up;
    }
    return 'commonjs';
};
const goalOf = (f: string): 'module' | 'commonjs' =>
    f.endsWith('.mjs') ? 'module' : f.endsWith('.cjs') ? 'commonjs' : nearestType(f) === 'module' ? 'module' : 'commonjs';

type Bucket = { count: number; sample: string; file: string; snippet: string };
const shakeupOnly = new Map<string, Bucket>();
const oxcOnly = new Map<string, Bucket>();
let both = 0;
let neither = 0;
let scanned = 0;
let skipped = 0;

const norm = (m: string) =>
    m
        .replace(/'[^']*'/g, "'…'")
        .replace(/"[^"]*"/g, '"…"')
        .slice(0, 70);

let sinceYield = 0;
for (const f of files) {
    // Hand control back to the event loop every so often. Each iteration allocates a whole AST and
    // drops it; without a yield V8 sees an unbroken synchronous run, grows the heap instead of
    // collecting, and dies with `Ineffective mark-compacts near heap limit` on a large tree.
    if (++sinceYield >= 50) {
        sinceYield = 0;
        await new Promise((r) => setImmediate(r));
    }
    let src: string;
    try {
        if (statSync(f).size > MAX_BYTES) {
            skipped++;
            continue;
        }
        src = readFileSync(f, 'utf8');
    } catch {
        skipped++;
        continue;
    }
    const goal = goalOf(f);
    let oxcOk: boolean;
    let oxcMsg = '';
    try {
        const r = parseSync(f, src, { sourceType: goal });
        oxcOk = r.errors.length === 0;
        oxcMsg = r.errors[0]?.message ?? '';
    } catch (e) {
        oxcOk = false;
        oxcMsg = String((e as Error).message);
    }
    let skOk: boolean;
    let skMsg = '';
    let skPos = 0;
    try {
        const r = parse(src, { ts: false, jsx: false, kind: goal === 'module' ? 'module' : 'commonjs' });
        skOk = r.errors.length === 0;
        skMsg = r.errors[0]?.msg ?? '';
        skPos = r.errors[0]?.pos ?? 0;
    } catch (e) {
        skOk = false;
        skMsg = `THREW: ${String((e as Error).message)}`;
    }
    scanned++;
    if (oxcOk && skOk) both++;
    else if (!oxcOk && !skOk) neither++;
    else if (oxcOk && !skOk) {
        const k = norm(skMsg);
        const b = shakeupOnly.get(k) ?? {
            count: 0,
            sample: skMsg,
            file: f,
            snippet: src.slice(Math.max(0, skPos - 55), skPos + 45).replace(/\n/g, '⏎'),
        };
        b.count++;
        shakeupOnly.set(k, b);
    } else {
        const k = norm(oxcMsg);
        const b = oxcOnly.get(k) ?? { count: 0, sample: oxcMsg, file: f, snippet: '' };
        b.count++;
        oxcOnly.set(k, b);
    }
}

const report = (title: string, m: Map<string, Bucket>) => {
    const total = [...m.values()].reduce((n, b) => n + b.count, 0);
    console.log(`\n${title}: ${total} files`);
    for (const [k, b] of [...m.entries()].sort((a, c) => c[1].count - a[1].count).slice(0, 12)) {
        console.log(`  ${String(b.count).padStart(4)}  ${k}`);
        console.log(`        e.g. ${b.file.replace(/.*node_modules\//, '')}`);
        if (b.snippet !== '') console.log(`        ...${b.snippet}...`);
    }
};

console.log(`scanned ${scanned} files under ${root} (${skipped} skipped: unreadable, or over MAX_BYTES=${MAX_BYTES})`);
console.log(`  both accept: ${both} · both reject: ${neither}`);
report('SHAKEUP REJECTS, oxc accepts  ← the harmful direction', shakeupOnly);
report('oxc rejects, shakeup accepts  ← missing early errors', oxcOnly);
