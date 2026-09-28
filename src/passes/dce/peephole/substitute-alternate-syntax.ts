// Port of oxc_minifier/src/peephole/substitute_alternate_syntax.rs.

import {
    evaluateValueToString,
    getInnerExpression,
    numericLiteralValue,
    stringLiteralValue,
    templateElementCooked,
    toJsString,
    toNumber,
    utf8Length,
    valueType,
} from '../../../analysis/const-eval.ts';
import { isTypedArrayConstructor, mayHaveSideEffects } from '../../../analysis/side-effects.ts';
import { cloneNode, type DataOf, N, type Node, node } from '../../../ast/index.ts';
import { boundNames } from '../bound-names.ts';
import { isTreeShakeOnly } from '../state.ts';
import {
    isIdentifierNamePatched,
    ReferenceFlags,
    scopeContainsDirectEval,
    scopeIsArrow,
    scopeIsFunction,
    scopeIsStrictMode,
} from '../syntax.ts';
import {
    ancestor,
    ancestorScopes,
    createIdentExpr,
    createReference,
    createUnboundReference,
    createVoidZero,
    currentScopeFlags,
    type DceCtx,
    dropExpression,
    dropVariableDeclarator,
    getReference,
    getResolvedReferences,
    isClosestFunctionScopeAnAsyncGenerator,
    isExpressionUndefined,
    isGlobalReference,
    isIdentifierUndefined,
    noticeChange,
    parent,
    parentKind,
    replaceAssignmentTargetProperty,
    replaceExpression,
    replacePropertyKey,
    replaceStatement,
    type Span,
    scopeFlags,
    stringToEquivalentNumberValue,
    supportsFeature,
    symbolIsUnused,
    symbolRedeclarations,
    takeNode,
    valueToExpr,
} from '../traverse-context.ts';
import { commutativePair, isLiteral } from './index.ts';
import { minimizeExpressionInBooleanContext } from './minimize-expression-in-boolean-context.ts';
import { minimizeNot } from './minimize-not-expression.ts';
import { canRemoveUnusedDeclarators, symbolIsUnusedByCount } from './remove-unused-declaration.ts';
import { foldArgumentsIntoNeededExpressions } from './remove-unused-expression.ts';

// --- oxc AST predicates --------------------------------------------------------------------------

const isNumber0 = (expr: Node): boolean => expr.type === N.NumericLiteral && numericLiteralValue(expr) === 0;

const isVoid0 = (expr: Node): boolean =>
    expr.type === N.UnaryExpression && expr.data.operator === 'void' && isNumber0(expr.data.argument);

const isNoSubstitutionTemplate = (expr: Node): boolean => expr.type === N.TemplateLiteral && expr.data.quasis.length === 1;

const isSpecificStringLiteral = (expr: Node, value: string): boolean =>
    expr.type === N.StringLiteral && stringLiteralValue(expr).value === value;

const isSpecificId = (expr: Node, name: string): boolean => {
    const inner = getInnerExpression(expr);
    return inner.type === N.IdentifierReference && inner.name === name;
};

const isEquality = (operator: string): boolean =>
    operator === '==' || operator === '!=' || operator === '===' || operator === '!==';

/** oxc `MemberExpression::static_property_name`. */
function staticPropertyName(member: Node): string | null {
    switch (member.type) {
        case N.StaticMemberExpression:
            return member.data.property.name;
        case N.ComputedMemberExpression: {
            const expression = member.data.expression as Node;
            if (expression.type === N.StringLiteral) return stringLiteralValue(expression).value;
            if (expression.type === N.TemplateLiteral && expression.data.quasis.length === 1)
                return templateElementCooked(expression.data.quasis[0])?.value ?? null;
            return null;
        }
        default:
            return null;
    }
}

/** oxc `Expression::is_specific_member_access`. */
function isSpecificMemberAccess(expr: Node, object: string, property: string): boolean {
    let inner = getInnerExpression(expr);
    if (inner.type === N.ChainExpression) inner = inner.data.expression;
    if (inner.type !== N.StaticMemberExpression && inner.type !== N.ComputedMemberExpression) return false;
    return isSpecificId(inner.data.object, object) && staticPropertyName(inner) === property;
}

/** oxc `PropertyKey::static_name`. */
function propertyKeyStaticName(key: Node): string | null {
    switch (key.type) {
        case N.IdentifierName:
            return key.name;
        case N.StringLiteral:
            return stringLiteralValue(key).value;
        case N.RegExpLiteral:
            return key.name;
        case N.NumericLiteral:
            return String(numericLiteralValue(key));
        case N.BigIntLiteral:
            return key.name.slice(0, -1);
        case N.NullLiteral:
            return 'null';
        case N.TemplateLiteral:
            return key.data.quasis.length === 1 ? (templateElementCooked(key.data.quasis[0])?.value ?? null) : null;
        default:
            return null;
    }
}

/** oxc `BindingPattern::is_destructuring_pattern`. */
function isDestructuringPattern(pattern: Node): boolean {
    switch (pattern.type) {
        case N.ObjectPattern:
        case N.ArrayPattern:
            return true;
        case N.AssignmentPattern:
            return isDestructuringPattern(pattern.data.left);
        default:
            return false;
    }
}

const numericLiteral = (span: Span, value: number): Node =>
    node(N.NumericLiteral, span.start, span.end, Object.is(value, -0) ? '-0' : String(value), null);

const stringLiteral = (span: Span, value: string): Node =>
    node(N.StringLiteral, span.start, span.end, JSON.stringify(value), null);

// --- substitutions -------------------------------------------------------------------------------

export function substituteObjectProperty(ctx: DceCtx, prop: Node): void {
    const data = prop.data as DataOf<'ObjectProperty'>;
    // "{ __proto__ }" sets prototype, while "{ ['__proto__'] }" does not
    if (!data.method && isSpecificStringLiteral(data.key, '__proto__')) return;

    // Normalise the key first: `{ "x": x }` becomes `{ x: x }`, a shorthand candidate in the same visit.
    tryCompressPropertyKey(ctx, prop);
    normalizeObjectPropertyShorthand(prop);
}

/** `{ x: x }` is `{ x }`. Output text is unchanged, so no change is recorded. */
function normalizeObjectPropertyShorthand(prop: Node): void {
    const data = prop.data as DataOf<'ObjectProperty'>;
    if (data.shorthand) return;
    const value = data.value;
    if (value.type !== N.IdentifierReference) return;
    if (data.computed || data.method || data.kind !== 'init') return;
    const key = data.key;
    if (key.type !== N.IdentifierName) return;
    // `{ __proto__: __proto__ }` sets the prototype, `{ __proto__ }` does not.
    if (key.name === value.name && key.name !== '__proto__') data.shorthand = true;
}

export function substituteAssignmentTargetPropertyProperty(ctx: DceCtx, prop: Node): void {
    tryCompressPropertyKey(ctx, prop);
}

export function substituteAssignmentTargetProperty(ctx: DceCtx, prop: Node): void {
    tryCompressAssignmentTargetProperty(ctx, prop);
}

/** `({ a: a } = o)` -> `({ a } = o)`. */
export function tryCompressAssignmentTargetProperty(ctx: DceCtx, prop: Node): void {
    const data = prop.data as DataOf<'ObjectProperty'>;
    if (data.shorthand) return;
    const propName = propertyKeyStaticName(data.key);
    if (propName === null) return;
    let ident: Node = data.value;
    if (ident.type === N.AssignmentPattern || ident.type === N.AssignmentExpression) ident = ident.data.left;
    if (ident.type !== N.IdentifierReference) return;
    if (propName === ident.name) {
        // oxc builds the shorthand with no initializer, so a default on the binding is dropped.
        const moved = takeNode(ctx, ident);
        const newProp = node(N.ObjectProperty, ident.start, ident.end, '', {
            key: node(N.IdentifierName, ident.start, ident.end, moved.name, null),
            value: moved,
            kind: 'init',
            computed: false,
            shorthand: true,
            method: false,
        });
        replaceAssignmentTargetProperty(ctx, prop, newProp);
    }
}

