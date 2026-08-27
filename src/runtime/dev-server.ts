import { analyze, createSemantic } from '../analysis/semantic.ts';
import type { Fs } from '../fs.ts';
import { EMPTY_MODULE_ID } from '../node-resolve.ts';
import { parse } from '../parser';
import {
    compilePipeline,
    type ModuleInfo,
    type PartialResolvedId,
    type Pipeline,
    type PluginCtx,
    type ResolveIdExtra,
    runLoad,
    runModuleParsed,
    runResolveId,
    runTransform,
} from '../plugin.ts';
import { type CommonOptions, isExternalSpecifier, makeBaseResolve } from '../resolve.ts';
import type { SourceMap } from '../sourcemap.ts';
import { devTransform, type HmrInfo } from '../transform.ts';
import type { HmrUpdate } from './environment.ts';

/** Resolution result: a module id to evaluate through the graph, or an external
 *  specifier the runner native-imports. */
export type ResolveResult = string | { external: string };

export type DevServerOptions = CommonOptions & {
    /** emit source maps (mapping runner code → original) so the runner attaches them
     *  and dev stack traces map to source. Default true. */
    sourcemap?: boolean;
    /** eagerly warm a module's static-import closure in the background on first transform, so the
     *  runner's later fetches are cache hits (transform overlaps the runner's eval). Default true. */
    preTransform?: boolean;
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
    /** Cumulative bundling metrics since the server was created (see {@link DevServerStats}). */
    stats(): DevServerStats;
};

/** Cumulative per-phase timing + counts across every `fetchModule` call — the cost of serving the
 *  module graph. `transformMs`/`devTransformMs`/`resolveMs` are summed over cache MISSES only (a hit
 *  re-transforms nothing). `wallMs` is the span from the first fetch to the last, so `wallMs` ≫ the
 *  phase sums means the time is in the transport/eval waterfall, not the transform itself. */
