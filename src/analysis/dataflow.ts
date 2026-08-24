// Generic dataflow framework — a port of Closure's `DataFlowAnalysis`
// (llm/closure/src/com/google/javascript/jscomp/DataFlowAnalysis.java).
//
// THIS is the part worth evaluating. The claim under test is that the elegance people attribute to
// "having a CFG" actually belongs to the FRAMEWORK — you supply a lattice, a transfer function and a
// direction, and control flow is handled once, generically — and that the graph is merely one possible
// input representation for it. Closure separates the two (`DataFlowAnalysis` vs `ControlFlowGraph`), so
// the separation is the oracle's own, not an invention here.
//
// An analysis supplies five things (Closure's exact set, its docs quoted):
//   • "Flow Direction: Implement isForward()"
//   • "Flow Equations: Implement flowThrough(Object, LatticeElement)"
//   • "Initial Entry Value: Implement createEntryLattice()"
//   • "Initial Estimate: Implement createInitialEstimateLattice()"
//   • a join operator (Closure `createFlowJoiner`)
// plus equality, which Java gets from `equals` and TS has to be handed explicitly.
//
// SOLVER: a work queue. Pop a node, join its inputs, run the transfer function; if its output changed,
// enqueue the nodes it feeds (successors when forward, predecessors when backward). The implicit-return
// node is never enqueued. This is Closure's `analyze()` verbatim, including the divergence guard.
import { type Cfg, IMPLICIT_RETURN } from './cfg.ts';
import type { Node } from '../ast.ts';

/** Closure's `MAX_STEPS_PER_NODE` — a divergence guard, not a precision knob. Its own comment calls
 *  20000 "way too high"; a monotone lattice of bounded height converges long before this. */
export const MAX_STEPS_PER_NODE = 20000;

export type DataflowSpec<L> = {
    /** false ⇒ backward (liveness). Closure `isForward()`. */
    forward: boolean;
    /** Lattice value at the graph's boundary. Closure `createEntryLattice()`. */
    entry: () => L;
    /** Optimistic starting value for every other node. Closure `createInitialEstimateLattice()`. */
    initial: () => L;
    /** Meet/join over incoming edges. Closure `createFlowJoiner()`. */
    join: (values: L[]) => L;
    /** The transfer function: the lattice value on the other side of `node`. */
    flowThrough: (node: Node, input: L, cfgId: number) => L;
    /** Fixed-point test. */
    equals: (a: L, b: L) => boolean;
};

export type DataflowResult<L> = {
    /** `inAt[id]` / `outAt[id]` — lattice values on each side of CFG node `id`. For a BACKWARD analysis
     *  `outAt` is the value AFTER the node and `inAt` the value before it, matching Closure. */
    inAt: L[];
    outAt: L[];
    /** Work-queue pops performed — the honest cost measure for a solver comparison. */
    steps: number;
};

/** Solve `spec` over `cfg` to a fixed point. Closure `DataFlowAnalysis.analyze()`. */
export function solve<L>(cfg: Cfg, spec: DataflowSpec<L>): DataflowResult<L> {
    const n = cfg.value.length;
    const inAt: L[] = new Array(n);
    const outAt: L[] = new Array(n);
    for (let i = 0; i < n; i++) {
        inAt[i] = spec.initial();
        outAt[i] = spec.initial();
    }

    // Closure uses a UniqueQueue: FIFO, but a node already queued is not queued twice.
    const queued = new Uint8Array(n);
    const queue: number[] = [];
    let head = 0;
    const push = (id: number): void => {
        if (id === IMPLICIT_RETURN || queued[id] === 1) return;
        queued[id] = 1;
        queue.push(id);
    };

    // Seed EVERY node except the implicit return — Closure `initialize()` does exactly this, and it is
    // not an optimisation detail but a correctness one. Seeding only the exits looks natural for a
    // backward analysis and is WRONG: a node whose recomputed value equals its optimistic initial value
    // reports "unchanged" and so never propagates, leaving everything upstream of it at the initial
    // estimate. (That bug was live here until the equivalence harness caught it on `if/else`.)
    for (let i = 1; i < n; i++) push(i);

    const stepCount = new Int32Array(n);
    let steps = 0;

    while (head < queue.length) {
        const id = queue[head++];
        queued[id] = 0;
        if (head > 4096 && head * 2 > queue.length) {
            queue.splice(0, head); // keep the array from growing without bound on long runs
            head = 0;
        }
        steps++;
        if (++stepCount[id] > MAX_STEPS_PER_NODE) throw new Error('dataflow diverged');

        // joinInputs
        if (spec.forward && id === cfg.entry) {
            inAt[id] = spec.entry();
        } else {
            const incoming = spec.forward ? cfg.pred[id] : cfg.succ[id];
            if (incoming.length === 1) {
                const src = incoming[0];
                const v = spec.forward ? outAt[src] : inAt[src];
                if (spec.forward) inAt[id] = v;
                else outAt[id] = v;
            } else if (incoming.length > 1) {
                const vals: L[] = new Array(incoming.length);
                for (let k = 0; k < incoming.length; k++) {
                    const src = incoming[k];
                    vals[k] = spec.forward ? outAt[src] : inAt[src];
                }
                const j = spec.join(vals);
                if (spec.forward) inAt[id] = j;
                else outAt[id] = j;
            } else if (!spec.forward) {
                // No successors at all — an exit node. Its out-value is the boundary.
                outAt[id] = spec.entry();
            }
        }

        // flow
        const value = cfg.value[id];
        let changed: boolean;
        if (spec.forward) {
            const before = outAt[id];
            outAt[id] = value === null ? before : spec.flowThrough(value, inAt[id], id);
            changed = !spec.equals(before, outAt[id]);
        } else {
            const before = inAt[id];
            inAt[id] = value === null ? before : spec.flowThrough(value, outAt[id], id);
            changed = !spec.equals(before, inAt[id]);
        }

        if (changed) for (const next of spec.forward ? cfg.succ[id] : cfg.pred[id]) push(next);
    }

    return { inAt, outAt, steps };
}
