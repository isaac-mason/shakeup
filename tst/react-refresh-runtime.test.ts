import { describe, expect, it } from 'vitest';
import { parse } from '../src/ast.ts';
import type { Fs } from '../src/bundler/fs.ts';
import { reactRefresh } from '../src/bundler/plugins/react-refresh.ts';
import {
    REACT_REFRESH_RUNTIME_ID,
    REACT_REFRESH_RUNTIME_SOURCE,
    reactRefreshPreamble,
} from '../src/bundler/plugins/react-refresh-runtime.ts';
import { createDevServer } from '../src/bundler/runtime/dev-server.ts';

// The `/@react-refresh` module the dev server serves. It cannot be imported directly here:
// `react-refresh` is not a shakeup dependency and is not resolvable from this project — by design,
// since the real one resolves against the USER's app. So the source is EVALUATED with the runtime
// specifier pointed at a stub, which also lets these assert what the layer asks the runtime for.

type Stub = {
    registered: [unknown, string][];
    refreshes: number;
    injected: unknown;
    isComponent: (t: unknown) => boolean;
    /** Families, as the real runtime keys them: one per registration ID, NOT per object. That is
     *  what lets a module's second version match its first — the namespace object is new every
     *  time, but `id %exports%` names the same family. */
    families: Map<unknown, unknown>;
    familyForId: Map<string, unknown>;
};

const STUB_SOURCE = `
const S = () => globalThis.__refreshStub;
export const register = (type, id) => {
  const s = S();
  s.registered.push([type, id]);
  if (type === null || (typeof type !== 'object' && typeof type !== 'function')) return;
  let family = s.familyForId.get(id);
  if (family === undefined) { family = { id }; s.familyForId.set(id, family); }
  s.families.set(type, family);
};
export const performReactRefresh = () => { S().refreshes++; };
export const createSignatureFunctionForTransform = () => (t) => t;
export const injectIntoGlobalHook = (w) => { S().injected = w; };
export const isLikelyComponentType = (t) => S().isComponent(t);
export const getFamilyByType = (t) => S().families.get(t);
`;

