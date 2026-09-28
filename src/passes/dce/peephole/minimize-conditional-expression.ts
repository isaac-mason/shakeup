// Port of oxc_minifier/src/peephole/minimize_conditional_expression.rs, the functions tree-shake mode
// reaches.

import { type DataOf, N, type Node, node } from '../../../ast/index.ts';
import { type DceCtx, replaceExpression, takeNode } from '../traverse-context.ts';

const isSpecificId = (expr: Node, name: string): boolean => expr.type === N.IdentifierReference && expr.name === name;

/** For `targetIdName` = `a` and `expr` = `a.b`, rewrite `expr` to `a?.b`, with `exprToInject` as the
 *  new base, and return true. */
export function injectOptionalChainingIfMatched(ctx: DceCtx, targetIdName: string, exprToInject: Node, expr: Node): boolean {
    if (!injectOptionalChainingIfMatchedInner(ctx, targetIdName, exprToInject, expr)) return false;
    if (expr.type !== N.ChainExpression) {
        const element = takeNode(ctx, expr);
        replaceExpression(ctx, expr, node(N.ChainExpression, element.start, element.end, '', { expression: element }));
    }
    return true;
}

/** Make the member or call whose base is `targetIdName` optional, recursing down the base. The
 *  field holding the base is `object` for a member and `callee` for a call. */
function injectIntoBase(ctx: DceCtx, targetIdName: string, exprToInject: Node, owner: Node, base: Node): boolean {
    if (isSpecificId(base, targetIdName)) {
        (owner.data as DataOf<'StaticMemberExpression'> | DataOf<'CallExpression'>).optional = true;
        replaceExpression(ctx, base, takeNode(ctx, exprToInject));
        return true;
    }
    return injectOptionalChainingIfMatchedInner(ctx, targetIdName, exprToInject, base);
}

function injectOptionalChainingIfMatchedInner(ctx: DceCtx, targetIdName: string, exprToInject: Node, expr: Node): boolean {
    switch (expr.type) {
        case N.StaticMemberExpression:
        case N.ComputedMemberExpression:
            return injectIntoBase(ctx, targetIdName, exprToInject, expr, expr.data.object);
        case N.CallExpression:
            return injectIntoBase(ctx, targetIdName, exprToInject, expr, expr.data.callee);
        case N.ChainExpression: {
            const element = expr.data.expression as Node;
            switch (element.type) {
                case N.StaticMemberExpression:
                case N.ComputedMemberExpression:
                    return injectIntoBase(ctx, targetIdName, exprToInject, element, element.data.object);
                case N.CallExpression:
                    return injectIntoBase(ctx, targetIdName, exprToInject, element, element.data.callee);
                default:
                    return false;
            }
        }
        default:
            return false;
    }
}
