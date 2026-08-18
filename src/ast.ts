import { enumeration } from './util/enumeration';

type ChildSchema = { kind: 'child' };
const child: ChildSchema = { kind: 'child' };

type BooleanSchema = { kind: 'boolean' };
const boolean: BooleanSchema = { kind: 'boolean' };

type StringSchema = { kind: 'string' };
const string: StringSchema = { kind: 'string' };

type NumberSchema = { kind: 'number' };
const number: NumberSchema = { kind: 'number' };

type ScalarSchema<U> = { kind: 'scalar'; t?: U };
const scalar = <const U>(): ScalarSchema<U> => ({ kind: 'scalar' });

type NullableSchema<M> = { kind: 'nullable'; of: M };
const nullable = <const M extends PrimitiveSchema>(of: M): NullableSchema<M> => ({ kind: 'nullable', of });

type ListSchema<M> = { kind: 'list'; of: M };
const list = <const M extends ElementSchema>(of: M): ListSchema<M> => ({ kind: 'list', of });

type PrimitiveSchema = ChildSchema | BooleanSchema | StringSchema | NumberSchema | ScalarSchema<unknown>;

type ElementSchema = PrimitiveSchema | NullableSchema<PrimitiveSchema>;

type Schema = ElementSchema | ListSchema<ElementSchema>;

type Infer<M> =
    M extends NullableSchema<infer X>
        ? Infer<X> | null
        : M extends ListSchema<infer X>
          ? Infer<X>[]
          : M extends ScalarSchema<infer U>
            ? Exclude<U, undefined>
            : M extends ChildSchema
              ? Node
              : M extends BooleanSchema
                ? boolean
                : M extends StringSchema
                  ? string
                  : M extends NumberSchema
                    ? number
                    : never;
type NodeDef = Record<string, Schema> | null;
const def = <const Name extends string, const D extends NodeDef>(name: Name, fields: D): { name: Name; fields: D } => ({
    name,
    fields,
});

