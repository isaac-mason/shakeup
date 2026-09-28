// Port of oxc_minifier/src/peephole/inline.rs, the parts tree-shake mode reaches: recording each
// declarator's value. `inline_identifier_reference` and the declaration-value initializers are full
// minify only.

import { evaluateValueInContext, numericLiteralValue, stringLiteralValue } from '../../../analysis/const-eval.ts';
import type { ConstantValue } from '../../../analysis/constant-value.ts';
import { type DataOf, N, type Node } from '../../../ast/index.ts';
import { lastBodyFrame } from '../state.ts';
import type { FreshValueKind } from '../symbol-value.ts';
import { referenceIsRead } from '../syntax.ts';
import { type DceCtx, getResolvedReferences, initValue, parent } from '../traverse-context.ts';
import { readCrossesFunctionBoundary } from './index.ts';
import { isScriptRootScope } from './remove-unused-declaration.ts';

const UNDEFINED_VALUE: ConstantValue = { kind: 'undefined' };

/** Record what the declarator's binding holds for this pass, at `exit_variable_declarator`. */
export function initSymbolValue(ctx: DceCtx, declarator: Node): void {
    const declarationAncestor = parent(ctx);
    if (declarationAncestor.kind !== 'VariableDeclarationDeclarations')
        throw new Error('dce: a declarator outside a declaration');
    const declarationKind = (declarationAncestor.node.data as DataOf<'VariableDeclaration'>).kind;
    const { id, init } = declarator.data as DataOf<'VariableDeclarator'>;
    if (id.type !== N.BindingIdentifier) return;
    const symbolId = id.sym;
    if (symbolId === 0) return;
    const initConstant = init === null ? null : evaluateValueInContext(init, ctx);
    // An explicit falsy initializer, not the implicit `undefined` of `var x;`.
    const falsyInit = initConstant !== null && isFalsyConstant(initConstant);
    const declarationInBodyStatementList = declarationKind !== 'var' || isDeclarationInBodyStatementList(ctx);
    let value: ConstantValue | null;
    if (isForStatementInit(ctx)) {
        // for-in/of heads get their value from the loop itself.
        value = null;
    } else if (declarationKind === 'var' && !isHoistedVarInlineable(ctx, declarator, symbolId, declarationInBodyStatementList)) {
        // `var` is hoisted: reads before the initializer line see `undefined`.
        value = null;
    } else {
        value = init === null ? UNDEFINED_VALUE : initConstant;
    }
    // A conditional `var` may still hold its previous value or the hoisted `undefined`.
    const kind: FreshValueKind = declarationInBodyStatementList && init !== null ? freshValueKind(init) : 'none';
    initValue(ctx, symbolId, value, kind, falsyInit, init === null);
}

/** A constant that coerces to `false`. BigInt is skipped conservatively. */
function isFalsyConstant(value: ConstantValue): boolean {
    switch (value.kind) {
        case 'boolean':
            return !value.value;
        case 'number':
            return Number.isNaN(value.value) || value.value === 0;
        case 'string':
            return value.value === '';
        case 'null':
        case 'undefined':
            return true;
        case 'bigint':
            return false;
    }
}

/** The declaration is a direct item of the current body, not nested in another statement position. */
function isDeclarationInBodyStatementList(ctx: DceCtx): boolean {
    for (let at = ctx.ancestorDepth - 1; at >= 0; at--) {
        switch (ctx.ancestorKinds[at]) {
            case 'VariableDeclarationDeclarations':
            case 'ExportDeclarationDeclaration':
                continue;
            case 'ProgramBody':
            case 'FunctionBodyStatements':
                return true;
            default:
                return false;
        }
    }
    return false;
}

/** Whether no read can observe a hoisted `var x = <constant>` as its hoisted `undefined`: the
 *  declarator is a direct item at the top of a body still in its declarative prelude, it has an
 *  initializer, it is not a Script global, and every read sits in a nested function. */
