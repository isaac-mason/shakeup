// Port of oxc_minifier/src/traverse_context/ (mod.rs, ecma_context.rs, scoping.rs, ancestry.rs,
// dropped_subtree_collector.rs): the context every DCE hook receives.
//
// oxc's `Scoping` is rebuilt here as a per-module view over shakeup's `Semantic`: per symbol its scope,
// flags and resolved references; per reference its `IdentifierReference` node, flags and occurrence
// scope. References are keyed by node identity, which is what oxc's `ReferenceId` on the node gives it.

import {
    type ConstEvalContext,
    bigIntLiteralValue,
    evaluateValueInContext,
    getInnerExpression,
    numericLiteralValue,
    stringLiteralValue,
    type ValueType,
    valueType,
} from '../../analysis/const-eval.ts';
import type { ConstantValue } from '../../analysis/constant-value.ts';
import {
    createScope,
    SCOPE,
    SCOPE_STRICT,
    SYM,
    type Semantic,
    lookupValue,
    scopeKind,
    symbolName as semanticSymbolName,
} from '../../analysis/semantic.ts';
import { isPureFunction, mayHaveSideEffects, type SideEffectsContext } from '../../analysis/side-effects.ts';
import { type DataOf, N, type Node, node, set, walk } from '../../ast/index.ts';
import type { CompressOptions } from './options.ts';
import { type CompressionMode, createMinifierState, type MinifierState, recordAstChange, type SourceType } from './state.ts';
import { storeSymbolValue, symbolValueOf } from './symbol-state.ts';
import {
    countsHaveWrites,
    createReferenceCounts,
    type FreshValueKind,
    recordReferenceCount,
    type SymbolValue,
} from './symbol-value.ts';
import {
    ReferenceFlags,
    referenceIsWrite,
    ScopeFlags,
    SymbolFlags,
    scopeContainsDirectEval,
    symbolIsConstVariable,
    symbolIsValue,
} from './syntax.ts';
import { compileWalker, hookNamesOf, type Traverser, WalkPosition } from './traverse.ts';

// --- types ---------------------------------------------------------------------------------------

/** oxc's `Ancestor` variants, named `<ParentType><Field>`: "my parent is a `ParentType` and I sit in
 *  its `Field`". Where shakeup's tree drops one of oxc's wrapper nodes (`FormalParameters`,
 *  `ClassBody`, `ClassHeritage`, `CatchParameter`) the entry is named for the nearest oxc parent. */
export type AncestorKind =
    | 'None'
    | 'ProgramBody'
    | 'TemplateLiteralQuasis'
    | 'TemplateLiteralExpressions'
    | 'TaggedTemplateExpressionTag'
    | 'TaggedTemplateExpressionQuasi'
    | 'ArrayExpressionElements'
    | 'ObjectExpressionProperties'
    | 'ObjectPropertyKey'
    | 'ObjectPropertyValue'
    | 'SpreadElementArgument'
    | 'BinaryExpressionLeft'
    | 'BinaryExpressionRight'
    | 'PrivateInExpressionLeft'
    | 'PrivateInExpressionRight'
    | 'LogicalExpressionLeft'
    | 'LogicalExpressionRight'
    | 'AssignmentExpressionLeft'
    | 'AssignmentExpressionRight'
    | 'UnaryExpressionArgument'
    | 'UpdateExpressionArgument'
    | 'ConditionalExpressionTest'
    | 'ConditionalExpressionConsequent'
    | 'ConditionalExpressionAlternate'
    | 'CallExpressionCallee'
    | 'CallExpressionArguments'
    | 'NewExpressionCallee'
    | 'NewExpressionArguments'
    | 'StaticMemberExpressionObject'
    | 'StaticMemberExpressionProperty'
    | 'ComputedMemberExpressionObject'
    | 'ComputedMemberExpressionExpression'
    | 'PrivateFieldExpressionObject'
    | 'PrivateFieldExpressionField'
    | 'ChainExpressionExpression'
    | 'SequenceExpressionExpressions'
    | 'ArrowFunctionExpressionBody'
    | 'FunctionId'
    | 'FunctionBody'
    | 'FormalParametersItems'
    | 'FormalParametersRest'
    | 'FormalParameterPattern'
    | 'FormalParameterInitializer'
    | 'BindingRestElementArgument'
    | 'ClassDecorators'
    | 'ClassId'
    | 'ClassHeritageExpression'
    | 'ClassBodyBody'
    | 'DecoratorExpression'
    | 'MethodDefinitionDecorators'
    | 'MethodDefinitionKey'
    | 'MethodDefinitionValue'
    | 'PropertyDefinitionDecorators'
    | 'PropertyDefinitionKey'
    | 'PropertyDefinitionValue'
    | 'StaticBlockBody'
    | 'YieldExpressionArgument'
    | 'AwaitExpressionArgument'
    | 'ImportExpressionSource'
    | 'ImportExpressionOptions'
    | 'ExpressionStatementExpression'
    | 'VariableDeclarationDeclarations'
    | 'VariableDeclaratorId'
    | 'VariableDeclaratorInit'
    | 'BlockStatementBody'
    | 'FunctionBodyStatements'
    | 'IfStatementTest'
    | 'IfStatementConsequent'
    | 'IfStatementAlternate'
    | 'ForStatementInit'
    | 'ForStatementTest'
    | 'ForStatementUpdate'
    | 'ForStatementBody'
    | 'ForInStatementLeft'
    | 'ForInStatementRight'
    | 'ForInStatementBody'
    | 'ForOfStatementLeft'
    | 'ForOfStatementRight'
    | 'ForOfStatementBody'
    | 'WhileStatementTest'
    | 'WhileStatementBody'
    | 'DoWhileStatementBody'
    | 'DoWhileStatementTest'
    | 'SwitchStatementDiscriminant'
    | 'SwitchStatementCases'
    | 'SwitchCaseTest'
    | 'SwitchCaseConsequent'
    | 'TryStatementBlock'
    | 'TryStatementHandler'
    | 'TryStatementFinalizer'
    | 'CatchClauseParam'
    | 'CatchClauseBody'
    | 'ReturnStatementArgument'
    | 'ThrowStatementArgument'
    | 'BreakStatementLabel'
    | 'ContinueStatementLabel'
    | 'LabeledStatementLabel'
    | 'LabeledStatementBody'
    | 'WithStatementObject'
    | 'WithStatementBody'
    | 'ImportDeclarationSpecifiers'
    | 'ImportDeclarationSource'
    | 'ImportDeclarationWithClause'
    | 'ImportSpecifierImported'
    | 'ImportSpecifierLocal'
    | 'ImportDefaultSpecifierLocal'
    | 'ImportNamespaceSpecifierLocal'
    | 'ImportAttributeKey'
    | 'ImportAttributeValue'
    | 'ExportDeclarationDeclaration'
    | 'ExportNamedDeclarationSpecifiers'
    | 'ExportFromDeclarationSource'
    | 'ExportFromDeclarationWithClause'
    | 'ExportSpecifierLocal'
    | 'ExportSpecifierExported'
    | 'ExportDefaultDeclarationDeclaration'
    | 'ExportAllDeclarationExported'
    | 'ExportAllDeclarationSource'
    | 'ExportAllDeclarationWithClause'
    | 'ObjectPatternProperties'
    | 'ObjectPatternRest'
    | 'BindingPropertyKey'
    | 'BindingPropertyValue'
    | 'ArrayPatternElements'
    | 'ArrayPatternRest'
    | 'AssignmentPatternLeft'
    | 'AssignmentPatternRight'
    | 'ArrayAssignmentTargetElements'
    | 'ArrayAssignmentTargetRest'
    | 'ObjectAssignmentTargetProperties'
    | 'ObjectAssignmentTargetRest'
    | 'AssignmentTargetRestTarget'
    | 'AssignmentTargetPropertyIdentifierBinding'
    | 'AssignmentTargetPropertyIdentifierInit'
    | 'AssignmentTargetPropertyPropertyName'
    | 'AssignmentTargetPropertyPropertyBinding'
    | 'AssignmentTargetWithDefaultBinding'
    | 'AssignmentTargetWithDefaultInit'
    | 'TSAsExpressionExpression'
    | 'TSSatisfiesExpressionExpression'
    | 'TSNonNullExpressionExpression'
    | 'TSInstantiationExpressionExpression'
    | 'JSXElementOpeningElement'
    | 'JSXElementChildren'
    | 'JSXElementClosingElement'
    | 'JSXOpeningElementName'
    | 'JSXOpeningElementAttributes'
    | 'JSXClosingElementName'
    | 'JSXFragmentChildren'
    | 'JSXAttributeName'
    | 'JSXAttributeValue'
    | 'JSXSpreadAttributeArgument'
    | 'JSXExpressionContainerExpression'
    | 'JSXSpreadChildExpression'
    | 'JSXMemberExpressionObject'
    | 'JSXMemberExpressionProperty'
    | 'JSXNamespacedNameNamespace'
    | 'JSXNamespacedNameName';

