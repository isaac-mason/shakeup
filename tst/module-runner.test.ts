import { afterEach, describe, expect, it } from 'vitest';
import { createModuleRunner, defaultEvaluator } from '../src/module-runner.ts';
import { moduleRunnerTransform } from '../src/transform.ts';

/** A runner over an in-memory source graph. Ids ARE the import specifiers; any
 *  unknown specifier is treated as external. Each module is transformed for real
 *  by moduleRunnerTransform, so this is a source→transform→run end-to-end test. */
function graph(sources: Record<string, string>, externals: Record<string, unknown> = {}) {
    return createModuleRunner({
        resolveId: (spec) => (spec in sources ? spec : { external: spec }),
        fetchModule: (id) => {
            const r = moduleRunnerTransform(id, sources[id]);
            if (r.errors.length) throw new Error(r.errors.join('\n'));
            return r.code;
        },
        evaluator: { ...defaultEvaluator, runExternalModule: async (spec) => externals[spec] },
        createImportMeta: (id) => ({ url: `sk://${id}` }),
    });
}

afterEach(() => {
    (globalThis as Record<string, unknown>).__log = undefined;
});

describe('runner — basic linking', () => {
    it('imports and evaluates a dependency', async () => {
        const ns = await graph({
            entry: `import { v } from 'dep';\nexport const result = v * 2;`,
            dep: `export const v = 21;`,
        }).import('entry');
        expect(ns.result).toBe(42);
    });

    it('default + named + namespace across modules', async () => {
        const ns = await graph({
            entry: `import d, { n } from 'm';\nimport * as star from 'm';\nexport const out = [d, n, star.n];`,
            m: `export default 'D';\nexport const n = 'N';`,
        }).import('entry');
        expect(ns.out).toEqual(['D', 'N', 'N']);
    });

    it('native-imports external specifiers', async () => {
        const ns = await graph(
            { entry: `import x from 'react';\nexport const r = x.tag;` },
            { react: { default: { tag: 'ext' } } },
        ).import('entry');
        expect(ns.r).toBe('ext');
    });

    it('exposes import.meta.url', async () => {
        const ns = await graph({ entry: `export const u = import.meta.url;` }).import('entry');
        expect(ns.u).toBe('sk://entry');
    });

    it('provides import.meta.env (never throws; realm-injected)', async () => {
        const runner = createModuleRunner({
            resolveId: (s) => s,
            fetchModule: (id) => moduleRunnerTransform(id, `export const m = import.meta.env.MODE;`).code,
            createImportMeta: (id) => ({ url: id }),
            env: { MODE: 'development' },
        });
        expect((await runner.import('x')).m).toBe('development');
        // default {} so access never throws even without config
        const bare = createModuleRunner({
            resolveId: (s) => s,
            fetchModule: (id) => moduleRunnerTransform(id, `export const m = import.meta.env.MODE ?? 'none';`).code,
        });
        expect((await bare.import('y')).m).toBe('none');
    });

    it('does NOT cache a module that threw during evaluation', async () => {
        const src: Record<string, string> = { bad: `throw new Error('boom');` };
        const runner = createModuleRunner({ resolveId: (s) => s, fetchModule: (id) => moduleRunnerTransform(id, src[id]).code });
        await expect(runner.import('bad')).rejects.toThrow('boom');
        src.bad = `export const v = 99;`; // fixed edit
        expect((await runner.import('bad')).v).toBe(99); // re-evaluates, not stale partial
    });
});

describe('runner — live bindings', () => {
    it('imported bindings reflect later mutation in the owning module', async () => {
        const ns = await graph({
            entry: `import { n, inc } from 'c';\nexport const before = n;\ninc();\nexport const after = n;`,
            c: `export let n = 0;\nexport function inc() { n++; }`,
        }).import('entry');
        expect(ns.before).toBe(0);
        expect(ns.after).toBe(1);
    });
});

describe('runner — circular dependencies', () => {
    it('resolves a two-module cycle via hoisted live getters', async () => {
        const ns = await graph({
            entry: `import { ab } from 'a';\nimport { ba } from 'b';\nexport const r1 = ab();\nexport const r2 = ba();`,
            a: `import { b } from 'b';\nexport const a = 'a';\nexport const ab = () => a + b;`,
            b: `import { a } from 'a';\nexport const b = 'b';\nexport const ba = () => b + a;`,
        }).import('entry');
        expect(ns.r1).toBe('ab');
        expect(ns.r2).toBe('ba');
    });
});

