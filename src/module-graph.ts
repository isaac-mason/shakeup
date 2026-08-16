import { analyze, createSemantic, declareSyntheticImport, type Semantic, scopeOf, symbolOf } from './analysis/semantic';
import { isJSXNode, N, type Node, node, type Program, walk } from './ast';
import { dirnameOf, type Fs, joinPath } from './fs';
import { parse } from './parser';
import {
    assertSync,
    type CustomPluginOptions,
    compilePipeline,
    type ModuleInfo,
    type ModuleOptions,
    type ModuleSideEffects,
    type ModuleType,
    type PartialResolvedId,
    type Pipeline,
    type Plugin,
    type PluginCtx,
    type ResolveIdExtra,
    runLoad,
    runResolveId,
    runTransform,
} from './plugin';

/** Imported name for `import * as ns` / `export * as ns`. */
export const NAME_NAMESPACE = '*';
/** Imported/exported name for the default binding. */
export const NAME_DEFAULT = 'default';

/** A resolved edge to another module (deduped per specifier). */
export type ImportRecord = {
    specifier: string;
    resolved: number;
    external: boolean;
    /** True iff this edge originates ONLY from dynamic `import()` (no static import
     *  of the same specifier). A specifier imported both statically and dynamically
     *  is `dynamic: false` — the static edge dominates (it's already in the sync
     *  graph; the dynamic-ness adds nothing to chunking once static). Dynamic records
     *  carry no `namedImports` (a bare `import()` binds no names). */
    dynamic: boolean;
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
    /** Resolved module-level side-effect flag (transform>load>resolveId>default true). */
    sideEffects: ModuleSideEffects;
    /** Merged per-module plugin scratch space (shallow-merged across the chain). */
    meta: CustomPluginOptions;
    /** Declared module type (js/ts/jsx/tsx/json/…); default derived from the id extension. */
    moduleType: ModuleType;
    /** True iff this module is rooted as an entry (its index appears in `graph.entries`). */
    isEntry: boolean;
    /** Entry name when this module is an entry (first name wins on dedup); else null. */
    entryName: string | null;
    /** Module-level external flag (distinct from per-record ImportRecord.external). */
    external: boolean;
    /** Reverse edges: ids of modules that statically import this one (filled during build). */
    importers: Set<string>;
};

