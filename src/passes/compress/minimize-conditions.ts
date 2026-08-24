// B-cond — minimize-conditions (terser `conditionals`, esbuild if→expr, oxc `minimize_if_statement`):
// rewrite an `if` whose branches are single simple statements into the shorter expression/ternary
// form, preserving evaluation order and short-circuit semantics EXACTLY. A missed rewrite costs
// bytes; a wrong one is a miscompile, so every shape is matched precisely and everything else bails.
//
// THE REWRITES (deliberately narrow):
//   1. `if (a) b();`            (no else, consequent a single ExpressionStatement)
//        → `a && b();`          (ExpressionStatement wrapping `a && b()`). Short-circuit `&&` runs
//                                `b()` iff `a` is truthy — identical to the guarded `if`.
//      NEGATED TEST: `if (!a) b();` → `a || b();` — we DROP the `!` and flip `&&`→`||` over the
//      un-negated operand (oxc `minimize_if_statement.rs:22-27`). `a || b()` runs `b()` iff `a` is
//      falsy, exactly `if (!a)`. Fewer bytes than `!a && b()`.
//   2. `if (a) b(); else c();`  (BOTH branches a single ExpressionStatement)
//        → `a ? b() : c();`     (ExpressionStatement wrapping a ConditionalExpression). Same taken
//                                branch, same single evaluation of `a`.
//   3. `if (a) return x; else return y;`  (BOTH branches a single `return <arg>`)
//        → `return a ? x : y;`  (one ReturnStatement over a ternary). Same value, same order.
//      Also `if (a) return x; return y;` (else-less, immediately followed by a `return <arg>` in the
//      SAME statement list) folds into `return a ? x : y;`, consuming the trailing return.
//   4. `if (a) {}` / `if (a);`  (empty consequent — empty block or empty statement — and NO else)
//        → `a;`                 (ExpressionStatement wrapping the test, run for its side effects).
//                                The test `a` MUST still be evaluated (that's the only observable
//                                effect left), so we keep it (oxc `minimize_if_statement.rs:43-50`).
//   5. `if (a) {} else b();`    (empty consequent AND an else that is a single ExpressionStatement)
//        → `a || b();`          (ExpressionStatement wrapping `a || b()`). The empty consequent means
//                                the truthy branch does nothing, so `b()` runs iff `a` is falsy —
//                                exactly `a || b()`, with `a` evaluated once (`:51-63`).
//
// LANDMINES / conservative bails (a bail is always correct):
//   - Branches must be EXACTLY the single simple statement shapes above. A single-statement
//     `BlockStatement` (`{ b(); }`) is unwrapped and accepted; a block with 0 or >1 statements, or
//     any declaration (`var`/`let`/`const`/`function`/`class`), bails — those change scope/semantics.
//     (The empty-consequent rewrites 4/5 are the ONE place an empty block is welcome, not a bail.)
//   - `return;` (no argument) bails from rewrite 3: `a ? undefined : y` is NOT `return;` semantics
//     when mixed, and building a ternary over a missing arg is meaningless.
//   - `else if` chains bail unless the terminal `else` is itself a simple single statement (which the
//     unwrap naturally handles — an `else if` is an IfStatement, not one of the accepted shapes, so
//     it bails). We never restructure a chain.
//   - The empty-consequent rewrites NEVER drop the test — `a` is evaluated for side effects even
//     when the body is empty; dropping it would be a miscompile if `a` is impure.
//   - Real nodes are built (never hand-formatted text) so the printer's precedence machinery adds
//     exactly the parens it needs: `(a, b) && c()`, `a ? b : (c, d)`, `(a, b) || c()`, etc.
import { N, type Node } from '../../ast.ts';
import * as create from '../../parser/create.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

type IfData = { test: Node; consequent: Node; alternate: Node | null };

/** True if `test` is a compile-time constant (literal, or `!<literal>`) — dead-code owns these
 *  (it eliminates the dead branch). minimize-conditions leaves them alone to avoid stranding a
 *  `false && …` the branch-elimination can no longer reach. Mirrors dead-code's `constTruthiness`. */
function isConstantTest(test: Node): boolean {
    switch (test.type) {
        case N.BooleanLiteral:
        case N.NumericLiteral:
        case N.StringLiteral:
        case N.NullLiteral:
            return true;
        case N.UnaryExpression:
            return (
                (test.data as { operator: string }).operator === '!' && isConstantTest((test.data as { argument: Node }).argument)
            );
        default:
            return false;
    }
}
type ExprStmtData = { expression: Node };
type ReturnData = { argument: Node | null };
type BlockData = { body: Node[] };
type SwitchCaseData = { consequent: Node[] };
type UnaryData = { operator: string; prefix: boolean; argument: Node };

