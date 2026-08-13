// Tree shaking: export-rooted, statement-level liveness (rolldown stmt_infos
// model, llm/notes/rolldown-internals.md). Effectful statements are always
// included, so conservative purity mistakes cost bundle size, never correctness.
// LIMIT: top-level statements only (no within-statement shaking).

import { A, N, type NodeId, listAt, listLen } from './ast';
import { isPureStatement } from './analysis/effects';
import { walkRefIdents } from './analysis/refs';
import { type Graph, type Module } from './graph';
import { type Linked, packRef, refMod, refSym } from './link';

/** Result of tree shaking: which top-level statements survive, and which were dropped. */
export type Shaken = {
    /** per module idx: set of live top-level statement NodeIds */
    live: Set<number>[];
    /** statements shaken away, for reporting: [moduleIdx, stmtNodeId][] */
    dropped: [number, number][];
};

/* -------------------------------------------------------------- stmt infos */

type StmtInfo = {
    stmt: NodeId;
    /** packed refs this statement references (imports resolved through binds) */
    refs: number[];
    pure: boolean;
};

function collectRefs(mod: Module, linked: Linked, stmt: NodeId, out: number[]): void {
    const moduleScope = mod.semantic.nodeScope[mod.program];
    walkRefIdents(mod.ast, stmt, (ident) => {
        const sym = mod.semantic.nodeSymbol[ident];
        if (sym === 0) return;
        if (mod.namedImports.has(sym)) {
            const bind = linked.binds.get(packRef(mod.idx, sym));
            if (bind === undefined) return;
            if (bind.kind === 'found') out.push(bind.ref);
            else if (bind.kind === 'namespace') out.push(packRef(bind.module, NS_MARKER));
            return;
        }
        if (mod.semantic.symScope[sym] === moduleScope) out.push(packRef(mod.idx, sym));
    });
}

/**
 * Bundler purity policy over the effects leaves: an EXTERNAL side-effect-only
 * import is itself the effect (kept); internal ones defer to the target
 * module's own statements (always preserved by root 1).
 */
function stmtIsPure(mod: Module, stmt: NodeId): boolean {
    const ast = mod.ast;
    if (ast.type[stmt] === N.ImportDecl) {
        const specs = A.ImportDecl.specifiers(ast, stmt);
        if (listLen(ast, specs) > 0) return true;
        const source = A.ImportDecl.source(ast, stmt);
        if (source === 0) return true;
        const spec = ast.src.slice(ast.start[source] + 1, ast.end[source] - 1);
        const rec = mod.importRecords.find((r) => r.specifier === spec);
        return !(rec?.external ?? false);
    }
    return isPureStatement(ast, stmt);
}

/** pseudo-symbol id marking "the whole namespace of this module" */
const NS_MARKER = 0x1fffff;

/* ---------------------------------------------------------------- liveness */

/** Compute statement-level liveness over the linked graph, rooted at the entry's exports and every effectful statement. */
export function shake(graph: Graph, linked: Linked): Shaken {
    const live: Set<number>[] = graph.modules.map(() => new Set());
    const infos: StmtInfo[][] = [];
    /** packed declared-symbol ref -> [moduleIdx, stmt list index] */
    const declToStmt = new Map<number, [number, number]>();

    for (const mod of graph.modules) {
        const list: StmtInfo[] = [];
        const ast = mod.ast;
        const moduleScope = mod.semantic.nodeScope[mod.program];
        const body = A.Program.body(ast, mod.program);
        const spans: [number, number, number][] = []; // start, end, listIdx
        for (let i = 0; i < listLen(ast, body); i++) {
            const stmt = listAt(ast, body, i);
            const refs: number[] = [];
            collectRefs(mod, linked, stmt, refs);
            list.push({ stmt, refs, pure: stmtIsPure(mod, stmt) });
            spans.push([ast.start[stmt], ast.end[stmt], list.length - 1]);
        }
        // map every module-scope symbol to the statement containing its decl
        const sem = mod.semantic;
        for (let sym = 1; sym < sem.symCount; sym++) {
            if (sem.symScope[sym] !== moduleScope) continue;
            const at = ast.start[sem.symDecl[sym]];
            for (const [s, e, idx] of spans) {
                if (at >= s && at < e) {
                    declToStmt.set(packRef(mod.idx, sym), [mod.idx, idx]);
                    break;
                }
            }
        }
        // synthetic anonymous-default: declared by its ExportDefault statement
        const defRef = linked.defaultRefs.get(mod.idx);
        if (defRef !== undefined) {
            for (let i = 0; i < list.length; i++) {
                if (ast.type[list[i].stmt] === N.ExportDefault) {
                    declToStmt.set(defRef, [mod.idx, i]);
                    break;
                }
            }
        }
        infos.push(list);
    }

    /* roots + worklist */
    const worklist: number[] = [];
    const liveRefs = new Set<number>();
    const markRef = (ref: number): void => {
        if (liveRefs.has(ref)) return;
        liveRefs.add(ref);
        worklist.push(ref);
    };
    const includeStmt = (modIdx: number, idx: number): void => {
        const info = infos[modIdx][idx];
        if (live[modIdx].has(info.stmt)) return;
        live[modIdx].add(info.stmt);
        for (const r of info.refs) markRef(r);
    };

    // root 1: every effectful statement, everywhere reachable
    for (const mod of graph.modules) {
        for (let i = 0; i < infos[mod.idx].length; i++) {
            if (!infos[mod.idx][i].pure) includeStmt(mod.idx, i);
        }
    }
    // root 2: the entry's export surface
    const entryMap = linked.exportMaps.get(graph.entry);
    if (entryMap !== undefined) {
        for (const bind of entryMap.values()) {
            if (bind.kind === 'found') markRef(bind.ref);
            else if (bind.kind === 'namespace') markRef(packRef(bind.module, NS_MARKER));
        }
    }
    // root 3: namespace objects reference every export of their module
    for (const modIdx of linked.namespaceOf.keys()) markRef(packRef(modIdx, NS_MARKER));

    while (worklist.length > 0) {
        const ref = worklist.pop()!;
        if (refSym(ref) === NS_MARKER) {
            // whole-namespace demand: every export of the module becomes live
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
        const decl = declToStmt.get(ref);
        if (decl !== undefined) includeStmt(decl[0], decl[1]);
    }

    const dropped: [number, number][] = [];
    for (const mod of graph.modules) {
        for (const info of infos[mod.idx]) {
            if (live[mod.idx].has(info.stmt)) continue;
            // report only real code removals — import/export/type syntax is
            // erased by the bundler regardless of liveness
            const t = mod.ast.type[info.stmt];
            if (t === N.ImportDecl || t === N.ExportAll || t === N.Empty || t === N.TSInterfaceDecl || t === N.TSTypeAliasDecl)
                continue;
            dropped.push([mod.idx, info.stmt]);
        }
    }
    return { live, dropped };
}
