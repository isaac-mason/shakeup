import { afterEach, describe, expect, it } from 'vitest';
import { createDevServer } from '../src/dev-server.ts';
import { createEnvironment } from '../src/environment.ts';
import type { Fs } from '../src/fs.ts';

/** ONE dev server (shared transform) + a factory for named environments (each its
 *  own runner/instances + its own import.meta.env). */
function multiEnv(files: Record<string, string>) {
    const fs: Fs = { read: (id) => files[id] ?? null, exists: (id) => id in files };
    const server = createDevServer({ fs });
    const env = (name: string, envObj: Record<string, unknown> = {}) =>
        createEnvironment({
            name,
            fetchModule: server.fetchModule,
            resolveId: server.resolveId,
            createImportMeta: (id) => ({ url: `sk://${name}${id}` }),
            env: envObj,
        });
    return { server, env, files };
}

afterEach(() => {
    (globalThis as Record<string, unknown>).__log = undefined;
});

describe('environment — isolation (one bundler, many apps)', () => {
    it('each env evaluates the SAME code into its OWN instances', async () => {
        const { env } = multiEnv({
            '/entry.ts': `export { box, bump } from './state';`,
            '/state.ts': `export const box = { n: 0 };\nexport function bump() { box.n++; }`,
        });
        const client = await env('client').import('/entry.ts');
        const server = await env('server').import('/entry.ts');
        (client.bump as () => void)();
        (client.bump as () => void)();
        (server.bump as () => void)();
        expect((client.box as { n: number }).n).toBe(2); // client's own module instance
        expect((server.box as { n: number }).n).toBe(1); // server's — isolated singleton
    });

    it('import.meta.env differs per env (client vs server) from one transform', async () => {
        const { env } = multiEnv({ '/m.ts': `export const mode = import.meta.env.MODE;` });
        const client = await env('client', { MODE: 'client' }).import('/m.ts');
        const server = await env('server', { MODE: 'server' }).import('/m.ts');
        expect(client.mode).toBe('client');
        expect(server.mode).toBe('server');
    });
});

describe('environment — HMR propagation', () => {
    it('a self-accepting edit updates each env independently', async () => {
        const { server, env, files } = multiEnv({
            '/m.ts': `globalThis.__log ??= [];\nexport let v = 1;\nimport.meta.hot.accept((nm) => { globalThis.__log.push(import.meta.env.N + ':' + nm.v); });`,
        });
        const client = env('client', { N: 'client' });
        const srv = env('server', { N: 'server' });
        await client.import('/m.ts');
        await srv.import('/m.ts');

        files['/m.ts'] = files['/m.ts'].replace('v = 1', 'v = 2');
        server.invalidate('/m.ts');
        expect(await client.applyEdit('/m.ts')).toEqual({ type: 'update', boundaries: ['/m.ts'] });
        expect(await srv.applyEdit('/m.ts')).toEqual({ type: 'update', boundaries: ['/m.ts'] });

        // each env re-evaluated its own instance and ran its own accept callback.
        expect((globalThis as { __log?: unknown[] }).__log).toEqual(['client:2', 'server:2']);
        expect((await client.import('/m.ts')).v).toBe(2);
    });

    it('an accepted dependency fires the importer callback with the fresh dep', async () => {
        const { server, env, files } = multiEnv({
            '/entry.ts': `globalThis.__log ??= [];\nimport { v } from './dep';\nimport.meta.hot.accept('./dep', (nd) => { globalThis.__log.push(nd.v); });\nexport const r = v;`,
            '/dep.ts': `export const v = 1;`,
        });
        const e = env('e');
        await e.import('/entry.ts');

        files['/dep.ts'] = `export const v = 2;`;
        server.invalidate('/dep.ts');
        // dep-accept: boundary is the importer, but the importer is NOT re-evaluated —
        // its callback fires with the fresh dep namespace (Vite semantics).
        expect(await e.applyEdit('/dep.ts')).toEqual({ type: 'update', boundaries: ['/entry.ts'] });
        expect((globalThis as { __log?: unknown[] }).__log).toEqual([2]);
    });

    it('a non-accepted edit is a full reload', async () => {
        const { server, env, files } = multiEnv({
            '/entry.ts': `import { v } from './dep';\nexport const r = v;`,
            '/dep.ts': `export const v = 1;`,
        });
        const e = env('e');
        await e.import('/entry.ts');

        files['/dep.ts'] = `export const v = 2;`;
        server.invalidate('/dep.ts');
        expect((await e.applyEdit('/dep.ts')).type).toBe('full-reload');
    });

    it('editing a module this env never loaded is a noop', async () => {
        const { env } = multiEnv({ '/a.ts': `export const a = 1;`, '/b.ts': `export const b = 2;` });
        const e = env('e');
        await e.import('/a.ts');
        expect((await e.applyEdit('/b.ts')).type).toBe('noop');
    });
});

