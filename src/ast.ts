import { enumeration } from './util/enumeration';

export const NODE_TYPE_NAMES = [
    'Program',
    // Four identifier ROLES (oxc js.rs:189-267). All map to 'Identifier' in
    // ESTREE_NAME; kept CONTIGUOUS so isIdentifier is a range check. The parser
    // classifies at construction; semantic declares off BindingIdentifier and
    // resolves off IdentifierReference (IdentifierName/LabelIdentifier never resolve).
    'BindingIdentifier', 'IdentifierReference', 'IdentifierName', 'LabelIdentifier',
    'PrivateIdentifier', 'NumericLiteral', 'StringLiteral', 'BooleanLiteral', 'NullLiteral', 'RegExpLiteral', 'BigIntLiteral',
    'TemplateElement', 'ThisExpression', 'Super', 'ImportMeta', 'NewTarget',
    'TemplateLiteral', 'TaggedTemplateExpression', 'ArrayExpression', 'ObjectExpression', 'ObjectProperty', 'SpreadElement',
    'BinaryExpression', 'LogicalExpression', 'AssignmentExpression', 'UnaryExpression', 'UpdateExpression', 'ConditionalExpression', 'CallExpression', 'NewExpression',
    // Member access split three ways (oxc js.rs:508-541, their field names). The
    // `computed` payload boolean dies; `optional` stays per-type. Kept CONTIGUOUS
    // where MemberExpression sat. All three map to 'MemberExpression' in ESTREE_NAME.
    'StaticMemberExpression', 'ComputedMemberExpression', 'PrivateFieldExpression',
    // ESTree-semantics wrapper around the OUTERMOST link of an optional chain (a
    // chain containing any `?.` link; parentheses TERMINATE the chain). Transparent
    // wrapper — pureness/rewriting/TS-stripping all see through it.
    'ChainExpression',
    'SequenceExpression', 'ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression', 'YieldExpression', 'AwaitExpression', 'ImportExpression',
    'ExpressionStatement', 'VariableDeclaration', 'VariableDeclarator', 'BlockStatement', 'IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
    'WhileStatement', 'DoWhileStatement', 'SwitchStatement', 'SwitchCase', 'TryStatement', 'CatchClause', 'ReturnStatement', 'ThrowStatement',
    'BreakStatement', 'ContinueStatement', 'LabeledStatement', 'EmptyStatement', 'DebuggerStatement', 'FunctionDeclaration', 'ClassDeclaration',
    'MethodDefinition', 'PropertyDefinition', 'StaticBlock',
    'ObjectPattern', 'ArrayPattern', 'AssignmentPattern', 'RestElement', 'FormalParameter',
    'ImportDeclaration', 'ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier',
    'ExportNamedDeclaration', 'ExportSpecifier', 'ExportDefaultDeclaration', 'ExportAllDeclaration',
    'TSTypeAnnotation',
    // 14 keyword leaves — kept CONTIGUOUS (TSAnyKeyword..TSThisType) so isTypeOnlyNode's
    // range check stays a bounds test; see isTypeOnlyNode below.
    'TSAnyKeyword', 'TSStringKeyword', 'TSNumberKeyword', 'TSBooleanKeyword', 'TSBigIntKeyword',
    'TSSymbolKeyword', 'TSObjectKeyword', 'TSVoidKeyword', 'TSUndefinedKeyword', 'TSNullKeyword',
    'TSNeverKeyword', 'TSUnknownKeyword', 'TSIntrinsicKeyword', 'TSThisType',
    'TSTypeReference', 'TSQualifiedName', 'TSTypeParameterInstantiation', 'TSTypeParameterDeclaration',
    'TSTypeParameter', 'TSTupleType', 'TSNamedTupleMember', 'TSTypeLiteral', 'TSPropertySignature', 'TSMethodSignature',
    'TSIndexSignature', 'TSCallSignatureDeclaration', 'TSConstructSignatureDeclaration', 'TSUnionType', 'TSIntersectionType', 'TSFunctionType',
    'TSConstructorType', 'TSArrayType', 'TSIndexedAccessType', 'TSTypeOperator', 'TSTypeQuery',
    'TSConditionalType', 'TSInferType', 'TSMappedType', 'TSLiteralType', 'TSTemplateLiteralType',
    // Heritage split (phase 4): TSClassImplements under class `implements`,
    // TSInterfaceHeritage under interface `extends`; same payload shape. Kept
    // adjacent so the isTypeOnlyNode range check (…TSInterfaceHeritage) stays a
    // bounds test. Each maps to its canonical name in estree.ts.
    'TSImportType', 'TSInterfaceDeclaration', 'TSClassImplements', 'TSInterfaceHeritage', 'TSTypeAliasDeclaration', 'TSEnumDeclaration',
    'TSEnumMember', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSModuleDeclaration',
] as const;

export type TypeName = (typeof NODE_TYPE_NAMES)[number];

export const N = enumeration(...NODE_TYPE_NAMES);

/** number of type ids, including the reserved 0 slot */
export const TYPE_COUNT = NODE_TYPE_NAMES.length + 1;
/** type-name per numeric id (index 0 reserved). */
export const TYPE_NAME: string[] = ['<null>'];
for (let i = 0; i < NODE_TYPE_NAMES.length; i++) TYPE_NAME[i + 1] = NODE_TYPE_NAMES[i];

/* ---------------------------------------------------- type-only-node helper */

/** Is this node type TS-type-only syntax (erased by emit)? Enums/namespaces are
 * runtime; TSAs/TSSatisfies/TSNonNull wrap a VALUE expression (not type-only —
 * emit strips just the type suffix). Interfaces and type aliases are type-only. */
export const isTypeOnlyNode = (type: number): boolean => {
    if (type === N.TSInterfaceDeclaration || type === N.TSTypeAliasDeclaration) return true;
    // the pure TS-type structural nodes span the contiguous id range
    // [TSTypeAnnotation .. TSInterfaceHeritage] — this includes the 14 keyword
    // leaves (TSAnyKeyword..TSThisType, kept contiguous) and the two heritage
    // forms (TSClassImplements/TSInterfaceHeritage, kept adjacent), and excludes
    // the runtime decls (enum/enum-member/module) and the value-wrapping exprs
    // (TSAsExpression/TSSatisfiesExpression/TSNonNullExpression) which fall after
    // TSInterfaceHeritage.
    return type >= N.TSTypeAnnotation && type <= N.TSInterfaceHeritage;
};

/** Is this type id any of the four identifier roles (contiguous range)? All four
 * are `data:null` leaves carrying the name in the name slot and serialize as
 * `'Identifier'`. */
export const isIdentifier = (type: number): boolean =>
    type >= N.BindingIdentifier && type <= N.LabelIdentifier;