/** Is `branch` an empty consequent — an empty `BlockStatement` (`{}`) or a bare `EmptyStatement`
 *  (`;`)? These carry no runtime effect, so an `if` with such a consequent reduces to just its test
 *  (rewrite 4) or a `test || else` (rewrite 5). A non-empty block or any statement is NOT empty. */
function isEmptyBranch(branch: Node): boolean {
    if (branch.type === N.EmptyStatement) return true;
    return branch.type === N.BlockStatement && (branch.data as BlockData).body.length === 0;
}

/** If `test` is a logical negation `!x` (a prefix `!` UnaryExpression), return the un-negated operand
 *  `x`; otherwise `null`. Used to turn `if (!a) …` into the flipped `||` form over `a`. */
function negatedOperand(test: Node): Node | null {
    if (test.type !== N.UnaryExpression) return null;
    const d = test.data as UnaryData;
    return d.operator === '!' ? d.argument : null;
}

/** Unwrap a branch to the single statement it actually runs: a bare statement is itself; a
 *  `BlockStatement` with exactly one statement is that statement. Anything else (empty block,
 *  multi-statement block, or a non-block that we still pass through) may be inspected by the shape
 *  probes below. Returns `null` only for blocks that don't reduce to a single statement. */
function unwrapSingle(branch: Node): Node | null {
    if (branch.type !== N.BlockStatement) return branch;
    const body = (branch.data as BlockData).body;
    return body.length === 1 ? body[0] : null;
}

/** The expression of a single `ExpressionStatement` branch, or `null` if the branch isn't one. */
function asExprStmt(branch: Node): Node | null {
    const s = unwrapSingle(branch);
    if (s === null || s.type !== N.ExpressionStatement) return null;
    return (s.data as ExprStmtData).expression;
}

/** The argument of a single `return <arg>;` branch, or `null` if the branch isn't a return-with-arg
 *  (a bare `return;` yields `null` and therefore bails). */
function asReturnArg(branch: Node): Node | null {
    const s = unwrapSingle(branch);
    if (s === null || s.type !== N.ReturnStatement) return null;
    return (s.data as ReturnData).argument; // null for `return;` → caller bails
}

/** Rewrite an `if` with an EMPTY consequent (rewrites 4 & 5), or `null` if the consequent isn't empty.
 *   - no else:  `if (a) {}` / `if (a);` → `a;` (the test as an ExpressionStatement, for side effects).
 *   - with else: `if (a) {} else b();` → `a || b();` (`b()` runs iff `a` is falsy). The else must be a
 *     single ExpressionStatement, else we bail. The test is NEVER dropped — `a` is still evaluated. */
function ifEmptyConsequent(n: Node): Node | null {
    const d = n.data as IfData;
    if (!isEmptyBranch(d.consequent)) return null;
    if (d.alternate === null) {
        // `if (a) {}` → `a;` — keep the test for its side effects.
        return create.ExpressionStatement(n.start, n.end, 0, d.test);
    }
    // `if (a) {} else b();` → `a || b();`
    const alt = asExprStmt(d.alternate);
    if (alt === null) return null;
    const logical = create.LogicalExpression(n.start, n.end, '||', d.test, alt);
    return create.ExpressionStatement(n.start, n.end, 0, logical);
}

/** Rewrite `if (test) <exprStmt> else <exprStmt>` → `test ? c : a`, or `if (test) <exprStmt>` (no
 *  else) → `test && c`, wrapped in an ExpressionStatement. Returns the replacement or `null` to bail.
 *  Both-branch-return folding is handled separately (needs the statement list for the else-less form).
 *
 *  NEGATED-TEST flip (no-else only): if the test is `!x`, emit `x || c` — drop the `!` and flip the
 *  operator (oxc). `x || c` runs `c` iff `x` is falsy, exactly `if (!x) c`. We don't apply this to the
 *  else form (it'd need branch-swapping, and the ternary is already minimal). */
function ifToExprStmt(n: Node): Node | null {
    const d = n.data as IfData;
    const cons = asExprStmt(d.consequent);
    if (cons === null) return null;
    if (d.alternate === null) {
        const neg = negatedOperand(d.test);
        // `if (!a) b();` → `a || b();`   ·   `if (a) b();` → `a && b();`
        const logical =
            neg !== null
                ? create.LogicalExpression(n.start, n.end, '||', neg, cons)
                : create.LogicalExpression(n.start, n.end, '&&', d.test, cons);
        return create.ExpressionStatement(n.start, n.end, 0, logical);
    }
    // `if (a) b(); else c();` → `a ? b() : c();`
    const alt = asExprStmt(d.alternate);
    if (alt === null) return null;
    const cond = create.ConditionalExpression(n.start, n.end, 0, d.test, cons, alt);
    return create.ExpressionStatement(n.start, n.end, 0, cond);
}

