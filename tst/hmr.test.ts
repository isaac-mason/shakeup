import { describe, expect, it } from 'vitest';
import type { Fs } from '../src/fs.ts';
import { createDevServer, type DevServer } from '../src/runtime/dev-server.ts';
import { createEnvironment, type Environment, type HmrUpdate } from '../src/runtime/environment.ts';

// HMR propagation, end to end over the real dev server: an edit lands in the fs, `handleChange`
// re-transforms once and fans `applyEdit` to every registered environment, and each env walks its
// own graph to find accept boundaries and re-evaluates through its own runner.
//
// The instrument is an EVAL TRANSCRIPT rather than return values alone: every fixture module pushes
// to a shared `log` (reached via `import.meta.env`, so no globals leak between tests). Assertions
// then read as "which module bodies ran, in what order, how many times" — the thing a return value
// of `{ type: 'update' }` can't tell you, and the thing that actually decides whether a hot-swapped
// script is the new one or the old one.

type Probe = {
    files: Record<string, string>;
    server: DevServer;
    envs: Record<string, Environment>;
    env: Environment; // the first env, for the single-env majority
    log: string[];
    reloads: string[];
    /** drain the transcript and return what it held. */
    take(): string[];
    /** an fs edit for `path` (write it yourself first), fanned to every env. */
    change(path: string): Promise<Record<string, HmrUpdate>>;
};

function probe(files: Record<string, string>, envNames: string[] = ['client']): Probe {
    const log: string[] = [];
    const reloads: string[] = [];
    const fs: Fs = { read: (id) => files[id] ?? null, exists: (id) => id in files };
    const server = createDevServer({ fs });
    const envs: Record<string, Environment> = {};
    for (const name of envNames) {
        const env = createEnvironment({
            name,
            fetchModule: server.fetchModule,
            resolveId: server.resolveId,
            createImportMeta: (id) => ({ url: id }),
            env: { log, realm: name },
            onFullReload: (id) => reloads.push(`${name}:${id}`),
        });
        server.register(env);
        envs[name] = env;
    }
    return {
        files,
        server,
        envs,
        env: envs[envNames[0]],
        log,
        reloads,
        take: () => log.splice(0, log.length),
        change: async (path) => {
            const results = await server.handleChange(path);
            return Object.fromEntries(results.map((r) => [r.env, r.update]));
        },
    };
}

/** a module that logs `<tag>:eval` on every evaluation and self-accepts. */
const selfAccepting = (tag: string, body: string): string =>
    `import.meta.env.log.push('${tag}:eval');\n${body}\nimport.meta.hot.accept(() => { import.meta.env.log.push('${tag}:accept'); });`;

/** a plain module that logs `<tag>:eval` and accepts nothing. */
const plain = (tag: string, body: string): string => `import.meta.env.log.push('${tag}:eval');\n${body}`;

