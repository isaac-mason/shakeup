import type { SourceMap } from './sourcemap.ts';

/** Resolve a specifier (as written) from an importer to a module id, or mark it
 *  external (native-imported, not evaluated through the graph). */
export type ResolveId = (
    spec: string,
    importer: string | null,
) => string | { external: string } | Promise<string | { external: string }>;

/** transformed source for a module — code, plus an optional source map (SMv3)
 *  back to the original, which the evaluator attaches so stack traces map to source. */
export type FetchedModule = string | { code: string; map?: SourceMap };

export type RunnerOptions = {
    resolveId: ResolveId;
    /** transformed (`__shakeup.*`) source for a module id (code, or {code, map}). */
    fetchModule: (id: string) => FetchedModule | Promise<FetchedModule>;
    /** build a module's import.meta base (url + filename); the runner adds `.hot` +
     *  `.env`. */
    createImportMeta?: (id: string) => ImportMetaInit | Promise<ImportMetaInit>;
    /** import.meta.env — the realm's runtime env object. Defaults to `{}` so
     *  `import.meta.env.X` never throws. */
    env?: Record<string, unknown>;
    /** how modules are evaluated + externals imported (default: AsyncFunction +
     *  dynamic import). Swap for CSP-safe eval, node `vm`, edge runtimes, or a
     *  `node:`-rejecting external policy (browser). */
    evaluator?: ModuleEvaluator;
    /** run once before the first module body evaluates (browser: install the
     *  `process` shim engine deps read). */
    prepare?: () => void;
    /** called when a module runs `import.meta.hot.invalidate()` — the owner (an
     *  Environment) re-propagates from that module, bubbling to its importers. When
     *  absent, invalidate() falls back to dropping the module's cached instance. */
    onInvalidate?: (id: string) => void;
    /** outbound custom HMR events: a module's `import.meta.hot.send(event, data)`
     *  lands here (the host forwards to the server / other realms). */
    onHotSend?: (event: string, data: unknown) => void;
};

/** The standard import.meta.hot surface. */
export type HotContext = {
    data: Record<string, unknown>;
    accept(): void;
    accept(cb: (mod: unknown) => void): void;
    accept(dep: string, cb: (mod: unknown) => void): void;
    accept(deps: readonly string[], cb: (mods: unknown[]) => void): void;
    acceptExports(names: readonly string[], cb: (mod: unknown) => void): void;
    dispose(cb: (data: Record<string, unknown>) => void): void;
    invalidate(message?: string): void;
    prune(cb: (data: Record<string, unknown>) => void): void;
    on(event: string, cb: (...args: unknown[]) => void): void;
    off(event: string, cb: (...args: unknown[]) => void): void;
    send(event: string, data?: unknown): void;
};

type Namespace = Record<string, unknown>;

type ModuleRecord = {
    id: string;
    exports: Namespace;
    /** resolves when this module has finished evaluating (shared across cycle re-entry). */
    ready: Promise<void>;
    /** self-accept callbacks (run when THIS module re-evaluates). */
    acceptCallbacks: ((mod: unknown) => void)[];
    /** dep-accept: fire when a listed dep updates. `single` = `accept(dep, cb)` (cb
     *  gets the one module) vs `accept([deps], cb)` (cb gets the array). */
    depAccepts: { deps: string[]; single: boolean; cb: (mods: unknown) => void }[];
    /** acceptExports(names, cb): a self-accept that fires only when a named export
     *  changed value across the update. We treat it as a self-accept boundary that
     *  fires cb on a named-value change (value-identity comparison is unreliable for
     *  functions/objects, which always "change" on re-eval). */
    acceptExports: { names: string[]; cb: (mod: unknown) => void }[];
    disposeCallbacks: ((data: Record<string, unknown>) => void)[];
    /** prune(cb): fired when the module is removed from the graph (orphaned). */
    pruneCallbacks: ((data: Record<string, unknown>) => void)[];
    /** hot.on(event, cb) listeners; cleared on re-eval (fresh record). */
    eventHandlers: Map<string, Set<(data: unknown) => void>>;
    /** import.meta.hot.data — persists across hot updates. */
    hotData: Record<string, unknown>;
};

