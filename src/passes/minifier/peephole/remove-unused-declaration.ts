// Port of oxc_minifier/src/peephole/remove_unused_declaration.rs.

import { create, type DataOf, N, type Node } from '../../../ast/index.ts';
import { functionIsDead, isImplicitlyObservable } from '../symbol-state.ts';
import { scopeContainsDirectEval, scopeIsArrow, scopeIsFunction, scopeIsStrictMode } from '../syntax.ts';
import {
    ancestorScopes,
    currentScopeFlags,
    type DceCtx,
    expressionValueType,
    getResolvedReferences,
    isGlobalReference,
    noticeChange,
    replaceStatement,
    rootScopeFlags,
    rootScopeId,
    scopeAncestors,
    scopeFlags,
    symbolIsUnused,
} from '../traverse-context.ts';
import { removeUnusedClass } from './remove-unused-expression.ts';

type VariableDeclarationKind = DataOf<'VariableDeclaration'>['kind'];

export const canRemoveUnusedDeclarators = (ctx: DceCtx): boolean =>
    ctx.state.options.unused !== 'keep' && !isScriptRootScope(ctx) && !scopeContainsDirectEval(rootScopeFlags(ctx));

/** Count-based unusedness for declaration removal and IIFE folding. The assignment, member-write and
 *  single-use-substitution consumers pair `isImplicitlyObservable` with their own count thresholds
 *  instead, because some runtime semantics observe a binding independently of resolved references. */
export const symbolIsUnusedByCount = (ctx: DceCtx, symbolId: number): boolean =>
    !isImplicitlyObservable(ctx.state.symbols, symbolId) && symbolIsUnused(ctx, symbolId);

/** Function declarations also consume graph deadness, so self- and mutually-recursive cycles go. */
const functionHasNoLiveReferences = (ctx: DceCtx, symbolId: number): boolean =>
    symbolIsUnusedByCount(ctx, symbolId) || functionIsDead(ctx.state.symbols, symbolId);

/** A function or arrow initializer that contains every reference to its own binding can never be
 *  called: `const f = () => f()` is removable, `use(f)` beside it is an outside reference that keeps it.
 *  Checked at the removal site rather than through the recursive-function graph, so mutual declarator
 *  cycles stay unsupported. */
function selfRecursiveFunctionDeclaratorIsUnused(ctx: DceCtx, declarator: Node, symbolId: number): boolean {
    const init = (declarator.data as DataOf<'VariableDeclarator'>).init;
    if (init === null) return false;
    let functionScopeId: number;
    if (init.type === N.FunctionExpression || init.type === N.ArrowFunctionExpression) functionScopeId = init.data.scopeId;
    else return false;
    if (!(functionScopeId > 0)) return false;

    // Covers exports, Script-root bindings, Annex B aliases and `using`.
    if (isImplicitlyObservable(ctx.state.symbols, symbolId)) return false;

    return getResolvedReferences(ctx, symbolId).every((reference) =>
        scopeAncestors(ctx.scoping, reference.scopeId).includes(functionScopeId),
    );
}

function isSyncIteratorExpr(ctx: DceCtx, expr: Node): boolean {
    switch (expr.type) {
        case N.ArrayExpression:
        case N.StringLiteral:
        case N.TemplateLiteral:
            return true;
        case N.IdentifierReference:
            return (
                expr.name === 'arguments' &&
                isGlobalReference(ctx, expr) &&
                // `arguments` can be reassigned in sloppy mode.
                scopeIsStrictMode(currentScopeFlags(ctx)) &&
                ancestorScopes(ctx).some((scopeId) => {
                    const flags = scopeFlags(ctx, scopeId);
                    return scopeIsFunction(flags) && !scopeIsArrow(flags);
                })
            );
        default:
            return false;
    }
}

const isUsing = (kind: VariableDeclarationKind): boolean => kind === 'using' || kind === 'await using';

export function shouldRemoveUnusedDeclarator(ctx: DceCtx, declarator: Node, kind: VariableDeclarationKind): boolean {
    if (!canRemoveUnusedDeclarators(ctx)) return false;
    // `[Symbol.dispose]` runs at scope exit and cannot be analysed statically.
    if (isUsing(kind)) return false;
    const { id, init } = declarator.data as DataOf<'VariableDeclarator'>;
    switch (id.type) {
        case N.BindingIdentifier: {
            const symbolId = id.sym;
            if (symbolId > 0)
                return symbolIsUnusedByCount(ctx, symbolId) || selfRecursiveFunctionDeclaratorIsUnused(ctx, declarator, symbolId);
            return false;
        }
        case N.ArrayPattern:
            return (id.data.elements as (Node | null)[]).length === 0 && init !== null && isSyncIteratorExpr(ctx, init);
        case N.ObjectPattern: {
            if ((id.data.properties as Node[]).length !== 0 || init === null) return false;
            const type = expressionValueType(ctx, init);
            return type !== 'null' && type !== 'undefined' && type !== 'undetermined';
        }
        default:
            return false;
    }
}

