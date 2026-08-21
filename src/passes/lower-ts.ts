// TS lowering passes (transform stage). First responsibility: value `enum` → IIFE, porting the
// print-time `emitEnum` (print-js.ts) to a mutation pass that emits real AST. Namespace lowering and
// type-strip join this pass next. `declare` enums are erased elsewhere (they emit no JS).
import { isPureExpr } from '../analysis/effects.ts';
import { createScope, declareLocal, SCOPE, SYM, scopeOf } from '../analysis/semantic.ts';
import { N, type Node, node, set, walk } from '../ast.ts';
import * as create from '../parser/create.ts';
import { FL, VAR_KIND } from '../parser/create.ts';
import { hookTable, type TransformCtx, type Visitor } from './traverse.ts';

const S = 0; // synthetic span (leaves print verbatim; spans collapse to the enum site)

/** A minted IIFE param: its reserved name plus the real SymbolId it binds to, so every reference
 *  carries `sym` and `mangleNestedScopes` can shorten it (oxc's `generate_uid` returns a bound id).
 *  `scope` is the fresh FUNCTION scope it lives in — the enclosing scope for the IIFE body's own
 *  nested enums/namespaces. */
type Uid = { name: string; sym: number; scope: number };

/** Mint a real IIFE-param binding for a lowering pass into `scope`: reserve a `_base` name and
 *  declare it as a PARAM symbol there, so every reference carries a real sym. */
function mintParam(base: string, scope: number, ctx: TransformCtx): Uid {
    const name = ctx.generateUid(base);
    const sym = declareLocal(ctx.semantic, bindId(name, 0), scope, SYM.PARAM);
    return { name, sym, scope };
}

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

/** Visit every binding identifier a pattern introduces (oxc's `BoundNames`), for the `_N.x = x`
 *  mirrors of a namespace `export const { a } = …` / `export const [a] = …`. Mirrors the shape of
 *  `declarePattern` in semantic.ts — BindingIdentifier leaves, everything else recurses. */
function forEachBoundName(pat: Node, fn: (name: string, sym: number) => void): void {
    switch (pat.type) {
        case N.BindingIdentifier:
            fn(pat.name, (pat as { sym: number }).sym);
            return;
        case N.ArrayPattern:
            for (const el of (pat.data as { elements: (Node | null)[] }).elements) if (el !== null) forEachBoundName(el, fn);
            return;
        case N.ObjectPattern:
            for (const p of (pat.data as { properties: Node[] }).properties) forEachBoundName(p, fn);
            return;
        case N.ObjectProperty:
            forEachBoundName((pat.data as { value: Node }).value, fn);
            return;
        case N.AssignmentPattern:
            forEachBoundName((pat.data as { left: Node }).left, fn);
            return;
        case N.RestElement:
            forEachBoundName((pat.data as { argument: Node }).argument, fn);
            return;
    }
}

/** Wrap `bodyStmts` (which reference the param `_X` and end in `return _X;`) in the shared
 *  single-statement IIFE-var form both enum and namespace lower to:
 *  `var X = /*@__PURE__*​/ (function(_X){ …body… })(<init>)`. `init` is `X || {}` at the top level, or
 *  `_P.X || (_P.X = {})` when nested inside a namespace whose param is `parentParam` (oxc's parent-
 *  linking). `id`/`sym`/`name` describe the outer binding; the call is PURE unless `sideEffect`. */
function iifeVarDecl(
    id: Node,
    name: string,
    sym: number,
    param: Uid,
    bodyStmts: Node[],
    sideEffect: boolean,
    parent: Uid | null,
): Node {
    const fn = create.FunctionExpression(
        S,
        S,
        0,
        null,
        null,
        [create.FormalParameter(S, S, 0, bindId(param.name, param.sym), null, null) as Node],
        null,
        create.BlockStatement(S, S, 0, bodyStmts) as Node,
    ) as Node;
    const arg =
        parent === null
            ? (create.LogicalExpression(S, S, '||', idRef(name, sym), obj()) as Node)
            : // nested: `_P.X || (_P.X = {})`
              (create.LogicalExpression(
                  S,
                  S,
                  '||',
                  member(idRef(parent.name, parent.sym), idName(name)),
                  assign(member(idRef(parent.name, parent.sym), idName(name)), obj()),
              ) as Node);
    const call = create.CallExpression(S, S, sideEffect ? 0 : FL.PURE, fn, [arg], null) as Node;
    return create.VariableDeclaration(S, S, VAR_KIND.VAR, [create.VariableDeclarator(S, S, 0, id, null, call) as Node]) as Node;
}

/** Qualify references to a prior enum member inside an initializer: `A` → `_E.A` (in place via
 *  `set`, mirroring `emitEnum`'s shadow rewrite). `enumParam` is the IIFE param name (`_E`). */
