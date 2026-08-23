// B-boolctx — minimize an expression that is only used in a BOOLEAN CONTEXT (esbuild
// `SimplifyBooleanExpr`, oxc `minimize_expression_in_boolean_context.rs`). An expression whose value
// is coerced to a boolean and never observed as a value can be replaced by any expression with the
// same truthiness — so redundant boolean coercions collapse. This is the ONE place `!!x` → `x` is
// legal: outside a boolean context `!!x` (a boolean) and `x` (the raw value) differ, but under an
// `if`/`while`/`!` the difference is erased by the coercion the position performs anyway.
//
// THE BOOLEAN-CONTEXT POSITIONS (the value is coerced to boolean, NOT bound/returned/used as a value):
//   • `if (T) …`            — IfStatement.test
//   • `while (T) …`         — WhileStatement.test
//   • `do … while (T)`      — DoWhileStatement.test
//   • `for (…; T; …) …`     — ForStatement.test (the middle clause; may be absent)
//   • `T ? … : …`           — ConditionalExpression.test (the ARMS are NOT boolean context)
//   • `!T`                  — a prefix `!` UnaryExpression's argument
// In EACH of these the position discards everything but truthiness, so we run `simplify` on the child.
// `simplify` ALSO recurses through the sub-positions that inherit the boolean context of their parent:
//   • `A && B` / `A || B`   — both operands feed the same boolean coercion (`if (a && b)` coerces the
//                             result, hence each operand's truthiness is all that matters).
//   • `A ? B : C`           — the two ARMS (B, C) are each in the boolean context the whole `?:` is in.
//                             (Its own TEST is a separate boolean context handled by the node hook.)
//   • `(…, X)`              — a SequenceExpression's LAST element is the value; only it is coerced.
//
// THE SIMPLIFICATIONS (each confirmed against oxc; see citations):
//   • `!!x` → `x`           — double logical-negation is a no-op under coercion. oxc lines 19-28.
//   • `Boolean(x)` → `x`    — `Boolean(x)` coerces `x` to boolean; in a boolean context that coercion
//                             is redundant, so `x` alone suffices. GLOBAL `Boolean`, EXACTLY one
//                             non-spread arg, non-optional (same shadow gate as alternate-syntax's
//                             reverse `Boolean(x)`→`!!x`). (Not literally in the oxc file — oxc goes the
//                             other way in substitute_alternate_syntax — but the boolean-context
//                             direction is the safe, requested one.)
//
// DELIBERATELY BAILED (oxc does these with machinery shakeup lacks — a bail is always correct):
//   • `(a|b) === 0` → `!(a|b)` (oxc 29-51) needs `is_int32_or_uint32` type reasoning — BAIL.
//   • `a && truthyNoSideEffects` → `a` (oxc 56-70), and the `?:`→`||`/`&&` collapses (oxc 72-104),
//     need `get_side_free_boolean_value` (side-effect-free constant truthiness) — shakeup has no such
//     helper, so we RECURSE into those operands/arms but never perform the collapse — BAIL.
//   • `var hydrating = false` identifier folding (oxc 111-125) needs symbol value tracking — BAIL.
//   • A literal test (`if (1)`) folding to its boolean is left to dead-code/fold-constants (they own
//     constants and eliminate the dead branch); we do NOT duplicate that here.
//
// CONSERVATIVE by construction: `simplify` is only ever entered from a genuine boolean-context slot, so
// `const b = !!x` (b HOLDS the boolean — value context, not boolean context) is never reached and never
// simplified, and a `?:` ARM outside a boolean context is likewise untouched. Every case not matched
// falls through unchanged.
import { N, type Node } from '../../ast.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

type UnaryData = { operator: string; prefix: boolean; argument: Node };
type LogicalData = { operator: string; left: Node; right: Node };
type CondData = { test: Node; consequent: Node; alternate: Node };
type SeqData = { expressions: Node[] };
type CallData = { callee: Node; arguments: Node[]; optional: boolean };

/** Is `n` a prefix `!` negation? Returns its argument, else `null`. */
function notArg(n: Node): Node | null {
    if (n.type !== N.UnaryExpression) return null;
    const d = n.data as UnaryData;
    return d.operator === '!' && d.prefix ? d.argument : null;
}

/** Is `n` a call to the GLOBAL `Boolean` with exactly one non-spread arg and not optional? Returns the
 *  sole argument, else `null`. `sym === 0` = unresolved/global — a shadowed `let Boolean = …` (nonzero
 *  sym) is excluded, mirroring alternate-syntax's shadow gate. `Boolean?.(x)` (optional) bails. */
