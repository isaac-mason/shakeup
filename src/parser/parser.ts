import {
    type Accessibility,
    allocId,
    type BindingIdentifier,
    type IdentifierName,
    type IdentifierReference,
    type LabelIdentifier,
    lineColOf,
    N,
    type Node,
    node,
    type Program,
} from '../ast.ts';
import { enumeration } from '../util/enumeration';
import { ParseErrorCode } from './errors.ts';
import {
    C_DIG,
    C_ID,
    C_NL,
    C_WS,
    CHAR,
    hashRange,
    intern,
    nextToken,
    recordNL,
    reScanRegex,
    reScanTemplateContinue,
    sliceFlat,
} from './lexer.ts';
import {
    F_NL,
    K,
    P,
    type ParseError,
    type ParserState,
    raise,
    T_BIGINT,
    T_EOF,
    T_IDENT,
    T_NUM,
    T_PRIVATE,
    T_REGEX,
    T_STR,
    T_TEMPLATE_FULL,
    T_TEMPLATE_HEAD,
} from './state.ts';
import { isAssignOp, isBinaryOp, isContextual, isKeyword, isLogical, isPunct, opTextOf, precedenceOf } from './token.ts';

// Re-exported so the parser's public surface (via index.ts) still carries ParseError.
export type { ParseError };

/** Any of the four identifier-role leaves; the role is fixed by the constructing call site. */
type Identifier = BindingIdentifier | IdentifierReference | IdentifierName | LabelIdentifier;

const R_BIND = N.BindingIdentifier;
const R_REF = N.IdentifierReference;
const R_NAME = N.IdentifierName;
const R_LABEL = N.LabelIdentifier;

const FL = {
    NAMED: 1 << 0,
    ASYNC: 1 << 0,
    GENERATOR: 1 << 1,
    COMPUTED: 1 << 2,
    STATIC: 1 << 3,
    OPTIONAL: 1 << 4,
    READONLY: 1 << 5,
    DECLARE: 1 << 6,
    ABSTRACT: 1 << 7,
    TYPE_ONLY: 1 << 8,
    PREFIX: 1 << 9,
    DELEGATE: 1 << 9,
    AWAIT: 1 << 9,
    SHORTHAND: 1 << 9,
    EXPR_BODY: 1 << 10,
    DEFINITE: 1 << 10,
    CONST_ENUM: 1 << 10,
    NAMESPACE: 1 << 11,
    KIND_SHIFT: 12,
    ACCESS_SHIFT: 14,
} as const;

const VAR_KIND = { VAR: 1, LET: 2, CONST: 3, KIND_MASK: 3 } as const;

// Unary & update operator ids (their text lives in UNARY_OP_NAME/UPDATE_OP_NAME).
// Binary/logical/assignment operators no longer need an id — their text comes
// straight off the packed token via `opTextOf` (token.ts).
const OP = enumeration('NEG', 'POS', 'NOT', 'BIT_NOT', 'TYPEOF', 'VOID', 'DELETE', 'INC', 'DEC');

const TSOP = enumeration('KEYOF', 'READONLY', 'UNIQUE');

// Binary / logical / assignment operator text now comes from token.ts (`opTextOf`).
// Unary & update still carry an `OP` id (parseUnary maps token → OP inline), so
// only their name tables remain.
const UNARY_OP_NAME: string[] = [];
const UPDATE_OP_NAME: string[] = [];
{
    UNARY_OP_NAME[OP.NEG] = '-';
    UNARY_OP_NAME[OP.POS] = '+';
    UNARY_OP_NAME[OP.NOT] = '!';
    UNARY_OP_NAME[OP.BIT_NOT] = '~';
    UNARY_OP_NAME[OP.TYPEOF] = 'typeof';
    UNARY_OP_NAME[OP.VOID] = 'void';
    UNARY_OP_NAME[OP.DELETE] = 'delete';
    UPDATE_OP_NAME[OP.INC] = '++';
    UPDATE_OP_NAME[OP.DEC] = '--';
}

/** Decode the 2-bit accessibility group of a parser flags int. */
function accessibilityOf(flags: number): Accessibility {
    const a = (flags >> FL.ACCESS_SHIFT) & 3;
    return a === 1 ? 'public' : a === 2 ? 'private' : a === 3 ? 'protected' : null;
}

/** A parse slot: a node object, or null when absent. */
type Ref = Node | null;

/** The null-data TS keyword/leaf type ids the `keyword` helper materializes. */
type KeywordType =
    | typeof N.TSAnyKeyword
    | typeof N.TSStringKeyword
    | typeof N.TSNumberKeyword
    | typeof N.TSBooleanKeyword
    | typeof N.TSBigIntKeyword
    | typeof N.TSSymbolKeyword
    | typeof N.TSObjectKeyword
    | typeof N.TSVoidKeyword
    | typeof N.TSUndefinedKeyword
    | typeof N.TSNullKeyword
    | typeof N.TSNeverKeyword
    | typeof N.TSUnknownKeyword
    | typeof N.TSThisType;

