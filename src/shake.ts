// Tree shaking: export-rooted, statement-level liveness (rolldown stmt_infos
// model, llm/notes/rolldown-internals.md). Effectful statements are always
// included, so conservative purity mistakes cost bundle size, never correctness.
// LIMIT: top-level statements only (no within-statement shaking).

import { type Node, N } from './ast';
import { isPureStatement } from './analysis/effects';
import { walkRefIdents } from './analysis/refs';
import { type Graph, type Module } from './graph';
import { type Linked, packRef, refMod, refSym } from './link';

/** Result of tree shaking: which top-level statements survive, and which were dropped.
 * Liveness is keyed by statement node id (the id-indexed side-table convention). */
export type Shaken = {
    /** per module idx: set of live top-level statement node ids */
    live: Set<number>[];
    /** statements shaken away, for reporting: [moduleIdx, stmtNode][] */
    dropped: [number, Node][];
};

/* -------------------------------------------------------------- stmt infos */

type StmtInfo = {
    stmt: Node;
    /** packed refs this statement references (imports resolved through binds) */
    refs: number[];
    pure: boolean;
};

function collectRefs(mod: Module, linked: Linked, stmt: Node, out: number[]): void {
    const moduleScope = mod.semantic.nodeScope[mod.program.id];
    walkRefIdents(stmt, (ident) => {
        const sym = mod.semantic.nodeSymbol[ident.id];
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
function stmtIsPure(mod: Module, stmt: Node): boolean {
    if (stmt.type === N.ImportDeclaration) {
        if (stmt.data.specifiers.length > 0) return true;
        const source = stmt.data.source;
        if (source.type !== N.StringLiteral) return true;
        const spec = mod.source.slice(source.start + 1, source.end - 1);
        const rec = mod.importRecords.find((r) => r.specifier === spec);
        return !(rec?.external ?? false);
    }
    return isPureStatement(stmt);
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
        const moduleScope = mod.semantic.nodeScope[mod.program.id];
        const spans: [number, number, number][] = []; // start, end, listIdx
        for (const stmt of mod.program.data.body) {
            const refs: number[] = [];
            collectRefs(mod, linked, stmt, refs);
            list.push({ stmt, refs, pure: stmtIsPure(mod, stmt) });
            spans.push([stmt.start, stmt.end, list.length - 1]);
        }
        // map every module-scope symbol to the statement containing its decl
        const sem = mod.semantic;
        for (let sym = 1; sym < sem.symCount; sym++) {
            if (sem.symScope[sym] !== moduleScope) continue;
            const at = sem.symDecl[sym]!.start;
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
                if (list[i].stmt.type === N.ExportDefaultDeclaration) {
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
        if (live[modIdx].has(info.stmt.id)) return;
        live[modIdx].add(info.stmt.id);
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

    const dropped: [number, Node][] = [];
    for (const mod of graph.modules) {
        for (const info of infos[mod.idx]) {
            if (live[mod.idx].has(info.stmt.id)) continue;
            // report only real code removals — import/export/type syntax is
            // erased by the bundler regardless of liveness
            const t = info.stmt.type;
            if (t === N.ImportDeclaration || t === N.ExportAllDeclaration || t === N.EmptyStatement || t === N.TSInterfaceDeclaration || t === N.TSTypeAliasDeclaration)
                continue;
            dropped.push([mod.idx, info.stmt]);
        }
    }
    return { live, dropped };
}
