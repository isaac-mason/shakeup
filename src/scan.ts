import { analyze, createSemantic, type Semantic, symbolOf } from './analysis/semantic';
import { isJSXNode, N, type Node, type Program, walk } from './ast';
import type { Fs, MaybePromise } from './fs';
import {
    type CachedParse,
    type Graph,
    type ImportRecordKind,
    type JSXRuntime,
    type Module,
    NAME_DEFAULT,
    NAME_NAMESPACE,
} from './graph-types';
import { EMPTY_MODULE_ID } from './node-resolve';
import { parse } from './parser';
import { runCompress } from './passes/compress';
import { inlineFunctions } from './passes/optimize/inline-functions';
import { scalarReplaceAggregates } from './passes/optimize/sroa';
import { unrollLoops } from './passes/optimize/unroll';
import { makeJsxLower } from './passes/lower-jsx';
import { tsLower } from './passes/lower-ts';
import { tsStrip } from './passes/strip-ts';
import { traverse } from './passes/traverse';
import {
    type CustomPluginOptions,
    compilePipeline,
    type EmittedFile,
    type ModuleInfo,
    type ModuleOptions,
    type ModuleSideEffects,
    type ModuleType,
    type PartialResolvedId,
    type Pipeline,
    type PluginCtx,
    type ResolveIdExtra,
    runLoad,
    runResolveId,
    runTransform,
} from './plugin';
import { type GraphOptions, type InputOption, isExternal, makeBaseResolve, normalizeResolve, resolveJSXOptions } from './resolve';

/** Flag emit-unsupported TS constructs that would otherwise miscompile SILENTLY. A value
 * (non-`declare`) namespace has no runtime lowering, so the walk would leave `namespace X {`
 * in the output = broken JS; fail loudly instead. (`declare` namespaces erase fine.)
 * TODO(namespace-lowering): replace this rejection with actual value-namespace lowering (SOTA:
 * oxc typescript/namespace.rs, esbuild tsParseNamespace) — then this walk goes away entirely. */
export function collectUnsupported(program: Node, id: string, errors: string[]): void {
    walk(program, (n) => {
        if (n.type === N.TSModuleDeclaration && !n.data.declare) {
            errors.push(`${id}:${n.start}: value namespaces are not supported (use ES modules)`);
            return false;
        }
        // Only the `import X = require("m")` form survives lowering (entity/type forms are lowered).
        if (n.type === N.TSImportEqualsDeclaration && n.data.moduleReference.type === N.TSExternalModuleReference) {
            errors.push(`${id}:${n.start}: import-equals with require() (CommonJS) is not supported (use ES modules)`);
            return false;
        }
        return true;
    });
}

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
 *  graph error (and returns `[]`) when neither / both are set (exactly one root source is
 *  required). Unnamed entries derive a name from the specifier basename; a collision suffixes
 *  `name`, `name2`, … deterministically. `Record` keys win verbatim. */
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

/** A mutable option bag threaded through resolveId → load → transform for a module id. */
type PendingOptions = ModuleOptions;

function newPendingOptions(): PendingOptions {
    return { moduleSideEffects: null, meta: {}, moduleType: undefined };
}

/** Merge `src` overrides onto `dst`: only overwrite when the source actually set a value.
 *  `meta` is shallow-merged (Object.assign) so multiple hooks/plugins contribute. */
function mergeOptions(
    dst: PendingOptions,
    src: { moduleSideEffects?: ModuleSideEffects | null; meta?: CustomPluginOptions; moduleType?: ModuleType },
): void {
    if (src.moduleSideEffects !== undefined && src.moduleSideEffects !== null) dst.moduleSideEffects = src.moduleSideEffects;
    if (src.meta !== undefined) Object.assign(dst.meta, src.meta);
    if (src.moduleType !== undefined) dst.moduleType = src.moduleType;
}

/** Resolve the final module-level side-effect flag: first-set of the merged chain, else `true`. */
function resolveModuleSideEffects(pending: PendingOptions): ModuleSideEffects {
    return pending.moduleSideEffects ?? true;
}

