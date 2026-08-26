import { deconflictChunk } from './deconflict';
import { type ChunkSlots, computeChunkSlots, mangleChunkScopes, topLevelSlotWeights } from './mangle/chunk';
import { type Graph, type ImportBind, type Linked, NAME_NAMESPACE, packRef, refMod, refSym } from './graph-types';
import { finalNameOf, reprName } from './link';

/** A cross-chunk import specifier: the producer chunk's exported name → this chunk's local. */
export type CrossImport = { imported: string; local: string };

/** A binding a chunk exports to other chunks: the producer symbol ref (or namespace), and
 *  the deconflicted name it is surfaced under in THIS (producer) chunk. */
export type ChunkExport = { ref: number; exportedName: string; local: string };

/** One emitted chunk (pre-render). */
export type Chunk = {
    /** Logical name (entry name, else derived from a member id). */
    name: string;
    /** Member module idxs, exec-ordered (a subsequence of `linked.order`). */
    modules: number[];
    /** Post-optimization dependent-entry bitset (identity key for the partition). */
    color: bigint;
    /** The entry module idx if this is an entry / dynamic-entry chunk, else -1. */
    entryModule: number;
    isEntry: boolean;
    isDynamicEntry: boolean;
    /** producer chunk idx → specifiers imported from it (static, named/namespace). */
    imports: Map<number, CrossImport[]>;
    /** producer chunk idx → the specifier is a bare side-effect `import './x';` (no names). */
    sideEffectImports: Set<number>;
    /** exportedName → the local binding surfaced under it (drives `export { local as name }`). */
    exports: Map<string, ChunkExport>;
    /** chunkIdx of dynamic-import targets (for `import('./target')` rewrites). */
    dynamicImports: Set<number>;
    /** Local aliases for cross-chunk imports into this chunk, keyed by producer packRef. */
    importLocalOf: Map<number, string>;
    /** Local alias for a cross-chunk NAMESPACE import into this chunk, keyed by module idx. */
    nsImportLocalOf: Map<number, string>;
    /** Producer-side: chosen export name per exported symbol ref (memo, dedup). */
    exportNameOfRef?: Map<number, string>;
    /** Producer-side: chosen export name per exported namespace module (memo, dedup). */
    nsExportName?: Map<number, string>;
    /** Producer-side: modules whose FULL export surface this chunk must surface as named exports so
     *  a consumer can take a NATIVE `import * as ns from './thisChunk'` instead of importing a
     *  synthesized namespace object. Also suppresses emitting that object here — the host builds a
     *  real Module namespace, which is smaller and spec-exact (live bindings, `[object Module]`,
     *  non-writable) with no help from us. See {@link wireBind}. */
    nsNative?: Set<number>;
};

/** The full chunk partition + lookup structures. */
export type ChunkGraph = {
    chunks: Chunk[];
    /** module idx → owning chunk idx. -1 = no chunk. */
    chunkByModule: Int32Array;
    /** per module → dependent-entry bitset (pre-optimization color, for groups). */
    color: bigint[];
    /** entry module idx → its entry-chunk idx (for dynamic-import target lookup). */
    entryChunkOf: Map<number, number>;
};

/** Options driving chunk formation (a slice of the resolved OutputOptions). */
export type ChunkOptions = {
    /** When false, dynamic-import targets are NOT promoted to entries (they fold into the
     *  importer's chunk and the `import()` is rewritten to `Promise.resolve(ns)`). */
    codeSplitting: boolean;
    /** When true, one chunk per module — bypasses coloring entirely. */
    preserveModules: boolean;
    /** manualChunks-normalized groups. Empty = pure auto-chunking. */
    groups: ResolvedGroup[];
};

/** A group after option normalization (manualChunks → single group). */
export type ResolvedGroup = {
    name: (id: string) => string | null;
    test: ((id: string) => boolean) | null;
    priority: number;
    minSize: number;
    maxSize: number;
    minModuleSize: number;
    maxModuleSize: number;
    minShareCount: number;
    entriesAware: boolean;
    entriesAwareMergeThreshold: number;
    initialOnly: boolean;
    includeDependenciesRecursively: boolean;
    /** Original array index — priority tie-break. */
    index: number;
};

const ZERO = 0n;

function popcount(x: bigint): number {
    let n = 0;
    while (x > ZERO) {
        n += Number(x & 1n);
        x >>= 1n;
    }
    return n;
}

/** Static dep targets of a module: static (non-dynamic) resolved internal edges, including
 *  star re-exports (they carry live bindings across chunks). When `includeDynamic`, dynamic
 *  edges are followed too — used when codeSplitting is off (targets fold into the importer).*/
function staticDeps(graph: Graph, idx: number, includeDynamic: boolean): number[] {
    const mod = graph.modules[idx];
    const out: number[] = [];
    for (const rec of mod.importRecords) {
        if (rec.external || rec.resolved < 0) continue;
        if (rec.kind !== 'dynamic' || includeDynamic) out.push(rec.resolved);
    }
    return out;
}