export function substituteBindingProperty(ctx: DceCtx, prop: Node): void {
    tryCompressPropertyKey(ctx, prop);
}

type ClassPropertyKeyParentType = 'PropertyDefinition' | 'AccessorProperty' | 'MethodDefinition';

/** Whether the key should stay computed to avoid an early error. */
function shouldKeepAsComputedProperty(type: ClassPropertyKeyParentType, isStatic: boolean, key: string): boolean {
    switch (key) {
        case 'prototype':
            return isStatic;
        case 'constructor':
            // A constructor may not be an accessor, a field or a private method.
            return type === 'MethodDefinition' ? !isStatic : true;
        case '#constructor':
            return true;
        default:
            return false;
    }
}

function substituteClassElement(ctx: DceCtx, element: Node, type: ClassPropertyKeyParentType): void {
    const data = element.data as { key: Node; computed: boolean; static: boolean };
    if (
        data.computed &&
        data.key.type === N.StringLiteral &&
        shouldKeepAsComputedProperty(type, data.static, stringLiteralValue(data.key).value)
    )
        return;
    tryCompressPropertyKey(ctx, element);
}

export function substituteMethodDefinition(ctx: DceCtx, prop: Node): void {
    substituteClassElement(ctx, prop, 'MethodDefinition');
}

export function substitutePropertyDefinition(ctx: DceCtx, prop: Node): void {
    substituteClassElement(ctx, prop, 'PropertyDefinition');
}

export function substituteAccessorProperty(ctx: DceCtx, prop: Node): void {
    substituteClassElement(ctx, prop, 'AccessorProperty');
}

export function substituteForStatement(ctx: DceCtx, statement: Node): void {
    tryRewriteArgumentsCopyLoop(ctx, statement);
}

export function substituteVariableDeclaration(ctx: DceCtx, declaration: Node): void {
    const data = declaration.data as DataOf<'VariableDeclaration'>;
    for (const declarator of data.declarations) compressVariableDeclarator(ctx, declarator, data.kind);
}

export function substituteCallExpression(ctx: DceCtx, call: Node): void {
    tryFlattenArguments(ctx, (call.data as DataOf<'CallExpression'>).arguments);
    tryRewriteObjectCalleeIndirectCall(ctx, call);
}

export function substituteNewExpression(ctx: DceCtx, newExpr: Node): void {
    tryFlattenArguments(ctx, (newExpr.data as DataOf<'NewExpression'>).arguments);
}

export function substituteChainExpression(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.ChainExpression) return;
    tryFlattenNestedChainExpression(ctx, expr);
    substituteChainCallExpression(ctx, expr);
}

export function substituteSwapBinaryExpressions(binary: Node): void {
    const data = binary.data as DataOf<'BinaryExpression'>;
    if (
        isEquality(data.operator) &&
        (isLiteral(data.left) || isNoSubstitutionTemplate(data.left) || isVoid0(data.left)) &&
        !isLiteral(data.right)
    ) {
        const left = data.left;
        data.left = data.right;
        data.right = left;
    }
}

/** `() => { return foo }` -> `() => foo` */
export function substituteArrowExpression(_ctx: DceCtx, arrow: Node): void {
    const data = arrow.data as DataOf<'ArrowFunctionExpression'>;
    const body = data.body;
    if (body.type !== N.BlockStatement) return;
    const statements = body.data.body as Node[];
    if (statements.length !== 1) return;
    const returnStatement = statements[0];
    if (returnStatement.type !== N.ReturnStatement || returnStatement.data.argument === null) return;
    data.body = returnStatement.data.argument;
    data.expression = true;
}

/** Compress `typeof foo == "undefined"`:
 *  - `typeof foo == "undefined"` (foo unresolved) -> `typeof foo > "u"`
 *  - `typeof foo != "undefined"` (foo unresolved) -> `typeof foo < "u"`
 *  - `typeof foo == "undefined"` -> `foo === undefined`, and `!=` -> `!==`, for any other operand */
export function substituteTypeofUndefined(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.BinaryExpression) return;
    const left = expr.data.left as Node;
    if (left.type !== N.UnaryExpression || left.data.operator !== 'typeof') return;
    let newEqOp: string;
    let newCompOp: string;
    switch (expr.data.operator) {
        case '==':
        case '===':
            newEqOp = '===';
            newCompOp = '>';
            break;
        case '!=':
        case '!==':
            newEqOp = '!==';
            newCompOp = '<';
            break;
        default:
            return;
    }
    const right = expr.data.right as Node;
    if (!isSpecificStringLiteral(right, 'undefined')) return;
    let newValue: Node;
    const argument = left.data.argument as Node;
    if (argument.type === N.IdentifierReference && isGlobalReference(ctx, argument)) {
        newValue = node(N.BinaryExpression, expr.start, expr.end, '', {
            operator: newCompOp,
            left: takeNode(ctx, left),
            right: stringLiteral(right, 'u'),
        });
    } else {
        newValue = node(N.BinaryExpression, expr.start, expr.end, '', {
            operator: newEqOp,
            left: takeNode(ctx, argument),
            right: createVoidZero(right),
        });
    }
    replaceExpression(ctx, expr, newValue);
}

/** Remove unary `+` where the parent operator already does `ToNumber`:
 *  `1 - +b` => `1 - b`, `+a - 1` => `a - 1` */
export function substituteUnaryPlus(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.UnaryExpression || expr.data.operator !== '+') return;
    const parentAncestor = parent(ctx);
    let parentDoesToNumberConversion = false;
    if (parentAncestor.kind === 'BinaryExpressionLeft') {
        const binary = parentAncestor.node.data as DataOf<'BinaryExpression'>;
        parentDoesToNumberConversion =
            isBinaryOperatorThatDoesNumberConversion(binary.operator) && valueType(binary.right, ctx) === 'number';
    } else if (parentAncestor.kind === 'BinaryExpressionRight') {
        const binary = parentAncestor.node.data as DataOf<'BinaryExpression'>;
        parentDoesToNumberConversion =
            isBinaryOperatorThatDoesNumberConversion(binary.operator) && valueType(binary.left, ctx) === 'number';
    }
    if (!parentDoesToNumberConversion) return;
    replaceExpression(ctx, expr, takeNode(ctx, expr.data.argument));
}

/** For `+a - n` with `n` a number, `ToNumber(a)` and `ToNumeric(a)` differ only where the binary
 *  operation throws anyway (a BigInt), so dropping the `+` is safe. */
function isBinaryOperatorThatDoesNumberConversion(operator: string): boolean {
    switch (operator) {
        case '**':
        case '*':
        case '/':
        case '%':
        case '-':
        case '<<':
        case '>>':
        case '>>>':
        case '&':
        case '^':
        case '|':
            return true;
        default:
            return false;
    }
}

/** `a || (b || c);` -> `(a || b) || c;` */
export function substituteRotateLogicalExpression(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.LogicalExpression) return;
    const right = expr.data.right as Node;
    if (right.type !== N.LogicalExpression || right.data.operator !== expr.data.operator) return;
    const operator = expr.data.operator as string;
    const takenRight = takeNode(ctx, right).data as DataOf<'LogicalExpression'>;
    const newLeft = node(N.LogicalExpression, expr.start, expr.end, '', {
        operator,
        left: takeNode(ctx, expr.data.left),
        right: takeNode(ctx, takenRight.left),
    });
    substituteRotateLogicalExpression(ctx, newLeft);
    const newValue = node(N.LogicalExpression, expr.start, expr.end, '', {
        operator,
        left: newLeft,
        right: takeNode(ctx, takenRight.right),
    });
    replaceExpression(ctx, expr, newValue);
}

