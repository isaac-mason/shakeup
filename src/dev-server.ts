// The dev server (Arc D) — shakeup's own dev runtime, independent of any host's
// dev server. Owns the module graph, transform cache, and resolution; serves
// transformed (`__shakeup.*`) modules to the runner via `fetchModule`.
//
// SURFACE: plugin-driven, exactly like `bundle()` (P4). resolution, loading, and
// source transformation are the SAME rollup-shaped plugin hooks (resolveId / load /
// transform / moduleParsed) — makecat wires its virtual fs, custom resolution, and
// the `__bongle` capture pass as PLUGINS (the same Plugin objects usable in bundle
// mode), not bespoke options. Hooks may be async (the drivers keep a sync fast
// path), so an OPFS/network `load` works.
//
// Pipeline per module: runLoad (→ default fs) → runTransform (plugin source
// patches, e.g. capture) → devTransform (FUSED strip + module-runner rewrite over a
// SINGLE parse for non-JSX; JSX falls back to two) → cache + graph. moduleParsed
// runs read-only after a parse when any plugin needs it. A source map (runner code →
// original) is emitted per module and carried on FetchResult for the evaluator.

import { analyze, createSemantic } from './analysis/semantic.ts';
import type { HmrUpdate } from './environment.ts';
import type { Fs } from './fs.ts';
import { parse } from './parser.ts';
import {
    compilePipeline,
    type Pipeline,
    type Plugin,
    type PluginCtx,
    runLoad,
    runModuleParsed,
    runResolveId,
    runTransform,
} from './plugin.ts';
import type { SourceMap } from './sourcemap.ts';
import { devTransform, type HmrInfo, type TransformOptions } from './transform.ts';

/** Resolution result: a module id to evaluate through the graph, or an external
 *  specifier the runner native-imports. */
export type ResolveResult = string | { external: string };

export type DevServerOptions = {
    /** synchronous default fs backend for the built-in resolver + loader (node /
     *  tests). Omit it and supply async `load`/`resolveId` plugins instead (makecat:
     *  OPFS). */
    fs?: Fs;
    /** rollup-shaped plugins — the resolution/load/transform surface. */
    plugins?: Plugin[];
    /** JSX config forwarded to the strip transform. */
    jsx?: TransformOptions['jsx'];
    /** emit source maps (mapping runner code → original) so the runner attaches them
     *  and dev stack traces map to source. Default true. */
    sourcemap?: boolean;
    warn?: (message: string) => void;
};

/** A node in the dev graph. `deps`/`dynamicDeps` are resolved ids (for importer
 *  tracking + HMR propagation); the served code still references raw specifiers. */
export type ModuleNode = {
    id: string;
    hash: number;
    code: string;
    map?: SourceMap;
    deps: string[];
    dynamicDeps: string[];
    importers: Set<string>;
    hmr: HmrInfo;
    errors: string[];
};

export type FetchResult = {
    code: string;
    map?: SourceMap;
    deps: string[];
    dynamicDeps: string[];
    hmr: HmrInfo;
    errors: string[];
};

/** Minimal environment handle the dev server fans HMR to. An `Environment` is one
 *  ({@link HmrUpdate} is re-exported from `environment.ts`). */
export type EnvHandle = { readonly name: string; applyEdit(id: string): Promise<HmrUpdate> };

export type DevServer = {
    resolveId(spec: string, importer: string | null): Promise<ResolveResult>;
    /** transform (cached) + graph-track a module; the runner calls this. */
    fetchModule(id: string): Promise<FetchResult>;
    /** mark a module changed: drop its cache so the next fetch re-transforms. */
    invalidate(id: string): void;
    /** register an environment to receive HMR fan-out; returns an unregister fn. */
    register(env: EnvHandle): () => void;
    /** a file changed: invalidate the SHARED transform cache once, then fan
     *  applyEdit to every registered environment (each HMR-updates its own
     *  instances). Returns each env's per-change result. */
    handleChange(id: string): Promise<{ env: string; update: HmrUpdate }[]>;
    node(id: string): ModuleNode | undefined;
    moduleIds(): string[];
};

