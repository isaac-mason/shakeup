// graph-types.ts — shared bundler data model + SymbolRef refs (rolldown `types/`). LEAF module:
// depends only on ast/semantic/plugin/fs types, imported by every stage (scan/link/deconflict/
// treeshake/chunk-graph/bundle). No stage logic here.

import type { Semantic } from './analysis/semantic';
import type { Node, Program } from './ast';
import type { CustomPluginOptions, ModuleSideEffects, ModuleType } from './plugin';

/** Imported name for `import * as ns` / `export * as ns`. */
export const NAME_NAMESPACE = '*';

/** Imported/exported name for the default binding. */
export const NAME_DEFAULT = 'default';

/** How an import edge entered the graph — enumerates exactly the edges shakeup's OWN (JS) parser
 *  discovers: `static`/`dynamic` are wired here, and `new-url` (`new URL('./x', import.meta.url)`)
 *  rides the same record once the asset phase lands. Edges that need another language's parser
 *  (CSS `@import`/`url()`) are NOT core: a css plugin lowers them to JS + emitted assets before the
 *  graph sees them (the Vite model), so they never become an ImportRecordKind. Distinct from the
 *  plugin-facing {@link ./plugin.ImportKind} (the Rollup resolveId kind). */
export type ImportRecordKind = 'static' | 'dynamic' | 'new-url';

/** A resolved edge to another module (deduped per specifier for `static`/`dynamic`). */
export type ImportRecord = {
    specifier: string;
    resolved: number;
    external: boolean;
    /** The edge's origin. `dynamic` means it comes ONLY from `import()` (no static import of the
     *  same specifier): a specifier imported both statically and dynamically collapses to
     *  `static` — the static edge dominates (it's already in the sync graph; the dynamic-ness
     *  adds nothing to chunking once static). Dynamic records carry no `namedImports` (a bare
     *  `import()` binds no names). */
    kind: ImportRecordKind;
    /** True iff a literal `import('…')` for this specifier appears in source — even when the
     *  specifier is also imported statically (so `kind` is `static`). Drives export-map seeding
     *  for the `import()` → `Promise.resolve(ns)` emit without re-walking the AST at link time. */
    hasDynamicLiteral: boolean;
    /** For a `new-url` asset edge: the content-hashed output fileName the asset was emitted as
     *  (per-build, not cached). The emit rewrites the `new URL('…', import.meta.url)` specifier to
     *  this. Undefined until the asset resolves + emits; unset means unresolved (left verbatim). */
    assetFileName?: string;
};

/** A local binding that aliases an imported name. */
export type NamedImport = {
    rec: number;
    name: string;
};

/** An exported name: local binding, re-export, or default expression. */
export type NamedExport = {
    symbol: number;
    rec: number;
    sourceName: string;
    exprNode: Node | null;
};

/** Deconflict-able local SymbolIds for the injected automatic-runtime bindings.
 * Present only on modules that contain JSX; `createElement` is populated only when a
 * key-after-spread fallback fired. Each is a real IMPORT symbol declared in the module's
 * semantic, so link binds it to the resolved runtime module's export and deconflict
 * renames it like any import. */
export type JSXRuntime = {
    jsx: number;
    jsxs: number;
    Fragment: number;
    createElement: number;
};

/** A parsed, analyzed module with its extracted import/export records. */
export type Module = {
    idx: number;
    id: string;
    source: string;
    program: Program;
    nodeCount: number;
    semantic: Semantic;
    importRecords: ImportRecord[];
    namedImports: Map<number, NamedImport>;
    namedExports: Map<string, NamedExport>;
    starExports: number[];
    execOrder: number;
    /** Module uses JSX (set by the parser; gates JSX-runtime injection without a detection walk). */
    hasJSX: boolean;
    jsxRuntime: JSXRuntime | null;
    /** Resolved module-level side-effect flag (transform>load>resolveId>default true). */
    sideEffects: ModuleSideEffects;
    /** Merged per-module plugin scratch space (shallow-merged across the chain). */
    meta: CustomPluginOptions;
    /** Declared module type (js/ts/jsx/tsx/json/…); default derived from the id extension. */
    moduleType: ModuleType;
    /** True iff this module is rooted as an entry (its index appears in `graph.entries`). */
    isEntry: boolean;
    /** Entry name when this module is an entry (first name wins on dedup); else null. */
    entryName: string | null;
    /** Module-level external flag (distinct from per-record ImportRecord.external). */
    external: boolean;
    /** Reverse edges: ids of modules that statically import this one (filled during build). */
    importers: Set<string>;
};

