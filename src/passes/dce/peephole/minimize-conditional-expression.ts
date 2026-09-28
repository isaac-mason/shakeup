// Port of oxc_minifier/src/peephole/minimize_conditional_expression.rs.

import { evaluateValueInContext, valueType } from '../../../analysis/const-eval.ts';
import type { ConstantValue } from '../../../analysis/constant-value.ts';
import { mayHaveSideEffects } from '../../../analysis/side-effects.ts';
import { type DataOf, N, type Node, node } from '../../../ast/index.ts';
import {
    contentEq,
    type DceCtx,
    exprEq,
    isExpressionUndefined,
    isGlobalReference,
    replaceExpression,
    type Span,
    supportsFeature,
    takeNode,
} from '../traverse-context.ts';
import { computedKeyBlocksReorder, memberPartBlocksReorder } from './index.ts';
import { extractIdOrAssignToId, joinWithLeftAssociativeOp } from './minimize-conditions.ts';
import { minimizeNot } from './minimize-not-expression.ts';
import { preserveIndirectAccess, shouldKeepIndirectAccess } from './remove-dead-code.ts';

// oxc_syntax `Precedence`, the rungs these folds compare.
const PRECEDENCE_YIELD = 3;
const PRECEDENCE_ASSIGN = 4;
const PRECEDENCE_CONDITIONAL = 5;

const conditional = (span: Span, test: Node, consequent: Node, alternate: Node): Node =>
    node(N.ConditionalExpression, span.start, span.end, '', { test, consequent, alternate });

const logical = (span: Span, left: Node, operator: string, right: Node): Node =>
    node(N.LogicalExpression, span.start, span.end, '', { operator, left, right });

const sequence = (span: Span, expressions: Node[]): Node => node(N.SequenceExpression, span.start, span.end, '', { expressions });

const unaryPlus = (span: Span, argument: Node): Node =>
    node(N.UnaryExpression, span.start, span.end, '', { operator: '+', prefix: true, argument });

const isSpecificId = (expr: Node, name: string): boolean => expr.type === N.IdentifierReference && expr.name === name;

const isEquality = (operator: string): boolean =>
    operator === '==' || operator === '!=' || operator === '===' || operator === '!==';

const isMemberExpression = (expr: Node): boolean =>
    expr.type === N.StaticMemberExpression || expr.type === N.ComputedMemberExpression || expr.type === N.PrivateFieldExpression;

/** `test ? consequent : alternate`, simplified. The operands are detached nodes. */
export function minimizeConditional(ctx: DceCtx, span: Span, test: Node, consequent: Node, alternate: Node): Node {
    // The transient conditional is replaced in place so references left in its untouched slots are
    // marked removed.
    const asExpr = conditional(span, test, consequent, alternate);
    const folded = minimizeConditionalExpression(ctx, asExpr);
    if (folded !== null) replaceExpression(ctx, asExpr, folded);
    return asExpr;
}

