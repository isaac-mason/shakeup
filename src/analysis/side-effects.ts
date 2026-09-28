// Port of oxc's side-effect analysis (`oxc_ecmascript/src/side_effects/`): `mod.rs`, `context.rs`,
// `expressions.rs`, `statements.rs`, `known_globals.rs`, `pure_function.rs`.
//
// oxc dispatches through one `MayHaveSideEffects` impl per AST type. Where shakeup's node types are
// distinct the same dispatch lives in `mayHaveSideEffects`; where one node type means different
// things by position (a `SpreadElement` in arguments, array literals and object literals; an
// `ObjectExpression` used as an assignment target), the positional impl is its own export.

import { N, type Node } from '../ast/index.ts';
import {
    bigIntLiteralValue,
    type GlobalContext,
    getInnerExpression,
    numericLiteralValue,
    primitiveToNumeric,
    stringLiteralValue,
    type ToPrimitiveResult,
    templateElementCooked,
    toBigInt,
    toPrimitive,
    valueType,
} from './const-eval.ts';

// --- context.rs ----------------------------------------------------------------------------------

/** oxc `PropertyReadSideEffects`. */
export type PropertyReadSideEffects = 'none' | 'all';

/** The `oxc_compat::ESFeature`s the RegExp purity checks query. */
export type EsFeature =
    | 'ES2015StickyRegex'
    | 'ES2015UnicodeRegex'
    | 'ES2015RegExpConstructorCanAlterFlags'
    | 'ES2018DotallRegex'
    | 'ES2018NamedCapturingGroupsRegex'
    | 'ES2018UnicodePropertyRegex'
    | 'ES2018LookbehindRegex'
    | 'ES2022MatchIndicesRegex'
    | 'ES2024UnicodeSetsRegex'
    | 'ES2025DuplicateNamedCapturingGroupsRegex'
    | 'ES2025RegexpModifiers';

/** oxc `EngineTargets::supports_es_feature`: a strict capability query, so an engine missing from the
 *  compatibility table does not support the feature. */
export type EngineTargets = { supportsEsFeature: (feature: EsFeature) => boolean };

/** oxc `MayHaveSideEffectsContext`. */
export type SideEffectsContext = GlobalContext & {
    /** null when targets are unknown: every runtime feature then counts as unsupported. */
    engineTargets: EngineTargets | null;
    /** Honour `/* @__PURE__ *\/` on calls and `new`. */
    annotations: boolean;
    /** Whether a call, `new` or tag with this callee is pure apart from its arguments. */
    manualPureFunctions: (callee: Node) => boolean;
    propertyReadSideEffects: PropertyReadSideEffects;
    propertyWriteSideEffects: boolean;
    /** Whether reading a global that is not a known global may throw or run a getter. */
    unknownGlobalSideEffects: boolean;
};

// --- mod.rs --------------------------------------------------------------------------------------

/**
 * Whether evaluating `node` may change application state. `node` is an expression, a statement, a
 * binding pattern or a class element.
 *
 * Assumes, as oxc does, that `.toString()`, `.valueOf()` and `[Symbol.toPrimitive]()` are side-effect
 * free, that creating an over-long String or Array does not throw, and that TDZ errors do not happen.
 */
export function mayHaveSideEffects(node: Node, ctx: SideEffectsContext): boolean {
    switch (node.type) {
        case N.IdentifierReference:
            return identifierReferenceMayHaveSideEffects(node, ctx);
        case N.NumericLiteral:
        case N.BooleanLiteral:
        case N.StringLiteral:
        case N.BigIntLiteral:
        case N.NullLiteral:
        case N.RegExpLiteral:
        case N.ImportMeta:
        case N.NewTarget:
        case N.ArrowFunctionExpression:
        case N.FunctionExpression:
        case N.Super:
            return false;
        case N.TemplateLiteral:
            return templateLiteralMayHaveSideEffects(node, ctx);
        case N.UnaryExpression:
            return unaryExpressionMayHaveSideEffects(node, ctx);
        case N.LogicalExpression:
            return logicalExpressionMayHaveSideEffects(node, ctx);
        case N.ConditionalExpression: {
            const { test, consequent, alternate } = node.data;
            if (mayHaveSideEffects(test, ctx)) return true;
            // typeof x === 'undefined' ? fallback : x
            if (isSideEffectFreeUnboundIdentifierRef(alternate, test, false, ctx)) return mayHaveSideEffects(consequent, ctx);
            // typeof x !== 'undefined' ? x : fallback
            if (isSideEffectFreeUnboundIdentifierRef(consequent, test, true, ctx)) return mayHaveSideEffects(alternate, ctx);
            return mayHaveSideEffects(consequent, ctx) || mayHaveSideEffects(alternate, ctx);
        }
        case N.SequenceExpression:
            return node.data.expressions.some((expression) => mayHaveSideEffects(expression, ctx));
        case N.BinaryExpression:
            // `#x in y` is oxc's `PrivateInExpression`.
            if (node.data.left.type === N.PrivateIdentifier) {
                if (mayHaveSideEffects(node.data.right, ctx)) return true;
                // `#x in y` throws when `y` is not an object.
                return valueType(node.data.right, ctx) !== 'object';
            }
            return binaryExpressionMayHaveSideEffects(node, ctx);
        case N.ObjectExpression:
            return node.data.properties.some((property) => objectPropertyKindMayHaveSideEffects(property, ctx));
        case N.ArrayExpression:
            return arrayExpressionMayHaveSideEffects(node, ctx);
        case N.ClassExpression:
        case N.ClassDeclaration:
            return classMayHaveSideEffects(node, ctx);
        case N.ChainExpression:
            return mayHaveSideEffects(node.data.expression, ctx);
        case N.StaticMemberExpression:
            return propertyAccessMayHaveSideEffects(node.data.object, node.data.property.name, ctx);
        case N.ComputedMemberExpression:
            return computedMemberExpressionMayHaveSideEffects(node, ctx);
        case N.PrivateFieldExpression:
            return ctx.propertyReadSideEffects !== 'none' || mayHaveSideEffects(node.data.object, ctx);
        case N.CallExpression:
            return callExpressionMayHaveSideEffects(node, ctx);
        case N.NewExpression:
            return newExpressionMayHaveSideEffects(node, ctx);
        case N.TaggedTemplateExpression:
            return ctx.manualPureFunctions(node.data.tag) ? mayHaveSideEffects(node.data.quasi, ctx) : true;
        case N.AssignmentExpression:
            return assignmentExpressionMayHaveSideEffects(node, ctx);
        case N.UpdateExpression:
            // `++`/`--` is GetValue + ToNumeric + PutValue, and the ToNumeric alone can run `valueOf`.
            return true;
        case N.TSAsExpression:
        case N.TSSatisfiesExpression:
        case N.TSNonNullExpression:
        case N.TSInstantiationExpression:
            return mayHaveSideEffects(getInnerExpression(node), ctx);

        // statements.rs
        case N.BlockStatement:
            return node.data.body.some((statement) => mayHaveSideEffects(statement, ctx));
        case N.DoWhileStatement:
        case N.WhileStatement:
            return mayHaveSideEffects(node.data.test, ctx) || mayHaveSideEffects(node.data.body, ctx);
        case N.ExpressionStatement:
            return mayHaveSideEffects(node.data.expression, ctx);
        case N.IfStatement: {
            const { test, consequent, alternate } = node.data;
            return (
                mayHaveSideEffects(test, ctx) ||
                mayHaveSideEffects(consequent, ctx) ||
                (alternate !== null && mayHaveSideEffects(alternate, ctx))
            );
        }
        case N.LabeledStatement:
            return mayHaveSideEffects(node.data.body, ctx);
        case N.ReturnStatement:
            return node.data.argument !== null && mayHaveSideEffects(node.data.argument, ctx);
        case N.SwitchStatement:
            return (
                mayHaveSideEffects(node.data.discriminant, ctx) ||
                node.data.cases.some(
                    (switchCase) =>
                        switchCase.type === N.SwitchCase &&
                        ((switchCase.data.test !== null && mayHaveSideEffects(switchCase.data.test, ctx)) ||
                            switchCase.data.consequent.some((statement) => mayHaveSideEffects(statement, ctx))),
                )
            );
        case N.TryStatement:
            return tryStatementMayHaveSideEffects(node, ctx);
        case N.BreakStatement:
        case N.ContinueStatement:
        case N.EmptyStatement:
        case N.FunctionDeclaration:
            return false;
        case N.VariableDeclaration:
            return variableDeclarationMayHaveSideEffects(node, ctx);

        // BindingPattern
        case N.ArrayPattern:
            return (
                ctx.propertyReadSideEffects !== 'none' ||
                node.data.elements.some(
                    (element) => element !== null && element.type !== N.RestElement && mayHaveSideEffects(element, ctx),
                )
            );
        case N.ObjectPattern:
            return (
                ctx.propertyReadSideEffects !== 'none' ||
                node.data.properties.some(
                    (property) =>
                        property.type === N.ObjectProperty &&
                        (propertyKeyMayHaveSideEffects(property.data.key, ctx) || mayHaveSideEffects(property.data.value, ctx)),
                )
            );
        case N.AssignmentPattern:
            return mayHaveSideEffects(node.data.left, ctx) || mayHaveSideEffects(node.data.right, ctx);
        case N.BindingIdentifier:
            return false;

        // ClassElement
        case N.StaticBlock:
            return node.data.body.some((statement) => mayHaveSideEffects(statement, ctx));
        case N.MethodDefinition:
            // oxc also counts decorated parameters, which shakeup's parser does not accept.
            return node.data.decorators.length > 0 || propertyKeyMayHaveSideEffects(node.data.key, ctx);
        case N.PropertyDefinition:
            // `accessor x = v` is oxc's AccessorProperty, whose initializer counts whether or not it is static
            return (
                node.data.decorators.length > 0 ||
                propertyKeyMayHaveSideEffects(node.data.key, ctx) ||
                ((node.data.static || node.data.accessor) && node.data.value !== null && mayHaveSideEffects(node.data.value, ctx))
            );
        case N.TSIndexSignature:
            return false;

        // ThisExpression, YieldExpression, AwaitExpression, ImportExpression, JSX, loops, `throw`,
        // `with`, `debugger` and module declarations. oxc never reaches TS declarations here.
        default:
            return true;
    }
}