/** The built module graph rooted at one or more entries. */
export type Graph = {
    modules: Module[];
    byId: Map<string, number>;
    /** Entry roots, in normalized input order. Each is (module index, entry name).
     *  Replaces the single `entry`. */
    entries: { module: number; name: string }[];
    errors: string[];
    warnings: string[];
    /** Files a plugin emitted via `ctx.emitFile`, deduped by content-hashed fileName. Merged into
     *  {@link BundleResult.assets} by `bundle()`. */
    emitted: Map<string, string | Uint8Array>;
    /** Modules freshly parsed vs reused from `options.cache` this build. */
    parseStats: ParseStats;
    /** Module ids whose downstream artifacts (link/shake/render) are stale this rebuild —
     *  export-surface changes propagated up the importer graph. Empty on a first/full build
     *  (no prior cache to diff against); the incremental stages read it to skip clean work. */
    affected: Set<string>;
    /** Module ids (re)parsed this build (cache miss) — a superset of `affected`'s seed that
     *  also includes body-only edits and new modules. `changed ∪ affected` = render-dirty. */
    changed: Set<string>;
};

/** A module's parse/analyze/extract result — everything derived purely from its
 *  (post-transform) source, reusable across rebuilds while that source is unchanged.
 *  Per-build state (indices, resolved deps, importers, exec order) is NOT cached. */
export type CachedParse = {
    srcHash: number;
    program: Program;
    nodeCount: number;
    semantic: Semantic;
    importRecords: { specifier: string; kind: ImportRecordKind; hasDynamicLiteral: boolean }[];
    namedImports: Map<number, NamedImport>;
    namedExports: Map<string, NamedExport>;
    starExports: number[];
    hasJSX: boolean;
    jsxRuntime: JSXRuntime | null;
    /** Stable digest of the module's export surface (named-export keys + `export *`
     *  specifiers). A change here means importers' link/shake/render is stale. */
    exportSig: string;
    /** Post-transform source + transform-derived fields, so a signal-mode rebuild can reconstruct
     *  an unchanged module WITHOUT re-loading, re-transforming, re-hashing or re-parsing it. */
    source: string;
    sideEffects: ModuleSideEffects;
    meta: CustomPluginOptions;
    moduleType: ModuleType;
};

/** Persistent per-module cache for incremental rebuilds (id → parsed artifacts). */
export type ParseCache = Map<string, CachedParse>;

/** Per-rebuild counters: modules freshly parsed vs reused from the cache. */
export type ParseStats = { parsed: number; reused: number };

const MOD_SHIFT = 0x200000;

/** Pack (moduleIdx, symbolId) into one SymbolRef number: `mod * 2^21 + sym`. Caps at 2M symbols/module. */
export const packRef = (mod: number, sym: number): number => mod * MOD_SHIFT + sym;

/** Module index of a packed SymbolRef. */
export const refMod = (ref: number): number => Math.floor(ref / MOD_SHIFT);

/** Symbol id of a packed SymbolRef. */
export const refSym = (ref: number): number => ref % MOD_SHIFT;

/** Where an import resolves: a graph symbol, an external, a module namespace, or unresolved. */
export type ImportBind =
    | { kind: 'found'; ref: number }
    | { kind: 'external'; specifier: string; name: string }
    | { kind: 'namespace'; module: number }
    | { kind: 'none' };

/** Result of linking: binds, exec order, final names, and synthesized namespaces. */
export type Linked = {
    graph: Graph;
    order: number[];
    binds: Map<number, ImportBind>;
    finalNames: Map<number, string>;
    namespaceOf: Map<number, string>;
    exportMaps: Map<number, Map<string, ImportBind>>;
    syntheticNames: Map<number, string>;
    externalLocals: Map<string, string>;
    defaultRefs: Map<number, number>;
    errors: string[];
};

/** Key for the shared local of an external import: `${specifier}\x00${importedName}`. */
export const externalKey = (specifier: string, name: string): string => `${specifier}\x00${name}`;