function isHoistedVarInlineable(
    ctx: DceCtx,
    declarator: Node,
    symbolId: number,
    declarationInBodyStatementList: boolean,
): boolean {
    if (
        (declarator.data as DataOf<'VariableDeclarator'>).init === null ||
        !declarationInBodyStatementList ||
        isScriptRootScope(ctx)
    )
        return false;
    const frame = lastBodyFrame(ctx.state);
    if (frame.hoistedVarInliningUnsafe || ctx.currentScopeId !== frame.scopeId) return false;
    let sawRead = false;
    for (const reference of getResolvedReferences(ctx, symbolId)) {
        if (!referenceIsRead(reference.flags)) continue;
        sawRead = true;
        if (!readCrossesFunctionBoundary(ctx, reference.scopeId, frame.scopeId)) return false;
    }
    return sawRead;
}

/** oxc `PropertyKey::static_name`, for the key kinds a non-computed property can have. */
function staticName(key: Node): string | null {
    switch (key.type) {
        case N.IdentifierName:
            return key.name;
        case N.StringLiteral:
            return stringLiteralValue(key).value;
        case N.NumericLiteral:
            return String(numericLiteralValue(key));
        case N.NullLiteral:
            return 'null';
        default:
            return null;
    }
}

/** The fresh value an expression creates: one that cannot alias another binding and has no setter
 *  or getter a property write could trigger. */
function freshValueKind(expr: Node): FreshValueKind {
    switch (expr.type) {
        case N.ArrayExpression:
            return 'array';
        case N.ArrowFunctionExpression:
        case N.FunctionExpression:
            return 'function';
        case N.ObjectExpression: {
            const hasSideEffects = (expr.data.properties as Node[]).some(
                (property) =>
                    property.type === N.ObjectProperty &&
                    (property.data.kind === 'get' ||
                        property.data.kind === 'set' ||
                        expressionHasSetterOrGetter(property.data.value) ||
                        // `{ __proto__: ... }` sets the prototype chain and could install setters.
                        (property.data.kind === 'init' &&
                            !property.data.computed &&
                            staticName(property.data.key) === '__proto__')),
            );
            return hasSideEffects ? 'none' : 'object';
        }
        case N.ClassExpression:
            return classMayHavePropertySideEffects(expr) ? 'none' : 'class';
        default:
            return 'none';
    }
}

/** A class with `extends`, decorators, static accessors, static field values or static blocks may
 *  make a property write observable. */
export function classMayHavePropertySideEffects(classNode: Node): boolean {
    const classData = classNode.data as DataOf<'ClassExpression'>;
    if (classData.superClass !== null) return true;
    if (classData.decorators.length > 0) return true;
    return classData.body.some((element) => {
        switch (element.type) {
            case N.MethodDefinition:
                return (
                    (element.data.decorators as Node[]).length > 0 ||
                    (element.data.static && (element.data.kind === 'set' || element.data.kind === 'get'))
                );
            case N.PropertyDefinition:
                return (element.data.decorators as Node[]).length > 0 || (element.data.static && element.data.value !== null);
            case N.StaticBlock:
                return true;
            default:
                return false;
        }
    });
}

function expressionHasSetterOrGetter(expr: Node): boolean {
    switch (expr.type) {
        case N.ObjectExpression:
            return (expr.data.properties as Node[]).some(
                (property) =>
                    property.type === N.ObjectProperty &&
                    (property.data.kind === 'set' ||
                        property.data.kind === 'get' ||
                        expressionHasSetterOrGetter(property.data.value)),
            );
        case N.ClassExpression:
            return classMayHavePropertySideEffects(expr);
        default:
            return false;
    }
}

/** The declaration is a for-in/of head. */
function isForStatementInit(ctx: DceCtx): boolean {
    const at = ctx.ancestorDepth - 2;
    if (at < 0) return false;
    const kind = ctx.ancestorKinds[at];
    return kind === 'ForInStatementLeft' || kind === 'ForOfStatementLeft';
}
