// Port of oxc_minifier/src/peephole/minimize_logical_expression.rs, the functions tree-shake mode
// reaches through `joinWithLeftAssociativeOp` and `removeUnusedLogicalExpr`.

import { getInnerExpression } from '../../../analysis/const-eval.ts';
import { type DataOf, N, type Node, node } from '../../../ast/index.ts';
import { MemberWriteEffect } from '../symbol-metadata.ts';
import { recordMemberWriteEffect } from '../symbol-state.ts';
import { ReferenceFlags } from '../syntax.ts';
import {
    contentEq,
    type DceCtx,
    getReference,
    isExpressionUndefined,
    isGlobalReference,
    replaceExpression,
    type Span,
    supportsFeature,
    takeNode,
} from '../traverse-context.ts';
import { commutativePair, memberObjectMayBeMutated } from './index.ts';
import { extractIdOrAssignToId } from './minimize-conditions.ts';

export function minimizeLogicalExpression(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.LogicalExpression) return;
    const changed = tryCompressIsNullOrUndefined(ctx, expr);
    if (changed !== null) replaceExpression(ctx, expr, changed);
    tryCompressLogicalExpressionToAssignmentExpression(ctx, expr);
}

/** `foo === null || foo === undefined` => `foo == null`, `foo !== null && foo !== undefined` =>
 *  `foo != null`, also through `(a = foo.bar) === null || a === undefined`. Assumes `document.all` is
 *  a normal object. */
function tryCompressIsNullOrUndefined(ctx: DceCtx, expr: Node): Node | null {
    const data = expr.data as DataOf<'LogicalExpression'>;
    const operator = data.operator;
    let findOperator: string;
    let replaceOperator: string;
    switch (operator) {
        case '||':
            findOperator = '===';
            replaceOperator = '==';
            break;
        case '&&':
            findOperator = '!==';
            replaceOperator = '!=';
            break;
        default:
            return null;
    }
    const newExpr = tryCompressIsNullOrUndefinedForLeftAndRight(ctx, data.left, data.right, expr, findOperator, replaceOperator);
    if (newExpr !== null) return newExpr;
    const left = data.left;
    if (left.type !== N.LogicalExpression || left.data.operator !== operator) return null;
    const newSpan = mergeWithin(left.data.right, data.right, expr);
    const inner = tryCompressIsNullOrUndefinedForLeftAndRight(
        ctx,
        left.data.right,
        data.right,
        newSpan,
        findOperator,
        replaceOperator,
    );
    if (inner === null) return null;
    return node(N.LogicalExpression, expr.start, expr.end, '', {
        operator,
        left: takeNode(ctx, left.data.left),
        right: inner,
    });
}

/** oxc `Span::merge_within(...).unwrap_or(SPAN)`. */
function mergeWithin(first: Span, second: Span, outer: Span): Span {
    const start = Math.min(first.start, second.start);
    const end = Math.max(first.end, second.end);
    return start >= outer.start && end <= outer.end ? { start, end } : { start: 0, end: 0 };
}

type NullOrUndefined = { kind: 'null'; span: Span } | { kind: 'undefined' };

function tryCompressIsNullOrUndefinedForLeftAndRight(
    ctx: DceCtx,
    left: Node,
    right: Node,
    span: Span,
    findOperator: string,
    replaceOperator: string,
): Node | null {
    if (left.type !== N.BinaryExpression || right.type !== N.BinaryExpression) return null;
    if (left.data.operator !== findOperator || right.data.operator !== findOperator) return null;

    const isNullOrUndefined = (candidate: Node): NullOrUndefined | null => {
        if (candidate.type === N.NullLiteral) return { kind: 'null', span: candidate };
        if (isExpressionUndefined(ctx, candidate)) return { kind: 'undefined' };
        return null;
    };
    let leftValue: NullOrUndefined;
    let leftNonValueExpr: Node;
    let leftIdName: string;
    const leftLeftValue = isNullOrUndefined(left.data.left);
    if (leftLeftValue !== null) {
        leftValue = leftLeftValue;
        const id = extractIdOrAssignToId(left.data.right);
        if (id === null) return null;
        leftNonValueExpr = left.data.right;
        leftIdName = id.name;
    } else {
        const leftRightValue = isNullOrUndefined(left.data.right);
        if (leftRightValue === null) return null;
        leftValue = leftRightValue;
        const id = extractIdOrAssignToId(left.data.left);
        if (id === null) return null;
        leftNonValueExpr = left.data.left;
        leftIdName = id.name;
    }

    // `checkA` answers with the span of the right-hand `null`, or null when the left side held it.
    const pair = commutativePair(
        right.data.left as Node,
        right.data.right as Node,
        (candidate): { nullSpan: Span | null } | null => {
            if (leftValue.kind === 'null') return isExpressionUndefined(ctx, candidate) ? { nullSpan: null } : null;
            return candidate.type === N.NullLiteral ? { nullSpan: candidate } : null;
        },
        (candidate): Node | null => (candidate.type === N.IdentifierReference ? candidate : null),
    );
    if (pair === null) return null;
    const [rightValue, rightId] = pair;
    if (leftIdName !== rightId.name) return null;

    const nullExprSpan = leftValue.kind === 'null' ? leftValue.span : (rightValue.nullSpan as Span);
    return node(N.BinaryExpression, span.start, span.end, '', {
        operator: replaceOperator,
        left: takeNode(ctx, leftNonValueExpr),
        right: node(N.NullLiteral, nullExprSpan.start, nullExprSpan.end, 'null', null),
    });
}

