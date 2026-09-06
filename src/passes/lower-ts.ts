// TS lowering passes (transform stage). First responsibility: value `enum` → IIFE, porting the
// print-time `emitEnum` (print-js.ts) to a mutation pass that emits real AST. Namespace lowering and
// type-strip join this pass next. `declare` enums are erased elsewhere (they emit no JS).
import { isPureExpr } from '../analysis/effects.ts';
import { attachScopeNode, createScope, declareLocal, SCOPE, type Semantic, SYM, scopeOf } from '../analysis/semantic.ts';
import {
    assign,
    boundBinding,
    boundRef,
    computed,
    create,
    emptyObject,
    exprStmt,
    FL,
    idName,
    member,
    N,
    type Node,
    num,
    SPAN,
    set,
    str,
    VAR_KIND,
    walk,
} from '../ast/index.ts';
import { hookTable, type TransformCtx, type Visitor } from './traverse.ts';

/** A minted IIFE param: its reserved name plus the real SymbolId it binds to, so every reference
 *  carries `sym` and the chunk mangler (`src/mangle/`) can shorten it (oxc's `generate_uid` returns a bound id).
 *  `scope` is the fresh FUNCTION scope it lives in — the enclosing scope for the IIFE body's own
 *  nested enums/namespaces. */
type Uid = { name: string; sym: number; scope: number };

/** Mint a real IIFE-param binding for a lowering pass into `scope`: reserve a `_base` name and
 *  declare it as a PARAM symbol there, so every reference carries a real sym. */
function mintParam(base: string, scope: number, ctx: TransformCtx): Uid {
    const name = ctx.generateUid(base);
    const sym = declareLocal(ctx.semantic, boundBinding(name, 0), scope, SYM.PARAM);
    return { name, sym, scope };
}

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
    semantic: Semantic,
): Node {
    const fn = create.FunctionExpression(
        SPAN,
        SPAN,
        0,
        null,
        null,
        [create.FormalParameter(SPAN, SPAN, 0, boundBinding(param.name, param.sym), null, null)],
        null,
        create.BlockStatement(SPAN, SPAN, 0, bodyStmts),
    );
    // `param` was declared into `param.scope`; this FunctionExpression is the node that OWNS that
    // scope, and only now does it exist. Registering it keeps `scopeOf`/`ctx.currentScope` correct
    // inside the IIFE without a post-lowering `analyze()` rebuild.
    attachScopeNode(semantic, param.scope, fn);
    const arg =
        parent === null
            ? create.LogicalExpression(SPAN, SPAN, '||', boundRef(name, sym), emptyObject())
            : // nested: `_P.X || (_P.X = {})`
              create.LogicalExpression(
                  SPAN,
                  SPAN,
                  '||',
                  member(boundRef(parent.name, parent.sym), idName(name)),
                  assign(member(boundRef(parent.name, parent.sym), idName(name)), emptyObject()),
              );
    const call = create.CallExpression(SPAN, SPAN, sideEffect ? 0 : FL.PURE, fn, [arg], null);
    // `analyze` files a declarator's init under its symbol (`Semantic.symbolInit`, oxc's
    // `SymbolValue`); compress reads it (alias-inline, const-prop). This declaration is minted
    // AFTER that walk, so record it here or the symbol looks initialiser-less and those passes
    // decline to fire — a size regression, not a miscompile.
    if (sym !== 0) semantic.symbolInit.set(sym, call);
    return create.VariableDeclaration(SPAN, SPAN, VAR_KIND.VAR, [create.VariableDeclarator(SPAN, SPAN, 0, id, null, call)]);
}

/** Qualify references to a prior enum member inside an initializer: `A` → `_E.A` (in place via
 *  `set`, mirroring `emitEnum`'s shadow rewrite). `enumParam` is the IIFE param name (`_E`). */