/** oxc `BinaryOperator::precedence`. */
function binaryPrecedence(operator: string): number {
    switch (operator) {
        case '??':
            return 3;
        case '||':
            return 4;
        case '&&':
            return 5;
        case '|':
            return 6;
        case '^':
            return 7;
        case '&':
            return 8;
        case '==':
        case '!=':
        case '===':
        case '!==':
            return 9;
        case '<':
        case '>':
        case '<=':
        case '>=':
        case 'instanceof':
        case 'in':
            return 10;
        case '<<':
        case '>>':
        case '>>>':
            return 11;
        case '+':
        case '-':
            return 12;
        case '*':
        case '/':
        case '%':
            return 13;
        case '**':
            return 14;
        default:
            return 0;
    }
}

/** Rotate associative operators, `a | (b | c)` -> `(a | b) | c`, and commutative ones to drop
 *  parentheses, `a * (b % c)` -> `b % c * a`. */
export function substituteRotateBinaryExpression(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.BinaryExpression) return;
    const data = expr.data as DataOf<'BinaryExpression'>;
    const operator = data.operator;

    const isAssociative = operator === '|' || operator === '&' || operator === '^';
    const right = data.right;
    if (
        isAssociative &&
        right.type === N.BinaryExpression &&
        right.data.operator === operator &&
        !mayHaveSideEffects(right.data.right, ctx)
    ) {
        const takenRight = takeNode(ctx, right).data as DataOf<'BinaryExpression'>;
        const newLeft = node(N.BinaryExpression, expr.start, expr.end, '', {
            operator,
            left: takeNode(ctx, data.left),
            right: takeNode(ctx, takenRight.left),
        });
        substituteRotateBinaryExpression(ctx, newLeft);
        const newValue = node(N.BinaryExpression, expr.start, expr.end, '', {
            operator,
            left: newLeft,
            right: takeNode(ctx, takenRight.right),
        });
        replaceExpression(ctx, expr, newValue);
        return;
    }

    if (
        right.type === N.BinaryExpression &&
        operator === '*' &&
        binaryPrecedence(operator) === binaryPrecedence(right.data.operator)
    ) {
        // Don't swap if left does not need parentheses
        const left = data.left;
        if (left.type === N.BinaryExpression && binaryPrecedence(operator) <= binaryPrecedence(left.data.operator)) return;

        // Don't swap if any value may have side effects, as they may update the other values
        if (
            !mayHaveSideEffects(left, ctx) &&
            !mayHaveSideEffects(right.data.left, ctx) &&
            !mayHaveSideEffects(right.data.right, ctx)
        ) {
            data.left = right;
            data.right = left;
            noticeChange(ctx);
        }
    }
}

/** `typeof foo === 'object' && foo !== null` => `typeof foo == 'object' && !!foo`, and the inverse
 *  `typeof foo !== 'object' || foo === null` => `typeof foo != 'object' || !foo`. Safe for
 *  `document.all`, whose `typeof` is not `'object'`. */
export function substituteIsObjectAndNotNull(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.LogicalExpression) return;
    let inversed: boolean;
    switch (expr.data.operator) {
        case '&&':
            inversed = false;
            break;
        case '||':
            inversed = true;
            break;
        default:
            return;
    }
    const direct = tryCompressIsObjectAndNotNullForLeftAndRight(ctx, expr.data.left, expr.data.right, expr, inversed);
    if (direct !== null) {
        replaceExpression(ctx, expr, direct);
        return;
    }
    const left = expr.data.left as Node;
    if (left.type !== N.LogicalExpression || left.data.operator !== expr.data.operator) return;
    const span = { start: left.data.right.start, end: expr.data.right.end };
    const newExpr = tryCompressIsObjectAndNotNullForLeftAndRight(ctx, left.data.right, expr.data.right, span, inversed);
    if (newExpr === null) return;
    const newValue = node(N.LogicalExpression, expr.start, expr.end, '', {
        operator: expr.data.operator,
        left: takeNode(ctx, left.data.left),
        right: newExpr,
    });
    replaceExpression(ctx, expr, newValue);
}

function tryCompressIsObjectAndNotNullForLeftAndRight(
    ctx: DceCtx,
    left: Node,
    right: Node,
    span: Span,
    inversed: boolean,
): Node | null {
    const pair = commutativePair<[Node, Node], Node>(
        left,
        right,
        (aExpr) => {
            if (aExpr.type !== N.BinaryExpression) return null;
            const operator = aExpr.data.operator as string;
            const isTargetOps = inversed ? operator === '!==' || operator === '!=' : operator === '===' || operator === '==';
            if (!isTargetOps) return null;
            const inner = commutativePair<Node, true>(
                aExpr.data.left,
                aExpr.data.right,
                (candidate) => {
                    if (candidate.type !== N.UnaryExpression || candidate.data.operator !== 'typeof') return null;
                    const argument = candidate.data.argument as Node;
                    return argument.type === N.IdentifierReference ? argument : null;
                },
                (candidate) => (isSpecificStringLiteral(candidate, 'object') ? true : null),
            );
            if (inner === null) return null;
            return [inner[0], aExpr];
        },
        (bExpr) => {
            if (bExpr.type !== N.BinaryExpression) return null;
            const operator = bExpr.data.operator as string;
            const isTargetOps = inversed ? operator === '===' || operator === '==' : operator === '!==' || operator === '!=';
            if (!isTargetOps) return null;
            const inner = commutativePair<Node, true>(
                bExpr.data.left,
                bExpr.data.right,
                (candidate) => (candidate.type === N.IdentifierReference ? candidate : null),
                (candidate) => (candidate.type === N.NullLiteral ? true : null),
            );
            return inner === null ? null : inner[0];
        },
    );
    if (pair === null) return null;
    const [[typeofIdRef, typeofBinaryExpr], isNullIdRef] = pair;
    if (typeofIdRef.name !== isNullIdRef.name) return null;
    if (isGlobalReference(ctx, typeofIdRef)) return null;

    // The replacement must not reuse references from the dropped subtree: mint fresh ones.
    const typeofSymbolId = getReference(ctx, typeofIdRef).symbolId;
    const isNullSymbolId = getReference(ctx, isNullIdRef).symbolId;

    // `cloneNode` leaves every identifier without a reference.
    const newLeftExpr = cloneNode(typeofBinaryExpr) as Node;
    if (newLeftExpr.type !== N.BinaryExpression) throw new Error('dce: the typeof comparison is not a binary expression');
    newLeftExpr.data.operator = inversed ? '!=' : '==';
    for (const operand of [newLeftExpr.data.left, newLeftExpr.data.right] as Node[]) {
        if (operand.type === N.UnaryExpression && operand.data.operator === 'typeof') {
            const id = operand.data.argument as Node;
            if (id.type === N.IdentifierReference) createReference(ctx, id, typeofSymbolId, ReferenceFlags.Read);
        }
    }

    const isNullId = createIdentExpr(ctx, isNullIdRef, isNullIdRef.name, isNullSymbolId, ReferenceFlags.Read);
    const not = (argument: Node): Node => node(N.UnaryExpression, 0, 0, '', { operator: '!', prefix: true, argument });
    const newRightExpr = inversed ? not(isNullId) : not(not(isNullId));
    return node(N.LogicalExpression, span.start, span.end, '', {
        operator: inversed ? '||' : '&&',
        left: newLeftExpr,
        right: newRightExpr,
    });
}

