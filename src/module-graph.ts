import { type Node, type Program, N, isJSXNode, node, walk } from './ast';
import { type Fs, dirnameOf, joinPath } from './fs';
import { type Pipeline, type Plugin, type PluginCtx, compilePipeline, runLoad, runResolveId, runTransform } from './plugin';
import { parse } from './parser';
import { type Semantic, analyze, createSemantic, declareSyntheticImport, scopeOf, symbolOf } from './analysis/semantic';

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
                const sym = symbolOf(semantic, local);
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
                            symbol: symbolOf(semantic, id),
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
                            symbol: symbolOf(semantic, id),
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
                        symbol: symbolOf(semantic, local),
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
                if (id !== null) symbol = symbolOf(semantic, id);
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
        const local = node(N.BindingIdentifier, 0, 0, name, null);
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
        const local = node(N.BindingIdentifier, 0, 0, 'createElement', null);
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
        analyze(semantic, program);
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

// ─────────────────────────────────────────────────────────────────────────────
// Linking: resolve the graph's import/export edges to concrete symbol binds,
// order modules, and deconflict names into a Linked overlay over the Graph.
// ─────────────────────────────────────────────────────────────────────────────

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

type LinkCtx = {
    graph: Graph;
    linked: Linked;
    nextSynthetic: number[];
};

function syntheticRef(ctx: LinkCtx, mod: number, name: string): number {
    const sym = ctx.nextSynthetic[mod]++;
    const ref = packRef(mod, sym);
    ctx.linked.syntheticNames.set(ref, name);
    return ref;
}

function matchImport(ctx: LinkCtx, module: Module, name: string, seen: Set<number>): ImportBind {
    const { graph } = ctx;
    const seenKey = packRef(module.idx, 0) + hashName(name);
    if (seen.has(seenKey)) return { kind: 'none' };
    seen.add(seenKey);

    const exp = module.namedExports.get(name);
    if (exp !== undefined) {
        if (exp.rec >= 0) {
            const rec = module.importRecords[exp.rec];
            if (rec.external) return { kind: 'external', specifier: rec.specifier, name: exp.sourceName };
            const target = graph.modules[rec.resolved];
            if (exp.sourceName === NAME_NAMESPACE) return namespaceBind(ctx, target);
            return matchImport(ctx, target, exp.sourceName, seen);
        }
        if (exp.symbol !== 0) return { kind: 'found', ref: packRef(module.idx, exp.symbol) };
        if (exp.exprNode !== null) {
            const existing = ctx.linked.defaultRefs.get(module.idx);
            if (existing !== undefined) return { kind: 'found', ref: existing };
            const synth = syntheticRef(ctx, module.idx, `${reprName(module)}_default`);
            ctx.linked.defaultRefs.set(module.idx, synth);
            return { kind: 'found', ref: synth };
        }
        return { kind: 'none' };
    }

    if (name !== NAME_DEFAULT) {
        let found: ImportBind | null = null;
        for (const recIdx of module.starExports) {
            const rec = module.importRecords[recIdx];
            if (rec.external) continue;
            const candidate = matchImport(ctx, graph.modules[rec.resolved], name, new Set(seen));
            if (candidate.kind === 'none') continue;
            if (found === null) found = candidate;
            else if (!sameBind(found, candidate)) {
                ctx.linked.errors.push(
                    `ambiguous export '${name}' from '${module.id}' (multiple star re-exports provide it)`,
                );
                return { kind: 'none' };
            }
        }
        if (found !== null) return found;
    }
    return { kind: 'none' };
}

function sameBind(a: ImportBind, b: ImportBind): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'found' && b.kind === 'found') return a.ref === b.ref;
    if (a.kind === 'namespace' && b.kind === 'namespace') return a.module === b.module;
    if (a.kind === 'external' && b.kind === 'external') return a.specifier === b.specifier && a.name === b.name;
    return true;
}

function namespaceBind(ctx: LinkCtx, target: Module): ImportBind {
    if (!ctx.linked.namespaceOf.has(target.idx)) {
        ctx.linked.namespaceOf.set(target.idx, `${reprName(target)}_ns`);
    }
    return { kind: 'namespace', module: target.idx };
}

/** Short identifier-safe name derived from a module's path. */
export function reprName(module: Module): string {
    const base = module.id.split('/').pop() ?? 'mod';
    return base.replace(/\.[a-z]+$/i, '').replace(/[^A-Za-z0-9_$]/g, '_');
}

function hashName(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0) % 0x1fffff;
}

/** Full resolved export surface of a module (own exports plus star-inherited), memoized. */
export function exportMapOf(ctx: LinkCtx, module: Module): Map<string, ImportBind> {
    const cached = ctx.linked.exportMaps.get(module.idx);
    if (cached !== undefined) return cached;
    const map = new Map<string, ImportBind>();
    ctx.linked.exportMaps.set(module.idx, map);
    for (const recIdx of module.starExports) {
        const rec = module.importRecords[recIdx];
        if (rec.external) continue;
        const inner = exportMapOf(ctx, ctx.graph.modules[rec.resolved]);
        for (const [name, bind] of inner) {
            if (name === NAME_DEFAULT) continue;
            const prior = map.get(name);
            if (prior !== undefined && !sameBind(prior, bind)) {
                map.set(name, { kind: 'none' });
            } else map.set(name, bind);
        }
    }
    for (const name of module.namedExports.keys()) {
        map.set(name, matchImport(ctx, module, name, new Set()));
    }
    return map;
}

