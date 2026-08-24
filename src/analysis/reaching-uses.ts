// Maybe-reaching (upward-exposed) uses — a port of Closure's `MaybeReachingVariableUse`
// (llm/closure/src/com/google/javascript/jscomp/MaybeReachingVariableUse.java).
//
// A BACKWARD MAY analysis, the mirror of the forward MUST analysis in `reaching-defs.ts`. At each point
// it answers, per variable: which USES might the current value flow into? A use is "upward exposed" at
// a node when some path forward from that node reaches the use without redefining the variable first.
//
// This is the second half of what `FlowSensitiveInlineVariables` needs. Reaching-defs tells it "exactly
// one definition reaches this use"; reaching-uses tells it "this definition's value has exactly one
// use", which is the condition for moving the definition's RHS into that use. Two dataflow results,
// opposite directions, both required — Closure runs them as a pair for exactly this reason.
//
// TRANSFER (backward, so out → in): starting from what may be used AFTER the node,
//   • a READ of v at this node ADDS this node as an upward-exposed use of v (gen);
//   • a DEFINITE UNCONDITIONAL definition of v REMOVES every use of v (kill) — the value being used
//     downstream cannot be this one, a later store shadows it. A CONDITIONAL definition (the node may
//     throw part-way, or the write is inside a short-circuit / ternary arm) does NOT remove uses, since
//     the write might not happen. This is the same conditional-kill rule liveness and reaching-defs use,
//     and it comes from the SAME shared `gen-kill.ts` — a use is a GEN, a definition is a KILL.
// Because kill runs before gen within a node, `v = v + 1` both reads and (re)defines v: the read at
// this node stays exposed, earlier uses are cut. That is what `gen-kill.ts` already encodes.
//
// LATTICE: per variable, the SET of CFG node ids that are upward-exposed uses. The join is UNION (MAY),
// so a use exposed on any successor path is exposed here. Stored as a bitset over CFG nodes per
// tracked variable — dense, and the union is word-wise OR.
import { BRANCH, type Cfg } from './cfg.ts';
import { type DataflowSpec, solve } from './dataflow.ts';
import { genKill } from './gen-kill.ts';

export type ReachingUses = {
    index: Map<number, number>;
    /** The CFG node ids that are upward-exposed uses of `sym` at the START of CFG node `id`. */
    usesInAt: (id: number, sym: number) => number[];
    /** As {@link usesInAt}, at the point immediately AFTER `id` (its live-out edge). */
    usesOutAt: (id: number, sym: number) => number[];
    steps: number;
};

const words = (count: number): number => (count + 31) >>> 5;

export function computeReachingUses(cfg: Cfg, tracked: ReadonlySet<number>): ReachingUses {
    const index = new Map<number, number>();
    for (const s of tracked) index.set(s, index.size);
    const nVars = Math.max(index.size, 1);
    const n = cfg.value.length;
    const W = words(n); // one bit per CFG node

    // The lattice is `nVars` bitsets of `W` words each, laid out flat: var v occupies [v*W .. v*W+W).
    const stride = nVars * W;

    // Per-node reads (gen) and definite definitions (kill), as tracked-symbol slots. Hoisted out of the
    // fixed point — pure functions of the node, from the shared gen/kill rules.
    const reads: number[][] = new Array(n);
    const kills: number[][] = new Array(n);
    for (let id = 1; id < n; id++) {
        const node = cfg.value[id];
        if (node === null) continue;
        // A node with an exception edge out may not complete, so its definitions are only maybe-kills:
        // pass `conditional = true` and gen/kill emits gens only. (Closure `hasExceptionHandler`.)
        let conditional = false;
        for (const b of cfg.succBranch[id])
            if (b === BRANCH.ON_EX) {
                conditional = true;
                break;
            }
        const g: number[] = [];
        const k: number[] = [];
        genKill(
            node,
            tracked,
            conditional,
            (s) => {
                const slot = index.get(s);
                if (slot !== undefined) g.push(slot);
            },
            (s) => {
                const slot = index.get(s);
                if (slot !== undefined) k.push(slot);
            },
        );
        if (g.length > 0) reads[id] = g;
        if (k.length > 0) kills[id] = k;
    }

    const spec: DataflowSpec<Uint32Array> = {
        forward: false,
        alloc: () => new Uint32Array(stride),
        boundary: (dst) => dst.fill(0),
        copy: (dst, src) => dst.set(src),
        joinInto: (dst, src) => {
            for (let i = 0; i < stride; i++) dst[i] |= src[i];
        },
        transfer: (dst, src, _node, id) => {
            // in := (out − kill) ∪ gen, computed and compared ONCE per word. A previous version cleared
            // a killed variable's words to 0 and THEN OR-ed the gen bit back in — for a self-referential
            // store (`x = x + 1`, which both kills and reads x) the final value equalled the previous
            // one, but writing 0 then the bit made `changed` fire every sweep and the analysis never
            // converged (fourth instance of this exact trap — see `DataflowSpec.transfer`). The fix is
            // to fold kill and gen into the per-word target before the single comparison.
            const k = kills[id];
            const g = reads[id];
            const killed = k === undefined ? null : new Set(k);
            const genWord = id >>> 5;
            const genMask = 1 << (id & 31);
            const genVars = g === undefined ? null : new Set(g);
            let changed = false;
            for (let v = 0; v < nVars; v++) {
                const base = v * W;
                const clear = killed !== null && killed.has(v);
                const gen = genVars !== null && genVars.has(v);
                for (let w = 0; w < W; w++) {
                    let value = clear ? 0 : src[base + w];
                    if (gen && w === genWord) value = (value | genMask) >>> 0;
                    if (dst[base + w] !== value) {
                        dst[base + w] = value;
                        changed = true;
                    }
                }
            }
            return changed;
        },
    };

    const { inAt, outAt, steps } = solve(cfg, spec);

    const decode = (bits: Uint32Array, slot: number): number[] => {
        const out: number[] = [];
        const base = slot * W;
        for (let w = 0; w < W; w++) {
            let word = bits[base + w];
            while (word !== 0) {
                const lsb = word & -word;
                out.push((w << 5) + (31 - Math.clz32(lsb)));
                word ^= lsb;
            }
        }
        return out;
    };

    return {
        index,
        steps,
        usesInAt: (id, sym) => {
            const slot = index.get(sym);
            if (slot === undefined || id < 0 || id >= n) return [];
            return decode(inAt[id], slot);
        },
        usesOutAt: (id, sym) => {
            const slot = index.get(sym);
            if (slot === undefined || id < 0 || id >= n) return [];
            return decode(outAt[id], slot);
        },
    };
}
