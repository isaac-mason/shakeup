// Chunk-level slot mangler — the adapter binding shakeup's per-module semantic tables to the
// oxc slot-liveness algorithm (`./slots.ts` + `./names.ts`).
//
// WHY CHUNK-WIDE: a chunk is concatenated into ONE flat top-level scope (esbuild/rolldown
// scope-hoisting), so whether module A's top-level name may be reused as a local inside module B's
// function is a chunk-wide question. rolldown asks it chunk-wide too (`deconflict_chunk_symbols`).
//
// WHAT THIS REPLACES: `mangleNestedScopes`, which blocked EVERY chunk-top name in EVERY nested
// scope (a shared `taken` set). That is the ~5% we were leaving on the table: a top-level name not
// referenced inside a function can be reused as that function's local.
//
// INCREMENT 1 (deliberately conservative): top-level names stay exactly as `deconflictChunk`
// assigned them — untouched, so chunk exports / cross-chunk import aliases cannot drift. Top-level
// symbols still take part in slot assignment so their LIVENESS is known; each slot that contains a
// top-level symbol is "anchored" to that symbol's existing name, and nested symbols sharing the slot
// inherit it (that inheritance IS the win). Slots with no top-level symbol get a fresh base54 name.
// Sound because slot assignment guarantees symbols sharing a slot never have overlapping live ranges.

import { scopeOf } from '../analysis/semantic.ts';
import { N, type Node } from '../ast.ts';
import { base54 } from '../deconflict.ts';
import { type Graph, type Linked, packRef, refMod, refSym } from '../graph-types.ts';
import { hookTable, traverse, type TransformCtx, type Visitor } from '../passes/traverse.ts';
import { assignSlots, SLOT_UNASSIGNED } from './slots.ts';

/** Direct `eval` can see every binding by its source name, so mangling any of them is unsafe.
 *  shakeup's semantic does not track direct eval (oxc reserves per-scope, lib.rs:604-608), so we
 *  bail conservatively for the whole chunk — matching the correctness requirement, not the precision. */
function chunkHasDirectEval(graph: Graph, chunkModules: number[]): boolean {
    for (const idx of chunkModules) {
        for (const node of graph.modules[idx].semantic.unresolved) {
            if (node.name === 'eval') return true;
        }
    }
    return false;
}

/**
 * Mangle every non-top-level binding in a chunk using chunk-wide slot liveness.
 * `taken` is the chunk's fully-populated top-level name set (globals + reserved + top-level names +
 * cross-chunk locals + namespace/external names) — fresh names avoid all of it.
 */
