import { resetInferredPure } from '../analysis/effects.ts';
import { runCompress } from '../passes/compress/index.ts';
import { inlineCrossModule } from '../passes/optimize/inline-functions.ts';
import type { SourceMap } from '../util/sourcemap.ts';
import * as Timer from '../util/timer.ts';
import { buildChunkGraph, type ChunkOptions, type ResolvedGroup } from './chunk-graph.ts';
import { type Fs, normalizePath, relativePath } from './fs.ts';
import {
    type ChunkRenderer,
    hashLiveSet,
    nameSignature,
    type RenderCache,
    type RenderIncremental,
    renderChunk,
    renderChunks,
    type RenderHooks,
} from './generate/chunks.ts';
import { includedModuleIds, type ModuleRenderCache, type ModuleReuse, type RenderStats } from './generate/context.ts';
import {
    type EmittedRecord,
    externalKey,
    type Graph,
    type ImportBind,
    type Linked,
    type ParseCache,
    type ParseStats,
    packRef,
    refMod,
    refSym,
} from './graph-types.ts';
import { computeInteropOwners } from './init-obligations.ts';
import { computeEnumInlines, linkGraph, namespaceTargets } from './link.ts';
import {
    type NormalizedOutputNaming,
    normalizeOutputOptions,
    type OutputOptionsNaming,
    type RenderedModule,
    resolveMinify,
} from './output-options.ts';
import {
    addOutputPlugins,
    callOptionsHook,
    compilePipeline,
    type GenerateBundleEntry,
    type RenderedChunkInfo,
    type MinimalPluginCtx,
    type ModuleInfo,
    normalizePluginOption,
    type PluginCtx,
    type PluginOption,
    pluginParse, pluginMeta,} from './plugin.ts';
import { stampPureCallsGraph } from './purity-graph.ts';
import type { GraphOptions } from './resolve.ts';
import { buildGraph, externalModuleInfo, fileNameOfRef, hashSource, registerEmitted, toModuleInfo } from './scan.ts';
import { type TreeshakeCache, type TreeshakeResult, treeshake } from './treeshake.ts';
import type { FileEvent } from './watch.ts';

/** The `{ getModuleInfo }` context threaded into user chunk `name`/`test` functions. */
export type ChunkMeta = { getModuleInfo: (id: string) => ModuleInfo | null };

/** A codeSplitting / advancedChunks group as a user config (mirrors rolldown's MatchGroup). */
export type CodeSplittingGroup = {
    name: string | ((id: string, meta: ChunkMeta) => string | null);
    test?: string | RegExp | ((id: string, meta: ChunkMeta) => boolean);
    priority?: number;
    minSize?: number;
    maxSize?: number;
    minModuleSize?: number;
    maxModuleSize?: number;
    minShareCount?: number;
    entriesAware?: boolean;
    entriesAwareMergeThreshold?: number;
    includeDependenciesRecursively?: boolean;
    tags?: '$initial'[];
};

/** `output.advancedChunks` — the public front door over the chunk-grouping engine. Top-level
 *  `minSize`/`maxSize`/`minShareCount`/… are per-group fallbacks (mirrors rolldown). */
export type AdvancedChunksOptions = {
    minSize?: number;
    maxSize?: number;
    minModuleSize?: number;
    maxModuleSize?: number;
    minShareCount?: number;
    includeDependenciesRecursively?: boolean;
    groups: CodeSplittingGroup[];
};

/** manualChunks — Rollup-compatible: a fn (id→name) or an object map (name→ids). Normalized
 *  into the same {@link ResolvedGroup} model as advancedChunks. */
export type ManualChunks = ((id: string, meta: ChunkMeta) => string | null | undefined) | Record<string, string[]>;

/** Output-shaping options plus naming/hash/sourcemap (from {@link OutputOptionsNaming}). */
export type OutputOptions = OutputOptionsNaming & {
    /** Plugins for THIS output only. Both oracles have it; only the GENERATE-phase hooks of these
     *  run (`renderStart`, `renderChunk`, `generateBundle`) — a build hook on an output plugin is
     *  ignored, not an error, which is Rollup's documented behaviour. */
    plugins?: PluginOption;
    /** false / the deprecated inlineDynamicImports = don't split dynamic imports out. An
     *  object configures groups. Default true. */
    codeSplitting?: boolean | { minSize?: number; groups?: CodeSplittingGroup[] };
    /** Advanced code splitting — the public group API over the chunk engine. If both this and
     *  `manualChunks` are provided, `advancedChunks` wins and `manualChunks` is ignored. */
    advancedChunks?: AdvancedChunksOptions;
    /** manualChunks — sugar over {@link advancedChunks}. Fn form (id→name) or object map
     *  (name→[ids], listed modules + their deps land in the chunk). */
    manualChunks?: ManualChunks;
    /** Deprecated alias for `codeSplitting: false` (single-input). */
    inlineDynamicImports?: boolean;
    /** One chunk per module, imports preserved as real ESM. */
    preserveModules?: boolean;
    preserveModulesRoot?: string;
    /** Which language features the GENERATED code may use — rolldown's `generatedCode`
     *  (`generated_code_options.rs`). Only `symbols` is modelled, because it is the only one whose
     *  absence is observable rather than cosmetic.
     *
     *  `symbols: false` drops the `Symbol.toStringTag` stamp from every namespace object, so
     *  `Object.prototype.toString.call(ns)` reads `[object Object]` instead of `[object Module]`.
     *
     *  DEFAULT TRUE, which is rolldown's (`GeneratedCodeOptions::default() == es2015()`). Rollup
     *  defaults it FALSE (`es5`), so this is one of the few places the two oracles disagree on a
     *  default rather than on behaviour; shakeup's bundler follows rolldown. */
    generatedCode?: { symbols?: boolean };
};

export type BundleOptions = GraphOptions & {
    /** Emit a source map (SMv3) mapping the chunk back to the module sources. */
    sourcemap?: boolean;
    /** Output-shaping config (code splitting, manualChunks, preserveModules). */
    output?: OutputOptions;
    /** Incremental per-chunk render cache. Pass a persistent Map across builds (via
     *  {@link createBuildContext}) to reuse the rendered code of clean chunks. */
    renderCache?: RenderCache;
    /** Incremental per-module render cache — reuse the rendered text of clean modules within a
     *  dirty chunk (the fine-grained companion to {@link renderCache}). */
    moduleRenderCache?: ModuleRenderCache;
    /** Incremental tree-shake cache — reuse per-module liveness infos for unchanged modules. */
    treeshakeCache?: TreeshakeCache;
    /** Threaded profiling state ({@link Timer}). Inject a shared one to accumulate per-pass
     *  timings across rebuilds; omit and a fresh (enabled) one is used per build. */
    timer?: Timer.TimerState;
};

export type OutputChunk = {
    type: 'chunk';
    fileName: string;
    /** Logical name (entry name, group name, or derived). */
    name: string;
    /** Id of the module this chunk is a facade for — the entry module for an entry chunk, `null`
     *  for a shared one. Both oracles carry it on `RenderedChunk`. */
    facadeModuleId: string | null;
    /** True iff this is a static user entry chunk. */
    isEntry: boolean;
    /** True iff this is a dynamic-import target chunk. */
    isDynamicEntry: boolean;
    /** Module ids this chunk contains, in emit order. */
    moduleIds: string[];
    /** Logical names of other chunks this chunk statically imports. */
    imports: string[];
    /** Logical names of chunks this chunk `import()`s. */
    dynamicImports: string[];
    /** Exported names this chunk surfaces. */
    exports: string[];
    /** Per-module rendered contribution, keyed by module id, in emit order — Rollup's and rolldown's
     *  `OutputChunk.modules`. A module that rendered nothing (a pure re-exporter) is absent, which is
     *  what Rollup's `inline-dynamic-imports-bundle` asserts by reading `Object.keys`. */
    modules: Record<string, RenderedModule>;
    code: string;
    map?: SourceMap;
};

