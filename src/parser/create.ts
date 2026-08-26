// AST node builders — free functions, namespaced at call sites as `create.Foo(...)`
// via `import * as create`. Owns the parse-flag vocabulary (FL / VAR_KIND / OP) the
// builders decode from a `flags` int, so parser.ts imports both `* as create` and
// those constants from here (clean ast <- create <- parser DAG).
import { type Accessibility, N, type Node, node } from '../ast.ts';
import { enumeration } from '../util/enumeration';

export const FL = {
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
    /** `/*@__PURE__*​/`-annotated call/new — the call is side-effect-free if its args are (oxc
     * `CallExpression.pure`). Set by lowering passes so tree-shaking can drop the result if unused. */
    PURE: 1 << 16,
} as const;

export const VAR_KIND = { VAR: 1, LET: 2, CONST: 3, KIND_MASK: 3 } as const;

// Unary & update operator ids (their text lives in UNARY_OP_NAME/UPDATE_OP_NAME).
// Binary/logical/assignment operators no longer need an id — their text comes
// straight off the packed token via `opTextOf` (token.ts).
export const OP = enumeration('NEG', 'POS', 'NOT', 'BIT_NOT', 'TYPEOF', 'VOID', 'DELETE', 'INC', 'DEC');
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

// `kind` lookup tables — module-level so decoding a flags int is an index, not a
// fresh array allocation on every node build.
const PROPERTY_KIND = ['init', 'get', 'set'] as const;
const VAR_DECL_KIND = ['var', 'var', 'let', 'const'] as const;
const METHOD_KIND = ['method', 'get', 'set', 'constructor'] as const;
const SIGNATURE_KIND = ['method', 'get', 'set'] as const;
/** The null-data TS keyword/leaf type ids the `keyword` helper materializes. */
export type KeywordType =
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

export const BooleanLiteral = (s: number, e: number, flags: number): Node =>
    node(N.BooleanLiteral, s, e, flags !== 0 ? 'true' : 'false', null);
export const NullLiteral = (s: number, e: number, _f: number): Node => node(N.NullLiteral, s, e, 'null', null);
export const ThisExpression = (s: number, e: number, _f: number): Node => node(N.ThisExpression, s, e, '', null);
export const Super = (s: number, e: number, _f: number): Node => node(N.Super, s, e, '', null);
export const EmptyStatement = (s: number, e: number, _f: number): Node => node(N.EmptyStatement, s, e, '', null);
export const DebuggerStatement = (s: number, e: number, _f: number): Node => node(N.DebuggerStatement, s, e, '', null);
export const ImportMeta = (s: number, e: number, _f: number): Node => node(N.ImportMeta, s, e, '', null);
export const NewTarget = (s: number, e: number, _f: number): Node => node(N.NewTarget, s, e, '', null);

export const BinaryExpression = (s: number, e: number, op: string, l: Node, r: Node): Node =>
    node(N.BinaryExpression, s, e, '', { operator: op, left: l, right: r });
export const LogicalExpression = (s: number, e: number, op: string, l: Node, r: Node): Node =>
    node(N.LogicalExpression, s, e, '', { operator: op, left: l, right: r });
export const AssignmentExpression = (s: number, e: number, op: string, l: Node, r: Node): Node =>
    node(N.AssignmentExpression, s, e, '', { operator: op, left: l, right: r });
export const UnaryExpression = (s: number, e: number, flags: number, a: Node): Node =>
    node(N.UnaryExpression, s, e, '', { operator: UNARY_OP_NAME[flags & 63], prefix: true, argument: a });
export const UpdateExpression = (s: number, e: number, flags: number, a: Node): Node =>
    node(N.UpdateExpression, s, e, '', {
        operator: UPDATE_OP_NAME[flags & 63],
        prefix: (flags & FL.PREFIX) !== 0,
        argument: a,
    });
