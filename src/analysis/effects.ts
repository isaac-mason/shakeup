import { type Node, N } from '../ast.ts';

/**
 * Conservatively true if evaluating this expression has no observable side effects.
 * `jsxPure` selects whether a JSX element/fragment is treated as side-effect-free
 * (bundler policy, from `jsx.pure`); it is threaded explicitly rather than held in
 * module state so the check stays pure and reentrant.
 */
export function isPureExpr(node: Node | null, jsxPure: boolean): boolean {
    if (node === null) return true;
    switch (node.type) {
        case N.BindingIdentifier:
        case N.IdentifierReference:
        case N.IdentifierName:
        case N.LabelIdentifier:
        case N.NumericLiteral:
        case N.StringLiteral:
        case N.BooleanLiteral:
        case N.NullLiteral:
        case N.RegExpLiteral:
        case N.BigIntLiteral:
        case N.ThisExpression:
        case N.ImportMeta:
        case N.NewTarget:
        case N.ArrowFunctionExpression:
        case N.FunctionExpression:
            return true;
        case N.ClassExpression:
            return node.data.superClass === null && !classHasStaticEffects(node, jsxPure);
        case N.TemplateLiteral: {
            for (const e of node.data.expressions) if (!isPureExpr(e, jsxPure)) return false;
            return true;
        }
        case N.ArrayExpression: {
            for (const el of node.data.elements) {
                if (el === null) continue;
                if (el.type === N.SpreadElement) return false;
                if (!isPureExpr(el, jsxPure)) return false;
            }
            return true;
        }
        case N.ObjectExpression: {
            for (const p of node.data.properties) {
                if (p.type === N.SpreadElement) return false;
                if (p.type !== N.ObjectProperty) continue;
                if (p.data.computed && !isPureExpr(p.data.key, jsxPure)) return false;
                if (p.data.kind === 'init' && !isPureExpr(p.data.value, jsxPure)) return false;
            }
            return true;
        }
        case N.UnaryExpression:
            return node.data.operator !== 'delete' && isPureExpr(node.data.argument, jsxPure);
        case N.BinaryExpression:
            return isPureExpr(node.data.left, jsxPure) && isPureExpr(node.data.right, jsxPure);
        case N.LogicalExpression:
            return isPureExpr(node.data.left, jsxPure) && isPureExpr(node.data.right, jsxPure);
        case N.ConditionalExpression:
            return (
                isPureExpr(node.data.test, jsxPure) &&
                isPureExpr(node.data.consequent, jsxPure) &&
                isPureExpr(node.data.alternate, jsxPure)
            );
        case N.SequenceExpression: {
            for (const e of node.data.expressions) if (!isPureExpr(e, jsxPure)) return false;
            return true;
        }
        case N.TSAsExpression:
        case N.TSSatisfiesExpression:
            return isPureExpr(node.data.expression, jsxPure);
        case N.JSXElement:
            return jsxPure && jsxElementPure(node, jsxPure);
        case N.JSXFragment:
            return jsxPure && jsxChildrenPure(node.data.children, jsxPure);
        default:
            return false;
    }
}

function jsxElementPure(node: Node & { type: typeof N.JSXElement }, jsxPure: boolean): boolean {
    const opening = node.data.openingElement as Node & { type: typeof N.JSXOpeningElement };
    for (const a of opening.data.attributes) {
        if (a.type === N.JSXSpreadAttribute) {
            if (!isPureExpr(a.data.argument, jsxPure)) return false;
        } else if (a.type === N.JSXAttribute) {
            const v = a.data.value;
            if (v !== null && !jsxAttrValuePure(v, jsxPure)) return false;
        }
    }
    return jsxChildrenPure(node.data.children, jsxPure);
}

function jsxAttrValuePure(value: Node, jsxPure: boolean): boolean {
    if (value.type === N.StringLiteral) return true;
    if (value.type === N.JSXExpressionContainer) {
        const e = value.data.expression;
        return e.type === N.JSXEmptyExpression || isPureExpr(e, jsxPure);
    }
    if (value.type === N.JSXElement || value.type === N.JSXFragment) return isPureExpr(value, jsxPure);
    return isPureExpr(value, jsxPure);
}

function jsxChildrenPure(children: Node[], jsxPure: boolean): boolean {
    for (const child of children) {
        if (child.type === N.JSXText) continue;
        if (child.type === N.JSXExpressionContainer) {
            const e = child.data.expression;
            if (e.type === N.JSXEmptyExpression) continue;
            if (!isPureExpr(e, jsxPure)) return false;
        } else if (child.type === N.JSXSpreadChild) {
            if (!isPureExpr(child.data.expression, jsxPure)) return false;
        } else if (child.type === N.JSXElement || child.type === N.JSXFragment) {
            if (!isPureExpr(child, jsxPure)) return false;
        }
    }
    return true;
}

/** True if evaluating a class declaration/expression runs static side effects (static blocks, impure static/computed keys). */
export function classHasStaticEffects(classNode: Node, jsxPure: boolean): boolean {
    if (classNode.type !== N.ClassDeclaration && classNode.type !== N.ClassExpression) return false;
    for (const m of classNode.data.body) {
        if (m.type === N.StaticBlock) return true;
        if (m.type === N.PropertyDefinition && m.data.static && !isPureExpr(m.data.value, jsxPure)) return true;
        if ((m.type === N.MethodDefinition || m.type === N.PropertyDefinition) && m.data.computed) {
            if (!isPureExpr(m.data.key, jsxPure)) return true;
        }
    }
    return false;
}

/**
 * Conservatively true if executing `stmt` in place has no immediate side
 * effects. Declarations count as pure (liveness is the caller's policy);
 * ImportDecl is pure here since import side-effect policy is a graph concern.
 */
export function isPureStatement(stmt: Node, jsxPure: boolean): boolean {
    switch (stmt.type) {
        case N.FunctionDeclaration:
        case N.TSInterfaceDeclaration:
        case N.TSTypeAliasDeclaration:
        case N.ImportDeclaration:
        case N.ExportAllDeclaration:
        case N.EmptyStatement:
            return true;
        case N.TSEnumDeclaration:
            return true;
        case N.ClassDeclaration:
            return stmt.data.superClass === null && !classHasStaticEffects(stmt, jsxPure);
        case N.VariableDeclaration: {
            for (const d of stmt.data.declarations) {
                if (d.type === N.VariableDeclarator && !isPureExpr(d.data.init, jsxPure)) return false;
            }
            return true;
        }
        case N.ExportNamedDeclaration: {
            const decl = stmt.data.declaration;
            return decl === null ? true : isPureStatement(decl, jsxPure);
        }
        case N.ExportDefaultDeclaration: {
            const decl = stmt.data.declaration;
            if (decl.type === N.FunctionDeclaration) return true;
            if (decl.type === N.ClassDeclaration) return isPureStatement(decl, jsxPure);
            return isPureExpr(decl, jsxPure);
        }
        default:
            return false;
    }
}
