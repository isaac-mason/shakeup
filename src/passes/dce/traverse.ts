// Port of oxc_minifier/src/minifier_traverse.rs and the generated `walk.rs`, for the hooks
// `peephole/mod.rs` and `peephole/normalize.rs` implement.
//
// Children are visited in oxc's field order and each hook fires where oxc's generated walker fires
// it. shakeup reuses expression node types for assignment targets and patterns, so which hooks a node
// gets is decided by the slot it sits in (its position), not only by its type. The walk is iterative:
// a hook may rewrite the node it is given in place, and the walk continues from the node's new shape.

import { N, type Node } from '../../ast/index.ts';
import type { AncestorKind, WalkState } from './traverse-context.ts';

/** The oxc hook family a node receives, by the slot it sits in. */
export const WalkPosition = {
    None: 0,
    Statement: 1,
    Expression: 2,
    AssignmentTarget: 3,
    SimpleAssignmentTarget: 4,
    AssignmentTargetPropertyIdentifier: 5,
    FunctionBody: 6,
    ArrowFunctionBlockBody: 7,
    ArrowFunctionExpressionBody: 8,
} as const;
export type WalkPosition = (typeof WalkPosition)[keyof typeof WalkPosition];

type Hook<C> = (ctx: C, node: Node) => void;

/** The `Traverse` hooks the minifier implements. `enterNode`/`exitNode` fire for every node visited. */
export type Traverser<C> = {
    enterProgram?: Hook<C>;
    exitProgram?: Hook<C>;
    enterStatement?: Hook<C>;
    exitStatement?: Hook<C>;
    /** A statement list after its statements were walked. `firstStatement` skips the directive prologue. */
    exitStatements?: (ctx: C, statements: Node[], firstStatement: number) => void;
    enterExpression?: Hook<C>;
    exitExpression?: Hook<C>;
    enterFunction?: Hook<C>;
    enterFunctionBody?: Hook<C>;
    exitFunctionBody?: Hook<C>;
    enterArrowFunctionBody?: Hook<C>;
    exitArrowFunctionBody?: Hook<C>;
    enterVariableDeclaration?: Hook<C>;
    exitVariableDeclaration?: Hook<C>;
    exitVariableDeclarator?: Hook<C>;
    /** oxc `ExportNamedDeclaration`: `export { a }` with no declaration and no source. */
    enterExportNamedDeclaration?: Hook<C>;
    /** oxc `ExportDeclaration`: an `ExportNamedDeclaration` carrying a declaration. */
    enterExportDeclaration?: Hook<C>;
    enterExportDefaultDeclaration?: Hook<C>;
    exitCallExpression?: Hook<C>;
    exitNewExpression?: Hook<C>;
    exitUpdateExpression?: Hook<C>;
    exitUnaryExpression?: Hook<C>;
    exitAssignmentTarget?: Hook<C>;
    enterNode?: (ctx: C, node: Node, position: WalkPosition) => void;
    exitNode?: (ctx: C, node: Node, position: WalkPosition) => void;
};

const OP_CHILD = 0;
const OP_LIST = 1;
const OP_STATEMENTS = 2;
const OP_SCOPE = 3;

// Slots: where a child sits, before its type resolves the hooks it gets and how it is walked.
const SLOT_NONE = 0;
const SLOT_STATEMENT = 1;
const SLOT_EXPRESSION = 2;
const SLOT_ASSIGNMENT_TARGET = 3;
const SLOT_SIMPLE_ASSIGNMENT_TARGET = 4;
const SLOT_TARGET_MAYBE_DEFAULT = 5;
const SLOT_ARRAY_TARGET_ELEMENT = 6;
const SLOT_TARGET_PROPERTY = 7;
const SLOT_TARGET_PROPERTY_VALUE = 8;
const SLOT_TARGET_PROPERTY_IDENTIFIER = 9;
const SLOT_BINDING_PROPERTY = 10;
const SLOT_ARRAY_PATTERN_ELEMENT = 11;
const SLOT_PARAMETER = 12;
const SLOT_PROPERTY_KEY = 13;
const SLOT_ARGUMENT = 14;
const SLOT_FUNCTION_BODY = 15;
const SLOT_ARROW_BODY = 16;
const SLOT_FOR_INIT = 17;
const SLOT_FOR_LEFT = 18;
const SLOT_EXPORT_DEFAULT = 19;
const SLOT_CHAIN_ELEMENT = 20;
const SLOT_JSX_EXPRESSION = 21;

// Roles: how a node is walked when its slot gives its type a different meaning.
const ROLE_DEFAULT = 0;
const ROLE_ARRAY_TARGET = 1;
const ROLE_OBJECT_TARGET = 2;
const ROLE_TARGET_PROPERTY = 3;
const ROLE_WITH_DEFAULT = 4;
const ROLE_PROPERTY_IDENTIFIER_WITH_INIT = 5;
const ROLE_REST_TARGET = 6;
const ROLE_FUNCTION_BODY = 7;
const ROLE_BINDING_PROPERTY = 8;

type Instruction = { op: number; field: string; slot: number; kind: AncestorKind };

const child = (field: string, slot: number, kind: AncestorKind): Instruction => ({ op: OP_CHILD, field, slot, kind });
const list = (field: string, slot: number, kind: AncestorKind): Instruction => ({ op: OP_LIST, field, slot, kind });
const statements = (field: string, kind: AncestorKind): Instruction => ({ op: OP_STATEMENTS, field, slot: SLOT_STATEMENT, kind });
const SCOPE: Instruction = { op: OP_SCOPE, field: '', slot: SLOT_NONE, kind: 'None' };