/** esbuild's `MangleIfExpr`. Returns the replacement, or null. */
export function minimizeConditionalExpression(ctx: DceCtx, expr: Node): Node | null {
    const data = expr.data as DataOf<'ConditionalExpression'>;
    const test = data.test as Node;
    switch (test.type) {
        // "(a, b) ? c : d" => "a, b ? c : d"
        case N.SequenceExpression: {
            if ((test.data.expressions as Node[]).length <= 1) break;
            const movedSequence = takeNode(ctx, test);
            const expressions = (movedSequence.data as DataOf<'SequenceExpression'>).expressions;
            const last = expressions.pop() as Node;
            const newConditional = minimizeConditional(
                ctx,
                expr,
                last,
                takeNode(ctx, data.consequent),
                takeNode(ctx, data.alternate),
            );
            expressions.push(newConditional);
            return movedSequence;
        }
        // "!a ? b : c" => "a ? c : b"
        case N.UnaryExpression: {
            if (test.data.operator !== '!') break;
            const newTest = takeNode(ctx, test.data.argument);
            const consequent = takeNode(ctx, data.alternate);
            const alternate = takeNode(ctx, data.consequent);
            return minimizeConditional(ctx, expr, newTest, consequent, alternate);
        }
        case N.IdentifierReference: {
            // "a ? a : b" => "a || b"
            if (data.consequent.type === N.IdentifierReference && test.name === data.consequent.name) {
                return joinWithLeftAssociativeOp(ctx, expr, '||', takeNode(ctx, data.test), takeNode(ctx, data.alternate));
            }
            // "a ? b : a" => "a && b"
            if (data.alternate.type === N.IdentifierReference && test.name === data.alternate.name) {
                return joinWithLeftAssociativeOp(ctx, expr, '&&', takeNode(ctx, data.test), takeNode(ctx, data.consequent));
            }
            break;
        }
        // `x != y ? b : c` -> `x == y ? c : b`
        case N.BinaryExpression: {
            const operator = test.data.operator as string;
            if (operator === '!=' || operator === '!==') {
                test.data.operator = operator === '!=' ? '==' : '===';
                const newTest = takeNode(ctx, data.test);
                const consequent = takeNode(ctx, data.consequent);
                const alternate = takeNode(ctx, data.alternate);
                return minimizeConditional(ctx, expr, newTest, alternate, consequent);
            }
            break;
        }
    }

    // "a ? b ? c : d : d" => "a && b ? c : d"
    const consequentNode = data.consequent as Node;
    if (consequentNode.type === N.ConditionalExpression && exprEq(ctx, consequentNode.data.alternate, data.alternate)) {
        return conditional(
            expr,
            joinWithLeftAssociativeOp(ctx, data.test, '&&', takeNode(ctx, data.test), takeNode(ctx, consequentNode.data.test)),
            takeNode(ctx, consequentNode.data.consequent),
            takeNode(ctx, consequentNode.data.alternate),
        );
    }

    // "a ? b : c ? b : d" => "a || c ? b : d"
    const alternateNode = data.alternate as Node;
    if (alternateNode.type === N.ConditionalExpression && exprEq(ctx, alternateNode.data.consequent, data.consequent)) {
        return conditional(
            expr,
            joinWithLeftAssociativeOp(ctx, data.test, '||', takeNode(ctx, data.test), takeNode(ctx, alternateNode.data.test)),
            takeNode(ctx, data.consequent),
            takeNode(ctx, alternateNode.data.alternate),
        );
    }

    // "a ? c : (b, c)" => "(a || b), c"
    if (alternateNode.type === N.SequenceExpression) {
        const expressions = alternateNode.data.expressions as Node[];
        if (expressions.length === 2 && exprEq(ctx, expressions[1], data.consequent)) {
            return sequence(expr, [
                joinWithLeftAssociativeOp(ctx, data.test, '||', takeNode(ctx, data.test), takeNode(ctx, expressions[0])),
                takeNode(ctx, data.consequent),
            ]);
        }
    }

    // "a ? (b, c) : c" => "(a && b), c"
    if (consequentNode.type === N.SequenceExpression) {
        const expressions = consequentNode.data.expressions as Node[];
        if (expressions.length === 2 && exprEq(ctx, expressions[1], data.alternate)) {
            return sequence(expr, [
                joinWithLeftAssociativeOp(ctx, data.test, '&&', takeNode(ctx, data.test), takeNode(ctx, expressions[0])),
                takeNode(ctx, data.alternate),
            ]);
        }
    }

    // "a ? b || c : c" => "(a && b) || c"
    if (
        consequentNode.type === N.LogicalExpression &&
        consequentNode.data.operator === '||' &&
        exprEq(ctx, consequentNode.data.right, data.alternate)
    ) {
        return logical(
            expr,
            joinWithLeftAssociativeOp(ctx, data.test, '&&', takeNode(ctx, data.test), takeNode(ctx, consequentNode.data.left)),
            '||',
            takeNode(ctx, data.alternate),
        );
    }

    // "a ? c : b && c" => "(a || b) && c"
    if (
        alternateNode.type === N.LogicalExpression &&
        alternateNode.data.operator === '&&' &&
        exprEq(ctx, alternateNode.data.right, data.consequent)
    ) {
        return logical(
            expr,
            joinWithLeftAssociativeOp(ctx, data.test, '||', takeNode(ctx, data.test), takeNode(ctx, alternateNode.data.left)),
            '&&',
            takeNode(ctx, data.consequent),
        );
    }

    // `a ? b(c, d) : b(e, d)` -> `b(a ? c : e, d)`
    if (consequentNode.type === N.CallExpression && alternateNode.type === N.CallExpression) {
        const consequentArgs = consequentNode.data.arguments as Node[];
        const alternateArgs = alternateNode.data.arguments as Node[];
        // `a ? b() : b()` is handled later
        if (
            consequentArgs.length !== 0 &&
            consequentArgs.length === alternateArgs.length &&
            !mayHaveSideEffects(data.test, ctx) &&
            !mayHaveSideEffects(consequentNode.data.callee, ctx) &&
            exprEq(ctx, consequentNode.data.callee, alternateNode.data.callee) &&
            consequentArgs.every((argument, index) => index === 0 || contentEq(argument, alternateArgs[index]))
        ) {
            const consequentFirstIsSpread = consequentArgs[0].type === N.SpreadElement;
            const alternateFirstIsSpread = alternateArgs[0].type === N.SpreadElement;
            // `a ? b(...c) : b(...e)` -> `b(...a ? c : e)`
            if (consequentFirstIsSpread && alternateFirstIsSpread) {
                const callee = takeNode(ctx, consequentNode.data.callee);
                const consequentFirstArg = takeNode(ctx, (consequentArgs[0].data as DataOf<'SpreadElement'>).argument);
                const alternateFirstArg = takeNode(ctx, (alternateArgs[0].data as DataOf<'SpreadElement'>).argument);
                const args = consequentArgs.slice();
                consequentArgs.length = 0;
                args[0] = node(N.SpreadElement, expr.start, expr.end, '', {
                    argument: conditional(data.test, takeNode(ctx, data.test), consequentFirstArg, alternateFirstArg),
                });
                return newCall(expr, callee, args);
            }
            // `a ? b(c) : b(e)` -> `b(a ? c : e)`
            if (!consequentFirstIsSpread && !alternateFirstIsSpread) {
                const callee = takeNode(ctx, consequentNode.data.callee);
                const consequentFirstArg = takeNode(ctx, consequentArgs[0]);
                const alternateFirstArg = takeNode(ctx, alternateArgs[0]);
                const args = consequentArgs.slice();
                consequentArgs.length = 0;
                args[0] = minimizeConditional(ctx, data.test, takeNode(ctx, data.test), consequentFirstArg, alternateFirstArg);
                return newCall(expr, callee, args);
            }
        }
    }

    // Not part of esbuild
    const merged = tryMergeConditionalExpressionInside(ctx, expr);
    if (merged !== null) return merged;

    // Try using the "??" or "?." operators
    const testNode = data.test as Node;
    if (
        (supportsFeature(ctx, 'ES2020NullishCoalescingOperator') || supportsFeature(ctx, 'ES2020OptionalChaining')) &&
        testNode.type === N.BinaryExpression &&
        (testNode.data.operator === '!=' || testNode.data.operator === '==')
    ) {
        const isNegate = testNode.data.operator === '!=';
        // a == null / a != null / (a = foo) == null / (a = foo) != null
        let valueExpr: Node | null = null;
        let targetIdName = '';
        if (testNode.data.left.type === N.NullLiteral) {
            const id = extractIdOrAssignToId(testNode.data.right);
            if (id !== null && !isGlobalReference(ctx, id)) {
                targetIdName = id.name;
                valueExpr = testNode.data.right;
            }
        } else if (testNode.data.right.type === N.NullLiteral) {
            const id = extractIdOrAssignToId(testNode.data.left);
            if (id !== null && !isGlobalReference(ctx, id)) {
                targetIdName = id.name;
                valueExpr = testNode.data.left;
            }
        }
        if (valueExpr !== null) {
            if (supportsFeature(ctx, 'ES2020NullishCoalescingOperator')) {
                // `a == null ? b : a` -> `a ?? b`
                // `a != null ? a : b` -> `a ?? b`
                // `(a = foo) == null ? b : a` -> `(a = foo) ?? b`
                // `(a = foo) != null ? a : b` -> `(a = foo) ?? b`
                const maybeSameIdExpr = isNegate ? data.consequent : data.alternate;
                if (isSpecificId(maybeSameIdExpr, targetIdName)) {
                    return logical(
                        expr,
                        takeNode(ctx, valueExpr),
                        '??',
                        isNegate ? takeNode(ctx, data.alternate) : takeNode(ctx, data.consequent),
                    );
                }
            }
            if (supportsFeature(ctx, 'ES2020OptionalChaining')) {
                // "a == null ? undefined : a.b.c[d](e)" => "a?.b.c[d](e)"
                // "a != null ? a.b.c[d](e) : undefined" => "a?.b.c[d](e)"
                // "(a = foo) == null ? undefined : a.b.c[d](e)" => "(a = foo)?.b.c[d](e)"
                // "(a = foo) != null ? a.b.c[d](e) : undefined" => "(a = foo)?.b.c[d](e)"
                const maybeUndefinedExpr = isNegate ? data.alternate : data.consequent;
                if (isExpressionUndefined(ctx, maybeUndefinedExpr)) {
                    const exprToInjectOptionalChaining = isNegate ? data.consequent : data.alternate;
                    if (injectOptionalChainingIfMatched(ctx, targetIdName, valueExpr, exprToInjectOptionalChaining)) {
                        return takeNode(ctx, exprToInjectOptionalChaining);
                    }
                }
            }
        }
    }

    const consequentValue = evaluateValueInContext(data.consequent, ctx);
    const alternateValue = evaluateValueInContext(data.alternate, ctx);

    // "a ? true : false" => "!!a"
    // "a ? false : true" => "!a"
    const consequentBoolean = sideFreeBoolean(ctx, consequentValue, data.consequent);
    const alternateBoolean = sideFreeBoolean(ctx, alternateValue, data.alternate);
    if (consequentBoolean === true && alternateBoolean === false) {
        let newTest = takeNode(ctx, data.test);
        newTest = minimizeNot(ctx, expr, newTest);
        newTest = minimizeNot(ctx, expr, newTest);
        return newTest;
    }
    if (consequentBoolean === false && alternateBoolean === true) {
        return minimizeNot(ctx, expr, takeNode(ctx, data.test));
    }
    // "c ? false : x" => "!c && x" (exact for any `c`)
    if (
        consequentBoolean === false &&
        alternateBoolean === null &&
        canFoldNegatedTest(data.test) &&
        !logicalOperandAddsParens(data.alternate, '&&', PRECEDENCE_YIELD)
    ) {
        const newTest = minimizeNot(ctx, expr, takeNode(ctx, data.test));
        const right = takeNode(ctx, data.alternate);
        return joinWithLeftAssociativeOp(ctx, expr, '&&', newTest, right);
    }
    // "c ? x : true" => "!c || x" (exact for any `c`)
    if (
        consequentBoolean === null &&
        alternateBoolean === true &&
        canFoldNegatedTest(data.test) &&
        !logicalOperandAddsParens(data.consequent, '||', PRECEDENCE_YIELD)
    ) {
        const newTest = minimizeNot(ctx, expr, takeNode(ctx, data.test));
        const right = takeNode(ctx, data.consequent);
        return joinWithLeftAssociativeOp(ctx, expr, '||', newTest, right);
    }
    // "c ? true : x" => "c || x", only when `c` is boolean: a non-boolean truthy `c` would be returned
    // instead of `true`
    if (
        consequentBoolean === true &&
        alternateBoolean === null &&
        valueType(data.test, ctx) === 'boolean' &&
        !logicalOperandAddsParens(data.test, '||', PRECEDENCE_CONDITIONAL) &&
        !logicalOperandAddsParens(data.alternate, '||', PRECEDENCE_YIELD)
    ) {
        const newTest = takeNode(ctx, data.test);
        const right = takeNode(ctx, data.alternate);
        return joinWithLeftAssociativeOp(ctx, expr, '||', newTest, right);
    }
    // "c ? x : false" => "c && x", only when `c` is boolean: a non-boolean falsy `c` would be returned
    // instead of `false`
    if (
        consequentBoolean === null &&
        alternateBoolean === false &&
        valueType(data.test, ctx) === 'boolean' &&
        !logicalOperandAddsParens(data.test, '&&', PRECEDENCE_CONDITIONAL) &&
        !logicalOperandAddsParens(data.consequent, '&&', PRECEDENCE_YIELD)
    ) {
        const newTest = takeNode(ctx, data.test);
        const right = takeNode(ctx, data.consequent);
        return joinWithLeftAssociativeOp(ctx, expr, '&&', newTest, right);
    }

    // "a ? 1 : 0" => "+a" (if a is boolean) or "+!!a" (if no parens needed)
    // "a ? 0 : 1" => "+!a" (if no parens needed)
    const consequentNumber = sideFreeNumber(ctx, consequentValue, data.consequent);
    const alternateNumber = sideFreeNumber(ctx, alternateValue, data.alternate);
    // The `0` must be `+0`: `a ? 1 : -0` would become `+a`, which yields `+0` when the test is falsy.
    if (consequentNumber === 1 && alternateNumber === 0 && !Object.is(alternateNumber, -0)) {
        const isBoolean = valueType(data.test, ctx) === 'boolean';
        const needsParens = testNeedsParens(data.test);
        if (isBoolean) {
            // Known boolean: +a (saves 3 chars: "a?1:0" => "+a")
            return unaryPlus(expr, takeNode(ctx, data.test));
        }
        // Unknown type: +!!a (saves 1 char), unless parens would be needed ("a+b?1:0" => "+!!(a+b)")
        if (!needsParens) {
            let newTest = takeNode(ctx, data.test);
            newTest = minimizeNot(ctx, expr, newTest);
            newTest = minimizeNot(ctx, expr, newTest);
            return unaryPlus(expr, newTest);
        }
    } else if (
        consequentNumber === 0 &&
        alternateNumber === 1 &&
        // "a ? 0 : 1" => "+!a", skipped when parens would be needed. `a ? -0 : 1` must keep its `-0`.
        !Object.is(consequentNumber, -0) &&
        !testNeedsParens(data.test)
    ) {
        return unaryPlus(expr, minimizeNot(ctx, expr, takeNode(ctx, data.test)));
    }

    if (exprEq(ctx, data.alternate, data.consequent)) {
        // "/* @__PURE__ */ a() ? b : b" => "b"
        if (!mayHaveSideEffects(data.test, ctx)) {
            const resultExpr = takeNode(ctx, data.consequent);
            // "(a ? eval : eval)(x)" => "(0, eval)(x)": the bare branch would form a direct eval call or
            // rebind a member call's `this`.
            if (shouldKeepIndirectAccess(ctx, resultExpr)) return preserveIndirectAccess(expr, resultExpr);
            return resultExpr;
        }
        // "a ? b : b" => "a, b"
        return sequence(expr, [takeNode(ctx, data.test), takeNode(ctx, data.consequent)]);
    }

    return null;
}

