// Normalize (oxc `normalize.rs`) — canonicalize the AST so later passes see fewer shapes and the
// output matches oxc's. Conservative, behavior-preserving:
//   • `while (t) body` → `for (; t;) body`  (identical semantics; oxc's canonical loop form)
//   • drop a trailing no-op `return` from a function body (`return;` / `return undefined;` /
//     `return void 0;` as the LAST statement — the function falls through to the same `undefined`)
//   • strip `EmptyStatement`s from statement lists (`;`)
import { N, type Node } from '../../ast.ts';
import * as create from '../../parser/create.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

/** A `return` whose value is `undefined` however spelled: bare `return;`, `return undefined` (the
 *  global), or `return void <pure>`. Dropping it when it's a function-body's last statement is a
 *  no-op (implicit fall-through already returns `undefined`). */
function isNoopReturn(stmt: Node): boolean {
    if (stmt.type !== N.ReturnStatement) return false;
    const arg = (stmt.data as { argument: Node | null }).argument;
    if (arg === null) return true;
    if (arg.type === N.IdentifierReference && arg.name === 'undefined' && (arg as { sym: number }).sym === 0) return true;
    // `void 0` (void of a literal — pure).
    if (arg.type === N.UnaryExpression) {
        const d = arg.data as { operator: string; argument: Node };
        if (d.operator === 'void' && d.argument.type === N.NumericLiteral) return true;
    }
    return false;
}

/** Drop a trailing no-op return from a function's block body (in place). */
function trimTrailingReturn(fn: Node): boolean {
    const body = (fn.data as { body: Node | null }).body;
    if (body === null || body.type !== N.BlockStatement) return false;
    const list = (body.data as { body: Node[] }).body;
    if (list.length > 0 && isNoopReturn(list[list.length - 1])) {
        list.pop();
        return true;
    }
    return false;
}

/** Remove `EmptyStatement`s from a statement list (in place). Returns whether it changed. */
function stripEmpty(list: Node[]): boolean {
    let has = false;
    for (const s of list) if (s.type === N.EmptyStatement) has = true;
    if (!has) return false;
    const kept = list.filter((s) => s.type !== N.EmptyStatement);
    list.length = 0;
    for (const s of kept) list.push(s);
    return true;
}

const listHook = (field: 'body' | 'consequent') => (n: Node, ctx: TransformCtx) => {
    if (stripEmpty((n.data as Record<string, Node[]>)[field])) ctx.changed = true;
};
const fnHook = (n: Node, ctx: TransformCtx) => {
    if (trimTrailingReturn(n)) ctx.changed = true;
};

export const normalize: Visitor = {
    name: 'normalize',
    enter: hookTable({
        [N.WhileStatement]: (n, ctx: TransformCtx) => {
            const d = n.data as { test: Node; body: Node };
            ctx.replaceWith(create.ForStatement(n.start, n.end, 0, null, d.test, null, d.body) as Node);
        },
        [N.FunctionDeclaration]: fnHook,
        [N.FunctionExpression]: fnHook,
        [N.ArrowFunctionExpression]: fnHook,
        [N.Program]: listHook('body'),
        [N.BlockStatement]: listHook('body'),
        [N.StaticBlock]: listHook('body'),
        [N.SwitchCase]: listHook('consequent'),
    }),
    exit: null,
};
