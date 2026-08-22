// join-vars + sequences + statement-fusion (terser `join_vars`/`sequences`, oxc
// `minimize_statements`): adjacency-only statement-list rewrites that collapse runs of trivially-
// mergeable statements into one, shrinking output without touching evaluation order.
//
//   1. JOIN-VARS — a run of consecutive `VariableDeclaration`s of the SAME `kind` (`var`+`var`,
//      `let`+`let`, `const`+`const`), with NOTHING between them, merges its declarators into the
//      first declaration: `var a=1; var b=2;` → `var a=1,b=2;`. Declarator order (and thus init
//      side-effect order) is preserved exactly, left-to-right.
//   2. SEQUENCES — a run of consecutive `ExpressionStatement`s folds into one `ExpressionStatement`
//      wrapping a `SequenceExpression`: `a(); b(); c();` → `a(),b(),c();`. Comma-operator order is
//      the source order, so effects are preserved.
//   3. FUSION (oxc `minimize_statements.rs`) — a run of `ExpressionStatement`s IMMEDIATELY followed
//      by a control statement that carries an expression folds those statements INTO that expression
//      via a leading `SequenceExpression`, all in source (comma) order:
//        - `a(); b(); return x;`  → `return (a(), b(), x);`      (`:121-142,229-248`)
//        - `a(); b(); throw x;`   → `throw (a(), b(), x);`       (same shape)
//        - `a(); if (t) …`        → `if ((a(), t)) …`            (`:815-822`)
//      Comma order = source order, so the folded effects run in exactly the same sequence and the
//      control transfer still happens after all of them — identical observable behavior.
//
// LANDMINES / conservative bails:
//   - Only ADJACENT SAME-KIND declarations join. `var` then `let` is NOT mergeable (different kind);
//     any non-declaration statement, label, or directive between two declarations breaks the run.
//     Same-kind adjacency is the whole safety argument: it changes nothing about hoisting or the TDZ
//     (the declarations already sat in the same scope, in the same order).
//   - This AST has no `directive` node — a "use strict" prologue is an `ExpressionStatement` whose
//     expression is a `StringLiteral`. Folding one into a comma sequence would demote it from a
//     directive to an ordinary string expression (silently dropping strict mode), so we treat a
//     string-literal expression statement as UN-foldable: it never folds into a sequence NOR into a
//     following return/throw/if — it breaks any preceding run.
//   - FUSION only ever folds `ExpressionStatement`s (never a declaration, control-flow, or any other
//     statement) into the control statement — the same conservative rule as SEQUENCES. A bare
//     `return;` has NO argument to fold into, so we SKIP fusing into it (v1 leaves `a(); return;`
//     as-is rather than rewriting to `return a();`). `throw` always carries an argument.
//   - We build real `SequenceExpression` nodes; the printer parenthesizes the return/throw argument
//     and the if-test when they are a sequence. When the sole preceding statement is ITSELF a comma
//     sequence (the SEQUENCES pass ran first and merged `a();b();` → `a(),b();`), we splice its
//     elements in so we get one flat `(a(), b(), x)` rather than a nested `((a(), b()), x)`.
//   - We rebuild the list into a fresh array and assign (dead-code's pattern) — never splice a
//     possibly-frozen shared array in place.
import { N, type Node, node } from '../../ast.ts';
import * as create from '../../parser/create.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

// Narrow views for the data shapes we read off already-`.type`-checked nodes (the codebase's
// `(node.data as {…})` idiom — sound because each access is guarded by a matching type check).
type VarDeclData = { declarations: Node[]; kind: 'var' | 'let' | 'const'; declare: boolean };
type ExprStmtData = { expression: Node };
type SeqData = { expressions: Node[] };
type ArgData = { argument: Node | null };
type IfData = { test: Node };

/** A string-literal expression statement is (potentially) a directive prologue in this AST, which has
 *  no dedicated directive node. Folding it into a comma sequence would strip its directive meaning, so
 *  it is never foldable and breaks any sequence run. */