/** The `__shakeup` context object injected into every module body. A custom
 *  evaluator receives this and evaluates the module code with it. */
export type ModuleContext = {
    link: (spec: string) => Promise<Namespace>;
    live: (getters: Record<string, () => unknown>) => void;
    exportAll: (ns: Namespace) => void;
    meta: { url: string; filename: string; hot: HotContext; env: Record<string, unknown> };
};

/** A module's import.meta base (url + filename); the runner merges `.hot` + `.env`
 *  itself. */
export type ImportMetaInit = { url?: string; filename?: string };

/** How module bodies are evaluated + how externals are imported — swappable for
 *  CSP-safe eval, node `vm`, or edge runtimes. */
export type ModuleEvaluator = {
    /** number of wrapper lines prepended before the module body — for sourcemap
     *  line alignment of runtime stack traces. */
    startOffset?: number;
    /** evaluate a transformed module body with its `__shakeup` context. `map` (if
     *  given) is attached — shifted down by `startOffset` — so stack traces map to
     *  source. */
    runModule(ctx: ModuleContext, code: string, map?: SourceMap): Promise<void>;
    /** native-import an external specifier (browser: reject `node:`). */
    runExternalModule(spec: string): Promise<unknown>;
};

export type Runner = {
    /** evaluate a module by id and return its live namespace. */
    import(id: string): Promise<Namespace>;
    /** self-accept convenience: re-evaluate a module and run its own accept
     *  callbacks. Returns false if it didn't self-accept (caller full-reloads). */
    applyUpdate(id: string): Promise<boolean>;
    /** apply one HMR boundary: `boundary` accepts the changed `acceptedPath`
     *  (equal for a self-accept). Fires the boundary's matching accept callback. */
    applyHmr(boundary: string, acceptedPath: string): Promise<boolean>;
    /** drop a module's cached instance (next import re-evaluates it). */
    invalidate(id: string): void;
    /** remove an orphaned module: run its prune + dispose callbacks, then drop it. */
    prune(id: string): void;
    /** deliver an inbound custom HMR event to every module's `hot.on(event)` listeners
     *  (the host calls this on a server → realm push). */
    emit(event: string, data?: unknown): void;
};

// modules are `async (__shakeup) => { <body> }`.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    arg: string,
    body: string,
) => (ctx: ModuleContext) => Promise<void>;

/** Append a `//# sourceMappingURL` data-URL to `code`, shifting the map down by
 *  `startOffset` lines (the `new Function` wrapper prefix) so runtime stack traces
 *  in the eval'd code map back to source. `;` per line is SMv3's line separator. */
function attachSourceMap(code: string, map: SourceMap, startOffset: number): string {
    const shifted = { ...map, mappings: ';'.repeat(startOffset) + map.mappings };
    // btoa isn't in scope in every runtime; encode via a portable base64.
    const json = JSON.stringify(shifted);
    let b64: string;
    if (typeof Buffer !== 'undefined') {
        b64 = Buffer.from(json, 'utf8').toString('base64');
    } else {
        let bin = '';
        for (const byte of new TextEncoder().encode(json)) bin += String.fromCharCode(byte);
        b64 = btoa(bin);
    }
    return `${code}\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${b64}`;
}

/** Default evaluator: `new AsyncFunction` for module bodies, dynamic `import` for
 *  externals. `new Function` wraps the body ~2 lines down (V8). */
export const defaultEvaluator: ModuleEvaluator = {
    startOffset: 2,
    runModule: (ctx, code, map) => {
        const src = map !== undefined ? attachSourceMap(code, map, defaultEvaluator.startOffset ?? 0) : code;
        return new AsyncFunction('__shakeup', src)(ctx);
    },
    runExternalModule: (spec) => import(/* @vite-ignore */ spec),
};