function qualifyMemberRefs(init: Node, priorMembers: Set<string>, enumParam: Uid): void {
    walk(init, (n) => {
        if (n.type === N.IdentifierReference && priorMembers.has(n.name)) {
            set(n, N.StaticMemberExpression, {
                object: idRef(enumParam.name, enumParam.sym),
                property: idName(n.name),
                optional: false,
            });
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
function lowerEnum(enumNode: Node, ctx: TransformCtx, enclosing: number): Node {
    const d = enumNode.data as { id: Node; members: Node[] };
    const enumId = d.id;
    const enumSym = (enumId as { sym: number }).sym;
    const enumName = enumId.name;
    // An enum has no body bindings (members are string keys), so the IIFE param gets a fresh
    // FUNCTION scope under the enclosing lexical scope.
    const param = mintParam(enumName, createScope(ctx.semantic, enclosing, SCOPE.FUNCTION), ctx); // `_E`
    const pRef = (): Node => idRef(param.name, param.sym);

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

/** Convert a value entity name (`A` / `A.B.C`) to the equivalent value expression: an
 *  IdentifierReference stays as-is; a TSQualifiedName becomes a static member chain. */
function entityToValue(ref: Node): Node {
    if (ref.type === N.TSQualifiedName) {
        const q = ref.data as { left: Node; right: Node };
        return member(entityToValue(q.left), idName(q.right.name));
    }
    return ref; // IdentifierReference — already a value ref
}

/** `import X = A.B` → `var X = A.B` (reuses the decl's own binding id). Returns null for the
 *  `import X = require("m")` external form — CommonJS interop is out of scope for an ESM browser
 *  bundler, so it's left un-lowered to reject loudly. Type-only (`import type X =`) is erased by the
 *  caller before this. */
function lowerImportEquals(node: Node): Node | null {
    const d = node.data as { id: Node; moduleReference: Node };
    if (d.moduleReference.type === N.TSExternalModuleReference) return null; // require() — reject
    const init = entityToValue(d.moduleReference);
    return create.VariableDeclaration(S, S, VAR_KIND.VAR, [create.VariableDeclarator(S, S, 0, d.id, null, init) as Node]) as Node;
}

/** Statements a value namespace body member lowers to, or null if the member isn't handled yet
 *  (`export *`). `thisParam` is the enclosing namespace's IIFE
 *  param (`_N`): used for the `_N.x = x` mirrors AND as the parent of any nested namespace. */
function lowerNsMember(stmt: Node, thisParam: Uid, ctx: TransformCtx): Node[] | null {
    const pRef = (): Node => idRef(thisParam.name, thisParam.sym);
    // type-only members emit no JS.
    if (stmt.type === N.TSInterfaceDeclaration || stmt.type === N.TSTypeAliasDeclaration) return [];
    if ((stmt.data as { declare?: boolean }).declare === true) return [];
    // bare (non-exported) `import X = A.B` → `var X = A.B` (no mirror); `import type X =` erased.
    if (stmt.type === N.TSImportEqualsDeclaration) {
        if ((stmt.data as { importKind: string }).importKind === 'type') return [];
        const lowered = lowerImportEquals(stmt);
        return lowered === null ? null : [lowered];
    }
    // bare (non-exported) nested namespace → a local `var M = (…)(M || {})`, not on `_N`.
    if (isValueNamespace(stmt)) {
        const nested = lowerNamespace(stmt, ctx, null);
        return nested === null ? null : nested === ERASE ? [] : [nested];
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
        return nested === null ? null : nested === ERASE ? [] : [nested];
    }
    // `export import X = A.B` → `var X = A.B` + mirror `_N.X = X`; `export import type X =` erased.
    if (decl.type === N.TSImportEqualsDeclaration) {
        if ((decl.data as { importKind: string }).importKind === 'type') return [];
        const lowered = lowerImportEquals(decl);
        if (lowered === null) return null;
        const id = (decl.data as { id: Node }).id;
        return [lowered, exprStmt(assign(member(pRef(), idName(id.name)), idRef(id.name, (id as { sym: number }).sym)))];
    }
    // `export enum E` → lowered enum (top-level form) + mirror onto `_N`.
    if (isValueEnum(decl)) {
        const varDecl = lowerEnum(decl, ctx, thisParam.scope);
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
    // Destructuring (`export const { a } = …`) mirrors every bound name (oxc's `bound_names`).
    if (decl.type === N.VariableDeclaration) {
        const decls = (decl.data as { declarations: Node[] }).declarations;
        const mirrors: Node[] = [];
        for (const d of decls)
            forEachBoundName((d.data as { id: Node }).id, (name, sym) =>
                mirrors.push(exprStmt(assign(member(pRef(), idName(name)), idRef(name, sym)))),
            );
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

/** oxc's three namespace outcomes: a lowered var-decl `Node`, `ERASE` (only type-only members →
 *  emit no JS, matching oxc's `is_namespace_module` early return), or `null` (a member we can't
 *  lower → leave the namespace intact for the graph to reject loudly). */
const ERASE = Symbol('erase');

/** Lower a value namespace to the single-statement IIFE-var form (oxc's model): nested `export
 *  namespace` links onto the parent (`_P.M || (_P.M = {})` via `parentParam`), else top-level
 *  `Foo || {}`. `ERASE` when the body has no runtime members; `null` if any member isn't handled. */
function lowerNamespace(nsNode: Node, ctx: TransformCtx, parent: Uid | null): Node | null | typeof ERASE {
    const d = nsNode.data as { id: Node; body: Node[] };
    const nsId = d.id;
    const nsName = nsId.name;
    if (nsId.type !== N.BindingIdentifier) return null; // string-named `module "x"` — not handled
    // The IIFE param joins the namespace's OWN analyzed scope (already parented + holding the body
    // vars), so the mangler sees param and body bindings together and never collides them.
    const param = mintParam(nsName, scopeOf(ctx.semantic, nsNode), ctx);
    const pRef = (): Node => idRef(param.name, param.sym);

    const body: Node[] = [];
    let sideEffect = false;
    for (const stmt of d.body) {
        const lowered = lowerNsMember(stmt, param, ctx);
        if (lowered === null) return null; // unhandled member → don't lower this namespace
        for (const s of lowered) body.push(s);
        if (!sideEffect) for (const s of lowered) if (!isPureNsStmt(s)) sideEffect = true;
    }
    if (body.length === 0) return ERASE; // type-only namespace → emits nothing
    body.push(create.ReturnStatement(S, S, 0, pRef()) as Node);
    return iifeVarDecl(nsId, nsName, (nsId as { sym: number }).sym, param, body, sideEffect, parent);
}

/** A lowered namespace body statement with no side effects (declarations + member mirrors of pure
 *  values). Conservative — anything else marks the namespace IIFE effectful (kept even if unused). */
function isPureNsStmt(stmt: Node): boolean {
    if (stmt.type === N.FunctionDeclaration || stmt.type === N.ClassDeclaration) return true;
    if (stmt.type === N.VariableDeclaration) {
        for (const dc of (stmt.data as { declarations: Node[] }).declarations) {
            const init = (dc.data as { init: Node | null }).init;
            if (init !== null && !isPureExpr(init)) return false;
        }
        return true;
    }
    // mirror `_Foo.x = <local ident>` is pure (assign to the local object).
    if (stmt.type === N.ExpressionStatement) {
        const e = (stmt.data as { expression: Node }).expression;
        if (e.type === N.AssignmentExpression) return isPureExpr((e.data as { right: Node }).right);
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
            if (isValueEnum(node)) ctx.replaceWith(lowerEnum(node, ctx, ctx.currentScope));
        },
        [N.TSImportEqualsDeclaration]: (node, ctx) => {
            // `import X = A.B` → `var X = A.B`; `import type X =` erased; `= require()` left to reject.
            if ((node.data as { importKind: string }).importKind === 'type') ctx.remove();
            else {
                const lowered = lowerImportEquals(node);
                if (lowered !== null) ctx.replaceWith(lowered);
            }
        },
        [N.ExportNamedDeclaration]: (node, ctx) => {
            const decl = (node.data as { declaration: Node | null }).declaration;
            if (decl !== null && isValueEnum(decl)) {
                const varDecl = lowerEnum(decl, ctx, ctx.currentScope);
                ctx.replaceWith(create.ExportNamedDeclaration(S, S, 0, varDecl, null, null) as Node);
            } else if (decl !== null && decl.type === N.TSImportEqualsDeclaration) {
                // `export import X = A.B` → `export var X = A.B`; type-only erased; require() rejects.
                if ((decl.data as { importKind: string }).importKind === 'type') ctx.remove();
                else {
                    const lowered = lowerImportEquals(decl);
                    if (lowered !== null) ctx.replaceWith(create.ExportNamedDeclaration(S, S, 0, lowered, null, null) as Node);
                }
            } else if (decl !== null && isValueNamespace(decl)) {
                const varDecl = lowerNamespace(decl, ctx, null);
                if (varDecl === ERASE)
                    ctx.remove(); // `export namespace N { type … }` → nothing
                else if (varDecl !== null) ctx.replaceWith(create.ExportNamedDeclaration(S, S, 0, varDecl, null, null) as Node);
            }
        },
        [N.TSModuleDeclaration]: (node, ctx) => {
            if (isValueNamespace(node)) {
                const varDecl = lowerNamespace(node, ctx, null);
                if (varDecl === ERASE)
                    ctx.remove(); // type-only namespace → nothing
                else if (varDecl !== null) ctx.replaceWith(varDecl);
            }
        },
    }),
    exit: null,
};
