// B-cond-expr — minimize-conditional (terser `conditionals`, esbuild `MangleIfExpr`, oxc
// `minimize_conditional_expression.rs`): rewrite a `test ? consequent : alternate` ternary into a
// shorter, EXACTLY-equivalent form. oxc's file has ~35 patterns; this ports the top high-value SAFE
// ones. A missed rewrite costs bytes; a wrong one is a miscompile, so every shape is matched
// precisely and everything else bails.
//
// THE REWRITES (each cites oxc `minimize_conditional_expression.rs`):
//
//   1. BOOLEAN-LITERAL ARMS (oxc :400-428):
//        `a ? true  : false` → `!!a`   (double negation coerces `a` to its boolean)
//        `a ? false : true`  → `!a`
//      Both arms are bare boolean literals (pure, effect-free), so only the test survives, coerced.
//      In shakeup boolean literals stay in canonical `true`/`false` form during the loop
//      (`substituteAlternateSyntax`'s `true`->`!0` runs ONCE in FINAL_PASSES, after the loop), so the
//      `N.BooleanLiteral` match is stable -- no oscillation.
//
//   2. IDENTICAL ARMS (oxc :570-585):
//        `a ? b : b` → `(a, b)`  when `b`===`b` structurally. `a` is evaluated for its effects, then
//                                 `b`. If `a` is provably side-effect-FREE, collapse further -> `b`.
//      The arms must be STRUCTURALLY identical (a conservative pure-expression compare); anything with
//      a side effect in the arms is NOT equal for our purposes (we only compare pure shapes).
//
//   3. `a ? a : b` → `a || b`  (oxc :72-84):  ONLY when the test is a bare identifier reference and the
//      consequent is the SAME reference (same name AND resolved symbol). An identifier read is
//      side-effect-free, so evaluating `a` twice (`a || b` reads `a`, and again iff falsy) is safe.
//
//   4. `a ? b : a` → `a && b`  (oxc :85-96):  same gate -- test is a bare identifier reference, the
//      ALTERNATE is the same reference. `a && b` reads `a`, then `b` iff truthy -- exactly the ternary.
//
//   5. `!a ? b : c` → `a ? c : b`  (oxc :63-71):  flip a NEGATED test, dropping the `!` and swapping
//      the arms. Dropping a `!` never grows the output, and the swapped ternary is exactly equivalent.
//      After the flip the test is no longer a `!`, so this is monotonic (fires at most once per node).
//
// SKIPPED (from oxc's ~35 patterns) -- deferred as not-clearly-safe or lower-value for v1:
//   - Sequence-test hoist `(a,b) ? c : d` -> `a, (b ? c : d)` (:44-62) -- structural, low payoff.
//   - Binary `!=`/`!==` test inversion (:98-112) -- needs operator-inverse plumbing.
//   - Nested-conditional merges `a ? b ? c : d : d` -> `a && b ? c : d` (:116-152) -- arm-equality heavy.
//   - Sequence/logical-arm merges (:154-234) -- many shapes, each its own equality gate.
//   - Same-callee call hoist `a ? f(c) : f(e)` -> `f(a ? c : e)` (:236-315) -- the prompt's optional #6.
//   - Assignment merge `x ? a=0 : a=1` -> `a = x ? 0 : 1` (:595-681) -- reorders target eval; subtle.
//   - `?? / ?.` nullish rewrites (:322-395).
//   These are all correct in oxc but each carries a distinct correctness gate; ported conservatively
//   later.
//
//   6. NUMERIC-COERCION ARMS (oxc :522-568): `a ? 1 : 0` -> `+!!a`, `a ? 0 : 1` -> `+!a`. The test is
//      evaluated once either way; the coercion reproduces the 0/1 result.
//   (Identical-arm equality (#2) also covers calls -- `a ? x() : x()` -> `x()` -- since the call is
//   evaluated exactly once regardless.)
//
// Real nodes are built (never hand-formatted text) so the printer's precedence machinery adds exactly
// the parens each context needs: `(a, b)` as a ternary/assignment RHS, `a || b` / `a && b` as operands.