export function createRunner(options: RunnerOptions): Runner {
    const modules = new Map<string, ModuleRecord>();
    const evaluating = new Set<string>(); // ids currently on the evaluation stack
    const evaluator = options.evaluator ?? defaultEvaluator;

    let prepared = false;
    const ensurePrepared = (): void => {
        if (prepared) return;
        prepared = true;
        options.prepare?.();
    };

    const makeHot = (rec: ModuleRecord): HotContext => ({
        data: rec.hotData,
        accept(depsOrCb?: string | readonly string[] | ((mod: unknown) => void), cb?: (mods: unknown[]) => void) {
            if (depsOrCb === undefined || typeof depsOrCb === 'function') {
                // self-accept: accept() / accept(cb)
                rec.acceptCallbacks.push((depsOrCb as (mod: unknown) => void) ?? (() => {}));
            } else {
                // dep-accept: accept(dep, cb) → cb(mod); accept([deps], cb) → cb([mods]).
                const single = !Array.isArray(depsOrCb);
                const deps = single ? [depsOrCb as string] : [...(depsOrCb as readonly string[])];
                rec.depAccepts.push({ deps, single, cb: (cb ?? (() => {})) as (mods: unknown) => void });
            }
        },
        acceptExports(names, cb) {
            rec.acceptExports.push({ names: [...names], cb: cb ?? (() => {}) });
        },
        dispose(cb) {
            rec.disposeCallbacks.push(cb);
        },
        invalidate() {
            if (options.onInvalidate !== undefined) options.onInvalidate(rec.id);
            else invalidate(rec.id);
        },
        prune(cb) {
            rec.pruneCallbacks.push(cb);
        },
        on(event, cb) {
            let set = rec.eventHandlers.get(event);
            if (set === undefined) {
                set = new Set();
                rec.eventHandlers.set(event, set);
            }
            set.add(cb as (data: unknown) => void);
        },
        off(event, cb) {
            rec.eventHandlers.get(event)?.delete(cb as (data: unknown) => void);
        },
        send(event, data) {
            options.onHotSend?.(event, data);
        },
    });

    const makeContext = async (rec: ModuleRecord): Promise<ModuleContext> => {
        const im = await options.createImportMeta?.(rec.id);
        return {
            link: (spec) => linkFrom(rec.id, spec),
            live: (getters) => {
                for (const k of Object.keys(getters)) {
                    Object.defineProperty(rec.exports, k, { get: getters[k], enumerable: true, configurable: true });
                }
            },
            exportAll: (ns) => {
                for (const k of Object.keys(ns)) {
                    if (k !== 'default' && !(k in rec.exports)) {
                        Object.defineProperty(rec.exports, k, { get: () => ns[k], enumerable: true, configurable: true });
                    }
                }
            },
            meta: {
                url: im?.url ?? `file:///${rec.id.replace(/^\/+/, '')}`,
                filename: im?.filename ?? rec.id,
                hot: makeHot(rec),
                env: options.env ?? {},
            },
        };
    };

    async function linkFrom(importer: string, spec: string): Promise<Namespace> {
        const resolved = await options.resolveId(spec, importer);
        if (typeof resolved !== 'string') return (await evaluator.runExternalModule(resolved.external)) as Namespace;
        return loadModule(resolved);
    }

    async function loadModule(id: string): Promise<Namespace> {
        const existing = modules.get(id);
        if (existing !== undefined) {
            // A cycle re-enters a module still on the eval stack: return its partial
            // exports (getters already installed via the hoisted `live` call). A
            // concurrent/finished load: await full evaluation first.
            if (!evaluating.has(id)) await existing.ready;
            return existing.exports;
        }
        let resolveReady!: () => void;
        const rec: ModuleRecord = {
            id,
            exports: {},
            ready: new Promise<void>((r) => {
                resolveReady = r;
            }),
            acceptCallbacks: [],
            depAccepts: [],
            acceptExports: [],
            disposeCallbacks: [],
            pruneCallbacks: [],
            eventHandlers: new Map(),
            hotData: {},
        };
        modules.set(id, rec);
        evaluating.add(id);
        const fetched = await options.fetchModule(id);
        const code = typeof fetched === 'string' ? fetched : fetched.code;
        const map = typeof fetched === 'string' ? undefined : fetched.map;
        ensurePrepared();
        try {
            await evaluator.runModule(await makeContext(rec), code, map);
        } catch (err) {
            // Don't cache a half-evaluated module — a retry (or fixed edit) must
            // re-evaluate from scratch, not return the broken partial exports.
            modules.delete(id);
            throw err;
        } finally {
            evaluating.delete(id);
            resolveReady();
        }
        return rec.exports;
    }

    function invalidate(id: string): void {
        modules.delete(id);
    }

    /** Remove an orphaned module: run its prune + dispose callbacks, drop it. */
    function prune(id: string): void {
        const rec = modules.get(id);
        if (rec === undefined) return;
        for (const cb of rec.pruneCallbacks) cb(rec.hotData);
        for (const cb of rec.disposeCallbacks) cb(rec.hotData);
        modules.delete(id);
    }

    /** Re-evaluate a module fresh (new exports object, hot.data preserved). Disposes
     *  the old instance first, then evaluates the new one; on failure it RESTORES the
     *  old instance so a throwing edit leaves the environment on the last-good version
     *  rather than a broken partial. */
    async function reeval(id: string): Promise<Namespace> {
        const old = modules.get(id);
        if (old !== undefined) for (const cb of old.disposeCallbacks) cb(old.hotData);
        const fresh: ModuleRecord = {
            id,
            exports: {},
            ready: Promise.resolve(),
            acceptCallbacks: [],
            depAccepts: [],
            acceptExports: [],
            disposeCallbacks: [],
            pruneCallbacks: [],
            eventHandlers: new Map(),
            hotData: old?.hotData ?? {},
        };
        const fetched = await options.fetchModule(id);
        const code = typeof fetched === 'string' ? fetched : fetched.code;
        const map = typeof fetched === 'string' ? undefined : fetched.map;
        ensurePrepared();
        modules.set(id, fresh); // register before eval so self-refs resolve
        try {
            await evaluator.runModule(await makeContext(fresh), code, map);
        } catch (err) {
            if (old !== undefined) modules.set(id, old);
            else modules.delete(id);
            throw err;
        }
        return fresh.exports;
    }

    /** Apply one HMR boundary update. `boundary` is the accepting module; `acceptedPath`
     *  is the changed module it accepts (== boundary for a self-accept). Returns false
     *  when nothing handled it (caller full-reloads). */
    async function applyHmr(boundary: string, acceptedPath: string): Promise<boolean> {
        const rec = modules.get(boundary);
        if (rec === undefined) return false;
        if (boundary === acceptedPath) {
            // self-accept: run the OLD instance's accept callbacks with the NEW exports.
            const accepts = rec.acceptCallbacks;
            const exportAccepts = rec.acceptExports;
            if (accepts.length === 0 && exportAccepts.length === 0) return false;
            // snapshot the old named-export values for acceptExports comparison.
            const oldVals = exportAccepts.map((ea) => ea.names.map((n) => rec.exports[n]));
            const ns = await reeval(boundary);
            for (const cb of accepts) cb(ns);
            exportAccepts.forEach((ea, i) => {
                if (ea.names.some((n, j) => ns[n] !== oldVals[i][j])) ea.cb(ns);
            });
            return true;
        }
        // dep-accept: re-evaluate the changed dep, fire the boundary's accept callback
        // for it (the boundary itself is NOT re-evaluated — it handles the dep manually).
        const depAccepts = rec.depAccepts;
        const freshDep = await reeval(acceptedPath);
        let fired = false;
        for (const da of depAccepts) {
            const mods: Namespace[] = [];
            let matches = false;
            for (const spec of da.deps) {
                const r = await options.resolveId(spec, boundary);
                const depId = typeof r === 'string' ? r : null;
                if (depId === acceptedPath) matches = true;
                mods.push(depId === acceptedPath ? freshDep : depId ? (modules.get(depId)?.exports ?? {}) : {});
            }
            if (!matches) continue;
            da.cb(da.single ? freshDep : mods);
            fired = true;
        }
        return fired;
    }

    /** self-accept convenience: `applyHmr(id, id)`. */
    const applyUpdate = (id: string): Promise<boolean> => applyHmr(id, id);

    function emit(event: string, data?: unknown): void {
        for (const rec of modules.values()) {
            const set = rec.eventHandlers.get(event);
            if (set !== undefined) for (const cb of set) cb(data);
        }
    }

    return { import: loadModule, applyUpdate, applyHmr, invalidate, prune, emit };
}