const m = {
    BooleanLiteral: (s: number, e: number, flags: number): Node =>
        node(N.BooleanLiteral, s, e, flags !== 0 ? 'true' : 'false', null),
    NullLiteral: (s: number, e: number, _f: number): Node => node(N.NullLiteral, s, e, 'null', null),
    ThisExpression: (s: number, e: number, _f: number): Node => node(N.ThisExpression, s, e, '', null),
    Super: (s: number, e: number, _f: number): Node => node(N.Super, s, e, '', null),
    EmptyStatement: (s: number, e: number, _f: number): Node => node(N.EmptyStatement, s, e, '', null),
    DebuggerStatement: (s: number, e: number, _f: number): Node => node(N.DebuggerStatement, s, e, '', null),
    ImportMeta: (s: number, e: number, _f: number): Node => node(N.ImportMeta, s, e, '', null),
    NewTarget: (s: number, e: number, _f: number): Node => node(N.NewTarget, s, e, '', null),

    BinaryExpression: (s: number, e: number, op: string, l: Node, r: Node): Node =>
        node(N.BinaryExpression, s, e, '', { operator: op, left: l, right: r }),
    LogicalExpression: (s: number, e: number, op: string, l: Node, r: Node): Node =>
        node(N.LogicalExpression, s, e, '', { operator: op, left: l, right: r }),
    AssignmentExpression: (s: number, e: number, op: string, l: Node, r: Node): Node =>
        node(N.AssignmentExpression, s, e, '', { operator: op, left: l, right: r }),
    UnaryExpression: (s: number, e: number, flags: number, a: Node): Node =>
        node(N.UnaryExpression, s, e, '', { operator: UNARY_OP_NAME[flags & 63], prefix: true, argument: a }),
    UpdateExpression: (s: number, e: number, flags: number, a: Node): Node =>
        node(N.UpdateExpression, s, e, '', {
            operator: UPDATE_OP_NAME[flags & 63],
            prefix: (flags & FL.PREFIX) !== 0,
            argument: a,
        }),
    ObjectProperty: (s: number, e: number, flags: number, key: Node, value: Node): Node =>
        node(N.ObjectProperty, s, e, '', {
            key,
            value,
            kind: (['init', 'get', 'set'] as const)[(flags >> FL.KIND_SHIFT) & 3],
            computed: (flags & FL.COMPUTED) !== 0,
            shorthand: (flags & FL.SHORTHAND) !== 0,
        }),
    CallExpression: (s: number, e: number, flags: number, callee: Node, args: Node[] | null, typeArgs: Node | null): Node =>
        node(N.CallExpression, s, e, '', {
            callee,
            arguments: args ?? [],
            optional: (flags & FL.OPTIONAL) !== 0,
            typeArguments: typeArgs ?? null,
        }),
    StaticMemberExpression: (s: number, e: number, flags: number, obj: Node, prop: Node): Node =>
        node(N.StaticMemberExpression, s, e, '', { object: obj, property: prop, optional: (flags & FL.OPTIONAL) !== 0 }),
    ComputedMemberExpression: (s: number, e: number, flags: number, obj: Node, expr: Node): Node =>
        node(N.ComputedMemberExpression, s, e, '', { object: obj, expression: expr, optional: (flags & FL.OPTIONAL) !== 0 }),
    PrivateFieldExpression: (s: number, e: number, flags: number, obj: Node, field: Node): Node =>
        node(N.PrivateFieldExpression, s, e, '', { object: obj, field, optional: (flags & FL.OPTIONAL) !== 0 }),
    ChainExpression: (s: number, e: number, _f: number, expression: Node): Node =>
        node(N.ChainExpression, s, e, '', { expression }),
    ArrowFunctionExpression: (
        s: number,
        e: number,
        flags: number,
        tp: Node | null,
        params: Node[] | null,
        rt: Node | null,
        body: Node,
    ): Node =>
        node(N.ArrowFunctionExpression, s, e, '', {
            typeParameters: tp ?? null,
            params: params ?? [],
            returnType: rt ?? null,
            body,
            async: (flags & FL.ASYNC) !== 0,
            expression: (flags & FL.EXPR_BODY) !== 0,
        }),
    FunctionExpression: (
        s: number,
        e: number,
        flags: number,
        id: Node | null,
        tp: Node | null,
        params: Node[] | null,
        rt: Node | null,
        body: Node | null,
    ): Node =>
        node(N.FunctionExpression, s, e, '', {
            id: id ?? null,
            typeParameters: tp ?? null,
            params: params ?? [],
            returnType: rt ?? null,
            body: body ?? null,
            async: (flags & FL.ASYNC) !== 0,
            generator: (flags & FL.GENERATOR) !== 0,
        }),
    FunctionDeclaration: (
        s: number,
        e: number,
        flags: number,
        id: Node | null,
        tp: Node | null,
        params: Node[] | null,
        rt: Node | null,
        body: Node | null,
    ): Node =>
        node(N.FunctionDeclaration, s, e, '', {
            id: id ?? null,
            typeParameters: tp ?? null,
            params: params ?? [],
            returnType: rt ?? null,
            body: body ?? null,
            async: (flags & FL.ASYNC) !== 0,
            generator: (flags & FL.GENERATOR) !== 0,
            declare: (flags & FL.DECLARE) !== 0,
        }),
    ClassExpression: (
        s: number,
        e: number,
        _flags: number,
        id: Node | null,
        tp: Node | null,
        sc: Node | null,
        sta: Node | null,
        impl: Node[] | null,
        body: Node[] | null,
    ): Node =>
        node(N.ClassExpression, s, e, '', {
            id: id ?? null,
            typeParameters: tp ?? null,
            superClass: sc ?? null,
            superTypeArguments: sta ?? null,
            implements: impl ?? [],
            body: body ?? [],
        }),
    ClassDeclaration: (
        s: number,
        e: number,
        flags: number,
        id: Node | null,
        tp: Node | null,
        sc: Node | null,
        sta: Node | null,
        impl: Node[] | null,
        body: Node[] | null,
    ): Node =>
        node(N.ClassDeclaration, s, e, '', {
            id: id ?? null,
            typeParameters: tp ?? null,
            superClass: sc ?? null,
            superTypeArguments: sta ?? null,
            implements: impl ?? [],
            body: body ?? [],
            abstract: (flags & FL.ABSTRACT) !== 0,
            declare: (flags & FL.DECLARE) !== 0,
        }),
    YieldExpression: (s: number, e: number, flags: number, a: Node | null): Node =>
        node(N.YieldExpression, s, e, '', { argument: a ?? null, delegate: (flags & FL.DELEGATE) !== 0 }),
    VariableDeclaration: (s: number, e: number, flags: number, decls: Node[] | null): Node =>
        node(N.VariableDeclaration, s, e, '', {
            declarations: decls ?? [],
            kind: (['var', 'var', 'let', 'const'] as const)[flags & VAR_KIND.KIND_MASK],
            declare: (flags & FL.DECLARE) !== 0,
        }),
    VariableDeclarator: (s: number, e: number, flags: number, id: Node, ta: Node | null, init: Node | null): Node =>
        node(N.VariableDeclarator, s, e, '', {
            id,
            typeAnnotation: ta ?? null,
            init: init ?? null,
            definite: (flags & FL.DEFINITE) !== 0,
        }),
    ForOfStatement: (s: number, e: number, flags: number, left: Node, right: Node, body: Node): Node =>
        node(N.ForOfStatement, s, e, '', { left, right, body, await: (flags & FL.AWAIT) !== 0 }),
    MethodDefinition: (s: number, e: number, flags: number, key: Node, value: Node): Node =>
        node(N.MethodDefinition, s, e, '', {
            key,
            value,
            kind: (['method', 'get', 'set', 'constructor'] as const)[(flags >> FL.KIND_SHIFT) & 3],
            static: (flags & FL.STATIC) !== 0,
            computed: (flags & FL.COMPUTED) !== 0,
            optional: (flags & FL.OPTIONAL) !== 0,
            abstract: (flags & FL.ABSTRACT) !== 0,
            accessibility: accessibilityOf(flags),
        }),
    PropertyDefinition: (s: number, e: number, flags: number, key: Node, ta: Node | null, value: Node | null): Node =>
        node(N.PropertyDefinition, s, e, '', {
            key,
            typeAnnotation: ta ?? null,
            value: value ?? null,
            static: (flags & FL.STATIC) !== 0,
            computed: (flags & FL.COMPUTED) !== 0,
            readonly: (flags & FL.READONLY) !== 0,
            optional: (flags & FL.OPTIONAL) !== 0,
            definite: (flags & FL.DEFINITE) !== 0,
            declare: (flags & FL.DECLARE) !== 0,
            abstract: (flags & FL.ABSTRACT) !== 0,
            accessibility: accessibilityOf(flags),
        }),
    FormalParameter: (s: number, e: number, flags: number, pat: Node, ta: Node | null, init: Node | null): Node =>
        node(N.FormalParameter, s, e, '', {
            pattern: pat,
            typeAnnotation: ta ?? null,
            init: init ?? null,
            optional: (flags & FL.OPTIONAL) !== 0,
            readonly: (flags & FL.READONLY) !== 0,
            accessibility: accessibilityOf(flags),
        }),
    ImportDeclaration: (s: number, e: number, flags: number, specs: Node[] | null, source: Node): Node =>
        node(N.ImportDeclaration, s, e, '', {
            specifiers: specs ?? [],
            source,
            importKind: (flags & FL.TYPE_ONLY) !== 0 ? 'type' : 'value',
        }),
    ImportSpecifier: (s: number, e: number, flags: number, local: Node, imported: Node): Node =>
        node(N.ImportSpecifier, s, e, '', { local, imported, importKind: (flags & FL.TYPE_ONLY) !== 0 ? 'type' : 'value' }),
    ExportNamedDeclaration: (
        s: number,
        e: number,
        flags: number,
        decl: Node | null,
        specs: Node[] | null,
        source: Node | null,
    ): Node =>
        node(N.ExportNamedDeclaration, s, e, '', {
            declaration: decl ?? null,
            specifiers: specs ?? [],
            source: source ?? null,
            exportKind: (flags & FL.TYPE_ONLY) !== 0 ? 'type' : 'value',
        }),
    ExportSpecifier: (s: number, e: number, flags: number, local: Node, exported: Node): Node =>
        node(N.ExportSpecifier, s, e, '', { local, exported, exportKind: (flags & FL.TYPE_ONLY) !== 0 ? 'type' : 'value' }),
    keyword: (s: number, e: number, kw: KeywordType): Node => node(kw, s, e, '', null),
    TSTypeParameter: (s: number, e: number, flags: number, name: Node, constraint: Node | null, dflt: Node | null): Node =>
        node(N.TSTypeParameter, s, e, '', {
            name,
            constraint: constraint ?? null,
            default: dflt ?? null,
            in: (flags & 1) !== 0,
            out: (flags & 2) !== 0,
            const: (flags & 4) !== 0,
        }),
    TSNamedTupleMember: (s: number, e: number, flags: number, label: Node, elemType: Node): Node =>
        node(N.TSNamedTupleMember, s, e, '', { label, elementType: elemType, optional: (flags & FL.OPTIONAL) !== 0 }),
    TSPropertySignature: (s: number, e: number, flags: number, key: Node, ta: Node | null): Node =>
        node(N.TSPropertySignature, s, e, '', {
            key,
            typeAnnotation: ta ?? null,
            optional: (flags & FL.OPTIONAL) !== 0,
            readonly: (flags & FL.READONLY) !== 0,
            computed: (flags & FL.COMPUTED) !== 0,
        }),
    TSMethodSignature: (
        s: number,
        e: number,
        flags: number,
        key: Node,
        tp: Node | null,
        params: Node[] | null,
        rt: Node | null,
    ): Node =>
        node(N.TSMethodSignature, s, e, '', {
            key,
            typeParameters: tp ?? null,
            params: params ?? [],
            returnType: rt ?? null,
            optional: (flags & FL.OPTIONAL) !== 0,
            kind: (['method', 'get', 'set'] as const)[(flags >> FL.KIND_SHIFT) & 3],
            computed: (flags & FL.COMPUTED) !== 0,
        }),
    TSIndexSignature: (s: number, e: number, flags: number, param: Node, ta: Node | null): Node =>
        node(N.TSIndexSignature, s, e, '', {
            parameter: param,
            typeAnnotation: ta ?? null,
            readonly: (flags & FL.READONLY) !== 0,
        }),
    TSTypeOperator: (s: number, e: number, flags: number, ta: Node): Node =>
        node(N.TSTypeOperator, s, e, '', {
            operator: flags === 1 ? 'keyof' : flags === 2 ? 'readonly' : flags === 3 ? 'unique' : '',
            typeAnnotation: ta,
        }),
    TSMappedType: (s: number, e: number, flags: number, tp: Node, nameType: Node | null, ta: Node | null): Node =>
        node(N.TSMappedType, s, e, '', {
            typeParameter: tp,
            nameType: nameType ?? null,
            typeAnnotation: ta ?? null,
            readonlyMod: (flags >> 4) & 3,
            optionalMod: (flags >> 6) & 3,
        }),
    TSConstructorType: (s: number, e: number, flags: number, tp: Node | null, params: Node[] | null, rt: Node | null): Node =>
        node(N.TSConstructorType, s, e, '', {
            typeParameters: tp ?? null,
            params: params ?? [],
            returnType: rt ?? null,
            abstract: (flags & FL.ABSTRACT) !== 0,
        }),
    TSInterfaceDeclaration: (
        s: number,
        e: number,
        flags: number,
        id: Node,
        tp: Node | null,
        ext: Node[] | null,
        body: Node[] | null,
    ): Node =>
        node(N.TSInterfaceDeclaration, s, e, '', {
            id,
            typeParameters: tp ?? null,
            extends: ext ?? [],
            body: body ?? [],
            declare: (flags & FL.DECLARE) !== 0,
        }),
    TSTypeAliasDeclaration: (s: number, e: number, flags: number, id: Node, tp: Node | null, ta: Node): Node =>
        node(N.TSTypeAliasDeclaration, s, e, '', {
            id,
            typeParameters: tp ?? null,
            typeAnnotation: ta,
            declare: (flags & FL.DECLARE) !== 0,
        }),
    TSEnumDeclaration: (s: number, e: number, flags: number, id: Node, members: Node[] | null): Node =>
        node(N.TSEnumDeclaration, s, e, '', {
            id,
            members: members ?? [],
            const: (flags & FL.CONST_ENUM) !== 0,
            declare: (flags & FL.DECLARE) !== 0,
        }),
    TSModuleDeclaration: (s: number, e: number, flags: number, id: Node, body: Node[] | null): Node =>
        node(N.TSModuleDeclaration, s, e, '', {
            id,
            body: body ?? [],
            declare: (flags & FL.DECLARE) !== 0,
            namespace: (flags & FL.NAMESPACE) !== 0,
        }),

    Program: (s: number, e: number, _f: number, body: Node[]): Node => node(N.Program, s, e, '', { body }),
    TemplateLiteral: (s: number, e: number, _f: number, quasis: Node[], expressions: Node[]): Node =>
        node(N.TemplateLiteral, s, e, '', { quasis, expressions }),
    TaggedTemplateExpression: (s: number, e: number, _f: number, tag: Node, quasi: Node): Node =>
        node(N.TaggedTemplateExpression, s, e, '', { tag, quasi }),
    ArrayExpression: (s: number, e: number, _f: number, elements: (Node | null)[]): Node =>
        node(N.ArrayExpression, s, e, '', { elements }),
    ObjectExpression: (s: number, e: number, _f: number, properties: Node[]): Node =>
        node(N.ObjectExpression, s, e, '', { properties }),
    SpreadElement: (s: number, e: number, _f: number, argument: Node): Node => node(N.SpreadElement, s, e, '', { argument }),
    ConditionalExpression: (s: number, e: number, _f: number, test: Node, consequent: Node, alternate: Node): Node =>
        node(N.ConditionalExpression, s, e, '', { test, consequent, alternate }),
    NewExpression: (s: number, e: number, _f: number, callee: Node, args: Node[] | null, typeArgs: Node | null): Node =>
        node(N.NewExpression, s, e, '', { callee, arguments: args ?? [], typeArguments: typeArgs ?? null }),
    SequenceExpression: (s: number, e: number, _f: number, expressions: Node[]): Node =>
        node(N.SequenceExpression, s, e, '', { expressions }),
    AwaitExpression: (s: number, e: number, _f: number, argument: Node): Node => node(N.AwaitExpression, s, e, '', { argument }),
    ImportExpression: (s: number, e: number, _f: number, source: Node, options: Node | null): Node =>
        node(N.ImportExpression, s, e, '', { source, options: options ?? null }),
    ExpressionStatement: (s: number, e: number, _f: number, expression: Node): Node =>
        node(N.ExpressionStatement, s, e, '', { expression }),
    BlockStatement: (s: number, e: number, _f: number, body: Node[]): Node => node(N.BlockStatement, s, e, '', { body }),
    IfStatement: (s: number, e: number, _f: number, test: Node, consequent: Node, alternate: Node | null): Node =>
        node(N.IfStatement, s, e, '', { test, consequent, alternate: alternate ?? null }),
    ForStatement: (
        s: number,
        e: number,
        _f: number,
        init: Node | null,
        test: Node | null,
        update: Node | null,
        body: Node,
    ): Node => node(N.ForStatement, s, e, '', { init: init ?? null, test: test ?? null, update: update ?? null, body }),
    ForInStatement: (s: number, e: number, _f: number, left: Node, right: Node, body: Node): Node =>
        node(N.ForInStatement, s, e, '', { left, right, body }),
    WhileStatement: (s: number, e: number, _f: number, test: Node, body: Node): Node =>
        node(N.WhileStatement, s, e, '', { test, body }),
    DoWhileStatement: (s: number, e: number, _f: number, body: Node, test: Node): Node =>
        node(N.DoWhileStatement, s, e, '', { body, test }),
    SwitchStatement: (s: number, e: number, _f: number, discriminant: Node, cases: Node[]): Node =>
        node(N.SwitchStatement, s, e, '', { discriminant, cases }),
    SwitchCase: (s: number, e: number, _f: number, test: Node | null, consequent: Node[]): Node =>
        node(N.SwitchCase, s, e, '', { test: test ?? null, consequent }),
    TryStatement: (s: number, e: number, _f: number, block: Node, handler: Node | null, finalizer: Node | null): Node =>
        node(N.TryStatement, s, e, '', { block, handler: handler ?? null, finalizer: finalizer ?? null }),
    CatchClause: (s: number, e: number, _f: number, param: Node | null, body: Node): Node =>
        node(N.CatchClause, s, e, '', { param: param ?? null, body }),
    ReturnStatement: (s: number, e: number, _f: number, argument: Node | null): Node =>
        node(N.ReturnStatement, s, e, '', { argument: argument ?? null }),
    ThrowStatement: (s: number, e: number, _f: number, argument: Node): Node => node(N.ThrowStatement, s, e, '', { argument }),
    BreakStatement: (s: number, e: number, _f: number, label: Node | null): Node =>
        node(N.BreakStatement, s, e, '', { label: label ?? null }),
    ContinueStatement: (s: number, e: number, _f: number, label: Node | null): Node =>
        node(N.ContinueStatement, s, e, '', { label: label ?? null }),
    LabeledStatement: (s: number, e: number, _f: number, label: Node, body: Node): Node =>
        node(N.LabeledStatement, s, e, '', { label, body }),
    StaticBlock: (s: number, e: number, _f: number, body: Node[]): Node => node(N.StaticBlock, s, e, '', { body }),
    ObjectPattern: (s: number, e: number, _f: number, properties: Node[]): Node =>
        node(N.ObjectPattern, s, e, '', { properties }),
    ArrayPattern: (s: number, e: number, _f: number, elements: (Node | null)[]): Node =>
        node(N.ArrayPattern, s, e, '', { elements }),
    AssignmentPattern: (s: number, e: number, _f: number, left: Node, right: Node): Node =>
        node(N.AssignmentPattern, s, e, '', { left, right }),
    RestElement: (s: number, e: number, _f: number, argument: Node, typeAnnotation: Node | null): Node =>
        node(N.RestElement, s, e, '', { argument, typeAnnotation: typeAnnotation ?? null }),
    ImportDefaultSpecifier: (s: number, e: number, _f: number, local: Node): Node =>
        node(N.ImportDefaultSpecifier, s, e, '', { local }),
    ImportNamespaceSpecifier: (s: number, e: number, _f: number, local: Node): Node =>
        node(N.ImportNamespaceSpecifier, s, e, '', { local }),
    ExportDefaultDeclaration: (s: number, e: number, _f: number, declaration: Node): Node =>
        node(N.ExportDefaultDeclaration, s, e, '', { declaration }),
    ExportAllDeclaration: (s: number, e: number, _f: number, source: Node, exported: Node | null): Node =>
        node(N.ExportAllDeclaration, s, e, '', { source, exported: exported ?? null }),
    TSTypeAnnotation: (s: number, e: number, _f: number, typeAnnotation: Node): Node =>
        node(N.TSTypeAnnotation, s, e, '', { typeAnnotation }),
    TSTypeReference: (s: number, e: number, _f: number, typeName: Node, typeArguments: Node | null): Node =>
        node(N.TSTypeReference, s, e, '', { typeName, typeArguments: typeArguments ?? null }),
    TSQualifiedName: (s: number, e: number, _f: number, left: Node, right: Node): Node =>
        node(N.TSQualifiedName, s, e, '', { left, right }),
    TSTypeParameterInstantiation: (s: number, e: number, _f: number, params: Node[]): Node =>
        node(N.TSTypeParameterInstantiation, s, e, '', { params }),
    TSTypeParameterDeclaration: (s: number, e: number, _f: number, params: Node[]): Node =>
        node(N.TSTypeParameterDeclaration, s, e, '', { params }),
    TSTupleType: (s: number, e: number, _f: number, elementTypes: Node[]): Node =>
        node(N.TSTupleType, s, e, '', { elementTypes }),
    TSTypeLiteral: (s: number, e: number, _f: number, members: Node[]): Node => node(N.TSTypeLiteral, s, e, '', { members }),
    TSCallSignatureDeclaration: (
        s: number,
        e: number,
        _f: number,
        typeParameters: Node | null,
        params: Node[] | null,
        returnType: Node | null,
    ): Node =>
        node(N.TSCallSignatureDeclaration, s, e, '', {
            typeParameters: typeParameters ?? null,
            params: params ?? [],
            returnType: returnType ?? null,
        }),
    TSConstructSignatureDeclaration: (
        s: number,
        e: number,
        _f: number,
        typeParameters: Node | null,
        params: Node[] | null,
        returnType: Node | null,
    ): Node =>
        node(N.TSConstructSignatureDeclaration, s, e, '', {
            typeParameters: typeParameters ?? null,
            params: params ?? [],
            returnType: returnType ?? null,
        }),
    TSUnionType: (s: number, e: number, _f: number, types: Node[]): Node => node(N.TSUnionType, s, e, '', { types }),
    TSIntersectionType: (s: number, e: number, _f: number, types: Node[]): Node =>
        node(N.TSIntersectionType, s, e, '', { types }),
    TSFunctionType: (
        s: number,
        e: number,
        _f: number,
        typeParameters: Node | null,
        params: Node[] | null,
        returnType: Node | null,
    ): Node =>
        node(N.TSFunctionType, s, e, '', {
            typeParameters: typeParameters ?? null,
            params: params ?? [],
            returnType: returnType ?? null,
        }),
    TSArrayType: (s: number, e: number, _f: number, elementType: Node): Node => node(N.TSArrayType, s, e, '', { elementType }),
    TSIndexedAccessType: (s: number, e: number, _f: number, objectType: Node, indexType: Node): Node =>
        node(N.TSIndexedAccessType, s, e, '', { objectType, indexType }),
    TSTypeQuery: (s: number, e: number, _f: number, exprName: Node, typeArguments: Node | null): Node =>
        node(N.TSTypeQuery, s, e, '', { exprName, typeArguments: typeArguments ?? null }),
    TSConditionalType: (
        s: number,
        e: number,
        _f: number,
        checkType: Node,
        extendsType: Node,
        trueType: Node,
        falseType: Node,
    ): Node => node(N.TSConditionalType, s, e, '', { checkType, extendsType, trueType, falseType }),
    TSInferType: (s: number, e: number, _f: number, typeParameter: Node): Node =>
        node(N.TSInferType, s, e, '', { typeParameter }),
    TSLiteralType: (s: number, e: number, _f: number, literal: Node): Node => node(N.TSLiteralType, s, e, '', { literal }),
    TSTemplateLiteralType: (s: number, e: number, _f: number, quasis: Node[], types: Node[]): Node =>
        node(N.TSTemplateLiteralType, s, e, '', { quasis, types }),
    TSImportType: (s: number, e: number, _f: number, source: Node, qualifier: Node | null, typeArguments: Node | null): Node =>
        node(N.TSImportType, s, e, '', { source, qualifier: qualifier ?? null, typeArguments: typeArguments ?? null }),
    TSClassImplements: (s: number, e: number, _f: number, expression: Node, typeArguments: Node | null): Node =>
        node(N.TSClassImplements, s, e, '', { expression, typeArguments: typeArguments ?? null }),
    TSInterfaceHeritage: (s: number, e: number, _f: number, expression: Node, typeArguments: Node | null): Node =>
        node(N.TSInterfaceHeritage, s, e, '', { expression, typeArguments: typeArguments ?? null }),
    TSEnumMember: (s: number, e: number, _f: number, id: Node, initializer: Node | null): Node =>
        node(N.TSEnumMember, s, e, '', { id, initializer: initializer ?? null }),
    TSAsExpression: (s: number, e: number, _f: number, expression: Node, typeAnnotation: Node): Node =>
        node(N.TSAsExpression, s, e, '', { expression, typeAnnotation }),
    TSSatisfiesExpression: (s: number, e: number, _f: number, expression: Node, typeAnnotation: Node): Node =>
        node(N.TSSatisfiesExpression, s, e, '', { expression, typeAnnotation }),
    TSNonNullExpression: (s: number, e: number, _f: number, expression: Node): Node =>
        node(N.TSNonNullExpression, s, e, '', { expression }),
    TSInstantiationExpression: (s: number, e: number, _f: number, expression: Node, typeArguments: Node): Node =>
        node(N.TSInstantiationExpression, s, e, '', { expression, typeArguments }),

    JSXElement: (s: number, e: number, _f: number, openingElement: Node, children: Node[], closingElement: Node | null): Node =>
        node(N.JSXElement, s, e, '', { openingElement, children, closingElement: closingElement ?? null }),
    JSXOpeningElement: (s: number, e: number, _f: number, name: Node, typeArguments: Node | null, attributes: Node[]): Node =>
        node(N.JSXOpeningElement, s, e, '', { name, typeArguments: typeArguments ?? null, attributes }),
    JSXClosingElement: (s: number, e: number, _f: number, name: Node): Node => node(N.JSXClosingElement, s, e, '', { name }),
    JSXFragment: (s: number, e: number, _f: number, openingFragment: Node, children: Node[], closingFragment: Node): Node =>
        node(N.JSXFragment, s, e, '', { openingFragment, children, closingFragment }),
    JSXOpeningFragment: (s: number, e: number, _f: number): Node => node(N.JSXOpeningFragment, s, e, '', null),
    JSXClosingFragment: (s: number, e: number, _f: number): Node => node(N.JSXClosingFragment, s, e, '', null),
    JSXNamespacedName: (s: number, e: number, _f: number, namespace: Node, name: Node): Node =>
        node(N.JSXNamespacedName, s, e, '', { namespace, name }),
    JSXMemberExpression: (s: number, e: number, _f: number, object: Node, property: Node): Node =>
        node(N.JSXMemberExpression, s, e, '', { object, property }),
    JSXExpressionContainer: (s: number, e: number, _f: number, expression: Node): Node =>
        node(N.JSXExpressionContainer, s, e, '', { expression }),
    JSXEmptyExpression: (s: number, e: number, _f: number): Node => node(N.JSXEmptyExpression, s, e, '', null),
    JSXAttribute: (s: number, e: number, _f: number, name: Node, value: Node | null): Node =>
        node(N.JSXAttribute, s, e, '', { name, value: value ?? null }),
    JSXSpreadAttribute: (s: number, e: number, _f: number, argument: Node): Node =>
        node(N.JSXSpreadAttribute, s, e, '', { argument }),
    JSXSpreadChild: (s: number, e: number, _f: number, expression: Node): Node =>
        node(N.JSXSpreadChild, s, e, '', { expression }),
};

// Token-identity aliases (P / K / T_*), F_NL, ParserState, and raise now live in
// state.ts; the lexer/scanner lives in lexer.ts (both imported at the top).

/** Fresh parser state for one `parse` call. Every field is initialized here so
 * `state` keeps a single stable hidden class for the whole parse. */
function createParserState(source: string, options: ParseOptions): ParserState {
    // Start the per-file buffers small and let them grow on demand (push / internGrow /
    // recordNL). Most modules are small; oversizing every state (esp. the null-filled stk
    // and the zeroed interner arrays) was pure per-file allocation. Large files just regrow.
    const cap = 1 << 10;
    return {
        src: source,
        srcLen: source.length,
        pos: 0,
        tok: T_EOF,
        tokStart: 0,
        tokEnd: 0,
        tokFlags: 0,
        tokHash: 0,
        tsMode: options.ts,
        jsxMode: options.jsx,
        errors: [],
        baseId: 0,
        itKeys: new Array(cap),
        itHashes: new Int32Array(cap),
        itMask: cap - 1,
        itCount: 0,
        lineStarts: new Uint32Array(1 << 9),
        lineCount: 0,
        stk: new Array(1 << 8).fill(null),
        sp: 0,
        speculating: 0,
        chainSawOptional: false,
        noCondType: false,
    };
}

function nextId(state: ParserState): number {
    const id = allocId();
    if (state.baseId === 0) state.baseId = id;
    return id;
}

// `v` is a packed token constant (P.* / K.*); packed values are unique per kind,
// so a whole-value compare is both the kind check and the identity check.
const isP = (state: ParserState, v: number): boolean => state.tok === v;
const isK = (state: ParserState, v: number): boolean => state.tok === v;

function eatP(state: ParserState, v: number): boolean {
    if (isP(state, v)) {
        nextToken(state);
        return true;
    }
    return false;
}
function expectP(state: ParserState, v: number, what: string): void {
    if (isP(state, v)) nextToken(state);
    else raise(state, ParseErrorCode.Expected, what);
}
function eatK(state: ParserState, v: number): boolean {
    if (isK(state, v)) {
        nextToken(state);
        return true;
    }
    return false;
}

function isIdentLike(state: ParserState): boolean {
    return state.tok === T_IDENT || isContextual(state.tok);
}
function isNameLike(state: ParserState): boolean {
    return state.tok === T_IDENT || isKeyword(state.tok);
}

/** Human description of the current token for diagnostics: `token 'foo'`, or `end of input`. */
function tokenDesc(state: ParserState): string {
    return state.tokEnd > state.tokStart ? `token '${state.src.slice(state.tokStart, state.tokEnd)}'` : 'end of input';
}

