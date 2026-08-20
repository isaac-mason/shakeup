// TS lowering passes (transform stage). First responsibility: value `enum` → IIFE, porting the
// print-time `emitEnum` (print-js.ts) to a mutation pass that emits real AST. Namespace lowering and
// type-strip join this pass next. `declare` enums are erased elsewhere (they emit no JS).
import { isPureExpr } from '../analysis/effects.ts';
import { N, type Node, node, set, walk } from '../ast.ts';
import * as create from '../parser/create.ts';
import { FL, VAR_KIND } from '../parser/create.ts';
import { hookTable, type TransformCtx, type Visitor } from './traverse.ts';

const S = 0; // synthetic span (leaves print verbatim; spans collapse to the enum site)

const idRef = (name: string, sym: number): Node => {
    const n = node(N.IdentifierReference, S, S, name, null);
    (n as { sym: number }).sym = sym;
    return n;
};
const bindId = (name: string, sym: number): Node => {
    const n = node(N.BindingIdentifier, S, S, name, null);
    (n as { sym: number }).sym = sym;
    return n;
};
const idName = (name: string): Node => node(N.IdentifierName, S, S, name, null);
const str = (raw: string): Node => node(N.StringLiteral, S, S, raw, null);
const num = (n: number): Node => node(N.NumericLiteral, S, S, String(n), null);
const computed = (obj: Node, expr: Node): Node => create.ComputedMemberExpression(S, S, 0, obj, expr) as Node;
const member = (obj: Node, prop: Node): Node => create.StaticMemberExpression(S, S, 0, obj, prop) as Node;
const assign = (l: Node, r: Node): Node => create.AssignmentExpression(S, S, '=', l, r) as Node;
const exprStmt = (e: Node): Node => create.ExpressionStatement(S, S, 0, e) as Node;

const obj = (): Node => create.ObjectExpression(S, S, 0, []) as Node;

/** Wrap `bodyStmts` (which reference the param `_X` and end in `return _X;`) in the shared
 *  single-statement IIFE-var form both enum and namespace lower to:
 *  `var X = /*@__PURE__*​/ (function(_X){ …body… })(<init>)`. `init` is `X || {}` at the top level, or
 *  `_P.X || (_P.X = {})` when nested inside a namespace whose param is `parentParam` (oxc's parent-
 *  linking). `id`/`sym`/`name` describe the outer binding; the call is PURE unless `sideEffect`. */
function iifeVarDecl(
    id: Node,
    name: string,
    sym: number,
    param: string,
    bodyStmts: Node[],
    sideEffect: boolean,
    parentParam: string | null,
): Node {
    const fn = create.FunctionExpression(
        S,
        S,
        0,
        null,
        null,
        [create.FormalParameter(S, S, 0, bindId(param, 0), null, null) as Node],
        null,
        create.BlockStatement(S, S, 0, bodyStmts) as Node,
    ) as Node;
    const arg =
        parentParam === null
            ? (create.LogicalExpression(S, S, '||', idRef(name, sym), obj()) as Node)
            : // nested: `_P.X || (_P.X = {})`
              (create.LogicalExpression(
                  S,
                  S,
                  '||',
                  member(idRef(parentParam, 0), idName(name)),
                  assign(member(idRef(parentParam, 0), idName(name)), obj()),
              ) as Node);
    const call = create.CallExpression(S, S, sideEffect ? 0 : FL.PURE, fn, [arg], null) as Node;
    return create.VariableDeclaration(S, S, VAR_KIND.VAR, [create.VariableDeclarator(S, S, 0, id, null, call) as Node]) as Node;
}

/** Qualify references to a prior enum member inside an initializer: `A` → `_E.A` (in place via
 *  `set`, mirroring `emitEnum`'s shadow rewrite). `enumParam` is the IIFE param name (`_E`). */
function qualifyMemberRefs(init: Node, priorMembers: Set<string>, enumParam: string): void {
    walk(init, (n) => {
        if (n.type === N.IdentifierReference && priorMembers.has(n.name)) {
            set(n, N.StaticMemberExpression, { object: idRef(enumParam, 0), property: idName(n.name), optional: false });
            return false; // don't descend into the rewritten member
        }
        return true;
    });
}

/** Lower one value enum to oxc's single-statement form (`enum.rs`):
 *  `var E = /*@__PURE__*​/ (function(_E){ _E[_E["A"]=0]="A"; …; return _E; })(E || {})`.
 *  ONE statement (var-with-IIFE-init) so tree-shaking ties the IIFE to E's liveness via
 *  declToStatement; the call is marked PURE unless a member initializer is a `new`/call, so a dead
 *  enum's lowering is dropped. Reuses the enum's binding id (+ symbol) for `var E`. */