export type Accessibility = 'public' | 'private' | 'protected' | null;

// ---- expressions ----
export type TemplateLiteralData = { quasis: Node[]; expressions: Node[]; }
export type TaggedTemplateExpressionData = { tag: Node; quasi: Node; }
export type ArrayExpressionData = { elements: (Node | null)[]; }
export type ObjectExpressionData = { properties: Node[]; }
export type ObjectPropertyData = { key: Node; value: Node; kind: 'init' | 'get' | 'set'; computed: boolean; shorthand: boolean; }
export type SpreadElementData = { argument: Node; }
export type BinaryExpressionData = { operator: string; left: Node; right: Node; }
export type LogicalExpressionData = { operator: string; left: Node; right: Node; }
export type AssignmentExpressionData = { operator: string; left: Node; right: Node; }
export type UnaryExpressionData = { operator: string; prefix: boolean; argument: Node; }
export type UpdateExpressionData = { operator: string; prefix: boolean; argument: Node; }
export type ConditionalExpressionData = { test: Node; consequent: Node; alternate: Node; }
export type CallExpressionData = { callee: Node; arguments: Node[]; optional: boolean; typeArguments: Node | null; }
export type NewExpressionData = { callee: Node; arguments: Node[]; typeArguments: Node | null; }
export type StaticMemberExpressionData = { object: Node; property: Node; optional: boolean; }
export type ComputedMemberExpressionData = { object: Node; expression: Node; optional: boolean; }
export type PrivateFieldExpressionData = { object: Node; field: Node; optional: boolean; }
export type ChainExpressionData = { expression: Node; }
export type SequenceExpressionData = { expressions: Node[]; }
export type ArrowFunctionExpressionData = { typeParameters: Node | null; params: Node[]; returnType: Node | null; body: Node; async: boolean; expression: boolean; }
export type FunctionExpressionData = { id: Node | null; typeParameters: Node | null; params: Node[]; returnType: Node | null; body: Node | null; async: boolean; generator: boolean; }
export type ClassExpressionData = { id: Node | null; typeParameters: Node | null; superClass: Node | null; superTypeArguments: Node | null; implements: Node[]; body: Node[]; }
export type YieldExpressionData = { argument: Node | null; delegate: boolean; }
export type AwaitExpressionData = { argument: Node; }
export type ImportExpressionData = { source: Node; options: Node | null; }

// ---- statements / declarations ----
export type ExpressionStatementData = { expression: Node; }
export type VariableDeclarationData = { declarations: Node[]; kind: 'var' | 'let' | 'const'; declare: boolean; }
export type VariableDeclaratorData = { id: Node; typeAnnotation: Node | null; init: Node | null; definite: boolean; }
export type BlockStatementData = { body: Node[]; }
export type IfStatementData = { test: Node; consequent: Node; alternate: Node | null; }
export type ForStatementData = { init: Node | null; test: Node | null; update: Node | null; body: Node; }
export type ForInStatementData = { left: Node; right: Node; body: Node; }
export type ForOfStatementData = { left: Node; right: Node; body: Node; await: boolean; }
export type WhileStatementData = { test: Node; body: Node; }
export type DoWhileStatementData = { body: Node; test: Node; }
export type SwitchStatementData = { discriminant: Node; cases: Node[]; }
export type SwitchCaseData = { test: Node | null; consequent: Node[]; }
export type TryStatementData = { block: Node; handler: Node | null; finalizer: Node | null; }
export type CatchClauseData = { param: Node | null; body: Node; }
export type ReturnStatementData = { argument: Node | null; }
export type ThrowStatementData = { argument: Node; }
export type BreakStatementData = { label: Node | null; }
export type ContinueStatementData = { label: Node | null; }
export type LabeledStatementData = { label: Node; body: Node; }
export type FunctionDeclarationData = { id: Node | null; typeParameters: Node | null; params: Node[]; returnType: Node | null; body: Node | null; async: boolean; generator: boolean; declare: boolean; }
export type ClassDeclarationData = { id: Node | null; typeParameters: Node | null; superClass: Node | null; superTypeArguments: Node | null; implements: Node[]; body: Node[]; abstract: boolean; declare: boolean; }
export type MethodDefinitionData = { key: Node; value: Node; kind: 'method' | 'get' | 'set' | 'constructor'; static: boolean; computed: boolean; optional: boolean; abstract: boolean; accessibility: Accessibility; }
export type PropertyDefinitionData = { key: Node; typeAnnotation: Node | null; value: Node | null; static: boolean; computed: boolean; readonly: boolean; optional: boolean; definite: boolean; declare: boolean; abstract: boolean; accessibility: Accessibility; }
export type StaticBlockData = { body: Node[]; }

// ---- patterns ----
export type ObjectPatternData = { properties: Node[]; }
export type ArrayPatternData = { elements: (Node | null)[]; }
export type AssignmentPatternData = { left: Node; right: Node; }
export type RestElementData = { argument: Node; typeAnnotation: Node | null; }
export type FormalParameterData = { pattern: Node; typeAnnotation: Node | null; init: Node | null; optional: boolean; readonly: boolean; accessibility: Accessibility; }

// ---- modules ----
export type ImportDeclarationData = { specifiers: Node[]; source: Node; importKind: 'value' | 'type'; }
export type ImportSpecifierData = { local: Node; imported: Node; importKind: 'value' | 'type'; }
export type ImportDefaultSpecifierData = { local: Node; }
export type ImportNamespaceSpecifierData = { local: Node; }
export type ExportNamedDeclarationData = { declaration: Node | null; specifiers: Node[]; source: Node | null; exportKind: 'value' | 'type'; }
export type ExportSpecifierData = { local: Node; exported: Node; exportKind: 'value' | 'type'; }
export type ExportDefaultDeclarationData = { declaration: Node; }
export type ExportAllDeclarationData = { source: Node; exported: Node | null; }

