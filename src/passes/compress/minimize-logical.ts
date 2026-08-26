// B-logical — minimize-logical (oxc `minimize_logical_expression.rs`). Two safe, high-value rewrites
// on `LogicalExpression`/`AssignmentExpression`, each behavior-identical (a bail is always correct):
//
//  1. NULLISH-COALESCE COLLAPSE (oxc `try_compress_is_null_or_undefined`, `.rs:20-151`):
//       `x === null || x === undefined`  →  `x == null`
//       `x === undefined || x === null`  →  `x == null`   (commutative — either order)
//       `x !== null && x !== undefined`  →  `x != null`   (the `&&` dual, `.rs:37-40`)
//     `== null` / `!= null` is the exact loose-equality idiom matching BOTH `null` and `undefined`
//     and nothing else, so the collapse is value-identical — PROVIDED `x` is the SAME simple,
//     side-effect-free reference on both sides (same IdentifierReference name+sym). oxc's `.rs:99-138`
//     pairs a null/undefined operand against the same identifier on each side; we require a structural
//     `sameSimpleRef` on both non-null operands. `x` is evaluated TWICE in the source and ONCE in the
//     result (`x == null`), so the reference MUST be side-effect-free for the eval-count change to be
//     unobservable — a member read (`o.p`) can trigger a getter, so we restrict to plain identifiers
//     for v1 (oxc admits same-object member chains guarded by a mutation set we don't model; a
//     conservative bail is always correct). This is the common lowered-optional-chaining / hand-written
//     `x == null` guard shape.
//
//     Left-nested chains fold too (oxc `.rs:51-73`): `a === null || a === undefined || rest` parses
//     as `(a===null || a===undefined) || rest`; we collapse the inner pair → `a == null || rest`.
//
//  2. COMPOUND / LOGICAL ASSIGNMENT (oxc `try_compress_logical_expression_to_assignment_expression`
//     `.rs:229-293` + `has_no_side_effect_for_evaluation_same_target` `.rs:164-204`):
//       `a = a + b`   →  `a += b`   (and `- * / % ** & | ^ << >> >>>`)
//       `a = a || b`  →  `a ||= b`
//       `a = a && b`  →  `a &&= b`
//       `a = a ?? b`  →  `a ??= b`
//     ONLY when the assignment target `a` is a SIMPLE IdentifierReference and the binary/logical LEFT
//     operand is the SAME identifier (same name+sym) — then `a` is read exactly where it is written,
//     so folding read+write into `<op>=` (single evaluation of the target) is value-identical and
//     preserves `||=`/`&&=`/`??=` short-circuit semantics (they read the target, then assign only if
//     needed — the source `a = a || b` already reads `a` first). MEMBER targets bail for v1 (oxc
//     `.rs:176-204` handles `a.b = a.b + c`, but the object is evaluated twice in the source and once
//     in the result — a getter/proxy hazard oxc guards with a mutation set we don't model).
//
// NOT De Morgan (`!(a||b)` → `!a&&!b`): that is `minimize-not`'s lane; doing it here would oscillate.
import { N, type Node } from '../../ast.ts';
import { boolCoerce } from './fold-constants.ts';
import * as create from '../../parser/create.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

type LogicalData = { operator: string; left: Node; right: Node };
type BinaryData = { operator: string; left: Node; right: Node };
type AssignData = { operator: string; left: Node; right: Node };
type UnaryData = { operator: string; argument: Node };

// --- reference identity --------------------------------------------------------------------------

/** Is `n` a plain reference to a variable — an IdentifierReference? */
const isIdentRef = (n: Node): boolean => n.type === N.IdentifierReference;

/** Two IdentifierReferences denote the SAME binding: same resolved symbol id and same source name.
 *  `sym === 0` means unresolved/global — two `sym===0` refs match iff their names match (the same
 *  global, e.g. a module-level free `x`). */
const sameIdent = (a: Node, b: Node): boolean =>
    a.type === N.IdentifierReference && b.type === N.IdentifierReference && a.sym === b.sym && a.name === b.name;

/** Structural equality of two SIMPLE, side-effect-free references, used by the null/undefined collapse
 *  where the reference is evaluated a different number of times before vs after. For v1 this is EXACTLY
 *  a plain IdentifierReference match: reading a variable has no side effect, so evaluating it twice
 *  (source) vs once (`x == null`) is unobservable. Member chains (`o.p`) are NOT accepted — a property
 *  read can trigger a getter, whose call count IS observable — so they bail (conservative). */
const sameSimpleRef = (a: Node, b: Node): boolean => sameIdent(a, b);

// --- null / undefined operand probes -------------------------------------------------------------