const isMemberExpression = (expr: Node): boolean =>
    expr.type === N.StaticMemberExpression || expr.type === N.ComputedMemberExpression || expr.type === N.PrivateFieldExpression;

/** Whether the assignment target and the expression evaluate without side effects to the same
 *  reference: `a`/`a`, `a.b`/`a.b`, `a["b"]`/`a["b"]`, `a[0]`/`a[0]`, where `a` can be `this`. */
export function hasNoSideEffectForEvaluationSameTarget(ctx: DceCtx, assignmentTarget: Node, expr: Node): boolean {
    if (assignmentTarget.type === N.IdentifierReference && expr.type === N.IdentifierReference)
        return assignmentTarget.name === expr.name;
    if (isMemberExpression(assignmentTarget)) {
        if (assignmentTarget.type === N.ComputedMemberExpression) {
            const key = assignmentTarget.data.expression as Node;
            if (key.type !== N.StringLiteral && key.type !== N.NumericLiteral) return false;
        }
        const object = (assignmentTarget.data as DataOf<'StaticMemberExpression'>).object;
        let hasSameObject: boolean;
        switch (object.type) {
            case N.IdentifierReference:
                hasSameObject = !isGlobalReference(ctx, object);
                break;
            case N.ThisExpression:
                hasSameObject =
                    isMemberExpression(expr) && (expr.data as DataOf<'StaticMemberExpression'>).object.type === N.ThisExpression;
                break;
            default:
                hasSameObject = false;
        }
        if (!hasSameObject) return false;
        if (isMemberExpression(expr)) return contentEq(assignmentTarget, expr);
    }
    return false;
}

/** Whether `readExpr <op> (target = value)` can become `target <op>= value`: the same side-effect-free
 *  target, and an object binding the read cannot reassign. */
export function canCompressToLogicalAssignment(ctx: DceCtx, assignmentTarget: Node, readExpr: Node): boolean {
    return (
        hasNoSideEffectForEvaluationSameTarget(ctx, assignmentTarget, readExpr) &&
        !memberObjectMayBeMutated(ctx, assignmentTarget)
    );
}

const toAssignmentOperator = (operator: string): string => `${operator}=`;

/** `a || (a = b)` => `a ||= b`, and `a || (foo, bar, a = b)` => `a ||= (foo, bar, b)`. */
function tryCompressLogicalExpressionToAssignmentExpression(ctx: DceCtx, expr: Node): void {
    if (!supportsFeature(ctx, 'ES2021LogicalAssignmentOperators')) return;
    if (expr.type !== N.LogicalExpression) return;
    const right = expr.data.right as Node;
    if (right.type === N.SequenceExpression) {
        const expressions = right.data.expressions as Node[];
        const assignment = expressions[expressions.length - 1];
        if (assignment === undefined || assignment.type !== N.AssignmentExpression) return;
        if (assignment.data.operator !== '=') return;
        if (!canCompressToLogicalAssignment(ctx, assignment.data.left, expr.data.left)) return;

        expressions.pop();
        markAssignmentTargetAsRead(ctx, assignment.data.left);

        expressions.push(takeNode(ctx, assignment.data.right));
        const newExpr = node(N.AssignmentExpression, expr.start, expr.end, '', {
            operator: toAssignmentOperator(expr.data.operator),
            left: takeNode(ctx, assignment.data.left),
            right: takeNode(ctx, right),
        });
        replaceExpression(ctx, expr, newExpr);
        return;
    }

    if (right.type !== N.AssignmentExpression || right.data.operator !== '=') return;
    const newOperator = toAssignmentOperator(expr.data.operator);
    if (!canCompressToLogicalAssignment(ctx, right.data.left, expr.data.left)) return;

    markAssignmentTargetAsRead(ctx, right.data.left);

    right.start = expr.start;
    right.end = expr.end;
    right.data.operator = newOperator;
    replaceExpression(ctx, expr, takeNode(ctx, right));
}

/** Add `Read` to an identifier target of an assignment that now reads it. A member target's base
 *  symbol gets a member-write hazard: the formed compound operator reads the property. */
export function markAssignmentTargetAsRead(ctx: DceCtx, assignTarget: Node): void {
    let object: Node;
    switch (assignTarget.type) {
        case N.IdentifierReference:
            getReference(ctx, assignTarget).flags |= ReferenceFlags.Read;
            return;
        case N.StaticMemberExpression:
        case N.ComputedMemberExpression:
        case N.PrivateFieldExpression:
            object = assignTarget.data.object;
            break;
        default:
            return;
    }
    const ident = getInnerExpression(object);
    if (ident.type !== N.IdentifierReference) return;
    const symbolId = getReference(ctx, ident).symbolId;
    if (symbolId !== 0) recordMemberWriteEffect(ctx.state.symbols, symbolId, MemberWriteEffect.Hazard);
}
