// The per-module pass of the generate stage: render every module of one chunk to text, in that
// chunk's perspective.
//
// The collect-then-print pairing here CANNOT be lifted into a bundle-wide pass the way rolldown
// lifts `finalize_modules` ahead of rendering. rolldown can because it MUTATES the AST; shakeup
// builds `Map<Node, string>` overrides that `printModule` consumes and discards, so collection and
// printing are one unit. That is deliberate: the module AST is reused across builds through
// `options.cache`, and mutating it during render would poison the next build.
import { SYM, symbolOf } from '../../analysis/semantic.ts';
import { N, type Node, walk } from '../../ast/index.ts';
import type { Chunk } from '../chunk-graph.ts';
import {
    type Graph,
    type ImportBind,
    type ImportRecord,
    isEsmFormat,
    type Linked,
    NAME_NAMESPACE,
    packRef,
    refMod,
    refSym,
} from '../graph-types.ts';
import { initRefForRecord, recordIsInitObligation } from '../init-obligations.ts';
import { finalNameOf } from '../link.ts';
import { lazySplit } from '../../passes/lazy-split.ts';
import { interopNamespace, materialiseLiveBody, wrapModuleBody } from '../../passes/wrap-module.ts';
import { printModule } from '../../print/print-js.ts';
import { createPrinter, finishPrinter } from '../../print/printer.ts';
import { isRequireCall } from '../scan.ts';
import type { Mappings } from '../../util/sourcemap.ts';
import { effectiveComments } from '../output-options.ts';
import { buildLineTable, type Part, trimMappings } from '../../util/sourcemap.ts';
import {
    clauseSep,
    type EmitCtx,
    isIdentName,
    type ModuleReuse,
    nameOfBind,
    type RenderCtx,
    type RenderedModules,
} from './context.ts';
import { freeRequireRefs } from './esm.ts';

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

/** The printer backend drops import/export statements itself, but still needs the side-effect-import
 *  and entry-star tracking that their removal implies — this records it without producing edits. */
function trackChunkSpecs(ctx: EmitCtx, isEntry: boolean, entryStarSpecs: string[], sideEffectSpecs: Set<string>): void {
    const { mod } = ctx;
    const src = mod.source;
    for (const statement of mod.program.data.body) {
        if (ctx.live !== null && !ctx.live.has(statement.id)) continue;
        if (statement.type === N.ImportDeclaration) {
            if (statement.data.importKind === 'type') continue;
            const source = statement.data.source;
            if (source.type === N.StringLiteral && statement.data.specifiers.length === 0) {
                const spec = src.slice(source.start + 1, source.end - 1);
                const rec = mod.importRecords.find((r) => r.specifier === spec);
                if (rec?.external) sideEffectSpecs.add(spec);
            }
        } else if (statement.type === N.ExportAllDeclaration) {
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
        }
    }
}

function collectRequireOverrides(ctx: EmitCtx, map: Map<Node, string>): void {
    const { mod, linked } = ctx;
    // Top-level `this` means `module.exports` in CommonJS (cjs.md §2.4). Only meaningful once the
    // body is a wrapper closure, which is where `exports` is bound.
    if (linked.cjsWrap.has(mod.idx)) for (const n of mod.topLevelThis) map.set(n, 'exports');
    for (const n of freeRequireRefs(mod)) map.set(n, '__require');
    if (!mod.hasRequire) return;
    walk(mod.program, (n) => {
        if (!isRequireCall(n)) return;
        const spec = (n.data as { arguments: Node[] }).arguments[0].name;
        const text = spec.length >= 2 ? spec.slice(1, -1) : spec;
        const rec = mod.importRecords.find((r) => r.kind === 'require' && r.specifier === text);
        if (rec === undefined) return;
        // EXTERNAL (cjs.md §7.6) — nothing to lower to, so route the call through the `__require`
        // shim. On `platform: 'node'` that is `createRequire(import.meta.url)` and the call genuinely
        // works; elsewhere it throws a named error instead of `require is not defined`. Both oracles
        // do this: esbuild wraps any `require(…)` it cannot bundle with
        // `valueToSubstituteForRequire` (`js_parser.go:15788-15791, 15800-15804`), and rolldown's
        // shim points its error message at "bundling-cjs#require-external-modules".
        //
        // Distinct from a DYNAMIC `require(expr)`, which stays a loud build error: that one has no
        // specifier to hand anybody, so deferring it to runtime would only hide it.
        if (rec.external) {
            map.set(n, `__require(${spec})`);
            return;
        }
        if (rec.resolved < 0) return;
        const wrapRef = linked.cjsWrap.get(rec.resolved);
        if (wrapRef !== undefined) {
            // Chunk-local alias first: a `require` that crosses a chunk boundary must call the name
            // this chunk imported the wrapper under, not the producer's own local.
            const wrapper = ctx.chunk.importLocalOf.get(wrapRef) ?? finalNameOf(linked, wrapRef);
            map.set(n, `${wrapper}()`);
            return;
        }
        // Requiring an ES module: hand back its namespace wrapped so the requiring CommonJS code
        // sees `__esModule: true` and its own default-interop resolves. `__toCommonJS` builds a
        // FRESH object per call rather than stamping the namespace itself — the importing side must
        // never see `__esModule` (cjs.md §4.3's asymmetry).
        // Chunk-local alias first, same as the wrapper above: across a boundary the namespace is
        // IMPORTED under a local name, not named by the producer's own.
        if (!linked.namespaceOf.has(rec.resolved)) return;
        const ns = nameOfBind(linked, { kind: 'namespace', module: rec.resolved }, ctx.chunk);
        if (ns === null) return;
        // A require-only ESM target is behind an `__esm` closure, so the CALL is what evaluates it —
        // that is the whole point of the lazy form. Sequencing the init in front of the read is
        // rolldown's shape too: `const foo = (init_foo(), __toCommonJS(foo_exports))`
        // (`tests/rolldown/misc/wrapped_esm/artifacts.snap`).
        // Shared predicate — `init-obligations.ts`.
        const initRef = initRefForRecord(linked, rec, 'require');
        if (initRef === undefined) {
            map.set(n, `__toCommonJS(${ns})`);
            return;
        }
        const initName = ctx.chunk.importLocalOf.get(initRef) ?? finalNameOf(linked, initRef);
        map.set(n, `(${initName}(), __toCommonJS(${ns}))`);
    });
}

