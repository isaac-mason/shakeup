// Differential against REAL rolldown for the dead-code tier, the one that runs when nothing asks for
// minification.
//
// Run: `pnpm dcediff` (all cases) or `pnpm dcediff <substring>` (cases whose label matches).
// `pnpm mindiff [substring]` compares `minify: true` instead: oxc's full compressor, mangler and minified
// codegen on both sides, so the outputs are expected to be byte-identical.
//
// Two columns per case, because rolldown runs oxc's tree-shake-only compressor twice:
//   `raw`  — `minify: false`: each module through oxc's dead-code pass (`pre_process_ecma_ast.rs`
//            step 5), then linking with `inlineConst`. shakeup's counterpart is scan's `'dce'` compress.
//   `dce`  — the default `minify: 'dce-only'`: the same, then the assembled chunk through it again.
//            shakeup's counterpart is the chunk compress.
// Nothing is mangled, so after normalising whitespace, indentation and rolldown's region comments,
// the two outputs are expected to be identical and a mismatch is reported as one (`!`).
import { rolldown } from 'rolldown';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';

type Case = [group: string, label: string, files: string | Record<string, string>];

const CASES: Case[] = [
    // ── constant reads (oxc folds through a symbol's value, never substitutes a read) ──
    ['constants', 'top-level const read', 'const L = 7;\nconsole.log(L);'],
    ['constants', 'top-level const in if test', 'const DEBUG = false;\nif (DEBUG) console.log("dbg");\nconsole.log(1);'],
    ['constants', 'top-level const in binary', 'const s = "x";\nconsole.log(s + 1);'],
    ['constants', 'function const read', 'function f() { const Q = 3; return Q; }\nconsole.log(f());'],
    ['constants', 'function const read twice', 'function f() { const Q = 3; console.log(Q); return Q; }\nconsole.log(f());'],
    ['constants', 'function let read', 'function f() { let Q = 3; g(); return Q; }\nconsole.log(f());'],
    ['constants', 'function const in if test', 'function f() { const D = false; if (D) g(); h(); }\nf();'],
    ['constants', 'negated flag', 'const DEBUG = false;\nif (!DEBUG) console.log("prod");'],
    ['constants', 'typeof const', 'const n = 1;\nconsole.log(typeof n);'],
    ['constants', 'const in template', 'const B = 6;\nconsole.log(`x${B}`);'],
    ['constants', 'hoisted var flag read in fn', 'var flag = false;\nfunction f() { if (flag) g(); }\nf();'],
    ['constants', 'exported const read locally', 'export const A = 1;\nconsole.log(A);'],
    // ── single-use substitution (minimize_statements) ──
    ['single_use', 'const into next stmt', 'function f() { const x = g(); return h(x); }\nconsole.log(f());'],
    ['single_use', 'const into next expr stmt', 'function f() { const x = g(); h(x); }\nf();'],
    ['single_use', 'const not adjacent', 'function f() { const x = g(); k(); return h(x); }\nconsole.log(f());'],
    ['single_use', 'let into next stmt', 'function f() { let x = g(); return h(x); }\nconsole.log(f());'],
    ['single_use', 'var into next stmt', 'function f() { var x = g(); return h(x); }\nconsole.log(f());'],
    ['single_use', 'top-level const into next', 'const x = g();\nh(x);'],
    ['single_use', 'member init into return', 'function f(a) { const v = a.b; return v; }\nconsole.log(f({ b: 1 }));'],
    ['single_use', 'used twice', 'function f() { const x = g(); return h(x, x); }\nconsole.log(f());'],
    // ── dead code ──
    ['dead_code', 'if (false)', 'if (false) g();\nh();'],
    ['dead_code', 'if (true) else', 'if (true) g(); else h();'],
    ['dead_code', 'while (false)', 'while (false) g();\nh();'],
    ['dead_code', 'after return', 'function f() { return 1; g(); }\nconsole.log(f());'],
    ['dead_code', 'false && call', 'false && g();\nh();'],
    ['dead_code', 'true || call', 'true || g();\nh();'],
    ['dead_code', 'constant conditional', 'console.log(true ? 1 : g());'],
    ['dead_code', 'empty try', 'try {} catch (e) { g(); }\nh();'],
    ['dead_code', 'constant switch', 'switch (1) { case 1: g(); break; case 2: h(); }'],
    ['dead_code', 'labeled empty block', 'a: {}\nh();'],
    ['dead_code', 'nested block', '{ { g(); } }'],
    // ── unused ──
    ['unused', 'unused local fn', 'function f() { function inner() {} return 1; }\nconsole.log(f());'],
    ['unused', 'unused local pure var', 'function f() { const x = [1]; return 1; }\nconsole.log(f());'],
    ['unused', 'unused local impure var', 'function f() { const x = g(); return 1; }\nconsole.log(f());'],
    ['unused', 'unused local class', 'function f() { class C {} return 1; }\nconsole.log(f());'],
    ['unused', 'unused top-level const', 'const x = [1];\nconsole.log(2);'],
    ['unused', 'unused top-level fn', 'function g() {}\nconsole.log(2);'],
    ['unused', 'unused assignment', 'function f() { let x; x = 1; return 2; }\nconsole.log(f());'],
    // ── folds ──
    ['fold', 'arithmetic', 'console.log(1 + 2 * 3);'],
    ['fold', 'string plus number', 'console.log("a" + 1);'],
    ['fold', 'typeof undefined', 'console.log(typeof undefined === "undefined");'],
    ['fold', 'array length', 'console.log([1, 2].length);'],
    ['fold', 'string length', 'console.log("abc".length);'],
    ['fold', 'not zero', 'console.log(!0);'],
    ['fold', 'nullish constant', 'console.log(null ?? 1);'],
    ['fold', 'sequence', 'console.log((1, 2, g()));'],
    ['fold', 'empty iife', '(() => {})();\nh();'],
    ['fold', 'template literal', 'console.log(`a${1}b`);'],
    ['fold', 'template with ident', 'console.log(`a${g()}b`);'],
    ['fold', 'known method', 'console.log("abc".toUpperCase());'],
    ['fold', 'math', 'console.log(Math.max(1, 2));'],
    // ── across modules ──
    ['modules', 'flag from another module', {
        '/flags.js': 'export const DEBUG = false;\n',
        '/main.js': "import { DEBUG } from './flags.js';\nif (DEBUG) console.log('dbg');\nconsole.log(1);\n",
    }],
    ['modules', 'unused import', {
        '/dep.js': 'export function g() { return 1; }\nexport function h() { return 2; }\n',
        '/main.js': "import { g, h } from './dep.js';\nconsole.log(g());\n",
    }],
    // ── full minify only: what the tree-shake tier leaves alone ──
    ['minify', 'if to ternary', 'export function f(a) { if (a) g(); else h(); }'],
    ['minify', 'if to logical', 'export function f(a) { if (a) g(); }'],
    ['minify', 'if return both', 'export function f(a) { if (a) return 1; else return 2; }'],
    ['minify', 'if return follow', 'export function f(a, b) { if (a) return 1; if (b) return 2; return 3; }'],
    ['minify', 'join vars', 'export function f() { var a = g(); var b = h(); return a + b; }'],
    ['minify', 'sequences', 'export function f() { g(); h(); return k(); }'],
    ['minify', 'dotted property', 'export function f(o) { return o["abc"]; }'],
    ['minify', 'object constructor', 'export function f() { return new Object(); }'],
    ['minify', 'array constructor', 'export function f() { return new Array(3); }'],
    ['minify', 'not in boolean context', 'export function f(a) { if (!!a) g(); }'],
    ['minify', 'conditional to logical', 'export function f(a) { return a ? a : b(); }'],
    ['minify', 'assign to compound', 'export function f(a) { a = a + 1; return a; }'],
    ['minify', 'assign to update', 'export function f(a) { a = a + 1; }'],
    ['minify', 'typeof undefined', 'export function f(a) { return typeof a === "undefined"; }'],
    ['minify', 'loose null', 'export function f(a) { return a === null || a === undefined; }'],
    ['minify', 'while to for', 'export function f() { while (g()) h(); }'],
    ['minify', 'const to let', 'export function f() { const a = g(); h(a); h(a); }'],
    ['minify', 'arrow body', 'export const f = () => { return 1; };'],
    ['minify', 'optional chain', 'export function f(a) { return a == null ? void 0 : a.b; }'],
    ['minify', 'true false', 'export const t = true, f = false;'],
    ['minify', 'undefined', 'export function f() { return undefined; }'],
    ['minify', 'known globals', 'export const a = Number.MAX_SAFE_INTEGER, b = Math.PI;'],
    ['minify', 'string concat', 'export function f(a) { return "a" + "b" + a; }'],
    ['minify', 'drop debugger', 'export function f() { debugger; return 1; }'],
    ['minify', 'mangle locals', 'export function run(input) { const total = input.a + input.b; const scaled = total * 2; return [total, scaled]; }'],
    ['minify', 'mangle top level', 'function helper(x) { return x * 2; }\nexport const value = helper(g());'],
    ['minify', 'keep class name', 'export class Box { size() { return 1; } }'],
    ['minify', 'private members', 'export class C { #a = 1; #b() { return this.#a; } get() { return this.#b(); } }'],
    ['minify', 'switch', 'export function f(a) { switch (a) { case 1: return g(); case 2: return h(); default: return k(); } }'],
    ['minify', 'for statement', 'export function f(a) { for (;;) { if (a()) break; g(); } }'],
];