describe('environment — invalidate() bubbling', () => {
    it('a self-accept that calls invalidate() bubbles to its importer boundary', async () => {
        const { server, env, files } = multiEnv({
            '/entry.ts': `globalThis.__log ??= [];\nimport { v } from './m';\nimport.meta.hot.accept('./m', () => { globalThis.__log.push('entry-got-m'); });\nexport const r = v;`,
            '/m.ts': `globalThis.__log ??= [];\nexport let v = 1;\nimport.meta.hot.accept(() => { globalThis.__log.push('m-self'); import.meta.hot.invalidate(); });`,
        });
        const e = env('e');
        await e.import('/entry.ts');

        files['/m.ts'] = files['/m.ts'].replace('v = 1', 'v = 2');
        server.invalidate('/m.ts');
        const u = await e.applyEdit('/m.ts');
        expect(u.type).toBe('update');
        // m self-accepted, then invalidated → bubbled to entry's dep-accept boundary.
        expect((globalThis as { __log?: unknown[] }).__log).toEqual(['m-self', 'entry-got-m']);
    });

    it('invalidate() that reaches a root with no acceptance is a full reload', async () => {
        const { server, env, files } = multiEnv({
            '/entry.ts': `import { v } from './m';\nexport const r = v;`,
            '/m.ts': `export let v = 1;\nimport.meta.hot.accept(() => { import.meta.hot.invalidate(); });`,
        });
        const e = env('e');
        await e.import('/entry.ts');
        files['/m.ts'] = files['/m.ts'].replace('v = 1', 'v = 2');
        server.invalidate('/m.ts');
        // m self-accepts then invalidates → bubbles to entry (no accept, root) → full reload.
        expect((await e.applyEdit('/m.ts')).type).toBe('full-reload');
    });
});

describe('environment — full-reload signal', () => {
    it('fires onFullReload when an edit cannot be HMR-handled', async () => {
        const files: Record<string, string> = {
            '/entry.ts': `import { v } from './dep';\nexport const r = v;`,
            '/dep.ts': `export const v = 1;`,
        };
        const server = createDevServer({ fs: { read: (id) => files[id] ?? null, exists: (id) => id in files } });
        const reloaded: string[] = [];
        const e = createEnvironment({
            name: 'e',
            fetchModule: server.fetchModule,
            resolveId: server.resolveId,
            createImportMeta: (id) => ({ url: id }),
            onFullReload: (id) => reloaded.push(id),
        });
        await e.import('/entry.ts');
        files['/dep.ts'] = `export const v = 2;`;
        server.invalidate('/dep.ts');
        expect((await e.applyEdit('/dep.ts')).type).toBe('full-reload');
        expect(reloaded).toEqual(['/dep.ts']);
    });
});

describe('environment — dynamic-import boundaries', () => {
    it('editing a dynamically-imported module invalidates it (no full reload)', async () => {
        const { server, env, files } = multiEnv({
            '/entry.ts': `export async function load() { return (await import('./lazy')).v; }`,
            '/lazy.ts': `export const v = 1;`,
        });
        const e = env('e');
        const ns = await e.import('/entry.ts');
        expect(await (ns.load as () => Promise<number>)()).toBe(1);

        files['/lazy.ts'] = `export const v = 2;`;
        server.invalidate('/lazy.ts');
        // /lazy is only dynamically imported → dynamic boundary → update, not full reload.
        expect((await e.applyEdit('/lazy.ts')).type).toBe('update');
        // next dynamic import() gets the fresh module.
        expect(await (ns.load as () => Promise<number>)()).toBe(2);
    });
});