/**
 * `init_X();` text for each included static import statement whose target is lazily initialised.
 *
 * Keyed by the IMPORT STATEMENT, because that is where the call must land: the statement already
 * sits in the importer's source order, so replacing it in place makes evaluation order fall out
 * (`cjs.md` §7.25d). The gate is the shared predicate, never `linked.esmInit` read inline.
 */
function collectInitCalls(ctx: EmitCtx): Map<Node, string> {
    const { mod, linked, chunk, interopOwners } = ctx;
    const map = new Map<Node, string>();
    // O(records) pre-check: a module with no static target that is either lazily initialised or a
    // wrapped CommonJS module contributes nothing, and the walk below is skipped for the
    // overwhelming majority of modules.
    const nsMap = isEsmFormat(mod.defFormat) ? linked.cjsNamespaceNode : linked.cjsNamespace;
    const wants = (r: ImportRecord): boolean =>
        recordIsInitObligation(r, 'static-import') && (linked.esmInit.has(r.resolved) || nsMap.has(r.resolved));
    if (!mod.importRecords.some(wants)) return map;
    const src = mod.source;
    for (const stmt of (mod.program.data as { body: Node[] }).body) {
        // `import './e.js'`, `export { v } from './e.js'` and `export * from './e.js'` are the same
        // dependency edge as far as evaluation goes: each names a module that has to have run by the
        // time this statement is reached. A re-export carries the obligation exactly like an import,
        // which is what the `re-export chain to target` shape in `pnpm evalorder` measures.
        if (stmt.type !== N.ImportDeclaration && stmt.type !== N.ExportNamedDeclaration && stmt.type !== N.ExportAllDeclaration)
            continue;
        const source = (stmt.data as { source: Node | null }).source;
        if (source === null || source.type !== N.StringLiteral) continue;
        const spec = src.slice(source.start + 1, source.end - 1);
        const rec = mod.importRecords.find((r) => r.specifier === spec && r.kind === 'static');
        if (rec === undefined) continue;
        const initRef = initRefForRecord(linked, rec, 'static-import');
        if (initRef !== undefined) {
            const name = chunk.importLocalOf.get(initRef) ?? finalNameOf(linked, initRef);
            map.set(stmt, `${name}();`);
            continue;
        }
        // A WRAPPED CommonJS target instead: this statement runs the module by building its interop
        // namespace, but only if it is the statement that OWNS it. Everyone else just reads the
        // binding the owner declared — see `computeInteropOwners` for why one and not all.
        if (!recordIsInitObligation(rec, 'static-import')) continue;
        const nsRef = nsMap.get(rec.resolved);
        if (nsRef === undefined) continue;
        const owner = interopOwners.get(nsRef);
        if (owner === undefined || owner.module !== mod.idx || owner.stmtId !== stmt.id) continue;
        const wrapRef = linked.cjsWrap.get(rec.resolved);
        if (wrapRef === undefined) continue;
        const nsName = chunk.importLocalOf.get(nsRef) ?? finalNameOf(linked, nsRef);
        const wrapName = chunk.importLocalOf.get(wrapRef) ?? finalNameOf(linked, wrapRef);
        const nodeArg = isEsmFormat(mod.defFormat) ? ', 1' : '';
        map.set(stmt, `var ${nsName} = /* @__PURE__ */ __toESM(${wrapName}()${nodeArg});`);
    }
    return map;
}

/** Pre-resolve the node-level rewrites the edit engine applies inline — dynamic `import()`
 *  retargeting and `new URL` asset URLs — into a node→text map the printer consults. Keyed on the
 *  exact node whose text is replaced (the whole `import()` for same-chunk/dropped; the specifier
 *  string otherwise). */