/** `foo == void 0` -> `foo == null`, `foo != undefined` -> `foo != null` */
export function substituteLooseEqualsUndefined(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.BinaryExpression) return;
    const operator = expr.data.operator as string;
    if (operator !== '!=' && operator !== '==') return;
    let left: Node;
    let right: Node;
    if (isExpressionUndefined(ctx, expr.data.right)) {
        left = takeNode(ctx, expr.data.left);
        right = node(N.NullLiteral, expr.data.right.start, expr.data.right.end, 'null', null);
    } else if (isExpressionUndefined(ctx, expr.data.left)) {
        left = takeNode(ctx, expr.data.right);
        right = node(N.NullLiteral, expr.data.left.start, expr.data.left.end, 'null', null);
    } else {
        return;
    }
    replaceExpression(ctx, expr, node(N.BinaryExpression, expr.start, expr.end, '', { operator, left, right }));
}

type VerifyArrayArgResult = 'with-offset' | 'without-offset' | 'invalid';

/** Whether `argExpr` is `e > offset ? e - offset : 0` or `e`. */
function verifyArrayArg(argExpr: Node, nameE: string, offset: number): VerifyArrayArgResult {
    switch (argExpr.type) {
        case N.IdentifierReference:
            return offset === 0 && argExpr.name === nameE ? 'without-offset' : 'invalid';
        case N.ConditionalExpression: {
            const test = argExpr.data.test as Node;
            const consequent = argExpr.data.consequent as Node;
            const alternate = argExpr.data.alternate as Node;
            if (test.type !== N.BinaryExpression || consequent.type !== N.BinaryExpression) return 'invalid';
            const isNumber = (expr: Node, value: number): boolean =>
                expr.type === N.NumericLiteral && numericLiteralValue(expr) === value;
            if (
                test.data.operator === '>' &&
                isSpecificId(test.data.left, nameE) &&
                isNumber(test.data.right, offset) &&
                consequent.data.operator === '-' &&
                consequent.data.left.type === N.IdentifierReference &&
                consequent.data.left.name === nameE &&
                isNumber(consequent.data.right, offset) &&
                isNumber(alternate, 0)
            )
                return 'with-offset';
            return 'invalid';
        }
        default:
            return 'invalid';
    }
}

const isGlobalArgumentsLength = (ctx: DceCtx, expr: Node): boolean => {
    if (expr.type !== N.StaticMemberExpression) return false;
    const object = expr.data.object as Node;
    return (
        object.type === N.IdentifierReference &&
        object.name === 'arguments' &&
        isGlobalReference(ctx, object) &&
        expr.data.property.name === 'length'
    );
};

/** Rewrite the Babel/TS `arguments` copy loop
 *  `for (var e = arguments.length, r = Array(e), a = 0; a < e; a++) r[a] = arguments[a];`
 *  into `for (var r = [...arguments]; 0; ) ;`, which later folds to `var r = [...arguments]`. Also
 *  handles an offset (`r[a - 1] = arguments[a]` into `[...arguments].slice(1)`) and the
 *  `a < arguments.length` form without `e`. */
function tryRewriteArgumentsCopyLoop(ctx: DceCtx, forStatement: Node): void {
    // In non-strict mode, a different value may be reassigned to the `arguments` variable
    if (!scopeIsStrictMode(currentScopeFlags(ctx))) return;
    const forData = forStatement.data as DataOf<'ForStatement'>;

    // Parse statement: `r[a - offset] = arguments[a];`
    let assignStatement: Node;
    const body = forData.body;
    if (body.type === N.ExpressionStatement) assignStatement = body;
    else if (body.type === N.BlockStatement && body.data.body.length === 1 && body.data.body[0].type === N.ExpressionStatement)
        assignStatement = body.data.body[0];
    else return;
    const bodyAssignExpr = (assignStatement.data as DataOf<'ExpressionStatement'>).expression;
    if (bodyAssignExpr.type !== N.AssignmentExpression || bodyAssignExpr.data.operator !== '=') return;

    // reference counts in the for-loop
    let aRefCount = 0;
    let eRefCount = 0;

    const lhsMemberExpr = bodyAssignExpr.data.left as Node;
    if (lhsMemberExpr.type !== N.ComputedMemberExpression) return;
    const lhsMemberExprObj = lhsMemberExpr.data.object as Node;
    if (lhsMemberExprObj.type !== N.IdentifierReference) return;
    let baseName: string;
    let offset: number;
    const lhsKey = lhsMemberExpr.data.expression as Node;
    if (lhsKey.type === N.IdentifierReference) {
        baseName = lhsKey.name;
        offset = 0;
    } else if (lhsKey.type === N.BinaryExpression) {
        if (lhsKey.data.operator !== '-') return;
        const keyLeft = lhsKey.data.left as Node;
        const keyRight = lhsKey.data.right as Node;
        if (keyLeft.type !== N.IdentifierReference || keyRight.type !== N.NumericLiteral) return;
        const value = numericLiteralValue(keyRight);
        if (!Number.isInteger(value) || value < 0) return;
        baseName = keyLeft.name;
        offset = value;
    } else {
        return;
    }
    const rIdName = lhsMemberExprObj.name;
    const aIdName = baseName;

    const rhsMemberExpr = bodyAssignExpr.data.right as Node;
    if (rhsMemberExpr.type !== N.ComputedMemberExpression) return;
    const argumentsId = rhsMemberExpr.data.object as Node;
    if (argumentsId.type !== N.IdentifierReference) return;
    if (argumentsId.name !== 'arguments' || !isGlobalReference(ctx, argumentsId)) return;
    const rhsIndex = rhsMemberExpr.data.expression as Node;
    if (rhsIndex.type !== N.IdentifierReference || rhsIndex.name !== aIdName) return;
    aRefCount += 2;

    // Parse update: `a++`
    const update = forData.update;
    if (update === null || update.type !== N.UpdateExpression) return;
    const updateArgument = update.data.argument as Node;
    if (updateArgument.type !== N.IdentifierReference || updateArgument.name !== aIdName) return;
    aRefCount += 1;

    // Parse test: `a < e` or `a < arguments.length`
    const test = forData.test;
    if (test === null || test.type !== N.BinaryExpression || test.data.operator !== '<') return;
    const testLeft = test.data.left as Node;
    if (testLeft.type !== N.IdentifierReference || testLeft.name !== aIdName) return;
    const testRight = test.data.right as Node;
    let eIdInfo: { name: string; symbolId: number } | null;
    if (testRight.type === N.IdentifierReference) {
        eIdInfo = { name: testRight.name, symbolId: getReference(ctx, testRight).symbolId };
    } else if (testRight.type === N.StaticMemberExpression) {
        if (!isGlobalArgumentsLength(ctx, testRight)) return;
        eIdInfo = null;
    } else {
        return;
    }
    if (eIdInfo !== null) eRefCount += 1;
    aRefCount += 1;

    const initDeclLen = eIdInfo !== null ? 3 : 2;

    const varInit = forData.init;
    if (varInit === null || varInit.type !== N.VariableDeclaration) return;
    const declarations = varInit.data.declarations as Node[];
    // Need at least two declarators: r, a (optional `e` may precede them)
    if (declarations.length < initDeclLen) return;

    // make sure `arguments` points to the arguments object; slower than the structure checks above
    if (
        ancestorScopes(ctx).every((scopeId) => {
            const flags = scopeFlags(ctx, scopeId);
            return !scopeIsFunction(flags) || scopeIsArrow(flags);
        })
    )
        return;

    let idx = 0;

    // Check `e = arguments.length`
    if (eIdInfo !== null) {
        const de = declarations[idx].data as DataOf<'VariableDeclarator'>;
        if (de.id.type !== N.BindingIdentifier || de.id.name !== eIdInfo.name) return;
        if (de.init === null || !isGlobalArgumentsLength(ctx, de.init)) return;
        idx += 1;
    }

    // Check `a = 0` or `a = k`
    const deA = declarations[idx + 1].data as DataOf<'VariableDeclarator'>;
    if (deA.id.type !== N.BindingIdentifier || deA.id.name !== aIdName) return;
    if (deA.init === null || deA.init.type !== N.NumericLiteral || numericLiteralValue(deA.init) !== offset) return;
    const aIdSymbolId = deA.id.sym;

    // Check `r = Array(e > 1 ? e - 1 : 0)`, or `r = []`
    const deR = declarations[idx].data as DataOf<'VariableDeclarator'>;
    const rInit = deR.init;
    if (rInit !== null && rInit.type === N.CallExpression) {
        const callee = rInit.data.callee as Node;
        if (callee.type !== N.IdentifierReference || callee.name !== 'Array' || !isGlobalReference(ctx, callee)) return;
        if (rInit.data.arguments.length !== 1) return;
        if (eIdInfo === null) return;
        const argExpr = rInit.data.arguments[0] as Node;
        if (argExpr.type === N.SpreadElement) return;
        const result = verifyArrayArg(argExpr, eIdInfo.name, offset);
        if (result === 'invalid') return;
        eRefCount += result === 'with-offset' ? 2 : 1;
    } else if (rInit !== null && rInit.type === N.ArrayExpression) {
        if (rInit.data.elements.length > 0) return;
    } else {
        return;
    }
    if (deR.id.type !== N.BindingIdentifier || deR.id.name !== rIdName) return;
    const rIdSymbolId = deR.id.sym;

    // bail out if `e` or `a` is used outside the for-loop
    if (eIdInfo !== null && (eIdInfo.symbolId === 0 || getResolvedReferences(ctx, eIdInfo.symbolId).length !== eRefCount)) return;
    if (getResolvedReferences(ctx, aIdSymbolId).length !== aRefCount) return;

    // `[...arguments]` has no side effect, so `r` is not needed when its only use is the loop's write.
    const rIdPat = getResolvedReferences(ctx, rIdSymbolId).length > 1 ? takeNode(ctx, deR.id) : null;

    if (rIdPat !== null) {
        const span = forStatement;
        const baseArr = node(N.ArrayExpression, span.start, span.end, '', {
            elements: [node(N.SpreadElement, span.start, span.end, '', { argument: takeNode(ctx, argumentsId) })],
        });
        // wrap with `.slice(offset)`
        const arr =
            offset > 0
                ? node(N.CallExpression, span.start, span.end, '', {
                      callee: node(N.StaticMemberExpression, span.start, span.end, '', {
                          object: baseArr,
                          property: node(N.IdentifierName, span.start, span.end, 'slice', null),
                          optional: false,
                      }),
                      arguments: [numericLiteral(span, offset)],
                      optional: false,
                      pure: false,
                      typeArguments: null,
                  })
                : baseArr;
        const newDecl = node(N.VariableDeclarator, span.start, span.end, '', {
            id: rIdPat,
            typeAnnotation: null,
            init: arr,
            definite: false,
        });
        for (const declarator of declarations) dropVariableDeclarator(ctx, declarator);
        declarations.splice(0, declarations.length, newDecl);
    } else {
        // An empty `var` would print as `for (var; 0;)` and let `try_fold_for` hoist a bogus `var;`.
        for (const declarator of declarations) dropVariableDeclarator(ctx, declarator);
        forData.init = null;
    }
    dropExpression(ctx, test);
    forData.test = numericLiteral(forStatement, 0);
    dropExpression(ctx, update);
    forData.update = null;
    replaceStatement(ctx, forData.body, node(N.EmptyStatement, forData.body.start, forData.body.end, '', null));
}

