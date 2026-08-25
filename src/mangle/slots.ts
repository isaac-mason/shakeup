// Slot assignment — the heart of the oxc-aligned slot-liveness mangler (P1).
//
// Faithful port of oxc_mangler `SlotAssignment::compute`
// (llm/libs/oxc/crates/oxc_mangler/src/lib.rs:562-727).
//
// A *slot* is an integer; two symbols share a slot exactly when their live ranges never overlap,
// so they can safely share one mangled name. We greedy-graph-colour the scope tree by liveness:
// walking scopes TOP-DOWN, each scope's bindings take slots that aren't live in it, allocating a
// fresh slot only when none is free. `slotLiveness[slot]` is the set of scopes the slot passes
// through live, so descendant scopes can tell what's free.
//
// Liveness definition (from the oxc code, NOT the loosely-illustrative doc example): for a symbol
// declared in `scopeId` and referenced in `useScope`, the slot is live in every scope on the path
// from `useScope` UP TO — but excluding — `scopeId`. So a symbol used only in its own declaration
// scope has EMPTY liveness (nothing below it), which is exactly what lets an outer name be reused
// by an inner local that doesn't reference it.
//
// ALIGNMENT NOTES vs oxc (`compute`), so nothing is silently omitted:
//   • declared/redeclared scopes — PORTED (see `declScopes`).
//   • named-function-expression orphan repair (oxc lib.rs:705-721) — NOT NEEDED here, verified:
//     oxc must repair the case where a body binding (`var foo`) overwrites the fn-expr's entry in
//     the binding map, orphaning the fn-expr symbol at SLOT_UNASSIGNED. shakeup's `declare`
//     (analysis/semantic.ts) RETURNS THE EXISTING symbol on a same-key collision (ORs the flags)
//     instead of minting a shadower, and a `var` in the body hoists to that same function scope —
//     so the two are ONE symbol and necessarily render as one name. That is exactly the outcome
//     oxc's repair produces, reached structurally rather than by patching afterwards.
//   • direct-`eval` scopes (oxc lib.rs:604-608: skip slot assignment AND reserve the binding names)
//     — this module has no `eval` concept by design; it is the CALLER's obligation to exclude such
//     scopes' bindings from `bindingsByScope` and add their names to the mangler's reserved set.
//     shakeup's semantic does not track direct eval today, so the adapter must detect it.

/** A symbol that keeps its name (kept / eval-visible / undeclared) — no slot. */
export const SLOT_UNASSIGNED = -1;

export interface SlotInput {
    /** Scope ids are `0 .. scopeCount-1`. REQUIRED: every scope's ancestors have SMALLER ids than
     *  it (ascending id order is a valid top-down walk). `root` is the top scope. */
    scopeCount: number;
    root: number;
    /** `parent[scope]` — parent scope id; `parent[root] === root`. */
    parent: readonly number[];
    /** Manglable symbol ids declared directly in each scope, in declaration order (ascending id).
     *  Kept / eval / import symbols are already excluded by the caller. */
    bindingsByScope: readonly (readonly number[])[];
    /** `refScopes[sym]` — the scopes in which symbol `sym` is referenced. */
    refScopes: readonly (readonly number[])[];
    /** `declScopes[sym]` — the scopes where the symbol's declaring identifier(s) PHYSICALLY appear
     *  (oxc `declared_scope_id` + `redeclared_scope_ids`, lib.rs:665-670). Differs from the owning
     *  scope for hoisted `var`: `function f() { { var x; } }` owns `x` in the function scope but
     *  declares it in the block, so the slot must be live in that block. Supply every declaration
     *  site (a `var` may be redeclared in several blocks). */
    declScopes: readonly (readonly number[])[];
    /** Size of the symbol-id space (length of the output `slots` array). */
    symbolCount: number;
}

export interface SlotResult {
    /** `slots[sym]` = assigned slot, or {@link SLOT_UNASSIGNED}. */
    slots: Int32Array;
    /** Number of distinct slots allocated. */
    totalSlots: number;
}

export function assignSlots(input: SlotInput): SlotResult {
    const { scopeCount, root, parent, bindingsByScope, refScopes, declScopes, symbolCount } = input;

    const slots = new Int32Array(symbolCount).fill(SLOT_UNASSIGNED);
    // slotLiveness[slot] = scopes the slot is live through (descendant scopes between a use and the
    // declaration, exclusive of the declaration scope).
    const slotLiveness: Set<number>[] = [];

    // Top-down: ascending id order is topological (ancestors have smaller ids).
    for (let scopeId = 0; scopeId < scopeCount; scopeId++) {
        const bindings = bindingsByScope[scopeId];
        if (bindings === undefined || bindings.length === 0) continue;

        // Reuse existing slots not live in this scope; allocate fresh ones for the remainder.
        const assigned: number[] = [];
        for (let s = 0; s < slotLiveness.length && assigned.length < bindings.length; s++) {
            if (!slotLiveness[s].has(scopeId)) assigned.push(s);
        }
        const remaining = bindings.length - assigned.length;
        const base = slotLiveness.length;
        for (let k = 0; k < remaining; k++) {
            assigned.push(base + k);
            slotLiveness.push(new Set());
        }

        // Ancestors of scopeId, EXCLUDING scopeId (the marking walk stops at these). Built by walking
        // `parent` straight into the Set: `ancestors()` would allocate the chain array, `.slice(1)`
        // a second array to drop the head, and the Set a third — three allocations per scope to hold
        // ~3 ids.
        const ancSet = new Set<number>();
        for (let a = scopeId; a !== root; ) {
            const p = parent[a];
            if (p === a) break;
            a = p;
            ancSet.add(a);
            if (a === root) break;
        }

        for (let i = 0; i < bindings.length; i++) {
            const sym = bindings[i];
            const slot = assigned[i];
            slots[sym] = slot;
            const liveness = slotLiveness[slot];

            // Mark the slot live from each use up to (excluding) the declaration scope.
            //
            // The ancestor walk is INLINED rather than going through `ancestors()`. That helper
            // materialises the whole chain into a fresh `number[]`, but this loop almost always
            // breaks after a step or two (at the declaration scope, or at an already-marked chain),
            // so the array was allocated and mostly discarded: 64,846 calls over a crashcat bundle,
            // averaging 3.0 links each. Walking `parent` directly allocates nothing and stops the
            // moment the condition hits. Termination is `ancestors`' own: stop at `root`, or where a
            // scope is its own parent.
            const mark = (useScope: number): void => {
                let anc = useScope;
                for (;;) {
                    if (anc === scopeId || ancSet.has(anc)) break; // reached declaration scope / above
                    if (liveness.has(anc)) break; // chain already marked
                    liveness.add(anc);
                    if (anc === root) break;
                    const p = parent[anc];
                    if (p === anc) break;
                    anc = p;
                }
            };
            // oxc marks: referenced ∪ redeclared ∪ {scope_id, declared_scope_id} (lib.rs:671-702).
            for (const u of refScopes[sym]) mark(u);
            for (const d of declScopes[sym]) mark(d);
            mark(scopeId); // the owning scope itself — breaks immediately (matches oxc's `[scope_id]`)
        }
    }

    return { slots, totalSlots: slotLiveness.length };
}