import { mayHaveSideEffects } from '../../analysis/effects.ts';
import { N, type Node } from '../../ast.ts';
import * as create from '../../parser/create.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

type CondData = { test: Node; consequent: Node; alternate: Node };
type UnaryData = { operator: string; prefix: boolean; argument: Node };

/** The un-negated operand of a prefix `!x` UnaryExpression, else `null`. Used to flip `!a ? b : c`. */
function notOperand(test: Node): Node | null {
    if (test.type !== N.UnaryExpression) return null;
    const d = test.data as UnaryData;
    return d.operator === '!' ? d.argument : null;
}

/** Is `n` the boolean literal `true`? (BooleanLiteral carries its text in `name`.) */
const isTrueLit = (n: Node): boolean => n.type === N.BooleanLiteral && n.name === 'true';
/** Is `n` the boolean literal `false`? */
const isFalseLit = (n: Node): boolean => n.type === N.BooleanLiteral && n.name === 'false';

/** Is `n` a bare identifier reference? (A read of one is always side-effect-free.) */
const isIdentRef = (n: Node): boolean => n.type === N.IdentifierReference;

/** Do two identifier references denote the SAME binding -- same source name AND same resolved symbol?
 *  Comparing `sym` (0 = unresolved/global) as well as `name` avoids conflating two same-named locals
 *  from different scopes; both must agree for `a ? a : b` / `a ? b : a` to be a valid rewrite. */
const sameIdentRef = (a: Node, b: Node): boolean =>
    a.type === N.IdentifierReference && b.type === N.IdentifierReference && a.name === b.name && a.sym === b.sym;

/** Conservative STRUCTURAL equality for PURE expressions only (a narrow subset of oxc's `expr_eq`).
 *  Returns `true` only when `a` and `b` are the same shape built from identifiers, literals, and pure
 *  member/unary/binary/logical sub-trees -- enough for the `a ? b : b` identical-arms rewrite. Any node
 *  we don't explicitly handle (calls, spreads, objects with getters, ...) returns `false`, so an
 *  uncertain compare NEVER claims equality. Callers additionally require the whole arm to be pure. */
function exprEq(a: Node, b: Node): boolean {
    if (a === b) return true;
    if (a.type !== b.type) return false;
    switch (a.type) {
        case N.IdentifierReference:
            return a.name === b.name && a.sym === b.sym;
        case N.NumericLiteral:
        case N.StringLiteral:
        case N.BooleanLiteral:
        case N.BigIntLiteral:
        case N.RegExpLiteral:
            return a.name === b.name;
        case N.NullLiteral:
        case N.ThisExpression:
            return true;
        case N.UnaryExpression: {
            const x = a.data as UnaryData;
            const y = b.data as UnaryData;
            return x.operator === y.operator && exprEq(x.argument, y.argument);
        }
        case N.BinaryExpression:
        case N.LogicalExpression: {
            const x = a.data as { operator: string; left: Node; right: Node };
            const y = b.data as { operator: string; left: Node; right: Node };
            return x.operator === y.operator && exprEq(x.left, y.left) && exprEq(x.right, y.right);
        }
        case N.StaticMemberExpression: {
            const x = a.data as { object: Node; property: Node; optional: boolean };
            const y = b.data as { object: Node; property: Node; optional: boolean };
            return x.optional === y.optional && x.property.name === y.property.name && exprEq(x.object, y.object);
        }
        case N.ComputedMemberExpression: {
            const x = a.data as { object: Node; expression: Node; optional: boolean };
            const y = b.data as { object: Node; expression: Node; optional: boolean };
            return x.optional === y.optional && exprEq(x.object, y.object) && exprEq(x.expression, y.expression);
        }
        case N.CallExpression: {
            // Equating calls is sound HERE only because the sole caller collapses IDENTICAL arms
            // (`a ? x() : x()`), where the call is evaluated exactly once either way.
            const x = a.data as { callee: Node; arguments: Node[]; optional: boolean };
            const y = b.data as { callee: Node; arguments: Node[]; optional: boolean };
            if (x.optional !== y.optional || x.arguments.length !== y.arguments.length) return false;
            if (!exprEq(x.callee, y.callee)) return false;
            for (let i = 0; i < x.arguments.length; i++) if (!exprEq(x.arguments[i], y.arguments[i])) return false;
            return true;
        }
        default:
            return false;
    }
}