// --- expressions.rs ------------------------------------------------------------------------------

function identifierReferenceMayHaveSideEffects(ident: Node, ctx: SideEffectsContext): boolean {
    switch (ident.name) {
        case 'NaN':
        case 'Infinity':
        case 'undefined':
            return false;
        default:
            // Reading a global may throw or run a getter. TDZ errors are ignored.
            return ctx.unknownGlobalSideEffects && ctx.isGlobalReference(ident) && !isKnownGlobalIdentifier(ident.name);
    }
}

/** oxc `ToPrimitiveResult::is_symbol() != Some(false)`. */
const mayBeSymbol = (result: ToPrimitiveResult): boolean => result === 'undetermined' || result === 'symbol';

/** oxc `ToPrimitiveResult::is_symbol_or_bigint() != Some(false)`. */
const mayBeSymbolOrBigInt = (result: ToPrimitiveResult): boolean =>
    result === 'undetermined' || result === 'symbol' || result === 'bigint';

function templateLiteralMayHaveSideEffects(template: Node, ctx: SideEffectsContext): boolean {
    if (template.type !== N.TemplateLiteral) return true;
    // ToString runs on each substitution and throws on a Symbol. ToPrimitive returns non-objects
    // unchanged, so it stands in for ToString here.
    return template.data.expressions.some(
        (expression) => mayBeSymbol(toPrimitive(expression, ctx)) || mayHaveSideEffects(expression, ctx),
    );
}

function unaryExpressionMayHaveSideEffects(unary: Node, ctx: SideEffectsContext): boolean {
    if (unary.type !== N.UnaryExpression) return true;
    const { operator, argument } = unary.data;
    switch (operator) {
        case 'delete':
            return true;
        case 'void':
        case '!':
            return mayHaveSideEffects(argument, ctx);
        case 'typeof':
            return argument.type === N.IdentifierReference ? false : mayHaveSideEffects(argument, ctx);
        case '+':
            // ToNumber throws on a Symbol or a BigInt.
            return mayBeSymbolOrBigInt(toPrimitive(argument, ctx)) || mayHaveSideEffects(argument, ctx);
        default:
            // `-` and `~`: ToNumeric throws on a Symbol.
            return mayBeSymbol(toPrimitive(argument, ctx)) || mayHaveSideEffects(argument, ctx);
    }
}

function binaryExpressionMayHaveSideEffects(binary: Node, ctx: SideEffectsContext): boolean {
    if (binary.type !== N.BinaryExpression) return true;
    const { operator, left, right } = binary.data;
    switch (operator) {
        case '==':
        case '!=':
        case '===':
        case '!==':
        case '<':
        case '<=':
        case '>':
        case '>=':
            return mayHaveSideEffects(left, ctx) || mayHaveSideEffects(right, ctx);
        case 'instanceof':
            // No TypeError when the right side is a known global constructor and the left side is
            // not a Proxy. Known global non-constructor functions would do too, but are rare.
            if (
                right.type === N.IdentifierReference &&
                isKnownGlobalConstructor(right.name) &&
                ctx.isGlobalReference(right) &&
                valueType(left, ctx) !== 'undetermined'
            ) {
                return false;
            }
            return true;
        case 'in':
            return true;
        case '+': {
            const leftPrimitive = toPrimitive(left, ctx);
            const rightPrimitive = toPrimitive(right, ctx);
            if (leftPrimitive === 'string' || rightPrimitive === 'string') {
                // ToString runs on both sides, and throws on a Symbol.
                const otherSide = leftPrimitive === 'string' ? rightPrimitive : leftPrimitive;
                return mayBeSymbol(otherSide) || mayHaveSideEffects(left, ctx) || mayHaveSideEffects(right, ctx);
            }
            const leftNumeric = primitiveToNumeric(leftPrimitive);
            const rightNumeric = primitiveToNumeric(rightPrimitive);
            if (
                (leftNumeric === 'number' && rightNumeric === 'number') ||
                (leftNumeric === 'bigint' && rightNumeric === 'bigint')
            ) {
                return mayHaveSideEffects(left, ctx) || mayHaveSideEffects(right, ctx);
            }
            return true;
        }
        default: {
            // `-` `*` `/` `%` `<<` `|` `>>` `^` `&` `**` `>>>`
            const leftNumeric = primitiveToNumeric(toPrimitive(left, ctx));
            const rightNumeric = primitiveToNumeric(toPrimitive(right, ctx));
            if (leftNumeric === 'bigint' && rightNumeric === 'bigint') {
                if (operator === '>>>') return true;
                if (operator === '**' || operator === '/' || operator === '%') {
                    if (right.type !== N.BigIntLiteral) return true;
                    const divisor = bigIntLiteralValue(right);
                    if (operator === '**') return divisor < 0n || mayHaveSideEffects(left, ctx);
                    return divisor === 0n || mayHaveSideEffects(left, ctx);
                }
                return mayHaveSideEffects(left, ctx) || mayHaveSideEffects(right, ctx);
            }
            if (leftNumeric === 'number' && rightNumeric === 'number') {
                return mayHaveSideEffects(left, ctx) || mayHaveSideEffects(right, ctx);
            }
            return true;
        }
    }
}

function logicalExpressionMayHaveSideEffects(logical: Node, ctx: SideEffectsContext): boolean {
    if (logical.type !== N.LogicalExpression) return true;
    const { operator, left, right } = logical.data;
    if (mayHaveSideEffects(left, ctx)) return true;
    // typeof x !== 'undefined' && x
    if (operator === '&&' && isSideEffectFreeUnboundIdentifierRef(right, left, true, ctx)) return false;
    // typeof x === 'undefined' || x
    if (operator === '||' && isSideEffectFreeUnboundIdentifierRef(right, left, false, ctx)) return false;
    return mayHaveSideEffects(right, ctx);
}

function arrayExpressionMayHaveSideEffects(array: Node, ctx: SideEffectsContext): boolean {
    if (array.type !== N.ArrayExpression) return true;
    return array.data.elements.some((element) => arrayExpressionElementMayHaveSideEffects(element, ctx));
}

/** oxc `ArrayExpressionElement::may_have_side_effects`; null is an elision. */
export function arrayExpressionElementMayHaveSideEffects(element: Node | null, ctx: SideEffectsContext): boolean {
    if (element === null) return false;
    if (element.type !== N.SpreadElement) return mayHaveSideEffects(element, ctx);
    const argument = element.data.argument;
    switch (argument.type) {
        case N.ArrayExpression:
            return arrayExpressionMayHaveSideEffects(argument, ctx);
        case N.StringLiteral:
            return false;
        case N.TemplateLiteral:
            return templateLiteralMayHaveSideEffects(argument, ctx);
        case N.IdentifierReference:
            // oxc notes `arguments` outside a function should count, and does not yet.
            return !(argument.name === 'arguments' && ctx.isGlobalReference(argument));
        default:
            return true;
    }
}

/** oxc `ObjectPropertyKind::may_have_side_effects`: an `ObjectProperty` or a spread in an object literal. */
export function objectPropertyKindMayHaveSideEffects(property: Node, ctx: SideEffectsContext): boolean {
    if (property.type === N.ObjectProperty) return objectPropertyMayHaveSideEffects(property, ctx);
    if (property.type !== N.SpreadElement) return true;
    const argument = property.data.argument;
    if (ctx.propertyReadSideEffects === 'none') return mayHaveSideEffects(argument, ctx);
    switch (argument.type) {
        case N.ArrayExpression:
            return arrayExpressionMayHaveSideEffects(argument, ctx);
        case N.ObjectExpression:
            return argument.data.properties.some((inner) => {
                if (inner.type === N.ObjectProperty) {
                    return inner.data.kind === 'get' || objectPropertyMayHaveSideEffects(inner, ctx);
                }
                return inner.type !== N.SpreadElement || mayHaveSideEffects(inner.data.argument, ctx);
            });
        case N.StringLiteral:
            return false;
        case N.TemplateLiteral:
            return templateLiteralMayHaveSideEffects(argument, ctx);
        default:
            return true;
    }
}