function collectLinkOverrides(ctx: EmitCtx): Map<Node, string> {
    const { mod, chunkGraph } = ctx;
    const map = new Map<Node, string>();
    // `import * as ns` bindings in THIS module whose target's namespace object is being elided
    // (`TreeshakeResult.elidableNs`): every `ns.foo` becomes `foo`'s own binding. Built first because
    // it has its own reason to walk — a module can have namespace imports and no `import()` at all.
    const elidedNs = new Map<number, number>(); // local ns symbol → target module idx
    if (ctx.elidableNs.size > 0)
        for (const [localSym, imp] of mod.namedImports) {
            if (imp.name !== NAME_NAMESPACE) continue;
            const rec = mod.importRecords[imp.rec];
            if (rec.external || rec.resolved < 0) continue;
            if (ctx.elidableNs.has(rec.resolved)) elidedNs.set(localSym, rec.resolved);
        }
    // Only `import()` and `new URL(...)` produce the OTHER overrides, and the scan already recorded
    // both as import records — so a module with neither, and no elided namespace, cannot contribute
    // one and the whole-program walk is skipped. Checking is O(records).
    if (
        elidedNs.size === 0 &&
        !mod.importRecords.some((r) => r.kind === 'dynamic' || r.kind === 'new-url' || r.hasDynamicLiteral)
    )
        return map;
    walk(mod.program, (n) => {
        if (elidedNs.size > 0 && n.type === N.StaticMemberExpression && n.data.object.type === N.IdentifierReference) {
            const target = elidedNs.get(symbolOf(mod.semantic, n.data.object));
            if (target !== undefined) {
                // `analyzeNsUsage` already proved every appearance of this binding is exactly this
                // shape, and `computeElidableNs` proved every name resolves — so a miss here is a
                // bug in one of them, and leaving the node alone would emit a reference to a
                // namespace that no longer exists. Fail loudly instead.
                const bind = ctx.linked.exportMaps.get(target)?.get(n.data.property.name as string);
                const local = bind === undefined ? null : nameOfBind(ctx.linked, bind, ctx.chunk);
                if (local === null)
                    throw new Error(
                        `namespace elision: ${mod.id} reads '${n.data.property.name}' off an elided namespace with no binding`,
                    );
                map.set(n, local);
                return;
            }
        }
        if (n.type === N.ImportExpression) {
            const source = n.data.source;
            if (source.type === N.StringLiteral) {
                const spec = mod.source.slice(source.start + 1, source.end - 1);
                const rec = mod.importRecords.find((r) => r.specifier === spec);
                if (rec !== undefined && !rec.external && rec.resolved >= 0) {
                    // Through the FACADE when the target has one — `chunkByModule` names the chunk
                    // that HOLDS the module, which for a faced dynamic entry exports more than the
                    // module does. See the facade pass in `chunk-graph.ts`.
                    const targetChunk = chunkGraph.entryChunkOf.get(rec.resolved) ?? chunkGraph.chunkByModule[rec.resolved];
                    if (targetChunk < 0) {
                        map.set(n, 'Promise.resolve({})');
                    } else if (targetChunk === chunkGraph.chunkByModule[mod.idx]) {
                        // A CommonJS target resolves to its INTEROP namespace (which carries
                        // `default`), not to `namespaceOf` — same object a static `import` of it
                        // gets. Chunk-local alias first, as everywhere else.
                        const cjsNs = ctx.linked.cjsNamespace.get(rec.resolved);
                        const nsName =
                            cjsNs !== undefined
                                ? (ctx.chunk.importLocalOf.get(cjsNs) ?? finalNameOf(ctx.linked, cjsNs))
                                : ctx.linked.namespaceOf.get(rec.resolved);
                        map.set(n, `Promise.resolve().then(() => ${nsName ?? '{}'})`);
                    } else {
                        const path = ctx.pathToChunk(targetChunk);
                        // A mode-2 target's chunk exports the runtime namespace OBJECT under a
                        // single name — its members are not knowable as chunk exports — so the
                        // import site unwraps it and the caller's `m.a` reads the object.
                        const nsExport = chunkGraph.chunks[targetChunk].nsExportName?.get(rec.resolved);
                        if (nsExport !== undefined && ctx.linked.dynamicExports.has(rec.resolved)) {
                            map.set(n, `import('${path}').then((m) => m.${nsExport})`);
                        } else if (n.data.options !== null) {
                            // DROP the import-attributes argument. The specifier now points at a
                            // JavaScript chunk, so `{ with: { type: 'json' } }` has become a lie and
                            // Node rejects the load outright:
                            //   `import('./d.json', { with: { type: 'json' } })`
                            //     → `import('./d-BoSLbCma.js', { with: { type: 'json' } })`
                            //     → TypeError: Module "…/d-BoSLbCma.js" is not of type "json"
                            // A build that reported no errors produced a bundle that threw. Both
                            // oracles drop the attribute for a BUNDLED module for the same reason and
                            // keep it only for an external — and an external never reaches here,
                            // because `rec.external` short-circuits above.
                            map.set(n, `import('${path}')`);
                        } else map.set(source, `'${path}'`);
                    }
                }
            }
        }
        if (
            n.type === N.NewExpression &&
            n.data.arguments.length === 2 &&
            n.data.callee.type === N.IdentifierReference &&
            n.data.callee.name === 'URL'
        ) {
            const base = n.data.arguments[1];
            if (
                base.type === N.StaticMemberExpression &&
                base.data.object.type === N.ImportMeta &&
                base.data.property.name === 'url'
            ) {
                const spec = n.data.arguments[0];
                if (spec.type === N.StringLiteral) {
                    const specifier = mod.source.slice(spec.start + 1, spec.end - 1);
                    const rec = mod.importRecords.find((r) => r.kind === 'new-url' && r.specifier === specifier);
                    if (rec?.assetFileName !== undefined) map.set(spec, JSON.stringify(rec.assetFileName));
                }
            }
        }
    });
    return map;
}

