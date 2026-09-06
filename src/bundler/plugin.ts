import type { Semantic } from '../analysis/semantic.ts';
import { astToEstree } from '../ast/estree.ts';
import type { Program } from '../ast/index.ts';
import { parse } from '../parser/index.ts';
import type { SourceMap } from '../util/sourcemap.ts';
import type { Fs, MaybePromise } from './fs.ts';
import { applyEdits, type Edit } from './patches.ts';

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
 *  an exact one. */
export type EmittedAsset = {
    type: 'asset';
    name?: string;
    fileName?: string;
    /** The SOURCE file this asset came from, when there is one — an imported image, a `new URL()`
     *  target. Reported back on the output asset so a consumer can map output to input; that is the
     *  whole point of the field, and it is what a size visualiser reads. */
    originalFileName?: string;
    source: string | Uint8Array;
};

/**
 * A module a plugin asks to be bundled as an extra ENTRY.
 *
 * `id` goes through the build hooks like any entry, starting with `resolveId` — which receives
 * `isEntry: true` whether or not an `importer` was given, since the thing being resolved IS an entry
 * either way. `importer` exists only so a RELATIVE `id` resolves against the right file.
 */
export type EmittedChunk = {
    type: 'chunk';
    id: string;
    importer?: string;
    /** Feeds the `entryFileNames` pattern, like a named entry in `input`. */
    name?: string;
    /** NOT SUPPORTED — there is no forced-fileName channel for an entry yet, and silently ignoring
     *  it would put the file somewhere the plugin did not ask for. Emitting one is an error. */
    fileName?: string;
};

export type EmittedFile = EmittedAsset | EmittedChunk;

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
    /**
     * Emit a file alongside the output. Returns a REFERENCE ID, not a fileName — resolve it with
     * {@link PluginCtx.getFileName}.
     *
     * The reference id is what both oracles return (`emitFile(file): string` + `getFileName(
     * referenceId): string` in rolldown's `plugin-context.ts`, and Rollup's documented pair), and
     * shakeup used to return the fileName directly. That was not merely a different spelling: a
     * fileName cannot exist at emit time for everything that can be emitted — a chunk's name is only
     * settled once chunking and naming have run — which is exactly why the indirection exists.
     *
     * In bundle mode the file lands in {@link BundleResult.assets}; the dev server has no output
     * sink, so its assets resolve via a host `url()` strategy and calling this there throws.
     */
    emitFile(file: EmittedFile): string;
    /** The output fileName for a reference id from {@link PluginCtx.emitFile}. Throws on an unknown
     *  id rather than answering `undefined` — Rollup errors too, and a silently-undefined name gets
     *  embedded in code and fails much later. */
    getFileName(referenceId: string): string;
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
    /**
     * `this.parse(code, options)` — run shakeup's own parser and hand back an ESTree-compatible
     * `Program`. rolldown's is the same shape and the same one-liner (`plugin-context.ts:459` ->
     * `parseAst`): the bundler already has a parser, so a plugin should not have to bring one.
     *
     * Nodes carry `start`/`end` because that is what a plugin actually does with the result —
     * `magic-string` overwrites by offset, which is the shape of Rollup's own `plugin-parse` sample.
     */
    parse(code: string, options?: { sourceType?: 'module' | 'script' } | null): EstreeProgram;
};

/**
 * The shared implementation behind `PluginCtx.parse`, so the scan-time, bundle-time and dev-server
 * contexts cannot drift.
 *
 * The ESTree projection is imported DIRECTLY rather than through `../ast/index.ts`: that barrel
 * deliberately omits it, because `src/index.ts` re-exports the barrel and the projection's only
 * `@typescript-eslint/types` import is a devDependency. That import is `import type`, so node's
 * erase-only stripping removes it and nothing is resolved at runtime — `tst/node-native-entry.test.ts`
 * is what actually proves that, and it runs node as a subprocess because nothing else can.
 */
export function pluginParse(code: string, options?: { sourceType?: 'module' | 'script' } | null): EstreeProgram {
    const { program, errors } = parse(code, { ts: false, jsx: true });
    if (errors.length > 0) throw new Error(`this.parse: ${errors[0].msg}`);
    return astToEstree(program, options?.sourceType ?? 'module') as unknown as EstreeProgram;
}

/** An ESTree `Program`, as `this.parse` returns it. Deliberately loose: shakeup ships no runtime
 *  dependency, and the precise node types live in a devDependency that only the projection imports
 *  as a TYPE. A plugin walks this structurally, exactly as it would Rollup's. */
