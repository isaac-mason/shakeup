// B-not — minimize-not (oxc `minimize_not_expression.rs` / `minimize_unary`, esbuild `MaybeSimplifyNot`):
// simplify a prefix `!` UnaryExpression by pushing the negation INTO its argument when the result is
// behavior-identical AND no longer. This pass OWNS De Morgan's law (no other compress pass does it).
//
// Ported from oxc `crates/oxc_minifier/src/peephole/minimize_not_expression.rs` (`minimize_unary`,
// lines 23-74) — the canonical, non-oscillating direction. Each rewrite is involutive (a later `!`
// restores the original at no byte cost), so nothing here loops against fold-constants or the
// branch-swaps that consume a `!` for free.
//
// THE REWRITES (all on a prefix `!` over…):
//   1. EQUALITY FLIP (oxc :38-46) — `!(a === b)` → `a !== b`, `!(a !== b)` → `a === b`,
//      `!(a == b)` → `a != b`, `!(a != b)` → `a == b`. ONLY the four equality operators flip through
//      `!`. Relational operators (`<`, `>`, `<=`, `>=`) do NOT flip: `!(a < b)` is NOT `a >= b` —
//      they differ when either operand is `NaN` (`NaN < 1` is false, so `!(NaN<1)` is true, but
//      `NaN >= 1` is false). That is the classic minifier NaN miscompile; we never do it. oxc guards
//      this with `binary_expr.operator.is_equality()` / `equality_inverse_operator()`, both defined
//      ONLY for the four equality operators (confirmed in oxc_syntax operator.rs).
//   2. DOUBLE/TRIPLE NEGATION (oxc :30-37) — oxc collapses `!(!x)` → `x` ONLY when the inner `!`'s
//      argument is boolean-typed (`e.argument.value_type().is_boolean()`), because `!!x` and `x`
//      differ unless `x` is already a boolean. We port that guard EXACTLY via {@link isBooleanTyped}
//      (the boolean-producing shapes oxc's DetermineValueType recognizes: `!`/`delete`, comparison
//      binaries incl. `in`/`instanceof`, boolean literals). Consequence: `!!!x` → `!x` (the inner
//      argument `!x` is always boolean), but bare `!!x` over a non-boolean (`!!foo`, `!!(a+b)`) is
//      LEFT ALONE — collapsing it needs a proven boolean context, which is the boolean-context pass's job.
//   3. DE MORGAN (oxc :47-61, :79-123) — `!(a == b && c == d)` → `a != b || c != d`, and the `||`
//      dual. This is LONGER in the general case, so oxc does it ONLY when it does not add parens
//      (`de_morgan_paren_delta(...) <= 0`) AND every leaf inverts its operator in place — i.e. every
//      operand of the `&&`/`||` chain is either an equality-operator binary (which flips safely) or a
//      nested `&&`/`||` of the same. A single relational leaf, or any other operand, makes the whole
//      chain bail (`de_morgan_paren_delta` returns `None`). We port the paren-delta arithmetic and the
//      in-place inversion EXACTLY; the involution guarantee means a re-negation restores the chain for
//      free, so this never regresses a shape that would otherwise consume the `!`.
//
// PORT-vs-BAIL: oxc's `minimize_unary` also has a SEQUENCE case (`!(a, b)` → `a, !b`, :62-71). We
// deliberately DO NOT port it: minimize-conditions owns the `if (!(a, b)) c()` → `(a, b) || c()` flip,
// which needs to see the `!(seq)` intact — distributing the `!` into the sequence here (during the same
// deepest-first traversal) would steal it and yield a longer `(a, !b) && c()`. Both are behavior-equal,
// but leaving the sequence to minimize-conditions is the shorter, non-colliding division of labor.
// oxc also runs `minimize_expression_in_boolean_context` on the argument first (:28); shakeup has no
// equivalent here, and omitting it only forgoes extra folds — it never changes correctness.
//
// CONSERVATIVE: behavior-identical only. Relational-operator flips are the NaN landmine — never done.
// Anything not matched here keeps its `!` untouched (a bail is always correct).
import { N, type Node } from '../../ast.ts';
import { hookTable, type Visitor } from '../traverse.ts';

type UnaryData = { operator: string; prefix: boolean; argument: Node };
type BinaryData = { operator: string; left: Node; right: Node };
type LogicalData = { operator: string; left: Node; right: Node };

/** The four equality operators that invert SAFELY through `!` (oxc `equality_inverse_operator`,
 *  defined only for these). Relational operators are deliberately ABSENT — they are unsound under
 *  `NaN` and must never flip. */
const EQUALITY_INVERSE: Record<string, string | undefined> = {
    '==': '!=',
    '!=': '==',
    '===': '!==',
    '!==': '===',
};

/** Is `n` a prefix `!` UnaryExpression? (The only unary this pass acts on.) */
function isNot(n: Node): boolean {
    return n.type === N.UnaryExpression && (n.data as UnaryData).operator === '!';
}