/** A non-chunk output file: a `.map` sidecar, or an asset a plugin emitted via `ctx.emitFile`
 *  (bytes for a binary asset, a string for text). */
/**
 * A non-chunk output file, in the shape both oracles hand to `generateBundle` and return from
 * `generate`. Every field below was measured against a real rolldown build rather than inferred:
 *
 *     emitFile({ name })              name: 'x.txt'  names: ['x.txt']  originalFileName: null
 *     emitFile({ name, originalFileName })           …               originalFileName: '<path>'
 *     emitFile({ fileName })          name absent    names: []        originalFileName: null
 *     a `.map` sidecar                name absent    names: []        originalFileName: null
 *
 * The plurals are the real fields and the singulars are deprecated aliases for their FIRST element,
 * because dedupe unions: the same bytes emitted twice under different names is one file listing both.
 */
export type OutputAsset = {
    type: 'asset';
    fileName: string;
    source: string | Uint8Array;
    /** @deprecated `names[0]`, absent when nothing named it. */
    name?: string;
    names: string[];
    /** @deprecated `originalFileNames[0]`, `null` when there is no source file. */
    originalFileName: string | null;
    originalFileNames: string[];
};

/** Project a {@link Graph.emitted} record into the output shape. */
function outputAsset(fileName: string, rec: EmittedRecord): OutputAsset {
    return {
        type: 'asset',
        fileName,
        source: rec.source,
        name: rec.names[0],
        names: rec.names,
        originalFileName: rec.originalFileNames[0] ?? null,
        originalFileNames: rec.originalFileNames,
    };
}

/** `map` is present iff `sourcemap` was set (and no `renderChunk` plugin rewrote the chunk). */
export type BundleResult = {
    /** The chunk graph. Length ≥ 1 (0 on error). */
    chunks: OutputChunk[];
    /** Emitted non-chunk files — `.map` sidecars plus plugin `ctx.emitFile` assets. */
    assets?: OutputAsset[];
    errors: string[];
    warnings: string[];
    graph: Graph | null;
    linked: Linked | null;
    shaken: TreeshakeResult | null;
    /** Modules freshly parsed vs reused from `options.cache` this build (incremental). */
    parseStats: ParseStats;
    /** Chunks rendered vs reused from `options.renderCache` (present only with a render cache). */
    renderStats?: RenderStats;
    /** Per-pass wall-clock (graph/link/treeshake/chunk/render), by total ms (success builds only). */
    timings?: Timer.TimerReport;
};

/** Rewrite `require("./x")` to the target's wrapper call. The wrapper returns `module.exports`, so
 *  the call site's VALUE is already what `require` should produce — no interop conversion, because
 *  the consumer is CommonJS and expects a CommonJS exports object. (`__toCommonJS` is the other
 *  direction — CJS requiring an ESM module — and is not lowered yet.) */

/** Generate-stage asset emit (rolldown finalizes assets in generate, not scan): read each resolved
 *  `new-url` asset's bytes, content-hash them into an output fileName, register it in `graph.emitted`,
 *  and record `assetFileName` for the `new URL(…, import.meta.url)` rewrite. Scan only resolved the
 *  path. A read failure goes to `graph.errors` (surfaced by the caller's post-buildGraph error gate). */
async function emitAssets(graph: Graph, fs: Fs): Promise<void> {
    for (const mod of graph.modules) {
        for (const rec of mod.importRecords) {
            if (rec.kind !== 'new-url' || rec.assetPath === undefined) continue;
            const bytes = await fs.read(rec.assetPath);
            if (bytes === null) {
                graph.errors.push(`cannot load asset '${rec.specifier}' from '${mod.id}'`);
                continue;
            }
            const name = rec.assetPath.slice(rec.assetPath.lastIndexOf('/') + 1);
            // Through `registerEmitted` like any other emit, so the dedupe union and the reference-id
            // bookkeeping are in ONE place. `originalFileName` is the point of the exercise here: a
            // `new URL()` asset is the case where the output file has a real source file behind it.
            // Read BACK through the reference id rather than recomputing the name: with content
            // dedupe the registered file may already exist under a different asset's name.
            const ref = registerEmitted(graph, { type: 'asset', name, originalFileName: rec.assetPath, source: bytes });
            rec.assetFileName = fileNameOfRef(graph, ref);
        }
    }
}

/** Drop an external import's emitted local when it is side-effect-free AND no live statement
 *  references it — rolldown's model: an external binding is emitted iff it's referenced (in
 *  `reference_needed_symbols` = treeshake's `liveRefs`) OR its module is side-effectful. An external
 *  is side-effect-free per `graph.externalSideEffects` (rolldown `moduleSideEffects`: the injected
 *  `<src>/jsx-runtime`, plus anything a plugin declares); authored externals default to
 *  side-effectful, so they're kept. Symbol liveness, not a JSX-specific AST walk. */
function pruneUnusedExternals(graph: Graph, linked: Linked, liveRefs: Set<number>): void {
    // Injected runtime symbols are side-effect-free even when their specifier isn't module-level
    // marked — notably `createElement`, imported from the bare (side-effectful) importSource.
    const runtimeSyms = new Set<number>();
    for (const mod of graph.modules) {
        const rt = mod.jsxRuntime;
        if (rt === null) continue;
        for (const sym of [rt.jsx, rt.jsxs, rt.Fragment, rt.createElement]) if (sym !== 0) runtimeSyms.add(packRef(mod.idx, sym));
    }
    // An external (specifier,name) key is kept iff SOME importer needs it (referenced OR side-effectful);
    // drop keys whose every importer is a dead side-effect-free binding.
    const kept = new Set<string>();
    const candidates = new Set<string>();
    // Named specifiers grouped by module, plus the subset some importer actually references. Star and
    // default locals are registered by `deconflict` but are not in `namedImports`, so they never
    // appear here — they are only ever left alone, never dropped, by the sibling rule below.
    const keysBySpec = new Map<string, Set<string>>();
    const liveKeys = new Set<string>();
    for (const mod of graph.modules) {
        for (const [sym, imp] of mod.namedImports) {
            const rec = mod.importRecords[imp.rec];
            if (!rec.external) continue;
            const key = externalKey(rec.specifier, imp.name);
            const ref = packRef(mod.idx, sym);
            let group = keysBySpec.get(rec.specifier);
            if (group === undefined) {
                group = new Set();
                keysBySpec.set(rec.specifier, group);
            }
            group.add(key);
            const sideEffectFree = graph.externalSideEffects.get(rec.specifier) === false || runtimeSyms.has(ref);
            if (liveRefs.has(ref)) liveKeys.add(key);
            if (!sideEffectFree || liveRefs.has(ref)) kept.add(key);
            else candidates.add(key);
        }
    }
    for (const key of candidates) if (!kept.has(key)) linked.externalLocals.delete(key);

    // A named specifier carries NO side effect of its own — the MODULE does. So when some sibling
    // specifier keeps `import { … } from 'spec'` alive, every unreferenced specifier on it is
    // droppable whether or not the external is side-effect-free: the statement still runs. Without
    // this we emitted `vec4` in crashcat's `math` import with zero uses, where oxc-minify drops it.
    //
    // Gated on a live sibling deliberately. If NOTHING on the specifier is live the statement itself
    // would disappear, and a side-effectful external then needs a bare `import 'spec';` — but
    // `sideEffectSpecs` is only populated from source-level bare imports (`trackChunkSpecs`), and
    // `renderExternalImports` emits those AFTER the named ones, which would move the side effect
    // relative to its siblings. That case stays on the conservative path above.
    for (const keys of keysBySpec.values()) {
        let anyLive = false;
        for (const key of keys) if (liveKeys.has(key)) anyLive = true;
        if (!anyLive) continue;
        for (const key of keys) if (!liveKeys.has(key)) linked.externalLocals.delete(key);
    }
}