export type EstreeProgram = { type: 'Program'; body: unknown[]; sourceType: string; start: number; end: number };

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
    /** This module's own dependencies, RESOLVED to ids and not yet loaded — the state Rollup and
     *  rolldown both document for this hook, and the reason it fires between scan's two resolution
     *  passes. `[]` inside `load`/`transform`, where nothing has been resolved yet. */
    importedIds: string[];
    dynamicallyImportedIds: string[];
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
    /** Inspect or replace the build options before anything else runs. Returning an object replaces
     *  them; mutating the one handed in works too, which is how `nested-and-async-plugin` adds a
     *  plugin (`options.plugins.push(...)`). Runs before the plugin list is resolved a second time,
     *  so a plugin added here takes part in the build. Both oracles do exactly this — Rollup's
     *  `getProcessedInputOptions` and rolldown's `PluginDriver.callOptionsHook`. */
    options?: (
        this: MinimalPluginCtx,
        options: Record<string, unknown>,
    ) => MaybePromise<Record<string, unknown> | null | undefined>;
    buildStart?: (this: PluginCtx) => MaybePromise<void>;
    resolveId?: WithFilter<
        (this: PluginCtx, specifier: string, importer: string | undefined, extra: ResolveIdExtra) => MaybePromise<ResolveIdResult>
    >;
    /** Resolve a DYNAMIC import (`import('x')`). Tried before {@link Plugin.resolveId} and falling
     *  through to it when every hook declines — rolldown's `resolve_id_with_plugins` runs
     *  `plugin_driver.resolve_dynamic_import(...)` first for `ImportKind::DynamicImport` and only
     *  then the ordinary chain, and Rollup's hook is `first` with the same fallback. Same result
     *  shape as `resolveId`. rolldown declines only the variant that hands the hook an AST node for a
     *  non-literal specifier; the string form is supported and this is it. */
    resolveDynamicImport?: WithFilter<
        (this: PluginCtx, specifier: string, importer: string | undefined, extra: ResolveIdExtra) => MaybePromise<ResolveIdResult>
    >;
    load?: WithFilter<(this: PluginCtx, id: string) => MaybePromise<LoadResult>>;
    transform?: WithFilter<(this: PluginCtx, code: string, id: string) => MaybePromise<TransformResult>>;
    moduleParsed?: (this: PluginCtx, info: ModuleParsedInfo) => MaybePromise<void>;
    /** Return the rewritten code, or rollup's `{ code, map }` object form. A returned `map` is NOT
     *  composed — the chunk's own map is dropped with a warning, same as for a string return. */
    /** Rewrite an emitted chunk. Rollup documents this as ASYNC, and plugins written against it
     *  return promises — hence {@link MaybePromise}. Hooks run in order, each seeing the previous
     *  one's output. */
    renderChunk?: (this: PluginCtx, code: string) => MaybePromise<string | { code: string; map?: unknown } | null | undefined>;
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

type Compiled<F> = {
    plugin: string;
    /** The plugin's index in the user's `plugins` array — the identity `skipSelf` is keyed on. A
     *  plugin's `load` hook calling `this.resolve` must skip THAT PLUGIN's `resolveId`, so the
     *  identity has to be shared across hook kinds and cannot be a per-array position. */
    pluginIdx: number;
    matches: ((id: string) => boolean) | null;
    handler: F;
};

/**
 * One entry in the `skipSelf` set: this plugin's `resolveId` is not to run for this exact
 * (specifier, importer). rolldown's `HookResolveIdSkipped { plugin_idx, importer, specifier }`
 * (`native_plugin_context.rs:99`), and the triple matters — skipping the plugin outright would break
 * `prevent-context-resolve-loop`, where a plugin skipped for one specifier must still resolve others.
 */
export type ResolveSkip = { pluginIdx: number; importer: string | null; specifier: string };

/** Build the context a hook belonging to `pluginIdx` sees, carrying the skips in force. `null` is a
 *  caller outside any plugin (the driver itself), which skips nothing. */
export type CtxFor = (pluginIdx: number | null, skipped: readonly ResolveSkip[]) => PluginCtx;

