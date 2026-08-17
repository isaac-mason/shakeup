import { isPureStatement } from './analysis/effects';
import { walkRefIdents } from './analysis/refs';
import { scopeOf, symbolOf } from './analysis/semantic';
import { N, type Node, walk } from './ast';
import { type Graph, type ImportBind, type Linked, type Module, packRef, refMod, refSym } from './module-graph';

export type TreeshakeResult = {
    live: Set<number>[];
    dropped: [number, Node][];
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

function collectRefs(mod: Module, linked: Linked, statement: Node, out: number[]): void {
    const moduleScope = scopeOf(mod.semantic, mod.program);
    const pushSym = (sym: number): void => {
        if (sym === 0) return;
        if (mod.namedImports.has(sym)) {
            const bind = linked.binds.get(packRef(mod.idx, sym));
            if (bind === undefined) return;
            if (bind.kind === 'found') out.push(bind.ref);
            else if (bind.kind === 'namespace') out.push(packRef(bind.module, NS_MARKER));
            return;
        }
        if (mod.semantic.symbols[sym].scope === moduleScope) out.push(packRef(mod.idx, sym));
    };
    walkRefIdents(statement, (ident) => pushSym(symbolOf(mod.semantic, ident)));
    if (mod.jsxRuntime !== null && statementContainsJSX(statement)) {
        const rt = mod.jsxRuntime;
        pushSym(rt.jsx);
        pushSym(rt.jsxs);
        pushSym(rt.Fragment);
        if (rt.createElement !== 0) pushSym(rt.createElement);
    }
}

function statementContainsJSX(statement: Node): boolean {
    let found = false;
    walk(statement, (n) => {
        if (n.type === N.JSXElement || n.type === N.JSXFragment) found = true;
    });
    return found;
}

function statementIsPure(mod: Module, statement: Node, jsxPure: boolean): boolean {
    if (statement.type === N.ImportDeclaration) {
        if (statement.data.specifiers.length > 0) return true;
        const source = statement.data.source;
        if (source.type !== N.StringLiteral) return true;
        const spec = mod.source.slice(source.start + 1, source.end - 1);
        const rec = mod.importRecords.find((r) => r.specifier === spec);
        return !(rec?.external ?? false);
    }
    return isPureStatement(statement, jsxPure);
}

/** pseudo-symbol id marking "the whole namespace of this module" */
const NS_MARKER = 0x1fffff;

/** Compute statement-level liveness over the linked graph, rooted at the entry's exports and every effectful statement. */
export function treeshake(graph: Graph, linked: Linked, jsxPure: boolean, cache?: TreeshakeCache): TreeshakeResult {
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
        const moduleScope = scopeOf(mod.semantic, mod.program);
        const spans: [number, number, number][] = [];
        for (const statement of mod.program.data.body) {
            const refs: number[] = [];
            collectRefs(mod, linked, statement, refs);
            list.push({ statement, refs, pure: statementIsPure(mod, statement, jsxPure) });
            spans.push([statement.start, statement.end, list.length - 1]);
        }
        const sem = mod.semantic;
        for (let sym = 1; sym < sem.symbols.length; sym++) {
            if (sem.symbols[sym].scope !== moduleScope) continue;
            const at = sem.symbols[sym].decl!.start;
            for (const [s, e, idx] of spans) {
                if (at >= s && at < e) {
                    const ref = packRef(mod.idx, sym);
                    declToStatement.set(ref, [mod.idx, idx]);
                    localDecls.push([ref, [mod.idx, idx]]);
                    break;
                }
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
    const markExportMap = (map: Map<string, ImportBind> | undefined): void => {
        if (map === undefined) return;
        for (const bind of map.values()) {
            if (bind.kind === 'found') markRef(bind.ref);
            else if (bind.kind === 'namespace') markRef(packRef(bind.module, NS_MARKER));
        }
    };
    // Root from every entry's export surface (multi-entry).
    for (const { module } of graph.entries) markExportMap(linked.exportMaps.get(module));
    // Dynamic-import liveness: a dynamically-imported module is an inclusion root — its whole
    // export surface may be reached at runtime. Seed each dynamic target's export map.
    for (const mod of graph.modules) {
        for (const rec of mod.importRecords) {
            if (rec.kind === 'dynamic' && !rec.external && rec.resolved >= 0) markExportMap(linked.exportMaps.get(rec.resolved));
        }
    }
    for (const modIdx of linked.namespaceOf.keys()) markRef(packRef(modIdx, NS_MARKER));

    while (worklist.length > 0) {
        const ref = worklist.pop()!;
        if (refSym(ref) === NS_MARKER) {
            const modIdx = refMod(ref);
            const map = linked.exportMaps.get(modIdx);
            if (map !== undefined) {
                for (const bind of map.values()) {
                    if (bind.kind === 'found') markRef(bind.ref);
                    else if (bind.kind === 'namespace') markRef(packRef(bind.module, NS_MARKER));
                }
            }
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
    return { live, dropped };
}
