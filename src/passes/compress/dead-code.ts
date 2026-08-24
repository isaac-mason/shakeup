// B2 — dead-code elimination (terser/esbuild `dead_code`): collapse constant-condition `if`/ternary
// branches and drop unreachable statements after a terminator (`return`/`throw`/`break`/`continue`).
//
// SCOPE (deliberately narrow — real constant-folding lives in the separate fold-constants pass):
//   1. `if (<const-truthy>) A else B` → A ; `if (<const-falsy>) A else B` → B (or nothing).
//   2. Statements after a terminator in the SAME statement list are unreachable → removed.
//   3. `c ? a : b` with constant `c` → the taken branch (expression context).
// A "constant" test is ONLY a literal boolean/number/string or a `!`-negation of one
// (`true`/`false`/`0`/`1`/`""`/`!0`/`!1`); no evaluation of variables or arbitrary expressions.
//
// VAR-HOISTING SAFETY (the landmine): a *dropped* branch may contain `var`/`function` declarations
// that hoist into the enclosing function scope (`if (false) { var x; function f(){} }` still declares
// `x`/`f`). We take the conservative bail: if the branch we would delete contains any hoisted
// `var`/`function` (scanning through blocks/ifs/loops but NOT into nested function scopes), we do
// NOT eliminate that `if`. `let`/`const`/`class` are block-scoped and vanish safely with their block.
//
// FLATTENING: when the taken branch is a `BlockStatement`, we splice its statements into the parent
// list (list-container hook) so `if(true){a;b}` becomes `a;b` — but only when the block has no
// block-scoped declarations (`let`/`const`/`class`/`function`) at its top level, else flattening
// would leak lexical scope, so we keep the block intact.
import { N, type Node, statementListOf } from '../../ast.ts';
import * as create from '../../parser/create.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

// Narrow views used where the `Node` union isn't already refined by a `switch (node.type)`. The
// codebase's `(node.data as { field })` idiom — the traversal keys hooks by type, so these casts are
// sound at each call site (guarded by a matching `.type` check).
type IfData = { test: Node; consequent: Node; alternate: Node | null };
type CatchData = { body: Node };
type SwitchCaseData = { consequent: Node[] };
type BlockData = { body: Node[] };

/** Constant-test verdict: `1` truthy, `0` falsy, `-1` not a recognized literal constant. */
function constTruthiness(test: Node): number {
    switch (test.type) {
        case N.BooleanLiteral:
            return test.name === 'true' ? 1 : 0;
        case N.NumericLiteral: {
            // `test.name` is the raw source of the numeric token (e.g. "0", "1", "0x0", "1.5").
            const v = Number(test.name);
            if (Number.isNaN(v)) return -1; // unparseable form — stay conservative.
            return v === 0 ? 0 : 1;
        }
        case N.StringLiteral:
            // `test.name` is the raw literal INCLUDING quotes, so `""`/`''` (length 2) is the empty
            // string (falsy); any longer raw is a non-empty string (truthy).
            return test.name.length <= 2 ? 0 : 1;
        case N.UnaryExpression: {
            // `!<const>` inverts a recognized constant; anything else is not constant.
            if (test.data.operator !== '!') return -1;
            const inner = constTruthiness(test.data.argument);
            return inner === -1 ? -1 : inner === 0 ? 1 : 0;
        }
        default:
            return -1;
    }
}

/** Recognized statement terminators — control cannot fall through past one. */
function isTerminator(stmt: Node): boolean {
    const t = stmt.type;
    return t === N.ReturnStatement || t === N.ThrowStatement || t === N.BreakStatement || t === N.ContinueStatement;
}

/** True if `stmt`, in place, hoists any `var`/`function` binding into the enclosing function scope.
 *  Descends through blocks/ifs/loops/labels/try/switch (they share the function scope) but NOT into
 *  nested functions/classes (they open their own scope, so their `var`/`function` don't hoist out). */
function hasHoistedDecl(stmt: Node | null): boolean {
    if (stmt === null) return false;
    switch (stmt.type) {
        case N.VariableDeclaration:
            return stmt.data.kind === 'var';
        case N.FunctionDeclaration:
            return true;
        case N.BlockStatement:
        case N.StaticBlock:
            return anyHoisted(stmt.data.body);
        case N.IfStatement:
            return hasHoistedDecl(stmt.data.consequent) || hasHoistedDecl(stmt.data.alternate);
        case N.ForStatement:
            return hasHoistedDecl(stmt.data.init) || hasHoistedDecl(stmt.data.body);
        case N.ForInStatement:
        case N.ForOfStatement:
            return hasHoistedDecl(stmt.data.left) || hasHoistedDecl(stmt.data.body);
        case N.WhileStatement:
            return hasHoistedDecl(stmt.data.body);
        case N.DoWhileStatement:
            return hasHoistedDecl(stmt.data.body);
        case N.LabeledStatement:
            return hasHoistedDecl(stmt.data.body);
        case N.TryStatement:
            return (
                hasHoistedDecl(stmt.data.block) ||
                (stmt.data.handler !== null && hasHoistedDecl((stmt.data.handler.data as CatchData).body)) ||
                hasHoistedDecl(stmt.data.finalizer)
            );
        case N.SwitchStatement:
            for (const c of stmt.data.cases) if (anyHoisted((c.data as SwitchCaseData).consequent)) return true;
            return false;
        // Nested function/class scopes — their inner `var`/`function` do NOT hoist out here.
        default:
            return false;
    }
}
function anyHoisted(list: Node[]): boolean {
    for (const s of list) if (hasHoistedDecl(s)) return true;
    return false;
}