/** Is `n` the `null` literal? */
const isNull = (n: Node): boolean => n.type === N.NullLiteral;

/** Is `n` the `undefined` VALUE — the global `undefined` IdentifierReference (`sym === 0`, unshadowed)
 *  or a `void <expr>` (always evaluates to `undefined`)? Mirrors oxc `is_expression_undefined`. A
 *  shadowed `let undefined = 1` (nonzero sym) is NOT the undefined value, so it is excluded. */
const isUndefined = (n: Node): boolean => {
    if (n.type === N.IdentifierReference && n.name === 'undefined' && n.sym === 0) return true;
    return n.type === N.UnaryExpression && (n.data as UnaryData).operator === 'void';
};

/** Category of a null-or-undefined operand. */
enum NullKind {
    None = 0,
    Null = 1,
    Undefined = 2,
}
const nullKind = (n: Node): NullKind => (isNull(n) ? NullKind.Null : isUndefined(n) ? NullKind.Undefined : NullKind.None);

/** For one side `left <cmp> right`, split into (the null/undefined operand's kind, the OTHER operand).
 *  Commutative — `null === x` and `x === null` both yield `(Null, x)`. Returns `null` if neither
 *  operand is null/undefined, or if BOTH are (`null === undefined` — degenerate, bail). */
function splitNullCompare(bin: BinaryData): { kind: NullKind; ref: Node } | null {
    const lk = nullKind(bin.left);
    const rk = nullKind(bin.right);
    if (lk !== NullKind.None && rk === NullKind.None) return { kind: lk, ref: bin.right };
    if (rk !== NullKind.None && lk === NullKind.None) return { kind: rk, ref: bin.left };
    return null; // neither side is null/undefined, or both are (degenerate)
}

/** Try to collapse `left <lop> right` (already known to be a `||`/`&&` pair) into `ref == null` /
 *  `ref != null`. `findOp` is the strict comparison each side must use (`===` for `||`, `!==` for
 *  `&&`); `replaceOp` is the loose result (`==` / `!=`). Returns the replacement BinaryExpression, or
 *  `null` to bail. `start`/`end` span the collapsed subtree. */
function collapseNullPair(left: Node, right: Node, start: number, end: number, findOp: string, replaceOp: string): Node | null {
    if (left.type !== N.BinaryExpression || right.type !== N.BinaryExpression) return null;
    const lb = left.data as BinaryData;
    const rb = right.data as BinaryData;
    if (lb.operator !== findOp || rb.operator !== findOp) return null;

    const ls = splitNullCompare(lb);
    const rs = splitNullCompare(rb);
    if (ls === null || rs === null) return null;
    // One side must be `=== null`, the other `=== undefined` (in either order). Two `=== null`s or two
    // `=== undefined`s are NOT the null-or-undefined idiom — bail (redundant test, not ours).
    if (ls.kind === rs.kind) return null;
    // Both non-null operands must be the SAME side-effect-free reference.
    if (!sameSimpleRef(ls.ref, rs.ref)) return null;

    // `ref == null` (or `!= null`). Reuse the left side's reference node (it stays live; the right
    // side's twin and both `null`/`undefined` operands are dropped).
    const nullLit = create.NullLiteral(start, end, 0);
    return create.BinaryExpression(start, end, replaceOp, ls.ref, nullLit);
}

/** Fold a logical whose LEFT operand is a known constant (oxc `try_fold_and_or`).
 *
 *   `true && x`  → `x`        `false && x` → `false`
 *   `true || x`  → `true`     `false || x` → `x`
 *
 *  Only when the left side is a recognised LITERAL, so dropping it can discard no side effect — a
 *  `!0` counts, because `substituteAlternateSyntax` rewrites `true` to it and the unary folds away.
 *
 *  Absent, `normalize`'s `while (true)` → `for (; !0;)` left the `!0` sitting in every hoisted loop
 *  test forever: `minimizeForStatement` produced `for (; !0 && !(x);)` where oxc reaches
 *  `for (; !x;)`. It is a general fold though, not a loop one — `true && f()` was not reducing either.
 *
 *  `??` is excluded: it tests NULLISH, not truthiness, so `0 ?? x` is `0` while `0 || x` is `x`. */
function tryFoldConstantOperand(n: Node): Node | null {
    const d = n.data as LogicalData;
    if (d.operator !== '&&' && d.operator !== '||') return null;
    // `!<literal>` is a literal for this purpose — see above.
    let left = d.left;
    let negations = 0;
    while (left.type === N.UnaryExpression && (left.data as { operator: string }).operator === '!') {
        left = (left.data as { argument: Node }).argument;
        negations++;
    }
    const base = boolCoerce(left);
    if (base === null) return null;
    const truthy = negations % 2 === 0 ? base : !base;
    if (d.operator === '&&') return truthy ? d.right : d.left;
    return truthy ? d.left : d.right;
}