function objectPropertyMayHaveSideEffects(property: Node, ctx: SideEffectsContext): boolean {
    if (property.type !== N.ObjectProperty) return true;
    return propertyKeyMayHaveSideEffects(property.data.key, ctx) || mayHaveSideEffects(property.data.value, ctx);
}

/** oxc `PropertyKey::may_have_side_effects`. ToPropertyKey on a computed key can throw when ToPrimitive
 *  does, which the ToPrimitive assumption rules out. */
export function propertyKeyMayHaveSideEffects(key: Node, ctx: SideEffectsContext): boolean {
    if (key.type === N.IdentifierName || key.type === N.PrivateIdentifier) return false;
    return mayHaveSideEffects(key, ctx);
}

/** oxc `Class::may_have_side_effects`, after esbuild's `ClassCanBeRemovedIfUnused`. */
function classMayHaveSideEffects(klass: Node, ctx: SideEffectsContext): boolean {
    if (klass.type !== N.ClassExpression && klass.type !== N.ClassDeclaration) return true;
    if (klass.data.decorators.length > 0) return true;
    // Extending something that is neither a constructor nor null throws, but that is assumed away so
    // that classes with a superclass stay removable. An arrow is never a constructor, so it is kept.
    const superClass = klass.data.superClass;
    if (superClass !== null && (superClass.type === N.ArrowFunctionExpression || mayHaveSideEffects(superClass, ctx))) {
        return true;
    }
    return klass.data.body.some((element) => mayHaveSideEffects(element, ctx));
}

/** oxc `ToIntegerIndex` for `f64`. */
function numberToIntegerIndex(value: number): number | null {
    if (value - Math.trunc(value) !== 0 || value < 0) return null;
    return value <= 0xffffffff ? value : null;
}

/** oxc `ToIntegerIndex` for `BigInt`. */
function bigIntToIntegerIndex(value: bigint): number | null {
    if (value < 0n || value > 0xffffffffn) return null;
    return Number(value);
}

/** A string literal's `value` as oxc stores it: a lone surrogate becomes U+FFFD plus four lowercase hex
 *  digits, and a literal U+FFFD in such a string becomes U+FFFD plus `fffd`. */
function oxcStringLiteralValue(literal: Node): string {
    const cooked = stringLiteralValue(literal);
    if (!cooked.loneSurrogates) return cooked.value;
    let encoded = '';
    for (const char of cooked.value) {
        const code = char.charCodeAt(0);
        if (char.length === 1 && code >= 0xd800 && code <= 0xdfff) encoded += `�${code.toString(16)}`;
        else if (code === 0xfffd) encoded += '�fffd';
        else encoded += char;
    }
    return encoded;
}

/** oxc `TemplateLiteral::single_quasi`: the cooked text of a template with no substitutions. */
function singleQuasi(template: Node): string | null {
    if (template.type !== N.TemplateLiteral || template.data.quasis.length !== 1) return null;
    return templateElementCooked(template.data.quasis[0])?.value ?? null;
}

function computedMemberExpressionMayHaveSideEffects(member: Node, ctx: SideEffectsContext): boolean {
    if (member.type !== N.ComputedMemberExpression) return true;
    const { object, expression } = member.data;
    switch (expression.type) {
        case N.StringLiteral:
            return propertyAccessMayHaveSideEffects(object, oxcStringLiteralValue(expression), ctx);
        case N.TemplateLiteral: {
            const quasi = singleQuasi(expression);
            return quasi === null || propertyAccessMayHaveSideEffects(object, quasi, ctx);
        }
        case N.NumericLiteral: {
            const index = numberToIntegerIndex(numericLiteralValue(expression));
            return index === null || integerIndexPropertyAccessMayHaveSideEffects(object, index, ctx);
        }
        case N.BigIntLiteral: {
            const value = bigIntLiteralValue(expression);
            if (value < 0n) return true;
            const index = bigIntToIntegerIndex(value);
            return index === null || integerIndexPropertyAccessMayHaveSideEffects(object, index, ctx);
        }
        default:
            // A non-literal key may run `toString`/`valueOf` on the key. With property reads assumed
            // pure, only the key and the object themselves are checked.
            if (ctx.propertyReadSideEffects === 'none') {
                return mayHaveSideEffects(expression, ctx) || mayHaveSideEffects(object, ctx);
            }
            return true;
    }
}

function propertyAccessMayHaveSideEffects(object: Node, property: string, ctx: SideEffectsContext): boolean {
    if (mayHaveSideEffects(object, ctx)) return true;
    if (ctx.propertyReadSideEffects === 'none') return false;

    // Known global property reads (`Math.PI`, `console.log`).
    if (object.type === N.IdentifierReference && ctx.isGlobalReference(object) && isKnownGlobalProperty(object.name, property)) {
        return false;
    }

    // Known three-level chains (`Object.prototype.hasOwnProperty`).
    if (object.type === N.StaticMemberExpression) {
        const root = object.data.object;
        if (
            root.type === N.IdentifierReference &&
            ctx.isGlobalReference(root) &&
            isKnownGlobalPropertyDeep(root.name, object.data.property.name, property)
        ) {
            return false;
        }
    }

    if (property === 'length') return !(object.type === N.ArrayExpression || valueType(object, ctx) === 'string');
    return true;
}

function integerIndexPropertyAccessMayHaveSideEffects(object: Node, property: number, ctx: SideEffectsContext): boolean {
    if (mayHaveSideEffects(object, ctx)) return true;
    if (ctx.propertyReadSideEffects === 'none') return false;
    switch (object.type) {
        case N.StringLiteral:
            return property >= oxcStringLiteralValue(object).length;
        case N.ArrayExpression:
            return property >= getArrayMinimumLength(object);
        default:
            return true;
    }
}

function getArrayMinimumLength(array: Node): number {
    if (array.type !== N.ArrayExpression) return 0;
    let length = 0;
    for (const element of array.data.elements) {
        if (element === null || element.type !== N.SpreadElement) {
            length += 1;
            continue;
        }
        const argument = element.data.argument;
        if (argument.type === N.ArrayExpression) length += getArrayMinimumLength(argument);
        // Rust `chars().count()`: code points.
        else if (argument.type === N.StringLiteral) length += Array.from(oxcStringLiteralValue(argument)).length;
    }
    return length;
}

/** oxc `iife_call_may_have_side_effects`: null when the callee is not a plain function or arrow literal.
 *  An IIFE binds its parameters and runs its body once, so it is side-effect-free when its arguments,
 *  parameter bindings and body statements are. Async and generator callees are left to the caller. */
function iifeCallMayHaveSideEffects(call: Node, ctx: SideEffectsContext): boolean | null {
    if (call.type !== N.CallExpression) return null;
    const callee = call.data.callee;
    let params: Node[];
    let bodyMayHaveSideEffects: boolean;
    if (callee.type === N.FunctionExpression && !callee.data.async && !callee.data.generator) {
        const body = callee.data.body;
        if (body === null || body.type !== N.BlockStatement) return null;
        params = callee.data.params;
        bodyMayHaveSideEffects = body.data.body.some((statement) => mayHaveSideEffects(statement, ctx));
    } else if (callee.type === N.ArrowFunctionExpression && !callee.data.async) {
        const body = callee.data.body;
        params = callee.data.params;
        bodyMayHaveSideEffects =
            body.type === N.BlockStatement
                ? body.data.body.some((statement) => mayHaveSideEffects(statement, ctx))
                : mayHaveSideEffects(body, ctx);
    } else {
        return null;
    }

    // Binding the parameters must run no user code: bare identifiers with no default, and a rest
    // binding only to an identifier.
    const paramsSimple = params.every((param) => {
        if (param.type === N.FormalParameter) return param.data.pattern.type === N.BindingIdentifier && param.data.init === null;
        if (param.type === N.RestElement) return param.data.argument.type === N.BindingIdentifier;
        return false;
    });
    if (!paramsSimple || call.data.arguments.some((argument) => argumentMayHaveSideEffects(argument, ctx))) return true;
    return bodyMayHaveSideEffects;
}

const anyArgumentMayHaveSideEffects = (args: Node[], ctx: SideEffectsContext): boolean =>
    args.some((argument) => argumentMayHaveSideEffects(argument, ctx));

/** oxc `Expression::get_identifier_reference`. */
function getIdentifierReference(expr: Node): Node | null {
    const inner = getInnerExpression(expr);
    return inner.type === N.IdentifierReference ? inner : null;
}

