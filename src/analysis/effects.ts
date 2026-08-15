import { type Node, N } from '../ast.ts';

let jsxTreatedPure = true;
/** Configure JSX purity for subsequent {@link isPureExpr}/{@link isPureStatement} calls. */
export function setJsxPurity(pure: boolean): void {
    jsxTreatedPure = pure;
}

/** Conservatively true if evaluating this expression has no observable side effects. */
export function isPureExpr(node: Node | null): boolean {
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
            return node.data.superClass === null && !classHasStaticEffects(node);
        case N.TemplateLiteral: {
            for (const e of node.data.expressions) if (!isPureExpr(e)) return false;
            return true;
        }
        case N.ArrayExpression: {
            for (const el of node.data.elements) {
                if (el === null) continue;
                if (el.type === N.SpreadElement) return false;
                if (!isPureExpr(el)) return false;
            }
            return true;
        }
        case N.ObjectExpression: {
            for (const p of node.data.properties) {
                if (p.type === N.SpreadElement) return false;
                if (p.type !== N.ObjectProperty) continue;
                if (p.data.computed && !isPureExpr(p.data.key)) return false;
                if (p.data.kind === 'init' && !isPureExpr(p.data.value)) return false;
            }
            return true;
        }
        case N.UnaryExpression:
            return node.data.operator !== 'delete' && isPureExpr(node.data.argument);
        case N.BinaryExpression:
            return isPureExpr(node.data.left) && isPureExpr(node.data.right);
        case N.LogicalExpression:
            return isPureExpr(node.data.left) && isPureExpr(node.data.right);
        case N.ConditionalExpression:
            return (
                isPureExpr(node.data.test) &&
                isPureExpr(node.data.consequent) &&
                isPureExpr(node.data.alternate)
            );
        case N.SequenceExpression: {
            for (const e of node.data.expressions) if (!isPureExpr(e)) return false;
            return true;
        }
        case N.TSAsExpression:
        case N.TSSatisfiesExpression:
            return isPureExpr(node.data.expression);
        case N.JSXElement:
            return jsxTreatedPure && jsxElementPure(node);
        case N.JSXFragment:
            return jsxTreatedPure && jsxChildrenPure(node.data.children);
        default:
            return false;
    }
}

function jsxElementPure(node: Node & { type: typeof N.JSXElement }): boolean {
    const opening = node.data.openingElement as Node & { type: typeof N.JSXOpeningElement };
    for (const a of opening.data.attributes) {
        if (a.type === N.JSXSpreadAttribute) {
            if (!isPureExpr(a.data.argument)) return false;
        } else if (a.type === N.JSXAttribute) {
            const v = a.data.value;
            if (v !== null && !jsxAttrValuePure(v)) return false;
        }
    }
    return jsxChildrenPure(node.data.children);
}

function jsxAttrValuePure(value: Node): boolean {
    if (value.type === N.StringLiteral) return true;
    if (value.type === N.JSXExpressionContainer) {
        const e = value.data.expression;
        return e.type === N.JSXEmptyExpression || isPureExpr(e);
    }
    if (value.type === N.JSXElement || value.type === N.JSXFragment) return isPureExpr(value);
    return isPureExpr(value);
}

function jsxChildrenPure(children: Node[]): boolean {
    for (const child of children) {
        if (child.type === N.JSXText) continue;
        if (child.type === N.JSXExpressionContainer) {
            const e = child.data.expression;
            if (e.type === N.JSXEmptyExpression) continue;
            if (!isPureExpr(e)) return false;
        } else if (child.type === N.JSXSpreadChild) {
            if (!isPureExpr(child.data.expression)) return false;
        } else if (child.type === N.JSXElement || child.type === N.JSXFragment) {
            if (!isPureExpr(child)) return false;
        }
    }
    return true;
}

/** True if evaluating a class declaration/expression runs static side effects (static blocks, impure static/computed keys). */
export function classHasStaticEffects(classNode: Node): boolean {
    if (classNode.type !== N.ClassDeclaration && classNode.type !== N.ClassExpression) return false;
    for (const m of classNode.data.body) {
        if (m.type === N.StaticBlock) return true;
        if (m.type === N.PropertyDefinition && m.data.static && !isPureExpr(m.data.value)) return true;
        if ((m.type === N.MethodDefinition || m.type === N.PropertyDefinition) && m.data.computed) {
            if (!isPureExpr(m.data.key)) return true;
        }
    }
    return false;
}

/**
 * Conservatively true if executing `stmt` in place has no immediate side
 * effects. Declarations count as pure (liveness is the caller's policy);
 * ImportDecl is pure here since import side-effect policy is a graph concern.
 */
export function isPureStatement(stmt: Node): boolean {
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
            return stmt.data.superClass === null && !classHasStaticEffects(stmt);
        case N.VariableDeclaration: {
            for (const d of stmt.data.declarations) {
                if (d.type === N.VariableDeclarator && !isPureExpr(d.data.init)) return false;
            }
            return true;
        }
        case N.ExportNamedDeclaration: {
            const decl = stmt.data.declaration;
            return decl === null ? true : isPureStatement(decl);
        }
        case N.ExportDefaultDeclaration: {
            const decl = stmt.data.declaration;
            if (decl.type === N.FunctionDeclaration) return true;
            if (decl.type === N.ClassDeclaration) return isPureStatement(decl);
            return isPureExpr(decl);
        }
        default:
            return false;
    }
}
