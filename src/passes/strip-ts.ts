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
import { hookTable, type Visitor, type TransformCtx } from './traverse.ts';

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
function lowerParamProps(ctor: Node, ctx: TransformCtx): void {
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
    // These statements are installed by REPLACING the body array rather than through
    // `ctx.spliceStatements` (an empty body is the shared frozen EMPTY_LIST, which cannot be spliced
    // in place), so the traversal's automatic `addRefs` never sees them. Each `this.x = x` introduces
    // a genuinely NEW read of the parameter, so record it explicitly — without this the parameter
    // looks less referenced than it is, which is the unsafe direction (`dropUnused` could delete a
    // binding that is still read).
    for (const a of assigns) ctx.addRefs(a);
    // Build a fresh array — an empty body is the shared frozen EMPTY_LIST (can't splice in place).
    (body.data as { body: Node[] }).body = [...stmts.slice(0, at), ...assigns, ...stmts.slice(at)];
}

/** Drop type-only specifiers from an import/export; returns true if the whole statement should be
 *  removed (type-kind, or nothing runtime-bearing survives). */
function stripImport(n: Node, ctx: TransformCtx): boolean {
    const d = n.data as { importKind: string; specifiers: Node[] };
    if (d.importKind === 'type') {
        for (const sp of d.specifiers) evictSymbol(ctx, sp);
        return true;
    }
    if (d.specifiers.length === 0) return false; // side-effect import `import 'x'` — keep
    d.specifiers = d.specifiers.filter((s) => {
        const typeOnly = s.type === N.ImportSpecifier && (s.data as { importKind: string }).importKind === 'type';
        if (typeOnly) evictSymbol(ctx, s);
        return !typeOnly;
    });
    return d.specifiers.length === 0; // everything was type-only → erase
}

/** An erased `import type { X }` leaves a symbol record behind in a MAINTAINED semantic, where a
 *  rebuilt one would simply never have created it. Left in module scope it still claims its name
 *  during deconfliction, so the VALUE that legitimately owns that name is pushed to `X$1`.
 *
 *  Evicting it by scope (rather than filtering at the claim site) is what keeps the two paths
 *  identical: `deconflict` skips it because it is no longer module-scoped, while the real binding
 *  still claims the name normally — so the name stays RESERVED and the chunk mangler cannot hand it
 *  to a local. Filtering in `deconflict` instead left the name looking free and the mangler reissued
 *  it, emitting a duplicate top-level declaration. */
function evictSymbol(ctx: TransformCtx, specifier: Node): void {
    evictSym(ctx, ((specifier.data as { local?: Node }).local as { sym: number } | undefined)?.sym ?? 0);
}

/** Same eviction for a type declaration erased whole (`interface` / `type X =`). */
function evictDeclSymbol(ctx: TransformCtx, decl: Node): void {
    evictSym(ctx, ((decl.data as { id?: Node }).id as { sym: number } | undefined)?.sym ?? 0);
}

