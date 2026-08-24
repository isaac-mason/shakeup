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
import { type DataflowSpec, solve } from './dataflow.ts';
import { N, type Node, walkChildren } from '../ast.ts';

/** A dense bitset over the tracked-variable index space. */
export type LiveSet = Uint32Array;

const words = (count: number): number => (count + 31) >>> 5;

export const bitGet = (s: LiveSet, i: number): boolean => (s[i >>> 5] & (1 << (i & 31))) !== 0;
const bitSet = (s: LiveSet, i: number): void => {
    s[i >>> 5] |= 1 << (i & 31);
};

const eqSet = (a: LiveSet, b: LiveSet): boolean => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
};

export type LiveVarsResult = {
    /** Tracked symbol id → dense bit index. */
    index: Map<number, number>;
    /** `liveOut(stmt)` — the tracked symbols live immediately AFTER `stmt`, or null if not a CFG node. */
    liveOut: (stmt: Node) => ReadonlySet<number> | null;
    steps: number;
};

/**
 * GEN/KILL for one CFG node — a port of Closure's `computeGenKill`
 * (LiveVariablesAnalysis.java:252). The node-role awareness here is essential and is what a naive
 * "walk the whole subtree" version gets wrong: a CFG node for an `if` or a loop represents ONLY its
 * condition (the branches are their own CFG nodes), and a block represents nothing at all.
 *
 * `conditional` means the assignments encountered might not actually happen, so they gen but do not
 * kill. It starts true when the node has an exception edge out, and is turned on when descending into
 * a short-circuit right operand or a conditional arm.
 */
function computeGenKill(
    n: Node | null,
    tracked: ReadonlySet<number>,
    conditional: boolean,
    gen: (s: number) => void,
    kill: (s: number) => void,
): void {
    if (n === null) return;
    switch (n.type) {
        // Containers contribute nothing — their contents are separate CFG nodes.
        case N.Program:
        case N.BlockStatement:
        case N.StaticBlock:
        case N.FunctionDeclaration:
        case N.FunctionExpression:
        case N.ArrowFunctionExpression:
            return;
        // A loop/if CFG node IS its condition.
        case N.IfStatement:
        case N.WhileStatement:
            computeGenKill((n.data as { test: Node }).test, tracked, conditional, gen, kill);
            return;
        case N.DoWhileStatement:
            computeGenKill((n.data as { test: Node }).test, tracked, conditional, gen, kill);
            return;
        case N.ForStatement:
            computeGenKill((n.data as { test: Node | null }).test, tracked, conditional, gen, kill);
            return;
        case N.SwitchStatement:
            computeGenKill((n.data as { discriminant: Node }).discriminant, tracked, conditional, gen, kill);
            return;
        case N.SwitchCase:
            computeGenKill((n.data as { test: Node | null }).test, tracked, conditional, gen, kill);
            return;
        case N.ForInStatement:
        case N.ForOfStatement: {
            // Closure: the LHS "may never be assigned to or evaluated, like in `for (x in []) {}`, so
            // should not be killed"; and the RHS "is executed only once so we don't go into it every
            // loop" (it has its own CFG node).
            let lhs = (n.data as { left: Node }).left;
            if (lhs.type === N.VariableDeclaration) {
                const decls = (lhs.data as { declarations: Node[] }).declarations;
                if (decls.length > 0) lhs = (decls[decls.length - 1].data as { id: Node }).id;
            }
            computeGenKill(lhs, tracked, conditional, gen, kill);
            return;
        }
        case N.VariableDeclaration: {
            for (const d of (n.data as { declarations: Node[] }).declarations) {
                const dd = d.data as { id: Node; init: Node | null };
                if (dd.id.type === N.BindingIdentifier) {
                    if (dd.init !== null) {
                        computeGenKill(dd.init, tracked, conditional, gen, kill);
                        if (!conditional) {
                            const s = (dd.id as { sym: number }).sym;
                            if (tracked.has(s)) kill(s);
                        }
                    }
                } else {
                    // Destructuring: every bound name is killed, and the init is read.
                    if (!conditional) lhsNames(dd.id, tracked, kill);
                    computeGenKill(dd.init, tracked, conditional, gen, kill);
                }
            }
            return;
        }
        case N.LogicalExpression: {
            const d = n.data as { left: Node; right: Node };
            computeGenKill(d.left, tracked, conditional, gen, kill);
            computeGenKill(d.right, tracked, true, gen, kill); // may short circuit
            return;
        }
        case N.ConditionalExpression: {
            const d = n.data as { test: Node; consequent: Node; alternate: Node };
            computeGenKill(d.test, tracked, conditional, gen, kill);
            computeGenKill(d.consequent, tracked, true, gen, kill);
            computeGenKill(d.alternate, tracked, true, gen, kill);
            return;
        }
        case N.IdentifierReference: {
            const s = (n as { sym: number }).sym;
            if (tracked.has(s)) gen(s);
            return;
        }
        case N.BindingIdentifier:
            return; // a declaration site is neither a read nor, by itself, a kill
        case N.AssignmentExpression: {
            const d = n.data as { operator: string; left: Node; right: Node };
            if (d.left.type === N.IdentifierReference) {
                const s = (d.left as { sym: number }).sym;
                if (tracked.has(s)) {
                    if (!conditional) kill(s);
                    if (d.operator !== '=') gen(s); // `a += 1` READS a first
                }
                computeGenKill(d.right, tracked, conditional, gen, kill);
                return;
            }
            if (d.left.type === N.ArrayPattern || d.left.type === N.ObjectPattern) {
                if (!conditional) lhsNames(d.left, tracked, kill);
                computeGenKill(d.right, tracked, conditional, gen, kill);
                return;
            }
            break; // member target etc. — fall through to the generic walk
        }
        case N.UpdateExpression: {
            const arg = (n.data as { argument: Node }).argument;
            if (arg.type === N.IdentifierReference) {
                const s = (arg as { sym: number }).sym;
                if (tracked.has(s)) {
                    gen(s); // `a++` reads then writes
                    if (!conditional) kill(s);
                }
                return;
            }
            break;
        }
        default:
            break;
    }
    walkChildren(n, (c) => {
        computeGenKill(c, tracked, conditional, gen, kill);
    });
}