describe('runner — re-exports', () => {
    it('export * flows through the runner', async () => {
        const ns = await graph({
            entry: `import { a, b } from 'barrel';\nexport const out = [a, b];`,
            barrel: `export * from 'x';\nexport * from 'y';`,
            x: `export const a = 1;`,
            y: `export const b = 2;`,
        }).import('entry');
        expect(ns.out).toEqual([1, 2]);
    });
});

describe('runner — HMR', () => {
    it('applyUpdate re-evaluates a self-accepting module and runs its callback', async () => {
        const sources: Record<string, string> = {
            m: `globalThis.__log = globalThis.__log || [];\nexport const v = 1;\nimport.meta.hot.accept((mod) => { globalThis.__log.push(mod.v); });`,
        };
        const runner = createModuleRunner({
            resolveId: (spec) => spec,
            fetchModule: (id) => moduleRunnerTransform(id, sources[id]).code,
            createImportMeta: (id) => ({ url: id }),
        });
        const ns = await runner.import('m');
        expect(ns.v).toBe(1);

        sources.m = sources.m.replace('export const v = 1;', 'export const v = 2;');
        const handled = await runner.applyUpdate('m');
        expect(handled).toBe(true);
        expect((globalThis as { __log?: unknown[] }).__log).toEqual([2]); // callback got the NEW exports
    });

    it('runs dispose before re-evaluation and preserves hot.data', async () => {
        const sources: Record<string, string> = {
            m: `globalThis.__log = globalThis.__log || [];\nimport.meta.hot.data.seen = (import.meta.hot.data.seen || 0) + 1;\nglobalThis.__log.push(import.meta.hot.data.seen);\nimport.meta.hot.accept();\nimport.meta.hot.dispose(() => { globalThis.__log.push('dispose'); });`,
        };
        const runner = createModuleRunner({
            resolveId: (spec) => spec,
            fetchModule: (id) => moduleRunnerTransform(id, sources[id]).code,
            createImportMeta: (id) => ({ url: id }),
        });
        await runner.import('m');
        await runner.applyUpdate('m');
        // first eval: seen=1; update: dispose runs, then re-eval seen=2 (data preserved).
        expect((globalThis as { __log?: unknown[] }).__log).toEqual([1, 'dispose', 2]);
    });

    it('dep-accept accept(dep, cb) does not crash and is not treated as self-accept', async () => {
        const src: Record<string, string> = {
            m: `import { v } from 'dep';\nimport.meta.hot.accept('dep', () => {});\nexport const got = v;`,
            dep: `export const v = 1;`,
        };
        const runner = createModuleRunner({ resolveId: (s) => s, fetchModule: (id) => moduleRunnerTransform(id, src[id]).code });
        await runner.import('m');
        src.dep = `export const v = 2;`;
        // m dep-accepts 'dep' but does NOT self-accept → its own update bubbles (false),
        // and crucially the dep string is not mispushed as a callback (would throw).
        expect(await runner.applyUpdate('m')).toBe(false);
    });

    it('applyUpdate returns false for a module that does not self-accept', async () => {
        const runner = createModuleRunner({
            resolveId: (spec) => spec,
            fetchModule: () => moduleRunnerTransform('m', `export const v = 1;`).code,
            createImportMeta: (id) => ({ url: id }),
        });
        await runner.import('m');
        expect(await runner.applyUpdate('m')).toBe(false);
    });
});

describe('runner — HMR robustness', () => {
    it('contains an error during update, keeping the last-good instance (#3)', async () => {
        const src: Record<string, string> = { m: `export const v = 1;\nimport.meta.hot.accept();` };
        const runner = createModuleRunner({
            resolveId: (s) => s,
            fetchModule: (id) => moduleRunnerTransform(id, src[id]).code,
            createImportMeta: (id) => ({ url: id }),
        });
        expect((await runner.import('m')).v).toBe(1);
        src.m = `throw new Error('boom');\nexport const v = 2;\nimport.meta.hot.accept();`;
        await expect(runner.applyUpdate('m')).rejects.toThrow('boom');
        expect((await runner.import('m')).v).toBe(1); // old instance survived
    });

    it('applyHmr(dep) fires a single-dep accept callback with the fresh module (#1)', async () => {
        const log: number[] = [];
        (globalThis as { __d?: number[] }).__d = log;
        const src: Record<string, string> = {
            imp: `import { v } from 'dep';\nimport.meta.hot.accept('dep', (nd) => { globalThis.__d.push(nd.v); });\nexport const r = v;`,
            dep: `export const v = 1;`,
        };
        const runner = createModuleRunner({
            resolveId: (s) => s,
            fetchModule: (id) => moduleRunnerTransform(id, src[id]).code,
            createImportMeta: (id) => ({ url: id }),
        });
        await runner.import('imp');
        src.dep = `export const v = 2;`;
        runner.invalidate('dep');
        expect(await runner.applyHmr('imp', 'dep')).toBe(true);
        expect(log).toEqual([2]);
        (globalThis as { __d?: number[] }).__d = undefined;
    });
});

