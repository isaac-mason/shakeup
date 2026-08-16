import { walkRefIdents } from './analysis/refs';
import { symbolOf } from './analysis/semantic';
import { N, type Node, walk } from './ast';
import { buildChunkGraph, type Chunk, type ChunkGraph, type ChunkOptions, type ResolvedGroup } from './chunk-graph';
import { applyEdits, collectStripEdits, type Edit, type JSXLower, renderMappedPart } from './emit';
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
import { compilePipeline, type ModuleInfo, type PluginCtx } from './plugin';
import { encodeMappings, joinParts, type Part, type SourceMap } from './sourcemap';
import { type TreeshakeResult, treeshake } from './treeshake';

/** A codeSplitting group as a user config (rolldown `CodeSplittingGroup`, §3.1). */
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

/** Output-shaping options (§3). R4 EXTENDS this same object with naming/hash/sourcemap. */
export type OutputOptions = {
    /** false / the deprecated inlineDynamicImports = don't split dynamic imports out. An
     *  object configures groups. Default true. */
    codeSplitting?: boolean | { minSize?: number; groups?: CodeSplittingGroup[] };
    /** rollup-compat manualChunks — normalized to a single group. */
    manualChunks?: (id: string, meta: { getModuleInfo: (id: string) => ModuleInfo | null }) => string | null | undefined;
    /** Deprecated alias for `codeSplitting: false` (single-input). */
    inlineDynamicImports?: boolean;
    /** One chunk per module, imports preserved as real ESM. */
    preserveModules?: boolean;
    preserveModulesRoot?: string;
};

/** Inputs to {@link bundle}: graph options plus tree-shaking toggle. */
export type BundleOptions = GraphOptions & {
    treeshake?: boolean;
    /** Emit a source map (SMv3) mapping the chunk back to the module sources. */
    sourcemap?: boolean;
    /** Output-shaping config (code splitting, manualChunks, preserveModules). */
    output?: OutputOptions;
};