function ident(state: ParserState, role: number, start: number, end: number): Identifier {
    const h = start === state.tokStart && end === state.tokEnd ? state.tokHash : hashRange(state, start, end);
    return { id: nextId(state), type: role, start, end, name: intern(state, start, end, h), sym: 0, data: null } as Identifier;
}
function leafRaw(state: ParserState, flatType: number, start: number, end: number): Node {
    return { id: nextId(state), type: flatType, start, end, name: sliceFlat(state, start, end), sym: 0, data: null } as Node;
}
/** Parse an identifier token in the given role. `role` picks the leaf type. */
function parseIdent(state: ParserState, role: number): Identifier {
    if (!isIdentLike(state)) {
        raise(state, ParseErrorCode.ExpectedIdentifier);
        return makeMissingIdent(state, role);
    }
    const id = ident(state, role, state.tokStart, state.tokEnd);
    nextToken(state);
    return id;
}
/** Parse a name-or-keyword token as an identifier in the given role (property
 * keys, member names, specifier names — usually IdentifierName). */
function parseNameAsIdent(state: ParserState, role: number): Identifier {
    if (!isNameLike(state)) {
        raise(state, ParseErrorCode.ExpectedName);
        return makeMissingIdent(state, role);
    }
    const id = ident(state, role, state.tokStart, state.tokEnd);
    nextToken(state);
    return id;
}
function makeMissingIdent(state: ParserState, role: number): Identifier {
    return { id: nextId(state), type: role, start: 0, end: 0, name: '', sym: 0, data: null } as Identifier;
}
/** A literal/leaf of the given flat type at the current token span. */
function leaf(state: ParserState, flatType: number, start: number, end: number): Node {
    return leafRaw(state, flatType, start, end);
}

const canInsertSemi = (state: ParserState): boolean =>
    (state.tokFlags & F_NL) !== 0 || state.tok === T_EOF || isP(state, P.RBRACE);
function consumeSemi(state: ParserState): void {
    if (eatP(state, P.SEMI)) return;
    if (!canInsertSemi(state)) raise(state, ParseErrorCode.Expected, "';'");
}

type LexState = [number, number, number, number, number, number, number, number];
const saveState = (state: ParserState): LexState => [
    state.pos,
    state.tok,
    state.tokStart,
    state.tokEnd,
    state.tokFlags,
    state.errors.length,
    state.tokHash,
    state.lineCount,
];
function restoreState(state: ParserState, s: LexState): void {
    state.pos = s[0];
    state.tok = s[1];
    state.tokStart = s[2];
    state.tokEnd = s[3];
    state.tokFlags = s[4];
    state.errors.length = s[5];
    state.tokHash = s[6];
    state.lineCount = s[7];
}

function push(state: ParserState, v: Ref): void {
    const stk = state.stk;
    if (state.sp === stk.length) {
        const n = stk.length;
        for (let i = 0; i < n; i++) stk.push(null);
    }
    stk[state.sp++] = v;
}
const DEV = process.env.NODE_ENV !== 'production';

/** Position of the current token as `line:col`, for invariant messages. */
function here(state: ParserState): string {
    const { line, column } = lineColOf(state.lineStarts.slice(0, state.lineCount), state.tokStart);
    return `${line}:${column}`;
}

/** Materialize [from, sp) into a fresh exact-size packed array (dropping the run).
 * Grammar-guaranteed list: asserts (dev) that no hole slipped through. */
function finishList(state: ParserState, from: number): Node[] {
    const stk = state.stk;
    if (DEV)
        for (let i = from; i < state.sp; i++)
            if (stk[i] === null) throw new Error(`parser invariant: null in list at ${here(state)}`);
    const out = stk.slice(from, state.sp) as Node[];
    state.sp = from;
    return out;
}
/** As finishList but typed to preserve nulls (array-pattern / call holes). */
function finishListWithHoles(state: ParserState, from: number): (Node | null)[] {
    const out = state.stk.slice(from, state.sp);
    state.sp = from;
    return out;
}

function applyDeclare(inner: Node, start: number): void {
    const r = inner as { data: { declare?: boolean } | null };
    if (r.data !== null) r.data.declare = true;
    inner.start = start;
}

function parseExpression(state: ParserState, noIn = false): Node {
    const expr = parseAssign(state, noIn);
    if (isP(state, P.COMMA)) {
        const start = expr.start;
        const from = state.sp;
        push(state, expr);
        while (eatP(state, P.COMMA)) push(state, parseAssign(state, noIn));
        return m.SequenceExpression(start, state.tokStart, 0, finishList(state, from)) as Node;
    }
    return expr;
}

function parseAssign(state: ParserState, noIn = false): Node {
    if (isP(state, P.LPAREN) && arrowAheadFromParen(state)) return parseArrow(state, state.tokStart, 0, null);
    if (isIdentLike(state) && !isK(state, K.ASYNC)) {
        const s = saveState(state);
        if (state.tok === T_IDENT || isContextual(state.tok)) {
            const idStart = state.tokStart;
            const maybe = parseIdent(state, R_BIND);
            if (isP(state, P.ARROW) && (state.tokFlags & F_NL) === 0) return parseArrowAfterSingleParam(state, idStart, maybe, 0);
            restoreState(state, s);
        }
    }
    if (isK(state, K.ASYNC) && (state.tokFlags & F_NL) === 0) {
        const s = saveState(state);
        const asyncStart = state.tokStart;
        nextToken(state);
        if ((state.tokFlags & F_NL) === 0) {
            if (isP(state, P.LPAREN) && arrowAheadFromParen(state)) return parseArrow(state, asyncStart, FL.ASYNC, null);
            if (isIdentLike(state)) {
                const idStart = state.tokStart;
                const single = parseIdent(state, R_BIND);
                if (isP(state, P.ARROW)) return parseArrowAfterSingleParam(state, asyncStart, single, FL.ASYNC, idStart);
            }
        }
        restoreState(state, s);
    }
    if (state.tsMode && isP(state, P.LT)) {
        const s = saveState(state);
        const start = state.tokStart;
        const tp = tryParseTypeParams(state);
        if (tp !== null && isP(state, P.LPAREN) && arrowAheadFromParen(state)) return parseArrow(state, start, 0, tp);
        restoreState(state, s);
    }
    if (isK(state, K.YIELD)) {
        const start = state.tokStart;
        nextToken(state);
        let flags = 0;
        if (isP(state, P.STAR)) {
            flags |= FL.DELEGATE;
            nextToken(state);
        }
        let arg: Ref = null;
        if (
            !canInsertSemi(state) &&
            !isP(state, P.RPAREN) &&
            !isP(state, P.RBRACKET) &&
            !isP(state, P.RBRACE) &&
            !isP(state, P.COMMA) &&
            !isP(state, P.SEMI) &&
            !isP(state, P.COLON)
        )
            arg = parseAssign(state, noIn);
        return m.YieldExpression(start, arg ? arg.end : state.tokStart, flags, arg) as Node;
    }

    const left = parseConditional(state, noIn);
    if (isAssignOp(state.tok)) {
        const op = opTextOf(state.tok);
        nextToken(state);
        const right = parseAssign(state, noIn);
        return m.AssignmentExpression(left.start, right.end, op, left, right) as Node;
    }
    return left;
}

function parseConditional(state: ParserState, noIn: boolean): Node {
    const test = parseBinary(state, 0, noIn);
    if (!isP(state, P.QUESTION)) return test;
    nextToken(state);
    const cons = parseAssign(state, false);
    expectP(state, P.COLON, "':'");
    const alt = parseAssign(state, noIn);
    return m.ConditionalExpression(test.start, alt.end, 0, test, cons, alt) as Node;
}

function parseBinary(state: ParserState, minPrec: number, noIn: boolean): Node {
    let left = parseUnary(state);
    for (;;) {
        const tok = state.tok;
        // TS `as` / `satisfies` are type operators (they consume a type), not binary ops.
        if (state.tsMode && (tok === K.AS || tok === K.SATISFIES) && (state.tokFlags & F_NL) === 0) {
            const satisfies = tok === K.SATISFIES;
            nextToken(state);
            const ty = parseType(state);
            left = satisfies
                ? (m.TSSatisfiesExpression(left.start, ty.end, 0, left, ty) as Node)
                : (m.TSAsExpression(left.start, ty.end, 0, left, ty) as Node);
            continue;
        }
        // One uniform path: punctuator ops and `in`/`instanceof` all carry precedence
        // + IsBinaryOp in the packed token (token.ts), so there is no punct-vs-keyword branch.
        if (!isBinaryOp(tok)) return left;
        if (tok === K.IN && noIn) return left; // `in` is not an operator in a no-in context
        const prec = precedenceOf(tok);
        if (prec <= minPrec) return left;
        nextToken(state);
        const right = parseBinary(state, tok === P.STARSTAR ? prec - 1 : prec, noIn);
        const op = opTextOf(tok);
        left = isLogical(tok)
            ? (m.LogicalExpression(left.start, right.end, op, left, right) as Node)
            : (m.BinaryExpression(left.start, right.end, op, left, right) as Node);
    }
}

function parseUnary(state: ParserState): Node {
    const start = state.tokStart;
    if (isPunct(state.tok)) {
        switch (state.tok as number) {
            case P.PLUS:
            case P.MINUS:
            case P.BANG:
            case P.TILDE: {
                const op =
                    state.tok === P.PLUS ? OP.POS : state.tok === P.MINUS ? OP.NEG : state.tok === P.BANG ? OP.NOT : OP.BIT_NOT;
                nextToken(state);
                const arg = parseUnary(state);
                return m.UnaryExpression(start, arg.end, op, arg) as Node;
            }
            case P.PLUSPLUS:
            case P.MINUSMINUS: {
                const op = state.tok === P.PLUSPLUS ? OP.INC : OP.DEC;
                nextToken(state);
                const arg = parseUnary(state);
                return m.UpdateExpression(start, arg.end, op | FL.PREFIX, arg) as Node;
            }
        }
    } else if (isKeyword(state.tok)) {
        switch (state.tok as number) {
            case K.TYPEOF:
            case K.VOID:
            case K.DELETE: {
                const op = state.tok === K.TYPEOF ? OP.TYPEOF : state.tok === K.VOID ? OP.VOID : OP.DELETE;
                nextToken(state);
                const arg = parseUnary(state);
                return m.UnaryExpression(start, arg.end, op, arg) as Node;
            }
            case K.AWAIT: {
                nextToken(state);
                const arg = parseUnary(state);
                return m.AwaitExpression(start, arg.end, 0, arg) as Node;
            }
        }
    }
    let expr = parsePostfixChain(state);
    if (isPunct(state.tok) && (state.tok === P.PLUSPLUS || state.tok === P.MINUSMINUS) && (state.tokFlags & F_NL) === 0) {
        const op = state.tok === P.PLUSPLUS ? OP.INC : OP.DEC;
        nextToken(state);
        expr = m.UpdateExpression(expr.start, state.tokStart, op, expr) as Node;
    }
    return expr;
}

function parsePostfixChain(state: ParserState): Node {
    if (isK(state, K.NEW)) return parseNew(state);
    return parseMemberChain(state, parsePrimary(state), true);
}

function parseNew(state: ParserState): Node {
    const start = state.tokStart;
    nextToken(state);
    if (isP(state, P.DOT)) {
        nextToken(state);
        parseNameAsIdent(state, R_NAME);
        return m.NewTarget(start, state.tokStart, 0) as Node;
    }
    let callee: Node;
    if (isK(state, K.NEW)) {
        callee = parseNew(state);
    } else {
        callee = parseMemberChain(state, parsePrimary(state), false);
        // `new a?.b()` is a SyntaxError; the parenthesized `new (a?.b)()` is legal (the `?.`
        // is consumed inside parsePrimary, so this frame's flag stays false there).
        if (state.chainSawOptional) raise(state, ParseErrorCode.NewOptionalChain);
    }
    let typeArgs: Ref = null;
    if (state.tsMode && isP(state, P.LT)) {
        const t = tryParseTypeArgsForCall(state);
        if (t !== null) typeArgs = t;
    }
    let args: Node[] | null = null;
    let end = callee.end;
    if (isP(state, P.LPAREN)) {
        args = parseArgs(state);
        end = state.tokStart;
    }
    const nw = m.NewExpression(start, end, 0, callee, args, typeArgs) as Node;
    return parseMemberChain(state, nw, true);
}

function parseArgs(state: ParserState): Node[] {
    nextToken(state);
    const from = state.sp;
    while (!isP(state, P.RPAREN) && (state.tok as number) !== T_EOF) {
        if (isP(state, P.DOTDOTDOT)) {
            const s = state.tokStart;
            nextToken(state);
            const arg = parseAssign(state);
            push(state, m.SpreadElement(s, arg.end, 0, arg) as Node);
        } else push(state, parseAssign(state));
        if (!eatP(state, P.COMMA)) break;
    }
    expectP(state, P.RPAREN, "')'");
    return finishList(state, from);
}

function parseMemberChain(state: ParserState, expr: Node, allowCall: boolean): Node {
    let sawOptional = false;
    const finish = (e: Node): Node => {
        state.chainSawOptional = sawOptional;
        return sawOptional ? (m.ChainExpression(e.start, e.end, 0, e) as Node) : e;
    };
    for (;;) {
        if (isP(state, P.DOT)) {
            nextToken(state);
            if (state.tok === T_PRIVATE) {
                const prop = parsePrivate(state);
                expr = m.PrivateFieldExpression(expr.start, prop.end, 0, expr, prop) as Node;
            } else {
                const prop = parseNameAsIdent(state, R_NAME);
                expr = m.StaticMemberExpression(expr.start, prop.end, 0, expr, prop) as Node;
            }
        } else if (isP(state, P.QDOT)) {
            sawOptional = true;
            nextToken(state);
            if (isP(state, P.LPAREN)) {
                if (!allowCall) return finish(expr);
                const args = parseArgs(state);
                expr = m.CallExpression(expr.start, state.tokStart, FL.OPTIONAL, expr, args, null) as Node;
            } else if (isP(state, P.LBRACKET)) {
                nextToken(state);
                const prop = parseExpression(state);
                expectP(state, P.RBRACKET, "']'");
                expr = m.ComputedMemberExpression(expr.start, state.tokStart, FL.OPTIONAL, expr, prop) as Node;
            } else if (state.tok === T_PRIVATE) {
                const prop = parsePrivate(state);
                expr = m.PrivateFieldExpression(expr.start, prop.end, FL.OPTIONAL, expr, prop) as Node;
            } else {
                const prop = parseNameAsIdent(state, R_NAME);
                expr = m.StaticMemberExpression(expr.start, prop.end, FL.OPTIONAL, expr, prop) as Node;
            }
        } else if (isP(state, P.LBRACKET)) {
            nextToken(state);
            const prop = parseExpression(state);
            expectP(state, P.RBRACKET, "']'");
            expr = m.ComputedMemberExpression(expr.start, state.tokStart, 0, expr, prop) as Node;
        } else if (allowCall && isP(state, P.LPAREN)) {
            const args = parseArgs(state);
            expr = m.CallExpression(expr.start, state.tokStart, 0, expr, args, null) as Node;
        } else if (state.tok === T_TEMPLATE_FULL || state.tok === T_TEMPLATE_HEAD) {
            if (sawOptional) raise(state, ParseErrorCode.TaggedOptionalChain);
            const quasi = parseTemplate(state);
            expr = m.TaggedTemplateExpression(expr.start, quasi.end, 0, expr, quasi) as Node;
        } else if (state.tsMode && isP(state, P.BANG) && (state.tokFlags & F_NL) === 0) {
            nextToken(state);
            expr = m.TSNonNullExpression(expr.start, state.tokStart, 0, expr) as Node;
        } else if (state.tsMode && allowCall && isP(state, P.LT)) {
            const t = tryParseTypeArgsForCall(state);
            if (t === null) return finish(expr);
            if (isP(state, P.LPAREN)) {
                const args = parseArgs(state);
                expr = m.CallExpression(expr.start, state.tokStart, 0, expr, args, t) as Node;
            } else if (state.tok === T_TEMPLATE_FULL || state.tok === T_TEMPLATE_HEAD) {
                if (sawOptional) raise(state, ParseErrorCode.TaggedOptionalChain);
                const quasi = parseTemplate(state);
                expr = m.TaggedTemplateExpression(expr.start, quasi.end, 0, expr, quasi) as Node;
            } else {
                // bare instantiation expression `f<number>`: keep the type args as a
                // node so emit strips them. tryParseTypeArgsForCall's follow-set
                // already gated that `<...>` is type args here (not a `<` comparison).
                expr = m.TSInstantiationExpression(expr.start, t.end, 0, expr, t) as Node;
            }
        } else return finish(expr);
    }
}

function parsePrivate(state: ParserState): Node {
    const id: Node = {
        id: nextId(state),
        type: N.PrivateIdentifier,
        start: state.tokStart,
        end: state.tokEnd,
        name: intern(state, state.tokStart + 1, state.tokEnd, state.tokHash),
        sym: 0,
        data: null,
    };
    nextToken(state);
    return id;
}

function parseTemplate(state: ParserState): Node {
    const start = state.tokStart;
    if (state.tok === T_TEMPLATE_FULL) {
        const q = leaf(state, N.TemplateElement, start + 1, state.tokEnd - 1);
        nextToken(state);
        return m.TemplateLiteral(start, q.end + 1, 0, [q], []) as Node;
    }
    const qFrom = state.sp;
    const eFrom: Node[] = [];
    push(state, leaf(state, N.TemplateElement, start + 1, state.tokEnd - 2));
    nextToken(state);
    for (;;) {
        eFrom.push(parseExpression(state));
        if (!isP(state, P.RBRACE)) {
            raise(state, ParseErrorCode.ExpectedRBraceInTemplate);
            break;
        }
        reScanTemplateContinue(state);
        if (state.tok === T_TEMPLATE_FULL) {
            push(state, leaf(state, N.TemplateElement, state.tokStart + 1, state.tokEnd - 1));
            nextToken(state);
            break;
        }
        push(state, leaf(state, N.TemplateElement, state.tokStart + 1, state.tokEnd - 2));
        nextToken(state);
    }
    const quasis = finishList(state, qFrom);
    return m.TemplateLiteral(start, state.tokStart, 0, quasis, eFrom) as Node;
}

/** Is `c` a valid start char of a JSX identifier (letter / `_` / `$`, or any
 * non-ASCII treated as ident). */
function isJSXIdentStart(c: number): boolean {
    return c < 128 ? CHAR[c] === C_ID : c !== 0x2028 && c !== 0x2029;
}

