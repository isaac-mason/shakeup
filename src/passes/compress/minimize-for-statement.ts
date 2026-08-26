// minimize-for-statement — hoist a leading `if (…) break;` out of a loop body into the loop TEST.
//
// Port of oxc `minimize_for_statement`, itself a port of esbuild's `mangleFor`:
//
//   for (;;)   if (x) break;             →  for (; !x;) ;
//   for (; a;) if (x) break;             →  for (; a && !x;) ;
//   for (;;)   if (x) break; else y();   →  for (; !x;) y();
//   for (; a;) if (x) y(); else break;   →  for (; a && x;) y();
//
// WHY IT MATTERS BEYOND ITS OWN BYTES: `while (true) { … ; if (c) break; }` is the common shape, and
// `normalize` already rewrites `while` to `for` while the statement-sequencing in `minimizeConditions`
// already folds a preceding expression statement into the `if` test. So the missing hoist was the last
// step between our `for(;!0;)if(t=e,e)break` and oxc's `for(;o=a,!a;)` — once the test becomes
// `!0 && !(t=e,e)`, the existing folds reduce it the rest of the way.
//
// THE BREAK MUST BE UNLABELLED. A labelled `break L` may target an OUTER loop, so hoisting it into
// THIS loop's test would change which loop exits.
import { N, type Node } from '../../ast.ts';
import * as create from '../../parser/create.ts';
import { OP, UnaryExpression } from '../../parser/create.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

type ForData = { init: Node | null; test: Node | null; update: Node | null; body: Node };
type IfData = { test: Node; consequent: Node; alternate: Node | null };

/** The single statement a branch runs, or `null` if it is not exactly one. */
function oneChild(branch: Node | null): Node | null {
    if (branch === null) return null;
    if (branch.type !== N.BlockStatement) return branch;
    const body = (branch.data as { body: Node[] }).body;
    return body.length === 1 ? body[0] : null;
}

/** An UNLABELLED `break;` — a labelled one may target an outer loop and must not be hoisted. */
function isBareBreak(stmt: Node | null): boolean {
    return stmt !== null && stmt.type === N.BreakStatement && (stmt.data as { label: Node | null } | null)?.label == null;
}

/** `!expr`, cancelling a double negation rather than stacking one. */
function not(expr: Node): Node {
    if (expr.type === N.UnaryExpression) {
        const d = expr.data as { operator: string; argument: Node };
        if (d.operator === '!') return d.argument;
    }
    return UnaryExpression(expr.start, expr.end, OP.NOT, expr);
}

/** `test && extra`, or just `extra` when the loop had no test. */
function andWith(test: Node | null, extra: Node): Node {
    if (test === null) return extra;
    return create.LogicalExpression(test.start, extra.end, '&&', test, extra) as Node;
}

/** Replace the body's FIRST statement with `next` (or drop it when there is none). */
function bodyWithout(body: Node, next: Node | null): Node {
    if (body.type !== N.BlockStatement) return next ?? create.EmptyStatement(body.start, body.end, 0);
    const stmts = (body.data as { body: Node[] }).body;
    const rest = next === null ? stmts.slice(1) : [next, ...stmts.slice(1)];
    (body.data as { body: Node[] }).body = rest;
    return body;
}

export const minimizeForStatement: Visitor = {
    name: 'minimizeForStatement',
    enter: hookTable({
        [N.ForStatement]: (n, ctx: TransformCtx) => {
            const d = n.data as ForData;
            const first = d.body.type === N.BlockStatement ? ((d.body.data as { body: Node[] }).body[0] ?? null) : d.body;
            if (first === null || first.type !== N.IfStatement) return;
            const iff = first.data as IfData;

            // `if (x) break; [else y()]` → test `&& !x`, body becomes the else branch.
            if (isBareBreak(oneChild(iff.consequent))) {
                d.test = andWith(d.test, not(iff.test));
                d.body = bodyWithout(d.body, iff.alternate);
                ctx.changed = true;
                return;
            }
            // `if (x) y(); else break;` → test `&& x`, body becomes the consequent.
            if (iff.alternate !== null && isBareBreak(oneChild(iff.alternate))) {
                d.test = andWith(d.test, iff.test);
                d.body = bodyWithout(d.body, iff.consequent);
                ctx.changed = true;
            }
        },
    }),
    exit: null,
};
