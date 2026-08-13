// Conservative (sound, not sharp) expression/statement purity over (Ast, NodeId).
// LIMIT: calls/new/member-reads/spreads are all treated effectful; no @__PURE__ (lexer drops comments).

import { A, type Ast, FL, N, type NodeId, listAt, listLen } from '../ast';

/** Conservatively true if evaluating this expression has no observable side effects. */
export function isPureExpr(ast: Ast, node: NodeId): boolean {
    if (node === 0) return true;
    const t = ast.type[node];
    switch (t) {
        case N.Ident:
        case N.Num:
        case N.Str:
        case N.Bool:
        case N.Null:
        case N.Regex:
        case N.BigInt:
        case N.ThisExpr:
        case N.MetaProp:
        case N.Arrow:
        case N.FuncExpr:
            return true;
        case N.ClassExpr:
            // pure when there's no superclass expression and no static effects
            return A.ClassExpr.superClass(ast, node) === 0 && !classHasStaticEffects(ast, node);
        case N.TemplateLiteral: {
            const exprs = A.TemplateLiteral.exprs(ast, node);
            for (let i = 0; i < listLen(ast, exprs); i++) if (!isPureExpr(ast, listAt(ast, exprs, i))) return false;
            return true; // stringification of pure operands — accepted
        }
        case N.ArrayExpr: {
            const els = A.ArrayExpr.elements(ast, node);
            for (let i = 0; i < listLen(ast, els); i++) {
                const el = listAt(ast, els, i);
                if (el === 0) continue;
                if (ast.type[el] === N.Spread) return false; // iterators
                if (!isPureExpr(ast, el)) return false;
            }
            return true;
        }
        case N.ObjectExpr: {
            const props = A.ObjectExpr.props(ast, node);
            for (let i = 0; i < listLen(ast, props); i++) {
                const p = listAt(ast, props, i);
                if (ast.type[p] === N.Spread) return false; // getters via spread
                if ((ast.flags[p] & FL.COMPUTED) !== 0 && !isPureExpr(ast, A.Property.key(ast, p))) return false;
                const kind = (ast.flags[p] >> FL.KIND_SHIFT) & 3;
                if (kind === 0 && !isPureExpr(ast, A.Property.value(ast, p))) return false;
                // getters/setters define, not invoke — pure
            }
            return true;
        }
        case N.Unary:
            return (ast.flags[node] & 63) !== 32 /* OP.DELETE */ && isPureExpr(ast, A.Unary.arg(ast, node));
        case N.Binary:
            return isPureExpr(ast, A.Binary.left(ast, node)) && isPureExpr(ast, A.Binary.right(ast, node));
        case N.Logical:
            return isPureExpr(ast, A.Logical.left(ast, node)) && isPureExpr(ast, A.Logical.right(ast, node));
        case N.Cond:
            return (
                isPureExpr(ast, A.Cond.test(ast, node)) &&
                isPureExpr(ast, A.Cond.consequent(ast, node)) &&
                isPureExpr(ast, A.Cond.alternate(ast, node))
            );
        case N.Seq: {
            const exprs = A.Seq.exprs(ast, node);
            for (let i = 0; i < listLen(ast, exprs); i++) if (!isPureExpr(ast, listAt(ast, exprs, i))) return false;
            return true;
        }
        case N.TSAs:
        case N.TSSatisfies:
            return isPureExpr(ast, A.TSAs.expr(ast, node));
        case N.TSNonNull:
            return isPureExpr(ast, A.TSNonNull.expr(ast, node));
        default:
            // Member (getters), Call, New, Assign, Update, Await, Yield,
            // TaggedTemplate, ImportExpr, ... — effectful.
            return false;
    }
}

/** True if evaluating a class declaration/expression runs static side effects (static blocks, impure static/computed keys). */
export function classHasStaticEffects(ast: Ast, classNode: NodeId): boolean {
    const body = A[ast.type[classNode] === N.ClassDecl ? 'ClassDecl' : 'ClassExpr'].body(ast, classNode);
    for (let i = 0; i < listLen(ast, body); i++) {
        const m = listAt(ast, body, i);
        const mt = ast.type[m];
        if (mt === N.StaticBlock) return true;
        if (mt === N.PropDef && (ast.flags[m] & FL.STATIC) !== 0 && !isPureExpr(ast, A.PropDef.value(ast, m))) return true;
        if ((ast.flags[m] & FL.COMPUTED) !== 0) {
            const key = mt === N.MethodDef ? A.MethodDef.key(ast, m) : A.PropDef.key(ast, m);
            if (!isPureExpr(ast, key)) return true;
        }
    }
    return false;
}

/**
 * Conservatively true if executing `stmt` in place has no immediate side
 * effects. Declarations count as pure (liveness is the caller's policy);
 * ImportDecl is pure here since import side-effect policy is a graph concern.
 */
export function isPureStatement(ast: Ast, stmt: NodeId): boolean {
    switch (ast.type[stmt]) {
        case N.FuncDecl:
        case N.TSInterfaceDecl:
        case N.TSTypeAliasDecl:
        case N.ImportDecl:
        case N.ExportAll:
        case N.Empty:
            return true;
        case N.TSEnumDecl:
            return true; // lowering writes only its own var
        case N.ClassDecl:
            return A.ClassDecl.superClass(ast, stmt) === 0 && !classHasStaticEffects(ast, stmt);
        case N.VarDecl: {
            const decls = A.VarDecl.declarators(ast, stmt);
            for (let i = 0; i < listLen(ast, decls); i++) {
                if (!isPureExpr(ast, A.VarDeclarator.init(ast, listAt(ast, decls, i)))) return false;
            }
            return true;
        }
        case N.ExportNamed: {
            const decl = A.ExportNamed.decl(ast, stmt);
            return decl === 0 ? true : isPureStatement(ast, decl);
        }
        case N.ExportDefault: {
            const decl = A.ExportDefault.decl(ast, stmt);
            const t = ast.type[decl];
            if (t === N.FuncDecl) return true;
            if (t === N.ClassDecl) return isPureStatement(ast, decl);
            return isPureExpr(ast, decl);
        }
        default:
            return false; // expression statements, loops, ifs, ... — effectful
    }
}
