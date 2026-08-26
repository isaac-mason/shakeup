/**
 * Termination fuzzing for the parser: mutate real sources into invalid ones and assert every parse
 * RETURNS. Run: `pnpm parserfuzz [dir] [rounds]`.
 *
 * A parser that hangs or exhausts memory on bad input is worse than one that rejects it — a bundler
 * must never be killed by a file it was asked to read. `llm/repro/parser-oom.js` is 347 bytes that
 * took down a 4GB heap, and it was found by accident while scanning `node_modules`.
 *
 * The mutations are the shapes that actually caused it: TRUNCATION (a fragment starting mid-construct
 * puts the parser into error recovery) and DELETION of single characters (removing a `,` or `}` makes
 * a recovery loop meet a token it cannot start a member with).
 *
 * Because a genuine infinite loop blocks the event loop, no in-process timer can catch it. The
 * current input is written to a scratch file BEFORE each parse, so if the process is killed the file
 * names the culprit — which is exactly how the original was isolated.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../src/parser/index.ts';

const root = process.argv[2] ?? 'src';
const ROUNDS = Number(process.argv[3] ?? 12);
const LAST = '/tmp/parser-fuzz-last.txt';

const files: string[] = [];
const walk = (d: string, depth = 0): void => {
    if (depth > 6) return;
    let ents: ReturnType<typeof readdirSync>;
    try {
        ents = readdirSync(d, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of ents) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
            if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p, depth + 1);
        } else if (/\.(js|mjs|cjs|ts|tsx)$/.test(e.name)) files.push(p);
    }
};
walk(root);

/** Deterministic PRNG — a fuzz failure has to be reproducible from its seed alone. */
let seed = Number(process.env.SEED ?? 0x5eed);
const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
};

let parsed = 0;
let slowest = { ms: 0, what: '' };
for (const f of files) {
    let src: string;
    try {
        if (statSync(f).size > 400_000) continue;
        src = readFileSync(f, 'utf8');
    } catch {
        continue;
    }
    if (src.length < 40) continue;
    const ts = /\.tsx?$/.test(f);
    const variants: [string, string][] = [];
    for (let i = 0; i < ROUNDS; i++) {
        const cut = 1 + rnd(src.length - 1);
        variants.push([`truncate@${cut}`, src.slice(0, cut)]);
        // A fragment that STARTS mid-construct — the shape that broke the original.
        variants.push([`tail@${cut}`, src.slice(cut)]);
        const del = rnd(src.length);
        variants.push([`delete@${del}`, src.slice(0, del) + src.slice(del + 1)]);
    }
    for (const [how, v] of variants) {
        writeFileSync(LAST, `${f} :: ${how} :: ${v.length} bytes`);
        const t0 = Date.now();
        parse(v, { ts, jsx: true, kind: 'commonjs' });
        parse(v, { ts, jsx: false, kind: 'module' });
        const ms = Date.now() - t0;
        if (ms > slowest.ms) slowest = { ms, what: `${f} ${how}` };
        parsed += 2;
    }
}
console.log(`${parsed} parses over ${files.length} files, seed ${process.env.SEED ?? '0x5eed'} — all returned.`);
console.log(`slowest single input: ${slowest.ms}ms (${slowest.what})`);