/** Build, link, tree-shake, and assemble the entry module into a single ESM chunk. */
export async function bundle(options: BundleOptions): Promise<BundleResult> {
    // Purity verdicts are derived from other modules and are re-derived in full every build; clear
    // last build's before anything reads them, or a cached module's call node keeps a stamp whose
    // justification has since changed. See `resetInferredPure`.
    resetInferredPure();
    // Resolve the plugin list the way both oracles do, in three steps: flatten (nested arrays,
    // promises, falsy holes), run every `options` hook against the build options, then flatten AGAIN
    // over the result — which is what lets an `options` hook add a plugin that takes part in the
    // build. Rollup's `getProcessedInputOptions` / rolldown's `PluginDriver.callOptionsHook`.
    const optionsWarnings: string[] = [];
    const minimalCtx: MinimalPluginCtx = {
        warn: (m) => optionsWarnings.push(m),
        error: (m) => {
            throw new Error(m);
        },
        info: (m) => optionsWarnings.push(m),
        debug: () => {},
    };
    const firstPass = await normalizePluginOption(options.plugins);
    options = (await callOptionsHook(
        firstPass,
        options as unknown as Record<string, unknown>,
        minimalCtx,
    )) as unknown as BundleOptions;
    const inputPlugins = await normalizePluginOption(options.plugins);
    const pipeline = compilePipeline(inputPlugins);
    // OUTPUT plugins contribute their generate-phase hooks, after the input plugins'. Their
    // `pluginIdx` continues the input list's so the two cannot collide.
    const outputPlugins = await normalizePluginOption(options.output?.plugins);
    if (outputPlugins.length > 0) addOutputPlugins(pipeline, outputPlugins, inputPlugins.length);
    const warningsOut: string[] = [...optionsWarnings];
    // Full PluginCtx for the bundle-level hooks (buildStart/renderChunk/buildEnd).
    // getModuleInfo/getModuleIds read `graph` once it's built (null/empty before);
    // in-build resolution (resolveId hooks, ctx.resolve) runs through buildGraph's
    // own graph-backed ctx.
    let graph: Graph;
    const pluginCtx: PluginCtx = {
        warn: (m) => warningsOut.push(m),
        error: (m) => {
            throw new Error(m);
        },
        info: (m) => warningsOut.push(m),
        debug: () => {},
        meta: pluginMeta(options.watchMode),
        parse: pluginParse,
        fs: options.fs,
        resolve: () => null,
        // Only reached from renderChunk/buildEnd/generateBundle, which run after `graph` is built.
        emitFile: (file) => registerEmitted(graph, file),
        getFileName: (referenceId) => fileNameOfRef(graph, referenceId),
        // POST-BUILD context (renderChunk / buildEnd / generateBundle): the graph is closed, so
        // `this.load` can only report what is already in it. The graph-backed load lives on the scan
        // context, which is where a plugin can still pull a module in.
        load: ({ id }): ModuleInfo | null => {
            if (graph === undefined) return null;
            const idx = graph.byId.get(id);
            return idx === undefined ? null : toModuleInfo(graph, graph.modules[idx]);
        },
        getModuleInfo: (id): ModuleInfo | null => {
            if (graph === undefined) return null;
            const idx = graph.byId.get(id);
            if (idx !== undefined) return toModuleInfo(graph, graph.modules[idx]);
            // Externals are not modules here, but Rollup keeps them in the graph and answers for
            // them — `custom-external-module-options` reads one's `meta` from `buildEnd`.
            const ext = graph.externals.get(id);
            return ext === undefined ? null : externalModuleInfo(ext);
        },
        getModuleIds: () => (graph === undefined ? [][Symbol.iterator]() : graph.byId.keys()),
    };
    // buildStart is driven inside buildGraph (full graph-backed ctx for ctx.resolve).
    const timer = options.timer ?? Timer.init(true);
    Timer.start(timer, 'graph');
    // Compress (minify P4) is a scan-stage transform — thread it in so the parse cache stays
    // compress-aware. `resolveMinify` also drives mangle (below) so the two never drift.
    // PER MODULE: the `dce` tier only, never the cosmetic one. DCE feeds the purity analysis that
    // tree-shaking depends on, so it has to precede the shaker — rolldown does exactly this at
    // `pre_process_ecma_ast.rs` step 5, gated on `treeshake.is_some()`. The cosmetic tier runs later,
    // over the assembled chunk (`chunk-compress.ts`), where it can see the whole picture.
    // TWO COSMETIC TIERS, SPLIT BY PHASE. `dce` runs per module during scan and is cached — it feeds
    // the purity analysis tree-shaking depends on. The COSMETIC tier runs once over each assembled
    // chunk, after linking and shaking (`chunk-compress.ts` has the full argument, and the mangler
    // runs there too, last, which is where every peer puts it).
    //
    // This is what it costs, measured interleaved in one process on crashcat + three:
    //
    //     cold crashcat     389ms -> 629ms  (+62%)      size 446,621 -> 445,872  (-749)
    //     cold three        333ms -> 460ms  (+38%)      size 382,631 -> 382,687  (+56)
    //     watch, minify:false  32.6ms -> 31.2ms (0.96x — the cosmetic tier is not running)
    //     watch, minify:true   56.2ms -> 430ms  (7.65x)
    //
    // The 7.65x is the honest price and it is not a re-parse problem — by stage, the re-parse is
    // 38.8ms of 229.7ms (17%) and the compressor itself is 137.9ms (60%). It is the per-module
    // compress CACHE that is gone: an edited chunk must be re-minified as a whole. Every peer pays
    // exactly this (rolldown `minify_chunks.rs`, rspack `process_assets`, rollup's `renderChunk`),
    // and unchanged chunks skip it entirely through the render cache below — rspack's
    // content-addressed minimize cache, reached through the cache we already keep. Taken
    // deliberately: correct decisions on whole-chunk information beat cached decisions made per
    // module on partial information.
    const compressForScan = resolveMinify(options.output?.minify).compress === false ? false : ('dce' as const);
    // CROSS-MODULE CACHE INVALIDATION — done BEFORE scan, on purpose.
    //
    // A module that received a cross-module substitution has its producers recorded on its cache entry
    // (`transformDependencies`). Evicting it here, rather than validating after the fact, means it is simply parsed
    // fresh by scan and lands in `graph.changed` like any source-changed module — so `affected`, the
    // render cache, `[hash]` propagation and sourcemap indices all follow with NO special-casing. This
    // is the same shape as a Rollup/Vite plugin calling `addWatchFile`: the plugin only declares the
    // edge, and the host's ordinary "this module changed" path does the rest.
    //
    // Hashes are taken over the RAW file so both sides of the comparison are available without running
    // the load/transform pipeline; a producer that cannot be read (virtual module, deleted) compares
    // unequal and conservatively invalidates.
    if (options.cache !== undefined && options.cache.size > 0) {
        const seen = new Map<string, number>();
        const rawHash = async (id: string): Promise<number> => {
            const memo = seen.get(id);
            if (memo !== undefined) return memo;
            const src = await options.fs.read(id);
            const h = src === null ? -1 : hashSource(src);
            seen.set(id, h);
            return h;
        };
        for (const [id, entry] of [...options.cache]) {
            if (entry.transformDependencies === undefined) continue;
            for (const [pid, phash] of entry.transformDependencies) {
                if ((await rawHash(pid)) !== phash) {
                    options.cache.delete(id);
                    break;
                }
            }
        }
    }
    graph = await buildGraph(
        {
            ...options,
            compress: compressForScan,
            optimize: options.output?.optimize ?? true,
            // An OUTPUT option threaded into SCAN — see `GraphOptions.assetFileNames`. An asset's
            // fileName is embedded in module code at transform time, so it cannot wait for generate.
            assetFileNames: options.output?.assetFileNames,
        },
        pipeline,
    );
    // Generate-stage asset emit: read + content-hash resolved `new-url` assets (scan only resolved
    // their paths). Before the error gate so an asset load failure surfaces like a scan error.
    await emitAssets(graph, options.fs);
    Timer.end(timer, 'graph');

    /** A failed build: no output, plus whatever pipeline state exists by the point of failure.
     *
     *  Six sites used to spell this out. They disagreed in two ways, both of which read as
     *  oversights rather than intent, and both are fixed here: the two earliest returned
     *  `warnings: []`, silently discarding plugin `this.warn()` output and every scan warning; and
     *  the chunk-options failure returned `linked: null, shaken: null` despite holding both. A
     *  caller inspecting `result.graph` after a failure now gets the same picture wherever it
     *  stopped. */
    const failed = (
        errors: string[],
        warnings: string[],
        atLink: Linked | null,
        atShake: TreeshakeResult | null,
    ): BundleResult => ({
        chunks: [],
        errors,
        warnings,
        graph,
        linked: atLink,
        shaken: atShake,
        parseStats: graph.parseStats,
    });
    const earlyWarnings = (): string[] => [...warningsOut, ...graph.warnings];

    if (graph.errors.length > 0 || graph.entries.length === 0) return failed(graph.errors, earlyWarnings(), null, null);
    // Link WITHOUT whole-bundle deconflict — the per-chunk deconflict inside buildChunkGraph
    // assigns names in fresh per-chunk scopes. For a single chunk this reproduces the
    // whole-bundle names byte-for-byte (same order, same taken seeding).
    Timer.start(timer, 'link');
    const linked = linkGraph(graph); // Link binds+sorts only; per-chunk deconflict runs in buildChunkGraph
    Timer.end(timer, 'link');
    if (linked.errors.length > 0) return failed(linked.errors, earlyWarnings(), linked, null);

    const warnings: string[] = [...warningsOut, ...graph.warnings];
    // Tree-shake per module before chunk assembly. Uses binds/exportMaps, not names.
    // Cross-module `@inline`: the donor module is already parsed and bound by now, so an imported
    // annotated helper can be inlined natively — no plugin re-read of the donor file. Runs BEFORE
    // purity and treeshake so both see the expanded code; each touched module is then re-analysed and
    // re-compressed, since scan's compress ran before the graph existed.
    {
        const compressMode = resolveMinify(options.output?.minify).compress === false ? false : ('dce' as const);
        const resolveImport = (idx: number, sym: number): { mod: number; sym: number } | null => {
            const bind = linked.binds.get(packRef(idx, sym));
            if (bind === undefined || bind.kind !== 'found') return null;
            return { mod: refMod(bind.ref), sym: refSym(bind.ref) };
        };
        // consumer module idx → the producer modules whose SOURCE its AST now depends on.
        const touched = inlineCrossModule(graph.modules, resolveImport);
        // Cross-module constant propagation (`passes/compress/cross-module-constants.ts`) is written
        // but NOT wired — see the roadmap. Being ungated, it would make almost every importer a cache
        // dependent; keeping it out means the only cross-module derived state in the system comes from
        // a DIRECTIVE the author opted into. If it is ever wanted, rolldown's shape is the model:
        // `optimization.inlineConst: boolean | { mode: 'all' | 'smart' }` — an OPTION, not a directive.
        void compressMode;
        for (const [idx, producers] of touched) {
            const mod = graph.modules[idx];
            // A cross-module substitution makes this module's AST depend on ANOTHER module's source —
            // a dependency the parse cache does not track. Editing the producer would otherwise leave
            // the consumer holding a stale inlined value (its cached AST already has the old constant
            // baked in). Evict it so the next build re-parses from source, and mark it changed so this
            // build re-renders it. Conservative: only modules that actually received a substitution.
            // This module's AST now depends on `producers`' SOURCE. Record that on its cache entry
            // so a later build can tell whether the cached (already-substituted) AST is still valid;
            // `srcHash` alone is no longer a sufficient key for it.
            const entry = options.cache?.get(mod.id);
            if (entry !== undefined) {
                const deps: [string, number][] = [];
                for (const p of producers) {
                    const pid = graph.modules[p].id;
                    // RAW-file hash, matching what the pre-scan check re-computes; an unreadable
                    // producer records -1 so the consumer is always invalidated (conservative).
                    const src = await options.fs.read(pid);
                    deps.push([pid, src === null ? -1 : hashSource(src)]);
                }
                entry.transformDependencies = deps;
            }
            // NO REBUILD. `inlineCrossModule` splices an imported `@inline` helper through the same
            // `inline-functions` machinery as the per-module tier, which now MAINTAINS the semantic —
            // fresh scopes and symbols per splice, references accounted through a `RefDelta`. This was
            // the last per-module `analyze` outside the initial one.
            //
            // Neither corpus takes this branch (both run exactly one `analyze` per module), so
            // `tst/cross-module-inline-semantic.test.ts` exists to exercise it: a green gate proves
            // nothing about a path nothing walks.
            if (compressMode !== false) {
                const refreshed = runCompress(mod.program, mod.semantic, compressMode);
                if (refreshed !== null) mod.semantic = refreshed;
            }
        }
    }

    // Cross-module purity BEFORE treeshake: proving an imported helper side-effect-free lets
    // `isPureStatement` (and so treeshake) drop a discarded call to it. The per-module pass inside
    // `runCompress` cannot see across module boundaries — scan analyses each module before link binds
    // them together — so this is the point where the interprocedural answer becomes available.
    stampPureCallsGraph(graph, linked);
    // BEFORE treeshake, which is the point: an `Enum.MEMBER` read that becomes a constant is not a
    // reference to the enum, and counting it as one is why the lowered object could never be
    // dropped. On crashcat that object is 231 string literals (3,903 bytes against rolldown's 2) —
    // the single largest item left in the size gap, and rolldown drops every one of them.
    linked.enumInlines = computeEnumInlines(graph, linked);
    Timer.start(timer, 'treeshake');
    const shaken = options.treeshake === false ? null : treeshake(graph, linked, options.treeshakeCache);
    Timer.end(timer, 'treeshake');
    // Hand elidability to DECONFLICT, which runs inside `buildChunkGraph` below. An elided `ns.foo`
    // is a reference to the producer that appears in no AST, so the renamer cannot see it and a
    // nested binding of the same name silently captures it. rolldown resolves member-expr refs in
    // link_stage for exactly this reason and deconflicts afterwards, in generate_stage.
    //
    // The CHUNK narrowing (`elidedNs`, below) has not happened yet — it needs `chunkByModule`, which
    // `buildChunkGraph` is what produces. So this is the wider candidate set, and deconfliction may
    // rename a nested local guarding an elision that the partition then declines. That direction is
    // safe: the cost is an occasional `$1` on a local, never a capture.
    linked.rewritableNs = namespaceTargets(graph, linked);

    // NAMESPACE ELISION, decided HERE — before the chunk partition exists, because it no longer
    // depends on one.
    //
    // The previous rule elided only where every consumer shared the target's chunk, since eliding
    // changes what a chunk IMPORTS — one namespace binding becomes the individual members — and the
    // cross-chunk wiring had already run by the time the emitter saw any of this.
    // `preserve-modules-namespace` caught the unwired version as a `ReferenceError`, not a diff.
    //
    // But the same-chunk test only ever existed to serve that ordering. Both inputs are known now,
    // so the decision moves ahead of `buildChunkGraph` and the wiring is TOLD what was elided —
    // `nsMemberBinds` below is exactly the member set the object literal would have named, so a
    // consumer in another chunk imports those instead of the object. rolldown does the same
    // (`resolve_member_expr_refs` never consults the chunk assignment) and answers this repro with
    // no namespace object at all.
    //
    // REWRITING a read is a SEPARATE question from BUILDING the object. rolldown keeps them apart:
    // `resolve_member_expr_refs` fires whenever the member expression's object is a namespace symbol
    // and the property resolves unambiguously to a non-CommonJS export, with no reference at all to
    // whether the object gets materialised (`bind_imports_and_exports.rs:616`). crashcat's 43
    // `export * as` namespaces are exactly that case — the object is public API and must exist, and
    // the 433 internal `ns.foo` reads of it should still name the binding directly.
    const rewrittenNs = new Set<number>();
    const elidedNs = new Set<number>();
    // The members a consumer chunk must import in the object's place. Taken from the SAME narrowed
    // set the object literal is built from (`renderNamespaceObject`'s `nsMembers`), which is the only
    // set that is neither too small — a member nothing wired is a dangling reference — nor too large:
    // an absent set means the whole surface, and a shaken-away binding must not be exported.
    const nsMemberBinds = new Map<number, ImportBind[]>();
    for (const target of linked.rewritableNs) {
        const map = linked.exportMaps.get(target);
        if (map === undefined) continue;
        // `nsUsage` for an ELIDED target — the object's own member set, which is exactly what its
        // reads resolve to. `nsRead` for one that is only REWRITTEN: it has no narrowed surface (that
        // is why it is not elidable), and wiring its whole export map imports members nothing names —
        // an escaping namespace under `preserveModules` did that, emitting a dead `import { v }`
        // beside the `import * as ns` it still needs.
        //
        // `treeshake: false` has neither, and gets the whole surface: nothing was shaken, so every
        // member exists and over-importing costs bytes rather than correctness. A target we cannot
        // name the members of is NOT rewritten at all — rewriting a read whose member no chunk
        // imports is the dangling reference this whole change has to avoid.
        const members = shaken === null ? new Set(map.keys()) : (shaken.nsUsage.get(target) ?? shaken.nsRead.get(target));
        if (members === undefined) continue;
        const binds: ImportBind[] = [];
        for (const [name, bind] of map) if (members.has(name)) binds.push(bind);
        nsMemberBinds.set(target, binds);
        rewrittenNs.add(target);
        // Elision needs everything rewriting needs AND proof the object is unobservable, which is
        // what `treeshake` establishes.
        if (shaken?.elidableNs.has(target) === true) elidedNs.add(target);
    }

    // Assign chunks → wire cross-chunk imports/exports → per-chunk deconflict.
    Timer.start(timer, 'chunk');
    // Option validation reports through `errors` like every other build failure, rather than
    // escaping as a throw — a caller reads `result.errors`, and a config mistake is not an exception.
    let chunkOptions: ReturnType<typeof resolveChunkOptions>;
    try {
        chunkOptions = resolveChunkOptions(
            options.output,
            graph.entries.length,
            warnings,
            pluginCtx.getModuleInfo,
            graph.externalIds,
        );
    } catch (e) {
        return failed([(e as Error).message], warnings, linked, shaken);
    }
    const min = resolveMinify(options.output?.minify);
    // Link-time mangling is SKIPPED when the chunk pass will do it, so names stay readable through
    // the chunk compress and the mangler gets to run last (see `mangle/program.ts`). `deconflict`
    // still runs — the chunk must be collision-free before it is one program.
    const chunkGraph = buildChunkGraph(graph, linked, chunkOptions, shaken?.deadDynamic, { elidedNs, nsMemberBinds });
    // Ownership is decided once for the whole bundle, over the SHAKEN graph and the finished chunk
    // assignment: the owner has to be a statement that survives, "first in evaluation order" is a
    // global question no per-chunk pass can answer, and the owner has to sit in the SAME chunk as the
    // wrapper it calls.
    const interopOwners = computeInteropOwners(
        graph,
        linked,
        (i) => (shaken === null ? null : shaken.live[i]),
        chunkGraph.chunkByModule,
    );
    Timer.end(timer, 'chunk');

    // Drop unused side-effect-free externals (the injected jsx runtime) via symbol liveness.
    if (shaken !== null) pruneUnusedExternals(graph, linked, shaken.liveRefs);

    // Normalize output naming/hashing/sourcemap config. `sourcemap` (top-level) is a
    // deprecated alias for `output.sourcemap`. Reject `file:` for a multi-chunk build.
    const multiChunk = chunkGraph.chunks.length > 1;
    let naming: NormalizedOutputNaming;
    try {
        naming = normalizeOutputOptions(options.output, options.sourcemap, multiChunk, warnings);
    } catch (e) {
        return failed([(e as Error).message], warnings, linked, shaken);
    }

    // `renderStart` — the first GENERATE-phase hook, with the output options SETTLED (`naming` is
    // normalized above) and before any chunk is rendered. Awaited in PARALLEL: both oracles list it
    // as `async parallel`, like `buildStart`.
    //
    // It gets the INPUT options as well, which is the whole reason the hook takes two arguments — a
    // plugin used as an OUTPUT plugin has never seen them otherwise.
    if (pipeline.renderStart.length > 0) {
        await Promise.all(
            pipeline.renderStart.map((hook) =>
                hook.handler.call(
                    pluginCtx,
                    naming as unknown as Record<string, unknown>,
                    options as unknown as Record<string, unknown>,
                ),
            ),
        );
        warnings.push(...warningsOut.splice(0));
    }

    // Two-pass render → content-hash → final-hash → substitute (see renderChunks below). The per-chunk
    // renderer closes over graph/linked/shaken and threads the path resolver + addons + module cache.
    const renderStats: RenderStats = { rendered: 0, reused: 0, moduleRendered: 0, moduleReused: 0 };
    let inc: RenderIncremental | undefined;
    if (options.renderCache !== undefined) {
        // Module-render reuse rides on a persistent cache + a global naming signature: when no
        // final name shifted this build, any clean module renders identical bytes.
        const mrc = options.moduleRenderCache ?? { modules: new Map(), namesHash: -1 };
        const namesHash = nameSignature(linked);
        const liveHash = graph.modules.map((_, i) => (shaken === null ? 0 : hashLiveSet(shaken.live[i])));
        const mod: ModuleReuse = {
            cache: mrc.modules,
            namesStable: mrc.namesHash === namesHash,
            changed: graph.changed,
            liveHash,
            stats: renderStats,
        };
        inc = { cache: options.renderCache, dirty: new Set([...graph.changed, ...graph.affected]), stats: renderStats, mod };
        mrc.namesHash = namesHash;
    }
    const renderer: ChunkRenderer = (chunk, ci, prelim, pathToChunk, want) =>
        renderChunk(
            {
                graph,
                linked,
                chunkGraph,
                chunk,
                chunkIdx: ci,
                shaken,
                elidedNs,
                rewrittenNs,
                interopOwners,
                warnings,
                naming,
                symbols: options.output?.generatedCode?.symbols !== false,
                context: options.context ?? null,
                wantMap: want,
                // Emit-glue spacing and module printing both stay readable when the chunk pass will
                // minify: it re-parses this text, and minified printing loses `@__PURE__`.
                tight: min.compress === 'full' ? false : min.whitespace,
                deferMinify: min.compress === 'full',
                pathToChunk,
            },
            prelim,
            inc?.mod ?? null,
        );

    // `renderChunk` and `augmentChunkHash` run INSIDE `renderChunks`, between the render and the
    // content hash — see {@link RenderHooks}. They used to run out here, after naming was finished,
    // which meant a plugin's rewrite never reached the hash: rolldown moves the hash for both and
    // shakeup moved it for neither (measured, §2z82).
    let renderChunkMeta: { chunks: Record<string, RenderedChunkInfo> } = { chunks: {} };
    const renderHooks: RenderHooks = {
        beforeRenderChunk: (described) => {
            // EMITTED-CHUNK reference ids become resolvable now, and not before: a chunk's fileName
            // exists only once chunking and naming have run, which is the whole reason `emitFile`
            // answers a reference id (§2z61). The name is PRELIMINARY here, so it may carry a hash
            // placeholder — which is exactly why a plugin can embed it: Pass C substitutes
            // placeholders inside the plugin's own output too. `bundle()` re-points these at the
            // final names below, for `generateBundle` and anything after it.
            // Matched by FACADE MODULE — the emitted chunk is an entry, so the chunk that fronts it
            // is the one whose facade is that module.
            for (const emitted of graph.emittedChunks) {
                if (emitted.module < 0) continue;
                const id = graph.modules[emitted.module].id;
                const own = described.find((c) => c.isEntry === true && (c.moduleIds as string[]).includes(id));
                if (own !== undefined) graph.emittedRefs.set(emitted.ref, own.fileName);
            }
            renderChunkMeta = { chunks: Object.fromEntries(described.map((c) => [c.fileName, c])) };
        },
        renderChunk:
            pipeline.renderChunk.length === 0
                ? undefined
                : async (code, chunk) => {
                      let current = code;
                      for (const hook of pipeline.renderChunk) {
                          // AWAITED, and in ORDER. Rollup documents `renderChunk` as async and plugins
                          // return promises; calling it synchronously meant the `{ code, map }` unwrap
                          // below read `.code` off a PROMISE, got `undefined`, and discarded the result —
                          // every hook then saw the original chunk and the bundle was emitted unmodified,
                          // with no error and no warning. Sequential rather than parallel because each
                          // hook's input is the previous one's output.
                          const raw = await hook.handler.call(
                              pluginCtx,
                              current,
                              chunk,
                              naming as unknown as Record<string, unknown>,
                              renderChunkMeta,
                          );
                          // rollup's `renderChunk` may return either a string or `{ code, map }`, and
                          // plugins written against rollup return the object form. It used to be assigned
                          // straight to the chunk's code, so the chunk was emitted as the string
                          // `[object Object]` — no error, no warning, just a destroyed bundle.
                          const result = typeof raw === 'object' && raw !== null ? raw.code : raw;
                          if (result !== null && result !== undefined) current = result;
                      }
                      return current === code ? null : current;
                  },
        augmentChunkHash:
            pipeline.augmentChunkHash.length === 0
                ? undefined
                : async (chunk) => {
                      // Every plugin's salt, concatenated in plugin order — one declining (returning
                      // nothing) must not erase another's.
                      let salt = '';
                      for (const hook of pipeline.augmentChunkHash) {
                          const part = await hook.handler.call(pluginCtx, chunk);
                          if (typeof part === 'string') salt += part;
                      }
                      return salt;
                  },
        warn: (m) => warnings.push(m),
    };

    let outputChunks: OutputChunk[];
    let assets: OutputAsset[];
    Timer.start(timer, 'render');
    try {
        const r = await renderChunks(
            chunkGraph,
            naming,
            renderer,
            (i) => graph.modules[i].id,
            (c) => includedModuleIds(graph, shaken, c),
            min.compress,
            min.mangle,
            inc,
            renderHooks,
        );
        outputChunks = r.chunks;
        assets = r.assets;
    } catch (e) {
        return failed([(e as Error).message], warnings, linked, shaken);
    }
    Timer.end(timer, 'render');

    // The emitted-chunk reference ids are re-pointed at the FINAL names. `beforeRenderChunk` set
    // them to the preliminary ones so `renderChunk` could resolve a reference; from here on
    // (`buildEnd`, `generateBundle`, the returned bundle) they must be the real file names.
    for (const emitted of graph.emittedChunks) {
        if (emitted.module < 0) continue;
        const id = graph.modules[emitted.module].id;
        const own = outputChunks.find((c) => c.moduleIds.length > 0 && c.isEntry && c.moduleIds.includes(id));
        if (own !== undefined) graph.emittedRefs.set(emitted.ref, own.fileName);
    }
    warnings.push(...warningsOut.splice(0));

    // AWAITED, and in parallel — Rollup documents `buildEnd` as `Kind: async, parallel` and says
    // "you can also return a Promise" (`docs/plugin-development/index.md:304-313`). Calling it and
    // walking away meant an async `buildEnd` neither blocked the build nor surfaced its error: the
    // rejection escaped as an unhandled one and took the whole process down, well after `bundle()`
    // had already returned a clean result. Found by `pnpm rollupsuite`, which crashed on
    // `validate-resolved-by-logic` rather than reporting it.
    await Promise.all(pipeline.buildEnd.map((hook) => hook.handler.call(pluginCtx)));
    warnings.push(...warningsOut.splice(0));

    // plugin ctx.emitFile assets (content-hashed fileName → record), collected across graph build +
    // renderChunk/buildEnd. Appended after buildEnd so a late emit still lands in the output.
    for (const [fileName, rec] of graph.emitted) assets.push(outputAsset(fileName, rec));

    // `generateBundle` — the last hook, and the only one that can MUTATE the finished output. rollup
    // hands over a fileName-keyed object; plugins add entries (emitting a file), delete them and
    // rewrite `code` in place, so the arrays are rebuilt FROM the object afterwards rather than
    // assumed unchanged. Runs before the file-name check below on purpose: an entry a plugin injects
    // is exactly what that check exists to catch (`error-file-name-absolute-path` injects
    // `/etc/passwd` here).
    if (pipeline.generateBundle.length > 0) {
        const bundleObj: Record<string, GenerateBundleEntry> = {};
        for (const c of outputChunks) bundleObj[c.fileName] = { ...c, type: 'chunk' } as GenerateBundleEntry;
        for (const a of assets) bundleObj[a.fileName] = { ...a, type: 'asset' } as GenerateBundleEntry;
        // A hook may also `this.emitFile(...)`, and that file has to become part of the bundle —
        // rolldown emits it (probed: `late.txt` appears in its output), while shakeup dropped it
        // WITHOUT AN ERROR, because the collection loop above had already run and nothing read
        // `graph.emitted` again. Surfaced between hooks so a later one sees what an earlier one
        // emitted, which is Rollup's behaviour.
        //
        // `surfaced` is seeded with everything already in the object, so this only ever ADDS a new
        // emission — a hook that DELETES an entry keeps it deleted rather than having it reappear on
        // the next iteration.
        const surfaced = new Set(graph.emitted.keys());
        for (const hook of pipeline.generateBundle) {
            await hook.handler.call(pluginCtx, naming as never, bundleObj, false);
            for (const [fileName, rec] of graph.emitted) {
                if (surfaced.has(fileName)) continue;
                surfaced.add(fileName);
                bundleObj[fileName] = outputAsset(fileName, rec) as unknown as GenerateBundleEntry;
            }
        }
        outputChunks = [];
        assets = [];
        for (const [key, entry] of Object.entries(bundleObj)) {
            // The KEY is the authority on where the file lands, but a plugin may also set a divergent
            // `fileName` — rollup validates both, so both are carried through.
            if (entry.type === 'asset') assets.push({ ...(entry as unknown as OutputAsset), fileName: entry.fileName ?? key });
            else outputChunks.push({ ...(entry as unknown as OutputChunk), fileName: entry.fileName ?? key });
        }
    }

    // FILE NAMES MUST STAY INSIDE THE OUTPUT DIRECTORY. A `entryFileNames` pattern like
    // `a/../../pwned.js`, or a plugin-emitted `/etc/passwd`, writes outside `output.dir` — rollup
    // treats that as an error rather than a warning, and so do we (`Bundle.ts:368`,
    // `logFileNameOutsideOutputDirectory`). Checked HERE, after every name is final, so a pattern, a
    // hash placeholder and a plugin emit are all covered by one gate.
    for (const name of [...outputChunks.map((c) => c.fileName), ...assets.map((a) => a.fileName)]) {
        if (isFileNameOutsideOutputDirectory(name))
            return failed(
                [
                    `The output file name "${name}" is not contained in the output directory. Make sure all file names are relative paths without ".." segments.`,
                ],
                warnings,
                linked,
                shaken,
            );
    }

    // Order: entry chunks first (in entry order), preserving discovery order otherwise.
    return {
        chunks: outputChunks,
        assets,
        errors: [],
        warnings,
        graph,
        linked,
        shaken,
        parseStats: graph.parseStats,
        renderStats,
        timings: Timer.report(timer),
    };
}