// `PF` in rollup's `knownGlobals.ts`.
function callExpressionMayHaveSideEffects(call: Node, ctx: SideEffectsContext): boolean {
    if (call.type !== N.CallExpression) return true;
    const { callee, arguments: args } = call.data;
    if ((call.data.pure && ctx.annotations) || ctx.manualPureFunctions(callee)) return anyArgumentMayHaveSideEffects(args, ctx);

    // A `/* @__PURE__ */` IIFE was already handled above.
    const iifeSideEffects = iifeCallMayHaveSideEffects(call, ctx);
    if (iifeSideEffects !== null) return iifeSideEffects;

    if (callee.type === N.IdentifierReference && ctx.isGlobalReference(callee)) {
        const name = callee.name;
        // `Number(Symbol())` throws in ToNumeric, `Symbol(Symbol())` and `Error(Symbol())` in ToString.
        // ToPrimitive on objects is assumed pure.
        if (name === 'Number' || name === 'Symbol' || isErrorConstructor(name)) {
            if (anyArgumentMayHaveSideEffects(args, ctx)) return true;
            const first = args[0];
            return first !== undefined && (first.type === N.SpreadElement || mayBeSymbol(toPrimitive(first, ctx)));
        }
        if (name === 'BigInt') {
            if (anyArgumentMayHaveSideEffects(args, ctx)) return true;
            // BigInt throws for a missing or invalid value, and ToPrimitive can run user code.
            const first = args[0];
            if (first === undefined || first.type === N.SpreadElement) return true;
            const primitive = toPrimitive(first, ctx);
            if (primitive === 'undetermined' || primitive === 'undefined' || primitive === 'null' || primitive === 'symbol') {
                return true;
            }
            return toBigInt(first, ctx) === null;
        }
        if (isPureGlobalFunction(name) || isPureCallableConstructor(name) || (name === 'RegExp' && isValidRegExp(args, ctx))) {
            if (anyArgumentMayHaveSideEffects(args, ctx)) return true;
            // `isNaN`/`isFinite` coerce with ToNumber, which throws on a BigInt. The other pure globals
            // coerce with ToString, which accepts one.
            return (name === 'isNaN' || name === 'isFinite') && anyArgumentThrowsToNumber(args, ctx);
        }
    }

    let objectExpression: Node;
    let name: string;
    if (callee.type === N.StaticMemberExpression && !callee.data.optional) {
        objectExpression = callee.data.object;
        name = callee.data.property.name;
    } else if (callee.type === N.ComputedMemberExpression && !callee.data.optional) {
        if (callee.data.expression.type !== N.StringLiteral) return true;
        objectExpression = callee.data.object;
        name = oxcStringLiteralValue(callee.data.expression);
    } else {
        return true;
    }

    const object = getIdentifierReference(objectExpression);
    if (object === null || !ctx.isGlobalReference(object)) return true;

    if (isPureGlobalMethodCall(object.name, name)) {
        if (anyArgumentMayHaveSideEffects(args, ctx)) return true;
        // ToNumber-coercing methods throw on a BigInt argument.
        const coercesToNumber =
            object.name === 'Math' ||
            (object.name === 'Date' && name === 'UTC') ||
            (object.name === 'String' && (name === 'fromCharCode' || name === 'fromCodePoint'));
        if (coercesToNumber && anyArgumentThrowsToNumber(args, ctx)) return true;
        // `String.fromCodePoint` also throws a RangeError unless every code point is an integer in [0, 0x10FFFF].
        if (
            object.name === 'String' &&
            name === 'fromCodePoint' &&
            args.some((argument) => argument.type !== N.SpreadElement && isInvalidCodePointLiteral(argument))
        ) {
            return true;
        }
        // `URL.canParse` has a required first argument.
        return object.name === 'URL' && name === 'canParse' && args.length === 0;
    }

    if (object.name !== 'Object') return true;

    // `Object` static methods that run no user code but whose purity depends on their arguments.
    switch (name) {
        // These introspect their first argument through internal methods a Proxy can trap, but never
        // `[[Get]]`, so no getter runs on a plain object. A null or undefined target throws in ToObject.
        case 'getOwnPropertyDescriptor':
        case 'getOwnPropertyDescriptors':
        case 'getOwnPropertyNames':
        case 'getOwnPropertySymbols':
        case 'getPrototypeOf':
        case 'hasOwn':
        case 'keys': {
            if (anyArgumentMayHaveSideEffects(args, ctx)) return true;
            // A missing or spread target is an `undefined` receiver, and ToObject throws.
            const first = args[0];
            if (first === undefined || first.type === N.SpreadElement) return true;
            const firstType = valueType(first, ctx);
            if (firstType === 'null' || firstType === 'undefined') return true;
            if (ctx.propertyReadSideEffects === 'none') return false;
            // An undetermined value could be a Proxy with an observable trap.
            return firstType === 'undetermined';
        }
        // These never ToObject their target, so a non-object returns a primitive without throwing. An
        // object target still fires Proxy traps, but never `[[Get]]`.
        case 'isExtensible':
        case 'isFrozen':
        case 'isSealed': {
            if (anyArgumentMayHaveSideEffects(args, ctx)) return true;
            // No arguments is an `undefined` receiver; a leading spread could place a Proxy here.
            const first = args[0];
            if (first === undefined || first.type === N.SpreadElement) return args.length > 0;
            if (ctx.propertyReadSideEffects === 'none') return false;
            return valueType(first, ctx) === 'undetermined';
        }
        // `Object.create(proto)` runs no user code and is pure when `proto` is an object or null (else
        // TypeError) and there is no `properties` argument (which is read with `[[Get]]`).
        case 'create': {
            if (anyArgumentMayHaveSideEffects(args, ctx)) return true;
            if (args.length === 1 && args[0].type !== N.SpreadElement) {
                const protoType = valueType(args[0], ctx);
                if (protoType === 'object' || protoType === 'null') return false;
            }
            return true;
        }
        default:
            return true;
    }
}

/** Whether any argument is provably a BigInt, for which ToNumber throws. A Symbol throws too, but a value
 *  is never provably a Symbol, so (as in esbuild) `Math.abs(x)` stays droppable. */
const anyArgumentThrowsToNumber = (args: Node[], ctx: SideEffectsContext): boolean =>
    args.some((argument) => argument.type !== N.SpreadElement && valueType(argument, ctx) === 'bigint');

/** A numeric literal, optionally negated, that is not an integer in [0, 0x10FFFF]. Anything else is
 *  left droppable, and a BigInt is `anyArgumentThrowsToNumber`'s. */
function isInvalidCodePointLiteral(expr: Node): boolean {
    let value: number;
    if (expr.type === N.NumericLiteral) value = numericLiteralValue(expr);
    else if (expr.type === N.UnaryExpression && expr.data.operator === '-' && expr.data.argument.type === N.NumericLiteral) {
        value = -numericLiteralValue(expr.data.argument);
    } else {
        return false;
    }
    return !(value - Math.trunc(value) === 0 && value >= 0 && value <= 1_114_111);
}

/** Whether the first argument may produce a Symbol from ToPrimitive, for which ToString and ToNumber
 *  throw. Used for `new String(arg)`, `new Number(arg)` and the Error constructors. */
function newExpressionFirstArgumentMayBeSymbol(args: Node[], ctx: SideEffectsContext): boolean {
    if (anyArgumentMayHaveSideEffects(args, ctx)) return true;
    const first = args[0];
    return first !== undefined && (first.type === N.SpreadElement || mayBeSymbol(toPrimitive(first, ctx)));
}

/** As {@link newExpressionFirstArgumentMayBeSymbol}, and also a BigInt, for which ToNumber throws. Used for
 *  `new Date(arg)` and `new ArrayBuffer(arg)`. */
function newExpressionFirstArgumentMayBeSymbolOrBigInt(args: Node[], ctx: SideEffectsContext): boolean {
    if (anyArgumentMayHaveSideEffects(args, ctx)) return true;
    const first = args[0];
    return first !== undefined && (first.type === N.SpreadElement || mayBeSymbolOrBigInt(toPrimitive(first, ctx)));
}

// `[ValueProperties]: PURE` in rollup's `knownGlobals.ts`.
function newExpressionMayHaveSideEffects(expr: Node, ctx: SideEffectsContext): boolean {
    if (expr.type !== N.NewExpression) return true;
    const { callee, arguments: args } = expr.data;
    if ((expr.data.pure && ctx.annotations) || ctx.manualPureFunctions(callee)) return anyArgumentMayHaveSideEffects(args, ctx);
    if (callee.type !== N.IdentifierReference || !ctx.isGlobalReference(callee)) return true;
    const name = callee.name;
    switch (name) {
        // ToString and ToNumeric throw on a Symbol. A BigInt is fine for both.
        case 'String':
        case 'Number':
            return newExpressionFirstArgumentMayBeSymbol(args, ctx);
        // ToNumber (after ToPrimitive, or through ToIndex) throws on a Symbol or a BigInt.
        case 'Date':
        case 'ArrayBuffer':
            return newExpressionFirstArgumentMayBeSymbolOrBigInt(args, ctx);
    }
    // ToString on the message throws on a Symbol.
    if (isErrorConstructor(name)) return newExpressionFirstArgumentMayBeSymbol(args, ctx);
    if (isTypedArrayConstructor(name)) {
        // An object argument is iterated and a BigInt throws in ToNumber, so only known primitives pass.
        if (anyArgumentMayHaveSideEffects(args, ctx)) return true;
        const first = args[0];
        if (first === undefined) return false;
        if (first.type === N.SpreadElement) return true;
        const firstType = valueType(first, ctx);
        return !(
            firstType === 'number' ||
            firstType === 'string' ||
            firstType === 'boolean' ||
            firstType === 'null' ||
            firstType === 'undefined'
        );
    }
    if (
        isUnconditionallyPureConstructor(name) ||
        (name === 'RegExp' && isValidRegExp(args, ctx)) ||
        isPureCollectionConstructor(name, args, ctx)
    ) {
        return anyArgumentMayHaveSideEffects(args, ctx);
    }
    return true;
}

