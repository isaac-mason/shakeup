import type { Semantic } from './analysis/semantic';
import type { Program } from './ast';
import type { Fs, MaybePromise } from './fs';
import { applyEdits, type Edit } from './patches';
import type { SourceMap } from './sourcemap';

/** false = no side effects (droppable if unused); true = default liveness;
 *  'no-treeshake' = keep every statement + always include the module. */
export type ModuleSideEffects = boolean | 'no-treeshake';

/** We only ACT on js/jsx/ts/tsx + json (via the json plugin's own load);
 *  others accepted + ignored. */
export type ModuleType =
    | 'js'
    | 'jsx'
    | 'ts'
    | 'tsx'
    | 'json'
    | 'text'
    | 'base64'
    | 'dataurl'
    | 'binary'
    | 'empty'
    | (string & {});

/** Opaque per-module plugin scratch space, keyed by plugin name by convention. */
export type CustomPluginOptions = { [plugin: string]: unknown };

/** The mutable option bag a module carries; set/overridden across the
 *  resolveId→load→transform chain. */
export type ModuleOptions = {
    moduleSideEffects: ModuleSideEffects | null;
    meta: CustomPluginOptions;
    moduleType?: ModuleType;
};

export type PartialResolvedId = {
    id: string;
    /** true|'absolute' → external, kept verbatim/absolute in output;
     *  'relative' → external but re-normalized as a relative id;
     *  false/undefined → internal. */
    external?: boolean | 'absolute' | 'relative';
    moduleSideEffects?: ModuleSideEffects | null;
    meta?: CustomPluginOptions;
    moduleType?: ModuleType;
};

export type SourceDescription = {
    code: string;
    map?: SourceMap | string | null; // map accepted, not yet consumed
    moduleSideEffects?: ModuleSideEffects | null;
    meta?: CustomPluginOptions;
    moduleType?: ModuleType;
};

/** code omitted = keep running code, still apply option overrides.
 *  Edit[] is our patch-form extension. */
export type TransformDescription = {
    code?: string | Edit[];
    map?: SourceMap | string | null; // map accepted, not yet consumed
    moduleSideEffects?: ModuleSideEffects | null;
    meta?: CustomPluginOptions;
    moduleType?: ModuleType;
};

/** resolveId: string = resolved id, false = external, null/undefined = pass,
 *  object = a {@link PartialResolvedId}. */
export type ResolveIdResult = string | false | null | undefined | PartialResolvedId;
/** load: string = source, null/undefined = pass, object = a {@link SourceDescription}. */
export type LoadResult = string | null | undefined | SourceDescription;
// PLUGIN HOOKS FOLLOW ROLLUP'S CALLING CONVENTION: the context is `this`, not a leading parameter.
//
// This used to be `(ctx, code, id)`. Every Rollup and Vite plugin in existence is written as
// `transform(code, id)` with `this.resolve(...)`, so the divergence meant a real plugin received the
// CONTEXT where it expected its first argument, and `this` was not the context at all. `pnpm
// rollupsuite` reported it as a wall of `code.replace is not a function` / `this.resolve is not a
// function` / `this.load is not a function` across 19 samples. Aligning took the suite from
// 427/591 to 444/591.
//
// Note for anyone changing a hook signature again: TypeScript CANNOT catch this. Hook parameters are
// positional and usually untyped in plugin literals, so `(_ctx, spec, importer)` silently re-bound to
// `(specifier, importer, extra)` and type-checked clean while behaving wrongly at runtime — four test
// files passed the compiler and failed at execution. Grep, do not trust `tsc`.

/** One entry in the `generateBundle` bundle object — a rendered chunk or an emitted asset. Kept
 *  loose (`Record<string, unknown>` tail) because plugins both read rollup-specific fields we do not
 *  model and write arbitrary ones back. */
export type GenerateBundleEntry = { type: 'chunk' | 'asset'; fileName: string } & Record<string, unknown>;

/** transform: string = replace source, Edit[] = patch it, null/undefined = pass,
 *  object = a {@link TransformDescription}. */
export type TransformResult = string | Edit[] | null | undefined | TransformDescription;

export type ImportKind = 'import-statement' | 'dynamic-import' | 'require-call' | 'hot-accept' | 'entry';
export type ResolveIdExtra = {
    isEntry: boolean;
    kind: ImportKind;
    custom?: CustomPluginOptions;
};

