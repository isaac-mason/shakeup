// Live-variable analysis expressed as a TRANSFER FUNCTION over the generic dataflow framework —
// a port of Closure's `LiveVariablesAnalysis`
// (llm/closure/src/com/google/javascript/jscomp/LiveVariablesAnalysis.java).
//
// The point of this file is the comparison it enables. `analysis/liveness.ts` computes the same answer
// by a hand-written structural recursion that fuses control flow INTO the analysis (14 statement arms,
// a break/continue target stack, a loop fixed point). Here the control-flow knowledge lives in
// `cfg.ts`, the solver in `dataflow.ts`, and what remains is only what liveness itself means:
//
//     L_in = (L_out - KILL) ∪ GEN
//
// LATTICE: a bitset over a dense per-function variable index, exactly as Closure does
// (`LiveVariableLattice` wraps a `java.util.BitSet`). `liveness.ts` allocates a `Set<number>` per
// statement instead, which is the single biggest cost difference between the two and is INDEPENDENT of
// the CFG-vs-structural question — either design can use either representation.
//
// CONDITIONAL KILLS: Closure's precision trick, and the one that needs exception edges. If a node has
// an ON_EX out-edge it may terminate part-way, so its assignments MIGHT NOT happen — the kill is
// dropped and only the gen survives. A structural analysis that bails on `try` cannot express this at
// all; it is the concrete capability the graph buys.
import { BRANCH, type Cfg } from './cfg.ts';
import { genKill } from './gen-kill.ts';
import { type DataflowSpec, solve } from './dataflow.ts';
import type { Node } from '../ast.ts';

/** A dense bitset over the tracked-variable index space. */
export type LiveSet = Uint32Array;

const words = (count: number): number => (count + 31) >>> 5;

export const bitGet = (s: LiveSet, i: number): boolean => (s[i >>> 5] & (1 << (i & 31))) !== 0;
const bitSet = (s: LiveSet, i: number): void => {
    s[i >>> 5] |= 1 << (i & 31);
};

export type LiveVarsResult = {
    /** Tracked symbol id → dense bit index. */
    index: Map<number, number>;
    /** `liveOut(stmt)` — the tracked symbols live immediately AFTER `stmt`, or null if not a CFG node. */
    liveOut: (stmt: Node) => ReadonlySet<number> | null;
    steps: number;
    /** Raw lattice, for consumers that work on bits rather than sets (the interference graph builder
     *  compares every live PAIR at every node, which is far too hot for `Set` materialisation).
     *  `inBits[id*words .. +words]` are the symbols live BEFORE CFG node `id`; `outBits` after it. */
    inBits: Uint32Array;
    outBits: Uint32Array;
    /** Words per lattice element. */
    words: number;
    /** Bit index → tracked symbol id. */
    symbolAt: number[];
    /** `killBits[id*words .. +words]` — symbols this node definitely overwrites. A variable DEFINED at
     *  a node overlaps everything live across that node, which live-in/live-out pairs alone miss
     *  (Closure recovers it with `LiveRangeChecker`). */
    killBits: Uint32Array;
};

/**
 * Live-out sets for every CFG node of `cfg`, over `tracked`. `alwaysLive` (escaped/captured symbols)
 * are live everywhere — Closure's `escaped` set, and the same rule `liveness.ts` already implements.
 *
 * GEN/KILL ARE PRECOMPUTED, once per CFG node. Closure calls `computeGenKill` inside `flowThrough`, so
 * it re-walks the AST subtree on every visit — with a work queue re-processing each node ~3x that is
 * three AST walks per node to recover a value that cannot change. They are a pure function of the
 * node, so they are hoisted out of the fixed point entirely and the solver reduces to bit arithmetic:
 *
 *     L_in = (L_out & ~KILL) | GEN
 */
export function computeLiveVars(
    cfg: Cfg,
    tracked: ReadonlySet<number>,
    alwaysLive: ReadonlySet<number>,
): LiveVarsResult {
    const index = new Map<number, number>();
    for (const s of tracked) index.set(s, index.size);
    const W = words(Math.max(index.size, 1));
    const n = cfg.value.length;

    // The boundary value: nothing is live at an exit except what escaped.
    const boundary = new Uint32Array(W);
    for (const s of alwaysLive) {
        const i = index.get(s);
        if (i !== undefined) bitSet(boundary, i);
    }

    // One flat buffer for all gen sets and one for all kills — `nodeGen[id*W .. id*W+W]`. Flat typed
    // arrays rather than an array of arrays: one allocation, and the solver's hot loop reads them with
    // a computed offset instead of chasing a pointer per node.
    const nodeGen = new Uint32Array(n * W);
    const nodeKill = new Uint32Array(n * W);

    for (let id = 1; id < n; id++) {
        const node = cfg.value[id];
        if (node === null) continue;
        // A node with an exception edge out may terminate part-way, so its assignments MIGHT not
        // happen: they gen but do not kill (Closure's `conditional`).
        let conditional = false;
        for (const b of cfg.succBranch[id])
            if (b === BRANCH.ON_EX) {
                conditional = true;
                break;
            }
        const base = id * W;
        genKill(
            node,
            tracked,
            conditional,
            (sym) => {
                const i = index.get(sym);
                if (i !== undefined) nodeGen[base + (i >>> 5)] |= 1 << (i & 31);
            },
            (sym) => {
                const i = index.get(sym);
                if (i !== undefined) nodeKill[base + (i >>> 5)] |= 1 << (i & 31);
            },
        );
    }

    const spec: DataflowSpec<LiveSet> = {
        forward: false,
        alloc: () => boundary.slice(),
        copy: (dst, src) => {
            dst.set(src);
        },
        joinInto: (dst, src) => {
            for (let w = 0; w < W; w++) dst[w] |= src[w];
        },
        boundary: (dst) => {
            dst.set(boundary);
        },
        transfer: (dst, src, _node, id) => {
            const base = id * W;
            let ch = false;
            for (let w = 0; w < W; w++) {
                const v = ((src[w] & ~nodeKill[base + w]) | nodeGen[base + w]) >>> 0;
                if (dst[w] !== v) {
                    dst[w] = v;
                    ch = true;
                }
            }
            return ch;
        },
    };

    const { inAt, outAt, steps } = solve(cfg, spec);
    const rev: number[] = new Array(index.size);
    for (const [sym, i] of index) rev[i] = sym;

    // Flatten the per-node lattices into one buffer each, so consumers can scan words directly.
    const inBits = new Uint32Array(n * W);
    const outBits = new Uint32Array(n * W);
    for (let id = 0; id < n; id++) {
        inBits.set(inAt[id], id * W);
        outBits.set(outAt[id], id * W);
    }

    return {
        index,
        steps,
        inBits,
        outBits,
        words: W,
        symbolAt: rev,
        killBits: nodeKill,
        liveOut: (stmt: Node) => {
            const id = cfg.idOf.get(stmt);
            if (id === undefined) return null;
            const bits = outAt[id];
            const out = new Set<number>();
            for (let i = 0; i < rev.length; i++) if (bitGet(bits, i)) out.add(rev[i]);
            return out;
        },
    };
}