/** oxc `Argument::may_have_side_effects`: a call or `new` argument, which may be a spread. */
export function argumentMayHaveSideEffects(argument: Node, ctx: SideEffectsContext): boolean {
    if (argument.type !== N.SpreadElement) return mayHaveSideEffects(argument, ctx);
    const spread = argument.data.argument;
    switch (spread.type) {
        case N.ArrayExpression:
            return arrayExpressionMayHaveSideEffects(spread, ctx);
        case N.StringLiteral:
            return false;
        case N.TemplateLiteral:
            return templateLiteralMayHaveSideEffects(spread, ctx);
        default:
            return true;
    }
}

/** oxc `AssignmentTarget::may_have_side_effects`: only the evaluation of the target, not its PutValue. */
export function assignmentTargetMayHaveSideEffects(target: Node, ctx: SideEffectsContext): boolean {
    switch (target.type) {
        case N.IdentifierReference:
            return false;
        case N.StaticMemberExpression:
            return mayHaveSideEffects(target.data.object, ctx);
        case N.ComputedMemberExpression:
            return mayHaveSideEffects(target.data.object, ctx) || mayHaveSideEffects(target.data.expression, ctx);
        case N.PrivateFieldExpression:
            return mayHaveSideEffects(target.data.object, ctx);
        default:
            // Destructuring targets and TS-wrapped targets.
            return true;
    }
}

/** oxc `is_side_effect_free_unbound_identifier_ref`, after esbuild: whether reading the global `value`
 *  is safe because `guardCondition` proved it defined on this branch, as in `typeof x !== 'undefined' && x`
 *  or `typeof x < 'u' && x`. */
function isSideEffectFreeUnboundIdentifierRef(
    value: Node,
    guardCondition: Node,
    isYesBranch: boolean,
    ctx: SideEffectsContext,
): boolean {
    const ident = getIdentifierReference(value);
    if (ident === null || !ctx.isGlobalReference(ident)) return false;
    if (guardCondition.type !== N.BinaryExpression) return false;
    const { operator } = guardCondition.data;
    let typeofSide = guardCondition.data.left;
    let stringSide = guardCondition.data.right;
    switch (operator) {
        case '===':
        case '!==':
        case '==':
        case '!=': {
            if (typeofSide.type === N.StringLiteral) [typeofSide, stringSide] = [stringSide, typeofSide];
            if (!isTypeofIdentifier(typeofSide) || stringSide.type !== N.StringLiteral) return false;
            const isUndefinedCheck = stringLiteralValue(stringSide).value === 'undefined';
            return (
                (isUndefinedCheck === isYesBranch) === (operator === '!=' || operator === '!==') &&
                isSpecificId(typeofSide.data.argument, ident.name)
            );
        }
        case '<':
        case '<=':
        case '>':
        case '>=': {
            let yesBranch = isYesBranch;
            if (typeofSide.type === N.StringLiteral) {
                [typeofSide, stringSide] = [stringSide, typeofSide];
                yesBranch = !yesBranch;
            }
            if (!isTypeofIdentifier(typeofSide) || stringSide.type !== N.StringLiteral) return false;
            if (stringLiteralValue(stringSide).value !== 'u') return false;
            return yesBranch === (operator === '<' || operator === '<=') && isSpecificId(typeofSide.data.argument, ident.name);
        }
        default:
            return false;
    }
}

function isTypeofIdentifier(expr: Node): expr is Extract<Node, { type: typeof N.UnaryExpression }> {
    return (
        expr.type === N.UnaryExpression && expr.data.operator === 'typeof' && expr.data.argument.type === N.IdentifierReference
    );
}

/** oxc `Expression::is_specific_id`. */
function isSpecificId(expr: Node, name: string): boolean {
    const inner = getInnerExpression(expr);
    return inner.type === N.IdentifierReference && inner.name === name;
}

function assignmentExpressionMayHaveSideEffects(assignment: Node, ctx: SideEffectsContext): boolean {
    if (assignment.type !== N.AssignmentExpression) return true;
    if (ctx.propertyWriteSideEffects) return true;
    // A compound assignment reads the target (a getter or Proxy may run) and coerces (ToPrimitive may
    // run user code or throw), so only `=` benefits from property writes being side-effect-free.
    if (assignment.data.operator !== '=') return true;
    const { left, right } = assignment.data;
    // Member writes are free; writes to variables and destructuring targets are not.
    switch (left.type) {
        case N.StaticMemberExpression:
        case N.PrivateFieldExpression:
            return mayHaveSideEffects(left.data.object, ctx) || mayHaveSideEffects(right, ctx);
        case N.ComputedMemberExpression:
            return (
                mayHaveSideEffects(left.data.object, ctx) ||
                mayHaveSideEffects(left.data.expression, ctx) ||
                mayHaveSideEffects(right, ctx)
            );
        default:
            return true;
    }
}

// --- statements.rs -------------------------------------------------------------------------------

function tryStatementMayHaveSideEffects(statement: Node, ctx: SideEffectsContext): boolean {
    if (statement.type !== N.TryStatement) return true;
    const { block, handler, finalizer } = statement.data;
    if (mayHaveSideEffects(block, ctx)) return true;
    if (handler !== null && handler.type === N.CatchClause) {
        if (handler.data.param !== null && mayHaveSideEffects(handler.data.param, ctx)) return true;
        if (mayHaveSideEffects(handler.data.body, ctx)) return true;
    }
    return finalizer !== null && mayHaveSideEffects(finalizer, ctx);
}

function variableDeclarationMayHaveSideEffects(declaration: Node, ctx: SideEffectsContext): boolean {
    if (declaration.type !== N.VariableDeclaration) return true;
    const { kind, declarations } = declaration.data;
    if (kind === 'await using') return true;
    if (kind === 'using') {
        return declarations.some((declarator) => {
            if (declarator.type !== N.VariableDeclarator) return true;
            const init = declarator.data.init;
            if (init === null) return true;
            const initType = valueType(init, ctx);
            return !(initType === 'null' || initType === 'undefined') || mayHaveSideEffects(init, ctx);
        });
    }
    return declarations.some(
        (declarator) =>
            declarator.type !== N.VariableDeclarator ||
            mayHaveSideEffects(declarator.data.id, ctx) ||
            (declarator.data.init !== null && mayHaveSideEffects(declarator.data.init, ctx)),
    );
}

// --- pure_function.rs ----------------------------------------------------------------------------

/**
 * oxc `is_pure_function`: whether `callee` matches one of `pureFunctions`, each a name or a dotted path.
 * `["console.log"]` matches `console.log()`, a property of it (`console.log.foo()`), a function it
 * returns (`console.log()()`), and a property of that (`console.log().foo()`).
 */
export function isPureFunction(callee: Node, pureFunctions: readonly string[]): boolean {
    if (pureFunctions.length === 0) return false;
    const pathParts = extractCalleePath(callee);
    if (pathParts === null) return false;
    return pureFunctions.some((pureFunction) => isPathMatch(pathParts, pureFunction));
}

/** The callee's path, outermost part first, or null when it has a non-string computed part. A call
 *  seals the path: everything after it is an extension of what it returns. */
function extractCalleePath(callee: Node): string[] | null {
    const pathParts: string[] = [];
    let current = callee;
    for (;;) {
        switch (current.type) {
            case N.IdentifierReference:
                pathParts.push(current.name);
                return pathParts;
            case N.StaticMemberExpression:
                pathParts.push(current.data.property.name);
                current = current.data.object;
                break;
            case N.ComputedMemberExpression:
                if (current.data.expression.type !== N.StringLiteral) return null;
                pathParts.push(oxcStringLiteralValue(current.data.expression));
                current = current.data.object;
                break;
            case N.CallExpression:
                pathParts.length = 0;
                current = current.data.callee;
                break;
            case N.ChainExpression: {
                const element = current.data.expression;
                switch (element.type) {
                    case N.StaticMemberExpression:
                        pathParts.push(element.data.property.name);
                        current = element.data.object;
                        break;
                    case N.ComputedMemberExpression:
                        if (element.data.expression.type !== N.StringLiteral) return null;
                        pathParts.push(oxcStringLiteralValue(element.data.expression));
                        current = element.data.object;
                        break;
                    case N.CallExpression:
                        pathParts.length = 0;
                        current = element.data.callee;
                        break;
                    case N.TSNonNullExpression:
                        current = element.data.expression;
                        break;
                    default:
                        return null;
                }
                break;
            }
            default:
                return null;
        }
    }
}

