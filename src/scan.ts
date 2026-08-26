import { semanticVerifyOn, verifySemantic } from './analysis/ref-facts';
import { analyze, createSemantic, retireSymbol, type Semantic, symbolOf } from './analysis/semantic';
import { isJSXNode, N, type Node, type Program, walk } from './ast';
import type { Fs, MaybePromise } from './fs';
import {
    type CachedParse,
    type ExportsKind,
    type Graph,
    type ImportRecordKind,
    isCommonJsFormat,
    isEsmFormat,
    type JSXRuntime,
    type Module,
    type ModuleDefFormat,
    NAME_DEFAULT,
    NAME_NAMESPACE,
} from './graph-types';
import { compileToModule } from './loaders';
import { createDefFormatLookup, EMPTY_MODULE_ID } from './node-resolve';
import { parse } from './parser';
import { runCompress } from './passes/compress';
import { compileDefines, makeDefine } from './passes/define';
import { makeJsxLower } from './passes/lower-jsx';
import { sawUnloweredTs, tsLower } from './passes/lower-ts';
import { eliminateDeadStores } from './passes/optimize/dead-store';
import { flowInlineVariables } from './passes/optimize/flow-inline';
import { inlineFunctions } from './passes/optimize/inline-functions';
import { resolveShapes, shapeCollector } from './passes/optimize/shapes';
import { scalarReplaceAggregates } from './passes/optimize/sroa';
import { unrollLoops } from './passes/optimize/unroll';
import { tsStrip } from './passes/strip-ts';
import { applyRefDelta, type RefDelta, traverse, type Visitor } from './passes/traverse';
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

/** How the semantic reaches the passes that run AFTER the TS/JSX lowering.
 *
 *  'rebuild'  — throw the pre-lowering semantic away and `analyze()` the lowered tree from scratch.
 *  'maintain' — keep the pre-lowering semantic, kept current by `attachScopeNode` (scope-owning
 *               nodes the lowerings mint) and the `RefDelta` their traversals record. Skips a full
 *               `analyze()` per TS module, measured at 33.4% of ALL semantic walking in a crashcat
 *               bundle (129,977 of 388,787 `visit()` calls).
 *  'verify'   — 'rebuild', plus assert the maintained semantic would have been equivalent.
 *
 *  Env-selectable so the whole suite can run under verification with
 *  `LOWER_SEMANTIC_MODE=verify pnpm test`. */
/** Hoisted so `traverse`'s per-node-type hook-table cache (keyed on the visitor ARRAY) hits instead
 *  of rebuilding for every module. Lower first, strip second — oxc's statement-level order.
 *
 *  `shapeCollector` goes FIRST when the optimize tier will consume its table: it reads written type
 *  annotations, and `tsStrip` (last) erases them, so within a node's enter phase it must run before
 *  the strip. Its output is only ever read by `scalarReplaceAggregates`, so without the tier there is
 *  nothing to collect for. */
const TS_PASSES: Visitor[] = [tsLower, tsStrip];
const TS_PASSES_WITH_SHAPES: Visitor[] = [shapeCollector, tsLower, tsStrip];
const EMPTY_PASSES: Visitor[] = [];

export type LowerSemanticMode = 'rebuild' | 'maintain' | 'verify';
let LOWER_SEMANTIC_MODE: LowerSemanticMode = (process.env.LOWER_SEMANTIC_MODE as LowerSemanticMode | undefined) ?? 'maintain';
export const setLowerSemanticMode = (m: LowerSemanticMode): void => {
    LOWER_SEMANTIC_MODE = m;
};

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