/**
 * Does this emitted file name escape the output directory?
 *
 * Transcribed from rollup's `isFileNameOutsideOutputDirectory` (`src/Bundle.ts:368`), including its
 * OWN `isAbsolute` rather than node's: rollup uses `/^(?:\/|(?:[A-Za-z]:)?[/\\|])/`
 * (`src/utils/path.ts:1`), which catches a Windows drive path (`C:\etc\passwd`) on POSIX too —
 * `node:path.isAbsolute` would not, and one of rollup's own fixtures asserts exactly that case.
 *
 * `join` normalises the `..` segments first, so `a/../../pwned.js` becomes `../pwned.js`.
 */
function isFileNameOutsideOutputDirectory(fileName: string): boolean {
    // `normalizePath` is our `join(fileName)`: same `..`/`.` resolution, except it yields '' where
    // node yields '.', so the empty result folds back to '.' before the checks.
    const normalized = (normalizePath(fileName) || '.').replaceAll('\\', '/');
    return (
        normalized === '..' ||
        normalized.startsWith('../') ||
        normalized === '.' ||
        /^(?:\/|(?:[A-Za-z]:)?[/\\|])/.test(normalized)
    );
}

/** Per-group fallbacks (top-level advancedChunks values, else engine defaults). */
type GroupDefaults = {
    minSize: number;
    maxSize: number;
    minModuleSize: number;
    maxModuleSize: number;
    minShareCount: number;
    includeDependenciesRecursively: boolean;
};

