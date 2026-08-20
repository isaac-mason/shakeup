// TS lowering passes (transform stage). First responsibility: value `enum` → IIFE, porting the
// print-time `emitEnum` (print-js.ts) to a mutation pass that emits real AST. Namespace lowering and
// type-strip join this pass next. `declare` enums are erased elsewhere (they emit no JS).
import { N, type Node, node, set, walk } from '../ast.ts';
import * as create from '../parser/create.ts';
import { VAR_KIND } from '../parser/create.ts';
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
const assign = (l: Node, r: Node): Node => create.AssignmentExpression(S, S, '=', l, r) as Node;
const exprStmt = (e: Node): Node => create.ExpressionStatement(S, S, 0, e) as Node;

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

/** Build the lowered `var E; (function(_E){ … })(E || (E = {}))` for one enum. `enumNode` is the
 *  `TSEnumDeclaration`; returns [varDecl, iifeStmt]. Reuses the enum's binding id (and symbol) for
 *  the outer `var`, so downstream deconflict/refs stay wired to the same symbol. */
function lowerEnum(enumNode: Node, ctx: TransformCtx): [Node, Node] {
    const d = enumNode.data as { id: Node; members: Node[] };
    const enumId = d.id;
    const enumSym = (enumId as { sym: number }).sym;
    const enumName = enumId.name;
    const param = ctx.generateUid(enumName); // `_E`
    const pRef = (): Node => idRef(param, 0);
    const oRef = (): Node => idRef(enumName, enumSym); // outer, carries the enum symbol

    const prior = new Set<string>();
    const stmts: Node[] = [];
    let autoNext = 0;
    let autoOk = true;
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

    const varDecl = create.VariableDeclaration(S, S, VAR_KIND.VAR, [
        create.VariableDeclarator(S, S, 0, enumId, null, null) as Node,
    ]) as Node;
    const fn = create.FunctionExpression(
        S,
        S,
        0,
        null,
        null,
        [create.FormalParameter(S, S, 0, bindId(param, 0), null, null) as Node],
        null,
        create.BlockStatement(S, S, 0, stmts) as Node,
    ) as Node;
    const arg = create.LogicalExpression(
        S,
        S,
        '||',
        oRef(),
        assign(oRef(), create.ObjectExpression(S, S, 0, []) as Node),
    ) as Node;
    const iife = exprStmt(create.CallExpression(S, S, 0, fn, [arg], null) as Node);
    return [varDecl, iife];
}

const isValueEnum = (n: Node): boolean => n.type === N.TSEnumDeclaration && (n.data as { declare: boolean }).declare !== true;

/** The TS lowering pass. Currently: value `enum` → IIFE (bare and `export enum`). Fires on `enter`
 *  and `replaceWithMultiple` — which short-circuits the child recursion (so `export enum`'s inner
 *  enum, sitting in a single-child slot, is never independently visited). */
export const tsLower: Visitor = {
    name: 'tsLower',
    enter: hookTable({
        [N.TSEnumDeclaration]: (node, ctx) => {
            if (isValueEnum(node)) ctx.replaceWithMultiple(lowerEnum(node, ctx));
        },
        [N.ExportNamedDeclaration]: (node, ctx) => {
            const decl = (node.data as { declaration: Node | null }).declaration;
            if (decl !== null && isValueEnum(decl)) {
                const [varDecl, iife] = lowerEnum(decl, ctx);
                const exportVar = create.ExportNamedDeclaration(S, S, 0, varDecl, null, null) as Node;
                ctx.replaceWithMultiple([exportVar, iife]);
            }
        },
    }),
    exit: null,
};