/** Mirror of oxc `DetermineValueType ... is_boolean()` (value_type.rs) restricted to the shapes that
 *  PROVABLY produce a boolean — a conservative subset (every non-match is a safe bail):
 *    - `!x` / `delete x`               (UnaryExpression LogicalNot/Delete → Boolean)
 *    - `a <cmp> b` for cmp in          (BinaryExpression comparison → Boolean)
 *        `== != === !== < > <= >= in instanceof`
 *    - `true` / `false`                (BooleanLiteral → Boolean)
 *  This is exactly the guard oxc uses for the `!!x` → `x` collapse, so `!!!x` (inner arg `!x`) and
 *  `!!(a===b)` fold, while `!!foo` / `!!(a+b)` (non-boolean) are left alone. */
function isBooleanTyped(n: Node): boolean {
    switch (n.type) {
        case N.BooleanLiteral:
            return true;
        case N.UnaryExpression: {
            const op = (n.data as UnaryData).operator;
            return op === '!' || op === 'delete';
        }
        case N.BinaryExpression: {
            const op = (n.data as BinaryData).operator;
            return (
                op === '==' ||
                op === '!=' ||
                op === '===' ||
                op === '!==' ||
                op === '<' ||
                op === '>' ||
                op === '<=' ||
                op === '>=' ||
                op === 'in' ||
                op === 'instanceof'
            );
        }
        default:
            return false;
    }
}

/** Character delta from parentheses added/removed by De Morgan on a logical chain (oxc
 *  `de_morgan_paren_delta`, :79-101), or `null` if some operand cannot invert its operator in place.
 *  A leaf must be an equality-operator binary (flips safely); a nested logical recurses. Flipping
 *  `&&`↔`||` changes which nested chains need parens: an `&&` under `||` prints bare, but its
 *  inversion (`||` under `&&`) needs parens (+2 chars for the pair); the reverse drops them (-2). */
function deMorganParenDelta(e: LogicalData): number | null {
    if (e.operator !== '&&' && e.operator !== '||') return null;
    let delta = 0;
    for (const side of [e.left, e.right]) {
        if (side.type === N.BinaryExpression && EQUALITY_INVERSE[(side.data as BinaryData).operator] !== undefined) {
            // equality leaf — inverts in place, no paren change
            continue;
        }
        if (side.type === N.LogicalExpression) {
            const child = side.data as LogicalData;
            const inner = deMorganParenDelta(child);
            if (inner === null) return null;
            delta += inner;
            if (e.operator === '||' && child.operator === '&&') delta += 2;
            else if (e.operator === '&&' && child.operator === '||') delta -= 2;
            continue;
        }
        return null; // any other operand (relational binary, identifier, call, …) → bail
    }
    return delta;
}

/** Apply De Morgan in place on a chain already approved by {@link deMorganParenDelta}: flip the
 *  operator and invert each side (oxc `de_morgan_invert_logical` / `de_morgan_invert`, :105-123). */
function deMorganInvertLogical(e: LogicalData): void {
    e.operator = e.operator === '&&' ? '||' : '&&';
    deMorganInvert(e.left);
    deMorganInvert(e.right);
}
function deMorganInvert(expr: Node): void {
    if (expr.type === N.BinaryExpression) {
        const b = expr.data as BinaryData;
        // approved by deMorganParenDelta ⇒ operator is an equality operator ⇒ inverse defined.
        b.operator = EQUALITY_INVERSE[b.operator] as string;
        return;
    }
    // The only other approved shape is a nested logical (deMorganParenDelta bails on anything else).
    deMorganInvertLogical(expr.data as LogicalData);
}

/** The core of oxc `minimize_unary` (:23-74): given a prefix `!` UnaryExpression, return its
 *  simplified replacement, or `null` to leave the `!` untouched. */
function simplifyUnary(n: Node): Node | null {
    const arg = (n.data as UnaryData).argument;

    // 1. `!(a === b)` → `a !== b`, etc. — EQUALITY operators only (relational is the NaN landmine).
    if (arg.type === N.BinaryExpression) {
        const b = arg.data as BinaryData;
        const inv = EQUALITY_INVERSE[b.operator];
        if (inv !== undefined) {
            b.operator = inv;
            return arg;
        }
        return null;
    }

    // 2. `!(!x)` → `x`, but ONLY when the inner argument is boolean-typed (else `!!x` ≠ `x`). This
    //    fires for `!!!x` (inner arg `!x`) and `!!(a===b)`, and is left alone for `!!foo`.
    if (isNot(arg)) {
        const innerArg = (arg.data as UnaryData).argument;
        if (isBooleanTyped(innerArg)) return innerArg;
        return null;
    }

    // 3. De Morgan — `!(a==b && c==d)` → `a!=b || c!=d` — only when it doesn't add parens and every
    //    leaf inverts in place.
    if (arg.type === N.LogicalExpression) {
        const l = arg.data as LogicalData;
        const delta = deMorganParenDelta(l);
        if (delta !== null && delta <= 0) {
            deMorganInvertLogical(l);
            return arg;
        }
        return null;
    }

    return null;
}

export const minimizeNot: Visitor = {
    name: 'minimizeNot',
    enter: null,
    // EXIT phase: run after the argument's children are visited, so a fold that canonicalizes the
    // argument (e.g. constProp inlining a comparison) is already in place before we inspect it.
    exit: hookTable({
        [N.UnaryExpression]: (n, ctx) => {
            if (!isNot(n)) return;
            const replacement = simplifyUnary(n);
            if (replacement !== null) ctx.replaceWith(replacement);
        },
    }),
};
