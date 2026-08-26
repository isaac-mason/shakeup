import { existsSync, readFileSync } from 'node:fs';
import { minifySync } from 'oxc-minify';
import { bundle } from '../src/bundle.ts';
const diskFs = { read: (i: string) => (existsSync(i) ? readFileSync(i, 'utf8') : null), exists: (i: string) => existsSync(i) };
const three = `${import.meta.dirname}/../llm/spikes/node_modules/three/build/three.core.js`;
const src = readFileSync(three, 'utf8');

// Ours: bundle the single file (no imports) so it's a like-for-like minify of the same source.
const ours = ((await bundle({ entry: three, fs: diskFs, external: [], output: { minify: true, optimize: true } } as never)) as { code: string }).code;
const theirs = minifySync('three.core.js', src, { compress: {}, mangle: true }).code;
console.log(`  source        ${src.length.toLocaleString()}`);
console.log(`  shakeup       ${ours.length.toLocaleString()}`);
console.log(`  oxc-minify    ${theirs.length.toLocaleString()}   (${ours.length < theirs.length ? 'we are SMALLER by ' + (theirs.length - ours.length).toLocaleString() : 'oxc is SMALLER by ' + (ours.length - theirs.length).toLocaleString()})`);

// Where does the difference live? Count syntactic markers in both. A marker we emit MORE of is a
// construct oxc reduces and we do not — that is a lead, not a conclusion.
const MARKERS: [string, RegExp][] = [
    ['else', /\belse\b/g],
    ['void 0', /void 0/g],
    ['!0', /!0/g],
    ['!1', /!1/g],
    ['===', /===/g],
    ['!==', /!==/g],
    ['empty block {}', /\{\}/g],
    ['function(', /function\s*\(/g],
    ['=>', /=>/g],
    ['return;', /return;/g],
    ['(0,', /\(0,/g],
    ['typeof', /\btypeof\b/g],
    ['?.', /\?\./g],
    ['??', /\?\?/g],
    ['`', /`/g],
    ['new ', /\bnew\s/g],
    [';}', /;\}/g],
    ['((', /\(\(/g],
    ['))', /\)\)/g],
    ['delete ', /\bdelete\s/g],
];
// Sample the contexts so a count difference becomes a readable lead.
const sample = (text: string, re: RegExp, n: number): string[] => {
    const out: string[] = [];
    for (const m of text.matchAll(re)) {
        if (m.index === undefined) continue;
        out.push(JSON.stringify(text.slice(Math.max(0, m.index - 22), m.index + 24)));
        if (out.length >= n) break;
    }
    return out;
};
console.log('\n  oxc backticks (we have 66, oxc 1612):');
for (const x of sample(theirs, /`/g, 3)) console.log('    ' + x);
console.log('  our `return;` (we have 25, oxc 13):');
for (const x of sample(ours, /return;/g, 3)) console.log('    ' + x);
console.log('  our `===` :');
for (const x of sample(ours, /===/g, 3)) console.log('    ' + x);

const count = (t: string, re: RegExp): number => (t.match(re) ?? []).length;
console.log('\n  targeted:');
console.log(`    typeof x === lit   ours ${count(ours, /typeof [^=]{1,24}===/g)}   oxc ${count(theirs, /typeof [^=]{1,24}===/g)}`);
console.log(`    typeof x == lit    ours ${count(ours, /typeof [^=]{1,24}==[^=]/g)}   oxc ${count(theirs, /typeof [^=]{1,24}==[^=]/g)}`);
console.log(`    === void 0         ours ${count(ours, /===void 0/g)}   oxc ${count(theirs, /===void 0/g)}`);
console.log(`    ==null             ours ${count(ours, /==null/g)}   oxc ${count(theirs, /==null/g)}`);
console.log(`    !==void 0          ours ${count(ours, /!==void 0/g)}   oxc ${count(theirs, /!==void 0/g)}`);
console.log(`    !=null             ours ${count(ours, /!=null/g)}   oxc ${count(theirs, /!=null/g)}`);

console.log('\n  marker            ours     oxc    delta');
const rows: [string, number, number][] = [];
for (const [name, re] of MARKERS) {
    const a = (ours.match(re) ?? []).length;
    const b = (theirs.match(re) ?? []).length;
    if (a !== b) rows.push([name, a, b]);
}
rows.sort((x, y) => Math.abs(y[1] - y[2]) - Math.abs(x[1] - x[2]));
for (const [name, a, b] of rows) {
    const d = a - b;
    console.log(`  ${name.padEnd(16)} ${String(a).padStart(6)}  ${String(b).padStart(6)}  ${d > 0 ? '+' : ''}${d}`);
}