function isDirectiveLike(stmt: Node): boolean {
    return stmt.type === N.ExpressionStatement && (stmt.data as ExprStmtData).expression.type === N.StringLiteral;
}

/** Merge a run `body[i..j)` (all `VariableDeclaration`s of the same kind, i.e. `mergeableVar` held for
 *  every adjacent pair) into one declaration, reusing the first node's span start and the last's end.
 *  A fresh declarations array preserves declarator (and init side-effect) order left-to-right. */
function mergeVarRun(body: Node[], i: number, j: number): Node {
    const first = body[i];
    const last = body[j - 1];
    const decls: Node[] = [];
    for (let k = i; k < j; k++) for (const d of (body[k].data as VarDeclData).declarations) decls.push(d);
    // Rebuild the declaration node directly (create.VariableDeclaration takes a flags-encoded kind; we
    // already have the concrete kind string, so we construct the data shape as-is and keep `declare`).
    const src = first.data as VarDeclData;
    return node(N.VariableDeclaration, first.start, last.end, '', {
        declarations: decls,
        kind: src.kind,
        declare: src.declare,
    });
}

/** Fold a run `body[i..j)` of `ExpressionStatement`s into one statement wrapping a `SequenceExpression`
 *  of their expressions, in source order. Span covers first→last. */
function mergeExprRun(body: Node[], i: number, j: number): Node {
    const first = body[i];
    const last = body[j - 1];
    const exprs: Node[] = [];
    for (let k = i; k < j; k++) exprs.push((body[k].data as ExprStmtData).expression);
    const seq = create.SequenceExpression(first.start, last.end, 0, exprs);
    return create.ExpressionStatement(first.start, last.end, 0, seq);
}

/** A statement foldable into a following control statement (return/throw/if) is exactly a non-directive
 *  `ExpressionStatement` — the same conservative rule the SEQUENCES fold uses. Declarations, nested
 *  control-flow, and "use strict"-style directives are never folded. */
function isFusableExpr(stmt: Node): boolean {
    return stmt.type === N.ExpressionStatement && !isDirectiveLike(stmt);
}

/** Collect the expressions of `body[i..j)` (all fusable expression statements) plus a trailing `tail`
 *  expression, flattening any statement that is already a `SequenceExpression` so the result is a single
 *  flat comma list `(e0, e1, …, tail)` in source order — never a nested `((e0, e1), tail)`. */
function collectFusedExprs(body: Node[], i: number, j: number, tail: Node): Node[] {
    const exprs: Node[] = [];
    for (let k = i; k < j; k++) {
        const e = (body[k].data as ExprStmtData).expression;
        if (e.type === N.SequenceExpression) exprs.push(...(e.data as SeqData).expressions);
        else exprs.push(e);
    }
    if (tail.type === N.SequenceExpression) exprs.push(...(tail.data as SeqData).expressions);
    else exprs.push(tail);
    return exprs;
}

/** Fuse a run `body[i..j)` of fusable expression statements into the argument of the return/throw
 *  statement `ctrl` (which MUST have an argument): `a(); b(); return x;` → `return (a(), b(), x);`.
 *  Span covers the first folded statement → the control statement. */
function fuseIntoArg(body: Node[], i: number, j: number, ctrl: Node): Node {
    const first = body[i];
    const arg = (ctrl.data as ArgData).argument as Node;
    const seq = create.SequenceExpression(first.start, ctrl.end, 0, collectFusedExprs(body, i, j, arg));
    return ctrl.type === N.ReturnStatement
        ? create.ReturnStatement(first.start, ctrl.end, 0, seq)
        : create.ThrowStatement(first.start, ctrl.end, 0, seq);
}

/** Fuse a run `body[i..j)` of fusable expression statements into the test of the if statement `ctrl`:
 *  `a(); if (t) …` → `if ((a(), t)) …`. Consequent/alternate are carried over untouched. Span covers
 *  the first folded statement → the if statement. */
