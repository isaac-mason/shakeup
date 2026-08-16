import type { FetchResult } from './dev-server.ts';
import type { ImportMetaInit, ModuleEvaluator, ResolveId, ModuleRunner } from './module-runner.ts';
import { createModuleRunner } from './module-runner.ts';
import type { HmrInfo } from './transform.ts';

const EMPTY_HMR: HmrInfo = { selfAccepts: false, acceptedDeps: [] };

/** the result of propagating one changed module through this env's graph. */
export type HmrUpdate = { type: 'update'; boundaries: string[] } | { type: 'full-reload' } | { type: 'noop' }; // this env never loaded the module

export type EnvironmentOptions = {
    name: string;
    /** the SHARED dev server's transform+cache (a module is transformed once for
     *  all envs); this env evaluates it independently. */
    fetchModule: (id: string) => FetchResult | Promise<FetchResult>;
    resolveId: ResolveId;
    /** build a module's import.meta base (url + filename). Browser: the SW URL;
     *  node: file://. */
    createImportMeta?: (id: string) => ImportMetaInit | Promise<ImportMetaInit>;
    /** import.meta.env — this env's runtime env (client vs server differ here). */
    env?: Record<string, unknown>;
    /** how modules are evaluated + externals imported (browser: a `node:`-rejecting
     *  evaluator; default: AsyncFunction + dynamic import). */
    evaluator?: ModuleEvaluator;
    /** run once before the first module evaluates (browser: process shim). */
    prepare?: () => void;
    /** outbound custom HMR events (`import.meta.hot.send`) — forward to the server /
     *  other realms. Inbound events are delivered via `env.runner.emit(event, data)`. */
    onHotSend?: (event: string, data: unknown) => void;
    /** called when an edit can't be handled by HMR and this env needs a full reload
     *  (host decides how: re-import the entry, reload the realm/iframe). `id` is the
     *  changed module that triggered it. Host-neutral — the core only signals. */
    onFullReload?: (id: string) => void;
};

type EnvNode = {
    deps: string[];
    dynamicDeps: string[];
    importers: Set<string>;
    dynamicImporters: Set<string>;
    hmr: HmrInfo;
};
type HmrBoundary = { boundary: string; acceptedPath: string };

export type Environment = {
    name: string;
    /** this env's runner — its own module instances. */
    runner: ModuleRunner;
    /** evaluate a module (and its graph) in this env. */
    import(id: string): Promise<Record<string, unknown>>;
    /** an upstream edit re-transformed `id`: propagate HMR within THIS env. Assumes
     *  the shared dev server has already invalidated `id`'s transform cache. */
    applyEdit(id: string): Promise<HmrUpdate>;
    node(id: string): EnvNode | undefined;
};