/** TypeScript import elision. `import { makeNode, Node } from './lib'` with `Node` used only as a
 *  type is ordinary TS — tsc (without `verbatimModuleSyntax`), rolldown and oxc all drop such a
 *  specifier. shakeup dropped one only when it carried an explicit `type` marker, so the binding
 *  survived into `namedImports`, `matchImport` found no value export that erasure had left behind,
 *  and the build failed with `'Node' is not exported by …`.
 *
 *  Runs HERE, after every module is resolved, for two reasons that rule out the earlier options:
 *   - the lowering traversal erases type annotations and `applyRefDelta` folds the resulting counts
 *     in only afterwards, so checking inside `tsStrip` reads stale counts and keeps everything;
 *   - EXTERNALITY is not knowable during scan. A plugin can mark a specifier external from
 *     `resolveId`, which happens after the importing module has been scanned.
 *
 *  Externals are deliberately untouched: their import line is rebuilt from `linked.externalLocals`,
 *  and whether an unreferenced one survives is decided by `pruneUnusedExternals` via symbol
 *  liveness — which needs the binding to still be there. Dropping it collapsed
 *  `import { a } from 'ext'` to a bare `import 'ext'`, which then reads as side-effectful and could
 *  no longer be pruned at all.
 *
 *  TS ONLY: in JavaScript an imported name that does not exist is a real error and must keep being
 *  reported, because no erasure could have removed it. */