function lowerEnum(enumNode: Node, ctx: TransformCtx): Node {
    const d = enumNode.data as { id: Node; members: Node[] };
    const enumId = d.id;
    const enumSym = (enumId as { sym: number }).sym;
    const enumName = enumId.name;
    const param = ctx.generateUid(enumName); // `_E`
    const pRef = (): Node => idRef(param, 0);

    const prior = new Set<string>();
    const stmts: Node[] = [];
    let autoNext = 0;
    let autoOk = true;
    let sideEffect = false; // any member initializer is a `new`/call → the IIFE may have side effects
    for (const m of d.members) {
        if (m.type !== N.TSEnumMember) continue;
        const md = m.data as { id: Node; initializer: Node | null };
        const key = md.id.type === N.StringLiteral ? md.id.name.slice(1, -1) : md.id.name;
        const keyLit = JSON.stringify(key);
        const init = md.initializer;
        if (init === null) {
            // auto: `_E[_E["A"]=n]="A"`
            stmts.push(exprStmt(assign(computed(pRef(), assign(computed(pRef(), str(keyLit)), num(autoNext))), str(keyLit))));
            autoNext++;
        } else {
            if (init.type === N.NewExpression || init.type === N.CallExpression) sideEffect = true;
            qualifyMemberRefs(init, prior, param);
            if (init.type === N.StringLiteral) {
                stmts.push(exprStmt(assign(computed(pRef(), str(keyLit)), init)));
                autoOk = false;
            } else {
                // `_E[_E["A"]=<init>]="A"`
                stmts.push(exprStmt(assign(computed(pRef(), assign(computed(pRef(), str(keyLit)), init)), str(keyLit))));
                if (init.type === N.NumericLiteral) {
                    const v = Number(init.name);
                    if (Number.isFinite(v)) {
                        autoNext = v + 1;
                        autoOk = true;
                    } else autoOk = false;
                } else autoOk = false;
            }
        }
        if (!autoOk) autoNext = 0; // a non-numeric member resets the auto sequence (matches emitEnum)
        prior.add(key);
    }
    stmts.push(create.ReturnStatement(S, S, 0, pRef()) as Node); // `return _E;`
    return iifeVarDecl(enumId, enumName, enumSym, param, stmts, sideEffect, null);
}

/** Statements a value namespace body member lowers to, or null if the member isn't handled yet
 *  (`export *`, `import =`, destructuring export). `thisParam` is the enclosing namespace's IIFE
 *  param (`_N`): used for the `_N.x = x` mirrors AND as the parent of any nested namespace. */
function lowerNsMember(stmt: Node, thisParam: string, ctx: TransformCtx): Node[] | null {
    const pRef = (): Node => idRef(thisParam, 0);
    // type-only members emit no JS.
    if (stmt.type === N.TSInterfaceDeclaration || stmt.type === N.TSTypeAliasDeclaration) return [];
    if ((stmt.data as { declare?: boolean }).declare === true) return [];
    // bare (non-exported) nested namespace → a local `var M = (…)(M || {})`, not on `_N`.
    if (isValueNamespace(stmt)) {
        const nested = lowerNamespace(stmt, ctx, null);
        return nested === null ? null : [nested];
    }
    // non-exported runtime statements pass through unchanged.
    if (stmt.type !== N.ExportNamedDeclaration) return [stmt];
    const decl = (stmt.data as { declaration: Node | null; specifiers: Node[] }).declaration;
    if (decl === null) return null; // `export { … }` / re-export — not handled yet
    // `export interface`/`export type` — type-only, erased.
    if (decl.type === N.TSInterfaceDeclaration || decl.type === N.TSTypeAliasDeclaration) return [];
    // `export namespace M` → nested namespace linked onto `_N.M` (parent = thisParam).
    if (isValueNamespace(decl)) {
        const nested = lowerNamespace(decl, ctx, thisParam);
        return nested === null ? null : [nested];
    }
    // `export enum E` → lowered enum (top-level form) + mirror onto `_N`.
    if (isValueEnum(decl)) {
        const varDecl = lowerEnum(decl, ctx);
        return [
            varDecl,
            exprStmt(
                assign(
                    member(pRef(), idName((decl.data as { id: Node }).id.name)),
                    idRef((decl.data as { id: Node }).id.name, ((decl.data as { id: Node }).id as { sym: number }).sym),
                ),
            ),
        ];
    }
    // `export const/let/var x = v` → keep the (unexported) decl + mirror each binding onto `_N`.
    if (decl.type === N.VariableDeclaration) {
        const decls = (decl.data as { declarations: Node[] }).declarations;
        const mirrors: Node[] = [];
        for (const d of decls) {
            const pat = (d.data as { id: Node }).id;
            if (pat.type !== N.BindingIdentifier) return null; // destructuring export — not handled yet
            mirrors.push(exprStmt(assign(member(pRef(), idName(pat.name)), idRef(pat.name, (pat as { sym: number }).sym))));
        }
        return [decl, ...mirrors];
    }
    // `export function f`/`class C` → keep the decl + `_N.f = f;`
    if (decl.type === N.FunctionDeclaration || decl.type === N.ClassDeclaration) {
        const id = (decl.data as { id: Node | null }).id;
        if (id === null) return null;
        return [decl, exprStmt(assign(member(pRef(), idName(id.name)), idRef(id.name, (id as { sym: number }).sym)))];
    }
    return null; // other — not handled yet
}