/** One entry of the ancestor stack, oxc's `Ancestor`: the parent `node` and the `kind` of the relation. */
export type Ancestor = { node: Node; kind: AncestorKind };

/** Anything with a source range; a node is one. */
export type Span = { start: number; end: number };

/** oxc `Reference`: one resolved or unresolved use of a name. */
export type Reference = {
    /** oxc `ReferenceId`: dense, in creation order. */
    id: number;
    /** The `IdentifierReference` currently holding this reference. */
    node: Node;
    /** 0 when unresolved, which is oxc's global reference. */
    symbolId: number;
    /** The scope the reference occurs in. */
    scopeId: number;
    flags: number;
    /** Marked removed by a `replace_*` / `drop_*` helper this pass. */
    markedRemoved: boolean;
    /** Pruned from its symbol's reference list at a pass flush. */
    pruned: boolean;
};

/** oxc `Scoping`, for one module. */
export type Scoping = {
    semantic: Semantic;
    /** oxc `symbol_scope_id`, per symbol. */
    symbolScopeIds: number[];
    /** oxc `SymbolFlags`, per symbol. */
    symbolFlags: number[];
    /** oxc `symbol_redeclarations`: the `SymbolFlags` of each declaration of a symbol declared more than once. */
    symbolRedeclarations: Map<number, number[]>;
    /** oxc `resolved_references`, per symbol. */
    resolvedReferences: Reference[][];
    /** Every reference, indexed by id; an identifier holds its id in `ref`. */
    references: Reference[];
    /** Parent of each scope, 0 for the root. */
    scopeParentIds: number[];
    /** oxc `ScopeFlags`, per scope. */
    scopeFlags: number[];
    rootScopeId: number;
    /** oxc `Scoping::no_side_effects`: symbols annotated `@__NO_SIDE_EFFECTS__`. */
    noSideEffects: ReadonlySet<number>;
    /** Symbols that had a binding identifier in the program when the view was built. */
    symbolsWithBindings: Uint8Array;
};

/** The walk position the traversal maintains: the ancestor stack, the current scope, the directives. */
export type WalkState = {
    ancestorNodes: Node[];
    ancestorKinds: AncestorKind[];
    ancestorDepth: number;
    currentScopeId: number;
    /** Directive-prologue statements. oxc keeps directives out of statement lists, so the walker skips them. */
    directives: Set<Node>;
};

/** oxc `TraverseCtx<MinifierState>`. Also the constant-evaluation and side-effect context. */
export type DceCtx = WalkState &
    SideEffectsContext &
    ConstEvalContext & {
        scoping: Scoping;
        state: MinifierState;
        /** Run oxc's debug-build invariant checks. */
        verify: boolean;
    };

// --- walk position (ancestry.rs, scoping.rs) ------------------------------------------------------

const ROOT_SENTINEL: Node = node(N.EmptyStatement, 0, 0, '', null);

/** `Ancestor::None`: above the program. */
export const ANCESTOR_NONE: Ancestor = { node: ROOT_SENTINEL, kind: 'None' };

export function createWalkState(rootScopeId: number): WalkState {
    return {
        ancestorNodes: [],
        ancestorKinds: [],
        ancestorDepth: 0,
        currentScopeId: rootScopeId,
        directives: new Set(),
    };
}

function ancestorAt(ctx: WalkState, at: number): Ancestor {
    if (at < 0) return ANCESTOR_NONE;
    return { node: ctx.ancestorNodes[at], kind: ctx.ancestorKinds[at] };
}

export const parent = (ctx: WalkState): Ancestor => ancestorAt(ctx, ctx.ancestorDepth - 1);

/** `level` above the parent; `ancestor(ctx, 0)` is the parent. `None` past the program. */
export const ancestor = (ctx: WalkState, level: number): Ancestor => ancestorAt(ctx, ctx.ancestorDepth - 1 - level);

export const parentKind = (ctx: WalkState): AncestorKind =>
    ctx.ancestorDepth === 0 ? 'None' : ctx.ancestorKinds[ctx.ancestorDepth - 1];

export const ancestorKind = (ctx: WalkState, level: number): AncestorKind => {
    const at = ctx.ancestorDepth - 1 - level;
    return at < 0 ? 'None' : ctx.ancestorKinds[at];
};