/** Every plan, by id: the generated walker has one straight-line case per plan. */
const PLAN_BY_ID: Instruction[][] = [];
const registerPlan = (instructions: Instruction[]): number => PLAN_BY_ID.push(instructions) - 1;
const NO_CHILDREN = registerPlan([]);

const PLAN_OF_TYPE: number[] = [];
const plan = (type: number, instructions: Instruction[]): void => {
    PLAN_OF_TYPE[type] = registerPlan(instructions);
};

plan(N.Program, [SCOPE, statements('body', 'ProgramBody')]);
plan(N.TemplateLiteral, [
    list('quasis', SLOT_NONE, 'TemplateLiteralQuasis'),
    list('expressions', SLOT_EXPRESSION, 'TemplateLiteralExpressions'),
]);
plan(N.TaggedTemplateExpression, [
    child('tag', SLOT_EXPRESSION, 'TaggedTemplateExpressionTag'),
    child('quasi', SLOT_NONE, 'TaggedTemplateExpressionQuasi'),
]);
plan(N.ArrayExpression, [list('elements', SLOT_ARGUMENT, 'ArrayExpressionElements')]);
plan(N.ObjectExpression, [list('properties', SLOT_NONE, 'ObjectExpressionProperties')]);
plan(N.ObjectProperty, [
    child('key', SLOT_PROPERTY_KEY, 'ObjectPropertyKey'),
    child('value', SLOT_EXPRESSION, 'ObjectPropertyValue'),
]);
plan(N.SpreadElement, [child('argument', SLOT_EXPRESSION, 'SpreadElementArgument')]);
plan(N.BinaryExpression, [
    child('left', SLOT_EXPRESSION, 'BinaryExpressionLeft'),
    child('right', SLOT_EXPRESSION, 'BinaryExpressionRight'),
]);
const PRIVATE_IN_PLAN = registerPlan([
    child('left', SLOT_NONE, 'PrivateInExpressionLeft'),
    child('right', SLOT_EXPRESSION, 'PrivateInExpressionRight'),
]);
plan(N.LogicalExpression, [
    child('left', SLOT_EXPRESSION, 'LogicalExpressionLeft'),
    child('right', SLOT_EXPRESSION, 'LogicalExpressionRight'),
]);
plan(N.AssignmentExpression, [
    child('left', SLOT_ASSIGNMENT_TARGET, 'AssignmentExpressionLeft'),
    child('right', SLOT_EXPRESSION, 'AssignmentExpressionRight'),
]);
plan(N.UnaryExpression, [child('argument', SLOT_EXPRESSION, 'UnaryExpressionArgument')]);
plan(N.UpdateExpression, [child('argument', SLOT_SIMPLE_ASSIGNMENT_TARGET, 'UpdateExpressionArgument')]);
plan(N.ConditionalExpression, [
    child('test', SLOT_EXPRESSION, 'ConditionalExpressionTest'),
    child('consequent', SLOT_EXPRESSION, 'ConditionalExpressionConsequent'),
    child('alternate', SLOT_EXPRESSION, 'ConditionalExpressionAlternate'),
]);
plan(N.CallExpression, [
    child('callee', SLOT_EXPRESSION, 'CallExpressionCallee'),
    list('arguments', SLOT_ARGUMENT, 'CallExpressionArguments'),
]);
plan(N.NewExpression, [
    child('callee', SLOT_EXPRESSION, 'NewExpressionCallee'),
    list('arguments', SLOT_ARGUMENT, 'NewExpressionArguments'),
]);
plan(N.StaticMemberExpression, [
    child('object', SLOT_EXPRESSION, 'StaticMemberExpressionObject'),
    child('property', SLOT_NONE, 'StaticMemberExpressionProperty'),
]);
plan(N.ComputedMemberExpression, [
    child('object', SLOT_EXPRESSION, 'ComputedMemberExpressionObject'),
    child('expression', SLOT_EXPRESSION, 'ComputedMemberExpressionExpression'),
]);
plan(N.PrivateFieldExpression, [
    child('object', SLOT_EXPRESSION, 'PrivateFieldExpressionObject'),
    child('field', SLOT_NONE, 'PrivateFieldExpressionField'),
]);
plan(N.ChainExpression, [child('expression', SLOT_CHAIN_ELEMENT, 'ChainExpressionExpression')]);
plan(N.SequenceExpression, [list('expressions', SLOT_EXPRESSION, 'SequenceExpressionExpressions')]);
plan(N.ArrowFunctionExpression, [
    SCOPE,
    list('params', SLOT_PARAMETER, 'FormalParametersItems'),
    child('body', SLOT_ARROW_BODY, 'ArrowFunctionExpressionBody'),
]);
const FUNCTION_PLAN = [
    SCOPE,
    child('id', SLOT_NONE, 'FunctionId'),
    list('params', SLOT_PARAMETER, 'FormalParametersItems'),
    child('body', SLOT_FUNCTION_BODY, 'FunctionBody'),
];
plan(N.FunctionExpression, FUNCTION_PLAN);
plan(N.FunctionDeclaration, FUNCTION_PLAN);
plan(N.FormalParameter, [
    child('pattern', SLOT_NONE, 'FormalParameterPattern'),
    child('init', SLOT_EXPRESSION, 'FormalParameterInitializer'),
]);
plan(N.RestElement, [child('argument', SLOT_NONE, 'BindingRestElementArgument')]);
const CLASS_PLAN = [
    list('decorators', SLOT_NONE, 'ClassDecorators'),
    child('id', SLOT_NONE, 'ClassId'),
    SCOPE,
    child('superClass', SLOT_EXPRESSION, 'ClassHeritageExpression'),
    list('body', SLOT_NONE, 'ClassBodyBody'),
];
plan(N.ClassExpression, CLASS_PLAN);
plan(N.ClassDeclaration, CLASS_PLAN);
plan(N.Decorator, [child('expression', SLOT_EXPRESSION, 'DecoratorExpression')]);
plan(N.MethodDefinition, [
    list('decorators', SLOT_NONE, 'MethodDefinitionDecorators'),
    child('key', SLOT_PROPERTY_KEY, 'MethodDefinitionKey'),
    child('value', SLOT_NONE, 'MethodDefinitionValue'),
]);
plan(N.PropertyDefinition, [
    list('decorators', SLOT_NONE, 'PropertyDefinitionDecorators'),
    child('key', SLOT_PROPERTY_KEY, 'PropertyDefinitionKey'),
    child('value', SLOT_EXPRESSION, 'PropertyDefinitionValue'),
]);
plan(N.StaticBlock, [SCOPE, statements('body', 'StaticBlockBody')]);
plan(N.YieldExpression, [child('argument', SLOT_EXPRESSION, 'YieldExpressionArgument')]);
plan(N.AwaitExpression, [child('argument', SLOT_EXPRESSION, 'AwaitExpressionArgument')]);
plan(N.ImportExpression, [
    child('source', SLOT_EXPRESSION, 'ImportExpressionSource'),
    child('options', SLOT_EXPRESSION, 'ImportExpressionOptions'),
]);
plan(N.ExpressionStatement, [child('expression', SLOT_EXPRESSION, 'ExpressionStatementExpression')]);
plan(N.VariableDeclaration, [list('declarations', SLOT_NONE, 'VariableDeclarationDeclarations')]);
plan(N.VariableDeclarator, [
    child('id', SLOT_NONE, 'VariableDeclaratorId'),
    child('init', SLOT_EXPRESSION, 'VariableDeclaratorInit'),
]);
plan(N.BlockStatement, [SCOPE, statements('body', 'BlockStatementBody')]);
const FUNCTION_BODY_PLAN = registerPlan([statements('body', 'FunctionBodyStatements')]);
plan(N.IfStatement, [
    child('test', SLOT_EXPRESSION, 'IfStatementTest'),
    child('consequent', SLOT_STATEMENT, 'IfStatementConsequent'),
    child('alternate', SLOT_STATEMENT, 'IfStatementAlternate'),
]);
plan(N.ForStatement, [
    SCOPE,
    child('init', SLOT_FOR_INIT, 'ForStatementInit'),
    child('test', SLOT_EXPRESSION, 'ForStatementTest'),
    child('update', SLOT_EXPRESSION, 'ForStatementUpdate'),
    child('body', SLOT_STATEMENT, 'ForStatementBody'),
]);
plan(N.ForInStatement, [
    SCOPE,
    child('left', SLOT_FOR_LEFT, 'ForInStatementLeft'),
    child('right', SLOT_EXPRESSION, 'ForInStatementRight'),
    child('body', SLOT_STATEMENT, 'ForInStatementBody'),
]);
plan(N.ForOfStatement, [
    SCOPE,
    child('left', SLOT_FOR_LEFT, 'ForOfStatementLeft'),
    child('right', SLOT_EXPRESSION, 'ForOfStatementRight'),
    child('body', SLOT_STATEMENT, 'ForOfStatementBody'),
]);
plan(N.WhileStatement, [
    child('test', SLOT_EXPRESSION, 'WhileStatementTest'),
    child('body', SLOT_STATEMENT, 'WhileStatementBody'),
]);
plan(N.DoWhileStatement, [
    child('body', SLOT_STATEMENT, 'DoWhileStatementBody'),
    child('test', SLOT_EXPRESSION, 'DoWhileStatementTest'),
]);
plan(N.SwitchStatement, [
    child('discriminant', SLOT_EXPRESSION, 'SwitchStatementDiscriminant'),
    SCOPE,
    list('cases', SLOT_NONE, 'SwitchStatementCases'),
]);
plan(N.SwitchCase, [child('test', SLOT_EXPRESSION, 'SwitchCaseTest'), statements('consequent', 'SwitchCaseConsequent')]);
plan(N.TryStatement, [
    child('block', SLOT_NONE, 'TryStatementBlock'),
    child('handler', SLOT_NONE, 'TryStatementHandler'),
    child('finalizer', SLOT_NONE, 'TryStatementFinalizer'),
]);
plan(N.CatchClause, [SCOPE, child('param', SLOT_NONE, 'CatchClauseParam'), child('body', SLOT_NONE, 'CatchClauseBody')]);
plan(N.ReturnStatement, [child('argument', SLOT_EXPRESSION, 'ReturnStatementArgument')]);
plan(N.ThrowStatement, [child('argument', SLOT_EXPRESSION, 'ThrowStatementArgument')]);
plan(N.BreakStatement, [child('label', SLOT_NONE, 'BreakStatementLabel')]);
plan(N.ContinueStatement, [child('label', SLOT_NONE, 'ContinueStatementLabel')]);
plan(N.LabeledStatement, [
    child('label', SLOT_NONE, 'LabeledStatementLabel'),
    child('body', SLOT_STATEMENT, 'LabeledStatementBody'),
]);
plan(N.WithStatement, [
    child('object', SLOT_EXPRESSION, 'WithStatementObject'),
    SCOPE,
    child('body', SLOT_STATEMENT, 'WithStatementBody'),
]);
plan(N.ImportDeclaration, [
    list('specifiers', SLOT_NONE, 'ImportDeclarationSpecifiers'),
    child('source', SLOT_NONE, 'ImportDeclarationSource'),
    list('attributes', SLOT_NONE, 'ImportDeclarationWithClause'),
]);
plan(N.ImportSpecifier, [
    child('imported', SLOT_NONE, 'ImportSpecifierImported'),
    child('local', SLOT_NONE, 'ImportSpecifierLocal'),
]);
plan(N.ImportDefaultSpecifier, [child('local', SLOT_NONE, 'ImportDefaultSpecifierLocal')]);
plan(N.ImportNamespaceSpecifier, [child('local', SLOT_NONE, 'ImportNamespaceSpecifierLocal')]);
plan(N.ImportAttribute, [child('key', SLOT_NONE, 'ImportAttributeKey'), child('value', SLOT_NONE, 'ImportAttributeValue')]);
const EXPORT_DECLARATION_PLAN = registerPlan([child('declaration', SLOT_NONE, 'ExportDeclarationDeclaration')]);
const EXPORT_NAMED_PLAN = registerPlan([list('specifiers', SLOT_NONE, 'ExportNamedDeclarationSpecifiers')]);
const EXPORT_FROM_PLAN = registerPlan([
    child('source', SLOT_NONE, 'ExportFromDeclarationSource'),
    list('attributes', SLOT_NONE, 'ExportFromDeclarationWithClause'),
]);
plan(N.ExportSpecifier, [
    child('local', SLOT_NONE, 'ExportSpecifierLocal'),
    child('exported', SLOT_NONE, 'ExportSpecifierExported'),
]);
plan(N.ExportDefaultDeclaration, [child('declaration', SLOT_EXPORT_DEFAULT, 'ExportDefaultDeclarationDeclaration')]);
plan(N.ExportAllDeclaration, [
    child('exported', SLOT_NONE, 'ExportAllDeclarationExported'),
    child('source', SLOT_NONE, 'ExportAllDeclarationSource'),
    list('attributes', SLOT_NONE, 'ExportAllDeclarationWithClause'),
]);
plan(N.ObjectPattern, [list('properties', SLOT_BINDING_PROPERTY, 'ObjectPatternProperties')]);
plan(N.ArrayPattern, [list('elements', SLOT_ARRAY_PATTERN_ELEMENT, 'ArrayPatternElements')]);
plan(N.AssignmentPattern, [
    child('left', SLOT_NONE, 'AssignmentPatternLeft'),
    child('right', SLOT_EXPRESSION, 'AssignmentPatternRight'),
]);
plan(N.TSAsExpression, [child('expression', SLOT_EXPRESSION, 'TSAsExpressionExpression')]);
plan(N.TSSatisfiesExpression, [child('expression', SLOT_EXPRESSION, 'TSSatisfiesExpressionExpression')]);
plan(N.TSNonNullExpression, [child('expression', SLOT_EXPRESSION, 'TSNonNullExpressionExpression')]);
plan(N.TSInstantiationExpression, [child('expression', SLOT_EXPRESSION, 'TSInstantiationExpressionExpression')]);
plan(N.JSXElement, [
    child('openingElement', SLOT_NONE, 'JSXElementOpeningElement'),
    list('children', SLOT_NONE, 'JSXElementChildren'),
    child('closingElement', SLOT_NONE, 'JSXElementClosingElement'),
]);
plan(N.JSXOpeningElement, [
    child('name', SLOT_NONE, 'JSXOpeningElementName'),
    list('attributes', SLOT_NONE, 'JSXOpeningElementAttributes'),
]);
plan(N.JSXClosingElement, [child('name', SLOT_NONE, 'JSXClosingElementName')]);
plan(N.JSXFragment, [list('children', SLOT_NONE, 'JSXFragmentChildren')]);
plan(N.JSXAttribute, [child('name', SLOT_NONE, 'JSXAttributeName'), child('value', SLOT_NONE, 'JSXAttributeValue')]);
plan(N.JSXSpreadAttribute, [child('argument', SLOT_EXPRESSION, 'JSXSpreadAttributeArgument')]);
plan(N.JSXExpressionContainer, [child('expression', SLOT_JSX_EXPRESSION, 'JSXExpressionContainerExpression')]);
plan(N.JSXSpreadChild, [child('expression', SLOT_EXPRESSION, 'JSXSpreadChildExpression')]);
plan(N.JSXMemberExpression, [
    child('object', SLOT_NONE, 'JSXMemberExpressionObject'),
    child('property', SLOT_NONE, 'JSXMemberExpressionProperty'),
]);
plan(N.JSXNamespacedName, [
    child('namespace', SLOT_NONE, 'JSXNamespacedNameNamespace'),
    child('name', SLOT_NONE, 'JSXNamespacedNameName'),
]);