/** Engine defaults per rolldown MatchGroup (llm/libs/rolldown …/manual_code_splitting_options.rs
 *  + output-options.ts @default tags): minSize 0, maxSize ∞, minModuleSize 0, maxModuleSize ∞,
 *  minShareCount 1, priority 0, entriesAware false, entriesAwareMergeThreshold 0,
 *  includeDependenciesRecursively true. */
const ENGINE_GROUP_DEFAULTS: GroupDefaults = {
    minSize: 0,
    maxSize: Number.POSITIVE_INFINITY,
    minModuleSize: 0,
    maxModuleSize: Number.POSITIVE_INFINITY,
    minShareCount: 1,
    includeDependenciesRecursively: true,
};

/** Normalize one public group → a {@link ResolvedGroup}. `name`/`test` function forms are
 *  threaded the `{ getModuleInfo }` meta; a string `name` becomes `() => name`; `test` compiles
 *  to a predicate (string → substring match, RegExp → `re.test`, fn → threaded) or `null`. */
function normalizeGroup(g: CodeSplittingGroup, index: number, defaults: GroupDefaults, meta: ChunkMeta): ResolvedGroup {
    const gName = g.name;
    const nameFn: (id: string) => string | null = typeof gName === 'function' ? (id) => gName(id, meta) : () => gName;
    let testFn: ((id: string) => boolean) | null = null;
    if (typeof g.test === 'string') {
        const t = g.test;
        testFn = (id) => id.includes(t);
    } else if (g.test instanceof RegExp) {
        const re = g.test;
        testFn = (id) => re.test(id);
    } else if (typeof g.test === 'function') {
        const fn = g.test;
        testFn = (id) => fn(id, meta);
    }
    return {
        name: nameFn,
        test: testFn,
        priority: g.priority ?? 0,
        minSize: g.minSize ?? defaults.minSize,
        maxSize: g.maxSize ?? defaults.maxSize,
        minModuleSize: g.minModuleSize ?? defaults.minModuleSize,
        maxModuleSize: g.maxModuleSize ?? defaults.maxModuleSize,
        minShareCount: g.minShareCount ?? defaults.minShareCount,
        entriesAware: g.entriesAware ?? false,
        entriesAwareMergeThreshold: g.entriesAwareMergeThreshold ?? 0,
        initialOnly: (g.tags ?? []).includes('$initial'),
        includeDependenciesRecursively: g.includeDependenciesRecursively ?? defaults.includeDependenciesRecursively,
        index,
    };
}