/** A single emitted chunk (rollup `OutputChunk`). R4 fills `fileName` hashing. */
export type OutputChunk = {
    /** Chunk file name — logical stub `${name}.js` until R4 owns entry/chunkFileNames. */
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

/** Output of {@link bundle}: the chunk graph plus diagnostics and intermediate state. `map`
 *  is present iff `sourcemap` was set (and no `renderChunk` plugin rewrote the chunk). */
export type BundleResult = {
    /** @deprecated single-chunk convenience alias for the ENTRY chunk's `code`. */
    code: string;
    /** The chunk graph. Length ≥ 1 (0 on error). */
    chunks: OutputChunk[];
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
 *  rewriting dynamic `import()` specifiers to their target chunk (§2.5). */
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
            // top-level `import().then()` doesn't read the ns const before it's declared (TDZ)
            // — mirrors rolldown's `Promise.resolve().then(() => foo_exports)`.
            const nsName = ctx.linked.namespaceOf.get(rec.resolved);
            const inner = nsName ?? '{}';
            ctx.edits.push({ start: n.start, end: n.end, text: `Promise.resolve().then(() => ${inner})` });
        } else {
            // Point the specifier at the target chunk's logical path (R4 owns the real path).
            const path = `./${chunkGraph.chunks[targetChunk].name}.js`;
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
    // buildStart is now driven inside buildGraph (full graph-backed ctx for ctx.resolve).
    graph = buildGraph(options, pipeline);
    if (graph.errors.length > 0 || graph.entries.length === 0) {
        return { code: '', chunks: [], errors: graph.errors, warnings: [], graph, linked: null, shaken: null };
    }
    // Link WITHOUT whole-bundle deconflict — the per-chunk deconflict inside buildChunkGraph
    // assigns names in fresh per-chunk scopes (§2.3). For a single chunk this reproduces the
    // whole-bundle names byte-for-byte (same order, same taken seeding).
    const linked = linkGraph(graph, { deconflict: false });
    if (linked.errors.length > 0) {
        return { code: '', chunks: [], errors: linked.errors, warnings: [], graph, linked, shaken: null };
    }

    const warnings: string[] = [...warningsOut, ...graph.warnings];
    const jsxPure = resolveJSXOptions(options.jsx).pure;
    // Tree-shake per module BEFORE chunk assembly (unchanged). Uses binds/exportMaps, not names.
    const shaken = options.treeshake === false ? null : treeshake(graph, linked, jsxPure);

    // Assign chunks → wire cross-chunk imports/exports → per-chunk deconflict (§1-2).
    const chunkOptions = resolveChunkOptions(options.output, graph.entries.length, warnings);
    const chunkGraph = buildChunkGraph(graph, linked, chunkOptions);

    let anyLiveJSX = false;
    for (const mod of graph.modules) {
        const live = shaken === null ? null : shaken.live[mod.idx];
        if (mod.jsxRuntime !== null && moduleHasLiveJSX(mod, live)) anyLiveJSX = true;
    }
    if (!anyLiveJSX) pruneUnusedRuntimeExternals(graph, linked);

    const wantMap = options.sourcemap === true;
    const outputChunks: OutputChunk[] = [];
    for (let ci = 0; ci < chunkGraph.chunks.length; ci++) {
        const chunk = chunkGraph.chunks[ci];
        const rendered = renderChunk(graph, linked, chunkGraph, chunk, ci, shaken, warnings, wantMap);
        if (rendered === null) continue; // empty non-entry chunk dropped (§7)
        outputChunks.push(rendered);
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
    // `code`/`map` aliases point at the FIRST entry chunk (§5.2 back-compat).
    const entryFirst = outputChunks[0];
    return {
        code: entryFirst?.code ?? '',
        chunks: outputChunks,
        errors: [],
        warnings,
        graph,
        linked,
        shaken,
        map: entryFirst?.map,
    };
}

/** Render one chunk to an {@link OutputChunk}, or null if it is an empty non-entry chunk
 *  (dropped per §7). Cross-chunk `import`/`export` lines are synthesized from `chunk.imports`
 *  / `chunk.exports`; module bodies reuse the R2 edit engine but scoped to this chunk. */
function renderChunk(
    graph: Graph,
    linked: Linked,
    chunkGraph: ChunkGraph,
    chunk: Chunk,
    chunkIdx: number,
    shaken: TreeshakeResult | null,
    warnings: string[],
    wantMap: boolean,
): OutputChunk | null {
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
        const jsxCtx: EmitCtx = { graph, linked, mod, edits: [], warnings, live, chunk, chunkGraph };
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
        const ctx: EmitCtx = { graph, linked, mod, edits: stripEdits, warnings, live, chunk, chunkGraph };
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

    // Cross-chunk static imports (§2.2): `import { imported as local, … } from './producer.js';`
    const crossImportLines: string[] = [];
    for (const [producerChunk, specs] of chunk.imports) {
        const path = `./${chunkGraph.chunks[producerChunk].name}.js`;
        const parts = specs.map((s) => (s.imported === s.local ? s.imported : `${s.imported} as ${s.local}`));
        crossImportLines.push(`import { ${parts.join(', ')} } from '${path}';`);
    }
    for (const producerChunk of chunk.sideEffectImports) {
        crossImportLines.push(`import './${chunkGraph.chunks[producerChunk].name}.js';`);
    }

    // External imports (unchanged R2 path), scoped to this chunk's used external locals.
    const extImports = renderExternalImports(linked, sideEffectSpecs);

    // Chunk exports (§2.4). For an entry chunk this is the entry's export surface; for a
    // shared/producer chunk it is `chunk.exports` (the cross-chunk producer names).
    const exportSpecs: string[] = [];
    const exportedNames: string[] = [];
    const seenExport = new Set<string>();
    // Entry (and dynamic-entry) chunks export their entry module's surface.
    if (chunk.entryModule >= 0 && (chunk.isEntry || chunk.isDynamicEntry)) {
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
        // Skip if this is already covered by the entry export surface under the same local.
        const local = e.local;
        seenExport.add(exportedName);
        const exported = isIdentName(exportedName) ? exportedName : JSON.stringify(exportedName);
        exportSpecs.push(local === exportedName ? exported : `${local} as ${exported}`);
        exportedNames.push(exportedName);
    }
    const exportLine = exportSpecs.length > 0 ? `export { ${exportSpecs.join(', ')} };` : null;
    const starLines = entryStarSpecs.map((spec) => `export * from '${spec}';`);

    // Empty non-entry chunk with nothing to emit: drop it (§7).
    const isEmpty = moduleTexts.length === 0 && exportLine === null && starLines.length === 0;
    if (isEmpty && !chunk.isEntry) return null;

    const parts: string[] = [];
    parts.push(...crossImportLines);
    parts.push(...extImports);
    parts.push(...moduleTexts);
    if (exportLine !== null) parts.push(exportLine);
    parts.push(...starLines);
    const code = `${parts.join('\n')}\n`;

    let map: SourceMap | undefined;
    if (wantMap) {
        const all: Part[] = [];
        for (const s of crossImportLines) all.push({ code: s });
        for (const s of extImports) all.push({ code: s });
        all.push(...moduleParts);
        if (exportLine !== null) all.push({ code: exportLine });
        for (const s of starLines) all.push({ code: s });
        const joined = joinParts(all);
        map = {
            version: 3,
            sources: mapSources,
            sourcesContent: mapSourcesContent,
            names: [],
            mappings: encodeMappings(joined.map),
        };
    }

    const importNames: string[] = [];
    for (const p of chunk.imports.keys()) importNames.push(chunkGraph.chunks[p].name);
    for (const p of chunk.sideEffectImports) importNames.push(chunkGraph.chunks[p].name);
    const dynamicImportNames: string[] = [];
    for (const d of chunk.dynamicImports) dynamicImportNames.push(chunkGraph.chunks[d].name);

    void chunkIdx;
    return {
        fileName: `${chunk.name}.js`,
        name: chunk.name,
        isEntry: chunk.isEntry,
        isDynamicEntry: chunk.isDynamicEntry,
        moduleIds: chunk.modules.map((i) => graph.modules[i].id),
        imports: importNames,
        dynamicImports: dynamicImportNames,
        exports: exportedNames,
        code,
        map,
    };
}

/** Resolve user `output` options into {@link ChunkOptions}, normalizing manualChunks → a
 *  single group and inlineDynamicImports → codeSplitting:false (§3.3/§3.5). */
function resolveChunkOptions(output: OutputOptions | undefined, entryCount: number, warnings: string[]): ChunkOptions {
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
        addGroup({ name: (id: string) => fn(id, { getModuleInfo: () => null }) ?? null });
    }
    return { codeSplitting, preserveModules: output?.preserveModules === true, groups };
}