export const ObjectProperty = (s: number, e: number, flags: number, key: Node, value: Node): Node =>
    node(N.ObjectProperty, s, e, '', {
        key,
        value,
        kind: PROPERTY_KIND[(flags >> FL.KIND_SHIFT) & 3],
        computed: (flags & FL.COMPUTED) !== 0,
        shorthand: (flags & FL.SHORTHAND) !== 0,
    });
export const CallExpression = (
    s: number,
    e: number,
    flags: number,
    callee: Node,
    args: Node[] | null,
    typeArgs: Node | null,
): Node =>
    node(N.CallExpression, s, e, '', {
        callee,
        arguments: args ?? [],
        optional: (flags & FL.OPTIONAL) !== 0,
        pure: (flags & FL.PURE) !== 0,
        typeArguments: typeArgs ?? null,
    });
export const StaticMemberExpression = (s: number, e: number, flags: number, obj: Node, prop: Node): Node =>
    node(N.StaticMemberExpression, s, e, '', { object: obj, property: prop, optional: (flags & FL.OPTIONAL) !== 0 });
export const ComputedMemberExpression = (s: number, e: number, flags: number, obj: Node, expr: Node): Node =>
    node(N.ComputedMemberExpression, s, e, '', { object: obj, expression: expr, optional: (flags & FL.OPTIONAL) !== 0 });
export const PrivateFieldExpression = (s: number, e: number, flags: number, obj: Node, field: Node): Node =>
    node(N.PrivateFieldExpression, s, e, '', { object: obj, field, optional: (flags & FL.OPTIONAL) !== 0 });
export const ChainExpression = (s: number, e: number, _f: number, expression: Node): Node =>
    node(N.ChainExpression, s, e, '', { expression });
export const ArrowFunctionExpression = (
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
        scopeId: 0,
    });
export const FunctionExpression = (
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
        scopeId: 0,
    });
export const FunctionDeclaration = (
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
        scopeId: 0,
    });
export const ClassExpression = (
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
    });
export const ClassDeclaration = (
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
        scopeId: 0,
    });
export const YieldExpression = (s: number, e: number, flags: number, a: Node | null): Node =>
    node(N.YieldExpression, s, e, '', { argument: a ?? null, delegate: (flags & FL.DELEGATE) !== 0 });
export const VariableDeclaration = (s: number, e: number, flags: number, decls: Node[] | null): Node =>
    node(N.VariableDeclaration, s, e, '', {
        declarations: decls ?? [],
        kind: VAR_DECL_KIND[flags & VAR_KIND.KIND_MASK],
        declare: (flags & FL.DECLARE) !== 0,
    });
export const VariableDeclarator = (s: number, e: number, flags: number, id: Node, ta: Node | null, init: Node | null): Node =>
    node(N.VariableDeclarator, s, e, '', {
        id,
        typeAnnotation: ta ?? null,
        init: init ?? null,
        definite: (flags & FL.DEFINITE) !== 0,
    });
export const ForOfStatement = (s: number, e: number, flags: number, left: Node, right: Node, body: Node): Node =>
    node(N.ForOfStatement, s, e, '', { left, right, body, await: (flags & FL.AWAIT) !== 0, scopeId: 0 });
export const MethodDefinition = (s: number, e: number, flags: number, key: Node, value: Node): Node =>
    node(N.MethodDefinition, s, e, '', {
        key,
        value,
        kind: METHOD_KIND[(flags >> FL.KIND_SHIFT) & 3],
        static: (flags & FL.STATIC) !== 0,
        computed: (flags & FL.COMPUTED) !== 0,
        optional: (flags & FL.OPTIONAL) !== 0,
        abstract: (flags & FL.ABSTRACT) !== 0,
        accessibility: accessibilityOf(flags),
    });
export const PropertyDefinition = (s: number, e: number, flags: number, key: Node, ta: Node | null, value: Node | null): Node =>
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
    });
