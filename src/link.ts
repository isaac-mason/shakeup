import { isPureStatement } from './analysis/effects';
import type { Graph, ImportBind, Linked, Module } from './graph-types';
import { NAME_DEFAULT, NAME_NAMESPACE, isEsmFormat, packRef, refMod, refSym } from './graph-types';

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
            // A one-statement re-export FROM a wrapped CommonJS module — `export { v } from './d.cjs'`
            // (and `export * as ns from`). Recursing would look for a named export the CJS module
            // does not have (its surface is built at runtime), and report the re-EXPORTER as missing
            // the name — a misleading error for a very common barrel shape.
            if (ctx.linked.cjsWrap.has(rec.resolved)) return cjsBind(ctx, target, exp.sourceName, module);
            if (exp.sourceName === NAME_NAMESPACE) return namespaceBind(ctx, target);
            return matchImport(ctx, target, exp.sourceName, seen);
        }
        if (exp.symbol !== 0) {
            // The exported local may itself be an import binding — the two-statement re-export
            // `import { x } from './a'; export { x }` (and its `import * as ns` / default forms).
            // Follow it to the source, exactly as the `exp.rec >= 0` branch above does for the
            // one-statement `export { x } from './a'`. Binding to the importing module's own
            // symbol instead would name a local that has no declaration in the output AND leave
            // the source export unrooted — a dangling `export { x }` next to a dropped module.
            // EXTERNAL imports are deliberately NOT followed: unlike the one-statement form, a
            // two-statement re-export has a real local symbol for the external binding, and that
            // symbol is what carries liveness — `pruneUnusedExternals` keeps an external import
            // only when its ref appears in `liveRefs`. Returning a ref-less `external` bind here
            // would prune the `import … from 'ext'` line out from under a live re-export.
            const imported = module.namedImports.get(exp.symbol);
            if (imported !== undefined && !module.importRecords[imported.rec].external) {
                const target = graph.modules[module.importRecords[imported.rec].resolved];
                if (imported.name === NAME_NAMESPACE) return namespaceBind(ctx, target);
                return matchImport(ctx, target, imported.name, seen);
            }
            return { kind: 'found', ref: packRef(module.idx, exp.symbol) };
        }
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
        // A CommonJS star source can never answer statically — its export surface is built at
        // runtime — so it is the LAST resort, tried only when no ESM star source provides the name.
        // esbuild does the same thing in the same order: a name that reaches a file with dynamic
        // export fallback is "rewrite[n] the import to a property access" (`linker.go:2704-2718`,
        // `importDynamicFallback` → `matchImportNamespace`), and a static match wins over it
        // (`matchImportNormalAndNamespace` keeps the normal binding).
        let cjsFallback: ImportBind | null = null;
        for (const recIdx of module.starExports) {
            const rec = module.importRecords[recIdx];
            if (rec.external) continue;
            if (ctx.linked.cjsWrap.has(rec.resolved)) {
                cjsFallback ??= cjsBind(ctx, graph.modules[rec.resolved], name, module);
                continue;
            }
            const candidate = matchImport(ctx, graph.modules[rec.resolved], name, new Set(seen));
            if (candidate.kind === 'none') continue;
            if (found === null) found = candidate;
            else if (!sameBind(found, candidate)) {
                ctx.linked.errors.push(`ambiguous export '${name}' from '${module.id}' (multiple star re-exports provide it)`);
                return { kind: 'none' };
            }
        }
        if (found !== null) return found;
        if (cjsFallback !== null) return cjsFallback;
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

/** Should this module be lowered to a `__commonJS` wrapper? rolldown's `WrapKind::Cjs`, restricted
 *  to the case that matters for an ESM-only emit: a module whose SOURCE is CommonJS
 *  (`exportsKind === 'commonjs'`) and which actually uses a CommonJS feature — so a `.cjs` file that
 *  merely runs side effects still concatenates as plain statements rather than paying for a closure.
 *
 *  rolldown reaches the same conclusion through `determine_module_exports_kind`'s final per-importer
 *  rule: for an ESM output format every CommonJs module is wrapped. */
function wantsCjsWrap(mod: Module): boolean {
    if (mod.exportsKind !== 'commonjs') return false;
    if (mod.hasTopLevelReturn) return true;
    // Top-level `this` IS a CommonJS export mechanism: the body is called with `module.exports` as
    // its receiver, so `this.v = 1` is an export. Without wrapping there is no `exports` object for
    // it to mean, and the UMD probe `typeof this === "object"` silently takes the wrong branch.
    if (mod.topLevelThis.length > 0) return true;
    for (const node of mod.semantic.unresolved) if (node.name === 'module' || node.name === 'exports') return true;
    return false;
}