// ---- typescript ----
export type TSTypeAnnotationData = { typeAnnotation: Node; }
export type TSTypeReferenceData = { typeName: Node; typeArguments: Node | null; }
export type TSQualifiedNameData = { left: Node; right: Node; }
export type TSTypeParameterInstantiationData = { params: Node[]; }
export type TSTypeParameterDeclarationData = { params: Node[]; }
export type TSTypeParameterData = { name: Node; constraint: Node | null; default: Node | null; in: boolean; out: boolean; const: boolean; }
export type TSTupleTypeData = { elementTypes: Node[]; }
export type TSNamedTupleMemberData = { label: Node; elementType: Node; optional: boolean; }
export type TSTypeLiteralData = { members: Node[]; }
export type TSPropertySignatureData = { key: Node; typeAnnotation: Node | null; optional: boolean; readonly: boolean; computed: boolean; }
export type TSMethodSignatureData = { key: Node; typeParameters: Node | null; params: Node[]; returnType: Node | null; optional: boolean; kind: 'method' | 'get' | 'set'; computed: boolean; }
export type TSIndexSignatureData = { parameter: Node; typeAnnotation: Node | null; readonly: boolean; }
export type TSCallSignatureDeclarationData = { typeParameters: Node | null; params: Node[]; returnType: Node | null; }
export type TSConstructSignatureDeclarationData = { typeParameters: Node | null; params: Node[]; returnType: Node | null; }
export type TSUnionTypeData = { types: Node[]; }
export type TSIntersectionTypeData = { types: Node[]; }
export type TSFunctionTypeData = { typeParameters: Node | null; params: Node[]; returnType: Node | null; }
export type TSConstructorTypeData = { typeParameters: Node | null; params: Node[]; returnType: Node | null; abstract: boolean; }
export type TSArrayTypeData = { elementType: Node; }
export type TSIndexedAccessTypeData = { objectType: Node; indexType: Node; }
export type TSTypeOperatorData = { operator: string; typeAnnotation: Node; }
export type TSTypeQueryData = { exprName: Node; typeArguments: Node | null; }
export type TSConditionalTypeData = { checkType: Node; extendsType: Node; trueType: Node; falseType: Node; }
export type TSInferTypeData = { typeParameter: Node; }
export type TSMappedTypeData = { typeParameter: Node; nameType: Node | null; typeAnnotation: Node | null; readonlyMod: number; optionalMod: number; }
export type TSLiteralTypeData = { literal: Node; }
export type TSTemplateLiteralTypeData = { quasis: Node[]; types: Node[]; }
export type TSImportTypeData = { source: Node; qualifier: Node | null; typeArguments: Node | null; }
export type TSInterfaceDeclarationData = { id: Node; typeParameters: Node | null; extends: Node[]; body: Node[]; declare: boolean; }
export type TSClassImplementsData = { expression: Node; typeArguments: Node | null; }
export type TSInterfaceHeritageData = { expression: Node; typeArguments: Node | null; }
export type TSTypeAliasDeclarationData = { id: Node; typeParameters: Node | null; typeAnnotation: Node; declare: boolean; }
export type TSEnumDeclarationData = { id: Node; members: Node[]; const: boolean; declare: boolean; }
export type TSEnumMemberData = { id: Node; initializer: Node | null; }
export type TSAsExpressionData = { expression: Node; typeAnnotation: Node; }
export type TSSatisfiesExpressionData = { expression: Node; typeAnnotation: Node; }
export type TSNonNullExpressionData = { expression: Node; }
export type TSModuleDeclarationData = { id: Node; body: Node[]; declare: boolean; namespace: boolean; }
export type ProgramData = { body: Node[]; }

/* ============================================== payload-by-type mapping table
 *
 * The mapped type that makes `type` a real discriminant. `DataOf` maps each N
 * literal to its payload interface (null for leaves). `NodeOf<K>` is the outer
 * node fixed to one type; `Node` is the union over all of them — identical key
 * order (id,type,start,end,name,data) at every arm, so `if (n.type === N.IfStatement)`
 * narrows `n.data` to IfStatementData and nothing else.
 */

