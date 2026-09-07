import { analyze, createSemantic } from '../../analysis/semantic.ts';
import { parse } from '../../parser/index.ts';
import type { SourceMap } from '../../util/sourcemap.ts';
import type { Fs } from '../fs.ts';
import { EMPTY_MODULE_ID } from '../node-resolve.ts';
import {
    compilePipeline,
    type ImportKind,
    type ModuleInfo,
    normalizePluginOptionSync,
    type PartialResolvedId,
    type Pipeline,
    type PluginCtx,
    pluginParse,
    type ResolveIdExtra,
    runLoad,
    runModuleParsed,
    runResolveId,
    runTransform,
    pluginMeta,
} from '../plugin.ts';
import { type CommonOptions, isExternalSpecifier, makeBaseResolve } from '../resolve.ts';
import { devTransform, type HmrInfo } from '../transform.ts';
import type { HmrUpdate } from './environment.ts';

/** Resolution result: a module id to evaluate through the graph, or an external
 *  specifier the runner native-imports. */
export type ResolveResult = string | { external: string };

export type DevServerOptions = CommonOptions & {
    /** Emit source maps (mapping runner code → the module's own source) so the runner attaches
     *  them and dev stack traces map back. A predicate decides per module.
     *
     *  Default: every module EXCEPT `node_modules` — the same rule `sourcemapIgnoreList` already
     *  defaults to on the output side. A built dependency has no original source in reach, so its
     *  map points at the built file: worth little, and paid for with a full SMv3 map plus a base64
     *  `sourceMappingURL` bolted onto every module body, on every boot, in every environment.
     *  `true` restores the old behaviour and maps everything. */
    sourcemap?: boolean | ((id: string) => boolean);
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
    resolveId(spec: string, importer: string | null, extra?: ResolveIdExtra): Promise<ResolveResult>;
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
    /** Batches are applied ONE AT A TIME. `flush` awaits `handleChange` per id, so a batch whose
     *  debounce elapsed while an earlier one was still applying used to start on top of it: the
     *  transcript read `start a | start b | end a | end b`. `handleChange` invalidates the shared
     *  transform cache and then fans HMR updates out to every environment, so overlapping batches
     *  let an environment receive an update computed either side of another batch's invalidation.
     *  Chaining here is the whole serialisation — the timer schedules onto this tail, never
     *  straight into `flush`. */
    let applying: Promise<void> = Promise.resolve();

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
        timer = setTimeout(() => {
            applying = applying.then(flush);
        }, debounceMs);
        return batch;
    };

    const unsub = source(emit);
    return {
        close() {
            if (timer !== null) clearTimeout(timer);
            timer = null;
            // SETTLE the batch this close abandons. `emit` resolves "once that batch is handled",
            // and a host that awaits it before shutting down waited forever: close cleared the
            // timer, so nothing ever called `resolveBatch`. The pending paths are dropped — the
            // server is closed — but the promise must not be. A batch already applying is not
            // touched; it resolves when it finishes.
            pending = new Set();
            batch = null;
            const done = resolveBatch;
            resolveBatch = null;
            done?.();
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

/** Resolve `sourcemap` into a per-module predicate. Default: everything but `node_modules` — the
 *  same test `normalizeIgnoreList` applies on the output side, inverted, since this option's `true`
 *  means "emit" where an ignore-list's means "skip".
 *
 *  The `string`/`RegExp` forms `sourcemapIgnoreList` accepts are deliberately NOT accepted here: its
 *  booleans mean the opposite of these, and a shared union would make the two look interchangeable. */
function normalizeSourcemap(v: boolean | ((id: string) => boolean) | undefined): (id: string) => boolean {
    if (v === undefined) return (id) => !id.includes('node_modules');
    if (typeof v === 'boolean') return () => v;
    // A user FUNCTION must actually answer the question — the same contract `sourcemapIgnoreList`
    // enforces, rather than letting `undefined` fall through as a silent "no map".
    return (id) => {
        const r = v(id);
        if (typeof r !== 'boolean') throw new Error('sourcemap function must return a boolean.');
        return r;
    };
}

export function createDevServer(options: DevServerOptions): DevServer {
    const fs = options.fs ?? NULL_FS;
    const wantSourcemap = normalizeSourcemap(options.sourcemap);
    const baseResolve = makeBaseResolve(fs, options.resolve, options.platform, (m) => options.warn?.(m));
    const pipeline: Pipeline = compilePipeline(normalizePluginOptionSync(options.plugins, (m) => options.warn?.(m)));
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
            hasDefaultExport: null,
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
        meta: pluginMeta(options.watchMode),
        parse: pluginParse,
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
        getFileName: () => {
            // Nothing can have been emitted, so no reference id can exist. Same message as
            // `emitFile`: the cause is always that something tried to emit.
            throw new Error('emitFile is not supported by the dev server — configure the asset plugin with a url() strategy');
        },
        // The dev server serves on demand; a plugin asking to pre-load gets what the runner has seen.
        load: ({ id }) => ctx.getModuleInfo(id),
        getModuleInfo: (id) => {
            const node = graph.get(id);
            return node === undefined ? null : toModuleInfo(id, node);
        },
        getModuleIds: () => graph.keys(),
    };

    /**
     * `buildStart`, ONCE per server, lazily.
     *
     * It never ran here at all — a plugin doing setup in `buildStart` (seeding state its `load` reads,
     * opening a cache, reading a manifest) worked under the bundler and silently did nothing under
     * the dev server. Both pipelines run the same plugin list, so the surface has to be the same.
     *
     * Lazily rather than in `createDevServer`, because that is synchronous and `buildStart` is
     * `async, parallel`; and once rather than per fetch, which is Vite's model — its
     * `PluginContainer.buildStart()` fires a single time for the life of the server. The promise is
     * memoised, so concurrent first fetches await one call rather than racing several.
     *
     * `buildEnd` is deliberately NOT fired: a long-lived server has no build to end, this surface has
     * no `close()`, and inventing a trigger would be worse than the gap. Recorded rather than
     * half-done.
     */
    let started: Promise<void> | null = null;
    const ensureStarted = (): Promise<void> => {
        started ??= Promise.all(pipeline.buildStart.map((hook) => hook.handler.call(ctx))).then(() => undefined);
        return started;
    };

    const DEV_RESOLVE_EXTRA: ResolveIdExtra = { isEntry: false, kind: 'import-statement' };

    async function resolveId(
        spec: string,
        importer: string | null,
        extra: ResolveIdExtra = DEV_RESOLVE_EXTRA,
    ): Promise<ResolveResult> {
        await ensureStarted();
        // `extra` was ACCEPTED AND DROPPED here, so every dev resolution reached the plugins as
        // `{isEntry: false, kind: 'import-statement'}`: a dynamic import resolved as if it were a
        // static one, and `custom` — Rollup's documented plugin-to-plugin channel, the whole point
        // of `this.resolve(…, {custom})` — never arrived. Both are threaded now.
        //
        // `custom` also has to defeat the cache: it carries arbitrary values that cannot go in a
        // string key, and two `this.resolve` calls for one specifier with DIFFERENT custom data are
        // two different questions. Before this, the second silently reused the first's answer.
        // `kind`/`isEntry` are keyable, so they join the key rather than skipping the cache.
        if (extra.custom !== undefined) return resolveIdInner(spec, importer, extra);
        const key = `${importer ?? ''}\x00${extra.kind}\x00${extra.isEntry ? 'E' : ''}\x00${spec}`;
        const cached = resolveCache.get(key);
        if (cached !== undefined) return cached;
        const result = await resolveIdInner(spec, importer, extra);
        resolveCache.set(key, result);
        return result;
    }

    async function resolveIdInner(spec: string, importer: string | null, extra: ResolveIdExtra): Promise<ResolveResult> {
        // A dynamic import tries `resolveDynamicImport` FIRST and falls through to `resolveId` when
        // every hook declines — the same shape as the bundler's (see `scan.ts`), which mirrors
        // rolldown's `resolve_id_with_plugins`. Dev never ran this chain at all, so a plugin's
        // `resolveDynamicImport` hook was dead code under the dev server.
        const dynamicHit =
            extra.kind === 'dynamic-import' && pipeline.resolveDynamicImport.length > 0
                ? await runResolveId(pipeline, () => ctx, spec, importer, extra, undefined, 'resolveDynamicImport')
                : null;
        const hit = dynamicHit ?? (await runResolveId(pipeline, () => ctx, spec, importer, extra));
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

    async function resolveDeps(id: string, specs: string[], kind: ImportKind = 'import-statement'): Promise<string[]> {
        const out: string[] = [];
        for (const spec of specs) {
            const r = await resolveId(spec, id, { isEntry: false, kind });
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
        // `then(cleanup, cleanup)`, not `finally`: `finally` returns a NEW promise that adopts p's
        // rejection, and discarding it unhandled turns any throwing plugin hook into a spurious
        // unhandled rejection on top of the error the caller already sees.
        const cleanup = () => {
            inFlight.delete(id);
        };
        void p.then(cleanup, cleanup);
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
        // The other entry point — a runner that already holds a resolved id fetches without ever
        // calling `resolveId`, so gating only that one would leave `buildStart` unfired.
        await ensureStarted();
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
        const loaded = await runLoad(pipeline, () => ctx, id);
        // SourceDescription → take .code; string/null unchanged. Dev doesn't shake, so
        // moduleSideEffects/meta/moduleType are accepted but ignored.
        const source =
            (loaded === null || loaded === undefined ? null : typeof loaded === 'string' ? loaded : loaded.code) ??
            (await fs.read(id));
        perf.ioMs += performance.now() - tIo;
        if (source === null) return { code: '', deps: [], dynamicDeps: [], hmr: EMPTY_HMR, errors: [`${id}: not found`] };
        // COMMONJS IS NOT A DEV-SERVER GOAL — the module runner evaluates ESM, and `module`/`exports`
        // do not exist there. shakeup's position (`llm/notes/cjs.md`) is that npm dependencies are
        // pre-seeded as ESM by an offline step rather than translated on the hot path.
        //
        // Say so. Served verbatim, a `.cjs` file reached the runner and threw
        // `ReferenceError: module is not defined` from inside the evaluated module — a runtime error
        // with no connection to its cause, from a `fetchModule` that reported success. The BUNDLE
        // path handles the same file correctly, which is what makes the silence worst: the two
        // pipelines disagreed and only one said anything.
        //
        // Keyed on the EXTENSION alone, which is unambiguous: `.cjs`/`.cts` are CommonJS by
        // definition. A `.js` file that is CommonJS by its package manifest is not detected here —
        // that needs the `defFormat` resolution the dev path does not do — and is left as a known
        // limit rather than guessed at from the source text.
        if (id.endsWith('.cjs') || id.endsWith('.cts')) {
            return {
                code: '',
                deps: [],
                dynamicDeps: [],
                hmr: EMPTY_HMR,
                errors: [
                    `${id}: CommonJS is not supported by the dev server — the module runner evaluates ES modules. ` +
                        `Pre-build this dependency to ESM, or import an ESM entry point instead. (The bundler handles CommonJS.)`,
                ],
            };
        }

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
        const result = devTransform(id, patched, { jsx: options.jsx, sourcemap: wantSourcemap(id) });
        perf.devTransformMs += performance.now() - tDev;
        if (result.errors.length > 0) return { code: '', deps: [], dynamicDeps: [], hmr: EMPTY_HMR, errors: result.errors };
        const tResolve = performance.now();
        const deps = await resolveDeps(id, result.deps);
        const dynamicDeps = await resolveDeps(id, result.dynamicDeps, 'dynamic-import');
        // resolve accepted-dep specifiers to ids so the graph walk matches `deps`.
        const hmr: HmrInfo = {
            selfAccepts: result.hmr.selfAccepts,
            // `import-statement`, NOT the `hot-accept` kind: an accepted dep names the same
            // specifier as a static import of it, and must resolve to the SAME id or the HMR
            // boundary points at a module the graph does not have. A plugin that rewrites
            // `import-statement` and declines an unfamiliar kind would break exactly that.
            acceptedDeps: await resolveDeps(id, result.hmr.acceptedDeps),
        };
        perf.resolveMs += performance.now() - tResolve;

        // read-only moduleParsed: only pay a parse when a plugin needs it.
        //
        // AFTER `resolveDeps`, so `importedIds`/`dynamicallyImportedIds` carry the resolved ids the
        // hook's contract promises — the same state the bundle path hands it. It used to run before
        // the dev transform, which is where the specifiers come from, so there was nothing to report.
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
                importedIds: deps,
                dynamicallyImportedIds: dynamicDeps,
            });
        }

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
