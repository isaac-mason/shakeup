// Control-flow graph — a faithful port of Closure's `ControlFlowAnalysis` / `ControlFlowGraph`
// (llm/closure/src/com/google/javascript/jscomp/{ControlFlowAnalysis,ControlFlowGraph}.java).
//
// WHY THIS EXISTS: shakeup already computes liveness structurally (`analysis/liveness.ts`), and the
// question of whether an explicit CFG is the better substrate was going in circles on argument. This
// is the experiment — a REAL Closure-aligned CFG, not a strawman, so the comparison is fair. See the
// roadmap's "DO WE NEED A CFG?" section.
//
// MODEL (Closure's, not the textbook one): CFG nodes are AST NODES, not basic blocks. Every statement,
// and every loop/if CONDITION, is its own node. There is no block merging. Two synthetic nodes exist:
// ENTRY, and IMPLICIT_RETURN (Closure's `implicitReturn`, value `null`) which every exit flows to —
// "this will make life easier for DFAs".
//
// The loop encodings are the subtle part and are taken verbatim from Closure:
//   • WHILE / FOR node  = the CONDITION CHECK. `for (init; cond; upd) body` becomes isomorphic to
//     `init; while (cond) { body; upd; }` — init and upd get their own CFG nodes, both UNCOND→ the FOR
//     node, and `follow(body) = upd ?? forNode`.
//   • DO node = the condition check that runs AFTER the body, so `fallThrough(DO) = fallThrough(body)`.
//   • FOR_IN / FOR_OF node = the loop itself; `right` (the collection) UNCOND→ the loop node, and
//     `follow(body) = the loop node`.
// This is why `computeFallThrough` exists at all: you cannot always enter a construct at its own node.
//
// EXCEPTIONS are the capability a structural walk cannot express, and the reason this port models them
// rather than bailing (compilecat's CFG bails on try/with/yield/await/generators — that is a defect of
// that port, NOT a property of CFGs, and grounding on it was a mistake this file exists to correct).
// An `exceptionHandler` stack tracks enclosing TRY nodes; any node whose subtree may throw gets an
// ON_EX edge to the nearest catch (or finally). `finallyMap` records transfers that must be rewired
// once a finally block's own follow is known — Closure's mechanism for `break`/`return` crossing a
// finally.
import { N, type Node, walkChildren } from '../ast.ts';

/** Edge kinds. Closure `ControlFlowGraph.Branch`. */
export const BRANCH = {
    ON_TRUE: 0,
    ON_FALSE: 1,
    UNCOND: 2,
    /** Exception path. Closure conflates "threw into a catch/finally" with "finally→outer finally":
     *  "In theory, we need 2 different edge types. In practice, we can just treat them as the edges we
     *  can't really optimize." */
    ON_EX: 3,
    SYN_BLOCK: 4,
} as const;
export type Branch = (typeof BRANCH)[keyof typeof BRANCH];

/** CFG node id 0 is always the implicit return (Closure's `implicitReturn`, a node with value null). */
export const IMPLICIT_RETURN = 0;

export type Cfg = {
    /** `value[id]` — the AST node for CFG node `id`, or null for IMPLICIT_RETURN. */
    value: (Node | null)[];
    idOf: Map<Node, number>;
    succ: number[][];
    /** `succBranch[id][k]` is the edge kind of `succ[id][k]`. */
    succBranch: Branch[][];
    pred: number[][];
    /** `predBranch[id][k]` is the edge kind of the edge FROM `pred[id][k]` into `id`. */
    predBranch: Branch[][];
    entry: number;
};

/** Whether evaluating `n`'s subtree may throw. Conservative: an unmodelled shape counts as throwing,
 *  since extra ON_EX edges only ever make a dataflow answer MORE conservative, never wrong.
 *  (Closure: `NodeUtil.mayThrowException`.) */