export type DataMap = {
    [N.Program]: ProgramData;
    [N.BindingIdentifier]: null; [N.IdentifierReference]: null; [N.IdentifierName]: null; [N.LabelIdentifier]: null;
    [N.PrivateIdentifier]: null;
    [N.NumericLiteral]: null; [N.StringLiteral]: null; [N.BooleanLiteral]: null;
    [N.NullLiteral]: null; [N.RegExpLiteral]: null; [N.BigIntLiteral]: null;
    [N.TemplateElement]: null; [N.ThisExpression]: null; [N.Super]: null; [N.ImportMeta]: null; [N.NewTarget]: null;
    [N.TemplateLiteral]: TemplateLiteralData; [N.TaggedTemplateExpression]: TaggedTemplateExpressionData;
    [N.ArrayExpression]: ArrayExpressionData; [N.ObjectExpression]: ObjectExpressionData; [N.ObjectProperty]: ObjectPropertyData; [N.SpreadElement]: SpreadElementData;
    [N.BinaryExpression]: BinaryExpressionData; [N.LogicalExpression]: LogicalExpressionData; [N.AssignmentExpression]: AssignmentExpressionData; [N.UnaryExpression]: UnaryExpressionData; [N.UpdateExpression]: UpdateExpressionData;
    [N.ConditionalExpression]: ConditionalExpressionData; [N.CallExpression]: CallExpressionData; [N.NewExpression]: NewExpressionData;
    [N.StaticMemberExpression]: StaticMemberExpressionData; [N.ComputedMemberExpression]: ComputedMemberExpressionData; [N.PrivateFieldExpression]: PrivateFieldExpressionData; [N.ChainExpression]: ChainExpressionData;
    [N.SequenceExpression]: SequenceExpressionData;
    [N.ArrowFunctionExpression]: ArrowFunctionExpressionData; [N.FunctionExpression]: FunctionExpressionData; [N.ClassExpression]: ClassExpressionData; [N.YieldExpression]: YieldExpressionData; [N.AwaitExpression]: AwaitExpressionData;
    [N.ImportExpression]: ImportExpressionData;
    [N.ExpressionStatement]: ExpressionStatementData; [N.VariableDeclaration]: VariableDeclarationData; [N.VariableDeclarator]: VariableDeclaratorData; [N.BlockStatement]: BlockStatementData;
    [N.IfStatement]: IfStatementData; [N.ForStatement]: ForStatementData; [N.ForInStatement]: ForInStatementData; [N.ForOfStatement]: ForOfStatementData; [N.WhileStatement]: WhileStatementData; [N.DoWhileStatement]: DoWhileStatementData;
    [N.SwitchStatement]: SwitchStatementData; [N.SwitchCase]: SwitchCaseData; [N.TryStatement]: TryStatementData; [N.CatchClause]: CatchClauseData;
    [N.ReturnStatement]: ReturnStatementData; [N.ThrowStatement]: ThrowStatementData; [N.BreakStatement]: BreakStatementData; [N.ContinueStatement]: ContinueStatementData; [N.LabeledStatement]: LabeledStatementData;
    [N.EmptyStatement]: null; [N.DebuggerStatement]: null; [N.FunctionDeclaration]: FunctionDeclarationData; [N.ClassDeclaration]: ClassDeclarationData;
    [N.MethodDefinition]: MethodDefinitionData; [N.PropertyDefinition]: PropertyDefinitionData; [N.StaticBlock]: StaticBlockData;
    [N.ObjectPattern]: ObjectPatternData; [N.ArrayPattern]: ArrayPatternData; [N.AssignmentPattern]: AssignmentPatternData;
    [N.RestElement]: RestElementData; [N.FormalParameter]: FormalParameterData;
    [N.ImportDeclaration]: ImportDeclarationData; [N.ImportSpecifier]: ImportSpecifierData; [N.ImportDefaultSpecifier]: ImportDefaultSpecifierData;
    [N.ImportNamespaceSpecifier]: ImportNamespaceSpecifierData;
    [N.ExportNamedDeclaration]: ExportNamedDeclarationData; [N.ExportSpecifier]: ExportSpecifierData; [N.ExportDefaultDeclaration]: ExportDefaultDeclarationData; [N.ExportAllDeclaration]: ExportAllDeclarationData;
    [N.TSTypeAnnotation]: TSTypeAnnotationData;
    [N.TSAnyKeyword]: null; [N.TSStringKeyword]: null; [N.TSNumberKeyword]: null; [N.TSBooleanKeyword]: null;
    [N.TSBigIntKeyword]: null; [N.TSSymbolKeyword]: null; [N.TSObjectKeyword]: null; [N.TSVoidKeyword]: null;
    [N.TSUndefinedKeyword]: null; [N.TSNullKeyword]: null; [N.TSNeverKeyword]: null; [N.TSUnknownKeyword]: null;
    [N.TSIntrinsicKeyword]: null; [N.TSThisType]: null;
    [N.TSTypeReference]: TSTypeReferenceData; [N.TSQualifiedName]: TSQualifiedNameData;
    [N.TSTypeParameterInstantiation]: TSTypeParameterInstantiationData; [N.TSTypeParameterDeclaration]: TSTypeParameterDeclarationData; [N.TSTypeParameter]: TSTypeParameterData;
    [N.TSTupleType]: TSTupleTypeData; [N.TSNamedTupleMember]: TSNamedTupleMemberData; [N.TSTypeLiteral]: TSTypeLiteralData;
    [N.TSPropertySignature]: TSPropertySignatureData; [N.TSMethodSignature]: TSMethodSignatureData; [N.TSIndexSignature]: TSIndexSignatureData;
    [N.TSCallSignatureDeclaration]: TSCallSignatureDeclarationData; [N.TSConstructSignatureDeclaration]: TSConstructSignatureDeclarationData; [N.TSUnionType]: TSUnionTypeData; [N.TSIntersectionType]: TSIntersectionTypeData;
    [N.TSFunctionType]: TSFunctionTypeData; [N.TSConstructorType]: TSConstructorTypeData; [N.TSArrayType]: TSArrayTypeData;
    [N.TSIndexedAccessType]: TSIndexedAccessTypeData; [N.TSTypeOperator]: TSTypeOperatorData; [N.TSTypeQuery]: TSTypeQueryData;
    [N.TSConditionalType]: TSConditionalTypeData; [N.TSInferType]: TSInferTypeData; [N.TSMappedType]: TSMappedTypeData; [N.TSLiteralType]: TSLiteralTypeData;
    [N.TSTemplateLiteralType]: TSTemplateLiteralTypeData; [N.TSImportType]: TSImportTypeData;
    [N.TSInterfaceDeclaration]: TSInterfaceDeclarationData; [N.TSClassImplements]: TSClassImplementsData; [N.TSInterfaceHeritage]: TSInterfaceHeritageData; [N.TSTypeAliasDeclaration]: TSTypeAliasDeclarationData;
    [N.TSEnumDeclaration]: TSEnumDeclarationData; [N.TSEnumMember]: TSEnumMemberData; [N.TSAsExpression]: TSAsExpressionData; [N.TSSatisfiesExpression]: TSSatisfiesExpressionData;
    [N.TSNonNullExpression]: TSNonNullExpressionData; [N.TSModuleDeclaration]: TSModuleDeclarationData;
}

export type NodeType = keyof DataMap;
export type DataOf<K extends NodeType> = DataMap[K];

/** One outer node, fixed to a single type. Identical key order for every K:
 * id, type, start, end, name, data. `name` carries the leaf payload (Identifier
 * name / Literal raw) — empty string for interior nodes. `id` is the per-parse
 * sequential id keying all side tables. */
export type NodeOf<K extends NodeType> = {
    id: number;
    type: K;
    start: number;
    end: number;
    name: string;
    data: DataOf<K>;
}

/** The node union — a distributive map over every N literal. `n.type` is a real
 * discriminant: narrowing on `n.type === N.BinaryExpression` narrows `n.data` to BinaryExpressionData. */
export type Node = { [K in NodeType]: NodeOf<K> }[NodeType];

/** Convenience aliases for the reading surface (payload-typed narrowings). */
export type Program = NodeOf<typeof N.Program>;
export type BindingIdentifier = NodeOf<typeof N.BindingIdentifier>;
export type IdentifierReference = NodeOf<typeof N.IdentifierReference>;
export type IdentifierName = NodeOf<typeof N.IdentifierName>;
export type LabelIdentifier = NodeOf<typeof N.LabelIdentifier>;

/* ============================================================= schema layout
 *
 * Declarative child layout, one row per type, tsc-checked against the payload
 * interfaces (the interfaces stay the source of truth). Only child/list fields
 * appear; scalars live in the payload directly.
 */

/** Child-field spec: a payload key that holds a Node / Node[] child. */
export type FieldSpec = { name: string; list: boolean };
const f = <const K extends string>(name: K): { name: K; list: false } => ({ name, list: false });
const fl = <const K extends string>(name: K): { name: K; list: true } => ({ name, list: true });

/** Keys of a payload that hold children (Node, Node|null, Node[], (Node|null)[]). */
type ChildKeyOf<Id extends NodeType> = DataOf<Id> extends null ? never
    : { [K in keyof DataOf<Id>]-?: NonNullable<DataOf<Id>[K]> extends Node | readonly (Node | null)[] ? K & string : never }[keyof DataOf<Id>];

/** Child-field layout per type, in schema (walk) order. Checked against the
 * payload interfaces: a misspelled or non-child field name is a compile error,
 * a missing type is a compile error, and a child field left out of its row is
 * caught by the completeness assertion below. */