export type ModuleInfo = {
    id: string;
    code: string | null; // null for external / not-yet-loaded
    isEntry: boolean;
    isExternal: boolean;
    moduleSideEffects: ModuleSideEffects;
    meta: CustomPluginOptions;
    moduleType: ModuleType;
    importedIds: string[]; // static deps, resolved
    dynamicallyImportedIds: string[];
    importers: string[]; // computed by reverse-scan of the graph
    dynamicImporters: string[];
    exports: string[]; // own named-export keys
    /** Whether the module has a default export. `null` while the module is still LOADING — rollup
     *  reports null there because nothing has been parsed yet, and its fixtures assert exactly that
     *  from inside a `load`/`transform` hook. */
    hasDefaultExport: boolean | null;
};

/** A file a plugin asks the bundler to emit alongside the output chunks. `source` is the contents;
 *  give `name` for a content-hashed fileName (`assets/<stem>-<hash><ext>`), or `fileName` to force
 *  an exact one. Only assets today; emitted chunks are a later addition. */
export type EmittedAsset = {
    type: 'asset';
    name?: string;
    fileName?: string;
    source: string | Uint8Array;
};
export type EmittedFile = EmittedAsset;

/** Context passed to every plugin hook. Every method returns {@link MaybePromise}
 *  so the sync fast path holds (`assertSync` unwraps in bundle mode). */
export type PluginCtx = {
    warn(message: string): void;
    error(message: string): never;
    info(message: string): void;
    debug(message: string): void;
    fs: Fs;
    /** Re-run the resolveId pipeline + default resolver. skipSelf defaults true →
     *  no infinite recursion. */
    resolve(
        source: string,
        importer?: string | null,
        options?: { isEntry?: boolean; kind?: ImportKind; skipSelf?: boolean; custom?: CustomPluginOptions },
    ): MaybePromise<PartialResolvedId | null>;
    /** Emit a file alongside the output; returns its final (content-hashed) fileName, which a
     *  plugin embeds in code (e.g. a `?url` import's default export). In bundle mode the file lands
     *  in {@link BundleResult.assets}; the dev server has no output sink, so its assets resolve via a
     *  host `url()` strategy and calling emitFile there throws. */
    emitFile(file: EmittedFile): string;
    /**
     * `this.load({ id })` — bring a module into the graph (resolve -> load -> transform -> parse) and
     * return its info. rollup's mechanism for a plugin that needs to INSPECT a module it does not
     * own: reading its exports to decide a rewrite, or forcing a dependency in.
     *
     * Idempotent: `addModule` returns the existing index rather than re-loading.
     */
    load(options: { id: string } & Record<string, unknown>): MaybePromise<ModuleInfo | null>;
    /** Backed by the live graph. A module that is still LOADING reports partial info (rollup does the
     *  same) rather than null — its own `load`/`transform` hooks can ask about it. */
    getModuleInfo(id: string): ModuleInfo | null;
    /** All module ids currently in the graph. */
    getModuleIds(): IterableIterator<string>;
};

/** Id filter for a hook; non-matching ids skip the handler entirely. */
export type HookFilter = { id?: RegExp | RegExp[] };
/** A hook given as a bare function or as `{ filter, handler }`. */
export type WithFilter<F> = F | { filter?: HookFilter; handler: F };

/** Info handed to the `moduleParsed` hook after a module is parsed and analyzed. */
export type ModuleParsedInfo = {
    id: string;
    source: string;
    program: Program;
    nodeCount: number;
    semantic: Semantic;
    moduleSideEffects: ModuleSideEffects;
    meta: CustomPluginOptions;
    moduleType: ModuleType;
};

/** A value or a promise of it. Hooks may be sync or async; the drivers below stay
 *  fully synchronous when no hook returns a thenable. */

const isThenable = (x: unknown): x is Promise<unknown> =>
    x !== null && typeof x === 'object' && typeof (x as { then?: unknown }).then === 'function';

/** Unwrap a driver result in a synchronous context (bundle mode requires sync
 *  plugins). Throws if a hook went async — a clear error, not a silent hang. */
export function assertSync<T>(x: MaybePromise<T>): T {
    if (isThenable(x)) throw new Error('async plugin hook is not supported in this (synchronous) build context');
    return x as T;
}

/** A plugin: a name plus any of the build hooks. Every hook may return a promise;
 *  the dev server awaits, bundle mode requires sync. */
