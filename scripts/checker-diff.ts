/**
 * Differential the CHECKER against oxc's, over real code.
 *
 * Run: `pnpm checkerdiff`
 *
 * `src/analysis/checker.ts` implements a growing subset of oxc's 41 semantic early-error rules
 * (`oxc_semantic/src/checker/`). Two directions, and they are not equally dangerous:
 *
 *   · SHAKEUP REJECTS, oxc accepts  — a FALSE POSITIVE. The build now fails on these
 *     (`scan.ts` pushes checker errors into `graph.errors`), so one of these is valid code that no
 *     longer builds. This must stay at ZERO.
 *   · oxc rejects, shakeup accepts  — the known backlog, shrinking as rules land. Informational.
 *
 * The oracle is the real `oxc-parser` with `showSemanticErrors: true` — the same instrument
 * `pnpm misslayers` uses, and for the same reason: reading `checker/*.rs` to predict behaviour gave a
 * materially different answer than running it.
 *
 * Corpus is `pnpm parsercorpus`'s: real shipped code under node_modules, where a false positive would
 * actually bite.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';
import { checkSyntax } from '../src/analysis/checker.ts';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { parse } from '../src/parser/index.ts';

const ROOT = 'node_modules';
const MAX_BYTES = 4_000_000;
const files: string[] = [];
(function walk(dir: string, depth: number) {
    if (depth > 6) return;
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }
    for (const name of entries) {
        const p = join(dir, name);
        let st: ReturnType<typeof statSync>;
        try {
            st = statSync(p);
        } catch {
            continue;
        }
        if (st.isDirectory()) walk(p, depth + 1);
        else if ((name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.cjs')) && st.size < MAX_BYTES) files.push(p);
    }
})(ROOT, 0);

let scanned = 0;
let bothClean = 0;
let backlog = 0;
let matched = 0;
const falsePositives: { file: string; msg: string }[] = [];

for (const file of files) {
    let src: string;
    try {
        src = readFileSync(file, 'utf8');
    } catch {
        continue;
    }
    const isModule = file.endsWith('.mjs');
    // Only files BOTH accept syntactically are comparable; a parse divergence is `parsercorpus`'s job.
    let program: ReturnType<typeof parse>['program'];
    try {
        const r = parse(src, { ts: false, jsx: false, kind: isModule ? 'module' : 'unambiguous' });
        if (r.errors.length > 0) continue;
        program = r.program;
    } catch {
        continue;
    }
    let theirs: string[];
    try {
        const r = parseSync(file, src, { sourceType: isModule ? 'module' : 'script', showSemanticErrors: true });
        if (r.errors.some((e) => /Expected|Unexpected|Invalid character/i.test(e.message))) continue;
        theirs = r.errors.map((e) => e.message);
    } catch {
        continue;
    }
    scanned++;
    const sem = createSemantic();
    analyze(sem, program, isModule);
    const ours = checkSyntax(sem, program).map((e) => e.msg);
    for (const m of ours) if (!theirs.includes(m)) falsePositives.push({ file, msg: m });
    if (ours.length > 0) matched++;
    else if (theirs.length > 0) backlog++;
    else bothClean++;
}

console.log(`\nscanned ${scanned} files under ${ROOT} (both parsers accept them syntactically)`);
console.log(`  both clean: ${bothClean}`);
// Real shipped code is overwhelmingly valid, so this is normally 0. It is here so "we found nothing"
// is stated rather than inferred from the other two adding up.
console.log(`  shakeup reported something: ${matched}\n`);
console.log(`SHAKEUP REJECTS, oxc accepts  ← the harmful direction: ${falsePositives.length} findings`);
for (const f of falsePositives.slice(0, 10)) console.log(`     ${f.msg}\n        ${f.file}`);
console.log(`\noxc rejects, shakeup accepts  ← rules not yet ported: ${backlog} files`);
if (falsePositives.length > 0) process.exit(1);