/** DFS the (static, optionally-dynamic) closure of `root`, invoking `visit(idx)` once per
 *  reached module. */
function staticClosure(graph: Graph, root: number, visit: (idx: number) => void, includeDynamic = false): void {
    const seen = new Uint8Array(graph.modules.length);
    const stack = [root];
    while (stack.length > 0) {
        const idx = stack.pop()!;
        if (idx < 0 || seen[idx] === 1) continue;
        seen[idx] = 1;
        visit(idx);
        for (const dep of staticDeps(graph, idx, includeDynamic)) stack.push(dep);
    }
}

/** For each dynamic entry, the atoms guaranteed already in memory when it loads =
 *  intersection over its dynamic importers of (importer's static-closure atoms).
 *  Those bits are removed from any atom whose color ⊆ (already-loaded ∪ {this entry}),
 *  letting it collapse back and merge with the non-dynamic chunk. */
function optimizeColors(
    graph: Graph,
    color: bigint[],
    entryList: number[],
    isDynamicEntry: boolean[],
    dynamicImporters: number[][],
): void {
    // staticColorOf[e] = OR of colors of every module in entry e's static closure — the set
    // of atoms (by color bit) present when e's chunk is loaded. The per-atom already-loaded set
    // is the union of dependent-entry bits reachable statically from each importer, which is
    // exactly what lets a shared atom shed the dynamic bit.
    for (let e = 0; e < entryList.length; e++) {
        if (!isDynamicEntry[e]) continue;
        const importers = dynamicImporters[e];
        if (importers.length === 0) continue;
        // already = ∩ over importers of the importer's static-closure color bits.
        let already: bigint | null = null;
        for (const imp of importers) {
            let impBits = ZERO;
            staticClosure(graph, imp, (idx) => {
                impBits |= color[idx];
            });
            already = already === null ? impBits : already & impBits;
        }
        if (already === null) continue;
        const eBit = 1n << BigInt(e);
        // Drop bit e from any module whose color, minus bit e, is a subset of `already`
        // — i.e. every other entry that reaches it also already-loads it. Then it need not
        // be duplicated into the dynamic chunk.
        for (let m = 0; m < color.length; m++) {
            if ((color[m] & eBit) === ZERO) continue;
            const without = color[m] & ~eBit;
            if ((without & ~already) === ZERO && without !== ZERO) {
                color[m] = without;
            }
        }
    }
}

/** Assign modules to chunks by post-optimization color. Entry/dynamic-entry modules force
 *  their own chunk (so an entry always emits a file). */
function formChunks(
    graph: Graph,
    linked: Linked,
    color: bigint[],
    entryList: number[],
    entryName: (string | null)[],
    isDynamicEntry: boolean[],
    groupOf: Int32Array | null,
    groupNames: string[],
): { chunks: Chunk[]; chunkByModule: Int32Array; entryChunkOf: Map<number, number> } {
    const N = graph.modules.length;
    const chunkByModule = new Int32Array(N).fill(-1);
    const entryModuleOf = new Map<number, { name: string | null; isEntry: boolean; isDynamic: boolean }>();
    for (let e = 0; e < entryList.length; e++) {
        const m = entryList[e];
        const prior = entryModuleOf.get(m);
        // A module that is both a static entry and a dynamic target stays a static entry.
        entryModuleOf.set(m, {
            name: entryName[e] ?? prior?.name ?? null,
            isEntry: (prior?.isEntry ?? false) || !isDynamicEntry[e],
            isDynamic: (prior?.isDynamic ?? false) || isDynamicEntry[e],
        });
    }

    // Key each module: a grouped module keys on its group; the rest key on color. Modules
    // with equal color always load together → one chunk. An entry module keys on its color
    // like everything else — a module reached ONLY by that entry shares the entry's color and
    // merges into the entry chunk; a shared module gets its own color and its own chunk. Two
    // entries with identical color (mutual static import cycle) merge into one chunk — both
    // map to it via entryChunkOf.
    const keyOf = (idx: number): string => {
        if (groupOf !== null && groupOf[idx] >= 0) return `group:${groupOf[idx]}`;
        return `color:${color[idx].toString(16)}`;
    };

    const chunks: Chunk[] = [];
    const byKey = new Map<string, number>();
    for (const idx of linked.order) {
        if (chunkByModule[idx] >= 0) continue;
        // A module unreachable from any entry (color 0, not an entry) is dead — skip.
        if (color[idx] === ZERO && !entryModuleOf.has(idx)) continue;
        const key = keyOf(idx);
        let ci = byKey.get(key);
        if (ci === undefined) {
            ci = chunks.length;
            chunks.push({
                name: groupOf !== null && groupOf[idx] >= 0 ? groupNames[groupOf[idx]] : reprName(graph.modules[idx]),
                modules: [],
                color: color[idx],
                entryModule: -1,
                isEntry: false,
                isDynamicEntry: false,
                imports: new Map(),
                sideEffectImports: new Set(),
                exports: new Map(),
                dynamicImports: new Set(),
                importLocalOf: new Map(),
                nsImportLocalOf: new Map(),
            });
            byKey.set(key, ci);
        }
        chunks[ci].modules.push(idx);
        chunkByModule[idx] = ci;
    }

    // Mark entry chunks + name them from the entry they contain (first static entry wins;
    // else the dynamic entry). Every entry module maps to its chunk in entryChunkOf.
    const entryChunkOf = new Map<number, number>();
    for (const [m, em] of entryModuleOf) {
        const ci = chunkByModule[m];
        if (ci < 0) continue;
        entryChunkOf.set(m, ci);
        const chunk = chunks[ci];
        if (chunk.entryModule < 0) chunk.entryModule = m;
        if (em.isEntry) {
            if (!chunk.isEntry) {
                chunk.isEntry = true;
                chunk.entryModule = m;
                if (em.name != null) chunk.name = em.name;
            }
        } else if (em.isDynamic && !chunk.isEntry) {
            chunk.isDynamicEntry = true;
            if (chunk.entryModule < 0) chunk.entryModule = m;
        }
    }
    return { chunks, chunkByModule, entryChunkOf };
}

