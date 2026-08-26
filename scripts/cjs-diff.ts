/**
 * Differential CommonJS conformance: shakeup vs rolldown vs Node, on VALUES.
 *
 * Run: `pnpm cjsdiff` · `pnpm cjsdiff <substring>` to filter cases.
 *
 * Reading the oracles' source tells you what they intend; running them tells you what they do. Every
 * case here is a complete program whose entry exports `x`. Each is bundled by shakeup and by
 * rolldown, both outputs are executed from disk, and the two `x` values are compared. Where the
 * program is also valid for Node as written, Node runs it too and acts as ground truth.
 *
 * A divergence printed here is a FACT, not an opinion. Some are intended — they are listed in
 * `EXPECTED` with the reason — and anything not listed is a finding.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';
import { bundle } from '../src/bundle.ts';
import { nodeFsFrom } from './cjs-diff-fs.ts';

type Case = {
    name: string;
    files: Record<string, string>;
    /** Entry, relative to the case root. Defaults to `main.js`. */
    entry?: string;
    /** Skip the Node arm — the program is not valid stand-alone Node (e.g. bare specifiers). */
    noNode?: boolean;
    output?: { minify?: boolean; preserveModules?: boolean; codeSplitting?: boolean };
    platform?: 'node' | 'browser' | 'neutral';
};

/** Divergences that are decided, with the reason. Anything else is a finding. */
const EXPECTED: Record<string, string> = {
    'a throwing module re-runs on the next require':
        'DELIBERATE, and shakeup is the one that matches Node. Node deletes a throwing CommonJS module from the require cache so the next require RE-RUNS it. esbuild implements that (`runtime.go:201-207`, `catch { mod = 0 }`); rolldown does not, and hands back the half-populated exports object from the failed run. shakeup follows esbuild here — see the `node` row.',
    'chunks: dynamic import of a mode-2 module':
        'DELIBERATE, and shakeup is more capable. `import("./b.js")` where b does `export * from "<cjs>"`: the names only exist after `__reExport` runs, so they cannot be chunk exports. rolldown leaves them unresolved and the caller reads `undefined`. shakeup has the target chunk export the runtime namespace OBJECT and rewrites the import site to unwrap it — the same move rolldown itself makes for a dynamically imported CommonJS module (`cjs_compat/dynamic_cjs_entry`: `import("./cjs.js").then((m) => __toESM(m.default))`), applied one case further. Node also gives `undefined` here, but only because its cjs-module-lexer cannot see through `export *` at all — it fails the STATIC form too, which both bundlers get right.',
};

