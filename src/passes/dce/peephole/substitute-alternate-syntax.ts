// Port of oxc_minifier/src/peephole/substitute_alternate_syntax.rs, the parts tree-shake mode reaches:
// `substitute_iife_call`. In tree-shake mode `try_take_iife_body` always bails, so an IIFE body is
// never inlined; only empty IIFEs and pure IIFEs whose result is unused fold.

import { type DataOf, N, type Node, node } from '../../../ast/index.ts';
import { ancestor, createVoidZero, type DceCtx, parentKind, replaceExpression } from '../traverse-context.ts';
import { canRemoveUnusedDeclarators, symbolIsUnusedByCount } from './remove-unused-declaration.ts';
import { foldArgumentsIntoNeededExpressions } from './remove-unused-expression.ts';

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

/** Fold empty IIFEs (`(() => {})()`, `(function () {})()`) to `undefined`, and pure-annotated
 *  arrow IIFEs whose result is unused. */
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
        // "(() => foo())()"
        if (isPure && isExpressionResultUnused(ctx)) replaceExpression(ctx, expr, createVoidZero(expr));
        return;
    }
    const statements = (body.data as DataOf<'BlockStatement'>).body.filter((statement) => !ctx.directives.has(statement));
    if (statements.length !== 1) return;
    const statement = statements[0];
    switch (statement.type) {
        // "(() => { foo() })()"
        case N.ExpressionStatement:
            if (isPure && isExpressionResultUnused(ctx)) replaceExpression(ctx, expr, createVoidZero(expr));
            return;
        // "(() => { return foo() })()"
        case N.ReturnStatement:
            if (statement.data.argument !== null && isPure && isExpressionResultUnused(ctx))
                replaceExpression(ctx, expr, createVoidZero(expr));
            return;
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
