// Generic dataflow framework — Closure's `DataFlowAnalysis`
// (llm/closure/src/com/google/javascript/jscomp/DataFlowAnalysis.java), tuned for JS.
//
// An analysis still supplies Closure's five things — direction, transfer, boundary value, initial
// estimate, join — so the framework stays generic and the control-flow knowledge lives once, in the
// CFG. Two deliberate departures from a literal transcription, both measured:
//
//  1. MUTABLE LATTICE CONTRACT. Closure's `flowThrough` RETURNS a fresh lattice element, so every step
//     allocates (`new LiveVariableLattice(input)`). Here the spec writes into a caller-owned buffer
//     (`transfer(dst, src, …)`, `joinInto(dst, src)`), so a solve allocates O(nodes) once instead of
//     O(steps). Java's escape analysis and generational GC make the pure version cheap there; on V8 it
//     is the single largest cost in the solver.
//
//  2. RPO SWEEPS instead of a FIFO work queue. Closure pops from a `UniqueQueue` and exposes an
//     optional priority comparator (`getOptionalNodeComparator`) that its callers largely leave unset;
//     a FIFO in node-creation order re-processes each node ~3x. Sweeping in reverse-postorder (for a
//     backward analysis, postorder) propagates along the natural direction of the graph, so a
//     structured function typically converges in two sweeps: one to compute, one to confirm.
//     Both are worklist algorithms over the same lattice — this changes only the visit ORDER, which
//     affects how fast the fixed point is reached and never what it is.
import { type Cfg, IMPLICIT_RETURN } from './cfg.ts';
import type { Node } from '../ast.ts';

/** Divergence guard (Closure's `MAX_STEPS_PER_NODE`), expressed as whole sweeps. */
export const MAX_SWEEPS = 10_000;

export type DataflowSpec<L> = {
    /** false ⇒ backward (liveness). Closure `isForward()`. */
    forward: boolean;
    /** Allocate one lattice element, at the initial estimate. Closure `createInitialEstimateLattice()`. */
    alloc: () => L;
    /** `dst := src`. */
    copy: (dst: L, src: L) => void;
    /** `dst := dst ⊔ src`. Closure `createFlowJoiner()`, accumulating rather than allocating. */
    joinInto: (dst: L, src: L) => void;
    /** `dst := boundary`. Closure `createEntryLattice()`. */
    boundary: (dst: L) => void;
    /**
     * `dst := transfer(src)` for CFG node `id`, RETURNING whether `dst` changed. Closure's
     * `flowThrough` returns a fresh element and the solver compares it against the old one; detecting
     * the change while writing folds the allocation, the copy and the compare into one pass.
     *
     * ⚠ IF THE LATTICE IS A TYPED ARRAY, COERCE THE COMPUTED VALUE WITH `>>> 0` BEFORE COMPARING.
     * JS bitwise operators yield a SIGNED int32 while a `Uint32Array` read is UNSIGNED, so for any
     * value with the high bit set `dst[w] !== v` is true even though the bits are identical. The store
     * coerces, so the value never actually changes — the node reports "changed" on every sweep forever
     * and the analysis only terminates by hitting the sweep cap, WITH THE CORRECT ANSWER. That bug cost
     * a full debugging session here (2.59 → 464 visits/node); it will silently ruin any future analysis
     * that repeats it.
     */
    transfer: (dst: L, src: L, node: Node, id: number) => boolean;
};

export type DataflowResult<L> = {
    inAt: L[];
    outAt: L[];
    /** Node visits performed — the honest cost measure when comparing solvers. */
    steps: number;
};

/**
 * Reverse postorder from the entry, then any nodes the entry cannot reach (unreachable code still
 * needs a defined answer). Postorder is computed iteratively — a recursive DFS blows the stack on the
 * long statement chains a minified bundle produces.
 */
function reversePostorder(cfg: Cfg): Int32Array {
    const n = cfg.value.length;
    const seen = new Uint8Array(n);
    const post: number[] = [];
    const stack: number[] = [];
    const next = new Int32Array(n); // per-node successor cursor

    const dfs = (from: number): void => {
        if (seen[from] === 1) return;
        seen[from] = 1;
        stack.push(from);
        next[from] = 0;
        while (stack.length > 0) {
            const id = stack[stack.length - 1];
            const succ = cfg.succ[id];
            if (next[id] < succ.length) {
                const s = succ[next[id]++];
                if (seen[s] === 0) {
                    seen[s] = 1;
                    next[s] = 0;
                    stack.push(s);
                }
            } else {
                post.push(id);
                stack.pop();
            }
        }
    };

    dfs(cfg.entry);
    for (let i = 1; i < n; i++) dfs(i);
    dfs(IMPLICIT_RETURN);

    const order = new Int32Array(post.length);
    for (let i = 0; i < post.length; i++) order[i] = post[post.length - 1 - i];
    return order;
}

/** Solve `spec` over `cfg` to a fixed point. */
export function solve<L>(cfg: Cfg, spec: DataflowSpec<L>): DataflowResult<L> {
    const n = cfg.value.length;
    const inAt: L[] = new Array(n);
    const outAt: L[] = new Array(n);
    for (let i = 0; i < n; i++) {
        inAt[i] = spec.alloc();
        outAt[i] = spec.alloc();
    }
    const rpo = reversePostorder(cfg);
    // A backward analysis propagates against the edges, so it visits in postorder.
    const order = spec.forward ? rpo : Int32Array.from(rpo).reverse();

    const scratch = spec.alloc();
    let steps = 0;

    for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
        let changed = false;
        for (let k = 0; k < order.length; k++) {
            const id = order[k];
            if (id === IMPLICIT_RETURN) continue;
            steps++;

            // joinInputs
            if (spec.forward && id === cfg.entry) {
                spec.boundary(inAt[id]);
            } else {
                const incoming = spec.forward ? cfg.pred[id] : cfg.succ[id];
                const target = spec.forward ? inAt[id] : outAt[id];
                if (incoming.length === 0) {
                    if (!spec.forward) spec.boundary(target);
                } else if (incoming.length === 1) {
                    // The common case in structured code — join straight into the target instead of
                    // through the scratch buffer, halving the copies.
                    spec.copy(target, spec.forward ? outAt[incoming[0]] : inAt[incoming[0]]);
                } else {
                    spec.copy(scratch, spec.forward ? outAt[incoming[0]] : inAt[incoming[0]]);
                    for (let j = 1; j < incoming.length; j++) {
                        const src = incoming[j];
                        spec.joinInto(scratch, spec.forward ? outAt[src] : inAt[src]);
                    }
                    spec.copy(target, scratch);
                }
            }

            // flow
            const value = cfg.value[id];
            if (value === null) continue;
            const target = spec.forward ? outAt[id] : inAt[id];
            const source = spec.forward ? inAt[id] : outAt[id];
            if (spec.transfer(target, source, value, id)) changed = true;
        }
        if (!changed) break;
    }

    return { inAt, outAt, steps };
}