/** The built module graph rooted at one or more entries. */
export type Graph = {
    modules: Module[];
    byId: Map<string, number>;
    /** Entry roots, in normalized input order. Each is (module index, entry name).
     *  Replaces the single `entry`. */
    entries: { module: number; name: string }[];
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

/** Flag emit-unsupported TS constructs that would otherwise miscompile SILENTLY. A value
 * (non-`declare`) namespace has no runtime lowering, so the walk would leave `namespace X {`
 * in the output = broken JS; fail loudly instead. (`declare` namespaces erase fine.) */
export function collectUnsupported(program: Node, id: string, errors: string[]): void {
    walk(program, (n) => {
        if (n.type === N.TSModuleDeclaration && !n.data.declare) {
            errors.push(`${id}:${n.start}: value namespaces are not supported (use ES modules)`);
            return false;
        }
        return true;
    });
}

/** Entry surface — rolldown `InputOption` (input-options.ts:23). `string` = single
 *  unnamed entry; `string[]` = several unnamed entries; `Record<name, specifier>` =
 *  named entries. */
export type InputOption = string | string[] | Record<string, string>;

/** A low-level resolver override (R1 form): specifier+importer → resolved id / null. */
export type ResolveFn = (specifier: string, importer: string | null) => string | null;

/** Deployment target picking `mainFields`/`conditionNames` defaults (rolldown `platform`). */
export type Platform = 'node' | 'browser' | 'neutral';

/** `resolve:{}` config (R4, §5) — surfaces the core relative-probe resolver's knobs. Fields
 *  gated on the npm-field resolver (`mainFields`/`conditionNames`/`exportsFields`/`aliasFields`)
 *  are ACCEPTED + STORED but only take effect once that resolver consumes them (a NOT-IMPLEMENTED
 *  seam guarded by a sentinel test — see resolve.workspace.test.ts). */
export type ResolveOptions = {
    /** Probe extensions, replacing the hard-coded set. Default ['.tsx','.ts','.jsx','.js','.json']. */
    extensions?: string[];
    /** `import './x.js'` → try these instead, in order (e.g. {'.js':['.ts','.js']}). */
    extensionAlias?: Record<string, string[]>;
    /** Directory index basenames. Default ['index']. */
    mainFiles?: string[];
    /** Pre-resolve string→string alias: `key` / `key/…` rewrites to the target then resolves. */
    alias?: Record<string, string>;
    /** false disables the `fs.realpath` deref (symlink preservation). Default true. */
    symlinks?: boolean;
    /** STUB — needs the npm-field resolver. Accepted + stored. */
    mainFields?: string[];
    /** STUB — needs the npm-field resolver. Accepted + stored. */
    conditionNames?: string[];
    /** STUB — package "exports" field lookup path. Accepted + stored. */
    exportsFields?: string[][];
    /** STUB — package "browser" alias field. Accepted + stored. */
    aliasFields?: string[][];
};

/** Fully-resolved {@link ResolveOptions} with platform defaults applied. */
export type NormalizedResolve = {
    extensions: string[];
    extensionAlias: Record<string, string[]>;
    mainFiles: string[];
    alias: Record<string, string>;
    symlinks: boolean;
    mainFields: string[];
    conditionNames: string[];
    exportsFields: string[][];
    aliasFields: string[][];
};

const DEFAULT_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.json'];

/** Resolve platform → (mainFields, conditionNames) defaults (rolldown input-options.ts). We
 *  emit ESM, so conditions are import-kind. */
function platformDefaults(platform: Platform): { mainFields: string[]; conditionNames: string[] } {
    switch (platform) {
        case 'browser':
            return { mainFields: ['browser', 'module', 'main'], conditionNames: ['import', 'browser', 'default'] };
        case 'neutral':
            return { mainFields: [], conditionNames: ['import', 'default'] };
        default:
            return { mainFields: ['main', 'module'], conditionNames: ['import', 'node', 'default'] };
    }
}

/** Normalize a {@link ResolveOptions} + platform into a {@link NormalizedResolve}. */
export function normalizeResolve(resolve: ResolveOptions | undefined, platform: Platform | undefined): NormalizedResolve {
    const r = resolve ?? {};
    const defaults = platformDefaults(platform ?? 'browser');
    return {
        extensions: r.extensions ?? DEFAULT_EXTENSIONS,
        extensionAlias: r.extensionAlias ?? {},
        mainFiles: r.mainFiles ?? ['index'],
        alias: r.alias ?? {},
        symlinks: r.symlinks ?? true,
        mainFields: r.mainFields ?? defaults.mainFields,
        conditionNames: r.conditionNames ?? defaults.conditionNames,
        exportsFields: r.exportsFields ?? [['exports']],
        aliasFields: r.aliasFields ?? [],
    };
}

/** Inputs to {@link buildGraph}. */
export type GraphOptions = {
    /** One or more entry modules. Exactly one of `input` / `entry` must be set. */
    input?: InputOption;
    /** @deprecated single-entry alias for `input`. Normalized into `input`. */
    entry?: string;
    fs: Fs;
    external?: string[] | ((specifier: string) => boolean);
    /** A low-level resolver function (R1 override) OR a {@link ResolveOptions} config (R4, §5). */
    resolve?: ResolveFn | ResolveOptions;
    /** Deployment target → mainFields/conditionNames defaults (R4). Default 'browser'. */
    platform?: Platform;
    plugins?: Plugin[];
    jsx?: JSXOptions;
    /** R2 stub: accepted and IGNORED. Rolldown default is `'exports-only'`; facade-chunk
     *  generation lands with the chunk graph in R3. Present so callers can pass it today. */
    preserveEntrySignatures?: false | 'strict' | 'allow-extension' | 'exports-only';
};

/** One normalized entry: a display name plus the raw specifier to resolve. */
type NormalizedEntry = { name: string; specifier: string };

/** Derive a filename-safe entry name from a specifier's basename (extension stripped).
 *  Distinct from {@link reprName} (module-path-based, identifier-safe — a different job). */
function entryNameFromSpecifier(specifier: string): string {
    const base = specifier.split('/').pop() ?? 'main';
    const stem = base.replace(/\.[^.]+$/, '');
    const cleaned = stem.replace(/[^A-Za-z0-9_$-]/g, '_');
    return cleaned === '' ? 'main' : cleaned;
}

/** Normalize `input` / `entry` into an ordered {@link NormalizedEntry} list. Pushes a
 *  graph error (and returns `[]`) when neither / both are set (rollup requires exactly
 *  one root source). Unnamed entries derive a name from the specifier basename; a
 *  collision suffixes `name`, `name2`, … deterministically. `Record` keys win verbatim. */
function normalizeInput(options: GraphOptions, errors: string[]): NormalizedEntry[] {
    const hasInput = options.input !== undefined;
    const hasEntry = options.entry !== undefined;
    if (hasInput === hasEntry) {
        errors.push("exactly one of 'input' or 'entry' must be set");
        return [];
    }
    const input: InputOption = hasEntry ? (options.entry as string) : (options.input as InputOption);
    const out: NormalizedEntry[] = [];
    const used = new Map<string, number>();
    const derive = (specifier: string): string => {
        const base = entryNameFromSpecifier(specifier);
        const seen = used.get(base);
        if (seen === undefined) {
            used.set(base, 1);
            return base;
        }
        const n = seen + 1;
        used.set(base, n);
        return `${base}${n}`;
    };
    if (typeof input === 'string') {
        out.push({ name: derive(input), specifier: input });
    } else if (Array.isArray(input)) {
        for (const specifier of input) out.push({ name: derive(specifier), specifier });
    } else {
        for (const name of Object.keys(input)) {
            used.set(name, 1); // reserve named keys so a later derived name can't collide
            out.push({ name, specifier: input[name] });
        }
    }
    return out;
}

/** Apply string→string `alias`: exact `key` or `key/…` prefix rewrites to the target (rolldown
 *  aliases run before defaultResolve, skipping other plugins' resolveId — documented). */
function applyAlias(specifier: string, alias: Record<string, string>): string {
    for (const key of Object.keys(alias)) {
        if (specifier === key) return alias[key];
        if (specifier.startsWith(`${key}/`)) return alias[key] + specifier.slice(key.length);
    }
    return specifier;
}

/** Relative/absolute probe (R4: config-driven). Builds the probe set from `extensions` +
 *  `mainFiles`, honours `extensionAlias` (try mapped exts for a matching suffix first). */
function defaultResolve(fs: Fs, resolve: NormalizedResolve, specifier: string, importer: string | null): string | null {
    const aliased = applyAlias(specifier, resolve.alias);
    if (!aliased.startsWith('./') && !aliased.startsWith('../') && !aliased.startsWith('/')) return null;
    const base = aliased.startsWith('/') || importer === null ? aliased : joinPath(dirnameOf(importer), aliased);

    // extensionAlias: if the specifier ends in a mapped ext (e.g. '.js'), try the alternatives
    // (e.g. '.ts','.js') BEFORE the generic probe (rolldown input-options.ts:387-393).
    for (const [ext, alts] of Object.entries(resolve.extensionAlias)) {
        if (base.endsWith(ext)) {
            const stem = base.slice(0, base.length - ext.length);
            for (const alt of alts) {
                const candidate = stem + alt;
                if (fs.exists(candidate)) return candidate;
            }
        }
    }

    // Direct hit, then each extension, then directory-index (mainFiles × extensions).
    if (fs.exists(base)) return base;
    for (const ext of resolve.extensions) {
        if (fs.exists(base + ext)) return base + ext;
    }
    for (const main of resolve.mainFiles) {
        for (const ext of resolve.extensions) {
            const candidate = `${base}/${main}${ext}`;
            if (fs.exists(candidate)) return candidate;
        }
    }
    return null;
}

function isExternal(options: GraphOptions, specifier: string): boolean {
    const ext = options.external;
    if (ext === undefined) return false;
    if (typeof ext === 'function') return ext(specifier);
    return ext.includes(specifier);
}

/** A mutable option bag threaded through resolveId → load → transform for a module
 *  id (rollup ResolvedId → Module, ModuleLoader.ts:405–433). */
type PendingOptions = ModuleOptions;

function newPendingOptions(): PendingOptions {
    return { moduleSideEffects: null, meta: {}, moduleType: undefined };
}

/** Merge `src` overrides onto `dst` with rollup `updateOptions` precedence
 *  (Module.ts:1045–1058): only overwrite when the source actually set a value.
 *  `meta` is shallow-merged (Object.assign) so multiple hooks/plugins contribute. */
function mergeOptions(
    dst: PendingOptions,
    src: { moduleSideEffects?: ModuleSideEffects | null; meta?: CustomPluginOptions; moduleType?: ModuleType },
): void {
    if (src.moduleSideEffects !== undefined && src.moduleSideEffects !== null) dst.moduleSideEffects = src.moduleSideEffects;
    if (src.meta !== undefined) Object.assign(dst.meta, src.meta);
    if (src.moduleType !== undefined) dst.moduleType = src.moduleType;
}

/** Resolve the final module-level side-effect flag (rolldown precedence tail,
 *  plugin/index.ts:144 item 6): first-set of the merged chain, else `true`. The
 *  `treeshake.moduleSideEffects` global default (item 4) and pkg `sideEffects` (item
 *  5) are LATER config; R1 uses `true`. */
function resolveModuleSideEffects(pending: PendingOptions): ModuleSideEffects {
    return pending.moduleSideEffects ?? true;
}

/** Default module type from the id's extension (R1 only ACTs on js/ts/jsx/tsx/json). */
function moduleTypeOf(id: string): ModuleType {
    if (id.endsWith('.tsx')) return 'tsx';
    if (id.endsWith('.jsx')) return 'jsx';
    if (id.endsWith('.ts')) return 'ts';
    if (id.endsWith('.json')) return 'json';
    return 'js';
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

function addRecord(mod: Module, specifier: string, dynamic = false): number {
    for (let i = 0; i < mod.importRecords.length; i++) {
        if (mod.importRecords[i].specifier === specifier) {
            // Static dominance: a specifier seen statically stays static regardless of a
            // later dynamic hit; a dynamic-first record flips to static when the static
            // import arrives. Order-independent because any static call demotes.
            if (!dynamic) mod.importRecords[i].dynamic = false;
            return i;
        }
    }
    mod.importRecords.push({ specifier, resolved: -1, external: false, dynamic });
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
                if (
                    decl.type === N.FunctionDeclaration ||
                    decl.type === N.ClassDeclaration ||
                    decl.type === N.TSEnumDeclaration
                ) {
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
        }
    }

    // Dynamic import() edges. Unlike static import/export these nest arbitrarily deep in
    // expressions/function bodies, so the top-level statement scan above misses them —
    // walk the whole program. Mirrors the dev-path detection in
    // transform.ts:collectRunnerEdits (~L304); kept inline (detection is ~3 lines and the
    // two callers emit different outputs — no shared helper warranted). Literal-only:
    // non-literal import() (import(x), import(`./${x}`), import('a'+b)) has a
    // non-StringLiteral source → skipped → no edge, left as a runtime import in the emit.
    walk(mod.program, (n) => {
        if (n.type === N.ImportExpression && n.data.source.type === N.StringLiteral) {
            addRecord(mod, strValue(source, n.data.source), /* dynamic */ true);
        }
    });
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

export function scanJSX(program: Program): { hasJSX: boolean; needsCreateElement: boolean } {
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

/** Project a live {@link Module} into the plugin-facing {@link ModuleInfo}
 *  (rollup Module.ts:317). Reads the graph as it's being built, so `importers` may
 *  be partial when called from `moduleParsed` (matches rollup's caveat). */
export function toModuleInfo(graph: Graph, mod: Module): ModuleInfo {
    const importedIds: string[] = [];
    const dynamicallyImportedIds: string[] = [];
    for (const rec of mod.importRecords) {
        if (rec.external || rec.resolved < 0) continue;
        (rec.dynamic ? dynamicallyImportedIds : importedIds).push(graph.modules[rec.resolved].id);
    }
    return {
        id: mod.id,
        code: mod.source,
        isEntry: mod.isEntry,
        isExternal: mod.external,
        moduleSideEffects: mod.sideEffects,
        meta: mod.meta,
        moduleType: mod.moduleType,
        importedIds,
        dynamicallyImportedIds,
        importers: [...mod.importers],
        dynamicImporters: [], // R2: reverse dynamic edges not yet tracked (R3/R4)
        exports: [...mod.namedExports.keys()],
    };
}

/** Resolve, load, parse, and analyze the module graph reachable from the entry. */
export function buildGraph(options: GraphOptions, pipeline?: Pipeline): Graph {
    const graph: Graph = { modules: [], byId: new Map(), entries: [], errors: [], warnings: [] };
    const jsxOptions = resolveJSXOptions(options.jsx);
    const pipe = pipeline ?? compilePipeline(options.plugins ?? []);
    // `resolve` may be a low-level function (R1 override) or a ResolveOptions config (R4). The
    // config drives the built-in relative probe; the function bypasses it entirely.
    const resolveIsFn = typeof options.resolve === 'function';
    const normalizedResolve = normalizeResolve(
        resolveIsFn ? undefined : (options.resolve as ResolveOptions | undefined),
        options.platform,
    );
    const baseResolve: ResolveFn = resolveIsFn
        ? (options.resolve as ResolveFn)
        : (s: string, i: string | null) => defaultResolve(options.fs, normalizedResolve, s, i);
    const pluginExternals = new Set<string>();
    /** resolveId/load option overrides keyed by RESOLVED id, finalized in addModule. */
    const pendingOptions = new Map<string, PendingOptions>();
    /** (specifier, importer) pairs currently being resolved — the R1 stand-in for
     *  rollup's per-plugin `skipSelf` recursion guard (§4). */
    const resolving = new Set<string>();

    const pendingFor = (id: string): PendingOptions => {
        let p = pendingOptions.get(id);
        if (p === undefined) {
            p = newPendingOptions();
            pendingOptions.set(id, p);
        }
        return p;
    };

    /** The shared resolve path used by both the graph walk and `ctx.resolve`
     *  (rollup: `this.resolve` calls the same ModuleLoader.resolveId). Runs the
     *  resolveId pipeline, normalizes {@link PartialResolvedId}, records its option
     *  overrides against the resolved id, then falls through to `baseResolve`.
     *  `skipPipeline` bypasses the plugins (used by the recursion guard). Returns
     *  the resolved id string, `false` (external), or `null` (unresolved). */
    const resolveThrough = (
        specifier: string,
        importer: string | null,
        extra: ResolveIdExtra,
        skipPipeline = false,
    ): string | false | null => {
        const hit = skipPipeline ? null : assertSync(runResolveId(pipe, ctx, specifier, importer, extra));
        if (hit === false) {
            pluginExternals.add(specifier);
            return false;
        }
        if (typeof hit === 'string') return hit;
        if (hit !== null && hit !== undefined && typeof hit === 'object') {
            const partial = hit as PartialResolvedId;
            if (partial.external !== undefined && partial.external !== false) {
                // true | 'absolute' | 'relative' → external. R1 treats them alike
                // (keep verbatim); the re-normalization distinction is R4 (§7).
                pluginExternals.add(specifier);
                return false;
            }
            mergeOptions(pendingFor(partial.id), partial);
            return partial.id;
        }
        const base = baseResolve(specifier, importer);
        return base;
    };

    const ctx: PluginCtx = {
        warn: (m) => graph.warnings.push(m),
        error: (m) => {
            throw new Error(m);
        },
        info: (m) => graph.warnings.push(m),
        debug: () => {},
        fs: options.fs,
        resolve: (source, importer = null, opts) => {
            const extra: ResolveIdExtra = {
                isEntry: opts?.isEntry ?? false,
                kind: opts?.kind ?? 'import-statement',
                custom: opts?.custom,
            };
            // Recursion guard (§4): skipSelf (default true) short-circuits a resolveId
            // hook that re-resolves the same (specifier, importer) already in flight —
            // if the key is already being resolved, skip the pipeline and go straight
            // to baseResolve. Otherwise mark it in-flight for the duration so a NESTED
            // ctx.resolve of the same pair is caught.
            const key = `${importer ?? ''}\x00${source}`;
            const skipSelf = opts?.skipSelf !== false;
            const guardHit = skipSelf && resolving.has(key);
            const marked = skipSelf && !guardHit;
            if (marked) resolving.add(key);
            try {
                const r = resolveThrough(source, importer, extra, guardHit);
                if (r === false) return { id: source, external: true };
                if (r === null) return null;
                const pending = pendingOptions.get(r);
                return {
                    id: r,
                    external: false,
                    moduleSideEffects: pending?.moduleSideEffects,
                    meta: pending?.meta,
                    moduleType: pending?.moduleType,
                };
            } finally {
                if (marked) resolving.delete(key);
            }
        },
        getModuleInfo: (id) => {
            const idx = graph.byId.get(id);
            if (idx === undefined) return null;
            return toModuleInfo(graph, graph.modules[idx]);
        },
        getModuleIds: () => graph.byId.keys(),
    };

    /** Graph-walk resolve: enters the resolving-set (so a plugin's `ctx.resolve`
     *  on the same pair is guarded), delegates to `resolveThrough`, exits. */
    const resolveFn = (specifier: string, importer: string | null, extra: ResolveIdExtra): string | false | null => {
        const key = `${importer ?? ''}\x00${specifier}`;
        resolving.add(key);
        try {
            return resolveThrough(specifier, importer, extra);
        } finally {
            resolving.delete(key);
        }
    };

    const loadFn = (id: string): string | null => {
        const r = assertSync(runLoad(pipe, ctx, id));
        if (r === null || r === undefined) return options.fs.read(id);
        if (typeof r === 'string') return r;
        // SourceDescription: take .code and merge its option overrides (load > resolveId).
        mergeOptions(pendingFor(id), r);
        return r.code;
    };

    const addModule = (id: string, isEntry: boolean): number => {
        const existing = graph.byId.get(id);
        if (existing !== undefined) return existing;
        const source0 = loadFn(id);
        if (source0 === null) {
            graph.errors.push(`cannot load module '${id}'`);
            return -1;
        }
        const transformed = assertSync(runTransform(pipe, ctx, source0, id));
        const source = transformed.code;
        // Merge transform overrides (transform > load > resolveId precedence, §3).
        const pending = pendingFor(id);
        mergeOptions(pending, transformed);
        const sideEffects = resolveModuleSideEffects(pending);
        const jsx = id.endsWith('.tsx') || id.endsWith('.jsx');
        const { program, errors, nodeCount } = parse(source, { ts: true, jsx });
        for (const e of errors) graph.errors.push(`${id}:${e.pos}: ${e.msg}`);
        collectUnsupported(program, id, graph.errors);
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
            sideEffects,
            meta: pending.meta,
            moduleType: pending.moduleType ?? moduleTypeOf(id),
            isEntry,
            entryName: null,
            external: false,
            importers: new Set(),
        };
        graph.modules.push(mod);
        graph.byId.set(id, mod.idx);
        extractRecords(mod);
        if (jsx) injectJSXRuntime(mod, jsxOptions.importSource);
        for (const hook of pipe.moduleParsed) {
            hook.handler(ctx, {
                id,
                source,
                program,
                nodeCount,
                semantic,
                moduleSideEffects: sideEffects,
                meta: mod.meta,
                moduleType: mod.moduleType,
            });
        }
        for (const rec of mod.importRecords) {
            if (isExternal(options, rec.specifier) || pluginExternals.has(rec.specifier)) {
                rec.external = true;
                continue;
            }
            const resolved = resolveFn(rec.specifier, id, {
                isEntry: false,
                kind: rec.dynamic ? 'dynamic-import' : 'import-statement',
            });
            if (resolved === false || pluginExternals.has(rec.specifier)) {
                rec.external = true;
                continue;
            }
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
            // symlinks:false disables the realpath deref (preserve the symlinked path). §5.
            const depId = normalizedResolve.symlinks ? (options.fs.realpath?.(resolved) ?? resolved) : resolved;
            rec.resolved = addModule(depId, false);
            if (rec.resolved >= 0) graph.modules[rec.resolved].importers.add(id);
        }
        return mod.idx;
    };

    // buildStart runs with the full graph-backed ctx so `ctx.resolve` works from it
    // (rollup runs it as part of the build, before resolution).
    for (const hook of pipe.buildStart) assertSync(hook.handler(ctx));

    // Multi-entry rooting (rollup addEntryModules, ModuleLoader.ts:121-158): resolve each
    // normalized entry, add its module, mark it an entry, and dedup into graph.entries
    // (same module named twice ⇒ one root, first name wins). Rooting stays in the caller,
    // not addModule, per R1's contract.
    const normalized = normalizeInput(options, graph.errors);
    const seen = new Set<number>();
    for (const { name, specifier } of normalized) {
        const entryResolved = resolveFn(specifier, null, { isEntry: true, kind: 'entry' });
        const entryId = typeof entryResolved === 'string' ? entryResolved : specifier;
        const idx = addModule(entryId, true);
        if (idx < 0) continue; // addModule already pushed a load error
        const mod = graph.modules[idx];
        mod.isEntry = true;
        if (mod.entryName === null) mod.entryName = name;
        if (!seen.has(idx)) {
            seen.add(idx);
            graph.entries.push({ module: idx, name });
        }
    }
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
                ctx.linked.errors.push(`ambiguous export '${name}' from '${module.id}' (multiple star re-exports provide it)`);
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
            // Skip dynamic edges: a dynamic target is not in the importer's synchronous
            // execution order (it loads on its own), and a cycle closed through a dynamic
            // edge must not wrongly serialize. Dynamic targets are seeded separately below.
            if (!rec.external && !rec.dynamic && rec.resolved >= 0) visit(rec.resolved);
        }
        state[idx] = 2;
        order.push(idx);
    };
    for (const { module } of graph.entries) visit(module);
    // R2 single-chunk world: a module reachable ONLY through import() would otherwise be
    // dropped from `order`. Seed the DFS from every dynamic target AFTER all static-entry
    // roots so their relative sync-order is preserved. R3 replaces this with real chunk
    // assignment (the dynamic target becomes its own chunk).
    for (const mod of graph.modules) {
        for (const rec of mod.importRecords) {
            if (rec.dynamic && !rec.external && rec.resolved >= 0) visit(rec.resolved);
        }
    }
    return order;
}

