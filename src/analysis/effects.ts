// Conservative (sound, not sharp) expression/statement purity over type+data Nodes.
// LIMIT: calls/new/member-reads/spreads are all treated effectful; no @__PURE__ (lexer drops comments).

import { type Node, N } from '../ast.ts';

/** Conservatively true if evaluating this expression has no observable side effects. */
export function isPureExpr(node: Node | null): boolean {
    if (node === null) return true;
    switch (node.type) {
        // any identifier ROLE — a bare name reference/leaf has no side effect
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
            // pure when there's no superclass expression and no static effects
            return node.data.superClass === null && !classHasStaticEffects(node);
        case N.TemplateLiteral: {
            for (const e of node.data.expressions) if (!isPureExpr(e)) return false;
            return true; // stringification of pure operands — accepted
        }
        case N.ArrayExpression: {
            for (const el of node.data.elements) {
                if (el === null) continue;
                if (el.type === N.SpreadElement) return false; // iterators
                if (!isPureExpr(el)) return false;
            }
            return true;
        }
        case N.ObjectExpression: {
            for (const p of node.data.properties) {
                if (p.type === N.SpreadElement) return false; // getters via spread
                if (p.type !== N.ObjectProperty) continue;
                if (p.data.computed && !isPureExpr(p.data.key)) return false;
                if (p.data.kind === 'init' && !isPureExpr(p.data.value)) return false;
                // getters/setters define, not invoke — pure
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
        case N.TSNonNullExpression:
            return isPureExpr(node.data.expression);
        default:
            // Member (getters), Call, New, Assign, Update, Await, Yield,
            // TaggedTemplate, ImportExpr, ... — effectful.
            return false;
    }
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
            return true; // lowering writes only its own var
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
            return false; // expression statements, loops, ifs, ... — effectful
    }
}
