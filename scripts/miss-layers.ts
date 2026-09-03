/**
 * Split shakeup's test262 false-accepts by WHICH LAYER of oxc rejects them.
 *
 * Run: `pnpm misslayers`
 *
 * `pnpm test262` reports one number for "accepted an invalid program", and that number is not one
 * kind of work. oxc rejects these from three separate places, and which place a miss belongs to
 * decides whether it is a rule we can add today or a subsystem we do not have:
 *
 *   · PARSER   — `oxc_parser/src/diagnostics.rs`, 229 variants. Decidable from the token stream and
 *                the `Context` bitflags. Same phase we already work in.
 *   · CHECKER  — `oxc_semantic/src/checker/`, 41 rules. Runs from `SemanticBuilder::leave_node`,
 *                over scopes, symbols and an ancestor stack. Needs per-scope strict mode, which
 *                oxc's PARSER deliberately does not carry — its `Context` has no strict bit.
 *   · NEITHER  — regex pattern bodies, validated by the separate `oxc_regular_expression` crate and
 *                off by default. Matching oxc means NOT doing these in the parser.
 *
 * The classification is oxc's own verdict, not a reading of the Rust: every miss is re-parsed by the
 * real `oxc-parser` twice, once plain and once with `showSemanticErrors`, and bucketed by which run
 * first produced an error. Reading `checker/*.rs` to guess the split gave a materially different
 * answer than measuring it — the same failure mode `oxcdiff` exists to prevent.
 *
 * The mode dispatch is `scripts/test262.ts`'s, so the denominator is that suite's false-accepts.
 *
 * Each message prints a sample path because **the message is where oxc's RECOVERY landed, not what
 * the rule is**. "Expected `:` but found `}`" turned out to be an escaped reserved word used as a
 * binding; "Expected `(` but found `;`" turned out to be `import.source`. Read a fixture before
 * believing a bucket's label — the same lesson as the 909-miss "class" clusters that were one
 * function-parameter rule.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { parseWithDiagnostics } from '../src/parser/parser.ts';

const ROOT = 'llm/libs/test262/test';
const skipPath = (p: string) =>
    p.includes('/staging/') ||
    p.endsWith('.md') ||
    p.includes('_FIXTURE') ||
    p.includes('annexB/language/expressions/assignmenttargettype');

const files: string[] = [];
(function walk(dir: string) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.js') && !skipPath(p)) files.push(p);
    }
})(ROOT);

function parseMeta(code: string): { negativeParse: boolean; flags: Set<string> } {
    const start = code.indexOf('/*---');
    const end = code.indexOf('---*/');
    const flags = new Set<string>();
    if (start < 0 || end < 0) return { negativeParse: false, flags };
    const block = code.slice(start, end);
    const fl = /flags:\s*\[([^\]]*)\]/.exec(block);
    if (fl !== null) for (const f of fl[1].split(',')) flags.add(f.trim());
    const neg = block.indexOf('negative:');
    if (neg < 0) return { negativeParse: false, flags };
    const phase = /phase:\s*(\w+)/.exec(block.slice(neg));
    return { negativeParse: phase !== null && phase[1] === 'parse', flags };
}

const weAccept = (src: string, kind: 'module' | 'unambiguous') => {
    try {
        return parseWithDiagnostics(src, { ts: false, jsx: false, kind }).errors.length === 0;
    } catch {
        return false;
    }
};

/** `sourceType` is oxc's own switch; `semantic` turns the checker on. Both runs must ACCEPT for the
 *  miss to fall through to the next layer, so a throw counts as a rejection. */
const oxcAccepts = (src: string, sourceType: 'module' | 'script', semantic: boolean) => {
    try {
        return parseSync('t.js', src, { sourceType, showSemanticErrors: semantic }).errors.length === 0;
    } catch {
        return false;
    }
};