describe('environment — acceptExports + prune', () => {
    it('acceptExports fires only when a named export changes', async () => {
        const { server, env, files } = multiEnv({
            '/m.ts': `globalThis.__log ??= [];\nexport let a = 1;\nexport let b = 1;\nimport.meta.hot.acceptExports(['a'], (nm) => { globalThis.__log.push('a=' + nm.a); });`,
        });
        const e = env('e');
        await e.import('/m.ts');

        // change only b — 'a' unchanged → callback must NOT fire.
        files['/m.ts'] = files['/m.ts'].replace('let b = 1', 'let b = 2');
        server.invalidate('/m.ts');
        expect((await e.applyEdit('/m.ts')).type).toBe('update');
        expect((globalThis as { __log?: unknown[] }).__log ?? []).toEqual([]);

        // change a → callback fires.
        files['/m.ts'] = files['/m.ts'].replace('let a = 1', 'let a = 9');
        server.invalidate('/m.ts');
        await e.applyEdit('/m.ts');
        expect((globalThis as { __log?: unknown[] }).__log).toEqual(['a=9']);
    });

    it('prunes a module that an edit removed from the graph', async () => {
        const { server, env, files } = multiEnv({
            '/entry.ts': `import './a';\nimport.meta.hot.accept();`,
            '/a.ts': `globalThis.__log ??= [];\nimport.meta.hot.accept();\nimport.meta.hot.prune(() => { globalThis.__log.push('a-pruned'); });`,
        });
        const e = env('e');
        await e.import('/entry.ts');
        expect(e.node('/a.ts')).toBeDefined();

        files['/entry.ts'] = `import.meta.hot.accept();`; // no longer imports ./a
        server.invalidate('/entry.ts');
        await e.applyEdit('/entry.ts');
        // /a orphaned → pruned; its prune callback ran.
        expect((globalThis as { __log?: unknown[] }).__log).toEqual(['a-pruned']);
        expect(e.node('/a.ts')).toBeUndefined();
    });
});

describe('dev server — handleChange fan-out', () => {
    it('one handleChange updates every registered environment independently', async () => {
        const { server, env, files } = multiEnv({
            '/m.ts': `globalThis.__log ??= [];\nexport let v = 1;\nimport.meta.hot.accept((nm) => { globalThis.__log.push(import.meta.env.N + ':' + nm.v); });`,
        });
        const client = env('client', { N: 'client' });
        const srv = env('server', { N: 'server' });
        server.register(client);
        server.register(srv);
        await client.import('/m.ts');
        await srv.import('/m.ts');

        files['/m.ts'] = files['/m.ts'].replace('v = 1', 'v = 2');
        const results = await server.handleChange('/m.ts');
        expect(results.map((r) => [r.env, r.update.type])).toEqual([
            ['client', 'update'],
            ['server', 'update'],
        ]);
        expect((globalThis as { __log?: unknown[] }).__log).toEqual(['client:2', 'server:2']);
    });

    it('a change is a noop for an env that never loaded the module', async () => {
        const { server, env, files } = multiEnv({
            '/a.ts': `export let a = 1;\nimport.meta.hot.accept();`,
            '/b.ts': `export let b = 1;\nimport.meta.hot.accept();`,
        });
        const e = env('e');
        server.register(e);
        await e.import('/a.ts'); // only /a loaded
        files['/b.ts'] = files['/b.ts'].replace('b = 1', 'b = 2');
        const results = await server.handleChange('/b.ts');
        expect(results).toEqual([{ env: 'e', update: { type: 'noop' } }]);
    });
});