function scanJSXName(state: ParserState): [number, number] {
    const src = state.src,
        srcLen = state.srcLen;
    const start = state.pos;
    let pos = state.pos + 1;
    while (pos < srcLen) {
        const c = src.charCodeAt(pos);
        if (c < 128) {
            const cl = CHAR[c];
            if (cl === C_ID || cl === C_DIG || c === 45) {
                pos++;
                continue;
            }
            break;
        }
        if (c === 0x2028 || c === 0x2029) break;
        pos++;
    }
    state.pos = pos;
    return [start, pos];
}

/** Skip whitespace/newlines (recording line starts) inside a JSX tag interior. */
function skipJSXTagWs(state: ParserState): void {
    const src = state.src,
        srcLen = state.srcLen;
    let pos = state.pos;
    while (pos < srcLen) {
        const c = src.charCodeAt(pos);
        if (c === 10) {
            recordNL(state, pos);
            pos++;
            continue;
        }
        if (c < 128 ? CHAR[c] === C_WS || CHAR[c] === C_NL : c === 0x2028 || c === 0x2029 || c === 0xa0 || c === 0xfeff) {
            pos++;
            continue;
        }
        break;
    }
    state.pos = pos;
}

/** A JSXIdentifier leaf (data:null, raw name in the name slot). */
function jsxIdent(state: ParserState, start: number, end: number): Node {
    return {
        id: nextId(state),
        type: N.JSXIdentifier,
        start,
        end,
        name: sliceFlat(state, start, end),
        sym: 0,
        data: null,
    } as Node;
}

function parseJSXName(state: ParserState): Node {
    const src = state.src,
        srcLen = state.srcLen;
    skipJSXTagWs(state);
    if (!isJSXIdentStart(src.charCodeAt(state.pos))) {
        raise(state, ParseErrorCode.ExpectedJSXName);
        return makeMissingIdent(state, R_NAME) as Node;
    }
    const [s0, e0] = scanJSXName(state);
    const first = src.charCodeAt(s0);
    if (state.pos < srcLen && src.charCodeAt(state.pos) === 58) {
        state.pos++;
        const [s1, e1] = isJSXIdentStart(src.charCodeAt(state.pos)) ? scanJSXName(state) : [state.pos, state.pos];
        return m.JSXNamespacedName(s0, e1, 0, jsxIdent(state, s0, e0), jsxIdent(state, s1, e1)) as Node;
    }
    if (state.pos < srcLen && src.charCodeAt(state.pos) === 46) {
        const isThis = e0 - s0 === 4 && src.startsWith('this', s0);
        let obj: Node = isThis ? (m.ThisExpression(s0, e0, 0) as Node) : (ident(state, R_REF, s0, e0) as Node);
        while (state.pos < srcLen && src.charCodeAt(state.pos) === 46) {
            state.pos++;
            const [ps, pe] = isJSXIdentStart(src.charCodeAt(state.pos)) ? scanJSXName(state) : [state.pos, state.pos];
            obj = m.JSXMemberExpression(s0, pe, 0, obj, jsxIdent(state, ps, pe)) as Node;
        }
        return obj;
    }
    if (e0 - s0 === 4 && first === 116 && src.startsWith('this', s0)) return m.ThisExpression(s0, e0, 0) as Node;
    if (first >= 65 && first <= 90) return ident(state, R_REF, s0, e0) as Node;
    return jsxIdent(state, s0, e0);
}

/** Parse a JSX attribute name: JSXIdentifier or JSXNamespacedName (`a:b`). Pos-driven. */
function parseJSXAttributeName(state: ParserState): Node {
    const src = state.src,
        srcLen = state.srcLen;
    const [s0, e0] = scanJSXName(state);
    if (state.pos < srcLen && src.charCodeAt(state.pos) === 58) {
        state.pos++;
        const [s1, e1] = isJSXIdentStart(src.charCodeAt(state.pos)) ? scanJSXName(state) : [state.pos, state.pos];
        return m.JSXNamespacedName(s0, e1, 0, jsxIdent(state, s0, e0), jsxIdent(state, s1, e1)) as Node;
    }
    return jsxIdent(state, s0, e0);
}

function parseJSXBrace(state: ParserState, inChildren: boolean): Node {
    const bracePos = state.pos;
    state.pos = bracePos + 1;
    nextToken(state);
    let node: Node;
    if (isP(state, P.DOTDOTDOT)) {
        nextToken(state);
        const arg = parseAssign(state);
        node = inChildren
            ? (m.JSXSpreadChild(bracePos, state.tokEnd, 0, arg) as Node)
            : (m.JSXExpressionContainer(bracePos, state.tokEnd, 0, arg) as Node);
    } else if (isP(state, P.RBRACE)) {
        node = m.JSXExpressionContainer(
            bracePos,
            state.tokEnd,
            0,
            m.JSXEmptyExpression(bracePos + 1, state.tokStart, 0) as Node,
        ) as Node;
    } else {
        const expr = parseExpression(state);
        node = m.JSXExpressionContainer(bracePos, state.tokEnd, 0, expr) as Node;
    }
    if (isP(state, P.RBRACE)) {
        state.pos = state.tokEnd;
    } else {
        raise(state, ParseErrorCode.ExpectedInJSX, "'}'");
        state.pos = state.tokStart;
    }
    return node;
}

function parseJSXSpreadAttribute(state: ParserState): Node {
    const bracePos = state.pos;
    state.pos = bracePos + 1;
    nextToken(state);
    if (!eatP(state, P.DOTDOTDOT)) raise(state, ParseErrorCode.ExpectedJSXSpread);
    const arg = parseAssign(state);
    const node = m.JSXSpreadAttribute(bracePos, state.tokEnd, 0, arg) as Node;
    if (isP(state, P.RBRACE)) {
        state.pos = state.tokEnd;
    } else {
        raise(state, ParseErrorCode.ExpectedInJSX, "'}'");
        state.pos = state.tokStart;
    }
    return node;
}

/** Parse opening-tag attributes. Pos-driven; `pos` sits just past the name.
 * Leaves `pos` on `>` or `/`. */
function parseJSXAttributes(state: ParserState): Node[] {
    const src = state.src,
        srcLen = state.srcLen;
    const from = state.sp;
    for (;;) {
        skipJSXTagWs(state);
        const c = state.pos < srcLen ? src.charCodeAt(state.pos) : 0;
        if (c === 62 || c === 47 || c === 0) break;
        if (c === 123) {
            push(state, parseJSXSpreadAttribute(state));
            continue;
        }
        if (!isJSXIdentStart(c)) {
            raise(state, ParseErrorCode.UnexpectedCharInJSXAttrs);
            state.pos++;
            continue;
        }
        const name = parseJSXAttributeName(state);
        const nameEnd = state.pos;
        skipJSXTagWs(state);
        let value: Ref = null;
        let end = nameEnd;
        if (state.pos < srcLen && src.charCodeAt(state.pos) === 61) {
            state.pos++;
            skipJSXTagWs(state);
            const vc = state.pos < srcLen ? src.charCodeAt(state.pos) : 0;
            if (vc === 34 || vc === 39) {
                const vs = state.pos;
                state.pos++;
                while (state.pos < srcLen && src.charCodeAt(state.pos) !== vc) {
                    if (src.charCodeAt(state.pos) === 10) recordNL(state, state.pos);
                    state.pos++;
                }
                state.pos++;
                value = leafRaw(state, N.StringLiteral, vs, state.pos);
                end = state.pos;
            } else if (vc === 123) {
                value = parseJSXBrace(state, false);
                end = state.pos;
            } else if (vc === 60) {
                value = parseJSXNested(state);
                end = state.pos;
            } else {
                raise(state, ParseErrorCode.ExpectedJSXAttrValue);
            }
        }
        push(state, m.JSXAttribute(name.start, end, 0, name, value) as Node);
    }
    return finishList(state, from);
}

/** Parse JSX children (pos-driven). On entry `pos` sits just after the opening
 * `>`; leaves `pos` on the closing-tag `<`. */
function parseJSXChildren(state: ParserState): Node[] {
    const src = state.src,
        srcLen = state.srcLen;
    const from = state.sp;
    for (;;) {
        const textStart = state.pos;
        while (state.pos < srcLen) {
            const c = src.charCodeAt(state.pos);
            if (c === 60 || c === 123) break;
            if (c === 10) recordNL(state, state.pos);
            state.pos++;
        }
        if (state.pos > textStart)
            push(state, {
                id: nextId(state),
                type: N.JSXText,
                start: textStart,
                end: state.pos,
                name: sliceFlat(state, textStart, state.pos),
                sym: 0,
                data: null,
            } as Node);
        if (state.pos >= srcLen) {
            raise(state, ParseErrorCode.UnterminatedJSXElement);
            break;
        }
        const c = src.charCodeAt(state.pos);
        if (c === 123) {
            push(state, parseJSXBrace(state, true));
            continue;
        }
        if (src.charCodeAt(state.pos + 1) === 47) break;
        push(state, parseJSXNested(state));
    }
    return from === state.sp ? [] : finishList(state, from);
}

/** Parse a nested JSX element/fragment in child or attribute-value position. `pos`
 * sits on `<`. Pure raw scan (no lexer sync — the outermost parseJSXRoot resyncs). */
function parseJSXNested(state: ParserState): Node {
    const src = state.src,
        srcLen = state.srcLen;
    const start = state.pos;
    state.pos++;
    skipJSXTagWs(state);
    if (state.pos < srcLen && src.charCodeAt(state.pos) === 62) {
        const openFrag = m.JSXOpeningFragment(start, state.pos + 1, 0) as Node;
        state.pos++;
        const children = parseJSXChildren(state);
        const closeStart = state.pos;
        state.pos += 2;
        skipJSXTagWs(state);
        expectRawChar(state, 62, "'>'");
        const closeFrag = m.JSXClosingFragment(closeStart, state.pos, 0) as Node;
        return m.JSXFragment(start, state.pos, 0, openFrag, children, closeFrag) as Node;
    }
    const name = parseJSXName(state);
    let typeArgs: Ref = null;
    if (state.tsMode && state.pos < srcLen && src.charCodeAt(state.pos) === 60) {
        nextToken(state);
        const ta = tryParseTypeArgsInType(state);
        if (ta !== null) {
            typeArgs = ta;
            state.pos = state.tokStart;
        } else state.pos = state.tokStart;
    }
    const attrs = parseJSXAttributes(state);
    skipJSXTagWs(state);
    if (state.pos < srcLen && src.charCodeAt(state.pos) === 47) {
        state.pos++;
        skipJSXTagWs(state);
        expectRawChar(state, 62, "'>'");
        const open = m.JSXOpeningElement(start, state.pos, 0, name, typeArgs, attrs) as Node;
        return m.JSXElement(start, state.pos, 0, open, [], null) as Node;
    }
    expectRawChar(state, 62, "'>'");
    const open = m.JSXOpeningElement(start, state.pos, 0, name, typeArgs, attrs) as Node;
    const children = parseJSXChildren(state);
    const closeStart = state.pos;
    state.pos += 2;
    const closeName = parseJSXName(state);
    skipJSXTagWs(state);
    expectRawChar(state, 62, "'>'");
    const close = m.JSXClosingElement(closeStart, state.pos, 0, closeName) as Node;
    return m.JSXElement(start, state.pos, 0, open, children, close) as Node;
}

function parseJSXRoot(state: ParserState): Node {
    state.pos = state.tokStart;
    const node = parseJSXNested(state);
    nextToken(state);
    return node;
}

/** Consume the exact raw char `ch` at `pos` (advancing past it); error otherwise. */
function expectRawChar(state: ParserState, ch: number, what: string): void {
    if (state.pos < state.srcLen && state.src.charCodeAt(state.pos) === ch) {
        state.pos++;
        return;
    }
    raise(state, ParseErrorCode.ExpectedInJSX, what);
}

function parsePrimary(state: ParserState): Node {
    const start = state.tokStart;
    switch (state.tok as number) {
        case T_NUM: {
            const n = leaf(state, N.NumericLiteral, start, state.tokEnd);
            nextToken(state);
            return n;
        }
        case T_BIGINT: {
            const n = leaf(state, N.BigIntLiteral, start, state.tokEnd);
            nextToken(state);
            return n;
        }
        case T_STR: {
            const n = leaf(state, N.StringLiteral, start, state.tokEnd);
            nextToken(state);
            return n;
        }
        case T_REGEX: {
            const n = leaf(state, N.RegExpLiteral, start, state.tokEnd);
            nextToken(state);
            return n;
        }
        case T_TEMPLATE_FULL:
        case T_TEMPLATE_HEAD:
            return parseTemplate(state);
        case T_PRIVATE:
            return parsePrivate(state);
        case T_IDENT:
            return parseIdent(state, R_REF);
    }
    if (isPunct(state.tok)) {
        switch (state.tok as number) {
            case P.LT:
                if (state.jsxMode) return parseJSXRoot(state);
                break;
            case P.SLASH:
            case P.SLASHEQ:
                reScanRegex(state);
                return parsePrimary(state);
            case P.LPAREN: {
                nextToken(state);
                const e = parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                return e;
            }
            case P.LBRACKET: {
                nextToken(state);
                const from = state.sp;
                while (!isP(state, P.RBRACKET) && (state.tok as number) !== T_EOF) {
                    if (isP(state, P.COMMA)) {
                        push(state, null);
                        nextToken(state);
                        continue;
                    }
                    if (isP(state, P.DOTDOTDOT)) {
                        const s = state.tokStart;
                        nextToken(state);
                        const arg = parseAssign(state);
                        push(state, m.SpreadElement(s, arg.end, 0, arg) as Node);
                    } else push(state, parseAssign(state));
                    if (!isP(state, P.RBRACKET)) expectP(state, P.COMMA, "','");
                }
                expectP(state, P.RBRACKET, "']'");
                return m.ArrayExpression(start, state.tokStart, 0, finishListWithHoles(state, from)) as Node;
            }
            case P.LBRACE:
                return parseObjectLiteral(state);
        }
    } else if (isKeyword(state.tok)) {
        switch (state.tok as number) {
            case K.THIS:
                nextToken(state);
                return m.ThisExpression(start, state.tokStart, 0) as Node;
            case K.SUPER:
                nextToken(state);
                return m.Super(start, state.tokStart, 0) as Node;
            case K.TRUE:
                nextToken(state);
                return m.BooleanLiteral(start, state.tokStart, 1) as Node;
            case K.FALSE:
                nextToken(state);
                return m.BooleanLiteral(start, state.tokStart, 0) as Node;
            case K.NULL:
                nextToken(state);
                return m.NullLiteral(start, state.tokStart, 0) as Node;
            case K.FUNCTION:
                return parseFunction(state, false, false, true);
            case K.ASYNC:
                nextToken(state);
                if (isK(state, K.FUNCTION)) return parseFunction(state, true, false, true);
                return ident(state, R_REF, start, start + 5);
            case K.CLASS:
                return parseClass(state, true, 0);
            case K.IMPORT: {
                nextToken(state);
                if (isP(state, P.DOT)) {
                    nextToken(state);
                    parseNameAsIdent(state, R_NAME);
                    return m.ImportMeta(start, state.tokStart, 0) as Node;
                }
                expectP(state, P.LPAREN, "'('");
                const source = parseAssign(state);
                let options: Ref = null;
                if (eatP(state, P.COMMA) && !isP(state, P.RPAREN)) options = parseAssign(state);
                eatP(state, P.COMMA);
                expectP(state, P.RPAREN, "')'");
                return m.ImportExpression(start, state.tokStart, 0, source, options) as Node;
            }
            case K.NEW:
                return parseNew(state);
        }
        if (isContextual(state.tok)) return parseIdent(state, R_REF);
    }
    raise(state, ParseErrorCode.UnexpectedInExpression, tokenDesc(state));
    nextToken(state);
    return makeMissingIdent(state, R_REF);
}

function parseObjectLiteral(state: ParserState): Node {
    const start = state.tokStart;
    nextToken(state);
    const from = state.sp;
    let last = -1;
    while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
        if (state.tokStart === last) {
            raise(state, ParseErrorCode.UnexpectedInObjectLiteral, tokenDesc(state));
            nextToken(state);
            continue;
        }
        last = state.tokStart;
        if (isP(state, P.DOTDOTDOT)) {
            const s = state.tokStart;
            nextToken(state);
            const arg = parseAssign(state);
            push(state, m.SpreadElement(s, arg.end, 0, arg) as Node);
        } else push(state, parseObjectMember(state));
        if (!isP(state, P.RBRACE)) expectP(state, P.COMMA, "','");
    }
    expectP(state, P.RBRACE, "'}'");
    return m.ObjectExpression(start, state.tokStart, 0, finishList(state, from)) as Node;
}