/** Filter unused declarators out of a `KeepVar`-synthesized `var` statement. Callers pass `KeepVar`
 *  output: a transient, init-less statement not yet in the tree, so removing a declarator discards no
 *  references and records no change. Installing the result, or not, is the caller's change. */
export function removeUnusedVariableDeclaration(ctx: DceCtx, statement: Node): Node | null {
    if (statement.type !== N.VariableDeclaration) return statement;
    if (!canRemoveUnusedDeclarators(ctx)) return statement;
    const { declarations, kind } = statement.data as DataOf<'VariableDeclaration'>;
    let kept = 0;
    for (const declarator of declarations) {
        if (ctx.verify && (declarator.data as DataOf<'VariableDeclarator'>).init !== null)
            throw new Error('dce: removeUnusedVariableDeclaration takes KeepVar output (init-less declarators)');
        if (!shouldRemoveUnusedDeclarator(ctx, declarator, kind)) declarations[kept++] = declarator;
    }
    declarations.length = kept;
    if (declarations.length === 0) return null;
    return statement;
}

export function removeUnusedFunctionDeclaration(ctx: DceCtx, statement: Node): void {
    if (statement.type !== N.FunctionDeclaration) return;
    if (ctx.state.options.unused === 'keep') return;
    const id = (statement.data as DataOf<'FunctionDeclaration'>).id;
    if (id === null) return;
    const symbolId = id.sym;
    if (symbolId === 0) return;
    if (isScriptRootScope(ctx) || scopeContainsDirectEval(currentScopeFlags(ctx))) return;
    if (!functionHasNoLiveReferences(ctx, symbolId)) return;
    replaceStatement(ctx, statement, create.EmptyStatement(statement.start, statement.end, 0));
}

export function removeUnusedClassDeclaration(ctx: DceCtx, statement: Node): void {
    if (statement.type !== N.ClassDeclaration) return;
    if (ctx.state.options.unused === 'keep') return;
    const id = (statement.data as DataOf<'ClassDeclaration'>).id;
    if (id === null) return;
    const symbolId = id.sym;
    if (symbolId === 0) return;
    if (isScriptRootScope(ctx) || scopeContainsDirectEval(currentScopeFlags(ctx))) return;
    if (!symbolIsUnusedByCount(ctx, symbolId)) return;
    const expressions = removeUnusedClass(ctx, statement);
    if (expressions === null) return;
    const replacement =
        expressions.length === 0
            ? create.EmptyStatement(statement.start, statement.end, 0)
            : create.ExpressionStatement(
                  statement.start,
                  statement.end,
                  0,
                  create.SequenceExpression(statement.start, statement.end, 0, expressions),
              );
    replaceStatement(ctx, statement, replacement);
}

/** The current scope is a Script's root, whose bindings are globals other scripts can see. */
export const isScriptRootScope = (ctx: DceCtx): boolean =>
    ctx.currentScopeId === rootScopeId(ctx) && ctx.state.sourceType === 'script';

/** Drop unused import specifiers. An import may have side effects, so one left with no specifiers
 *  becomes a side-effect-only `import 'x'` rather than being removed; a phase import (`import source`,
 *  `import defer`) has no side effects and is removed whole. */
export function removeUnusedImportSpecifiers(ctx: DceCtx, statement: Node): void {
    if (ctx.state.options.treeshake.invalidImportSideEffects || ctx.state.options.unused === 'keep') return;

    if (scopeContainsDirectEval(rootScopeFlags(ctx))) return;

    if (ctx.verify && ctx.state.sourceType === 'script') throw new Error('dce: imports are not allowed in script mode');

    if (statement.type !== N.ImportDeclaration) return;
    const data = statement.data as DataOf<'ImportDeclaration'>;

    if (data.phase !== null) {
        const local = (data.specifiers[0].data as { local: Node }).local;
        if (symbolIsUnused(ctx, local.sym))
            replaceStatement(ctx, statement, create.EmptyStatement(statement.start, statement.end, 0));
        return;
    }

    // shakeup has no `None` specifier list: `import 'x'` and `import {} from 'x'` both hold an empty one.
    const specifiers = data.specifiers;
    if (specifiers.length === 0) return;

    const originalLength = specifiers.length;
    let kept = 0;
    for (const specifier of specifiers) {
        if (!symbolIsUnused(ctx, (specifier.data as { local: Node }).local.sym)) specifiers[kept++] = specifier;
    }
    specifiers.length = kept;

    if (specifiers.length !== originalLength) noticeChange(ctx);
}