/** `return undefined` -> `return`, `return void 0` -> `return` */
export function substituteReturnStatement(ctx: DceCtx, statement: Node): void {
    const data = statement.data as DataOf<'ReturnStatement'>;
    const argument = data.argument;
    if (argument === null) return;
    let isUndefined: boolean;
    if (argument.type === N.IdentifierReference) isUndefined = isIdentifierUndefined(ctx, argument);
    else if (argument.type === N.UnaryExpression)
        isUndefined = argument.data.operator === 'void' && !mayHaveSideEffects(argument, ctx);
    else isUndefined = false;
    if (!isUndefined) return;
    // `return undefined` has a different semantic in async generator function.
    if (isClosestFunctionScopeAnAsyncGenerator(ctx)) return;
    data.argument = null;
    dropExpression(ctx, argument);
}

function compressVariableDeclarator(ctx: DceCtx, declarator: Node, kind: DataOf<'VariableDeclaration'>['kind']): void {
    const data = declarator.data as DataOf<'VariableDeclarator'>;
    // Destructuring Pattern has error throwing side effect.
    if (kind === 'const' || kind === 'using' || kind === 'await using' || isDestructuringPattern(data.id)) return;
    const init = data.init;
    if (kind !== 'var' && init !== null && isExpressionUndefined(ctx, init)) {
        data.init = null;
        dropExpression(ctx, init);
    }
}

/** `Boolean(a)` -> `!!a`, `Number(0)` -> `0`, `String()` -> `''`, `BigInt(1n)` -> `1n` */
export function substituteSimpleFunctionCall(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.CallExpression) return;
    const call = expr.data as DataOf<'CallExpression'>;
    if (call.optional || call.arguments.length >= 2) return;
    const ident = call.callee;
    if (ident.type !== N.IdentifierReference) return;
    const name = ident.name;
    if (name !== 'Boolean' && name !== 'Number' && name !== 'String' && name !== 'BigInt') return;
    if (!isGlobalReference(ctx, ident)) return;
    const span: Span = expr;
    let arg: Node | null = null;
    if (call.arguments.length > 0) {
        arg = call.arguments[0];
        if (arg.type === N.SpreadElement) return;
    }
    let changed: Node | null = null;
    switch (name) {
        // `Boolean(a)` -> `!!(a)`
        case 'Boolean':
            if (arg === null) {
                changed = node(N.BooleanLiteral, span.start, span.end, 'false', null);
            } else {
                const moved = takeNode(ctx, arg);
                minimizeExpressionInBooleanContext(ctx, moved);
                const not = node(N.UnaryExpression, span.start, span.end, '', { operator: '!', prefix: true, argument: moved });
                changed = minimizeNot(ctx, span, not);
            }
            break;
        case 'String':
            if (arg === null) {
                // `String()` -> `''`
                changed = stringLiteral(span, '');
            } else {
                const value = evaluateValueToString(arg, ctx);
                if (value !== null && !mayHaveSideEffects(arg, ctx)) changed = valueToExpr(ctx, span, { kind: 'string', value });
            }
            break;
        case 'Number': {
            let value = 0;
            if (arg !== null) {
                const number = toNumber(arg, ctx);
                if (number === null || mayHaveSideEffects(arg, ctx)) return;
                value = number;
            }
            changed = numericLiteral(span, value);
            break;
        }
        // `BigInt(1n)` -> `1n`
        case 'BigInt':
            if (arg !== null && arg.type === N.BigIntLiteral) changed = takeNode(ctx, arg);
            break;
    }
    if (changed !== null) replaceExpression(ctx, expr, changed);
}

/** The name of a foldable `Object` or `Array` constructor callee. */
function getFoldConstructorName(ctx: DceCtx, callee: Node): string | null {
    switch (callee.type) {
        case N.StaticMemberExpression: {
            const object = callee.data.object as Node;
            if (object.type !== N.IdentifierReference || object.name !== 'window') return null;
            return callee.data.property.name;
        }
        case N.IdentifierReference: {
            const name = callee.name;
            if (name !== 'Object' && name !== 'Array') return null;
            if (!isGlobalReference(ctx, callee)) return null;
            return name;
        }
        default:
            return null;
    }
}