const ARRAY_TARGET_PLAN = registerPlan([list('elements', SLOT_ARRAY_TARGET_ELEMENT, 'ArrayAssignmentTargetElements')]);
const OBJECT_TARGET_PLAN = registerPlan([list('properties', SLOT_TARGET_PROPERTY, 'ObjectAssignmentTargetProperties')]);
const TARGET_PROPERTY_IDENTIFIER_PLAN = registerPlan([
    child('value', SLOT_TARGET_PROPERTY_VALUE, 'AssignmentTargetPropertyIdentifierBinding'),
]);
const TARGET_PROPERTY_PROPERTY_PLAN = registerPlan([
    child('key', SLOT_PROPERTY_KEY, 'AssignmentTargetPropertyPropertyName'),
    child('value', SLOT_TARGET_MAYBE_DEFAULT, 'AssignmentTargetPropertyPropertyBinding'),
]);
const WITH_DEFAULT_PLAN = registerPlan([
    child('left', SLOT_ASSIGNMENT_TARGET, 'AssignmentTargetWithDefaultBinding'),
    child('right', SLOT_EXPRESSION, 'AssignmentTargetWithDefaultInit'),
]);
const PROPERTY_IDENTIFIER_WITH_INIT_PLAN = registerPlan([
    child('left', SLOT_TARGET_PROPERTY_IDENTIFIER, 'AssignmentTargetPropertyIdentifierBinding'),
    child('right', SLOT_EXPRESSION, 'AssignmentTargetPropertyIdentifierInit'),
]);
const REST_TARGET_PLAN = registerPlan([child('argument', SLOT_ASSIGNMENT_TARGET, 'AssignmentTargetRestTarget')]);
const BINDING_PROPERTY_PLAN = registerPlan([
    child('key', SLOT_PROPERTY_KEY, 'BindingPropertyKey'),
    child('value', SLOT_NONE, 'BindingPropertyValue'),
]);