/** Default module type from the id's extension. */
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

function addRecord(mod: Module, specifier: string, kind: ImportRecordKind): number {
    const dynamic = kind === 'dynamic';
    const asset = kind === 'new-url';
    for (let i = 0; i < mod.importRecords.length; i++) {
        const r = mod.importRecords[i];
        if (r.specifier !== specifier) continue;
        // An asset edge (`new URL`) and a code edge (`import`) for the same specifier are genuinely
        // different things — never collapse them; only dedup like-for-like.
        if (asset !== (r.kind === 'new-url')) continue;
        if (asset) return i; // same asset referenced twice → one record
        // Static dominance: a specifier seen statically stays static regardless of a later dynamic
        // hit; a dynamic-first record flips to static when the static import arrives.
        if (!dynamic) r.kind = 'static';
        else r.hasDynamicLiteral = true;
        return i;
    }
    mod.importRecords.push({ specifier, resolved: -1, external: false, kind, hasDynamicLiteral: dynamic });
    return mod.importRecords.length - 1;
}

/** The inner value of a string literal node (quotes stripped), read from source. */
// Real StringLiterals slice their value from source (perf: no stored copy). Synthetic nodes injected
// by a transform pass (e.g. jsxLower's runtime import) have a collapsed span but carry the quoted
// value in `name` — fall back to that so injected imports scan like any other.
const strValue = (source: string, node: Node): string =>
    node.end > node.start ? source.slice(node.start + 1, node.end - 1) : node.name.slice(1, -1);