function elideTypeOnlyImports(graph: Graph): void {
    for (const mod of graph.modules) {
        if (mod.moduleType !== 'ts' && mod.moduleType !== 'tsx') continue;
        if (mod.namedImports.size === 0) continue;
        for (const [sym, imp] of mod.namedImports) {
            if ((mod.semantic.uses[sym] ?? 0) > 0) continue; // still referenced as a value
            const rec = mod.importRecords[imp.rec];
            if (rec === undefined || rec.external || rec.resolved < 0) continue;
            mod.namedImports.delete(sym);
            // Retire the symbol too: left in module scope it still claims its name during
            // deconfliction, pushing the value that legitimately owns that name to `X$1`.
            retireSymbol(mod.semantic, sym);
        }
    }
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
        //
        // A `require` edge is NOT subject to that downgrade. It is what forces the target to be
        // wrapped, and that consequence outlives the fact that the same specifier may also be
        // imported statically — rolldown likewise lets `ImportKind::Require` drive `WrapKind`
        // regardless of the other edges. Losing it here silently un-lowered every `require` after
        // the first for a given specifier. `require` still counts as a static edge everywhere that
        // matters (`staticDeps` tests only for `dynamic`), so chunking is unaffected.
        if (dynamic) r.hasDynamicLiteral = true;
        if (kind === 'require' || r.kind === 'require') r.kind = 'require';
        else if (!dynamic) r.kind = 'static';
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
/** Does the module's own source carry an ESM `export` / `import` keyword? Tier 1 and tier 4 of the
 *  CommonJS kind rule. One body scan, shared by the classifier and both diagnostics. */
function esmSyntaxOf(mod: Module): { hasExport: boolean; hasImport: boolean } {
    // The AST scan below can only LOSE declarations, never gain them: an `export` after an
    // unconditional top-level `throw` is unreachable and is eliminated during lowering, and
    // classifying from the surviving body then made a genuine ES module CommonJS — it got a
    // `__commonJS` wrapper and every importer read the wrong shape, silently. `hasEsmExport` is
    // recorded at PARSE time, so it settles the tier-1 question from the source.
    let hasExport = mod.hasEsmExport;
    let hasImport = mod.hasEsmImport;
    for (const stmt of mod.program.data.body) {
        if (stmt.type === N.ImportDeclaration) hasImport = true;
        else if (
            stmt.type === N.ExportNamedDeclaration ||
            stmt.type === N.ExportDefaultDeclaration ||
            stmt.type === N.ExportAllDeclaration
        )
            hasExport = true;
        if (hasExport && hasImport) break;
    }
    return { hasExport, hasImport };
}

/** Does the module reference `module` / `exports` as FREE identifiers? Tier 2's other half.
 *  `semantic.unresolved` holds exactly the references that bound to no declaration, which is
 *  rolldown's `is_global_identifier_reference` (`ast_scanner/mod.rs:1073-1076`) — so a module that
 *  declares its own `exports` is correctly not counted. */
function cjsGlobalIn(mod: Module): Node | null {
    for (const node of mod.semantic.unresolved) if (node.name === 'module' || node.name === 'exports') return node;
    return null;
}

/** Classify a module's source (cjs.md §2.1), porting rolldown's four tiers in order
 *  (`ast_scanner/mod.rs:297-345`). DERIVED PER BUILD — never cached, because tier 3 reads
 *  {@link Module.defFormat}, which comes from another file (§7.1b).
 *
 *  Also emits the tier-1 warning: an ESM export keyword wins outright and the module IS ESM, but a
 *  free `module`/`exports` reference in one is a CommonJS habit that silently does nothing —
 *  `module.exports = x` throws and `exports.foo = x` writes to a global nobody reads. rolldown warns
 *  rather than reclassifying (`commonjs_variable_in_esm`); esbuild has no equivalent. */
function classifyExportsKind(mod: Module, warnings: string[]): ExportsKind {
    const { hasExport, hasImport } = esmSyntaxOf(mod);
    const cjsGlobal = cjsGlobalIn(mod);
    if (hasExport) {
        if (cjsGlobal !== null) {
            warnings.push(
                `${mod.id}:${cjsGlobal.start}: '${cjsGlobal.name}' is a CommonJS variable and is not defined in an ES module ` +
                    '(this file uses ESM `export`, so it is treated as ESM)',
            );
        }
        return 'esm';
    }
    if (cjsGlobal !== null || mod.hasTopLevelReturn) return 'commonjs';
    if (isCommonJsFormat(mod.defFormat)) return 'commonjs';
    if (isEsmFormat(mod.defFormat)) return 'esm';
    return hasImport ? 'esm' : 'none';
}

/** Reject a `require()` the bundler cannot resolve statically — a computed specifier
 *  (`require(name)`, `require('./' + x)`) or a call with the wrong arity.
 *
 *  cjs.md §2 pattern 7 called for this from the start and it went unimplemented, with the worst
 *  possible result: the call reached the output VERBATIM, the build reported no error, and the
 *  bundle threw `require is not defined` at runtime. A browser bundle has no module registry to
 *  resolve against, so there is nothing to lower it to — naming the file and the call is the only
 *  honest outcome. esbuild and rolldown both keep such a call as a runtime `require`, which only
 *  works because they can emit a CommonJS format; shakeup emits ESM only. */
function errorDynamicRequire(mod: Module, errors: string[]): void {
    if (!mod.hasRequire) return;
    walk(mod.program, (n) => {
        if (!isAnyRequireCall(n) || isRequireCall(n)) return;
        const args = (n.data as { arguments: Node[] }).arguments;
        const why = args.length !== 1 ? `it takes ${args.length} arguments` : 'its specifier is not a string literal';
        errors.push(
            `${mod.id}:${n.start}: cannot statically resolve this require() — ${why}. ` +
                'A bundle has no module registry to resolve against at runtime, so the specifier must be a literal.',
        );
    });
}

/** Error on an `import`/`export` statement in a file DECLARED CommonJS — a `.cjs`/`.cts` extension
 *  or the nearest `package.json#type: "commonjs"`. Port of oxc's `module_code` check
 *  (`oxc_semantic/src/checker/javascript.rs:532-548` **[V]**), whose message this mirrors.
 *
 *  The exact mirror of the tier-1 warning in {@link classifyExportsKind}: that one catches CommonJS habits in an ES module,
 *  this one catches ESM syntax in a CommonJS file. An ERROR rather than a warning because — unlike
 *  a stray `module.exports` in ESM, which merely does nothing — this file cannot be interpreted the
 *  way it is declared at all. Node rejects it too.
 *
 *  Reads only the DECLARED format, never `exportsKind`: kind detection's tier 1 says ESM syntax wins
 *  and the module IS ESM, which is precisely the contradiction being reported. */
function errorEsmSyntaxInCjs(mod: Module, errors: string[]): void {
    if (!isCommonJsFormat(mod.defFormat)) return;
    const why =
        mod.defFormat === 'cjs-package-json'
            ? 'the nearest package.json declares "type": "commonjs"'
            : `of its ${mod.defFormat === 'cts' ? '.cts' : '.cjs'} extension`;
    for (const stmt of mod.program.data.body) {
        const what =
            stmt.type === N.ImportDeclaration
                ? 'import'
                : stmt.type === N.ExportNamedDeclaration ||
                    stmt.type === N.ExportDefaultDeclaration ||
                    stmt.type === N.ExportAllDeclaration
                  ? 'export'
                  : null;
        if (what === null) continue;
        errors.push(
            `${mod.id}:${stmt.start}: '${what}' statement in a CommonJS file (this file is CommonJS because ${why}) — ` +
                `CommonJS uses require/module.exports, not import/export statements`,
        );
        return; // one per module is enough
    }
}

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
    // Both shapes below require `import(` or `import.meta`, which the parser already noted. Without
    // either, this whole-program walk cannot match — 97 of 97 modules on a crashcat bundle, 167,349
    // nodes for nothing.
    // `require("lit")` edges, and dynamic-import / asset edges, both need a whole-program walk
    // (either can nest arbitrarily deep). Each is gated by a parser flag so a module with neither
    // pays nothing.
    if (mod.hasRequire) {
        walk(mod.program, (n) => {
            if (!isRequireCall(n)) return;
            addRecord(mod, strValue(source, (n.data as { arguments: Node[] }).arguments[0]), 'require');
        });
    }
    if (!mod.hasImportSyntax) return;
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
/** A call to a FREE `require` with any argument shape — the superset {@link isRequireCall} narrows.
 *  Used to DIAGNOSE the calls that cannot be lowered rather than let them reach the output. */
export function isAnyRequireCall(n: Node): boolean {
    if (n.type !== N.CallExpression) return false;
    const d = n.data as { callee: Node };
    return d.callee.type === N.IdentifierReference && d.callee.name === 'require' && d.callee.sym === 0;
}

/** A `require("literal")` call with a FREE `require` — a local binding of that name is somebody
 *  else's function, not Node's. Only a string-literal specifier is an edge; a computed one cannot be
 *  resolved statically and is diagnosed separately. */
export function isRequireCall(n: Node): boolean {
    if (n.type !== N.CallExpression) return false;
    const d = n.data as { callee: Node; arguments: Node[] };
    if (d.callee.type !== N.IdentifierReference || d.callee.name !== 'require' || d.callee.sym !== 0) return false;
    return d.arguments.length === 1 && d.arguments[0].type === N.StringLiteral;
}

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
export function hashSource(s: string): number {
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
        platform: options.platform ?? 'browser',
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
    const optimizeTier = options.optimize ?? true; // directive-gated hot-path opts; `false` ignores all directives
    // The injected automatic JSX runtime is side-effect-free (conventionally pure), so an unused
    // injected `jsx`/`jsxs`/`Fragment` import prunes cleanly — the general form of the old
    // jsx-runtime special-case (see pruneUnusedExternals).
    graph.externalSideEffects.set(`${jsxOptions.importSource}/jsx-runtime`, false);
    const pipe = pipeline ?? compilePipeline(options.plugins ?? []);
    const baseResolve = makeBaseResolve(fs, options.resolve, options.platform, (m) => graph.warnings.push(m));
    // Per-build declared-format lookup (cjs.md §7.1b): a RESOLVE output, so its package.json cache
    // lives exactly one build and a `"type"` edit can never go stale.
    const defFormatOf = createDefFormatLookup(fs);
    const compiledDefines = options.define === undefined ? null : compileDefines(options.define);
    const definePass = compiledDefines === null ? null : makeDefine(compiledDefines);
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
        let hasImportSyntax: boolean;
        let hasTopLevelReturn = false;
        let hasRequire = false;
        let hasTopLevelAwait = false;
        let hasEsmExport = false;
        let hasEsmImport = false;
        let topLevelThis: Node[] = [];
        let sideEffects: ModuleSideEffects;
        let metaVal: CustomPluginOptions;
        let moduleTypeVal: ModuleType;
        let defFormat: ModuleDefFormat = 'unknown';
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
            hasImportSyntax = signalHit.hasImportSyntax;
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
            // Declared module goal (cjs.md §7.1b): a per-build RESOLVE output. Needed BEFORE the
            // cache lookup because it is part of the key, and before `parse` because it selects the
            // parse goal.
            defFormat = await defFormatOf(id);

            // Non-JavaScript module types become ES module SOURCE here, before hashing and parsing,
            // so everything downstream — the cache key, the parse goal, tree-shaking — sees an
            // ordinary module. `ModuleType` has declared `json`/`text`/`base64`/`dataurl`/`binary`
            // for a long time; only `ts`/`tsx` were ever acted on, and every other type fell through
            // to the JavaScript parser (`.json` failed with `expected ';'`).
            //
            // A plugin that REWROTE the source owns the module: `@rollup/plugin-json` and friends
            // turn `.json` into `export default …` in a `transform` hook, and running the built-in
            // loader afterwards fed that JavaScript to `JSON.parse`. Extension-derived types only
            // apply to source no plugin touched; an explicit `moduleType` from a plugin still wins,
            // so a plugin CAN hand work back to a built-in loader deliberately.
            const pluginOwns = pending?.moduleType === undefined && source !== source0;
            const compiled = pluginOwns ? null : compileToModule(moduleTypeVal, source, id);
            if (compiled !== null) {
                if ('error' in compiled) {
                    graph.errors.push(compiled.error);
                    return -1;
                }
                source = compiled.code;
            }

            // Incremental cache: reuse parse/analyze/extract when the (post-transform) source is
            // unchanged. Those AST passes dominate build cost; load/transform/resolve stay per-build.
            // Only when there is a cache to compare against or write to. `srcHash` is read at exactly
            // two places — the `reuse` test just below and the `cache?.set` at the end of this block —
            // so with no cache configured this hashed every module's source and threw the result away.
            // 1.21% of a crashcat bundling profile, and one-shot builds (CI, this benchmark) never
            // supply a cache; it is the watch loop that does.
            if (cache !== undefined) srcHash = hashSource(source);
            hit = cache?.get(id);
            // `defFormat` is part of the key because the AST is format-DEPENDENT: the parse goal
            // gates top-level `return`/`new.target` (cjs.md §7.1c). Unlike `ts`/`jsx` — also
            // per-module parse inputs, but derived from the id the cache is keyed by — a
            // `package.json#type` edit changes this WITHOUT changing the id or the source, so it
            // must be compared explicitly or a stale AST survives the edit.
            reuse =
                hit !== undefined &&
                hit.srcHash === srcHash &&
                hit.compress === compress &&
                hit.optimize === optimizeTier &&
                hit.defFormat === defFormat;
            if (reuse && hit !== undefined) {
                ({ program, nodeCount, semantic } = hit);
                hasJSX = hit.hasJSX;
                hasImportSyntax = hit.hasImportSyntax;
                hasTopLevelReturn = hit.hasTopLevelReturn;
                hasRequire = hit.hasRequire;
                hasTopLevelAwait = hit.hasTopLevelAwait;
                hasEsmExport = hit.hasEsmExport;
                hasEsmImport = hit.hasEsmImport;
                topLevelThis = hit.topLevelThis;
                graph.parseStats.reused++;
            } else {
                // Parse TS syntax only for actual TS modules — a `.js`/`.jsx` file is JavaScript, so
                // TS-mode parsing there is both wrong (rejects valid JS the TS grammar disallows) and
                // slower (needless type/generic speculation).
                const isTs = moduleTypeVal === 'ts' || moduleTypeVal === 'tsx';
                // Permissive `unambiguous` unless the file carries an explicit goal signal, so
                // plain `.js` in a typeless package parses exactly as before (cjs.md §7.1c).
                const kind = isEsmFormat(defFormat) ? 'module' : isCommonJsFormat(defFormat) ? 'commonjs' : 'unambiguous';
                const parsed = parse(source, { ts: isTs, jsx, kind });
                for (const e of parsed.errors) graph.errors.push(`${id}:${e.pos}: ${e.msg}`);
                program = parsed.program;
                nodeCount = parsed.nodeCount;
                hasJSX = parsed.hasJSX;
                hasImportSyntax = parsed.hasImportSyntax;
                hasTopLevelReturn = parsed.hasTopLevelReturn;
                hasRequire = parsed.hasRequire;
                hasTopLevelAwait = parsed.hasTopLevelAwait;
                hasEsmExport = parsed.hasEsmExport;
                hasEsmImport = parsed.hasEsmImport;
                topLevelThis = parsed.topLevelThis;
                semantic = createSemantic();
                analyze(semantic, program);
                // TS + JSX lowering, all before extractRecords (rolldown Scan order): jsxLower injects a
                // real `import {…} from "…/jsx-runtime"` scanned as a normal record. Its minted runtime
                // symbols are captured into `jsxRt` → mod.jsxRuntime (for the runtime-import prune).
                // GATED ON THE MODULE'S LANGUAGE. The parser already skips TS-mode parsing for a
                // `.js` file (see above); the LOWERING did not, so every JavaScript module paid two
                // whole-program traversals — `tsLower` and `tsStrip` — to find nothing. Counting work
                // rather than time made it obvious: a build of three.core.js (plain JS) ran 12 full
                // traversals, and these were 2 of them, ~17% of all 1.59M node visits, for zero
                // mutations. A profile cannot show this; it looks like ordinary traversal cost.
                // ONE traversal for the whole transform, which is oxc's model: a single
                // `traverse_mut_with_ctx` drives annotations + enum + namespace + module + JSX
                // (`oxc_transformer/src/lib.rs:190`). `tsStrip` used to need a second walk because
                // `fireEnter` consumes `ctx.op` only AFTER every hook for a node has run, so two
                // visitors acting on one node would clobber each other (`ts-strip-pass-plan.md`).
                // That hazard is real in the mechanism but cannot arise between these passes: they
                // share exactly three node types and their predicates are exact complements —
                // `tsLower` takes the VALUE form (`declare !== true`), `tsStrip` the `declare` form.
                // `LOWER_SEMANTIC_MODE=verify` asserts it (see `fireEnter`'s conflict check) rather
                // than leaving it to a comment.
                //
                // GATED ON THE MODULE'S LANGUAGE. A `.js` file runs none of this; the lowering used
                // to walk every JavaScript module to find nothing.
                const wantShapes = isTs && optimizeTier;
                let passes: Visitor[];
                if (jsx && hasJSX) {
                    jsxRt = { jsx: 0, jsxs: 0, Fragment: 0, createElement: 0 };
                    const jsxPass = makeJsxLower(jsxOptions.importSource, jsxOptions.pure, jsxRt);
                    // jsxLower carries per-module state, so this array cannot be shared.
                    passes = isTs
                        ? wantShapes
                            ? [shapeCollector, tsLower, jsxPass, tsStrip]
                            : [tsLower, jsxPass, tsStrip]
                        : [jsxPass];
                } else {
                    // Shared constants: `traverse` caches its per-node-type hook tables on the visitor
                    // ARRAY, so a fresh array per module would miss that cache every time.
                    passes = isTs ? (wantShapes ? TS_PASSES_WITH_SHAPES : TS_PASSES) : EMPTY_PASSES;
                }
                // Reference movement from the lowering traversal, folded into `semantic` below.
                // `replaceWith`/`spliceStatements` already record it via `dropRefs`/`addRefs`; they
                // are inert unless a delta map is threaded in, which is why the lowerings used to
                // leave `semantic.refs` describing the PRE-lowering tree.
                // `define` runs FIRST in the lowering traversal — before TS/JSX, matching rolldown's
                // step ordering (`pre_process_ecma_ast.rs:155`) — and well before compress, so the
                // substituted literal is what fold-constants and dead-code get to see.
                if (definePass !== null) passes = passes.length === 0 ? [definePass] : [definePass, ...passes];
                const lowerDelta = new Map<number, RefDelta>();
                if (passes.length > 0) traverse(program, semantic, passes, lowerDelta);
                // Resolved AFTER the walk: a `type`/`interface` may be declared after the declaration
                // that references it, so the alias table is only complete once the traversal ends.
                const shapes = wantShapes ? resolveShapes() : new Map<number, string[]>();
                // INVARIANT: a pass that reads `Semantic` must get one that describes the CURRENT
                // tree. The lowering above creates real bindings and scopes (a TS enum lowers to an
                // IIFE, JSX injects a runtime import), which the pre-lowering `analyze` cannot know
                // about — measured: 7 scopes recorded vs 8 in the tree, and 2 scope-owning nodes with
                // no `nodeScope` entry. Left stale, `ctx.currentScope` is wrong inside those regions
                // and anything resolving names against it (inline's hygiene check, block-flatten's
                // collision check, SROA's target scope) silently works from bad data.
                // ...but ONLY when a lowering actually ran. `tsLower`, `captureShapes` and `tsStrip`
                // are all gated above, so a plain-JS module without JSX mutates nothing here — and
                // rebuilding the semantic to observe changes that were never made cost a full
                // `analyze()` of every node, per module. `analyze` is the largest single file in a
                // bundling profile (13%) and runs ~3x per module; this removes one of those for every
                // JavaScript module, which in a real graph is most of `node_modules`.
                if (isTs || passes.length > 0) {
                    applyRefDelta(semantic, lowerDelta);
                    if (LOWER_SEMANTIC_MODE === 'verify') {
                        const problems = verifySemantic(semantic, program);
                        if (problems.length > 0)
                            throw new Error(
                                `maintained semantic diverged after lowering in ${id}:\n  ${problems.slice(0, 20).join('\n  ')}`,
                            );
                    }
                    if (LOWER_SEMANTIC_MODE !== 'maintain') {
                        semantic = createSemantic();
                        analyze(semantic, program);
                    }
                }
                // TypeScript import elision. `import { makeNode, Node } from './lib'` with `Node`
                // used only as a type is ordinary TS — tsc (without `verbatimModuleSyntax`),
                // rolldown and oxc all drop such a specifier. Without it the specifier survives into
                // `namedImports`, link looks for a value export that erasure removed, and the build
                // fails with `'Node' is not exported by …`. The same happens for a specifier that is
                // never referenced at all.
                //
                // MUST run here: after `applyRefDelta`, because the type annotations that referenced
                // these bindings are erased by `tsStrip` DURING the traversal and their reference
                // counts are only folded in afterwards — checking inside the pass would read stale
                // counts and keep every specifier. And before `extractRecords` (below), which is what
                // turns surviving specifiers into import records.
                //
                // TS ONLY. In JavaScript an imported name that does not exist is a real error and
                // should keep being reported; there is no erasure that could have removed it.
                // Reject only value namespaces the lowering couldn't handle (nested/merged/re-export)
                // — the handled ones are now `var`, so this runs AFTER the transform.
                // Only a TS module can contain the construct this looks for (a value
                // `namespace`), so a `.js`/`.jsx` module skips the walk entirely.
                // Only when the lowering left one of the two constructs this diagnoses behind — it walks every
                // node otherwise, and on a clean TS corpus finds nothing (97 walks, 178,021 nodes, 0 errors).
                if (isTs && sawUnloweredTs()) collectUnsupported(program, id, graph.errors);
                // Compress (minify P4) runs here — after value lowering, BEFORE extractRecords — so it
                // is upstream of every sym-id-keyed index; a fresh semantic after it stays consistent,
                // and the (compress-aware) cache stores the already-compressed AST.
                // Opt tier (directive-gated) runs BEFORE compress: inlining EXPANDS code, and the
                // compress fixed point is what cleans the result up — folding the substituted
                // arguments and dropping the now-unreferenced declaration. This is the same ordering
                // compilecat's `run_all` uses (inline first, then the simplify loop).
                let expanded = false;
                // Part of the standard `SEMANTIC_VERIFY` gate. It began as a diagnostic because the
                // tier reported 32 divergences the following rebuild absorbed — but every one was an
                // UNSAFE class (unbound / UNDER / partition / missing scopeId), and the rebuild does
                // NOT protect against the dangerous case: `flowInlineVariables` moved a block-scoped
                // local out of its block, and a rebuild cannot fix tree corruption, it just makes the
                // semantic agree with the broken tree.
                //
                // All four passes now maintain, so checking per pass names an offender directly instead
                // of surfacing two stages later against a compress round.
                const verifyAfter = (passName: string): void => {
                    if (!semanticVerifyOn()) return;
                    const problems = verifySemantic(semantic, program);
                    if (problems.length > 0)
                        throw new Error(
                            `maintained semantic diverged after ${passName} in ${id}:\n  ${problems.slice(0, 20).join('\n  ')}`,
                        );
                };
                if (optimizeTier) {
                    expanded = inlineFunctions(program, semantic, source);
                    verifyAfter('inlineFunctions');
                    if (unrollLoops(program, semantic, source)) expanded = true;
                    verifyAfter('unrollLoops');
                    if (scalarReplaceAggregates(program, semantic, source, shapes)) expanded = true;
                    verifyAfter('scalarReplaceAggregates');
                    // Flow-sensitive inlining runs AFTER the structural expanders (function-inline,
                    // unroll, sroa) so it sees the straight-line code they produce; the compress fixed
                    // point then folds each substituted RHS. Directive-gated like the rest of the tier.
                    // NO REBUILD between the structural expanders and flow-inline: all four tier
                    // passes now MAINTAIN the semantic (verified per pass under `SEMANTIC_VERIFY`).

                    if (flowInlineVariables(program, semantic, source)) expanded = true;
                    verifyAfter('flowInlineVariables');
                    // Dead-store LAST in the tier: its job is cleaning up the `result = X; break L;`
                    // scaffolding the inliners emit, so it must see their output.
                    if (eliminateDeadStores(program, semantic, source)) expanded = true;
                    verifyAfter('eliminateDeadStores');
                }
                // NO REBUILD after the optimize tier either — same reason. This and the one above
                // were the last two per-module rebuilds outside the initial `analyze`.
                void expanded;
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
            hasImportSyntax,
            hasTopLevelReturn,
            hasRequire,
            hasTopLevelAwait,
            hasEsmExport,
            hasEsmImport,
            topLevelThis,
            jsxRuntime: null,
            sideEffects,
            meta: metaVal,
            moduleType: moduleTypeVal,
            isEntry,
            entryName: null,
            external: false,
            defFormat,
            exportsKind: 'none', // classified below, once records are extracted
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
            mod.exportsKind = classifyExportsKind(mod, graph.warnings);
            errorEsmSyntaxInCjs(mod, graph.errors);
            errorDynamicRequire(mod, graph.errors);
        } else {
            extractRecords(mod); // scans the jsxLower-injected import as a normal record
            mod.exportsKind = classifyExportsKind(mod, graph.warnings);
            errorEsmSyntaxInCjs(mod, graph.errors);
            errorDynamicRequire(mod, graph.errors);
            mod.jsxRuntime = jsxRt; // captured runtime symbols (null when no JSX)
            const exportSig = exportSignature(mod);
            // A changed module (had a prior cache entry) whose export surface differs marks its
            // importers stale (rspack AffectType). A brand-new module affects nothing pre-existing.
            if (hit !== undefined && hit.exportSig !== exportSig) changedExports.add(id);
            cache?.set(id, {
                srcHash,
                compress,
                optimize: optimizeTier,
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
                hasImportSyntax: mod.hasImportSyntax,
                hasTopLevelReturn: mod.hasTopLevelReturn,
                hasRequire: mod.hasRequire,
                hasTopLevelAwait: mod.hasTopLevelAwait,
                hasEsmExport: mod.hasEsmExport,
                hasEsmImport: mod.hasEsmImport,
                topLevelThis: mod.topLevelThis,
                jsxRuntime: mod.jsxRuntime,
                exportSig,
                source,
                sideEffects,
                meta: metaVal,
                moduleType: moduleTypeVal,
                defFormat,
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
    elideTypeOnlyImports(graph);
    // Importers are now complete — propagate export-surface changes to the affected-set.
    if (changedExports.size > 0) graph.affected = computeAffected(graph, changedExports);
    return graph;
}