export const FormalParameter = (s: number, e: number, flags: number, pat: Node, ta: Node | null, init: Node | null): Node =>
    node(N.FormalParameter, s, e, '', {
        pattern: pat,
        typeAnnotation: ta ?? null,
        init: init ?? null,
        optional: (flags & FL.OPTIONAL) !== 0,
        readonly: (flags & FL.READONLY) !== 0,
        accessibility: accessibilityOf(flags),
    });
export const ImportDeclaration = (s: number, e: number, flags: number, specs: Node[] | null, source: Node): Node =>
    node(N.ImportDeclaration, s, e, '', {
        specifiers: specs ?? [],
        source,
        importKind: (flags & FL.TYPE_ONLY) !== 0 ? 'type' : 'value',
    });
export const ImportSpecifier = (s: number, e: number, flags: number, local: Node, imported: Node): Node =>
    node(N.ImportSpecifier, s, e, '', { local, imported, importKind: (flags & FL.TYPE_ONLY) !== 0 ? 'type' : 'value' });
export const ExportNamedDeclaration = (
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
    });
export const ExportSpecifier = (s: number, e: number, flags: number, local: Node, exported: Node): Node =>
    node(N.ExportSpecifier, s, e, '', { local, exported, exportKind: (flags & FL.TYPE_ONLY) !== 0 ? 'type' : 'value' });
export const keyword = (s: number, e: number, kw: KeywordType): Node => node(kw, s, e, '', null);
export const TSTypeParameter = (
    s: number,
    e: number,
    flags: number,
    name: Node,
    constraint: Node | null,
    dflt: Node | null,
): Node =>
    node(N.TSTypeParameter, s, e, '', {
        name,
        constraint: constraint ?? null,
        default: dflt ?? null,
        in: (flags & 1) !== 0,
        out: (flags & 2) !== 0,
        const: (flags & 4) !== 0,
    });
export const TSNamedTupleMember = (s: number, e: number, flags: number, label: Node, elemType: Node): Node =>
    node(N.TSNamedTupleMember, s, e, '', { label, elementType: elemType, optional: (flags & FL.OPTIONAL) !== 0 });
export const TSPropertySignature = (s: number, e: number, flags: number, key: Node, ta: Node | null): Node =>
    node(N.TSPropertySignature, s, e, '', {
        key,
        typeAnnotation: ta ?? null,
        optional: (flags & FL.OPTIONAL) !== 0,
        readonly: (flags & FL.READONLY) !== 0,
        computed: (flags & FL.COMPUTED) !== 0,
    });
export const TSMethodSignature = (
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
        kind: SIGNATURE_KIND[(flags >> FL.KIND_SHIFT) & 3],
        computed: (flags & FL.COMPUTED) !== 0,
    });
export const TSIndexSignature = (s: number, e: number, flags: number, param: Node, ta: Node | null): Node =>
    node(N.TSIndexSignature, s, e, '', {
        parameter: param,
        typeAnnotation: ta ?? null,
        readonly: (flags & FL.READONLY) !== 0,
    });
export const TSTypeOperator = (s: number, e: number, flags: number, ta: Node): Node =>
    node(N.TSTypeOperator, s, e, '', {
        operator: flags === 1 ? 'keyof' : flags === 2 ? 'readonly' : flags === 3 ? 'unique' : '',
        typeAnnotation: ta,
    });
export const TSMappedType = (s: number, e: number, flags: number, tp: Node, nameType: Node | null, ta: Node | null): Node =>
    node(N.TSMappedType, s, e, '', {
        typeParameter: tp,
        nameType: nameType ?? null,
        typeAnnotation: ta ?? null,
        readonlyMod: (flags >> 4) & 3,
        optionalMod: (flags >> 6) & 3,
    });
export const TSConstructorType = (
    s: number,
    e: number,
    flags: number,
    tp: Node | null,
    params: Node[] | null,
    rt: Node | null,
): Node =>
    node(N.TSConstructorType, s, e, '', {
        typeParameters: tp ?? null,
        params: params ?? [],
        returnType: rt ?? null,
        abstract: (flags & FL.ABSTRACT) !== 0,
    });
