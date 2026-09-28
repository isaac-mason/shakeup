import { afterEach, describe, expect, it } from 'vitest';
import { createDevServer } from '../src/bundler/runtime/dev-server.ts';
import { createEnvironment, type EnvironmentOptions } from '../src/bundler/runtime/environment.ts';
import type { Fs } from '../src/bundler/fs.ts';

/** ONE dev server (shared transform) + a factory for named environments (each its
 *  own runner/instances + its own import.meta.env). */
function multiEnv(files: Record<string, string>) {
    const fs: Fs = { read: (id) => files[id] ?? null, exists: (id) => id in files };
    const server = createDevServer({ fs });
    const env = (name: string, envObj: Record<string, unknown> = {}, extra: Partial<EnvironmentOptions> = {}) =>
        createEnvironment({
            name,
            fetchModule: server.fetchModule,
            resolveId: server.resolveId,
            createImportMeta: (id) => ({ url: `sk://${name}${id}` }),
            env: envObj,
            ...extra,
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

    it('a bare-specifier entry resolves through the resolver (npm-style package entry)', async () => {
        // The boot case: import('pkg/sub') — the entry must go through node-resolve
        // (package.json exports), not be fetched as the literal id 'pkg/sub'.
        const { env } = multiEnv({
            'node_modules/pkg/package.json': `{"name":"pkg","exports":{"./sub":"./sub.js"}}`,
            'node_modules/pkg/sub.js': `export const hello = 'from pkg/sub';`,
        });
        const ns = await env('boot').import('pkg/sub');
        expect(ns.hello).toBe('from pkg/sub');
    });

    it('import.meta.env differs per env (client vs server) from one transform', async () => {
        const { env } = multiEnv({ '/m.ts': `export const mode = import.meta.env.MODE;` });
        const client = await env('client', { MODE: 'client' }).import('/m.ts');
        const server = await env('server', { MODE: 'server' }).import('/m.ts');
        expect(client.mode).toBe('client');
        expect(server.mode).toBe('server');
    });
});

describe('environment — externalized entry', () => {
    it('an entry a plugin externalizes to a rewritten target goes through runExternalModule', async () => {
        // The realm boot case: `env.import('pkg')` where a host plugin answers every dependency
        // with a served URL the realm native-imports. `Environment.import` used to drop the
        // external answer and fetch the literal spec — a "pkg: not found" for a module that
        // resolved fine.
        const files: Record<string, string> = {
            'node_modules/pkg/package.json': `{"name":"pkg","exports":{".":"./index.js"}}`,
            'node_modules/pkg/index.js': `export const v = 1;`,
        };
        const fs: Fs = { read: (id) => files[id] ?? null, exists: (id) => id in files };
        const server = createDevServer({
            fs,
            plugins: [
                {
                    name: 'serve-deps-natively',
                    async resolveId(spec, importer, extra) {
                        if (extra.custom?.self) return null;
                        const r = await this.resolve(spec, importer, { custom: { self: true } });
                        return r && !r.external && r.id.startsWith('node_modules/') ? { id: `https://host/${r.id}`, external: true } : r;
                    },
                },
            ],
        });
        const external: string[] = [];
        const env = createEnvironment({
            name: 'realm',
            fetchModule: server.fetchModule,
            resolveId: server.resolveId,
            evaluator: {
                async runExternalModule(target: string) {
                    external.push(target);
                    return { v: 'native' };
                },
            } as never,
        });
        const ns = await env.import('pkg');
        expect(external).toEqual(['https://host/node_modules/pkg/index.js']);
        expect(ns.v).toBe('native');
        expect(env.node('pkg')).toBeUndefined(); // not a module of this graph, not a root
    });

    it('an entry the resolver cannot place still falls back to a fetch by the spec itself', async () => {
        // A host id scheme the resolver does not understand (a project-relative 'src/app.ts' with a
        // cwd it cannot probe) resolves `{ external: spec }` and must keep loading as before.
        const files: Record<string, string> = { 'src/app.ts': `export const ok = true;` };
        const fs: Fs = { read: (id) => files[id] ?? null, exists: () => false };
        const server = createDevServer({ fs });
        const env = createEnvironment({ name: 'realm', fetchModule: server.fetchModule, resolveId: server.resolveId });
        expect((await env.import('src/app.ts')).ok).toBe(true);
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
        expect(await (ns.load as () => Promise<number>)()).toBe(2);
    });
});

describe('environment — acceptExports + prune', () => {
    it('acceptExports fires on EVERY update — the names are the server’s business', async () => {
        // This test used to assert the opposite: that the callback fires only when one of the
        // listed exports changed value. That rule was ours, not the reference's. Vite's client
        // (`packages/vite/src/shared/hmr.ts`) implements `acceptExports(names, cb)` as
        // `acceptDeps([ownerPath], cb)` — a plain self-accept — under the comment "export names
        // (first arg) are irrelevant on the client side, they're extracted in the server for
        // propagation". So the value comparison went, and this asserts what vite does.
        (globalThis as { __log?: unknown[] }).__log = [];
        const { server, env, files } = multiEnv({
            '/m.ts': `globalThis.__log ??= [];\nexport let a = 1;\nexport let b = 1;\nimport.meta.hot.acceptExports(['a'], (nm) => { globalThis.__log.push('a=' + nm.a); });`,
        });
        const e = env('e');
        await e.import('/m.ts');

        // change only b — 'a' is unchanged, and the callback fires anyway.
        files['/m.ts'] = files['/m.ts'].replace('let b = 1', 'let b = 2');
        server.invalidate('/m.ts');
        expect((await e.applyEdit('/m.ts')).type).toBe('update');
        expect((globalThis as { __log?: unknown[] }).__log).toEqual(['a=1']);

        files['/m.ts'] = files['/m.ts'].replace('let a = 1', 'let a = 9');
        server.invalidate('/m.ts');
        await e.applyEdit('/m.ts');
        expect((globalThis as { __log?: unknown[] }).__log).toEqual(['a=1', 'a=9']);
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
        await e.import('/a.ts');
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
        const { createDevServer } = await import('../src/bundler/runtime/dev-server.ts');
        const { createEnvironment } = await import('../src/bundler/runtime/environment.ts');
        const { defaultEvaluator } = await import('../src/bundler/runtime/module-runner.ts');
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

const log = (): unknown[] | undefined => (globalThis as { __log?: unknown[] }).__log;

/** a promise the test opens by hand, to hold a fetch mid-flight. */
function gate(): { opened: Promise<void>; open: () => void } {
    let open: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { opened, open };
}

describe('environment — release', () => {
    it('an entry nothing imports leaves the graph, every dispose before any prune', async () => {
        const { env } = multiEnv({
            '/run.ts': `globalThis.__log ??= [];\nimport './a';\nimport.meta.hot.dispose(() => { globalThis.__log.push('run-dispose'); });\nimport.meta.hot.prune(() => { globalThis.__log.push('run-prune'); });`,
            '/a.ts': `globalThis.__log ??= [];\nimport.meta.hot.dispose(() => { globalThis.__log.push('a-dispose'); });\nimport.meta.hot.prune(() => { globalThis.__log.push('a-prune'); });`,
        });
        const e = env('e');
        await e.import('/run.ts');

        const pruned = await e.release('/run.ts');
        expect([...pruned].sort()).toEqual(['/a.ts', '/run.ts']);
        expect(e.node('/run.ts')).toBeUndefined();
        expect(e.node('/a.ts')).toBeUndefined();
        expect(log()?.slice(0, 2).sort()).toEqual(['a-dispose', 'run-dispose']);
        expect(log()?.slice(2).sort()).toEqual(['a-prune', 'run-prune']);
    });

    it('cascades through what only the entry kept alive, and keeps what another root imports', async () => {
        const { env } = multiEnv({
            '/game.ts': `import './shared';\nimport.meta.hot.accept();`,
            '/run.ts': `import './shared';\nimport './only';`,
            '/only.ts': `import './deep';`,
            '/deep.ts': `export const d = 1;`,
            '/shared.ts': `export const s = 1;`,
        });
        const e = env('e');
        await e.import('/game.ts');
        await e.import('/run.ts');
        expect([...(e.node('/shared.ts')?.importers ?? [])].sort()).toEqual(['/game.ts', '/run.ts']);

        const pruned = await e.release('/run.ts');
        expect([...pruned].sort()).toEqual(['/deep.ts', '/only.ts', '/run.ts']);
        expect(e.node('/shared.ts')).toBeDefined();
        expect([...(e.node('/shared.ts')?.importers ?? [])]).toEqual(['/game.ts']);
        expect(e.node('/game.ts')).toBeDefined();
    });

    // A dep whose accept invalidates bubbles to its importers, as capture's accept does for a module
    // whose exports are not all engine handles. The game accepts it; the finished run does not.
    const bubbling = () => ({
        '/game.ts': `globalThis.__log ??= [];\nimport { v } from './dep';\nimport.meta.hot.accept('./dep', () => { globalThis.__log.push('game-got-dep'); });\nexport const r = v;`,
        '/dep.ts': `export let v = 1;\nimport.meta.hot.accept(() => { import.meta.hot.invalidate(); });`,
        '/run.ts': `globalThis.__log ??= [];\nimport { v } from './dep';\nglobalThis.__log.push('run-body');\nexport default () => v;`,
    });

    it('control: a finished run left rooted turns a bubbling edit into a full reload', async () => {
        const { server, env, files } = multiEnv(bubbling());
        const reloaded: string[] = [];
        const e = env('e', {}, { onFullReload: (id) => reloaded.push(id) });
        await e.import('/game.ts');
        await e.import('/run.ts');

        files['/dep.ts'] = files['/dep.ts'].replace('v = 1', 'v = 2');
        server.invalidate('/dep.ts');
        expect((await e.applyEdit('/dep.ts')).type).toBe('full-reload');
        expect(reloaded).toEqual(['/dep.ts']);
    });

    it('released, the same edit is an update at the game boundary and the run never runs again', async () => {
        const { server, env, files } = multiEnv(bubbling());
        const reloaded: string[] = [];
        const e = env('e', {}, { onFullReload: (id) => reloaded.push(id) });
        await e.import('/game.ts');
        await e.import('/run.ts');
        await e.release('/run.ts');

        files['/dep.ts'] = files['/dep.ts'].replace('v = 1', 'v = 2');
        server.invalidate('/dep.ts');
        const update = await e.applyEdit('/dep.ts');
        expect(update.type).toBe('update');
        expect(update.type === 'update' && update.boundaries).toContain('/game.ts');
        expect(reloaded).toEqual([]);
        expect(log()).toEqual(['run-body', 'game-got-dep']);
    });

    it('an edit to a dep only the released entry imported is a noop', async () => {
        const { server, env, files } = multiEnv({
            '/run.ts': `import { x } from './only';\nexport default () => x;`,
            '/only.ts': `export const x = 1;`,
        });
        const e = env('e');
        await e.import('/run.ts');
        await e.release('/run.ts');

        files['/only.ts'] = `export const x = 2;`;
        server.invalidate('/only.ts');
        expect(await e.applyEdit('/only.ts')).toEqual({ type: 'noop' });
    });

    it('the run cycle: one id imported, run and released three times, fresh each time', async () => {
        const { server, env, files } = multiEnv({
            '/game.ts': `import './lib';\nimport.meta.hot.accept();`,
            '/lib.ts': `export const n = 10;`,
            '/slot.ts': ``,
        });
        const e = env('e');
        await e.import('/game.ts');
        for (let i = 0; i < 3; i++) {
            files['/slot.ts'] =
                `globalThis.__log ??= [];\nimport { n } from './lib';\nglobalThis.__log.push('body-${i}:' + (import.meta.hot.data.seen ?? 'fresh'));\nimport.meta.hot.data.seen = 'stale';\nexport default () => ${i} + n;`;
            server.invalidate('/slot.ts');
            const ns = await e.import('/slot.ts');
            expect((ns.default as () => number)()).toBe(i + 10);
            expect(await e.release('/slot.ts')).toEqual(['/slot.ts']);
            expect(e.node('/slot.ts')).toBeUndefined();
            expect(e.node('/lib.ts')).toBeDefined();
        }
        expect(log()).toEqual(['body-0:fresh', 'body-1:fresh', 'body-2:fresh']);
    });

    it('an entry a loaded module still imports stays, unrooted, until that importer drops it', async () => {
        const { server, env, files } = multiEnv({
            '/game.ts': `import './a';\nimport.meta.hot.accept();`,
            '/a.ts': `export const a = 1;`,
        });
        const e = env('e');
        await e.import('/game.ts');
        await e.import('/a.ts');

        expect(await e.release('/a.ts')).toEqual([]);
        expect(e.node('/a.ts')).toBeDefined();

        files['/game.ts'] = `import.meta.hot.accept();`;
        server.invalidate('/game.ts');
        await e.applyEdit('/game.ts');
        expect(e.node('/a.ts')).toBeUndefined();
    });

    it('control: still rooted, an entry survives its importer dropping it', async () => {
        const { server, env, files } = multiEnv({
            '/game.ts': `import './a';\nimport.meta.hot.accept();`,
            '/a.ts': `export const a = 1;`,
        });
        const e = env('e');
        await e.import('/game.ts');
        await e.import('/a.ts');

        files['/game.ts'] = `import.meta.hot.accept();`;
        server.invalidate('/game.ts');
        await e.applyEdit('/game.ts');
        expect(e.node('/a.ts')).toBeDefined();
    });

    it('an entry a loaded module imports dynamically stays', async () => {
        const { env } = multiEnv({
            '/game.ts': `export const load = () => import('./a');\nimport.meta.hot.accept();`,
            '/a.ts': `export const a = 1;`,
        });
        const e = env('e');
        await e.import('/game.ts');
        await e.import('/a.ts');
        expect(e.node('/a.ts')?.dynamicImporters.has('/game.ts')).toBe(true);

        expect(await e.release('/a.ts')).toEqual([]);
        expect(e.node('/a.ts')).toBeDefined();
    });

    it('an unknown spec, a never-imported module and a second release all resolve to nothing', async () => {
        const { env } = multiEnv({ '/a.ts': `export const a = 1;`, '/b.ts': `export const b = 1;` });
        const e = env('e');
        expect(await e.release('/nope.ts')).toEqual([]);
        expect(await e.release('/b.ts')).toEqual([]);
        await e.import('/a.ts');
        expect(await e.release('/a.ts')).toEqual(['/a.ts']);
        expect(await e.release('/a.ts')).toEqual([]);
    });

    it('an import that threw is released whole, and imports again cleanly', async () => {
        const { server, env, files } = multiEnv({
            '/run.ts': `import './a';\nthrow new Error('boom');`,
            '/a.ts': `export const a = 1;`,
        });
        const e = env('e');
        await expect(e.import('/run.ts')).rejects.toThrow('boom');

        expect([...(await e.release('/run.ts'))].sort()).toEqual(['/a.ts', '/run.ts']);
        expect(e.node('/run.ts')).toBeUndefined();

        files['/run.ts'] = `import { a } from './a';\nexport const got = a;`;
        server.invalidate('/run.ts');
        expect((await e.import('/run.ts')).got).toBe(1);
    });

    it('waits for an in-flight import of the same entry, then prunes it', async () => {
        const { server, env } = multiEnv({
            '/run.ts': `import './a';`,
            '/a.ts': `export const a = 1;`,
        });
        const held = gate();
        const e = env(
            'e',
            {},
            {
                fetchModule: async (id) => {
                    if (id === '/a.ts') await held.opened;
                    return server.fetchModule(id);
                },
            },
        );
        const importing = e.import('/run.ts');
        let released: string[] | null = null;
        const releasing = e.release('/run.ts').then((ids) => {
            released = ids;
        });
        await new Promise((r) => setTimeout(r, 10));
        expect(released).toBeNull();

        held.open();
        await importing;
        await releasing;
        expect([...(released ?? [])].sort()).toEqual(['/a.ts', '/run.ts']);
        expect(e.node('/run.ts')).toBeUndefined();
    });

    it('takes its turn behind an edit that has chosen the entry as a boundary: no full reload', async () => {
        // The edit's boundaries are [game, run], applied in order. While it awaits game's re-fetch,
        // a release that did not wait its turn would prune run, and applying run's update would then
        // find no instance: a full reload.
        const { server, env, files } = multiEnv({
            '/game.ts': `globalThis.__log ??= [];\nimport './dep';\nglobalThis.__log.push('game-body');\nimport.meta.hot.accept();`,
            '/run.ts': `globalThis.__log ??= [];\nimport './dep';\nglobalThis.__log.push('run-body');\nimport.meta.hot.accept();`,
            '/dep.ts': `export let v = 1;`,
        });
        const held = gate();
        let gameFetches = 0;
        const reloaded: string[] = [];
        const e = env(
            'e',
            {},
            {
                onFullReload: (id) => reloaded.push(id),
                fetchModule: async (id) => {
                    if (id === '/game.ts' && ++gameFetches === 2) await held.opened;
                    return server.fetchModule(id);
                },
            },
        );
        await e.import('/game.ts');
        await e.import('/run.ts');

        files['/dep.ts'] = `export let v = 2;`;
        server.invalidate('/dep.ts');
        const editing = e.applyEdit('/dep.ts');
        const releasing = e.release('/run.ts');
        await new Promise((r) => setTimeout(r, 10));
        held.open();

        expect(await editing).toEqual({ type: 'update', boundaries: ['/game.ts', '/run.ts'] });
        expect(await releasing).toEqual(['/run.ts']);
        expect(reloaded).toEqual([]);
        expect(log()).toEqual(['game-body', 'run-body', 'game-body', 'run-body']);
        expect(e.node('/run.ts')).toBeUndefined();
        expect([...(e.node('/dep.ts')?.importers ?? [])]).toEqual(['/game.ts']);

        // truly gone: importing again evaluates it, rather than handing back a leftover instance.
        await e.import('/run.ts');
        expect(log()).toEqual(['game-body', 'run-body', 'game-body', 'run-body', 'run-body']);
    });

    it('a prune callback that throws is reported, and the release still completes', async () => {
        const { env } = multiEnv({
            '/run.ts': `import.meta.hot.prune(() => { throw new Error('bad prune'); });`,
        });
        const errors: { id: string; phase: string }[] = [];
        const e = env('e', {}, { onHotError: (_err, ctx) => errors.push(ctx) });
        await e.import('/run.ts');

        expect(await e.release('/run.ts')).toEqual(['/run.ts']);
        expect(errors).toEqual([{ id: '/run.ts', phase: 'prune' }]);
        expect(e.node('/run.ts')).toBeUndefined();
    });

    it('an entry a plugin externalized was never a root: nothing to release', async () => {
        const files: Record<string, string> = {
            'node_modules/pkg/package.json': `{"name":"pkg","exports":{".":"./index.js"}}`,
            'node_modules/pkg/index.js': `export const v = 1;`,
        };
        const server = createDevServer({
            fs: { read: (id) => files[id] ?? null, exists: (id) => id in files },
            plugins: [
                {
                    name: 'serve-deps-natively',
                    async resolveId(spec, importer, extra) {
                        if (extra.custom?.self) return null;
                        const r = await this.resolve(spec, importer, { custom: { self: true } });
                        return r && !r.external && r.id.startsWith('node_modules/')
                            ? { id: `https://host/${r.id}`, external: true }
                            : r;
                    },
                },
            ],
        });
        const e = createEnvironment({
            name: 'realm',
            fetchModule: server.fetchModule,
            resolveId: server.resolveId,
            evaluator: {
                async runExternalModule() {
                    return { v: 'native' };
                },
            } as never,
        });
        expect((await e.import('pkg')).v).toBe('native');
        expect(await e.release('pkg')).toEqual([]);
    });

    it('releasing in one environment leaves another environment’s instance live and updating', async () => {
        const { server, env, files } = multiEnv({
            '/m.ts': `globalThis.__log ??= [];\nexport let v = 1;\nimport.meta.hot.accept((nm) => { globalThis.__log.push(import.meta.env.N + ':' + nm.v); });`,
        });
        const client = env('client', { N: 'client' });
        const srv = env('server', { N: 'server' });
        await client.import('/m.ts');
        await srv.import('/m.ts');
        expect(await client.release('/m.ts')).toEqual(['/m.ts']);

        files['/m.ts'] = files['/m.ts'].replace('v = 1', 'v = 2');
        server.invalidate('/m.ts');
        expect(await client.applyEdit('/m.ts')).toEqual({ type: 'noop' });
        expect(await srv.applyEdit('/m.ts')).toEqual({ type: 'update', boundaries: ['/m.ts'] });
        expect(log()).toEqual(['server:2']);
    });

    it('through the dev server: a change fanned out after a release is no full reload', async () => {
        const { server, env, files } = multiEnv(bubbling());
        const reloaded: string[] = [];
        const e = env('e', {}, { onFullReload: (id) => reloaded.push(id) });
        server.register(e);
        await e.import('/game.ts');
        await e.import('/run.ts');
        await e.release('/run.ts');

        files['/dep.ts'] = files['/dep.ts'].replace('v = 1', 'v = 2');
        const results = await server.handleChange('/dep.ts');
        expect(results.map((r) => [r.env, r.update.type])).toEqual([['e', 'update']]);
        expect(reloaded).toEqual([]);
        expect(log()).toEqual(['run-body', 'game-got-dep']);
    });
});