function parseObjectMember(state: ParserState): Node {
    const start = state.tokStart;
    let flags = 0;
    let async = false;
    let generator = false;
    if (isK(state, K.ASYNC) && !nextIsPropertyEnd(state)) {
        async = true;
        nextToken(state);
    }
    if (isP(state, P.STAR)) {
        generator = true;
        nextToken(state);
    }
    let kind = 0;
    if ((isK(state, K.GET) || isK(state, K.SET)) && !nextIsPropertyEnd(state)) {
        kind = isK(state, K.GET) ? 1 : 2;
        nextToken(state);
    }
    let key: Node;
    if (isP(state, P.LBRACKET)) {
        flags |= FL.COMPUTED;
        nextToken(state);
        key = parseAssign(state);
        expectP(state, P.RBRACKET, "']'");
    } else if ((state.tok as number) === T_STR) {
        key = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    } else if (state.tok === T_NUM) {
        key = leaf(state, N.NumericLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    } else key = parseNameAsIdent(state, R_NAME);

    if (kind !== 0 || async || generator || isP(state, P.LPAREN)) {
        const fn = parseMethodTail(state, start, (async ? FL.ASYNC : 0) | (generator ? FL.GENERATOR : 0));
        flags |= kind << FL.KIND_SHIFT;
        return m.ObjectProperty(start, fn.end, flags, key, fn) as Node;
    }
    if (isP(state, P.COLON)) {
        nextToken(state);
        const value = parseAssign(state);
        return m.ObjectProperty(start, value.end, flags, key, value) as Node;
    }
    const shorthandRef = ident(state, R_REF, key.start, key.end);
    if (isP(state, P.EQ)) {
        nextToken(state);
        const right = parseAssign(state);
        const value = m.AssignmentPattern(key.start, right.end, 0, shorthandRef, right) as Node;
        return m.ObjectProperty(start, right.end, flags | FL.SHORTHAND, key, value) as Node;
    }
    return m.ObjectProperty(start, key.end, flags | FL.SHORTHAND, key, shorthandRef) as Node;
}

function nextIsPropertyEnd(state: ParserState): boolean {
    const s = saveState(state);
    nextToken(state);
    const endLike =
        state.tok === T_EOF ||
        (isPunct(state.tok) &&
            (state.tok === P.COLON ||
                state.tok === P.COMMA ||
                state.tok === P.RBRACE ||
                state.tok === P.LPAREN ||
                state.tok === P.EQ ||
                state.tok === P.QUESTION ||
                state.tok === P.SEMI ||
                state.tok === P.RPAREN ||
                state.tok === P.LT ||
                state.tok === P.BANG ||
                state.tok === P.RBRACKET));
    restoreState(state, s);
    return endLike;
}

function parseMethodTail(state: ParserState, start: number, flags: number): Node {
    let typeParams: Ref = null;
    if (state.tsMode && isP(state, P.LT)) {
        const t = tryParseTypeParams(state);
        if (t !== null) typeParams = t;
    }
    const params = parseParams(state);
    let returnType: Ref = null;
    if (state.tsMode && isP(state, P.COLON)) returnType = parseTypeAnn(state);
    let body: Ref = null;
    if (isP(state, P.LBRACE)) body = parseBlock(state);
    else consumeSemi(state);
    return m.FunctionExpression(start, state.tokStart, flags, null, typeParams, params, returnType, body) as Node;
}

function arrowAheadFromParen(state: ParserState): boolean {
    const src = state.src,
        srcLen = state.srcLen;
    let p = state.tokStart + 1;
    let depth = 1;
    while (p < srcLen && depth > 0) {
        const c = src.charCodeAt(p);
        if (c === 40 || c === 91 || c === 123) (depth += c === 40 ? 1 : 0), (depth += c === 91 || c === 123 ? 1 : 0);
        else if (c === 41 || c === 93 || c === 125) depth--;
        else if (c === 34 || c === 39 || c === 96) {
            const q = c;
            p++;
            while (p < srcLen) {
                const cc = src.charCodeAt(p);
                if (cc === 92) {
                    p += 2;
                    continue;
                }
                if (cc === q) break;
                p++;
            }
        } else if (c === 47) {
            const c1 = src.charCodeAt(p + 1);
            if (c1 === 47) {
                while (p < srcLen && src.charCodeAt(p) !== 10) p++;
                continue;
            }
            if (c1 === 42) {
                p += 2;
                while (p < srcLen && !(src.charCodeAt(p) === 42 && src.charCodeAt(p + 1) === 47)) p++;
                p += 2;
                continue;
            }
        }
        p++;
    }
    for (;;) {
        while (p < srcLen) {
            const c = src.charCodeAt(p);
            if (c < 128 && (CHAR[c] === C_WS || CHAR[c] === C_NL)) p++;
            else break;
        }
        if (src.charCodeAt(p) === 47 && src.charCodeAt(p + 1) === 47) {
            while (p < srcLen && src.charCodeAt(p) !== 10) p++;
            continue;
        }
        if (src.charCodeAt(p) === 47 && src.charCodeAt(p + 1) === 42) {
            p += 2;
            while (p < srcLen && !(src.charCodeAt(p) === 42 && src.charCodeAt(p + 1) === 47)) p++;
            p += 2;
            continue;
        }
        break;
    }
    if (src.charCodeAt(p) === 61 && src.charCodeAt(p + 1) === 62) return true;
    if (state.tsMode && src.charCodeAt(p) === 58) {
        const s = saveState(state);
        const ok = trySpeculativeArrow(state);
        restoreState(state, s);
        return ok;
    }
    return false;
}

function trySpeculativeArrow(state: ParserState): boolean {
    try {
        state.speculating++;
        parseParams(state);
        if (isP(state, P.COLON)) parseTypeAnn(state);
        const ok = isP(state, P.ARROW);
        state.speculating--;
        return ok;
    } catch {
        state.speculating--;
        return false;
    }
}

function parseArrow(state: ParserState, start: number, flags: number, typeParams: Ref): Node {
    const params = parseParams(state);
    let returnType: Ref = null;
    if (state.tsMode && isP(state, P.COLON)) returnType = parseTypeAnn(state);
    expectP(state, P.ARROW, "'=>'");
    let body: Node;
    if (isP(state, P.LBRACE)) body = parseBlock(state);
    else {
        body = parseAssign(state);
        flags |= FL.EXPR_BODY;
    }
    return m.ArrowFunctionExpression(start, body.end, flags, typeParams, params, returnType, body) as Node;
}

function parseArrowAfterSingleParam(state: ParserState, start: number, id: Identifier, flags: number, identStart?: number): Node {
    const param = m.FormalParameter(identStart ?? start, id.end, 0, id, null, null) as Node;
    expectP(state, P.ARROW, "'=>'");
    let body: Node;
    if (isP(state, P.LBRACE)) body = parseBlock(state);
    else {
        body = parseAssign(state);
        flags |= FL.EXPR_BODY;
    }
    return m.ArrowFunctionExpression(start, body.end, flags, null, [param], null, body) as Node;
}

function parseBindingTarget(state: ParserState): Node {
    if (isP(state, P.LBRACKET)) {
        const start = state.tokStart;
        nextToken(state);
        const from = state.sp;
        while (!isP(state, P.RBRACKET) && (state.tok as number) !== T_EOF) {
            if (isP(state, P.COMMA)) {
                push(state, null);
                nextToken(state);
                continue;
            }
            if (isP(state, P.DOTDOTDOT)) {
                const s = state.tokStart;
                nextToken(state);
                const arg = parseBindingTarget(state);
                push(state, m.RestElement(s, arg.end, 0, arg, null) as Node);
            } else push(state, parseBindingElement(state));
            if (!isP(state, P.RBRACKET)) expectP(state, P.COMMA, "','");
        }
        expectP(state, P.RBRACKET, "']'");
        return m.ArrayPattern(start, state.tokStart, 0, finishListWithHoles(state, from)) as Node;
    }
    if (isP(state, P.LBRACE)) {
        const start = state.tokStart;
        nextToken(state);
        const from = state.sp;
        while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
            if (isP(state, P.DOTDOTDOT)) {
                const s = state.tokStart;
                nextToken(state);
                const arg = parseBindingTarget(state);
                push(state, m.RestElement(s, arg.end, 0, arg, null) as Node);
            } else {
                const s = state.tokStart;
                let flags = 0;
                let key: Node;
                if (isP(state, P.LBRACKET)) {
                    flags |= FL.COMPUTED;
                    nextToken(state);
                    key = parseAssign(state);
                    expectP(state, P.RBRACKET, "']'");
                } else if ((state.tok as number) === T_STR) {
                    key = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
                    nextToken(state);
                } else if (state.tok === T_NUM) {
                    key = leaf(state, N.NumericLiteral, state.tokStart, state.tokEnd);
                    nextToken(state);
                } else key = parseNameAsIdent(state, R_NAME);
                let value: Node;
                if (isP(state, P.COLON)) {
                    nextToken(state);
                    value = parseBindingElement(state);
                } else if (isP(state, P.EQ)) {
                    nextToken(state);
                    const right = parseAssign(state);
                    value = m.AssignmentPattern(key.start, right.end, 0, ident(state, R_BIND, key.start, key.end), right) as Node;
                    flags |= FL.SHORTHAND;
                } else {
                    value = ident(state, R_BIND, key.start, key.end);
                    flags |= FL.SHORTHAND;
                }
                push(state, m.ObjectProperty(s, value.end, flags, key, value) as Node);
            }
            if (!isP(state, P.RBRACE)) expectP(state, P.COMMA, "','");
        }
        expectP(state, P.RBRACE, "'}'");
        return m.ObjectPattern(start, state.tokStart, 0, finishList(state, from)) as Node;
    }
    return parseIdent(state, R_BIND);
}

function parseBindingElement(state: ParserState): Node {
    const target = parseBindingTarget(state);
    if (isP(state, P.EQ)) {
        nextToken(state);
        const right = parseAssign(state);
        return m.AssignmentPattern(target.start, right.end, 0, target, right) as Node;
    }
    return target;
}

function parseParams(state: ParserState): Node[] {
    const src = state.src;
    expectP(state, P.LPAREN, "'('");
    const from = state.sp;
    while (!isP(state, P.RPAREN) && (state.tok as number) !== T_EOF) {
        const start = state.tokStart;
        let flags = 0;
        if (state.tsMode) {
            for (;;) {
                if ((isK(state, K.READONLY) || isK(state, K.OVERRIDE)) && !nextIsParamNameEnd(state)) {
                    flags |= FL.READONLY;
                    nextToken(state);
                } else if (isK(state, K.STATIC) && !nextIsParamNameEnd(state)) nextToken(state);
                else if (
                    isKeyword(state.tok) &&
                    (state.tok === K.IMPLEMENTS || state.tok === K.INTERFACE) &&
                    !nextIsParamNameEnd(state)
                )
                    nextToken(state);
                else if (
                    state.tok === T_IDENT &&
                    (src.startsWith('public', state.tokStart) ||
                        src.startsWith('private', state.tokStart) ||
                        src.startsWith('protected', state.tokStart)) &&
                    state.tokEnd - state.tokStart <= 9 &&
                    !nextIsParamNameEnd(state)
                ) {
                    const access = src.startsWith('public', state.tokStart)
                        ? 1
                        : src.startsWith('private', state.tokStart)
                          ? 2
                          : 3;
                    flags |= access << FL.ACCESS_SHIFT;
                    nextToken(state);
                } else break;
            }
        }
        if (isP(state, P.DOTDOTDOT)) {
            nextToken(state);
            const arg = parseBindingTarget(state);
            let typeAnn: Ref = null;
            if (state.tsMode && isP(state, P.COLON)) typeAnn = parseTypeAnn(state);
            push(state, m.RestElement(start, state.tokStart, 0, arg, typeAnn) as Node);
        } else if (isK(state, K.THIS) && state.tsMode) {
            const t = ident(state, R_BIND, state.tokStart, state.tokEnd);
            nextToken(state);
            let typeAnn: Ref = null;
            if (isP(state, P.COLON)) typeAnn = parseTypeAnn(state);
            push(state, m.FormalParameter(start, state.tokStart, 0, t, typeAnn, null) as Node);
        } else {
            const pattern = parseBindingTarget(state);
            if (state.tsMode && isP(state, P.QUESTION)) {
                flags |= FL.OPTIONAL;
                nextToken(state);
            }
            let typeAnn: Ref = null;
            if (state.tsMode && isP(state, P.COLON)) typeAnn = parseTypeAnn(state);
            let init: Ref = null;
            if (isP(state, P.EQ)) {
                nextToken(state);
                init = parseAssign(state);
            }
            push(state, m.FormalParameter(start, state.tokStart, flags, pattern, typeAnn, init) as Node);
        }
        if (!eatP(state, P.COMMA)) break;
    }
    expectP(state, P.RPAREN, "')'");
    return finishList(state, from);
}

function nextIsParamNameEnd(state: ParserState): boolean {
    const s = saveState(state);
    nextToken(state);
    const end =
        state.tok === T_EOF ||
        (isPunct(state.tok) &&
            (state.tok === P.COLON ||
                state.tok === P.COMMA ||
                state.tok === P.RPAREN ||
                state.tok === P.QUESTION ||
                state.tok === P.EQ));
    restoreState(state, s);
    return end;
}

function parseFunction(state: ParserState, async: boolean, isDecl: boolean, isExpr: boolean): Node {
    const start = state.tokStart;
    nextToken(state);
    let flags = async ? FL.ASYNC : 0;
    if (isP(state, P.STAR)) {
        flags |= FL.GENERATOR;
        nextToken(state);
    }
    let id: Ref = null;
    if (isIdentLike(state)) id = parseIdent(state, R_BIND);
    let typeParams: Ref = null;
    if (state.tsMode && isP(state, P.LT)) {
        const t = tryParseTypeParams(state);
        if (t !== null) typeParams = t;
    }
    const params = parseParams(state);
    let returnType: Ref = null;
    if (state.tsMode && isP(state, P.COLON)) returnType = parseTypeAnn(state);
    let body: Ref = null;
    if (isP(state, P.LBRACE)) body = parseBlock(state);
    else consumeSemi(state);
    return isDecl && !isExpr
        ? (m.FunctionDeclaration(start, state.tokStart, flags, id, typeParams, params, returnType, body) as Node)
        : (m.FunctionExpression(start, state.tokStart, flags, id, typeParams, params, returnType, body) as Node);
}

function parseClass(state: ParserState, isExpr: boolean, extraFlags: number, startOverride = -1): Node {
    const start = startOverride >= 0 ? startOverride : state.tokStart;
    nextToken(state);
    let id: Ref = null;
    if (isIdentLike(state) && !isK(state, K.EXTENDS) && !isK(state, K.IMPLEMENTS)) id = parseIdent(state, R_BIND);
    let typeParams: Ref = null;
    if (state.tsMode && isP(state, P.LT)) {
        const t = tryParseTypeParams(state);
        if (t !== null) typeParams = t;
    }
    let superClass: Ref = null;
    let superTypeArgs: Ref = null;
    if (eatK(state, K.EXTENDS)) {
        superClass = parseMemberChain(state, parsePrimary(state), true);
        if (state.tsMode && isP(state, P.LT)) {
            const t = tryParseTypeArgsInType(state);
            if (t !== null) superTypeArgs = t;
        }
    }
    const implFrom = state.sp;
    if (state.tsMode && eatK(state, K.IMPLEMENTS)) {
        do {
            const s = state.tokStart;
            let expr: Node = parseIdent(state, R_REF);
            while (isP(state, P.DOT)) {
                nextToken(state);
                const r = parseNameAsIdent(state, R_NAME);
                expr = m.TSQualifiedName(s, r.end, 0, expr, r) as Node;
            }
            let targs: Ref = null;
            if (isP(state, P.LT)) {
                const t = tryParseTypeArgsInType(state);
                if (t !== null) targs = t;
            }
            push(state, m.TSClassImplements(s, state.tokStart, 0, expr, targs) as Node);
        } while (eatP(state, P.COMMA));
    }
    const impls = finishList(state, implFrom);
    const body = parseClassBody(state);
    return isExpr
        ? (m.ClassExpression(start, state.tokStart, extraFlags, id, typeParams, superClass, superTypeArgs, impls, body) as Node)
        : (m.ClassDeclaration(start, state.tokStart, extraFlags, id, typeParams, superClass, superTypeArgs, impls, body) as Node);
}

function parseClassBody(state: ParserState): Node[] {
    expectP(state, P.LBRACE, "'{'");
    const from = state.sp;
    let last = -1;
    while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
        if (eatP(state, P.SEMI)) continue;
        if (state.tokStart === last) {
            raise(state, ParseErrorCode.UnexpectedInClassBody, tokenDesc(state));
            nextToken(state);
            continue;
        }
        last = state.tokStart;
        push(state, parseClassMember(state));
    }
    expectP(state, P.RBRACE, "'}'");
    return finishList(state, from);
}

function parseClassMember(state: ParserState): Node {
    const src = state.src;
    const start = state.tokStart;
    let flags = 0;
    let async = false;
    let generator = false;
    for (;;) {
        if (isK(state, K.STATIC) && !nextIsPropertyEnd(state)) {
            const s = saveState(state);
            nextToken(state);
            if (isP(state, P.LBRACE)) {
                const b = parseBlock(state);
                const body = (b as Extract<Node, { type: typeof N.BlockStatement }>).data.body;
                return m.StaticBlock(start, state.tokStart, 0, body) as Node;
            }
            restoreState(state, s);
            flags |= FL.STATIC;
            nextToken(state);
        } else if (state.tok === T_IDENT && !nextIsPropertyEnd(state) && isAccessModifier(state)) {
            const access = src.startsWith('public', state.tokStart) ? 1 : src.startsWith('private', state.tokStart) ? 2 : 3;
            flags |= access << FL.ACCESS_SHIFT;
            nextToken(state);
        } else if (isK(state, K.READONLY) && !nextIsPropertyEnd(state)) {
            flags |= FL.READONLY;
            nextToken(state);
        } else if (isK(state, K.ABSTRACT) && !nextIsPropertyEnd(state)) {
            flags |= FL.ABSTRACT;
            nextToken(state);
        } else if (isK(state, K.DECLARE) && !nextIsPropertyEnd(state)) {
            flags |= FL.DECLARE;
            nextToken(state);
        } else if (isK(state, K.OVERRIDE) && !nextIsPropertyEnd(state)) nextToken(state);
        else if (isK(state, K.ACCESSOR) && !nextIsPropertyEnd(state)) nextToken(state);
        else break;
    }
    if (isK(state, K.ASYNC) && !nextIsPropertyEnd(state)) {
        async = true;
        nextToken(state);
    }
    if (isP(state, P.STAR)) {
        generator = true;
        nextToken(state);
    }
    let kind = 0;
    if ((isK(state, K.GET) || isK(state, K.SET)) && !nextIsPropertyEnd(state)) {
        kind = isK(state, K.GET) ? 1 : 2;
        nextToken(state);
    }
    let key: Node;
    if (isP(state, P.LBRACKET)) {
        nextToken(state);
        if (state.tsMode && isIdentLike(state)) {
            const s = saveState(state);
            const name = parseIdent(state, R_BIND);
            if (isP(state, P.COLON)) {
                const keyAnn = parseTypeAnn(state);
                const param = m.FormalParameter(name.start, state.tokStart, 0, name, keyAnn, null) as Node;
                expectP(state, P.RBRACKET, "']'");
                let ann: Ref = null;
                if (isP(state, P.COLON)) ann = parseTypeAnn(state);
                consumeSemi(state);
                return m.TSIndexSignature(start, state.tokStart, flags & FL.READONLY, param, ann) as Node;
            }
            restoreState(state, s);
        }
        flags |= FL.COMPUTED;
        key = parseAssign(state);
        expectP(state, P.RBRACKET, "']'");
    } else if ((state.tok as number) === T_STR) {
        key = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    } else if (state.tok === T_NUM) {
        key = leaf(state, N.NumericLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    } else if (state.tok === T_PRIVATE) key = parsePrivate(state);
    else key = parseNameAsIdent(state, R_NAME);

    if (kind === 0 && key.type === N.IdentifierName && src.startsWith('constructor', key.start) && key.end - key.start === 11)
        kind = 3;

    if (state.tsMode && isP(state, P.QUESTION)) {
        flags |= FL.OPTIONAL;
        nextToken(state);
    }

    if (kind !== 0 || async || generator || isP(state, P.LPAREN) || (state.tsMode && isP(state, P.LT))) {
        const fn = parseMethodTail(state, start, (async ? FL.ASYNC : 0) | (generator ? FL.GENERATOR : 0));
        return m.MethodDefinition(start, state.tokStart, flags | (kind << FL.KIND_SHIFT), key, fn) as Node;
    }
    if (state.tsMode && isP(state, P.BANG)) {
        flags |= FL.DEFINITE;
        nextToken(state);
    }
    let typeAnn: Ref = null;
    if (state.tsMode && isP(state, P.COLON)) typeAnn = parseTypeAnn(state);
    let value: Ref = null;
    if (isP(state, P.EQ)) {
        nextToken(state);
        value = parseAssign(state);
    }
    consumeSemi(state);
    return m.PropertyDefinition(start, state.tokStart, flags, key, typeAnn, value) as Node;
}

function isAccessModifier(state: ParserState): boolean {
    const src = state.src;
    const len = state.tokEnd - state.tokStart;
    return (
        (len === 6 && src.startsWith('public', state.tokStart)) ||
        (len === 7 && src.startsWith('private', state.tokStart)) ||
        (len === 9 && src.startsWith('protected', state.tokStart))
    );
}

function parseBlock(state: ParserState): Node {
    const start = state.tokStart;
    expectP(state, P.LBRACE, "'{'");
    const from = state.sp;
    while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) push(state, parseStatement(state));
    expectP(state, P.RBRACE, "'}'");
    return m.BlockStatement(start, state.tokStart, 0, finishList(state, from)) as Node;
}

