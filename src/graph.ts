import { type Node, type Program, N, isJSXNode, makeBindingIdentifier, walk } from './ast';
import { type Fs, dirnameOf, joinPath } from './fs';
import { type Pipeline, type Plugin, type PluginCtx, compilePipeline, runLoad, runResolveId, runTransform } from './plugin';
import { parse } from './parser';
import { type Semantic, analyze, createSemantic, declareSyntheticImport } from './analysis/semantic';

/** Imported name for `import * as ns` / `export * as ns`. */
export const NAME_NAMESPACE = '*';
/** Imported/exported name for the default binding. */
export const NAME_DEFAULT = 'default';

/** A resolved edge to another module (deduped per specifier). */
export type ImportRecord = {
    specifier: string;
    resolved: number;
    external: boolean;
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

/** Deconflict-able local SymbolIds for the injected automatic-runtime bindings
 * (plan §5c option A). Present only on modules that contain JSX; `createElement`
 * is populated only when a key-after-spread fallback (§5a.6) fired. Each is a
 * real IMPORT symbol declared in the module's semantic, so link binds it to the
 * resolved runtime module's export and deconflict renames it like any import. */
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
    jsxRuntime: JSXRuntime | null;
};

/** The built module graph rooted at `entry` (an index into `modules`). */
export type Graph = {
    modules: Module[];
    byId: Map<string, number>;
    entry: number;
    errors: string[];
    warnings: string[];
};

/** Automatic-runtime JSX options (plan §4b, P2 subset). No `runtime`/`factory`/
 * `fragment`/`development` — automatic runtime only. */
export type JSXOptions = {
    importSource?: string;
    pure?: boolean;
};

/** Resolve JSX options against defaults (importSource 'react', pure true). */
export function resolveJSXOptions(jsx: JSXOptions | undefined): { importSource: string; pure: boolean } {
    return { importSource: jsx?.importSource ?? 'react', pure: jsx?.pure ?? true };
}

/** Inputs to {@link buildGraph}. */
export type GraphOptions = {
    entry: string;
    fs: Fs;
    external?: string[] | ((specifier: string) => boolean);
    resolve?: (specifier: string, importer: string | null) => string | null;
    plugins?: Plugin[];
    jsx?: JSXOptions;
};

const EXTENSION_PROBES = ['', '.ts', '.js', '/index.ts', '/index.js'];

function defaultResolve(fs: Fs, specifier: string, importer: string | null): string | null {
    if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('/')) return null;
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

/** Collect every BindingIdentifier in a binding pattern into `out`. */
function collectPatternIdents(node: Node | null, out: Node[]): void {
    if (node === null) return;
    switch (node.type) {
        case N.BindingIdentifier:
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
                else exprNode = decl;
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
                mod.namedExports.set(exported.name, { symbol: 0, rec, sourceName: NAME_NAMESPACE, exprNode: null });
            } else {
                mod.starExports.push(rec);
            }
            continue;
        }
    }
}

/** True if `openingName`-carrying attrs put a `key` attribute AFTER a spread
 * (the key-after-spread createElement fallback, plan §5a.6). */
function attrsHaveKeyAfterSpread(attrs: Node[]): boolean {
    let sawSpread = false;
    for (const a of attrs) {
        if (a.type === N.JSXSpreadAttribute) {
            sawSpread = true;
        } else if (a.type === N.JSXAttribute) {
            const name = a.data.name;
            if (sawSpread && name.type === N.JSXIdentifier && name.name === 'key') return true;
        }
    }
    return false;
}

function scanJSX(program: Program): { hasJSX: boolean; needsCreateElement: boolean } {
    let hasJSX = false;
    let needsCreateElement = false;
    walk(program, (n: Node) => {
        if (!isJSXNode(n.type)) return;
        hasJSX = true;
        if (n.type === N.JSXOpeningElement && attrsHaveKeyAfterSpread(n.data.attributes)) {
            needsCreateElement = true;
        }
    });
    return { hasJSX, needsCreateElement };
}

function injectJSXRuntime(mod: Module, importSource: string): void {
    const { hasJSX, needsCreateElement } = scanJSX(mod.program);
    if (!hasJSX) return;

    const runtimeRec = addRecord(mod, `${importSource}/jsx-runtime`);
    const named = (name: string): number => {
        const local = makeBindingIdentifier(name);
        const sym = declareSyntheticImport(mod.semantic, local);
        mod.namedImports.set(sym, { rec: runtimeRec, name });
        return sym;
    };
    const jsx = named('jsx');
    const jsxs = named('jsxs');
    const Fragment = named('Fragment');

    let createElement = 0;
    if (needsCreateElement) {
        const rootRec = addRecord(mod, importSource);
        const local = makeBindingIdentifier('createElement');
        createElement = declareSyntheticImport(mod.semantic, local);
        mod.namedImports.set(createElement, { rec: rootRec, name: 'createElement' });
    }

    mod.jsxRuntime = { jsx, jsxs, Fragment, createElement };
}

/** Resolve, load, parse, and analyze the module graph reachable from the entry. */
export function buildGraph(options: GraphOptions, pipeline?: Pipeline): Graph {
    const graph: Graph = { modules: [], byId: new Map(), entry: -1, errors: [], warnings: [] };
    const jsxOptions = resolveJSXOptions(options.jsx);
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
        const jsx = id.endsWith('.tsx') || id.endsWith('.jsx');
        const { program, errors, nodeCount } = parse(source, { ts: true, jsx });
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
            jsxRuntime: null,
        };
        graph.modules.push(mod);
        graph.byId.set(id, mod.idx);
        extractRecords(mod);
        if (jsx) injectJSXRuntime(mod, jsxOptions.importSource);
        for (const hook of pipe.moduleParsed) {
            hook.handler(ctx, { id, source, program, nodeCount, semantic });
        }
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
                    graph.warnings.push(
                        `'${rec.specifier}' (imported by '${id}') could not be resolved — treated as external. Add it to \`external\` or use a resolver plugin to silence this.`,
                    );
                }
                rec.external = true;
                continue;
            }
            rec.resolved = addModule(options.fs.realpath?.(resolved) ?? resolved);
        }
        return mod.idx;
    };

    const entryId = resolveFn(options.entry, null) ?? options.entry;
    graph.entry = addModule(entryId);
    return graph;
}