export const TSInterfaceDeclaration = (
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
        scopeId: 0,
    });
export const TSTypeAliasDeclaration = (s: number, e: number, flags: number, id: Node, tp: Node | null, ta: Node): Node =>
    node(N.TSTypeAliasDeclaration, s, e, '', {
        id,
        typeParameters: tp ?? null,
        typeAnnotation: ta,
        declare: (flags & FL.DECLARE) !== 0,
        scopeId: 0,
    });
export const TSEnumDeclaration = (s: number, e: number, flags: number, id: Node, members: Node[] | null): Node =>
    node(N.TSEnumDeclaration, s, e, '', {
        id,
        members: members ?? [],
        const: (flags & FL.CONST_ENUM) !== 0,
        declare: (flags & FL.DECLARE) !== 0,
    });
export const TSModuleDeclaration = (s: number, e: number, flags: number, id: Node, body: Node[] | null): Node =>
    node(N.TSModuleDeclaration, s, e, '', {
        id,
        body: body ?? [],
        declare: (flags & FL.DECLARE) !== 0,
        namespace: (flags & FL.NAMESPACE) !== 0,
    });

export const TSImportEqualsDeclaration = (s: number, e: number, flags: number, id: Node, moduleReference: Node): Node =>
    node(N.TSImportEqualsDeclaration, s, e, '', {
        id,
        moduleReference,
        importKind: (flags & FL.TYPE_ONLY) !== 0 ? 'type' : 'value',
    });
export const TSExternalModuleReference = (s: number, e: number, _f: number, expression: Node): Node =>
    node(N.TSExternalModuleReference, s, e, '', { expression });

export const Program = (s: number, e: number, _f: number, body: Node[]): Node => node(N.Program, s, e, '', { body, scopeId: 0 });
export const TemplateLiteral = (s: number, e: number, _f: number, quasis: Node[], expressions: Node[]): Node =>
    node(N.TemplateLiteral, s, e, '', { quasis, expressions });
export const TaggedTemplateExpression = (s: number, e: number, _f: number, tag: Node, quasi: Node): Node =>
    node(N.TaggedTemplateExpression, s, e, '', { tag, quasi });
export const ArrayExpression = (s: number, e: number, _f: number, elements: (Node | null)[]): Node =>
    node(N.ArrayExpression, s, e, '', { elements });
export const ObjectExpression = (s: number, e: number, _f: number, properties: Node[]): Node =>
    node(N.ObjectExpression, s, e, '', { properties });
export const SpreadElement = (s: number, e: number, _f: number, argument: Node): Node =>
    node(N.SpreadElement, s, e, '', { argument });
export const ConditionalExpression = (s: number, e: number, _f: number, test: Node, consequent: Node, alternate: Node): Node =>
    node(N.ConditionalExpression, s, e, '', { test, consequent, alternate });
export const NewExpression = (s: number, e: number, f: number, callee: Node, args: Node[] | null, typeArgs: Node | null): Node =>
    // `pure` mirrors CallExpression: `/*@__PURE__*​/ new X()` is the most common annotation shape in
    // real libraries, so a `new` has to be able to carry the marker. Every NewExpression gets the
    // field, so the data shape stays monomorphic.
    node(N.NewExpression, s, e, '', {
        callee,
        arguments: args ?? [],
        typeArguments: typeArgs ?? null,
        pure: (f & FL.PURE) !== 0,
    });
export const SequenceExpression = (s: number, e: number, _f: number, expressions: Node[]): Node =>
    node(N.SequenceExpression, s, e, '', { expressions });
export const AwaitExpression = (s: number, e: number, _f: number, argument: Node): Node =>
    node(N.AwaitExpression, s, e, '', { argument });