const DEFS = [
    def('Program', { body: list(child) }),
    def('BindingIdentifier', null),
    def('IdentifierReference', null),
    def('IdentifierName', null),
    def('LabelIdentifier', null),
    def('PrivateIdentifier', null),
    def('NumericLiteral', null),
    def('StringLiteral', null),
    def('BooleanLiteral', null),
    def('NullLiteral', null),
    def('RegExpLiteral', null),
    def('BigIntLiteral', null),
    def('TemplateElement', null),
    def('ThisExpression', null),
    def('Super', null),
    def('ImportMeta', null),
    def('NewTarget', null),
    def('TemplateLiteral', { quasis: list(child), expressions: list(child) }),
    def('TaggedTemplateExpression', { tag: child, quasi: child }),
    def('ArrayExpression', { elements: list(nullable(child)) }),
    def('ObjectExpression', { properties: list(child) }),
    def('ObjectProperty', {
        key: child,
        value: child,
        kind: scalar<'init' | 'get' | 'set'>(),
        computed: boolean,
        shorthand: boolean,
    }),
    def('SpreadElement', { argument: child }),
    def('BinaryExpression', { operator: string, left: child, right: child }),
    def('LogicalExpression', { operator: string, left: child, right: child }),
    def('AssignmentExpression', { operator: string, left: child, right: child }),
    def('UnaryExpression', { operator: string, prefix: boolean, argument: child }),
    def('UpdateExpression', { operator: string, prefix: boolean, argument: child }),
    def('ConditionalExpression', { test: child, consequent: child, alternate: child }),
    def('CallExpression', { callee: child, arguments: list(child), optional: boolean, typeArguments: nullable(child) }),
    def('NewExpression', { callee: child, arguments: list(child), typeArguments: nullable(child) }),
    def('StaticMemberExpression', { object: child, property: child, optional: boolean }),
    def('ComputedMemberExpression', { object: child, expression: child, optional: boolean }),
    def('PrivateFieldExpression', { object: child, field: child, optional: boolean }),
    def('ChainExpression', { expression: child }),
    def('SequenceExpression', { expressions: list(child) }),
    def('ArrowFunctionExpression', {
        typeParameters: nullable(child),
        params: list(child),
        returnType: nullable(child),
        body: child,
        async: boolean,
        expression: boolean,
    }),
    def('FunctionExpression', {
        id: nullable(child),
        typeParameters: nullable(child),
        params: list(child),
        returnType: nullable(child),
        body: nullable(child),
        async: boolean,
        generator: boolean,
    }),
    def('ClassExpression', {
        id: nullable(child),
        typeParameters: nullable(child),
        superClass: nullable(child),
        superTypeArguments: nullable(child),
        implements: list(child),
        body: list(child),
    }),
    def('YieldExpression', { argument: nullable(child), delegate: boolean }),
    def('AwaitExpression', { argument: child }),
    def('ImportExpression', { source: child, options: nullable(child) }),
    def('ExpressionStatement', { expression: child }),
    def('VariableDeclaration', { declarations: list(child), kind: scalar<'var' | 'let' | 'const'>(), declare: boolean }),
    def('VariableDeclarator', { id: child, typeAnnotation: nullable(child), init: nullable(child), definite: boolean }),
    def('BlockStatement', { body: list(child) }),
    def('IfStatement', { test: child, consequent: child, alternate: nullable(child) }),
    def('ForStatement', { init: nullable(child), test: nullable(child), update: nullable(child), body: child }),
    def('ForInStatement', { left: child, right: child, body: child }),
    def('ForOfStatement', { left: child, right: child, body: child, await: boolean }),
    def('WhileStatement', { test: child, body: child }),
    def('DoWhileStatement', { body: child, test: child }),
    def('SwitchStatement', { discriminant: child, cases: list(child) }),
    def('SwitchCase', { test: nullable(child), consequent: list(child) }),
    def('TryStatement', { block: child, handler: nullable(child), finalizer: nullable(child) }),
    def('CatchClause', { param: nullable(child), body: child }),
    def('ReturnStatement', { argument: nullable(child) }),
    def('ThrowStatement', { argument: child }),
    def('BreakStatement', { label: nullable(child) }),
    def('ContinueStatement', { label: nullable(child) }),
    def('LabeledStatement', { label: child, body: child }),
    def('EmptyStatement', null),
    def('DebuggerStatement', null),
    def('FunctionDeclaration', {
        id: nullable(child),
        typeParameters: nullable(child),
        params: list(child),
        returnType: nullable(child),
        body: nullable(child),
        async: boolean,
        generator: boolean,
        declare: boolean,
    }),
    def('ClassDeclaration', {
        id: nullable(child),
        typeParameters: nullable(child),
        superClass: nullable(child),
        superTypeArguments: nullable(child),
        implements: list(child),
        body: list(child),
        abstract: boolean,
        declare: boolean,
    }),
    def('MethodDefinition', {
        key: child,
        value: child,
        kind: scalar<'method' | 'get' | 'set' | 'constructor'>(),
        static: boolean,
        computed: boolean,
        optional: boolean,
        abstract: boolean,
        accessibility: scalar<Accessibility>(),
    }),
    def('PropertyDefinition', {
        key: child,
        typeAnnotation: nullable(child),
        value: nullable(child),
        static: boolean,
        computed: boolean,
        readonly: boolean,
        optional: boolean,
        definite: boolean,
        declare: boolean,
        abstract: boolean,
        accessibility: scalar<Accessibility>(),
    }),
    def('StaticBlock', { body: list(child) }),
    def('ObjectPattern', { properties: list(child) }),
    def('ArrayPattern', { elements: list(nullable(child)) }),
    def('AssignmentPattern', { left: child, right: child }),
    def('RestElement', { argument: child, typeAnnotation: nullable(child) }),
    def('FormalParameter', {
        pattern: child,
        typeAnnotation: nullable(child),
        init: nullable(child),
        optional: boolean,
        readonly: boolean,
        accessibility: scalar<Accessibility>(),
    }),
    def('ImportDeclaration', { specifiers: list(child), source: child, importKind: scalar<'value' | 'type'>() }),
    def('ImportSpecifier', { local: child, imported: child, importKind: scalar<'value' | 'type'>() }),
    def('ImportDefaultSpecifier', { local: child }),
    def('ImportNamespaceSpecifier', { local: child }),
    def('ExportNamedDeclaration', {
        declaration: nullable(child),
        specifiers: list(child),
        source: nullable(child),
        exportKind: scalar<'value' | 'type'>(),
    }),
    def('ExportSpecifier', { local: child, exported: child, exportKind: scalar<'value' | 'type'>() }),
    def('ExportDefaultDeclaration', { declaration: child }),
    def('ExportAllDeclaration', { source: child, exported: nullable(child) }),
    def('TSTypeAnnotation', { typeAnnotation: child }),
    def('TSAnyKeyword', null),
    def('TSStringKeyword', null),
    def('TSNumberKeyword', null),
    def('TSBooleanKeyword', null),
    def('TSBigIntKeyword', null),
    def('TSSymbolKeyword', null),
    def('TSObjectKeyword', null),
    def('TSVoidKeyword', null),
    def('TSUndefinedKeyword', null),
    def('TSNullKeyword', null),
    def('TSNeverKeyword', null),
    def('TSUnknownKeyword', null),
    def('TSIntrinsicKeyword', null),
    def('TSThisType', null),
    def('TSTypeReference', { typeName: child, typeArguments: nullable(child) }),
    def('TSQualifiedName', { left: child, right: child }),
    def('TSTypeParameterInstantiation', { params: list(child) }),
    def('TSTypeParameterDeclaration', { params: list(child) }),
    def('TSTypeParameter', {
        name: child,
        constraint: nullable(child),
        default: nullable(child),
        in: boolean,
        out: boolean,
        const: boolean,
    }),
    def('TSTupleType', { elementTypes: list(child) }),
    def('TSNamedTupleMember', { label: child, elementType: child, optional: boolean }),
    def('TSTypeLiteral', { members: list(child) }),
    def('TSPropertySignature', {
        key: child,
        typeAnnotation: nullable(child),
        optional: boolean,
        readonly: boolean,
        computed: boolean,
    }),
    def('TSMethodSignature', {
        key: child,
        typeParameters: nullable(child),
        params: list(child),
        returnType: nullable(child),
        optional: boolean,
        kind: scalar<'method' | 'get' | 'set'>(),
        computed: boolean,
    }),
    def('TSIndexSignature', { parameter: child, typeAnnotation: nullable(child), readonly: boolean }),
    def('TSCallSignatureDeclaration', { typeParameters: nullable(child), params: list(child), returnType: nullable(child) }),
    def('TSConstructSignatureDeclaration', { typeParameters: nullable(child), params: list(child), returnType: nullable(child) }),
    def('TSUnionType', { types: list(child) }),
    def('TSIntersectionType', { types: list(child) }),
    def('TSFunctionType', { typeParameters: nullable(child), params: list(child), returnType: nullable(child) }),
    def('TSConstructorType', {
        typeParameters: nullable(child),
        params: list(child),
        returnType: nullable(child),
        abstract: boolean,
    }),
    def('TSArrayType', { elementType: child }),
    def('TSIndexedAccessType', { objectType: child, indexType: child }),
    def('TSTypeOperator', { operator: string, typeAnnotation: child }),
    def('TSTypeQuery', { exprName: child, typeArguments: nullable(child) }),
    def('TSConditionalType', { checkType: child, extendsType: child, trueType: child, falseType: child }),
    def('TSInferType', { typeParameter: child }),
    def('TSMappedType', {
        typeParameter: child,
        nameType: nullable(child),
        typeAnnotation: nullable(child),
        readonlyMod: number,
        optionalMod: number,
    }),
    def('TSLiteralType', { literal: child }),
    def('TSTemplateLiteralType', { quasis: list(child), types: list(child) }),
    def('TSImportType', { source: child, qualifier: nullable(child), typeArguments: nullable(child) }),
    def('TSInterfaceDeclaration', {
        id: child,
        typeParameters: nullable(child),
        extends: list(child),
        body: list(child),
        declare: boolean,
    }),
    def('TSClassImplements', { expression: child, typeArguments: nullable(child) }),
    def('TSInterfaceHeritage', { expression: child, typeArguments: nullable(child) }),
    def('TSTypeAliasDeclaration', { id: child, typeParameters: nullable(child), typeAnnotation: child, declare: boolean }),
    def('TSEnumDeclaration', { id: child, members: list(child), const: boolean, declare: boolean }),
    def('TSEnumMember', { id: child, initializer: nullable(child) }),
    def('TSAsExpression', { expression: child, typeAnnotation: child }),
    def('TSSatisfiesExpression', { expression: child, typeAnnotation: child }),
    def('TSNonNullExpression', { expression: child }),
    def('TSModuleDeclaration', { id: child, body: list(child), declare: boolean, namespace: boolean }),
    def('JSXElement', { openingElement: child, children: list(child), closingElement: nullable(child) }),
    def('JSXOpeningElement', { name: child, typeArguments: nullable(child), attributes: list(child) }),
    def('JSXClosingElement', { name: child }),
    def('JSXFragment', { openingFragment: child, children: list(child), closingFragment: child }),
    def('JSXOpeningFragment', null),
    def('JSXClosingFragment', null),
    def('JSXNamespacedName', { namespace: child, name: child }),
    def('JSXMemberExpression', { object: child, property: child }),
    def('JSXExpressionContainer', { expression: child }),
    def('JSXEmptyExpression', null),
    def('JSXAttribute', { name: child, value: nullable(child) }),
    def('JSXSpreadAttribute', { argument: child }),
    def('JSXSpreadChild', { expression: child }),
    def('JSXIdentifier', null),
    def('JSXText', null),
    // Ids are append-only, so new node types go at the end. An expression, so it
    // sits outside the isTypeOnlyNode / isJSXNode id ranges.
    def('TSInstantiationExpression', { expression: child, typeArguments: child }),
] as const;