function booleanCallArg(n: Node): Node | null {
    if (n.type !== N.CallExpression) return null;
    const d = n.data as CallData;
    if (d.optional || d.arguments.length !== 1) return null;
    if (d.callee.type !== N.IdentifierReference || d.callee.name !== 'Boolean' || d.callee.sym !== 0) return null;
    const arg = d.arguments[0];
    return arg.type === N.SpreadElement ? null : arg;
}

/** Simplify an expression that is used ONLY as a boolean (truthiness). Returns the (possibly rewritten)
 *  expression to install in the slot. Recurses through the sub-positions that inherit the boolean
 *  context (`&&`/`||` operands, `?:` arms, a sequence's last element), and collapses redundant boolean
 *  coercions (`!!x` → `x`, `Boolean(x)` → `x`). Everything else is returned unchanged. */
function simplify(expr: Node): Node {
    // `!!x` → `x`: a `!` whose argument is itself a `!`. The inner argument is ALSO in a boolean
    // context (it feeds the same outer coercion), so recurse into it. `!(single !)` is minimize-not's
    // job, not ours — we only collapse the DOUBLE negation.
    const outer = notArg(expr);
    if (outer !== null) {
        const inner = notArg(outer);
        if (inner !== null) return simplify(inner);
        return expr; // single `!` — not a boolean-context simplification here
    }
    // `Boolean(x)` → `x`: the coercion is redundant under an outer coercion. The argument inherits the
    // boolean context, so recurse into it.
    const boolArg = booleanCallArg(expr);
    if (boolArg !== null) return simplify(boolArg);

    switch (expr.type) {
        // `A && B` / `A || B`: both operands feed the same boolean coercion, so each is itself in a
        // boolean context. Recurse in place (no collapse — that needs oxc's side-free boolean value).
        case N.LogicalExpression: {
            const d = expr.data as LogicalData;
            if (d.operator === '&&' || d.operator === '||') {
                d.left = simplify(d.left);
                d.right = simplify(d.right);
            }
            return expr;
        }
        // `A ? B : C`: the two ARMS inherit the boolean context; the TEST does NOT (it is its own
        // boolean context, simplified by the ConditionalExpression node hook when reached). We touch
        // only the arms here.
        case N.ConditionalExpression: {
            const d = expr.data as CondData;
            d.consequent = simplify(d.consequent);
            d.alternate = simplify(d.alternate);
            return expr;
        }
        // `(…, X)`: only the LAST element is the produced value that gets coerced; the leading elements
        // run for side effects and are NOT boolean context. Simplify the last in place.
        case N.SequenceExpression: {
            const d = expr.data as SeqData;
            if (d.expressions.length > 0) {
                const last = d.expressions.length - 1;
                d.expressions[last] = simplify(d.expressions[last]);
            }
            return expr;
        }
        default:
            return expr;
    }
}

/** Simplify a `.test` field (shared by if/while/do-while/conditional) in place, marking `ctx.changed`
 *  only when the top-level expression actually changed identity (a genuine `!!`/`Boolean` collapse).
 *  Nested in-place edits inside a preserved node also flip `changed` — see the per-hook logic. */
function simplifyTest(n: Node, ctx: TransformCtx): void {
    const d = n.data as { test: Node };
    const next = simplify(d.test);
    if (next !== d.test) {
        d.test = next;
        ctx.changed = true;
    }
}

export const booleanContext: Visitor = {
    name: 'booleanContext',
    // ENTER phase: simplify the boolean-context child BEFORE descending, so a collapse (`!!x`→`x`)
    // exposes the inner expression to the other passes' hooks on the same traversal where possible;
    // the driver loops to a fixed point regardless, so ordering is not load-bearing.
    enter: hookTable({
        [N.IfStatement]: simplifyTest,
        [N.WhileStatement]: simplifyTest,
        [N.DoWhileStatement]: simplifyTest,
        [N.ConditionalExpression]: simplifyTest,
        // ForStatement.test is nullable (`for (;;)` has none) — only simplify when present.
        [N.ForStatement]: (n, ctx) => {
            const d = n.data as { test: Node | null };
            if (d.test === null) return;
            const next = simplify(d.test);
            if (next !== d.test) {
                d.test = next;
                ctx.changed = true;
            }
        },
        // The argument of a prefix `!` is a boolean context: `!EXPR` coerces EXPR to boolean. This hook
        // simplifies that SINGLE `!`'s argument (e.g. `!(a && !!b)` → `!(a && b)`). A top-level `!!x` is
        // collapsed when the OUTER `!` is reached as a boolean-context slot (if/while/etc.) or as an
        // inner `!` during `simplify`'s recursion — not here, where we'd only see one `!` at a time.
        [N.UnaryExpression]: (n, ctx) => {
            const d = n.data as UnaryData;
            if (d.operator !== '!' || !d.prefix) return;
            const next = simplify(d.argument);
            if (next !== d.argument) {
                d.argument = next;
                ctx.changed = true;
            }
        },
    }),
    exit: null,
};