/** Whether `pureFunction`, a dotted path, is a prefix of the callee's path. */
function isPathMatch(pathParts: string[], pureFunction: string): boolean {
    const pureParts = pureFunction.split('.');
    if (pureParts.length > pathParts.length) return false;
    return pureParts.every((part, index) => part === pathParts[pathParts.length - 1 - index]);
}

// --- known_globals.rs ----------------------------------------------------------------------------

const supportsEsFeature = (ctx: SideEffectsContext, feature: EsFeature): boolean =>
    ctx.engineTargets?.supportsEsFeature(feature) === true;

/**
 * oxc `is_valid_regexp`: whether `RegExp(...args)` / `new RegExp(...args)` cannot throw on the target
 * engines. Constructor calls are a common feature test, so newer syntax a modern parser accepts still
 * counts as throwing unless every target supports it.
 */
export function isValidRegExp(args: Node[], ctx: SideEffectsContext): boolean {
    let pattern = '';
    let isRegExpLiteral = false;
    const first = args[0];
    if (first !== undefined) {
        if (first.type === N.RegExpLiteral) {
            // Already a valid pattern. Replacement flags are validated below, since support for that
            // constructor form varies by target.
            isRegExpLiteral = true;
        } else if (first.type === N.StringLiteral) {
            const literal = stringLiteralValue(first);
            if (literal.loneSurrogates) return false;
            pattern = literal.value;
        } else {
            return false;
        }
    }

    let flags: string | null = null;
    const second = args[1];
    if (second !== undefined) {
        if (second.type !== N.StringLiteral) return false;
        flags = oxcStringLiteralValue(second);
    }

    if (isRegExpLiteral) {
        // ES5 throws whenever a RegExp object and flags are both supplied.
        return (
            regExpFlagsAreSupported(flags ?? '', ctx) &&
            (flags === null || supportsEsFeature(ctx, 'ES2015RegExpConstructorCanAlterFlags'))
        );
    }

    return isRegExpPatternValid(pattern, flags) && isRegExpSyntaxSupported(pattern, flags ?? '', ctx);
}

const REGEXP_FLAG_CHARS = 'dgimsuvy';

/**
 * oxc's `LiteralParser::parse().is_ok()`. oxc runs its own ECMAScript RegExp parser (with Annex B);
 * the host engine's parser implements the same grammar, so it stands in for it here. The flags are
 * checked first, the way oxc's `FlagsParser` does, so the verdict never depends on host flag support.
 */
function isRegExpPatternValid(pattern: string, flags: string | null): boolean {
    if (flags !== null) {
        let seen = '';
        for (const flag of flags) {
            if (!REGEXP_FLAG_CHARS.includes(flag) || seen.includes(flag)) return false;
            seen += flag;
        }
        if (seen.includes('u') && seen.includes('v')) return false;
    }
    try {
        new RegExp(pattern, flags ?? '');
        return true;
    } catch {
        return false;
    }
}

/** oxc `is_regexp_syntax_supported`: whether every target supports the flags and pattern syntax of a
 *  pattern already known to be valid. */
export function isRegExpSyntaxSupported(pattern: string, flags: string, ctx: SideEffectsContext): boolean {
    if (!regExpFlagsAreSupported(flags, ctx)) return false;
    const features = scanRegExpPatternFeatures(pattern, flags.includes('u') || flags.includes('v'), flags.includes('v'));
    return !(
        (features.namedCaptureGroups && !supportsEsFeature(ctx, 'ES2018NamedCapturingGroupsRegex')) ||
        (features.duplicateNamedCaptureGroups && !supportsEsFeature(ctx, 'ES2025DuplicateNamedCapturingGroupsRegex')) ||
        (features.unicodePropertyEscapes && !supportsEsFeature(ctx, 'ES2018UnicodePropertyRegex')) ||
        (features.lookBehindAssertions && !supportsEsFeature(ctx, 'ES2018LookbehindRegex')) ||
        (features.patternModifiers && !supportsEsFeature(ctx, 'ES2025RegexpModifiers'))
    );
}

/** oxc `has_unsupported_regular_expression_flags`, negated. */
function regExpFlagsAreSupported(flags: string, ctx: SideEffectsContext): boolean {
    let seen = '';
    for (const flag of flags) {
        let unsupported: boolean;
        switch (flag) {
            case 'g':
            case 'i':
            case 'm':
                unsupported = false;
                break;
            case 'y':
                unsupported = !supportsEsFeature(ctx, 'ES2015StickyRegex');
                break;
            case 'u':
                unsupported = !supportsEsFeature(ctx, 'ES2015UnicodeRegex');
                break;
            case 's':
                unsupported = !supportsEsFeature(ctx, 'ES2018DotallRegex');
                break;
            case 'd':
                unsupported = !supportsEsFeature(ctx, 'ES2022MatchIndicesRegex');
                break;
            case 'v':
                unsupported = !supportsEsFeature(ctx, 'ES2024UnicodeSetsRegex');
                break;
            default:
                return false;
        }
        if (unsupported || seen.includes(flag)) return false;
        seen += flag;
    }
    return !(seen.includes('u') && seen.includes('v'));
}

type RegExpPatternFeatures = {
    namedCaptureGroups: boolean;
    duplicateNamedCaptureGroups: boolean;
    unicodePropertyEscapes: boolean;
    lookBehindAssertions: boolean;
    patternModifiers: boolean;
};

/**
 * The syntax oxc's `has_unsupported_regular_expression_pattern` looks for in the parsed pattern, found by
 * scanning a pattern already known to be valid: `(?<name>` groups (and repeated names), `(?<=`/`(?<!`,
 * `\p{..}`/`\P{..}` (escapes only in unicode mode, at top level or in a class), and `(?ims-ims:` groups.
 */
function scanRegExpPatternFeatures(pattern: string, unicodeMode: boolean, unicodeSetsMode: boolean): RegExpPatternFeatures {
    const features: RegExpPatternFeatures = {
        namedCaptureGroups: false,
        duplicateNamedCaptureGroups: false,
        unicodePropertyEscapes: false,
        lookBehindAssertions: false,
        patternModifiers: false,
    };
    const groupNames = new Set<string>();
    let index = 0;
    while (index < pattern.length) {
        const char = pattern[index];
        if (char === '\\') {
            const escaped = pattern[index + 1];
            if (unicodeMode && (escaped === 'p' || escaped === 'P')) features.unicodePropertyEscapes = true;
            index += 2;
            continue;
        }
        if (char === '[') {
            index = scanCharacterClass(pattern, index + 1, unicodeMode, unicodeSetsMode, features);
            continue;
        }
        if (char === '(' && pattern[index + 1] === '?') {
            const kind = pattern[index + 2];
            if (kind === '<') {
                const next = pattern[index + 3];
                if (next === '=' || next === '!') {
                    features.lookBehindAssertions = true;
                } else {
                    const close = pattern.indexOf('>', index + 3);
                    const name = decodeGroupName(pattern.slice(index + 3, close));
                    features.namedCaptureGroups = true;
                    if (groupNames.has(name)) features.duplicateNamedCaptureGroups = true;
                    groupNames.add(name);
                    index = close + 1;
                    continue;
                }
            } else if (kind !== ':' && kind !== '=' && kind !== '!') {
                features.patternModifiers = true;
            }
        }
        index++;
    }
    return features;
}

/** Skip a character class body starting after its `[`, returning the index after its `]`. Classes nest
 *  only in unicode-sets mode. */
function scanCharacterClass(
    pattern: string,
    start: number,
    unicodeMode: boolean,
    unicodeSetsMode: boolean,
    features: RegExpPatternFeatures,
): number {
    let index = start;
    while (index < pattern.length) {
        const char = pattern[index];
        if (char === '\\') {
            const escaped = pattern[index + 1];
            if (unicodeMode && (escaped === 'p' || escaped === 'P')) features.unicodePropertyEscapes = true;
            index += 2;
            continue;
        }
        if (char === ']') return index + 1;
        if (char === '[' && unicodeSetsMode) {
            index = scanCharacterClass(pattern, index + 1, unicodeMode, unicodeSetsMode, features);
            continue;
        }
        index++;
    }
    return index;
}

/** A group name with its `\uXXXX` and `\u{X}` escapes decoded. */
const decodeGroupName = (name: string): string =>
    name.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g, (_match, braced: string | undefined, fixed: string | undefined) =>
        String.fromCodePoint(Number.parseInt(braced ?? fixed ?? '0', 16)),
    );

const isPureGlobalFunction = (name: string): boolean => PURE_GLOBAL_FUNCTIONS.has(name);

const PURE_GLOBAL_FUNCTIONS = new Set([
    'decodeURI',
    'decodeURIComponent',
    'encodeURI',
    'encodeURIComponent',
    'escape',
    'isFinite',
    'isNaN',
    'parseFloat',
    'parseInt',
]);

/** Constructors that are side-effect-free called as functions, given side-effect-free arguments.
 *  `Number`, `Symbol`, `BigInt` and the Error types need argument checks and are handled separately.
 *  `String(Symbol())` does not throw, and `Date()` ignores its arguments. */