type Defs = typeof DEFS;
type DefOf<T extends TypeName> = Extract<Defs[number], { name: T }>;

// Payload fields are mutable: the AST is the mutable IR (passes rewrite nodes in place). `-readonly`
// strips the readonly the `as const` DEFS would otherwise propagate.
type PayloadOf<D extends NodeDef> = D extends null ? null : { -readonly [K in keyof D]: D[K] extends Schema ? Infer<D[K]> : never } & {};

export type TypeName = Defs[number]['name'];

type IdsOf<
    D extends readonly { name: string }[],
    Acc = unknown,
    Len extends readonly unknown[] = [unknown],
> = D extends readonly [infer H extends { name: string }, ...infer R extends readonly { name: string }[]]
    ? IdsOf<R, Acc & Record<H['name'], Len['length']>, [...Len, unknown]>
    : { [K in keyof Acc]: Acc[K] };
type IdMap = IdsOf<Defs>;
type IdOf<T extends TypeName> = T extends keyof IdMap ? IdMap[T] & number : never;

export const NODE_TYPE_NAMES: readonly TypeName[] = DEFS.map((d) => d.name);

export const N = enumeration(...NODE_TYPE_NAMES) as { readonly [T in TypeName]: IdOf<T> };

export const TYPE_COUNT = NODE_TYPE_NAMES.length + 1;
export const TYPE_NAME: readonly string[] = ['<null>', ...NODE_TYPE_NAMES];

