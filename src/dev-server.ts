import { analyze, createSemantic } from './analysis/semantic.ts';
import type { HmrUpdate } from './environment.ts';
import type { Fs } from './fs.ts';
import { type CommonOptions, isExternalSpecifier, makeBaseResolve } from './module-graph.ts';
import { EMPTY_MODULE_ID } from './node-resolve.ts';
import { parse } from './parser.ts';
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
} from './plugin.ts';
import type { SourceMap } from './sourcemap.ts';
import { devTransform, type HmrInfo } from './transform.ts';

/** Resolution result: a module id to evaluate through the graph, or an external
 *  specifier the runner native-imports. */
export type ResolveResult = string | { external: string };

export type DevServerOptions = CommonOptions & {
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
        getModuleInfo: (id) => {
            const node = graph.get(id);
            return node === undefined ? null : toModuleInfo(id, node);
        },
        getModuleIds: () => graph.keys(),
    };

    async function resolveId(spec: string, importer: string | null, _extra?: ResolveIdExtra): Promise<ResolveResult> {
        const hit = await runResolveId(pipeline, ctx, spec, importer);
        if (hit === false) return { external: spec };
        if (typeof hit === 'string') return hit;
        if (hit !== null && hit !== undefined && typeof hit === 'object') {
            // PartialResolvedId: external:true|'absolute'|'relative' → runner native-import.
            if (hit.external !== undefined && hit.external !== false) return { external: spec };
            return hit.id;
        }
        // No plugin resolved it: honour `external`, then the shared config-driven resolver.
        if (isExternalSpecifier(options.external, spec)) return { external: spec };
        const resolved = await baseResolve(spec, importer);
        if (resolved !== null) return resolved;
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

    async function fetchModule(id: string): Promise<FetchResult> {
        if (id === EMPTY_MODULE_ID) return { code: '', deps: [], dynamicDeps: [], hmr: EMPTY_HMR, errors: [] };
        const loaded = await runLoad(pipeline, ctx, id);
        // SourceDescription → take .code; string/null unchanged. Dev doesn't shake, so
        // moduleSideEffects/meta/moduleType are accepted but ignored.
        const source =
            (loaded === null || loaded === undefined ? null : typeof loaded === 'string' ? loaded : loaded.code) ?? (await fs.read(id));
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

        // plugin source patches → fused strip + module-runner rewrite.
        const patched = (await runTransform(pipeline, ctx, source, id)).code;

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