/** Bind an import of a WRAPPED CommonJS module. Its exports are built imperatively at runtime, so
 *  nothing can bind to a symbol — every name becomes a member read off the interop namespace. */
function cjsBind(ctx: LinkCtx, target: Module, name: string, importer: Module): ImportBind {
    return { kind: 'cjs-member', ref: cjsNamespaceRef(ctx, target, isEsmFormat(importer.defFormat)), name };
}

/** The synthetic symbol holding a wrapped module's interop namespace (`var import_foo = …`).
 *  A real ref so it is deconflicted, tree-shaken and WIRED ACROSS CHUNKS like any other symbol. */
function cjsNamespaceRef(ctx: LinkCtx, target: Module, nodeMode: boolean): number {
    const map = nodeMode ? ctx.linked.cjsNamespaceNode : ctx.linked.cjsNamespace;
    const existing = map.get(target.idx);
    if (existing !== undefined) return existing;
    const ref = syntheticRef(ctx, target.idx, nodeMode ? `import_${reprName(target)}_node` : `import_${reprName(target)}`);
    map.set(target.idx, ref);
    return ref;
}

/** Is this module reached by any STATIC import (as opposed to only `require`/`import()`)? A static
 *  importer needs the module's bindings hoisted at top level, which rules out putting the whole body
 *  inside a lazy-init closure. */
function isStaticallyImported(graph: Graph, idx: number): boolean {
    for (const mod of graph.modules) {
        for (const rec of mod.importRecords) {
            if (rec.resolved === idx && rec.kind === 'static' && !rec.external) return true;
        }
    }
    return false;
}

/** The synthetic symbol holding a lazily-initialised ESM module's init function
 *  (`var init_foo = __esm(() => {…})`). */
function cjsInitRef(ctx: LinkCtx, target: Module): number {
    const existing = ctx.linked.esmInit.get(target.idx);
    if (existing !== undefined) return existing;
    return syntheticRef(ctx, target.idx, `init_${reprName(target)}`);
}

/** The synthetic symbol holding a module's CommonJS wrapper (`var require_foo = __commonJS(…)`). */
function cjsWrapRef(ctx: LinkCtx, target: Module): number {
    const existing = ctx.linked.cjsWrap.get(target.idx);
    if (existing !== undefined) return existing;
    const ref = syntheticRef(ctx, target.idx, `require_${reprName(target)}`);
    ctx.linked.cjsWrap.set(target.idx, ref);
    return ref;
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
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
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
            if (!rec.external && rec.kind !== 'dynamic' && rec.resolved >= 0) visit(rec.resolved);
        }
        state[idx] = 2;
        order.push(idx);
    };
    for (const { module } of graph.entries) visit(module);
    // A module reachable ONLY through import() would otherwise be dropped from `order`. Seed the
    // DFS from every dynamic target AFTER all static-entry roots so their relative sync-order is
    // preserved.
    for (const mod of graph.modules) {
        for (const rec of mod.importRecords) {
            if (rec.kind === 'dynamic' && !rec.external && rec.resolved >= 0) visit(rec.resolved);
        }
    }
    return order;
}

/** LINK stage (rolldown `link_stage`): bind imports/exports across `graph` + order modules into a
 *  {@link Linked}. **Metadata only — no AST mutation, no naming.** Deconfliction (a generate-stage
 *  concern) runs per-chunk in buildChunkGraph; single-scope callers run {@link deconflictWholeBundle}. */