export const isTypeOnlyNode = (type: number): boolean => {
    if (type === N.TSInterfaceDeclaration || type === N.TSTypeAliasDeclaration) return true;
    return type >= N.TSTypeAnnotation && type <= N.TSInterfaceHeritage;
};

export const isIdentifier = (type: number): boolean => type >= N.BindingIdentifier && type <= N.LabelIdentifier;

export const isJSXNode = (type: number): boolean => type >= N.JSXElement && type <= N.JSXText;

export type Accessibility = 'public' | 'private' | 'protected' | null;

export type DataOf<T extends TypeName> = PayloadOf<DefOf<T>['fields']>;

export type NodeOf<T extends TypeName> = {
    id: number;
    type: IdOf<T>;
    start: number;
    end: number;
    name: string;
    data: DataOf<T>;
};

export type Node = { [T in TypeName]: NodeOf<T> }[TypeName];

export type NodeType = IdOf<TypeName>;

export type Program = NodeOf<'Program'>;
export type BindingIdentifier = NodeOf<'BindingIdentifier'>;
export type IdentifierReference = NodeOf<'IdentifierReference'>;
export type IdentifierName = NodeOf<'IdentifierName'>;
export type LabelIdentifier = NodeOf<'LabelIdentifier'>;

type FieldSpec = { name: string; list: boolean };

type HoldsChild<M> = M extends ChildSchema
    ? true
    : M extends NullableSchema<infer X>
      ? HoldsChild<X>
      : M extends ListSchema<infer X>
        ? HoldsChild<X>
        : false;

type ChildFieldNames<D extends NodeDef> = D extends null
    ? never
    : { [K in keyof D]: HoldsChild<D[K]> extends true ? K & string : never }[keyof D];

const baseOf = (m: Schema): Schema => (m.kind === 'nullable' || m.kind === 'list' ? baseOf(m.of) : m);
const holdsChild = (m: Schema): boolean => baseOf(m).kind === 'child';
const isList = (m: Schema): boolean => m.kind === 'list' || (m.kind === 'nullable' && isList(m.of));

/** child fields per type, in def (walk) order */
export const CHILD_FIELDS = Object.fromEntries(
    DEFS.map((d) => [
        d.name,
        d.fields === null
            ? []
            : Object.entries(d.fields)
                  .filter(([, m]) => holdsChild(m as Schema))
                  .map(([name, m]) => ({ name, list: isList(m as Schema) })),
    ]),
) as { [T in TypeName]: { name: ChildFieldNames<DefOf<T>['fields']>; list: boolean }[] };

const FIELDS: FieldSpec[][] = new Array(TYPE_COUNT);
for (const t of NODE_TYPE_NAMES) FIELDS[N[t]] = CHILD_FIELDS[t] as FieldSpec[];

export function lineColOf(lines: Uint32Array, offset: number): { line: number; column: number } {
    let lo = 0,
        hi = lines.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lines[mid] <= offset) lo = mid;
        else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lines[lo] };
}

const payload = (n: Node): Record<string, unknown> | null => n.data as Record<string, unknown> | null;

type DataForId<Id extends NodeType> = { [T in TypeName]: IdOf<T> extends Id ? DataOf<T> : never }[TypeName];

let idCounter = 0;
/** globally unique, never reset — ids are unique across parses and clones */
export const allocId = (): number => ++idCounter;

export function node<Id extends NodeType>(type: Id, start: number, end: number, name: string, data: DataForId<Id>): Node {
    return { id: allocId(), type, start, end, name, data } as Node;
}

