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
            metaUrl: (id) => `sk://${name}${id}`,
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
            metaUrl: (id) => id,
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