/** Resolve user `output` options into {@link ChunkOptions}, normalizing codeSplitting groups,
 *  advancedChunks, and manualChunks (fn/object) → the same {@link ResolvedGroup}[] the engine
 *  consumes, and inlineDynamicImports → codeSplitting:false. */
function resolveChunkOptions(
    output: OutputOptions | undefined,
    entryCount: number,
    warnings: string[],
    getModuleInfo: (id: string) => ModuleInfo | null,
    /** Ids a plugin resolved as external — see `Graph.externalIds`. */
    externalIds: ReadonlySet<string> = new Set(),
): ChunkOptions {
    const cs = output?.codeSplitting;
    const inline = output?.inlineDynamicImports === true;
    let codeSplitting = cs !== false && !inline;
    if (inline && entryCount > 1) {
        warnings.push('inlineDynamicImports is only valid with a single input — ignored for multi-entry');
        codeSplitting = true;
    }
    const meta: ChunkMeta = { getModuleInfo };
    const groups: ResolvedGroup[] = [];
    let index = 0;
    const add = (g: CodeSplittingGroup, defaults: GroupDefaults): void => {
        groups.push(normalizeGroup(g, index++, defaults, meta));
    };

    // codeSplitting.groups (legacy inline form) → groups with engine defaults.
    if (typeof cs === 'object' && cs.groups !== undefined) {
        for (const g of cs.groups) add(g, ENGINE_GROUP_DEFAULTS);
    }

    const adv = output?.advancedChunks;
    if (adv !== undefined) {
        // Group-level minSize/maxSize/… fall back to the top-level advancedChunks values, then
        // engine defaults (mirrors rolldown's CodeSplittingOptions global fallbacks).
        const defaults: GroupDefaults = {
            minSize: adv.minSize ?? ENGINE_GROUP_DEFAULTS.minSize,
            maxSize: adv.maxSize ?? ENGINE_GROUP_DEFAULTS.maxSize,
            minModuleSize: adv.minModuleSize ?? ENGINE_GROUP_DEFAULTS.minModuleSize,
            maxModuleSize: adv.maxModuleSize ?? ENGINE_GROUP_DEFAULTS.maxModuleSize,
            minShareCount: adv.minShareCount ?? ENGINE_GROUP_DEFAULTS.minShareCount,
            includeDependenciesRecursively:
                adv.includeDependenciesRecursively ?? ENGINE_GROUP_DEFAULTS.includeDependenciesRecursively,
        };
        for (const g of adv.groups) add(g, defaults);
        // Precedence: advancedChunks wins; manualChunks (if also present) is ignored.
        if (output?.manualChunks !== undefined) {
            warnings.push('both advancedChunks and manualChunks are set — manualChunks is ignored');
        }
    } else if (output?.manualChunks !== undefined) {
        // `inlineDynamicImports` collapses everything into ONE chunk, so there is nothing for
        // `manualChunks` to assign — rollup rejects the combination rather than silently dropping
        // one of them, which is what we did.
        if (inline) {
            throw new Error(
                'Invalid value for option "output.manualChunks" - this option is not supported for "output.inlineDynamicImports".',
            );
        }
        const mc = output.manualChunks;
        if (typeof mc === 'function') {
            // fn form → one group whose `name` is the fn; deps NOT pulled in (Rollup semantics:
            // only the modules the fn names land in the chunk).
            add({ name: (id, m) => mc(id, m) ?? null, includeDependenciesRecursively: false }, ENGINE_GROUP_DEFAULTS);
        } else {
            // object map { chunkName: [ids] } → one group per entry; listed modules + their deps
            // land in the chunk (Rollup semantics → includeDependenciesRecursively: true).
            // A module may belong to ONE manual chunk. rollup errors rather than picking a winner
            // (`logInvalidChunk`, `Chunk.ts`), because the "winner" would be silent and arbitrary —
            // our group machinery would have resolved it by priority, which is the advancedChunks
            // model, not this one.
            const claimedBy = new Map<string, string>();
            for (const [chunkName, ids] of Object.entries(mc)) {
                for (const id of ids) {
                    // An EXTERNAL module is never emitted, so it cannot be put in a chunk. rollup
                    // errors; we silently produced a group that could never match anything.
                    if (externalIds.has(id)) {
                        throw new Error(
                            `"${id}" cannot be included in manualChunks because it is resolved as an external module by the "external" option or plugins.`,
                        );
                    }
                    const prior = claimedBy.get(id);
                    if (prior !== undefined && prior !== chunkName) {
                        throw new Error(
                            // rollup prints a cwd-relative id (`relativeId`); ours is relative to
                            // `output.dir`, with the `./` prefix dropped to match its shape.
                            `Cannot assign "${relativePath(output?.dir ?? '', id).replace(/^\.\//, '')}" to the "${chunkName}" chunk as it is already in the "${prior}" chunk.`,
                        );
                    }
                    claimedBy.set(id, chunkName);
                }
            }
            for (const [chunkName, ids] of Object.entries(mc)) {
                const idSet = new Set(ids);
                add(
                    {
                        name: () => chunkName,
                        test: (id) => idSet.has(id),
                        includeDependenciesRecursively: true,
                    },
                    ENGINE_GROUP_DEFAULTS,
                );
            }
        }
    }
    return { codeSplitting, preserveModules: output?.preserveModules === true, groups, keepNames: output?.keepNames === true };
}

