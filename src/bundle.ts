import { symbolOf } from './analysis/semantic';
import { N, type Node, walk } from './ast';
import { buildChunkGraph, type Chunk, type ChunkGraph, type ChunkOptions, type ResolvedGroup } from './chunk-graph';
import { basenameOf, dirnameOf, type Fs, relativePath } from './fs';
import {
    externalKey,
    type Graph,
    type ImportBind,
    type Linked,
    type Module,
    type ParseCache,
    type ParseStats,
    packRef,
} from './graph-types';
import { finalNameOf, linkGraph } from './link';
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
import type { Edit } from './patches';
import { compilePipeline, type ModuleInfo, type PluginCtx } from './plugin';
import { printModule } from './print/print-js';
import { createPrinter, finishPrinter } from './print/printer';
import type { GraphOptions } from './resolve';
import { buildGraph, resolveEmittedFileName, toModuleInfo } from './scan';
import {
    buildLineTable,
    encodeMappings,
    inlineSourceMapComment,
    joinParts,
    type Part,
    type SourceMap,
    trimMappings,
} from './sourcemap';
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
export type ManualChunks =
    | ((id: string, meta: ChunkMeta) => string | null | undefined)
    | Record<string, string[]>;

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

type EmitCtx = {
    graph: Graph;
    linked: Linked;
    mod: Module;
    edits: Edit[];
    warnings: string[];
    live: Set<number> | null;
    /** The chunk this module is being rendered into (null in link-only helpers). */
    chunk: Chunk | null;
    chunkGraph: ChunkGraph | null;
    /** Resolve a target chunk idx to the import specifier this chunk uses for it (relative
     *  path over preliminary/placeholder-bearing filenames). Null in link-only. */
    pathToChunk: ((targetChunkIdx: number) => string) | null;
};

/** Final output name for an Ident node's symbol, or null if unchanged. */
function renameOf(ctx: EmitCtx, identNode: Node): string | null {
    const sym = symbolOf(ctx.mod.semantic, identNode);
    if (sym === 0) return null;
    const imp = ctx.mod.namedImports.get(sym);
    if (imp !== undefined) {
        const bind = ctx.linked.binds.get(packRef(ctx.mod.idx, sym));
        if (bind === undefined) return null;
        return nameOfBind(ctx.linked, bind, ctx.chunk);
    }
    const renamed = ctx.linked.finalNames.get(packRef(ctx.mod.idx, sym));
    return renamed ?? null;
}

/** Resolve a bind to the identifier it renders as, in the perspective of `chunk` (the
 *  consuming chunk). A `found`/`namespace` bind whose producer lives in ANOTHER chunk renders
 *  as this chunk's cross-chunk import LOCAL (recorded during wiring); a same-chunk bind
 *  renders as the producer's final name. `chunk === null` = single-scope (whole-bundle). */
function nameOfBind(linked: Linked, bind: ImportBind, chunk: Chunk | null): string | null {
    switch (bind.kind) {
        case 'found': {
            if (chunk !== null) {
                const local = chunk.importLocalOf.get(bind.ref);
                if (local !== undefined) return local;
            }
            return finalNameOf(linked, bind.ref);
        }
        case 'namespace': {
            if (chunk !== null) {
                const local = chunk.nsImportLocalOf.get(bind.module);
                if (local !== undefined) return local;
            }
            return linked.namespaceOf.get(bind.module) ?? null;
        }
        case 'external':
            return linked.externalLocals.get(externalKey(bind.specifier, bind.name)) ?? null;
        case 'none':
            return null;
    }
}

/** The printer backend drops import/export statements itself, but still needs the side-effect-import
 *  and entry-star tracking that their removal implies — this records it without producing edits. */