/** Extract import/export records from the module's top-level statements. */
function extractRecords(mod: Module): void {
    const { semantic, source } = mod;
    for (const stmt of mod.program.data.body) {
        if (stmt.type === N.ImportDeclaration) {
            if (stmt.data.importKind === 'type') continue;
            const src = stmt.data.source;
            if (src.type !== N.StringLiteral) continue;
            const rec = addRecord(mod, strValue(source, src), 'static');
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
            const rec = src !== null && src.type === N.StringLiteral ? addRecord(mod, strValue(source, src), 'static') : -1;
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
            const rec = addRecord(mod, strValue(source, src), 'static');
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
    // walk the whole program. Literal-only: non-literal import() (import(x), import(`./${x}`),
    // import('a'+b)) has a non-StringLiteral source → skipped → no edge, left as a runtime
    // import in the emit.
    walk(mod.program, (n) => {
        if (n.type === N.ImportExpression && n.data.source.type === N.StringLiteral) {
            addRecord(mod, strValue(source, n.data.source), 'dynamic');
        } else if (n.type === N.NewExpression && isNewUrlAsset(mod, n)) {
            addRecord(mod, strValue(source, n.data.arguments[0]), 'new-url');
        }
    });
}

/** Match `new URL('./relative', import.meta.url)` — the web-standard asset-reference idiom. The
 *  callee must be the GLOBAL `URL` (unresolved symbol), arg0 a relative string literal, and arg1
 *  exactly `import.meta.url`. Non-literal / non-relative / bare `URL()` are left verbatim. */
function isNewUrlAsset(mod: Module, n: Node): boolean {
    if (n.type !== N.NewExpression || n.data.arguments.length !== 2) return false;
    const callee = n.data.callee;
    if (callee.type !== N.IdentifierReference || callee.name !== 'URL' || symbolOf(mod.semantic, callee) !== 0) return false;
    const spec = n.data.arguments[0];
    if (spec.type !== N.StringLiteral || !mod.source.slice(spec.start + 1, spec.end - 1).startsWith('.')) return false;
    const base = n.data.arguments[1];
    return base.type === N.StaticMemberExpression && base.data.object.type === N.ImportMeta && base.data.property.name === 'url';
}

/** True if `openingName`-carrying attrs put a `key` attribute AFTER a spread
 * (the key-after-spread createElement fallback). */
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

/** Project a live {@link Module} into the plugin-facing {@link ModuleInfo}. Reads the graph
 *  as it's being built, so `importers` may be partial when called from `moduleParsed`. */
export function toModuleInfo(graph: Graph, mod: Module): ModuleInfo {
    const importedIds: string[] = [];
    const dynamicallyImportedIds: string[] = [];
    for (const rec of mod.importRecords) {
        if (rec.external || rec.resolved < 0) continue;
        (rec.kind === 'dynamic' ? dynamicallyImportedIds : importedIds).push(graph.modules[rec.resolved].id);
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
        dynamicImporters: [],
        exports: [...mod.namedExports.keys()],
    };
}

/** Resolve, load, parse, and analyze the module graph reachable from the entry. */
/** djb2 content hash keying the incremental parse cache. */
function hashSource(s: string): number {
    // djb2, but `Math.imul` keeps the multiply in int32 — `h * 33` would box to a double every
    // iteration. The trailing `^` already truncates to int32, so the digest is bit-identical.
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = Math.imul(h, 33) ^ s.charCodeAt(i);
    return h >>> 0;
}

/** Digest a module's export surface (rspack `AffectType` input): the set of names it
 *  exports plus its `export *` targets. Body-only edits leave this unchanged. */
function exportSignature(mod: Module): string {
    const names = [...mod.namedExports.keys()].sort();
    const stars = mod.starExports.map((r) => mod.importRecords[r].specifier).sort();
    return `${names.join(',')}\x00${stars.join(',')}`;
}

/** Whether `r` re-exports from module index `targetIdx` (`export { x } from` or `export *`).
 *  Such an edge is `Transitive` — a target's export change ripples through `r` to ITS
 *  importers; a plain `import` is `True` (affects `r` only). */
function reexportsFrom(r: Module, targetIdx: number): boolean {
    for (const exp of r.namedExports.values()) {
        if (exp.rec >= 0 && r.importRecords[exp.rec]?.resolved === targetIdx) return true;
    }
    for (const recIdx of r.starExports) {
        if (r.importRecords[recIdx]?.resolved === targetIdx) return true;
    }
    return false;
}

/** Propagate `changedExports` (modules whose export surface changed vs the last build) up the
 *  importer graph → the set of modules whose downstream artifacts (link/shake/render) are
 *  stale. Port of rspack `compute_affected_modules_with_module_graph`: re-export edges are
 *  transitive, plain imports terminal. */
function computeAffected(graph: Graph, changedExports: Set<string>): Set<string> {
    const affected = new Set<string>(changedExports);
    const exportChanged = new Set<string>(changedExports);
    const queue = [...changedExports];
    while (queue.length > 0) {
        const idx = graph.byId.get(queue.shift() as string);
        if (idx === undefined) continue;
        for (const importerId of graph.modules[idx].importers) {
            affected.add(importerId);
            const rIdx = graph.byId.get(importerId);
            if (rIdx !== undefined && reexportsFrom(graph.modules[rIdx], idx) && !exportChanged.has(importerId)) {
                exportChanged.add(importerId);
                queue.push(importerId);
            }
        }
    }
    return affected;
}

/** Memoize `exists`/`realpath` for the duration of ONE build. Within a single build the
 *  filesystem is fixed, so a path's existence and its realpath are constant — and module
 *  resolution probes the same candidate paths many times over (≈⅔ of fs calls on a real graph
 *  are exact repeats). `read` is left direct (each module loads once; package.json is cached in
 *  the resolver). Correct-by-construction because it never crosses a build boundary. */
function memoBuildFs(fs: Fs): Fs {
    // Cache the MaybePromise: an async fs's Promise is cached + shared, so repeat/concurrent probes
    // of the same path await ONE underlying call. A sync fs caches the plain value as before.
    const exists = new Map<string, MaybePromise<boolean>>();
    const realpath = fs.realpath === undefined ? undefined : new Map<string, MaybePromise<string>>();
    const rp = fs.realpath;
    return {
        read: (id) => fs.read(id),
        exists: (id) => {
            let v = exists.get(id);
            if (v === undefined) {
                v = fs.exists(id);
                exists.set(id, v);
            }
            return v;
        },
        realpath:
            rp === undefined
                ? undefined
                : (id) => {
                      let v = realpath!.get(id);
                      if (v === undefined) {
                          v = rp(id);
                          realpath!.set(id, v);
                      }
                      return v;
                  },
    };
}

/** FNV-1a over the source bytes → 8 hex chars, for content-addressed emitted-asset fileNames. */
function hashSourceHex(source: string | Uint8Array): string {
    const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source;
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/** The output fileName for an emitted file: an explicit `fileName`, else `assets/<stem>-<hash><ext>`
 *  derived from `name` (default 'asset') and the content hash. */
export function resolveEmittedFileName(file: EmittedFile): string {
    if (file.fileName !== undefined) return file.fileName;
    const base = file.name ?? 'asset';
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    return `assets/${stem}-${hashSourceHex(file.source)}${ext}`;
}

export async function buildGraph(options: GraphOptions, pipeline?: Pipeline): Promise<Graph> {
    const graph: Graph = {
        modules: [],
        byId: new Map(),
        entries: [],
        errors: [],
        warnings: [],
        emitted: new Map(),
        parseStats: { parsed: 0, reused: 0 },
        affected: new Set(),
        changed: new Set(),
        externalSideEffects: new Map(),
    };
    const cache = options.cache;
    const fs = memoBuildFs(options.fs);
    // Modules whose export surface changed vs the prior build — the affected-set frontier.
    const changedExports = new Set<string>();
    const jsxOptions = resolveJSXOptions(options.jsx);
    const compress = options.compress ?? false; // minify P4 — a MODE ('full'|'dce'|false); part of the parse-cache key below
    // The injected automatic JSX runtime is side-effect-free (conventionally pure), so an unused
    // injected `jsx`/`jsxs`/`Fragment` import prunes cleanly — the general form of the old
    // jsx-runtime special-case (see pruneUnusedExternals).
    graph.externalSideEffects.set(`${jsxOptions.importSource}/jsx-runtime`, false);
    const pipe = pipeline ?? compilePipeline(options.plugins ?? []);
    const baseResolve = makeBaseResolve(fs, options.resolve, options.platform, (m) => graph.warnings.push(m));
    // `symlinks:false` disables the realpath deref below (config form only).
    const normalizedResolve = normalizeResolve(
        typeof options.resolve === 'function' ? undefined : options.resolve,
        options.platform,
    );
    const pluginExternals = new Set<string>();
    /** resolveId/load option overrides keyed by RESOLVED id, finalized in addModule. */
    const pendingOptions = new Map<string, PendingOptions>();
    /** (specifier, importer) pairs currently being resolved — the `skipSelf` recursion guard. */
    const resolving = new Set<string>();

    const pendingFor = (id: string): PendingOptions => {
        let p = pendingOptions.get(id);
        if (p === undefined) {
            p = newPendingOptions();
            pendingOptions.set(id, p);
        }
        return p;
    };

    /** The shared resolve path used by both the graph walk and `ctx.resolve`. Runs the
     *  resolveId pipeline, normalizes {@link PartialResolvedId}, records its option overrides
     *  against the resolved id, then falls through to `baseResolve`. `skipPipeline` bypasses the
     *  plugins (used by the recursion guard). Returns the resolved id string, `false` (external),
     *  or `null` (unresolved). */
    const resolveThrough = async (
        specifier: string,
        importer: string | null,
        extra: ResolveIdExtra,
        skipPipeline = false,
    ): Promise<string | false | null> => {
        const hit = skipPipeline ? null : await runResolveId(pipe, ctx, specifier, importer, extra);
        if (hit === false) {
            pluginExternals.add(specifier);
            return false;
        }
        if (typeof hit === 'string') return hit;
        if (hit !== null && hit !== undefined && typeof hit === 'object') {
            const partial = hit as PartialResolvedId;
            if (partial.external !== undefined && partial.external !== false) {
                // true | 'absolute' | 'relative' → external. Treated alike (keep verbatim).
                pluginExternals.add(specifier);
                // A plugin may declare the external side-effect-free (rolldown `moduleSideEffects`),
                // letting an unreferenced import of it drop entirely.
                if (partial.moduleSideEffects === false) graph.externalSideEffects.set(specifier, false);
                return false;
            }
            mergeOptions(pendingFor(partial.id), partial);
            return partial.id;
        }
        return baseResolve(specifier, importer);
    };

    const ctx: PluginCtx = {
        warn: (m) => graph.warnings.push(m),
        error: (m) => {
            throw new Error(m);
        },
        info: (m) => graph.warnings.push(m),
        debug: () => {},
        fs: options.fs,
        resolve: async (source, importer = null, opts) => {
            const extra: ResolveIdExtra = {
                isEntry: opts?.isEntry ?? false,
                kind: opts?.kind ?? 'import-statement',
                custom: opts?.custom,
            };
            // Recursion guard: skipSelf (default true) short-circuits a resolveId hook that
            // re-resolves the same (specifier, importer) already in flight — if the key is
            // already being resolved, skip the pipeline and go straight to baseResolve.
            // Otherwise mark it in-flight for the duration so a NESTED ctx.resolve of the same
            // pair is caught.
            const key = `${importer ?? ''}\x00${source}`;
            const skipSelf = opts?.skipSelf !== false;
            const guardHit = skipSelf && resolving.has(key);
            const marked = skipSelf && !guardHit;
            if (marked) resolving.add(key);
            try {
                const r = await resolveThrough(source, importer, extra, guardHit);
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
        emitFile: (file) => {
            const fileName = resolveEmittedFileName(file);
            if (!graph.emitted.has(fileName)) graph.emitted.set(fileName, file.source);
            return fileName;
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
    const resolveFn = async (
        specifier: string,
        importer: string | null,
        extra: ResolveIdExtra,
    ): Promise<string | false | null> => {
        const key = `${importer ?? ''}\x00${specifier}`;
        resolving.add(key);
        try {
            return await resolveThrough(specifier, importer, extra);
        } finally {
            resolving.delete(key);
        }
    };

    const loadFn = async (id: string): Promise<string | null> => {
        if (id === EMPTY_MODULE_ID) return ''; // browser:false-disabled module → empty
        const r = await runLoad(pipe, ctx, id);
        if (r === null || r === undefined) return fs.read(id);
        if (typeof r === 'string') return r;
        // SourceDescription: take .code and merge its option overrides (load > resolveId).
        mergeOptions(pendingFor(id), r);
        return r.code;
    };

    const addModule = async (id: string, isEntry: boolean): Promise<number> => {
        const existing = graph.byId.get(id);
        if (existing !== undefined) return existing;
        const jsx = id.endsWith('.tsx') || id.endsWith('.jsx');

        // Signal-mode fast path: an unchanged module (not in the change signal) with a full cache
        // entry is reconstructed straight from cache — no load, transform, hash or parse. Resolution
        // still runs below, so file create/delete stays correct.
        const signalHit = options.incremental !== undefined && !options.incremental.changed.has(id) ? cache?.get(id) : undefined;

        let source: string;
        let program: Program;
        let nodeCount: number;
        let semantic: Semantic;
        let hasJSX: boolean;
        let sideEffects: ModuleSideEffects;
        let metaVal: CustomPluginOptions;
        let moduleTypeVal: ModuleType;
        let reuse: boolean;
        let hit: CachedParse | undefined;
        let srcHash = 0;
        let jsxRt: JSXRuntime | null = null; // captured by jsxLower (non-reuse); → mod.jsxRuntime

        if (signalHit !== undefined) {
            source = signalHit.source;
            program = signalHit.program;
            nodeCount = signalHit.nodeCount;
            semantic = signalHit.semantic;
            hasJSX = signalHit.hasJSX;
            sideEffects = signalHit.sideEffects;
            metaVal = signalHit.meta;
            moduleTypeVal = signalHit.moduleType;
            reuse = true;
            hit = signalHit;
            graph.parseStats.reused++;
        } else {
            const source0 = await loadFn(id);
            if (source0 === null) {
                graph.errors.push(`cannot load module '${id}'`);
                return -1;
            }
            const transformed = await runTransform(pipe, ctx, source0, id);
            source = transformed.code;
            // Merge transform overrides (transform > load > resolveId precedence).
            const pending = pendingFor(id);
            mergeOptions(pending, transformed);
            sideEffects = resolveModuleSideEffects(pending);
            metaVal = pending.meta;
            moduleTypeVal = pending.moduleType ?? moduleTypeOf(id);

            // Incremental cache: reuse parse/analyze/extract when the (post-transform) source is
            // unchanged. Those AST passes dominate build cost; load/transform/resolve stay per-build.
            srcHash = hashSource(source);
            hit = cache?.get(id);
            reuse = hit !== undefined && hit.srcHash === srcHash && hit.compress === compress;
            if (reuse && hit !== undefined) {
                ({ program, nodeCount, semantic } = hit);
                hasJSX = hit.hasJSX;
                graph.parseStats.reused++;
            } else {
                // Parse TS syntax only for actual TS modules — a `.js`/`.jsx` file is JavaScript, so
                // TS-mode parsing there is both wrong (rejects valid JS the TS grammar disallows) and
                // slower (needless type/generic speculation).
                const parsed = parse(source, { ts: moduleTypeVal === 'ts' || moduleTypeVal === 'tsx', jsx });
                for (const e of parsed.errors) graph.errors.push(`${id}:${e.pos}: ${e.msg}`);
                program = parsed.program;
                nodeCount = parsed.nodeCount;
                hasJSX = parsed.hasJSX;
                semantic = createSemantic();
                analyze(semantic, program);
                // TS + JSX lowering, all before extractRecords (rolldown Scan order): jsxLower injects a
                // real `import {…} from "…/jsx-runtime"` scanned as a normal record. Its minted runtime
                // symbols are captured into `jsxRt` → mod.jsxRuntime (for the runtime-import prune).
                const passes = [tsLower];
                if (jsx && hasJSX) {
                    jsxRt = { jsx: 0, jsxs: 0, Fragment: 0, createElement: 0 };
                    passes.push(makeJsxLower(jsxOptions.importSource, jsxOptions.pure, jsxRt));
                }
                traverse(program, semantic, passes);
                // 2nd traverse: strip residual TS types (assertions, type-only stmts/members, param
                // properties) after value lowering. Separate traverse so tsStrip never races tsLower's
                // replaceWith on a shared node (see ts-strip-pass-plan.md).
                traverse(program, semantic, [tsStrip]);
                // Reject only value namespaces the lowering couldn't handle (nested/merged/re-export)
                // — the handled ones are now `var`, so this runs AFTER the transform.
                collectUnsupported(program, id, graph.errors);
                // Compress (minify P4) runs here — after value lowering, BEFORE extractRecords — so it
                // is upstream of every sym-id-keyed index; a fresh semantic after it stays consistent,
                // and the (compress-aware) cache stores the already-compressed AST.
                // Opt tier (directive-gated) runs BEFORE compress: inlining EXPANDS code, and the
                // compress fixed point is what cleans the result up — folding the substituted
                // arguments and dropping the now-unreferenced declaration. This is the same ordering
                // compilecat's `run_all` uses (inline first, then the simplify loop).
                let expanded = inlineFunctions(program, semantic, source);
                if (unrollLoops(program, semantic, source)) expanded = true;
                if (scalarReplaceAggregates(program, semantic, source)) expanded = true;
                if (expanded) {
                    semantic = createSemantic();
                    analyze(semantic, program);
                }
                if (compress !== false) {
                    const refreshed = runCompress(program, semantic, compress);
                    if (refreshed !== null) semantic = refreshed;
                }
                graph.parseStats.parsed++;
                graph.changed.add(id);
            }
        }
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
            hasJSX,
            jsxRuntime: null,
            sideEffects,
            meta: metaVal,
            moduleType: moduleTypeVal,
            isEntry,
            entryName: null,
            external: false,
            importers: new Set(),
        };
        graph.modules.push(mod);
        graph.byId.set(id, mod.idx);
        if (reuse) {
            const c = hit as CachedParse;
            // Clone import records (resolved/external are per-build); namedImports/Exports index
            // them by position, which the clone preserves.
            mod.importRecords = c.importRecords.map((r) => ({
                specifier: r.specifier,
                resolved: -1,
                external: false,
                kind: r.kind,
                hasDynamicLiteral: r.hasDynamicLiteral,
            }));
            mod.namedImports = c.namedImports;
            mod.namedExports = c.namedExports;
            mod.starExports = c.starExports;
            mod.jsxRuntime = c.jsxRuntime;
        } else {
            extractRecords(mod); // scans the jsxLower-injected import as a normal record
            mod.jsxRuntime = jsxRt; // captured runtime symbols (null when no JSX)
            const exportSig = exportSignature(mod);
            // A changed module (had a prior cache entry) whose export surface differs marks its
            // importers stale (rspack AffectType). A brand-new module affects nothing pre-existing.
            if (hit !== undefined && hit.exportSig !== exportSig) changedExports.add(id);
            cache?.set(id, {
                srcHash,
                compress,
                program,
                nodeCount,
                semantic,
                importRecords: mod.importRecords.map((r) => ({
                    specifier: r.specifier,
                    kind: r.kind,
                    hasDynamicLiteral: r.hasDynamicLiteral,
                })),
                namedImports: mod.namedImports,
                namedExports: mod.namedExports,
                starExports: mod.starExports,
                hasJSX: mod.hasJSX,
                jsxRuntime: mod.jsxRuntime,
                exportSig,
                source,
                sideEffects,
                meta: metaVal,
                moduleType: moduleTypeVal,
            });
        }
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
            // `new URL('./x', import.meta.url)` asset: SCAN only resolves the target to a real path
            // (resolution is scan's job); the generate-stage `emitAssets` pass reads + content-hashes
            // + emits it. It is NOT a JS module — no parse, no chunk, no graph edge.
            if (rec.kind === 'new-url') {
                const hit = await resolveFn(rec.specifier, id, { isEntry: false, kind: 'import-statement' });
                if (typeof hit !== 'string') continue; // unresolved → leave the `new URL(...)` verbatim
                rec.assetPath = normalizedResolve.symlinks ? ((await fs.realpath?.(hit)) ?? hit) : hit;
                continue;
            }
            if (isExternal(options, rec.specifier) || pluginExternals.has(rec.specifier)) {
                rec.external = true;
                continue;
            }
            const resolved = await resolveFn(rec.specifier, id, {
                isEntry: false,
                kind: rec.kind === 'dynamic' ? 'dynamic-import' : 'import-statement',
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
            // symlinks:false disables the realpath deref (preserve the symlinked path).
            const depId = normalizedResolve.symlinks ? ((await fs.realpath?.(resolved)) ?? resolved) : resolved;
            rec.resolved = await addModule(depId, false);
            if (rec.resolved >= 0) graph.modules[rec.resolved].importers.add(id);
        }
        return mod.idx;
    };

    // buildStart runs with the full graph-backed ctx so `ctx.resolve` works from it.
    for (const hook of pipe.buildStart) await hook.handler(ctx);

    // Multi-entry rooting: resolve each normalized entry, add its module, mark it an entry, and
    // dedup into graph.entries (same module named twice ⇒ one root, first name wins). Rooting
    // stays in the caller, not addModule.
    const normalized = normalizeInput(options, graph.errors);
    const seen = new Set<number>();
    for (const { name, specifier } of normalized) {
        const entryResolved = await resolveFn(specifier, null, { isEntry: true, kind: 'entry' });
        const entryId = typeof entryResolved === 'string' ? entryResolved : specifier;
        const idx = await addModule(entryId, true);
        if (idx < 0) continue; // addModule already pushed a load error
        const mod = graph.modules[idx];
        mod.isEntry = true;
        if (mod.entryName === null) mod.entryName = name;
        if (!seen.has(idx)) {
            seen.add(idx);
            graph.entries.push({ module: idx, name });
        }
    }
    // Importers are now complete — propagate export-surface changes to the affected-set.
    if (changedExports.size > 0) graph.affected = computeAffected(graph, changedExports);
    return graph;
}