export function linkGraph(graph: Graph): Linked {
    const linked: Linked = {
        graph,
        order: sortModules(graph),
        binds: new Map(),
        finalNames: new Map(),
        namespaceOf: new Map(),
        exportMaps: new Map(),
        syntheticNames: new Map(),
        cjsWrap: new Map(),
        cjsNamespace: new Map(),
        cjsNamespaceNode: new Map(),
        esmInit: new Map(),
        dynamicExports: new Set(),
        externalLocals: new Map(),
        defaultRefs: new Map(),
        errors: [],
    };
    const ctx: LinkCtx = {
        graph,
        linked,
        nextSynthetic: graph.modules.map((m) => m.semantic.symbols.length),
    };

    // Wrap decisions first: `matchImport` routes an import of a wrapped module to a runtime member
    // read, so the decision has to exist before any bind is resolved (rolldown likewise settles
    // `wrap_kind` in the link stage, ahead of `bind_imports_and_exports`).
    for (const idx of linked.order) {
        const mod = graph.modules[idx];
        if (wantsCjsWrap(mod)) cjsWrapRef(ctx, mod);
    }
    // A `require()`d module must ALSO be wrapped, whatever its own source looks like: `require` is a
    // call that returns an exports object, so the target needs a callable, once-only, memoized form.
    // rolldown's `determine_module_exports_kind` reaches this through `ImportKind::Require`
    // (`Esm -> WrapKind::Esm`, `CommonJs`/`None -> WrapKind::Cjs`); with an ESM-only emit the CJS
    // wrapper serves both, since an ESM module's bindings are already hoisted into the closure.
    const warnedEagerEsm = new Set<number>();
    // LINK-STAGE KIND PROMOTION, then wrapping — rolldown's `determine_module_exports_kind`
    // (`:36-96` **[V]**). A module with `ExportsKind::None` (no ESM syntax, no CommonJS feature use)
    // is genuinely undecided after scanning; how it is IMPORTED settles it:
    //   · `import`ed  → promote to Esm
    //   · `require`d  → promote to CommonJs, and wrap
    //
    // Without the require-side promotion an exports-less script reached `__toCommonJS(ns)`, so
    // `require('./e.js')` produced `{ __esModule: true }` where Node gives a bare `{}` — and that
    // marker flips a consumer's default-interop to the `.default` branch, yielding `undefined`.
    //
    // Iterated in `linked.order` so an earlier importer's promotion is visible to a later one, which
    // is the ordering rolldown's own comment calls out as load-bearing.
    for (const idx of linked.order) {
        for (const rec of graph.modules[idx].importRecords) {
            if (rec.external || rec.resolved < 0) continue;
            const target = graph.modules[rec.resolved];
            if (target.exportsKind !== 'none') continue;
            target.exportsKind = rec.kind === 'require' ? 'commonjs' : 'esm';
        }
    }

    for (const idx of linked.order) {
        for (const rec of graph.modules[idx].importRecords) {
            if (rec.kind !== 'require' || rec.external || rec.resolved < 0) continue;
            const target = graph.modules[rec.resolved];
            if (target.exportsKind === 'commonjs') {
                // CJS requiring CJS: the wrapper's return value IS the exports object.
                cjsWrapRef(ctx, target);
                continue;
            }
            // CJS requiring ESM. Do NOT give it a CommonJS wrapper — an ES module has no `exports`
            // object to populate, so wrapping it produced an empty one and the require silently
            // yielded `{}`. It needs its ESM namespace instead, converted at the call site by
            // `__toCommonJS` (which stamps the `__esModule` marker the requiring code checks for).
            //
            if (!linked.namespaceOf.has(rec.resolved)) linked.namespaceOf.set(rec.resolved, `${reprName(target)}_ns`);
            // LAZY INIT when nothing else needs the module's bindings hoisted. `require()` must
            // evaluate its target AT THE CALL — eagerly running it changes when side effects happen
            // and runs a module whose require is never reached (§7.20).
            //
            // rolldown always builds the lazy form, splitting declarations from initializers so the
            // namespace getters can close over bare `var`s (`misc/wrapped_esm`). That split is only
            // NEEDED when something else — a static `import` — also wants those bindings at top
            // level. When the target is reached ONLY through `require`, the whole body can go inside
            // the closure untouched and the namespace can be assigned from within it, which is the
            // same semantics with no rewriting. The split remains outstanding for the mixed case,
            // which is why the warning below still fires there.
            if (!isStaticallyImported(graph, rec.resolved)) linked.esmInit.set(rec.resolved, cjsInitRef(ctx, target));
            else if (!warnedEagerEsm.has(rec.resolved) && target.program.data.body.some((st) => !isPureStatement(st))) {
                warnedEagerEsm.add(rec.resolved);
                graph.warnings.push(
                    `${graph.modules[idx].id}: require('${rec.specifier}') targets an ES module that is ALSO statically ` +
                        'imported, so its bindings must stay hoisted and it cannot go inside a lazy-init closure — it is ' +
                        'evaluated eagerly with the rest of the bundle rather than at the require() call, so its side ' +
                        'effects may run earlier than Node would run them, or run even if the require is never reached.',
                );
            }
        }
    }

    // `export * from './x.cjs'` — namespace-construction MODE 2 of cjs.md §4.4. A CommonJS module's
    // export surface is only known at runtime, so a re-exporter cannot enumerate it: its namespace
    // becomes an `__exportAll` object of getter thunks for the names it DOES know, extended at
    // runtime by `__reExport` with the CommonJS members. A NAMED import through such a star is
    // answered separately, by `matchImport`'s CommonJS fallback.
    //
    // ~~Reported as unsupported.~~ It was, with a message suggesting `export { a, b } from …`
    // instead. Now built.
    //
    // Propagated to a FIXED POINT: `export * from './c.js'` where c itself stars from CommonJS makes
    // the outer module dynamic too, and its `__reExport` chains to c's namespace rather than to the
    // CommonJS module. rolldown's `cjs_compat/exoprt_star_of_cjs` is exactly that chain:
    //     var b_exports = __exportAll({}); __reExport(b_exports, __toESM(require_c()));
    //     var a_exports = __exportAll({}); __reExport(a_exports, b_exports);
    // Without the propagation the outer namespace was a plain literal built from a static export map
    // that could not see the CommonJS names, and every member read `undefined`.
    for (let changed = true; changed; ) {
        changed = false;
        for (const idx of linked.order) {
            const mod = graph.modules[idx];
            if (linked.dynamicExports.has(idx)) continue;
            for (const recIdx of mod.starExports) {
                const rec = mod.importRecords[recIdx];
                if (rec.external || rec.resolved < 0) continue;
                if (linked.cjsWrap.has(rec.resolved)) {
                    // The re-exporter's namespace reads the CommonJS module's interop namespace, so
                    // mint it here rather than leaving it to a consumer that may never appear.
                    cjsBind(ctx, graph.modules[rec.resolved], NAME_NAMESPACE, mod);
                } else if (linked.dynamicExports.has(rec.resolved)) {
                    namespaceBind(ctx, graph.modules[rec.resolved]);
                } else continue;
                linked.dynamicExports.add(idx);
                changed = true;
                break;
            }
        }
    }

    for (const idx of linked.order) {
        const mod = graph.modules[idx];
        for (const [localSym, imp] of mod.namedImports) {
            const rec = mod.importRecords[imp.rec];
            let bind: ImportBind;
            if (rec.external) {
                bind = { kind: 'external', specifier: rec.specifier, name: imp.name };
            } else if (ctx.linked.cjsWrap.has(rec.resolved)) {
                // A wrapped CommonJS target: `import * as ns` gets the whole interop namespace,
                // every other form a member read off it. `default` included — `__toESM` synthesizes
                // it from `module.exports` when the module carries no `__esModule` marker.
                bind = cjsBind(ctx, graph.modules[rec.resolved], imp.name, mod);
            } else if (imp.name === NAME_NAMESPACE) {
                bind = namespaceBind(ctx, graph.modules[rec.resolved]);
            } else {
                bind = matchImport(ctx, graph.modules[rec.resolved], imp.name, new Set());
                // ~~Suppressed when the target had a reported `export * from <cjs>`.~~ No longer
                // needed: that forwarding is built, so such a name comes back as a CommonJS member
                // read rather than `none`. `default` is the one exception and it SHOULD report —
                // `export *` never forwards `default`, in any bundler or in Node.
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

    for (const { module } of graph.entries) exportMapOf(ctx, graph.modules[module]);
    // Build export maps for dynamic-import targets too: treeshake seeds them as inclusion roots
    // and the emit rewrites an in-bundle `import('./x')` to `Promise.resolve(namespaceObject)`,
    // needing the surface. A target may be statically-dominated (its record is `kind:'static'`)
    // yet still have a literal `import()` — `hasDynamicLiteral` records that at parse time, so we
    // read it off the (cached) import records instead of re-walking every module's whole AST.
    for (const mod of graph.modules) {
        for (const rec of mod.importRecords) {
            if (rec.hasDynamicLiteral && !rec.external && rec.resolved >= 0) exportMapOf(ctx, graph.modules[rec.resolved]);
        }
    }

    // Namespace targets, LAST and to a fixed point. `namespaceOf` grows while export maps are
    // built: `export * as ns from './m'` is a named EXPORT, not a named import, so the loop over
    // `namedImports` above never sees it — `m` is registered only when the re-exporting module's
    // own map is constructed. Running this before those maps existed left `m`'s export map unbuilt,
    // which silently produced BOTH halves of the same bug: `expandNs` bailed on the missing map so
    // nothing in `m` was rooted, and `renderNamespaceObject` found no map so it emitted an empty
    // `Object.freeze({})`. Building one target's map can reveal further targets, hence the fixed
    // point; `exportMapOf` memoizes, so repeat calls are free and this terminates on module count.
    for (let seen = -1; seen !== linked.namespaceOf.size; ) {
        seen = linked.namespaceOf.size;
        for (const modIdx of [...linked.namespaceOf.keys()]) exportMapOf(ctx, graph.modules[modIdx]);
    }

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
