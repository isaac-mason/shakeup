import { walkRefIdents } from './analysis/refs';
import { symbolOf } from './analysis/semantic';
import { N, type Node, walk } from './ast';
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

/** Inputs to {@link bundle}: graph options plus tree-shaking toggle. */
export type BundleOptions = GraphOptions & {
    treeshake?: boolean;
    /** Emit a source map (SMv3) mapping the chunk back to the module sources. */
    sourcemap?: boolean;
};

/** A single emitted chunk (rollup `OutputChunk`, R2 subset — R3/R4 extend). R2 always
 *  emits exactly one chunk holding every entry and every module. */
export type OutputChunk = {
    /** Chunk file name — R2 stub: derived from the (first) entry name, e.g. `${name}.js`.
     *  R4 replaces with entryFileNames/chunkFileNames patterns. */
    fileName: string;
    /** Entry name for this chunk (the first entry's name in R2's single chunk). */
    name: string;
    /** True — every R2 chunk is an entry chunk. */
    isEntry: boolean;
    /** Module ids this chunk contains, in emit order. */
    moduleIds: string[];
    code: string;
    map?: SourceMap;
};

/** Output of {@link bundle}: the chunk graph plus diagnostics and intermediate state. `map`
 *  is present iff `sourcemap` was set (and no `renderChunk` plugin rewrote the chunk). */
export type BundleResult = {
    /** @deprecated single-chunk convenience alias for `chunks[0].code`. Kept so every
     *  existing caller/test compiles unchanged in R2. Remove when R3 lands real splitting. */
    code: string;
    /** The chunk graph. R2 always length 1 (or 0 on error). R3 makes this the real output. */
    chunks: OutputChunk[];
    errors: string[];
    warnings: string[];
    graph: Graph | null;
    linked: Linked | null;
    shaken: TreeshakeResult | null;
    /** @deprecated alias for `chunks[0].map`. */
    map?: SourceMap;
};

type EmitCtx = {
    graph: Graph;
    linked: Linked;
    mod: Module;
    edits: Edit[];
    warnings: string[];
    live: Set<number> | null;
};

/** Final output name for an Ident node's symbol, or null if unchanged. */
function renameOf(ctx: EmitCtx, identNode: Node): string | null {
    const sym = symbolOf(ctx.mod.semantic, identNode);
    if (sym === 0) return null;
    const imp = ctx.mod.namedImports.get(sym);
    if (imp !== undefined) {
        const bind = ctx.linked.binds.get(packRef(ctx.mod.idx, sym));
        if (bind === undefined) return null;
        return nameOfBind(ctx.linked, bind);
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
        return nameOfBind(ctx.linked, bind);
    }
    return ctx.linked.finalNames.get(packRef(ctx.mod.idx, sym)) ?? null;
}

/** Whether two entry-export binds are the same target (so merging them into one chunk's
 *  `export { … }` is safe). Mirrors module-graph's internal `sameBind` for the emit path. */
function sameBindForExport(a: ImportBind, b: ImportBind): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'found' && b.kind === 'found') return a.ref === b.ref;
    if (a.kind === 'namespace' && b.kind === 'namespace') return a.module === b.module;
    if (a.kind === 'external' && b.kind === 'external') return a.specifier === b.specifier && a.name === b.name;
    return true;
}

function nameOfBind(linked: Linked, bind: ImportBind): string | null {
    switch (bind.kind) {
        case 'found':
            return finalNameOf(linked, bind.ref);
        case 'namespace':
            return linked.namespaceOf.get(bind.module) ?? null;
        case 'external':
            return linked.externalLocals.get(externalKey(bind.specifier, bind.name)) ?? null;
        case 'none':
            return null;
    }
}

/** Walk an expression/statement subtree adding rename edits (shorthand-aware). */
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