export const CHILD_FIELDS = {
    Program: [fl('body')],
    BindingIdentifier: [],
    IdentifierReference: [],
    IdentifierName: [],
    LabelIdentifier: [],
    PrivateIdentifier: [],
    NumericLiteral: [],
    StringLiteral: [],
    BooleanLiteral: [],
    NullLiteral: [],
    RegExpLiteral: [],
    BigIntLiteral: [],
    TemplateElement: [],
    ThisExpression: [],
    Super: [],
    ImportMeta: [],
    NewTarget: [],
    TemplateLiteral: [fl('quasis'), fl('expressions')],
    TaggedTemplateExpression: [f('tag'), f('quasi')],
    ArrayExpression: [fl('elements')],
    ObjectExpression: [fl('properties')],
    ObjectProperty: [f('key'), f('value')],
    SpreadElement: [f('argument')],
    BinaryExpression: [f('left'), f('right')],
    LogicalExpression: [f('left'), f('right')],
    AssignmentExpression: [f('left'), f('right')],
    UnaryExpression: [f('argument')],
    UpdateExpression: [f('argument')],
    ConditionalExpression: [f('test'), f('consequent'), f('alternate')],
    CallExpression: [f('callee'), fl('arguments'), f('typeArguments')],
    NewExpression: [f('callee'), fl('arguments'), f('typeArguments')],
    StaticMemberExpression: [f('object'), f('property')],
    ComputedMemberExpression: [f('object'), f('expression')],
    PrivateFieldExpression: [f('object'), f('field')],
    ChainExpression: [f('expression')],
    SequenceExpression: [fl('expressions')],
    ArrowFunctionExpression: [f('typeParameters'), fl('params'), f('returnType'), f('body')],
    FunctionExpression: [f('id'), f('typeParameters'), fl('params'), f('returnType'), f('body')],
    ClassExpression: [f('id'), f('typeParameters'), f('superClass'), f('superTypeArguments'), fl('implements'), fl('body')],
    YieldExpression: [f('argument')],
    AwaitExpression: [f('argument')],
    ImportExpression: [f('source'), f('options')],
    ExpressionStatement: [f('expression')],
    VariableDeclaration: [fl('declarations')],
    VariableDeclarator: [f('id'), f('typeAnnotation'), f('init')],
    BlockStatement: [fl('body')],
    IfStatement: [f('test'), f('consequent'), f('alternate')],
    ForStatement: [f('init'), f('test'), f('update'), f('body')],
    ForInStatement: [f('left'), f('right'), f('body')],
    ForOfStatement: [f('left'), f('right'), f('body')],
    WhileStatement: [f('test'), f('body')],
    DoWhileStatement: [f('body'), f('test')],
    SwitchStatement: [f('discriminant'), fl('cases')],
    SwitchCase: [f('test'), fl('consequent')],
    TryStatement: [f('block'), f('handler'), f('finalizer')],
    CatchClause: [f('param'), f('body')],
    ReturnStatement: [f('argument')],
    ThrowStatement: [f('argument')],
    BreakStatement: [f('label')],
    ContinueStatement: [f('label')],
    LabeledStatement: [f('label'), f('body')],
    EmptyStatement: [],
    DebuggerStatement: [],
    FunctionDeclaration: [f('id'), f('typeParameters'), fl('params'), f('returnType'), f('body')],
    ClassDeclaration: [f('id'), f('typeParameters'), f('superClass'), f('superTypeArguments'), fl('implements'), fl('body')],
    MethodDefinition: [f('key'), f('value')],
    PropertyDefinition: [f('key'), f('typeAnnotation'), f('value')],
    StaticBlock: [fl('body')],
    ObjectPattern: [fl('properties')],
    ArrayPattern: [fl('elements')],
    AssignmentPattern: [f('left'), f('right')],
    RestElement: [f('argument'), f('typeAnnotation')],
    FormalParameter: [f('pattern'), f('typeAnnotation'), f('init')],
    ImportDeclaration: [fl('specifiers'), f('source')],
    ImportSpecifier: [f('local'), f('imported')],
    ImportDefaultSpecifier: [f('local')],
    ImportNamespaceSpecifier: [f('local')],
    ExportNamedDeclaration: [f('declaration'), fl('specifiers'), f('source')],
    ExportSpecifier: [f('local'), f('exported')],
    ExportDefaultDeclaration: [f('declaration')],
    ExportAllDeclaration: [f('source'), f('exported')],
    TSTypeAnnotation: [f('typeAnnotation')],
    TSAnyKeyword: [],
    TSStringKeyword: [],
    TSNumberKeyword: [],
    TSBooleanKeyword: [],
    TSBigIntKeyword: [],
    TSSymbolKeyword: [],
    TSObjectKeyword: [],
    TSVoidKeyword: [],
    TSUndefinedKeyword: [],
    TSNullKeyword: [],
    TSNeverKeyword: [],
    TSUnknownKeyword: [],
    TSIntrinsicKeyword: [],
    TSThisType: [],
    TSTypeReference: [f('typeName'), f('typeArguments')],
    TSQualifiedName: [f('left'), f('right')],
    TSTypeParameterInstantiation: [fl('params')],
    TSTypeParameterDeclaration: [fl('params')],
    TSTypeParameter: [f('name'), f('constraint'), f('default')],
    TSTupleType: [fl('elementTypes')],
    TSNamedTupleMember: [f('label'), f('elementType')],
    TSTypeLiteral: [fl('members')],
    TSPropertySignature: [f('key'), f('typeAnnotation')],
    TSMethodSignature: [f('key'), f('typeParameters'), fl('params'), f('returnType')],
    TSIndexSignature: [f('parameter'), f('typeAnnotation')],
    TSCallSignatureDeclaration: [f('typeParameters'), fl('params'), f('returnType')],
    TSConstructSignatureDeclaration: [f('typeParameters'), fl('params'), f('returnType')],
    TSUnionType: [fl('types')],
    TSIntersectionType: [fl('types')],
    TSFunctionType: [f('typeParameters'), fl('params'), f('returnType')],
    TSConstructorType: [f('typeParameters'), fl('params'), f('returnType')],
    TSArrayType: [f('elementType')],
    TSIndexedAccessType: [f('objectType'), f('indexType')],
    TSTypeOperator: [f('typeAnnotation')],
    TSTypeQuery: [f('exprName'), f('typeArguments')],
    TSConditionalType: [f('checkType'), f('extendsType'), f('trueType'), f('falseType')],
    TSInferType: [f('typeParameter')],
    TSMappedType: [f('typeParameter'), f('nameType'), f('typeAnnotation')],
    TSLiteralType: [f('literal')],
    TSTemplateLiteralType: [fl('quasis'), fl('types')],
    TSImportType: [f('source'), f('qualifier'), f('typeArguments')],
    TSInterfaceDeclaration: [f('id'), f('typeParameters'), fl('extends'), fl('body')],
    TSClassImplements: [f('expression'), f('typeArguments')],
    TSInterfaceHeritage: [f('expression'), f('typeArguments')],
    TSTypeAliasDeclaration: [f('id'), f('typeParameters'), f('typeAnnotation')],
    TSEnumDeclaration: [f('id'), fl('members')],
    TSEnumMember: [f('id'), f('initializer')],
    TSAsExpression: [f('expression'), f('typeAnnotation')],
    TSSatisfiesExpression: [f('expression'), f('typeAnnotation')],
    TSNonNullExpression: [f('expression')],
    TSModuleDeclaration: [f('id'), fl('body')],
} satisfies { [T in TypeName]: readonly { name: ChildKeyOf<(typeof N)[T]>; list: boolean }[] };