describe('environment — HMR edge cases', () => {
    it('multi-hop: editing a leaf bubbles to a grandparent that accepts the mid', async () => {
        const { server, env, files } = multiEnv({
            '/entry.ts': `globalThis.__log ??= [];\nimport { m } from './mid';\nimport.meta.hot.accept('./mid', (nm) => { globalThis.__log.push('entry-got:' + nm.m); });\nexport const r = m;`,
            '/mid.ts': `import { leaf } from './leaf';\nexport const m = 'mid-' + leaf;`,
            '/leaf.ts': `export const leaf = 1;`,
        });
        const e = env('e');
        await e.import('/entry.ts');
        files['/leaf.ts'] = `export const leaf = 2;`;
        server.invalidate('/leaf.ts');
        const u = await e.applyEdit('/leaf.ts');
        expect(u).toEqual({ type: 'update', boundaries: ['/entry.ts'] });
        // mid re-linked the fresh leaf; entry's cb got the fresh mid.
        expect((globalThis as { __log?: string[] }).__log).toEqual(['entry-got:mid-2']);
    });

    it('a change fires every accepting importer', async () => {
        const { server, env, files } = multiEnv({
            '/a.ts': `globalThis.__log ??= [];\nimport { v } from './dep';\nimport.meta.hot.accept('./dep', (n) => { globalThis.__log.push('a:' + n.v); });\nexport const _ = v;`,
            '/b.ts': `globalThis.__log ??= [];\nimport { v } from './dep';\nimport.meta.hot.accept('./dep', (n) => { globalThis.__log.push('b:' + n.v); });\nexport const _ = v;`,
            '/entry.ts': `import './a';\nimport './b';\nimport.meta.hot.accept();`,
            '/dep.ts': `export const v = 1;`,
        });
        const e = env('e');
        await e.import('/entry.ts');
        files['/dep.ts'] = `export const v = 2;`;
        server.invalidate('/dep.ts');
        const u = await e.applyEdit('/dep.ts');
        expect(u.type).toBe('update');
        expect(((globalThis as { __log?: string[] }).__log ?? []).sort()).toEqual(['a:2', 'b:2']);
    });

    it('hot.data persists across multiple updates', async () => {
        const { server, env, files } = multiEnv({
            '/m.ts': `globalThis.__log ??= [];\nimport.meta.hot.data.n = (import.meta.hot.data.n ?? 0) + 1;\nglobalThis.__log.push(import.meta.hot.data.n);\nexport let v = 0;\nimport.meta.hot.accept();`,
        });
        const e = env('e');
        await e.import('/m.ts');
        for (let i = 1; i <= 2; i++) {
            files['/m.ts'] = files['/m.ts'].replace(`v = ${i - 1}`, `v = ${i}`);
            server.invalidate('/m.ts');
            await e.applyEdit('/m.ts');
        }
        expect((globalThis as { __log?: number[] }).__log).toEqual([1, 2, 3]);
    });

    it('circular dep member self-accepts and updates', async () => {
        const { server, env, files } = multiEnv({
            '/a.ts': `globalThis.__log ??= [];\nimport { b } from './b';\nexport let a = 'a1';\nexport const ab = () => a + b;\nimport.meta.hot.accept((n) => { globalThis.__log.push(n.ab()); });`,
            '/b.ts': `import { a } from './a';\nexport const b = 'b';\nexport const ba = () => b + a;`,
        });
        const e = env('e');
        await e.import('/a.ts');
        files['/a.ts'] = files['/a.ts'].replace(`a = 'a1'`, `a = 'a2'`);
        server.invalidate('/a.ts');
        expect((await e.applyEdit('/a.ts')).type).toBe('update');
        expect((globalThis as { __log?: string[] }).__log).toEqual(['a2b']);
    });

    it('re-imports a module after it was pruned', async () => {
        const { server, env, files } = multiEnv({
            '/entry.ts': `import './a';\nimport.meta.hot.accept();`,
            '/a.ts': `export const a = 1;\nimport.meta.hot.accept();`,
        });
        const e = env('e');
        await e.import('/entry.ts');
        files['/entry.ts'] = `import.meta.hot.accept();`; // drop ./a → prune
        server.invalidate('/entry.ts');
        await e.applyEdit('/entry.ts');
        expect(e.node('/a.ts')).toBeUndefined();
        // re-add the import → /a loads fresh again.
        files['/entry.ts'] = `import { a } from './a';\nexport const got = a;\nimport.meta.hot.accept();`;
        server.invalidate('/entry.ts');
        await e.applyEdit('/entry.ts');
        expect(e.node('/a.ts')).toBeDefined();
        expect((await e.import('/entry.ts')).got).toBe(1);
    });
});

describe('environment — source maps', () => {
    it('threads the dev-server map through to the evaluator (shifted for startOffset)', async () => {
        const { createDevServer } = await import('../src/dev-server.ts');
        const { createEnvironment } = await import('../src/environment.ts');
        const { defaultEvaluator } = await import('../src/runner.ts');
        const files: Record<string, string> = { '/m.ts': `export const v: number = 1;` };
        const server = createDevServer({ fs: { read: (id) => files[id] ?? null, exists: (id) => id in files }, sourcemap: true });

        // the dev server emits a map back to source
        const fetched = await server.fetchModule('/m.ts');
        expect(fetched.map).toBeDefined();
        expect(fetched.map?.sources).toEqual(['/m.ts']);

        // and it reaches the evaluator
        let receivedMap: unknown;
        const env = createEnvironment({
            name: 'e',
            fetchModule: server.fetchModule,
            resolveId: server.resolveId,
            evaluator: {
                startOffset: 2,
                runModule: (ctx, code, map) => {
                    receivedMap = map;
                    return defaultEvaluator.runModule(ctx, code);
                },
                runExternalModule: defaultEvaluator.runExternalModule,
            },
        });
        await env.import('/m.ts');
        expect(receivedMap).toBeDefined();
    });
});
