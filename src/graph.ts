// Module graph: resolve -> load -> parse -> analyze -> extract module records.
// ESM-only record model (llm/notes/rolldown-internals.md).
// LIMIT: no CommonJS; an unresolvable specifier is external or a build error.

import { type Node, type Program, N } from './ast';
import { type Fs, dirnameOf, joinPath } from './fs';
import { type Pipeline, type Plugin, type PluginCtx, compilePipeline, runLoad, runResolveId, runTransform } from './plugin';
import { parse } from './parser';
import { type Semantic, analyze, createSemantic } from './analysis/semantic';

/* ------------------------------------------------------------------ types */

/** Imported name for `import * as ns` / `export * as ns`. */
export const NAME_NAMESPACE = '*';
/** Imported/exported name for the default binding. */
export const NAME_DEFAULT = 'default';

/** A resolved edge to another module (deduped per specifier). */
export type ImportRecord = {
    specifier: string;
    /** resolved module idx; -1 = external */
    resolved: number;
    external: boolean;
};

/** A local binding that aliases an imported name. */
export type NamedImport = {
    /** index into module.importRecords */
    rec: number;
    /** imported name on the source module ('default', '*', or a named export) */
    name: string;
};

/** An exported name: local binding, re-export, or default expression. */
export type NamedExport = {
    /** local SymbolId (0 when re-exported or when default-exporting an expression) */
    symbol: number;
    /** re-export source record (-1 = local export) */
    rec: number;
    /** name on the re-export source ('*' for `export * as ns`) */
    sourceName: string;
    /** for `export default <expr>`: the expression Node (else null) */
    exprNode: Node | null;
};

/** A parsed, analyzed module with its extracted import/export records. */
export type Module = {
    idx: number;
    /** resolved id (path or virtual id) */
    id: string;
    /** module source (retained — the emit edit engine rewrites spans over it). */
    source: string;
    program: Program;
    /** number of nodes (ids run 1..nodeCount-1); sizes the semantic id tables. */
    nodeCount: number;
    semantic: Semantic;
    importRecords: ImportRecord[];
    /** local SymbolId -> import info */
    namedImports: Map<number, NamedImport>;
    /** exported name -> export info */
    namedExports: Map<string, NamedExport>;
    /** record indexes of bare `export * from '...'` */
    starExports: number[];
    /** execution order assigned by link (topo) */
    execOrder: number;
};

/** The built module graph rooted at `entry` (an index into `modules`). */
export type Graph = {
    modules: Module[];
    byId: Map<string, number>;
    entry: number;
    errors: string[];
    warnings: string[];
};

/** Inputs to {@link buildGraph}. */
export type GraphOptions = {
    entry: string;
    /** the environment seam — real fs, memory map, HTTP cache, anything (src/fs.ts) */
    fs: Fs;
    /** specifiers treated as external (exact match or custom predicate) */
    external?: string[] | ((specifier: string) => boolean);
    /** override resolution: return resolved id, or null for "not found" */
    resolve?: (specifier: string, importer: string | null) => string | null;
    /** plugin pipeline (rollup-shaped hooks; see src/plugin.ts) */
    plugins?: Plugin[];
};

/* ---------------------------------------------------------------- resolve */

const EXTENSION_PROBES = ['', '.ts', '.js', '/index.ts', '/index.js'];

function defaultResolve(fs: Fs, specifier: string, importer: string | null): string | null {
    if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('/')) return null; // bare: external-or-error
    const base =
        specifier.startsWith('/') || importer === null ? specifier : joinPath(dirnameOf(importer), specifier);
    for (const ext of EXTENSION_PROBES) {
        const candidate = base + ext;
        if (fs.exists(candidate)) return candidate;
    }
    return null;
}

function isExternal(options: GraphOptions, specifier: string): boolean {
    const ext = options.external;
    if (ext === undefined) return false;
    if (typeof ext === 'function') return ext(specifier);
    return ext.includes(specifier);
}

/* ------------------------------------------------------- record extraction */

/** Collect every BindingIdentifier in a binding pattern into `out`. */
function collectPatternIdents(node: Node | null, out: Node[]): void {
    if (node === null) return;
    switch (node.type) {
        case N.BindingIdentifier: // the declaring leaf in every pattern position
            out.push(node);
            return;
        case N.ArrayPattern:
            for (const el of node.data.elements) collectPatternIdents(el, out);
            return;
        case N.ObjectPattern:
            for (const p of node.data.properties) collectPatternIdents(p, out);
            return;
        case N.ObjectProperty:
            collectPatternIdents(node.data.value, out);
            return;
        case N.AssignmentPattern:
            collectPatternIdents(node.data.left, out);
            return;
        case N.RestElement:
            collectPatternIdents(node.data.argument, out);
            return;
    }
}