export type Plugin = {
    name: string;
    buildStart?: (this: PluginCtx) => MaybePromise<void>;
    resolveId?: WithFilter<
        (this: PluginCtx, specifier: string, importer: string | null, extra: ResolveIdExtra) => MaybePromise<ResolveIdResult>
    >;
    load?: WithFilter<(this: PluginCtx, id: string) => MaybePromise<LoadResult>>;
    transform?: WithFilter<(this: PluginCtx, code: string, id: string) => MaybePromise<TransformResult>>;
    moduleParsed?: (this: PluginCtx, info: ModuleParsedInfo) => MaybePromise<void>;
    /** Return the rewritten code, or rollup's `{ code, map }` object form. A returned `map` is NOT
     *  composed — the chunk's own map is dropped with a warning, same as for a string return. */
    renderChunk?: (this: PluginCtx, code: string) => string | { code: string; map?: unknown } | null | undefined;
    buildEnd?: (this: PluginCtx) => MaybePromise<void>;
    /**
     * `generateBundle(options, bundle, isWrite)` — the last chance to inspect or MUTATE the output.
     *
     * `bundle` is keyed by fileName, values tagged `type: 'chunk' | 'asset'`, exactly as rollup shapes
     * it. Plugins add entries (emitting a file), delete them (suppressing one) and rewrite `code` in
     * place, so the caller must read the object BACK after every hook rather than trusting the arrays
     * it passed in. 19 of rollup's own function samples use this hook.
     */
    generateBundle?: (
        this: PluginCtx,
        options: Record<string, unknown>,
        bundle: Record<string, GenerateBundleEntry>,
        isWrite: boolean,
    ) => MaybePromise<void>;
};

type Compiled<F> = { plugin: string; matches: ((id: string) => boolean) | null; handler: F };

/** Plugins flattened into dense per-hook arrays so hot loops skip feature tests. */
export type Pipeline = {
    buildStart: Compiled<NonNullable<Plugin['buildStart']>>[];
    resolveId: Compiled<Extract<NonNullable<Plugin['resolveId']>, (...a: never[]) => unknown>>[];
    load: Compiled<Extract<NonNullable<Plugin['load']>, (...a: never[]) => unknown>>[];
    transform: Compiled<Extract<NonNullable<Plugin['transform']>, (...a: never[]) => unknown>>[];
    moduleParsed: Compiled<NonNullable<Plugin['moduleParsed']>>[];
    renderChunk: Compiled<NonNullable<Plugin['renderChunk']>>[];
    buildEnd: Compiled<NonNullable<Plugin['buildEnd']>>[];
    generateBundle: Compiled<NonNullable<Plugin['generateBundle']>>[];
};

function compileMatcher(filter: HookFilter | undefined): ((id: string) => boolean) | null {
    if (filter?.id === undefined) return null;
    const patterns = Array.isArray(filter.id) ? filter.id : [filter.id];
    return (id: string) => patterns.some((p) => p.test(id));
}

function normalize<F>(plugin: string, hook: WithFilter<F> | undefined | null): Compiled<F> | null {
    // `null` as well as `undefined`: rollup treats an explicitly-null hook as absent, and plugins
    // written as `{ transform: cond ? fn : null }` are common. It used to reach `compileMatcher`
    // through the object branch and crash the whole build with `Cannot read properties of null`.
    if (hook === undefined || hook === null) return null;
    if (typeof hook === 'function') return { plugin, matches: null, handler: hook as F };
    const h = hook as { filter?: HookFilter; handler: F };
    return { plugin, matches: compileMatcher(h.filter), handler: h.handler };
}

/** Flatten a plugin list into a {@link Pipeline}, compiling each hook's id filter. */
export function compilePipeline(plugins: readonly Plugin[]): Pipeline {
    const pipeline: Pipeline = {
        buildStart: [],
        resolveId: [],
        load: [],
        transform: [],
        generateBundle: [],
        moduleParsed: [],
        renderChunk: [],
        buildEnd: [],
    };
    for (const p of plugins) {
        const bs = normalize(p.name, p.buildStart);
        if (bs !== null) pipeline.buildStart.push(bs);
        const ri = normalize(p.name, p.resolveId);
        if (ri !== null) pipeline.resolveId.push(ri as Pipeline['resolveId'][number]);
        const ld = normalize(p.name, p.load);
        if (ld !== null) pipeline.load.push(ld as Pipeline['load'][number]);
        const tr = normalize(p.name, p.transform);
        if (tr !== null) pipeline.transform.push(tr as Pipeline['transform'][number]);
        const mp = normalize(p.name, p.moduleParsed);
        if (mp !== null) pipeline.moduleParsed.push(mp);
        const rc = normalize(p.name, p.renderChunk);
        if (rc !== null) pipeline.renderChunk.push(rc);
        const be = normalize(p.name, p.buildEnd);
        if (be !== null) pipeline.buildEnd.push(be);
        const gb = normalize(p.name, p.generateBundle);
        if (gb !== null) pipeline.generateBundle.push(gb);
    }
    return pipeline;
}

