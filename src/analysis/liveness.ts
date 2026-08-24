// Backward liveness over structured control flow — the analysis dead-store elimination needs.
//
// A variable is LIVE at a point if its current value might still be read. Computing that requires
// control flow, which is why dead-store is the one optimization with an irreducible flow dependency.
//
// WHY NOT AN EXPLICIT CFG: JavaScript statements are structured (no `goto`), so liveness can be
// computed by a backward recursive walk, with loops iterated to a fixed point and `break`/`continue`
// resolved against a stack of their targets. For structured code this is EXACTLY the answer a CFG
// worklist would produce — it is not the "bail at any branch" approximation. Constructs whose flow is
// not modelled (`try`) bail the whole function, matching compilecat, which likewise refuses to build a
// CFG for a function it cannot represent.
//
// This models LABELED blocks and `break LABEL` specifically because that is what block-inlining emits
// (`L: { … result = X; break L; … }`), and cleaning that scaffolding is where dead-store pays off.
//
// SOUNDNESS: only a definite whole-variable write is treated as a KILL (`x = …`, or a declarator's
// initialiser). Everything else contributes reads only. Never killing where a kill is uncertain means
// the analysis can only ever report a variable MORE live than it is — which loses optimizations,
// never correctness.
import { N, type Node } from '../ast.ts';
import { genKill } from './gen-kill.ts';

/** Symbols live immediately AFTER each statement. */
export type LiveOut = Map<Node, ReadonlySet<number>>;


/**
 * Apply one node's GEN/KILL to a live set, in place: `live := (live − KILL) ∪ GEN`.
 *
 * The rules themselves live in `analysis/gen-kill.ts`, SHARED with the CFG driver. This file owns only
 * the control flow. They used to be separate implementations that disagreed — see that file's header
 * for the miscompile that cost.
 *
 * Kills are collected and applied BEFORE gens so a node that both reads and writes a symbol
 * (`a = a + 1`) leaves it live, as it must.
 */
function applyGenKill(node: Node | null, tracked: ReadonlySet<number>, live: Set<number>): void {
    if (node === null) return;
    const kills: number[] = [];
    const gens: number[] = [];
    genKill(
        node,
        tracked,
        false,
        (s) => gens.push(s),
        (s) => kills.push(s),
    );
    for (const s of kills) live.delete(s);
    for (const s of gens) live.add(s);
}


const union = (a: ReadonlySet<number>, b: ReadonlySet<number>): Set<number> => new Set([...a, ...b]);
const same = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean =>
    a.size === b.size && [...a].every((x) => b.has(x));

type Targets = {
    /** Live set at the exit of the nearest enclosing breakable construct, by label (`''` = nearest). */
    brk: Map<string, ReadonlySet<number>>;
    /** Live set at the nearest enclosing loop's continue point. */
    cont: Map<string, ReadonlySet<number>>;
};

/**
 * Live-out sets for every statement in `body`.
 * `tracked` are the symbols to analyse; `alwaysLive` (escaped/captured) are live everywhere.
 * Returns `null` when the body contains flow this does not model.
 */