/** Plugins flattened into dense per-hook arrays so hot loops skip feature tests. */
export type Pipeline = {
    buildStart: Compiled<NonNullable<Plugin['buildStart']>>[];
    resolveId: Compiled<Extract<NonNullable<Plugin['resolveId']>, (...a: never[]) => unknown>>[];
    resolveDynamicImport: Compiled<Extract<NonNullable<Plugin['resolveDynamicImport']>, (...a: never[]) => unknown>>[];
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

function normalize<F>(plugin: string, pluginIdx: number, hook: WithFilter<F> | undefined | null): Compiled<F> | null {
    // `null` as well as `undefined`: rollup treats an explicitly-null hook as absent, and plugins
    // written as `{ transform: cond ? fn : null }` are common. It used to reach `compileMatcher`
    // through the object branch and crash the whole build with `Cannot read properties of null`.
    if (hook === undefined || hook === null) return null;
    if (typeof hook === 'function') return { plugin, pluginIdx, matches: null, handler: hook as F };
    const h = hook as { filter?: HookFilter; handler: F };
    return { plugin, pluginIdx, matches: compileMatcher(h.filter), handler: h.handler };
}

/** Flatten a plugin list into a {@link Pipeline}, compiling each hook's id filter. */
/** The context an `options` hook gets. There is no graph yet, so it is the logging surface only —
 *  Rollup passes a cut-down context there for the same reason, and rolldown a
 *  `MinimalPluginContextImpl`. */
export type MinimalPluginCtx = {
    warn(message: string): void;
    error(message: string): never;
    info(message: string): void;
    debug(message: string): void;
};

/** A plugin as the user may write it: nested arrays, promises, and falsy holes are all legal.
 *  Rollup and rolldown share one implementation of the flattening — rolldown's
 *  `utils/async-flatten.ts` is a copy of Rollup's `utils/asyncFlatten.ts`, with the source URL in a
 *  comment — so this follows it exactly rather than approximating. */
export type PluginOption = Plugin | null | undefined | false | PluginOption[] | Promise<PluginOption>;

/** `(await asyncFlatten([plugins])).filter(Boolean)`, which is verbatim what both oracles run
 *  (`normalizePluginOption` in each). The loop re-flattens while any entry is still a thenable,
 *  because a promise may resolve TO an array of promises; `flat(Infinity)` also drops the holes a
 *  sparse array literal leaves, and `filter(Boolean)` drops `null` / `undefined` / `false`. */
export async function normalizePluginOption(plugins: PluginOption): Promise<Plugin[]> {
    let array: unknown[] = [plugins];
    do {
        array = (await Promise.all(array)).flat(Number.POSITIVE_INFINITY);
    } while (array.some((v) => (v as { then?: unknown } | null)?.then));
    return array.filter(Boolean) as Plugin[];
}

/** The synchronous half of {@link normalizePluginOption}: flatten nested arrays and drop the falsy
 *  holes, but a PROMISE cannot be awaited. For `createDevServer`, whose constructor is synchronous —
 *  it warns and drops rather than passing a thenable to `compilePipeline`, where it would have become
 *  a plugin with no hooks and no explanation. `bundle()` is async and does the full thing. */
export function normalizePluginOptionSync(plugins: PluginOption, warn: (m: string) => void): Plugin[] {
    const flat = ([plugins] as unknown[]).flat(Number.POSITIVE_INFINITY).filter(Boolean) as Plugin[];
    return flat.filter((p) => {
        if ((p as { then?: unknown }).then === undefined) return true;
        warn('a Promise-valued plugin was dropped: the dev server builds its plugin pipeline synchronously');
        return false;
    });
}

/** Run every plugin's `options` hook, in order, threading the result. A hook returning a value
 *  REPLACES the options; returning nothing leaves the (possibly mutated) object in place. The caller
 *  must re-run {@link normalizePluginOption} over the result's `plugins` afterwards — that is what
 *  lets a hook add a plugin, and it is the order both oracles use. */
export async function callOptionsHook(
    plugins: readonly Plugin[],
    options: Record<string, unknown>,
    ctx: MinimalPluginCtx,
): Promise<Record<string, unknown>> {
    let current = options;
    for (const p of plugins) {
        if (p.options === undefined) continue;
        const next = await p.options.call(ctx, current);
        if (next !== null && next !== undefined) current = next;
    }
    return current;
}

export function compilePipeline(plugins: readonly Plugin[]): Pipeline {
    const pipeline: Pipeline = {
        buildStart: [],
        resolveId: [],
        resolveDynamicImport: [],
        load: [],
        transform: [],
        generateBundle: [],
        moduleParsed: [],
        renderChunk: [],
        buildEnd: [],
    };
    for (const [pluginIdx, p] of plugins.entries()) {
        const bs = normalize(p.name, pluginIdx, p.buildStart);
        if (bs !== null) pipeline.buildStart.push(bs);
        const ri = normalize(p.name, pluginIdx, p.resolveId);
        if (ri !== null) pipeline.resolveId.push(ri as Pipeline['resolveId'][number]);
        const rd = normalize(p.name, pluginIdx, p.resolveDynamicImport);
        if (rd !== null) pipeline.resolveDynamicImport.push(rd as Pipeline['resolveId'][number]);
        const ld = normalize(p.name, pluginIdx, p.load);
        if (ld !== null) pipeline.load.push(ld as Pipeline['load'][number]);
        const tr = normalize(p.name, pluginIdx, p.transform);
        if (tr !== null) pipeline.transform.push(tr as Pipeline['transform'][number]);
        const mp = normalize(p.name, pluginIdx, p.moduleParsed);
        if (mp !== null) pipeline.moduleParsed.push(mp);
        const rc = normalize(p.name, pluginIdx, p.renderChunk);
        if (rc !== null) pipeline.renderChunk.push(rc);
        const be = normalize(p.name, pluginIdx, p.buildEnd);
        if (be !== null) pipeline.buildEnd.push(be);
        const gb = normalize(p.name, pluginIdx, p.generateBundle);
        if (gb !== null) pipeline.generateBundle.push(gb);
    }
    return pipeline;
}

/** Default `extra` for resolveId callers that don't supply one (dev server, tests). */
const DEFAULT_RESOLVE_EXTRA: ResolveIdExtra = { isEntry: false, kind: 'import-statement' };

const EMPTY_SKIPS: readonly ResolveSkip[] = [];

/** first-wins resolveId. Returns the RAW hook value (object / string / false) —
 *  normalization happens at the call site so the driver stays shape-agnostic.
 *  Stays synchronous unless a hook returns a promise, then resumes the loop after
 *  it settles. */
export function runResolveId(
    pipeline: Pipeline,
    ctxFor: CtxFor,
    specifier: string,
    importer: string | null,
    extra: ResolveIdExtra = DEFAULT_RESOLVE_EXTRA,
    /** The `skipSelf` set in force, accumulated down a chain of nested `this.resolve` calls. */
    skipped: readonly ResolveSkip[] = EMPTY_SKIPS,
    /** Which chain to run. `resolveDynamicImport` is tried first for a dynamic import and falls
     *  through to `resolveId` when every hook declines — see {@link Plugin.resolveDynamicImport}. */
    which: 'resolveId' | 'resolveDynamicImport' = 'resolveId',
): MaybePromise<ResolveIdResult> {
    const hooks = pipeline[which];
    let i = 0;
    const step = (): MaybePromise<ResolveIdResult> => {
        while (i < hooks.length) {
            const hook = hooks[i++];
            if (hook.matches !== null && !hook.matches(specifier)) continue;
            // Skipped only for THIS (specifier, importer): a plugin taken out of the loop for one
            // resolution still resolves every other one.
            if (
                skipped.length > 0 &&
                skipped.some((k) => k.pluginIdx === hook.pluginIdx && k.specifier === specifier && k.importer === importer)
            )
                continue;
            // `undefined`, not `null`, when there is no importer. Rollup's fixtures assert
            // `strictEqual(importer, undefined)` for an entry and for a `this.resolve(spec)` with no
            // importer, and a plugin written against that contract sees `null` here and takes the
            // wrong branch. Internally the absence stays `null` — that is what the resolver and the
            // skip-matching are keyed on; only the plugin-facing argument changes.
            const r = hook.handler.call(ctxFor(hook.pluginIdx, skipped), specifier, importer ?? undefined, extra);
            if (isThenable(r)) return r.then((v) => (v !== null && v !== undefined ? (v as ResolveIdResult) : step()));
            if (r !== null && r !== undefined) return r;
        }
        return null;
    };
    return step();
}

/** first-wins load. Returns the RAW hook value (string / SourceDescription);
 *  the call site takes `.code`. */
export function runLoad(pipeline: Pipeline, ctxFor: CtxFor, id: string): MaybePromise<LoadResult> {
    const hooks = pipeline.load;
    let i = 0;
    const step = (): MaybePromise<LoadResult> => {
        while (i < hooks.length) {
            const hook = hooks[i++];
            if (hook.matches !== null && !hook.matches(id)) continue;
            // A `load` hook's own `this.resolve` skips ITS plugin's `resolveId`, so it needs the same
            // per-plugin context a `resolveId` hook gets. Nothing is inherited: this is a fresh chain.
            const r = hook.handler.call(ctxFor(hook.pluginIdx, EMPTY_SKIPS), id);
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