describe('hmr — propagation shape', () => {
    it('a self-accepting module is its own boundary', async () => {
        const p = probe({ '/s.ts': selfAccepting('s', 'export const v = 1;') });
        await p.env.import('/s.ts');

        p.files['/s.ts'] = selfAccepting('s', 'export const v = 2;');
        expect(await p.change('/s.ts')).toEqual({ client: { type: 'update', boundaries: ['/s.ts'] } });
    });

    it('an accepted dep makes the IMPORTER the boundary', async () => {
        const p = probe({
            '/dep.ts': plain('dep', 'export const v = 1;'),
            '/app.ts': `import { v } from './dep';
import.meta.env.log.push('app:eval:' + v);
import.meta.hot.accept('./dep', (m) => { import.meta.env.log.push('app:accepted-dep:' + m.v); });`,
        });
        await p.env.import('/app.ts');

        p.files['/dep.ts'] = plain('dep', 'export const v = 2;');
        expect(await p.change('/dep.ts')).toEqual({ client: { type: 'update', boundaries: ['/app.ts'] } });
    });

    it('propagation bubbles through unaccepting importers to the nearest boundary', async () => {
        const p = probe({
            '/dep.ts': plain('dep', 'export const v = 1;'),
            '/mid.ts': `import { v } from './dep';\n${plain('mid', 'export const w = v + 10;')}`,
            '/app.ts': `import { w } from './mid';\n${selfAccepting('app', 'export const z = w;')}`,
        });
        await p.env.import('/app.ts');

        p.files['/dep.ts'] = plain('dep', 'export const v = 2;');
        // neither dep nor mid accepts, so the update climbs to app — the first module that does.
        expect(await p.change('/dep.ts')).toEqual({ client: { type: 'update', boundaries: ['/app.ts'] } });
    });

    it('an unaccepted root reports full-reload and signals the host', async () => {
        const p = probe({
            '/dep.ts': plain('dep', 'export const v = 1;'),
            '/app.ts': `import { v } from './dep';\n${plain('app', 'export const z = v;')}`,
        });
        await p.env.import('/app.ts');

        p.files['/dep.ts'] = plain('dep', 'export const v = 2;');
        expect(await p.change('/dep.ts')).toEqual({ client: { type: 'full-reload' } });
        // the core only signals; the host decides how to reload (re-import the entry, reload the iframe).
        expect(p.reloads).toEqual(['client:/dep.ts']);
    });

    it('a module this env never loaded is a noop', async () => {
        const p = probe({ '/loaded.ts': selfAccepting('loaded', ''), '/other.ts': selfAccepting('other', '') });
        await p.env.import('/loaded.ts');

        p.files['/other.ts'] = selfAccepting('other', 'export const v = 1;');
        expect(await p.change('/other.ts')).toEqual({ client: { type: 'noop' } });
        expect(p.reloads).toEqual([]); // a noop must NOT be escalated to a reload
    });

    it('a dynamically-imported module is its own implicit boundary', async () => {
        const p = probe({
            '/lazy.ts': plain('lazy', 'export const v = 1;'),
            '/app.ts': `${plain('app', '')}\nexport const load = () => import('./lazy');`,
        });
        const ns = await p.env.import('/app.ts');
        await (ns.load as () => Promise<Record<string, unknown>>)();

        p.files['/lazy.ts'] = plain('lazy', 'export const v = 2;');
        // no static importer, but the dynamic edge is an implicit boundary: no full reload.
        expect(await p.change('/lazy.ts')).toEqual({ client: { type: 'update', boundaries: ['/lazy.ts'] } });
        p.take();
        // the next import() gets the fresh module.
        expect(((await (ns.load as () => Promise<Record<string, unknown>>)()) as { v: number }).v).toBe(2);
        expect(p.take()).toEqual(['lazy:eval']);
    });
});