const CASES: Case[] = [
    // ── interop shapes ──
    {
        name: 'default import of plain module.exports',
        files: { 'd.cjs': 'module.exports = { k: 7 };', 'main.js': "import d from './d.cjs';\nexport const x = d.k;" },
    },
    {
        name: 'default import honours __esModule',
        files: {
            'd.cjs': "exports.__esModule = true;\nexports.default = 'REAL';\nexports.named = 'N';",
            'main.js': "import d, { named } from './d.cjs';\nexport const x = [d, named];",
        },
    },
    {
        name: 'named imports off module.exports',
        files: {
            'd.cjs': 'module.exports = { a: 1, b: 2 };',
            'main.js': "import { a, b } from './d.cjs';\nexport const x = [a, b];",
        },
    },
    {
        name: 'namespace import of a CommonJS module',
        files: {
            'd.cjs': 'module.exports = { a: 1 };',
            'main.js': "import * as ns from './d.cjs';\nexport const x = [ns.a ?? null, ns.default, Object.keys(ns).sort()];",
        },
    },
    {
        name: 'exports.foo form',
        files: {
            'd.cjs': 'exports.a = 1;\nexports.b = 2;',
            'main.js': "import * as ns from './d.cjs';\nexport const x = [ns.a, ns.b];",
        },
    },
    {
        name: 'module.exports = function',
        files: {
            'd.cjs': 'module.exports = function f() { return 5 };',
            'main.js': "import d from './d.cjs';\nexport const x = [typeof d, d()];",
        },
    },
    {
        name: 'module.exports reassigned in a branch',
        files: {
            'd.cjs': "if (globalThis.__never) { module.exports = 'A' } else { module.exports = 'B' }",
            'main.js': "import d from './d.cjs';\nexport const x = d;",
        },
    },
    {
        name: 'exports.a then module.exports replaced',
        files: {
            'd.cjs': 'exports.a = 1;\nmodule.exports = { b: 2 };',
            'main.js': "import d from './d.cjs';\nexport const x = [d.b, d.a ?? null];",
        },
    },
    // ── require ──
    {
        name: 'require chain',
        files: {
            'i.cjs': 'module.exports = 3;',
            'd.cjs': "module.exports = require('./i.cjs') * 2;",
            'main.js': "import d from './d.cjs';\nexport const x = d;",
        },
    },
    {
        name: 'require of an ES module',
        files: {
            'e.js': 'export const a = 1;\nexport default 2;',
            'd.cjs': "const e = require('./e.js');\nmodule.exports = [e.a, e.default, e.__esModule];",
            'main.js': "import d from './d.cjs';\nexport const x = d;",
        },
    },
    {
        name: 'require of an ES module is LAZY (order)',
        files: {
            'e.js': "globalThis.__o1.push('esm');\nexport const a = 1;",
            'd.cjs':
                "globalThis.__o1 = ['before'];\nconst e = require('./e.js');\nglobalThis.__o1.push('after');\nmodule.exports = globalThis.__o1.concat(e.a);",
            'main.js': "import d from './d.cjs';\nexport const x = d;",
        },
    },
    {
        name: 'require never reached does not evaluate',
        files: {
            'e.js': 'globalThis.__ran2 = true;\nexport const a = 1;',
            'd.cjs':
                "let v = 0;\nif (globalThis.__never) { v = require('./e.js').a }\nmodule.exports = { v, ran: globalThis.__ran2 ?? false };",
            'main.js': "import d from './d.cjs';\nexport const x = d;",
        },
    },
    {
        name: 'require inside try/catch',
        files: {
            'o.cjs': "module.exports = 'OPT';",
            'd.cjs': "let v;\ntry { v = require('./o.cjs') } catch { v = null }\nmodule.exports = v;",
            'main.js': "import d from './d.cjs';\nexport const x = d;",
        },
    },
    {
        name: 'a throwing module re-runs on the next require',
        files: {
            't.cjs':
                "globalThis.__r3 = (globalThis.__r3 ?? 0) + 1;\nif (globalThis.__r3 === 1) throw new Error('first');\nmodule.exports = { ran: globalThis.__r3 };",
            'd.cjs':
                "const out = [];\nfor (let i = 0; i < 2; i++) { try { out.push(require('./t.cjs')) } catch (e) { out.push('THREW:' + e.message) } }\nmodule.exports = out;",
            'main.js': "import d from './d.cjs';\nexport const x = d;",
        },
    },
    {
        name: 'a throwing ES module error is STICKY',
        files: {
            'e.js': "globalThis.__s4 = (globalThis.__s4 ?? 0) + 1;\nthrow new Error('boom' + globalThis.__s4);\nexport const a = 1;",
            'd.cjs':
                "const out = [];\nfor (let i = 0; i < 2; i++) { try { require('./e.js') } catch (e) { out.push(e.message) } }\nmodule.exports = out;",
            'main.js': "import d from './d.cjs';\nexport const x = d;",
        },
    },
    {
        name: 'require evaluates once',
        files: {
            't.cjs': 'globalThis.__o5 = (globalThis.__o5 ?? 0) + 1;\nmodule.exports = { n: globalThis.__o5 };',
            'd.cjs': "const a = require('./t.cjs');\nconst b = require('./t.cjs');\nmodule.exports = [a.n, b.n, a === b];",
            'main.js': "import d from './d.cjs';\nexport const x = d;",
        },
    },
    // ── re-export ──
    {
        name: 're-export named from CommonJS',
        files: {
            'd.cjs': 'module.exports = { a: 1 };',
            'b.js': "export { a } from './d.cjs';",
            'main.js': "import { a } from './b.js';\nexport const x = a;",
        },
    },
    {
        name: 'export * from CommonJS',
        files: {
            'd.cjs': 'module.exports = { a: 1, b: 2 };',
            'b.js': "export * from './d.cjs';",
            'main.js': "import { a, b } from './b.js';\nexport const x = [a, b];",
        },
    },
    {
        name: 'export * from CommonJS, namespace form',
        files: {
            'd.cjs': 'module.exports = { a: 1, b: 2 };',
            'b.js': "export * from './d.cjs';\nexport const own = 9;",
            'main.js': "import * as ns from './b.js';\nexport const x = [ns.a, ns.b, ns.own, Object.keys(ns).sort()];",
        },
    },
    {
        name: 'export * does not forward default',
        files: {
            'd.cjs': "module.exports = { a: 1, default: 'NO' };",
            'b.js': "export * from './d.cjs';",
            'main.js': "import * as ns from './b.js';\nexport const x = [ns.a, ns.default ?? null];",
        },
    },
    {
        name: 'export * chained two hops',
        files: {
            'd.cjs': 'module.exports = { a: 1 };',
            'c.js': "export * from './d.cjs';",
            'b.js': "export * from './c.js';",
            'main.js': "import * as ns from './b.js';\nexport const x = ns.a;",
        },
    },
    {
        name: 'export * as ns from CommonJS',
        files: {
            'd.cjs': 'module.exports = { a: 1 };',
            'b.js': "export * as inner from './d.cjs';",
            'main.js': "import { inner } from './b.js';\nexport const x = inner.a ?? inner.default.a;",
        },
    },
    // ── evaluation order / cycles ──
    {
        name: 'CommonJS evaluates in dependency order',
        files: {
            'a.cjs': "globalThis.__o6.push('a');\nmodule.exports = 1;",
            'b.cjs': "globalThis.__o6.push('b');\nmodule.exports = 2;",
            'main.js':
                "globalThis.__o6 = [];\nimport a from './a.cjs';\nimport b from './b.cjs';\nexport const x = [a, b, globalThis.__o6.slice()];",
        },
    },
    {
        name: 'one CommonJS module shared by two importers',
        files: {
            'd.cjs': 'globalThis.__o7 = (globalThis.__o7 ?? 0) + 1;\nmodule.exports = { n: globalThis.__o7 };',
            'a.js': "import d from './d.cjs';\nexport const a = d;",
            'b.js': "import d from './d.cjs';\nexport const b = d;",
            'main.js': "import { a } from './a.js';\nimport { b } from './b.js';\nexport const x = [a.n, b.n, a === b];",
        },
    },
    {
        name: 'CommonJS self-cycle via require',
        files: {
            'a.cjs': "exports.name = 'a';\nconst b = require('./b.cjs');\nexports.fromB = b.name;",
            'b.cjs': "exports.name = 'b';\nconst a = require('./a.cjs');\nexports.fromA = a.name;",
            'main.js': "import a from './a.cjs';\nexport const x = [a.name, a.fromB];",
        },
    },
    // ── late mutation ──
    {
        name: 'late mutation, default import',
        files: {
            'b.cjs': 'module.exports = { v: 1 };',
            'm.js': "import b from './b.cjs';\nb.v = 99;\nb.added = 'NEW';\nexport const done = true;",
            'main.js': "import b from './b.cjs';\nimport { done } from './m.js';\nexport const x = [b.v, b.added ?? null, done];",
        },
    },
    {
        name: 'late mutation, namespace import',
        files: {
            'b.cjs': 'module.exports = { v: 1 };',
            'm.js': "import b from './b.cjs';\nb.v = 99;\nb.added = 'NEW';\nexport const done = true;",
            'main.js':
                "import * as ns from './b.cjs';\nimport { done } from './m.js';\nexport const x = [ns.v ?? null, ns.added ?? null, Object.keys(ns).sort(), done];",
        },
    },
    // ── entries ──
    {
        name: 'CommonJS entry exports module.exports as default',
        entry: 'main.cjs',
        files: { 'main.cjs': "module.exports = 'main';" },
    },
    {
        name: 'dynamic import of a CommonJS module',
        files: {
            'c.cjs': 'module.exports = { k: 7 };',
            'main.js': "export const x = import('./c.cjs').then((m) => m.default.k);",
        },
    },
    // ── top-level this / UMD ──
    {
        name: 'top-level this is module.exports',
        files: {
            'd.cjs': 'this.viaThis = 1;\nmodule.exports.viaExports = 2;',
            'main.js': "import d from './d.cjs';\nexport const x = [d.viaThis, d.viaExports];",
        },
    },
    {
        name: 'UMD header takes the CommonJS branch',
        files: {
            'd.cjs':
                "if (typeof exports === 'object' && typeof module !== 'undefined') { module.exports = 'CJS' } else { globalThis.LIB = 'GLOBAL' }",
            'main.js': "import d from './d.cjs';\nexport const x = d;",
        },
    },
    {
        name: 'typeof require is function',
        files: {
            'd.cjs': "module.exports = typeof require === 'function' ? 'cjs' : 'browser';",
            'main.js': "import d from './d.cjs';\nexport const x = d;",
        },
    },
    // ── chunking · the axis whose PRODUCT with CommonJS had no coverage ──
    {
        name: 'chunks: CommonJS shared by two dynamic entries',
        files: {
            's.cjs': 'module.exports = { k: 7 };',
            'a.js': "import s from './s.cjs';\nexport const a = s.k;",
            'b.js': "import s from './s.cjs';\nexport const b = s.k;",
            'main.js': "export const x = Promise.all([import('./a.js'), import('./b.js')]).then(([p, q]) => p.a + q.b);",
        },
    },
    {
        name: 'chunks: CommonJS requiring CommonJS across a boundary',
        files: {
            'i.cjs': 'module.exports = 3;',
            'd.cjs': "module.exports = require('./i.cjs') * 2;",
            'main.js': "export const x = import('./d.cjs').then((m) => m.default);",
        },
    },
    {
        name: 'chunks: require of an ES module across a boundary',
        files: {
            'e.js': 'export const a = 7;',
            'd.cjs': "module.exports = require('./e.js').a;",
            'main.js': "export const x = import('./d.cjs').then((m) => m.default);",
        },
        output: { preserveModules: true },
    },
    {
        name: 'chunks: preserveModules with a CommonJS dep',
        files: { 'd.cjs': 'module.exports = { k: 7 };', 'main.js': "import d from './d.cjs';\nexport const x = d.k;" },
        output: { preserveModules: true },
    },
    {
        name: 'chunks: mode-2 across a boundary',
        files: {
            'd.cjs': 'module.exports = { a: 1, b: 2 };',
            'b.js': "export * from './d.cjs';",
            'main.js': "import * as ns from './b.js';\nexport const x = [ns.a, ns.b];",
        },
        output: { preserveModules: true },
    },
    {
        name: 'chunks: dynamic import of a mode-2 module',
        files: {
            'd.cjs': 'module.exports = { a: 1 };',
            'b.js': "export * from './d.cjs';",
            'main.js': "export const x = import('./b.js').then((m) => m.a);",
        },
    },
    // ── minify ──
    {
        name: 'minify: CommonJS wrapper',
        files: { 'd.cjs': 'module.exports = { k: 7 };', 'main.js': "import d from './d.cjs';\nexport const x = d.k;" },
        output: { minify: true },
    },
    {
        name: 'minify: mode-2 namespace',
        files: {
            'd.cjs': 'module.exports = { a: 1, b: 2 };',
            'b.js': "export * from './d.cjs';\nexport const own = 9;",
            'main.js': "import * as ns from './b.js';\nexport const x = [ns.a, ns.b, ns.own];",
        },
        output: { minify: true },
    },
    {
        name: 'minify: lazy __esm',
        files: {
            'e.js': 'export const a = 1;\nexport let m = 2;',
            'd.cjs': "const e = require('./e.js');\nmodule.exports = [e.a, e.m];",
            'main.js': "import d from './d.cjs';\nexport const x = d;",
        },
        output: { minify: true },
    },
    // ── platform / isNodeMode ──
    {
        name: 'platform node: __esModule interop',
        files: {
            'd.cjs': "exports.__esModule = true;\nexports.default = 'REAL';",
            'main.js': "import d from './d.cjs';\nexport const x = d;",
        },
        platform: 'node',
    },
    {
        name: '.mjs importer ignores __esModule (Node spec)',
        entry: 'main.mjs',
        files: {
            'd.cjs': "exports.__esModule = true;\nexports.default = 'REAL';\nexports.named = 'N';",
            'main.mjs': "import d, { named } from './d.cjs';\nexport const x = [d, named];",
        },
    },
    // ── shapes real packages ship ──
    {
        name: 'react-like: exports assigned in a loop',
        files: {
            'd.cjs': "const names = ['a', 'b'];\nfor (const n of names) exports[n] = n.toUpperCase();\nexports.extra = 1;",
            'main.js': "import * as ns from './d.cjs';\nexport const x = [ns.extra, ns.default.a ?? null];",
        },
    },
    {
        name: 'conditional exports by NODE_ENV',
        files: {
            'p.cjs': "module.exports = process.env.NODE_ENV === 'production' ? 'P' : 'D';",
            'd.cjs': "module.exports = require('./p.cjs');",
            'main.js': "import d from './d.cjs';\nexport const x = typeof d;",
        },
    },
    {
        name: 'Object.defineProperty exports',
        files: {
            'd.cjs': "Object.defineProperty(exports, '__esModule', { value: true });\nexports.default = 'X';",
            'main.js': "import d from './d.cjs';\nexport const x = d;",
        },
    },
    {
        name: 'getter on exports',
        files: {
            'd.cjs': "Object.defineProperty(exports, 'lazy', { get: () => 42, enumerable: true });",
            'main.js': "import * as ns from './d.cjs';\nexport const x = ns.lazy ?? ns.default.lazy;",
        },
    },
    {
        name: 'nested require in a function',
        files: {
            'i.cjs': 'module.exports = 5;',
            'd.cjs': "module.exports = function () { return require('./i.cjs') };",
            'main.js': "import d from './d.cjs';\nexport const x = d();",
        },
    },
    {
        name: 'require result destructured',
        files: {
            'i.cjs': 'module.exports = { a: 1, b: 2 };',
            'd.cjs': "const { a, b } = require('./i.cjs');\nmodule.exports = a + b;",
            'main.js': "import d from './d.cjs';\nexport const x = d;",
        },
    },
    {
        name: 'CommonJS importing an ES module by import syntax is an error in .cjs',
        files: { 'd.cjs': 'module.exports = 1;', 'main.js': "import d from './d.cjs';\nexport const x = d;" },
    },
];

