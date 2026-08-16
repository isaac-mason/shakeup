// The native module runner (Arc A3) — evaluates modules transformed by
// moduleRunnerTransform (the `__shakeup.*` protocol) and links them at runtime.
// Transport-agnostic: `resolveId` + `fetchModule` are injected, so the same core
// runs behind makecat's MessagePort bridge (A5) or a plain in-memory graph (tests).
//
// The runner OWNS the `__shakeup` context each module receives:
//   link(spec)        → resolve + evaluate a dep, return its live namespace
//   live(getters)     → install this module's exports as lazy getters
//   exportAll(ns)     → re-export a namespace (skip default + already-defined)
//   meta              → { url, hot } — hot is the standard import.meta.hot API
//
// Circular deps work WITHOUT cycle detection here: moduleRunnerTransform emits
// `live({…})` as the FIRST statement, so a module's getters are installed before it
// `await`s any dep. A cycle re-entering a still-evaluating module gets its exports
// object with getters already in place — lazy, so values resolve once defined.

/** Resolve a specifier (as written) from an importer to a module id, or mark it
 *  external (native-imported, not evaluated through the graph). */
export type ResolveId = (
    spec: string,
    importer: string | null,
) => string | { external: string } | Promise<string | { external: string }>;

export type RunnerOptions = {
    resolveId: ResolveId;
    /** transformed (`__shakeup.*`) source for a module id. */
    fetchModule: (id: string) => string | Promise<string>;
    /** import.meta.url for a module (browser: SW URL; node: file://). */
    metaUrl?: (id: string) => string;
    /** import.meta.env — the realm's runtime env object (makecat sets this per realm
     *  at boot rather than compile-time replacing). Defaults to `{}` so
     *  `import.meta.env.X` never throws. */
    env?: Record<string, unknown>;
    /** native import for external specifiers (default: dynamic `import`). A browser
     *  host injects one that rejects `node:` builtins (a composition leak). */
    nativeImport?: (spec: string) => Promise<unknown>;
    /** run once before the first module body evaluates (browser: install the
     *  `process` shim engine deps read). Matches makecat's RunnerHost.prepare. */
    prepare?: () => void;
    /** called when a module runs `import.meta.hot.invalidate()` — the owner (an
     *  Environment) re-propagates from that module, bubbling to its importers. When
     *  absent, invalidate() falls back to dropping the module's cached instance. */
    onInvalidate?: (id: string) => void;
};

/** The standard import.meta.hot surface (Vite-compatible shape). */
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
     *  changed value across the update. */
    acceptExports: { names: string[]; cb: (mod: unknown) => void }[];
    disposeCallbacks: ((data: Record<string, unknown>) => void)[];
    /** prune(cb): fired when the module is removed from the graph (orphaned). */
    pruneCallbacks: ((data: Record<string, unknown>) => void)[];
    /** import.meta.hot.data — persists across hot updates. */
    hotData: Record<string, unknown>;
};

type ShakeupContext = {
    link: (spec: string) => Promise<Namespace>;
    live: (getters: Record<string, () => unknown>) => void;
    exportAll: (ns: Namespace) => void;
    meta: { url: string; hot: HotContext; env: Record<string, unknown> };
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
};

// AsyncFunction constructor — modules are `async (__shakeup) => { <body> }`.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    arg: string,
    body: string,
) => (ctx: ShakeupContext) => Promise<void>;

export function createRunner(options: RunnerOptions): Runner {
    const modules = new Map<string, ModuleRecord>();
    const compiled = new Map<string, (ctx: ShakeupContext) => Promise<void>>();
    const evaluating = new Set<string>(); // ids currently on the evaluation stack
    const nativeImport = options.nativeImport ?? ((spec: string) => import(/* @vite-ignore */ spec));

    let prepared = false;
    const ensurePrepared = (): void => {
        if (prepared) return;
        prepared = true;
        options.prepare?.();
    };

    const compile = (id: string, code: string): ((ctx: ShakeupContext) => Promise<void>) => {
        let fn = compiled.get(id);
        if (fn === undefined) {
            fn = new AsyncFunction('__shakeup', code);
            compiled.set(id, fn);
        }
        return fn;
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
        on() {},
        off() {},
        send() {},
    });

    const makeContext = (rec: ModuleRecord): ShakeupContext => ({
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
            url: options.metaUrl?.(rec.id) ?? `file:///${rec.id.replace(/^\/+/, '')}`,
            hot: makeHot(rec),
            env: options.env ?? {},
        },
    });

    async function linkFrom(importer: string, spec: string): Promise<Namespace> {
        const resolved = await options.resolveId(spec, importer);
        if (typeof resolved !== 'string') return (await nativeImport(resolved.external)) as Namespace;
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
            hotData: {},
        };
        modules.set(id, rec);
        evaluating.add(id);
        const code = await options.fetchModule(id);
        ensurePrepared();
        try {
            await compile(id, code)(makeContext(rec));
        } catch (err) {
            // Don't cache a half-evaluated module — a retry (or fixed edit) must
            // re-evaluate from scratch, not return the broken partial exports.
            modules.delete(id);
            compiled.delete(id);
            throw err;
        } finally {
            evaluating.delete(id);
            resolveReady();
        }
        return rec.exports;
    }

    function invalidate(id: string): void {
        modules.delete(id);
        compiled.delete(id);
    }

    /** Remove an orphaned module: run its prune + dispose callbacks, drop it. */
    function prune(id: string): void {
        const rec = modules.get(id);
        if (rec === undefined) return;
        for (const cb of rec.pruneCallbacks) cb(rec.hotData);
        for (const cb of rec.disposeCallbacks) cb(rec.hotData);
        modules.delete(id);
        compiled.delete(id);
    }

    /** Re-evaluate a module fresh (new exports object, hot.data preserved). Disposes
     *  the old instance first (Vite order), then evaluates the new one; on failure it
     *  RESTORES the old instance so a throwing edit leaves the environment on the
     *  last-good version rather than a broken partial (#3). */
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
            hotData: old?.hotData ?? {},
        };
        compiled.delete(id);
        const code = await options.fetchModule(id);
        ensurePrepared();
        modules.set(id, fresh); // register before eval so self-refs resolve
        try {
            await compile(id, code)(makeContext(fresh));
        } catch (err) {
            if (old !== undefined) modules.set(id, old);
            else modules.delete(id);
            compiled.delete(id);
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

    return { import: loadModule, applyUpdate, applyHmr, invalidate, prune };
}