// preserveModules — one chunk per module. Bypasses coloring.
function formPreserveModulesChunks(
    graph: Graph,
    linked: Linked,
): {
    chunks: Chunk[];
    chunkByModule: Int32Array;
    entryChunkOf: Map<number, number>;
} {
    const chunks: Chunk[] = [];
    const chunkByModule = new Int32Array(graph.modules.length).fill(-1);
    const entryChunkOf = new Map<number, number>();
    const nameOf = new Map<number, string | null>();
    const dynamicSet = new Set<number>();
    for (const { module, name } of graph.entries) nameOf.set(module, name);
    for (const mod of graph.modules) {
        for (const rec of mod.importRecords) {
            if (rec.kind === 'dynamic' && !rec.external && rec.resolved >= 0) dynamicSet.add(rec.resolved);
        }
    }
    for (const idx of linked.order) {
        const entryName = nameOf.get(idx);
        const isEntry = entryName !== undefined;
        const isDyn = dynamicSet.has(idx) && !isEntry;
        const ci = chunks.length;
        chunks.push({
            name: entryName ?? reprName(graph.modules[idx]),
            modules: [idx],
            color: ZERO,
            entryModule: isEntry || isDyn ? idx : -1,
            isEntry,
            isDynamicEntry: isDyn,
            imports: new Map(),
            sideEffectImports: new Set(),
            exports: new Map(),
            dynamicImports: new Set(),
            importLocalOf: new Map(),
            nsImportLocalOf: new Map(),
        });
        chunkByModule[idx] = ci;
        if (isEntry || isDyn) entryChunkOf.set(idx, ci);
    }
    return { chunks, chunkByModule, entryChunkOf };
}

// Cross-chunk wiring — populate chunk.imports / chunk.exports from linked.binds.

/** The producer chunk + a stable export-name request for an ImportBind that lands in
 *  another chunk. Returns null for same-chunk / external / unresolved binds (no wiring). */
function crossProducer(
    bind: ImportBind,
    consumerChunk: number,
    chunkByModule: Int32Array,
): { producerChunk: number; ref: number; kind: 'found' | 'namespace'; module: number } | null {
    // A `cjs-member` names its module's interop namespace, which is a real symbol living in that
    // module's chunk — so it crosses a boundary exactly like a `found` bind. Returning null here is
    // what left a consumer chunk emitting `import_d.default` with no import for `import_d`.
    if (bind.kind === 'found' || bind.kind === 'cjs-member') {
        const pc = chunkByModule[refMod(bind.ref)];
        if (pc < 0 || pc === consumerChunk) return null;
        return { producerChunk: pc, ref: bind.ref, kind: 'found', module: refMod(bind.ref) };
    }
    if (bind.kind === 'namespace') {
        const pc = chunkByModule[bind.module];
        if (pc < 0 || pc === consumerChunk) return null;
        return { producerChunk: pc, ref: packRef(bind.module, refSym(0)), kind: 'namespace', module: bind.module };
    }
    return null;
}

/** Producer-side default export name for a synthetic/ref. */
function producerBaseName(graph: Graph, linked: Linked, ref: number, isNs: boolean): string {
    if (isNs) return `${reprName(graph.modules[refMod(ref)])}_ns`;
    return finalNameOf(linked, ref);
}

/** Build the full chunk graph: color → atoms → chunks → wire imports/exports → per-chunk
 *  deconflict. `linked.finalNames` / `namespaceOf` / `externalLocals` are (re)populated by
 *  the per-chunk deconflict; for a single chunk this reproduces the whole-bundle names. */