function planFor(node: Node, role: number): number {
    switch (role) {
        case ROLE_ARRAY_TARGET:
            return ARRAY_TARGET_PLAN;
        case ROLE_OBJECT_TARGET:
            return OBJECT_TARGET_PLAN;
        case ROLE_TARGET_PROPERTY:
            return (node.data as { shorthand: boolean }).shorthand
                ? TARGET_PROPERTY_IDENTIFIER_PLAN
                : TARGET_PROPERTY_PROPERTY_PLAN;
        case ROLE_WITH_DEFAULT:
            return WITH_DEFAULT_PLAN;
        case ROLE_PROPERTY_IDENTIFIER_WITH_INIT:
            return PROPERTY_IDENTIFIER_WITH_INIT_PLAN;
        case ROLE_REST_TARGET:
            return REST_TARGET_PLAN;
        case ROLE_FUNCTION_BODY:
            return FUNCTION_BODY_PLAN;
        case ROLE_BINDING_PROPERTY:
            return BINDING_PROPERTY_PLAN;
    }
    switch (node.type) {
        case N.BinaryExpression:
            return node.data.left.type === N.PrivateIdentifier ? PRIVATE_IN_PLAN : PLAN_OF_TYPE[N.BinaryExpression];
        case N.ExportNamedDeclaration:
            if (node.data.declaration !== null) return EXPORT_DECLARATION_PLAN;
            return node.data.source === null ? EXPORT_NAMED_PLAN : EXPORT_FROM_PLAN;
    }
    return PLAN_OF_TYPE[node.type] ?? NO_CHILDREN;
}