/** Every tracked name bound by a destructuring pattern. */
function lhsNames(pattern: Node, tracked: ReadonlySet<number>, kill: (s: number) => void): void {
    if (pattern.type === N.BindingIdentifier || pattern.type === N.IdentifierReference) {
        const s = (pattern as { sym: number }).sym;
        if (tracked.has(s)) kill(s);
        return;
    }
    walkChildren(pattern, (c) => {
        lhsNames(c, tracked, kill);
    });
}

/**
 * Live-out sets for every CFG node of `cfg`, over `tracked`. `alwaysLive` (escaped/captured symbols)
 * are live everywhere — Closure's `escaped` set, and the same rule `liveness.ts` already implements.
 */
export function computeLiveVars(
    cfg: Cfg,
    tracked: ReadonlySet<number>,
    alwaysLive: ReadonlySet<number>,
): LiveVarsResult {
    const index = new Map<number, number>();
    for (const s of tracked) index.set(s, index.size);
    const W = words(Math.max(index.size, 1));

    // The boundary value: nothing is live at an exit except what escaped.
    const boundary = new Uint32Array(W);
    for (const s of alwaysLive) {
        const i = index.get(s);
        if (i !== undefined) bitSet(boundary, i);
    }

    // Does this CFG node have an exception edge out? Then its kills are only MAYBE-kills.
    const conditional = new Uint8Array(cfg.value.length);
    for (let id = 0; id < cfg.value.length; id++)
        for (const b of cfg.succBranch[id])
            if (b === BRANCH.ON_EX) {
                conditional[id] = 1;
                break;
            }

    const spec: DataflowSpec<LiveSet> = {
        forward: false,
        entry: () => boundary.slice(),
        initial: () => boundary.slice(),
        join: (vals) => {
            const out = vals[0].slice();
            for (let k = 1; k < vals.length; k++) {
                const v = vals[k];
                for (let w = 0; w < W; w++) out[w] |= v[w];
            }
            return out;
        },
        equals: eqSet,
        flowThrough: (node, out, id) => {
            // L_in = (L_out - KILL) ∪ GEN. Kills are collected separately and applied FIRST, so a node
            // that both reads and writes a variable (`a = a + 1`) leaves it live, as it must.
            const killed: number[] = [];
            const genned: number[] = [];
            computeGenKill(
                node,
                tracked,
                conditional[id] === 1,
                (s) => genned.push(s),
                (s) => killed.push(s),
            );
            if (killed.length === 0 && genned.length === 0) return out;
            const res = out.slice();
            for (const s of killed) {
                const i = index.get(s);
                if (i !== undefined) res[i >>> 5] &= ~(1 << (i & 31));
            }
            for (const s of genned) {
                const i = index.get(s);
                if (i !== undefined) bitSet(res, i);
            }
            return res;
        },
    };

    const { outAt, steps } = solve(cfg, spec);
    const rev: number[] = new Array(index.size);
    for (const [sym, i] of index) rev[i] = sym;

    return {
        index,
        steps,
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