function addRecord(mod: Module, specifier: string): number {
    // dedupe by specifier (multiple imports from the same module share a record)
    for (let i = 0; i < mod.importRecords.length; i++) {
        if (mod.importRecords[i].specifier === specifier) return i;
    }
    mod.importRecords.push({ specifier, resolved: -1, external: false });
    return mod.importRecords.length - 1;
}

/** The inner value of a string literal node (quotes stripped), read from source. */
const strValue = (source: string, node: Node): string => source.slice(node.start + 1, node.end - 1);

/** Extract import/export records from the module's top-level statements. */
function extractRecords(mod: Module): void {
    const { semantic, source } = mod;
    for (const stmt of mod.program.data.body) {
        if (stmt.type === N.ImportDeclaration) {
            if (stmt.data.importKind === 'type') continue;
            const src = stmt.data.source;
            if (src.type !== N.StringLiteral) continue;
            const rec = addRecord(mod, strValue(source, src));
            for (const spec of stmt.data.specifiers) {
                let local: Node;
                let name: string;
                if (spec.type === N.ImportSpecifier) {
                    if (spec.data.importKind === 'type') continue;
                    local = spec.data.local;
                    const imported = spec.data.imported;
                    name = imported.type === N.StringLiteral ? strValue(source, imported) : imported.name;
                } else if (spec.type === N.ImportDefaultSpecifier) {
                    local = spec.data.local;
                    name = NAME_DEFAULT;
                } else if (spec.type === N.ImportNamespaceSpecifier) {
                    local = spec.data.local;
                    name = NAME_NAMESPACE;
                } else continue;
                const sym = semantic.nodeSymbol[local.id];
                if (sym !== 0) mod.namedImports.set(sym, { rec, name });
            }
            continue;
        }

        if (stmt.type === N.ExportNamedDeclaration) {
            if (stmt.data.exportKind === 'type') continue;
            const decl = stmt.data.declaration;
            if (decl !== null) {
                if (decl.type === N.FunctionDeclaration || decl.type === N.ClassDeclaration || decl.type === N.TSEnumDeclaration) {
                    const id = decl.data.id;
                    if (id !== null) {
                        mod.namedExports.set(id.name, {
                            symbol: semantic.nodeSymbol[id.id],
                            rec: -1,
                            sourceName: '',
                            exprNode: null,
                        });
                    }
                } else if (decl.type === N.VariableDeclaration) {
                    const idents: Node[] = [];
                    for (const d of decl.data.declarations) {
                        if (d.type === N.VariableDeclarator) collectPatternIdents(d.data.id, idents);
                    }
                    for (const id of idents) {
                        mod.namedExports.set(id.name, {
                            symbol: semantic.nodeSymbol[id.id],
                            rec: -1,
                            sourceName: '',
                            exprNode: null,
                        });
                    }
                }
                // TSInterfaceDecl / TSTypeAliasDecl: type-only, no runtime export
                continue;
            }
            const src = stmt.data.source;
            const rec = src !== null && src.type === N.StringLiteral ? addRecord(mod, strValue(source, src)) : -1;
            for (const spec of stmt.data.specifiers) {
                if (spec.type !== N.ExportSpecifier) continue;
                if (spec.data.exportKind === 'type') continue;
                const local = spec.data.local;
                const exported = spec.data.exported;
                const exportedName = exported.type === N.StringLiteral ? strValue(source, exported) : exported.name;
                if (rec >= 0) {
                    const sourceName = local.type === N.StringLiteral ? strValue(source, local) : local.name;
                    mod.namedExports.set(exportedName, { symbol: 0, rec, sourceName, exprNode: null });
                } else {
                    mod.namedExports.set(exportedName, {
                        symbol: semantic.nodeSymbol[local.id],
                        rec: -1,
                        sourceName: '',
                        exprNode: null,
                    });
                }
            }
            continue;
        }

        if (stmt.type === N.ExportDefaultDeclaration) {
            const decl = stmt.data.declaration;
            let symbol = 0;
            let exprNode: Node | null = null;
            if (decl.type === N.FunctionDeclaration || decl.type === N.ClassDeclaration) {
                const id = decl.data.id;
                if (id !== null) symbol = semantic.nodeSymbol[id.id];
                else exprNode = decl; // anonymous default fn/class
            } else {
                exprNode = decl;
            }
            mod.namedExports.set(NAME_DEFAULT, { symbol, rec: -1, sourceName: '', exprNode });
            continue;
        }

        if (stmt.type === N.ExportAllDeclaration) {
            const src = stmt.data.source;
            if (src.type !== N.StringLiteral) continue;
            const rec = addRecord(mod, strValue(source, src));
            const exported = stmt.data.exported;
            if (exported !== null) {
                // `export * as ns from '...'`
                mod.namedExports.set(exported.name, { symbol: 0, rec, sourceName: NAME_NAMESPACE, exprNode: null });
            } else {
                mod.starExports.push(rec);
            }
            continue;
        }
    }
}