describe('runner — host seams', () => {
    it('runs prepare() once, before any module body (#7)', async () => {
        const order: string[] = [];
        const runner = createModuleRunner({
            resolveId: (s) => s,
            fetchModule: (id) => moduleRunnerTransform(id, `globalThis.__ord.push('body');\nexport const v = 1;`).code,
            prepare: () => order.push('prepare'),
        });
        (globalThis as { __ord?: string[] }).__ord = order;
        await runner.import('a');
        await runner.import('b'); // second import must NOT prepare again
        (globalThis as { __ord?: string[] }).__ord = undefined;
        expect(order).toEqual(['prepare', 'body', 'body']);
    });

    it('the evaluator is the external policy — a browser host rejects node: (#8)', async () => {
        const runner = createModuleRunner({
            resolveId: (spec) => ({ external: spec }),
            fetchModule: (id) => moduleRunnerTransform(id, `import fs from 'node:fs';\nexport const f = fs;`).code,
            evaluator: {
                ...defaultEvaluator,
                runExternalModule: async (spec) => {
                    if (spec.startsWith('node:')) throw new Error(`node builtin '${spec}' in a browser realm`);
                    return {};
                },
            },
        });
        await expect(runner.import('m')).rejects.toThrow(/node builtin 'node:fs'/);
    });
});

describe('runner — custom HMR events (on/off/send)', () => {
    it('send() forwards outbound; emit() delivers inbound to on() listeners', async () => {
        const sent: Array<[string, unknown]> = [];
        const got: unknown[] = [];
        (globalThis as { __got?: unknown[] }).__got = got;
        const runner = createModuleRunner({
            resolveId: (s) => s,
            fetchModule: (id) =>
                moduleRunnerTransform(
                    id,
                    `import.meta.hot.on('ping', (d) => { globalThis.__got.push(d); });\nimport.meta.hot.send('ready', { id: 1 });\nexport const v = 1;`,
                ).code,
            createImportMeta: (id) => ({ url: id }),
            onHotSend: (event, data) => sent.push([event, data]),
        });
        await runner.import('m');
        expect(sent).toEqual([['ready', { id: 1 }]]); // outbound send
        runner.emit('ping', 'hello'); // inbound → on('ping')
        expect(got).toEqual(['hello']);
        (globalThis as { __got?: unknown[] }).__got = undefined;
    });
});

describe('runner — evaluator + import.meta', () => {
    it('createImportMeta provides url + filename', async () => {
        const runner = createModuleRunner({
            resolveId: (s) => s,
            fetchModule: (id) =>
                moduleRunnerTransform(id, `export const u = import.meta.url;\nexport const f = import.meta.filename;`).code,
            createImportMeta: (id) => ({ url: `sk://${id}`, filename: id }),
        });
        const ns = await runner.import('/m.ts');
        expect(ns.u).toBe('sk:///m.ts');
        expect(ns.f).toBe('/m.ts');
    });

    it('a custom evaluator replaces how modules are run (CSP/vm/edge seam)', async () => {
        const ran: string[] = [];
        const runner = createModuleRunner({
            resolveId: (s) => s,
            fetchModule: (id) => moduleRunnerTransform(id, `export const v = 42;`).code,
            evaluator: {
                startOffset: 0,
                runModule: (ctx, code) => {
                    ran.push(code);
                    return defaultEvaluator.runModule(ctx, code);
                },
                runExternalModule: defaultEvaluator.runExternalModule,
            },
        });
        expect((await runner.import('m')).v).toBe(42);
        expect(ran.length).toBe(1); // the injected evaluator ran the module
    });
});

describe('runner — source maps', () => {
    it('attaches a real map without breaking evaluation', async () => {
        const runner = createModuleRunner({
            resolveId: (s) => s,
            fetchModule: (id) => {
                const r = moduleRunnerTransform(id, `export const v = 42;`, { sourcemap: true });
                return { code: r.code, map: r.map };
            },
        });
        // the default evaluator attaches //# sourceMappingURL (startOffset-shifted) —
        // the module must still evaluate correctly.
        expect((await runner.import('m')).v).toBe(42);
    });
});
