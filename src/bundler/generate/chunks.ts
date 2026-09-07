// The chunk-rendering driver: two-pass deferred-hash orchestration, plus the file naming, hashing
// and placeholder machinery it needs.
//
// `renderChunk` — the composition of the module pass and the format renderer — lives here rather
// than beside either, because this is the only caller and the pipeline reads top-down from it.

import type { CompressMode } from '../../passes/compress/index.ts';
import {
    composeMappings,
    encodeMappings,
    inlineSourceMapComment,
    joinParts,
    type Part,
    type SourceMap,
} from '../../util/sourcemap.ts';
import type { OutputAsset, OutputChunk } from '../bundle.ts';
import { compressChunk } from '../chunk-compress.ts';
import type { Chunk, ChunkGraph } from '../chunk-graph.ts';
import { basenameOf, dirnameOf, relativePath } from '../fs.ts';
import type { Linked } from '../graph-types.ts';
import {
    DEFAULT_HASH_SIZE,
    effectiveComments,
    getHashPlaceholderGenerator,
    type HashPlaceholderGenerator,
    makeUnique,
    type NormalizedOutputNaming,
    type PreRenderedChunk,
    type RenderedModule,
    renderNamePattern,
    replacePlaceholders,
    replacePlaceholdersWithDefaultAndGetContainedPlaceholders,
    replaceSinglePlaceholder,
} from '../output-options.ts';
import type { ModuleReuse, PreliminaryFileName, RenderCtx, RenderedChunk, RenderStats } from './context.ts';
import { renderEsm } from './esm.ts';
import { renderModules } from './modules.ts';

/** Render one chunk: its modules, then its output format. Kept as a named composition so the two
 *  passes and their one hand-off stay visible at a single place. */
export function renderChunk(ctx: RenderCtx, prelim: PreliminaryFileName, reuse: ModuleReuse | null): RenderedChunk | null {
    return renderEsm(ctx, renderModules(ctx, reuse), prelim);
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

const preRenderedInfo = (
    chunk: Chunk,
    moduleIdOf: (i: number) => string,
    /** INCLUDED module ids — see `includedModuleIds`. Separate from `moduleIdOf`, which still answers
     *  for every ASSIGNED module because `chunkKeyOf` and dirty-tracking need all of them. */
    moduleIdsOf: (c: Chunk) => string[],
): PreRenderedChunk => ({
    name: chunk.name,
    isEntry: chunk.isEntry,
    isDynamicEntry: chunk.isDynamicEntry,
    facadeModuleId: chunk.entryModule >= 0 ? moduleIdOf(chunk.entryModule) : null,
    moduleIds: moduleIdsOf(chunk),
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
    modules: Record<string, RenderedModule>;
};
export type RenderCache = Map<string, CachedRender>;

/** Incremental render inputs: the persistent cache + the render-dirty module ids
 *  (`graph.changed ∪ graph.affected`) + a stats sink + per-module reuse context. */
export type RenderIncremental = { cache: RenderCache; dirty: Set<string>; stats: RenderStats; mod: ModuleReuse };

/** A chunk's stable cross-build identity: its member ids in exec order. Distinct chunks never
 *  share members, so this is unique; exec-order changes (which alter output) change it. */
export function chunkKeyOf(chunk: Chunk, moduleIdOf: (i: number) => string): string {
    return chunk.modules.map(moduleIdOf).join('\x1f');
}

/** Order-independent hash of a live statement-id set (XOR-fold + size), for cheap liveness diffing. */
export function hashLiveSet(set: Set<number>): number {
    let h = 0;
    for (const id of set) h = (h ^ Math.imul(id, 0x9e3779b1)) | 0;
    return (Math.imul(h, 31) + set.size) | 0;
}

/** Order-independent signature of every final name rendered this build (module locals, namespace
 *  objects, external import locals). Equal signatures ⇒ no name shifted, so any clean module's
 *  referenced names are stable and its cached text is reusable. */
export function nameSignature(linked: Linked): number {
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
export function chunkSignature(chunk: Chunk, keyOf: string[]): string {
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
    moduleIdsOf: (c: Chunk) => string[],
    /** Resolved compress mode. `'full'` runs the cosmetic tier over each assembled chunk. */
    compressMode: CompressMode | false,
    /** Mangle inside the chunk pass — set when link-time mangling was skipped so this can run last. */
    chunkMangle: boolean,
    inc?: RenderIncremental,
): { chunks: OutputChunk[]; assets: OutputAsset[] } {
    const chunks = chunkGraph.chunks;
    const wantMap = naming.sourcemap !== false;
    const genPlaceholder = getHashPlaceholderGenerator();
    const reserved = new Set<string>();

    // Pre-render info (needed for pattern functions) computed once.
    const infos = chunks.map((c) => preRenderedInfo(c, moduleIdOf, moduleIdsOf));

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
                modules: cached.modules,
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
            const done = compressChunk(
                rc.code,
                { minify: naming.minify },
                wantMap,
                chunkMangle,
                compressMode === 'full',
                effectiveComments(naming.comments, naming.minify),
            );
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
                modules: rc.modules,
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
    const assets: OutputAsset[] = [];
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
                // A `.map` sidecar has no `name` and no source file — both oracles report exactly
                // this shape for one (measured), so it is spelled out rather than defaulted.
                assets.push({
                    type: 'asset',
                    fileName: mapFileName,
                    source: JSON.stringify(map),
                    names: [],
                    originalFileName: null,
                    originalFileNames: [],
                });
                if (naming.sourcemap !== 'hidden') code += `//# sourceMappingURL=${basenameOf(mapFileName)}\n`;
            }
        }

        outChunks.push({
            // Discriminant, as on `OutputAsset` — both oracles carry it, and `generateBundle` used to
            // stamp it on a copy, which meant the value the CALLER got back had no `type` at all.
            type: 'chunk',
            fileName,
            name: rc.name,
            // The module this chunk fronts, or null for a shared chunk. Already computed for the
            // pattern functions (`preRenderedInfo`) and simply not carried through — rolldown's
            // `RenderedChunk` has it, and a `renderChunk` plugin identifying the entry reaches for
            // it first.
            facadeModuleId: infos[rc.chunkIdx].facadeModuleId,
            isEntry: rc.isEntry,
            isDynamicEntry: rc.isDynamicEntry,
            moduleIds: rc.moduleIds,
            imports: rc.imports,
            dynamicImports: rc.dynamicImports,
            exports: rc.exports,
            modules: rc.modules,
            code,
            map,
        });
    }
    return { chunks: outChunks, assets };
}