export const ImportExpression = (s: number, e: number, _f: number, source: Node, options: Node | null): Node =>
    node(N.ImportExpression, s, e, '', { source, options: options ?? null });
export const ExpressionStatement = (s: number, e: number, _f: number, expression: Node): Node =>
    node(N.ExpressionStatement, s, e, '', { expression });
export const BlockStatement = (s: number, e: number, _f: number, body: Node[]): Node =>
    node(N.BlockStatement, s, e, '', { body, scopeId: 0 });
export const IfStatement = (s: number, e: number, _f: number, test: Node, consequent: Node, alternate: Node | null): Node =>
    node(N.IfStatement, s, e, '', { test, consequent, alternate: alternate ?? null });
export const ForStatement = (
    s: number,
    e: number,
    _f: number,
    init: Node | null,
    test: Node | null,
    update: Node | null,
    body: Node,
): Node => node(N.ForStatement, s, e, '', { init: init ?? null, test: test ?? null, update: update ?? null, body, scopeId: 0 });
export const ForInStatement = (s: number, e: number, _f: number, left: Node, right: Node, body: Node): Node =>
    node(N.ForInStatement, s, e, '', { left, right, body, scopeId: 0 });
export const WhileStatement = (s: number, e: number, _f: number, test: Node, body: Node): Node =>
    node(N.WhileStatement, s, e, '', { test, body });
export const DoWhileStatement = (s: number, e: number, _f: number, body: Node, test: Node): Node =>
    node(N.DoWhileStatement, s, e, '', { body, test });
export const SwitchStatement = (s: number, e: number, _f: number, discriminant: Node, cases: Node[]): Node =>
    node(N.SwitchStatement, s, e, '', { discriminant, cases, scopeId: 0 });
export const SwitchCase = (s: number, e: number, _f: number, test: Node | null, consequent: Node[]): Node =>
    node(N.SwitchCase, s, e, '', { test: test ?? null, consequent });
export const TryStatement = (s: number, e: number, _f: number, block: Node, handler: Node | null, finalizer: Node | null): Node =>
    node(N.TryStatement, s, e, '', { block, handler: handler ?? null, finalizer: finalizer ?? null });
export const CatchClause = (s: number, e: number, _f: number, param: Node | null, body: Node): Node =>
    node(N.CatchClause, s, e, '', { param: param ?? null, body });
export const ReturnStatement = (s: number, e: number, _f: number, argument: Node | null): Node =>
    node(N.ReturnStatement, s, e, '', { argument: argument ?? null });
export const ThrowStatement = (s: number, e: number, _f: number, argument: Node): Node =>
    node(N.ThrowStatement, s, e, '', { argument });
export const BreakStatement = (s: number, e: number, _f: number, label: Node | null): Node =>
    node(N.BreakStatement, s, e, '', { label: label ?? null });
export const ContinueStatement = (s: number, e: number, _f: number, label: Node | null): Node =>
    node(N.ContinueStatement, s, e, '', { label: label ?? null });
export const LabeledStatement = (s: number, e: number, _f: number, label: Node, body: Node): Node =>
    node(N.LabeledStatement, s, e, '', { label, body });
export const StaticBlock = (s: number, e: number, _f: number, body: Node[]): Node => node(N.StaticBlock, s, e, '', { body });
export const ObjectPattern = (s: number, e: number, _f: number, properties: Node[]): Node =>
    node(N.ObjectPattern, s, e, '', { properties });
export const ArrayPattern = (s: number, e: number, _f: number, elements: (Node | null)[]): Node =>
    node(N.ArrayPattern, s, e, '', { elements });
export const AssignmentPattern = (s: number, e: number, _f: number, left: Node, right: Node): Node =>
    node(N.AssignmentPattern, s, e, '', { left, right });
export const RestElement = (s: number, e: number, _f: number, argument: Node, typeAnnotation: Node | null): Node =>
    node(N.RestElement, s, e, '', { argument, typeAnnotation: typeAnnotation ?? null });