function trackChunkSpecs(ctx: EmitCtx, isEntry: boolean, entryStarSpecs: string[], sideEffectSpecs: Set<string>): void {
    const { mod } = ctx;
    const src = mod.source;
    for (const statement of mod.program.data.body) {
        if (ctx.live !== null && !ctx.live.has(statement.id)) continue;
        if (statement.type === N.ImportDeclaration) {
            if (statement.data.importKind === 'type') continue;
            const source = statement.data.source;
            if (source.type === N.StringLiteral && statement.data.specifiers.length === 0) {
                const spec = src.slice(source.start + 1, source.end - 1);
                const rec = mod.importRecords.find((r) => r.specifier === spec);
                if (rec?.external) sideEffectSpecs.add(spec);
            }
        } else if (statement.type === N.ExportAllDeclaration) {
            const source = statement.data.source;
            const spec = source.type === N.StringLiteral ? src.slice(source.start + 1, source.end - 1) : '';
            const rec = mod.importRecords.find((r) => r.specifier === spec);
            if (rec?.external) {
                if (isEntry) entryStarSpecs.push(spec);
                else
                    ctx.warnings.push(
                        `'export * from "${spec}"' in non-entry module '${mod.id}' is dropped (external star re-export)`,
                    );
            }
        }
    }
}

/** Pre-resolve the node-level rewrites the edit engine applies inline — dynamic `import()`
 *  retargeting ({@link rewriteDynamicImports}) and `new URL` asset URLs ({@link rewriteNewUrlAssets})
 *  — into a node→text map the printer consults. Keyed on the exact node whose text is replaced
 *  (the whole `import()` for same-chunk/dropped; the specifier string otherwise). */
function collectLinkOverrides(ctx: EmitCtx): Map<Node, string> {
    const { mod, chunk, chunkGraph } = ctx;
    const map = new Map<Node, string>();
    walk(mod.program, (n) => {
        if (n.type === N.ImportExpression && chunk !== null && chunkGraph !== null) {
            const source = n.data.source;
            if (source.type === N.StringLiteral) {
                const spec = mod.source.slice(source.start + 1, source.end - 1);
                const rec = mod.importRecords.find((r) => r.specifier === spec);
                if (rec !== undefined && !rec.external && rec.resolved >= 0) {
                    const targetChunk = chunkGraph.chunkByModule[rec.resolved];
                    if (targetChunk < 0) {
                        map.set(n, 'Promise.resolve({})');
                    } else if (targetChunk === chunkGraph.chunkByModule[mod.idx]) {
                        const nsName = ctx.linked.namespaceOf.get(rec.resolved);
                        map.set(n, `Promise.resolve().then(() => ${nsName ?? '{}'})`);
                    } else {
                        const path =
                            ctx.pathToChunk !== null
                                ? ctx.pathToChunk(targetChunk)
                                : `./${chunkGraph.chunks[targetChunk].name}.js`;
                        map.set(source, `'${path}'`);
                    }
                }
            }
        }
        if (
            n.type === N.NewExpression &&
            n.data.arguments.length === 2 &&
            n.data.callee.type === N.IdentifierReference &&
            n.data.callee.name === 'URL'
        ) {
            const base = n.data.arguments[1];
            if (
                base.type === N.StaticMemberExpression &&
                base.data.object.type === N.ImportMeta &&
                base.data.property.name === 'url'
            ) {
                const spec = n.data.arguments[0];
                if (spec.type === N.StringLiteral) {
                    const specifier = mod.source.slice(spec.start + 1, spec.end - 1);
                    const rec = mod.importRecords.find((r) => r.kind === 'new-url' && r.specifier === specifier);
                    if (rec?.assetFileName !== undefined) map.set(spec, JSON.stringify(rec.assetFileName));
                }
            }
        }
    });
    return map;
}

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
    for (const mod of graph.modules) {
        for (const [sym, imp] of mod.namedImports) {
            const rec = mod.importRecords[imp.rec];
            if (!rec.external) continue;
            const key = externalKey(rec.specifier, imp.name);
            const ref = packRef(mod.idx, sym);
            const sideEffectFree = graph.externalSideEffects.get(rec.specifier) === false || runtimeSyms.has(ref);
            if (!sideEffectFree || liveRefs.has(ref)) kept.add(key);
            else candidates.add(key);
        }
    }
    for (const key of candidates) if (!kept.has(key)) linked.externalLocals.delete(key);
}

