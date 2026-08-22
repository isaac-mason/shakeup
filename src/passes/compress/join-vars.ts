// join-vars + sequences (terser `join_vars` + `sequences`): two adjacency-only statement-list
// rewrites that collapse runs of trivially-mergeable statements into one, shrinking output without
// touching evaluation order.
//
//   1. JOIN-VARS — a run of consecutive `VariableDeclaration`s of the SAME `kind` (`var`+`var`,
//      `let`+`let`, `const`+`const`), with NOTHING between them, merges its declarators into the
//      first declaration: `var a=1; var b=2;` → `var a=1,b=2;`. Declarator order (and thus init
//      side-effect order) is preserved exactly, left-to-right.
//   2. SEQUENCES — a run of consecutive `ExpressionStatement`s folds into one `ExpressionStatement`
//      wrapping a `SequenceExpression`: `a(); b(); c();` → `a(),b(),c();`. Comma-operator order is
//      the source order, so effects are preserved.
//
// LANDMINES / conservative bails:
//   - Only ADJACENT SAME-KIND declarations join. `var` then `let` is NOT mergeable (different kind);
//     any non-declaration statement, label, or directive between two declarations breaks the run.
//     Same-kind adjacency is the whole safety argument: it changes nothing about hoisting or the TDZ
//     (the declarations already sat in the same scope, in the same order).
//   - This AST has no `directive` node — a "use strict" prologue is an `ExpressionStatement` whose
//     expression is a `StringLiteral`. Folding one into a comma sequence would demote it from a
//     directive to an ordinary string expression (silently dropping strict mode), so we treat a
//     string-literal expression statement as UN-foldable and let it break the run.
//   - SEQUENCES only ever fold `ExpressionStatement`s (never a declaration, control-flow, or any
//     other statement). Since we produce a statement-level sequence, no extra parens are needed; the
//     printer parenthesizes sub-expressions (e.g. a nested sequence / assignment) as required.
//   - We rebuild the list into a fresh array and assign (dead-code's pattern) — never splice a
//     possibly-frozen shared array in place.
import { N, type Node, node } from '../../ast.ts';
import * as create from '../../parser/create.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

// Narrow views for the two data shapes we read off already-`.type`-checked nodes (the codebase's
// `(node.data as {…})` idiom — sound because each access is guarded by a matching type check).
type VarDeclData = { declarations: Node[]; kind: 'var' | 'let' | 'const'; declare: boolean };
type ExprStmtData = { expression: Node };

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
        // SEQUENCES: extend a run of foldable (non-directive) expression statements.
        if (stmt.type === N.ExpressionStatement && !isDirectiveLike(stmt)) {
            let j = i + 1;
            while (j < body.length && body[j].type === N.ExpressionStatement && !isDirectiveLike(body[j])) j++;
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