export function mayThrow(n: Node | null): boolean {
    if (n === null) return false;
    switch (n.type) {
        case N.NumericLiteral:
        case N.StringLiteral:
        case N.BooleanLiteral:
        case N.NullLiteral:
        case N.BigIntLiteral:
        case N.RegExpLiteral:
        case N.ThisExpression:
        case N.IdentifierReference:
        case N.BindingIdentifier:
        case N.IdentifierName:
        case N.PrivateIdentifier:
        case N.FunctionExpression:
        case N.ArrowFunctionExpression:
        case N.EmptyStatement:
        case N.DebuggerStatement:
        case N.FunctionDeclaration:
            return false;
        // Property access can invoke a getter; calls/new run arbitrary code; await/yield resume
        // arbitrarily; `throw` obviously.
        case N.StaticMemberExpression:
        case N.ComputedMemberExpression:
        case N.PrivateFieldExpression:
        case N.CallExpression:
        case N.NewExpression:
        case N.AwaitExpression:
        case N.YieldExpression:
        case N.ThrowStatement:
        case N.TaggedTemplateExpression:
        case N.ImportExpression:
            return true;
        default: {
            let found = false;
            walkChildren(n, (c) => {
                if (!found && mayThrow(c)) found = true;
            });
            return found;
        }
    }
}

const isLoop = (t: number): boolean =>
    t === N.ForStatement || t === N.WhileStatement || t === N.DoWhileStatement || t === N.ForInStatement || t === N.ForOfStatement;

const isStmtList = (t: number): boolean => t === N.Program || t === N.BlockStatement || t === N.StaticBlock;

const listOf = (n: Node): Node[] =>
    n.type === N.SwitchCase ? (n.data as { consequent: Node[] }).consequent : (n.data as { body: Node[] }).body;

/**
 * Node kinds the CFG traversal descends into: every statement, plus the containers that hold them.
 * NOT "can contain a statement" — leaf statements (`ExpressionStatement`, `return`, `break`, …) must be
 * visited too or they never become CFG nodes. Getting that distinction wrong broke 12 equivalence tests
 * instantly, which is the harness doing its job.
 */
const isStatementish = (t: number): boolean =>
    t === N.ExpressionStatement ||
    t === N.ReturnStatement ||
    t === N.ThrowStatement ||
    t === N.BreakStatement ||
    t === N.ContinueStatement ||
    t === N.EmptyStatement ||
    t === N.DebuggerStatement ||
    t === N.FunctionDeclaration ||
    t === N.Program ||
    t === N.BlockStatement ||
    t === N.StaticBlock ||
    t === N.IfStatement ||
    t === N.ForStatement ||
    t === N.ForInStatement ||
    t === N.ForOfStatement ||
    t === N.WhileStatement ||
    t === N.DoWhileStatement ||
    t === N.SwitchStatement ||
    t === N.SwitchCase ||
    t === N.TryStatement ||
    t === N.CatchClause ||
    t === N.LabeledStatement ||
    t === N.VariableDeclaration;

const isFnNode = (t: number): boolean =>
    t === N.FunctionDeclaration || t === N.FunctionExpression || t === N.ArrowFunctionExpression;

/**
 * Build a control-flow graph rooted at `root` (a function body, `Program`, or `StaticBlock`).
 * Never returns null — unlike compilecat's port, `try`/`await`/`yield` are MODELLED, not bailed on.
 */
