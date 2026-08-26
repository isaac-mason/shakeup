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

/** `verify` runs BOTH collectors on every current module and compares them; the walk is the reference
 *  implementation. Mirrors `DELTA_MODE`/`VERIFY_SYMBOL_INIT` — the divergence must be findable, not argued. */
// `verify` runs BOTH collectors on every current module and compares them as multisets; the walk is the
// reference implementation. It reported 0 divergences on crashcat and three.core.js once `analyze` was
// aligned to oxc's class/function scope ordering — see llm/notes/mangle-collect-elimination-design.md.
const MANGLE_SCOPES = process.env.MANGLE_SCOPES ?? 'semantic';


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
export type ChunkSlots = {
    slots: Int32Array;
    totalSlots: number;
    symbolCount: number;
    unifiedToRef: number[];
    isTopLevel: Uint8Array;
    refScopes: number[][];
};

/** §1-4: the chunk's unified scope/symbol space and its slot assignment. Depends only on SHAPE —
 *  scopes, bindings and reference sites — never on names, so it can run BEFORE `deconflictChunk`
 *  chooses any. `null` when the chunk contains direct `eval` and must keep its names. */
export function computeChunkSlots(graph: Graph, linked: Linked, chunkModules: number[]): ChunkSlots | null {
    if (chunkHasDirectEval(graph, chunkModules)) return null; // leave names alone (see above)

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

    // ── 3. Reference + declaration scopes (cross-module resolved), read off the semantic ──
    // oxc's mangler never walks the AST for these: `SlotAssignment::compute` reads
    // `get_resolved_references(sym).map(Reference::scope_id)` plus the declaring/redeclaring scopes
    // straight off `Scoping` (`oxc_mangler/src/lib.rs:665-672`). `analyze` now records the same pairs,
    // so the dedicated traversal this used to run (97 calls, 122,202 node visits, 14.3% of ALL node
    // visits in a crashcat bundle) is gone for every module whose semantic is current.
    const refScopes: number[][] = Array.from({ length: symbolCount }, () => []);
    const declScopes: number[][] = Array.from({ length: symbolCount }, () => []);

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
        const uScope = (localScope: number): number => (localScope <= 0 ? ROOT : (sm[localScope] ?? ROOT));

        /** Today's path: recover the scopes by walking the module. Kept as the fallback for a semantic
         *  that is not current, and as the reference implementation `MANGLE_SCOPES=verify` checks. */
        const collectByWalk = (rOut: number[][], dOut: number[][]): void => {
            const uScopeOf = (ctx: TransformCtx): number => uScope(ctx.currentScope);
            const visitor: Visitor = {
                name: 'mangle-collect',
                enter: hookTable({
                    [N.IdentifierReference]: (n: Node, ctx: TransformCtx) => {
                        const s = (n as { sym: number }).sym;
                        if (s <= 0) return;
                        const u = resolve(s);
                        if (u <= 0) return;
                        rOut[u].push(uScopeOf(ctx));
                    },
                    [N.BindingIdentifier]: (n: Node, ctx: TransformCtx) => {
                        const s = (n as { sym: number }).sym;
                        if (s <= 0) return;
                        const u = ym[s];
                        if (u <= 0) return;
                        dOut[u].push(uScopeOf(ctx));
                    },
                }),
                exit: null,
            };
            traverse(mod.program, sem, [visitor]);
        };

        /** oxc's path: read the scopes off the semantic (`get_resolved_references(sym).scope_id`),
         *  no traversal. Valid only while `refsCurrent` holds. */
        const collectFromSemantic = (rOut: number[][], dOut: number[][]): void => {
            const rs = sem.refSyms, rsc = sem.refScopeIds;
            for (let i = 0; i < rs.length; i++) {
                const u = resolve(rs[i]);
                if (u <= 0) continue;
                rOut[u].push(uScope(rsc[i]));
            }
            const ds = sem.declSyms, dsc = sem.declScopeIds;
            for (let i = 0; i < ds.length; i++) {
                const u = ym[ds[i]];
                if (u <= 0) continue;
                dOut[u].push(uScope(dsc[i]));
            }
        };

        if (!sem.refsCurrent || MANGLE_SCOPES === 'walk') {
            // Not current: a traversal mutated the tree without a re-analyze, so the recorded scopes may
            // describe a shape that no longer exists. Measured on crashcat: 6 of 97 modules.
            collectByWalk(refScopes, declScopes);
        } else if (MANGLE_SCOPES === 'verify') {
            // Both, then compare as MULTISETS — `assignSlots` only ever tests set membership
            // (`slotLiveness[s].has(scopeId)`), so order and duplicates are not observable, but a
            // MISSING or EXTRA scope is.
            // BOTH into fresh per-module arrays. `refScopes`/`declScopes` ACCUMULATE across the module
            // loop, so comparing this module's walk against them would compare one module's output
            // against every module so far — a guaranteed mismatch that says nothing.
            const rw: number[][] = Array.from({ length: symbolCount }, () => []);
            const dw: number[][] = Array.from({ length: symbolCount }, () => []);
            const rs: number[][] = Array.from({ length: symbolCount }, () => []);
            const ds: number[][] = Array.from({ length: symbolCount }, () => []);
            collectByWalk(rw, dw);
            collectFromSemantic(rs, ds);
            const key = (a: number[]): string => [...a].sort((x, y) => x - y).join(',');
            for (let u = 1; u < symbolCount; u++) {
                if (key(rw[u]) !== key(rs[u]))
                    throw new Error(`mangle refScopes diverged, unified sym ${u} in ${mod.id}: walk [${key(rw[u])}] vs semantic [${key(rs[u])}]`);
                if (key(dw[u]) !== key(ds[u]))
                    throw new Error(`mangle declScopes diverged, unified sym ${u} in ${mod.id}: walk [${key(dw[u])}] vs semantic [${key(ds[u])}]`);
            }
            for (let u = 1; u < symbolCount; u++) {
                for (const v of rs[u]) refScopes[u].push(v);
                for (const v of ds[u]) declScopes[u].push(v);
            }
        } else {
            collectFromSemantic(refScopes, declScopes);
        }
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

    return { slots, totalSlots, symbolCount, unifiedToRef, isTopLevel, refScopes };
}

