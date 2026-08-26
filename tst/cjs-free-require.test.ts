import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import type { Platform } from '../src/resolve.ts';

// cjs.md D7-D10 — a `require` reference that is NOT a call: `typeof require`, `require.resolve(x)`,
// `require.cache`, a bare `require` passed as a value. Each one used to reach the output verbatim,
// where `require` does not exist in an ES module: `typeof require` was `'function'`-less so a UMD
// header silently took the browser-global branch (D7), and the other three threw
// `require is not defined` at load (D8-D10).
//
// esbuild substitutes its `__require` stub for exactly these — `ref == p.requireRef &&
// !opts.isCallTarget` (`js_parser.go:17181`) — and rolldown inherits it, with a second form for
// `platform: 'node'` that is `createRequire(import.meta.url)`, i.e. a REAL require
// (`runtime-tail-node.js`, selected at `runtime_module_task.rs:42`).
//
// Every assertion EXECUTES the output from a real file: `import.meta.url` has to be a file URL for
// `createRequire` to work, so a `data:` URL would not exercise the thing under test.
const dirs: string[] = [];
afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const run = async (cjs: string, platform: Platform = 'browser') => {
    const r = await bundle({
        entry: '/main.js',
        external: [],
        platform,
        fs: createMemoryFs({ '/d.cjs': cjs, '/main.js': "import d from './d.cjs';\nexport const x = d;" }),
    });
    expect(r.errors).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'shakeup-req-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'm.js'), r.chunks[0].code);
    const ns = (await import(pathToFileURL(join(dir, 'm.js')).href)) as { x: unknown };
    return { value: ns.x, code: r.chunks[0].code };
};

describe('free `require` references are substituted', () => {
    it('D7 — `typeof require` is "function", so a UMD header takes the CommonJS branch', async () => {
        const { value } = await run("module.exports = typeof require === 'function' ? 'cjs' : 'browser';");
        expect(value).toBe('cjs');
    });

    it('D10 — a bare `require` passed as a value survives', async () => {
        const { value } = await run('function f(r) { return typeof r }\nmodule.exports = f(require);');
        expect(value).toBe('function');
    });

    it('D9 — `require.cache` reads instead of throwing', async () => {
        // Deliberately NOT pinned to a value. Which one you get is a property of the host: the shim
        // defers to a real `require` when the environment has one (which vitest's runner does), and
        // falls back to the stub's missing property when it does not. The regression this guards is
        // that the read used to THROW `require is not defined` in either case.
        const { value } = await run('module.exports = typeof require.cache;');
        expect(typeof value).toBe('string');
    });

    it('D8/D9 — on `platform: "node"` the shim is a REAL require', async () => {
        // `createRequire(import.meta.url)` IS Node's require, so `.resolve` and `.cache` are the
        // genuine articles rather than a stub's missing properties.
        const { value, code } = await run(
            'module.exports = [typeof require, typeof require.resolve, typeof require.cache];',
            'node',
        );
        expect(value).toEqual(['function', 'function', 'object']);
        expect(code).toContain("import { createRequire } from 'node:module';");
        expect(code).not.toContain('new Proxy');
    });

    it("emits the oracle's Proxy shim verbatim off `node`", async () => {
        // The shim's shape is the assertion here, because its two subtleties cannot be observed from
        // inside a test runner that already provides a `require` of its own:
        //   · the target is a FUNCTION, so `typeof require` is `'function'` even off Node (#1202);
        //   · the lookup is a PROXY, not a captured value, so a `require` installed LATER still wins,
        //     including through a property access like `require.resolve` (#1614).
        // Both are the reason esbuild wrote it this way and rolldown copied it unchanged; a shim
        // derived from scratch gets both wrong.
        const { code } = await run("module.exports = typeof require === 'function';");
        expect(code).toContain('new Proxy(x, {');
        expect(code).toContain("get: (a, b) => (typeof require !== 'undefined' ? require : a)[b]");
        expect(code).toMatch(/__require = \/\* @__PURE__ \*\/ \(\(x\) =>/);
        expect(code).toContain(': x)(function (x) {');
    });

    // ── the boundary: what must NOT be substituted ──

    it('a resolvable `require("./x")` is still lowered, not routed through the shim', async () => {
        const r = await bundle({
            entry: '/main.js',
            external: [],
            fs: createMemoryFs({
                '/i.cjs': 'module.exports = 5;',
                '/d.cjs': "module.exports = require('./i.cjs') + 1;",
                '/main.js': "import d from './d.cjs';\nexport const x = d;",
            }),
        });
        expect(r.errors).toEqual([]);
        expect(r.code).not.toContain('__require');
        expect((await import(`data:text/javascript,${encodeURIComponent(r.code)}`)).x).toBe(6);
    });

    it('a DYNAMIC require is still a loud build error, not a runtime throw', async () => {
        // The deliberate divergence: shakeup emits ESM only and has no runtime module registry, so
        // `require(expr)` cannot work and is reported at build time. Substituting the shim in call
        // position — which is what esbuild does — would turn that into a runtime failure instead.
        const r = await bundle({
            entry: '/main.js',
            external: [],
            fs: createMemoryFs({
                '/d.cjs': 'module.exports = require(globalThis.n);',
                '/main.js': "import d from './d.cjs';\nexport const x = d;",
            }),
        });
        expect(r.errors.join('\n')).toMatch(/cannot statically resolve this require\(\)/);
    });

    it('a LOCAL binding named `require` is untouched', async () => {
        const { value } = await run(
            'function make(require) { return require("shadowed") }\nmodule.exports = make((s) => s + "!");',
        );
        expect(value).toBe('shadowed!');
    });

    it('a bundle with no free `require` carries no shim', async () => {
        const r = await bundle({ entry: '/main.js', external: [], fs: createMemoryFs({ '/main.js': 'export const x = 1;' }) });
        expect(r.code).not.toContain('__require');
        expect(r.code).not.toContain('node:module');
    });
});
