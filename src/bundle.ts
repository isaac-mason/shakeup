import { resetInferredPure } from './analysis/effects';
import { stampPureCallsGraph } from './analysis/purity';
import { compressChunk } from './chunk-compress';
import { buildChunkGraph, type Chunk, type ChunkGraph, type ChunkOptions, type ResolvedGroup } from './chunk-graph';
import { basenameOf, dirnameOf, type Fs, normalizePath, relativePath } from './fs';
import type {
    ModuleRenderCache,
    ModuleReuse,
    PreliminaryFileName,
    RenderCtx,
    RenderedChunk,
    RenderStats,
} from './generate/context.ts';
import { renderEsm } from './generate/esm.ts';
import { renderModules } from './generate/modules.ts';
import { externalKey, type Graph, type Linked, type ParseCache, type ParseStats, packRef, refMod, refSym } from './graph-types';
import { computeInteropOwners } from './init-obligations';
import { linkGraph } from './link';
import {
    DEFAULT_HASH_SIZE,
    getHashPlaceholderGenerator,
    type HashPlaceholderGenerator,
    makeUnique,
    type NormalizedOutputNaming,
    normalizeOutputOptions,
    type OutputOptionsNaming,
    type PreRenderedChunk,
    renderNamePattern,
    replacePlaceholders,
    replacePlaceholdersWithDefaultAndGetContainedPlaceholders,
    replaceSinglePlaceholder,
    resolveMinify,
} from './output-options';
import { type CompressMode, runCompress } from './passes/compress';
import { inlineCrossModule } from './passes/optimize/inline-functions';
import { compilePipeline, type GenerateBundleEntry, type ModuleInfo, type PluginCtx } from './plugin';
import type { GraphOptions } from './resolve';
import { buildGraph, hashSource, resolveEmittedFileName, toModuleInfo } from './scan';
import { composeMappings, encodeMappings, inlineSourceMapComment, joinParts, type Part, type SourceMap } from './sourcemap';
import { type TreeshakeCache, type TreeshakeResult, treeshake } from './treeshake';
import * as Timer from './util/timer';
import type { FileEvent } from './watch';

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
};

export type BundleOptions = GraphOptions & {
    treeshake?: boolean;
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
    fileName: string;
    /** Logical name (entry name, group name, or derived). */
    name: string;
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
    code: string;
    map?: SourceMap;
};

/** A non-chunk output file: a `.map` sidecar, or an asset a plugin emitted via `ctx.emitFile`
 *  (bytes for a binary asset, a string for text). */
export type OutputAsset = { fileName: string; source: string | Uint8Array };