function sortModules(graph: Graph): number[] {
    const order: number[] = [];
    const state = new Uint8Array(graph.modules.length);
    const visit = (idx: number): void => {
        if (idx < 0 || state[idx] !== 0) return;
        state[idx] = 1;
        const mod = graph.modules[idx];
        for (const rec of mod.importRecords) {
            if (!rec.external && rec.resolved >= 0) visit(rec.resolved);
        }
        state[idx] = 2;
        order.push(idx);
    };
    visit(graph.entry);
    return order;
}

const RESERVED = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
    'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new',
    'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
    'await', 'static', 'enum', 'implements', 'interface', 'package', 'private', 'protected', 'public',
]);

function deconflict(ctx: LinkCtx): void {
    const { graph, linked } = ctx;
    const taken = new Set<string>(RESERVED);
    for (const idx of linked.order) {
        const mod = graph.modules[idx];
        for (const node of mod.semantic.unresolved) taken.add(node.name);
    }
    const claim = (base: string): string => {
        let name = base;
        let n = 1;
        while (taken.has(name)) name = `${base}$${n++}`;
        taken.add(name);
        return name;
    };
    for (const idx of linked.order) {
        const mod = graph.modules[idx];
        const moduleScope = scopeOf(mod.semantic, mod.program);
        const sem = mod.semantic;
        for (let sym = 1; sym < sem.symbols.length; sym++) {
            if (sem.symbols[sym].scope !== moduleScope) continue;
            if (mod.namedImports.has(sym)) continue;
            const original = sem.symbols[sym].decl!.name;
            const final = claim(original);
            if (final !== original) linked.finalNames.set(packRef(idx, sym), final);
        }
    }
    for (const [ref, base] of linked.syntheticNames) {
        linked.finalNames.set(ref, claim(base));
    }
    for (const [modIdx, base] of linked.namespaceOf) {
        linked.namespaceOf.set(modIdx, claim(base));
    }
    const claimExternal = (specifier: string, name: string, base: string): void => {
        const key = externalKey(specifier, name);
        if (linked.externalLocals.has(key)) return;
        linked.externalLocals.set(key, claim(base));
    };
    for (const [ref, bind] of linked.binds) {
        if (bind.kind !== 'external') continue;
        const mod = graph.modules[refMod(ref)];
        const localName = mod.semantic.symbols[refSym(ref)].decl!.name;
        claimExternal(bind.specifier, bind.name, localName);
    }
    for (const map of linked.exportMaps.values()) {
        for (const bind of map.values()) {
            if (bind.kind !== 'external') continue;
            const base =
                bind.name === '*'
                    ? `${bind.specifier.replace(/[^A-Za-z0-9_$]/g, '_')}_ns`
                    : bind.name === 'default'
                      ? `${bind.specifier.replace(/[^A-Za-z0-9_$]/g, '_')}_default`
                      : bind.name;
            claimExternal(bind.specifier, bind.name, base);
        }
    }
}

/** Bind imports/exports across `graph`, order modules, and deconflict names into a {@link Linked}. */
export function linkGraph(graph: Graph): Linked {
    const linked: Linked = {
        graph,
        order: sortModules(graph),
        binds: new Map(),
        finalNames: new Map(),
        namespaceOf: new Map(),
        exportMaps: new Map(),
        syntheticNames: new Map(),
        externalLocals: new Map(),
        defaultRefs: new Map(),
        errors: [],
    };
    const ctx: LinkCtx = {
        graph,
        linked,
        nextSynthetic: graph.modules.map((m) => m.semantic.symbols.length),
    };

    for (const idx of linked.order) {
        const mod = graph.modules[idx];
        for (const [localSym, imp] of mod.namedImports) {
            const rec = mod.importRecords[imp.rec];
            let bind: ImportBind;
            if (rec.external) {
                bind = { kind: 'external', specifier: rec.specifier, name: imp.name };
            } else if (imp.name === NAME_NAMESPACE) {
                bind = namespaceBind(ctx, graph.modules[rec.resolved]);
            } else {
                bind = matchImport(ctx, graph.modules[rec.resolved], imp.name, new Set());
                if (bind.kind === 'none') {
                    linked.errors.push(
                        `'${imp.name}' is not exported by '${graph.modules[rec.resolved].id}' (imported by '${mod.id}')`,
                    );
                }
            }
            linked.binds.set(packRef(idx, localSym), bind);
        }
        const def = mod.namedExports.get(NAME_DEFAULT);
        if (def !== undefined && def.symbol === 0 && def.rec < 0 && def.exprNode !== null) {
            matchImport(ctx, mod, NAME_DEFAULT, new Set());
        }
    }

    for (const modIdx of linked.namespaceOf.keys()) exportMapOf(ctx, graph.modules[modIdx]);
    if (graph.entry >= 0) exportMapOf(ctx, graph.modules[graph.entry]);

    deconflict(ctx);
    return linked;
}

/** Final output name for a packed ref (the declared name when no rename was recorded). */
export function finalNameOf(linked: Linked, ref: number): string {
    const renamed = linked.finalNames.get(ref);
    if (renamed !== undefined) return renamed;
    const synth = linked.syntheticNames.get(ref);
    if (synth !== undefined) return synth;
    const mod = linked.graph.modules[refMod(ref)];
    return mod.semantic.symbols[refSym(ref)].decl!.name;
}
