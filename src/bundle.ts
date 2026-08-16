import { walkRefIdents } from './analysis/refs';
import { symbolOf } from './analysis/semantic';
import { N, type Node, walk } from './ast';
import { buildChunkGraph, type Chunk, type ChunkGraph, type ChunkOptions, type ResolvedGroup } from './chunk-graph';
import { applyEdits, collectStripEdits, type Edit, type JSXLower, renderMappedPart } from './emit';
import { basenameOf, dirnameOf, relativePath } from './fs';
import {
    buildGraph,
    externalKey,
    finalNameOf,
    type Graph,
    type GraphOptions,
    type ImportBind,
    type JSXRuntime,
    type Linked,
    linkGraph,
    type Module,
    packRef,
    resolveJSXOptions,
    toModuleInfo,
} from './module-graph';
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
} from './output-options';
import { compilePipeline, type ModuleInfo, type PluginCtx } from './plugin';
import { encodeMappings, inlineSourceMapComment, joinParts, type Part, type SourceMap } from './sourcemap';
import { type TreeshakeResult, treeshake } from './treeshake';

/** A codeSplitting group as a user config. */
export type CodeSplittingGroup = {
    name: string | ((id: string) => string | null);
    test?: string | RegExp | ((id: string) => boolean);
    priority?: number;
    minSize?: number;
    maxSize?: number;
    minModuleSize?: number;
    maxModuleSize?: number;
    minShareCount?: number;
    entriesAware?: boolean;
    includeDependenciesRecursively?: boolean;
    tags?: '$initial'[];
};