export const ImportDefaultSpecifier = (s: number, e: number, _f: number, local: Node): Node =>
    node(N.ImportDefaultSpecifier, s, e, '', { local });
export const ImportNamespaceSpecifier = (s: number, e: number, _f: number, local: Node): Node =>
    node(N.ImportNamespaceSpecifier, s, e, '', { local });
export const ExportDefaultDeclaration = (s: number, e: number, _f: number, declaration: Node): Node =>
    node(N.ExportDefaultDeclaration, s, e, '', { declaration });
export const ExportAllDeclaration = (s: number, e: number, _f: number, source: Node, exported: Node | null): Node =>
    node(N.ExportAllDeclaration, s, e, '', { source, exported: exported ?? null });
export const TSTypeAnnotation = (s: number, e: number, _f: number, typeAnnotation: Node): Node =>
    node(N.TSTypeAnnotation, s, e, '', { typeAnnotation });
export const TSTypeReference = (s: number, e: number, _f: number, typeName: Node, typeArguments: Node | null): Node =>
    node(N.TSTypeReference, s, e, '', { typeName, typeArguments: typeArguments ?? null });
export const TSQualifiedName = (s: number, e: number, _f: number, left: Node, right: Node): Node =>
    node(N.TSQualifiedName, s, e, '', { left, right });
export const TSTypeParameterInstantiation = (s: number, e: number, _f: number, params: Node[]): Node =>
    node(N.TSTypeParameterInstantiation, s, e, '', { params });
export const TSTypeParameterDeclaration = (s: number, e: number, _f: number, params: Node[]): Node =>
    node(N.TSTypeParameterDeclaration, s, e, '', { params });
export const TSTupleType = (s: number, e: number, _f: number, elementTypes: Node[]): Node =>
    node(N.TSTupleType, s, e, '', { elementTypes });
export const TSTypeLiteral = (s: number, e: number, _f: number, members: Node[]): Node =>
    node(N.TSTypeLiteral, s, e, '', { members });
export const TSCallSignatureDeclaration = (
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
    });
export const TSConstructSignatureDeclaration = (
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
    });
export const TSUnionType = (s: number, e: number, _f: number, types: Node[]): Node => node(N.TSUnionType, s, e, '', { types });
export const TSIntersectionType = (s: number, e: number, _f: number, types: Node[]): Node =>
    node(N.TSIntersectionType, s, e, '', { types });
export const TSFunctionType = (
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
    });
export const TSArrayType = (s: number, e: number, _f: number, elementType: Node): Node =>
    node(N.TSArrayType, s, e, '', { elementType });
export const TSIndexedAccessType = (s: number, e: number, _f: number, objectType: Node, indexType: Node): Node =>
    node(N.TSIndexedAccessType, s, e, '', { objectType, indexType });
export const TSTypeQuery = (s: number, e: number, _f: number, exprName: Node, typeArguments: Node | null): Node =>
    node(N.TSTypeQuery, s, e, '', { exprName, typeArguments: typeArguments ?? null });
export const TSConditionalType = (
    s: number,
    e: number,
    _f: number,
    checkType: Node,
    extendsType: Node,
    trueType: Node,
    falseType: Node,
): Node => node(N.TSConditionalType, s, e, '', { checkType, extendsType, trueType, falseType });
export const TSInferType = (s: number, e: number, _f: number, typeParameter: Node): Node =>
    node(N.TSInferType, s, e, '', { typeParameter });
export const TSLiteralType = (s: number, e: number, _f: number, literal: Node): Node =>
    node(N.TSLiteralType, s, e, '', { literal });
export const TSTemplateLiteralType = (s: number, e: number, _f: number, quasis: Node[], types: Node[]): Node =>
    node(N.TSTemplateLiteralType, s, e, '', { quasis, types });