export type DevServerStats = {
    fetches: number;
    cacheHits: number;
    transforms: number;
    ioMs: number; // plugin load + fs read
    transformMs: number; // plugin transform hooks (e.g. capture)
    devTransformMs: number; // TS-strip + module-runner rewrite (+ any moduleParsed parse)
    resolveMs: number; // resolving a module's dep specifiers to ids
    /** wall time with ≥1 fetch in flight — `wallMs − busyMs` ≈ idle/eval/transport waterfall. */
    busyMs: number;
    wallMs: number;
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

/** Cheap deterministic content hash (djb2) for cache validity. `Math.imul` keeps the multiply
 *  in int32 (the trailing `^` already truncates, so the digest is bit-identical to `h * 33`). */
function hashOf(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = Math.imul(h, 33) ^ s.charCodeAt(i);
    return h >>> 0;
}

const NULL_FS: Fs = { read: () => null, exists: () => false };
const EMPTY_HMR: HmrInfo = { selfAccepts: false, acceptedDeps: [] };

export function createDevServer(options: DevServerOptions): DevServer {
    const fs = options.fs ?? NULL_FS;
    const baseResolve = makeBaseResolve(fs, options.resolve, options.platform, (m) => options.warn?.(m));
    const pipeline: Pipeline = compilePipeline(options.plugins ?? []);
    // Cumulative bundling metrics (exposed via `stats()`). firstAt/lastAt bound the wall span;
    // busyMs is the wall time with ≥1 fetch in flight (so wall − busyMs ≈ idle/eval/transport).
    const perf = {
        fetches: 0,
        cacheHits: 0,
        transforms: 0,
        ioMs: 0,
        transformMs: 0,
        devTransformMs: 0,
        resolveMs: 0,
        firstAt: 0,
        lastAt: 0,
        busyMs: 0,
        inFlight: 0,
        busyStart: 0,
    };
    // (spec, importer) → resolution, cleared on any fs change (create/update can shift resolution).
    // Keeps boot from re-probing OPFS for the same specifiers across the graph.
    const resolveCache = new Map<string, ResolveResult>();
    const preTransform = options.preTransform !== false;
    const graph = new Map<string, ModuleNode>();

    /** Project a dev {@link ModuleNode} into the plugin-facing {@link ModuleInfo}.
     *  The dev graph lacks named-exports/side-effects (dev doesn't shake), so
     *  `exports: []`, `moduleSideEffects: true`. */
    function toModuleInfo(id: string, node: ModuleNode): ModuleInfo {
        return {
            id,
            code: node.code,
            isEntry: false,
            isExternal: false,
            moduleSideEffects: true,
            meta: {},
            moduleType: 'js',
            importedIds: node.deps,
            dynamicallyImportedIds: node.dynamicDeps,
            importers: [...node.importers],
            dynamicImporters: [],
            exports: [],
        };
    }

    const warn = options.warn ?? (() => {});
    const ctx: PluginCtx = {
        warn,
        error: (m) => {
            throw new Error(m);
        },
        info: warn,
        debug: () => {},
        fs,
        resolve: async (source, importer = null, opts) => {
            const r = await resolveId(source, importer ?? null, {
                isEntry: opts?.isEntry ?? false,
                kind: opts?.kind ?? 'import-statement',
                custom: opts?.custom,
            });
            const partial: PartialResolvedId =
                typeof r === 'string' ? { id: r, external: false } : { id: r.external, external: true };
            return partial;
        },
        emitFile: () => {
            // The dev server has no output sink — assets resolve through a host url() strategy
            // (e.g. the asset plugin's `url` option) rather than being emitted.
            throw new Error('emitFile is not supported by the dev server — configure the asset plugin with a url() strategy');
        },
        getModuleInfo: (id) => {
            const node = graph.get(id);
            return node === undefined ? null : toModuleInfo(id, node);
        },
        getModuleIds: () => graph.keys(),
    };

    async function resolveId(spec: string, importer: string | null, _extra?: ResolveIdExtra): Promise<ResolveResult> {
        const key = `${importer ?? ''}\x00${spec}`;
        const cached = resolveCache.get(key);
        if (cached !== undefined) return cached;
        const result = await resolveIdInner(spec, importer);
        resolveCache.set(key, result);
        return result;
    }

    async function resolveIdInner(spec: string, importer: string | null): Promise<ResolveResult> {
        const hit = await runResolveId(pipeline, ctx, spec, importer);
        if (hit === false) return { external: spec };
        if (typeof hit === 'string') return hit;
        if (hit !== null && hit !== undefined && typeof hit === 'object') {
            // PartialResolvedId: external:true|'absolute'|'relative' → runner native-import.
            // External target is the plugin's RESOLVED id (Rollup semantics), so a plugin can
            // externalize to a rewritten target — e.g. resolve a bare dep to a served URL the runner
            // native-imports, instead of keeping the bare specifier (which needs an import map).
            if (hit.external !== undefined && hit.external !== false) return { external: hit.id };
            return hit.id;
        }
        // No plugin resolved it: honour `external`, then the shared config-driven resolver.
        if (isExternalSpecifier(options.external, spec)) return { external: spec };
        const resolved = await baseResolve(spec, importer);
        // Dev serves modules one at a time and never tree-shakes, so the record form's
        // `moduleSideEffects` is irrelevant here — take the id.
        if (resolved !== null) return typeof resolved === 'string' ? resolved : resolved.id;
        // Unresolved: a bare specifier is native-imported; a relative one surfaces as a fetch error.
        if (isBare(spec)) return { external: spec };
        return spec.startsWith('/') || importer === null ? spec : joinPath(dirOf(importer), spec);
    }

    async function resolveDeps(id: string, specs: string[]): Promise<string[]> {
        const out: string[] = [];
        for (const spec of specs) {
            const r = await resolveId(spec, id);
            if (typeof r === 'string') out.push(r);
        }
        return out;
    }

    // In-flight dedup: concurrent requests for one id share ONE transform — essential once
    // preTransform fires prefetches alongside the runner's real fetches.
    const inFlight = new Map<string, Promise<FetchResult>>();
    function fetchModule(id: string): Promise<FetchResult> {
        perf.fetches++;
        const pending = inFlight.get(id);
        if (pending !== undefined) return pending;
        const p = fetchModuleTracked(id);
        inFlight.set(id, p);
        void p.finally(() => inFlight.delete(id));
        return p;
    }

    // Whole-fetch metrics (wall span / busy-interval) around the impl.
    async function fetchModuleTracked(id: string): Promise<FetchResult> {
        const t = performance.now();
        if (perf.firstAt === 0) perf.firstAt = t;
        if (perf.inFlight === 0) perf.busyStart = t;
        perf.inFlight++;
        try {
            return await fetchModuleImpl(id);
        } finally {
            perf.inFlight--;
            const now = performance.now();
            perf.lastAt = now;
            if (perf.inFlight === 0) perf.busyMs += now - perf.busyStart;
        }
    }

    async function fetchModuleImpl(id: string): Promise<FetchResult> {
        if (id === EMPTY_MODULE_ID) return { code: '', deps: [], dynamicDeps: [], hmr: EMPTY_HMR, errors: [] };
        // Known-clean fast path: a fully-transformed module whose cache wasn't invalidated
        // (invalidate/handleChange zero the hash) is served WITHOUT re-reading source — the big
        // cross-realm re-fetch win. Trusts the change signal (handleChange), which HMR requires anyway.
        const known = graph.get(id);
        if (known !== undefined && known.hash !== 0 && known.errors.length === 0) {
            perf.cacheHits++;
            return {
                code: known.code,
                map: known.map,
                deps: known.deps,
                dynamicDeps: known.dynamicDeps,
                hmr: known.hmr,
                errors: [],
            };
        }

        const tIo = performance.now();
        const loaded = await runLoad(pipeline, ctx, id);
        // SourceDescription → take .code; string/null unchanged. Dev doesn't shake, so
        // moduleSideEffects/meta/moduleType are accepted but ignored.
        const source =
            (loaded === null || loaded === undefined ? null : typeof loaded === 'string' ? loaded : loaded.code) ??
            (await fs.read(id));
        perf.ioMs += performance.now() - tIo;
        if (source === null) return { code: '', deps: [], dynamicDeps: [], hmr: EMPTY_HMR, errors: [`${id}: not found`] };

        const hash = hashOf(source);
        // Re-read reached only after invalidation/first-fetch; content-hash still matching (e.g. a
        // no-op save) skips the transform.
        const cached = graph.get(id);
        if (cached !== undefined && cached.hash === hash && cached.errors.length === 0) {
            perf.cacheHits++;
            return {
                code: cached.code,
                map: cached.map,
                deps: cached.deps,
                dynamicDeps: cached.dynamicDeps,
                hmr: cached.hmr,
                errors: [],
            };
        }
        perf.transforms++;

        // plugin source patches → fused strip + module-runner rewrite.
        const tTransform = performance.now();
        const patched = (await runTransform(pipeline, ctx, source, id)).code;
        perf.transformMs += performance.now() - tTransform;

        const tDev = performance.now();
        // read-only moduleParsed: only pay a parse when a plugin needs it.
        if (pipeline.moduleParsed.length > 0) {
            const isx = id.endsWith('.tsx') || id.endsWith('.jsx');
            const { program, nodeCount } = parse(patched, { ts: true, jsx: isx });
            const semantic = createSemantic();
            analyze(semantic, program);
            await runModuleParsed(pipeline, ctx, {
                id,
                source: patched,
                program,
                nodeCount,
                semantic,
                moduleSideEffects: true,
                meta: {},
                moduleType: 'js',
            });
        }

        const result = devTransform(id, patched, { jsx: options.jsx, sourcemap: options.sourcemap ?? true });
        perf.devTransformMs += performance.now() - tDev;
        if (result.errors.length > 0) return { code: '', deps: [], dynamicDeps: [], hmr: EMPTY_HMR, errors: result.errors };
        const tResolve = performance.now();
        const deps = await resolveDeps(id, result.deps);
        const dynamicDeps = await resolveDeps(id, result.dynamicDeps);
        // resolve accepted-dep specifiers to ids so the graph walk matches `deps`.
        const hmr: HmrInfo = {
            selfAccepts: result.hmr.selfAccepts,
            acceptedDeps: await resolveDeps(id, result.hmr.acceptedDeps),
        };
        perf.resolveMs += performance.now() - tResolve;

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
        // Eagerly warm this module's STATIC import closure in the background so the runner's later
        // fetches hit the cache — overlapping transform with eval. Fire-and-forget; the in-flight
        // dedup + known-clean cache prevent duplicate/repeat work.
        if (preTransform) for (const dep of deps) void fetchModule(dep).catch(() => {});
        // Timeline annotation: this module's cold-transform span (load+read+transform+resolve), so a
        // DevTools recording of the bundler-worker attributes transform time per module.
        try {
            performance.measure(`transform ${id}`, { start: tIo });
        } catch {}
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
        resolveCache.clear(); // a create/edit can shift resolution (new file, shadowing) — re-resolve lazily
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
        stats: () => ({
            fetches: perf.fetches,
            cacheHits: perf.cacheHits,
            transforms: perf.transforms,
            ioMs: perf.ioMs,
            transformMs: perf.transformMs,
            devTransformMs: perf.devTransformMs,
            resolveMs: perf.resolveMs,
            busyMs: perf.busyMs,
            wallMs: perf.firstAt === 0 ? 0 : perf.lastAt - perf.firstAt,
        }),
    };
}