/* ------------------------------------------------------------- graph build */

/** Resolve, load, parse, and analyze the module graph reachable from the entry. */
export function buildGraph(options: GraphOptions, pipeline?: Pipeline): Graph {
    const graph: Graph = { modules: [], byId: new Map(), entry: -1, errors: [], warnings: [] };
    const pipe = pipeline ?? compilePipeline(options.plugins ?? []);
    const ctx: PluginCtx = { warn: (m) => graph.warnings.push(m), fs: options.fs };
    const baseResolve = options.resolve ?? ((s: string, i: string | null) => defaultResolve(options.fs, s, i));
    const pluginExternals = new Set<string>();
    const resolveFn = (specifier: string, importer: string | null): string | null => {
        const hit = runResolveId(pipe, ctx, specifier, importer);
        if (hit === false) {
            pluginExternals.add(specifier);
            return null;
        }
        if (typeof hit === 'string') return hit;
        return baseResolve(specifier, importer);
    };
    const loadFn = (id: string): string | null => runLoad(pipe, ctx, id) ?? options.fs.read(id);

    const addModule = (id: string): number => {
        const existing = graph.byId.get(id);
        if (existing !== undefined) return existing;
        let source = loadFn(id);
        if (source === null) {
            graph.errors.push(`cannot load module '${id}'`);
            return -1;
        }
        source = runTransform(pipe, ctx, source, id);
        const { program, errors, nodeCount } = parse(source, { ts: true });
        for (const e of errors) graph.errors.push(`${id}:${e.pos}: ${e.msg}`);
        const semantic = createSemantic();
        analyze(semantic, program, nodeCount);
        const mod: Module = {
            idx: graph.modules.length,
            id,
            source,
            program,
            nodeCount,
            semantic,
            importRecords: [],
            namedImports: new Map(),
            namedExports: new Map(),
            starExports: [],
            execOrder: -1,
        };
        graph.modules.push(mod);
        graph.byId.set(id, mod.idx);
        extractRecords(mod);
        for (const hook of pipe.moduleParsed) {
            hook.handler(ctx, { id, source, program, nodeCount, semantic });
        }
        // resolve edges (depth-first; cycles land as already-registered idx)
        for (const rec of mod.importRecords) {
            if (isExternal(options, rec.specifier) || pluginExternals.has(rec.specifier)) {
                rec.external = true;
                continue;
            }
            const resolved = resolveFn(rec.specifier, id);
            if (resolved === null) {
                if (rec.specifier.startsWith('.') || rec.specifier.startsWith('/')) {
                    graph.errors.push(`cannot resolve '${rec.specifier}' from '${id}'`);
                } else {
                    // rollup parity: unresolved bare specifiers externalize with a
                    // LOUD warning (never silently) — import maps may resolve them
                    // at runtime; otherwise list them in `external` or add a
                    // resolver plugin (nodeResolve)
                    graph.warnings.push(
                        `'${rec.specifier}' (imported by '${id}') could not be resolved — treated as external. Add it to \`external\` or use a resolver plugin to silence this.`,
                    );
                }
                rec.external = true;
                continue;
            }
            // canonical identity: symlinked paths collapse to one module
            rec.resolved = addModule(options.fs.realpath?.(resolved) ?? resolved);
        }
        return mod.idx;
    };

    const entryId = resolveFn(options.entry, null) ?? options.entry;
    graph.entry = addModule(entryId);
    return graph;
}
