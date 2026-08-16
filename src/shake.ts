import { isPureStatement } from './analysis/effects';
import { walkRefIdents } from './analysis/refs';
import { scopeOf, symbolOf } from './analysis/semantic';
import { N, type Node, walk } from './ast';
import { type Graph, type Linked, type Module, packRef, refMod, refSym } from './module-graph';

/** Result of tree shaking: which top-level statements survive, and which were dropped.
 * Liveness is keyed by statement node id (the id-indexed side-table convention). */
export type Shaken = {
    live: Set<number>[];
    dropped: [number, Node][];
};

type StmtInfo = {
    stmt: Node;
    refs: number[];
    pure: boolean;
};

function collectRefs(mod: Module, linked: Linked, stmt: Node, out: number[]): void {
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
    walkRefIdents(stmt, (ident) => pushSym(symbolOf(mod.semantic, ident)));
    if (mod.jsxRuntime !== null && stmtContainsJSX(stmt)) {
        const rt = mod.jsxRuntime;
        pushSym(rt.jsx);
        pushSym(rt.jsxs);
        pushSym(rt.Fragment);
        if (rt.createElement !== 0) pushSym(rt.createElement);
    }
}

/** True if the statement subtree contains any JSX element/fragment. */
function stmtContainsJSX(stmt: Node): boolean {
    let found = false;
    walk(stmt, (n) => {
        if (n.type === N.JSXElement || n.type === N.JSXFragment) found = true;
    });
    return found;
}

function stmtIsPure(mod: Module, stmt: Node, jsxPure: boolean): boolean {
    if (stmt.type === N.ImportDeclaration) {
        if (stmt.data.specifiers.length > 0) return true;
        const source = stmt.data.source;
        if (source.type !== N.StringLiteral) return true;
        const spec = mod.source.slice(source.start + 1, source.end - 1);
        const rec = mod.importRecords.find((r) => r.specifier === spec);
        return !(rec?.external ?? false);
    }
    return isPureStatement(stmt, jsxPure);
}

/** pseudo-symbol id marking "the whole namespace of this module" */
const NS_MARKER = 0x1fffff;

/** Compute statement-level liveness over the linked graph, rooted at the entry's exports and every effectful statement. */
export function shake(graph: Graph, linked: Linked, jsxPure: boolean): Shaken {
    const live: Set<number>[] = graph.modules.map(() => new Set());
    const infos: StmtInfo[][] = [];
    /** packed declared-symbol ref -> [moduleIdx, stmt list index] */
    const declToStmt = new Map<number, [number, number]>();

    for (const mod of graph.modules) {
        const list: StmtInfo[] = [];
        const moduleScope = scopeOf(mod.semantic, mod.program);
        const spans: [number, number, number][] = [];
        for (const stmt of mod.program.data.body) {
            const refs: number[] = [];
            collectRefs(mod, linked, stmt, refs);
            list.push({ stmt, refs, pure: stmtIsPure(mod, stmt, jsxPure) });
            spans.push([stmt.start, stmt.end, list.length - 1]);
        }
        const sem = mod.semantic;
        for (let sym = 1; sym < sem.symbols.length; sym++) {
            if (sem.symbols[sym].scope !== moduleScope) continue;
            const at = sem.symbols[sym].decl!.start;
            for (const [s, e, idx] of spans) {
                if (at >= s && at < e) {
                    declToStmt.set(packRef(mod.idx, sym), [mod.idx, idx]);
                    break;
                }
            }
        }
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

    for (const mod of graph.modules) {
        for (let i = 0; i < infos[mod.idx].length; i++) {
            if (!infos[mod.idx][i].pure) includeStmt(mod.idx, i);
        }
    }
    const entryMap = linked.exportMaps.get(graph.entry);
    if (entryMap !== undefined) {
        for (const bind of entryMap.values()) {
            if (bind.kind === 'found') markRef(bind.ref);
            else if (bind.kind === 'namespace') markRef(packRef(bind.module, NS_MARKER));
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
        const decl = declToStmt.get(ref);
        if (decl !== undefined) includeStmt(decl[0], decl[1]);
    }

    const dropped: [number, Node][] = [];
    for (const mod of graph.modules) {
        for (const info of infos[mod.idx]) {
            if (live[mod.idx].has(info.stmt.id)) continue;
            const t = info.stmt.type;
            if (
                t === N.ImportDeclaration ||
                t === N.ExportAllDeclaration ||
                t === N.EmptyStatement ||
                t === N.TSInterfaceDeclaration ||
                t === N.TSTypeAliasDeclaration
            )
                continue;
            dropped.push([mod.idx, info.stmt]);
        }
    }
    return { live, dropped };
}