function parseStatement(state: ParserState): Node {
    const start = state.tokStart;
    if (isPunct(state.tok)) {
        switch (state.tok as number) {
            case P.LBRACE:
                return parseBlock(state);
            case P.SEMI:
                nextToken(state);
                return m.EmptyStatement(start, state.tokStart, 0) as Node;
            case P.AT:
                raise(state, ParseErrorCode.DecoratorsUnsupported);
                nextToken(state);
                return parseStatement(state);
        }
    }
    if (isKeyword(state.tok)) {
        switch (state.tok as number) {
            case K.VAR:
                return parseVarDecl(state, VAR_KIND.VAR, 0);
            case K.CONST: {
                const s = saveState(state);
                nextToken(state);
                if (state.tsMode && isK(state, K.ENUM)) return parseEnum(state, start, FL.CONST_ENUM);
                restoreState(state, s);
                return parseVarDecl(state, VAR_KIND.CONST, 0);
            }
            case K.LET: {
                const s = saveState(state);
                nextToken(state);
                if (isIdentLike(state) || isP(state, P.LBRACE) || isP(state, P.LBRACKET)) {
                    restoreState(state, s);
                    return parseVarDecl(state, VAR_KIND.LET, 0);
                }
                restoreState(state, s);
                break;
            }
            case K.FUNCTION:
                return parseFunction(state, false, true, false);
            case K.ASYNC: {
                const s = saveState(state);
                nextToken(state);
                if (isK(state, K.FUNCTION) && (state.tokFlags & F_NL) === 0) return parseFunction(state, true, true, false);
                restoreState(state, s);
                break;
            }
            case K.CLASS:
                return parseClass(state, false, 0);
            case K.IF: {
                nextToken(state);
                expectP(state, P.LPAREN, "'('");
                const test = parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                const cons = parseStatement(state);
                let alt: Ref = null;
                if (eatK(state, K.ELSE)) alt = parseStatement(state);
                return m.IfStatement(start, state.tokStart, 0, test, cons, alt) as Node;
            }
            case K.FOR:
                return parseFor(state, start);
            case K.WHILE: {
                nextToken(state);
                expectP(state, P.LPAREN, "'('");
                const test = parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                const body = parseStatement(state);
                return m.WhileStatement(start, body.end, 0, test, body) as Node;
            }
            case K.DO: {
                nextToken(state);
                const body = parseStatement(state);
                if (!eatK(state, K.WHILE)) raise(state, ParseErrorCode.Expected, "'while'");
                expectP(state, P.LPAREN, "'('");
                const test = parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                eatP(state, P.SEMI);
                return m.DoWhileStatement(start, state.tokStart, 0, body, test) as Node;
            }
            case K.SWITCH: {
                nextToken(state);
                expectP(state, P.LPAREN, "'('");
                const disc = parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                expectP(state, P.LBRACE, "'{'");
                const from = state.sp;
                while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
                    const cs = state.tokStart;
                    let test: Ref = null;
                    if (eatK(state, K.CASE)) {
                        test = parseExpression(state);
                    } else if (!eatK(state, K.DEFAULT)) {
                        raise(state, ParseErrorCode.Expected, "'case'");
                        nextToken(state);
                        continue;
                    }
                    expectP(state, P.COLON, "':'");
                    const bodyFrom = state.sp;
                    while (
                        !isP(state, P.RBRACE) &&
                        !isK(state, K.CASE) &&
                        !isK(state, K.DEFAULT) &&
                        (state.tok as number) !== T_EOF
                    )
                        push(state, parseStatement(state));
                    const body = finishList(state, bodyFrom);
                    push(state, m.SwitchCase(cs, state.tokStart, 0, test, body) as Node);
                }
                expectP(state, P.RBRACE, "'}'");
                return m.SwitchStatement(start, state.tokStart, 0, disc, finishList(state, from)) as Node;
            }
            case K.TRY: {
                nextToken(state);
                const block = parseBlock(state);
                let handler: Ref = null;
                let finalizer: Ref = null;
                if (isK(state, K.CATCH)) {
                    const cs = state.tokStart;
                    nextToken(state);
                    let param: Ref = null;
                    if (eatP(state, P.LPAREN)) {
                        param = parseBindingTarget(state);
                        if (state.tsMode && isP(state, P.COLON)) parseTypeAnn(state);
                        expectP(state, P.RPAREN, "')'");
                    }
                    const cbody = parseBlock(state);
                    handler = m.CatchClause(cs, state.tokStart, 0, param, cbody) as Node;
                }
                if (eatK(state, K.FINALLY)) finalizer = parseBlock(state);
                return m.TryStatement(start, state.tokStart, 0, block, handler, finalizer) as Node;
            }
            case K.RETURN: {
                nextToken(state);
                let arg: Ref = null;
                if (!canInsertSemi(state) && !isP(state, P.SEMI)) arg = parseExpression(state);
                consumeSemi(state);
                return m.ReturnStatement(start, state.tokStart, 0, arg) as Node;
            }
            case K.THROW: {
                nextToken(state);
                const arg = parseExpression(state);
                consumeSemi(state);
                return m.ThrowStatement(start, state.tokStart, 0, arg) as Node;
            }
            case K.BREAK:
            case K.CONTINUE: {
                const isBreak = state.tok === K.BREAK;
                nextToken(state);
                let label: Ref = null;
                if (isIdentLike(state) && (state.tokFlags & F_NL) === 0) label = parseIdent(state, R_LABEL);
                consumeSemi(state);
                return isBreak
                    ? (m.BreakStatement(start, state.tokStart, 0, label) as Node)
                    : (m.ContinueStatement(start, state.tokStart, 0, label) as Node);
            }
            case K.DEBUGGER:
                nextToken(state);
                consumeSemi(state);
                return m.DebuggerStatement(start, state.tokStart, 0) as Node;
            case K.IMPORT: {
                const s = saveState(state);
                nextToken(state);
                if (isP(state, P.LPAREN) || isP(state, P.DOT)) {
                    restoreState(state, s);
                    break;
                }
                restoreState(state, s);
                return parseImport(state);
            }
            case K.EXPORT:
                return parseExport(state);
            case K.INTERFACE:
                if (state.tsMode) return parseInterface(state, start, 0);
                break;
            case K.TYPE:
                if (state.tsMode) {
                    const s = saveState(state);
                    nextToken(state);
                    if (isIdentLike(state) && (state.tokFlags & F_NL) === 0) {
                        restoreState(state, s);
                        return parseTypeAlias(state, start, 0);
                    }
                    restoreState(state, s);
                }
                break;
            case K.ENUM:
                if (state.tsMode) return parseEnum(state, start, 0);
                break;
            case K.DECLARE:
                if (state.tsMode) {
                    const s = saveState(state);
                    nextToken(state);
                    if (
                        isKeyword(state.tok) &&
                        (state.tok === K.CONST ||
                            state.tok === K.LET ||
                            state.tok === K.VAR ||
                            state.tok === K.FUNCTION ||
                            state.tok === K.CLASS ||
                            state.tok === K.INTERFACE ||
                            state.tok === K.TYPE ||
                            state.tok === K.ENUM ||
                            state.tok === K.NAMESPACE ||
                            state.tok === K.MODULE ||
                            state.tok === K.ABSTRACT ||
                            state.tok === K.ASYNC)
                    ) {
                        const inner = parseStatement(state);
                        applyDeclare(inner, start);
                        return inner;
                    }
                    // `declare global { ... }` — ambient global augmentation; `global` is a
                    // contextual identifier here. Model it as a declare TSModuleDeclaration so
                    // emit erases the whole block (isErasableStatement).
                    if ((state.tok as number) === T_IDENT && state.src.slice(state.tokStart, state.tokEnd) === 'global') {
                        const gid = parseIdent(state, R_BIND);
                        if (isP(state, P.LBRACE)) {
                            nextToken(state);
                            const from = state.sp;
                            while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) push(state, parseStatement(state));
                            expectP(state, P.RBRACE, "'}'");
                            const mod = m.TSModuleDeclaration(start, state.tokStart, 0, gid, finishList(state, from)) as Node;
                            applyDeclare(mod, start);
                            return mod;
                        }
                    }
                    restoreState(state, s);
                }
                break;
            case K.ABSTRACT:
                if (state.tsMode) {
                    const s = saveState(state);
                    const abstractStart = state.tokStart;
                    nextToken(state);
                    if (isK(state, K.CLASS)) return parseClass(state, false, FL.ABSTRACT, abstractStart);
                    restoreState(state, s);
                }
                break;
            case K.NAMESPACE:
            case K.MODULE:
                if (state.tsMode) {
                    const s = saveState(state);
                    nextToken(state);
                    if (isIdentLike(state) || (state.tok as number) === T_STR) {
                        const id =
                            (state.tok as number) === T_STR
                                ? leaf(state, N.StringLiteral, state.tokStart, state.tokEnd)
                                : parseIdent(state, R_BIND);
                        if ((state.tok as number) === T_STR) nextToken(state);
                        if (isP(state, P.LBRACE)) {
                            nextToken(state);
                            const from = state.sp;
                            while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) push(state, parseStatement(state));
                            expectP(state, P.RBRACE, "'}'");
                            return m.TSModuleDeclaration(
                                start,
                                state.tokStart,
                                FL.NAMESPACE,
                                id,
                                finishList(state, from),
                            ) as Node;
                        }
                    }
                    restoreState(state, s);
                }
                break;
        }
    }
    const expr = parseExpression(state);
    if (expr.type === N.IdentifierReference && isP(state, P.COLON)) {
        nextToken(state);
        const body = parseStatement(state);
        const label = ident(state, R_LABEL, expr.start, expr.end);
        return m.LabeledStatement(start, body.end, 0, label, body) as Node;
    }
    consumeSemi(state);
    return m.ExpressionStatement(start, state.tokStart, 0, expr) as Node;
}

function parseVarDecl(state: ParserState, kind: number, extraFlags: number): Node {
    const start = state.tokStart;
    nextToken(state);
    const from = state.sp;
    do {
        const ds = state.tokStart;
        const target = parseBindingTarget(state);
        let flags = 0;
        if (state.tsMode && isP(state, P.BANG)) {
            flags |= FL.DEFINITE;
            nextToken(state);
        }
        let typeAnn: Ref = null;
        if (state.tsMode && isP(state, P.COLON)) typeAnn = parseTypeAnn(state);
        let init: Ref = null;
        if (isP(state, P.EQ)) {
            nextToken(state);
            init = parseAssign(state);
        }
        push(state, m.VariableDeclarator(ds, state.tokStart, flags, target, typeAnn, init) as Node);
    } while (eatP(state, P.COMMA));
    consumeSemi(state);
    return m.VariableDeclaration(start, state.tokStart, kind | extraFlags, finishList(state, from)) as Node;
}

function parseFor(state: ParserState, start: number): Node {
    nextToken(state);
    let flags = 0;
    if (eatK(state, K.AWAIT)) flags |= FL.AWAIT;
    expectP(state, P.LPAREN, "'('");
    let init: Ref = null;
    if (isP(state, P.SEMI)) nextToken(state);
    else {
        if (isKeyword(state.tok) && (state.tok === K.VAR || state.tok === K.LET || state.tok === K.CONST)) {
            const kind = state.tok === K.VAR ? VAR_KIND.VAR : state.tok === K.LET ? VAR_KIND.LET : VAR_KIND.CONST;
            const ds = state.tokStart;
            nextToken(state);
            const target = parseBindingTarget(state);
            if (isK(state, K.OF) || isK(state, K.IN)) {
                const isOf = isK(state, K.OF);
                nextToken(state);
                const dtor = m.VariableDeclarator(ds, state.tokStart, 0, target, null, null) as Node;
                const decl = m.VariableDeclaration(ds, state.tokStart, kind, [dtor]) as Node;
                const right = isOf ? parseAssign(state) : parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                const body = parseStatement(state);
                return isOf
                    ? (m.ForOfStatement(start, body.end, flags, decl, right, body) as Node)
                    : (m.ForInStatement(start, body.end, 0, decl, right, body) as Node);
            }
            const dFrom = state.sp;
            {
                let typeAnn: Ref = null;
                let dflags = 0;
                if (state.tsMode && isP(state, P.BANG)) {
                    dflags |= FL.DEFINITE;
                    nextToken(state);
                }
                if (state.tsMode && isP(state, P.COLON)) typeAnn = parseTypeAnn(state);
                let dinit: Ref = null;
                if (isP(state, P.EQ)) {
                    nextToken(state);
                    dinit = parseAssign(state, true);
                }
                push(state, m.VariableDeclarator(ds, state.tokStart, dflags, target, typeAnn, dinit) as Node);
            }
            while (eatP(state, P.COMMA)) {
                const ds2 = state.tokStart;
                const t2 = parseBindingTarget(state);
                let typeAnn: Ref = null;
                if (state.tsMode && isP(state, P.COLON)) typeAnn = parseTypeAnn(state);
                let dinit: Ref = null;
                if (isP(state, P.EQ)) {
                    nextToken(state);
                    dinit = parseAssign(state, true);
                }
                push(state, m.VariableDeclarator(ds2, state.tokStart, 0, t2, typeAnn, dinit) as Node);
            }
            init = m.VariableDeclaration(ds, state.tokStart, kind, finishList(state, dFrom)) as Node;
            expectP(state, P.SEMI, "';'");
        } else {
            init = parseExpression(state, true);
            if (isK(state, K.OF) || isK(state, K.IN)) {
                const isOf = state.tok === K.OF;
                nextToken(state);
                const right = isOf ? parseAssign(state) : parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                const body = parseStatement(state);
                return isOf
                    ? (m.ForOfStatement(start, body.end, flags, init, right, body) as Node)
                    : (m.ForInStatement(start, body.end, 0, init, right, body) as Node);
            }
            expectP(state, P.SEMI, "';'");
        }
    }
    let test: Ref = null;
    if (!isP(state, P.SEMI)) test = parseExpression(state);
    expectP(state, P.SEMI, "';'");
    let update: Ref = null;
    if (!isP(state, P.RPAREN)) update = parseExpression(state);
    expectP(state, P.RPAREN, "')'");
    const body = parseStatement(state);
    return m.ForStatement(start, body.end, 0, init, test, update, body) as Node;
}

function parseImport(state: ParserState): Node {
    const start = state.tokStart;
    nextToken(state);
    let flags = 0;
    if (state.tsMode && isK(state, K.TYPE)) {
        const s = saveState(state);
        nextToken(state);
        if (!isK(state, K.FROM) && !isP(state, P.EQ)) flags |= FL.TYPE_ONLY;
        else restoreState(state, s);
    }
    const from = state.sp;
    if ((state.tok as number) === T_STR) {
        const source = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
        consumeSemi(state);
        return m.ImportDeclaration(start, state.tokStart, flags, finishList(state, from), source) as Node;
    }
    if (isIdentLike(state)) {
        const local = parseIdent(state, R_BIND);
        push(state, m.ImportDefaultSpecifier(local.start, local.end, 0, local) as Node);
        eatP(state, P.COMMA);
    }
    if (isP(state, P.STAR)) {
        const s = state.tokStart;
        nextToken(state);
        if (!eatK(state, K.AS)) raise(state, ParseErrorCode.Expected, "'as'");
        const local = parseIdent(state, R_BIND);
        push(state, m.ImportNamespaceSpecifier(s, local.end, 0, local) as Node);
    } else if (isP(state, P.LBRACE)) {
        nextToken(state);
        while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
            const ss = state.tokStart;
            let specFlags = 0;
            if (state.tsMode && isK(state, K.TYPE)) {
                const st = saveState(state);
                nextToken(state);
                if (isNameLike(state) || (state.tok as number) === T_STR) specFlags |= FL.TYPE_ONLY;
                else restoreState(state, st);
            }
            const imported =
                (state.tok as number) === T_STR
                    ? leaf(state, N.StringLiteral, state.tokStart, state.tokEnd)
                    : parseNameAsIdent(state, R_NAME);
            if ((state.tok as number) === T_STR) nextToken(state);
            const local = eatK(state, K.AS) ? parseIdent(state, R_BIND) : ident(state, R_BIND, imported.start, imported.end);
            push(state, m.ImportSpecifier(ss, state.tokStart, specFlags, local, imported) as Node);
            if (!isP(state, P.RBRACE)) expectP(state, P.COMMA, "','");
        }
        expectP(state, P.RBRACE, "'}'");
    }
    if (!eatK(state, K.FROM)) raise(state, ParseErrorCode.Expected, "'from'");
    let source: Ref = null;
    if ((state.tok as number) === T_STR) {
        source = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    } else raise(state, ParseErrorCode.ExpectedModuleSpecifier);
    consumeSemi(state);
    return m.ImportDeclaration(
        start,
        state.tokStart,
        flags,
        finishList(state, from),
        source ?? leaf(state, N.StringLiteral, state.tokStart, state.tokStart),
    ) as Node;
}