/** The ancestors from the parent up to the program; `None` is not included. */
export function ancestors(ctx: WalkState): Ancestor[] {
    const result: Ancestor[] = [];
    for (let at = ctx.ancestorDepth - 1; at >= 0; at--) result.push(ancestorAt(ctx, at));
    return result;
}

export const ancestorsDepth = (ctx: WalkState): number => ctx.ancestorDepth + 1;

export const currentScopeId = (ctx: WalkState): number => ctx.currentScopeId;

export const currentScopeFlags = (ctx: DceCtx): number => scopeFlags(ctx, ctx.currentScopeId);

/** Scopes from the current one up to the root. */
export const ancestorScopes = (ctx: DceCtx): number[] => scopeAncestors(ctx.scoping, ctx.currentScopeId);

// --- scoping queries -----------------------------------------------------------------------------

export function scopeAncestors(scoping: Scoping, scopeId: number): number[] {
    const result: number[] = [];
    for (let scope = scopeId; scope > 0; scope = scoping.scopeParentIds[scope] ?? 0) result.push(scope);
    return result;
}

export const scopeParentId = (scoping: Scoping, scopeId: number): number => scoping.scopeParentIds[scopeId] ?? 0;

export const scopeFlags = (ctx: DceCtx, scopeId: number): number => ctx.scoping.scopeFlags[scopeId] ?? 0;

export const rootScopeId = (ctx: DceCtx): number => ctx.scoping.rootScopeId;

export const rootScopeFlags = (ctx: DceCtx): number => scopeFlags(ctx, ctx.scoping.rootScopeId);

export const symbolScopeId = (ctx: DceCtx, symbolId: number): number => ctx.scoping.symbolScopeIds[symbolId] ?? 0;

export const symbolFlags = (ctx: DceCtx, symbolId: number): number => ctx.scoping.symbolFlags[symbolId] ?? 0;

export const symbolName = (ctx: DceCtx, symbolId: number): string => semanticSymbolName(ctx.scoping.semantic, symbolId);

const NO_REDECLARATIONS: readonly number[] = [];

/** oxc `symbol_redeclarations`, as the `SymbolFlags` of each declaration. Empty unless declared twice. */
export const symbolRedeclarations = (ctx: DceCtx, symbolId: number): readonly number[] =>
    ctx.scoping.symbolRedeclarations.get(symbolId) ?? NO_REDECLARATIONS;

/** The symbol `name` resolves to from `scopeId`, or 0. */
export const findBinding = (ctx: DceCtx, scopeId: number, name: string): number =>
    lookupValue(ctx.scoping.semantic, scopeId, name);

export const noSideEffects = (ctx: DceCtx, symbolId: number): boolean => ctx.scoping.noSideEffects.has(symbolId);

/** oxc `create_child_scope`: a new scope under `parentId`, inheriting its strict mode. The caller
 *  puts the id on the node that owns it and attaches the node with `attachScopeNode`. */
export function createChildScope(ctx: DceCtx, parentId: number, flags: number): number {
    const scopeFlagsWithStrict = flags | (scopeFlags(ctx, parentId) & ScopeFlags.StrictMode);
    const kind = (flags & ScopeFlags.Function) !== 0 ? SCOPE.FUNCTION : SCOPE.BLOCK;
    const scopeId = createScope(
        ctx.scoping.semantic,
        parentId,
        kind | ((scopeFlagsWithStrict & ScopeFlags.StrictMode) !== 0 ? SCOPE_STRICT : 0),
    );
    ctx.scoping.scopeParentIds[scopeId] = parentId;
    ctx.scoping.scopeFlags[scopeId] = scopeFlagsWithStrict;
    return scopeId;
}

export const createChildScopeOfCurrent = (ctx: DceCtx, flags: number): number => createChildScope(ctx, ctx.currentScopeId, flags);

// --- references ----------------------------------------------------------------------------------

/** oxc `scoping().get_reference(ident.reference_id())`. Throws for an identifier that was never
 *  registered, where oxc's `reference_id()` panics. */
export function getReference(ctx: DceCtx, ident: Node): Reference {
    const reference = referenceOf(ctx, ident);
    if (reference === null)
        throw new Error(`dce: identifier \`${ident.name}\` has no reference; create it with createReference`);
    return reference;
}

/** The reference `ident` holds, or null for a fresh identifier with none (oxc's `reference_id.get()`). */
export const referenceOf = (ctx: DceCtx, ident: Node): Reference | null => referenceIn(ctx.scoping, ident);

/** An id left by an earlier pass, or on a node the reference has since moved off, names nothing. */
function referenceIn(scoping: Scoping, ident: Node): Reference | null {
    const id = ident.ref;
    if (id < 0) return null;
    const reference = scoping.references[id];
    return reference !== undefined && reference.node === ident ? reference : null;
}

const NO_REFERENCES: readonly Reference[] = [];

export const getResolvedReferences = (ctx: DceCtx, symbolId: number): readonly Reference[] =>
    ctx.scoping.resolvedReferences[symbolId] ?? NO_REFERENCES;

export const symbolIsUnused = (ctx: DceCtx, symbolId: number): boolean => getResolvedReferences(ctx, symbolId).length === 0;

/** oxc `symbol_is_mutated`: never for a `const`, otherwise whether any reference writes. */
export function symbolIsMutated(ctx: DceCtx, symbolId: number): boolean {
    if (symbolIsConstVariable(symbolFlags(ctx, symbolId))) return false;
    return getResolvedReferences(ctx, symbolId).some((reference) => referenceIsWrite(reference.flags));
}

function registerReference(scoping: Scoping, ident: Node, symbolId: number, scopeId: number, flags: number): Reference {
    const reference: Reference = {
        id: scoping.references.length,
        node: ident,
        symbolId,
        scopeId,
        flags,
        markedRemoved: false,
        pruned: false,
    };
    scoping.references.push(reference);
    ident.ref = reference.id;
    if (symbolId > 0) {
        let list = scoping.resolvedReferences[symbolId];
        if (list === undefined) {
            list = [];
            scoping.resolvedReferences[symbolId] = list;
        }
        list.push(reference);
    }
    return reference;
}

/** oxc `create_reference`: register a fresh `IdentifierReference`, bound to `symbolId` (0 for an
 *  unbound one), occurring in the current scope. */
export function createReference(ctx: DceCtx, ident: Node, symbolId: number, flags: number): Reference {
    ident.sym = symbolId;
    return registerReference(ctx.scoping, ident, symbolId, ctx.currentScopeId, flags);
}