/** A numeric literal whose value equals `v` (`0` or `1`). */
const isNum = (n: Node, v: number): boolean => n.type === N.NumericLiteral && Number(n.name) === v;

/** Rewrite a `ConditionalExpression`, or return `null` to leave it untouched. Applied on EXIT (after
 *  children are simplified) so the arms are already in their most-reduced form. */
function minimizeConditional(n: Node): Node | null {
    const d = n.data as CondData;
    const { test, consequent, alternate } = d;

    // 5. `!a ? b : c` → `a ? c : b` -- drop the `!`, swap arms. Monotonic: the new test isn't a `!`.
    //    Take this first so a negated test is normalized before the other shape probes run.
    const un = notOperand(test);
    if (un !== null) {
        return create.ConditionalExpression(n.start, n.end, 0, un, alternate, consequent);
    }

    // 1. Boolean-literal arms → `!!a` / `!a`.
    if (isTrueLit(consequent) && isFalseLit(alternate)) {
        // `a ? true : false` → `!!a`
        const inner = create.UnaryExpression(n.start, n.end, create.OP.NOT, test);
        return create.UnaryExpression(n.start, n.end, create.OP.NOT, inner);
    }
    if (isFalseLit(consequent) && isTrueLit(alternate)) {
        // `a ? false : true` → `!a`
        return create.UnaryExpression(n.start, n.end, create.OP.NOT, test);
    }

    // 1b. Numeric 0/1 arms → the numeric coercion of the boolean (test evaluated once either way).
    //     `a ? 1 : 0` → `+!!a` ; `a ? 0 : 1` → `+!a`.
    if (isNum(consequent, 1) && isNum(alternate, 0)) {
        const notNot = create.UnaryExpression(
            n.start,
            n.end,
            create.OP.NOT,
            create.UnaryExpression(n.start, n.end, create.OP.NOT, test),
        );
        return create.UnaryExpression(n.start, n.end, create.OP.POS, notNot);
    }
    if (isNum(consequent, 0) && isNum(alternate, 1)) {
        return create.UnaryExpression(n.start, n.end, create.OP.POS, create.UnaryExpression(n.start, n.end, create.OP.NOT, test));
    }

    // 3. `a ? a : b` → `a || b` -- test is a bare ref, consequent is the SAME ref (double-read safe).
    if (isIdentRef(test) && sameIdentRef(test, consequent)) {
        return create.LogicalExpression(n.start, n.end, '||', test, alternate);
    }
    // 4. `a ? b : a` → `a && b` -- test is a bare ref, alternate is the SAME ref.
    if (isIdentRef(test) && sameIdentRef(test, alternate)) {
        return create.LogicalExpression(n.start, n.end, '&&', test, consequent);
    }

    // 2. `a ? b : b` → `(a, b)`, collapsing to just `b` when `a` is provably side-effect-free.
    //    Both arms must be structurally identical PURE expressions (exprEq only equates pure shapes).
    if (exprEq(consequent, alternate)) {
        if (!mayHaveSideEffects(test)) return consequent;
        return create.SequenceExpression(n.start, n.end, 0, [test, consequent]);
    }

    return null;
}

export const minimizeConditionalExpr: Visitor = {
    name: 'minimizeConditional',
    enter: null,
    // EXIT phase: rewrite the ternary after its test/arms have been visited (so a nested simplification
    // -- e.g. an inner ternary or const-folded arm -- has already happened and we see the reduced shape).
    exit: hookTable({
        [N.ConditionalExpression]: (n, ctx: TransformCtx) => {
            const rewritten = minimizeConditional(n);
            if (rewritten !== null) ctx.replaceWith(rewritten);
        },
    }),
};