/** `window.Object()`, `new Object()`, `Object()` -> `{}`; `window.Array()`, `new Array()`, `Array()` -> `[]` */
export function substituteObjectOrArrayConstructor(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.NewExpression && expr.type !== N.CallExpression) return;
    const data = expr.data as { callee: Node; arguments: Node[] };
    const name = getFoldConstructorName(ctx, data.callee);
    if (name === null) return;
    const isNewExpr = expr.type === N.NewExpression;
    const args = data.arguments;
    const toCall = (): Node =>
        node(N.CallExpression, expr.start, expr.end, '', {
            callee: takeNode(ctx, data.callee),
            arguments: args.splice(0),
            optional: false,
            pure: false,
            typeArguments: null,
        });
    if (name === 'Object') {
        if (args.length === 0)
            replaceExpression(ctx, expr, node(N.ObjectExpression, expr.start, expr.end, '', { properties: [] }));
        return;
    }
    if (name !== 'Array') return;
    // `new Array` -> `[]`
    if (args.length === 0) {
        replaceExpression(ctx, expr, node(N.ArrayExpression, expr.start, expr.end, '', { elements: [] }));
    } else if (args.length === 1) {
        const arg = args[0];
        if (arg.type === N.SpreadElement) return;
        // `new Array(0)` -> `[]`
        if (isNumber0(arg)) {
            replaceExpression(ctx, expr, node(N.ArrayExpression, expr.start, expr.end, '', { elements: [] }));
        }
        // `new Array(8)` -> `Array(8)`
        else if (arg.type === N.NumericLiteral) {
            // `new Array(2)` -> `[,,]`; this does not work with IE8 and below
            const value = numericLiteralValue(arg);
            if (Number.isInteger(value)) {
                const count = value > 0 ? value : 0;
                if (count >= 1 && count <= 6) {
                    const elisions: null[] = new Array(count).fill(null);
                    replaceExpression(ctx, expr, node(N.ArrayExpression, expr.start, expr.end, '', { elements: elisions }));
                    return;
                }
            }
            if (isNewExpr) replaceExpression(ctx, expr, toCall());
        }
        // `new Array(literal)` -> `[literal]`
        else if (isLiteral(arg) || arg.type === N.ArrayExpression) {
            replaceExpression(ctx, expr, node(N.ArrayExpression, expr.start, expr.end, '', { elements: [takeNode(ctx, arg)] }));
        }
        // `new Array(x)` -> `Array(x)`
        else if (isNewExpr) {
            replaceExpression(ctx, expr, toCall());
        }
    } else {
        // `Array` treats exactly one argument as a length. With two non-spread arguments the count is
        // at least two whatever the spreads produce; with fewer, a spread may produce nothing and
        // expose the one-argument case, e.g. `Array(foo, ...[])`.
        let hasSpread = false;
        let nonSpreadCount = 0;
        for (const arg of args) {
            if (arg.type === N.SpreadElement) hasSpread = true;
            else nonSpreadCount += 1;
            if (hasSpread && nonSpreadCount >= 2) break;
        }
        if (hasSpread && nonSpreadCount < 2) return;

        // `new Array(1, 2, ...xs)` -> `[1, 2, ...xs]`
        replaceExpression(ctx, expr, node(N.ArrayExpression, expr.start, expr.end, '', { elements: args.splice(0) }));
    }
}

/** `new Error()` -> `Error()` (also the NativeErrors), `new AggregateError()`, `new Function()`,
 *  `new RegExp()` likewise */
export function substituteGlobalNewExpression(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.NewExpression) return;
    const data = expr.data as DataOf<'NewExpression'>;
    const ident = data.callee;
    if (ident.type !== N.IdentifierReference) return;
    const name = ident.name;
    if (name !== 'Error' && name !== 'AggregateError' && name !== 'Function' && name !== 'RegExp' && !isNativeErrorName(name))
        return;
    if (!isGlobalReference(ctx, ident)) return;
    let fold: boolean;
    if (name === 'RegExp') {
        const firstArgument = data.arguments[0];
        fold =
            data.arguments.length === 0 ||
            (firstArgument.type !== N.SpreadElement &&
                (() => {
                    const type = valueType(firstArgument, ctx);
                    return type !== 'undetermined' && type !== 'object';
                })());
    } else {
        fold = true;
    }
    if (!fold) return;
    const newValue = node(N.CallExpression, expr.start, expr.end, '', {
        callee: takeNode(ctx, ident),
        // The parser shares one frozen empty list.
        arguments: data.arguments.length === 0 ? [] : data.arguments.splice(0),
        optional: false,
        pure: data.pure,
        typeArguments: null,
    });
    replaceExpression(ctx, expr, newValue);
}

/** Whether the name is one of the native error types. */
function isNativeErrorName(name: string): boolean {
    switch (name) {
        case 'EvalError':
        case 'RangeError':
        case 'ReferenceError':
        case 'SyntaxError':
        case 'TypeError':
        case 'URIError':
            return true;
        default:
            return false;
    }
}

/** `window.Object?.()` -> `Object?.()` */
export function substituteChainCallExpression(ctx: DceCtx, expr: Node): void {
    const call = (expr.data as DataOf<'ChainExpression'>).expression;
    if (call.type !== N.CallExpression) return;
    const callee = call.data.callee as Node;
    if (
        call.data.arguments.length === 0 &&
        (callee.type === N.StaticMemberExpression || callee.type === N.ComputedMemberExpression) &&
        isSpecificMemberAccess(callee, 'window', 'Object')
    ) {
        replaceExpression(ctx, callee, createUnboundReference(ctx, callee, 'Object', ReferenceFlags.Read));
    }
}

export function substituteTemplateLiteral(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.TemplateLiteral) return;
    const value = toJsString(expr, ctx);
    if (value === null || mayHaveSideEffects(expr, ctx)) return;
    replaceExpression(ctx, expr, stringLiteral(expr, value));
}

function tryCompressPropertyKey(ctx: DceCtx, owner: Node): void {
    const data = owner.data as { key: Node; computed: boolean };
    const key = data.key;
    switch (key.type) {
        case N.NumericLiteral:
            if (data.computed) data.computed = false;
            return;
        case N.StringLiteral: {
            const value = stringLiteralValue(key).value;
            if (isIdentifierNamePatched(value)) {
                data.computed = false;
                replacePropertyKey(ctx, key, node(N.IdentifierName, key.start, key.end, value, null));
                return;
            }
            const number = stringToEquivalentNumberValue(value);
            if (number !== null && number >= 0) {
                data.computed = false;
                replacePropertyKey(ctx, key, numericLiteral(key, number));
                return;
            }
            if (data.computed) data.computed = false;
            return;
        }
    }
}

/** `foo(...[1,2,3])` -> `foo(1,2,3)`, `new Foo(...[1,2,3])` -> `new Foo(1,2,3)` */
function tryFlattenArguments(ctx: DceCtx, args: Node[]): void {
    let shouldFold = false;
    for (const arg of args) {
        if (arg.type === N.SpreadElement && arg.data.argument.type === N.ArrayExpression) shouldFold = true;
    }
    if (!shouldFold) return;

    const oldArgs = args.splice(0);
    for (const arg of oldArgs) {
        if (arg.type !== N.SpreadElement) {
            args.push(arg);
            continue;
        }
        const arrayExpr = arg.data.argument as Node;
        if (arrayExpr.type !== N.ArrayExpression) {
            args.push(arg);
            continue;
        }
        for (const element of arrayExpr.data.elements as (Node | null)[]) {
            if (element === null) args.push(createVoidZero(arrayExpr));
            else args.push(element);
        }
    }
    noticeChange(ctx);
}