/** oxc `create_ident_expr`. */
export function createIdentExpr(ctx: DceCtx, span: Span, name: string, symbolId: number, flags: number): Node {
    const ident = node(N.IdentifierReference, span.start, span.end, name, null);
    createReference(ctx, ident, symbolId, flags);
    return ident;
}

/** oxc `create_unbound_ident_expr`. */
export const createUnboundReference = (ctx: DceCtx, span: Span, name: string, flags: number): Node =>
    createIdentExpr(ctx, span, name, 0, flags);

// --- mutation (ecma_context.rs, dropped_subtree_collector.rs) -------------------------------------

/** The callee of a direct `eval(...)` call, or null. */
export function asDirectEvalCall(call: Node): Node | null {
    if (call.type !== N.CallExpression || call.data.optional) return null;
    const callee = getInnerExpression(call.data.callee);
    return callee.type === N.IdentifierReference && callee.name === 'eval' ? callee : null;
}

/** oxc `DroppedSubtreeCollector`: mark every reference in `root` removed and note dropped direct
 *  `eval` calls. `survivors` are subtrees moved into a replacement; they are not dropped. */
function collectDroppedSubtree(ctx: DceCtx, root: Node, survivors: ReadonlySet<Node> | null): void {
    const changes = ctx.state.passChanges;
    walk(root, (visited) => {
        if (survivors?.has(visited)) return false;
        if (visited.type === N.IdentifierReference) {
            const reference = referenceOf(ctx, visited);
            // References minted since the last flush are beyond capacity and treated as live.
            if (
                reference !== null &&
                reference.id < changes.referenceCapacity &&
                !reference.markedRemoved &&
                !reference.pruned
            ) {
                reference.markedRemoved = true;
                changes.removedReferences.push(reference);
            }
        } else if (visited.type === N.CallExpression && asDirectEvalCall(visited) !== null) {
            changes.directEvalDropped = true;
        }
        return true;
    });
}

/** Nodes of `replacement` that already sit in `target`'s subtree: they move rather than drop. */
function survivingSubtrees(target: Node, replacement: Node): Set<Node> {
    const previous = new Set<Node>();
    walk(target, (visited) => {
        previous.add(visited);
    });
    const survivors = new Set<Node>();
    walk(replacement, (visited) => {
        if (visited === target)
            throw new Error('dce: a replacement may not contain the node it replaces; move it out with takeNode');
        if (!previous.has(visited)) return true;
        survivors.add(visited);
        return false;
    });
    return survivors;
}

/** oxc's raw `*slot = new`: `target` becomes `replacement` in place, with no reference accounting. */
export function overwriteNode(ctx: DceCtx, target: Node, replacement: Node): void {
    if (target === replacement) return;
    const moved = referenceOf(ctx, replacement);
    retargetOwnership(ctx, replacement, target);
    set(target, replacement.type, replacement.data as never);
    const rest = target as { name: string; sym: number; start: number; end: number };
    rest.name = replacement.name;
    rest.sym = replacement.sym;
    rest.start = replacement.start;
    rest.end = replacement.end;
    if (moved !== null) {
        moved.node = target;
        target.ref = moved.id;
    }
}

/** Point the semantic records that name `from` by identity (its scope, its declaration) at `to`. */
function retargetOwnership(ctx: DceCtx, from: Node, to: Node): void {
    const semantic = ctx.scoping.semantic;
    const scopeId = (from.data as { scopeId?: number } | null)?.scopeId ?? 0;
    if (scopeId > 0 && semantic.scopes[scopeId]?.node === from) semantic.scopes[scopeId].node = to;
    if (from.type === N.BindingIdentifier && from.sym > 0 && semantic.symbols[from.sym]?.decl === from)
        semantic.symbols[from.sym].decl = to;
    if (ctx.directives.delete(from)) ctx.directives.add(to);
}

/** oxc `take_in`: move `target`'s contents into a fresh node and leave a placeholder in its slot, so
 *  the moved node can go inside `target`'s replacement. */
export function takeNode(ctx: DceCtx, target: Node): Node {
    const moved = node(target.type, target.start, target.end, target.name, target.data as never);
    (moved as { sym: number }).sym = target.sym;
    const reference = referenceOf(ctx, target);
    if (reference !== null) {
        reference.node = moved;
        moved.ref = reference.id;
    }
    retargetOwnership(ctx, target, moved);
    set(target, N.NullLiteral, null);
    (target as { name: string }).name = 'null';
    return moved;
}

function replaceNode(ctx: DceCtx, target: Node, replacement: Node): void {
    if (target !== replacement) {
        collectDroppedSubtree(ctx, target, survivingSubtrees(target, replacement));
        overwriteNode(ctx, target, replacement);
    }
    recordAstChange(ctx.state);
}

/** Replace an expression slot. References only in the old subtree are marked removed. */
export const replaceExpression = (ctx: DceCtx, target: Node, replacement: Node): void => replaceNode(ctx, target, replacement);

export const replaceStatement = (ctx: DceCtx, target: Node, replacement: Node): void => replaceNode(ctx, target, replacement);

export const replaceAssignmentTargetProperty = (ctx: DceCtx, target: Node, replacement: Node): void =>
    replaceNode(ctx, target, replacement);

export const replacePropertyKey = (ctx: DceCtx, target: Node, replacement: Node): void => replaceNode(ctx, target, replacement);

export const replaceForStatementLeft = (ctx: DceCtx, target: Node, replacement: Node): void =>
    replaceNode(ctx, target, replacement);

/** Mark the pass as having mutated the AST without a slot replacement. */
export function noticeChange(ctx: DceCtx): void {
    recordAstChange(ctx.state);
}

function dropNode(ctx: DceCtx, root: Node): void {
    collectDroppedSubtree(ctx, root, null);
    recordAstChange(ctx.state);
}

/** Mark a subtree about to leave the tree. Detach any part that stays alive before calling. */
export const dropExpression = (ctx: DceCtx, expression: Node): void => dropNode(ctx, expression);

export const dropStatement = (ctx: DceCtx, statement: Node): void => dropNode(ctx, statement);

export const dropClassElement = (ctx: DceCtx, element: Node): void => dropNode(ctx, element);

export const dropVariableDeclarator = (ctx: DceCtx, declarator: Node): void => dropNode(ctx, declarator);

export const dropSwitchCase = (ctx: DceCtx, switchCase: Node): void => dropNode(ctx, switchCase);

// --- values (ecma_context.rs) --------------------------------------------------------------------

export const options = (ctx: DceCtx): CompressOptions => ctx.state.options;

