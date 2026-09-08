import { describe, expect, it } from 'vitest';
import { parse } from '../src/ast.ts';
import type { Fs } from '../src/bundler/fs.ts';
import { reactRefresh, refreshFooter } from '../src/bundler/plugins/react-refresh.ts';
import { createDevServer } from '../src/bundler/runtime/dev-server.ts';
import { createModuleRunner } from '../src/bundler/runtime/module-runner.ts';

// The wrapper supplies what the compile pass emits free references to, plus the HMR boundary. Its
// text is transcribed from rolldown's `add_refresh_wrapper`, so these assert that text rather than a
// paraphrase of it.
/** Run one module through the dev server with the plugin on, and return the emitted code. */
async function through(code: string, id: string, host = ''): Promise<string> {
    const files: Record<string, string> = { [id]: code };
    const fs: Fs = { read: (i) => files[i] ?? null, exists: (i) => i in files };
    const server = createDevServer({ fs, plugins: [reactRefresh({ reactRefreshHost: host })] });
    const r = await server.fetchModule(id);
    expect(r.errors, id).toEqual([]);
    return r.code;
}

describe('react-refresh wrapper — the gates', () => {
    const component = 'export function App() {\n  return <h1>hi</h1>;\n}\n';

    it('wires up a .jsx module', async () => {
        expect(await through(component, '/a.jsx')).toContain('$RefreshReg$');
    });

    it('wires up a .js module that imports the JSX runtime', async () => {
        // What a pre-lowered file looks like — the id says nothing, the import does.
        const src = 'import { jsx } from "react/jsx-runtime";\nexport function App() { return jsx("h1", {}); }\n';
        expect(await through(src, '/a.js')).toContain('$RefreshReg$');
    });

    it('leaves a plain .js module, and a component-free .jsx module, alone', async () => {
        // The falsification arm for both gates above.
        expect(await through('export const a = 1;\n', '/a.js')).not.toContain('$RefreshReg$');
        expect(await through('export const a = 1;\n', '/a.jsx')).not.toContain('$RefreshReg$');
    });

    it('wraps a CLASS component but does NOT define $RefreshReg$ for it', async () => {
        // The path the first draft of the plan missed entirely: a class component has nothing for
        // the pass to register, so it needs the boundary WITHOUT the definitions.
        const out = await through('export class A extends React.PureComponent {}\n', '/a.jsx');
        expect(out).toContain('registerExportsForReactRefresh');
        expect(out).not.toContain('createSignatureFunctionForTransform');
    });
});

describe('react-refresh wrapper — the footer text', () => {
    // Asserted as TEXT, not against a dev fetch: `devTransform` lowers every import to
    // `__shakeup.link(...)`, so reading the emitted module would test the runner protocol rather
    // than the transcription from rolldown's `add_refresh_wrapper`.
    const out = refreshFooter('/src/App.jsx', 'http://host', true);

    it('imports the runtime from the configured host', () => {
        expect(out).toContain('import * as RefreshRuntime from "http://host/@react-refresh"');
    });

    it('guards on the preamble, and on not being in a worker', () => {
        expect(out).toContain("typeof WorkerGlobalScope !== 'undefined'");
        expect(out).toContain('if (import.meta.hot && !inWebWorker)');
        expect(out).toContain("can't detect preamble");
    });

    it('registers exports and accepts, in a microtask', () => {
        expect(out).toContain('queueMicrotask(');
        expect(out).toContain('RefreshRuntime.registerExportsForReactRefresh("/src/App.jsx", currentExports)');
        expect(out).toContain('import.meta.hot.accept((nextExports) =>');
        expect(out).toContain('validateRefreshBoundaryAndEnqueueUpdate("/src/App.jsx", currentExports, nextExports)');
        expect(out).toContain('import.meta.hot.invalidate(invalidateMessage)');
    });

    it('namespaces every registration by module id', () => {
        // Two modules exporting a component of the same name must stay distinct families.
        expect(out).toContain('RefreshRuntime.register(type, "/src/App.jsx" + \' \' + id)');
    });

    it('reads its own exports through a self-import', () => {
        expect(out).toContain('import * as __vite_react_currentExports from "/src/App.jsx"');
    });

    it('omits the $Refresh definitions when the pass emitted nothing', () => {
        const classOnly = refreshFooter('/a.jsx', '', false);
        expect(classOnly).toContain('registerExportsForReactRefresh');
        expect(classOnly).not.toContain('function $RefreshReg$');
    });

    it('is valid JavaScript', () => {
        // It is spliced in as AST, so it has to parse — and a golden-text test would not notice.
        expect(parse(out, { ts: false, jsx: false }).errors).toEqual([]);
    });
});

// The self-import was the plan's highest-ranked open risk: rolldown emits `import * as X from
// "<the module's own id>"`, and shakeup's runner dedupes by promise and hands back partial exports
// for a module still on the eval stack — but self-import is not the cycle case that was written for.
describe('a module that imports itself, in the runner', () => {
    it('resolves rather than deadlocking, and sees its own exports afterwards', async () => {
        const files: Record<string, string> = {
            '/self.js': [
                'export const a = 1;',
                'import * as own from "/self.js";',
                'export const kindAtTop = typeof own;',
                'export function later() { return own.a; }',
            ].join('\n'),
        };
        const fs: Fs = { read: (id) => files[id] ?? null, exists: (id) => id in files };
        const server = createDevServer({ fs });
        const runner = createModuleRunner({
            resolveId: (spec, importer, extra) => server.resolveId(spec, importer, extra),
            fetchModule: async (id) => {
                const r = await server.fetchModule(id);
                if (r.errors.length > 0) throw new Error(r.errors.join('\n'));
                return r.code;
            },
            createImportMeta: (id) => ({ url: `sk://${id}` }),
        });

        const ns = (await runner.import('/self.js')) as { kindAtTop: string; later: () => number };
        expect(ns.kindAtTop, 'the namespace exists while the module is still evaluating').toBe('object');
        expect(ns.later(), 'and reads the finished export afterwards').toBe(1);
    });
});

describe('the pass and the footer compose', () => {
    it('the pass emits free references and the footer defines them', () => {
        const source = 'export function App() {\n  return <h1>hi</h1>;\n}\n';
        const files: Record<string, string> = { '/App.jsx': source };
        const fs: Fs = { read: (id) => files[id] ?? null, exists: (id) => id in files };
        const server = createDevServer({ fs, plugins: [reactRefresh()] });
        return server.fetchModule('/App.jsx').then((r) => {
            expect(r.errors).toEqual([]);
            // The pass's output…
            expect(r.code).toContain('$RefreshReg$');
            // …and the wrapper's definitions for it.
            expect(r.code).toContain('createSignatureFunctionForTransform');
            // The accept call reached the HMR extractor, so the module is a boundary.
            expect(r.hmr.selfAccepts, 'the wrapper makes the module self-accepting').toBe(true);
        });
    });
});
