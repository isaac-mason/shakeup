import type { Graph, ImportBind, Linked, Module } from './graph-types';
import { NAME_DEFAULT, NAME_NAMESPACE, packRef, refMod, refSym } from './graph-types';

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
    for (const node of mod.semantic.unresolved) if (node.name === 'module' || node.name === 'exports') return true;
    return false;
}

/** Bind an import of a WRAPPED CommonJS module. Its exports are built imperatively at runtime, so
 *  nothing can bind to a symbol — every name becomes a member read off the interop namespace. */
function cjsBind(ctx: LinkCtx, target: Module, name: string): ImportBind {
    if (!ctx.linked.cjsNamespace.has(target.idx)) {
        ctx.linked.cjsNamespace.set(target.idx, `import_${reprName(target)}`);
    }
    return { kind: 'cjs-member', module: target.idx, name };
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
        if (wantsCjsWrap(mod)) linked.cjsWrap.set(idx, `require_${reprName(mod)}`);
    }
    // A `require()`d module must ALSO be wrapped, whatever its own source looks like: `require` is a
    // call that returns an exports object, so the target needs a callable, once-only, memoized form.
    // rolldown's `determine_module_exports_kind` reaches this through `ImportKind::Require`
    // (`Esm -> WrapKind::Esm`, `CommonJs`/`None -> WrapKind::Cjs`); with an ESM-only emit the CJS
    // wrapper serves both, since an ESM module's bindings are already hoisted into the closure.
    for (const idx of linked.order) {
        for (const rec of graph.modules[idx].importRecords) {
            if (rec.kind !== 'require' || rec.external || rec.resolved < 0) continue;
            if (!linked.cjsWrap.has(rec.resolved)) {
                linked.cjsWrap.set(rec.resolved, `require_${reprName(graph.modules[rec.resolved])}`);
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
                bind = cjsBind(ctx, graph.modules[rec.resolved], imp.name);
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