function fuseIntoIf(body: Node[], i: number, j: number, ctrl: Node): Node {
    const first = body[i];
    const data = ctrl.data as IfData & { consequent: Node; alternate: Node | null };
    const seq = create.SequenceExpression(first.start, ctrl.end, 0, collectFusedExprs(body, i, j, data.test));
    return create.IfStatement(first.start, ctrl.end, 0, seq, data.consequent, data.alternate);
}

/** Two adjacent statements join under join-vars iff both are `VariableDeclaration`s of the SAME kind.
 *  (`declare` doesn't matter for mergeability — it's a TS-only flag; adjacent same-kind decls always
 *  share it in practice, and we carry the first's forward.) */
function mergeableVar(a: Node, b: Node): boolean {
    return (
        a.type === N.VariableDeclaration &&
        b.type === N.VariableDeclaration &&
        (a.data as VarDeclData).kind === (b.data as VarDeclData).kind
    );
}

/** Rewrite one statement list in place: fuse maximal runs of same-kind `VariableDeclaration`s
 *  (join-vars) and maximal runs of foldable `ExpressionStatement`s (sequences). Returns whether
 *  anything changed. */
function rewriteList(body: Node[]): boolean {
    if (body.length < 2) return false;
    const out: Node[] = [];
    let changed = false;
    let i = 0;
    while (i < body.length) {
        const stmt = body[i];
        // JOIN-VARS: extend a run of same-kind variable declarations.
        if (stmt.type === N.VariableDeclaration) {
            let j = i + 1;
            while (j < body.length && mergeableVar(body[j - 1], body[j])) j++;
            if (j - i >= 2) {
                out.push(mergeVarRun(body, i, j));
                changed = true;
                i = j;
                continue;
            }
        }
        // Extend a run of foldable (non-directive) expression statements once, then decide how it ends:
        // FUSION into a following control statement takes priority, else SEQUENCES folds a run of ≥2.
        if (isFusableExpr(stmt)) {
            let j = i + 1;
            while (j < body.length && isFusableExpr(body[j])) j++;
            const next = j < body.length ? body[j] : null;
            // FUSION #1 — expr(s) → return/throw with an argument: fold into the argument.
            if (next && (next.type === N.ReturnStatement || next.type === N.ThrowStatement) && (next.data as ArgData).argument) {
                out.push(fuseIntoArg(body, i, j, next));
                changed = true;
                i = j + 1; // consume the run AND the control statement
                continue;
            }
            // FUSION #2 — expr(s) → if-test: fold into the test.
            if (next && next.type === N.IfStatement) {
                out.push(fuseIntoIf(body, i, j, next));
                changed = true;
                i = j + 1;
                continue;
            }
            // SEQUENCES: no fusable control target follows — fold a run of ≥2 into one comma sequence.
            if (j - i >= 2) {
                out.push(mergeExprRun(body, i, j));
                changed = true;
                i = j;
                continue;
            }
        }
        out.push(stmt);
        i++;
    }
    if (!changed) return false;
    body.length = 0;
    for (const s of out) body.push(s);
    return true;
}

/** A statement-list container hook: run {@link rewriteList} over its list field, marking the ctx
 *  changed so the fixed-point driver re-runs. */
function listHook(field: string): (n: Node, ctx: TransformCtx) => void {
    return (n, ctx) => {
        if (rewriteList((n.data as Record<string, Node[]>)[field])) ctx.changed = true;
    };
}

export const joinVars: Visitor = {
    name: 'joinVars',
    enter: hookTable({
        // Statement-list containers (same-scope statement lists): Program / block / static block.
        [N.Program]: listHook('body'),
        [N.BlockStatement]: listHook('body'),
        [N.StaticBlock]: listHook('body'),
        // A switch case's `consequent` is a same-scope statement list too.
        [N.SwitchCase]: listHook('consequent'),
    }),
    exit: null,
};
