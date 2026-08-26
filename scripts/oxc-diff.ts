// Differential against the REAL oxc minifier (`oxc-minify`), not against a reading of the Rust.
//
// Run: `pnpm oxcdiff`
//
// Every case is a construct where oxc's minifier and ours might disagree. `!` marks a divergence.
// This exists because reading `oxc_minifier/src/peephole/*.rs` repeatedly produced WRONG conclusions
// about what oxc actually does — `minimize_for_statement` turned out to be about hoisting an `if` into
// the loop test, not about dropping an always-true test, and `replace_known_methods` turned out to
// cover far less than its name suggests. Running the real thing settles it in one command.
//
// Cases are grouped by the oxc pass they exercise. Fixed gaps are KEPT as regression cases.
// Mangled names differ between the two by nature — compare SHAPE, not spelling.
import { minifySync } from 'oxc-minify';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

type Case = [group: string, label: string, body: string];
const CASES: Case[] = [
    // ── replace_known_methods ──
    ['replace_known_methods', 'Number.NaN', 'o = Number.NaN;'],
    ['replace_known_methods', 'Number.POSITIVE_INFINITY', 'o = Number.POSITIVE_INFINITY;'],
    ['replace_known_methods', 'Number.MAX_SAFE_INTEGER', 'o = Number.MAX_SAFE_INTEGER;'],
    ['replace_known_methods', 'Number.EPSILON', 'o = Number.EPSILON;'],
    ['replace_known_methods', 'regex .source', 'o = /ab+/.source;'],
    ['replace_known_methods', 'Math.pow', 'o = Math.pow(a, 2);'],
    ['replace_known_methods', '"a".concat("b")', 'o = "a".concat("b");'],
    ['replace_known_methods', 'Array.of(1,2)', 'o = Array.of(1, 2);'],
    // ── remove_unused_private_members ──
    ['private_members', 'unused #priv', 'class C { #x = 1; m() { return 2; } } o = new C().m();'],
    ['private_members', 'used #priv', 'class C { #x = 1; m() { return this.#x; } } o = new C().m();'],
    // ── minimize_for_statement / minimize_statements ──
    ['for_statement', 'while(true)+break', 'while (true) { o = a; if (a) break; }'],
    ['for_statement', 'for(;true;)+break', 'for (; true;) { o = a; if (a) break; }'],
    ['for_statement', 'if in for body', 'for (let i = 0; i < 3; i++) { if (a) o = i; }'],
    ['statements', 'if -> logical', 'if (a) { o = 1; }'],
    ['statements', 'return merge', 'function f(){ if (a) return 1; return 2; } o = f();'],
];

/** Drop the shared prologue/epilogue so only the construct under test shows. Best-effort: this is a
 *  READING aid, not a verdict. An earlier version scored each case same/diverged by normalising
 *  identifiers, and it marked cases as diverging that were plainly at parity modulo mangled names
 *  (`e&&(t=1)` vs `a&&(o=1)`). A comparator that cannot be trusted is worse than none, so the output
 *  is now simply both sides, side by side, for a human to read. */
const strip = (c: string): string =>
    c.trim().replace(/\n/g, ' ')
        .replace(/(?:let|var|const)\s+[\w$]+\s*=\s*Number\(globalThis\.x\)\s*,?\s*/, '')
        .replace(/^(?:let|var|const)\s+[\w$]+\s*[;,]\s*/, '')
        .replace(/[,;]?\s*globalThis\.sink\s*=\s*[\w$]+;?\s*$/, '')
        .replace(/^[;,\s]+|[;,\s]+$/g, '');

let group = '';
for (const [g, label, body] of CASES) {
    if (g !== group) { group = g; console.log(`\n\u2500\u2500 ${g} \u2500\u2500`); }
    const src = `const a = Number(globalThis.x);\nlet o;\n${body}\nglobalThis.sink = o;\n`;
    const ours = strip(((await bundle({ entry: '/e.js', fs: createMemoryFs({ '/e.js': src }), external: [], output: { minify: true, optimize: true } } as never)) as { code: string }).code);
    const theirs = strip(minifySync('e.js', src, { compress: {}, mangle: true }).code);
    console.log(`  ${label}`);
    console.log(`      ours  ${ours}`);
    console.log(`      oxc   ${theirs}`);
}