export function buildChunkGraph(
    graph: Graph,
    linked: Linked,
    options: ChunkOptions,
    deadDynamic: Set<number> = new Set(),
    mangle = false,
): ChunkGraph {
    const N = graph.modules.length;

    if (options.preserveModules) {
        const formed = formPreserveModulesChunks(graph, linked);
        const color: bigint[] = graph.modules.map(() => ZERO);
        wireAndDeconflict(graph, linked, formed.chunks, formed.chunkByModule, formed.entryChunkOf, mangle);
        return { chunks: formed.chunks, chunkByModule: formed.chunkByModule, color, entryChunkOf: formed.entryChunkOf };
    }

    // Entry list = static entries, then discovered dynamic targets.
    const entryList: number[] = [];
    const entryName: (string | null)[] = [];
    const isDynamicEntry: boolean[] = [];
    const entryIndexOf = new Map<number, number>();
    for (const { module, name } of graph.entries) {
        entryIndexOf.set(module, entryList.length);
        entryList.push(module);
        entryName.push(name);
        isDynamicEntry.push(false);
    }

    // Discover dynamic-import targets as entries (unless codeSplitting is off). We grow
    // entryList mid-loop.
    const dynamicImporters: number[][] = [];
    for (let i = 0; i < entryList.length; i++) dynamicImporters.push([]);
    if (options.codeSplitting) {
        for (const mod of graph.modules) {
            for (const rec of mod.importRecords) {
                if (rec.kind !== 'dynamic' || rec.external || rec.resolved < 0 || deadDynamic.has(rec.resolved)) continue;
                const target = rec.resolved;
                let e = entryIndexOf.get(target);
                if (e === undefined) {
                    e = entryList.length;
                    entryIndexOf.set(target, e);
                    entryList.push(target);
                    entryName.push(null);
                    isDynamicEntry.push(true);
                    dynamicImporters.push([]);
                }
                // Record the importer for the already-loaded optimization (only when this
                // entry is genuinely a dynamic entry — a static entry ignores it).
                if (isDynamicEntry[e]) dynamicImporters[e].push(mod.idx);
            }
        }
    }

    // Color: for each entry, DFS static closure, set its bit. When codeSplitting is off,
    // dynamic edges are followed too so targets fold into their importer's chunk.
    const includeDynamic = !options.codeSplitting;
    const color: bigint[] = new Array(N).fill(ZERO);
    for (let e = 0; e < entryList.length; e++) {
        const bit = 1n << BigInt(e);
        staticClosure(
            graph,
            entryList[e],
            (idx) => {
                color[idx] |= bit;
            },
            includeDynamic,
        );
    }
    // Pre-optimization color snapshot (for groups' shareCount).
    const preColor = color.map((c) => c);

    optimizeColors(graph, color, entryList, isDynamicEntry, dynamicImporters);

    // groupOf[idx] = group index or -1.
    let groupOf: Int32Array | null = null;
    const groupNames: string[] = [];
    if (options.groups.length > 0) {
        const res = assignGroups(graph, preColor, options.groups);
        groupOf = res.groupOf;
        groupNames.push(...res.groupNames);
    }

    const { chunks, chunkByModule, entryChunkOf } = formChunks(
        graph,
        linked,
        color,
        entryList,
        entryName,
        isDynamicEntry,
        groupOf,
        groupNames,
    );

    wireAndDeconflict(graph, linked, chunks, chunkByModule, entryChunkOf, mangle);
    return { chunks, chunkByModule, color: preColor, entryChunkOf };
}

/** Wire cross-chunk imports/exports from `linked.binds`, resolve dynamic-import targets,
 *  then run per-chunk deconflict in the correct order (producers before consumers). */