/** Attempt the null/undefined collapse on a `LogicalExpression`. Handles the direct pair and the
 *  left-nested chain (`(a===null || a===undefined) || rest` → `a==null || rest`). */
function tryNullCollapse(n: Node): Node | null {
    const d = n.data as LogicalData;
    let findOp: string;
    let replaceOp: string;
    if (d.operator === '||') {
        findOp = '===';
        replaceOp = '==';
    } else if (d.operator === '&&') {
        findOp = '!==';
        replaceOp = '!=';
    } else {
        return null; // `??` — nothing to collapse (oxc `.rs:40`)
    }

    // Direct pair: `left <op> right`.
    const direct = collapseNullPair(d.left, d.right, n.start, n.end, findOp, replaceOp);
    if (direct !== null) return direct;

    // Left-nested chain: `(inner.left <op> inner.right) <op> right` where the SAME operator nests on
    // the left (oxc `.rs:51-73`). Collapse `inner.right <op> right`; keep `inner.left` as the new left.
    if (d.left.type !== N.LogicalExpression) return null;
    const inner = d.left.data as LogicalData;
    if (inner.operator !== d.operator) return null;
    const collapsed = collapseNullPair(inner.right, d.right, inner.right.start, n.end, findOp, replaceOp);
    if (collapsed === null) return null;
    return create.LogicalExpression(n.start, n.end, d.operator, inner.left, collapsed);
}

// --- compound / logical assignment ---------------------------------------------------------------

/** Binary operators whose `a = a <op> b` form has a `<op>=` compound-assignment spelling. Excludes
 *  `==`/`===`/`<`/etc. (no compound form). */
const COMPOUND_BINARY = new Set(['+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>']);

/** Logical operators → their logical-assignment spelling (ES2021). */
const LOGICAL_ASSIGN: Record<string, string> = { '||': '||=', '&&': '&&=', '??': '??=' };

/** Try to fold a plain `=` assignment whose RHS re-reads the target into a compound/logical
 *  assignment: `a = a + b` → `a += b`, `a = a || b` → `a ||= b`, etc. Requires: operator `=`; target
 *  `a` a plain IdentifierReference; RHS a Binary/Logical whose LEFT operand is the SAME identifier as
 *  `a` (single-eval read+write coincide). Member targets bail for v1 (see file header). */
function tryCompoundAssign(n: Node): Node | null {
    const d = n.data as AssignData;
    if (d.operator !== '=') return null; // already compound (or destructuring) — nothing to do
    if (!isIdentRef(d.left)) return null; // member/pattern target — bail for v1

    const rhs = d.right;
    if (rhs.type === N.BinaryExpression) {
        const b = rhs.data as BinaryData;
        if (!COMPOUND_BINARY.has(b.operator)) return null;
        if (!sameIdent(d.left, b.left)) return null; // RHS must read the SAME variable, on the left
        // `a = a + b` → `a += b`: keep target `a`, take the binary's RIGHT as the new RHS.
        return create.AssignmentExpression(n.start, n.end, `${b.operator}=`, d.left, b.right);
    }
    if (rhs.type === N.LogicalExpression) {
        const l = rhs.data as LogicalData;
        const op = LOGICAL_ASSIGN[l.operator];
        if (op === undefined) return null;
        if (!sameIdent(d.left, l.left)) return null;
        // `a = a || b` → `a ||= b`: single eval of `a`; `||=`/`&&=`/`??=` short-circuit matches the
        // source's `a || b` read-then-maybe-assign.
        return create.AssignmentExpression(n.start, n.end, op, d.left, l.right);
    }
    return null;
}

export const minimizeLogical: Visitor = {
    name: 'minimizeLogical',
    // EXIT phase: children are visited first, so a nested inner pair (`a===null||a===undefined`) has
    // already been examined before its enclosing chain, and RHS folding by other passes has settled.
    // Ordering across the fixed-point loop is not load-bearing (the driver re-runs), but exit avoids a
    // wasted iteration.
    enter: null,
    exit: hookTable({
        [N.LogicalExpression]: (n, ctx: TransformCtx) => {
            const folded = tryFoldConstantOperand(n);
            if (folded !== null) {
                ctx.replaceWith(folded);
                return;
            }
            const rewritten = tryNullCollapse(n);
            if (rewritten !== null) ctx.replaceWith(rewritten);
        },
        [N.AssignmentExpression]: (n, ctx: TransformCtx) => {
            const rewritten = tryCompoundAssign(n);
            if (rewritten !== null) ctx.replaceWith(rewritten);
        },
    }),
};