describe('hmr — evaluation transcript', () => {
    it('a self-accept re-evaluates ONLY the changed module', async () => {
        const p = probe({
            '/dep.ts': selfAccepting('dep', 'export const v = 1;'),
            '/app.ts': `import { v } from './dep';\n${plain('app', 'export const z = v;')}`,
        });
        await p.env.import('/app.ts');
        expect(p.take()).toEqual(['dep:eval', 'app:eval']);

        p.files['/dep.ts'] = selfAccepting('dep', 'export const v = 2;');
        await p.change('/dep.ts');
        // the boundary re-evaluates once and runs the OLD instance's callback; app is untouched,
        // which is exactly why a by-value export across this edge would go stale.
        expect(p.take()).toEqual(['dep:eval', 'dep:accept']);
    });

    it('a dep-accept re-evaluates the dep, NOT the accepting importer', async () => {
        const p = probe({
            '/dep.ts': plain('dep', 'export const v = 1;'),
            '/app.ts': `import { v } from './dep';
import.meta.env.log.push('app:eval');
import.meta.hot.accept('./dep', (m) => { import.meta.env.log.push('app:accepted-dep:' + m.v); });`,
        });
        await p.env.import('/app.ts');
        p.take();

        p.files['/dep.ts'] = plain('dep', 'export const v = 2;');
        await p.change('/dep.ts');
        // the importer handles the new dep manually, so its own body must not re-run.
        expect(p.take()).toEqual(['dep:eval', 'app:accepted-dep:2']);
    });

    it('bubbling re-evaluates the chain up to the boundary, once each', async () => {
        const p = probe({
            '/dep.ts': plain('dep', 'export const v = 1;'),
            '/mid.ts': `import { v } from './dep';\n${plain('mid', 'export const w = v + 10;')}`,
            '/app.ts': `import { w } from './mid';
import.meta.env.log.push('app:eval:' + w);
import.meta.hot.accept(() => { import.meta.env.log.push('app:accept'); });`,
        });
        await p.env.import('/app.ts');
        p.take();

        p.files['/dep.ts'] = plain('dep', 'export const v = 2;');
        await p.change('/dep.ts');
        // every module between the edit and the boundary re-links fresh code exactly once, and the
        // boundary observes the new value (12, not the stale 11).
        expect(p.take()).toEqual(['dep:eval', 'mid:eval', 'app:eval:12', 'app:accept']);
    });

    it('hot.invalidate() in a self-accept bubbles to importers', async () => {
        const p = probe({
            '/dep.ts': `import.meta.env.log.push('dep:eval');
export const v = 1;
import.meta.hot.accept(() => { import.meta.env.log.push('dep:accept'); import.meta.hot.invalidate(); });`,
            '/app.ts': `import { v } from './dep';
import.meta.env.log.push('app:eval:' + v);
import.meta.hot.accept(() => { import.meta.env.log.push('app:accept'); });`,
        });
        await p.env.import('/app.ts');
        p.take();

        p.files['/dep.ts'] = p.files['/dep.ts'].replace('v = 1', 'v = 2');
        const update = await p.change('/dep.ts');
        expect(update).toEqual({ client: { type: 'update', boundaries: ['/dep.ts', '/app.ts'] } });
        // COST OF THE INVALIDATE PATH: dep evaluates TWICE. It re-evaluates as its own boundary,
        // its callback rejects the update, and the bubble pass then invalidates it as an
        // intermediate — so the importer's re-link fetches and evaluates it again. Any side effect
        // in a module body (a registry upsert, a subscription) therefore runs twice per edit on
        // this path and must be idempotent.
        expect(p.take()).toEqual(['dep:eval', 'dep:accept', 'dep:eval', 'app:eval:2', 'app:accept']);
    });

    it('the boundary re-evaluates against the EDITED source, not a cached copy', async () => {
        const p = probe({ '/s.ts': selfAccepting('s', 'export const v = 1;') });
        const ns = await p.env.import('/s.ts');
        expect(ns.v).toBe(1);

        for (const n of [2, 3, 4]) {
            p.take();
            p.files['/s.ts'] = selfAccepting('s', `export const v = ${n};`);
            await p.change('/s.ts');
            // repeated edits must keep swapping — a stale content-hash or a leaked cache entry
            // would show up as the second edit silently doing nothing.
            expect(p.take()).toEqual(['s:eval', 's:accept']);
            expect((await p.env.import('/s.ts')).v).toBe(n);
        }
    });

    it('an edit that ADDS an import wires and evaluates the new dep', async () => {
        const p = probe({
            '/new.ts': plain('new', 'export const n = 99;'),
            '/s.ts': selfAccepting('s', 'export const v = 1;'),
        });
        await p.env.import('/s.ts');
        p.take();

        p.files['/s.ts'] = `import { n } from './new';\n${selfAccepting('s', 'export const v = n;')}`;
        await p.change('/s.ts');
        expect(p.take()).toEqual(['new:eval', 's:eval', 's:accept']);
        expect(p.env.node('/s.ts')?.deps).toEqual(['/new.ts']);
    });
});