const filter = process.argv[2];
const cases = filter === undefined ? CASES : CASES.filter((c) => c.name.includes(filter));

const dirs: string[] = [];
const mk = (c: Case) => {
    const dir = mkdtempSync(join(tmpdir(), 'cjsdiff-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    for (const [name, src] of Object.entries(c.files)) writeFileSync(join(dir, name), src);
    return dir;
};

/** Run a built bundle in a FRESH node process, so globals cannot leak between arms or cases. */
const runIsolated = (dir: string, file: string): string => {
    const probe = join(dir, `__probe-${file.replace(/[^\w]/g, '_')}.mjs`);
    writeFileSync(
        probe,
        `const m = await import(${JSON.stringify(pathToFileURL(join(dir, file)).href)});\nprocess.stdout.write(JSON.stringify(await (m.x ?? m.default)) ?? 'undefined');\n`,
    );
    try {
        return execFileSync(process.execPath, [probe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        return `THREW: ${
            String((e as { stderr?: string }).stderr ?? e)
                .split('\n')
                .find((l) => /Error|error/.test(l))
                ?.trim() ?? 'unknown'
        }`;
    }
};

/** Each bundler writes into its OWN subdirectory. Prefixing filenames inside one directory instead
 *  breaks the relative specifiers a multi-chunk build emits, which fails identically for both arms
 *  and reads as a false "identical". */
const outDir = (dir: string, who: string) => {
    const d = join(dir, who);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'package.json'), '{"type":"module"}');
    return d;
};

const buildShakeup = async (c: Case, dir: string): Promise<string> => {
    let r: Awaited<ReturnType<typeof bundle>>;
    try {
        r = await bundle({
            entry: join(dir, c.entry ?? 'main.js'),
            fs: nodeFsFrom(),
            external: [],
            output: c.output ?? {},
            platform: c.platform,
        });
    } catch (e) {
        return `BUILD THREW: ${String((e as Error).message)
            .split('\n')[0]
            .slice(0, 90)}`;
    }
    if (r.errors.length > 0) return `BUILD ERROR: ${r.errors[0].slice(0, 90)}`;
    const d = outDir(dir, 'sk');
    for (const ch of r.chunks) writeFileSync(join(d, ch.fileName), ch.code.replace(/^\/\/# sourceMappingURL=.*$/gm, ''));
    return runIsolated(d, r.chunks.find((ch) => ch.isEntry)!.fileName);
};

const buildRolldown = async (c: Case, dir: string): Promise<string> => {
    try {
        const b = await rolldown({ input: join(dir, c.entry ?? 'main.js'), logLevel: 'silent', platform: c.platform });
        const { output } = await b.generate({ format: 'es', ...(c.output?.minify === true ? { minify: true } : {}) });
        const d = outDir(dir, 'rd');
        for (const ch of output) if (ch.type === 'chunk') writeFileSync(join(d, ch.fileName), ch.code);
        const entryChunk = output.find((ch) => ch.type === 'chunk' && ch.isEntry)!;
        return runIsolated(d, entryChunk.fileName);
    } catch (e) {
        return `BUILD ERROR: ${String((e as Error).message)
            .split('\n')[0]
            .slice(0, 90)}`;
    }
};

const runNode = (c: Case, dir: string): string => (c.noNode === true ? '—' : runIsolated(dir, c.entry ?? 'main.js'));

let diverged = 0;
let expected = 0;
const rows: string[] = [];
for (const c of cases) {
    const dir = mk(c);
    const sk = await buildShakeup(c, dir);
    const rd = await buildRolldown(c, dir);
    const nd = runNode(c, dir);
    const same = sk === rd;
    if (!same) {
        if (EXPECTED[c.name] !== undefined) expected++;
        else diverged++;
    }
    const mark = same ? '  ok  ' : EXPECTED[c.name] !== undefined ? ' note ' : ' DIFF ';
    rows.push(`${mark} ${c.name}`);
    if (!same) {
        rows.push(`         shakeup  ${sk}`);
        rows.push(`         rolldown ${rd}`);
        rows.push(`         node     ${nd}`);
        if (EXPECTED[c.name] !== undefined) rows.push(`         reason:  ${EXPECTED[c.name]}`);
    } else if (nd !== '—' && nd !== sk) {
        rows.push(`         (both bundlers agree; NODE differs: ${nd})`);
    }
}
console.log(rows.join('\n'));
console.log(
    `\n${cases.length} cases · ${cases.length - diverged - expected} identical · ${expected} expected-different · ${diverged} UNEXPLAINED`,
);
for (const d of dirs) rmSync(d, { recursive: true, force: true });
process.exit(diverged === 0 ? 0 : 1);
