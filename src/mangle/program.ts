// Mangle ONE standalone program — the chunk, after the cosmetic tier has run over it.
//
// WHY A SECOND MANGLER. `mangle/chunk.ts` mangles a chunk that does not exist yet as a single tree:
// it unifies the scope and symbol spaces of N per-module semantics so it can reason chunk-wide while
// the modules are still separate. That unification exists ONLY because mangling currently happens
// before the chunk is assembled. Once the cosmetic tier runs over an assembled chunk, the chunk IS
// one program with one semantic, and the unification has nothing left to do — so this adapter is
// strictly simpler than that one, not an extra copy of it.
//
// WHY IT MUST RUN AFTER COMPRESS. Mangling hands out 54 one-character names by frequency. Run it
// first and the compressor then deletes variables whose short names are already spent — measured on
// crashcat, chunk-level compress is 2,359 bytes SMALLER with mangling off but 535 bytes BIGGER with
// it on, purely from that ordering. Every peer mangles inside the minifier, last: oxc's `Minifier`
// owns its mangler, and rolldown's `minify_chunks` runs that whole thing.
//
// `assignSlots` is reused verbatim — its `SlotInput` was already free of any graph/module notion.
import { type Semantic, scopeOf } from '../analysis/semantic.ts';
import type { Node } from '../ast.ts';
import { base54 } from '../deconflict.ts';
import { assignSlots, SLOT_UNASSIGNED } from './slots.ts';

/**
 * Rename every manglable binding in `program`. Returns `symbol id → new name`; the printer applies it
 * through `nameOf`, so `export { local as exported }` keeps its external name automatically.
 *
 * `reserved` is every name the result must avoid — globals the chunk references, plus anything the
 * caller wants left alone.
 */
export function mangleProgram(program: Node, sem: Semantic, reserved: Set<string>): Map<number, string> {
    const out = new Map<number, string>();
    // Direct `eval` can see every binding by its source name (oxc reserves per-scope, lib.rs:604-608).
    // shakeup's semantic does not track it, so bail for the whole program — correctness over precision,
    // the same call `mangle/chunk.ts` makes.
    for (const node of sem.unresolved) {
        if (node.name === 'eval') return out;
        reserved.add(node.name);
    }

    const root = scopeOf(sem, program);
    const scopeCount = sem.scopes.length;
    const parent = new Array<number>(scopeCount);
    for (let s = 0; s < scopeCount; s++) parent[s] = s === root ? root : sem.scopes[s].parent;

    const symbolCount = sem.symbols.length;
    const bindingsByScope: number[][] = Array.from({ length: scopeCount }, () => []);
    for (let sym = 1; sym < symbolCount; sym++) {
        const rec = sem.symbols[sym];
        if (rec.decl === null) continue; // retired, or never declared here
        bindingsByScope[rec.scope]?.push(sym);
    }

    // READ OFF THE SEMANTIC — oxc's shape exactly (`oxc_mangler/src/lib.rs:665-672`, which reads
    // `get_resolved_references(sym).scope_id` plus the declaring and redeclaring scopes and never
    // walks the AST). The caller must hand us a semantic built FROM THE TREE WE ARE MANGLING: oxc
    // builds a second, fresh one for precisely this (`oxc_minifier/src/lib.rs:157`), because its
    // compressor maintains references across add/remove but never updates a reference's scope when a
    // subtree relocates — `Reference::scope_id` has no setter anywhere in either crate.
    if (sem.refPairs === null || sem.declPairs === null)
        throw new Error('mangleProgram needs a semantic built with createSemantic(true) — see chunk-compress.ts');
    const refScopes: number[][] = Array.from({ length: symbolCount }, () => []);
    const declScopes: number[][] = Array.from({ length: symbolCount }, () => []);
    // Pairs are [nodeId, scope, ...]; the mangler wants the scopes.
    for (let sym = 1; sym < symbolCount; sym++) {
        const rp = sem.refPairs[sym];
        if (rp !== undefined) for (let i = 1; i < rp.length; i += 2) refScopes[sym].push(rp[i]);
        const dp = sem.declPairs[sym];
        if (dp !== undefined) for (let i = 1; i < dp.length; i += 2) declScopes[sym].push(dp[i]);
    }

    const { slots, totalSlots } = assignSlots({ scopeCount, root, parent, bindingsByScope, refScopes, declScopes, symbolCount });

    // oxc Phase 3 (`SlotRanking::tally`): rank slots by REFERENCE FREQUENCY and hand out names
    // hottest-first, because base54 names get longer as they are consumed.
    const freq = new Float64Array(totalSlots);
    for (let sym = 1; sym < symbolCount; sym++) {
        const slot = slots[sym];
        if (slot !== SLOT_UNASSIGNED) freq[slot] += refScopes[sym].length;
    }
    const order = [...freq.keys()].sort((a, b) => freq[b] - freq[a]);
    const slotName = new Array<string>(totalSlots);
    let next = 0;
    for (const slot of order) {
        let name = base54(next++);
        while (reserved.has(name)) name = base54(next++);
        slotName[slot] = name;
    }

    for (let sym = 1; sym < symbolCount; sym++) {
        const slot = slots[sym];
        if (slot !== SLOT_UNASSIGNED) out.set(sym, slotName[slot]);
    }
    return out;
}