describe('hmr — runner lifecycle', () => {
    it('dispose runs before re-evaluation and hot.data survives the swap', async () => {
        const p = probe({
            '/s.ts': `import.meta.env.log.push('s:eval:' + (import.meta.hot.data.count ?? 0));
import.meta.hot.data.count = (import.meta.hot.data.count ?? 0) + 1;
import.meta.hot.dispose(() => { import.meta.env.log.push('s:dispose'); });
import.meta.hot.accept(() => {});`,
        });
        await p.env.import('/s.ts');
        expect(p.take()).toEqual(['s:eval:0']);

        p.files['/s.ts'] = `${p.files['/s.ts']}\nexport const marker = 1;`;
        await p.change('/s.ts');
        // dispose is the teardown seam — it MUST run before the new body, or the new instance's
        // setup races the old instance's still-live subscriptions.
        expect(p.take()).toEqual(['s:dispose', 's:eval:1']);
    });

    it('a module that throws on re-evaluation keeps the last-good instance', async () => {
        const p = probe({ '/s.ts': selfAccepting('s', 'export const v = 1;') });
        expect((await p.env.import('/s.ts')).v).toBe(1);
        p.take();

        p.files['/s.ts'] = `${selfAccepting('s', 'export const v = 2;')}\nthrow new Error('broken edit');`;
        await expect(p.change('/s.ts')).rejects.toThrow('broken edit');
        // the broken edit must not leave a half-evaluated module cached.
        expect((await p.env.import('/s.ts')).v).toBe(1);
    });

    it('a module orphaned by an edit is pruned', async () => {
        const p = probe({
            '/orphan.ts': `import.meta.env.log.push('orphan:eval');
export const v = 1;
import.meta.hot.prune(() => { import.meta.env.log.push('orphan:prune'); });
import.meta.hot.dispose(() => { import.meta.env.log.push('orphan:dispose'); });`,
            '/app.ts': `import { v } from './orphan';\n${selfAccepting('app', 'export const z = v;')}`,
        });
        await p.env.import('/app.ts');
        p.take();

        // drop the import: nothing reaches orphan.ts any more.
        p.files['/app.ts'] = selfAccepting('app', 'export const z = 0;');
        await p.change('/app.ts');
        expect(p.take()).toEqual(['app:eval', 'app:accept', 'orphan:prune', 'orphan:dispose']);
        expect(p.env.node('/orphan.ts')).toBeUndefined();
    });
});

describe('hmr — fan-out across environments', () => {
    it('one change updates every registered environment independently', async () => {
        const p = probe(
            {
                '/s.ts': `import.meta.env.log.push(import.meta.env.realm + ':eval');
export const v = 1;
import.meta.hot.accept(() => {});`,
            },
            ['client', 'server'],
        );
        await p.envs.client.import('/s.ts');
        await p.envs.server.import('/s.ts');
        p.take();

        p.files['/s.ts'] = p.files['/s.ts'].replace('v = 1', 'v = 2');
        expect(await p.change('/s.ts')).toEqual({
            client: { type: 'update', boundaries: ['/s.ts'] },
            server: { type: 'update', boundaries: ['/s.ts'] },
        });
        // each realm holds its OWN instance of the module — one transform, two evaluations.
        expect(p.take()).toEqual(['client:eval', 'server:eval']);
    });

    it('verdicts are per-env: a module only one realm loaded', async () => {
        const p = probe(
            {
                '/client-only.ts': `import.meta.env.log.push(import.meta.env.realm + ':eval');\nimport.meta.hot.accept(() => {});`,
            },
            ['client', 'server'],
        );
        await p.envs.client.import('/client-only.ts');
        p.take();

        p.files['/client-only.ts'] = `${p.files['/client-only.ts']}\nexport const v = 1;`;
        expect(await p.change('/client-only.ts')).toEqual({
            client: { type: 'update', boundaries: ['/client-only.ts'] },
            server: { type: 'noop' },
        });
        expect(p.take()).toEqual(['client:eval']);
    });
});

