// Shared vocabulary of the generate stage: the two render contexts, the value that crosses between
// the module pass and the format renderer, and the one naming primitive all three need.
//
// The LEAF of `generate/` — it imports from the link stage and the graph model, and nothing here
// imports a sibling. Extracted first, for the same reason `graph-types.ts` was extracted first when
// `module-graph.ts` was dissolved: every further split then points downward and cannot cycle.

import type { Part } from '../../util/sourcemap.ts';
import type { Chunk, ChunkGraph } from '../chunk-graph.ts';
import { externalKey, type Graph, type ImportBind, type Linked, type Module, NAME_NAMESPACE } from '../graph-types.ts';
import type { InteropOwner } from '../init-obligations.ts';
import { finalNameOf } from '../link.ts';
import type { NormalizedOutputNaming } from '../output-options.ts';
import type { TreeshakeResult } from '../treeshake.ts';

/** Per-module render context. Built once per module inside `renderChunk`'s loop, and by nothing
 *  else — there is no chunk-less caller, which is why every field below is non-null.
 *
 *  It used to carry `chunk`/`chunkGraph`/`pathToChunk` as `| null`, documented "null in link-only
 *  helpers". Those helpers no longer exist: link stopped naming things when `linkGraph` was purified
 *  (see the note at the `linkGraph` call — per-chunk deconflict inside `buildChunkGraph` assigns
 *  names in fresh per-chunk scopes), and the whole-bundle naming perspective went with it. The
 *  nullability outlived it by twelve unreachable branches, several of which read as real alternative
 *  naming paths. */
export type EmitCtx = {
    linked: Linked;
    mod: Module;
    warnings: string[];
    /** Null when `treeshake: false` — the one genuine nullable here. */
    live: Set<number> | null;
    /** The chunk this module is being rendered into. */
    chunk: Chunk;
    chunkGraph: ChunkGraph;
    /** Resolve a target chunk idx to the import specifier this chunk uses for it (relative
     *  path over preliminary/placeholder-bearing filenames). */
    pathToChunk: (targetChunkIdx: number) => string;
    /** Which statement owns each wrapped-CommonJS interop namespace — see `computeInteropOwners`. */
    interopOwners: Map<number, InteropOwner>;
};

/** Resolve a bind to the identifier it renders as, in the perspective of `chunk` (the
 *  consuming chunk). A `found`/`namespace` bind whose producer lives in ANOTHER chunk renders
 *  as this chunk's cross-chunk import LOCAL (recorded during wiring); a same-chunk bind
 *  renders as the producer's final name. */
export function nameOfBind(linked: Linked, bind: ImportBind, chunk: Chunk): string | null {
    switch (bind.kind) {
        case 'found': {
            const local = chunk.importLocalOf.get(bind.ref);
            if (local !== undefined) return local;
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
            const local = chunk.importLocalOf.get(bind.ref) ?? finalNameOf(linked, bind.ref);
            if (local === null) return null;
            return bind.name === NAME_NAMESPACE ? local : `${local}.${bind.name}`;
        }
        case 'namespace': {
            const local = chunk.nsImportLocalOf.get(bind.module);
            if (local !== undefined) return local;
            return linked.namespaceOf.get(bind.module) ?? null;
        }
        case 'external':
            return linked.externalLocals.get(externalKey(bind.specifier, bind.name)) ?? null;
        case 'none':
            return null;
    }
}

/** The printer backend drops import/export statements itself, but still needs the side-effect-import

/** Render one chunk to a {@link RenderedChunk} (placeholders unresolved), or null if it is an
 *  empty non-entry chunk. Cross-chunk `import`/`export` lines are synthesized from
 *  `chunk.imports`/`chunk.exports`, their paths resolved via `pathToChunk` (preliminary,
 *  placeholder-bearing filenames — the real hashed path is substituted in pass C). Banner/intro
 *  are prepended as SYNTHETIC leading map Parts so the per-chunk sourcemap stays in offset. */
/** Everything one chunk's render reads that does not change while rendering it.
 *
 *  This is not a new abstraction: `bundle()` already builds exactly this set as the captured
 *  environment of its `renderer` closure, then expands it back into positional arguments one line
 *  later. Naming it stops the expansion, and gives the render phases something to share.
 *
 *  Per-CHUNK, not per-build — `chunk`, `chunkIdx` and `pathToChunk` are in here, matching rolldown's
 *  `GenerateContext` (`types/generator.rs`), which likewise carries `chunk` and `chunk_idx` beside
 *  `link_output`, `chunk_graph` and `used_symbol_refs`. */
export type RenderCtx = {
    graph: Graph;
    linked: Linked;
    chunkGraph: ChunkGraph;
    chunk: Chunk;
    chunkIdx: number;
    shaken: TreeshakeResult | null;
    /** Decided once for the whole bundle, beside `shaken` — see `computeInteropOwners`. */
    interopOwners: Map<number, InteropOwner>;
    warnings: string[];
    naming: NormalizedOutputNaming;
    wantMap: boolean;
    tight: boolean;
    /** The cosmetic tier runs later over the assembled chunk, so this render must stay READABLE.
     *  Minified printing drops `/*@__PURE__*​/` annotations (1146 → 0 on crashcat), and the chunk
     *  compress re-parses this text — so minifying here would destroy the purity information it
     *  needs and it would keep calls it could otherwise drop. rolldown renders the chunk un-minified
     *  for the same reason and lets `dce_or_minify` do the minifying once, at the end. */
    deferMinify: boolean;
    /** Resolve a target chunk idx to the import specifier this chunk uses for it. */
    pathToChunk: (targetChunkIdx: number) => string;
};

/** What rendering a chunk's modules produced — everything the format renderer needs from that pass.
 *
 *  A returned value, not shared mutable state: the two phases used to be one function and the
 *  accumulators were locals, so "what crosses the seam" was invisible. It is these five. */
export type RenderedModules = {
    /** The module region, as sourcemap parts. Their `code` concatenates to the region's text. */
    parts: Part[];
    mapSources: string[];
    mapSourcesContent: string[];
    /** `export * from '<external>'` specifiers hoisted out of an entry module. */
    entryStarSpecs: string[];
    /** External specifiers imported for side effects only. */
    sideEffectSpecs: Set<string>;
};

export const isIdentName = (s: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);

/** Emit-layer spacing. The AST printer is whitespace-aware, but this hand-built glue (import and
 *  export clauses, the namespace object) carried readable padding regardless of `minify.whitespace`
 *  — 1.4KB on crashcat measured against oxc-minify. Only COLUMNS move: every one of these is a
 *  single line before and after, so the line-counting the source-map parts rely on is untouched. */
export const clauseSep = (tight: boolean): string => (tight ? ',' : ', ');

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

/** Per-module render REUSE: what lets an unchanged module skip re-rendering. Named for the job, not
 *  for the incremental machinery it arrives from (`RenderIncremental.mod`). */
export type ModuleReuse = {
    cache: Map<string, CachedModuleRender>;
    /** Every final name is unchanged from the cached build → referenced names are stable. */
    namesStable: boolean;
    /** Module ids re-parsed this build (source changed) — never reused. */
    changed: Set<string>;
    /** Per-module-index liveness hash (0 when tree-shaking is off). */
    liveHash: number[];
    stats: RenderStats;
};