function wireAndDeconflict(
    graph: Graph,
    linked: Linked,
    chunks: Chunk[],
    chunkByModule: Int32Array,
    entryChunkOf: Map<number, number>,
    mangle = false,
): void {
    const memberSets = chunks.map((c) => new Set(c.modules));

    // Same-chunk dynamic import() targets need a namespace object to resolve against
    // (`Promise.resolve(<ns>)`). A module dynamically imported whose target lands in the SAME
    // chunk (dynamic-optimization collapse, or a static-dominated dynamic import) gets a
    // synthesized namespace if it doesn't already have one. Register the BASE name pre-deconflict
    // so the per-chunk deconflict claims it. (Cross-chunk dynamic targets export named bindings
    // instead — no namespace needed.)
    for (const mod of graph.modules) {
        for (const rec of mod.importRecords) {
            if (!rec.hasDynamicLiteral || rec.external || rec.resolved < 0) continue;
            if (chunkByModule[rec.resolved] === chunkByModule[mod.idx] && !linked.namespaceOf.has(rec.resolved)) {
                linked.namespaceOf.set(rec.resolved, `${reprName(graph.modules[rec.resolved])}_ns`);
            }
        }
    }

    // Producer-side deconflict FIRST (each chunk's own names + external locals), seeded empty.
    // This fixes every producer export name before any consumer references it. Order matters:
    // all producers, then consumers layer their import locals on top. We deconflict every chunk
    // here (producer role), then in a second pass add the cross-chunk import locals (consumer
    // role) with the producer names already reserved in that chunk's taken set — reusing the
    // same `taken` via seed.
    // Slot assignment runs FIRST. It depends only on the chunk's shape — scopes, bindings, reference
    // sites — never on names, so it is free to precede deconflict, and the per-slot weights it yields
    // are what let deconflict spend its shortest names on the busiest slots instead of on whichever
    // module happened to be ordered first. The same computation is handed to the mangler below, so
    // slots are assigned once per chunk, not twice.
    const chunkSlots: (ChunkSlots | null)[] = [];
    const chunkClaim: ((base: string) => string)[] = [];
    const chunkTaken: Set<string>[] = [];
    for (let c = 0; c < chunks.length; c++) {
        const taken = new Set<string>();
        chunkTaken.push(taken);
        const pre = mangle ? computeChunkSlots(graph, linked, chunks[c].modules) : null;
        chunkSlots.push(pre);
        const weights = pre === null ? null : topLevelSlotWeights(pre);
        const claim = deconflictChunk(graph, linked, chunks[c].modules, memberSets[c], [], mangle, taken, weights);
        chunkClaim.push(claim);
    }

    // Wire imports/exports. For every imported binding whose producer lands in another chunk,
    // record a cross-chunk import on the consumer + a matching export on the producer.
    for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c];
        for (const idx of chunk.modules) {
            const mod = graph.modules[idx];
            for (const [localSym, imp] of mod.namedImports) {
                void imp;
                const bind = linked.binds.get(packRef(idx, localSym));
                if (bind === undefined) continue;
                wireBind(graph, linked, chunks, chunkByModule, chunkClaim, c, bind);
            }
            // `require('./x')` references the target's WRAPPER, and that reference is not a named
            // import, so nothing above wires it. rolldown reaches the same place by pushing
            // `target.wrapper_ref` into `depended_symbols` (`compute_cross_chunk_links.rs:659`).
            for (const rec of mod.importRecords) {
                if (rec.kind !== 'require' || rec.external || rec.resolved < 0) continue;
                const wrapRef = linked.cjsWrap.get(rec.resolved);
                if (wrapRef !== undefined) wireBind(graph, linked, chunks, chunkByModule, chunkClaim, c, { kind: 'found', ref: wrapRef });
                const nsRef = linked.cjsNamespace.get(rec.resolved);
                if (nsRef !== undefined) wireBind(graph, linked, chunks, chunkByModule, chunkClaim, c, { kind: 'found', ref: nsRef });
                // Requiring an ES MODULE reads its namespace object and — when the target is lazy —
                // calls its `__esm` init. Neither is a named import either, and across a chunk
                // boundary both dangled: the producer declared them and the consumer referenced them
                // with nothing joining the two.
                if (wrapRef === undefined && linked.namespaceOf.has(rec.resolved)) {
                    wireBind(graph, linked, chunks, chunkByModule, chunkClaim, c, { kind: 'namespace', module: rec.resolved });
                    const initRef = linked.esmInit.get(rec.resolved);
                    if (initRef !== undefined) wireBind(graph, linked, chunks, chunkByModule, chunkClaim, c, { kind: 'found', ref: initRef });
                }
            }
        }
    }

    // Cross-chunk re-exports: an entry/producer chunk may re-export a binding whose producer is
    // in another chunk. The entry's export map is materialized below in bundle.ts; here we
    // ensure such producer exports exist and the entry chunk imports them.
    for (const [entryModule, chunkIdx] of entryChunkOf) {
        const map = linked.exportMaps.get(entryModule);
        if (map === undefined) continue;
        for (const bind of map.values()) {
            wireBind(graph, linked, chunks, chunkByModule, chunkClaim, chunkIdx, bind);
        }
    }

    // Dynamic import targets → dynamicImports edges + side-effect imports for cross-chunk bare
    // `import './x'` (no named bindings).
    for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c];
        for (const idx of chunk.modules) {
            const mod = graph.modules[idx];
            for (const rec of mod.importRecords) {
                if (rec.external || rec.resolved < 0) continue;
                if (rec.kind === 'dynamic') {
                    const targetChunk = chunkByModule[rec.resolved];
                    if (targetChunk >= 0 && targetChunk !== c) chunk.dynamicImports.add(targetChunk);
                } else {
                    // Bare side-effect import: a static import with no named bindings whose
                    // target is a different chunk must still be kept as `import './x';`.
                    const producer = chunkByModule[rec.resolved];
                    if (producer >= 0 && producer !== c && !chunk.imports.has(producer)) {
                        // Only add if this record binds no names into this chunk (checked by
                        // whether any of the chunk's imports already reference producer).
                        chunk.sideEffectImports.add(producer);
                    }
                }
            }
        }
        // A producer already carrying named imports needn't also be a side-effect import.
        for (const p of chunk.imports.keys()) chunk.sideEffectImports.delete(p);
    }

    // Mangle nested locals last, once each chunk's top-level name set (`chunkTaken[c]`) is
    // complete — including cross-chunk import locals claimed above — so no local shadows a
    // chunk-top name it references.
    if (mangle) {
        for (let c = 0; c < chunks.length; c++) {
            const pre = chunkSlots[c];
            if (pre !== null) mangleChunkScopes(graph, linked, chunkTaken[c], pre);
        }
    }
}