describe('hmr — robustness', () => {
    it('a throwing accept callback does not abort the other environments', async () => {
        const p = probe(
            {
                '/s.ts': `import.meta.env.log.push(import.meta.env.realm + ':eval');
export const v = 1;
import.meta.hot.accept(() => {
    if (import.meta.env.realm === 'client') throw new Error('bad accept callback');
    import.meta.env.log.push('server:accept');
});`,
            },
            ['client', 'server'],
        );
        await p.envs.client.import('/s.ts');
        await p.envs.server.import('/s.ts');
        p.take();

        p.files['/s.ts'] = p.files['/s.ts'].replace('v = 1', 'v = 2');
        // one realm's bad callback is a bug in THAT module, not grounds for withholding the update
        // from every other realm — the server must still swap.
        await p.change('/s.ts');
        expect(p.take()).toEqual(['client:eval', 'server:eval', 'server:accept']);
    });

    it('a throwing accept callback does not abort the sibling boundaries in one env', async () => {
        const p = probe({
            '/bad.ts': `import.meta.env.log.push('bad:eval');
export const v = 1;
import.meta.hot.accept(() => { throw new Error('bad accept callback'); });`,
            '/good.ts': selfAccepting('good', 'export const v = 1;'),
            '/shared.ts': plain('shared', 'export const s = 1;'),
        });
        // both boundaries import the same changed module, so one change produces two boundaries.
        p.files['/bad.ts'] = `import { s } from './shared';\n${p.files['/bad.ts']}`;
        p.files['/good.ts'] = `import { s } from './shared';\n${p.files['/good.ts']}`;
        await p.env.import('/bad.ts');
        await p.env.import('/good.ts');
        p.take();

        p.files['/shared.ts'] = plain('shared', 'export const s = 2;');
        await p.change('/shared.ts');
        expect(p.take()).toContain('good:accept');
    });

    it('a callback failure is REPORTED, not swallowed', async () => {
        const errors: string[] = [];
        const log: string[] = [];
        const files: Record<string, string> = {
            '/s.ts': `import.meta.hot.dispose(() => { throw new Error('bad dispose'); });
import.meta.hot.accept(() => { throw new Error('bad accept'); });
export const v = 1;`,
        };
        const server = createDevServer({ fs: { read: (id) => files[id] ?? null, exists: (id) => id in files } });
        const env = createEnvironment({
            name: 'client',
            fetchModule: server.fetchModule,
            resolveId: server.resolveId,
            createImportMeta: (id) => ({ url: id }),
            env: { log },
            onHotError: (err, ctx) => errors.push(`${ctx.phase}:${ctx.id}:${(err as Error).message}`),
        });
        server.register(env);
        await env.import('/s.ts');

        files['/s.ts'] = files['/s.ts'].replace('v = 1', 'v = 2');
        await server.handleChange('/s.ts');
        // isolating a bad handler must not mean hiding it — the host needs both of these to surface.
        expect(errors).toEqual(['dispose:/s.ts:bad dispose', 'accept:/s.ts:bad accept']);
        // and the swap itself still landed.
        expect((await env.import('/s.ts')).v).toBe(2);
    });

    it('handleChange for an unknown path is a noop everywhere', async () => {
        const p = probe({ '/s.ts': selfAccepting('s', '') }, ['client', 'server']);
        await p.envs.client.import('/s.ts');
        p.take();

        expect(await p.change('/nope.ts')).toEqual({ client: { type: 'noop' }, server: { type: 'noop' } });
        expect(p.take()).toEqual([]);
        expect(p.reloads).toEqual([]);
    });
});