function evictSym(ctx: TransformCtx, sym: number): void {
    if (sym === 0) return; // unresolved / no symbol — symbols[0] is the table's own sentinel
    const rec = ctx.semantic.symbols[sym];
    // Scope 0 is the root sentinel `createSemantic` seeds and is never a module scope, so this
    // reads as "owned by no lexical scope" while staying a VALID index for anything that does
    // `scopes[rec.scope]` (an out-of-range sentinel crashed chunk-graph).
    if (rec !== undefined) rec.scope = 0;
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

const isAssertion = (t: number): boolean =>
    t === N.TSAsExpression || t === N.TSSatisfiesExpression || t === N.TSNonNullExpression || t === N.TSInstantiationExpression;

/** Peel ALL nested type-assertion layers (`(a as T)!`, `a as B as C`) in one step — the traverse
 *  doesn't re-fire `enter` on a `replaceWith` replacement, so a single-layer unwrap would leave a
 *  nested assertion behind (→ printer sees a `TSAsExpression`). */
function unwrapAssertions(n: Node): Node {
    let e = n;
    while (isAssertion(e.type)) e = (e.data as { expression: Node }).expression;
    return e;
}

/** Clear TS type-annotation fields (and TS-only modifiers) so the post-transform AST is genuinely
 *  plain JS — oxc `annotations.rs`. The printer already ignores these; clearing them is for consumers
 *  of the plain AST (compilecat). Done on ENTER, so the traverse also skips descending into the (now
 *  null/empty) type subtrees. */
/** Subtract the references held by a type subtree that is about to be erased.
 *
 *  Type annotations DO carry resolved references — `analyze` resolves a `TSTypeReference`'s entity
 *  name in the type namespace and tallies it like any other. Nulling the field without subtracting
 *  them leaves those symbols looking referenced by code that no longer exists, so `dropUnused` keeps
 *  declarations it should drop. That direction is SAFE (it cannot miscompile) but it costs bytes:
 *  measured at +188 bytes on a minified crashcat bundle before this was added. */
function dropTypeRefs(ctx: TransformCtx, t: unknown): void {
    if (t === null || t === undefined) return;
    if (Array.isArray(t)) {
        for (const x of t) if (x !== null && x !== undefined) ctx.dropRefs(x as Node);
        return;
    }
    ctx.dropRefs(t as Node);
}

function clearTypes(n: Node, ctx: TransformCtx): void {
    const d = n.data as Record<string, unknown>;
    switch (n.type) {
        case N.VariableDeclarator:
            dropTypeRefs(ctx, d.typeAnnotation);
            d.typeAnnotation = null;
            d.definite = false;
            break;
        case N.PropertyDefinition:
            dropTypeRefs(ctx, d.typeAnnotation);
            d.typeAnnotation = null;
            d.optional = false;
            d.definite = false;
            d.readonly = false;
            d.abstract = false;
            d.accessibility = null;
            break;
        case N.FormalParameter:
            dropTypeRefs(ctx, d.typeAnnotation);
            d.typeAnnotation = null;
            d.optional = false;
            d.readonly = false;
            d.accessibility = null;
            break;
        case N.RestElement:
            dropTypeRefs(ctx, d.typeAnnotation);
            d.typeAnnotation = null;
            break;
        case N.MethodDefinition:
            d.optional = false;
            d.abstract = false;
            d.accessibility = null;
            break;
        case N.FunctionDeclaration:
        case N.FunctionExpression:
        case N.ArrowFunctionExpression:
            dropTypeRefs(ctx, d.typeParameters);
            dropTypeRefs(ctx, d.returnType);
            d.typeParameters = null;
            d.returnType = null;
            break;
        case N.ClassDeclaration:
        case N.ClassExpression:
            dropTypeRefs(ctx, d.typeParameters);
            dropTypeRefs(ctx, d.superTypeArguments);
            dropTypeRefs(ctx, d.implements);
            d.typeParameters = null;
            d.superTypeArguments = null;
            d.implements = [];
            d.abstract = false;
            break;
        case N.CallExpression:
        case N.NewExpression:
            dropTypeRefs(ctx, d.typeArguments);
            d.typeArguments = null;
            break;
    }
}

/** The TS type-strip pass. */
export const tsStrip: Visitor = {
    name: 'tsStrip',
    enter: hookTable({
        // Type-assertion / non-null / instantiation wrappers → the inner expression (all layers).
        [N.TSAsExpression]: (n, ctx) => ctx.replaceWith(unwrapAssertions(n)),
        [N.TSSatisfiesExpression]: (n, ctx) => ctx.replaceWith(unwrapAssertions(n)),
        [N.TSNonNullExpression]: (n, ctx) => ctx.replaceWith(unwrapAssertions(n)),
        [N.TSInstantiationExpression]: (n, ctx) => ctx.replaceWith(unwrapAssertions(n)),
        // Type-only statements → removed.
        [N.TSInterfaceDeclaration]: (n, ctx) => {
            evictDeclSymbol(ctx, n);
            ctx.remove();
        },
        [N.TSTypeAliasDeclaration]: (n, ctx) => {
            evictDeclSymbol(ctx, n);
            ctx.remove();
        },
        // NOTE: `declare` forms are erased but their symbols are deliberately NOT evicted. A
        // TYPE-ONLY declaration (`interface` / `type X =` / `import type`) leaves no reference behind,
        // so a rebuilt semantic reserves nothing for it and the maintained one must not either. A
        // `declare const g` is the opposite: references to `g` SURVIVE the strip as unresolved, so a
        // rebuild reserves the name via `Semantic.unresolved` — and keeping the symbol reserves it
        // exactly the same way. Evicting here instead left the name free for capture.
        [N.FunctionDeclaration]: (n, ctx) => {
            if (isErasedStmt(n)) ctx.remove();
            else clearTypes(n, ctx);
        },
        [N.ClassDeclaration]: (n, ctx) => {
            if (isErasedStmt(n)) ctx.remove();
            else clearTypes(n, ctx);
        },
        [N.VariableDeclaration]: (n, ctx) => {
            if (isErasedStmt(n)) ctx.remove();
        },
        // Pure type-field clearing (A1b — plain-JS AST).
        [N.VariableDeclarator]: (n, ctx) => clearTypes(n, ctx),
        [N.FormalParameter]: (n, ctx) => clearTypes(n, ctx),
        [N.RestElement]: (n, ctx) => clearTypes(n, ctx),
        [N.FunctionExpression]: (n, ctx) => clearTypes(n, ctx),
        [N.ArrowFunctionExpression]: (n, ctx) => clearTypes(n, ctx),
        [N.ClassExpression]: (n, ctx) => clearTypes(n, ctx),
        [N.CallExpression]: (n, ctx) => clearTypes(n, ctx),
        [N.NewExpression]: (n, ctx) => clearTypes(n, ctx),
        // `declare enum`/`declare namespace` — tsLower only lowers the VALUE forms, so the declare
        // (ambient) ones reach here and erase.
        [N.TSEnumDeclaration]: (n, ctx) => {
            if ((n.data as { declare: boolean }).declare === true) ctx.remove();
        },
        [N.TSModuleDeclaration]: (n, ctx) => {
            if ((n.data as { declare: boolean }).declare === true) ctx.remove();
        },
        [N.ImportDeclaration]: (n, ctx) => {
            if (stripImport(n, ctx)) ctx.remove();
        },
        [N.ExportNamedDeclaration]: (n, ctx) => {
            if (stripExport(n)) {
                // The wrapper is erased WITHOUT descending, so the inner declaration's own hook
                // never runs — `export interface X {}` must be evicted from here or its symbol
                // survives at module scope and claims `X` during deconfliction.
                const inner = (n.data as { declaration?: Node }).declaration;
                if (inner !== null && inner !== undefined) evictDeclSymbol(ctx, inner);
                for (const sp of ((n.data as { specifiers?: Node[] }).specifiers ?? [])) evictSymbol(ctx, sp);
                ctx.remove();
            }
        },
        // Class-body type-only members → removed.
        [N.TSIndexSignature]: (_n, ctx) => ctx.remove(),
        [N.MethodDefinition]: (n, ctx) => {
            if (isErasedClassMember(n)) {
                ctx.remove();
                return;
            }
            if ((n.data as { kind: string }).kind === 'constructor') lowerParamProps(n, ctx);
            clearTypes(n, ctx);
        },
        [N.PropertyDefinition]: (n, ctx) => {
            if (isErasedClassMember(n)) ctx.remove();
            else clearTypes(n, ctx);
        },
    }),
    exit: hookTable({
        // `Semantic.symbolInit` holds the declarator init NODE per symbol, recorded by `analyze`
        // before this pass ran. Unwrapping `x!` / `x as T` replaces that node, leaving the entry
        // pointing at a detached wrapper — so `alias-inline` and `const-prop` see a
        // `TSNonNullExpression` where the tree now has the `CallExpression` it wrapped, and decline
        // to fire. Repairing is O(symbols-with-inits) (median 94 per module), not a tree walk,
        // because the replacement is always a DESCENDANT reachable by the same unwrap.
        [N.Program]: (_n, ctx) => {
            const sem = ctx.semantic;
            const si = sem.symbolInit;
            for (const [sym, init] of si) {
                const inner = unwrapAssertions(init);
                if (inner !== init) si.set(sym, inner);
            }
            // `Semantic.unresolved` holds the reference NODES that resolved to nothing; `deconflict`
            // seeds its taken-name set from them. `lowerEnum`'s `qualifyMemberRefs` rewrites a bare
            // member reference (`C = B`) into `_E.B` by RETYPING the node in place, so an entry here
            // can be left pointing at something that is no longer an identifier at all — and its
            // stale name then reserves a name nothing uses. Dropping the retyped ones is
            // O(unresolved), and it generalises to any in-place retype a lowering performs.
            const live = sem.unresolved.filter((n) => n.type === N.IdentifierReference && n.sym === 0);
            if (live.length !== sem.unresolved.length) sem.unresolved.length = 0, sem.unresolved.push(...live);
        },
    }),
};