/** Whether module `modIdx`'s namespace can be handed to another chunk as a NATIVE `import * as`
 *  rather than a synthesized object. Two conditions, both conservative — a false negative only
 *  costs the old synthesized form:
 *
 *  1. `modIdx` is the producer chunk's ONLY module. Otherwise its export names could collide with a
 *     sibling module's in the chunk's single flat export namespace, and a star import needs the
 *     module's real names, unrenamed. (`preserveModules` always satisfies this.)
 *  2. Every member of its export surface is one of its OWN local symbols. A re-export, an external,
 *     or a nested namespace would need its provider wired into this chunk's exports first, which
 *     is not guaranteed at this point in wiring. */
function nativeNsEligible(linked: Linked, producer: Chunk, modIdx: number): boolean {
    if (producer.modules.length !== 1 || producer.modules[0] !== modIdx) return false;
    // A lazily-initialised module (§7.20/D1) has no top-level bindings to surface — they live inside
    // its `__esm` closure — so there is nothing for a native `import * as ns` to name. It exports its
    // assembled namespace object instead, which is the non-native path below.
    if (linked.esmInit.has(modIdx)) return false;
    const map = linked.exportMaps.get(modIdx);
    if (map === undefined || map.size === 0) return false;
    for (const bind of map.values()) {
        if (bind.kind !== 'found' || refMod(bind.ref) !== modIdx) return false;
    }
    return true;
}

/** Record one cross-chunk binding (consumer import + producer export) if it crosses a
 *  chunk boundary. Idempotent per (consumerChunk, ref). */
function wireBind(
    graph: Graph,
    linked: Linked,
    chunks: Chunk[],
    chunkByModule: Int32Array,
    chunkClaim: ((base: string) => string)[],
    consumerChunk: number,
    bind: ImportBind,
): void {
    const cross = crossProducer(bind, consumerChunk, chunkByModule);
    if (cross === null) return;
    const producer = chunks[cross.producerChunk];
    const consumer = chunks[consumerChunk];
    const isNs = cross.kind === 'namespace';

    // Producer export name (deconflicted in producer). Key on ref (found) or module (ns).
    let exportedName: string;
    if (isNs && nativeNsEligible(linked, producer, cross.module)) {
        // NATIVE namespace across a chunk boundary: the producer surfaces the module's own export
        // names and the consumer takes `import * as local from './producer'`. The runtime then
        // supplies a real Module namespace — live bindings, `[object Module]`, non-writable — with
        // no synthesized object, no `Object.freeze`, no accessors. This is what `preserveModules`
        // (one module per chunk) wants for library output, and it is already what a cross-chunk
        // `import()` gets for free by virtue of landing on a dynamic-entry chunk.
        producer.nsNative ??= new Set();
        producer.nsNative.add(cross.module);
        if (consumer.nsImportLocalOf.has(cross.module)) return;
        const local = chunkClaim[consumerChunk](producerBaseName(graph, linked, cross.ref, true));
        consumer.nsImportLocalOf.set(cross.module, local);
        addImport(consumer, cross.producerChunk, NAME_NAMESPACE, local);
        return;
    }
    if (isNs) {
        // Producer builds the namespace object under its OWN deconflicted namespaceOf name and
        // exports it under that name; consumer imports it under a local.
        const surfaceWired = producer.nsExportName?.has(cross.module) ?? false;
        const producerNs = linked.namespaceOf.get(cross.module);
        exportedName = producerNs ?? chunkClaim[cross.producerChunk](producerBaseName(graph, linked, cross.ref, true));
        if (producerNs === undefined) linked.namespaceOf.set(cross.module, exportedName);
        if (!producer.exports.has(exportedName)) {
            producer.nsExportName ??= new Map();
            producer.nsExportName.set(cross.module, exportedName);
            producer.exports.set(exportedName, { ref: cross.ref, exportedName, local: exportedName });
        }
        // The producer WRITES the object literal, so it must be able to name every member. A member
        // whose binding lives in a THIRD chunk (a barrel that re-exports, which is the common shape
        // under preserveModules) was never wired into the producer, so the emitted object referenced
        // an undeclared local — a ReferenceError at runtime, silently. Wire each member into the
        // producer chunk. Guarded on `nsExportName` so it runs once per (producer, module) and
        // terminates on namespace cycles.
        if (!surfaceWired) {
            for (const member of linked.exportMaps.get(cross.module)?.values() ?? [])
                wireBind(graph, linked, chunks, chunkByModule, chunkClaim, cross.producerChunk, member);
        }
    } else {
        const existing = producer.exportNameOfRef?.get(cross.ref);
        if (existing !== undefined) {
            exportedName = existing;
        } else {
            // The producer's local name for this ref is its final deconflicted name.
            const local = finalNameOf(linked, cross.ref);
            exportedName = local;
            producer.exportNameOfRef ??= new Map();
            producer.exportNameOfRef.set(cross.ref, exportedName);
            producer.exports.set(exportedName, { ref: cross.ref, exportedName, local });
        }
    }

    // Consumer import local (deconflicted in consumer). One local per (chunk, ref/module).
    if (isNs) {
        if (consumer.nsImportLocalOf.has(cross.module)) return;
        const local = chunkClaim[consumerChunk](producerBaseName(graph, linked, cross.ref, true));
        consumer.nsImportLocalOf.set(cross.module, local);
        addImport(consumer, cross.producerChunk, exportedName, local);
    } else {
        if (consumer.importLocalOf.has(cross.ref)) return;
        const local = chunkClaim[consumerChunk](finalNameOf(linked, cross.ref));
        consumer.importLocalOf.set(cross.ref, local);
        addImport(consumer, cross.producerChunk, exportedName, local);
    }
}