export const sourceType = (ctx: DceCtx): SourceType => ctx.state.sourceType;

/** oxc `supports_feature`: the target engines have `feature` natively. */
export const supportsFeature = (ctx: DceCtx, feature: string): boolean => !ctx.state.options.target.hasFeature(feature);

/** A registered reference with no symbol. A fresh identifier with no reference is not global. */
export function isGlobalReference(ctx: DceCtx, ident: Node): boolean {
    if (ident.type !== N.IdentifierReference) return false;
    const reference = referenceOf(ctx, ident);
    return reference !== null && reference.symbolId === 0;
}

export function isGlobalExpr(ctx: DceCtx, name: string, expr: Node): boolean {
    const inner = getInnerExpression(expr);
    return inner.type === N.IdentifierReference && inner.name === name && isGlobalReference(ctx, inner);
}

/** oxc `tracked_constant_for_reference_id`. */
function trackedConstantFor(ctx: DceCtx, ident: Node): ConstantValue | null {
    const reference = referenceOf(ctx, ident);
    if (reference === null || reference.symbolId === 0) return null;
    const value = symbolValueOf(ctx.state.symbols, reference.symbolId);
    if (value === null || countsHaveWrites(value.references)) return null;
    return value.initializedConstant;
}

function constantValueType(value: ConstantValue): ValueType {
    return value.kind;
}

export function evalBinaryOperation(ctx: DceCtx, operator: string, left: Node, right: Node): ConstantValue | null {
    const binary = {
        id: 0,
        type: N.BinaryExpression,
        start: left.start,
        end: right.end,
        name: '',
        sym: 0,
        data: { operator, left, right },
    } as Node;
    return evaluateValueInContext(binary, ctx);
}

/** `NaN`/`Infinity` printed where a binding in the current scope chain captures the name. */
function nonFiniteGlobalShadowed(ctx: DceCtx, value: number): boolean {
    let name: string;
    if (Number.isNaN(value)) name = 'NaN';
    else if (!Number.isFinite(value)) name = 'Infinity';
    else return false;
    return findBinding(ctx, ctx.currentScopeId, name) !== 0;
}

const numberLiteralName = (value: number): string => (Object.is(value, -0) ? '-0' : String(value));

function nonFiniteToDivisionExpr(span: Span, value: number): Node {
    let left = node(N.NumericLiteral, span.start, span.end, Number.isNaN(value) ? '0' : '1', null);
    if (value === Number.NEGATIVE_INFINITY) {
        left = node(N.UnaryExpression, span.start, span.end, '', { operator: '-', prefix: true, argument: left });
    }
    const right = node(N.NumericLiteral, span.start, span.end, '0', null);
    return node(N.BinaryExpression, span.start, span.end, '', { operator: '/', left, right });
}

/** oxc `Expression::new_void_0`. */
export function createVoidZero(span: Span): Node {
    const zero = node(N.NumericLiteral, span.start, span.end, '0', null);
    return node(N.UnaryExpression, span.start, span.end, '', { operator: 'void', prefix: true, argument: zero });
}

export function valueToExpr(ctx: DceCtx, span: Span, value: ConstantValue): Node {
    switch (value.kind) {
        case 'number':
            if (!Number.isFinite(value.value) && nonFiniteGlobalShadowed(ctx, value.value))
                return nonFiniteToDivisionExpr(span, value.value);
            return node(N.NumericLiteral, span.start, span.end, numberLiteralName(value.value), null);
        case 'bigint':
            return node(N.BigIntLiteral, span.start, span.end, `${value.value}n`, null);
        case 'string':
            return node(N.StringLiteral, span.start, span.end, JSON.stringify(value.value), null);
        case 'boolean':
            return node(N.BooleanLiteral, span.start, span.end, value.value ? 'true' : 'false', null);
        case 'undefined':
            return createVoidZero(span);
        case 'null':
            return node(N.NullLiteral, span.start, span.end, 'null', null);
    }
}

export function evalBinary(ctx: DceCtx, binary: Node): Node | null {
    if (binary.type !== N.BinaryExpression || mayHaveSideEffects(binary, ctx)) return null;
    const value = evalBinaryOperation(ctx, binary.data.operator, binary.data.left, binary.data.right);
    if (value === null) return null;
    if (value.kind === 'number' && nonFiniteGlobalShadowed(ctx, value.value)) return null;
    return valueToExpr(ctx, binary, value);
}

export function isIdentifierUndefined(ctx: DceCtx, ident: Node): boolean {
    return ident.name === 'undefined' && isGlobalReference(ctx, ident);
}

export function isExpressionUndefined(ctx: DceCtx, expr: Node): boolean {
    if (expr.type === N.IdentifierReference) return isIdentifierUndefined(ctx, expr);
    return expr.type === N.UnaryExpression && expr.data.operator === 'void' && expr.data.argument.type === N.NumericLiteral;
}

export const expressionValueType = (ctx: DceCtx, expr: Node): ValueType => valueType(expr, ctx);

/** oxc's derived `ContentEq`: structural equality ignoring spans, ids, scopes and symbols. */
export function contentEq(left: Node | null, right: Node | null): boolean {
    if (left === right) return true;
    if (left === null || right === null || left.type !== right.type) return false;
    switch (left.type) {
        case N.NumericLiteral:
            return Object.is(numericLiteralValue(left), numericLiteralValue(right));
        case N.BigIntLiteral:
            return bigIntLiteralValue(left) === bigIntLiteralValue(right);
        case N.StringLiteral: {
            const leftValue = stringLiteralValue(left);
            const rightValue = stringLiteralValue(right);
            return leftValue.value === rightValue.value && leftValue.loneSurrogates === rightValue.loneSurrogates;
        }
    }
    if (left.name !== right.name) return false;
    const leftData = left.data as Record<string, unknown> | null;
    const rightData = right.data as Record<string, unknown> | null;
    if (leftData === null || rightData === null) return leftData === rightData;
    for (const key of Object.keys(leftData)) {
        if (key === 'scopeId') continue;
        const leftValue = leftData[key];
        const rightValue = rightData[key];
        if (Array.isArray(leftValue)) {
            if (!Array.isArray(rightValue) || leftValue.length !== rightValue.length) return false;
            for (let index = 0; index < leftValue.length; index++) {
                if (!contentEq(leftValue[index] as Node | null, rightValue[index] as Node | null)) return false;
            }
        } else if (leftValue !== null && typeof leftValue === 'object') {
            if (rightValue === null || typeof rightValue !== 'object') return false;
            if (!contentEq(leftValue as Node, rightValue as Node)) return false;
        } else if (leftValue !== rightValue) return false;
    }
    return true;
}