function qualifyMemberRefs(init: Node, priorMembers: Set<string>, enumParam: Uid): void {
    walk(init, (n) => {
        if (n.type === N.IdentifierReference && priorMembers.has(n.name)) {
            set(n, N.StaticMemberExpression, {
                object: boundRef(enumParam.name, enumParam.sym),
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
    const pRef = (): Node => boundRef(param.name, param.sym);

    const prior = new Set<string>();
    /** Members of THIS enum already evaluated, for `B = A << 1`. Names, because that is what a
     *  reference in an initializer resolves to and what `qualifyMemberRefs` rewrites. */
    const vals = new Map<string, number>();
    const stmts: Node[] = [];
    let autoNext = 0;
    let autoOk = true;
    let sideEffect = false; // any member initializer is a `new`/call → the IIFE may have side effects
    for (const m of d.members) {
        if (m.type !== N.TSEnumMember) continue;
        const md = m.data as { id: Node; initializer: Node | null };
        const key = md.id.type === N.StringLiteral ? md.id.name.slice(1, -1) : md.id.name;
        const init = md.initializer;
        if (init === null) {
            // auto: `_E[_E["A"]=n]="A"`
            if (autoOk) {
                recordEnumConst(enumSym, key, String(autoNext));
                vals.set(key, autoNext);
            }
            stmts.push(exprStmt(assign(computed(pRef(), assign(computed(pRef(), str(key)), num(autoNext))), str(key))));
            autoNext++;
        } else {
            if (init.type === N.NewExpression || init.type === N.CallExpression) sideEffect = true;
            // BEFORE `qualifyMemberRefs` rewrites `A` to `_E.A` in place: the evaluator resolves a
            // bare member reference through `vals`, and after the rewrite there is no bare reference
            // left to resolve.
            const constVal = init.type === N.StringLiteral ? null : constEnumValue(init, vals);
            // `qualifyMemberRefs` rewrites `A` -> `_E.A` IN PLACE, inside a subtree the enclosing
            // `ctx.replaceWith` will later walk as its `prev`. That walk assumes `prev` is the tree
            // the semantic still describes, so mutating first makes it decrement the NEW `_E`
            // references (which were never counted) and re-add them — netting zero where the truth
            // is +1 each, i.e. an UNDER-count, which is the unsafe direction. Bracketing the
            // rewrite settles the initializer's own accounting before/after, exactly as
            // `compress/inline.ts` brackets a moved body.
            ctx.dropRefs(init);
            qualifyMemberRefs(init, prior, param);
            ctx.addRefs(init);
            if (init.type === N.StringLiteral) {
                recordEnumConst(enumSym, key, init.name);
                stmts.push(exprStmt(assign(computed(pRef(), str(key)), init)));
                autoOk = false;
            } else {
                // `_E[_E["A"]=<init>]="A"`
                stmts.push(exprStmt(assign(computed(pRef(), assign(computed(pRef(), str(key)), init)), str(key))));
                // Any constant enum expression, not just a bare literal — `1 << 4`, `A | B`, `~0`.
                const text = constVal === null ? null : enumConstText(constVal);
                if (constVal !== null && text !== null) {
                    recordEnumConst(enumSym, key, text);
                    vals.set(key, constVal);
                    autoNext = constVal + 1;
                    autoOk = true;
                } else autoOk = false;
            }
        }
        if (!autoOk) autoNext = 0; // a non-numeric member resets the auto sequence (matches emitEnum)
        prior.add(key);
    }
    stmts.push(create.ReturnStatement(SPAN, SPAN, 0, pRef())); // `return _E;`
    return iifeVarDecl(enumId, enumName, enumSym, param, stmts, sideEffect, null, ctx.semantic);
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
function lowerImportEquals(node: Node, semantic: Semantic): Node | null {
    const d = node.data as { id: Node; moduleReference: Node };
    if (d.moduleReference.type === N.TSExternalModuleReference) return null; // require() — reject
    const init = entityToValue(d.moduleReference);
    const sym = (d.id as { sym: number }).sym;
    if (sym !== 0) semantic.symbolInit.set(sym, init); // see the note in `iifeVarDecl`
    return create.VariableDeclaration(SPAN, SPAN, VAR_KIND.VAR, [create.VariableDeclarator(SPAN, SPAN, 0, d.id, null, init)]);
}

/** Statements a value namespace body member lowers to, or null if the member isn't handled yet
 *  (`export *`). `thisParam` is the enclosing namespace's IIFE
 *  param (`_N`): used for the `_N.x = x` mirrors AND as the parent of any nested namespace. */
function lowerNsMember(stmt: Node, thisParam: Uid, ctx: TransformCtx): Node[] | null {
    const pRef = (): Node => boundRef(thisParam.name, thisParam.sym);
    // type-only members emit no JS.
    if (stmt.type === N.TSInterfaceDeclaration || stmt.type === N.TSTypeAliasDeclaration) return [];
    if ((stmt.data as { declare?: boolean }).declare === true) return [];
    // bare (non-exported) `import X = A.B` → `var X = A.B` (no mirror); `import type X =` erased.
    if (stmt.type === N.TSImportEqualsDeclaration) {
        if ((stmt.data as { importKind: string }).importKind === 'type') return [];
        const lowered = lowerImportEquals(stmt, ctx.semantic);
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
        const lowered = lowerImportEquals(decl, ctx.semantic);
        if (lowered === null) return null;
        const id = (decl.data as { id: Node }).id;
        return [lowered, exprStmt(assign(member(pRef(), idName(id.name)), boundRef(id.name, (id as { sym: number }).sym)))];
    }
    // `export enum E` → lowered enum (top-level form) + mirror onto `_N`.
    if (isValueEnum(decl)) {
        const varDecl = lowerEnum(decl, ctx, thisParam.scope);
        return [
            varDecl,
            exprStmt(
                assign(
                    member(pRef(), idName((decl.data as { id: Node }).id.name)),
                    boundRef((decl.data as { id: Node }).id.name, ((decl.data as { id: Node }).id as { sym: number }).sym),
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
                mirrors.push(exprStmt(assign(member(pRef(), idName(name)), boundRef(name, sym)))),
            );
        return [decl, ...mirrors];
    }
    // `export function f`/`class C` → keep the decl + `_N.f = f;`
    if (decl.type === N.FunctionDeclaration || decl.type === N.ClassDeclaration) {
        const id = (decl.data as { id: Node | null }).id;
        if (id === null) return null;
        return [decl, exprStmt(assign(member(pRef(), idName(id.name)), boundRef(id.name, (id as { sym: number }).sym)))];
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
    const pRef = (): Node => boundRef(param.name, param.sym);

    const body: Node[] = [];
    let sideEffect = false;
    for (const stmt of d.body) {
        const lowered = lowerNsMember(stmt, param, ctx);
        if (lowered === null) return null; // unhandled member → don't lower this namespace
        for (const s of lowered) body.push(s);
        if (!sideEffect) for (const s of lowered) if (!isPureNsStmt(s)) sideEffect = true;
    }
    if (body.length === 0) return ERASE; // type-only namespace → emits nothing
    body.push(create.ReturnStatement(SPAN, SPAN, 0, pRef()));
    return iifeVarDecl(nsId, nsName, (nsId as { sym: number }).sym, param, body, sideEffect, parent, ctx.semantic);
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

/**
 * Constant enum members, by enum SYMBOL then member name, with the literal's SOURCE TEXT as the
 * value. Collected here because this is the only place that already knows each member's value — the
 * auto-increment sequence is computed to build the IIFE, and throwing it away meant every
 * `Kind.DYNAMIC` stayed a property read on the lowered object.
 *
 * TypeScript treats an enum member access as a constant, and so do the other bundlers: rolldown emits
 * `0` for `Kind.STATIC` on a PLAIN enum, not only a `const enum`, and keeps the object solely for
 * whatever else references it. Verified against `rolldown` on a two-file fixture before this existed.
 *
 * Only a NUMERIC or STRING literal initialiser is recorded, plus auto members while the sequence is
 * still known. `A = -1` parses as a unary expression and `A = f()` is a call; both are simply absent,
 * which is the safe direction — an absent member is read off the object as before.
 *
 * Module-level state reset at Program enter, harvested by {@link resolveEnumConsts}: `traverse`
 * caches its hook tables on the visitor array's identity, so the visitor has to stay a shared
 * constant.
 */
let ENUM_CONSTS: Map<number, Map<string, string>> | null = null;

/**
 * A TypeScript CONSTANT ENUM EXPRESSION, evaluated to its number — the rule set in oxc's
 * `oxc_semantic/src/ts_enum/eval.rs`, which is where oxc computes member values (the transformer
 * only reads them back off `Scoping`). Returns null for anything not statically known, which leaves
 * the member absent from {@link ENUM_CONSTS} and its reads going through the object, as before.
 *
 * This is why a bit-flag enum used to inline nothing. `TWIST_MIN = 1 << 0` is a BinaryExpression, so
 * the old literal-only test recorded no value AND cleared `autoOk`, taking the rest of the enum with
 * it — 20 names and 77 reads on crashcat, where rolldown inlines every one and then drops the enum
 * object as unused.
 *
 * JS gives the operator semantics for free: `<<`, `>>`, `&`, `|`, `^`, `~` coerce to int32 in the
 * language exactly as oxc's `to_int_32`/`wrapping_shl` do, and `>>>` to uint32.
 *
 * NUMBERS ONLY, deliberately narrower than oxc, which also folds string concatenation. A string
 * member still records through the StringLiteral path below with its quotes intact; computing one
 * here would mean re-quoting a value that never appears in practice.
 *
 * @param vals members of THIS enum already evaluated, by name — oxc resolves the same references
 *   through the enum's own scope, and `qualifyMemberRefs` rewrites exactly this set of names.
 */
function constEnumValue(node: Node, vals: Map<string, number>): number | null {
    switch (node.type) {
        case N.NumericLiteral: {
            const v = Number(node.name);
            return Number.isFinite(v) ? v : null;
        }
        case N.IdentifierReference:
            return vals.get(node.name) ?? null;
        case N.StaticMemberExpression: {
            // `Other.MEMBER` — a member of an enum lowered EARLIER in this module, whose values are
            // already in `ENUM_CONSTS`. oxc's `find_in_enum_body_scopes` is the same lookup.
            const d = node.data as { object: Node; property: Node };
            if (d.object.type !== N.IdentifierReference) return null;
            const text = ENUM_CONSTS?.get((d.object as { sym: number }).sym)?.get(d.property.name as string);
            if (text === undefined) return null;
            const v = Number(text);
            return Number.isFinite(v) ? v : null;
        }
        case N.UnaryExpression: {
            const d = node.data as { operator: string; argument: Node };
            const v = constEnumValue(d.argument, vals);
            if (v === null) return null;
            switch (d.operator) {
                case '+':
                    return v;
                case '-':
                    return -v;
                case '~':
                    return ~v;
                default:
                    return null;
            }
        }
        case N.BinaryExpression: {
            const d = node.data as { operator: string; left: Node; right: Node };
            const l = constEnumValue(d.left, vals);
            if (l === null) return null;
            const r = constEnumValue(d.right, vals);
            if (r === null) return null;
            switch (d.operator) {
                case '<<':
                    return l << r;
                case '>>':
                    return l >> r;
                case '>>>':
                    return l >>> r;
                case '&':
                    return l & r;
                case '|':
                    return l | r;
                case '^':
                    return l ^ r;
                case '*':
                    return l * r;
                case '/':
                    return l / r;
                case '+':
                    return l + r;
                case '-':
                    return l - r;
                case '%':
                    return l % r;
                case '**':
                    return l ** r;
                default:
                    return null;
            }
        }
        default:
            return null;
    }
}

/** The source text to substitute for a computed member value. A NEGATIVE number is parenthesised:
 *  the override replaces a member expression, which binds tighter than unary minus, and `a -
 *  E.X` becoming `a - -1` is a shape the printer would have to reason about. Two bytes on a rare
 *  member buys not having to. */
function enumConstText(v: number): string | null {
    if (!Number.isFinite(v)) return null;
    const text = String(v);
    return text.startsWith('-') ? `(${text})` : text;
}

function recordEnumConst(enumSym: number, key: string, text: string): void {
    if (enumSym === 0) return;
    ENUM_CONSTS ??= new Map();
    let m = ENUM_CONSTS.get(enumSym);
    if (m === undefined) ENUM_CONSTS.set(enumSym, (m = new Map()));
    m.set(key, text);
}

/** Take what {@link tsLower} recorded for this module and reset for the next one. */
export function resolveEnumConsts(): Map<number, Map<string, string>> {
    const t = ENUM_CONSTS ?? new Map<number, Map<string, string>>();
    ENUM_CONSTS = null;
    return t;
}

const isValueEnum = (n: Node): boolean => n.type === N.TSEnumDeclaration && (n.data as { declare: boolean }).declare !== true;
const isValueNamespace = (n: Node): boolean =>
    n.type === N.TSModuleDeclaration && (n.data as { declare: boolean }).declare !== true;

/** The TS lowering pass. Currently: value `enum` → IIFE (bare and `export enum`). Fires on `enter`
 *  and `replaceWithMultiple` — which short-circuits the child recursion (so `export enum`'s inner
 *  enum, sitting in a single-child slot, is never independently visited). */
/** Did a TS construct that `collectUnsupported` diagnoses SURVIVE this module's lowering?
 *
 *  `collectUnsupported` errors on exactly two node types — a non-`declare` `TSModuleDeclaration` and
 *  an `import X = require(...)` — and it used to walk every TS module to look for them (178,021 nodes
 *  over a crashcat bundle, finding nothing). This traversal already visits every one of those nodes,
 *  so it records whether any survived; when none did, there is provably nothing for that walk to find.
 *
 *  Deliberately CONSERVATIVE: the flag is set whenever such a node is left in place, including forms
 *  the check would not have complained about. A false positive costs one walk; a false negative would
 *  silence a diagnostic, so the bias is one-directional. */
let SAW_UNLOWERED = false;
export const sawUnloweredTs = (): boolean => SAW_UNLOWERED;

export const tsLower: Visitor = {
    name: 'tsLower',
    enter: hookTable({
        [N.Program]: () => {
            SAW_UNLOWERED = false;
        },
        [N.TSEnumDeclaration]: (node, ctx) => {
            if (isValueEnum(node)) ctx.replaceWith(lowerEnum(node, ctx, ctx.currentScope));
        },
        [N.TSImportEqualsDeclaration]: (node, ctx) => {
            // `import X = A.B` → `var X = A.B`; `import type X =` erased; `= require()` left to reject.
            if ((node.data as { importKind: string }).importKind === 'type') ctx.remove();
            else {
                const lowered = lowerImportEquals(node, ctx.semantic);
                if (lowered !== null) ctx.replaceWith(lowered);
                else SAW_UNLOWERED = true; // `= require(...)` — left for the diagnostic
            }
        },
        [N.ExportNamedDeclaration]: (node, ctx) => {
            const decl = (node.data as { declaration: Node | null }).declaration;
            if (decl !== null && isValueEnum(decl)) {
                const varDecl = lowerEnum(decl, ctx, ctx.currentScope);
                ctx.replaceWith(create.ExportNamedDeclaration(SPAN, SPAN, 0, varDecl, null, null));
            } else if (decl !== null && decl.type === N.TSImportEqualsDeclaration) {
                // `export import X = A.B` → `export var X = A.B`; type-only erased; require() rejects.
                if ((decl.data as { importKind: string }).importKind === 'type') ctx.remove();
                else {
                    const lowered = lowerImportEquals(decl, ctx.semantic);
                    if (lowered !== null) ctx.replaceWith(create.ExportNamedDeclaration(SPAN, SPAN, 0, lowered, null, null));
                    else SAW_UNLOWERED = true; // `export import X = require(...)` — left for the diagnostic
                }
            } else if (decl !== null && isValueNamespace(decl)) {
                const varDecl = lowerNamespace(decl, ctx, null);
                if (varDecl === ERASE)
                    ctx.remove(); // `export namespace N { type … }` → nothing
                else if (varDecl !== null) ctx.replaceWith(create.ExportNamedDeclaration(SPAN, SPAN, 0, varDecl, null, null));
            }
        },
        [N.TSModuleDeclaration]: (node, ctx) => {
            if (isValueNamespace(node)) {
                const varDecl = lowerNamespace(node, ctx, null);
                if (varDecl === ERASE)
                    ctx.remove(); // type-only namespace → nothing
                else if (varDecl !== null) ctx.replaceWith(varDecl);
                else SAW_UNLOWERED = true; // nested/merged/re-export — left for the diagnostic
            } else SAW_UNLOWERED = true; // `declare` namespace: survives, so let the check look
        },
    }),
    exit: null,
};