/** Weight per top-level symbol for `deconflictChunk`'s claim ORDER: the total reference count of the
 *  symbol's whole SLOT, not of the symbol itself.
 *
 *  This distinction is the entire point. A slot holding a top-level symbol lends that name to every
 *  nested symbol sharing it, so the name's real traffic is the slot's. Measured on crashcat, the
 *  top-level symbol printed as `e` is `NONE_FLAG`, whose OWN reference count is zero — `e` appears
 *  7359 times because the nested symbols in its slot inherit it. Ranking by the symbol's own count
 *  instead of its slot's made the bundle 30,563 bytes BIGGER.
 *
 *  Keyed by `packRef` so `deconflictChunk` can look up the symbols it is about to claim for. */
export function topLevelSlotWeights(pre: ChunkSlots): Map<number, number> {
    const { slots, totalSlots, symbolCount, unifiedToRef, isTopLevel, refScopes } = pre;
    const freq = new Float64Array(totalSlots);
    for (let u = 1; u < symbolCount; u++) {
        const slot = slots[u];
        if (slot !== SLOT_UNASSIGNED) freq[slot] += refScopes[u].length;
    }
    const out = new Map<number, number>();
    for (let u = 1; u < symbolCount; u++) {
        if (!isTopLevel[u]) continue;
        const slot = slots[u];
        if (slot === SLOT_UNASSIGNED) continue;
        out.set(unifiedToRef[u], freq[slot]);
    }
    return out;
}

/** §5-6: choose a name per slot and write it back. */
export function mangleChunkScopes(graph: Graph, linked: Linked, taken: Set<string>, pre: ChunkSlots): void {
    const { slots, totalSlots, symbolCount, unifiedToRef, isTopLevel, refScopes } = pre;

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
    // oxc Phase 3, `SlotRanking::tally` (`oxc_mangler/src/lib.rs:732-777`): rank slots by REFERENCE
    // FREQUENCY and hand out names hottest-first, because `base54` names get LONGER as they are
    // consumed (54 one-character names, then two-character). Assigning in slot-index order — what this
    // did — spends the one-character names on whichever slots happen to come first, which is arbitrary.
    //
    // `refScopes[u].length` is the reference count for unified symbol u (one entry pushed per
    // reference), i.e. exactly oxc's `get_resolved_reference_ids(symbol_id).len()`.
    //
    // Top-level symbols are excluded, matching this file's existing policy: their slots are already
    // ANCHORED to a `deconflict`-assigned name above and never take a fresh one.
    const slotFreq = new Float64Array(totalSlots);
    for (let u = 1; u < symbolCount; u++) {
        if (isTopLevel[u]) continue;
        const slot = slots[u];
        if (slot === SLOT_UNASSIGNED) continue;
        slotFreq[slot] += refScopes[u].length;
    }
    const unnamed: number[] = [];
    for (let s = 0; s < totalSlots; s++) if (slotName[s] === null) unnamed.push(s);
    // Descending frequency. `unnamed` is built in ascending slot order and `sort` is stable, so ties
    // break by slot index — deterministic, which matters more here than oxc's `sort_unstable_by_key`.
    unnamed.sort((a, b) => slotFreq[b] - slotFreq[a]);
    for (const s of unnamed) slotName[s] = fresh();

    // ── 5b. Ceiling measurement (MANGLE_STATS=1) ──────────────────────────────────────────────
    // Increment 1 leaves every top-level name as `deconflictChunk` set it. Against oxc-minify on the
    // same input that costs real bytes: a hot external-import binding (`vec3`, 2163 uses) keeps its
    // 2-char deconflict name while oxc gives it a 1-char one. This reports the UPPER BOUND on
    // increment 2 — it ignores export/cross-chunk safety, so the achievable win is smaller.
    if (process.env.MANGLE_STATS) {
        const freq = new Float64Array(totalSlots);
        let top = 0;
        for (let u = 1; u < symbolCount; u++) {
            const slot = slots[u];
            if (slot === SLOT_UNASSIGNED) continue;
            freq[slot] += refScopes[u].length;
            if (isTopLevel[u]) top += refScopes[u].length;
        }
        let now = 0;
        for (let u = 1; u < symbolCount; u++) {
            const slot = slots[u];
            if (slot === SLOT_UNASSIGNED) continue;
            now += refScopes[u].length * slotName[slot]!.length;
        }
        // Ideal: every slot competes in one frequency ranking, hottest slot takes `base54(0)`.
        const order = [...freq.keys()].sort((a, b) => freq[b] - freq[a]);
        let ideal = 0;
        for (let i = 0; i < order.length; i++) ideal += freq[order[i]] * base54(i).length;
        console.error(
            `[mangle] slots=${totalSlots} anchored=${slotName.filter((n, i) => n !== null && freq[i] > 0).length}` +
                ` topLevelUses=${top} identBytes now=${now} ideal=${ideal} ceiling=${now - ideal}`,
        );
    }

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