/** `map` is present iff `sourcemap` was set (and no `renderChunk` plugin rewrote the chunk). */
export type BundleResult = {
    /** @deprecated single-chunk convenience alias for the ENTRY chunk's `code`. */
    code: string;
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
    /** @deprecated alias for the entry chunk's `map`. */
    map?: SourceMap;
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
            const fileName = resolveEmittedFileName({ type: 'asset', name, source: bytes });
            if (!graph.emitted.has(fileName)) graph.emitted.set(fileName, bytes);
            rec.assetFileName = fileName;
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
    const pipeline = compilePipeline(options.plugins ?? []);
    const warningsOut: string[] = [];
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
        fs: options.fs,
        resolve: () => null,
        emitFile: (file) => {
            // Only reached from renderChunk/buildEnd, which run after `graph` is built.
            const fileName = resolveEmittedFileName(file);
            if (!graph.emitted.has(fileName)) graph.emitted.set(fileName, file.source);
            return fileName;
        },
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
            return idx === undefined ? null : toModuleInfo(graph, graph.modules[idx]);
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
    graph = await buildGraph({ ...options, compress: compressForScan, optimize: options.output?.optimize ?? true }, pipeline);
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
        code: '',
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
    Timer.start(timer, 'treeshake');
    const shaken = options.treeshake === false ? null : treeshake(graph, linked, options.treeshakeCache);
    Timer.end(timer, 'treeshake');

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
    const chunkGraph = buildChunkGraph(graph, linked, chunkOptions, shaken?.deadDynamic);
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
                interopOwners,
                warnings,
                naming,
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

    let outputChunks: OutputChunk[];
    let assets: OutputAsset[];
    Timer.start(timer, 'render');
    try {
        const r = renderChunks(chunkGraph, naming, renderer, (i) => graph.modules[i].id, min.compress, min.mangle, inc);
        outputChunks = r.chunks;
        assets = r.assets;
    } catch (e) {
        return failed([(e as Error).message], warnings, linked, shaken);
    }
    Timer.end(timer, 'render');

    // renderChunk plugin hook: run per emitted chunk (rewrites drop that chunk's sourcemap).
    for (let i = 0; i < outputChunks.length; i++) {
        const oc = outputChunks[i];
        for (const hook of pipeline.renderChunk) {
            const raw = hook.handler.call(pluginCtx, oc.code);
            // rollup's `renderChunk` may return either a string or `{ code, map }`, and plugins
            // written against rollup return the object form. It used to be assigned straight to
            // `oc.code`, so the chunk was emitted as the string `[object Object]` — no error, no
            // warning, just a destroyed bundle.
            const result = typeof raw === 'object' && raw !== null ? raw.code : raw;
            if (result !== null && result !== undefined && result !== oc.code) {
                oc.code = result;
                if (oc.map !== undefined) {
                    oc.map = undefined;
                    warnings.push('sourcemap omitted: a renderChunk plugin rewrote the chunk');
                }
            }
        }
    }
    // AWAITED, and in parallel — Rollup documents `buildEnd` as `Kind: async, parallel` and says
    // "you can also return a Promise" (`docs/plugin-development/index.md:304-313`). Calling it and
    // walking away meant an async `buildEnd` neither blocked the build nor surfaced its error: the
    // rejection escaped as an unhandled one and took the whole process down, well after `bundle()`
    // had already returned a clean result. Found by `pnpm rollupsuite`, which crashed on
    // `validate-resolved-by-logic` rather than reporting it.
    await Promise.all(pipeline.buildEnd.map((hook) => hook.handler.call(pluginCtx)));
    warnings.push(...warningsOut.splice(0));

    // plugin ctx.emitFile assets (content-hashed fileName → source), collected across graph build +
    // renderChunk/buildEnd. Appended after buildEnd so a late emit still lands in the output.
    for (const [fileName, source] of graph.emitted) assets.push({ fileName, source });

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
        for (const hook of pipeline.generateBundle) await hook.handler.call(pluginCtx, naming as never, bundleObj, false);
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

    // Order: entry chunks first (in entry order), preserving discovery order otherwise. The
    // `code`/`map` aliases point at the FIRST entry chunk (back-compat).
    const entryFirst = outputChunks[0];
    return {
        code: entryFirst?.code ?? '',
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
        map: entryFirst?.map,
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

/** Render one chunk: its modules, then its output format. Kept as a named composition so the two
 *  passes and their one hand-off stay visible at a single place. */
function renderChunk(ctx: RenderCtx, prelim: PreliminaryFileName, reuse: ModuleReuse | null): RenderedChunk | null {
    return renderEsm(ctx, renderModules(ctx, reuse), prelim);
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
    return { codeSplitting, preserveModules: output?.preserveModules === true, groups };
}

/**
 * Two-pass deferred-hash render orchestration.
 *
 * A chunk's final `[hash]` hashes its final CONTENT, which includes the import-path strings to
 * the chunks it imports, which contain THOSE chunks' hashes — a fixpoint. We do not iterate:
 *   Pass 0  render each chunk with cross-chunk / dynamic import paths written as opaque HASH
 *           PLACEHOLDERS (`!~{…}~`) for hashed targets (the placeholder rides through render
 *           inside the import path string).
 *   Pass A  per hashed chunk, canonicalize its own-set placeholders to zeros and hash the
 *           result → a STABLE content hash + the set of referenced placeholders.
 *   Pass B  resolve each chunk's final hash over its own content hash folded with the CONTENT
 *           hashes (never the final hashes — that's the circular trap) of its entire transitive
 *           dependency closure. Cycles are fine: the worklist is a Set, so a mutual A↔B pair
 *           folds the same multiset deterministically.
 *   Pass C  substitute resolved fileNames back into every referencing chunk's specifiers.
 */

/** The per-chunk renderer. Given the target-path resolver and the addon strings, produces a
 *  {@link RenderedChunk} (or null for a dropped empty non-entry). */
export type ChunkRenderer = (
    chunk: Chunk,
    chunkIdx: number,
    prelim: PreliminaryFileName,
    pathToChunk: (targetChunkIdx: number) => string,
    wantMap: boolean,
) => RenderedChunk | null;

const preRenderedInfo = (chunk: Chunk, moduleIdOf: (i: number) => string): PreRenderedChunk => ({
    name: chunk.name,
    isEntry: chunk.isEntry,
    isDynamicEntry: chunk.isDynamicEntry,
    facadeModuleId: chunk.entryModule >= 0 ? moduleIdOf(chunk.entryModule) : null,
    moduleIds: chunk.modules.map(moduleIdOf),
    exports: [...chunk.exports.keys()].sort(),
    type: 'chunk',
});

/** Compute a chunk's preliminary filename: choose the entry vs chunk pattern, expand it
 *  (`[hash]` → placeholder, else reserve via `makeUnique`), and record the reservation in
 *  `reserved` (lowercased keyset). */
function getPreliminaryFileName(
    chunk: Chunk,
    naming: NormalizedOutputNaming,
    genPlaceholder: HashPlaceholderGenerator,
    reserved: Set<string>,
    info: PreRenderedChunk,
): PreliminaryFileName {
    // A single-chunk `file:` build uses its basename verbatim (no pattern, no hash).
    if (naming.file !== null) {
        const fileName = basenameOf(naming.file);
        reserved.add(fileName.toLowerCase());
        return { fileName, hashPlaceholder: null };
    }
    const isEntryLike = chunk.isEntry;
    const pattern = isEntryLike ? naming.entryFileNames : naming.chunkFileNames;
    const patternName = isEntryLike ? 'output.entryFileNames' : 'output.chunkFileNames';
    let hashPlaceholder: string | null = null;
    // Generate the placeholder once and cache it (a pattern may reference [hash] more than once).
    const hashReplacer = (size?: number): string => {
        if (hashPlaceholder === null) hashPlaceholder = genPlaceholder(patternName, size ?? DEFAULT_HASH_SIZE);
        return hashPlaceholder;
    };
    let fileName = renderNamePattern(typeof pattern === 'function' ? pattern(info) : pattern, patternName, {
        format: () => 'es',
        hash: hashReplacer,
        name: () => naming.sanitizeFileName(chunk.name),
    });
    if (hashPlaceholder === null) {
        fileName = makeUnique(fileName, reserved);
        reserved.add(fileName.toLowerCase());
    }
    return { fileName, hashPlaceholder };
}

type HashResult = { containedPlaceholders: Set<string>; contentHash: string };

/** A cached chunk render, reusable across builds. `code` holds cross-chunk hash placeholders
 *  rewritten to stable `!~⟦key⟧~` markers (per-build placeholders are re-injected on reuse), so
 *  it is independent of the placeholder counter. Keyed by the chunk's stable member-id list. */
export type CachedRender = {
    signature: string;
    code: string;
    parts: Part[];
    mapSources: string[];
    mapSourcesContent: string[];
    name: string;
    isEntry: boolean;
    isDynamicEntry: boolean;
    moduleIds: string[];
    imports: string[];
    dynamicImports: string[];
    exports: string[];
};
export type RenderCache = Map<string, CachedRender>;

/** Incremental render inputs: the persistent cache + the render-dirty module ids
 *  (`graph.changed ∪ graph.affected`) + a stats sink + per-module reuse context. */
export type RenderIncremental = { cache: RenderCache; dirty: Set<string>; stats: RenderStats; mod: ModuleReuse };

/** A chunk's stable cross-build identity: its member ids in exec order. Distinct chunks never
 *  share members, so this is unique; exec-order changes (which alter output) change it. */
function chunkKeyOf(chunk: Chunk, moduleIdOf: (i: number) => string): string {
    return chunk.modules.map(moduleIdOf).join('\x1f');
}

/** Order-independent hash of a live statement-id set (XOR-fold + size), for cheap liveness diffing. */
function hashLiveSet(set: Set<number>): number {
    let h = 0;
    for (const id of set) h = (h ^ Math.imul(id, 0x9e3779b1)) | 0;
    return (Math.imul(h, 31) + set.size) | 0;
}

/** Order-independent signature of every final name rendered this build (module locals, namespace
 *  objects, external import locals). Equal signatures ⇒ no name shifted, so any clean module's
 *  referenced names are stable and its cached text is reusable. */
function nameSignature(linked: Linked): number {
    let acc = 0;
    const fold = (key: string): void => {
        let h = 5381;
        for (let i = 0; i < key.length; i++) h = (Math.imul(h, 33) ^ key.charCodeAt(i)) | 0;
        acc = (acc + h) | 0;
    };
    for (const [ref, name] of linked.finalNames) fold(`f${ref}=${name}`);
    for (const [modIdx, name] of linked.namespaceOf) fold(`n${modIdx}=${name}`);
    for (const [key, name] of linked.externalLocals) fold(`e${key}=${name}`);
    return acc;
}

/** Everything that determines a chunk's rendered bytes EXCEPT its members' own source/binds
 *  (covered by the `dirty` check): member set + order, and all cross-chunk wiring (producers by
 *  stable key, imported/exported names, dynamic + side-effect targets). A change here invalidates. */
function chunkSignature(chunk: Chunk, keyOf: string[]): string {
    const imps = [...chunk.imports.entries()]
        .map(
            ([p, list]) =>
                `${keyOf[p]}>${list
                    .map((c) => `${c.imported}=${c.local}`)
                    .sort()
                    .join(',')}`,
        )
        .sort();
    const exps = [...chunk.exports.values()].map((e) => `${e.exportedName}=${e.local}`).sort();
    const dyn = [...chunk.dynamicImports].map((t) => keyOf[t]).sort();
    const side = [...chunk.sideEffectImports].map((p) => keyOf[p]).sort();
    return [
        `n:${chunk.name}`,
        `e:${chunk.isEntry ? 1 : 0}${chunk.isDynamicEntry ? 'd' : ''}`,
        `i:${imps.join(';')}`,
        `x:${exps.join(',')}`,
        `d:${dyn.join(',')}`,
        `s:${side.join(',')}`,
    ].join('\n');
}

/** Rewrite live per-build placeholders → stable `!~⟦targetKey⟧~` markers for the cache store. */
function toMarkers(code: string, keyByPlaceholder: Map<string, string>): string {
    let out = code;
    for (const [ph, key] of keyByPlaceholder) {
        if (out.includes(ph)) out = out.split(ph).join(`!~⟦${key}⟧~`);
    }
    return out;
}

/** Rewrite stable markers → this build's placeholders for a reused chunk. */
function fromMarkers(code: string, placeholderByKey: Map<string, string>): string {
    return code.replace(/!~⟦([\s\S]*?)⟧~/g, (m, key) => placeholderByKey.get(key) ?? m);
}

/**
 * Drive the whole two-pass flow. `chunkGraph` gives the partition; `naming` the resolved output
 * config; `render` the per-chunk text builder. Returns finalized {@link OutputChunk}s
 * (fileName/code/map placeholder-free) plus emitted `.map` asset entries. When `inc` is present,
 * a chunk whose members are all clean and whose signature is unchanged reuses its cached render.
 */
export function renderChunks(
    chunkGraph: ChunkGraph,
    naming: NormalizedOutputNaming,
    render: ChunkRenderer,
    moduleIdOf: (i: number) => string,
    /** Resolved compress mode. `'full'` runs the cosmetic tier over each assembled chunk. */
    compressMode: CompressMode | false,
    /** Mangle inside the chunk pass — set when link-time mangling was skipped so this can run last. */
    chunkMangle: boolean,
    inc?: RenderIncremental,
): { chunks: OutputChunk[]; assets: { fileName: string; source: string }[] } {
    const chunks = chunkGraph.chunks;
    const wantMap = naming.sourcemap !== false;
    const genPlaceholder = getHashPlaceholderGenerator();
    const reserved = new Set<string>();

    // Pre-render info (needed for pattern functions) computed once.
    const infos = chunks.map((c) => preRenderedInfo(c, moduleIdOf));

    // Pass 0a — reserve ENTRY chunk names first so no-hash `[name].js` names get stable,
    // un-suffixed reservation before shared/dynamic chunks.
    const prelim: PreliminaryFileName[] = new Array(chunks.length);
    for (let i = 0; i < chunks.length; i++) {
        if (chunks[i].isEntry) prelim[i] = getPreliminaryFileName(chunks[i], naming, genPlaceholder, reserved, infos[i]);
    }
    for (let i = 0; i < chunks.length; i++) {
        if (!chunks[i].isEntry) prelim[i] = getPreliminaryFileName(chunks[i], naming, genPlaceholder, reserved, infos[i]);
    }

    // The path from chunk `fromIdx` to chunk `toIdx`, relative to `from`'s directory, using the
    // preliminary (placeholder-bearing) filenames — so a hashed target's placeholder rides
    // through the render inside the import specifier.
    const pathFrom =
        (fromIdx: number) =>
        (toIdx: number): string =>
            relativePath(dirnameOf(prelim[fromIdx].fileName), prelim[toIdx].fileName);

    // Stable per-chunk keys + placeholder↔key maps for cross-build render reuse.
    const keyOf = chunks.map((c) => chunkKeyOf(c, moduleIdOf));
    const placeholderByKey = new Map<string, string>();
    const keyByPlaceholder = new Map<string, string>();
    for (let i = 0; i < chunks.length; i++) {
        const ph = prelim[i].hashPlaceholder;
        if (ph !== null) {
            placeholderByKey.set(keyOf[i], ph);
            keyByPlaceholder.set(ph, keyOf[i]);
        }
    }
    // A chunk is render-dirty if any member changed (body) or was affected (bind). A clean chunk
    // whose signature matches its cache reuses the render — signature captures member set/order +
    // all cross-chunk wiring names, so a producer's rename/move invalidates the importer too.
    const dirtyChunk = inc === undefined ? null : chunks.map((c) => c.modules.some((idx) => inc.dirty.has(moduleIdOf(idx))));

    // Pass 0b — render each chunk (or reuse its cached render with placeholders remapped).
    const rendered: RenderedChunk[] = [];
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const sig = inc !== undefined ? chunkSignature(chunk, keyOf) : '';
        const cached = inc !== undefined && dirtyChunk !== null && !dirtyChunk[i] ? inc.cache.get(keyOf[i]) : undefined;
        if (inc !== undefined && cached !== undefined && cached.signature === sig) {
            rendered.push({
                chunk,
                chunkIdx: i,
                prelim: prelim[i],
                code: fromMarkers(cached.code, placeholderByKey),
                parts: cached.parts,
                mapSources: cached.mapSources,
                mapSourcesContent: cached.mapSourcesContent,
                name: cached.name,
                isEntry: cached.isEntry,
                isDynamicEntry: cached.isDynamicEntry,
                moduleIds: cached.moduleIds,
                imports: cached.imports,
                dynamicImports: cached.dynamicImports,
                exports: cached.exports,
            });
            inc.stats.reused++;
            continue;
        }
        const rc = render(chunk, i, prelim[i], pathFrom(i), wantMap);
        if (rc === null) continue;
        // COSMETIC COMPRESS, over the assembled chunk — see `chunk-compress.ts`. Placed before the
        // chunk cache write (so a reused chunk skips it, rspack's content-addressed minimize cache
        // reached through the cache we already keep) and before hashing (placeholders are derived
        // from content, so compressing after would invalidate every hash).
        // Also runs for `{ mangle: true, compress: false }`: link-time mangling is gone, so this pass
        // is the only place a mangler runs at all.
        if (compressMode === 'full' || chunkMangle) {
            const joined = wantMap ? joinParts(rc.parts) : null;
            const done = compressChunk(rc.code, { minify: naming.minify }, wantMap, chunkMangle, compressMode === 'full');
            rc.code = done.code;
            // One part carrying the composed mapping: module→chunk (`joined`) then chunk→compressed
            // (`done.map`). `rc.parts` described the pre-compress text and is now meaningless.
            if (wantMap && joined !== null && done.map !== null) {
                rc.parts = [{ code: done.code, map: composeMappings(joined.map, done.map) }];
            }
        }
        if (inc !== undefined) {
            inc.cache.set(keyOf[i], {
                signature: sig,
                code: toMarkers(rc.code, keyByPlaceholder),
                parts: rc.parts,
                mapSources: rc.mapSources,
                mapSourcesContent: rc.mapSourcesContent,
                name: rc.name,
                isEntry: rc.isEntry,
                isDynamicEntry: rc.isDynamicEntry,
                moduleIds: rc.moduleIds,
                imports: rc.imports,
                dynamicImports: rc.dynamicImports,
                exports: rc.exports,
            });
            inc.stats.rendered++;
        }
        rendered.push(rc);
    }

    // Collect every chunk placeholder up-front.
    const placeholders = new Set<string>();
    for (const rc of rendered) if (rc.prelim.hashPlaceholder) placeholders.add(rc.prelim.hashPlaceholder);

    // Pass A — content hash per hashed chunk (stable, dependency-value-independent).
    const hashDependenciesByPlaceholder = new Map<string, HashResult>();
    for (const rc of rendered) {
        const ph = rc.prelim.hashPlaceholder;
        if (ph === null) continue;
        const { containedPlaceholders, transformedCode } = replacePlaceholdersWithDefaultAndGetContainedPlaceholders(
            rc.code,
            placeholders,
        );
        hashDependenciesByPlaceholder.set(ph, { containedPlaceholders, contentHash: naming.getHash(transformedCode) });
    }

    // Pass B — final hashes via transitive closure (fold CONTENT hashes, never FINAL hashes).
    const hashesByPlaceholder = new Map<string, string>();
    for (const placeholder of placeholders) {
        const rc = rendered.find((r) => r.prelim.hashPlaceholder === placeholder)!;
        let contentToHash = '';
        // A Set used as a growing BFS queue: `.add` during for..of extends the live iteration,
        // so this walks the ENTIRE transitive dependency closure in one loop. Cycles terminate
        // because the Set dedups.
        const worklist = new Set<string>([placeholder]);
        for (const dep of worklist) {
            const hr = hashDependenciesByPlaceholder.get(dep)!;
            // Fold the dependency's STABLE CONTENT hash (Pass A), NOT its final hash (which would
            // be circular / order-dependent for A↔B cycles).
            contentToHash += hr.contentHash;
            for (const c of hr.containedPlaceholders) worklist.add(c);
        }
        let finalFileName: string;
        let finalHash = '';
        do {
            if (finalHash) contentToHash = finalHash; // hash-of-hash on filename collision
            finalHash = naming.getHash(contentToHash).slice(0, placeholder.length);
            finalFileName = replaceSinglePlaceholder(rc.prelim.fileName, placeholder, finalHash);
        } while (reserved.has(finalFileName.toLowerCase()));
        reserved.add(finalFileName.toLowerCase());
        hashesByPlaceholder.set(placeholder, finalHash);
    }

    // Pass C — substitute resolved fileNames into every chunk's code + own fileName, then emit
    // the sourcemap variant. Order: hashed chunks then non-hashed (both need substitution since
    // a non-hashed chunk's import paths may point at hashed chunks).
    const outChunks: OutputChunk[] = [];
    const assets: { fileName: string; source: string }[] = [];
    for (const rc of rendered) {
        let code = hashesByPlaceholder.size > 0 ? replacePlaceholders(rc.code, hashesByPlaceholder) : rc.code;
        const fileName =
            rc.prelim.hashPlaceholder !== null || hashesByPlaceholder.size > 0
                ? replacePlaceholders(rc.prelim.fileName, hashesByPlaceholder)
                : rc.prelim.fileName;

        let map: SourceMap | undefined;
        if (wantMap) {
            const joined = joinParts(rc.parts);
            const sourcesContent = naming.sourcemapExcludeSources ? undefined : rc.mapSourcesContent;
            const ignore: number[] = [];
            for (let i = 0; i < rc.mapSources.length; i++) {
                if (naming.sourcemapIgnoreList(rc.mapSources[i], `${fileName}.map`)) ignore.push(i);
            }
            map = {
                version: 3,
                file: basenameOf(fileName),
                sources: rc.mapSources,
                sourcesContent,
                names: [],
                mappings: encodeMappings(joined.map),
                ...(ignore.length > 0 ? { x_google_ignoreList: ignore } : {}),
            };
            // Emit + comment. Appended AFTER hashing so it never perturbs the content hash.
            const mapFileName = `${fileName}.map`;
            if (naming.sourcemap === 'inline') {
                code += `${inlineSourceMapComment(map)}\n`;
            } else {
                assets.push({ fileName: mapFileName, source: JSON.stringify(map) });
                if (naming.sourcemap !== 'hidden') code += `//# sourceMappingURL=${basenameOf(mapFileName)}\n`;
            }
        }

        outChunks.push({
            fileName,
            name: rc.name,
            isEntry: rc.isEntry,
            isDynamicEntry: rc.isDynamicEntry,
            moduleIds: rc.moduleIds,
            imports: rc.imports,
            dynamicImports: rc.dynamicImports,
            exports: rc.exports,
            code,
            map,
        });
    }
    return { chunks: outChunks, assets };
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