/** A host-provided change source: it receives an `emit(paths)` and wires the host's
 *  file watcher to it (node: `fs.watch`/chokidar; browser: the project-fs change
 *  stream). Returns an optional unsubscribe. `emit` resolves once that batch is
 *  handled, so a host can await if it needs to. */
export type ChangeSource = (emit: (paths: string[]) => Promise<void>) => (() => void) | void;

/** Wire a {@link ChangeSource} to a dev server: batches + de-dups changed paths and
 *  drives `handleChange` for each. Host-neutral — the watching is injected. */
export function watch(
    server: Pick<DevServer, 'handleChange'>,
    source: ChangeSource,
    opts: { debounceMs?: number; onError?: (e: unknown) => void } = {},
): { close(): void } {
    const debounceMs = opts.debounceMs ?? 0;
    let pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let resolveBatch: (() => void) | null = null;
    let batch: Promise<void> | null = null;

    const flush = async (): Promise<void> => {
        const ids = [...pending];
        pending = new Set();
        const done = resolveBatch;
        timer = null;
        batch = null;
        resolveBatch = null;
        for (const id of ids) {
            try {
                await server.handleChange(id);
            } catch (e) {
                opts.onError?.(e);
            }
        }
        done?.();
    };

    const emit = (paths: string[]): Promise<void> => {
        for (const p of paths) pending.add(p);
        if (batch === null) {
            batch = new Promise<void>((r) => {
                resolveBatch = r;
            });
        }
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(flush, debounceMs);
        return batch;
    };

    const unsub = source(emit);
    return {
        close() {
            if (timer !== null) clearTimeout(timer);
            unsub?.();
        },
    };
}

const EXT_PROBES = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '/index.ts', '/index.js'];
const isBare = (s: string): boolean => !s.startsWith('./') && !s.startsWith('../') && !s.startsWith('/');

function dirOf(id: string): string {
    const i = id.lastIndexOf('/');
    return i <= 0 ? '/' : id.slice(0, i);
}

function joinPath(base: string, spec: string): string {
    const parts = `${base}/${spec}`.split('/');
    const out: string[] = [];
    for (const p of parts) {
        if (p === '' || p === '.') continue;
        if (p === '..') out.pop();
        else out.push(p);
    }
    return `/${out.join('/')}`;
}

/** Cheap deterministic content hash (djb2) for cache validity. */
function hashOf(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
    return h >>> 0;
}

const NULL_FS: Fs = { read: () => null, exists: () => false };
const EMPTY_HMR: HmrInfo = { selfAccepts: false, acceptedDeps: [] };