/** The branch's boolean constant, when it has no side effects. */
function sideFreeBoolean(ctx: DceCtx, value: ConstantValue | null, branch: Node): boolean | null {
    if (value === null || value.kind !== 'boolean' || mayHaveSideEffects(branch, ctx)) return null;
    return value.value;
}

/** The branch's number constant, when it has no side effects. */
function sideFreeNumber(ctx: DceCtx, value: ConstantValue | null, branch: Node): number | null {
    if (value === null || value.kind !== 'number' || mayHaveSideEffects(branch, ctx)) return null;
    return value.value;
}

const newCall = (span: Span, callee: Node, args: Node[]): Node =>
    node(N.CallExpression, span.start, span.end, '', {
        callee,
        arguments: args,
        optional: false,
        pure: false,
        typeArguments: null,
    });

/** Merge the branches' assignments: `x ? a = 0 : a = 1` => `a = x ? 0 : 1`, also for member targets
 *  and compound operators. */
function tryMergeConditionalExpressionInside(ctx: DceCtx, expr: Node): Node | null {
    const data = expr.data as DataOf<'ConditionalExpression'>;
    const consequent = data.consequent as Node;
    const alternate = data.alternate as Node;
    if (consequent.type !== N.AssignmentExpression || alternate.type !== N.AssignmentExpression) return null;

    // Applying this to an anonymous function right-hand side sets its `name`; done even with
    // `keep_names`, as oxc does.
    if (consequent.data.operator !== alternate.data.operator || !contentEq(consequent.data.left, alternate.data.left))
        return null;

    const target = consequent.data.left as Node;
    let isSafe: boolean;
    if (consequent.data.operator === '=') {
        if (target.type === N.IdentifierReference) {
            isSafe = true;
        } else if (isMemberExpression(target)) {
            // The object and computed key now evaluate before `x`: they must not have side effects, hit
            // a TDZ `x` would have resolved, or change value when `x` runs.
            isSafe =
                !memberPartBlocksReorder(ctx, (target.data as DataOf<'StaticMemberExpression'>).object) &&
                (target.type !== N.ComputedMemberExpression || !computedKeyBlocksReorder(ctx, target.data.expression));
        } else {
            isSafe = false;
        }
    } else {
        // Other operators also read the target before `x`, and logical ones skip `x` when the
        // assignment short-circuits, so `x` and the target read must both be side-effect free.
        isSafe =
            !mayHaveSideEffects(data.test, ctx) &&
            (target.type === N.IdentifierReference || isMemberExpression(target)) &&
            !mayHaveSideEffects(target, ctx);
    }
    if (!isSafe) return null;
    const condExpr = minimizeConditional(
        ctx,
        expr,
        takeNode(ctx, data.test),
        takeNode(ctx, consequent.data.right),
        takeNode(ctx, alternate.data.right),
    );
    return node(N.AssignmentExpression, expr.start, expr.end, '', {
        operator: consequent.data.operator,
        left: takeNode(ctx, alternate.data.left),
        right: condExpr,
    });
}

