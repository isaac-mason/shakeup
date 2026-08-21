import { isPureStatement } from './analysis/effects';
import { analyzeDynamicUsage, analyzeNsUsage, type NsUsage } from './analysis/ns-usage';
import { walkRefIdents } from './analysis/refs';
import { scopeOf, symbolOf } from './analysis/semantic';
import { N, type Node } from './ast';
import { type Graph, type ImportBind, type Linked, type Module, NAME_NAMESPACE, packRef, refMod, refSym } from './module-graph';

export type TreeshakeResult = {
    live: Set<number>[];
    dropped: [number, Node][];
    /** Per-target narrowed namespace surface: module idx → the exact member names its
     *  `import * as ns` consumers read. A module absent here keeps its whole surface (it escapes,
     *  is an entry, is dynamically imported, or is re-exported as a namespace). Consumed by the
     *  emit so the namespace object lists only these members. */
    nsUsage: Map<number, Set<string>>;
    /** Dead pure dynamic-import targets: modules reached ONLY via `import()` whose result is never
     *  used and that have no side effects. Not rooted, not promoted to a chunk; their `import()`
     *  sites are rewritten to `Promise.resolve({})`. Consumed by chunk-graph and the emit. */
    deadDynamic: Set<number>;
    /** Every `packRef` referenced by a live statement (rolldown's `reference_needed_symbols`). An
     *  external import binding is needed iff its ref is here — lets us drop unused side-effect-free
     *  externals (e.g. the injected jsx runtime) via symbol liveness, not a JSX-specific AST walk. */
    liveRefs: Set<number>;
};

export type StatementInfo = {
    statement: Node;
    refs: number[];
    pure: boolean;
};

export type TreeshakeCache = {
    moduleIds: string[];
    infos: StatementInfo[][];
    decls: [number, [number, number]][][];
};

function collectRefs(mod: Module, linked: Linked, statement: Node, out: number[], declared: number[]): void {
    const moduleScope = scopeOf(mod.semantic, mod.program);
    const sem = mod.semantic;
    const pushSym = (sym: number): void => {
        if (sym === 0) return;
        if (mod.namedImports.has(sym)) {
            const bind = linked.binds.get(packRef(mod.idx, sym));
            if (bind === undefined) return;
            if (bind.kind === 'found') out.push(bind.ref);
            else if (bind.kind === 'namespace') out.push(packRef(bind.module, NS_MARKER));
            // An external ref roots no internal statement, but recording it lets `liveRefs` gate
            // external-import emission (drop an unused side-effect-free external).
            else if (bind.kind === 'external') out.push(packRef(mod.idx, sym));
            return;
        }
        if (sem.symbols[sym].scope === moduleScope) out.push(packRef(mod.idx, sym));
    };
    // One scan yields both `referenced_symbols` (uses → `out`) and `declared_symbols` (module-scope
    // bindings → `declared`), keyed by SymbolRef identity — the rolldown `StmtInfo` model. No spans:
    // this is robust to synthetic (lowered) nodes, which carry symbols but have no meaningful span.
    walkRefIdents(statement, (ident) => {
        const sym = symbolOf(sem, ident);
        pushSym(sym);
        if (ident.type === N.BindingIdentifier && sym !== 0 && sem.symbols[sym].scope === moduleScope) {
            declared.push(packRef(mod.idx, sym));
        }
    });
    // (JSX runtime refs are collected normally now — jsxLower lowers JSX to `jsx(...)` calls before
    // treeshake, so their callee IdentifierReferences are ordinary refs. No JSX-specific walk.)
}

function statementIsPure(mod: Module, statement: Node): boolean {
    if (statement.type === N.ImportDeclaration) {
        if (statement.data.specifiers.length > 0) return true;
        const source = statement.data.source;
        if (source.type !== N.StringLiteral) return true;
        const spec = mod.source.slice(source.start + 1, source.end - 1);
        const rec = mod.importRecords.find((r) => r.specifier === spec);
        return !(rec?.external ?? false);
    }
    return isPureStatement(statement);
}