const isPureCallableConstructor = (name: string): boolean =>
    name === 'Date' || name === 'Boolean' || name === 'Object' || name === 'String';

/** Constructors that are side-effect-free with any arguments: `Object` wraps or returns its argument,
 *  and ToBoolean runs no user code. */
const isUnconditionallyPureConstructor = (name: string): boolean => name === 'Object' || name === 'Boolean';

const isErrorConstructor = (name: string): boolean => ERROR_CONSTRUCTORS.has(name);

const ERROR_CONSTRUCTORS = new Set([
    'Error',
    'EvalError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'TypeError',
    'URIError',
]);

/** oxc `is_typed_array_constructor`. */
export const isTypedArrayConstructor = (name: string): boolean => TYPED_ARRAY_CONSTRUCTORS.has(name);

const TYPED_ARRAY_CONSTRUCTORS = new Set([
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array',
]);

/** `Map`/`Set`/`WeakMap`/`WeakSet` iterate their argument, which can run user code, so (as in esbuild and
 *  rollup) only no argument, null, undefined or an array literal is pure, and for the maps every element
 *  must itself be an array literal. */
function isPureCollectionConstructor(name: string, args: Node[], ctx: SideEffectsContext): boolean {
    if (!(name === 'Set' || name === 'Map' || name === 'WeakSet' || name === 'WeakMap')) return false;
    const first = args[0];
    if (first === undefined) return true;
    switch (first.type) {
        case N.NullLiteral:
            return true;
        case N.IdentifierReference:
            return first.name === 'undefined' && ctx.isGlobalReference(first);
        case N.ArrayExpression:
            if (name === 'Map' || name === 'WeakMap') {
                return first.data.elements.every((element) => element !== null && element.type === N.ArrayExpression);
            }
            return true;
        default:
            return false;
    }
}

const isKnownGlobalConstructor = (name: string): boolean => KNOWN_GLOBAL_CONSTRUCTORS.has(name);

const wordSet = (words: string): Set<string> => new Set(words.split(/\s+/).filter((word) => word !== ''));

const KNOWN_GLOBAL_CONSTRUCTORS = wordSet(`
    AggregateError Array ArrayBuffer BigInt BigInt64Array BigUint64Array Boolean DataView Date Error
    EvalError FinalizationRegistry Float32Array Float64Array Function Int8Array Int16Array Int32Array
    Iterator Map Number Object Promise Proxy RangeError ReferenceError RegExp Set SharedArrayBuffer
    String Symbol SyntaxError TypeError Uint8Array Uint8ClampedArray Uint16Array Uint32Array URIError
    WeakMap WeakSet
`);

/** Globals that are side-effect-free to read: rolldown's `GLOBAL_IDENT`, after rollup's `knownGlobals`,
 *  host APIs included. `NaN`, `Infinity` and `undefined` are handled before this is consulted. */
const isKnownGlobalIdentifier = (name: string): boolean => KNOWN_GLOBAL_IDENTIFIERS.has(name);

const KNOWN_GLOBAL_IDENTIFIERS = wordSet(`
    Array Boolean Function Math Number Object RegExp String

    AbortController AbortSignal AggregateError ArrayBuffer BigInt DataView Date Error EvalError Event
    EventTarget Float32Array Float64Array Int16Array Int32Array Int8Array Intl JSON Map MessageChannel
    MessageEvent MessagePort Promise Proxy RangeError ReferenceError Reflect Set Symbol SyntaxError
    TextDecoder TextEncoder TypeError URIError URL URLSearchParams Uint16Array Uint32Array Uint8Array
    Uint8ClampedArray WeakMap WeakSet WebAssembly clearInterval clearTimeout console decodeURI
    decodeURIComponent encodeURI encodeURIComponent escape globalThis isFinite isNaN parseFloat parseInt
    queueMicrotask setInterval setTimeout unescape

    CSSAnimation CSSFontFaceRule CSSImportRule CSSKeyframeRule CSSKeyframesRule CSSMediaRule
    CSSNamespaceRule CSSPageRule CSSRule CSSRuleList CSSStyleDeclaration CSSStyleRule CSSStyleSheet
    CSSSupportsRule CSSTransition

    SVGAElement SVGAngle SVGAnimateElement SVGAnimateMotionElement SVGAnimateTransformElement
    SVGAnimatedAngle SVGAnimatedBoolean SVGAnimatedEnumeration SVGAnimatedInteger SVGAnimatedLength
    SVGAnimatedLengthList SVGAnimatedNumber SVGAnimatedNumberList SVGAnimatedPreserveAspectRatio
    SVGAnimatedRect SVGAnimatedString SVGAnimatedTransformList SVGAnimationElement SVGCircleElement
    SVGClipPathElement SVGComponentTransferFunctionElement SVGDefsElement SVGDescElement SVGElement
    SVGEllipseElement SVGFEBlendElement SVGFEColorMatrixElement SVGFEComponentTransferElement
    SVGFECompositeElement SVGFEConvolveMatrixElement SVGFEDiffuseLightingElement
    SVGFEDisplacementMapElement SVGFEDistantLightElement SVGFEDropShadowElement SVGFEFloodElement
    SVGFEFuncAElement SVGFEFuncBElement SVGFEFuncGElement SVGFEFuncRElement SVGFEGaussianBlurElement
    SVGFEImageElement SVGFEMergeElement SVGFEMergeNodeElement SVGFEMorphologyElement SVGFEOffsetElement
    SVGFEPointLightElement SVGFESpecularLightingElement SVGFESpotLightElement SVGFETileElement
    SVGFETurbulenceElement SVGFilterElement SVGForeignObjectElement SVGGElement SVGGeometryElement
    SVGGradientElement SVGGraphicsElement SVGImageElement SVGLength SVGLengthList SVGLineElement
    SVGLinearGradientElement SVGMPathElement SVGMarkerElement SVGMaskElement SVGMatrix
    SVGMetadataElement SVGNumber SVGNumberList SVGPathElement SVGPatternElement SVGPoint SVGPointList
    SVGPolygonElement SVGPolylineElement SVGPreserveAspectRatio SVGRadialGradientElement SVGRect
    SVGRectElement SVGSVGElement SVGScriptElement SVGSetElement SVGStopElement SVGStringList
    SVGStyleElement SVGSwitchElement SVGSymbolElement SVGTSpanElement SVGTextContentElement
    SVGTextElement SVGTextPathElement SVGTextPositioningElement SVGTitleElement SVGTransform
    SVGTransformList SVGUnitTypes SVGUseElement SVGViewElement

    AnalyserNode Animation AnimationEffect AnimationEvent AnimationPlaybackEvent AnimationTimeline Attr
    Audio AudioBuffer AudioBufferSourceNode AudioDestinationNode AudioListener AudioNode AudioParam
    AudioProcessingEvent AudioScheduledSourceNode BarProp BeforeUnloadEvent BiquadFilterNode Blob
    BlobEvent ByteLengthQueuingStrategy CDATASection CSS CanvasGradient CanvasPattern
    CanvasRenderingContext2D ChannelMergerNode ChannelSplitterNode CharacterData ClipboardEvent
    CloseEvent Comment CompositionEvent ConvolverNode CountQueuingStrategy Crypto
    CustomElementRegistry CustomEvent DOMException DOMImplementation DOMMatrix DOMMatrixReadOnly
    DOMParser DOMPoint DOMPointReadOnly DOMQuad DOMRect DOMRectList DOMRectReadOnly DOMStringList
    DOMStringMap DOMTokenList DataTransfer DataTransferItem DataTransferItemList DelayNode Document
    DocumentFragment DocumentTimeline DocumentType DragEvent DynamicsCompressorNode Element ErrorEvent
    EventSource File FileList FileReader FocusEvent FontFace FormData GainNode Gamepad GamepadButton
    GamepadEvent Geolocation GeolocationPositionError HTMLAllCollection HTMLAnchorElement
    HTMLAreaElement HTMLAudioElement HTMLBRElement HTMLBaseElement HTMLBodyElement HTMLButtonElement
    HTMLCanvasElement HTMLCollection HTMLDListElement HTMLDataElement HTMLDataListElement
    HTMLDetailsElement HTMLDirectoryElement HTMLDivElement HTMLDocument HTMLElement HTMLEmbedElement
    HTMLFieldSetElement HTMLFontElement HTMLFormControlsCollection HTMLFormElement HTMLFrameElement
    HTMLFrameSetElement HTMLHRElement HTMLHeadElement HTMLHeadingElement HTMLHtmlElement
    HTMLIFrameElement HTMLImageElement HTMLInputElement HTMLLIElement HTMLLabelElement
    HTMLLegendElement HTMLLinkElement HTMLMapElement HTMLMarqueeElement HTMLMediaElement
    HTMLMenuElement HTMLMetaElement HTMLMeterElement HTMLModElement HTMLOListElement HTMLObjectElement
    HTMLOptGroupElement HTMLOptionElement HTMLOptionsCollection HTMLOutputElement HTMLParagraphElement
    HTMLParamElement HTMLPictureElement HTMLPreElement HTMLProgressElement HTMLQuoteElement
    HTMLScriptElement HTMLSelectElement HTMLSlotElement HTMLSourceElement HTMLSpanElement
    HTMLStyleElement HTMLTableCaptionElement HTMLTableCellElement HTMLTableColElement HTMLTableElement
    HTMLTableRowElement HTMLTableSectionElement HTMLTemplateElement HTMLTextAreaElement HTMLTimeElement
    HTMLTitleElement HTMLTrackElement HTMLUListElement HTMLUnknownElement HTMLVideoElement
    HashChangeEvent Headers History IDBCursor IDBCursorWithValue IDBDatabase IDBFactory IDBIndex
    IDBKeyRange IDBObjectStore IDBOpenDBRequest IDBRequest IDBTransaction IDBVersionChangeEvent Image
    ImageData InputEvent IntersectionObserver IntersectionObserverEntry KeyboardEvent KeyframeEffect
    Location MediaCapabilities MediaElementAudioSourceNode MediaEncryptedEvent MediaError MediaList
    MediaQueryList MediaQueryListEvent MediaRecorder MediaSource MediaStream
    MediaStreamAudioDestinationNode MediaStreamAudioSourceNode MediaStreamTrack MediaStreamTrackEvent
    MimeType MimeTypeArray MouseEvent MutationEvent MutationObserver MutationRecord NamedNodeMap
    Navigator Node NodeFilter NodeIterator NodeList Notification OfflineAudioCompletionEvent Option
    OscillatorNode PageTransitionEvent Path2D Performance PerformanceEntry PerformanceMark
    PerformanceMeasure PerformanceNavigation PerformanceObserver PerformanceObserverEntryList
    PerformanceResourceTiming PerformanceTiming PeriodicWave Plugin PluginArray PointerEvent
    PopStateEvent ProcessingInstruction ProgressEvent PromiseRejectionEvent RTCCertificate
    RTCDTMFSender RTCDTMFToneChangeEvent RTCDataChannel RTCDataChannelEvent RTCIceCandidate
    RTCPeerConnection RTCPeerConnectionIceEvent RTCRtpReceiver RTCRtpSender RTCRtpTransceiver
    RTCSessionDescription RTCStatsReport RTCTrackEvent RadioNodeList Range ReadableStream Request
    ResizeObserver ResizeObserverEntry Response Screen ScriptProcessorNode SecurityPolicyViolationEvent
    Selection ShadowRoot SourceBuffer SourceBufferList SpeechSynthesisEvent SpeechSynthesisUtterance
    StaticRange Storage StorageEvent StyleSheet StyleSheetList Text TextMetrics TextTrack TextTrackCue
    TextTrackCueList TextTrackList TimeRanges TrackEvent TransitionEvent TreeWalker UIEvent VTTCue
    ValidityState VisualViewport WaveShaperNode WebGLActiveInfo WebGLBuffer WebGLContextEvent
    WebGLFramebuffer WebGLProgram WebGLQuery WebGLRenderbuffer WebGLRenderingContext WebGLSampler
    WebGLShader WebGLShaderPrecisionFormat WebGLSync WebGLTexture WebGLUniformLocation WebKitCSSMatrix
    WebSocket WheelEvent Window Worker XMLDocument XMLHttpRequest XMLHttpRequestEventTarget
    XMLHttpRequestUpload XMLSerializer XPathEvaluator XPathExpression XPathResult XSLTProcessor alert
    atob blur btoa cancelAnimationFrame captureEvents close closed confirm customElements
    devicePixelRatio document event fetch find focus frameElement frames getComputedStyle getSelection
    history indexedDB isSecureContext length location locationbar matchMedia menubar moveBy moveTo
    name navigator

    onabort onafterprint onanimationend onanimationiteration onanimationstart onbeforeprint
    onbeforeunload onblur oncanplay oncanplaythrough onchange onclick oncontextmenu oncuechange
    ondblclick ondrag ondragend ondragenter ondragleave ondragover ondragstart ondrop ondurationchange
    onemptied onended onerror onfocus ongotpointercapture onhashchange oninput oninvalid onkeydown
    onkeypress onkeyup onlanguagechange onload onloadeddata onloadedmetadata onloadstart
    onlostpointercapture onmessage onmousedown onmouseenter onmouseleave onmousemove onmouseout
    onmouseover onmouseup onoffline ononline onpagehide onpageshow onpause onplay onplaying
    onpointercancel onpointerdown onpointerenter onpointerleave onpointermove onpointerout
    onpointerover onpointerup onpopstate onprogress onratechange onrejectionhandled onreset onresize
    onscroll onseeked onseeking onselect onstalled onstorage onsubmit onsuspend ontimeupdate ontoggle
    ontransitioncancel ontransitionend ontransitionrun ontransitionstart onunhandledrejection onunload
    onvolumechange onwaiting onwebkitanimationend onwebkitanimationiteration onwebkitanimationstart
    onwebkittransitionend onwheel

    open opener origin outerHeight outerWidth parent performance personalbar postMessage print prompt
    releaseEvents requestAnimationFrame resizeBy resizeTo screen screenLeft screenTop screenX screenY
    scroll scrollBy scrollTo scrollbars self speechSynthesis status statusbar stop toolbar top
    webkitURL window
`);