export function createEnvironment(options: EnvironmentOptions): Environment {
    const graph = new Map<string, EnvNode>();
    const roots = new Set<string>(); // explicitly-imported entry modules (never pruned)

    // Wrap the shared fetchModule to record this env's graph as it loads modules.
    const fetchModule = async (id: string): Promise<{ code: string; map?: FetchResult['map'] }> => {
        const r = await options.fetchModule(id);
        if (r.errors.length > 0) throw new Error(r.errors.join('\n'));
        const prev = graph.get(id);
        if (prev !== undefined) {
            for (const d of prev.deps) graph.get(d)?.importers.delete(id);
            for (const d of prev.dynamicDeps) graph.get(d)?.dynamicImporters.delete(id);
        }
        const node: EnvNode = {
            deps: r.deps,
            dynamicDeps: r.dynamicDeps,
            importers: prev?.importers ?? new Set(),
            dynamicImporters: prev?.dynamicImporters ?? new Set(),
            hmr: r.hmr,
        };
        graph.set(id, node);
        const edge = (d: string): EnvNode => {
            let dn = graph.get(d);
            if (dn === undefined) {
                dn = { deps: [], dynamicDeps: [], importers: new Set(), dynamicImporters: new Set(), hmr: EMPTY_HMR };
                graph.set(d, dn);
            }
            return dn;
        };
        for (const d of r.deps) edge(d).importers.add(id);
        for (const d of r.dynamicDeps) edge(d).dynamicImporters.add(id);
        return { code: r.code, map: r.map };
    };

    // `import.meta.hot.invalidate()` calls land here; applyEdit drains them and
    // re-propagates (bubbling to the invalidating module's importers).
    const pendingInvalidations = new Set<string>();
    const runner = createModuleRunner({
        resolveId: options.resolveId,
        fetchModule,
        createImportMeta: options.createImportMeta,
        env: options.env,
        evaluator: options.evaluator,
        prepare: options.prepare,
        onHotSend: options.onHotSend,
        onInvalidate: (id) => pendingInvalidations.add(id),
    });

    /** Walk importers from `id` collecting accept boundaries as (boundary,
     *  acceptedPath) pairs. `bubble` skips `id`'s own self-accept (used when `id`
     *  called hot.invalidate() — it can't handle the update, so go to its importers).
     *  Returns false on a dead end (a root reached with no acceptance) → full reload. */
    function propagate(
        id: string,
        boundaries: HmrBoundary[],
        seen: Set<string>,
        dynamicBoundaries: Set<string>,
        bubble = false,
    ): boolean {
        if (seen.has(id)) return true;
        seen.add(id);
        const node = graph.get(id);
        if (node === undefined) return true; // not loaded here — nothing to propagate
        if (!bubble && node.hmr.selfAccepts) {
            boundaries.push({ boundary: id, acceptedPath: id });
            return true;
        }
        if (node.importers.size === 0) {
            // No static importers. If dynamically imported, the dynamic edge is an
            // implicit boundary — invalidate the module; the importer's next
            // `import()` gets the fresh version (no full reload).
            if (node.dynamicImporters.size > 0) {
                dynamicBoundaries.add(id);
                return true;
            }
            return false; // root, unaccepted → full reload
        }
        for (const importer of node.importers) {
            if (graph.get(importer)?.hmr.acceptedDeps.includes(id)) {
                boundaries.push({ boundary: importer, acceptedPath: id });
                continue;
            }
            if (!propagate(importer, boundaries, seen, dynamicBoundaries)) return false;
        }
        return true;
    }

    async function applyEdit(id: string): Promise<HmrUpdate> {
        const result = await propagateAndApply(id);
        if (result.type === 'full-reload') options.onFullReload?.(id);
        return result;
    }

    async function propagateAndApply(id: string): Promise<HmrUpdate> {
        if (!graph.has(id)) return { type: 'noop' };
        const allBoundaries: string[] = [];
        const done = new Set<string>(); // ids already propagated (guards invalidate loops)
        const queue: Array<{ id: string; bubble: boolean }> = [{ id, bubble: false }];

        while (queue.length > 0) {
            const { id: cur, bubble } = queue.shift() as { id: string; bubble: boolean };
            const key = `${cur}:${bubble}`;
            if (done.has(key)) continue;
            done.add(key);

            const boundaries: HmrBoundary[] = [];
            const seen = new Set<string>();
            const dynamicBoundaries = new Set<string>();
            const ok = propagate(cur, boundaries, seen, dynamicBoundaries, bubble);
            if (!ok || (boundaries.length === 0 && dynamicBoundaries.size === 0)) return { type: 'full-reload' };

            // Dynamic boundaries: invalidate so the next import() re-fetches fresh.
            for (const d of dynamicBoundaries) {
                runner.invalidate(d);
                allBoundaries.push(d);
            }
            // Invalidate intermediates so a boundary re-eval re-links fresh code.
            const handled = new Set([...boundaries.flatMap((b) => [b.boundary, b.acceptedPath]), ...dynamicBoundaries]);
            for (const x of seen) if (!handled.has(x)) runner.invalidate(x);

            pendingInvalidations.clear();
            for (const b of boundaries) {
                if (!(await runner.applyHmr(b.boundary, b.acceptedPath))) return { type: 'full-reload' };
                allBoundaries.push(b.boundary);
            }
            // any hot.invalidate() during those callbacks → bubble those modules.
            for (const inv of pendingInvalidations) queue.push({ id: inv, bubble: true });
        }
        pruneOrphans();
        return { type: 'update', boundaries: allBoundaries };
    }

    /** Prune modules no longer reachable (no static/dynamic importers, not a root)
     *  after an edit rewired the graph — fires their prune + dispose callbacks. */
    function pruneOrphans(): void {
        let changed = true;
        while (changed) {
            changed = false;
            for (const [id, node] of graph) {
                if (node.importers.size > 0 || node.dynamicImporters.size > 0 || roots.has(id)) continue;
                for (const d of node.deps) graph.get(d)?.importers.delete(id);
                for (const d of node.dynamicDeps) graph.get(d)?.dynamicImporters.delete(id);
                runner.prune(id);
                graph.delete(id);
                changed = true;
            }
        }
    }

    return {
        name: options.name,
        runner,
        import: (id) => {
            roots.add(id); // an explicitly-imported module is a root (never orphaned)
            return runner.import(id);
        },
        applyEdit,
        node: (id) => graph.get(id),
    };
}