/** A persistent, incremental build handle (esbuild `Context.Rebuild` lineage). Holds a
 *  module parse cache across rebuilds, so unchanged modules skip parse/analyze/extract. */
export type BuildContext = {
    /** Rebuild from the current sources, reusing unchanged modules. Read `.parseStats` on
     *  the result for the parse/reuse counts. Pass the {@link FileEvent}s from a {@link Watcher}
     *  to prune caches for deleted files; `update`/`create` are detected by source hash. */
    rebuild(events?: FileEvent[]): Promise<BundleResult>;
    /** Drop a module's cached parse so the next rebuild re-parses it (e.g. a known edit). */
    invalidate(id: string): void;
    /** Release the cache. */
    close(): void;
};

export function createBuildContext(options: BundleOptions): BuildContext {
    const cache: ParseCache = new Map();
    const renderCache: RenderCache = new Map();
    const moduleRenderCache: ModuleRenderCache = { modules: new Map(), namesHash: -1 };
    const treeshakeCache: TreeshakeCache = { moduleIds: [], infos: [], decls: [] };
    return {
        rebuild: (events?: FileEvent[]) => {
            // With a change signal (a Watcher), enter SIGNAL MODE: only the changed ids are
            // re-loaded/transformed/hashed/parsed; every other module is reconstructed from cache
            // (resolution still runs, so create/delete stay correct). A `delete` also prunes the
            // id-keyed caches so a later recreate can't reuse stale artifacts. Without events, the
            // build auto-detects changes by hashing every module (the safe default).
            let incremental: { changed: Set<string> } | undefined;
            if (events !== undefined) {
                const changed = new Set<string>();
                for (const e of events) {
                    if (e.kind === 'delete') {
                        cache.delete(e.id);
                        moduleRenderCache.modules.delete(e.id);
                    } else changed.add(e.id); // update | create
                }
                incremental = { changed };
            }
            return bundle({ ...options, cache, renderCache, moduleRenderCache, treeshakeCache, incremental });
        },
        invalidate: (id) => void cache.delete(id),
        close: () => {
            cache.clear();
            renderCache.clear();
            moduleRenderCache.modules.clear();
            moduleRenderCache.namesHash = -1;
            treeshakeCache.moduleIds = [];
            treeshakeCache.infos = [];
            treeshakeCache.decls = [];
        },
    };
}