/** Rewrite `if (a) return x; else return y;` → `return a ? x : y;`. Both branches must be a single
 *  `return <arg>` (arg present). Returns the ReturnStatement or `null` to bail. The else-less
 *  `if (a) return x; return y;` variant is folded in the statement-list hook, not here. */
function ifReturnBoth(n: Node): Node | null {
    const d = n.data as IfData;
    if (d.alternate === null) return null;
    const x = asReturnArg(d.consequent);
    if (x === null) return null;
    const y = asReturnArg(d.alternate);
    if (y === null) return null;
    const cond = create.ConditionalExpression(n.start, n.end, 0, d.test, x, y);
    return create.ReturnStatement(n.start, n.end, 0, cond);
}

/** Statement-list hook: fold the else-less `if (a) return x; <next> = return y;` pair into
 *  `return a ? x : y;`, consuming the trailing return. Only fires when the `if` has NO else, its
 *  consequent is a single `return <arg>`, and the IMMEDIATELY-following statement is a
 *  `return <arg>`. Returns whether anything changed. */
function foldIfReturnFollow(body: Node[], ctx: TransformCtx): boolean {
    let changed = false;
    for (let i = 0; i < body.length - 1; i++) {
        const stmt = body[i];
        if (stmt.type !== N.IfStatement) continue;
        const d = stmt.data as IfData;
        const next = body[i + 1];
        if (next.type !== N.ReturnStatement) continue;
        const y = (next.data as ReturnData).argument;
        if (y === null) continue; // trailing `return;` — no ternary value, bail
        let cons: Node;
        let alt: Node;
        if (d.alternate === null) {
            // `if (a) return X;  return Y`  →  `return a ? X : Y`
            const x = asReturnArg(d.consequent);
            if (x === null) continue;
            cons = x;
            alt = y;
        } else if (isEmptyBranch(d.consequent)) {
            // `if (a) {} else return X;  return Y`  →  `return a ? Y : X`  (truthy falls through to Y).
            const elseX = asReturnArg(d.alternate);
            if (elseX === null) continue;
            cons = y;
            alt = elseX;
        } else continue; // else-form with a non-empty consequent is handled by the node hook (ifReturnBoth)
        const cond = create.ConditionalExpression(stmt.start, next.end, 0, d.test, cons, alt);
        body[i] = create.ReturnStatement(stmt.start, next.end, 0, cond);
        ctx.spliceStatements(body, i + 1, 1); // drop the consumed trailing return
        changed = true;
    }
    return changed;
}

function listHook(n: Node, ctx: TransformCtx): void {
    if (foldIfReturnFollow((n.data as BlockData).body, ctx)) ctx.changed = true;
}

export const minimizeConditions: Visitor = {
    name: 'minimizeConditions',
    // ENTER phase: the statement-list fold runs on the container before we descend into each `if`, so
    // the follow-return pairing sees the original list; the per-`if` node hook then handles the
    // remaining (else-form and expr-statement) rewrites. Ordering is not load-bearing — the driver
    // loops to a fixed point — but doing the list fold first avoids a wasted iteration.
    enter: hookTable({
        [N.Program]: listHook,
        [N.BlockStatement]: listHook,
        [N.StaticBlock]: listHook,
        // A switch case's `consequent` is a same-scope statement list too.
        [N.SwitchCase]: (n, ctx) => {
            if (foldIfReturnFollow((n.data as SwitchCaseData).consequent, ctx)) ctx.changed = true;
        },
    }),
    // The `if`-shape rewrites run on EXIT — after the test's children are visited, so a constProp
    // inline of the test (`if (DEBUG)` → `if (false)`) has already happened and the constant-test
    // guard can defer it to dead-code (rather than converting `if (false){…}` → a stranded `false && …`).
    exit: hookTable({
        [N.IfStatement]: (n, ctx) => {
            // A CONSTANT test belongs to dead-code (it eliminates the whole dead branch); leave it.
            if (isConstantTest((n.data as IfData).test)) return;
            // Prefer the return-both rewrite (shortest) when it applies; then the empty-consequent
            // reduction (`if (a) {}` → `a;` / `a || b()`); else the expr/ternary form.
            const asReturn = ifReturnBoth(n);
            if (asReturn !== null) {
                ctx.replaceWith(asReturn);
                return;
            }
            const asEmpty = ifEmptyConsequent(n);
            if (asEmpty !== null) {
                ctx.replaceWith(asEmpty);
                return;
            }
            const asExpr = ifToExprStmt(n);
            if (asExpr !== null) ctx.replaceWith(asExpr);
        },
    }),
};
