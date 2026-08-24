// Must-be-reaching definitions — a port of Closure's `MustBeReachingVariableDef`
// (llm/closure/src/com/google/javascript/jscomp/MustBeReachingVariableDef.java).
//
// Closure's definition: "A definition of A in `A = foo()` is a must-be-reaching definition of the use
// of A in `alert(A)` if all paths from entry node to the use pass through that definition and it is the
// last definition before the use." Being a MUST analysis, the answer for a given use is always a single
// definition, and it dominates that use.
//
// THIS IS THE ANALYSIS THAT JUSTIFIES THE CFG. Unlike liveness — which shakeup also computes
// structurally, with the two provably identical — reaching definitions has no equally good structural
// implementation: the answer at a merge point depends on comparing what arrives along each incoming
// EDGE, which is the graph's whole reason for existing. It is also the input `FlowSensitiveInlineVariables`
// needs ("exactly one definition must reach the read").
//
// LATTICE, per variable, as a flat `Int32Array` slot (Closure uses a map; the encoding is the same
// three-level lattice):
//     TOP    (-2) — no information yet. Join identity: `join(TOP, x) = x`.
//     BOTTOM (-1) — MORE THAN ONE definition reaches here, so nothing can be concluded.
//     >= 0        — the CFG node id of the single definition that reaches.
// The ENTRY lattice maps every variable to the entry node: on entry a parameter holds its argument and
// a declared local holds `undefined`, and either way that is one known definition. The INITIAL estimate
// is TOP everywhere, so a not-yet-computed predecessor cannot pollute a merge.
//
// DEFINES and DEPENDS come from the SHARED `gen-kill.ts`: a "definition" is exactly a KILL (a definite
// whole-variable overwrite) and the definition's dependencies are exactly the GEN set of the same node.
// That reuse is the dividend of Phase 1 — the notion of a kill is now stated once and both the liveness
// and reaching-definition analyses inherit it, including the conditional-kill rule that suppresses a
// definition the node might not actually perform.
import { type Cfg } from './cfg.ts';
import { type DataflowSpec, solve } from './dataflow.ts';
import { genKill } from './gen-kill.ts';
import type { Node } from '../ast.ts';

/** No information — join identity. */
export const TOP = -2;
/** Several definitions reach; nothing can be concluded. */
export const BOTTOM = -1;

export type ReachingDefs = {
    /** Tracked symbol id → dense slot. */
    index: Map<number, number>;
    /**
     * The CFG node id of the single definition reaching the START of `stmt` for `sym`, or {@link TOP} /
     * {@link BOTTOM}. `TOP` also covers "`stmt` is not a CFG node" and "`sym` is not tracked".
     */
    defIn: (stmt: Node, sym: number) => number;
    /** As {@link defIn}, by CFG node id. */
    defInAt: (id: number, sym: number) => number;
    /** The symbols the definition at CFG node `id` READS — Closure's `Definition.depends`. */
    dependsOf: (id: number) => ReadonlySet<number>;
    /** The symbols CFG node `id` definitely defines. */
    definesOf: (id: number) => ReadonlySet<number>;
    steps: number;
};

export function computeReachingDefs(cfg: Cfg, tracked: ReadonlySet<number>): ReachingDefs {
    const index = new Map<number, number>();
    for (const s of tracked) index.set(s, index.size);
    const size = Math.max(index.size, 1);
    const n = cfg.value.length;

    // Per-node DEFINES and DEPENDS, computed once — they are a pure function of the node, so they are
    // hoisted out of the fixed point exactly as the liveness gen/kill sets are.
    const defines: Set<number>[] = new Array(n);
    const depends: Set<number>[] = new Array(n);
    const EMPTY: ReadonlySet<number> = new Set<number>();
    for (let id = 0; id < n; id++) {
        const node = cfg.value[id];
        if (node === null) continue;
        const defs = new Set<number>();
        const deps = new Set<number>();
        genKill(
            node,
            tracked,
            false,
            (s) => deps.add(s),
            (s) => defs.add(s),
        );
        if (defs.size > 0) defines[id] = defs;
        if (deps.size > 0) depends[id] = deps;
    }

    // Defined slots per node, as a flat list — used to compute each slot's FINAL value in one pass.
    const defSlots: Int32Array[] = new Array(n);
    for (let id = 0; id < n; id++) {
        const defs = defines[id];
        if (defs === undefined) continue;
        const slots: number[] = [];
        for (const sym of defs) {
            const slot = index.get(sym);
            if (slot !== undefined) slots.push(slot);
        }
        if (slots.length > 0) defSlots[id] = Int32Array.from(slots);
    }
    // Generation-stamped marker, so "is this slot defined at this node" is O(1) without clearing.
    const mark = new Int32Array(size);
    let stamp = 0;

    const spec: DataflowSpec<Int32Array> = {
        forward: true,
        alloc: () => new Int32Array(size).fill(TOP),
        // On entry every variable has exactly one "definition": its incoming value (an argument for a
        // parameter, `undefined` for a declared local). Closure maps each var to the scope root node.
        boundary: (dst) => dst.fill(cfg.entry),
        copy: (dst, src) => dst.set(src),
        joinInto: (dst, src) => {
            for (let i = 0; i < size; i++) {
                const a = dst[i];
                const b = src[i];
                if (a === b) continue;
                // TOP is the identity; disagreement collapses to BOTTOM. (Closure `mergeVarDef`.)
                dst[i] = a === TOP ? b : b === TOP ? a : BOTTOM;
            }
        },
        transfer: (dst, src, _node, id) => {
            // ⚠ Each slot's FINAL value is computed and compared ONCE. Copying `src` wholesale and then
            // overwriting the defined slots looks equivalent and is NOT: the copy writes a transient
            // value into a slot the second step immediately replaces, so a defining node reports
            // "changed" on EVERY sweep and the analysis never converges. That cost a full debugging pass
            // here (6,842 visits per node) and is the SECOND time this exact shape has bitten — see the
            // signed/unsigned note on `DataflowSpec.transfer`. Never write an intermediate value you are
            // about to overwrite.
            const slots = defSlots[id];
            stamp++;
            if (slots !== undefined) for (let k = 0; k < slots.length; k++) mark[slots[k]] = stamp;
            let changed = false;
            for (let i = 0; i < size; i++) {
                const v = mark[i] === stamp ? id : src[i];
                if (dst[i] !== v) {
                    dst[i] = v;
                    changed = true;
                }
            }
            return changed;
        },
    };

    const { inAt, steps } = solve(cfg, spec);

    const defInAt = (id: number, sym: number): number => {
        const slot = index.get(sym);
        if (slot === undefined || id < 0 || id >= n) return TOP;
        return inAt[id][slot];
    };

    return {
        index,
        steps,
        defInAt,
        defIn: (stmt, sym) => {
            const id = cfg.idOf.get(stmt);
            return id === undefined ? TOP : defInAt(id, sym);
        },
        dependsOf: (id) => depends[id] ?? EMPTY,
        definesOf: (id) => defines[id] ?? EMPTY,
    };
}
