import { N, type Node } from '../ast.ts';

/**
 * Conservatively true if evaluating this expression has no observable side effects.
 * `jsxPure` selects whether a JSX element/fragment is treated as side-effect-free.
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
        case N.CallExpression: {
            // A `/*@__PURE__*/`-annotated call (oxc `CallExpression.pure`) is side-effect-free iff
            // its arguments are. Lowering passes set this on the enum/namespace IIFE.
            if (node.data.pure !== true) return false;
            for (const a of node.data.arguments) {
                const arg = a.type === N.SpreadElement ? a.data.argument : a;
                if (!isPureExpr(arg, jsxPure)) return false;
            }
            return true;
        }
        // JSX is lowered to `jsx(...)` calls before any effect analysis runs (jsxLower, transform
        // stage), so JSXElement/JSXFragment never reach here — their purity is the CallExpression's,
        // judged by standard side-effect rules (oxc/rolldown default; no bespoke JSX-spread optimism).
        default:
            return false;
    }
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