function kindFor(slot: number, node: Node, kind: AncestorKind): AncestorKind {
    switch (slot) {
        case SLOT_ARRAY_TARGET_ELEMENT:
            return node.type === N.SpreadElement ? 'ArrayAssignmentTargetRest' : kind;
        case SLOT_TARGET_PROPERTY:
            return node.type === N.SpreadElement ? 'ObjectAssignmentTargetRest' : kind;
        case SLOT_BINDING_PROPERTY:
            return node.type === N.RestElement ? 'ObjectPatternRest' : kind;
        case SLOT_ARRAY_PATTERN_ELEMENT:
            return node.type === N.RestElement ? 'ArrayPatternRest' : kind;
        case SLOT_PARAMETER:
            return node.type === N.RestElement ? 'FormalParametersRest' : kind;
    }
    return kind;
}

/** A child's position and role, packed as `position | role << 4` so resolving one allocates nothing. */
const pack = (position: number, role: number): number => position | (role << 4);

function resolveAssignmentTarget(node: Node): number {
    if (node.type === N.ArrayExpression) return pack(WalkPosition.AssignmentTarget, ROLE_ARRAY_TARGET);
    if (node.type === N.ObjectExpression) return pack(WalkPosition.AssignmentTarget, ROLE_OBJECT_TARGET);
    return pack(WalkPosition.AssignmentTarget, ROLE_DEFAULT);
}