function addImport(consumer: Chunk, producerChunk: number, imported: string, local: string): void {
    let list = consumer.imports.get(producerChunk);
    if (list === undefined) {
        list = [];
        consumer.imports.set(producerChunk, list);
    }
    if (!list.some((s) => s.imported === imported && s.local === local)) list.push({ imported, local });
}

// Groups — test/priority/minShareCount/$initial/min-maxModuleSize.
function estimateSize(graph: Graph, idx: number): number {
    return graph.modules[idx].source.length;
}

function assignGroups(graph: Graph, preColor: bigint[], groups: ResolvedGroup[]): { groupOf: Int32Array; groupNames: string[] } {
    const N = graph.modules.length;
    const groupOf = new Int32Array(N).fill(-1);
    const groupPriority = new Int32Array(N).fill(-1 << 30);
    const groupNameList: string[] = [];
    const groupNameIndex = new Map<string, number>();
    // $initial = reachable from a static (user) entry. In our color, static entries are the
    // low bits; a module reachable from any is color != 0 (dynamic-only would be a dynamic
    // entry's bit). Approximate: reachable if preColor != 0.
    const isInitial = (idx: number): boolean => preColor[idx] !== ZERO;

    // Stable id order for determinism.
    const orderByStableId = [...graph.modules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((m) => m.idx);

    // The group config that captured each module (for size gating by that config's minSize).
    const capturedBy = new Int32Array(N).fill(-1);

    for (const idx of orderByStableId) {
        const mod = graph.modules[idx];
        const size = estimateSize(graph, idx);
        const shareCount = popcount(preColor[idx]);
        for (const g of groups) {
            if (g.test !== null && !g.test(mod.id)) continue;
            if (g.initialOnly && !isInitial(idx)) continue;
            if (size < g.minModuleSize || size > g.maxModuleSize) continue;
            if (shareCount < g.minShareCount) continue;
            const name = g.name(mod.id);
            if (name === null) continue;
            // Priority resolution: capture iff no prior group, or strictly higher priority,
            // or equal priority but earlier array index. First match at equal priority wins.
            if (groupOf[idx] >= 0) {
                if (g.priority < groupPriority[idx]) continue;
                if (g.priority === groupPriority[idx] && g.index >= capturedBy[idx]) continue;
            }
            let ni = groupNameIndex.get(name);
            if (ni === undefined) {
                ni = groupNameList.length;
                groupNameList.push(name);
                groupNameIndex.set(name, ni);
            }
            groupOf[idx] = ni;
            groupPriority[idx] = g.priority;
            capturedBy[idx] = g.index;
        }
    }

    // includeDependenciesRecursively: pull each captured module's static-dep closure into the
    // SAME group (reduces cross-chunk churn), unless already captured.
    for (let idx = 0; idx < N; idx++) {
        if (groupOf[idx] < 0) continue;
        const g = groups.find((x) => x.index === capturedBy[idx]);
        if (g === undefined || !g.includeDependenciesRecursively) continue;
        const gi = groupOf[idx];
        staticClosure(graph, idx, (dep) => {
            if (groupOf[dep] < 0) {
                groupOf[dep] = gi;
                capturedBy[dep] = g.index;
                groupPriority[dep] = g.priority;
            }
        });
    }

    // Size gating: a group whose total < its config's minSize is discarded (members fall
    // back to auto-chunk). Gate by the capturing config's minSize.
    const groupTotal = new Map<number, number>();
    for (let idx = 0; idx < N; idx++) {
        if (groupOf[idx] < 0) continue;
        groupTotal.set(groupOf[idx], (groupTotal.get(groupOf[idx]) ?? 0) + estimateSize(graph, idx));
    }
    for (let idx = 0; idx < N; idx++) {
        if (groupOf[idx] < 0) continue;
        const g = groups.find((x) => x.index === capturedBy[idx]);
        if (g === undefined || g.minSize <= 0) continue;
        if ((groupTotal.get(groupOf[idx]) ?? 0) < g.minSize) groupOf[idx] = -1;
    }
    return refineGroups(graph, preColor, groups, groupOf, capturedBy, groupNameList);
}

/** Split a module list into pieces each ≤ `maxSize` (greedy pack in stable-id order; a single
 *  oversized module forms its own piece). */
function splitByMaxSize(graph: Graph, mods: number[], maxSize: number): number[][] {
    const sorted = [...mods].sort((a, b) => (graph.modules[a].id < graph.modules[b].id ? -1 : 1));
    const out: number[][] = [];
    let cur: number[] = [];
    let curSize = 0;
    for (const m of sorted) {
        const s = estimateSize(graph, m);
        if (cur.length > 0 && curSize + s > maxSize) {
            out.push(cur);
            cur = [];
            curSize = 0;
        }
        cur.push(m);
        curSize += s;
    }
    if (cur.length > 0) out.push(cur);
    return out;
}

/** Merge entriesAware subgroups whose total size is below `threshold` into the largest
 *  subgroup (a simpler take on rolldown's bitset-nearest merge). */
function mergeSmallPartitions(graph: Graph, partitions: number[][], threshold: number): number[][] {
    const sizeOf = (p: number[]): number => p.reduce((s, m) => s + estimateSize(graph, m), 0);
    let largest = 0;
    for (let i = 1; i < partitions.length; i++) {
        if (sizeOf(partitions[i]) > sizeOf(partitions[largest])) largest = i;
    }
    const kept: number[][] = [partitions[largest]];
    for (let i = 0; i < partitions.length; i++) {
        if (i === largest) continue;
        if (sizeOf(partitions[i]) < threshold) partitions[largest].push(...partitions[i]);
        else kept.push(partitions[i]);
    }
    return kept;
}

/** Refine base groups into final sub-chunks: `entriesAware` partitions a group by the set of
 *  entries reaching each module (its `color` bitset); `maxSize` greedy-splits an oversized
 *  group/subgroup. Returns a finer module→sub-chunk map + per-sub-chunk base names (duplicate
 *  names are fine — the naming pass deduplicates them). */
function refineGroups(
    graph: Graph,
    preColor: bigint[],
    groups: ResolvedGroup[],
    baseGroupOf: Int32Array,
    capturedBy: Int32Array,
    baseNames: string[],
): { groupOf: Int32Array; groupNames: string[] } {
    const N = graph.modules.length;
    const subOf = new Int32Array(N).fill(-1);
    const subNames: string[] = [];
    const byBase = new Map<number, number[]>();
    for (let idx = 0; idx < N; idx++) {
        const b = baseGroupOf[idx];
        if (b < 0) continue;
        let list = byBase.get(b);
        if (list === undefined) {
            list = [];
            byBase.set(b, list);
        }
        list.push(idx);
    }
    for (const base of [...byBase.keys()].sort((a, b) => a - b)) {
        const mods = byBase.get(base) as number[];
        const cfg = groups.find((g) => g.index === capturedBy[mods[0]]) ?? groups[0];
        let partitions: number[][];
        if (cfg.entriesAware) {
            const byColor = new Map<string, number[]>();
            for (const m of mods) {
                const k = preColor[m].toString(16);
                let list = byColor.get(k);
                if (list === undefined) {
                    list = [];
                    byColor.set(k, list);
                }
                list.push(m);
            }
            partitions = [...byColor.keys()].sort().map((k) => byColor.get(k) as number[]);
            if (cfg.entriesAwareMergeThreshold > 0 && partitions.length > 1) {
                partitions = mergeSmallPartitions(graph, partitions, cfg.entriesAwareMergeThreshold);
            }
        } else {
            partitions = [mods];
        }
        for (const part of partitions) {
            const pieces = cfg.maxSize < Number.POSITIVE_INFINITY ? splitByMaxSize(graph, part, cfg.maxSize) : [part];
            for (const piece of pieces) {
                const si = subNames.length;
                subNames.push(baseNames[base]);
                for (const m of piece) subOf[m] = si;
            }
        }
    }
    return { groupOf: subOf, groupNames: subNames };
}