/** For `targetIdName` = `a` and `expr` = `a.b`, rewrite `expr` to `a?.b`, with `exprToInject` as the
 *  new base, and return true. */
export function injectOptionalChainingIfMatched(ctx: DceCtx, targetIdName: string, exprToInject: Node, expr: Node): boolean {
    if (!injectOptionalChainingIfMatchedInner(ctx, targetIdName, exprToInject, expr)) return false;
    if (expr.type !== N.ChainExpression) {
        const element = takeNode(ctx, expr);
        replaceExpression(ctx, expr, node(N.ChainExpression, element.start, element.end, '', { expression: element }));
    }
    return true;
}

/** Make the member or call whose base is `targetIdName` optional, recursing down the base. The
 *  field holding the base is `object` for a member and `callee` for a call. */
function injectIntoBase(ctx: DceCtx, targetIdName: string, exprToInject: Node, owner: Node, base: Node): boolean {
    if (isSpecificId(base, targetIdName)) {
        (owner.data as DataOf<'StaticMemberExpression'> | DataOf<'CallExpression'>).optional = true;
        replaceExpression(ctx, base, takeNode(ctx, exprToInject));
        return true;
    }
    return injectOptionalChainingIfMatchedInner(ctx, targetIdName, exprToInject, base);
}

function injectOptionalChainingIfMatchedInner(ctx: DceCtx, targetIdName: string, exprToInject: Node, expr: Node): boolean {
    switch (expr.type) {
        case N.StaticMemberExpression:
        case N.ComputedMemberExpression:
            return injectIntoBase(ctx, targetIdName, exprToInject, expr, expr.data.object);
        case N.CallExpression:
            return injectIntoBase(ctx, targetIdName, exprToInject, expr, expr.data.callee);
        case N.ChainExpression: {
            const element = expr.data.expression as Node;
            switch (element.type) {
                case N.StaticMemberExpression:
                case N.ComputedMemberExpression:
                    return injectIntoBase(ctx, targetIdName, exprToInject, element, element.data.object);
                case N.CallExpression:
                    return injectIntoBase(ctx, targetIdName, exprToInject, element, element.data.callee);
                default:
                    return false;
            }
        }
        default:
            return false;
    }
}