/** pseudo-symbol id marking "the whole namespace of this module" */
const NS_MARKER = 0x1fffff;

/** Determine which namespace-import targets can have their materialized namespace object narrowed
 *  to the exact members read. A target is narrowable only if EVERY namespace bind to it is a
 *  non-escaping member read (static `import * as ns` OR dynamic `import()` result) — so any of
 *  these forces the whole surface instead: it's an entry, it's re-exported as a namespace
 *  (`export * as ns` — opaque downstream), or some consumer escapes. A dead target is dropped
 *  outright. Returns target idx → the union of member names read across all its consumers. */
function computeNsUsage(graph: Graph, dynUsage: Map<number, NsUsage>, deadDynamic: Set<number>): Map<number, Set<string>> {
    const forceWhole = new Set<number>();
    for (const { module } of graph.entries) forceWhole.add(module);
    // `export * as ns from './m'` re-exports m's whole namespace opaquely.
    for (const mod of graph.modules) {
        for (const exp of mod.namedExports.values()) {
            if (exp.sourceName !== NAME_NAMESPACE || exp.rec < 0) continue;
            const rec = mod.importRecords[exp.rec];
            if (!rec.external && rec.resolved >= 0) forceWhole.add(rec.resolved);
        }
    }

    // Accumulate member reads (and escape) per target across BOTH `import * as ns` consumers and
    // `import()` consumers — a module's namespace surface is the union of everything read of it.
    const acc = new Map<number, NsUsage>();
    const fold = (target: number, u: NsUsage): void => {
        let a = acc.get(target);
        if (a === undefined) {
            a = { escapes: false, members: new Set() };
            acc.set(target, a);
        }
        if (u.escapes) a.escapes = true;
        for (const m of u.members) a.members.add(m);
    };
    for (const mod of graph.modules) {
        const nsSyms = new Map<number, number>(); // local ns symbol → target module idx
        for (const [localSym, imp] of mod.namedImports) {
            if (imp.name !== NAME_NAMESPACE) continue;
            const rec = mod.importRecords[imp.rec];
            if (rec.external || rec.resolved < 0) continue;
            nsSyms.set(localSym, rec.resolved);
        }
        if (nsSyms.size === 0) continue;
        const usage = analyzeNsUsage(mod.program, mod.semantic, new Set(nsSyms.keys()));
        for (const [localSym, target] of nsSyms) fold(target, usage.get(localSym)!);
    }
    for (const [target, u] of dynUsage) fold(target, u);

    const narrowable = new Map<number, Set<string>>();
    for (const [target, a] of acc) {
        // Dead targets are dropped entirely (no namespace object); escaping / entry / re-exported
        // targets need their whole surface.
        if (a.escapes || forceWhole.has(target) || deadDynamic.has(target)) continue;
        narrowable.set(target, a.members);
    }
    return narrowable;
}

/** Aggregate how each dynamic-import target's resolved module is consumed, unioned across every
 *  `import()` site (in any module) that resolves to it. */
function computeDynamicUsage(graph: Graph): Map<number, { escapes: boolean; members: Set<string> }> {
    const acc = new Map<number, { escapes: boolean; members: Set<string> }>();
    for (const mod of graph.modules) {
        const sites = analyzeDynamicUsage(mod.program, mod.semantic, mod.source);
        for (const { specifier, usage } of sites) {
            const rec = mod.importRecords.find((r) => r.specifier === specifier);
            if (rec === undefined || rec.external || rec.resolved < 0) continue;
            let a = acc.get(rec.resolved);
            if (a === undefined) {
                a = { escapes: false, members: new Set() };
                acc.set(rec.resolved, a);
            }
            if (usage.escapes) a.escapes = true;
            for (const m of usage.members) a.members.add(m);
        }
    }
    return acc;
}

/** Dead pure dynamic imports: a target reached ONLY through `import()` (no static edge), never an
 *  entry, whose every `import()` result is discarded (usage is `none`), and which is declared
 *  side-effect-free — so loading it is observably a no-op and it can be dropped entirely. */
