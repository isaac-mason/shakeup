import { resetInferredPure } from './analysis/effects';
import { stampPureCallsGraph } from './analysis/purity';
import { SYM, symbolOf } from './analysis/semantic';
import { N, type Node, walk } from './ast';
import { compressChunk } from './chunk-compress';
import { buildChunkGraph, type Chunk, type ChunkGraph, type ChunkOptions, type ResolvedGroup } from './chunk-graph';
import { basenameOf, dirnameOf, type Fs, normalizePath, relativePath } from './fs';
import {
    externalKey,
    type Graph,
    type ImportBind,
    type ImportRecord,
    isEsmFormat,
    type Linked,
    type Module,
    NAME_DEFAULT,
    NAME_NAMESPACE,
    type ParseCache,
    type ParseStats,
    packRef,
    refMod,
    refSym,
} from './graph-types';
import { computeInteropOwners, type InteropOwner, initRefForRecord, recordIsInitObligation } from './init-obligations';
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
import { type CompressMode, runCompress } from './passes/compress';
import { lazySplit } from './passes/lazy-split';
import { inlineCrossModule } from './passes/optimize/inline-functions';
import { interopNamespace, materialiseLiveBody, wrapModuleBody } from './passes/wrap-module';
import type { Edit } from './patches';
import { compilePipeline, type GenerateBundleEntry, type ModuleInfo, type PluginCtx } from './plugin';
import { printModule } from './print/print-js';
import { createPrinter, finishPrinter } from './print/printer';
import type { GraphOptions } from './resolve';
import { buildGraph, hashSource, isAnyRequireCall, isRequireCall, resolveEmittedFileName, toModuleInfo } from './scan';
import {
    buildLineTable,
    composeMappings,
    encodeMappings,
    inlineSourceMapComment,
    joinParts,
    type Mappings,
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
    /** Which statement owns each wrapped-CommonJS interop namespace — see `computeInteropOwners`. */
    interopOwners: Map<number, InteropOwner>;
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
        case 'cjs-member': {
            // Textual member access: the emit substitutes NAMES for identifier nodes, and a member
            // expression is valid in every position a bare name was. This is how a CJS module's
            // non-statically-knowable export reaches its consumer.
            //
            // The namespace is resolved exactly like a `found` bind — CHUNK-LOCAL alias first — so a
            // consumer in another chunk names the symbol it imported rather than the producer's own
            // local, which is what used to dangle.
            const local = chunk?.importLocalOf.get(bind.ref) ?? finalNameOf(linked, bind.ref);
            if (local === null) return null;
            return bind.name === NAME_NAMESPACE ? local : `${local}.${bind.name}`;
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
/** Rewrite `require("./x")` to the target's wrapper call. The wrapper returns `module.exports`, so
 *  the call site's VALUE is already what `require` should produce — no interop conversion, because
 *  the consumer is CommonJS and expects a CommonJS exports object. (`__toCommonJS` is the other
 *  direction — CJS requiring an ESM module — and is not lowered yet.) */
/** Identifier references to a FREE `require` that are NOT the callee of a `require(...)` call —
 *  `typeof require`, `require.resolve(x)`, `require.cache`, a bare `require` passed as a value.
 *
 *  esbuild swaps exactly these for its `__require` stub: `ref == p.requireRef && !opts.isCallTarget`
 *  (`js_parser.go:17181-17189` → `valueToSubstituteForRequire`, `:1863`), gated on bundle mode with
 *  a non-CommonJS output format (`config.go:696`). rolldown inherits the same stub. Without it a
 *  UMD header's `typeof require === 'function'` is FALSE and it silently takes the browser-global
 *  branch, and every `require.X` throws `require is not defined` at load.
 *
 *  A `require("literal")` CALL is not here: it is either lowered to the target's wrapper or reported
 *  as an unresolvable specifier. Keeping the stub off call position is what preserves shakeup's
 *  deliberate divergence — a dynamic `require(expr)` stays a LOUD BUILD ERROR rather than becoming a
 *  runtime throw from inside `__require`. */
function needsRequireShim(mod: Module): boolean {
    return freeRequireRefs(mod).length > 0 || mod.importRecords.some((r) => r.kind === 'require' && r.external);
}

function freeRequireRefs(mod: Module): Node[] {
    const found: Node[] = [];
    if (!mod.hasRequire && !mod.semantic.unresolved.some((n) => n.name === 'require')) return found;
    const callees = new Set<Node>();
    walk(mod.program, (n) => {
        if (isAnyRequireCall(n)) callees.add((n.data as { callee: Node }).callee);
    });
    walk(mod.program, (n) => {
        if (n.type === N.IdentifierReference && n.name === 'require' && n.sym === 0 && !callees.has(n)) found.push(n);
    });
    return found;
}

function collectRequireOverrides(ctx: EmitCtx, map: Map<Node, string>): void {
    const { mod, linked } = ctx;
    // Top-level `this` means `module.exports` in CommonJS (cjs.md §2.4). Only meaningful once the
    // body is a wrapper closure, which is where `exports` is bound.
    if (linked.cjsWrap.has(mod.idx)) for (const n of mod.topLevelThis) map.set(n, 'exports');
    for (const n of freeRequireRefs(mod)) map.set(n, '__require');
    if (!mod.hasRequire) return;
    walk(mod.program, (n) => {
        if (!isRequireCall(n)) return;
        const spec = (n.data as { arguments: Node[] }).arguments[0].name;
        const text = spec.length >= 2 ? spec.slice(1, -1) : spec;
        const rec = mod.importRecords.find((r) => r.kind === 'require' && r.specifier === text);
        if (rec === undefined) return;
        // EXTERNAL (cjs.md §7.6) — nothing to lower to, so route the call through the `__require`
        // shim. On `platform: 'node'` that is `createRequire(import.meta.url)` and the call genuinely
        // works; elsewhere it throws a named error instead of `require is not defined`. Both oracles
        // do this: esbuild wraps any `require(…)` it cannot bundle with
        // `valueToSubstituteForRequire` (`js_parser.go:15788-15791, 15800-15804`), and rolldown's
        // shim points its error message at "bundling-cjs#require-external-modules".
        //
        // Distinct from a DYNAMIC `require(expr)`, which stays a loud build error: that one has no
        // specifier to hand anybody, so deferring it to runtime would only hide it.
        if (rec.external) {
            map.set(n, `__require(${spec})`);
            return;
        }
        if (rec.resolved < 0) return;
        const wrapRef = linked.cjsWrap.get(rec.resolved);
        if (wrapRef !== undefined) {
            // Chunk-local alias first: a `require` that crosses a chunk boundary must call the name
            // this chunk imported the wrapper under, not the producer's own local.
            const wrapper = ctx.chunk?.importLocalOf.get(wrapRef) ?? finalNameOf(linked, wrapRef);
            map.set(n, `${wrapper}()`);
            return;
        }
        // Requiring an ES module: hand back its namespace wrapped so the requiring CommonJS code
        // sees `__esModule: true` and its own default-interop resolves. `__toCommonJS` builds a
        // FRESH object per call rather than stamping the namespace itself — the importing side must
        // never see `__esModule` (cjs.md §4.3's asymmetry).
        // Chunk-local alias first, same as the wrapper above: across a boundary the namespace is
        // IMPORTED under a local name, not named by the producer's own.
        if (!linked.namespaceOf.has(rec.resolved)) return;
        const ns = nameOfBind(linked, { kind: 'namespace', module: rec.resolved }, ctx.chunk);
        if (ns === null) return;
        // A require-only ESM target is behind an `__esm` closure, so the CALL is what evaluates it —
        // that is the whole point of the lazy form. Sequencing the init in front of the read is
        // rolldown's shape too: `const foo = (init_foo(), __toCommonJS(foo_exports))`
        // (`tests/rolldown/misc/wrapped_esm/artifacts.snap`).
        // Shared predicate — `init-obligations.ts`.
        const initRef = initRefForRecord(linked, rec, 'require');
        if (initRef === undefined) {
            map.set(n, `__toCommonJS(${ns})`);
            return;
        }
        const initName = ctx.chunk?.importLocalOf.get(initRef) ?? finalNameOf(linked, initRef);
        map.set(n, `(${initName}(), __toCommonJS(${ns}))`);
    });
}

/**
 * `init_X();` text for each included static import statement whose target is lazily initialised.
 *
 * Keyed by the IMPORT STATEMENT, because that is where the call must land: the statement already
 * sits in the importer's source order, so replacing it in place makes evaluation order fall out
 * (`cjs.md` §7.25d). The gate is the shared predicate, never `linked.esmInit` read inline.
 */
function collectInitCalls(ctx: EmitCtx): Map<Node, string> {
    const { mod, linked, chunk, interopOwners } = ctx;
    const map = new Map<Node, string>();
    // O(records) pre-check: a module with no static target that is either lazily initialised or a
    // wrapped CommonJS module contributes nothing, and the walk below is skipped for the
    // overwhelming majority of modules.
    const nsMap = isEsmFormat(mod.defFormat) ? linked.cjsNamespaceNode : linked.cjsNamespace;
    const wants = (r: ImportRecord): boolean =>
        recordIsInitObligation(r, 'static-import') && (linked.esmInit.has(r.resolved) || nsMap.has(r.resolved));
    if (!mod.importRecords.some(wants)) return map;
    const src = mod.source;
    for (const stmt of (mod.program.data as { body: Node[] }).body) {
        // `import './e.js'`, `export { v } from './e.js'` and `export * from './e.js'` are the same
        // dependency edge as far as evaluation goes: each names a module that has to have run by the
        // time this statement is reached. A re-export carries the obligation exactly like an import,
        // which is what the `re-export chain to target` shape in `pnpm evalorder` measures.
        if (stmt.type !== N.ImportDeclaration && stmt.type !== N.ExportNamedDeclaration && stmt.type !== N.ExportAllDeclaration)
            continue;
        const source = (stmt.data as { source: Node | null }).source;
        if (source === null || source.type !== N.StringLiteral) continue;
        const spec = src.slice(source.start + 1, source.end - 1);
        const rec = mod.importRecords.find((r) => r.specifier === spec && r.kind === 'static');
        if (rec === undefined) continue;
        const initRef = initRefForRecord(linked, rec, 'static-import');
        if (initRef !== undefined) {
            const name = chunk?.importLocalOf.get(initRef) ?? finalNameOf(linked, initRef);
            map.set(stmt, `${name}();`);
            continue;
        }
        // A WRAPPED CommonJS target instead: this statement runs the module by building its interop
        // namespace, but only if it is the statement that OWNS it. Everyone else just reads the
        // binding the owner declared — see `computeInteropOwners` for why one and not all.
        if (!recordIsInitObligation(rec, 'static-import')) continue;
        const nsRef = nsMap.get(rec.resolved);
        if (nsRef === undefined) continue;
        const owner = interopOwners.get(nsRef);
        if (owner === undefined || owner.module !== mod.idx || owner.stmtId !== stmt.id) continue;
        const wrapRef = linked.cjsWrap.get(rec.resolved);
        if (wrapRef === undefined) continue;
        const nsName = chunk?.importLocalOf.get(nsRef) ?? finalNameOf(linked, nsRef);
        const wrapName = chunk?.importLocalOf.get(wrapRef) ?? finalNameOf(linked, wrapRef);
        const nodeArg = isEsmFormat(mod.defFormat) ? ', 1' : '';
        map.set(stmt, `var ${nsName} = /* @__PURE__ */ __toESM(${wrapName}()${nodeArg});`);
    }
    return map;
}

function collectLinkOverrides(ctx: EmitCtx): Map<Node, string> {
    const { mod, chunk, chunkGraph } = ctx;
    const map = new Map<Node, string>();
    // Only `import()` and `new URL(...)` produce an override, and the scan already recorded both as
    // import records — so a module with neither cannot contribute one, and the whole-program walk
    // below is skipped. Checking is O(records).
    if (!mod.importRecords.some((r) => r.kind === 'dynamic' || r.kind === 'new-url' || r.hasDynamicLiteral)) return map;
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
                        // A CommonJS target resolves to its INTEROP namespace (which carries
                        // `default`), not to `namespaceOf` — same object a static `import` of it
                        // gets. Chunk-local alias first, as everywhere else.
                        const cjsNs = ctx.linked.cjsNamespace.get(rec.resolved);
                        const nsName =
                            cjsNs !== undefined
                                ? (ctx.chunk?.importLocalOf.get(cjsNs) ?? finalNameOf(ctx.linked, cjsNs))
                                : ctx.linked.namespaceOf.get(rec.resolved);
                        map.set(n, `Promise.resolve().then(() => ${nsName ?? '{}'})`);
                    } else {
                        const path =
                            ctx.pathToChunk !== null
                                ? ctx.pathToChunk(targetChunk)
                                : `./${chunkGraph.chunks[targetChunk].name}.js`;
                        // A mode-2 target's chunk exports the runtime namespace OBJECT under a
                        // single name — its members are not knowable as chunk exports — so the
                        // import site unwraps it and the caller's `m.a` reads the object.
                        const nsExport = chunkGraph.chunks[targetChunk].nsExportName?.get(rec.resolved);
                        if (nsExport !== undefined && ctx.linked.dynamicExports.has(rec.resolved)) {
                            map.set(n, `import('${path}').then((m) => m.${nsExport})`);
                        } else if (n.data.options !== null) {
                            // DROP the import-attributes argument. The specifier now points at a
                            // JavaScript chunk, so `{ with: { type: 'json' } }` has become a lie and
                            // Node rejects the load outright:
                            //   `import('./d.json', { with: { type: 'json' } })`
                            //     → `import('./d-BoSLbCma.js', { with: { type: 'json' } })`
                            //     → TypeError: Module "…/d-BoSLbCma.js" is not of type "json"
                            // A build that reported no errors produced a bundle that threw. Both
                            // oracles drop the attribute for a BUNDLED module for the same reason and
                            // keep it only for an external — and an external never reaches here,
                            // because `rec.external` short-circuits above.
                            map.set(n, `import('${path}')`);
                        } else map.set(source, `'${path}'`);
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

function renderExternalImports(linked: Linked, sideEffectSpecs: Set<string>, tight: boolean): string[] {
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
        const attrs = linked.externalAttributes.get(spec);
        const star = entries.find((e) => e.name === '*');
        if (star !== undefined) lines.push(importStmt(`* as ${star.local}`, spec, tight, attrs));
        const def = entries.find((e) => e.name === 'default');
        const named = entries.filter((e) => e.name !== '*' && e.name !== 'default');
        if (def !== undefined || named.length > 0) {
            const inner = named.map((e) => (e.name === e.local ? e.name : `${e.name} as ${e.local}`)).join(clauseSep(tight));
            const namedPart = named.length > 0 ? (tight ? `{${inner}}` : `{ ${inner} }`) : '';
            const clauses = [def !== undefined ? def.local : '', namedPart].filter((s) => s !== '').join(clauseSep(tight));
            lines.push(importStmt(clauses, spec, tight, attrs));
        }
    }
    for (const spec of sideEffectSpecs) {
        const a = linked.externalAttributes.get(spec);
        const w = a === undefined ? '' : tight ? `with{${a}}` : ` with { ${a} }`;
        lines.push(tight ? `import'${spec}'${w};` : `import '${spec}'${w};`);
    }
    return lines;
}

const isIdentName = (s: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);

/** Emit-layer spacing. The AST printer is whitespace-aware, but this hand-built glue (import and
 *  export clauses, the namespace object) carried readable padding regardless of `minify.whitespace`
 *  — 1.4KB on crashcat measured against oxc-minify. Only COLUMNS move: every one of these is a
 *  single line before and after, so the line-counting the source-map parts rely on is untouched. */
const clauseSep = (tight: boolean): string => (tight ? ',' : ', ');

/** `import <clauses> from '<spec>';`, dropping the separators that only exist for readability.
 *  A clause list starting with `{`/`*` needs no space after `import`, and one ending in `}` needs
 *  none before `from`; a bare default local (`import d from …`) needs both. */
function importStmt(clauses: string, spec: string, tight: boolean, attrs?: string): string {
    // An external keeps its import attributes: the module is still fetched by the runtime, which
    // needs `with { type: … }` to load it. (A BUNDLED module drops the clause — it is inlined
    // JavaScript by then. Both oracles split it exactly this way.)
    const w = attrs === undefined ? '' : tight ? `with{${attrs}}` : ` with { ${attrs} }`;
    if (!tight) return `import ${clauses} from '${spec}'${w};`;
    const lead = clauses.startsWith('{') || clauses.startsWith('*') ? '' : ' ';
    const tail = clauses.endsWith('}') ? '' : ' ';
    return `import${lead}${clauses}${tail}from'${spec}'${w};`;
}

/** Whether a namespace member's local binding can never be reassigned, so the namespace may hold it
 *  as a plain value instead of an accessor. Only a positive proof counts: a `const`/`function`/
 *  `class` declaration in this graph. A namespace-of-a-namespace, an external, a synthetic ref, or
 *  anything whose symbol we cannot inspect falls through to `false` (accessor), which is always
 *  correct — just larger. */
function isImmutableBind(linked: Linked, bind: ImportBind): boolean {
    if (bind.kind !== 'found') return false;
    const mod = linked.graph.modules[refMod(bind.ref)];
    const sym = mod?.semantic.symbols[refSym(bind.ref)];
    if (sym === undefined) return false; // synthetic (`*_default`) refs have no symbol record
    return (sym.flags & (SYM.CONST | SYM.FUNCTION | SYM.CLASS)) !== 0;
}

function renderNamespaceObject(
    graph: Graph,
    linked: Linked,
    modIdx: number,
    chunk: Chunk | null,
    nsMembers: Set<string> | undefined,
    tight: boolean,
    /** The `var` is already declared outside (lazy-init form) — assign, do not redeclare. */
    preDeclared = false,
    /** Force accessors for every member. A SPLIT lazy module's bindings are hoisted `var`s that stay
     *  `undefined` until `init` runs, so a plain value here would snapshot `undefined` — the
     *  immutability that normally justifies a plain value is about the SYMBOL's kind, which still
     *  says `const` even though the emitted declaration is now a bare `var`. */
    forceAccessors = false,
): string {
    const nsName = linked.namespaceOf.get(modIdx)!;
    const map = linked.exportMaps.get(modIdx);
    const entries: string[] = [];
    if (map !== undefined) {
        // SORTED BY NAME, matching rollup's `sortExportedVariables` (`Module.ts:1505`,
        // `a < b ? -1 : a > b ? 1 : 0` — plain code-unit order, not `localeCompare`). A namespace
        // object's key order is OBSERVABLE through `Object.keys`/`getOwnPropertyNames`, and rollup's
        // `namespace-keys-are-sorted` asserts the exact sequence, so source order is a divergence
        // rather than a free choice.
        for (const [name, bind] of [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
            // Narrowed target: emit only the members its consumers read (tree-shake seeded exactly
            // these live). Absent set → whole surface (target escaped / entry / dynamic).
            if (nsMembers !== undefined && !nsMembers.has(name)) continue;
            const value = nameOfBind(linked, bind, chunk);
            if (value === null) continue;
            const key = isIdentName(name) ? name : JSON.stringify(name);
            // An ESM namespace exposes LIVE bindings: `ns.v` must re-read the local, so an
            // `export let v` reassigned after the namespace is built is visible through it. A flat
            // `v: v` snapshots the initial value and silently miscompiles (`ns.bump(); ns.v` read 1
            // where the spec says 2).
            //
            // But a getter is only needed when the local CAN be reassigned. A bundler knows that
            // statically, so pay for it only where it buys something: `const`/`function`/`class`
            // bindings are immutable, so a plain value is exactly equivalent and cheaper — which is
            // the overwhelming majority of exports. Only `let`/`var` (and anything we cannot
            // positively prove immutable) gets an accessor.
            //
            // Keyed off the symbol KIND, deliberately not off `semantic.refs[...].writes`: an
            // undercount there (stale refs after a lowering pass) would silently reintroduce the
            // exact miscompile above, whereas a symbol's declaration kind cannot go stale. The
            // trade is a getter for a never-reassigned `export let`, which is rare and harmless.
            entries.push(
                !forceAccessors && isImmutableBind(linked, bind)
                    ? `${key}${tight ? ':' : ': '}${value}`
                    : `get ${key}()${tight ? '{' : ' { '}return ${value};${tight ? '}' : ' }'}`,
            );
        }
    }
    const inner = entries.join(clauseSep(tight));
    // `Symbol.toStringTag` is defined SEPARATELY rather than as a literal member, so it is
    // non-enumerable like the spec's. As a literal it was enumerable and got copied by `{...ns}`.
    //
    // No `Object.freeze`. It was here on a spec argument — namespace exotic objects are
    // non-extensible with non-configurable properties — but NEITHER ORACLE freezes: rolldown's
    // runtime contains no `freeze`/`seal`/`preventExtensions` at all, and esbuild's `__freeze` is
    // used only by `__template`, where the spec requires it. A bundler-synthesized namespace cannot
    // be a real namespace exotic object anyway, so both keep what is observable — live bindings and
    // the tag, which feature detection reads — and drop what only affects code that is already
    // assigning to a namespace member. Freezing also blocks the `__reExport` chain that
    // `export * from 'cjs'` (namespace mode 2) needs to extend the object.
    const tag = `${tight ? '' : ' '}Object.defineProperty(${nsName},${tight ? '' : ' '}Symbol.toStringTag,${tight ? '' : ' '}{${tight ? '' : ' '}value:${tight ? '' : ' '}'Module'${tight ? '' : ' '}});`;
    const decl = preDeclared ? '' : 'const ';
    // MODE 2 (cjs.md §4.4) — the module `export *`s from CommonJS, so its surface is not knowable
    // here. The statically-known names become getter THUNKS handed to `__exportAll`, which is the
    // one place shakeup uses accessors for everything: the object has to stay extensible so
    // `__reExport` can copy the CommonJS members in at runtime, and a value snapshot taken now would
    // predate them. This does NOT touch the ordinary namespace above, which keeps plain values for
    // provably-immutable members.
    //
    // rolldown's `cjs_compat/reexport_commonjs` is the shape, verbatim:
    //     var foo_exports = /* @__PURE__ */ __exportAll({ bar: () => import_commonjs.bar, … });
    //     __reExport(foo_exports, /* @__PURE__ */ __toESM(require_commonjs()));
    // `__exportAll` stamps `Symbol.toStringTag` itself, so no separate `defineProperty` here.
    if (linked.dynamicExports.has(modIdx)) {
        const thunks: string[] = [];
        for (const [name, bind] of map ?? []) {
            if (nsMembers !== undefined && !nsMembers.has(name)) continue;
            const value = nameOfBind(linked, bind, chunk);
            if (value !== null) thunks.push(`${name}${tight ? ':' : ': '}()${tight ? '=>' : ' => '}${value}`);
        }
        const body = tight ? `{${thunks.join(',')}}` : `{ ${thunks.join(', ')} }`;
        const lines = [`${decl}${nsName} = /* @__PURE__ */ __exportAll(${thunks.length === 0 ? '{}' : body});`];
        for (const recIdx of graph.modules[modIdx].starExports) {
            const rec = graph.modules[modIdx].importRecords[recIdx];
            if (rec.external || rec.resolved < 0) continue;
            const wrapRef = linked.cjsWrap.get(rec.resolved);
            if (wrapRef !== undefined) {
                const wrapper = chunk?.importLocalOf.get(wrapRef) ?? finalNameOf(linked, wrapRef);
                lines.push(`__reExport(${nsName},${tight ? '' : ' '}/* @__PURE__ */ __toESM(${wrapper}()));`);
            } else if (linked.dynamicExports.has(rec.resolved)) {
                // Chained: the star source is itself a mode-2 re-exporter, so copy from ITS object.
                const inner = nameOfBind(linked, { kind: 'namespace', module: rec.resolved }, chunk);
                if (inner !== null) lines.push(`__reExport(${nsName},${tight ? '' : ' '}${inner});`);
            }
        }
        return lines.join('\n');
    }
    // `__proto__: null` — a real ES module namespace is an exotic object with a NULL prototype, and
    // that is observable: `Object.getPrototypeOf(ns)`, and `deepStrictEqual` against
    // `{ __proto__: null, ... }`, both see it. ALL THREE oracles emit it — rollup
    // (`Object.freeze({ __proto__: null, ... })`), rolldown, and esbuild — so this was a shakeup-only
    // divergence, not a choice between them.
    //
    // Freezing is a SEPARATE question and stays as it was: rollup freezes, rolldown and esbuild do
    // not, and the comment above records why we follow the latter two.
    const proto = tight ? '__proto__:null' : '__proto__: null';
    const members = inner === '' ? proto : `${proto}${clauseSep(tight)}${inner}`;
    return tight ? `${decl}${nsName}={${members}};${tag}` : `${decl}${nsName} = { ${members} };${tag}`;
}

/** Runtime helpers for CommonJS interop, transcribed from rolldown's `runtime-base.js`.
 *
 *  The `Min` forms are used: rolldown selects the named-function variants only under
 *  `profiler_names` (default off), and every fixture snapshot uses these. Emitted verbatim into the
 *  chunk that needs them rather than through a synthetic runtime module — a full runtime-module
 *  facility is only warranted once more than a handful of helpers exist.
 *
 *  `__commonJSMin` memoizes: `mod ||` short-circuits after the first call, so a module body runs at
 *  most once and a cycle re-entering it observes the PARTIAL exports, which is exactly Node's
 *  behaviour. `__toESM` converts a CommonJS exports object into an ESM namespace, honouring the
 *  `__esModule` marker — and note rolldown's extra `hasOwnProperty(mod, 'default')` guard, a fix
 *  (#10360) esbuild lacks: a module claiming `__esModule` without actually owning a `default` would
 *  otherwise yield `undefined` for `import d from`. */
const CJS_HELPERS: Record<string, string> = {
    // The `binary` loader's decoder, transcribed from rolldown's `runtime-base.js:76-95` (which is
    // esbuild's `__toBinary`). The table build and the four-at-a-time inner loop are theirs; the
    // `/* @__PURE__ */` on the IIFE is what lets it be dropped when tree-shaking removes the last
    // binary module. esbuild has a `__toBinaryNode` variant backed by `Buffer.from` — not used
    // here, since this form works on both platforms and shakeup emits ONE runtime chunk shared
    // across them.
    __toBinary: `var __toBinary = /* @__PURE__ */ (() => {
  var table = new Uint8Array(128);
  for (var i = 0; i < 64; i++) table[i < 26 ? i + 65 : i < 52 ? i + 71 : i < 62 ? i - 4 : i * 4 - 205] = i;
  return (base64) => {
    var n = base64.length, bytes = new Uint8Array((((n - (base64[n - 1] == '=') - (base64[n - 2] == '=')) * 3) / 4) | 0);
    for (var i = 0, j = 0; i < n; ) {
      var c0 = table[base64.charCodeAt(i++)], c1 = table[base64.charCodeAt(i++)];
      var c2 = table[base64.charCodeAt(i++)], c3 = table[base64.charCodeAt(i++)];
      bytes[j++] = (c0 << 2) | (c1 >> 4);
      bytes[j++] = (c1 << 4) | (c2 >> 2);
      bytes[j++] = (c2 << 6) | c3;
    }
    return bytes;
  };
})();`,
    __getOwnPropNames: 'var __getOwnPropNames = Object.getOwnPropertyNames;',
    __getOwnPropDesc: 'var __getOwnPropDesc = Object.getOwnPropertyDescriptor;',
    __hasOwnProp: 'var __hasOwnProp = Object.prototype.hasOwnProperty;',
    __defProp: 'var __defProp = Object.defineProperty;',
    __create: 'var __create = Object.create;',
    __getProtoOf: 'var __getProtoOf = Object.getPrototypeOf;',
    // esbuild's `__commonJSMin` (`runtime.go:201-207`), NOT rolldown's — the two differ and only
    // esbuild's matches Node. A CommonJS module whose body THROWS is deleted from Node's require
    // cache and RE-RUNS on the next `require()`; measured on Node 24, a module that throws once then
    // succeeds gives `["THREW:first", {ran:2}]`. rolldown's body has no `try`, so `mod` stays set to
    // the HALF-POPULATED exports object from the failed run and the second require hands that back —
    // shakeup returned `{}` where Node returns `{ran:2}`, silently.
    //
    // `cb` is deliberately NOT nulled after the first call (rolldown nulls it to free the closure):
    // a retry needs it. Note the asymmetry with `__esm` below, which is the OPPOSITE and equally
    // deliberate — an ES module's evaluation error IS sticky per spec, a CommonJS module's is not.
    __commonJS: [
        'var __commonJS = (cb, mod) => () => {',
        '    try {',
        '        return (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);',
        '    } catch (e) {',
        '        throw ((mod = 0), e);',
        '    }',
        '};',
    ].join('\n'),
    // rolldown's `__esmMin` verbatim (`runtime/runtime-base.js:17-23`). `fn = 0` after the first
    // call makes it run ONCE; the `err` cache makes an evaluation failure STICKY, which the ESM
    // spec requires — a module that threw must throw the same error on every later access, not
    // re-run. Transcribed rather than derived: the one-liner it is tempting to write instead
    // re-evaluates a module whose first evaluation threw.
    __esm: [
        'var __esm = (fn, res, err) => () => {',
        '    if (err) throw err[0];',
        '    try {',
        '        return (fn && (res = fn((fn = 0))), res);',
        '    } catch (e) {',
        '        throw ((err = [e]), e);',
        '    }',
        '};',
    ].join('\n'),
    __copyProps: [
        'var __copyProps = (to, from, except, desc) => {',
        "    if ((from && typeof from === 'object') || typeof from === 'function') {",
        '        for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {',
        '            key = keys[i];',
        '            if (!__hasOwnProp.call(to, key) && key !== except) {',
        '                __defProp(to, key, {',
        '                    get: ((k) => from[k]).bind(null, key),',
        '                    enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,',
        '                });',
        '            }',
        '        }',
        '    }',
        '    return to;',
        '};',
    ].join('\n'),
    // Transcribed from rolldown `runtime-base.js:34-43` and `:58-60`. `__exportAll` builds the
    // mode-2 namespace: every entry is a getter, and the object stays EXTENSIBLE so `__reExport` can
    // add to it (which is also why nothing here is frozen). `__reExport` copies with `'default'` as
    // the `except` key — `export *` never forwards `default`, in any bundler or in Node.
    __exportAll: [
        'var __exportAll = (all, no_symbols) => {',
        '    let target = {};',
        '    for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });',
        "    if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: 'Module' });",
        '    return target;',
        '};',
    ].join('\n'),
    __reExport:
        "var __reExport = (target, mod, secondTarget) => (__copyProps(target, mod, 'default'), secondTarget && __copyProps(secondTarget, mod, 'default'));",
    __toCommonJS: [
        'var __toCommonJS = (mod) =>',
        "    __hasOwnProp.call(mod, 'module.exports')",
        "        ? mod['module.exports']",
        "        : __copyProps(__defProp({}, '__esModule', { value: true }), mod);",
    ].join('\n'),
    __toESM: [
        'var __toESM = (mod, isNodeMode, target) => (',
        '    (target = mod != null ? __create(__getProtoOf(mod)) : {}),',
        '    __copyProps(',
        "        isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, 'default')",
        "            ? __defProp(target, 'default', { value: mod, enumerable: true })",
        '            : target,',
        '        mod,',
        '    )',
        ');',
    ].join('\n'),
};

/** The `require` shim, in its two platform forms — both transcribed, neither derived.
 *
 *  On `platform: 'node'` an ESM bundle can build a REAL require: rolldown's `runtime-tail-node.js`
 *  is `createRequire(import.meta.url)`, selected by `is_esm_format_with_node_platform()`
 *  (`runtime_module_task.rs:42-44`). `require.resolve`, `require.cache` and a dynamic call then all
 *  genuinely work, because it IS Node's require.
 *
 *  Everywhere else it is the Proxy stub esbuild wrote and rolldown inherited verbatim
 *  (`runtime-tail.js` / `runtime.go:123-133`). Two things it is careful about, both from linked
 *  issues: `typeof require` must be `'function'` even off Node (esbuild #1202) — hence a function
 *  target — and it must pick up a `require` that appears LATER, including through property access
 *  (esbuild #1614) — hence the Proxy rather than a captured value. */
const REQUIRE_SHIM_NODE = 'var __require = /* @__PURE__ */ (() => createRequire(import.meta.url))();';
const REQUIRE_SHIM_NODE_IMPORT = "import { createRequire } from 'node:module';";
const REQUIRE_SHIM = [
    'var __require = /* @__PURE__ */ ((x) =>',
    "    typeof require !== 'undefined'",
    '        ? require',
    "        : typeof Proxy !== 'undefined'",
    "          ? new Proxy(x, { get: (a, b) => (typeof require !== 'undefined' ? require : a)[b] })",
    '          : x)(function (x) {',
    "    if (typeof require !== 'undefined') return require.apply(this, arguments);",
    "    throw Error('Dynamic require of \"' + x + '\" is not supported');",
    '});',
].join('\n');

/** Sentinel key for the `require` shim, which is not in {@link CJS_HELPERS} because it has two
 *  platform-dependent bodies and one of them needs an accompanying import statement. */
export const REQUIRE_SHIM_KEY = '__require';

/** The `__require` shim's lines for this build's platform. */
function requireShimLines(graph: Graph): string[] {
    return graph.platform === 'node' ? [REQUIRE_SHIM_NODE_IMPORT, REQUIRE_SHIM_NODE] : [REQUIRE_SHIM];
}

/** Which runtime helpers this chunk's own modules require. Pure function of `graph`/`linked`/the
 *  chunk's module list, so chunk-graph can call it before rendering to decide whether a shared
 *  runtime chunk is worth minting. */
export function helpersNeededBy(graph: Graph, linked: Linked, chunk: Chunk): Set<string> {
    const wanted = new Set<string>();
    const has = (f: (i: number) => boolean) => chunk.modules.some(f);
    const needsCjs = has((i) => linked.cjsWrap.has(i)) || has((i) => linked.dynamicExports.has(i));
    // A `require()` of an ES module needs `__toCommonJS` even when nothing else here is wrapped.
    const needsToCjs = has((i) =>
        graph.modules[i].importRecords.some(
            (r) =>
                r.kind === 'require' &&
                !r.external &&
                r.resolved >= 0 &&
                !linked.cjsWrap.has(r.resolved) &&
                linked.namespaceOf.has(r.resolved),
        ),
    );
    // A lazily-initialised module (§7.20/D1) carries its own `__esm` — and it is the PRODUCER chunk
    // that declares the init function, which may wrap nothing and require nothing itself.
    const needsEsm = has((i) => linked.esmInit.has(i));
    if (needsCjs) wanted.add('__commonJS');
    if (has((i) => linked.cjsNamespace.has(i) || linked.cjsNamespaceNode.has(i))) for (const d of TO_ESM_DEPS) wanted.add(d);
    if (needsEsm) wanted.add('__esm');
    if (has((i) => linked.dynamicExports.has(i))) for (const d of EXPORT_ALL_DEPS) wanted.add(d);
    if (needsToCjs) for (const d of TO_CJS_DEPS) wanted.add(d);
    if (has((i) => needsRequireShim(graph.modules[i]))) wanted.add(REQUIRE_SHIM_KEY);
    // The `binary` loader emits `export default __toBinary("…")`, so the demand is a property of
    // the module's TYPE rather than of anything `link` computed.
    if (has((i) => graph.modules[i].moduleType === 'binary')) wanted.add('__toBinary');
    return wanted;
}

/** Helpers namespace mode 2 needs, in dependency order. */
const EXPORT_ALL_DEPS = [
    '__getOwnPropNames',
    '__getOwnPropDesc',
    '__hasOwnProp',
    '__defProp',
    '__create',
    '__getProtoOf',
    '__copyProps',
    '__exportAll',
    '__reExport',
    '__toESM',
];

/** Helpers `__toESM` needs, in dependency order. */
const TO_ESM_DEPS = [
    '__getOwnPropNames',
    '__getOwnPropDesc',
    '__hasOwnProp',
    '__defProp',
    '__create',
    '__getProtoOf',
    '__copyProps',
    '__toESM',
];

/** Helpers `__toCommonJS` needs, in dependency order. */
const TO_CJS_DEPS = ['__getOwnPropNames', '__getOwnPropDesc', '__hasOwnProp', '__defProp', '__copyProps', '__toCommonJS'];

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
        return {
            code: '',
            chunks: [],
            errors: [(e as Error).message],
            warnings,
            graph,
            linked: null,
            shaken: null,
            parseStats: graph.parseStats,
        };
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
        renderChunk(
            graph,
            linked,
            chunkGraph,
            chunk,
            ci,
            shaken,
            interopOwners,
            warnings,
            want,
            // Emit-glue spacing and module printing both stay readable when the chunk pass will
            // minify: it re-parses this text, and minified printing loses `@__PURE__`.
            min.compress === 'full' ? false : min.whitespace,
            min.compress === 'full',
            naming,
            pathToChunk,
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
        if (isFileNameOutsideOutputDirectory(name)) {
            return {
                code: '',
                chunks: [],
                errors: [
                    `The output file name "${name}" is not contained in the output directory. Make sure all file names are relative paths without ".." segments.`,
                ],
                warnings,
                graph,
                linked,
                shaken,
                parseStats: graph.parseStats,
            };
        }
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
    /** Decided once for the whole bundle, beside `shaken` — see `computeInteropOwners`. */
    interopOwners: Map<number, InteropOwner>,
    warnings: string[],
    wantMap: boolean,
    tight: boolean,
    /** The cosmetic tier runs later over the assembled chunk, so this render must stay READABLE.
     *  Minified printing drops `/*@__PURE__*​/` annotations (1146 → 0 on crashcat), and the chunk
     *  compress re-parses this text — so minifying here would destroy the purity information it
     *  needs and it would keep calls it could otherwise drop. rolldown renders the chunk un-minified
     *  for the same reason and lets `dce_or_minify` do the minifying once, at the end. */
    deferMinify: boolean,
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
        // Set only for a module needing the declaration/initializer split — see §7.25.
        let splitRender: ReturnType<typeof lazySplit> | null = null;
        let splitMapParts: Part[] | null = null;
        // Hoisted out of the printer block below so the `__esm` wrappers further down can render AST
        // rather than splice text. Assigned exactly once, immediately.
        let renderStmts: ((body: Node[], liveOverride?: Set<number> | null) => { code: string; map: Mappings | null }) | null =
            null;
        // Printer backend (minify and non-minify): generate every token from the AST, in link mode
        // (drop imports, unwrap exports, shake dead statements, apply renames + node rewrites).
        // `minify` only toggles whitespace/syntactic form — the link-mode rewrites are identical.
        {
            const ctx: EmitCtx = { graph, linked, mod, edits: [], warnings, live, chunk, chunkGraph, pathToChunk, interopOwners };
            trackChunkSpecs(ctx, mod.isEntry, entryStarSpecs, sideEffectSpecs);
            const overrides = collectLinkOverrides(ctx);
            const initCalls = collectInitCalls(ctx);
            collectRequireOverrides(ctx, overrides);
            const renameCache: (string | null | undefined)[] = [];
            // A FACTORY, not a single printer: a module that needs the declaration/initializer split
            // (cjs.md §7.25) is printed as two regions — hoisted bindings and function declarations
            // at top level, then the initializers inside the `__esm` closure — and each region needs
            // its own printer. Everything else makes exactly one.
            const makePrinter = (liveOverride: typeof live = live) =>
                createPrinter(
                    { minify: deferMinify ? false : naming.minify },
                    {
                        // Memoised per SYMBOL, not per occurrence. `renameOf` does two Map lookups
                        // (`namedImports`, then `finalNames` under a packed key), and a symbol is emitted
                        // many times — ~94k references over ~7.3k symbols on crashcat, so roughly 13
                        // identical lookups per symbol. Symbol ids are dense, so an array indexed by id
                        // collapses that to one. Correct per printer because the answer depends on
                        // `ctx.chunk`, and a printer is created per module PER CHUNK render.
                        nameOf: (idNode: Node) => {
                            const sym = idNode.sym;
                            if (sym === 0) return idNode.name; // unresolved: the name varies per node
                            const hit = renameCache[sym];
                            if (hit !== undefined) return hit ?? idNode.name;
                            const v = renameOf(ctx, idNode) ?? null;
                            renameCache[sym] = v;
                            return v ?? idNode.name;
                        },
                        linkModule: true,
                        defaultName: () => {
                            const ref = linked.defaultRefs.get(mod.idx);
                            return ref !== undefined ? (finalNameOf(linked, ref) ?? `${mod.idx}_default`) : `${mod.idx}_default`;
                        },
                        live: liveOverride,
                        overrides,
                        initCalls,
                        srcLines: wantMap ? Uint32Array.from(buildLineTable(mod.source)) : undefined,
                        sourceIdx: srcIdx,
                    },
                );
            const renderBody = (body: Node[], liveOverride: typeof live = live): { code: string; map: Mappings | null } => {
                const pr = makePrinter(liveOverride);
                const prog =
                    body === (mod.program.data as { body: Node[] }).body
                        ? mod.program
                        : ({ ...mod.program, data: { ...(mod.program.data as object), body } } as Node);
                printModule(pr, prog);
                if (!wantMap) return { code: finishPrinter(pr).trim(), map: null };
                const code = trimMappings(finishPrinter(pr), pr.map!);
                return { code, map: pr.map! };
            };
            renderStmts = renderBody;
            const whole = renderBody((mod.program.data as { body: Node[] }).body);
            out = whole.code;
            if (wantMap) mapPart = { code: out, map: whole.map! };
            if (linked.esmInitSplit.has(idx)) {
                const dref = linked.defaultRefs.get(idx);
                // Split the LIVE statements only, then render with shaking OFF. The statements the
                // split synthesizes (`var a, b;`, `a = 1`) are new nodes with fresh ids, so a `live`
                // set built from the original program would drop every one of them — which is
                // exactly what happened: the hoisted bindings and all the initializers vanished.
                const all = (mod.program.data as { body: Node[] }).body;
                const liveBody = live === null ? all : all.filter((st) => live.has(st.id));
                splitRender = lazySplit(liveBody, dref === undefined ? undefined : (finalNameOf(linked, dref) ?? undefined));
            }
            // A wrapped CommonJS module becomes a closure instead of top-level statements. Params are
            // MINIMAL — bound only when the body references them. `/* @__PURE__ */` lets an unused
            // wrapper be dropped entirely.
            const wrapRef = linked.cjsWrap.get(idx);
            if (wrapRef !== undefined) {
                const wrapName = finalNameOf(linked, wrapRef);
                // rolldown's rule exactly (`ast_factory.rs:759-786`): push `exports` when the module
                // references EITHER binding (`ModuleOrExports`), push `module` only when it references
                // `module` (`ModuleRef`). A module touching neither gets NO parameter list. We used to
                // emit `exports` unconditionally — the comment above claimed to be following rolldown and
                // described behaviour it does not have.
                const uses = new Set(mod.semantic.unresolved.map((n) => n.name));
                // Top-level `this` counts as referencing `exports`: in CommonJS `this === module.exports`,
                // and `bundle.ts:323` rewrites every top-level `this` to `exports` — so a module that only
                // ever says `this` still needs the parameter bound. rolldown folds the same case into
                // `ModuleOrExports`. Missing it emitted a closure with no `exports` param whose body
                // referenced `exports`, which the CJS `this` tests caught immediately.
                const usesModule = uses.has('module');
                const usesExports = uses.has('exports') || mod.topLevelThis.length > 0;
                const params = usesModule ? ['exports', 'module'] : usesExports ? ['exports'] : [];
                // AST, NOT a text splice. rolldown builds this with `new_commonjs_wrapper_stmt`
                // (`ast_factory.rs:741`), moving `program.body` into the closure — there is no text stage
                // in its pipeline. Building it here means the mappings fall out of printing instead of
                // being patched up afterwards to account for the added header line and indent, which
                // is what used to desynchronize the whole chunk's map when it was missed.
                //
                // The body is materialised (statements + declarators filtered by `live`) BEFORE wrapping
                // and then rendered with shaking off: `live` is keyed by TOP-LEVEL node id, and a closure
                // body is not top level.
                const wrapped: Node[] = [
                    wrapModuleBody({
                        name: wrapName,
                        helper: '__commonJS',
                        params,
                        body: materialiseLiveBody((mod.program.data as { body: Node[] }).body, live),
                        pure: true,
                    }),
                ];
                for (const [map, nodeMode] of [
                    [linked.cjsNamespace, false],
                    [linked.cjsNamespaceNode, true],
                ] as const) {
                    const nsRef = map.get(idx);
                    if (nsRef === undefined) continue;
                    // UNLESS AN IMPORT STATEMENT OWNS IT. `import b from './b.cjs'` evaluates the
                    // module at that statement, so when one exists the decl is emitted there instead
                    // (`collectInitCalls`) and putting a second one here would both redeclare the
                    // binding and run the wrapper early. Only a module reached solely through
                    // `require()` — which sequences its own init — still declares it beside the
                    // wrapper, which is where it has always been.
                    if (interopOwners.has(nsRef)) continue;
                    wrapped.push(interopNamespace(finalNameOf(linked, nsRef), wrapName, nodeMode));
                }
                const rendered = renderBody(wrapped, null);
                out = rendered.code;
                if (wantMap) mapPart = { code: out, map: rendered.map! };
                // The interop namespace is materialized ONCE per (module, isNodeMode), right after its
                // wrapper, and every consumer reads members off it (`nameOfBind`'s `cjs-member`).
                //
                // The second argument is rolldown's `isNodeMode` (D4): an importer that is ESM BY FILE
                // FORMAT gets `__toESM(require_d(), 1)`, which skips the `__esModule` check entirely and
                // hands back the whole `module.exports` as `default` — what Node actually does. A module
                // imported both ways gets both objects; they are genuinely different values.
            }
        }
        const lazyRef = linked.esmInit.get(idx);
        let nsCode: string | null = null;
        if (linked.namespaceOf.has(idx) && !chunk.nsNative?.has(idx)) {
            // `preDeclared` only for the UNSPLIT lazy form, where the binding is hoisted above the
            // closure and assigned inside it. A split module keeps its namespace at top level.
            nsCode = renderNamespaceObject(
                graph,
                linked,
                idx,
                chunk,
                shaken?.nsUsage.get(idx),
                tight,
                lazyRef !== undefined && !linked.esmInitSplit.has(idx),
                linked.esmInitSplit.has(idx),
            );
            out += `\n${nsCode}`;
        }
        // LAZY INIT — an ESM module reached only through `require()` (§7.20/D1). Its whole body,
        // initializers move inside an `__esm` closure so they evaluate at the require CALL, while the
        // declarations stay at top level — rolldown's single wrapped-ESM shape
        // (`module_finalizers/impl_visit_mut.rs:283-331`), which it builds unconditionally.
        //
        // The namespace object stays OUTSIDE and is built from those hoisted bindings, so it must
        // use accessors — a value snapshot taken here would capture `undefined`, since nothing has
        // been assigned until `init` runs.
        if (lazyRef !== undefined && out !== '') {
            const initName = finalNameOf(linked, lazyRef);
            if (splitRender !== null) {
                //
                // AST, not a text splice — same reason as the CommonJS wrapper above. `lazySplit`
                // already hands back STATEMENT ARRAYS, so the hoisted bindings, the kept function
                // declarations and the closure render as one body and the mappings fall out of
                // printing instead of needing the mappings shoved down and right afterwards.
                const headAndClosure = renderStmts!(
                    [
                        ...splitRender.hoisted,
                        ...splitRender.functions,
                        wrapModuleBody({ name: initName, helper: '__esm', params: [], body: splitRender.body, pure: true }),
                    ],
                    null,
                );
                // `nsCode` was appended to `out` before this block; replacing `out` wholesale dropped
                // it and left `e_ns is not defined`. Re-append it AFTER the closure — the namespace
                // reads hoisted bindings, so it may be built at top level, and it must be, because a
                // consumer names it outside.
                // NO eager `init()` call at the module's own slot. `link.ts` sets `esmInitSplit`
                // only for require-ONLY targets, and the whole point of the lazy form is that such
                // a module runs at the require CALL and not before — an eager call here re-broke
                // all six laziness tests (never-reached require, ordering, sticky throw). The
                // mixed case, which DOES need a call because a static importer reads the bindings,
                // still takes the eager path in `link.ts` and never reaches here.
                out = `${headAndClosure.code}${nsCode === null ? '' : `\n${nsCode}`}`;
                if (mapPart !== null) {
                    // One part per emitted region: `joinParts` derives each span from its own `code`,
                    // so they stay aligned. The namespace object is still emitter TEXT and keeps its
                    // own (unmapped) part, as it always did.
                    splitMapParts = [
                        { code: headAndClosure.code, map: headAndClosure.map ?? undefined },
                        ...(nsCode === null ? [] : [{ code: nsCode }]),
                    ];
                    mapPart = null;
                    nsCode = null; // already inside `out`, and covered by the parts above
                }
            }
        }
        if (out !== '') moduleTexts.push(out);
        if (wantMap && out !== '') {
            mapSources.push(mod.id);
            mapSourcesContent.push(mod.source);
            if (splitMapParts !== null) moduleParts.push(...splitMapParts);
            else moduleParts.push(mapPart!);
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
        // A `*` specifier is a NATIVE namespace import (chunk-graph `nsNative`): the host builds the
        // Module namespace, so it gets its own statement rather than joining the named clause.
        for (const s of specs)
            if (s.imported === NAME_NAMESPACE) crossImportLines.push(importStmt(`* as ${s.local}`, path, tight));
        const named = specs.filter((s) => s.imported !== NAME_NAMESPACE);
        if (named.length === 0) continue;
        const parts = named.map((s) => (s.imported === s.local ? s.imported : `${s.imported} as ${s.local}`));
        const inner = parts.join(clauseSep(tight));
        crossImportLines.push(importStmt(tight ? `{${inner}}` : `{ ${inner} }`, path, tight));
    }
    for (const producerChunk of chunk.sideEffectImports) {
        crossImportLines.push(tight ? `import'${pathToChunk(producerChunk)}';` : `import '${pathToChunk(producerChunk)}';`);
    }

    // External imports, scoped to this chunk's used external locals.
    const extImports = renderExternalImports(linked, sideEffectSpecs, tight);

    // `exports: 'none'` suppresses the entry export line entirely (validation-only shaping for
    // pure ESM — cross-chunk producer exports still emit so shared chunks keep working). For a
    // shared/producer chunk it is `chunk.exports`.
    const exportSpecs: string[] = [];
    const exportedNames: string[] = [];
    let cjsEntryDefault: string | null = null;
    const seenExport = new Set<string>();
    // `output.exports` must be CONSISTENT with what the entry actually exports — rollup's
    // `getExportMode` (`utils/getExportMode.ts:13-20`). `'default'` demands the entry export exactly
    // `default`; `'none'` demands it export nothing. We accepted either silently and then just
    // suppressed the export line, so a misconfigured build produced a chunk missing its exports
    // instead of telling the user.
    if (
        chunk.entryModule >= 0 &&
        (chunk.isEntry || chunk.isDynamicEntry) &&
        (naming.exports === 'default' || naming.exports === 'none')
    ) {
        const keys = [...(linked.exportMaps.get(chunk.entryModule)?.keys() ?? [])];
        const bad = naming.exports === 'default' ? !(keys.length === 1 && keys[0] === NAME_DEFAULT) : keys.length > 0;
        if (bad) {
            // rollup's `printQuotedStringList`: one item bare, otherwise `"a", "b" and "c"`.
            const quoted = keys.map((k) => `"${k}"`);
            const list =
                quoted.length <= 1 ? (quoted[0] ?? '') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
            const id = graph.modules[chunk.entryModule].id;
            throw new Error(
                `"${naming.exports}" was specified for "output.exports", but entry module "${relativePath(naming.dir, id)}" has the following exports: ${list}`,
            );
        }
    }
    const suppressEntryExports = naming.exports === 'none';
    // Entry (and dynamic-entry) chunks export their entry module's surface.
    if (!suppressEntryExports && chunk.entryModule >= 0 && (chunk.isEntry || chunk.isDynamicEntry)) {
        // A CommonJS entry has no ESM export surface — its exports are `module.exports`, produced by
        // calling the wrapper. rolldown emits exactly `export default require_main();`
        // (`cjs_compat/cjs_entry`). Without this the chunk exported NOTHING: a `import('./x.cjs')`
        // resolved to an empty namespace, and a CommonJS entry point yielded `undefined` downstream.
        const entryWrapRef = linked.cjsWrap.get(chunk.entryModule);
        if (entryWrapRef !== undefined) {
            // Its own statement, not an `export { … }` specifier: a specifier must be an identifier,
            // and this is a CALL. `export default require_main();`
            seenExport.add(NAME_DEFAULT);
            // Chunk-local alias first — a FACADE entry chunk (one whose entry module lives in
            // another chunk, minted when two static entries share a color) has to call the name it
            // imported the wrapper under. rolldown's `multiple_circle_cjs_entries` snapshot is the
            // same shape: `import { t as require_b } from "./a.js"; export default require_b();`.
            cjsEntryDefault = `export default ${chunk.importLocalOf.get(entryWrapRef) ?? finalNameOf(linked, entryWrapRef)}();`;
            exportedNames.push(NAME_DEFAULT);
        }
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
    // Native-namespace producers: surface the module's OWN export names so a consumer's
    // `import * as ns from './thisChunk'` sees the real surface. `nativeNsEligible` guarantees this
    // chunk holds exactly that module and every member is one of its own locals, so these names
    // cannot collide with a sibling's.
    for (const modIdx of chunk.nsNative ?? []) {
        for (const [name, bind] of linked.exportMaps.get(modIdx) ?? []) {
            if (seenExport.has(name)) continue;
            const local = nameOfBind(linked, bind, chunk);
            if (local === null) continue;
            seenExport.add(name);
            const exported = isIdentName(name) ? name : JSON.stringify(name);
            exportSpecs.push(local === name ? exported : `${local} as ${exported}`);
            exportedNames.push(name);
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
    // The shared runtime chunk exports the helpers it defines, under their own names. Not routed
    // through `chunk.exports`, which is keyed on symbol refs — a helper has no ref, it is text.
    if (chunk.runtimeHelpers !== undefined) {
        for (const name of chunk.runtimeHelpers) {
            if (seenExport.has(name)) continue;
            seenExport.add(name);
            exportSpecs.push(name);
            exportedNames.push(name);
        }
    }
    const exportInner = exportSpecs.join(clauseSep(tight));
    const exportLine = exportSpecs.length > 0 ? (tight ? `export{${exportInner}};` : `export { ${exportInner} };`) : null;
    const starLines = suppressEntryExports
        ? []
        : entryStarSpecs.map((spec) => (tight ? `export*from'${spec}';` : `export * from '${spec}';`));

    // CommonJS runtime helpers. Which ones a chunk needs is decided by `helpersNeededBy`, shared
    // with chunk-graph so the SHARED-RUNTIME decision (below) uses the same answer the render does.
    const wanted = helpersNeededBy(graph, linked, chunk);
    const helperLines: string[] = [];
    if (chunk.runtimeHelpers !== undefined) {
        // THIS is the runtime chunk: it defines the union of every consumer's helpers and exports
        // them. rolldown does the same, as a real module in the graph (`runtime_module_task.rs`);
        // shakeup keeps them as text but gives them their own chunk, which is where the DUPLICATION
        // was — measured at 6 identical copies of the helper set across 7 chunks (D5).
        for (const name of chunk.runtimeHelpers) if (name === REQUIRE_SHIM_KEY) helperLines.push(...requireShimLines(graph));
        for (const [name, src] of Object.entries(CJS_HELPERS)) if (chunk.runtimeHelpers.has(name)) helperLines.push(src);
    } else if (chunk.importsRuntime) {
        // A consumer: the helpers arrive as a cross-chunk import, already in `crossImportLines`.
    } else {
        if (wanted.has(REQUIRE_SHIM_KEY)) helperLines.push(...requireShimLines(graph));
        for (const [name, src] of Object.entries(CJS_HELPERS)) if (wanted.has(name)) helperLines.push(src);
    }

    // Empty non-entry chunk with nothing to emit: drop it.
    const isEmpty =
        moduleTexts.length === 0 &&
        exportLine === null &&
        cjsEntryDefault === null &&
        starLines.length === 0 &&
        helperLines.length === 0;
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
    parts.push(...helperLines);
    parts.push(...moduleTexts);
    if (exportLine !== null) parts.push(exportLine);
    if (cjsEntryDefault !== null) parts.push(cjsEntryDefault);
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
        // The CommonJS runtime helpers are in `parts` but were MISSING here, so every mapped line
        // sat ~30 generated lines above where it belonged and the whole chunk's map pointed at the
        // wrong source lines — silently, since a map that decodes fine looks fine. `joinParts`
        // derives each part's line span from its `code`, so the two lists have to agree exactly.
        for (const s of helperLines) mapParts.push({ code: s });
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