function renderExternalImports(linked: Linked, sideEffectSpecs: Set<string>): string[] {
    const bySpec = new Map<string, { name: string; local: string }[]>();
    for (const [key, local] of linked.externalLocals) {
        const sep = key.indexOf('\x00');
        const spec = key.slice(0, sep);
        const name = key.slice(sep + 1);
        let list = bySpec.get(spec);
        if (list === undefined) {
            list = [];
            bySpec.set(spec, list);
        }
        list.push({ name, local });
    }
    const lines: string[] = [];
    for (const [spec, entries] of bySpec) {
        sideEffectSpecs.delete(spec);
        const star = entries.find((e) => e.name === '*');
        if (star !== undefined) lines.push(`import * as ${star.local} from '${spec}';`);
        const def = entries.find((e) => e.name === 'default');
        const named = entries.filter((e) => e.name !== '*' && e.name !== 'default');
        if (def !== undefined || named.length > 0) {
            const namedPart =
                named.length > 0
                    ? `{ ${named.map((e) => (e.name === e.local ? e.name : `${e.name} as ${e.local}`)).join(', ')} }`
                    : '';
            const clauses = [def !== undefined ? def.local : '', namedPart].filter((s) => s !== '').join(', ');
            lines.push(`import ${clauses} from '${spec}';`);
        }
    }
    for (const spec of sideEffectSpecs) lines.push(`import '${spec}';`);
    return lines;
}

const isIdentName = (s: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);

function renderNamespaceObject(linked: Linked, modIdx: number, chunk: Chunk | null, nsMembers: Set<string> | undefined): string {
    const nsName = linked.namespaceOf.get(modIdx)!;
    const map = linked.exportMaps.get(modIdx);
    const entries: string[] = [];
    if (map !== undefined) {
        for (const [name, bind] of map) {
            // Narrowed target: emit only the members its consumers read (tree-shake seeded exactly
            // these live). Absent set → whole surface (target escaped / entry / dynamic).
            if (nsMembers !== undefined && !nsMembers.has(name)) continue;
            const value = nameOfBind(linked, bind, chunk);
            if (value === null) continue;
            entries.push(`${isIdentName(name) ? name : JSON.stringify(name)}: ${value}`);
        }
    }
    return `const ${nsName} = Object.freeze({ ${entries.join(', ')} });`;
}

