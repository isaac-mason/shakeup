/**
 * Differential: TS mode must accept everything JS mode accepts. Run: `pnpm tsmodediff [dir]`.
 *
 * Every other parser gate runs ONE mode, so a rule that fires only under `ts: true` is invisible to
 * all of them. That is not hypothetical — it shipped. `x ? y => ({ y }) : z => ({ z })` is valid
 * JavaScript that `js` mode accepted and `ts` mode rejected, because the arrow body's `:`
 * speculation consumed the conditional's colon as a return type. `test`, `unchanged`, `parserfuzz`,
 * `parserdiff` and `test262` were all green with that bug present (fixed in 620fb6d).
 *
 * ONE DIRECTION ONLY. TypeScript is a syntactic superset of JavaScript, so `ts` must accept
 * everything `js` accepts — but the converse is false and asserting it would be nonsense: `enum E {}`,
 * `type X = 1`, `<T>expr` and every annotation are ts-only. `parser-diff.ts` made exactly this
 * mistake once with `unambiguous` vs `script` and inflated its divergence count by nine; the lesson
 * transfers directly, so it is written down here rather than re-learned.
 *
 * A file both modes REJECT is not interesting — it is invalid input, and the two modes are entitled
 * to different diagnostics for it. Only accept-then-reject is a finding.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../src/parser/index.ts';

// Defaults to the repo's own `node_modules` because it always exists — `llm/` is gitignored, so a
// corpus under it cannot be a gate everyone can run.
const root = process.argv[2] ?? 'node_modules';
const MAX_BYTES = 4 << 20;

const files: string[] = [];
const walk = (d: string, depth = 0): void => {
    if (depth > 12) return;
    let ents: ReturnType<typeof readdirSync>;
    try {
        ents = readdirSync(d, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of ents) {
        const p = join(d, e.name);
        // `.ts`/`.tsx` are excluded on purpose: they do not parse in `js` mode, so they can never
        // produce the accept-then-reject shape this gate looks for.
        if (e.isDirectory()) {
            // `.pnpm` is NOT skipped: under pnpm every real package lives there, and skipping all
            // dot-directories cut the corpus from 4,000 files to 245 — which would have made a clean
            // run meaningless. Only VCS and cache directories are excluded.
            if (e.name !== '.git' && e.name !== '.cache') walk(p, depth + 1);
        } else if (/\.(js|mjs|cjs)$/.test(e.name)) files.push(p);
    }
};
walk(root);
files.sort();

type Finding = { file: string; pos: number; msg: string };
const findings: Finding[] = [];
let jsOk = 0;
let skipped = 0;

for (const f of files) {
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
    const js = parse(src, { ts: false, jsx: false });
    if (js.errors.length > 0) continue; // invalid as JS — says nothing about TS
    jsOk++;
    const ts = parse(src, { ts: true, jsx: false });
    if (ts.errors.length > 0) findings.push({ file: f, pos: ts.errors[0].pos, msg: ts.errors[0].msg });
}

for (const d of findings) {
    const src = readFileSync(d.file, 'utf8');
    const line = src.slice(0, d.pos).split('\n').length;
    const text = src.slice(Math.max(0, d.pos - 40), d.pos + 40).replace(/\n/g, '\\n');
    console.log(` DIFF  ${d.file}:${line}\n         ts rejects: ${d.msg}\n         near: …${text}…`);
}

console.log(
    `\n${files.length} files · ${jsOk} valid as JS · ${skipped} skipped · ${findings.length} accepted by js and REJECTED by ts`,
);
if (findings.length > 0) process.exit(1);