/** Default `extra` for resolveId callers that don't supply one (dev server, tests). */
const DEFAULT_RESOLVE_EXTRA: ResolveIdExtra = { isEntry: false, kind: 'import-statement' };

/** first-wins resolveId. Returns the RAW hook value (object / string / false) —
 *  normalization happens at the call site so the driver stays shape-agnostic.
 *  Stays synchronous unless a hook returns a promise, then resumes the loop after
 *  it settles. */
export function runResolveId(
    pipeline: Pipeline,
    ctx: PluginCtx,
    specifier: string,
    importer: string | null,
    extra: ResolveIdExtra = DEFAULT_RESOLVE_EXTRA,
): MaybePromise<ResolveIdResult> {
    const hooks = pipeline.resolveId;
    let i = 0;
    const step = (): MaybePromise<ResolveIdResult> => {
        while (i < hooks.length) {
            const hook = hooks[i++];
            if (hook.matches !== null && !hook.matches(specifier)) continue;
            const r = hook.handler.call(ctx, specifier, importer, extra);
            if (isThenable(r)) return r.then((v) => (v !== null && v !== undefined ? (v as ResolveIdResult) : step()));
            if (r !== null && r !== undefined) return r;
        }
        return null;
    };
    return step();
}

/** first-wins load. Returns the RAW hook value (string / SourceDescription);
 *  the call site takes `.code`. */
export function runLoad(pipeline: Pipeline, ctx: PluginCtx, id: string): MaybePromise<LoadResult> {
    const hooks = pipeline.load;
    let i = 0;
    const step = (): MaybePromise<LoadResult> => {
        while (i < hooks.length) {
            const hook = hooks[i++];
            if (hook.matches !== null && !hook.matches(id)) continue;
            const r = hook.handler.call(ctx, id);
            if (isThenable(r)) return r.then((v) => (v !== null && v !== undefined ? (v as LoadResult) : step()));
            if (r !== null && r !== undefined) return r;
        }
        return null;
    };
    return step();
}

/** The accumulator a {@link runTransform} chain threads and returns: the running
 *  code plus the merged option overrides. `moduleSideEffects`/`moduleType` are
 *  null/undefined until a hook sets them; `meta` is shallow-merged across the chain. */
export type TransformAccumulator = {
    code: string;
    moduleSideEffects: ModuleSideEffects | null;
    meta: CustomPluginOptions;
    moduleType: ModuleType | undefined;
};

/** sequential transform chain. Threads the running code AND merges each hook's
 *  option overrides. `Edit[]` / string `code` patch the running code; the
 *  accumulator adds option merging. Returns the accumulator (read `.code`). */
export function runTransform(pipeline: Pipeline, ctx: PluginCtx, code: string, id: string): MaybePromise<TransformAccumulator> {
    const hooks = pipeline.transform;
    const acc: TransformAccumulator = { code, moduleSideEffects: null, meta: {}, moduleType: undefined };
    let i = 0;
    const apply = (r: TransformResult): void => {
        if (r === null || r === undefined) return;
        if (typeof r === 'string') {
            acc.code = r;
            return;
        }
        if (Array.isArray(r)) {
            acc.code = applyEdits(acc.code, r);
            return;
        }
        // TransformDescription: code omitted keeps the running code; option overrides merge.
        if (r.code !== undefined) acc.code = typeof r.code === 'string' ? r.code : applyEdits(acc.code, r.code);
        if (r.moduleSideEffects !== undefined && r.moduleSideEffects !== null) acc.moduleSideEffects = r.moduleSideEffects;
        if (r.meta !== undefined) Object.assign(acc.meta, r.meta);
        if (r.moduleType !== undefined) acc.moduleType = r.moduleType;
    };
    const step = (): MaybePromise<TransformAccumulator> => {
        while (i < hooks.length) {
            const hook = hooks[i++];
            if (hook.matches !== null && !hook.matches(id)) continue;
            const r = hook.handler.call(ctx, acc.code, id);
            if (isThenable(r)) {
                return r.then((res) => {
                    apply(res as TransformResult);
                    return step();
                });
            }
            apply(r);
        }
        return acc;
    };
    return step();
}

/** sequential moduleParsed hooks (post-parse AST access). */
export function runModuleParsed(pipeline: Pipeline, ctx: PluginCtx, info: ModuleParsedInfo): MaybePromise<void> {
    const hooks = pipeline.moduleParsed;
    let i = 0;
    const step = (): MaybePromise<void> => {
        while (i < hooks.length) {
            const r = hooks[i++].handler.call(ctx, info);
            if (isThenable(r)) return r.then(() => step());
        }
    };
    return step();
}