export const TSImportType = (
    s: number,
    e: number,
    _f: number,
    source: Node,
    qualifier: Node | null,
    typeArguments: Node | null,
): Node => node(N.TSImportType, s, e, '', { source, qualifier: qualifier ?? null, typeArguments: typeArguments ?? null });
export const TSClassImplements = (s: number, e: number, _f: number, expression: Node, typeArguments: Node | null): Node =>
    node(N.TSClassImplements, s, e, '', { expression, typeArguments: typeArguments ?? null });
export const TSInterfaceHeritage = (s: number, e: number, _f: number, expression: Node, typeArguments: Node | null): Node =>
    node(N.TSInterfaceHeritage, s, e, '', { expression, typeArguments: typeArguments ?? null });
export const TSEnumMember = (s: number, e: number, _f: number, id: Node, initializer: Node | null): Node =>
    node(N.TSEnumMember, s, e, '', { id, initializer: initializer ?? null });
export const TSAsExpression = (s: number, e: number, _f: number, expression: Node, typeAnnotation: Node): Node =>
    node(N.TSAsExpression, s, e, '', { expression, typeAnnotation });
export const TSSatisfiesExpression = (s: number, e: number, _f: number, expression: Node, typeAnnotation: Node): Node =>
    node(N.TSSatisfiesExpression, s, e, '', { expression, typeAnnotation });
export const TSNonNullExpression = (s: number, e: number, _f: number, expression: Node): Node =>
    node(N.TSNonNullExpression, s, e, '', { expression });
export const TSInstantiationExpression = (s: number, e: number, _f: number, expression: Node, typeArguments: Node): Node =>
    node(N.TSInstantiationExpression, s, e, '', { expression, typeArguments });

export const JSXElement = (
    s: number,
    e: number,
    _f: number,
    openingElement: Node,
    children: Node[],
    closingElement: Node | null,
): Node => node(N.JSXElement, s, e, '', { openingElement, children, closingElement: closingElement ?? null });
export const JSXOpeningElement = (
    s: number,
    e: number,
    _f: number,
    name: Node,
    typeArguments: Node | null,
    attributes: Node[],
): Node => node(N.JSXOpeningElement, s, e, '', { name, typeArguments: typeArguments ?? null, attributes });
export const JSXClosingElement = (s: number, e: number, _f: number, name: Node): Node =>
    node(N.JSXClosingElement, s, e, '', { name });
export const JSXFragment = (
    s: number,
    e: number,
    _f: number,
    openingFragment: Node,
    children: Node[],
    closingFragment: Node,
): Node => node(N.JSXFragment, s, e, '', { openingFragment, children, closingFragment });
export const JSXOpeningFragment = (s: number, e: number, _f: number): Node => node(N.JSXOpeningFragment, s, e, '', null);
export const JSXClosingFragment = (s: number, e: number, _f: number): Node => node(N.JSXClosingFragment, s, e, '', null);
export const JSXNamespacedName = (s: number, e: number, _f: number, namespace: Node, name: Node): Node =>
    node(N.JSXNamespacedName, s, e, '', { namespace, name });
export const JSXMemberExpression = (s: number, e: number, _f: number, object: Node, property: Node): Node =>
    node(N.JSXMemberExpression, s, e, '', { object, property });
export const JSXExpressionContainer = (s: number, e: number, _f: number, expression: Node): Node =>
    node(N.JSXExpressionContainer, s, e, '', { expression });
export const JSXEmptyExpression = (s: number, e: number, _f: number): Node => node(N.JSXEmptyExpression, s, e, '', null);
export const JSXAttribute = (s: number, e: number, _f: number, name: Node, value: Node | null): Node =>
    node(N.JSXAttribute, s, e, '', { name, value: value ?? null });
export const JSXSpreadAttribute = (s: number, e: number, _f: number, argument: Node): Node =>
    node(N.JSXSpreadAttribute, s, e, '', { argument });
export const JSXSpreadChild = (s: number, e: number, _f: number, expression: Node): Node =>
    node(N.JSXSpreadChild, s, e, '', { expression });