/** Whether negating `test` adds no parentheses compared with its place as a conditional test.
 *  Equality comparisons invert in place; other accepted tests negate to a bare `!test`. */
function canFoldNegatedTest(test: Node): boolean {
    switch (test.type) {
        case N.BinaryExpression:
            return isEquality(test.data.operator);
        case N.LogicalExpression:
            return false;
        default:
            return true;
    }
}

/** Whether `expr` as an operand of `&&`/`||` adds parentheses compared with its conditional
 *  position. Sequences need parentheses in both places. */
function logicalOperandAddsParens(expr: Node, operator: string, oldParentPrecedence: number): boolean {
    switch (expr.type) {
        case N.AssignmentExpression:
        case N.YieldExpression:
        case N.ArrowFunctionExpression:
            return oldParentPrecedence < PRECEDENCE_ASSIGN;
        case N.ConditionalExpression:
            return oldParentPrecedence < PRECEDENCE_CONDITIONAL;
        // `??` cannot mix with `&&`/`||` unparenthesized, and `||` needs parens under `&&`.
        case N.LogicalExpression:
            return expr.data.operator === '??' || (expr.data.operator === '||' && operator === '&&');
        default:
            return false;
    }
}

/** Whether the expression needs parentheses as a unary operand. */
function testNeedsParens(expr: Node): boolean {
    switch (expr.type) {
        case N.BinaryExpression:
        case N.LogicalExpression:
        case N.ConditionalExpression:
        case N.AssignmentExpression:
        case N.SequenceExpression:
        case N.YieldExpression:
            return true;
        default:
            return false;
    }
}