/** Whether a namespace member's local binding can never be reassigned, so the namespace may hold it
 *  as a plain value instead of an accessor. Only a positive proof counts: a `const`/`function`/
 *  `class` declaration in this graph. A namespace-of-a-namespace, an external, a synthetic ref, or
 *  anything whose symbol we cannot inspect falls through to `false` (accessor), which is always
 *  correct — just larger. */
function isImmutableBind(linked: Linked, bind: ImportBind): boolean {
    if (bind.kind !== 'found') return false;
    const mod = linked.graph.modules[refMod(bind.ref)];
    const sym = mod?.semantic.symbols[refSym(bind.ref)];
    if (sym === undefined) return false; // synthetic (`*_default`) refs have no symbol record
    return (sym.flags & (SYM.CONST | SYM.FUNCTION | SYM.CLASS)) !== 0;
}

function renderNamespaceObject(
    graph: Graph,
    linked: Linked,
    modIdx: number,
    chunk: Chunk,
    nsMembers: Set<string> | undefined,
    tight: boolean,
    /** `output.generatedCode.symbols` — see {@link RenderCtx.symbols}. */
    symbols: boolean,
    /** The `var` is already declared outside (lazy-init form) — assign, do not redeclare. */
    preDeclared = false,
    /** Force accessors for every member. A SPLIT lazy module's bindings are hoisted `var`s that stay
     *  `undefined` until `init` runs, so a plain value here would snapshot `undefined` — the
     *  immutability that normally justifies a plain value is about the SYMBOL's kind, which still
     *  says `const` even though the emitted declaration is now a bare `var`. */
    forceAccessors = false,
): string {
    const nsName = linked.namespaceOf.get(modIdx)!;
    const map = linked.exportMaps.get(modIdx);
    const entries: string[] = [];
    if (map !== undefined) {
        // SORTED BY NAME, matching rollup's `sortExportedVariables` (`Module.ts:1505`,
        // `a < b ? -1 : a > b ? 1 : 0` — plain code-unit order, not `localeCompare`). A namespace
        // object's key order is OBSERVABLE through `Object.keys`/`getOwnPropertyNames`, and rollup's
        // `namespace-keys-are-sorted` asserts the exact sequence, so source order is a divergence
        // rather than a free choice.
        for (const [name, bind] of [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
            // Narrowed target: emit only the members its consumers read (tree-shake seeded exactly
            // these live). Absent set → whole surface (target escaped / entry / dynamic).
            if (nsMembers !== undefined && !nsMembers.has(name)) continue;
            const value = nameOfBind(linked, bind, chunk);
            if (value === null) continue;
            const key = isIdentName(name) ? name : JSON.stringify(name);
            // An ESM namespace exposes LIVE bindings: `ns.v` must re-read the local, so an
            // `export let v` reassigned after the namespace is built is visible through it. A flat
            // `v: v` snapshots the initial value and silently miscompiles (`ns.bump(); ns.v` read 1
            // where the spec says 2).
            //
            // But a getter is only needed when the local CAN be reassigned. A bundler knows that
            // statically, so pay for it only where it buys something: `const`/`function`/`class`
            // bindings are immutable, so a plain value is exactly equivalent and cheaper — which is
            // the overwhelming majority of exports. Only `let`/`var` (and anything we cannot
            // positively prove immutable) gets an accessor.
            //
            // Keyed off the symbol KIND, deliberately not off `semantic.refs[...].writes`: an
            // undercount there (stale refs after a lowering pass) would silently reintroduce the
            // exact miscompile above, whereas a symbol's declaration kind cannot go stale. The
            // trade is a getter for a never-reassigned `export let`, which is rare and harmless.
            entries.push(
                !forceAccessors && isImmutableBind(linked, bind)
                    ? `${key}${tight ? ':' : ': '}${value}`
                    : `get ${key}()${tight ? '{' : ' { '}return ${value};${tight ? '}' : ' }'}`,
            );
        }
    }
    const inner = entries.join(clauseSep(tight));
    // `Symbol.toStringTag` is defined SEPARATELY rather than as a literal member, so it is
    // non-enumerable like the spec's. As a literal it was enumerable and got copied by `{...ns}`.
    //
    // No `Object.freeze`. It was here on a spec argument — namespace exotic objects are
    // non-extensible with non-configurable properties — but NEITHER ORACLE freezes: rolldown's
    // runtime contains no `freeze`/`seal`/`preventExtensions` at all, and esbuild's `__freeze` is
    // used only by `__template`, where the spec requires it. A bundler-synthesized namespace cannot
    // be a real namespace exotic object anyway, so both keep what is observable — live bindings and
    // the tag, which feature detection reads — and drop what only affects code that is already
    // assigning to a namespace member. Freezing also blocks the `__reExport` chain that
    // `export * from 'cjs'` (namespace mode 2) needs to extend the object.
    const tag = !symbols
        ? ''
        : `${tight ? '' : ' '}Object.defineProperty(${nsName},${tight ? '' : ' '}Symbol.toStringTag,${tight ? '' : ' '}{${tight ? '' : ' '}value:${tight ? '' : ' '}'Module'${tight ? '' : ' '}});`;
    const decl = preDeclared ? '' : 'const ';
    // MODE 2 (cjs.md §4.4) — the module `export *`s from CommonJS, so its surface is not knowable
    // here. The statically-known names become getter THUNKS handed to `__exportAll`, which is the
    // one place shakeup uses accessors for everything: the object has to stay extensible so
    // `__reExport` can copy the CommonJS members in at runtime, and a value snapshot taken now would
    // predate them. This does NOT touch the ordinary namespace above, which keeps plain values for
    // provably-immutable members.
    //
    // rolldown's `cjs_compat/reexport_commonjs` is the shape, verbatim:
    //     var foo_exports = /* @__PURE__ */ __exportAll({ bar: () => import_commonjs.bar, … });
    //     __reExport(foo_exports, /* @__PURE__ */ __toESM(require_commonjs()));
    // `__exportAll` stamps `Symbol.toStringTag` itself, so no separate `defineProperty` here.
    if (linked.dynamicExports.has(modIdx)) {
        const thunks: string[] = [];
        for (const [name, bind] of map ?? []) {
            if (nsMembers !== undefined && !nsMembers.has(name)) continue;
            const value = nameOfBind(linked, bind, chunk);
            if (value !== null) thunks.push(`${name}${tight ? ':' : ': '}()${tight ? '=>' : ' => '}${value}`);
        }
        const body = tight ? `{${thunks.join(',')}}` : `{ ${thunks.join(', ')} }`;
        // `__exportAll(all, no_symbols)` — the second argument SUPPRESSES the tag, so it is passed
        // only when `symbols` is off. Same shape and same polarity as rolldown's
        // (`module_finalizers/mod.rs:993`), whose runtime this one was ported from.
        const noSymbols = symbols ? '' : `,${tight ? '' : ' '}1`;
        const lines = [`${decl}${nsName} = /* @__PURE__ */ __exportAll(${thunks.length === 0 ? '{}' : body}${noSymbols});`];
        for (const recIdx of graph.modules[modIdx].starExports) {
            const rec = graph.modules[modIdx].importRecords[recIdx];
            if (rec.external || rec.resolved < 0) continue;
            const wrapRef = linked.cjsWrap.get(rec.resolved);
            if (wrapRef !== undefined) {
                const wrapper = chunk.importLocalOf.get(wrapRef) ?? finalNameOf(linked, wrapRef);
                lines.push(`__reExport(${nsName},${tight ? '' : ' '}/* @__PURE__ */ __toESM(${wrapper}()));`);
            } else if (linked.dynamicExports.has(rec.resolved)) {
                // Chained: the star source is itself a mode-2 re-exporter, so copy from ITS object.
                const inner = nameOfBind(linked, { kind: 'namespace', module: rec.resolved }, chunk);
                if (inner !== null) lines.push(`__reExport(${nsName},${tight ? '' : ' '}${inner});`);
            }
        }
        return lines.join('\n');
    }
    // `__proto__: null` — a real ES module namespace is an exotic object with a NULL prototype, and
    // that is observable: `Object.getPrototypeOf(ns)`, and `deepStrictEqual` against
    // `{ __proto__: null, ... }`, both see it. ALL THREE oracles emit it — rollup
    // (`Object.freeze({ __proto__: null, ... })`), rolldown, and esbuild — so this was a shakeup-only
    // divergence, not a choice between them.
    //
    // Freezing is a SEPARATE question and stays as it was: rollup freezes, rolldown and esbuild do
    // not, and the comment above records why we follow the latter two.
    const proto = tight ? '__proto__:null' : '__proto__: null';
    const members = inner === '' ? proto : `${proto}${clauseSep(tight)}${inner}`;
    return tight ? `${decl}${nsName}={${members}};${tag}` : `${decl}${nsName} = { ${members} };${tag}`;
}

/** Render every module of one chunk to text, in that chunk's perspective.
 *
 *  This is where the collect-then-print pairing lives, and it CANNOT be lifted out the way rolldown
 *  lifts `finalize_modules` into a bundle-wide pass before rendering. rolldown can because it MUTATES
 *  the AST; shakeup builds `Map<Node, string>` overrides that `printModule` consumes and discards, so
 *  collection and printing are one unit. That is deliberate — the module AST is reused across builds
 *  through `options.cache`, and mutating it during render would poison the next build. */
export function renderModules(ctx: RenderCtx, reuse: ModuleReuse | null): RenderedModules {
    const { graph, linked, chunk, chunkGraph, shaken, interopOwners, warnings } = ctx;
    const { naming, wantMap, tight, deferMinify, pathToChunk } = ctx;
    const entryStarSpecs: string[] = [];
    const sideEffectSpecs = new Set<string>();
    /** The chunk's module region, as parts. ONE list, not a `string[]` beside a `Part[]` — see the
     *  assembly at the end of this function for why that pairing is a defect generator. */
    const moduleParts: Part[] = [];
    const mapSources: string[] = [];
    const mapSourcesContent: string[] = [];
    const chunkKey = chunk.modules.map((i) => graph.modules[i].id).join('\x1f');

    for (const idx of chunk.modules) {
        const mod = graph.modules[idx];

        // Per-module reuse: a clean module (not re-parsed, unchanged liveness, same chunk
        // perspective) renders identical bytes when no final name shifted (`namesStable`). This
        // is what makes a single-chunk edit cheap — only the touched module re-renders.
        if (reuse !== null) {
            const entry = reuse.cache.get(mod.id);
            const mapOk =
                !wantMap ||
                entry === undefined ||
                entry.text === '' ||
                (entry.mapPart !== null && entry.srcIdx === mapSources.length);
            if (
                reuse.namesStable &&
                entry !== undefined &&
                !reuse.changed.has(mod.id) &&
                entry.liveHash === reuse.liveHash[idx] &&
                entry.chunkKey === chunkKey &&
                mapOk
            ) {
                reuse.stats.moduleReused++;
                if (entry.text !== '') {
                    if (wantMap) {
                        mapSources.push(mod.id);
                        mapSourcesContent.push(mod.source);
                        moduleParts.push(entry.mapPart!);
                        if (entry.nsCode !== null) moduleParts.push({ code: entry.nsCode });
                    } else moduleParts.push({ code: entry.text });
                }
                continue;
            }
        }
        const live = shaken === null ? null : shaken.live[idx];
        // Index this module will occupy in `mapSources` if it emits anything.
        const srcIdx = mapSources.length;
        let out: string;
        let mapPart: Part | null = null;
        // Set only for a module needing the declaration/initializer split — see §7.25.
        let splitRender: ReturnType<typeof lazySplit> | null = null;
        let splitMapParts: Part[] | null = null;
        // Hoisted out of the printer block below so the `__esm` wrappers further down can render AST
        // rather than splice text. Assigned exactly once, immediately.
        let renderStmts: ((body: Node[], liveOverride?: Set<number> | null) => { code: string; map: Mappings | null }) | null =
            null;
        // Printer backend (minify and non-minify): generate every token from the AST, in link mode
        // (drop imports, unwrap exports, shake dead statements, apply renames + node rewrites).
        // `minify` only toggles whitespace/syntactic form — the link-mode rewrites are identical.
        {
            // Named `emit`, not `ctx`: the enclosing function's parameter is the per-CHUNK
            // `RenderCtx`, and the two share six field names. A shadow here would resolve silently.
            const emit: EmitCtx = {
                linked,
                mod,
                warnings,
                live,
                chunk,
                chunkGraph,
                pathToChunk,
                interopOwners,
                elidableNs: ctx.elidedNs,
            };
            trackChunkSpecs(emit, mod.isEntry, entryStarSpecs, sideEffectSpecs);
            const overrides = collectLinkOverrides(emit);
            const initCalls = collectInitCalls(emit);
            collectRequireOverrides(emit, overrides);
            const renameCache: (string | null | undefined)[] = [];
            // A FACTORY, not a single printer: a module that needs the declaration/initializer split
            // (cjs.md §7.25) is printed as two regions — hoisted bindings and function declarations
            // at top level, then the initializers inside the `__esm` closure — and each region needs
            // its own printer. Everything else makes exactly one.
            const makePrinter = (liveOverride: typeof live = live) =>
                createPrinter(
                    { minify: deferMinify ? false : naming.minify },
                    {
                        // Memoised per SYMBOL, not per occurrence. `renameOf` does two Map lookups
                        // (`namedImports`, then `finalNames` under a packed key), and a symbol is emitted
                        // many times — ~94k references over ~7.3k symbols on crashcat, so roughly 13
                        // identical lookups per symbol. Symbol ids are dense, so an array indexed by id
                        // collapses that to one. Correct per printer because the answer depends on
                        // `emit.chunk`, and a printer is created per module PER CHUNK render.
                        nameOf: (idNode: Node) => {
                            const sym = idNode.sym;
                            if (sym === 0) return idNode.name; // unresolved: the name varies per node
                            const hit = renameCache[sym];
                            if (hit !== undefined) return hit ?? idNode.name;
                            const v = renameOf(emit, idNode) ?? null;
                            renameCache[sym] = v;
                            return v ?? idNode.name;
                        },
                        linkModule: true,
                        defaultName: () => {
                            const ref = linked.defaultRefs.get(mod.idx);
                            return ref !== undefined ? (finalNameOf(linked, ref) ?? `${mod.idx}_default`) : `${mod.idx}_default`;
                        },
                        live: liveOverride,
                        overrides,
                        initCalls,
                        srcLines: wantMap ? Uint32Array.from(buildLineTable(mod.source)) : undefined,
                        // Per MODULE: a comment's offsets index this module's own source, and a chunk
                        // concatenates many, so the join cannot be hoisted to the chunk.
                        comments: mod.comments,
                        src: mod.source,
                        commentOpts: effectiveComments(naming.comments, deferMinify ? false : naming.minify),
                        sourceIdx: srcIdx,
                    },
                );
            const renderBody = (body: Node[], liveOverride: typeof live = live): { code: string; map: Mappings | null } => {
                const pr = makePrinter(liveOverride);
                const prog =
                    body === (mod.program.data as { body: Node[] }).body
                        ? mod.program
                        : ({ ...mod.program, data: { ...(mod.program.data as object), body } } as Node);
                printModule(pr, prog);
                if (!wantMap) return { code: finishPrinter(pr).trim(), map: null };
                const code = trimMappings(finishPrinter(pr), pr.map!);
                return { code, map: pr.map! };
            };
            renderStmts = renderBody;
            const whole = renderBody((mod.program.data as { body: Node[] }).body);
            out = whole.code;
            if (wantMap) mapPart = { code: out, map: whole.map! };
            if (linked.esmInitSplit.has(idx)) {
                const dref = linked.defaultRefs.get(idx);
                // Split the LIVE statements only, then render with shaking OFF. The statements the
                // split synthesizes (`var a, b;`, `a = 1`) are new nodes with fresh ids, so a `live`
                // set built from the original program would drop every one of them — which is
                // exactly what happened: the hoisted bindings and all the initializers vanished.
                const all = (mod.program.data as { body: Node[] }).body;
                const liveBody = live === null ? all : all.filter((st) => live.has(st.id));
                splitRender = lazySplit(liveBody, dref === undefined ? undefined : (finalNameOf(linked, dref) ?? undefined));
            }
            // A wrapped CommonJS module becomes a closure instead of top-level statements. Params are
            // MINIMAL — bound only when the body references them. `/* @__PURE__ */` lets an unused
            // wrapper be dropped entirely.
            const wrapRef = linked.cjsWrap.get(idx);
            if (wrapRef !== undefined) {
                const wrapName = finalNameOf(linked, wrapRef);
                // rolldown's rule exactly (`ast_factory.rs:759-786`): push `exports` when the module
                // references EITHER binding (`ModuleOrExports`), push `module` only when it references
                // `module` (`ModuleRef`). A module touching neither gets NO parameter list. We used to
                // emit `exports` unconditionally — the comment above claimed to be following rolldown and
                // described behaviour it does not have.
                const uses = new Set(mod.semantic.unresolved.map((n) => n.name));
                // Top-level `this` counts as referencing `exports`: in CommonJS `this === module.exports`,
                // and `bundle.ts:323` rewrites every top-level `this` to `exports` — so a module that only
                // ever says `this` still needs the parameter bound. rolldown folds the same case into
                // `ModuleOrExports`. Missing it emitted a closure with no `exports` param whose body
                // referenced `exports`, which the CJS `this` tests caught immediately.
                const usesModule = uses.has('module');
                const usesExports = uses.has('exports') || mod.topLevelThis.length > 0;
                const params = usesModule ? ['exports', 'module'] : usesExports ? ['exports'] : [];
                // AST, NOT a text splice. rolldown builds this with `new_commonjs_wrapper_stmt`
                // (`ast_factory.rs:741`), moving `program.body` into the closure — there is no text stage
                // in its pipeline. Building it here means the mappings fall out of printing instead of
                // being patched up afterwards to account for the added header line and indent, which
                // is what used to desynchronize the whole chunk's map when it was missed.
                //
                // The body is materialised (statements + declarators filtered by `live`) BEFORE wrapping
                // and then rendered with shaking off: `live` is keyed by TOP-LEVEL node id, and a closure
                // body is not top level.
                const wrapped: Node[] = [
                    wrapModuleBody({
                        name: wrapName,
                        helper: '__commonJS',
                        params,
                        body: materialiseLiveBody((mod.program.data as { body: Node[] }).body, live),
                        pure: true,
                    }),
                ];
                for (const [map, nodeMode] of [
                    [linked.cjsNamespace, false],
                    [linked.cjsNamespaceNode, true],
                ] as const) {
                    const nsRef = map.get(idx);
                    if (nsRef === undefined) continue;
                    // UNLESS AN IMPORT STATEMENT OWNS IT. `import b from './b.cjs'` evaluates the
                    // module at that statement, so when one exists the decl is emitted there instead
                    // (`collectInitCalls`) and putting a second one here would both redeclare the
                    // binding and run the wrapper early. Only a module reached solely through
                    // `require()` — which sequences its own init — still declares it beside the
                    // wrapper, which is where it has always been.
                    if (interopOwners.has(nsRef)) continue;
                    wrapped.push(interopNamespace(finalNameOf(linked, nsRef), wrapName, nodeMode));
                }
                const rendered = renderBody(wrapped, null);
                out = rendered.code;
                if (wantMap) mapPart = { code: out, map: rendered.map! };
                // The interop namespace is materialized ONCE per (module, isNodeMode), right after its
                // wrapper, and every consumer reads members off it (`nameOfBind`'s `cjs-member`).
                //
                // The second argument is rolldown's `isNodeMode` (D4): an importer that is ESM BY FILE
                // FORMAT gets `__toESM(require_d(), 1)`, which skips the `__esModule` check entirely and
                // hands back the whole `module.exports` as `default` — what Node actually does. A module
                // imported both ways gets both objects; they are genuinely different values.
            }
        }
        const lazyRef = linked.esmInit.get(idx);
        let nsCode: string | null = null;
        if (linked.namespaceOf.has(idx) && !chunk.nsNative?.has(idx) && !ctx.elidedNs.has(idx)) {
            // `preDeclared` only for the UNSPLIT lazy form, where the binding is hoisted above the
            // closure and assigned inside it. A split module keeps its namespace at top level.
            nsCode = renderNamespaceObject(
                graph,
                linked,
                idx,
                chunk,
                shaken?.nsUsage.get(idx),
                tight,
                ctx.symbols,
                lazyRef !== undefined && !linked.esmInitSplit.has(idx),
                linked.esmInitSplit.has(idx),
            );
            out += `\n${nsCode}`;
        }
        // LAZY INIT — an ESM module reached only through `require()` (§7.20/D1). Its whole body,
        // initializers move inside an `__esm` closure so they evaluate at the require CALL, while the
        // declarations stay at top level — rolldown's single wrapped-ESM shape
        // (`module_finalizers/impl_visit_mut.rs:283-331`), which it builds unconditionally.
        //
        // The namespace object stays OUTSIDE and is built from those hoisted bindings, so it must
        // use accessors — a value snapshot taken here would capture `undefined`, since nothing has
        // been assigned until `init` runs.
        if (lazyRef !== undefined && out !== '') {
            const initName = finalNameOf(linked, lazyRef);
            if (splitRender !== null) {
                //
                // AST, not a text splice — same reason as the CommonJS wrapper above. `lazySplit`
                // already hands back STATEMENT ARRAYS, so the hoisted bindings, the kept function
                // declarations and the closure render as one body and the mappings fall out of
                // printing instead of needing the mappings shoved down and right afterwards.
                const headAndClosure = renderStmts!(
                    [
                        ...splitRender.hoisted,
                        ...splitRender.functions,
                        wrapModuleBody({ name: initName, helper: '__esm', params: [], body: splitRender.body, pure: true }),
                    ],
                    null,
                );
                // `nsCode` was appended to `out` before this block; replacing `out` wholesale dropped
                // it and left `e_ns is not defined`. Re-append it AFTER the closure — the namespace
                // reads hoisted bindings, so it may be built at top level, and it must be, because a
                // consumer names it outside.
                // NO eager `init()` call at the module's own slot. `link.ts` sets `esmInitSplit`
                // only for require-ONLY targets, and the whole point of the lazy form is that such
                // a module runs at the require CALL and not before — an eager call here re-broke
                // all six laziness tests (never-reached require, ordering, sticky throw). The
                // mixed case, which DOES need a call because a static importer reads the bindings,
                // still takes the eager path in `link.ts` and never reaches here.
                out = `${headAndClosure.code}${nsCode === null ? '' : `\n${nsCode}`}`;
                if (mapPart !== null) {
                    // One part per emitted region: `joinParts` derives each span from its own `code`,
                    // so they stay aligned. The namespace object is still emitter TEXT and keeps its
                    // own (unmapped) part, as it always did.
                    splitMapParts = [
                        { code: headAndClosure.code, map: headAndClosure.map ?? undefined },
                        ...(nsCode === null ? [] : [{ code: nsCode }]),
                    ];
                    mapPart = null;
                    nsCode = null; // already inside `out`, and covered by the parts above
                }
            }
        }
        if (out !== '') {
            if (wantMap) {
                mapSources.push(mod.id);
                mapSourcesContent.push(mod.source);
                // Finer-grained than `out` on purpose: the namespace object and the split module's
                // two regions are separate parts so `joinParts` can give each its own line span.
                // Their codes still concatenate back to exactly `out`.
                if (splitMapParts !== null) moduleParts.push(...splitMapParts);
                else moduleParts.push(mapPart!);
                if (nsCode !== null) moduleParts.push({ code: nsCode });
            } else moduleParts.push({ code: out });
        }
        // Cache the render for reuse — unless it carries a per-build hash placeholder (its bytes
        // are not counter-stable, so it must re-render every build).
        if (reuse !== null) {
            if (out.includes('!~{')) reuse.cache.delete(mod.id);
            else
                reuse.cache.set(mod.id, {
                    liveHash: reuse.liveHash[idx],
                    chunkKey,
                    text: out,
                    mapPart,
                    srcIdx,
                    nsCode,
                });
            reuse.stats.moduleRendered++;
        }
    }

    return { parts: moduleParts, mapSources, mapSourcesContent, entryStarSpecs, sideEffectSpecs };
}
