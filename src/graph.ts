// Module graph: resolve -> load -> parse -> analyze -> extract module records.
// ESM-only record model (llm/notes/rolldown-internals.md).
// LIMIT: no CommonJS; an unresolvable specifier is external or a build error.

import { type Ast, type NodeId, A, FL, N, createAst, listAt, listLen, text } from './ast';
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
    /** for `export default <expr>`: the expression NodeId (else 0) */
    exprNode: NodeId;
};

/** A parsed, analyzed module with its extracted import/export records. */
export type Module = {
    idx: number;
    /** resolved id (path or virtual id) */
    id: string;
    source: string;
    ast: Ast;
    program: NodeId;
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

/** Collect every bound Ident in a binding pattern into `out`. */
function collectPatternIdents(ast: Ast, node: NodeId, out: NodeId[]): void {
    if (node === 0) return;
    switch (ast.type[node]) {
        case N.Ident:
            out.push(node);
            return;
        case N.ArrayPattern: {
            const ref = A.ArrayPattern.elements(ast, node);
            for (let i = 0; i < listLen(ast, ref); i++) collectPatternIdents(ast, listAt(ast, ref, i), out);
            return;
        }
        case N.ObjectPattern: {
            const ref = A.ObjectPattern.props(ast, node);
            for (let i = 0; i < listLen(ast, ref); i++) collectPatternIdents(ast, listAt(ast, ref, i), out);
            return;
        }
        case N.Property:
            collectPatternIdents(ast, A.Property.value(ast, node), out);
            return;
        case N.AssignPattern:
            collectPatternIdents(ast, A.AssignPattern.left(ast, node), out);
            return;
        case N.RestElement:
            collectPatternIdents(ast, A.RestElement.arg(ast, node), out);
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

const strValue = (ast: Ast, node: NodeId): string => ast.src.slice(ast.start[node] + 1, ast.end[node] - 1);

/** Extract import/export records from the module's top-level statements. */
function extractRecords(mod: Module): void {
    const { ast, semantic } = mod;
    const body = A.Program.body(ast, mod.program);
    for (let i = 0; i < listLen(ast, body); i++) {
        const stmt = listAt(ast, body, i);
        const t = ast.type[stmt];

        if (t === N.ImportDecl) {
            if (ast.flags[stmt] & FL.TYPE_ONLY) continue;
            const source = A.ImportDecl.source(ast, stmt);
            if (source === 0) continue;
            const rec = addRecord(mod, strValue(ast, source));
            const specs = A.ImportDecl.specifiers(ast, stmt);
            for (let j = 0; j < listLen(ast, specs); j++) {
                const spec = listAt(ast, specs, j);
                const st = ast.type[spec];
                if (ast.flags[spec] & FL.TYPE_ONLY) continue;
                let local: NodeId;
                let name: string;
                if (st === N.ImportSpec) {
                    local = A.ImportSpec.local(ast, spec);
                    const imported = A.ImportSpec.imported(ast, spec);
                    name = ast.type[imported] === N.Str ? strValue(ast, imported) : text(ast, imported);
                } else if (st === N.ImportDefaultSpec) {
                    local = A.ImportDefaultSpec.local(ast, spec);
                    name = NAME_DEFAULT;
                } else {
                    local = A.ImportNamespaceSpec.local(ast, spec);
                    name = NAME_NAMESPACE;
                }
                const sym = semantic.nodeSymbol[local];
                if (sym !== 0) mod.namedImports.set(sym, { rec, name });
            }
            continue;
        }

        if (t === N.ExportNamed) {
            if (ast.flags[stmt] & FL.TYPE_ONLY) continue;
            const decl = A.ExportNamed.decl(ast, stmt);
            if (decl !== 0) {
                const dt = ast.type[decl];
                if (dt === N.FuncDecl || dt === N.ClassDecl || dt === N.TSEnumDecl) {
                    const id = A[dt === N.FuncDecl ? 'FuncDecl' : dt === N.ClassDecl ? 'ClassDecl' : 'TSEnumDecl'].id(ast, decl);
                    if (id !== 0) {
                        mod.namedExports.set(text(ast, id), {
                            symbol: semantic.nodeSymbol[id],
                            rec: -1,
                            sourceName: '',
                            exprNode: 0,
                        });
                    }
                } else if (dt === N.VarDecl) {
                    const decls = A.VarDecl.declarators(ast, decl);
                    const idents: NodeId[] = [];
                    for (let j = 0; j < listLen(ast, decls); j++)
                        collectPatternIdents(ast, A.VarDeclarator.id(ast, listAt(ast, decls, j)), idents);
                    for (const id of idents) {
                        mod.namedExports.set(text(ast, id), {
                            symbol: semantic.nodeSymbol[id],
                            rec: -1,
                            sourceName: '',
                            exprNode: 0,
                        });
                    }
                }
                // TSInterfaceDecl / TSTypeAliasDecl: type-only, no runtime export
                continue;
            }
            const source = A.ExportNamed.source(ast, stmt);
            const rec = source !== 0 ? addRecord(mod, strValue(ast, source)) : -1;
            const specs = A.ExportNamed.specifiers(ast, stmt);
            for (let j = 0; j < listLen(ast, specs); j++) {
                const spec = listAt(ast, specs, j);
                if (ast.flags[spec] & FL.TYPE_ONLY) continue;
                const local = A.ExportSpec.local(ast, spec);
                const exported = A.ExportSpec.exported(ast, spec);
                const exportedName = ast.type[exported] === N.Str ? strValue(ast, exported) : text(ast, exported);
                if (rec >= 0) {
                    const sourceName = ast.type[local] === N.Str ? strValue(ast, local) : text(ast, local);
                    mod.namedExports.set(exportedName, { symbol: 0, rec, sourceName, exprNode: 0 });
                } else {
                    mod.namedExports.set(exportedName, {
                        symbol: semantic.nodeSymbol[local],
                        rec: -1,
                        sourceName: '',
                        exprNode: 0,
                    });
                }
            }
            continue;
        }

        if (t === N.ExportDefault) {
            const decl = A.ExportDefault.decl(ast, stmt);
            const dt = ast.type[decl];
            let symbol = 0;
            let exprNode = 0;
            if (dt === N.FuncDecl || dt === N.ClassDecl) {
                const id = A[dt === N.FuncDecl ? 'FuncDecl' : 'ClassDecl'].id(ast, decl);
                if (id !== 0) symbol = mod.semantic.nodeSymbol[id];
                else exprNode = decl; // anonymous default fn/class
            } else {
                exprNode = decl;
            }
            mod.namedExports.set(NAME_DEFAULT, { symbol, rec: -1, sourceName: '', exprNode });
            continue;
        }

        if (t === N.ExportAll) {
            const source = A.ExportAll.source(ast, stmt);
            if (source === 0) continue;
            const rec = addRecord(mod, strValue(ast, source));
            const exported = A.ExportAll.exported(ast, stmt);
            if (exported !== 0) {
                // `export * as ns from '...'`
                mod.namedExports.set(text(ast, exported), { symbol: 0, rec, sourceName: NAME_NAMESPACE, exprNode: 0 });
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
        const ast = createAst();
        const { program } = parse(ast, source, { ts: true });
        for (const e of ast.errors) graph.errors.push(`${id}:${e.pos}: ${e.msg}`);
        const semantic = createSemantic();
        analyze(semantic, ast, program);
        const mod: Module = {
            idx: graph.modules.length,
            id,
            source,
            ast,
            program,
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
            hook.handler(ctx, { id, source, ast, program, semantic });
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