function dataUrl(source: string): string {
    return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

type Runtime = {
    register: (type: unknown, id: string) => void;
    registerExportsForReactRefresh: (id: string, exports: unknown) => void;
    validateRefreshBoundaryAndEnqueueUpdate: (id: string, prev: unknown, next: unknown) => string | undefined;
    injectIntoGlobalHook: (target: unknown) => void;
    createSignatureFunctionForTransform: () => unknown;
};

/** Evaluate the runtime against a fresh stub. `nonce` keeps each test's module instance separate,
 *  so the debounce timer of one does not leak into the next. */
async function loadRuntime(nonce: string, over: Partial<Stub> = {}): Promise<{ rt: Runtime; stub: Stub }> {
    const stub: Stub = {
        registered: [],
        refreshes: 0,
        injected: undefined,
        // A function whose name starts with a capital, which is what the real heuristic mostly does.
        isComponent: (t) => typeof t === 'function' && /^[A-Z]/.test((t as { name: string }).name),
        families: new Map(),
        familyForId: new Map(),
        ...over,
    };
    (globalThis as { __refreshStub?: Stub }).__refreshStub = stub;
    const src = REACT_REFRESH_RUNTIME_SOURCE.replace("'react-refresh/runtime'", JSON.stringify(dataUrl(STUB_SOURCE)));
    // If the specifier ever changes shape, the stub silently stops being used and every assertion
    // below would be testing the real runtime's absence instead.
    expect(src, 'the runtime specifier was not rewritten').not.toBe(REACT_REFRESH_RUNTIME_SOURCE);
    const rt = (await import(dataUrl(`${src}\n//${nonce}\n`))) as unknown as Runtime;
    return { rt, stub };
}

describe('the /@react-refresh runtime module', () => {
    it('parses, and imports react-refresh/runtime from the app', () => {
        const { errors } = parse(REACT_REFRESH_RUNTIME_SOURCE, { ts: false, jsx: false });
        expect(errors).toEqual([]);
        // Bare, so it resolves against the consuming app. shakeup has no React dependency and must
        // not acquire one to make this work.
        expect(REACT_REFRESH_RUNTIME_SOURCE).toContain("from 'react-refresh/runtime'");
    });

    it('re-exports the two functions the footer calls', async () => {
        const { rt } = await loadRuntime('reexports');
        // The footer's `$RefreshReg$`/`$RefreshSig$` definitions call exactly these.
        expect(typeof rt.register).toBe('function');
        expect(typeof rt.createSignatureFunctionForTransform).toBe('function');
    });

    it('injectIntoGlobalHook passes the target straight through', async () => {
        const { rt, stub } = await loadRuntime('inject');
        const target = { marker: 1 };
        rt.injectIntoGlobalHook(target);
        expect(stub.injected).toBe(target);
    });
});

describe('registerExportsForReactRefresh', () => {
    it("registers the namespace, then every export, under metro's %exports% scheme", async () => {
        const { rt, stub } = await loadRuntime('register');
        const App = () => null;
        const Other = () => null;
        rt.registerExportsForReactRefresh('/a.jsx', { App, Other });
        expect(stub.registered).toEqual([
            [{ App, Other }, '/a.jsx %exports%'],
            [App, '/a.jsx %exports% App'],
            [Other, '/a.jsx %exports% Other'],
        ]);
    });

    it('registers a non-object namespace as itself and stops', async () => {
        const { rt, stub } = await loadRuntime('register-fn');
        const App = () => null;
        rt.registerExportsForReactRefresh('/a.jsx', App);
        expect(stub.registered).toEqual([[App, '/a.jsx %exports%']]);
    });

    it('does not invoke a getter export', async () => {
        const { rt, stub } = await loadRuntime('register-getter');
        let calls = 0;
        const exports = {};
        Object.defineProperty(exports, 'boom', {
            enumerable: true,
            get() {
                calls++;
                return null;
            },
        });
        rt.registerExportsForReactRefresh('/a.jsx', exports);
        // A getter on a CJS namespace can have side effects, so its value is never read to find out
        // whether it is a component.
        expect(calls).toBe(0);
        expect(stub.registered.map((r) => r[1])).toEqual(['/a.jsx %exports%']);
    });
});

describe('validateRefreshBoundaryAndEnqueueUpdate', () => {
    const App = () => null;
    const Other = () => null;

    it('accepts a module whose exports are all components, and refreshes', async () => {
        const { rt, stub } = await loadRuntime('accept');
        // What actually happens on an edit: each version registers as it evaluates, and the accept
        // callback then compares them. The two namespace objects are DIFFERENT — they match only
        // because both registered under `/a.jsx %exports%`.
        const NextApp = () => null;
        const prev = { App };
        const next = { App: NextApp };
        rt.registerExportsForReactRefresh('/a.jsx', prev);
        rt.registerExportsForReactRefresh('/a.jsx', next);
        expect(rt.validateRefreshBoundaryAndEnqueueUpdate('/a.jsx', prev, next)).toBeUndefined();
        // The first call in a quiet period runs immediately — an edit refreshes at once, and only a
        // burst is coalesced.
        expect(stub.refreshes).toBe(1);
    });

    it('accepts a bare component namespace', async () => {
        const { rt } = await loadRuntime('accept-bare');
        const NextApp = () => null;
        rt.registerExportsForReactRefresh('/a.jsx', App);
        rt.registerExportsForReactRefresh('/a.jsx', NextApp);
        expect(rt.validateRefreshBoundaryAndEnqueueUpdate('/a.jsx', App, NextApp)).toBeUndefined();
    });

    it('rejects when an export is no longer a component', async () => {
        const { rt, stub } = await loadRuntime('reject-noncomponent');
        const prev = { App };
        const next = { App, count: 1 };
        rt.registerExportsForReactRefresh('/a.jsx', prev);
        rt.registerExportsForReactRefresh('/a.jsx', next);
        const msg = rt.validateRefreshBoundaryAndEnqueueUpdate('/a.jsx', prev, next);
        expect(msg).toBe('Could not Fast Refresh (export removed or no longer a component)');
        expect(stub.refreshes).toBe(0);
    });

    it('rejects a module with no exports at all', async () => {
        const { rt } = await loadRuntime('reject-empty');
        expect(rt.validateRefreshBoundaryAndEnqueueUpdate('/a.jsx', {}, {})).toBeTruthy();
    });

    it('rejects when the set of exports changed', async () => {
        const { rt, stub } = await loadRuntime('reject-added');
        const prev = { App };
        const next = { App, Other };
        rt.registerExportsForReactRefresh('/a.jsx', prev);
        rt.registerExportsForReactRefresh('/a.jsx', next);
        const msg = rt.validateRefreshBoundaryAndEnqueueUpdate('/a.jsx', prev, next);
        expect(msg).toBe('Could not Fast Refresh (exports changed)');
        expect(stub.refreshes).toBe(0);
    });

    it('rejects when the module itself was not a boundary before', async () => {
        const { rt, stub } = await loadRuntime('reject-new-boundary');
        // The exports line up, but the previous version never registered its NAMESPACE — it was not
        // a refresh boundary. Without the namespace family leading the signature this update would
        // be accepted, and the runtime would try to refresh against families that do not exist.
        const prev = { App };
        const next = { App };
        rt.register(App, '/a.jsx %exports% App');
        rt.registerExportsForReactRefresh('/a.jsx', next);
        expect(rt.validateRefreshBoundaryAndEnqueueUpdate('/a.jsx', prev, next)).toBeTruthy();
        expect(stub.refreshes).toBe(0);
    });

    it('rejects, naming the export, when one export has no family', async () => {
        const { rt, stub } = await loadRuntime('reject-changed');
        // Same names in the same order, so the length check passes and the mismatch lands on a
        // FAMILY slot — which is the only way the message can name an export. Here the new `Other`
        // never registered, so it has no family while the old one does.
        const prev = { App, Other };
        const next = { App, Other: () => null };
        rt.registerExportsForReactRefresh('/a.jsx', prev);
        rt.register(next.App, '/a.jsx %exports% App');
        rt.register(next, '/a.jsx %exports%');
        const msg = rt.validateRefreshBoundaryAndEnqueueUpdate('/a.jsx', prev, next);
        expect(msg).toBe('Could not Fast Refresh (Other changed)');
        expect(stub.refreshes).toBe(0);
    });
});

describe('the plugin serves the runtime', () => {
    const fs: Fs = { read: () => null, exists: () => false };

    it('resolves and loads /@react-refresh', async () => {
        const server = createDevServer({ fs, plugins: [reactRefresh()] });
        const r = await server.fetchModule(REACT_REFRESH_RUNTIME_ID);
        expect(r.errors).toEqual([]);
        expect(r.code).toContain('registerExportsForReactRefresh');
    });

    it('declines a lookalike id', async () => {
        // The falsification arm for `load`.
        const server = createDevServer({ fs, plugins: [reactRefresh()] });
        const r = await server.fetchModule('/@react-refresh-x');
        expect(r.errors.length).toBeGreaterThan(0);
    });

    it('does not hijack ordinary resolution', async () => {
        // The falsification arm for `resolveId`, which `load` cannot stand in for: a plugin that
        // answered every specifier would resolve `./b.jsx` to itself and never reach the resolver —
        // no error, just a dep pointing nowhere. Measured: the anchored filter and the handler's
        // equality check each block that on their own, so only breaking BOTH fails this.
        const files: Record<string, string> = {
            '/a.jsx': 'import { B } from "./b.jsx";\nexport function App() { return <B />; }\n',
            '/b.jsx': 'export function B() { return <i>b</i>; }\n',
        };
        const app: Fs = { read: (i) => files[i] ?? null, exists: (i) => i in files };
        const server = createDevServer({ fs: app, plugins: [reactRefresh()] });
        const r = await server.fetchModule('/a.jsx');
        expect(r.errors).toEqual([]);
        expect(r.deps).toContain('/b.jsx');
    });
});

describe('the preamble', () => {
    it('parses, and installs the globals the footer demands', () => {
        const code = reactRefreshPreamble();
        expect(parse(code, { ts: false, jsx: false }).errors).toEqual([]);
        // The footer throws when `window.$RefreshReg$` is missing, so these two assignments are the
        // whole point of the preamble existing.
        expect(code).toContain('window.$RefreshReg$ = () => {};');
        expect(code).toContain('window.$RefreshSig$ = () => (type) => type;');
        expect(code).toContain('RefreshRuntime.injectIntoGlobalHook(window);');
        expect(code).toContain('from "/@react-refresh"');
    });

    it('honours a refresh host', () => {
        expect(reactRefreshPreamble('http://localhost:5173')).toContain('from "http://localhost:5173/@react-refresh"');
    });
});
