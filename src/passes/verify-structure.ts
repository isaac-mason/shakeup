// Verification-only: assert every node sits in a slot that ACCEPTS it.
//
// The other half of the loop-head miscompile, and the half that did not announce itself.
// `ctx.remove()` in a single-child slot throws at the mutation site — loud, with the offending pass
// on the stack. `ctx.replaceWith()` checks nothing, so `dropUnused` wrote an `ExpressionStatement`
// into `ForStatement.init` — an expression-or-declaration slot — and the traversal accepted it. The
// build carried a structurally invalid tree through every later pass and only failed in the PRINTER,
// with "unsupported expression node ExpressionStatement" and no trace of who built it. Had the
// printer happened to accept that node, it would have been a silent miscompile instead.
//
// WHY A WHOLE-TREE WALK rather than a check inside `visitSingle`. The first attempt asserted that a
// replacement preserves STATEMENT-NESS, inside the traversal. It ran clean across all 2,314 tests —
// and caught nothing, because `VariableDeclaration` and `ExpressionStatement` are BOTH statements.
// The property that was violated is not about the node in isolation; it is about the node relative
// to its SLOT, and `visitSingle` receives no slot information. Threading it there would mean
// changing the walker codegen on the hottest path in the compiler to check a property that is
// perfectly observable afterwards, for free, off the hot path.
//
// Scope is deliberately the one direction that is expressible by mistake: a STATEMENT reaching a
// slot that does not take one. Passes build statements and expressions and move them between slots;
// nothing in the type system distinguishes the two, since every node is the same `Node` shape.
import { CHILD_FIELDS, N, type Node, walk } from '../ast.ts';

/** `SEMANTIC_VERIFY=1` turns this on, alongside the semantic differential it rides with. */
export const structureVerifyOn = (): boolean => process.env.SEMANTIC_VERIFY === '1';

const STATEMENT = new Set<number>([
    N.ExpressionStatement,
    N.VariableDeclaration,
    N.BlockStatement,
    N.IfStatement,
    N.ForStatement,
    N.ForInStatement,
    N.ForOfStatement,
    N.WhileStatement,
    N.DoWhileStatement,
    N.SwitchStatement,
    N.TryStatement,
    N.ReturnStatement,
    N.ThrowStatement,
    N.BreakStatement,
    N.ContinueStatement,
    N.LabeledStatement,
    N.EmptyStatement,
    N.DebuggerStatement,
    N.FunctionDeclaration,
    N.ClassDeclaration,
    N.ImportDeclaration,
    N.ExportNamedDeclaration,
    N.ExportDefaultDeclaration,
    N.ExportAllDeclaration,
    N.TSInterfaceDeclaration,
    N.TSTypeAliasDeclaration,
    N.TSEnumDeclaration,
    N.TSModuleDeclaration,
    N.TSImportEqualsDeclaration,
]);

const key = (type: number, field: string) => `${type}.${field}`;

/** Single-child slots that accept ANY statement — the statement positions of the grammar. */
const ANY_STATEMENT = new Set<string>([
    key(N.IfStatement, 'consequent'),
    key(N.IfStatement, 'alternate'),
    key(N.ForStatement, 'body'),
    key(N.ForInStatement, 'body'),
    key(N.ForOfStatement, 'body'),
    key(N.WhileStatement, 'body'),
    key(N.DoWhileStatement, 'body'),
    key(N.LabeledStatement, 'body'),
    key(N.TryStatement, 'block'),
    key(N.TryStatement, 'finalizer'),
    key(N.CatchClause, 'body'),
    key(N.ExportNamedDeclaration, 'declaration'),
    key(N.ExportDefaultDeclaration, 'declaration'),
    key(N.FunctionDeclaration, 'body'),
    key(N.FunctionExpression, 'body'),
    key(N.ArrowFunctionExpression, 'body'), // a block body; an expression body is also legal here
]);

/** Slots that accept a `VariableDeclaration` and NO OTHER statement — the loop heads. `init` is
 *  otherwise an Expression and `left` an assignment target, which is exactly why writing an
 *  `ExpressionStatement` into one produced a tree nothing rejected until the printer. */
const DECLARATION_ONLY = new Set<string>([
    key(N.ForStatement, 'init'),
    key(N.ForInStatement, 'left'),
    key(N.ForOfStatement, 'left'),
]);

const nameOf = (type: number) => Object.keys(N).find((k) => N[k as keyof typeof N] === type) ?? String(type);

/** Every structural violation in `root`, as readable one-liners. Empty when the tree is well-formed. */
export function verifyStructure(root: Node): string[] {
    const problems: string[] = [];
    // `CHILD_FIELDS` is the same schema the walker codegen and `walk` are generated from, so the
    // slot list here cannot drift from the one the traversal actually visits.
    const byType = new Map<number, { name: string; list: boolean }[]>();
    for (const [name, fields] of Object.entries(CHILD_FIELDS))
        byType.set(N[name as keyof typeof N], fields as { name: string; list: boolean }[]);
    walk(root, (n) => {
        const fields = byType.get(n.type);
        if (fields === undefined || n.data === null) return;
        for (const f of fields) {
            if (f.list) continue; // a list slot is a statement list wherever it holds statements
            const child = (n.data as Record<string, Node | null>)[f.name];
            if (child == null || !STATEMENT.has(child.type)) continue;
            const k = key(n.type, f.name);
            if (ANY_STATEMENT.has(k)) continue;
            if (DECLARATION_ONLY.has(k)) {
                if (child.type === N.VariableDeclaration) continue;
                problems.push(
                    `${nameOf(n.type)}.${f.name} @${n.start} holds a ${nameOf(child.type)}; only a VariableDeclaration is a statement here`,
                );
                continue;
            }
            problems.push(
                `${nameOf(n.type)}.${f.name} @${n.start} holds a ${nameOf(child.type)}, but the slot takes an expression`,
            );
        }
    });
    return problems;
}