function renderNamespaceObject(linked: Linked, modIdx: number): string {
    const nsName = linked.namespaceOf.get(modIdx)!;
    const map = linked.exportMaps.get(modIdx);
    const entries: string[] = [];
    if (map !== undefined) {
        for (const [name, bind] of map) {
            const value = nameOfBind(linked, bind);
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
    const linked = linkGraph(graph);
    if (linked.errors.length > 0) {
        return { code: '', chunks: [], errors: linked.errors, warnings: [], graph, linked, shaken: null };
    }

    const warnings: string[] = [...warningsOut, ...graph.warnings];
    const parts: string[] = [];
    const entryStarSpecs: string[] = [];
    const sideEffectSpecs = new Set<string>();
    const jsxPure = resolveJSXOptions(options.jsx).pure;
    const shaken = options.treeshake === false ? null : treeshake(graph, linked, jsxPure);

    let anyLiveJSX = false;

    const wantMap = options.sourcemap === true;
    const moduleTexts: string[] = [];
    const moduleParts: Part[] = []; // parallel to moduleTexts, only built when wantMap
    const mapSources: string[] = [];
    const mapSourcesContent: string[] = [];
    for (const idx of linked.order) {
        const mod = graph.modules[idx];
        const live = shaken === null ? null : shaken.live[idx];
        if (mod.jsxRuntime !== null && moduleHasLiveJSX(mod, live)) anyLiveJSX = true;
        const enumFinalName = (idNode: Node): string | null => {
            const sym = symbolOf(mod.semantic, idNode);
            if (sym === 0) return null;
            return linked.finalNames.get(packRef(mod.idx, sym)) ?? null;
        };
        const jsxCtx: EmitCtx = { graph, linked, mod, edits: [], warnings, live };
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
        const ctx: EmitCtx = { graph, linked, mod, edits: stripEdits, warnings, live };
        moduleEdits(ctx, mod.isEntry, entryStarSpecs, sideEffectSpecs);
        let out = applyEdits(mod.source, ctx.edits).trim();
        if (linked.namespaceOf.has(idx)) {
            out += `\n${renderNamespaceObject(linked, idx)}`;
        }
        if (out !== '') moduleTexts.push(out);
        if (wantMap && out !== '') {
            const part = renderMappedPart(mod.source, ctx.edits, mapSources.length);
            mapSources.push(mod.id);
            mapSourcesContent.push(mod.source);
            moduleParts.push(part);
            if (linked.namespaceOf.has(idx)) moduleParts.push({ code: renderNamespaceObject(linked, idx) });
        }
    }

    if (!anyLiveJSX) pruneUnusedRuntimeExternals(graph, linked);

    // Synthetic (generated-only) surrounds, computed once for both the string and the map assembly.
    const extImports = renderExternalImports(linked, sideEffectSpecs);
    let exportLine: string | null = null;
    // Merge the export surfaces of ALL entries into the single chunk's trailing
    // `export { … }`, deduping by exported name (§4.5). With one entry this is byte-
    // identical to the pre-R2 single-entry output. Two entries exporting the same name
    // with DIFFERENT binds is a real conflict in one merged chunk: emit the first, warn.
    // R3 gives each entry its own chunk and the conflict dissolves.
    {
        const merged = new Map<string, ImportBind>();
        const mergedFrom = new Map<string, string>();
        for (const { module, name: entryName } of graph.entries) {
            const entryMap = linked.exportMaps.get(module);
            if (entryMap === undefined) continue;
            for (const [name, bind] of entryMap) {
                const prior = merged.get(name);
                if (prior === undefined) {
                    merged.set(name, bind);
                    mergedFrom.set(name, entryName);
                } else if (!sameBindForExport(prior, bind)) {
                    warnings.push(
                        `entries '${mergedFrom.get(name)}' and '${entryName}' both export '${name}' — merged into one chunk exports the first; R3 chunk splitting will separate them`,
                    );
                }
            }
        }
        if (merged.size > 0) {
            const specifiers: string[] = [];
            for (const [name, bind] of merged) {
                const local = nameOfBind(linked, bind);
                if (local === null) continue;
                const exported = isIdentName(name) ? name : JSON.stringify(name);
                specifiers.push(local === name ? exported : `${local} as ${exported}`);
            }
            if (specifiers.length > 0) exportLine = `export { ${specifiers.join(', ')} };`;
        }
    }
    const starLines = entryStarSpecs.map((spec) => `export * from '${spec}';`);

    parts.push(...extImports);
    parts.push(...moduleTexts);
    if (exportLine !== null) parts.push(exportLine);
    parts.push(...starLines);
    let code = `${parts.join('\n')}\n`;

    let map: SourceMap | undefined;
    if (wantMap) {
        const all: Part[] = extImports.map((s) => ({ code: s }));
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

    for (const hook of pipeline.renderChunk) {
        const result = hook.handler(pluginCtx, code);
        if (result !== null && result !== undefined && result !== code) {
            code = result;
            if (map !== undefined) {
                map = undefined;
                warnings.push('sourcemap omitted: a renderChunk plugin rewrote the chunk');
            }
        }
    }
    for (const hook of pipeline.buildEnd) hook.handler(pluginCtx);
    warnings.push(...warningsOut.splice(0));

    // Wrap the single assembled chunk in one OutputChunk (R2 always length 1). name/
    // fileName come from the first entry; moduleIds are the emit order. code/map are
    // aliased onto the result for back-compat with every existing caller (§5.2).
    const chunkName = graph.entries[0]?.name ?? 'main';
    const chunk: OutputChunk = {
        fileName: `${chunkName}.js`,
        name: chunkName,
        isEntry: true,
        moduleIds: linked.order.map((i) => graph.modules[i].id),
        code,
        map,
    };
    return { code, chunks: [chunk], errors: [], warnings, graph, linked, shaken, map };
}