const normalize = (code: string): string =>
    code
        .replace(/^\s*\/\/#(?:end)?region.*$/gm, '')
        .replace(/^\s*\/\/# sourceMappingURL=.*$/gm, '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .join(' ');

const filesOf = (files: string | Record<string, string>): Record<string, string> =>
    typeof files === 'string' ? { '/main.js': files } : files;

type Minify = false | undefined | true;

async function ours(files: Record<string, string>, minify: Minify): Promise<string> {
    const r = await bundle({ entry: '/main.js', fs: createMemoryFs(files), external: [], output: { minify } } as never);
    const result = r as { errors: string[]; chunks: { code: string }[] };
    if (result.errors.length > 0) return `ERROR ${result.errors.join('; ')}`;
    return normalize(result.chunks.map((c) => c.code).join('\n'));
}

async function theirs(files: Record<string, string>, minify: Minify): Promise<string> {
    const build = await rolldown({
        input: '/main.js',
        logLevel: 'silent',
        plugins: [
            {
                name: 'memory',
                resolveId: (id) => (id.startsWith('/') ? id : id.startsWith('./') ? `/${id.slice(2)}` : null),
                load: (id) => files[id] ?? null,
            },
        ],
    });
    const { output } = await build.generate({ format: 'esm', minify });
    return normalize(output.map((o) => ('code' in o ? o.code : '')).join('\n'));
}

const minifyMode = process.argv.includes('--min');
const filter = process.argv.slice(2).find((argument) => argument !== '--min');
const modes: (readonly [string, Minify])[] = minifyMode
    ? [['min', true]]
    : [
          ['raw', false],
          ['dce', undefined],
      ];
let group = '';
let diverged = 0;
let total = 0;
for (const [g, label, spec] of CASES) {
    if (filter !== undefined && !label.includes(filter) && !g.includes(filter)) continue;
    // The full-minify cases say nothing new about the tree-shake tier.
    if (!minifyMode && g === 'minify') continue;
    if (g !== group) {
        group = g;
        console.log(`\n-- ${g} --`);
    }
    const files = filesOf(spec);
    for (const [mode, minify] of modes) {
        total++;
        const a = await ours(files, minify);
        const b = await theirs(files, minify);
        const same = a === b;
        if (!same) diverged++;
        console.log(`${same ? ' ' : '!'} ${label} [${mode}]`);
        if (!same) {
            console.log(`      ours      ${a}`);
            console.log(`      rolldown  ${b}`);
        }
    }
}
console.log(`\n${diverged} of ${total} diverge`);