type AssertNever<T extends never> = T;
/** Compile-time completeness proof: every child key of every payload appears in
 * its CHILD_FIELDS row (a forgotten field surfaces here as a constraint error
 * naming it). */
export type ChildFieldsComplete = AssertNever<{
    [T in TypeName]: Exclude<ChildKeyOf<(typeof N)[T]>, (typeof CHILD_FIELDS)[T][number]['name']>;
}[TypeName]>;

/** Child-field layout per numeric id (derived; no holes by construction). */
export const FIELDS: FieldSpec[][] = new Array(TYPE_COUNT);
for (const t of NODE_TYPE_NAMES) FIELDS[N[t]] = CHILD_FIELDS[t] as readonly FieldSpec[] as FieldSpec[];

/* ================================================================ line table
 *
 * The line table is a plain function the parser calls at the end of a parse and
 * returns to the caller. Offset->line/col is served source-free from this table.
 */

export function buildLineTable(src: string): Uint32Array {
    const starts: number[] = [0];
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
    return Uint32Array.from(starts);
}
export function lineColOf(lines: Uint32Array, offset: number): { line: number; column: number } {
    let lo = 0, hi = lines.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lines[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lines[lo] };
}

/* ============================================================= node internals
 *
 * The loosely-typed internal node view for the machinery (walk/clone/access) and
 * the shape-fixing constructor. THE shape invariant: every node — parser-built or
 * programmatically built — is created with the SAME outer key order
 * { id, type, start, end, name, data }, so the whole tree is one hidden class.
 * The parser inlines this key order at each grammar site (its own constructors).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPayload = Record<string, unknown> | null;
/** The uniform untyped view generic (schema-driven) machinery works on. */
export interface RawNode { id: number; type: number; start: number; end: number; name: string; data: AnyPayload; }

/** Typed->raw boundary. Plain structural widening — every NodeOf<K> is a RawNode. */
const raw = (n: Node): RawNode => n;
/** Raw->typed boundary — constructors handing fresh nodes back to the typed world. */
const typed = (r: RawNode): Node => r as Node;

/* ================================================================= node ids
 *
 * ONE id space for the whole process: the parser resets it per parse (from 0)
 * and draws parsed-node ids from it; programmatic construction (make/cloneNode/
 * makeIdentifierReference) draws from the SAME counter so synthesized nodes never collide
 * with parsed ones (a transform can clone-and-reanalyze safely). Ids start at 1
 * (0 = null parity).
 */

let idCounter = 0;
/** Next node id (shared by parse and programmatic build). */
export const nextNodeId = (): number => ++idCounter;
/** Reset the id counter (the parser calls this at the start of each parse). */
export const resetNodeIds = (): void => { idCounter = 0; };
/** The highest id assigned so far (parse returns this + 1 as nodeCount). */
export const peekNodeId = (): number => idCounter;

/* ========================================================= programmatic build
 *
 * Synthesis constructs nodes as plain object literals over `node()` — the
 * payload types make that fully checked. Explicit make helpers are added here
 * only when a real transform earns them (the parser owns its own inline
 * constructors and never goes through this surface).
 */

function node(type: number, start: number, end: number, name: string, data: AnyPayload): RawNode {
    return { id: nextNodeId(), type, start, end, name, data };
}

/** Synthetic identifier REFERENCE (an expression-position name — the kind a
 * transform building `x` -> `y` rewrites; the name IS the payload). */
export function makeIdentifierReference(name: string): Node {
    return typed(node(N.IdentifierReference, 0, 0, name, null));
}
/** Synthetic BINDING identifier (a declaring name — for transforms that emit a
 * fresh binding, e.g. hoisting an inlined param to a local). */
export function makeBindingIdentifier(name: string): Node {
    return typed(node(N.BindingIdentifier, 0, 0, name, null));
}

/* =============================================================== numeric type */

export function nodeType(n: Node): number { return raw(n).type; }

/* ============================================================== walk */

/** Generic (schema-driven) walk of direct children. `fieldIndex`/`listIndex`
 * locate the child; `listIndex` is -1 for a direct slot. */
export function walkChildren(n: Node, cb: (child: Node, fieldIndex: number, listIndex: number) => boolean | void): void {
    const r = raw(n);
    const fields = FIELDS[r.type];
    const data = r.data;
    if (data === null) return;              // leaf: no children
    for (let i = 0; i < fields.length; i++) {
        const v = data[fields[i].name];
        if (v == null) continue;
        if (fields[i].list) {
            const list = v as (Node | null)[];
            for (let j = 0; j < list.length; j++) {
                const c = list[j];
                if (c != null && cb(c, i, j) === false) return;
            }
        } else if (cb(v as Node, i, -1) === false) return;
    }
}

/** Depth-first pre-order walk. `enter` may return false to skip the subtree
 * (exit is then not called). Hand switch over the schema, grouped by field
 * shape — the drift test in tst/ast.test.ts pins it to CHILD_FIELDS. */