/** `(foo?.bar)?.baz` -> `foo?.bar?.baz` */
function tryFlattenNestedChainExpression(ctx: DceCtx, expr: Node): void {
    const element = (expr.data as DataOf<'ChainExpression'>).expression;
    let slot: Node;
    switch (element.type) {
        case N.StaticMemberExpression:
        case N.ComputedMemberExpression:
        case N.PrivateFieldExpression:
            slot = element.data.object;
            break;
        case N.CallExpression:
            slot = element.data.callee;
            break;
        default:
            return;
    }
    if (slot.type !== N.ChainExpression) return;
    replaceExpression(ctx, slot, takeNode(ctx, slot.data.expression));
}

/** `Object(expr)(args)` -> `(0, expr)(args)`. For a primitive or nullish `expr` both throw "not a
 *  function"; for an object `Object(expr)` is `expr`, and `(0, expr)` keeps `this` unbound. */
function tryRewriteObjectCalleeIndirectCall(ctx: DceCtx, call: Node): void {
    const innerCall = (call.data as DataOf<'CallExpression'>).callee;
    if (innerCall.type !== N.CallExpression) return;
    if (innerCall.data.optional || innerCall.data.arguments.length !== 1) return;
    const callee = innerCall.data.callee as Node;
    if (callee.type !== N.IdentifierReference) return;
    if (callee.name !== 'Object' || !isGlobalReference(ctx, callee)) return;
    const argExpr = innerCall.data.arguments[0] as Node;
    if (argExpr.type === N.SpreadElement) return;
    const newCallee = node(N.SequenceExpression, innerCall.start, innerCall.end, '', {
        expressions: [numericLiteral(innerCall, 0), takeNode(ctx, argExpr)],
    });
    replaceExpression(ctx, innerCall, newCallee);
}

/** `var a = function f() {}` -> `var a = function () {}` when `f` is unused. Not safe for code that
 *  relies on `Function.prototype.name`. */
export function tryRemoveNameFromFunctions(ctx: DceCtx, func: Node): void {
    if (ctx.state.options.keepNames.function) return;
    const data = func.data as DataOf<'FunctionExpression'>;
    if (data.id !== null && symbolIsUnused(ctx, data.id.sym) && !scopeContainsDirectEval(scopeFlags(ctx, data.scopeId))) {
        data.id = null;
        noticeChange(ctx);
    }
}

/** `var a = class C {}` -> `var a = class {}` when `C` is unused. Not safe for code that relies on
 *  the class name. */
export function tryRemoveNameFromClasses(ctx: DceCtx, classNode: Node): void {
    if (ctx.state.options.keepNames.class) return;
    const data = classNode.data as DataOf<'ClassExpression'>;
    if (data.id !== null && symbolIsUnused(ctx, data.id.sym) && !scopeContainsDirectEval(scopeFlags(ctx, data.scopeId))) {
        data.id = null;
        noticeChange(ctx);
    }
}

/** `new Int8Array(0)` -> `new Int8Array()` (also for other TypedArrays) */
export function substituteTypedArrayConstructor(ctx: DceCtx, newExpr: Node): void {
    const data = newExpr.data as DataOf<'NewExpression'>;
    const ident = data.callee;
    if (ident.type !== N.IdentifierReference) return;
    if (!isTypedArrayConstructor(ident.name) || !isGlobalReference(ctx, ident)) return;
    if (data.arguments.length === 1 && isNumber0(data.arguments[0])) data.arguments.length = 0;
}

/** `true` => `!0`, `false` => `!1` */
export function substituteBoolean(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.BooleanLiteral) return;
    const num = numericLiteral(expr, expr.name === 'true' ? 0 : 1);
    replaceExpression(
        ctx,
        expr,
        node(N.UnaryExpression, expr.start, expr.end, '', { operator: '!', prefix: true, argument: num }),
    );
}

const countElisions = (elements: readonly (Node | null)[]): number => {
    let count = 0;
    for (const element of elements) if (element === null) count += 1;
    return count;
};

/** `[a, ...[1, 2, 3]]` -> `[a, 1, 2, 3]`. An elision in the spread source becomes `void 0`, as
 *  spreading reads it as `undefined`; with two or more the spread is kept, being shorter. */
export function tryFlattenArrayExpressionElements(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.ArrayExpression) return;
    const elements = expr.data.elements as (Node | null)[];
    const isFoldable = (element: Node | null): boolean =>
        element !== null &&
        element.type === N.SpreadElement &&
        element.data.argument.type === N.ArrayExpression &&
        countElisions(element.data.argument.data.elements) < 2;
    if (!elements.some(isFoldable)) return;

    const oldElements = elements.splice(0);
    for (const element of oldElements) {
        if (element !== null && isFoldable(element)) {
            const arrayExpr = (element.data as DataOf<'SpreadElement'>).argument;
            for (const inner of (arrayExpr.data as DataOf<'ArrayExpression'>).elements)
                elements.push(inner === null ? createVoidZero(arrayExpr) : inner);
        } else {
            elements.push(element);
        }
    }
    noticeChange(ctx);
}

/** A long array of string literals -> `"str1,str2".split(',')` */
export function substituteArrayExpression(ctx: DceCtx, expr: Node): void {
    // chosen by hand from the minsize output
    const THRESHOLD = 40;
    if (expr.type !== N.ArrayExpression) return;
    const elements = expr.data.elements as (Node | null)[];
    if (!elements.every((element) => element !== null && element.type === N.StringLiteral)) return;

    // Only when the saving is large: using `.split` in some places and not others can grow gzip size.
    const canSave = elements.length * 2 > ".split('.')".length + THRESHOLD;
    if (!canSave) return;

    const strings = (elements as Node[]).map((element) => stringLiteralValue(element).value);
    const delimiter = pickDelimiter(strings);
    if (delimiter === null) return;

    const concatenatedString = strings.join(delimiter);
    const newValue = node(N.CallExpression, expr.start, expr.end, '', {
        callee: node(N.StaticMemberExpression, expr.start, expr.end, '', {
            object: stringLiteral(expr, concatenatedString),
            property: node(N.IdentifierName, expr.start, expr.end, 'split', null),
            optional: false,
        }),
        arguments: [stringLiteral(expr, delimiter)],
        optional: false,
        pure: true,
        typeArguments: null,
    });
    replaceExpression(ctx, expr, newValue);
}

function pickDelimiter(strings: readonly string[]): string | null {
    // Characters common in programs, so probably with a small Huffman encoding.
    const DELIMITERS = ['.', ',', '(', ')', ' '];
    // oxc compares UTF-8 byte lengths.
    if (strings.every((value) => utf8Length(value) === 1)) return '';
    return DELIMITERS.find((delimiter) => strings.every((value) => !value.includes(delimiter))) ?? null;
}

export function substituteCatchClause(ctx: DceCtx, catchClause: Node): void {
    const data = catchClause.data as DataOf<'CatchClause'>;
    const param = data.param;
    if (
        supportsFeature(ctx, 'ES2019OptionalCatchBinding') &&
        param !== null &&
        param.type === N.BindingIdentifier &&
        ((data.body.data as DataOf<'BlockStatement'>).body.length === 0 || symbolIsUnused(ctx, param.sym)) &&
        // Direct eval can reference the catch parameter even when static analysis sees no use.
        !scopeContainsDirectEval(scopeFlags(ctx, data.scopeId)) &&
        // In `catch (e) { var e = x }` the assignment targets the catch parameter.
        symbolRedeclarations(ctx, param.sym).length === 0 &&
        !catchBodyHasSameNameVar(data.body, param.name)
    ) {
        data.param = null;
    }
}