/** Build, link, tree-shake, and assemble the entry module into a single ESM chunk. */
export async function bundle(options: BundleOptions): Promise<BundleResult> {
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
    graph = await buildGraph({ ...options, compress: resolveMinify(options.output?.minify).compress }, pipeline);
    // Generate-stage asset emit: read + content-hash resolved `new-url` assets (scan only resolved
    // their paths). Before the error gate so an asset load failure surfaces like a scan error.
    await emitAssets(graph, options.fs);
    Timer.end(timer, 'graph');
    if (graph.errors.length > 0 || graph.entries.length === 0) {
        return {
            code: '',
            chunks: [],
            errors: graph.errors,
            warnings: [],
            graph,
            linked: null,
            shaken: null,
            parseStats: graph.parseStats,
        };
    }
    // Link WITHOUT whole-bundle deconflict — the per-chunk deconflict inside buildChunkGraph
    // assigns names in fresh per-chunk scopes. For a single chunk this reproduces the
    // whole-bundle names byte-for-byte (same order, same taken seeding).
    Timer.start(timer, 'link');
    const linked = linkGraph(graph); // Link binds+sorts only; per-chunk deconflict runs in buildChunkGraph
    Timer.end(timer, 'link');
    if (linked.errors.length > 0) {
        return {
            code: '',
            chunks: [],
            errors: linked.errors,
            warnings: [],
            graph,
            linked,
            shaken: null,
            parseStats: graph.parseStats,
        };
    }

    const warnings: string[] = [...warningsOut, ...graph.warnings];
    // Tree-shake per module before chunk assembly. Uses binds/exportMaps, not names.
    Timer.start(timer, 'treeshake');
    const shaken = options.treeshake === false ? null : treeshake(graph, linked, options.treeshakeCache);
    Timer.end(timer, 'treeshake');

    // Assign chunks → wire cross-chunk imports/exports → per-chunk deconflict.
    Timer.start(timer, 'chunk');
    const chunkOptions = resolveChunkOptions(options.output, graph.entries.length, warnings, pluginCtx.getModuleInfo);
    const min = resolveMinify(options.output?.minify);
    const chunkGraph = buildChunkGraph(graph, linked, chunkOptions, shaken?.deadDynamic, min.mangle);
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
        return {
            code: '',
            chunks: [],
            errors: [(e as Error).message],
            warnings,
            graph,
            linked,
            shaken,
            parseStats: graph.parseStats,
        };
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
        const mod: ModuleRenderCtx = {
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
        renderChunk(graph, linked, chunkGraph, chunk, ci, shaken, warnings, want, naming, pathToChunk, prelim, inc?.mod ?? null);

    let outputChunks: OutputChunk[];
    let assets: OutputAsset[];
    Timer.start(timer, 'render');
    try {
        const r = renderChunks(chunkGraph, naming, renderer, (i) => graph.modules[i].id, inc);
        outputChunks = r.chunks;
        assets = r.assets;
    } catch (e) {
        return {
            code: '',
            chunks: [],
            errors: [(e as Error).message],
            warnings,
            graph,
            linked,
            shaken,
            parseStats: graph.parseStats,
        };
    }
    Timer.end(timer, 'render');

    // renderChunk plugin hook: run per emitted chunk (rewrites drop that chunk's sourcemap).
    for (let i = 0; i < outputChunks.length; i++) {
        const oc = outputChunks[i];
        for (const hook of pipeline.renderChunk) {
            const result = hook.handler(pluginCtx, oc.code);
            if (result !== null && result !== undefined && result !== oc.code) {
                oc.code = result;
                if (oc.map !== undefined) {
                    oc.map = undefined;
                    warnings.push('sourcemap omitted: a renderChunk plugin rewrote the chunk');
                }
            }
        }
    }
    for (const hook of pipeline.buildEnd) hook.handler(pluginCtx);
    warnings.push(...warningsOut.splice(0));

    // plugin ctx.emitFile assets (content-hashed fileName → source), collected across graph build +
    // renderChunk/buildEnd. Appended after buildEnd so a late emit still lands in the output.
    for (const [fileName, source] of graph.emitted) assets.push({ fileName, source });

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

/** Render one chunk to a {@link RenderedChunk} (placeholders unresolved), or null if it is an
 *  empty non-entry chunk. Cross-chunk `import`/`export` lines are synthesized from
 *  `chunk.imports`/`chunk.exports`, their paths resolved via `pathToChunk` (preliminary,
 *  placeholder-bearing filenames — the real hashed path is substituted in pass C). Banner/intro
 *  are prepended as SYNTHETIC leading map Parts so the per-chunk sourcemap stays in offset. */
function renderChunk(
    graph: Graph,
    linked: Linked,
    chunkGraph: ChunkGraph,
    chunk: Chunk,
    chunkIdx: number,
    shaken: TreeshakeResult | null,
    warnings: string[],
    wantMap: boolean,
    naming: NormalizedOutputNaming,
    pathToChunk: (targetChunkIdx: number) => string,
    prelim: PreliminaryFileName,
    modInc: ModuleRenderCtx | null,
): RenderedChunk | null {
    const entryStarSpecs: string[] = [];
    const sideEffectSpecs = new Set<string>();
    const moduleTexts: string[] = [];
    const moduleParts: Part[] = [];
    const mapSources: string[] = [];
    const mapSourcesContent: string[] = [];
    const chunkKey = chunk.modules.map((i) => graph.modules[i].id).join('\x1f');

    for (const idx of chunk.modules) {
        const mod = graph.modules[idx];

        // Per-module reuse: a clean module (not re-parsed, unchanged liveness, same chunk
        // perspective) renders identical bytes when no final name shifted (`namesStable`). This
        // is what makes a single-chunk edit cheap — only the touched module re-renders.
        if (modInc !== null) {
            const entry = modInc.cache.get(mod.id);
            const mapOk =
                !wantMap ||
                entry === undefined ||
                entry.text === '' ||
                (entry.mapPart !== null && entry.srcIdx === mapSources.length);
            if (
                modInc.namesStable &&
                entry !== undefined &&
                !modInc.changed.has(mod.id) &&
                entry.liveHash === modInc.liveHash[idx] &&
                entry.chunkKey === chunkKey &&
                mapOk
            ) {
                modInc.stats.moduleReused++;
                if (entry.text !== '') moduleTexts.push(entry.text);
                if (wantMap && entry.text !== '') {
                    mapSources.push(mod.id);
                    mapSourcesContent.push(mod.source);
                    moduleParts.push(entry.mapPart!);
                    if (entry.nsCode !== null) moduleParts.push({ code: entry.nsCode });
                }
                continue;
            }
        }
        const live = shaken === null ? null : shaken.live[idx];
        // Index this module will occupy in `mapSources` if it emits anything.
        const srcIdx = mapSources.length;
        let out: string;
        let mapPart: Part | null = null;
        // Printer backend (minify and non-minify): generate every token from the AST, in link mode
        // (drop imports, unwrap exports, shake dead statements, apply renames + node rewrites).
        // `minify` only toggles whitespace/syntactic form — the link-mode rewrites are identical.
        {
            const ctx: EmitCtx = { graph, linked, mod, edits: [], warnings, live, chunk, chunkGraph, pathToChunk };
            trackChunkSpecs(ctx, mod.isEntry, entryStarSpecs, sideEffectSpecs);
            const overrides = collectLinkOverrides(ctx);
            const printer = createPrinter(
                { minify: naming.minify },
                {
                    nameOf: (idNode: Node) => renameOf(ctx, idNode) ?? idNode.name,
                    linkModule: true,
                    defaultName: () => {
                        const ref = linked.defaultRefs.get(mod.idx);
                        return ref !== undefined ? (finalNameOf(linked, ref) ?? `${mod.idx}_default`) : `${mod.idx}_default`;
                    },
                    live,
                    overrides,
                    srcLines: wantMap ? Uint32Array.from(buildLineTable(mod.source)) : undefined,
                    sourceIdx: srcIdx,
                },
            );
            printModule(printer, mod.program);
            if (wantMap) {
                out = trimMappings(finishPrinter(printer), printer.map!);
                mapPart = { code: out, map: printer.map! };
            } else {
                out = finishPrinter(printer).trim();
            }
        }
        let nsCode: string | null = null;
        if (linked.namespaceOf.has(idx)) {
            nsCode = renderNamespaceObject(linked, idx, chunk, shaken?.nsUsage.get(idx));
            out += `\n${nsCode}`;
        }
        if (out !== '') moduleTexts.push(out);
        if (wantMap && out !== '') {
            mapSources.push(mod.id);
            mapSourcesContent.push(mod.source);
            moduleParts.push(mapPart!);
            if (nsCode !== null) moduleParts.push({ code: nsCode });
        }
        // Cache the render for reuse — unless it carries a per-build hash placeholder (its bytes
        // are not counter-stable, so it must re-render every build).
        if (modInc !== null) {
            if (out.includes('!~{')) modInc.cache.delete(mod.id);
            else
                modInc.cache.set(mod.id, {
                    liveHash: modInc.liveHash[idx],
                    chunkKey,
                    text: out,
                    mapPart,
                    srcIdx,
                    nsCode,
                });
            modInc.stats.moduleRendered++;
        }
    }

    // Cross-chunk static imports: `import { imported as local, … } from '<path>';`
    const crossImportLines: string[] = [];
    for (const [producerChunk, specs] of chunk.imports) {
        const path = pathToChunk(producerChunk);
        const parts = specs.map((s) => (s.imported === s.local ? s.imported : `${s.imported} as ${s.local}`));
        crossImportLines.push(`import { ${parts.join(', ')} } from '${path}';`);
    }
    for (const producerChunk of chunk.sideEffectImports) {
        crossImportLines.push(`import '${pathToChunk(producerChunk)}';`);
    }

    // External imports, scoped to this chunk's used external locals.
    const extImports = renderExternalImports(linked, sideEffectSpecs);

    // `exports: 'none'` suppresses the entry export line entirely (validation-only shaping for
    // pure ESM — cross-chunk producer exports still emit so shared chunks keep working). For a
    // shared/producer chunk it is `chunk.exports`.
    const exportSpecs: string[] = [];
    const exportedNames: string[] = [];
    const seenExport = new Set<string>();
    const suppressEntryExports = naming.exports === 'none';
    // Entry (and dynamic-entry) chunks export their entry module's surface.
    if (!suppressEntryExports && chunk.entryModule >= 0 && (chunk.isEntry || chunk.isDynamicEntry)) {
        const entryMap = linked.exportMaps.get(chunk.entryModule);
        // A pure dynamic-entry chunk narrows to the members its `import()` consumers read (tree-shake
        // dropped the rest); a real user entry always exports its whole surface.
        const narrow = chunk.isDynamicEntry && !chunk.isEntry ? shaken?.nsUsage.get(chunk.entryModule) : undefined;
        if (entryMap !== undefined) {
            for (const [name, bind] of entryMap) {
                if (narrow !== undefined && !narrow.has(name)) continue;
                const local = nameOfBind(linked, bind, chunk);
                if (local === null) continue;
                if (seenExport.has(name)) continue;
                seenExport.add(name);
                const exported = isIdentName(name) ? name : JSON.stringify(name);
                exportSpecs.push(local === name ? exported : `${local} as ${exported}`);
                exportedNames.push(name);
            }
        }
    }
    // Producer exports for cross-chunk consumers (`export { local as t }`).
    for (const [exportedName, e] of chunk.exports) {
        if (seenExport.has(exportedName)) continue;
        const local = e.local;
        seenExport.add(exportedName);
        const exported = isIdentName(exportedName) ? exportedName : JSON.stringify(exportedName);
        exportSpecs.push(local === exportedName ? exported : `${local} as ${exported}`);
        exportedNames.push(exportedName);
    }
    const exportLine = exportSpecs.length > 0 ? `export { ${exportSpecs.join(', ')} };` : null;
    const starLines = suppressEntryExports ? [] : entryStarSpecs.map((spec) => `export * from '${spec}';`);

    // Empty non-entry chunk with nothing to emit: drop it.
    const isEmpty = moduleTexts.length === 0 && exportLine === null && starLines.length === 0;
    if (isEmpty && !chunk.isEntry) return null;

    // Addons (banner/intro leading, footer/outro trailing). Sync string/fn only. Order:
    // banner, intro, imports, body, exports, outro, footer.
    const preInfo: PreRenderedChunk = {
        name: chunk.name,
        isEntry: chunk.isEntry,
        isDynamicEntry: chunk.isDynamicEntry,
        facadeModuleId: chunk.entryModule >= 0 ? graph.modules[chunk.entryModule].id : null,
        moduleIds: chunk.modules.map((i) => graph.modules[i].id),
        exports: [...chunk.exports.keys()].sort(),
        type: 'chunk',
    };
    const banner = naming.banner(preInfo);
    const intro = naming.intro(preInfo);
    const outro = naming.outro(preInfo);
    const footer = naming.footer(preInfo);

    const parts: string[] = [];
    if (banner !== '') parts.push(banner);
    if (intro !== '') parts.push(intro);
    parts.push(...crossImportLines);
    parts.push(...extImports);
    parts.push(...moduleTexts);
    if (exportLine !== null) parts.push(exportLine);
    parts.push(...starLines);
    if (outro !== '') parts.push(outro);
    if (footer !== '') parts.push(footer);
    const code = `${parts.join('\n')}\n`;

    // Per-chunk map Parts (synthetic leading parts for banner/intro so joinParts counts their
    // lines and every source segment shifts by exactly that many lines — the classic footgun).
    const mapParts: Part[] = [];
    if (wantMap) {
        if (banner !== '') mapParts.push({ code: banner });
        if (intro !== '') mapParts.push({ code: intro });
        for (const s of crossImportLines) mapParts.push({ code: s });
        for (const s of extImports) mapParts.push({ code: s });
        mapParts.push(...moduleParts);
        if (exportLine !== null) mapParts.push({ code: exportLine });
        for (const s of starLines) mapParts.push({ code: s });
        if (outro !== '') mapParts.push({ code: outro });
        if (footer !== '') mapParts.push({ code: footer });
    }

    const importNames: string[] = [];
    for (const p of chunk.imports.keys()) importNames.push(chunkGraph.chunks[p].name);
    for (const p of chunk.sideEffectImports) importNames.push(chunkGraph.chunks[p].name);
    const dynamicImportNames: string[] = [];
    for (const d of chunk.dynamicImports) dynamicImportNames.push(chunkGraph.chunks[d].name);

    return {
        chunk,
        chunkIdx,
        prelim,
        code,
        parts: mapParts,
        mapSources,
        mapSourcesContent,
        name: chunk.name,
        isEntry: chunk.isEntry,
        isDynamicEntry: chunk.isDynamicEntry,
        moduleIds: chunk.modules.map((i) => graph.modules[i].id),
        imports: importNames,
        dynamicImports: dynamicImportNames,
        exports: exportedNames,
    };
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
    const nameFn: (id: string) => string | null =
        typeof gName === 'function' ? (id) => gName(id, meta) : () => gName;
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
        const mc = output.manualChunks;
        if (typeof mc === 'function') {
            // fn form → one group whose `name` is the fn; deps NOT pulled in (Rollup semantics:
            // only the modules the fn names land in the chunk).
            add(
                { name: (id, m) => mc(id, m) ?? null, includeDependenciesRecursively: false },
                ENGINE_GROUP_DEFAULTS,
            );
        } else {
            // object map { chunkName: [ids] } → one group per entry; listed modules + their deps
            // land in the chunk (Rollup semantics → includeDependenciesRecursively: true).
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

/** A chunk's preliminary filename: the pattern with `[hash]` left as a placeholder token (or
 *  `null` when the pattern has no `[hash]`, in which case the name is reserved immediately). */
export type PreliminaryFileName = { fileName: string; hashPlaceholder: string | null };

/** The intermediate a chunk render produces before hashing (placeholders unresolved). */
export type RenderedChunk = {
    chunk: Chunk;
    chunkIdx: number;
    prelim: PreliminaryFileName;
    /** Code with cross-chunk/dynamic paths as placeholders (own name still logical). */
    code: string;
    /** Assembled parts (banner/intro leading synthetics included) for the per-chunk map. */
    parts: Part[];
    mapSources: string[];
    mapSourcesContent: string[];
    // metadata for OutputChunk
    name: string;
    isEntry: boolean;
    isDynamicEntry: boolean;
    moduleIds: string[];
    imports: string[];
    dynamicImports: string[];
    exports: string[];
};

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
export type RenderStats = { rendered: number; reused: number; moduleRendered: number; moduleReused: number };

/** A single module's rendered contribution to its chunk, reusable across builds. The rendered
 *  text is a pure function of the module's source (→ `changed` set), its liveness (`liveHash`),
 *  the final names it references (globally gated by `namesStable`), and its chunk perspective
 *  (`chunkKey`). Modules whose text carries a per-build hash placeholder are never cached. */
export type CachedModuleRender = {
    liveHash: number;
    chunkKey: string;
    /** Full module text (type-stripped body + any appended namespace object), '' if it emits nothing. */
    text: string;
    /** Source-map part for the module body, and its baked source index (position in `mapSources`). */
    mapPart: Part | null;
    srcIdx: number;
    /** Namespace-object code for the separate map part, when this module has one. */
    nsCode: string | null;
};
/** Persistent per-module render cache + the naming signature of the build that populated it.
 *  A rename anywhere (`namesHash` mismatch) disables per-module reuse for that build. */
export type ModuleRenderCache = { modules: Map<string, CachedModuleRender>; namesHash: number };

/** Per-module reuse inputs threaded into {@link renderChunk}. */
export type ModuleRenderCtx = {
    cache: Map<string, CachedModuleRender>;
    /** Every final name is unchanged from the cached build → referenced names are stable. */
    namesStable: boolean;
    /** Module ids re-parsed this build (source changed) — never reused. */
    changed: Set<string>;
    /** Per-module-index liveness hash (0 when tree-shaking is off). */
    liveHash: number[];
    stats: RenderStats;
};

/** Incremental render inputs: the persistent cache + the render-dirty module ids
 *  (`graph.changed ∪ graph.affected`) + a stats sink + per-module reuse context. */
export type RenderIncremental = { cache: RenderCache; dirty: Set<string>; stats: RenderStats; mod: ModuleRenderCtx };

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