export function walk(n: Node, enter: (n: Node) => boolean | void, exit?: (n: Node) => void): void {
    if (enter(n) === false) return;
    const d = raw(n).data;
    if (d !== null) switch (raw(n).type) {
        case N.Program:
        case N.BlockStatement:
        case N.StaticBlock:
            { const l = d.body as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            break;
        case N.TemplateLiteral:
            { const l = d.quasis as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            { const l = d.expressions as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            break;
        case N.TaggedTemplateExpression:
            if (d.tag != null) walk(d.tag as Node, enter, exit);
            if (d.quasi != null) walk(d.quasi as Node, enter, exit);
            break;
        case N.ArrayExpression:
        case N.ArrayPattern:
            { const l = d.elements as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            break;
        case N.ObjectExpression:
        case N.ObjectPattern:
            { const l = d.properties as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            break;
        case N.ObjectProperty:
        case N.MethodDefinition:
            if (d.key != null) walk(d.key as Node, enter, exit);
            if (d.value != null) walk(d.value as Node, enter, exit);
            break;
        case N.SpreadElement:
        case N.UnaryExpression:
        case N.UpdateExpression:
        case N.YieldExpression:
        case N.AwaitExpression:
        case N.ReturnStatement:
        case N.ThrowStatement:
            if (d.argument != null) walk(d.argument as Node, enter, exit);
            break;
        case N.BinaryExpression:
        case N.LogicalExpression:
        case N.AssignmentExpression:
        case N.AssignmentPattern:
        case N.TSQualifiedName:
            if (d.left != null) walk(d.left as Node, enter, exit);
            if (d.right != null) walk(d.right as Node, enter, exit);
            break;
        case N.ConditionalExpression:
        case N.IfStatement:
            if (d.test != null) walk(d.test as Node, enter, exit);
            if (d.consequent != null) walk(d.consequent as Node, enter, exit);
            if (d.alternate != null) walk(d.alternate as Node, enter, exit);
            break;
        case N.CallExpression:
        case N.NewExpression:
            if (d.callee != null) walk(d.callee as Node, enter, exit);
            { const l = d.arguments as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            if (d.typeArguments != null) walk(d.typeArguments as Node, enter, exit);
            break;
        case N.StaticMemberExpression:
            if (d.object != null) walk(d.object as Node, enter, exit);
            if (d.property != null) walk(d.property as Node, enter, exit);
            break;
        case N.ComputedMemberExpression:
            if (d.object != null) walk(d.object as Node, enter, exit);
            if (d.expression != null) walk(d.expression as Node, enter, exit);
            break;
        case N.PrivateFieldExpression:
            if (d.object != null) walk(d.object as Node, enter, exit);
            if (d.field != null) walk(d.field as Node, enter, exit);
            break;
        case N.ChainExpression:
            if (d.expression != null) walk(d.expression as Node, enter, exit);
            break;
        case N.SequenceExpression:
            { const l = d.expressions as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            break;
        case N.ArrowFunctionExpression:
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter, exit);
            { const l = d.params as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            if (d.returnType != null) walk(d.returnType as Node, enter, exit);
            if (d.body != null) walk(d.body as Node, enter, exit);
            break;
        case N.FunctionExpression:
        case N.FunctionDeclaration:
            if (d.id != null) walk(d.id as Node, enter, exit);
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter, exit);
            { const l = d.params as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            if (d.returnType != null) walk(d.returnType as Node, enter, exit);
            if (d.body != null) walk(d.body as Node, enter, exit);
            break;
        case N.ClassExpression:
        case N.ClassDeclaration:
            if (d.id != null) walk(d.id as Node, enter, exit);
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter, exit);
            if (d.superClass != null) walk(d.superClass as Node, enter, exit);
            if (d.superTypeArguments != null) walk(d.superTypeArguments as Node, enter, exit);
            { const l = d.implements as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            { const l = d.body as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            break;
        case N.ImportExpression:
            if (d.source != null) walk(d.source as Node, enter, exit);
            if (d.options != null) walk(d.options as Node, enter, exit);
            break;
        case N.ExpressionStatement:
        case N.TSNonNullExpression:
            if (d.expression != null) walk(d.expression as Node, enter, exit);
            break;
        case N.VariableDeclaration:
            { const l = d.declarations as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            break;
        case N.VariableDeclarator:
            if (d.id != null) walk(d.id as Node, enter, exit);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter, exit);
            if (d.init != null) walk(d.init as Node, enter, exit);
            break;
        case N.ForStatement:
            if (d.init != null) walk(d.init as Node, enter, exit);
            if (d.test != null) walk(d.test as Node, enter, exit);
            if (d.update != null) walk(d.update as Node, enter, exit);
            if (d.body != null) walk(d.body as Node, enter, exit);
            break;
        case N.ForInStatement:
        case N.ForOfStatement:
            if (d.left != null) walk(d.left as Node, enter, exit);
            if (d.right != null) walk(d.right as Node, enter, exit);
            if (d.body != null) walk(d.body as Node, enter, exit);
            break;
        case N.WhileStatement:
            if (d.test != null) walk(d.test as Node, enter, exit);
            if (d.body != null) walk(d.body as Node, enter, exit);
            break;
        case N.DoWhileStatement:
            if (d.body != null) walk(d.body as Node, enter, exit);
            if (d.test != null) walk(d.test as Node, enter, exit);
            break;
        case N.SwitchStatement:
            if (d.discriminant != null) walk(d.discriminant as Node, enter, exit);
            { const l = d.cases as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            break;
        case N.SwitchCase:
            if (d.test != null) walk(d.test as Node, enter, exit);
            { const l = d.consequent as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            break;
        case N.TryStatement:
            if (d.block != null) walk(d.block as Node, enter, exit);
            if (d.handler != null) walk(d.handler as Node, enter, exit);
            if (d.finalizer != null) walk(d.finalizer as Node, enter, exit);
            break;
        case N.CatchClause:
            if (d.param != null) walk(d.param as Node, enter, exit);
            if (d.body != null) walk(d.body as Node, enter, exit);
            break;
        case N.BreakStatement:
        case N.ContinueStatement:
            if (d.label != null) walk(d.label as Node, enter, exit);
            break;
        case N.LabeledStatement:
            if (d.label != null) walk(d.label as Node, enter, exit);
            if (d.body != null) walk(d.body as Node, enter, exit);
            break;
        case N.PropertyDefinition:
            if (d.key != null) walk(d.key as Node, enter, exit);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter, exit);
            if (d.value != null) walk(d.value as Node, enter, exit);
            break;
        case N.RestElement:
            if (d.argument != null) walk(d.argument as Node, enter, exit);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter, exit);
            break;
        case N.FormalParameter:
            if (d.pattern != null) walk(d.pattern as Node, enter, exit);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter, exit);
            if (d.init != null) walk(d.init as Node, enter, exit);
            break;
        case N.ImportDeclaration:
            { const l = d.specifiers as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            if (d.source != null) walk(d.source as Node, enter, exit);
            break;
        case N.ImportSpecifier:
            if (d.local != null) walk(d.local as Node, enter, exit);
            if (d.imported != null) walk(d.imported as Node, enter, exit);
            break;
        case N.ImportDefaultSpecifier:
        case N.ImportNamespaceSpecifier:
            if (d.local != null) walk(d.local as Node, enter, exit);
            break;
        case N.ExportNamedDeclaration:
            if (d.declaration != null) walk(d.declaration as Node, enter, exit);
            { const l = d.specifiers as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            if (d.source != null) walk(d.source as Node, enter, exit);
            break;
        case N.ExportSpecifier:
            if (d.local != null) walk(d.local as Node, enter, exit);
            if (d.exported != null) walk(d.exported as Node, enter, exit);
            break;
        case N.ExportDefaultDeclaration:
            if (d.declaration != null) walk(d.declaration as Node, enter, exit);
            break;
        case N.ExportAllDeclaration:
            if (d.source != null) walk(d.source as Node, enter, exit);
            if (d.exported != null) walk(d.exported as Node, enter, exit);
            break;
        case N.TSTypeAnnotation:
        case N.TSTypeOperator:
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter, exit);
            break;
        case N.TSTypeReference:
            if (d.typeName != null) walk(d.typeName as Node, enter, exit);
            if (d.typeArguments != null) walk(d.typeArguments as Node, enter, exit);
            break;
        case N.TSTypeParameterInstantiation:
        case N.TSTypeParameterDeclaration:
            { const l = d.params as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            break;
        case N.TSTypeParameter:
            if (d.name != null) walk(d.name as Node, enter, exit);
            if (d.constraint != null) walk(d.constraint as Node, enter, exit);
            if (d.default != null) walk(d.default as Node, enter, exit);
            break;
        case N.TSTupleType:
            { const l = d.elementTypes as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            break;
        case N.TSNamedTupleMember:
            if (d.label != null) walk(d.label as Node, enter, exit);
            if (d.elementType != null) walk(d.elementType as Node, enter, exit);
            break;
        case N.TSTypeLiteral:
            { const l = d.members as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            break;
        case N.TSPropertySignature:
            if (d.key != null) walk(d.key as Node, enter, exit);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter, exit);
            break;
        case N.TSMethodSignature:
            if (d.key != null) walk(d.key as Node, enter, exit);
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter, exit);
            { const l = d.params as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            if (d.returnType != null) walk(d.returnType as Node, enter, exit);
            break;
        case N.TSIndexSignature:
            if (d.parameter != null) walk(d.parameter as Node, enter, exit);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter, exit);
            break;
        case N.TSCallSignatureDeclaration:
        case N.TSConstructSignatureDeclaration:
        case N.TSFunctionType:
        case N.TSConstructorType:
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter, exit);
            { const l = d.params as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            if (d.returnType != null) walk(d.returnType as Node, enter, exit);
            break;
        case N.TSUnionType:
        case N.TSIntersectionType:
            { const l = d.types as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            break;
        case N.TSArrayType:
            if (d.elementType != null) walk(d.elementType as Node, enter, exit);
            break;
        case N.TSIndexedAccessType:
            if (d.objectType != null) walk(d.objectType as Node, enter, exit);
            if (d.indexType != null) walk(d.indexType as Node, enter, exit);
            break;
        case N.TSTypeQuery:
            if (d.exprName != null) walk(d.exprName as Node, enter, exit);
            if (d.typeArguments != null) walk(d.typeArguments as Node, enter, exit);
            break;
        case N.TSConditionalType:
            if (d.checkType != null) walk(d.checkType as Node, enter, exit);
            if (d.extendsType != null) walk(d.extendsType as Node, enter, exit);
            if (d.trueType != null) walk(d.trueType as Node, enter, exit);
            if (d.falseType != null) walk(d.falseType as Node, enter, exit);
            break;
        case N.TSInferType:
            if (d.typeParameter != null) walk(d.typeParameter as Node, enter, exit);
            break;
        case N.TSMappedType:
            if (d.typeParameter != null) walk(d.typeParameter as Node, enter, exit);
            if (d.nameType != null) walk(d.nameType as Node, enter, exit);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter, exit);
            break;
        case N.TSLiteralType:
            if (d.literal != null) walk(d.literal as Node, enter, exit);
            break;
        case N.TSTemplateLiteralType:
            { const l = d.quasis as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            { const l = d.types as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            break;
        case N.TSImportType:
            if (d.source != null) walk(d.source as Node, enter, exit);
            if (d.qualifier != null) walk(d.qualifier as Node, enter, exit);
            if (d.typeArguments != null) walk(d.typeArguments as Node, enter, exit);
            break;
        case N.TSInterfaceDeclaration:
            if (d.id != null) walk(d.id as Node, enter, exit);
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter, exit);
            { const l = d.extends as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            { const l = d.body as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            break;
        case N.TSClassImplements:
        case N.TSInterfaceHeritage:
            if (d.expression != null) walk(d.expression as Node, enter, exit);
            if (d.typeArguments != null) walk(d.typeArguments as Node, enter, exit);
            break;
        case N.TSTypeAliasDeclaration:
            if (d.id != null) walk(d.id as Node, enter, exit);
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter, exit);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter, exit);
            break;
        case N.TSEnumDeclaration:
            if (d.id != null) walk(d.id as Node, enter, exit);
            { const l = d.members as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            break;
        case N.TSEnumMember:
            if (d.id != null) walk(d.id as Node, enter, exit);
            if (d.initializer != null) walk(d.initializer as Node, enter, exit);
            break;
        case N.TSAsExpression:
        case N.TSSatisfiesExpression:
            if (d.expression != null) walk(d.expression as Node, enter, exit);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter, exit);
            break;
        case N.TSModuleDeclaration:
            if (d.id != null) walk(d.id as Node, enter, exit);
            { const l = d.body as (Node | null)[]; for (let i = 0; i < l.length; i++) { const c = l[i]; if (c != null) walk(c, enter, exit); } }
            break;
    }
    exit?.(n);
}

/* ============================================================== clone
 *
 * Structural clone: fresh outer node (same hidden class) + fresh payload with
 * recursed children. Leaves copy their name slot; `data:null` stays null.
 * `substitute` swaps a subtree (inlining). GC owns the result.
 */

export function cloneNode(
    n: Node | null,
    substitute?: (n: Node) => Node | null,
): Node | null {
    if (n === null) return null;
    if (substitute) {
        const sub = substitute(n);
        if (sub !== null) return sub;
    }
    const r = raw(n);
    const id = r.type;
    if (r.data === null) return typed(node(id, r.start, r.end, r.name, null));
    const fields = FIELDS[id];
    const srcData = r.data;
    const outData: AnyPayload = {};
    const fieldNames = new Set<string>();
    for (let i = 0; i < fields.length; i++) {
        const spec = fields[i];
        fieldNames.add(spec.name);
        const v = srcData[spec.name];
        if (spec.list) {
            const list = v as (Node | null)[];
            const nl: (Node | null)[] = new Array(list.length);
            for (let j = 0; j < list.length; j++) nl[j] = cloneNode(list[j] as Node | null, substitute);
            outData[spec.name] = nl;
        } else {
            outData[spec.name] = v == null ? null : cloneNode(v as Node, substitute);
        }
    }
    // copy scalar payload fields (operator/kind/booleans) verbatim
    for (const k in srcData) {
        if (fieldNames.has(k)) continue;
        outData[k] = srcData[k];
    }
    return typed(node(id, r.start, r.end, r.name, outData));
}

/* ------------------------------------------------------------ reading glue */

/** Leaf text: Identifier name / Literal raw (materialized in the name slot). */
export const text = (n: Node): string => raw(n).name;
export const nodeName = (n: Node): string => raw(n).name;
export const setName = (n: Node, v: string): void => { raw(n).name = v; };
export const nodeStart = (n: Node): number => n.start;
export const nodeEnd = (n: Node): number => n.end;