/** index-aware walk of direct children (`listIndex` -1 for a direct slot) */
export function walkChildren(n: Node, cb: (child: Node, field: string, listIndex: number) => boolean | void): void {
    const fields = FIELDS[n.type];
    const data = payload(n);
    if (data === null) return;
    for (let i = 0; i < fields.length; i++) {
        const v = data[fields[i].name];
        if (v == null) continue;
        if (fields[i].list) {
            const arr = v as (Node | null)[];
            for (let j = 0; j < arr.length; j++) {
                const c = arr[j];
                if (c != null && cb(c, fields[i].name, j) === false) return;
            }
        } else if (cb(v as Node, fields[i].name, -1) === false) return;
    }
}

/**
 * Like {@link walkChildren} but the callback may MUTATE the slot: return a Node to replace the
 * child, `null` to drop it (list slots compact; a direct slot is set null — only valid where the
 * field is nullable), or `undefined` to leave it. The substrate for AST-as-IR mutation passes.
 */
export function mutateChildren(n: Node, cb: (child: Node, field: string, listIndex: number) => Node | null | undefined): void {
    const fields = FIELDS[n.type];
    const data = payload(n);
    if (data === null) return;
    for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const v = data[f.name];
        if (v == null) continue;
        if (f.list) {
            const arr = v as (Node | null)[];
            let w = 0;
            for (let j = 0; j < arr.length; j++) {
                const c = arr[j];
                if (c == null) {
                    arr[w++] = c;
                    continue;
                }
                const r = cb(c, f.name, j);
                if (r === null) continue; // drop
                arr[w++] = r === undefined ? c : r;
            }
            arr.length = w;
        } else {
            const r = cb(v as Node, f.name, -1);
            if (r !== undefined) (data as Record<string, unknown>)[f.name] = r;
        }
    }
}