export function buildCfg(root: Node): Cfg {
    const cfg: Cfg = {
        value: [null],
        idOf: new Map(),
        succ: [[]],
        succBranch: [[]],
        pred: [[]],
        predBranch: [[]],
        entry: 1,
    };

    // Parent map — shakeup nodes carry no parent pointer (deliberate: monomorphic node shape), and
    // `computeFollowNode` is defined by walking up. It is filled DURING the main traversal rather than
    // by a pre-pass: `handle` runs post-order, so by the time anything walks up from a node, every one
    // of its ancestors has already been entered and recorded.
    const parent = new Map<Node, Node>();

    const idFor = (n: Node | null): number => {
        if (n === null) return IMPLICIT_RETURN;
        const hit = cfg.idOf.get(n);
        if (hit !== undefined) return hit;
        const id = cfg.value.length;
        cfg.value.push(n);
        cfg.idOf.set(n, id);
        cfg.succ.push([]);
        cfg.succBranch.push([]);
        cfg.pred.push([]);
        cfg.predBranch.push([]);
        return id;
    };

    const createEdge = (from: Node, branch: Branch, to: Node | null): void => {
        const f = idFor(from);
        const t = idFor(to);
        // `connectIfNotFound` — Closure never duplicates an identical edge.
        const s = cfg.succ[f];
        for (let i = 0; i < s.length; i++) if (s[i] === t && cfg.succBranch[f][i] === branch) return;
        s.push(t);
        cfg.succBranch[f].push(branch);
        cfg.pred[t].push(f);
        cfg.predBranch[t].push(branch);
    };

    /** Closure `computeFallThrough`: where control lands when entering `n`'s subtree. You cannot
     *  always enter at `n` itself — a DO enters at its body, a FOR at its init/condition. */
    const fallThrough = (n: Node): Node => {
        switch (n.type) {
            case N.DoWhileStatement:
                return fallThrough((n.data as { body: Node }).body);
            case N.ForStatement: {
                const init = (n.data as { init: Node | null }).init;
                return init === null ? n : fallThrough(init);
            }
            case N.ForInStatement:
            case N.ForOfStatement:
                return (n.data as { right: Node }).right;
            case N.LabeledStatement:
                return fallThrough((n.data as { body: Node }).body);
            default:
                return n;
        }
    };

    // Transfers out of a finally block that must be rewired once the finally's own follow is known.
    const finallyMap = new Map<Node, Node[]>();
    const addFinally = (from: Node, to: Node): void => {
        const cur = finallyMap.get(from);
        if (cur === undefined) finallyMap.set(from, [to]);
        else cur.push(to);
    };

    const catchBodyOf = (tryNode: Node): Node | null => {
        const h = (tryNode.data as { handler: Node | null }).handler;
        return h === null ? null : (h.data as { body: Node }).body;
    };
    const finalizerOf = (tryNode: Node): Node | null => (tryNode.data as { finalizer: Node | null }).finalizer;

    /**
     * Closure `computeFollowNode(fromNode, node)`: the node control reaches after `node` completes.
     * `null` means the implicit return (end of the CFG root, or a function boundary).
     * SIDE EFFECT (Closure's, preserved): leaving a FINALLY rewires `fromNode` to that finally's
     * recorded outer targets.
     */
    const follow = (fromNode: Node, node: Node): Node | null => {
        if (node === root) return null;
        const p = parent.get(node);
        if (p === undefined || isFnNode(p.type)) return null;

        switch (p.type) {
            case N.IfStatement:
                return follow(fromNode, p);
            case N.LabeledStatement:
                return follow(fromNode, p);
            case N.SwitchCase: {
                // shakeup stores `consequent` as a FLAT statement list (Closure wraps it in a block), so
                // a statement's parent IS the case. Remaining siblings come first; only at the end of a
                // case body does control FALL THROUGH into the next case's body — never its test.
                const own = listOf(p);
                let k = own.indexOf(node) + 1;
                while (k < own.length && own[k].type === N.FunctionDeclaration) k++;
                if (k > 0 && k < own.length) return fallThrough(own[k]);

                const sw = parent.get(p);
                if (sw === undefined || sw.type !== N.SwitchStatement) return follow(fromNode, p);
                const cases = (sw.data as { cases: Node[] }).cases;
                const i = cases.indexOf(p);
                for (let j = i + 1; j < cases.length; j++) {
                    const body = listOf(cases[j]);
                    if (body.length > 0) return fallThrough(body[0]);
                }
                return follow(fromNode, sw);
            }
            case N.ForStatement: {
                // Any child of a FOR is followed by the update, which then re-tests the condition.
                const upd = (p.data as { update: Node | null }).update;
                return upd ?? p;
            }
            case N.WhileStatement:
            case N.DoWhileStatement:
            case N.ForInStatement:
            case N.ForOfStatement:
                return p;
            case N.TryStatement: {
                const block = (p.data as { block: Node }).block;
                const fin = finalizerOf(p);
                if (block === node) {
                    // Leaving the TRY block: into the finally if there is one, else past the whole try.
                    return fin !== null ? fallThrough(fin) : follow(fromNode, p);
                }
                if (catchBodyOf(p) === node || (p.data as { handler: Node | null }).handler === node) {
                    return fin !== null ? fallThrough(fin) : follow(fromNode, p);
                }
                if (fin === node) {
                    // Leaving the FINALLY: rewire everything that jumped INTO this finally to its own
                    // outer destinations (Closure does exactly this, with ON_EX edges).
                    const targets = finallyMap.get(p);
                    if (targets !== undefined) for (const t of targets) createEdge(fromNode, BRANCH.ON_EX, t);
                    return follow(fromNode, p);
                }
                return follow(fromNode, p);
            }
            case N.CatchClause:
                return follow(fromNode, p);
            default:
                break;
        }

        // Otherwise: the next sibling in the enclosing statement list, skipping function declarations
        // (control does not fall into them).
        if (isStmtList(p.type)) {
            const list = listOf(p);
            let i = list.indexOf(node) + 1;
            while (i < list.length && list[i].type === N.FunctionDeclaration) i++;
            if (i > 0 && i < list.length) return fallThrough(list[i]);
        }
        return follow(fromNode, p);
    };

    // ── exception wiring ─────────────────────────────────────────────────────────────────────────
    const exceptionHandler: Node[] = []; // innermost last

    /** Closure `connectToPossibleExceptionHandler`. */
    const connectEx = (cfgNode: Node, target: Node | null): void => {
        if (exceptionHandler.length === 0 || !mayThrow(target)) return;
        let lastJump: Node = cfgNode;
        for (let h = exceptionHandler.length - 1; h >= 0; h--) {
            const handler = exceptionHandler[h];
            const catchBody = catchBodyOf(handler);
            const fin = finalizerOf(handler);

            // Is `lastJump` itself inside this handler's catch block? Then its exceptions escape to the
            // NEXT handler out, not back into the same catch.
            let inCatch = false;
            if (catchBody !== null) {
                for (let a: Node | undefined = lastJump; a !== undefined; a = parent.get(a)) {
                    if (a === handler) break;
                    if (a === catchBody) {
                        inCatch = true;
                        break;
                    }
                }
            }

            if (catchBody === null || inCatch) {
                // No catch (or we are already in it) → the finally handles it, then keep unwinding.
                const dest = fin;
                if (dest !== null) {
                    if (lastJump === cfgNode) createEdge(cfgNode, BRANCH.ON_EX, fallThrough(dest));
                    else addFinally(lastJump, fallThrough(dest));
                }
            } else {
                if (lastJump === cfgNode) {
                    createEdge(cfgNode, BRANCH.ON_EX, catchBody);
                    return;
                }
                addFinally(lastJump, catchBody);
                return;
            }
            lastJump = handler;
        }
    };

    // ── break / continue targets ─────────────────────────────────────────────────────────────────
    const labelOf = (n: Node): string | null => {
        const l = (n.data as { label: Node | null }).label;
        return l === null ? null : l.name;
    };

    /** Closure `isBreakTarget` / `isContinueTarget`, plus the finally-crossing rewiring.
     *  `break` (unlabelled) targets the nearest loop or switch; labelled, the statement carrying the
     *  label. `continue` targets the nearest loop; labelled, the loop carrying the label. */
    const isTarget = (cand: Node, label: string | null, wantContinue: boolean): boolean => {
        const loop = isLoop(cand.type);
        if (label !== null) return (wantContinue ? loop : true) && labelledAs(cand, label);
        return wantContinue ? loop : loop || cand.type === N.SwitchStatement;
    };

    const jumpTo = (node: Node, label: string | null, wantContinue: boolean): void => {
        let lastJump: Node = node;
        let previous: Node | null = null;
        let cur: Node = node;

        for (;;) {
            if (cur !== node && isTarget(cur, label, wantContinue)) {
                const dest = wantContinue ? continueDest(cur) : follow(lastJump, cur);
                if (lastJump === node) createEdge(node, BRANCH.UNCOND, dest);
                else if (dest !== null) addFinally(lastJump, dest);
                return;
            }
            // Crossing a finally on the way out: enter it first, and record where control goes after.
            if (cur.type === N.TryStatement) {
                const fin = finalizerOf(cur);
                if (fin !== null && fin !== previous) {
                    if (lastJump === node) createEdge(lastJump, BRANCH.UNCOND, fallThrough(fin));
                    else addFinally(lastJump, fallThrough(fin));
                    lastJump = cur;
                }
            }
            const p = parent.get(cur);
            if (p === undefined || cur === root) {
                createEdge(node, BRANCH.UNCOND, null); // unresolved target → implicit return
                return;
            }
            previous = cur;
            cur = p;
        }
    };

    /** Is `n` the body of a LabeledStatement carrying `label` (or the labelled statement itself)? */
    const labelledAs = (n: Node, label: string): boolean => {
        const p = parent.get(n);
        return p !== undefined && p.type === N.LabeledStatement && (p.data as { label: Node }).label.name === label;
    };

    /** Where `continue` lands: the update for a C-style for, else the loop node itself. */
    const continueDest = (loop: Node): Node => {
        if (loop.type === N.ForStatement) {
            const upd = (loop.data as { update: Node | null }).update;
            return upd ?? loop;
        }
        return loop;
    };

    // ── traversal ────────────────────────────────────────────────────────────────────────────────
    // Closure pushes handlers in `shouldTraverseIntoChildren` (pre-order) and dispatches handlers in
    // `visit` (post-order). The TRY handler is popped when we ENTER the catch/finally, not on exit —
    // exceptions raised in a catch block belong to the NEXT handler out.
    const visit = (n: Node): void => {
        const t = n.type;

        if (isFnNode(t) && n !== root) return; // control never falls into a nested function

        if (t === N.TryStatement) {
            const d = n.data as { block: Node; handler: Node | null; finalizer: Node | null };
            parent.set(d.block, n);
            if (d.handler !== null) parent.set(d.handler, n);
            if (d.finalizer !== null) parent.set(d.finalizer, n);
            exceptionHandler.push(n);
            visit(d.block);
            exceptionHandler.pop();
            if (d.handler !== null) visit(d.handler);
            if (d.finalizer !== null) visit(d.finalizer);
            handle(n);
            return;
        }

        // Record EVERY child (a CFG node can be a direct expression child — a `for`'s init/update, a
        // for-in's right — and `connectEx` walks up from those), but only DESCEND into statement-ish
        // ones. `handle` does nothing for an expression, and statements cannot occur inside one except
        // in a nested function body, which is skipped anyway. Expressions dominate node counts, so
        // this is most of the traversal.
        walkChildren(n, (c) => {
            parent.set(c, n);
            if (!isFnNode(c.type) && isStatementish(c.type)) visit(c);
        });
        handle(n);
    };

    const handle = (n: Node): void => {
        switch (n.type) {
            case N.Program:
            case N.BlockStatement:
            case N.StaticBlock: {
                const list = listOf(n);
                let i = 0;
                while (i < list.length && list[i].type === N.FunctionDeclaration) i++;
                if (i < list.length) createEdge(n, BRANCH.UNCOND, fallThrough(list[i]));
                else createEdge(n, BRANCH.UNCOND, follow(n, n));
                return;
            }
            case N.IfStatement: {
                const d = n.data as { test: Node; consequent: Node; alternate: Node | null };
                createEdge(n, BRANCH.ON_TRUE, fallThrough(d.consequent));
                createEdge(n, BRANCH.ON_FALSE, d.alternate === null ? follow(n, n) : fallThrough(d.alternate));
                connectEx(n, d.test);
                return;
            }
            case N.WhileStatement: {
                const d = n.data as { test: Node; body: Node };
                createEdge(n, BRANCH.ON_TRUE, fallThrough(d.body));
                if (!isAlwaysTrue(d.test)) createEdge(n, BRANCH.ON_FALSE, follow(n, n));
                connectEx(n, d.test);
                return;
            }
            case N.DoWhileStatement: {
                const d = n.data as { body: Node; test: Node };
                createEdge(n, BRANCH.ON_TRUE, fallThrough(d.body));
                if (!isAlwaysTrue(d.test)) createEdge(n, BRANCH.ON_FALSE, follow(n, n));
                connectEx(n, d.test);
                return;
            }
            case N.ForStatement: {
                const d = n.data as { init: Node | null; test: Node | null; update: Node | null; body: Node };
                if (d.init !== null) createEdge(d.init, BRANCH.UNCOND, n);
                createEdge(n, BRANCH.ON_TRUE, fallThrough(d.body));
                if (d.test !== null && !isAlwaysTrue(d.test)) createEdge(n, BRANCH.ON_FALSE, follow(n, n));
                if (d.update !== null) createEdge(d.update, BRANCH.UNCOND, n);
                if (d.init !== null) connectEx(d.init, d.init);
                connectEx(n, d.test);
                return;
            }
            case N.ForInStatement:
            case N.ForOfStatement: {
                const d = n.data as { left: Node; right: Node; body: Node };
                createEdge(d.right, BRANCH.UNCOND, n);
                createEdge(n, BRANCH.ON_TRUE, fallThrough(d.body));
                createEdge(n, BRANCH.ON_FALSE, follow(n, n));
                connectEx(n, d.right);
                return;
            }
            case N.SwitchStatement: {
                const d = n.data as { discriminant: Node; cases: Node[] };
                const first = d.cases.find((c) => (c.data as { test: Node | null }).test !== null) ?? d.cases[0];
                createEdge(n, BRANCH.UNCOND, first ?? follow(n, n));
                connectEx(n, d.discriminant);
                return;
            }
            case N.SwitchCase: {
                const d = n.data as { test: Node | null; consequent: Node[] };
                const body = d.consequent.length > 0 ? fallThrough(d.consequent[0]) : follow(n, n);
                if (d.test === null) {
                    createEdge(n, BRANCH.UNCOND, body); // default: straight into the body
                    return;
                }
                createEdge(n, BRANCH.ON_TRUE, body);
                const sw = parent.get(n);
                const cases = sw === undefined ? [] : (sw.data as { cases: Node[] }).cases;
                const i = cases.indexOf(n);
                let next: Node | null = null;
                for (let k = i + 1; k < cases.length; k++)
                    if ((cases[k].data as { test: Node | null }).test !== null) {
                        next = cases[k];
                        break;
                    }
                if (next === null) next = cases.find((c) => (c.data as { test: Node | null }).test === null) ?? null;
                createEdge(n, BRANCH.ON_FALSE, next ?? follow(n, n));
                connectEx(n, d.test);
                return;
            }
            case N.TryStatement:
                createEdge(n, BRANCH.UNCOND, (n.data as { block: Node }).block);
                return;
            case N.CatchClause:
                createEdge(n, BRANCH.UNCOND, (n.data as { body: Node }).body);
                return;
            case N.ReturnStatement:
                connectEx(n, (n.data as { argument: Node | null }).argument);
                createEdge(n, BRANCH.UNCOND, null);
                return;
            case N.ThrowStatement:
                connectEx(n, n);
                return;
            case N.BreakStatement:
                jumpTo(n, labelOf(n), false);
                return;
            case N.ContinueStatement:
                jumpTo(n, labelOf(n), true);
                return;
            case N.LabeledStatement:
                createEdge(n, BRANCH.UNCOND, fallThrough((n.data as { body: Node }).body));
                return;
            case N.FunctionDeclaration:
                return; // hoisted; control never falls in
            case N.ExpressionStatement:
                createEdge(n, BRANCH.UNCOND, follow(n, n));
                connectEx(n, n);
                return;
            case N.VariableDeclaration:
                createEdge(n, BRANCH.UNCOND, follow(n, n));
                connectEx(n, n);
                return;
            case N.EmptyStatement:
            case N.DebuggerStatement:
                createEdge(n, BRANCH.UNCOND, follow(n, n));
                return;
            default:
                // Not a statement (expressions are handled as part of their statement) — no node.
                return;
        }
    };

    const isAlwaysTrue = (test: Node | null): boolean =>
        test !== null && test.type === N.BooleanLiteral && test.name === 'true';

    idFor(root); // entry must be cfg node 1
    visit(root);
    return cfg;
}