function parseExport(state: ParserState): Node {
    const start = state.tokStart;
    nextToken(state);
    if (eatK(state, K.DEFAULT)) {
        let decl: Node;
        if (isK(state, K.FUNCTION)) decl = parseFunction(state, false, true, false);
        else if (isK(state, K.ASYNC)) {
            nextToken(state);
            decl = parseFunction(state, true, true, false);
        } else if (isK(state, K.CLASS)) decl = parseClass(state, false, 0);
        else {
            decl = parseAssign(state);
            consumeSemi(state);
        }
        return m.ExportDefaultDeclaration(start, state.tokStart, 0, decl) as Node;
    }
    if (isP(state, P.STAR)) {
        nextToken(state);
        let exported: Ref = null;
        if (eatK(state, K.AS)) exported = parseIdent(state, R_NAME);
        if (!eatK(state, K.FROM)) raise(state, ParseErrorCode.Expected, "'from'");
        let source: Ref = null;
        if ((state.tok as number) === T_STR) {
            source = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
            nextToken(state);
        }
        consumeSemi(state);
        return m.ExportAllDeclaration(
            start,
            state.tokStart,
            0,
            source ?? leaf(state, N.StringLiteral, state.tokStart, state.tokStart),
            exported,
        ) as Node;
    }
    let flags = 0;
    if (state.tsMode && isK(state, K.TYPE)) {
        const s = saveState(state);
        nextToken(state);
        if (isP(state, P.LBRACE)) flags |= FL.TYPE_ONLY;
        else restoreState(state, s);
    }
    if (isP(state, P.LBRACE)) {
        nextToken(state);
        const from = state.sp;
        while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
            const ss = state.tokStart;
            let specFlags = 0;
            if (state.tsMode && isK(state, K.TYPE)) {
                const st = saveState(state);
                nextToken(state);
                if (isNameLike(state)) specFlags |= FL.TYPE_ONLY;
                else restoreState(state, st);
            }
            const local =
                (state.tok as number) === T_STR
                    ? leaf(state, N.StringLiteral, state.tokStart, state.tokEnd)
                    : parseNameAsIdent(state, R_REF);
            if ((state.tok as number) === T_STR) nextToken(state);
            const exported: Node = eatK(state, K.AS)
                ? (state.tok as number) === T_STR
                    ? leaf(state, N.StringLiteral, state.tokStart, state.tokEnd)
                    : parseNameAsIdent(state, R_NAME)
                : local.type === N.StringLiteral
                  ? local
                  : ident(state, R_NAME, local.start, local.end);
            if (exported.type === N.StringLiteral) nextToken(state);
            push(state, m.ExportSpecifier(ss, state.tokStart, specFlags, local, exported) as Node);
            if (!isP(state, P.RBRACE)) expectP(state, P.COMMA, "','");
        }
        expectP(state, P.RBRACE, "'}'");
        let source: Ref = null;
        if (eatK(state, K.FROM)) {
            if ((state.tok as number) === T_STR) {
                source = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
                nextToken(state);
            }
        }
        consumeSemi(state);
        return m.ExportNamedDeclaration(start, state.tokStart, flags, null, finishList(state, from), source) as Node;
    }
    const decl = parseStatement(state);
    return m.ExportNamedDeclaration(start, state.tokStart, flags, decl, [], null) as Node;
}

function parseInterface(state: ParserState, start: number, extraFlags: number): Node {
    nextToken(state);
    const id = parseIdent(state, R_BIND);
    let typeParams: Ref = null;
    if (isP(state, P.LT)) {
        const t = tryParseTypeParams(state);
        if (t !== null) typeParams = t;
    }
    const extFrom = state.sp;
    if (eatK(state, K.EXTENDS)) {
        do {
            const s = state.tokStart;
            let expr: Node = parseIdent(state, R_REF);
            while (isP(state, P.DOT)) {
                nextToken(state);
                const r = parseNameAsIdent(state, R_NAME);
                expr = m.TSQualifiedName(s, r.end, 0, expr, r) as Node;
            }
            let targs: Ref = null;
            if (isP(state, P.LT)) {
                const t = tryParseTypeArgsInType(state);
                if (t !== null) targs = t;
            }
            push(state, m.TSInterfaceHeritage(s, state.tokStart, 0, expr, targs) as Node);
        } while (eatP(state, P.COMMA));
    }
    const ext = finishList(state, extFrom);
    const body = parseTypeMembers(state);
    return m.TSInterfaceDeclaration(start, state.tokStart, extraFlags, id, typeParams, ext, body) as Node;
}

function parseTypeAlias(state: ParserState, start: number, extraFlags: number): Node {
    nextToken(state);
    const id = parseIdent(state, R_BIND);
    let typeParams: Ref = null;
    if (isP(state, P.LT)) {
        const t = tryParseTypeParams(state);
        if (t !== null) typeParams = t;
    }
    expectP(state, P.EQ, "'='");
    const ty = parseType(state);
    consumeSemi(state);
    return m.TSTypeAliasDeclaration(start, state.tokStart, extraFlags, id, typeParams, ty) as Node;
}

function parseEnum(state: ParserState, start: number, extraFlags: number): Node {
    nextToken(state);
    const id = parseIdent(state, R_BIND);
    expectP(state, P.LBRACE, "'{'");
    const from = state.sp;
    while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
        const ms = state.tokStart;
        let key: Node;
        if ((state.tok as number) === T_STR) {
            key = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
            nextToken(state);
        } else key = parseNameAsIdent(state, R_NAME);
        let init: Ref = null;
        if (isP(state, P.EQ)) {
            nextToken(state);
            init = parseAssign(state);
        }
        push(state, m.TSEnumMember(ms, state.tokStart, 0, key, init) as Node);
        if (!isP(state, P.RBRACE)) expectP(state, P.COMMA, "','");
    }
    expectP(state, P.RBRACE, "'}'");
    return m.TSEnumDeclaration(start, state.tokStart, extraFlags, id, finishList(state, from)) as Node;
}

function parseTypeAnn(state: ParserState): Node {
    const start = state.tokStart;
    expectP(state, P.COLON, "':'");
    if (isK(state, K.ASSERTS)) {
        nextToken(state);
        if (isIdentLike(state) || isK(state, K.THIS)) nextToken(state);
        if (eatK(state, K.IS)) parseType(state);
        return m.TSTypeAnnotation(start, state.tokStart, 0, m.keyword(start, state.tokStart, N.TSAnyKeyword) as Node) as Node;
    }
    const s = saveState(state);
    if (isIdentLike(state) || isK(state, K.THIS)) {
        nextToken(state);
        if (isK(state, K.IS)) {
            nextToken(state);
            const ty = parseType(state);
            return m.TSTypeAnnotation(start, state.tokStart, 0, ty) as Node;
        }
        restoreState(state, s);
    }
    const ty = parseType(state);
    return m.TSTypeAnnotation(start, ty.end, 0, ty) as Node;
}

/** Public type entry: conditional types are ALLOWED here (a trailing `? … : …` starts a new
 * conditional). Nested bracketed types (`(T)`, `{…}`, `T[…]`, `<…>`) route back through this,
 * so disallow-conditional state never leaks across a bracket boundary — matching oxc/TS. */
function parseType(state: ParserState): Node {
    const saved = state.noCondType;
    state.noCondType = false;
    const t = parseTypeInner(state);
    state.noCondType = saved;
    return t;
}

function parseTypeInner(state: ParserState): Node {
    if (isP(state, P.LPAREN) && fnTypeAhead(state)) return parseFnType(state, 0, null);
    if (isP(state, P.LT)) {
        const tp = tryParseTypeParams(state);
        if (tp !== null) return parseFnType(state, 0, tp);
    }
    if (isK(state, K.NEW)) {
        const start = state.tokStart;
        nextToken(state);
        let tp: Ref = null;
        if (isP(state, P.LT)) {
            const t = tryParseTypeParams(state);
            if (t !== null) tp = t;
        }
        const params = parseParams(state);
        expectP(state, P.ARROW, "'=>'");
        const ret = parseType(state);
        const ann = m.TSTypeAnnotation(ret.start, ret.end, 0, ret) as Node;
        return m.TSConstructorType(start, state.tokStart, 0, tp, params, ann) as Node;
    }
    return parseConditionalTypeOrHigher(state);
}

function parseFnType(state: ParserState, abstractFlag: number, typeParams: Ref): Node {
    const start = state.tokStart;
    const params = parseParams(state);
    expectP(state, P.ARROW, "'=>'");
    const ret = parseType(state);
    const ann = m.TSTypeAnnotation(ret.start, ret.end, 0, ret) as Node;
    return m.TSFunctionType(start, state.tokStart, abstractFlag, typeParams, params, ann) as Node;
}

function fnTypeAhead(state: ParserState): boolean {
    const src = state.src,
        srcLen = state.srcLen;
    let p = state.tokStart + 1;
    let depth = 1;
    while (p < srcLen && depth > 0) {
        const c = src.charCodeAt(p);
        if (c === 40 || c === 91 || c === 123) depth++;
        else if (c === 41 || c === 93 || c === 125) depth--;
        else if (c === 34 || c === 39 || c === 96) {
            const q = c;
            p++;
            while (p < srcLen && src.charCodeAt(p) !== q) p += src.charCodeAt(p) === 92 ? 2 : 1;
        }
        p++;
    }
    while (p < srcLen) {
        const c = src.charCodeAt(p);
        if (c < 128 && (CHAR[c] === C_WS || CHAR[c] === C_NL)) p++;
        else break;
    }
    return src.charCodeAt(p) === 61 && src.charCodeAt(p + 1) === 62;
}

function parseConditionalTypeOrHigher(state: ParserState): Node {
    const checkType = parseUnionType(state);
    // A conditional's extends-type is parsed with conditionals disallowed (`noCondType`), so a
    // trailing `? … : …` there binds to THIS conditional, not a nested one.
    if (state.noCondType || !isK(state, K.EXTENDS)) return checkType;
    nextToken(state);
    state.noCondType = true;
    const extendsType = parseTypeInner(state);
    state.noCondType = false;
    expectP(state, P.QUESTION, "'?'");
    const trueType = parseType(state);
    expectP(state, P.COLON, "':'");
    const falseType = parseType(state);
    return m.TSConditionalType(checkType.start, falseType.end, 0, checkType, extendsType, trueType, falseType) as Node;
}

function parseUnionType(state: ParserState): Node {
    eatP(state, P.PIPE);
    const first = parseIntersectionType(state);
    if (!isP(state, P.PIPE)) return first;
    const start = first.start;
    const from = state.sp;
    push(state, first);
    while (eatP(state, P.PIPE)) push(state, parseIntersectionType(state));
    return m.TSUnionType(start, state.tokStart, 0, finishList(state, from)) as Node;
}

function parseIntersectionType(state: ParserState): Node {
    eatP(state, P.AMP);
    const first = parseTypeOperator(state);
    if (!isP(state, P.AMP)) return first;
    const start = first.start;
    const from = state.sp;
    push(state, first);
    while (eatP(state, P.AMP)) push(state, parseTypeOperator(state));
    return m.TSIntersectionType(start, state.tokStart, 0, finishList(state, from)) as Node;
}

function parseTypeOperator(state: ParserState): Node {
    const start = state.tokStart;
    if (isK(state, K.KEYOF)) {
        nextToken(state);
        const t = parseTypeOperator(state);
        return m.TSTypeOperator(start, t.end, TSOP.KEYOF, t) as Node;
    }
    if (isK(state, K.READONLY)) {
        nextToken(state);
        const t = parseTypeOperator(state);
        return m.TSTypeOperator(start, t.end, TSOP.READONLY, t) as Node;
    }
    if (isK(state, K.UNIQUE)) {
        nextToken(state);
        const t = parseTypeOperator(state);
        return m.TSTypeOperator(start, t.end, TSOP.UNIQUE, t) as Node;
    }
    if (isK(state, K.INFER)) {
        nextToken(state);
        const name = parseIdent(state, R_BIND);
        // `infer X extends C`: the `extends C` is the inferred type's constraint — UNLESS we're in
        // an allow-conditional context and a `?` follows, in which case `extends` opens the outer
        // conditional and we roll back. (oxc/TS `tryParseConstraintOfInferType`.)
        let constraint: Ref = null;
        if (isK(state, K.EXTENDS)) {
            const s = saveState(state);
            const inDisallow = state.noCondType;
            nextToken(state);
            state.noCondType = true;
            const c = parseTypeInner(state);
            state.noCondType = inDisallow;
            if (inDisallow || !isP(state, P.QUESTION)) constraint = c;
            else restoreState(state, s);
        }
        const tp = m.TSTypeParameter(name.start, state.tokStart, 0, name, constraint, null) as Node;
        return m.TSInferType(start, state.tokStart, 0, tp) as Node;
    }
    return parseTypePostfixAndCond(state, parsePrimaryType(state));
}

function parseTypePostfixAndCond(state: ParserState, t: Node): Node {
    for (;;) {
        if (isP(state, P.LBRACKET) && (state.tokFlags & F_NL) === 0) {
            nextToken(state);
            if (isP(state, P.RBRACKET)) {
                nextToken(state);
                t = m.TSArrayType(t.start, state.tokStart, 0, t) as Node;
            } else {
                const idx = parseType(state);
                expectP(state, P.RBRACKET, "']'");
                t = m.TSIndexedAccessType(t.start, state.tokStart, 0, t, idx) as Node;
            }
        } else return t;
    }
}

function parsePrimaryType(state: ParserState): Node {
    const start = state.tokStart;
    if (isP(state, P.LPAREN)) {
        if (fnTypeAhead(state)) return parseFnType(state, 0, null);
        nextToken(state);
        const t = parseType(state);
        expectP(state, P.RPAREN, "')'");
        return t;
    }
    if ((state.tok as number) === T_STR) {
        const l = leaf(state, N.StringLiteral, start, state.tokEnd);
        nextToken(state);
        return m.TSLiteralType(start, state.tokStart, 0, l) as Node;
    }
    if (state.tok === T_NUM) {
        const l = leaf(state, N.NumericLiteral, start, state.tokEnd);
        nextToken(state);
        return m.TSLiteralType(start, state.tokStart, 0, l) as Node;
    }
    if (state.tok === T_BIGINT) {
        const l = leaf(state, N.BigIntLiteral, start, state.tokEnd);
        nextToken(state);
        return m.TSLiteralType(start, state.tokStart, 0, l) as Node;
    }
    if (state.tok === T_TEMPLATE_FULL || state.tok === T_TEMPLATE_HEAD) return parseTemplateLiteralType(state);
    if (isP(state, P.MINUS)) {
        nextToken(state);
        if (state.tok === T_NUM) {
            const l = leaf(state, N.NumericLiteral, start, state.tokEnd);
            nextToken(state);
            return m.TSLiteralType(start, state.tokStart, 0, l) as Node;
        }
        raise(state, ParseErrorCode.ExpectedNumber);
        return m.keyword(start, state.tokStart, N.TSAnyKeyword) as Node;
    }
    if (isP(state, P.LBRACKET)) {
        nextToken(state);
        const from = state.sp;
        while (!isP(state, P.RBRACKET) && (state.tok as number) !== T_EOF) {
            if (isP(state, P.DOTDOTDOT)) {
                const s = state.tokStart;
                nextToken(state);
                const sv = saveState(state);
                let t: Ref = null;
                if (isIdentLike(state)) {
                    const label = parseIdent(state, R_NAME);
                    let opt = 0;
                    if (isP(state, P.QUESTION)) {
                        opt = FL.OPTIONAL;
                        nextToken(state);
                    }
                    if (isP(state, P.COLON)) {
                        nextToken(state);
                        const ty = parseType(state);
                        t = m.TSNamedTupleMember(label.start, ty.end, opt, label, ty) as Node;
                    } else restoreState(state, sv);
                }
                if (t === null) t = parseType(state);
                push(state, m.TSTypeOperator(s, t.end, 0, t) as Node);
            } else {
                const s = saveState(state);
                if (isIdentLike(state)) {
                    const label = parseIdent(state, R_NAME);
                    let opt = 0;
                    if (isP(state, P.QUESTION)) {
                        opt = FL.OPTIONAL;
                        nextToken(state);
                    }
                    if (isP(state, P.COLON)) {
                        nextToken(state);
                        const t = parseType(state);
                        push(state, m.TSNamedTupleMember(label.start, t.end, opt, label, t) as Node);
                        if (!isP(state, P.RBRACKET)) expectP(state, P.COMMA, "','");
                        continue;
                    }
                    restoreState(state, s);
                }
                push(state, parseType(state));
                // unlabeled optional element `[string?]` — consume the marker. Optionality
                // isn't modeled without a TSOptionalType node, and the whole tuple type is
                // erased at emit, so dropping it is invisible to output (cf. `...` as TSTypeOperator).
                if (isP(state, P.QUESTION)) nextToken(state);
            }
            if (!isP(state, P.RBRACKET)) expectP(state, P.COMMA, "','");
        }
        expectP(state, P.RBRACKET, "']'");
        return m.TSTupleType(start, state.tokStart, 0, finishList(state, from)) as Node;
    }
    if (isP(state, P.LBRACE)) {
        if (mappedTypeAhead(state)) return parseMappedType(state);
        const members = parseTypeMembers(state);
        return m.TSTypeLiteral(start, state.tokStart, 0, members) as Node;
    }
    if (isK(state, K.TYPEOF)) {
        nextToken(state);
        const s = state.tokStart;
        // `typeof this.foo` — the entity-name root may be `this` (or any reserved word). TS/oxc
        // parse a reserved-word-tolerant entity name here.
        let expr: Node;
        if (isK(state, K.THIS)) {
            expr = m.ThisExpression(state.tokStart, state.tokEnd, 0) as Node;
            nextToken(state);
        } else {
            expr = parseIdent(state, R_REF);
        }
        while (isP(state, P.DOT)) {
            nextToken(state);
            const r = parseNameAsIdent(state, R_NAME);
            expr = m.TSQualifiedName(s, r.end, 0, expr, r) as Node;
        }
        let targs: Ref = null;
        if (isP(state, P.LT)) {
            const t = tryParseTypeArgsInType(state);
            if (t !== null) targs = t;
        }
        return m.TSTypeQuery(start, state.tokStart, 0, expr, targs) as Node;
    }
    if (isK(state, K.IMPORT)) {
        nextToken(state);
        expectP(state, P.LPAREN, "'('");
        let source: Ref = null;
        if ((state.tok as number) === T_STR) {
            source = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
            nextToken(state);
        }
        expectP(state, P.RPAREN, "')'");
        let qualifier: Ref = null;
        if (isP(state, P.DOT)) {
            nextToken(state);
            let q: Node = parseNameAsIdent(state, R_NAME);
            while (isP(state, P.DOT)) {
                nextToken(state);
                const r = parseNameAsIdent(state, R_NAME);
                q = m.TSQualifiedName(q.start, r.end, 0, q, r) as Node;
            }
            qualifier = q;
        }
        let targs: Ref = null;
        if (isP(state, P.LT)) {
            const t = tryParseTypeArgsInType(state);
            if (t !== null) targs = t;
        }
        return m.TSImportType(
            start,
            state.tokStart,
            0,
            source ?? leaf(state, N.StringLiteral, state.tokStart, state.tokStart),
            qualifier,
            targs,
        ) as Node;
    }
    if (isK(state, K.THIS)) {
        nextToken(state);
        return m.keyword(start, state.tokStart, N.TSThisType) as Node;
    }
    if (isIdentLike(state) || isKeyword(state.tok)) {
        const kw = tsKeywordType(state);
        if (kw !== 0) {
            nextToken(state);
            return m.keyword(start, state.tokStart, kw) as Node;
        }
        const s = state.tokStart;
        let name: Node = parseNameAsIdent(state, R_REF);
        while (isP(state, P.DOT)) {
            nextToken(state);
            const r = parseNameAsIdent(state, R_NAME);
            name = m.TSQualifiedName(s, r.end, 0, name, r) as Node;
        }
        let targs: Ref = null;
        if (isP(state, P.LT)) {
            const t = tryParseTypeArgsInType(state);
            if (t !== null) targs = t;
        }
        return m.TSTypeReference(start, state.tokStart, 0, name, targs) as Node;
    }
    raise(state, ParseErrorCode.ExpectedType);
    nextToken(state);
    return m.keyword(start, state.tokStart, N.TSAnyKeyword) as Node;
}