export function createDevServer(options: DevServerOptions): DevServer {
    const fs = options.fs ?? NULL_FS;
    const pipeline: Pipeline = compilePipeline(options.plugins ?? []);
    const ctx: PluginCtx = { warn: options.warn ?? (() => {}), fs };
    const graph = new Map<string, ModuleNode>();

    /** default resolver: relative → path-probe against fs; bare → external. */
    function defaultResolve(spec: string, importer: string | null): ResolveResult {
        if (isBare(spec)) return { external: spec };
        const base = spec.startsWith('/') || importer === null ? spec : joinPath(dirOf(importer), spec);
        for (const ext of EXT_PROBES) {
            if (fs.read(base + ext) !== null) return base + ext;
        }
        return base; // unresolved — surfaces as a fetch error
    }

    async function resolveId(spec: string, importer: string | null): Promise<ResolveResult> {
        const hit = await runResolveId(pipeline, ctx, spec, importer);
        if (hit === false) return { external: spec };
        if (typeof hit === 'string') return hit;
        return defaultResolve(spec, importer);
    }

    async function resolveDeps(id: string, specs: string[]): Promise<string[]> {
        const out: string[] = [];
        for (const spec of specs) {
            const r = await resolveId(spec, id);
            if (typeof r === 'string') out.push(r);
        }
        return out;
    }

    async function fetchModule(id: string): Promise<FetchResult> {
        const source = (await runLoad(pipeline, ctx, id)) ?? fs.read(id);
        if (source === null) return { code: '', deps: [], dynamicDeps: [], hmr: EMPTY_HMR, errors: [`${id}: not found`] };

        const hash = hashOf(source);
        const cached = graph.get(id);
        if (cached !== undefined && cached.hash === hash && cached.errors.length === 0) {
            return {
                code: cached.code,
                map: cached.map,
                deps: cached.deps,
                dynamicDeps: cached.dynamicDeps,
                hmr: cached.hmr,
                errors: [],
            };
        }

        // plugin source patches (capture, etc.) → fused strip + module-runner rewrite.
        const patched = await runTransform(pipeline, ctx, source, id);

        // read-only moduleParsed (P4): only pay a parse when a plugin needs it. Parses
        // the (patched) module source — the real TS/JSX AST plugins inspect.
        if (pipeline.moduleParsed.length > 0) {
            const isx = id.endsWith('.tsx') || id.endsWith('.jsx');
            const { program, nodeCount } = parse(patched, { ts: true, jsx: isx });
            const semantic = createSemantic();
            analyze(semantic, program);
            await runModuleParsed(pipeline, ctx, { id, source: patched, program, nodeCount, semantic });
        }

        const result = devTransform(id, patched, { jsx: options.jsx, sourcemap: options.sourcemap ?? true });
        if (result.errors.length > 0) return { code: '', deps: [], dynamicDeps: [], hmr: EMPTY_HMR, errors: result.errors };
        const deps = await resolveDeps(id, result.deps);
        const dynamicDeps = await resolveDeps(id, result.dynamicDeps);
        // resolve accepted-dep specifiers to ids so the graph walk matches `deps`.
        const hmr: HmrInfo = {
            selfAccepts: result.hmr.selfAccepts,
            acceptedDeps: await resolveDeps(id, result.hmr.acceptedDeps),
        };

        const prev = graph.get(id);
        if (prev !== undefined) {
            for (const d of prev.deps) graph.get(d)?.importers.delete(id);
        }
        const node: ModuleNode = {
            id,
            hash,
            code: result.code,
            map: result.map,
            deps,
            dynamicDeps,
            importers: prev?.importers ?? new Set(),
            hmr,
            errors: result.errors,
        };
        graph.set(id, node);
        for (const d of deps) {
            let depNode = graph.get(d);
            if (depNode === undefined) {
                depNode = {
                    id: d,
                    hash: 0,
                    code: '',
                    deps: [],
                    dynamicDeps: [],
                    importers: new Set(),
                    hmr: EMPTY_HMR,
                    errors: [],
                };
                graph.set(d, depNode);
            }
            depNode.importers.add(id);
        }
        return { code: node.code, map: node.map, deps, dynamicDeps, hmr, errors: node.errors };
    }

    function invalidate(id: string): void {
        const node = graph.get(id);
        if (node !== undefined) node.hash = 0; // force re-transform on next fetch
    }

    const environments = new Set<EnvHandle>();
    function register(env: EnvHandle): () => void {
        environments.add(env);
        return () => environments.delete(env);
    }
    async function handleChange(id: string): Promise<{ env: string; update: HmrUpdate }[]> {
        invalidate(id); // shared transform cache — the module is re-transformed once
        const out: { env: string; update: HmrUpdate }[] = [];
        for (const env of environments) out.push({ env: env.name, update: await env.applyEdit(id) });
        return out;
    }

    return {
        resolveId,
        fetchModule,
        invalidate,
        register,
        handleChange,
        node: (id) => graph.get(id),
        moduleIds: () => [...graph.keys()],
    };
}