/** Lower a value namespace to the single-statement IIFE-var form (oxc's model): nested `export
 *  namespace` links onto the parent (`_P.M || (_P.M = {})` via `parentParam`), else top-level
 *  `Foo || {}`. Returns null if any member isn't handled — the caller leaves it for the graph to reject. */
function lowerNamespace(nsNode: Node, ctx: TransformCtx, parentParam: string | null): Node | null {
    const d = nsNode.data as { id: Node; body: Node[] };
    const nsId = d.id;
    const nsName = nsId.name;
    if (nsId.type !== N.BindingIdentifier) return null; // string-named `module "x"` — not handled
    const param = ctx.generateUid(nsName);
    const pRef = (): Node => idRef(param, 0);

    const body: Node[] = [];
    let sideEffect = false;
    for (const stmt of d.body) {
        const lowered = lowerNsMember(stmt, param, ctx);
        if (lowered === null) return null; // unhandled member → don't lower this namespace
        for (const s of lowered) body.push(s);
        if (!sideEffect) for (const s of lowered) if (!isPureNsStmt(s)) sideEffect = true;
    }
    body.push(create.ReturnStatement(S, S, 0, pRef()) as Node);
    return iifeVarDecl(nsId, nsName, (nsId as { sym: number }).sym, param, body, sideEffect, parentParam);
}

/** A lowered namespace body statement with no side effects (declarations + member mirrors of pure
 *  values). Conservative — anything else marks the namespace IIFE effectful (kept even if unused). */
function isPureNsStmt(stmt: Node): boolean {
    if (stmt.type === N.FunctionDeclaration || stmt.type === N.ClassDeclaration) return true;
    if (stmt.type === N.VariableDeclaration) {
        for (const dc of (stmt.data as { declarations: Node[] }).declarations) {
            const init = (dc.data as { init: Node | null }).init;
            if (init !== null && !isPureExpr(init, false)) return false;
        }
        return true;
    }
    // mirror `_Foo.x = <local ident>` is pure (assign to the local object).
    if (stmt.type === N.ExpressionStatement) {
        const e = (stmt.data as { expression: Node }).expression;
        if (e.type === N.AssignmentExpression) return isPureExpr((e.data as { right: Node }).right, false);
    }
    return false;
}

const isValueEnum = (n: Node): boolean => n.type === N.TSEnumDeclaration && (n.data as { declare: boolean }).declare !== true;
const isValueNamespace = (n: Node): boolean =>
    n.type === N.TSModuleDeclaration && (n.data as { declare: boolean }).declare !== true;

/** The TS lowering pass. Currently: value `enum` → IIFE (bare and `export enum`). Fires on `enter`
 *  and `replaceWithMultiple` — which short-circuits the child recursion (so `export enum`'s inner
 *  enum, sitting in a single-child slot, is never independently visited). */
export const tsLower: Visitor = {
    name: 'tsLower',
    enter: hookTable({
        [N.TSEnumDeclaration]: (node, ctx) => {
            if (isValueEnum(node)) ctx.replaceWith(lowerEnum(node, ctx));
        },
        [N.ExportNamedDeclaration]: (node, ctx) => {
            const decl = (node.data as { declaration: Node | null }).declaration;
            if (decl !== null && isValueEnum(decl)) {
                const varDecl = lowerEnum(decl, ctx);
                ctx.replaceWith(create.ExportNamedDeclaration(S, S, 0, varDecl, null, null) as Node);
            } else if (decl !== null && isValueNamespace(decl)) {
                const varDecl = lowerNamespace(decl, ctx, null);
                if (varDecl !== null) ctx.replaceWith(create.ExportNamedDeclaration(S, S, 0, varDecl, null, null) as Node);
            }
        },
        [N.TSModuleDeclaration]: (node, ctx) => {
            if (isValueNamespace(node)) {
                const varDecl = lowerNamespace(node, ctx, null);
                if (varDecl !== null) ctx.replaceWith(varDecl);
            }
        },
    }),
    exit: null,
};