const PURE_MATH_METHODS = wordSet(`
    abs acos acosh asin asinh atan atan2 atanh cbrt ceil clz32 cos cosh exp expm1 floor fround hypot
    imul log log10 log1p log2 max min pow random round sign sin sinh sqrt tan tanh trunc
`);

/** Whether calling `object.method()` is side-effect-free given pure arguments. Distinct from
 *  `isKnownGlobalProperty`, the read check: `Object.freeze` is safe to read but not to call. */
function isPureGlobalMethodCall(object: string, method: string): boolean {
    switch (object) {
        case 'Array':
            return method === 'isArray' || method === 'of';
        case 'ArrayBuffer':
            return method === 'isView';
        case 'Date':
            return method === 'now' || method === 'parse' || method === 'UTC';
        case 'Math':
            return PURE_MATH_METHODS.has(method);
        case 'Number':
            return (
                method === 'isFinite' ||
                method === 'isInteger' ||
                method === 'isNaN' ||
                method === 'isSafeInteger' ||
                method === 'parseFloat' ||
                method === 'parseInt'
            );
        // Only `Object.is` is unconditionally pure; the argument-dependent ones are in the call check.
        case 'Object':
            return method === 'is';
        // `String.raw` reads `template.raw`, which is never provably safe.
        case 'String':
            return method === 'fromCharCode' || method === 'fromCodePoint';
        // `Symbol.keyFor` throws on a non-Symbol, which is never provable.
        case 'Symbol':
            return method === 'for';
        case 'URL':
            return method === 'canParse';
        default:
            return isTypedArrayConstructor(object) && method === 'of';
    }
}

const KNOWN_GLOBAL_PROPERTIES = new Map<string, Set<string>>([
    ['Math', new Set([...wordSet('E LN10 LN2 LOG10E LOG2E PI SQRT1_2 SQRT2'), ...PURE_MATH_METHODS])],
    [
        'console',
        wordSet(`
            assert clear count countReset debug dir dirxml error group groupCollapsed groupEnd info log
            table time timeEnd timeLog trace warn
        `),
    ],
    [
        'Object',
        wordSet(`
            assign create defineProperties defineProperty entries freeze fromEntries
            getOwnPropertyDescriptor getOwnPropertyDescriptors getOwnPropertyNames getOwnPropertySymbols
            getPrototypeOf is isExtensible isFrozen isSealed keys preventExtensions prototype seal
            setPrototypeOf values
        `),
    ],
    [
        'Reflect',
        wordSet(`
            apply construct defineProperty deleteProperty get getOwnPropertyDescriptor getPrototypeOf
            has isExtensible ownKeys preventExtensions set setPrototypeOf
        `),
    ],
    [
        'Symbol',
        wordSet(`
            asyncDispose asyncIterator dispose hasInstance isConcatSpreadable iterator match matchAll
            replace search species split toPrimitive toStringTag unscopables
        `),
    ],
    ['JSON', wordSet('parse stringify')],
]);

/** Whether reading `global.property` is side-effect-free (`Math.PI`, `console.log`, `Object.keys`). */
const isKnownGlobalProperty = (global: string, property: string): boolean =>
    KNOWN_GLOBAL_PROPERTIES.get(global)?.has(property) ?? false;

const OBJECT_PROTOTYPE_PROPERTIES = wordSet(`
    __defineGetter__ __defineSetter__ __lookupGetter__ __lookupSetter__ hasOwnProperty isPrototypeOf
    propertyIsEnumerable toLocaleString toString unwatch valueOf watch
`);

/** Whether reading `global.middle.property` is side-effect-free (`Object.prototype.hasOwnProperty`). */
const isKnownGlobalPropertyDeep = (global: string, middle: string, property: string): boolean =>
    global === 'Object' && middle === 'prototype' && OBJECT_PROTOTYPE_PROPERTIES.has(property);