/** Depth-first pre-order walk. `enter` may return false to skip the subtree. */
export function walk(n: Node, enter: (n: Node) => boolean | void): void {
    if (enter(n) === false) return;
    const d = payload(n);
    if (d === null) return;
    switch (n.type) {
        case N.Program:
            {
                const l = d.body as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.TemplateLiteral:
            {
                const l = d.quasis as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            {
                const l = d.expressions as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.TaggedTemplateExpression:
            if (d.tag != null) walk(d.tag as Node, enter);
            if (d.quasi != null) walk(d.quasi as Node, enter);
            break;
        case N.ArrayExpression:
            {
                const l = d.elements as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.ObjectExpression:
            {
                const l = d.properties as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.ObjectProperty:
            if (d.key != null) walk(d.key as Node, enter);
            if (d.value != null) walk(d.value as Node, enter);
            break;
        case N.SpreadElement:
            if (d.argument != null) walk(d.argument as Node, enter);
            break;
        case N.BinaryExpression:
            if (d.left != null) walk(d.left as Node, enter);
            if (d.right != null) walk(d.right as Node, enter);
            break;
        case N.LogicalExpression:
            if (d.left != null) walk(d.left as Node, enter);
            if (d.right != null) walk(d.right as Node, enter);
            break;
        case N.AssignmentExpression:
            if (d.left != null) walk(d.left as Node, enter);
            if (d.right != null) walk(d.right as Node, enter);
            break;
        case N.UnaryExpression:
            if (d.argument != null) walk(d.argument as Node, enter);
            break;
        case N.UpdateExpression:
            if (d.argument != null) walk(d.argument as Node, enter);
            break;
        case N.ConditionalExpression:
            if (d.test != null) walk(d.test as Node, enter);
            if (d.consequent != null) walk(d.consequent as Node, enter);
            if (d.alternate != null) walk(d.alternate as Node, enter);
            break;
        case N.CallExpression:
            if (d.callee != null) walk(d.callee as Node, enter);
            {
                const l = d.arguments as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            if (d.typeArguments != null) walk(d.typeArguments as Node, enter);
            break;
        case N.NewExpression:
            if (d.callee != null) walk(d.callee as Node, enter);
            {
                const l = d.arguments as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            if (d.typeArguments != null) walk(d.typeArguments as Node, enter);
            break;
        case N.StaticMemberExpression:
            if (d.object != null) walk(d.object as Node, enter);
            if (d.property != null) walk(d.property as Node, enter);
            break;
        case N.ComputedMemberExpression:
            if (d.object != null) walk(d.object as Node, enter);
            if (d.expression != null) walk(d.expression as Node, enter);
            break;
        case N.PrivateFieldExpression:
            if (d.object != null) walk(d.object as Node, enter);
            if (d.field != null) walk(d.field as Node, enter);
            break;
        case N.ChainExpression:
            if (d.expression != null) walk(d.expression as Node, enter);
            break;
        case N.SequenceExpression:
            {
                const l = d.expressions as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.ArrowFunctionExpression:
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter);
            {
                const l = d.params as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            if (d.returnType != null) walk(d.returnType as Node, enter);
            if (d.body != null) walk(d.body as Node, enter);
            break;
        case N.FunctionExpression:
            if (d.id != null) walk(d.id as Node, enter);
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter);
            {
                const l = d.params as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            if (d.returnType != null) walk(d.returnType as Node, enter);
            if (d.body != null) walk(d.body as Node, enter);
            break;
        case N.ClassExpression:
            if (d.id != null) walk(d.id as Node, enter);
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter);
            if (d.superClass != null) walk(d.superClass as Node, enter);
            if (d.superTypeArguments != null) walk(d.superTypeArguments as Node, enter);
            {
                const l = d.implements as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            {
                const l = d.body as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.YieldExpression:
            if (d.argument != null) walk(d.argument as Node, enter);
            break;
        case N.AwaitExpression:
            if (d.argument != null) walk(d.argument as Node, enter);
            break;
        case N.ImportExpression:
            if (d.source != null) walk(d.source as Node, enter);
            if (d.options != null) walk(d.options as Node, enter);
            break;
        case N.ExpressionStatement:
            if (d.expression != null) walk(d.expression as Node, enter);
            break;
        case N.VariableDeclaration:
            {
                const l = d.declarations as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.VariableDeclarator:
            if (d.id != null) walk(d.id as Node, enter);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter);
            if (d.init != null) walk(d.init as Node, enter);
            break;
        case N.BlockStatement:
            {
                const l = d.body as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.IfStatement:
            if (d.test != null) walk(d.test as Node, enter);
            if (d.consequent != null) walk(d.consequent as Node, enter);
            if (d.alternate != null) walk(d.alternate as Node, enter);
            break;
        case N.ForStatement:
            if (d.init != null) walk(d.init as Node, enter);
            if (d.test != null) walk(d.test as Node, enter);
            if (d.update != null) walk(d.update as Node, enter);
            if (d.body != null) walk(d.body as Node, enter);
            break;
        case N.ForInStatement:
            if (d.left != null) walk(d.left as Node, enter);
            if (d.right != null) walk(d.right as Node, enter);
            if (d.body != null) walk(d.body as Node, enter);
            break;
        case N.ForOfStatement:
            if (d.left != null) walk(d.left as Node, enter);
            if (d.right != null) walk(d.right as Node, enter);
            if (d.body != null) walk(d.body as Node, enter);
            break;
        case N.WhileStatement:
            if (d.test != null) walk(d.test as Node, enter);
            if (d.body != null) walk(d.body as Node, enter);
            break;
        case N.DoWhileStatement:
            if (d.body != null) walk(d.body as Node, enter);
            if (d.test != null) walk(d.test as Node, enter);
            break;
        case N.SwitchStatement:
            if (d.discriminant != null) walk(d.discriminant as Node, enter);
            {
                const l = d.cases as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.SwitchCase:
            if (d.test != null) walk(d.test as Node, enter);
            {
                const l = d.consequent as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.TryStatement:
            if (d.block != null) walk(d.block as Node, enter);
            if (d.handler != null) walk(d.handler as Node, enter);
            if (d.finalizer != null) walk(d.finalizer as Node, enter);
            break;
        case N.CatchClause:
            if (d.param != null) walk(d.param as Node, enter);
            if (d.body != null) walk(d.body as Node, enter);
            break;
        case N.ReturnStatement:
            if (d.argument != null) walk(d.argument as Node, enter);
            break;
        case N.ThrowStatement:
            if (d.argument != null) walk(d.argument as Node, enter);
            break;
        case N.BreakStatement:
            if (d.label != null) walk(d.label as Node, enter);
            break;
        case N.ContinueStatement:
            if (d.label != null) walk(d.label as Node, enter);
            break;
        case N.LabeledStatement:
            if (d.label != null) walk(d.label as Node, enter);
            if (d.body != null) walk(d.body as Node, enter);
            break;
        case N.FunctionDeclaration:
            if (d.id != null) walk(d.id as Node, enter);
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter);
            {
                const l = d.params as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            if (d.returnType != null) walk(d.returnType as Node, enter);
            if (d.body != null) walk(d.body as Node, enter);
            break;
        case N.ClassDeclaration:
            if (d.id != null) walk(d.id as Node, enter);
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter);
            if (d.superClass != null) walk(d.superClass as Node, enter);
            if (d.superTypeArguments != null) walk(d.superTypeArguments as Node, enter);
            {
                const l = d.implements as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            {
                const l = d.body as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.MethodDefinition:
            if (d.key != null) walk(d.key as Node, enter);
            if (d.value != null) walk(d.value as Node, enter);
            break;
        case N.PropertyDefinition:
            if (d.key != null) walk(d.key as Node, enter);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter);
            if (d.value != null) walk(d.value as Node, enter);
            break;
        case N.StaticBlock:
            {
                const l = d.body as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.ObjectPattern:
            {
                const l = d.properties as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.ArrayPattern:
            {
                const l = d.elements as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.AssignmentPattern:
            if (d.left != null) walk(d.left as Node, enter);
            if (d.right != null) walk(d.right as Node, enter);
            break;
        case N.RestElement:
            if (d.argument != null) walk(d.argument as Node, enter);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter);
            break;
        case N.FormalParameter:
            if (d.pattern != null) walk(d.pattern as Node, enter);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter);
            if (d.init != null) walk(d.init as Node, enter);
            break;
        case N.ImportDeclaration:
            {
                const l = d.specifiers as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            if (d.source != null) walk(d.source as Node, enter);
            break;
        case N.ImportSpecifier:
            if (d.local != null) walk(d.local as Node, enter);
            if (d.imported != null) walk(d.imported as Node, enter);
            break;
        case N.ImportDefaultSpecifier:
            if (d.local != null) walk(d.local as Node, enter);
            break;
        case N.ImportNamespaceSpecifier:
            if (d.local != null) walk(d.local as Node, enter);
            break;
        case N.ExportNamedDeclaration:
            if (d.declaration != null) walk(d.declaration as Node, enter);
            {
                const l = d.specifiers as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            if (d.source != null) walk(d.source as Node, enter);
            break;
        case N.ExportSpecifier:
            if (d.local != null) walk(d.local as Node, enter);
            if (d.exported != null) walk(d.exported as Node, enter);
            break;
        case N.ExportDefaultDeclaration:
            if (d.declaration != null) walk(d.declaration as Node, enter);
            break;
        case N.ExportAllDeclaration:
            if (d.source != null) walk(d.source as Node, enter);
            if (d.exported != null) walk(d.exported as Node, enter);
            break;
        case N.TSTypeAnnotation:
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter);
            break;
        case N.TSTypeReference:
            if (d.typeName != null) walk(d.typeName as Node, enter);
            if (d.typeArguments != null) walk(d.typeArguments as Node, enter);
            break;
        case N.TSQualifiedName:
            if (d.left != null) walk(d.left as Node, enter);
            if (d.right != null) walk(d.right as Node, enter);
            break;
        case N.TSTypeParameterInstantiation:
            {
                const l = d.params as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.TSTypeParameterDeclaration:
            {
                const l = d.params as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.TSTypeParameter:
            if (d.name != null) walk(d.name as Node, enter);
            if (d.constraint != null) walk(d.constraint as Node, enter);
            if (d.default != null) walk(d.default as Node, enter);
            break;
        case N.TSTupleType:
            {
                const l = d.elementTypes as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.TSNamedTupleMember:
            if (d.label != null) walk(d.label as Node, enter);
            if (d.elementType != null) walk(d.elementType as Node, enter);
            break;
        case N.TSTypeLiteral:
            {
                const l = d.members as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.TSPropertySignature:
            if (d.key != null) walk(d.key as Node, enter);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter);
            break;
        case N.TSMethodSignature:
            if (d.key != null) walk(d.key as Node, enter);
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter);
            {
                const l = d.params as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            if (d.returnType != null) walk(d.returnType as Node, enter);
            break;
        case N.TSIndexSignature:
            if (d.parameter != null) walk(d.parameter as Node, enter);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter);
            break;
        case N.TSCallSignatureDeclaration:
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter);
            {
                const l = d.params as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            if (d.returnType != null) walk(d.returnType as Node, enter);
            break;
        case N.TSConstructSignatureDeclaration:
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter);
            {
                const l = d.params as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            if (d.returnType != null) walk(d.returnType as Node, enter);
            break;
        case N.TSUnionType:
            {
                const l = d.types as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.TSIntersectionType:
            {
                const l = d.types as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.TSFunctionType:
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter);
            {
                const l = d.params as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            if (d.returnType != null) walk(d.returnType as Node, enter);
            break;
        case N.TSConstructorType:
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter);
            {
                const l = d.params as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            if (d.returnType != null) walk(d.returnType as Node, enter);
            break;
        case N.TSArrayType:
            if (d.elementType != null) walk(d.elementType as Node, enter);
            break;
        case N.TSIndexedAccessType:
            if (d.objectType != null) walk(d.objectType as Node, enter);
            if (d.indexType != null) walk(d.indexType as Node, enter);
            break;
        case N.TSTypeOperator:
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter);
            break;
        case N.TSTypeQuery:
            if (d.exprName != null) walk(d.exprName as Node, enter);
            if (d.typeArguments != null) walk(d.typeArguments as Node, enter);
            break;
        case N.TSConditionalType:
            if (d.checkType != null) walk(d.checkType as Node, enter);
            if (d.extendsType != null) walk(d.extendsType as Node, enter);
            if (d.trueType != null) walk(d.trueType as Node, enter);
            if (d.falseType != null) walk(d.falseType as Node, enter);
            break;
        case N.TSInferType:
            if (d.typeParameter != null) walk(d.typeParameter as Node, enter);
            break;
        case N.TSMappedType:
            if (d.typeParameter != null) walk(d.typeParameter as Node, enter);
            if (d.nameType != null) walk(d.nameType as Node, enter);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter);
            break;
        case N.TSLiteralType:
            if (d.literal != null) walk(d.literal as Node, enter);
            break;
        case N.TSTemplateLiteralType:
            {
                const l = d.quasis as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            {
                const l = d.types as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.TSImportType:
            if (d.source != null) walk(d.source as Node, enter);
            if (d.qualifier != null) walk(d.qualifier as Node, enter);
            if (d.typeArguments != null) walk(d.typeArguments as Node, enter);
            break;
        case N.TSInterfaceDeclaration:
            if (d.id != null) walk(d.id as Node, enter);
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter);
            {
                const l = d.extends as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            {
                const l = d.body as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.TSClassImplements:
            if (d.expression != null) walk(d.expression as Node, enter);
            if (d.typeArguments != null) walk(d.typeArguments as Node, enter);
            break;
        case N.TSInterfaceHeritage:
            if (d.expression != null) walk(d.expression as Node, enter);
            if (d.typeArguments != null) walk(d.typeArguments as Node, enter);
            break;
        case N.TSTypeAliasDeclaration:
            if (d.id != null) walk(d.id as Node, enter);
            if (d.typeParameters != null) walk(d.typeParameters as Node, enter);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter);
            break;
        case N.TSEnumDeclaration:
            if (d.id != null) walk(d.id as Node, enter);
            {
                const l = d.members as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.TSEnumMember:
            if (d.id != null) walk(d.id as Node, enter);
            if (d.initializer != null) walk(d.initializer as Node, enter);
            break;
        case N.TSAsExpression:
            if (d.expression != null) walk(d.expression as Node, enter);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter);
            break;
        case N.TSSatisfiesExpression:
            if (d.expression != null) walk(d.expression as Node, enter);
            if (d.typeAnnotation != null) walk(d.typeAnnotation as Node, enter);
            break;
        case N.TSNonNullExpression:
            if (d.expression != null) walk(d.expression as Node, enter);
            break;
        case N.TSInstantiationExpression:
            if (d.expression != null) walk(d.expression as Node, enter);
            if (d.typeArguments != null) walk(d.typeArguments as Node, enter);
            break;
        case N.TSModuleDeclaration:
            if (d.id != null) walk(d.id as Node, enter);
            {
                const l = d.body as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.JSXElement:
            if (d.openingElement != null) walk(d.openingElement as Node, enter);
            {
                const l = d.children as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            if (d.closingElement != null) walk(d.closingElement as Node, enter);
            break;
        case N.JSXOpeningElement:
            if (d.name != null) walk(d.name as Node, enter);
            if (d.typeArguments != null) walk(d.typeArguments as Node, enter);
            {
                const l = d.attributes as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            break;
        case N.JSXClosingElement:
            if (d.name != null) walk(d.name as Node, enter);
            break;
        case N.JSXFragment:
            if (d.openingFragment != null) walk(d.openingFragment as Node, enter);
            {
                const l = d.children as (Node | null)[];
                for (let i = 0; i < l.length; i++) {
                    const c = l[i];
                    if (c != null) walk(c, enter);
                }
            }
            if (d.closingFragment != null) walk(d.closingFragment as Node, enter);
            break;
        case N.JSXNamespacedName:
            if (d.namespace != null) walk(d.namespace as Node, enter);
            if (d.name != null) walk(d.name as Node, enter);
            break;
        case N.JSXMemberExpression:
            if (d.object != null) walk(d.object as Node, enter);
            if (d.property != null) walk(d.property as Node, enter);
            break;
        case N.JSXExpressionContainer:
            if (d.expression != null) walk(d.expression as Node, enter);
            break;
        case N.JSXAttribute:
            if (d.name != null) walk(d.name as Node, enter);
            if (d.value != null) walk(d.value as Node, enter);
            break;
        case N.JSXSpreadAttribute:
            if (d.argument != null) walk(d.argument as Node, enter);
            break;
        case N.JSXSpreadChild:
            if (d.expression != null) walk(d.expression as Node, enter);
            break;
    }
}

export function cloneNode(n: Node | null, substitute?: (n: Node) => Node | null): Node | null {
    if (n === null) return null;
    if (substitute) {
        const sub = substitute(n);
        if (sub !== null) return sub;
    }
    const id = n.type;
    const srcData = payload(n);
    if (srcData === null) return rebuild(id, n.start, n.end, n.name, null);
    const fields = FIELDS[id];
    const outData: Record<string, unknown> = { ...srcData };
    for (let i = 0; i < fields.length; i++) {
        const spec = fields[i];
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
    return rebuild(id, n.start, n.end, n.name, outData);
}

function rebuild(type: number, start: number, end: number, name: string, data: unknown): Node {
    return { id: allocId(), type, start, end, name, data } as Node;
}