const RESERVED = new Set([
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'export',
    'extends',
    'finally',
    'for',
    'function',
    'if',
    'import',
    'in',
    'instanceof',
    'let',
    'new',
    'return',
    'super',
    'switch',
    'this',
    'throw',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'with',
    'yield',
    'await',
    'static',
    'enum',
    'implements',
    'interface',
    'package',
    'private',
    'protected',
    'public',
]);

/** A `claim` closure over a mutable `taken` set: returns a unique name derived from
 *  `base` (suffixing `$1`, `$2`, … on collision) and reserves it. */
export function makeClaim(taken: Set<string>): (base: string) => string {
    return (base: string): string => {
        let name = base;
        let n = 1;
        while (taken.has(name)) name = `${base}$${n++}`;
        taken.add(name);
        return name;
    };
}

/** Deconflict the module-scope symbols, synthetics, namespaces, and external locals of a
 *  set of modules (`memberOrder`, exec-ordered) into a FRESH scope. Whole-bundle deconflict
 *  is this run over `linked.order`; R3 runs it once per chunk (each chunk = one lexical
 *  scope, so a name may safely repeat across chunks). Writes into `linked.finalNames` /
 *  `linked.namespaceOf` / `linked.externalLocals` — because a module lives in exactly one
 *  chunk, its `packRef→name` stays unambiguous. `seed` pre-reserves names the chunk pulls
 *  in from other chunks (cross-chunk import locals), so producer names win before consumers.
 *
 *  When `memberSet` is provided, only external binds whose owning module is in the chunk are
 *  claimed here (per-chunk external import locals); the whole-bundle path passes it as null
 *  and claims every external once. */
