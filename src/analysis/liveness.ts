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
import { N, type Node, walk } from '../ast.ts';

/** Symbols live immediately AFTER each statement. */
export type LiveOut = Map<Node, ReadonlySet<number>>;

const isFn = (n: Node): boolean =>
    n.type === N.FunctionDeclaration || n.type === N.FunctionExpression || n.type === N.ArrowFunctionExpression;

/** Every tracked symbol read anywhere in `n` (not descending into nested functions). */
function reads(n: Node | null, tracked: ReadonlySet<number>, into: Set<number>): void {
    if (n === null) return;
    walk(n, (c) => {
        if (isFn(c)) return false; // a nested function's reads are handled by the escape rule
        if (c.type === N.IdentifierReference) {
            const s = (c as { sym: number }).sym;
            if (tracked.has(s)) into.add(s);
        }
        return undefined;
    });
}

/** The variable a statement DEFINITELY overwrites, plus the expression evaluated first. */
function killOf(stmt: Node, tracked: ReadonlySet<number>): { kill: number; value: Node | null } | null {
    if (stmt.type === N.ExpressionStatement) {
        const e = (stmt.data as { expression: Node }).expression;
        if (e.type !== N.AssignmentExpression) return null;
        const a = e.data as { operator: string; left: Node; right: Node };
        // Only a plain `=` kills; `+=` reads the old value first.
        if (a.operator !== '=' || a.left.type !== N.IdentifierReference) return null;
        const s = (a.left as { sym: number }).sym;
        return tracked.has(s) ? { kill: s, value: a.right } : null;
    }
    return null;
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
                reads((stmt.data as { argument: Node | null }).argument, tracked, live);
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
                reads(d.test, tracked, live as Set<number>);
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
                    if (cd.test !== null) reads(cd.test, tracked, live as Set<number>);
                }
                reads(d.discriminant, tracked, live as Set<number>);
                return live;
            }
            case N.VariableDeclaration: {
                const decls = (stmt.data as { declarations: Node[] }).declarations;
                let live: ReadonlySet<number> = after;
                for (let i = decls.length - 1; i >= 0; i--) {
                    const d = decls[i].data as { id: Node; init: Node | null };
                    const next = new Set(live);
                    // Only an INITIALISED declarator kills. A bare `var h;` does NOT reset the binding —
                    // `var` is hoisted, so a store can textually PRECEDE the declaration and still be
                    // live through it: `h = 7; var h; return h` must return 7. Treating the bare
                    // declaration as a kill made that store look dead and dead-store DELETED it, which
                    // returned `undefined`. (Closure's `computeGenKill` kills only when the declarator
                    // `hasChildren()`, i.e. has an init; the CFG port matches. This arm did not.)
                    if (d.id.type === N.BindingIdentifier) {
                        if (d.init !== null) next.delete((d.id as { sym: number }).sym);
                    } else {
                        reads(d.id, tracked, next); // destructuring — treat as reads, never a kill
                    }
                    reads(d.init, tracked, next);
                    live = next;
                }
                return live;
            }
            case N.TryStatement:
                bailed = true; // exception edges are not modelled
                return after;
            default: {
                const k = killOf(stmt, tracked);
                const live = new Set(after);
                if (k !== null) {
                    live.delete(k.kill);
                    reads(k.value, tracked, live);
                } else {
                    reads(stmt, tracked, live);
                }
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
                reads(d.update, tracked, u);
                bodyIn = u;
            }
            const next = union(bodyIn, after);
            if (d.test != null) reads(d.test, tracked, next as Set<number>);
            if (d.right != null) reads(d.right, tracked, next as Set<number>); // for-in/of subject
            if (d.left != null && d.left.type !== N.VariableDeclaration) reads(d.left, tracked, next as Set<number>);
            if (same(next, header)) break;
            header = next;
        }
        const live = new Set(header);
        if (d.init != null) {
            if (d.init.type === N.VariableDeclaration) return liveIn(d.init, live, t);
            reads(d.init, tracked, live);
        }
        return live;
    };

    const root: Targets = { brk: new Map(), cont: new Map() };
    liveIn(body, new Set(alwaysLive), root);
    return bailed ? null : out;
}