/** A block whose top-level body has no lexical declaration can be flattened into the parent list
 *  without changing scope (`let`/`const`/`class`/`function` are block-scoped or hoist-visible, so
 *  they must keep their block). */
function blockFlattenable(block: Node): boolean {
    for (const s of (block.data as BlockData).body) {
        if (s.type === N.FunctionDeclaration || s.type === N.ClassDeclaration) return false;
        if (s.type === N.VariableDeclaration && s.data.kind !== 'var') return false;
    }
    return true;
}

/** The taken branch of a constant `if`, expanded into a list of statements to splice in place of the
 *  `if`. Returns `null` when the `if` must be left alone (non-constant test, or a hoisting hazard in
 *  the dropped branch). An empty array means "delete the `if` entirely" (falsy test, no `else`). */
function collapseIf(stmt: Node): Node[] | null {
    if (stmt.type !== N.IfStatement) return null;
    const v = constTruthiness(stmt.data.test);
    if (v === -1) return null;
    const taken = v === 1 ? stmt.data.consequent : stmt.data.alternate;
    const dropped = v === 1 ? stmt.data.alternate : stmt.data.consequent;
    // Bail if the branch we're about to delete hoists a `var`/`function` (would change scope).
    if (hasHoistedDecl(dropped)) return null;
    if (taken === null) return []; // falsy test, no else → the whole `if` disappears.
    if (taken.type === N.BlockStatement && blockFlattenable(taken)) return taken.data.body.slice();
    return [taken];
}

/** Rewrite one statement list in place: collapse constant `if`s (flattening safe blocks) and drop
 *  unreachable statements after a terminator. Returns whether anything changed. */
function rewriteList(body: Node[], ctx: TransformCtx): boolean {
    let changed = false;
    const out: Node[] = [];
    for (let i = 0; i < body.length; i++) {
        const stmt = body[i];
        const collapsed = collapseIf(stmt);
        if (collapsed !== null) {
            // `collapsed` are subtrees LIFTED OUT of `stmt`, so dropping `stmt` and adding each one
            // back nets the survivors to zero and subtracts only the discarded branch.
            ctx.dropRefs(stmt);
            for (const s of collapsed) {
                ctx.addRefs(s);
                out.push(s);
            }
            changed = true;
        } else {
            out.push(stmt);
        }
        // Everything after a terminator in this list is unreachable — drop it. BUT a hoisted
        // `var`/`function` in that tail still takes effect regardless of position (hoisting), so
        // dropping it would change semantics (e.g. a `function g` used before the terminator, or a
        // `var x` assigned earlier). If the tail hoists anything, KEEP it (conservative bail, same
        // guard collapseIf uses); oxc instead harvests initializer-less var stubs — a future win.
        const last = out.length > 0 ? out[out.length - 1] : null;
        if (last !== null && isTerminator(last)) {
            const tail = body.slice(i + 1);
            if (tail.length > 0) {
                if (anyHoisted(tail)) {
                    for (const s of tail) out.push(s); // hoisting hazard → keep the unreachable tail
                } else {
                    for (const s of tail) ctx.dropRefs(s);
                    changed = true; // dead tail dropped
                }
            }
            break;
        }
    }
    if (!changed) return false;
    body.length = 0;
    for (const s of out) body.push(s);
    return true;
}

/** A statement-list container hook: run {@link rewriteList} over its list field, marking the ctx
 *  changed so the fixed-point driver re-runs. */
function listHook(n: Node, ctx: TransformCtx): void {
    const list = statementListOf(n);
    if (list !== null && rewriteList(list, ctx)) ctx.changed = true;
}

export const deadCode: Visitor = {
    name: 'deadCode',
    enter: hookTable({
        // Statement-list containers: collapse constant `if`s (with flattening) + drop unreachable.
        [N.Program]: listHook,
        [N.BlockStatement]: listHook,
        [N.StaticBlock]: listHook,
        // A switch case's statement list (`consequent`) is also a same-scope statement list.
        [N.SwitchCase]: (n, ctx) => {
            if (rewriteList((n.data as SwitchCaseData).consequent, ctx)) ctx.changed = true;
        },
        // `if` in a single-child slot (loop body, `else if` chain): can't splice, so replace with the
        // single taken statement, an EmptyStatement when the branch disappears, or a fresh block.
        [N.IfStatement]: (n, ctx) => {
            const collapsed = collapseIf(n);
            if (collapsed === null) return;
            if (collapsed.length === 1) ctx.replaceWith(collapsed[0]);
            else if (collapsed.length === 0) ctx.replaceWith(create.EmptyStatement(n.start, n.end, 0));
            else ctx.replaceWith(create.BlockStatement(n.start, n.end, 0, collapsed));
        },
        // Ternary with a constant test → the taken branch (pure expression rewrite).
        [N.ConditionalExpression]: (n, ctx) => {
            const d = n.data as IfData;
            const v = constTruthiness(d.test);
            if (v === -1) return;
            ctx.replaceWith(v === 1 ? d.consequent : (d.alternate as Node));
        },
    }),
    exit: null,
};