const firstError = (src: string, sourceType: 'module' | 'script', semantic: boolean) => {
    try {
        return parseSync('t.js', src, { sourceType, showSemanticErrors: semantic }).errors[0]?.message ?? null;
    } catch {
        return null;
    }
};

type Bucket = { n: number; msgs: Map<string, { n: number; sample: string }> };
const buckets = new Map<string, Bucket>();
const bump = (key: string, msg: string, file: string) => {
    const b = buckets.get(key) ?? { n: 0, msgs: new Map<string, { n: number; sample: string }>() };
    b.n++;
    const m = b.msgs.get(msg) ?? { n: 0, sample: file };
    m.n++;
    b.msgs.set(msg, m);
    buckets.set(key, b);
};

const areaOf = (p: string) =>
    p
        .slice(ROOT.length + 1)
        .split('/')
        .slice(0, 3)
        .join('/');

let total = 0;
let ported = 0;
for (const p of files) {
    const code = readFileSync(p, 'utf8');
    const meta = parseMeta(code);
    if (!meta.negativeParse) continue;

    // A test with no mode flag must be rejected in BOTH modes, so both are offered to oxc too.
    let src: string;
    let sourceType: 'module' | 'script';
    let bothModes = false;
    let accepted: boolean;
    if (meta.flags.has('module')) {
        src = code;
        sourceType = 'module';
        accepted = weAccept(code, 'module');
    } else if (meta.flags.has('onlyStrict')) {
        src = `"use strict";\n${code}`;
        sourceType = 'script';
        accepted = weAccept(src, 'unambiguous');
    } else if (meta.flags.has('noStrict') || meta.flags.has('raw')) {
        src = code;
        sourceType = 'script';
        accepted = weAccept(code, 'unambiguous');
    } else {
        src = code;
        sourceType = 'script';
        bothModes = true;
        accepted = weAccept(code, 'unambiguous') && weAccept(`"use strict";\n${code}`, 'unambiguous');
    }
    if (!accepted) continue;
    total++;

    const strictSrc = `"use strict";\n${code}`;
    const oxcOk = (semantic: boolean) =>
        oxcAccepts(src, sourceType, semantic) && (!bothModes || oxcAccepts(strictSrc, sourceType, semantic));

    const rel = p.slice(ROOT.length + 1);
    if (!oxcOk(false)) {
        bump(
            'PARSER  (oxc_parser diagnostic)',
            firstError(src, sourceType, false) ?? firstError(strictSrc, sourceType, false) ?? '?',
            rel,
        );
    } else if (!oxcOk(true)) {
        // Does OUR checker already catch it? Splits the CHECKER bucket into ported and not, so the
        // rule-porting work has a number to move.
        try {
            const prog = parseWithDiagnostics(src, {
                ts: false,
                jsx: false,
                kind: sourceType === 'module' ? 'module' : 'unambiguous',
            }).program;
            const sem = createSemantic();
            analyze(sem, prog, sourceType === 'module', true);
            if (sem.errors.length > 0) ported++;
        } catch {
            // a checker crash must not change the layer verdict
        }
        bump(
            'CHECKER (oxc_semantic/checker)',
            firstError(src, sourceType, true) ?? firstError(strictSrc, sourceType, true) ?? '?',
            rel,
        );
    } else {
        bump('NEITHER (a third layer, or oxc misses it too)', areaOf(p), rel);
    }
}

console.log(`\nshakeup false-accepts, classified by the oxc layer that rejects them: ${total}`);
console.log(`  of the CHECKER bucket, our checker already catches: ${ported}\n`);
for (const [name, b] of [...buckets].sort((a, c) => c[1].n - a[1].n)) {
    console.log(`${String(b.n).padStart(5)}  ${name}`);
    for (const [msg, m] of [...b.msgs].sort((a, c) => c[1].n - a[1].n).slice(0, 12)) {
        console.log(`         ${String(m.n).padStart(4)}  ${msg}`);
        console.log(`               e.g. ${m.sample}`);
    }
    console.log('');
}