function catchBodyHasSameNameVar(body: Node, name: string): boolean {
    return (body.data as DataOf<'BlockStatement'>).body.some((statement) => {
        if (statement.type !== N.VariableDeclaration || statement.data.kind !== 'var') return false;
        let hasSameName = false;
        boundNames(statement, (ident) => {
            if (ident.name === name) hasSameName = true;
        });
        return hasSameName;
    });
}

// --- IIFEs ---------------------------------------------------------------------------------------

/** oxc `FormalParameters::is_empty`: no items; a rest parameter is not an item. */
const paramsIsEmpty = (params: readonly Node[]): boolean => !params.some((param) => param.type === N.FormalParameter);

/** oxc `FormalParameters::has_parameter`: an item or a rest parameter. */
const paramsHasParameter = (params: readonly Node[]): boolean => params.length > 0;

/** oxc `FunctionBody::is_empty`: no directives and no statements. */
const functionBodyIsEmpty = (body: Node): boolean => (body.data as DataOf<'BlockStatement'>).body.length === 0;

/** Whether the expression's result will be discarded: a bare expression statement, or the init of a
 *  `var`/`let`/`const` whose binding is unused by count. */
function isExpressionResultUnused(ctx: DceCtx): boolean {
    switch (parentKind(ctx)) {
        case 'ExpressionStatementExpression':
            return true;
        case 'VariableDeclaratorInit': {
            if (!canRemoveUnusedDeclarators(ctx)) return false;
            const declaration = ancestor(ctx, 1);
            if (declaration.kind !== 'VariableDeclarationDeclarations')
                throw new Error('dce: a declarator outside a declaration');
            // `using` runs `[Symbol.dispose]` at scope exit.
            const kind = (declaration.node.data as DataOf<'VariableDeclaration'>).kind;
            if (kind === 'using' || kind === 'await using') return false;
            const id = (ancestor(ctx, 0).node.data as DataOf<'VariableDeclarator'>).id;
            if (id.type !== N.BindingIdentifier) return false;
            return symbolIsUnusedByCount(ctx, id.sym);
        }
        default:
            return false;
    }
}

/** Simplify IIFEs: empty ones become `undefined`, and a parameterless non-async arrow whose body is
 *  one expression, one expression statement or one `return` is inlined. */
export function substituteIifeCall(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.CallExpression) return;
    const call = expr.data as DataOf<'CallExpression'>;
    const callee = call.callee;
    if (callee.type !== N.FunctionExpression && callee.type !== N.ArrowFunctionExpression) return;

    if (call.arguments.length > 0) {
        substituteEmptyBodyIifeCallWithArgs(ctx, expr);
        return;
    }

    let isEmptyIife: boolean;
    if (callee.type === N.FunctionExpression) {
        const body = callee.data.body as Node | null;
        isEmptyIife =
            paramsIsEmpty(callee.data.params) &&
            body !== null &&
            functionBodyIsEmpty(body) &&
            // ignore async/generator if a return value is not used
            ((!callee.data.async && !callee.data.generator) || isExpressionResultUnused(ctx));
    } else {
        const body = callee.data.body as Node;
        isEmptyIife =
            paramsIsEmpty(callee.data.params) &&
            body.type === N.BlockStatement &&
            functionBodyIsEmpty(body) &&
            // ignore async if a return value is not used
            (!callee.data.async || isExpressionResultUnused(ctx));
    }

    if (isEmptyIife) {
        // Replace "(() => {})()" with "undefined"
        replaceExpression(ctx, expr, createVoidZero(expr));
        return;
    }

    // The callee is a function literal, so only an explicit `/* @__PURE__ */` annotation can apply.
    const isPure = call.pure && ctx.annotations;

    if (callee.type !== N.ArrowFunctionExpression || callee.data.async || paramsHasParameter(callee.data.params)) return;
    const body = callee.data.body as Node;
    if (body.type !== N.BlockStatement) {
        // Replace "(() => foo())()" with "foo()"
        let newValue: Node | null;
        if (isPure && isExpressionResultUnused(ctx)) newValue = createVoidZero(expr);
        else newValue = tryTakeIifeBody(ctx, body, isPure);
        if (newValue !== null) replaceExpression(ctx, expr, newValue);
        return;
    }
    const statements = (body.data as DataOf<'BlockStatement'>).body.filter((statement) => !ctx.directives.has(statement));
    if (statements.length !== 1) return;
    const statement = statements[0];
    switch (statement.type) {
        case N.ExpressionStatement: {
            // Replace "(() => { foo() })()" with "(foo(), undefined)"
            let newValue: Node;
            if (isPure && isExpressionResultUnused(ctx)) {
                newValue = createVoidZero(expr);
            } else {
                const taken = tryTakeIifeBody(ctx, statement.data.expression, isPure);
                if (taken === null) return;
                newValue = node(N.SequenceExpression, statement.start, statement.end, '', {
                    expressions: [taken, createVoidZero(expr)],
                });
            }
            replaceExpression(ctx, expr, newValue);
            return;
        }
        case N.ReturnStatement: {
            const argument = statement.data.argument as Node | null;
            if (argument === null) return;
            // Replace "(() => { return foo() })()" with "foo()"
            let newValue: Node | null;
            if (isPure && isExpressionResultUnused(ctx)) newValue = createVoidZero(expr);
            else newValue = tryTakeIifeBody(ctx, argument, isPure);
            if (newValue !== null) replaceExpression(ctx, expr, newValue);
            return;
        }
    }
}

/** `(() => {})(a, b)` -> `(a, b, void 0)`: drop the wrapper when the body is empty and every param is
 *  a bare identifier; spread args become `[...a]` to keep the iterator-protocol invocation. */
function substituteEmptyBodyIifeCallWithArgs(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.CallExpression) return;
    const call = expr.data as DataOf<'CallExpression'>;
    const callee = call.callee;

    // Looser than the spec's `IsSimpleParameterList`: a rest binding to an identifier is safe here,
    // since the empty body never observes the collected array.
    const paramsSimple = (params: readonly Node[]): boolean =>
        params.every((param) =>
            param.type === N.FormalParameter
                ? param.data.pattern.type === N.BindingIdentifier && param.data.init === null
                : param.type === N.RestElement && param.data.argument.type === N.BindingIdentifier,
        );

    let isDropCandidate: boolean;
    if (callee.type === N.FunctionExpression) {
        const body = callee.data.body as Node | null;
        isDropCandidate =
            !callee.data.async &&
            !callee.data.generator &&
            body !== null &&
            functionBodyIsEmpty(body) &&
            paramsSimple(callee.data.params);
    } else if (callee.type === N.ArrowFunctionExpression) {
        const body = callee.data.body as Node;
        isDropCandidate =
            !callee.data.async && body.type === N.BlockStatement && functionBodyIsEmpty(body) && paramsSimple(callee.data.params);
    } else {
        isDropCandidate = false;
    }

    if (!isDropCandidate) return;

    const expressions = foldArgumentsIntoNeededExpressions(ctx, call.arguments);
    let newValue: Node;
    if (expressions.length === 0) {
        newValue = createVoidZero(expr);
    } else {
        expressions.push(createVoidZero(expr));
        newValue = node(N.SequenceExpression, expr.start, expr.end, '', { expressions });
    }
    replaceExpression(ctx, expr, newValue);
}

/** Take the IIFE body out for inlining, marking a call or `new` body pure when the IIFE was. Null
 *  in tree-shake-only mode, which keeps IIFEs. */
function tryTakeIifeBody(ctx: DceCtx, body: Node, isPure: boolean): Node | null {
    if (isTreeShakeOnly(ctx.state)) return null;
    const taken = takeNode(ctx, body);
    if (isPure && (taken.type === N.CallExpression || taken.type === N.NewExpression)) taken.data.pure = true;
    return taken;
}