export function mangleChunkScopes(graph: Graph, linked: Linked, chunkModules: number[], taken: Set<string>): void {
    if (chunkHasDirectEval(graph, chunkModules)) return; // leave names alone (see above)

    // ── 1. Unified scope + symbol id spaces across the chunk's modules ──
    // Unified scope 0 is the chunk's single top-level scope; every module scope maps onto it.
    const ROOT = 0;
    const parent: number[] = [ROOT];
    // per module: local scope id → unified scope id, and local sym id → unified sym id
    const scopeMap: Int32Array[] = [];
    const symMap: Int32Array[] = [];
    const unifiedToRef: number[] = [0]; // unified sym → packRef (index 0 unused)

    for (const idx of chunkModules) {
        const sem = graph.modules[idx].semantic;
        const moduleScope = scopeOf(sem, graph.modules[idx].program);
        const sm = new Int32Array(sem.scopes.length).fill(-1);
        // Ascending local ids keep parents before children, so unified ids stay topological too.
        for (let s = 1; s < sem.scopes.length; s++) {
            if (s === moduleScope) {
                sm[s] = ROOT;
                continue;
            }
            const p = sem.scopes[s].parent;
            sm[s] = parent.length;
            parent.push(p === moduleScope || p === 0 ? ROOT : sm[p]);
        }
        scopeMap[idx] = sm;

        const ym = new Int32Array(sem.symbols.length).fill(0);
        for (let sym = 1; sym < sem.symbols.length; sym++) {
            ym[sym] = unifiedToRef.length;
            unifiedToRef.push(packRef(idx, sym));
        }
        symMap[idx] = ym;
    }

    const scopeCount = parent.length;
    const symbolCount = unifiedToRef.length;

    // ── 2. Bindings per unified scope (declaration order), skipping import aliases ──
    const bindingsByScope: number[][] = Array.from({ length: scopeCount }, () => []);
    const isTopLevel = new Uint8Array(symbolCount);
    for (const idx of chunkModules) {
        const mod = graph.modules[idx];
        const sem = mod.semantic;
        const moduleScope = scopeOf(sem, mod.program);
        for (let sym = 1; sym < sem.symbols.length; sym++) {
            if (mod.namedImports.has(sym)) continue; // alias for a producer symbol — never named here
            if (sem.symbols[sym].decl === null) continue;
            const u = symMap[idx][sym];
            const owner = sem.symbols[sym].scope;
            const uScope = owner === moduleScope ? ROOT : scopeMap[idx][owner];
            if (uScope < 0) continue;
            if (uScope === ROOT) isTopLevel[u] = 1;
            bindingsByScope[uScope].push(u);
        }
    }

    // ── 3. Reference + declaration scopes (cross-module resolved) via one scope-tracking walk ──
    const refScopes: number[][] = Array.from({ length: symbolCount }, () => []);
    const declScopes: number[][] = Array.from({ length: symbolCount }, () => []);
    const refCount = new Float64Array(symbolCount);

    for (const idx of chunkModules) {
        const mod = graph.modules[idx];
        const sem = mod.semantic;
        const sm = scopeMap[idx];
        const ym = symMap[idx];
        /** Local symbol → unified symbol, following an import alias to its producer so a top-level
         *  symbol's liveness includes uses in OTHER modules of the chunk. */
        const refToUnified = (ref: number): number => {
            const map = symMap[refMod(ref)];
            if (map === undefined) return 0; // producer outside this chunk → skip
            // A SYNTHETIC ref (link.ts `syntheticRef`) — the binding minted for `export default <expr>`,
            // whose id is allocated PAST the producer's real symbol table (`nextSynthetic[mod]++`) and
            // whose name lives in `linked.syntheticNames`, not `semantic.symbols`. `symMap` is sized to
            // the real table, so the lookup is legitimately out of range. Skip it: the name deconflict
            // already assigned stands, and the mangler leaves it alone. Without this the chunk mangler
            // crashed on `refScopes[undefined]` for any chunk containing a module whose default export
            // is a bare expression (three.js ships ~200 of these as `.glsl.js` shader chunks).
            return map[refSym(ref)] ?? 0;
        };
        const resolve = (localSym: number): number => {
            if (!mod.namedImports.has(localSym)) return ym[localSym];
            const bind = linked.binds.get(packRef(idx, localSym));
            if (bind === undefined || bind.kind !== 'found') return 0;
            return refToUnified(bind.ref);
        };
        const uScopeOf = (ctx: TransformCtx): number => {
            const s = ctx.currentScope;
            return s <= 0 ? ROOT : (sm[s] ?? ROOT);
        };
        const visitor: Visitor = {
            name: 'mangle-collect',
            enter: hookTable({
                [N.IdentifierReference]: (n: Node, ctx: TransformCtx) => {
                    const s = (n as { sym: number }).sym;
                    if (s <= 0) return;
                    const u = resolve(s);
                    if (u <= 0) return;
                    refScopes[u].push(uScopeOf(ctx));
                    refCount[u]++;
                },
                [N.BindingIdentifier]: (n: Node, ctx: TransformCtx) => {
                    const s = (n as { sym: number }).sym;
                    if (s <= 0) return;
                    const u = ym[s];
                    if (u <= 0) return;
                    declScopes[u].push(uScopeOf(ctx));
                },
            }),
            exit: null,
        };
        traverse(mod.program, sem, [visitor]);
    }

    // ── 4. Slot assignment (the oxc algorithm) ──
    const { slots, totalSlots } = assignSlots({
        scopeCount,
        root: ROOT,
        parent,
        bindingsByScope,
        refScopes,
        declScopes,
        symbolCount,
    });

    // ── 5. Names: a slot holding a top-level symbol inherits that symbol's existing name (the win);
    //    every other slot gets a fresh base54 name avoiding `taken`. ──
    const slotName: (string | null)[] = new Array(totalSlots).fill(null);
    for (let u = 1; u < symbolCount; u++) {
        if (!isTopLevel[u]) continue;
        const slot = slots[u];
        if (slot === SLOT_UNASSIGNED) continue;
        const ref = unifiedToRef[u];
        const existing = linked.finalNames.get(ref);
        slotName[slot] = existing ?? nameOfRef(graph, ref);
    }
    let next = 0;
    const fresh = (): string => {
        let name = base54(next++);
        while (taken.has(name)) name = base54(next++);
        return name;
    };
    for (let s = 0; s < totalSlots; s++) if (slotName[s] === null) slotName[s] = fresh();

    // ── 6. Write back — nested symbols only; top-level naming is left exactly as deconflict set it ──
    for (let u = 1; u < symbolCount; u++) {
        if (isTopLevel[u]) continue;
        const slot = slots[u];
        if (slot === SLOT_UNASSIGNED) continue;
        linked.finalNames.set(unifiedToRef[u], slotName[slot]!);
    }
}

function nameOfRef(graph: Graph, ref: number): string {
    return graph.modules[refMod(ref)].semantic.symbols[refSym(ref)].decl!.name;
}