/** Output-shaping options plus naming/hash/sourcemap (from {@link OutputOptionsNaming}). */
export type OutputOptions = OutputOptionsNaming & {
    /** false / the deprecated inlineDynamicImports = don't split dynamic imports out. An
     *  object configures groups. Default true. */
    codeSplitting?: boolean | { minSize?: number; groups?: CodeSplittingGroup[] };
    /** manualChunks — normalized to a single group. */
    manualChunks?: (id: string, meta: { getModuleInfo: (id: string) => ModuleInfo | null }) => string | null | undefined;
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

/** `map` is present iff `sourcemap` was set (and no `renderChunk` plugin rewrote the chunk). */
export type BundleResult = {
    /** @deprecated single-chunk convenience alias for the ENTRY chunk's `code`. */
    code: string;
    /** The chunk graph. Length ≥ 1 (0 on error). */
    chunks: OutputChunk[];
    /** Emitted non-chunk files — currently `.map` sidecars (sourcemap: true|'hidden'). */
    assets?: { fileName: string; source: string }[];
    errors: string[];
    warnings: string[];
    graph: Graph | null;
    linked: Linked | null;
    shaken: TreeshakeResult | null;
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

/** Final output name for a module-local SymbolId (import-bound or renamed). */
function finalNameOfSymbol(ctx: EmitCtx, sym: number): string | null {
    const imp = ctx.mod.namedImports.get(sym);
    if (imp !== undefined) {
        const bind = ctx.linked.binds.get(packRef(ctx.mod.idx, sym));
        if (bind === undefined) return null;
        return nameOfBind(ctx.linked, bind, ctx.chunk);
    }
    return ctx.linked.finalNames.get(packRef(ctx.mod.idx, sym)) ?? null;
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

/** Walk an expression/statement subtree adding rename edits (shorthand-aware) AND
 *  rewriting dynamic `import()` specifiers to their target chunk. */
function renameWalk(ctx: EmitCtx, node: Node): void {
    walkRefIdents(node, (ident, shorthandProp) => {
        const newName = renameOf(ctx, ident);
        if (newName === null || newName === ident.name) return;
        ctx.edits.push({
            start: ident.start,
            end: ident.end,
            text: shorthandProp !== null ? `${ident.name}: ${newName}` : newName,
        });
    });
    rewriteDynamicImports(ctx, node);
}

/** Rewrite each literal dynamic `import('./spec')` in `node` to point at the target chunk's
 *  logical import path; if the target collapsed into THIS chunk, replace with
 *  `Promise.resolve(<namespaceObject>)`. External / non-literal import() is left verbatim. */
function rewriteDynamicImports(ctx: EmitCtx, node: Node): void {
    const { mod, chunk, chunkGraph } = ctx;
    if (chunk === null || chunkGraph === null) return;
    walk(node, (n) => {
        if (n.type !== N.ImportExpression) return;
        const source = n.data.source;
        if (source.type !== N.StringLiteral) return;
        const spec = mod.source.slice(source.start + 1, source.end - 1);
        const rec = mod.importRecords.find((r) => r.specifier === spec);
        if (rec === undefined || rec.external || rec.resolved < 0) return;
        const targetChunk = chunkGraph.chunkByModule[rec.resolved];
        if (targetChunk < 0) return;
        if (targetChunk === chunkGraph.chunkByModule[mod.idx]) {
            // Target folded into this chunk: resolve against its namespace object. Defer the
            // namespace access into a microtask (`Promise.resolve().then(() => ns)`) so a
            // top-level `import().then()` doesn't read the ns const before it's declared (TDZ).
            const nsName = ctx.linked.namespaceOf.get(rec.resolved);
            const inner = nsName ?? '{}';
            ctx.edits.push({ start: n.start, end: n.end, text: `Promise.resolve().then(() => ${inner})` });
        } else {
            // Point the specifier at the target chunk's import path (preliminary
            // placeholder-bearing path, resolved to the final hashed name in pass C).
            const path = ctx.pathToChunk !== null ? ctx.pathToChunk(targetChunk) : `./${chunkGraph.chunks[targetChunk].name}.js`;
            ctx.edits.push({ start: source.start, end: source.end, text: `'${path}'` });
        }
    });
}

function moduleEdits(ctx: EmitCtx, isEntry: boolean, entryStarSpecs: string[], sideEffectSpecs: Set<string>): void {
    const { mod } = ctx;
    const src = mod.source;
    for (const statement of mod.program.data.body) {
        if (ctx.live !== null && !ctx.live.has(statement.id)) {
            ctx.edits.push({ start: statement.start, end: statement.end });
            continue;
        }

        if (statement.type === N.ImportDeclaration) {
            if (statement.data.importKind !== 'type') {
                const source = statement.data.source;
                if (source.type === N.StringLiteral && statement.data.specifiers.length === 0) {
                    const spec = src.slice(source.start + 1, source.end - 1);
                    const rec = mod.importRecords.find((r) => r.specifier === spec);
                    if (rec?.external) sideEffectSpecs.add(spec);
                }
            }
            ctx.edits.push({ start: statement.start, end: statement.end });
            continue;
        }

        if (statement.type === N.ExportAllDeclaration) {
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
            ctx.edits.push({ start: statement.start, end: statement.end });
            continue;
        }

        if (statement.type === N.ExportNamedDeclaration) {
            if (statement.data.exportKind === 'type') continue;
            const decl = statement.data.declaration;
            if (decl !== null) {
                if (
                    decl.type === N.TSEnumDeclaration ||
                    decl.type === N.TSInterfaceDeclaration ||
                    decl.type === N.TSTypeAliasDeclaration
                )
                    continue;
                ctx.edits.push({ start: statement.start, end: decl.start });
                renameWalk(ctx, decl);
            } else {
                ctx.edits.push({ start: statement.start, end: statement.end });
            }
            continue;
        }

        if (statement.type === N.ExportDefaultDeclaration) {
            const decl = statement.data.declaration;
            const named = (decl.type === N.FunctionDeclaration || decl.type === N.ClassDeclaration) && decl.data.id !== null;
            if (named) {
                ctx.edits.push({ start: statement.start, end: decl.start });
            } else {
                const ref = ctx.linked.defaultRefs.get(mod.idx);
                const name = ref !== undefined ? finalNameOf(ctx.linked, ref) : `${mod.idx}_default`;
                ctx.edits.push({ start: statement.start, end: decl.start, text: `const ${name} = ` });
            }
            renameWalk(ctx, decl);
            continue;
        }

        renameWalk(ctx, statement);
    }
}

/** True if the module has at least one live statement containing JSX (so its
 * injected runtime import is genuinely needed). `live === null` = no shaking. */
function moduleHasLiveJSX(mod: Module, live: Set<number> | null): boolean {
    for (const statement of mod.program.data.body) {
        if (live !== null && !live.has(statement.id)) continue;
        let found = false;
        walk(statement, (n) => {
            if (n.type === N.JSXElement || n.type === N.JSXFragment) found = true;
        });
        if (found) return true;
    }
    return false;
}

/** Remove injected-runtime external locals that no live JSX demands, unless an
 * AUTHORED import shares the same (specifier, name) — those stay. */
function pruneUnusedRuntimeExternals(graph: Graph, linked: Linked): void {
    const authored = new Set<string>();
    for (const mod of graph.modules) {
        const injected = mod.jsxRuntime;
        const injectedSyms =
            injected === null ? null : new Set([injected.jsx, injected.jsxs, injected.Fragment, injected.createElement]);
        for (const [sym, imp] of mod.namedImports) {
            if (injectedSyms !== null && injectedSyms.has(sym)) continue;
            const rec = mod.importRecords[imp.rec];
            if (rec.external) authored.add(externalKey(rec.specifier, imp.name));
        }
    }
    for (const mod of graph.modules) {
        const injected = mod.jsxRuntime;
        if (injected === null) continue;
        for (const sym of [injected.jsx, injected.jsxs, injected.Fragment, injected.createElement]) {
            if (sym === 0) continue;
            const imp = mod.namedImports.get(sym);
            if (imp === undefined) continue;
            const rec = mod.importRecords[imp.rec];
            if (!rec.external) continue;
            const key = externalKey(rec.specifier, imp.name);
            if (!authored.has(key)) linked.externalLocals.delete(key);
        }
    }
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

function renderNamespaceObject(linked: Linked, modIdx: number, chunk: Chunk | null): string {
    const nsName = linked.namespaceOf.get(modIdx)!;
    const map = linked.exportMaps.get(modIdx);
    const entries: string[] = [];
    if (map !== undefined) {
        for (const [name, bind] of map) {
            const value = nameOfBind(linked, bind, chunk);
            if (value === null) continue;
            entries.push(`${isIdentName(name) ? name : JSON.stringify(name)}: ${value}`);
        }
    }
    return `const ${nsName} = Object.freeze({ ${entries.join(', ')} });`;
}

/** Build, link, tree-shake, and assemble the entry module into a single ESM chunk. */
export function bundle(options: BundleOptions): BundleResult {
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
        getModuleInfo: (id): ModuleInfo | null => {
            if (graph === undefined) return null;
            const idx = graph.byId.get(id);
            return idx === undefined ? null : toModuleInfo(graph, graph.modules[idx]);
        },
        getModuleIds: () => (graph === undefined ? [][Symbol.iterator]() : graph.byId.keys()),
    };
    // buildStart is driven inside buildGraph (full graph-backed ctx for ctx.resolve).
    graph = buildGraph(options, pipeline);
    if (graph.errors.length > 0 || graph.entries.length === 0) {
        return { code: '', chunks: [], errors: graph.errors, warnings: [], graph, linked: null, shaken: null };
    }
    // Link WITHOUT whole-bundle deconflict — the per-chunk deconflict inside buildChunkGraph
    // assigns names in fresh per-chunk scopes. For a single chunk this reproduces the
    // whole-bundle names byte-for-byte (same order, same taken seeding).
    const linked = linkGraph(graph, { deconflict: false });
    if (linked.errors.length > 0) {
        return { code: '', chunks: [], errors: linked.errors, warnings: [], graph, linked, shaken: null };
    }

    const warnings: string[] = [...warningsOut, ...graph.warnings];
    const jsxPure = resolveJSXOptions(options.jsx).pure;
    // Tree-shake per module before chunk assembly. Uses binds/exportMaps, not names.
    const shaken = options.treeshake === false ? null : treeshake(graph, linked, jsxPure);

    // Assign chunks → wire cross-chunk imports/exports → per-chunk deconflict.
    const chunkOptions = resolveChunkOptions(options.output, graph.entries.length, warnings, pluginCtx.getModuleInfo);
    const chunkGraph = buildChunkGraph(graph, linked, chunkOptions);

    let anyLiveJSX = false;
    for (const mod of graph.modules) {
        const live = shaken === null ? null : shaken.live[mod.idx];
        if (mod.jsxRuntime !== null && moduleHasLiveJSX(mod, live)) anyLiveJSX = true;
    }
    if (!anyLiveJSX) pruneUnusedRuntimeExternals(graph, linked);

    // Normalize output naming/hashing/sourcemap config. `sourcemap` (top-level) is a
    // deprecated alias for `output.sourcemap`. Reject `file:` for a multi-chunk build.
    const multiChunk = chunkGraph.chunks.length > 1;
    let naming: NormalizedOutputNaming;
    try {
        naming = normalizeOutputOptions(options.output, options.sourcemap, multiChunk, warnings);
    } catch (e) {
        return { code: '', chunks: [], errors: [(e as Error).message], warnings, graph, linked, shaken };
    }

    // Two-pass render → content-hash → final-hash → substitute (see renderChunks below). The per-chunk
    // renderer closes over graph/linked/shaken and threads the path resolver + addons.
    const renderer: ChunkRenderer = (chunk, ci, prelim, pathToChunk, want) =>
        renderChunk(graph, linked, chunkGraph, chunk, ci, shaken, warnings, want, naming, pathToChunk, prelim);

    let outputChunks: OutputChunk[];
    let assets: { fileName: string; source: string }[];
    try {
        const r = renderChunks(chunkGraph, naming, renderer, (i) => graph.modules[i].id);
        outputChunks = r.chunks;
        assets = r.assets;
    } catch (e) {
        return { code: '', chunks: [], errors: [(e as Error).message], warnings, graph, linked, shaken };
    }

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
): RenderedChunk | null {
    const entryStarSpecs: string[] = [];
    const sideEffectSpecs = new Set<string>();
    const moduleTexts: string[] = [];
    const moduleParts: Part[] = [];
    const mapSources: string[] = [];
    const mapSourcesContent: string[] = [];

    for (const idx of chunk.modules) {
        const mod = graph.modules[idx];
        const live = shaken === null ? null : shaken.live[idx];
        const enumFinalName = (idNode: Node): string | null => {
            const sym = symbolOf(mod.semantic, idNode);
            if (sym === 0) return null;
            return linked.finalNames.get(packRef(mod.idx, sym)) ?? null;
        };
        const jsxCtx: EmitCtx = { graph, linked, mod, edits: [], warnings, live, chunk, chunkGraph, pathToChunk };
        const jsxLower: JSXLower | null =
            mod.jsxRuntime === null
                ? null
                : {
                      renameIdent: (idNode: Node): string | null => renameOf(jsxCtx, idNode),
                      runtimeName: (kind: keyof JSXRuntime): string => {
                          const sym = mod.jsxRuntime![kind];
                          return finalNameOfSymbol(jsxCtx, sym) ?? kind;
                      },
                  };
        let stripEdits = collectStripEdits(mod.program, mod.source, true, enumFinalName, jsxLower);
        if (live !== null) {
            const deadSpans: [number, number][] = [];
            for (const statement of mod.program.data.body) {
                if (!live.has(statement.id)) deadSpans.push([statement.start, statement.end]);
            }
            stripEdits = stripEdits.filter((e) => !deadSpans.some(([s, x]) => e.start >= s && e.end <= x));
        }
        const ctx: EmitCtx = { graph, linked, mod, edits: stripEdits, warnings, live, chunk, chunkGraph, pathToChunk };
        moduleEdits(ctx, mod.isEntry, entryStarSpecs, sideEffectSpecs);
        let out = applyEdits(mod.source, ctx.edits).trim();
        if (linked.namespaceOf.has(idx)) {
            out += `\n${renderNamespaceObject(linked, idx, chunk)}`;
        }
        if (out !== '') moduleTexts.push(out);
        if (wantMap && out !== '') {
            const part = renderMappedPart(mod.source, ctx.edits, mapSources.length);
            mapSources.push(mod.id);
            mapSourcesContent.push(mod.source);
            moduleParts.push(part);
            if (linked.namespaceOf.has(idx)) moduleParts.push({ code: renderNamespaceObject(linked, idx, chunk) });
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
        if (entryMap !== undefined) {
            for (const [name, bind] of entryMap) {
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

/** Resolve user `output` options into {@link ChunkOptions}, normalizing manualChunks → a
 *  single group and inlineDynamicImports → codeSplitting:false. */
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
    const groups: ResolvedGroup[] = [];
    let index = 0;
    const addGroup = (g: CodeSplittingGroup): void => {
        const nameFn: (id: string) => string | null = typeof g.name === 'function' ? g.name : () => g.name as string;
        let testFn: ((id: string) => boolean) | null = null;
        if (typeof g.test === 'string') {
            const t = g.test;
            testFn = (id) => id.includes(t);
        } else if (g.test instanceof RegExp) {
            const re = g.test;
            testFn = (id) => re.test(id);
        } else if (typeof g.test === 'function') {
            testFn = g.test;
        }
        groups.push({
            name: nameFn,
            test: testFn,
            priority: g.priority ?? 0,
            minSize: g.minSize ?? 0,
            maxSize: g.maxSize ?? Number.POSITIVE_INFINITY,
            minModuleSize: g.minModuleSize ?? 0,
            maxModuleSize: g.maxModuleSize ?? Number.POSITIVE_INFINITY,
            minShareCount: g.minShareCount ?? 1,
            initialOnly: (g.tags ?? []).includes('$initial'),
            includeDependenciesRecursively: g.includeDependenciesRecursively ?? true,
            index: index++,
        });
    };
    if (typeof cs === 'object' && cs.groups !== undefined) {
        for (const g of cs.groups) addGroup(g);
    }
    // manualChunks → single group whose `name` is the fn (test/priority/sizes default).
    if (output?.manualChunks !== undefined) {
        const fn = output.manualChunks;
        addGroup({ name: (id: string) => fn(id, { getModuleInfo }) ?? null });
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

/**
 * Drive the whole two-pass flow. `chunkGraph` gives the partition; `naming` the resolved output
 * config; `render` the per-chunk text builder. Returns finalized {@link OutputChunk}s
 * (fileName/code/map placeholder-free) plus emitted `.map` asset entries.
 */
export function renderChunks(
    chunkGraph: ChunkGraph,
    naming: NormalizedOutputNaming,
    render: ChunkRenderer,
    moduleIdOf: (i: number) => string,
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

    // Pass 0b — render every chunk with placeholder-bearing paths.
    const rendered: RenderedChunk[] = [];
    for (let i = 0; i < chunks.length; i++) {
        const rc = render(chunks[i], i, prelim[i], pathFrom(i), wantMap);
        if (rc !== null) rendered.push(rc);
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