function resolveSlot(slot: number, node: Node): number {
    switch (slot) {
        case SLOT_STATEMENT:
            return WalkPosition.Statement;
        case SLOT_EXPRESSION:
            return WalkPosition.Expression;
        case SLOT_ASSIGNMENT_TARGET:
            return resolveAssignmentTarget(node);
        case SLOT_SIMPLE_ASSIGNMENT_TARGET:
            return WalkPosition.SimpleAssignmentTarget;
        case SLOT_TARGET_MAYBE_DEFAULT:
            if (node.type === N.AssignmentExpression || node.type === N.AssignmentPattern) return pack(WalkPosition.None, ROLE_WITH_DEFAULT);
            return resolveAssignmentTarget(node);
        case SLOT_ARRAY_TARGET_ELEMENT:
            if (node.type === N.SpreadElement) return pack(WalkPosition.None, ROLE_REST_TARGET);
            if (node.type === N.AssignmentExpression || node.type === N.AssignmentPattern) return pack(WalkPosition.None, ROLE_WITH_DEFAULT);
            return resolveAssignmentTarget(node);
        case SLOT_TARGET_PROPERTY:
            return pack(WalkPosition.None, node.type === N.SpreadElement ? ROLE_REST_TARGET : ROLE_TARGET_PROPERTY);
        case SLOT_TARGET_PROPERTY_VALUE:
            if (node.type === N.AssignmentPattern || node.type === N.AssignmentExpression)
                return pack(WalkPosition.None, ROLE_PROPERTY_IDENTIFIER_WITH_INIT);
            return WalkPosition.AssignmentTargetPropertyIdentifier;
        case SLOT_TARGET_PROPERTY_IDENTIFIER:
            return WalkPosition.AssignmentTargetPropertyIdentifier;
        case SLOT_BINDING_PROPERTY:
            return node.type === N.ObjectProperty ? pack(WalkPosition.None, ROLE_BINDING_PROPERTY) : WalkPosition.None;
        case SLOT_PROPERTY_KEY:
            return node.type !== N.IdentifierName && node.type !== N.PrivateIdentifier ? WalkPosition.Expression : WalkPosition.None;
        case SLOT_ARGUMENT:
            return node.type !== N.SpreadElement ? WalkPosition.Expression : WalkPosition.None;
        case SLOT_FUNCTION_BODY:
            return pack(WalkPosition.FunctionBody, ROLE_FUNCTION_BODY);
        case SLOT_ARROW_BODY:
            return node.type === N.BlockStatement
                ? pack(WalkPosition.ArrowFunctionBlockBody, ROLE_FUNCTION_BODY)
                : WalkPosition.ArrowFunctionExpressionBody;
        case SLOT_FOR_INIT:
            return node.type !== N.VariableDeclaration ? WalkPosition.Expression : WalkPosition.None;
        case SLOT_FOR_LEFT:
            return node.type !== N.VariableDeclaration ? resolveAssignmentTarget(node) : WalkPosition.None;
        case SLOT_EXPORT_DEFAULT:
            return node.type !== N.FunctionDeclaration && node.type !== N.ClassDeclaration && node.type !== N.TSInterfaceDeclaration
                ? WalkPosition.Expression
                : WalkPosition.None;
        case SLOT_CHAIN_ELEMENT:
            return node.type !== N.CallExpression &&
                node.type !== N.StaticMemberExpression &&
                node.type !== N.ComputedMemberExpression &&
                node.type !== N.PrivateFieldExpression &&
                node.type !== N.TSNonNullExpression
                ? WalkPosition.Expression
                : WalkPosition.None;
        case SLOT_JSX_EXPRESSION:
            return node.type !== N.JSXEmptyExpression ? WalkPosition.Expression : WalkPosition.None;
    }
    return WalkPosition.None;
}

/** Slots whose ancestor kind depends on the child's own type. */
const KIND_DEPENDS_ON_CHILD = new Set([
    SLOT_ARRAY_TARGET_ELEMENT,
    SLOT_TARGET_PROPERTY,
    SLOT_BINDING_PROPERTY,
    SLOT_ARRAY_PATTERN_ELEMENT,
    SLOT_PARAMETER,
]);

const HOOK_NAMES = [
    'enterProgram',
    'exitProgram',
    'enterStatement',
    'exitStatement',
    'exitStatements',
    'enterExpression',
    'exitExpression',
    'enterFunction',
    'enterFunctionBody',
    'exitFunctionBody',
    'enterArrowFunctionBody',
    'exitArrowFunctionBody',
    'enterVariableDeclaration',
    'exitVariableDeclaration',
    'exitVariableDeclarator',
    'enterExportNamedDeclaration',
    'enterExportDeclaration',
    'enterExportDefaultDeclaration',
    'exitCallExpression',
    'exitNewExpression',
    'exitUpdateExpression',
    'exitUnaryExpression',
    'exitAssignmentTarget',
    'enterNode',
    'exitNode',
] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/** A compiled walk: the traverser whose hooks it fires, the program, the context. */
export type Walker<C> = (traverser: Traverser<C>, program: Node, ctx: C) => void;

/** Plans by type, dense, so the generated code can index without a hole check. */
const PLAN_OF_TYPE_DENSE: number[] = [];
for (let type = 0; type < 512; type++) PLAN_OF_TYPE_DENSE[type] = PLAN_OF_TYPE[type] ?? NO_CHILDREN;

/** Code that sets `position` and `role` for a child `next` in `slot`: constants for the slots whose
 *  answer does not depend on the child, `resolveSlot` for the rest. */
function slotSource(slot: number): string {
    switch (slot) {
        case SLOT_NONE:
            return `position = ${WalkPosition.None}; role = ${ROLE_DEFAULT};`;
        case SLOT_STATEMENT:
            return `position = ${WalkPosition.Statement}; role = ${ROLE_DEFAULT};`;
        case SLOT_EXPRESSION:
            return `position = ${WalkPosition.Expression}; role = ${ROLE_DEFAULT};`;
        case SLOT_SIMPLE_ASSIGNMENT_TARGET:
            return `position = ${WalkPosition.SimpleAssignmentTarget}; role = ${ROLE_DEFAULT};`;
        case SLOT_TARGET_PROPERTY_IDENTIFIER:
            return `position = ${WalkPosition.AssignmentTargetPropertyIdentifier}; role = ${ROLE_DEFAULT};`;
        case SLOT_FUNCTION_BODY:
            return `position = ${WalkPosition.FunctionBody}; role = ${ROLE_FUNCTION_BODY};`;
    }
    return `{ const resolved = resolveSlot(${slot}, next); position = resolved & 15; role = resolved >> 4; }`;
}

/** oxc's ancestor push for the current frame, inline. */
const ancestorSource = (kind: string): string =>
    `if (ancestorPushed[top] === 0) { ancestorPushed[top] = 1; ctx.ancestorDepth++; }
{ const at = ctx.ancestorDepth - 1; ancestorNodes[at] = node; ancestorKinds[at] = ${kind}; }`;