/** oxc `expr_eq`: content-equal, or both `undefined`. */
export function exprEq(ctx: DceCtx, left: Node, right: Node): boolean {
    return contentEq(left, right) || (isExpressionUndefined(ctx, left) && isExpressionUndefined(ctx, right));
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** oxc `string_to_equivalent_number_value` (esbuild): the number whose `ToString` is exactly `text`,
 *  for canonical 32-bit integers only. */
export function stringToEquivalentNumberValue(text: string): number | null {
    if (text.length === 0) return null;
    let isNegative = false;
    let intValue = 0;
    let start = 0;
    if (text[0] === '-' && text.length > 1) {
        isNegative = true;
        start = 1;
    }
    if (text[start] === '0' && text.length > 1) return null;
    for (let index = start; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code < 48 || code > 57) return null;
        const digit = code & 15;
        intValue = isNegative ? intValue * 10 - digit : intValue * 10 + digit;
        if (intValue < INT32_MIN || intValue > INT32_MAX) return null;
    }
    return intValue;
}

/** oxc `init_value`: record what `symbolId` was initialized with for this pass. */
export function initValue(
    ctx: DceCtx,
    symbolId: number,
    constant: ConstantValue | null,
    kind: FreshValueKind,
    falsyInit: boolean,
    initAbsent: boolean,
): void {
    const references = createReferenceCounts();
    for (const reference of getResolvedReferences(ctx, symbolId)) recordReferenceCount(references, reference.flags);

    const scopeId = symbolScopeId(ctx, symbolId);
    const flags = scopeFlags(ctx, scopeId);
    // A nested function can consume the first declaration's facts before a later declaration of the
    // same symbol is visited, so every declaration-derived fact is disabled from the outset.
    let valueDeclarations = 0;
    for (const declarationFlags of symbolRedeclarations(ctx, symbolId)) if (symbolIsValue(declarationFlags)) valueDeclarations++;
    const hasMultipleValueDeclarations = valueDeclarations > 1;

    const valueWithheld = constant === null;
    const directEval = scopeContainsDirectEval(flags);
    const initializedConstant = hasMultipleValueDeclarations || directEval ? null : constant;

    const booleanFalsy = hasMultipleValueDeclarations
        ? false
        : falsyInit &&
          valueWithheld &&
          !countsHaveWrites(references) &&
          !directEval &&
          !(ctx.state.sourceType === 'script' && scopeId === ctx.scoping.rootScopeId);

    const implicitUndefined = initAbsent && initializedConstant !== null && initializedConstant.kind === 'undefined';

    const value: SymbolValue = {
        initializedConstant,
        implicitUndefined,
        references,
        kind: hasMultipleValueDeclarations ? 'none' : kind,
        booleanFalsy,
    };
    storeSymbolValue(ctx.state.symbols, symbolId, value);
}

/** Whether the closest function scope is an async generator. */
export function isClosestFunctionScopeAnAsyncGenerator(ctx: DceCtx): boolean {
    for (let at = ctx.ancestorDepth - 1; at >= 0; at--) {
        const kind = ctx.ancestorKinds[at];
        if (kind === 'FunctionBody') {
            const fn = ctx.ancestorNodes[at].data as { async: boolean; generator: boolean };
            return fn.async && fn.generator;
        }
        if (kind === 'ArrowFunctionExpressionBody') return false;
    }
    return false;
}

/** oxc `Expression::is_anonymous_function_definition`. */
export function isAnonymousFunctionDefinition(expr: Node): boolean {
    switch (expr.type) {
        case N.ArrowFunctionExpression:
            return true;
        case N.FunctionExpression:
        case N.ClassExpression:
            return expr.data.id === null;
        default:
            return false;
    }
}

/** Whether the assignment expression needs to be kept to preserve the name. */
export function isExpressionWhoseNameNeedsToBeKept(ctx: DceCtx, expr: Node): boolean {
    const keepNames = ctx.state.options.keepNames;
    if (!keepNames.class && !keepNames.function) return false;
    if (!isAnonymousFunctionDefinition(expr)) return false;
    const isClass = expr.type === N.ClassExpression;
    return (keepNames.class && isClass) || (keepNames.function && !isClass);
}

// --- building the scoping view -------------------------------------------------------------------

type ScopingBuild = WalkState & {
    scoping: Scoping;
    /** oxc `SemanticBuilder::current_reference_flags`, consumed by the next identifier reference. */
    currentReferenceFlags: number;
    /** Flags saved around a conditional's test. */
    savedConditionalFlags: number[];
};

const isMemberExpressionType = (type: number): boolean =>
    type === N.StaticMemberExpression || type === N.ComputedMemberExpression || type === N.PrivateFieldExpression;

const isTargetPosition = (position: WalkPosition): boolean =>
    position === WalkPosition.AssignmentTarget || position === WalkPosition.SimpleAssignmentTarget;

/** Directive-shaped leading statements of a program or function body: unparenthesised string literals. */
function recordDirectives(build: ScopingBuild, body: Node[]): void {
    for (const statement of body) {
        if (statement.type !== N.ExpressionStatement) return;
        const expression = statement.data.expression;
        if (expression.type !== N.StringLiteral || expression.start !== statement.start) return;
        build.directives.add(statement);
    }
}

function symbolFlagsFromSemantic(flags: number): number {
    let result = 0;
    if ((flags & (SYM.VAR | SYM.PARAM)) !== 0) result |= SymbolFlags.FunctionScopedVariable;
    if ((flags & SYM.LET) !== 0) result |= SymbolFlags.BlockScopedVariable;
    if ((flags & SYM.CONST) !== 0) result |= SymbolFlags.BlockScopedVariable | SymbolFlags.ConstVariable;
    if ((flags & SYM.FUNCTION) !== 0) result |= SymbolFlags.Function;
    if ((flags & SYM.FN_EXPR_NAME) !== 0) result |= SymbolFlags.FunctionExpression;
    if ((flags & SYM.CLASS) !== 0) result |= SymbolFlags.Class;
    if ((flags & SYM.CATCH) !== 0) result |= SymbolFlags.CatchVariable | SymbolFlags.FunctionScopedVariable;
    if ((flags & SYM.IMPORT) !== 0) result |= (flags & SYM.TYPE) !== 0 ? SymbolFlags.TypeImport : SymbolFlags.Import;
    if ((flags & SYM.ENUM) !== 0) result |= SymbolFlags.RegularEnum;
    if ((flags & SYM.NAMESPACE) !== 0) result |= SymbolFlags.ValueModule;
    return result;
}

