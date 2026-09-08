import { describe, expect, it } from 'vitest';
import type { Fs } from '../src/bundler/fs.ts';
import type { Plugin } from '../src/bundler/plugin.ts';
import { reactRefresh } from '../src/bundler/plugins/react-refresh.ts';
import { createDevServer } from '../src/bundler/runtime/dev-server.ts';
import { createEnvironment, type HmrUpdate } from '../src/bundler/runtime/environment.ts';

// Fast Refresh end to end: the pass, the footer, the `/@react-refresh` module and the HMR graph, all
// running together over the real dev server and a real environment.
//
// React is NOT here — `react-refresh` is not a shakeup dependency and is not resolvable from this
// project (it exists only in the pnpm store, under the parcel package the layer was transcribed
// from). So `react-refresh/runtime` and `react/jsx-runtime` are served as stubs, and what is proved
// is the WIRING: that registrations happen at eval, that the accept callback is reached on an edit
// and asks for a refresh, and that a module which stops being a boundary escalates instead. Whether
// React then preserves a `useState` value is React's half, and needs a browser.

type Sink = {
    registered: string[];
    refreshes: number;
    families: Map<unknown, unknown>;
    familyForId: Map<string, unknown>;
};

const STUB_RUNTIME = `
const S = import.meta.env.sink;
export const register = (type, id) => {
  S.registered.push(id);
  if (type === null || (typeof type !== 'object' && typeof type !== 'function')) return;
  let family = S.familyForId.get(id);
  if (family === undefined) { family = { id }; S.familyForId.set(id, family); }
  S.families.set(type, family);
};
export const performReactRefresh = () => { S.refreshes++; };
export const createSignatureFunctionForTransform = () => (t) => t;
export const injectIntoGlobalHook = () => {};
export const isLikelyComponentType = (t) => typeof t === 'function' && /^[A-Z]/.test(t.name);
export const getFamilyByType = (t) => S.families.get(t);
`;

const STUB_JSX = `
export const Fragment = 'Fragment';
export const jsx = (type, props) => ({ type, props });
export const jsxs = jsx;
export const jsxDEV = jsx;
`;

/** Serve the two packages a refreshed module imports, which this project does not have. */
const stubs: Plugin = {
    name: 'stub-react',
    resolveId: (spec) =>
        spec === 'react-refresh/runtime' || spec === 'react/jsx-runtime' || spec === 'react/jsx-dev-runtime'
            ? `/stub/${spec}`
            : null,
    load: (id) =>
        id === '/stub/react-refresh/runtime'
            ? STUB_RUNTIME
            : id.startsWith('/stub/react/jsx')
              ? STUB_JSX
              : null,
};

type Probe = {
    files: Record<string, string>;
    sink: Sink;
    reloads: string[];
    importModule: (id: string) => Promise<unknown>;
    change: (path: string) => Promise<HmrUpdate>;
};

function probe(files: Record<string, string>): Probe {
    const sink: Sink = { registered: [], refreshes: 0, families: new Map(), familyForId: new Map() };
    const reloads: string[] = [];
    const fs: Fs = { read: (id) => files[id] ?? null, exists: (id) => id in files };
    const server = createDevServer({ fs, plugins: [reactRefresh(), stubs] });
    const env = createEnvironment({
        name: 'client',
        fetchModule: server.fetchModule,
        resolveId: server.resolveId,
        createImportMeta: (id) => ({ url: id }),
        env: { sink },
        onFullReload: (id) => reloads.push(id),
    });
    server.register(env);
    return {
        files,
        sink,
        reloads,
        importModule: (id) => env.import(id),
        change: async (path) => (await server.handleChange(path))[0].update,
    };
}

/** The footer throws unless the preamble ran, so a host global has to exist. Restored either way —
 *  the harness in `hmr.test.ts` deliberately leaks no globals and this must not either. */
async function withPreamble<T>(fn: () => Promise<T>): Promise<T> {
    const g = globalThis as { window?: unknown };
    const had = 'window' in g;
    const before = g.window;
    g.window = { $RefreshReg$: () => {}, $RefreshSig$: () => (t: unknown) => t };
    try {
        return await fn();
    } finally {
        if (had) g.window = before;
        else delete g.window;
    }
}

describe('react refresh, end to end over HMR', () => {
    it('registers at eval, and refreshes on an edit', async () => {
        await withPreamble(async () => {
            const files: Record<string, string> = {
                '/Counter.jsx': 'export function Counter() {\n  return <div>v1</div>;\n}\n',
            };
            const p = probe(files);
            await p.importModule('/Counter.jsx');

            // Both registration paths ran: the footer's `$RefreshReg$` for the component the pass
            // found, and `registerExportsForReactRefresh` for the namespace and each export.
            expect(p.sink.registered).toContain('/Counter.jsx Counter');
            expect(p.sink.registered).toContain('/Counter.jsx %exports%');
            expect(p.sink.registered).toContain('/Counter.jsx %exports% Counter');
            expect(p.sink.refreshes, 'nothing to refresh on first eval').toBe(0);

            files['/Counter.jsx'] = 'export function Counter() {\n  return <div>v2</div>;\n}\n';
            const update = await p.change('/Counter.jsx');

            // The accept callback registered inside `queueMicrotask` was reached — the open question
            // §7 recorded — and it asked for a refresh rather than invalidating.
            expect(update).toEqual({ type: 'update', boundaries: ['/Counter.jsx'] });
            expect(p.sink.refreshes, 'the boundary validated and enqueued').toBe(1);
            expect(p.reloads).toEqual([]);
        });
    });

    it('escalates when the module stops being a boundary', async () => {
        await withPreamble(async () => {
            // The falsification arm. The edit adds a non-component export, so the update is no longer
            // safe to apply in place: `validateRefreshBoundaryAndEnqueueUpdate` returns a message and
            // the footer invalidates.
            const files: Record<string, string> = {
                '/Widget.jsx': 'export function Widget() {\n  return <div>v1</div>;\n}\n',
            };
            const p = probe(files);
            await p.importModule('/Widget.jsx');

            files['/Widget.jsx'] = 'export function Widget() {\n  return <div>v2</div>;\n}\nexport const VERSION = 2;\n';
            const update = await p.change('/Widget.jsx');

            expect(p.sink.refreshes, 'no refresh was enqueued').toBe(0);
            // Nothing imports it, so invalidation runs out of graph and the page reloads.
            expect(update).toEqual({ type: 'full-reload' });
            expect(p.reloads).toEqual(['/Widget.jsx']);
        });
    });
});