export function computeLiveness(
    body: Node,
    tracked: ReadonlySet<number>,
    alwaysLive: ReadonlySet<number>,
): LiveOut | null {
    const out: LiveOut = new Map();
    let bailed = false;

    /** Live set BEFORE `stmt`, given what is live after it. Records `stmt`'s live-out on the way. */
    const liveIn = (stmt: Node, after: ReadonlySet<number>, t: Targets): ReadonlySet<number> => {
        if (bailed) return after;
        out.set(stmt, after);
        switch (stmt.type) {
            case N.EmptyStatement:
            case N.DebuggerStatement:
            case N.FunctionDeclaration: // hoisted; its body is analysed separately
                return after;
            case N.BlockStatement: {
                const list = (stmt.data as { body: Node[] }).body;
                let live = after;
                for (let i = list.length - 1; i >= 0; i--) live = liveIn(list[i], live, t);
                return live;
            }
            case N.ReturnStatement: {
                // Nothing after a `return` but the escaped set.
                const live = new Set(alwaysLive);
                applyGenKill((stmt.data as { argument: Node | null }).argument, tracked, live);
                out.set(stmt, live);
                return live;
            }
            case N.ThrowStatement: {
                // A `throw` terminates this flow exactly as `return` does — the statements after it are
                // not reachable from here. Without this arm a throw fell into `default` and was treated
                // as FALLING THROUGH, which kept variables live along a path that cannot reach their
                // reads (e.g. `let c, d; if (…) c = …; else throw …; use(c)`), making the analysis
                // needlessly conservative. Safe, but it was the last remaining disagreement with the CFG
                // driver. A throw INSIDE a `try` goes to the handler instead — this function bails on
                // `try` wholesale, so that case never reaches here.
                const live = new Set(alwaysLive);
                applyGenKill((stmt.data as { argument: Node }).argument, tracked, live);
                out.set(stmt, live);
                return live;
            }
            case N.BreakStatement: {
                const label = (stmt.data as { label: Node | null }).label;
                const key = label === null ? '' : label.name;
                const target = t.brk.get(key);
                if (target === undefined) {
                    bailed = true; // break to an unknown target
                    return after;
                }
                out.set(stmt, target);
                return target;
            }
            case N.ContinueStatement: {
                const label = (stmt.data as { label: Node | null }).label;
                const target = t.cont.get(label === null ? '' : label.name);
                if (target === undefined) {
                    bailed = true;
                    return after;
                }
                out.set(stmt, target);
                return target;
            }
            case N.IfStatement: {
                const d = stmt.data as { test: Node; consequent: Node; alternate: Node | null };
                const thenIn = liveIn(d.consequent, after, t);
                const elseIn = d.alternate === null ? after : liveIn(d.alternate, after, t);
                const live = union(thenIn, elseIn);
                applyGenKill(d.test, tracked, live as Set<number>);
                return live;
            }
            case N.LabeledStatement: {
                // `L: { … break L; … }` — a break to `L` lands where the labeled statement ends.
                const d = stmt.data as { label: Node; body: Node };
                const inner: Targets = { brk: new Map(t.brk), cont: new Map(t.cont) };
                inner.brk.set(d.label.name, after);
                inner.brk.set('', after);
                return liveIn(d.body, after, inner);
            }
            case N.ForStatement:
            case N.DoWhileStatement:
            case N.ForInStatement:
            case N.ForOfStatement:
                return loopIn(stmt, after, t);
            case N.SwitchStatement: {
                const d = stmt.data as { discriminant: Node; cases: Node[] };
                // Conservative but sound: any case may run, and `break` exits to `after`.
                const inner: Targets = { brk: new Map(t.brk), cont: new Map(t.cont) };
                inner.brk.set('', after);
                let live: ReadonlySet<number> = after;
                for (const c of d.cases) {
                    const cd = c.data as { test: Node | null; consequent: Node[] };
                    let caseLive: ReadonlySet<number> = after;
                    for (let i = cd.consequent.length - 1; i >= 0; i--) {
                        caseLive = liveIn(cd.consequent[i], caseLive, inner);
                    }
                    live = union(live, caseLive);
                    if (cd.test !== null) applyGenKill(cd.test, tracked, live as Set<number>);
                }
                applyGenKill(d.discriminant, tracked, live as Set<number>);
                return live;
            }
            case N.VariableDeclaration: {
                const next = new Set(after);
                applyGenKill(stmt, tracked, next);
                return next;
            }
            case N.TryStatement:
                bailed = true; // exception edges are not modelled
                return after;
            default: {
                const live = new Set(after);
                applyGenKill(stmt, tracked, live);
                return live;
            }

        }
    };

    /** Loops: iterate to a fixed point, since the body's live-in feeds the header. */
    const loopIn = (stmt: Node, after: ReadonlySet<number>, t: Targets): ReadonlySet<number> => {
        const d = stmt.data as { init?: Node | null; test?: Node | null; update?: Node | null; body: Node; left?: Node; right?: Node };
        let header: ReadonlySet<number> = after;
        for (let i = 0; i < 12; i++) {
            const inner: Targets = { brk: new Map(t.brk), cont: new Map(t.cont) };
            inner.brk.set('', after); // `break` leaves the loop
            inner.cont.set('', header); // `continue` re-enters the header
            let bodyIn = liveIn(d.body, header, inner);
            if (d.update != null) {
                const u = new Set(bodyIn);
                applyGenKill(d.update, tracked, u);
                bodyIn = u;
            }
            const next = union(bodyIn, after);
            if (d.test != null) applyGenKill(d.test, tracked, next as Set<number>);
            if (d.right != null) applyGenKill(d.right, tracked, next as Set<number>); // for-in/of subject
            if (d.left != null && d.left.type !== N.VariableDeclaration) applyGenKill(d.left, tracked, next as Set<number>);
            if (same(next, header)) break;
            header = next;
        }
        const live = new Set(header);
        if (d.init != null) {
            if (d.init.type === N.VariableDeclaration) return liveIn(d.init, live, t);
            applyGenKill(d.init, tracked, live);
        }
        return live;
    };

    const root: Targets = { brk: new Map(), cont: new Map() };
    liveIn(body, new Set(alwaysLive), root);
    return bailed ? null : out;
}