function tsKeywordType(state: ParserState): KeywordType | 0 {
    const src = state.src;
    const len = state.tokEnd - state.tokStart;
    const st = state.tokStart;
    switch (len) {
        case 3:
            if (src.startsWith('any', st)) return N.TSAnyKeyword;
            break;
        case 4:
            if (src.startsWith('void', st)) return N.TSVoidKeyword;
            break;
        case 5:
            if (src.startsWith('never', st)) return N.TSNeverKeyword;
            break;
        case 6:
            if (src.startsWith('number', st)) return N.TSNumberKeyword;
            if (src.startsWith('string', st)) return N.TSStringKeyword;
            if (src.startsWith('symbol', st)) return N.TSSymbolKeyword;
            if (src.startsWith('object', st)) return N.TSObjectKeyword;
            if (src.startsWith('bigint', st)) return N.TSBigIntKeyword;
            break;
        case 7:
            if (src.startsWith('boolean', st)) return N.TSBooleanKeyword;
            if (src.startsWith('unknown', st)) return N.TSUnknownKeyword;
            break;
        case 9:
            if (src.startsWith('undefined', st)) return N.TSUndefinedKeyword;
    }
    if (isK(state, K.NULL)) return N.TSNullKeyword;
    return 0;
}

function parseTemplateLiteralType(state: ParserState): Node {
    const start = state.tokStart;
    if (state.tok === T_TEMPLATE_FULL) {
        const q = leaf(state, N.TemplateElement, start + 1, state.tokEnd - 1);
        nextToken(state);
        return m.TSTemplateLiteralType(start, state.tokStart, 0, [q], []) as Node;
    }
    const qFrom = state.sp;
    const types: Node[] = [];
    push(state, leaf(state, N.TemplateElement, start + 1, state.tokEnd - 2));
    nextToken(state);
    for (;;) {
        types.push(parseType(state));
        if (!isP(state, P.RBRACE)) {
            raise(state, ParseErrorCode.Expected, "'}'");
            break;
        }
        reScanTemplateContinue(state);
        if (state.tok === T_TEMPLATE_FULL) {
            push(state, leaf(state, N.TemplateElement, state.tokStart + 1, state.tokEnd - 1));
            nextToken(state);
            break;
        }
        push(state, leaf(state, N.TemplateElement, state.tokStart + 1, state.tokEnd - 2));
        nextToken(state);
    }
    const quasis = finishList(state, qFrom);
    return m.TSTemplateLiteralType(start, state.tokStart, 0, quasis, types) as Node;
}

function mappedTypeAhead(state: ParserState): boolean {
    const s = saveState(state);
    nextToken(state);
    let ok = false;
    if (isP(state, P.PLUS) || isP(state, P.MINUS)) nextToken(state);
    if (isK(state, K.READONLY)) nextToken(state);
    if (isP(state, P.LBRACKET)) {
        nextToken(state);
        if (isIdentLike(state)) {
            nextToken(state);
            ok = isK(state, K.IN);
        }
    }
    restoreState(state, s);
    return ok;
}

function parseMappedType(state: ParserState): Node {
    const start = state.tokStart;
    nextToken(state);
    let flags = 0;
    if (isP(state, P.PLUS)) {
        nextToken(state);
        if (eatK(state, K.READONLY)) flags |= 1 << 4;
    } else if (isP(state, P.MINUS)) {
        nextToken(state);
        if (eatK(state, K.READONLY)) flags |= 2 << 4;
    } else if (eatK(state, K.READONLY)) flags |= 3 << 4;
    expectP(state, P.LBRACKET, "'['");
    const name = parseIdent(state, R_BIND);
    if (!eatK(state, K.IN)) raise(state, ParseErrorCode.Expected, "'in'");
    const constraint = parseType(state);
    let nameType: Ref = null;
    if (eatK(state, K.AS)) nameType = parseType(state);
    expectP(state, P.RBRACKET, "']'");
    if (isP(state, P.PLUS)) {
        nextToken(state);
        if (eatP(state, P.QUESTION)) flags |= 1 << 6;
    } else if (isP(state, P.MINUS)) {
        nextToken(state);
        if (eatP(state, P.QUESTION)) flags |= 2 << 6;
    } else if (eatP(state, P.QUESTION)) flags |= 3 << 6;
    let typeAnn: Ref = null;
    if (isP(state, P.COLON)) {
        nextToken(state);
        typeAnn = parseType(state);
    }
    eatP(state, P.SEMI);
    expectP(state, P.RBRACE, "'}'");
    const tp = m.TSTypeParameter(name.start, constraint.end, 0, name, constraint, null) as Node;
    return m.TSMappedType(start, state.tokStart, flags, tp, nameType, typeAnn) as Node;
}

function parseTypeMembers(state: ParserState): Node[] {
    expectP(state, P.LBRACE, "'{'");
    const from = state.sp;
    let last = -1;
    while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
        if (state.tokStart === last) {
            raise(state, ParseErrorCode.UnexpectedInTypeMember, tokenDesc(state));
            nextToken(state);
            continue;
        }
        last = state.tokStart;
        push(state, parseTypeMember(state));
        eatP(state, P.COMMA);
        eatP(state, P.SEMI);
    }
    expectP(state, P.RBRACE, "'}'");
    return finishList(state, from);
}

function parseTypeMember(state: ParserState): Node {
    const start = state.tokStart;
    let flags = 0;
    if (isK(state, K.READONLY) && !nextIsPropertyEnd(state)) {
        flags |= FL.READONLY;
        nextToken(state);
    }
    if (isK(state, K.NEW) && !nextIsPropertyEnd(state)) {
        nextToken(state);
        let tp: Ref = null;
        if (isP(state, P.LT)) {
            const t = tryParseTypeParams(state);
            if (t !== null) tp = t;
        }
        const params = parseParams(state);
        let ret: Ref = null;
        if (isP(state, P.COLON)) ret = parseTypeAnn(state);
        return m.TSConstructSignatureDeclaration(start, state.tokStart, 0, tp, params, ret) as Node;
    }
    if (isP(state, P.LPAREN) || isP(state, P.LT)) {
        let tp: Ref = null;
        if (isP(state, P.LT)) {
            const t = tryParseTypeParams(state);
            if (t !== null) tp = t;
        }
        const params = parseParams(state);
        let ret: Ref = null;
        if (isP(state, P.COLON)) ret = parseTypeAnn(state);
        return m.TSCallSignatureDeclaration(start, state.tokStart, 0, tp, params, ret) as Node;
    }
    if (isP(state, P.LBRACKET)) {
        nextToken(state);
        const ps = state.tokStart;
        const name = parseNameAsIdent(state, R_REF);
        if (isP(state, P.COLON)) {
            const keyAnn = parseTypeAnn(state);
            const param = m.FormalParameter(
                ps,
                state.tokStart,
                0,
                ident(state, R_BIND, name.start, name.end),
                keyAnn,
                null,
            ) as Node;
            expectP(state, P.RBRACKET, "']'");
            let ann: Ref = null;
            if (isP(state, P.COLON)) ann = parseTypeAnn(state);
            return m.TSIndexSignature(start, state.tokStart, flags, param, ann) as Node;
        }
        let key: Node = name;
        while (isP(state, P.DOT)) {
            nextToken(state);
            const r = parseNameAsIdent(state, R_NAME);
            key = m.StaticMemberExpression(ps, r.end, 0, key, r) as Node;
        }
        expectP(state, P.RBRACKET, "']'");
        let mflags = flags | FL.COMPUTED;
        if (isP(state, P.QUESTION)) {
            mflags |= FL.OPTIONAL;
            nextToken(state);
        }
        if (isP(state, P.LPAREN) || isP(state, P.LT)) {
            let tp: Ref = null;
            if (isP(state, P.LT)) {
                const t = tryParseTypeParams(state);
                if (t !== null) tp = t;
            }
            const params = parseParams(state);
            let ret: Ref = null;
            if (isP(state, P.COLON)) ret = parseTypeAnn(state);
            return m.TSMethodSignature(start, state.tokStart, mflags, key, tp, params, ret) as Node;
        }
        let ann: Ref = null;
        if (isP(state, P.COLON)) ann = parseTypeAnn(state);
        return m.TSPropertySignature(start, state.tokStart, mflags, key, ann) as Node;
    }
    let kind = 0;
    if ((isK(state, K.GET) || isK(state, K.SET)) && !nextIsPropertyEnd(state)) {
        kind = isK(state, K.GET) ? 1 : 2;
        nextToken(state);
    }
    let key: Node;
    if ((state.tok as number) === T_STR) {
        key = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    } else if (state.tok === T_NUM) {
        key = leaf(state, N.NumericLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    } else key = parseNameAsIdent(state, R_NAME);
    if (isP(state, P.QUESTION)) {
        flags |= FL.OPTIONAL;
        nextToken(state);
    }
    if (isP(state, P.LPAREN) || isP(state, P.LT) || kind !== 0) {
        let tp: Ref = null;
        if (isP(state, P.LT)) {
            const t = tryParseTypeParams(state);
            if (t !== null) tp = t;
        }
        const params = parseParams(state);
        let ret: Ref = null;
        if (isP(state, P.COLON)) ret = parseTypeAnn(state);
        return m.TSMethodSignature(start, state.tokStart, flags | (kind << FL.KIND_SHIFT), key, tp, params, ret) as Node;
    }
    let ann: Ref = null;
    if (isP(state, P.COLON)) ann = parseTypeAnn(state);
    return m.TSPropertySignature(start, state.tokStart, flags, key, ann) as Node;
}

function expectGtInType(state: ParserState): void {
    if (isP(state, P.GT)) {
        nextToken(state);
        return;
    }
    if (
        isPunct(state.tok) &&
        (state.tok === P.SHR || state.tok === P.USHR || state.tok === P.GE || state.tok === P.SHREQ || state.tok === P.USHREQ)
    ) {
        state.pos = state.tokStart + 1;
        nextToken(state);
        return;
    }
    raise(state, ParseErrorCode.Expected, "'>'");
}
const isGtLike = (state: ParserState): boolean =>
    isPunct(state.tok) &&
    (state.tok === P.GT ||
        state.tok === P.SHR ||
        state.tok === P.USHR ||
        state.tok === P.GE ||
        state.tok === P.SHREQ ||
        state.tok === P.USHREQ);

function tryParseTypeParams(state: ParserState): Node | null {
    const src = state.src;
    const s = saveState(state);
    const startPos = state.tokStart;
    nextToken(state);
    const from = state.sp;
    try {
        state.speculating++;
        while (!isGtLike(state) && (state.tok as number) !== T_EOF) {
            const ts = state.tokStart;
            let flags = 0;
            for (;;) {
                if (isK(state, K.IN)) {
                    flags |= 1;
                    nextToken(state);
                } else if (
                    state.tok === T_IDENT &&
                    state.tokEnd - state.tokStart === 3 &&
                    src.startsWith('out', state.tokStart) &&
                    !nextIsTypeParamEnd(state)
                ) {
                    flags |= 2;
                    nextToken(state);
                } else if (isK(state, K.CONST)) {
                    flags |= 4;
                    nextToken(state);
                } else break;
            }
            const name = parseIdent(state, R_BIND);
            let constraint: Ref = null;
            if (eatK(state, K.EXTENDS)) constraint = parseType(state);
            let dflt: Ref = null;
            if (isP(state, P.EQ)) {
                nextToken(state);
                dflt = parseType(state);
            }
            push(state, m.TSTypeParameter(ts, state.tokStart, flags, name, constraint, dflt) as Node);
            if (!eatP(state, P.COMMA)) break;
        }
        if (!isGtLike(state)) throw 0;
        expectGtInType(state);
        state.speculating--;
        return m.TSTypeParameterDeclaration(startPos, state.tokStart, 0, finishList(state, from)) as Node;
    } catch {
        state.speculating--;
        state.sp = from;
        restoreState(state, s);
        return null;
    }
}

function nextIsTypeParamEnd(state: ParserState): boolean {
    const s = saveState(state);
    nextToken(state);
    const end = isGtLike(state) || isP(state, P.COMMA) || isK(state, K.EXTENDS) || isP(state, P.EQ);
    restoreState(state, s);
    return end;
}

function tryParseTypeArgsInType(state: ParserState): Node | null {
    const s = saveState(state);
    const startPos = state.tokStart;
    nextToken(state);
    const from = state.sp;
    try {
        state.speculating++;
        while (!isGtLike(state) && (state.tok as number) !== T_EOF) {
            push(state, parseType(state));
            if (!eatP(state, P.COMMA)) break;
        }
        if (!isGtLike(state)) throw 0;
        expectGtInType(state);
        state.speculating--;
        return m.TSTypeParameterInstantiation(startPos, state.tokStart, 0, finishList(state, from)) as Node;
    } catch {
        state.speculating--;
        state.sp = from;
        restoreState(state, s);
        return null;
    }
}

function tryParseTypeArgsForCall(state: ParserState): Node | null {
    const s = saveState(state);
    const ref = tryParseTypeArgsInType(state);
    if (ref === null) return null;
    if (
        isP(state, P.LPAREN) ||
        state.tok === T_TEMPLATE_FULL ||
        state.tok === T_TEMPLATE_HEAD ||
        isP(state, P.RPAREN) ||
        isP(state, P.COMMA) ||
        isP(state, P.SEMI) ||
        isP(state, P.RBRACE) ||
        state.tok === T_EOF
    ) {
        return ref;
    }
    restoreState(state, s);
    return null;
}

/** The parse result: the program, the error list, and the source-free line table
 * for offset->line/col. The source is not retained after the parse. */
export type ParseResult = { program: Program; errors: ParseError[]; lines: Uint32Array; nodeCount: number };
export type ParseOptions = { ts: boolean; jsx: boolean };

/** Parse `source` into a standalone Program. Source, error sink, intern map and
 * line table are the parser's own state, reset at entry; nothing references
 * `source` after this returns. */
export function parse(source: string, options: ParseOptions): ParseResult {
    const state = createParserState(source, options);
    recordNL(state, -1);
    nextToken(state);
    const from = state.sp;
    let lastPos = -1;
    while ((state.tok as number) !== T_EOF) {
        if (state.pos === lastPos && (state.tok as number) !== T_EOF) {
            raise(state, ParseErrorCode.ParserStalled);
            nextToken(state);
        }
        lastPos = state.pos;
        push(state, parseStatement(state));
    }
    const body = finishList(state, from);
    const program = m.Program(0, state.srcLen, 0, body) as Program;
    const lines = state.lineStarts.slice(0, state.lineCount);
    const nodeCount = program.id - state.baseId + 1;
    return { program, errors: state.errors, lines, nodeCount };
}

export function parseProgram(source: string, options: ParseOptions): Program {
    return parse(source, options).program;
}
export function parseWithDiagnostics(source: string, options: ParseOptions): ParseResult {
    return parse(source, options);
}

export function lexOnly(source: string, options: ParseOptions): number {
    const state = createParserState(source, options);
    let sum = 0;
    nextToken(state);
    let lastPos = -1;
    while (state.tok !== T_EOF) {
        if (state.tok === T_IDENT) sum += intern(state, state.tokStart, state.tokEnd, state.tokHash).length;
        else sum += state.tokEnd - state.tokStart;
        if (state.pos === lastPos) break;
        lastPos = state.pos;
        nextToken(state);
    }
    return sum;
}
