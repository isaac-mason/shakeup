// TS type-strip pass (transform stage). Ports the printer's print-time type-stripping to an AST
// mutation pass (oxc's `typescript/annotations.rs` + `class.rs` model), so the printer becomes pure
// codegen. Runs as a 2nd traverse AFTER tsLower/jsxLower (value enum/ns/JSX already lowered), so it
// only sees residual type syntax. Enum/namespace/import-equals are NOT handled here (tsLower owns them).
//
// A1a (this file): the functional strip — unwrap type-assertion expressions, remove type-only
// statements + class members, filter type-only import/export specifiers, and lower constructor
// parameter properties. A1b (annotation-field clearing, for a fully plain-JS AST) is layered on top.
import { N, type Node, node } from '../ast.ts';
import * as create from '../parser/create.ts';
import { hookTable, type Visitor } from './traverse.ts';

const S = 0; // synthetic span (leaves print verbatim)

const idName = (name: string): Node => node(N.IdentifierName, S, S, name, null);
const idRef = (name: string, sym: number): Node => {
    const n = node(N.IdentifierReference, S, S, name, null);
    (n as { sym: number }).sym = sym;
    return n;
};
const member = (obj: Node, prop: Node): Node => create.StaticMemberExpression(S, S, 0, obj, prop) as Node;
const assign = (l: Node, r: Node): Node => create.AssignmentExpression(S, S, '=', l, r) as Node;
const exprStmt = (e: Node): Node => create.ExpressionStatement(S, S, 0, e) as Node;

/** A whole statement that erases in strip mode (mirrors the printer's `isErasedStmt`): type
 *  declarations, `declare` ambients, body-less overload signatures, type-only import/export. Value
 *  enum/namespace/import-equals are already lowered by tsLower, so only their `declare` forms remain. */
function isErasedStmt(n: Node): boolean {
    const d = n.data as Record<string, unknown>;
    switch (n.type) {
        case N.TSInterfaceDeclaration:
        case N.TSTypeAliasDeclaration:
            return true;
        case N.FunctionDeclaration:
            return d.declare === true || d.body === null; // `declare function` or overload signature
        case N.ClassDeclaration:
        case N.VariableDeclaration:
        case N.TSModuleDeclaration:
        case N.TSEnumDeclaration:
            return d.declare === true;
        case N.ImportDeclaration:
            return d.importKind === 'type';
        case N.ExportNamedDeclaration:
            return d.exportKind === 'type';
        default:
            return false;
    }
}

/** A class-body member that erases in strip mode (printer's `isErasedClassMember`): index signature,
 *  body-less method overload, `declare` field. */
function isErasedClassMember(n: Node): boolean {
    if (n.type === N.TSIndexSignature) return true;
    if (n.type === N.MethodDefinition) {
        const v = (n.data as { value: Node }).value;
        return v !== null && (v.data as { body: Node | null }).body === null;
    }
    if (n.type === N.PropertyDefinition) return (n.data as { declare: boolean }).declare === true;
    return false;
}

const isSuperCall = (n: Node): boolean =>
    n.type === N.ExpressionStatement &&
    (n.data as { expression: Node }).expression.type === N.CallExpression &&
    ((n.data as { expression: Node }).expression.data as { callee: Node }).callee.type === N.Super;

/** Lower constructor parameter properties (`constructor(private x)`) → `this.x = x;` prepended to the
 *  body (after a leading `super(...)`). The field name is the original param name; the RHS references
 *  the param binding (same symbol, so it renames consistently). oxc's `class.rs`. */
