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
import { N, type Node } from '../ast.ts';
import { base54 } from '../deconflict.ts';
import { hookTable, type TransformCtx, traverse, type Visitor } from '../passes/traverse.ts';
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

    // DERIVED FROM THE TREE, not read off the semantic. `Semantic` used to carry these as four flat
    // arrays filled by `analyze` — oxc's data model (`get_resolved_references(sym).scope_id` plus the
    // declaring and redeclaring scopes) — but nothing maintained them, and compress runs between that
    // `analyze` and this call. Measured on the chunk the mangler actually sees, 2,339 of crashcat's
    // symbols and 881 of three's had scopes that no longer described the tree.
    //
    // The direction was the safe one — oxc's own words (`compressor.rs:38`): "Stale *extra* references
    // cause missed optimizations (output stays correct); an *added* reference that was never recorded
    // can cause incorrect output." Ours were extras, so output stayed valid and was simply BIGGER:
    // references compress had deleted still forced symbols apart, so fewer shared a slot and names ran
    // longer. Deriving them here is worth 262 bytes on crashcat, 59 on three, 50 on three-consumer.
    //
    // oxc fixes the same staleness by rebuilding the WHOLE semantic for the mangler
    // (`oxc_minifier/src/lib.rs:157`) — which it needs regardless, for tables the compressor's build
    // lacks (`with_build_nodes`, `with_class_table`). Ours needs only these two, and building just
    // them measured 6.8ms against 19.0ms for a full re-`analyze`, with byte-identical output.
    const { refScopes, declScopes } = collectScopes(program, sem, symbolCount);

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

/**
 * The scopes each symbol is REFERENCED in and DECLARED in, from the current tree.
 *
 * `declScopes` is the scope the binding IDENTIFIER APPEARS in, which is NOT `symbols[sym].scope` —
 * that is the hoisted OWNER. oxc keeps the distinction for the same reason (`oxc_mangler/src/lib.rs`
 * :664, "`var` is hoisted, so include the scope where it is declared"). Redeclarations are included
 * because every `BindingIdentifier` is visited, matching oxc's `symbol_redeclarations`.
 *
 * Equivalence to the semantic-derived tables this replaced was checked BEFORE they were deleted: on a
 * freshly analyzed tree the two agree exactly, on both corpora. That control is what proved the
 * divergence after compress was real staleness and not a numbering difference between `traverse`'s
 * `currentScope` and `analyze`'s `state.scope`.
 */
function collectScopes(program: Node, sem: Semantic, symbolCount: number): { refScopes: number[][]; declScopes: number[][] } {
    const refScopes: number[][] = Array.from({ length: symbolCount }, () => []);
    const declScopes: number[][] = Array.from({ length: symbolCount }, () => []);
    const visitor: Visitor = {
        name: 'mangle-collect-scopes',
        enter: hookTable({
            [N.IdentifierReference]: (n: Node, ctx: TransformCtx) => {
                const sym = (n as { sym: number }).sym;
                if (sym > 0) refScopes[sym].push(ctx.currentScope);
            },
            [N.BindingIdentifier]: (n: Node, ctx: TransformCtx) => {
                const sym = (n as { sym: number }).sym;
                if (sym > 0) declScopes[sym].push(ctx.currentScope);
            },
        }),
        exit: null,
    };
    traverse(program, sem, [visitor]);
    return { refScopes, declScopes };
}