/** The body of one plan's case: its children in order, each resumed at `step`. */
function planSource(instructions: Instruction[], hooks: ReadonlySet<HookName>): string {
    let source = '';
    for (let step = 0; step < instructions.length; step++) {
        const { op, field, slot, kind } = instructions[step];
        const kindText = JSON.stringify(kind);
        source += `if (step === ${step}) {\n`;
        switch (op) {
            case OP_SCOPE:
                source += `const scopeId = data.scopeId;
if (scopeId > 0 && savedScopes[top] < 0) { savedScopes[top] = ctx.currentScopeId; ctx.currentScopeId = scopeId; }
step = ${step + 1};\n`;
                break;
            case OP_CHILD:
                source += `step = ${step + 1};
const value = data.${field};
if (value != null) { steps[top] = step; ${ancestorSource(kindText)} next = value; ${slotSource(slot)} break plan; }\n`;
                break;
            case OP_LIST: {
                const elementKind = KIND_DEPENDS_ON_CHILD.has(slot) ? `kindFor(${slot}, element, ${kindText})` : kindText;
                source += `const elements = data.${field};
for (;;) {
    const index = listIndexes[top];
    if (elements == null || index >= elements.length) { listIndexes[top] = 0; step = ${step + 1}; break; }
    listIndexes[top] = index + 1;
    const element = elements[index];
    if (element != null) { steps[top] = step; ${ancestorSource(elementKind)} next = element; ${slotSource(slot)} break plan; }
}\n`;
                break;
            }
            case OP_STATEMENTS:
                source += `const body = data.${field};
if (listStarts[top] < 0) {
    let start = 0;
    while (start < body.length && ctx.directives.has(body[start])) start++;
    listStarts[top] = start;
    listIndexes[top] = start;
}
const index = listIndexes[top];
if (index < body.length) { listIndexes[top] = index + 1; steps[top] = step; ${ancestorSource(kindText)} next = body[index]; ${slotSource(SLOT_STATEMENT)} break plan; }
${ancestorSource(kindText)}
${hooks.has('exitStatements') ? 'traverser.exitStatements(ctx, body, listStarts[top]);' : ''}
step = ${step + 1}; listIndexes[top] = 0; listStarts[top] = -1;\n`;
                break;
        }
        source += '}\n';
    }
    return source;
}

/** A hook call on `target`, or nothing when the traverser has no such hook. */
const call = (hooks: ReadonlySet<HookName>, name: HookName, target: string, extra = ''): string =>
    hooks.has(name) ? `traverser.${name}(ctx, ${target}${extra});\n` : '';

/** oxc's enter hooks for `target` at `position` in `role`. */
function enterSource(hooks: ReadonlySet<HookName>, target: string): string {
    const P = WalkPosition;
    return `switch (position) {
    case ${P.Statement}: ${call(hooks, 'enterStatement', target)} break;
    case ${P.Expression}: ${call(hooks, 'enterExpression', target)} break;
    case ${P.FunctionBody}: ${call(hooks, 'enterFunctionBody', target)} break;
    case ${P.ArrowFunctionBlockBody}: ${call(hooks, 'enterArrowFunctionBody', target)}${call(hooks, 'enterFunctionBody', target)} break;
    case ${P.ArrowFunctionExpressionBody}: ${call(hooks, 'enterArrowFunctionBody', target)}${call(hooks, 'enterExpression', target)} break;
}
if (role === ${ROLE_DEFAULT}) {
    switch (${target}.type) {
        case ${N.Program}: ${call(hooks, 'enterProgram', target)} break;
        case ${N.FunctionDeclaration}:
        case ${N.FunctionExpression}: ${call(hooks, 'enterFunction', target)} break;
        case ${N.VariableDeclaration}: ${call(hooks, 'enterVariableDeclaration', target)} break;
        case ${N.ExportNamedDeclaration}:
            if (${target}.data.declaration !== null) { ${call(hooks, 'enterExportDeclaration', target)} }
            else if (${target}.data.source === null) { ${call(hooks, 'enterExportNamedDeclaration', target)} }
            break;
        case ${N.ExportDefaultDeclaration}: ${call(hooks, 'enterExportDefaultDeclaration', target)} break;
    }
}
${call(hooks, 'enterNode', target, ', position')}`;
}

/** oxc's exit hooks for `target`, which had `position` and, when walked in the default role, `type`. */
function exitSource(hooks: ReadonlySet<HookName>, target: string, position: string, type: string): string {
    const P = WalkPosition;
    return `${hooks.has('exitNode') ? `traverser.exitNode(ctx, ${target}, ${position});` : ''}
switch (${type}) {
    case ${N.Program}: ${call(hooks, 'exitProgram', target)} break;
    case ${N.VariableDeclarator}: ${call(hooks, 'exitVariableDeclarator', target)} break;
    case ${N.VariableDeclaration}: ${call(hooks, 'exitVariableDeclaration', target)} break;
    case ${N.CallExpression}: ${call(hooks, 'exitCallExpression', target)} break;
    case ${N.NewExpression}: ${call(hooks, 'exitNewExpression', target)} break;
    case ${N.UpdateExpression}: ${call(hooks, 'exitUpdateExpression', target)} break;
    case ${N.UnaryExpression}: ${call(hooks, 'exitUnaryExpression', target)} break;
}
switch (${position}) {
    case ${P.Statement}: ${call(hooks, 'exitStatement', target)} break;
    case ${P.Expression}: ${call(hooks, 'exitExpression', target)} break;
    case ${P.AssignmentTarget}: ${call(hooks, 'exitAssignmentTarget', target)} break;
    case ${P.FunctionBody}: ${call(hooks, 'exitFunctionBody', target)} break;
    case ${P.ArrowFunctionBlockBody}: ${call(hooks, 'exitFunctionBody', target)}${call(hooks, 'exitArrowFunctionBody', target)} break;
    case ${P.ArrowFunctionExpressionBody}: ${call(hooks, 'exitExpression', target)}${call(hooks, 'exitArrowFunctionBody', target)} break;
}`;
}