const functionSymbolFlags = (fn: Node, expression: boolean): number =>
    SymbolFlags.Function |
    (expression ? SymbolFlags.FunctionExpression : 0) |
    ((fn.data as { async: boolean; generator: boolean }).async || (fn.data as { generator: boolean }).generator
        ? SymbolFlags.AsyncOrGeneratorFunction
        : 0);

/** The oxc `SymbolFlags` a binding identifier declares, from the declaration it sits in. */
function bindingSymbolFlags(build: ScopingBuild): number {
    for (let at = build.ancestorDepth - 1; at >= 0; at--) {
        const owner = build.ancestorNodes[at];
        switch (build.ancestorKinds[at]) {
            case 'BindingPropertyValue':
            case 'BindingPropertyKey':
            case 'ObjectPatternProperties':
            case 'ObjectPatternRest':
            case 'ArrayPatternElements':
            case 'ArrayPatternRest':
            case 'AssignmentPatternLeft':
            case 'BindingRestElementArgument':
            case 'FormalParameterPattern':
            case 'VariableDeclaratorId':
                continue;
            case 'VariableDeclarationDeclarations': {
                const kind = (owner.data as { kind: string }).kind;
                if (kind === 'var') return SymbolFlags.FunctionScopedVariable;
                if (kind === 'let') return SymbolFlags.BlockScopedVariable;
                return SymbolFlags.BlockScopedVariable | SymbolFlags.ConstVariable;
            }
            case 'FormalParametersItems':
            case 'FormalParametersRest':
                return SymbolFlags.FunctionScopedVariable;
            case 'CatchClauseParam':
                return at === build.ancestorDepth - 1
                    ? SymbolFlags.FunctionScopedVariable | SymbolFlags.CatchVariable
                    : SymbolFlags.BlockScopedVariable | SymbolFlags.CatchVariable;
            case 'FunctionId':
                return functionSymbolFlags(owner, owner.type === N.FunctionExpression);
            case 'ClassId':
                return SymbolFlags.Class;
            case 'ImportSpecifierLocal':
            case 'ImportDefaultSpecifierLocal':
            case 'ImportNamespaceSpecifierLocal': {
                const declaration = at > 0 ? build.ancestorNodes[at - 1] : owner;
                const typeOnly =
                    (owner.data as { importKind?: string }).importKind === 'type' ||
                    (declaration.data as { importKind?: string } | null)?.importKind === 'type';
                return typeOnly ? SymbolFlags.TypeImport : SymbolFlags.Import;
            }
            default:
                return 0;
        }
    }
    return 0;
}

/** oxc `SemanticBuilder`'s reference-flag bookkeeping, replayed over the walk so each reference gets
 *  the flags oxc's semantic analysis gives it. */
const scopingBuilder: Traverser<ScopingBuild> = {
    enterProgram(build, program) {
        recordDirectives(build, (program.data as DataOf<'Program'>).body);
    },
    enterFunctionBody(build, body) {
        recordDirectives(build, (body.data as DataOf<'BlockStatement'>).body);
    },
    enterNode(build, visited, position) {
        const scoping = build.scoping;
        switch (visited.type) {
            case N.IdentifierReference: {
                // `export { a } from 'm'` names another module's export: oxc parses that `local` as an
                // IdentifierName, not a reference
                if (parentKind(build) === 'ExportSpecifierLocal' && (ancestor(build, 1).node.data as { source: Node | null }).source !== null)
                    return;
                if (position === WalkPosition.AssignmentTargetPropertyIdentifier)
                    build.currentReferenceFlags = ReferenceFlags.Write;
                else if (isTargetPosition(position) && !referenceIsWrite(build.currentReferenceFlags))
                    build.currentReferenceFlags = ReferenceFlags.Write;
                if (parentKind(build) === 'ExportDefaultDeclarationDeclaration')
                    build.currentReferenceFlags = ReferenceFlags.Read | ReferenceFlags.Type;
                let flags = build.currentReferenceFlags;
                if (flags === 0) flags = ReferenceFlags.Read;
                else build.currentReferenceFlags = 0;
                registerReference(scoping, visited, visited.sym, build.currentScopeId, flags);
                return;
            }
            case N.StaticMemberExpression:
            case N.ComputedMemberExpression:
            case N.PrivateFieldExpression:
                if (isTargetPosition(position) && !referenceIsWrite(build.currentReferenceFlags))
                    build.currentReferenceFlags = ReferenceFlags.Write;
                // `A.B = 1` writes a property of `A`, so `A` is read as a member write target.
                if (referenceIsWrite(build.currentReferenceFlags))
                    build.currentReferenceFlags = ReferenceFlags.Read | ReferenceFlags.MemberWriteTarget;
                else build.currentReferenceFlags &= ~ReferenceFlags.Write;
                return;
            case N.TSAsExpression:
            case N.TSSatisfiesExpression:
            case N.TSNonNullExpression:
                if (isTargetPosition(position) && !referenceIsWrite(build.currentReferenceFlags))
                    build.currentReferenceFlags = ReferenceFlags.Write;
                return;
            case N.AssignmentExpression:
                if (
                    (position === WalkPosition.Expression || position === WalkPosition.ArrowFunctionExpressionBody) &&
                    visited.data.operator !== '='
                )
                    build.currentReferenceFlags = ReferenceFlags.Read | ReferenceFlags.Write;
                return;
            case N.UpdateExpression:
                build.currentReferenceFlags = ReferenceFlags.Read | ReferenceFlags.Write;
                return;
            case N.UnaryExpression:
                // `delete a.foo` is a property write context; `delete x` is not.
                if (visited.data.operator === 'delete' && isMemberExpressionType(visited.data.argument.type))
                    build.currentReferenceFlags = ReferenceFlags.Write;
                return;
            case N.ConditionalExpression:
                build.savedConditionalFlags.push(build.currentReferenceFlags);
                build.currentReferenceFlags &= ~ReferenceFlags.MemberWriteTarget;
                return;
            case N.CallExpression:
                if (!visited.data.optional) {
                    const callee = getInnerExpression(visited.data.callee);
                    if (callee.type === N.IdentifierReference && callee.name === 'eval')
                        scoping.scopeFlags[build.currentScopeId] |= ScopeFlags.DirectEval;
                }
                return;
            case N.FunctionExpression:
            case N.FunctionDeclaration: {
                const scopeId = visited.data.scopeId;
                if (scopeId > 0 && parentKind(build) === 'MethodDefinitionValue') {
                    const method = build.ancestorNodes[build.ancestorDepth - 1].data as { kind: string };
                    if (method.kind === 'get') scoping.scopeFlags[scopeId] |= ScopeFlags.GetAccessor;
                    else if (method.kind === 'set') scoping.scopeFlags[scopeId] |= ScopeFlags.SetAccessor;
                    else if (method.kind === 'constructor') scoping.scopeFlags[scopeId] |= ScopeFlags.Constructor;
                }
                return;
            }
            case N.BindingIdentifier:
                if (visited.sym > 0) {
                    scoping.symbolFlags[visited.sym] |= bindingSymbolFlags(build);
                    scoping.symbolsWithBindings[visited.sym] = 1;
                }
                return;
        }
    },
    exitNode(build, visited) {
        if (isMemberExpressionType(visited.type)) build.currentReferenceFlags = 0;
        switch (parentKind(build)) {
            case 'ConditionalExpressionTest':
                build.currentReferenceFlags = build.savedConditionalFlags.pop() ?? 0;
                return;
            case 'ComputedMemberExpressionObject':
                build.currentReferenceFlags &= ~ReferenceFlags.MemberWriteTarget;
                return;
            case 'ClassHeritageExpression':
                build.currentReferenceFlags = 0;
                return;
        }
    },
};
const walkScoping = compileWalker<ScopingBuild>(hookNamesOf(scopingBuilder));