export function deconflictChunk(
    graph: Graph,
    linked: Linked,
    memberOrder: number[],
    memberSet: Set<number> | null,
    seed: Iterable<string>,
): (base: string) => string {
    const taken = new Set<string>(RESERVED);
    for (const name of seed) taken.add(name);
    for (const idx of memberOrder) {
        const mod = graph.modules[idx];
        for (const node of mod.semantic.unresolved) taken.add(node.name);
    }
    const claim = makeClaim(taken);
    for (const idx of memberOrder) {
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
        if (memberSet !== null && !memberSet.has(refMod(ref))) continue;
        linked.finalNames.set(ref, claim(base));
    }
    for (const [modIdx, base] of linked.namespaceOf) {
        if (memberSet !== null && !memberSet.has(modIdx)) continue;
        linked.namespaceOf.set(modIdx, claim(base));
    }
    const claimExternal = (specifier: string, name: string, base: string): void => {
        const key = externalKey(specifier, name);
        if (linked.externalLocals.has(key)) return;
        linked.externalLocals.set(key, claim(base));
    };
    for (const [ref, bind] of linked.binds) {
        if (bind.kind !== 'external') continue;
        if (memberSet !== null && !memberSet.has(refMod(ref))) continue;
        const mod = graph.modules[refMod(ref)];
        const localName = mod.semantic.symbols[refSym(ref)].decl!.name;
        claimExternal(bind.specifier, bind.name, localName);
    }
    for (const [modIdx, map] of linked.exportMaps) {
        if (memberSet !== null && !memberSet.has(modIdx)) continue;
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
    return claim;
}

function deconflict(ctx: LinkCtx): void {
    deconflictChunk(ctx.graph, ctx.linked, ctx.linked.order, null, []);
}

/** Bind imports/exports across `graph`, order modules, and deconflict names into a {@link Linked}.
 *  `opts.deconflict` (default true) runs a whole-bundle deconflict — R3 passes `false` and
 *  runs a fresh per-chunk deconflict from {@link deconflictChunk} instead (each chunk is its
 *  own lexical scope). When skipped, `namespaceOf` holds BASE names (`_ns`) so the per-chunk
 *  pass can claim them. */
export function linkGraph(graph: Graph, opts?: { deconflict?: boolean }): Linked {
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
    for (const { module } of graph.entries) exportMapOf(ctx, graph.modules[module]);
    // Build export maps for dynamic-import targets too: treeshake seeds them as inclusion
    // roots (§4.4) and needs the resolved surface present in `linked.exportMaps`. A target
    // may be statically-dominated (its record is `dynamic:false`) yet still have a literal
    // `import()` in source that R3 rewrites to `Promise.resolve(namespaceObject)` — so we
    // detect the target from the AST, not the record's `dynamic` flag.
    for (const mod of graph.modules) {
        walk(mod.program, (n) => {
            if (n.type !== N.ImportExpression || n.data.source.type !== N.StringLiteral) return;
            const spec = mod.source.slice(n.data.source.start + 1, n.data.source.end - 1);
            const rec = mod.importRecords.find((r) => r.specifier === spec);
            if (rec !== undefined && !rec.external && rec.resolved >= 0) exportMapOf(ctx, graph.modules[rec.resolved]);
        });
    }

    if (opts?.deconflict !== false) deconflict(ctx);
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