/** Plan selection for `next` after its enter hooks, as {@link planFor} decides it. */
const planSelectSource = `let planId;
if (role === ${ROLE_DEFAULT}) {
    const nextType = next.type;
    if (nextType === ${N.BinaryExpression}) planId = next.data.left.type === ${N.PrivateIdentifier} ? ${PRIVATE_IN_PLAN} : planOfType[nextType];
    else if (nextType === ${N.ExportNamedDeclaration}) planId = planFor(next, role);
    else planId = planOfType[nextType];
} else planId = planFor(next, role);`;

/**
 * Compile oxc's `traverse_mut_with_ctx` for one hook set: each plan becomes straight-line code with
 * literal field access, child positions resolved at compile time where they are fixed, and only the
 * hooks in `hooks` called. Compile once per call site; the traverser passed to the walker must
 * implement exactly these hooks.
 */
export function compileWalker<C extends WalkState>(hooks: readonly HookName[]): Walker<C> {
    const present = new Set(hooks);
    let cases = '';
    for (let id = 0; id < PLAN_BY_ID.length; id++) {
        if (PLAN_BY_ID[id].length === 0) continue;
        cases += `case ${id}: {\n${planSource(PLAN_BY_ID[id], present)}break;\n}\n`;
    }
    // One frame per node being walked, eight ints each: plan, type, position, step, list index, list
    // start, saved scope, whether the ancestor entry was pushed.
    const pushSource = `top++;
{
    const pushed = top << 3;
    if (pushed === frames.length) { const grown = new Int32Array(frames.length * 2); grown.set(frames); frames = grown; }
    nodes[top] = next;
    frames[pushed] = planId; frames[pushed + 1] = role === ${ROLE_DEFAULT} ? next.type : 0; frames[pushed + 2] = position;
    frames[pushed + 3] = 0; frames[pushed + 4] = 0; frames[pushed + 5] = -1; frames[pushed + 6] = -1; frames[pushed + 7] = 0;
}`;
    const source = `
const ancestorNodes = ctx.ancestorNodes, ancestorKinds = ctx.ancestorKinds;
// A walk started from inside another one's hook finds no spare and makes its own.
let frames = spare === null ? new Int32Array(${8 * 256}) : spare;
spare = null;
const nodes = [];
let top = -1;
let node = null;
walk: {
    {
        const next = program, position = ${WalkPosition.None}, role = ${ROLE_DEFAULT};
        ${enterSource(present, 'next')}
        ${planSelectSource}
        if (planId === ${NO_CHILDREN}) { const nextType = role === ${ROLE_DEFAULT} ? next.type : 0; ${exitSource(present, 'next', 'position', 'nextType')} break walk; }
        ${pushSource}
    }
    while (top >= 0) {
        const frame = top << 3;
        node = nodes[top];
        const data = node.data;
        let step = steps[top];
        let next = null;
        let position = 0;
        let role = 0;
        plan: switch (planIds[top]) {
${cases}
        }
        if (next !== null) {
            ${enterSource(present, 'next')}
            // after the enter hooks, which may have retyped the node in place
            ${planSelectSource}
            if (planId === ${NO_CHILDREN}) {
                const nextType = role === ${ROLE_DEFAULT} ? next.type : 0;
                ${exitSource(present, 'next', 'position', 'nextType')}
                continue;
            }
            ${pushSource}
            continue;
        }
        if (ancestorPushed[top] === 1) ctx.ancestorDepth--;
        if (savedScopes[top] >= 0) ctx.currentScopeId = savedScopes[top];
        const leftPosition = positions[top];
        const leftType = types[top];
        nodes[top] = null;
        top--;
        ${exitSource(present, 'node', 'leftPosition', 'leftType')}
    }
}
spare = frames;`
        .replaceAll('planIds[top]', 'frames[frame]')
        .replaceAll('types[top]', 'frames[frame + 1]')
        .replaceAll('positions[top]', 'frames[frame + 2]')
        .replaceAll('steps[top]', 'frames[frame + 3]')
        .replaceAll('listIndexes[top]', 'frames[frame + 4]')
        .replaceAll('listStarts[top]', 'frames[frame + 5]')
        .replaceAll('savedScopes[top]', 'frames[frame + 6]')
        .replaceAll('ancestorPushed[top]', 'frames[frame + 7]');
    const factory = new Function(
        'planFor',
        'resolveSlot',
        'kindFor',
        'planOfType',
        `let spare = null; return function walk(traverser, program, ctx) {${source}};`,
    ) as (
        planForArgument: typeof planFor,
        resolveSlotArgument: typeof resolveSlot,
        kindForArgument: typeof kindFor,
        planOfTypeArgument: number[],
    ) => Walker<C>;
    return factory(planFor, resolveSlot, kindFor, PLAN_OF_TYPE_DENSE);
}

/** The hooks `traverser` implements, in the order {@link compileWalker} takes them. */
export const hookNamesOf = <C>(traverser: Traverser<C>): HookName[] => HOOK_NAMES.filter((name) => traverser[name] !== undefined);

/** Walk `program` firing `traverser`'s hooks, oxc's `traverse_mut_with_ctx`. Compiles a walker for the
 *  traverser's hooks on every call: a hot call site compiles one once with {@link compileWalker}. */
export function traverseProgram<C extends WalkState>(traverser: Traverser<C>, program: Node, ctx: C): void {
    compileWalker<C>(hookNamesOf(traverser))(traverser, program, ctx);
}