function computeDeadDynamic(graph: Graph, dynUsage: Map<number, { escapes: boolean; members: Set<string> }>): Set<number> {
    const entrySet = new Set(graph.entries.map((e) => e.module));
    const staticTargets = new Set<number>();
    for (const mod of graph.modules) {
        for (const rec of mod.importRecords) {
            if (rec.kind === 'static' && !rec.external && rec.resolved >= 0) staticTargets.add(rec.resolved);
        }
    }
    const dead = new Set<number>();
    for (const [target, usage] of dynUsage) {
        if (usage.escapes || usage.members.size > 0) continue; // result is used somewhere
        if (entrySet.has(target) || staticTargets.has(target)) continue; // reachable another way
        if (graph.modules[target].sideEffects !== false) continue; // loading it may be observable
        dead.add(target);
    }
    return dead;
}

/** Compute statement-level liveness over the linked graph, rooted at the entry's exports and every effectful statement. */
export function treeshake(graph: Graph, linked: Linked, cache?: TreeshakeCache): TreeshakeResult {
    const dynUsage = computeDynamicUsage(graph);
    const deadDynamic = computeDeadDynamic(graph, dynUsage);
    const nsUsage = computeNsUsage(graph, dynUsage, deadDynamic);
    const live: Set<number>[] = graph.modules.map(() => new Set());
    const infos: StatementInfo[][] = [];
    const declArrays: [number, [number, number]][][] = [];

    /** packed declared-symbol ref -> [moduleIdx, statement list index] */
    const declToStatement = new Map<number, [number, number]>();

    // Incremental reuse: when topology is unchanged (module id list identical → stable indices),
    // reuse a module's infos unless it was re-parsed or imports a re-parsed module (whose new
    // symbol ids would change this module's binds/refs). The rest rebuild; propagation re-runs.
    const moduleIds = graph.modules.map((m) => m.id);
    const topoStable =
        cache !== undefined &&
        cache.moduleIds.length === moduleIds.length &&
        moduleIds.every((id, i) => id === cache.moduleIds[i]);
    const reshake = new Set<number>();
    if (topoStable) {
        for (let i = 0; i < graph.modules.length; i++) if (graph.changed.has(moduleIds[i])) reshake.add(i);
        for (const c of [...reshake]) {
            for (const impId of graph.modules[c].importers) {
                const ii = graph.byId.get(impId);
                if (ii !== undefined) reshake.add(ii);
            }
        }
    }

    for (const mod of graph.modules) {
        if (topoStable && cache !== undefined && !reshake.has(mod.idx)) {
            infos.push(cache.infos[mod.idx]);
            declArrays.push(cache.decls[mod.idx]);
            for (const [ref, val] of cache.decls[mod.idx]) declToStatement.set(ref, val);
            continue;
        }
        const list: StatementInfo[] = [];
        const localDecls: [number, [number, number]][] = [];
        const body = mod.program.data.body;
        for (let idx = 0; idx < body.length; idx++) {
            const statement = body[idx];
            const refs: number[] = [];
            const declared: number[] = [];
            collectRefs(mod, linked, statement, refs, declared);
            list.push({ statement, refs, pure: statementIsPure(mod, statement) });
            for (const ref of declared) {
                declToStatement.set(ref, [mod.idx, idx]);
                localDecls.push([ref, [mod.idx, idx]]);
            }
        }
        const defRef = linked.defaultRefs.get(mod.idx);
        if (defRef !== undefined) {
            for (let i = 0; i < list.length; i++) {
                if (list[i].statement.type === N.ExportDefaultDeclaration) {
                    declToStatement.set(defRef, [mod.idx, i]);
                    localDecls.push([defRef, [mod.idx, i]]);
                    break;
                }
            }
        }
        infos.push(list);
        declArrays.push(localDecls);
    }

    const worklist: number[] = [];
    const liveRefs = new Set<number>();
    const markRef = (ref: number): void => {
        if (liveRefs.has(ref)) return;
        liveRefs.add(ref);
        worklist.push(ref);
    };
    const includeStatement = (modIdx: number, idx: number): void => {
        const info = infos[modIdx][idx];
        if (live[modIdx].has(info.statement.id)) return;
        live[modIdx].add(info.statement.id);
        for (const r of info.refs) markRef(r);
    };

    for (const mod of graph.modules) {
        // Module-level side-effect gate: a module marked `false` does NOT auto-root its impure
        // statements — they drop if unreferenced; `'no-treeshake'` roots EVERY statement (forces
        // full inclusion).
        if (mod.sideEffects === false) continue;
        const forceAll = mod.sideEffects === 'no-treeshake';
        for (let i = 0; i < infos[mod.idx].length; i++) {
            if (forceAll || !infos[mod.idx][i].pure) includeStatement(mod.idx, i);
        }
    }
    const markBind = (bind: ImportBind): void => {
        if (bind.kind === 'found') markRef(bind.ref);
        else if (bind.kind === 'namespace') markRef(packRef(bind.module, NS_MARKER));
    };
    const markExportMap = (map: Map<string, ImportBind> | undefined): void => {
        if (map === undefined) return;
        for (const bind of map.values()) markBind(bind);
    };
    /** Expand a live NS_MARKER: mark the target's export surface — narrowed to just the members its
     *  consumers read when the target is narrowable, otherwise the whole surface. */
    const expandNs = (modIdx: number): void => {
        const map = linked.exportMaps.get(modIdx);
        if (map === undefined) return;
        const narrow = nsUsage.get(modIdx);
        if (narrow === undefined) {
            for (const bind of map.values()) markBind(bind);
            return;
        }
        for (const name of narrow) {
            const bind = map.get(name);
            if (bind !== undefined) markBind(bind);
        }
    };
    // Root from every entry's export surface (multi-entry).
    for (const { module } of graph.entries) markExportMap(linked.exportMaps.get(module));
    // Dynamic-import liveness: a dynamically-imported module is an inclusion root — its whole
    // export surface may be reached at runtime. Seed each dynamic target's export map.
    for (const mod of graph.modules) {
        for (const rec of mod.importRecords) {
            // Any literal `import()` of the target — whether its record is a pure dynamic edge or a
            // statically-dominant one that also carries an `import()` (`hasDynamicLiteral`).
            if (rec.kind !== 'dynamic' && !rec.hasDynamicLiteral) continue;
            if (rec.external || rec.resolved < 0 || deadDynamic.has(rec.resolved)) continue;
            // Narrowed to the members its consumers read (expandNs consults nsUsage); whole surface
            // when the target escaped / is re-exported / is also a static entry.
            expandNs(rec.resolved);
        }
    }
    for (const modIdx of linked.namespaceOf.keys()) markRef(packRef(modIdx, NS_MARKER));

    while (worklist.length > 0) {
        const ref = worklist.pop()!;
        if (refSym(ref) === NS_MARKER) {
            expandNs(refMod(ref));
            continue;
        }
        const decl = declToStatement.get(ref);
        if (decl !== undefined) includeStatement(decl[0], decl[1]);
    }

    const dropped: [number, Node][] = [];
    for (const mod of graph.modules) {
        for (const info of infos[mod.idx]) {
            if (live[mod.idx].has(info.statement.id)) continue;
            const t = info.statement.type;
            if (
                t === N.ImportDeclaration ||
                t === N.ExportAllDeclaration ||
                t === N.EmptyStatement ||
                t === N.TSInterfaceDeclaration ||
                t === N.TSTypeAliasDeclaration
            )
                continue;
            dropped.push([mod.idx, info.statement]);
        }
    }
    if (cache !== undefined) {
        cache.moduleIds = moduleIds;
        cache.infos = infos;
        cache.decls = declArrays;
    }
    return { live, dropped, nsUsage, deadDynamic, liveRefs };
}