function lowerParamProps(ctor: Node): void {
    const value = (ctor.data as { value: Node }).value;
    if (value === null || value.type !== N.FunctionExpression) return;
    const body = (value.data as { body: Node | null }).body;
    if (body === null || body.type !== N.BlockStatement) return;
    const assigns: Node[] = [];
    for (const par of (value.data as { params: Node[] }).params) {
        if (par.type !== N.FormalParameter) continue;
        const pd = par.data as { accessibility: string | null; readonly: boolean; pattern: Node };
        if (pd.accessibility === null && pd.readonly !== true) continue;
        const pat = pd.pattern;
        if (pat.type !== N.BindingIdentifier) continue; // TS forbids destructuring param props
        assigns.push(
            exprStmt(
                assign(
                    member(create.ThisExpression(S, S, 0) as Node, idName(pat.name)),
                    idRef(pat.name, (pat as { sym: number }).sym),
                ),
            ),
        );
    }
    if (assigns.length === 0) return;
    const stmts = (body.data as { body: Node[] }).body;
    const at = stmts.length > 0 && isSuperCall(stmts[0]) ? 1 : 0;
    stmts.splice(at, 0, ...assigns);
}

/** Drop type-only specifiers from an import/export; returns true if the whole statement should be
 *  removed (type-kind, or nothing runtime-bearing survives). */
function stripImport(n: Node): boolean {
    const d = n.data as { importKind: string; specifiers: Node[] };
    if (d.importKind === 'type') return true;
    if (d.specifiers.length === 0) return false; // side-effect import `import 'x'` — keep
    d.specifiers = d.specifiers.filter(
        (s) => !(s.type === N.ImportSpecifier && (s.data as { importKind: string }).importKind === 'type'),
    );
    return d.specifiers.length === 0; // everything was type-only → erase
}

function stripExport(n: Node): boolean {
    const d = n.data as { exportKind: string; declaration: Node | null; specifiers: Node[]; source: Node | null };
    if (d.exportKind === 'type') return true;
    if (d.declaration !== null) return isErasedStmt(d.declaration) || isTypeOnlyDecl(d.declaration);
    d.specifiers = d.specifiers.filter(
        (s) => !(s.type === N.ExportSpecifier && (s.data as { exportKind: string }).exportKind === 'type'),
    );
    return d.specifiers.length === 0 && d.source === null; // no runtime specifiers and no re-export source
}

const isTypeOnlyDecl = (decl: Node): boolean =>
    decl.type === N.TSInterfaceDeclaration ||
    decl.type === N.TSTypeAliasDeclaration ||
    (decl.data as { declare?: boolean }).declare === true;

/** The TS type-strip pass. */
export const tsStrip: Visitor = {
    name: 'tsStrip',
    enter: hookTable({
        // Type-assertion / non-null / instantiation wrappers → the inner expression.
        [N.TSAsExpression]: (n, ctx) => ctx.replaceWith((n.data as { expression: Node }).expression),
        [N.TSSatisfiesExpression]: (n, ctx) => ctx.replaceWith((n.data as { expression: Node }).expression),
        [N.TSNonNullExpression]: (n, ctx) => ctx.replaceWith((n.data as { expression: Node }).expression),
        [N.TSInstantiationExpression]: (n, ctx) => ctx.replaceWith((n.data as { expression: Node }).expression),
        // Type-only statements → removed.
        [N.TSInterfaceDeclaration]: (_n, ctx) => ctx.remove(),
        [N.TSTypeAliasDeclaration]: (_n, ctx) => ctx.remove(),
        [N.FunctionDeclaration]: (n, ctx) => {
            if (isErasedStmt(n)) ctx.remove();
        },
        [N.ClassDeclaration]: (n, ctx) => {
            if (isErasedStmt(n)) ctx.remove();
        },
        [N.VariableDeclaration]: (n, ctx) => {
            if (isErasedStmt(n)) ctx.remove();
        },
        [N.ImportDeclaration]: (n, ctx) => {
            if (stripImport(n)) ctx.remove();
        },
        [N.ExportNamedDeclaration]: (n, ctx) => {
            if (stripExport(n)) ctx.remove();
        },
        // Class-body type-only members → removed.
        [N.TSIndexSignature]: (_n, ctx) => ctx.remove(),
        [N.MethodDefinition]: (n, ctx) => {
            if (isErasedClassMember(n)) {
                ctx.remove();
                return;
            }
            if ((n.data as { kind: string }).kind === 'constructor') lowerParamProps(n);
        },
        [N.PropertyDefinition]: (n, ctx) => {
            if (isErasedClassMember(n)) ctx.remove();
        },
    }),
    exit: null,
};