function scopeFlagsFromSemantic(semantic: Semantic, scopeId: number): number {
    const record = semantic.scopes[scopeId];
    let flags = (record.flags & SCOPE_STRICT) !== 0 ? ScopeFlags.StrictMode : 0;
    switch (scopeKind(record.flags)) {
        case SCOPE.MODULE:
            flags |= ScopeFlags.Top;
            break;
        case SCOPE.FUNCTION:
            flags |= ScopeFlags.Function;
            if (record.node !== null && record.node.type === N.ArrowFunctionExpression) flags |= ScopeFlags.Arrow;
            break;
        case SCOPE.CATCH:
            flags |= ScopeFlags.CatchClause;
            break;
        case SCOPE.STATIC_BLOCK:
            flags |= ScopeFlags.ClassStaticBlock;
            break;
        case SCOPE.NAMESPACE:
            flags |= ScopeFlags.TsModuleBlock;
            break;
    }
    return flags;
}

/** Build the scoping view of `program` from `semantic`, and the directive prologues. */
export function buildScoping(
    program: Node,
    semantic: Semantic,
    noSideEffectSymbols: ReadonlySet<number>,
): { scoping: Scoping; directives: Set<Node> } {
    const rootScopeId = (program.data as { scopeId: number }).scopeId;
    const symbolCount = semantic.symbols.length;
    const scopeCount = semantic.scopes.length;
    const scoping: Scoping = {
        semantic,
        symbolScopeIds: new Array(symbolCount),
        symbolFlags: new Array(symbolCount),
        symbolRedeclarations: new Map(),
        resolvedReferences: new Array(symbolCount),
        references: [],
        scopeParentIds: new Array(scopeCount),
        scopeFlags: new Array(scopeCount),
        rootScopeId,
        noSideEffects: noSideEffectSymbols,
        symbolsWithBindings: new Uint8Array(symbolCount),
    };
    for (let symbolId = 0; symbolId < symbolCount; symbolId++) {
        scoping.symbolScopeIds[symbolId] = semantic.symbols[symbolId].scope;
        scoping.symbolFlags[symbolId] = 0;
        scoping.resolvedReferences[symbolId] = [];
    }
    for (let scopeId = 0; scopeId < scopeCount; scopeId++) {
        scoping.scopeParentIds[scopeId] = scopeId === rootScopeId ? 0 : semantic.scopes[scopeId].parent;
        scoping.scopeFlags[scopeId] = scopeId === 0 ? 0 : scopeFlagsFromSemantic(semantic, scopeId);
    }
    for (const [symbolId, declarations] of semantic.redeclarations) {
        scoping.symbolRedeclarations.set(
            symbolId,
            declarations.map((declaration) => symbolFlagsFromSemantic(declaration.flags)),
        );
    }

    const build: ScopingBuild = { ...createWalkState(rootScopeId), scoping, currentReferenceFlags: 0, savedConditionalFlags: [] };
    walkScoping(scopingBuilder, program, build);

    for (let symbolId = 1; symbolId < symbolCount; symbolId++) {
        if (scoping.symbolFlags[symbolId] === 0)
            scoping.symbolFlags[symbolId] = symbolFlagsFromSemantic(semantic.symbols[symbolId].flags);
    }
    // A direct eval marks every enclosing scope, as oxc's semantic builder does on leaving each scope.
    for (let scopeId = 1; scopeId < scopeCount; scopeId++) {
        if ((scoping.scopeFlags[scopeId] & ScopeFlags.DirectEval) === 0) continue;
        for (let scope = scoping.scopeParentIds[scopeId]; scope > 0; scope = scoping.scopeParentIds[scope]) {
            scoping.scopeFlags[scope] |= ScopeFlags.DirectEval;
        }
    }
    return { scoping, directives: build.directives };
}

/** Create the context for one DCE run over `program`, oxc's `ReusableTraverseCtx::new`. */
export function createDceCtx(
    program: Node,
    semantic: Semantic,
    compressOptions: CompressOptions,
    mode: CompressionMode,
    moduleSourceType: SourceType,
    noSideEffectSymbols: ReadonlySet<number>,
    verify: boolean,
): DceCtx {
    const { scoping, directives } = buildScoping(program, semantic, noSideEffectSymbols);
    const state = createMinifierState(moduleSourceType, compressOptions, mode, scoping);
    const treeshake = compressOptions.treeshake;
    const ctx: DceCtx = {
        ...createWalkState(scoping.rootScopeId),
        directives,
        scoping,
        state,
        verify,
        isGlobalReference: (ident) => isGlobalReference(ctx, ident),
        constantValueForReference: (ident) => trackedConstantFor(ctx, ident),
        valueTypeForReference: (ident) => {
            const constant = trackedConstantFor(ctx, ident);
            return constant === null ? null : constantValueType(constant);
        },
        constantOf: (ident) => trackedConstantFor(ctx, ident),
        engineTargets: compressOptions.target,
        annotations: treeshake.annotations,
        manualPureFunctions: (callee) =>
            treeshake.manualPureFunctions.length > 0 && isPureFunction(callee, treeshake.manualPureFunctions),
        propertyReadSideEffects: treeshake.propertyReadSideEffects,
        propertyWriteSideEffects: treeshake.propertyWriteSideEffects,
        unknownGlobalSideEffects: treeshake.unknownGlobalSideEffects,
    };
    return ctx;
}
