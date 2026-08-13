/**
 * Maps our flat-AST node type names (src/ast.ts NODE_TYPE_NAMES) to ESTree type
 * names as produced by meriyah's default output. Typed as
 * Record<TypeName, string | null> so tsc enforces exhaustiveness: adding a new
 * node type to the schema without a mapping here is a compile error.
 *
 * `null` = no ESTree equivalent in meriyah's default output (Param has no node;
 * all TS* types are dropped by meriyah when it parses plain JS; Program is
 * compared separately).
 */
import type { TypeName } from '../src/ast.ts';

export const ESTREE_MAP: Record<TypeName, string | null> = {
    Program: 'Program',

    // literals all merge to 'Literal'
    Num: 'Literal',
    Str: 'Literal',
    Bool: 'Literal',
    Null: 'Literal',
    Regex: 'Literal',
    BigInt: 'Literal',

    // leaves / obvious renames
    Ident: 'Identifier',
    PrivateIdent: 'PrivateIdentifier',
    ThisExpr: 'ThisExpression',
    SuperExpr: 'Super',
    MetaProp: 'MetaProperty',

    // expressions
    TemplateLiteral: 'TemplateLiteral',
    TemplateElement: 'TemplateElement',
    TaggedTemplate: 'TaggedTemplateExpression',
    ArrayExpr: 'ArrayExpression',
    ObjectExpr: 'ObjectExpression',
    Property: 'Property',
    Spread: 'SpreadElement',
    Binary: 'BinaryExpression',
    Logical: 'LogicalExpression',
    Assign: 'AssignmentExpression',
    Unary: 'UnaryExpression',
    Update: 'UpdateExpression',
    Cond: 'ConditionalExpression',
    Call: 'CallExpression',
    New: 'NewExpression',
    Member: 'MemberExpression',
    Seq: 'SequenceExpression',
    Arrow: 'ArrowFunctionExpression',
    FuncExpr: 'FunctionExpression',
    ClassExpr: 'ClassExpression',
    Yield: 'YieldExpression',
    Await: 'AwaitExpression',
    ImportExpr: 'ImportExpression',

    // statements / declarations
    ExprStmt: 'ExpressionStatement',
    VarDecl: 'VariableDeclaration',
    VarDeclarator: 'VariableDeclarator',
    Block: 'BlockStatement',
    If: 'IfStatement',
    For: 'ForStatement',
    ForIn: 'ForInStatement',
    ForOf: 'ForOfStatement',
    While: 'WhileStatement',
    DoWhile: 'DoWhileStatement',
    Switch: 'SwitchStatement',
    SwitchCase: 'SwitchCase',
    Try: 'TryStatement',
    CatchClause: 'CatchClause',
    Return: 'ReturnStatement',
    Throw: 'ThrowStatement',
    Break: 'BreakStatement',
    Continue: 'ContinueStatement',
    Labeled: 'LabeledStatement',
    Empty: 'EmptyStatement',
    Debugger: 'DebuggerStatement',
    FuncDecl: 'FunctionDeclaration',
    ClassDecl: 'ClassDeclaration',
    MethodDef: 'MethodDefinition',
    PropDef: 'PropertyDefinition',
    StaticBlock: 'StaticBlock',

    // patterns
    ObjectPattern: 'ObjectPattern',
    ArrayPattern: 'ArrayPattern',
    AssignPattern: 'AssignmentPattern',
    RestElement: 'RestElement',
    Param: null, // Param is a wrapper we add; ESTree has no dedicated node

    // modules
    ImportDecl: 'ImportDeclaration',
    ImportSpec: 'ImportSpecifier',
    ImportDefaultSpec: 'ImportDefaultSpecifier',
    ImportNamespaceSpec: 'ImportNamespaceSpecifier',
    ExportNamed: 'ExportNamedDeclaration',
    ExportSpec: 'ExportSpecifier',
    ExportDefault: 'ExportDefaultDeclaration',
    ExportAll: 'ExportAllDeclaration',

    // TS types — no ESTree equivalent in meriyah's default (plain-JS) output
    TSTypeAnn: null,
    TSKeyword: null,
    TSTypeRef: null,
    TSQualifiedName: null,
    TSTypeArgs: null,
    TSTypeParams: null,
    TSTypeParam: null,
    TSTuple: null,
    TSNamedTupleMember: null,
    TSTypeLit: null,
    TSPropSig: null,
    TSMethodSig: null,
    TSIndexSig: null,
    TSCallSig: null,
    TSCtorSig: null,
    TSUnion: null,
    TSIntersection: null,
    TSFunctionType: null,
    TSCtorType: null,
    TSArrayType: null,
    TSIndexedAccess: null,
    TSTypeOperator: null,
    TSTypeQuery: null,
    TSConditional: null,
    TSInfer: null,
    TSMapped: null,
    TSLiteralType: null,
    TSTemplateLiteralType: null,
    TSImportType: null,
    TSInterfaceDecl: null,
    TSHeritage: null,
    TSTypeAliasDecl: null,
    TSEnumDecl: null,
    TSEnumMember: null,
    TSAs: null,
    TSSatisfies: null,
    TSNonNull: null,
    TSModuleDecl: null,
};
