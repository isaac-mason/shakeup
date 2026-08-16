import { describe, expect, it } from 'vitest';
import {
    CHILD_FIELDS,
    N,
    NODE_TYPE_NAMES,
    TYPE_COUNT,
    isTypeOnlyNode,
    node,
    walk,
    walkChildren,
    type Node,
    type DataOf,
    type TypeName,
} from '../src/ast.ts';

/** Frozen name->id snapshot taken from the pre-migration enumeration. Pins that
 * the DEFS-derived ids are byte-for-byte identical to the old vocabulary and that
 * the derived type count did not drift. */
const ID_SNAPSHOT: Record<string, number> = {
    Program: 1, BindingIdentifier: 2, IdentifierReference: 3, IdentifierName: 4, LabelIdentifier: 5,
    PrivateIdentifier: 6, NumericLiteral: 7, StringLiteral: 8, BooleanLiteral: 9, NullLiteral: 10, RegExpLiteral: 11, BigIntLiteral: 12,
    TemplateElement: 13, ThisExpression: 14, Super: 15, ImportMeta: 16, NewTarget: 17,
    TemplateLiteral: 18, TaggedTemplateExpression: 19, ArrayExpression: 20, ObjectExpression: 21, ObjectProperty: 22, SpreadElement: 23,
    BinaryExpression: 24, LogicalExpression: 25, AssignmentExpression: 26, UnaryExpression: 27, UpdateExpression: 28, ConditionalExpression: 29, CallExpression: 30, NewExpression: 31,
    StaticMemberExpression: 32, ComputedMemberExpression: 33, PrivateFieldExpression: 34, ChainExpression: 35,
    SequenceExpression: 36, ArrowFunctionExpression: 37, FunctionExpression: 38, ClassExpression: 39, YieldExpression: 40, AwaitExpression: 41, ImportExpression: 42,
    ExpressionStatement: 43, VariableDeclaration: 44, VariableDeclarator: 45, BlockStatement: 46, IfStatement: 47, ForStatement: 48, ForInStatement: 49, ForOfStatement: 50,
    WhileStatement: 51, DoWhileStatement: 52, SwitchStatement: 53, SwitchCase: 54, TryStatement: 55, CatchClause: 56, ReturnStatement: 57, ThrowStatement: 58,
    BreakStatement: 59, ContinueStatement: 60, LabeledStatement: 61, EmptyStatement: 62, DebuggerStatement: 63, FunctionDeclaration: 64, ClassDeclaration: 65,
    MethodDefinition: 66, PropertyDefinition: 67, StaticBlock: 68,
    ObjectPattern: 69, ArrayPattern: 70, AssignmentPattern: 71, RestElement: 72, FormalParameter: 73,
    ImportDeclaration: 74, ImportSpecifier: 75, ImportDefaultSpecifier: 76, ImportNamespaceSpecifier: 77,
    ExportNamedDeclaration: 78, ExportSpecifier: 79, ExportDefaultDeclaration: 80, ExportAllDeclaration: 81,
    TSTypeAnnotation: 82,
    TSAnyKeyword: 83, TSStringKeyword: 84, TSNumberKeyword: 85, TSBooleanKeyword: 86, TSBigIntKeyword: 87,
    TSSymbolKeyword: 88, TSObjectKeyword: 89, TSVoidKeyword: 90, TSUndefinedKeyword: 91, TSNullKeyword: 92,
    TSNeverKeyword: 93, TSUnknownKeyword: 94, TSIntrinsicKeyword: 95, TSThisType: 96,
    TSTypeReference: 97, TSQualifiedName: 98, TSTypeParameterInstantiation: 99, TSTypeParameterDeclaration: 100,
    TSTypeParameter: 101, TSTupleType: 102, TSNamedTupleMember: 103, TSTypeLiteral: 104, TSPropertySignature: 105, TSMethodSignature: 106,
    TSIndexSignature: 107, TSCallSignatureDeclaration: 108, TSConstructSignatureDeclaration: 109, TSUnionType: 110, TSIntersectionType: 111, TSFunctionType: 112,
    TSConstructorType: 113, TSArrayType: 114, TSIndexedAccessType: 115, TSTypeOperator: 116, TSTypeQuery: 117,
    TSConditionalType: 118, TSInferType: 119, TSMappedType: 120, TSLiteralType: 121, TSTemplateLiteralType: 122,
    TSImportType: 123, TSInterfaceDeclaration: 124, TSClassImplements: 125, TSInterfaceHeritage: 126, TSTypeAliasDeclaration: 127, TSEnumDeclaration: 128,
    TSEnumMember: 129, TSAsExpression: 130, TSSatisfiesExpression: 131, TSNonNullExpression: 132, TSModuleDeclaration: 133,
    JSXElement: 134, JSXOpeningElement: 135, JSXClosingElement: 136, JSXFragment: 137, JSXOpeningFragment: 138, JSXClosingFragment: 139,
    JSXNamespacedName: 140, JSXMemberExpression: 141, JSXExpressionContainer: 142, JSXEmptyExpression: 143, JSXAttribute: 144, JSXSpreadAttribute: 145,
    JSXSpreadChild: 146, JSXIdentifier: 147, JSXText: 148,
};

describe('DEFS-derived numeric ids match the frozen pre-migration snapshot', () => {
    it('every name->id pair is byte-identical', () => {
        for (const [name, id] of Object.entries(ID_SNAPSHOT)) {
            expect(N[name as TypeName], name).toBe(id);
        }
    });
    it('the derived vocabulary has no extra or missing names', () => {
        expect(new Set(NODE_TYPE_NAMES)).toEqual(new Set(Object.keys(ID_SNAPSHOT)));
        expect(NODE_TYPE_NAMES.length).toBe(Object.keys(ID_SNAPSHOT).length);
    });
    it('TYPE_COUNT reserves slot 0 (= names + 1)', () => {
        expect(TYPE_COUNT).toBe(Object.keys(ID_SNAPSHOT).length + 1);
    });
});

/** Type-identity gate: DataOf<'X'> must be mutually assignable to the exact
 * old hand-written XData shape for the trickiest rows (literal-union scalars,
 * null-carrying scalars, listWithHoles, numeric mods). A drift makes the
 * corresponding assignment error at compile time. */
describe('DataOf<X> is structurally identical to the old *Data shapes', () => {
    type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    const assertEq = <T extends true>(): T => true as T;

    type OldObjectProperty = { key: Node; value: Node; kind: 'init' | 'get' | 'set'; computed: boolean; shorthand: boolean };
    type OldTSMappedType = { typeParameter: Node; nameType: Node | null; typeAnnotation: Node | null; readonlyMod: number; optionalMod: number };
    type OldFormalParameter = { pattern: Node; typeAnnotation: Node | null; init: Node | null; optional: boolean; readonly: boolean; accessibility: 'public' | 'private' | 'protected' | null };
    type OldImportSpecifier = { local: Node; imported: Node; importKind: 'value' | 'type' };
    type OldArrayExpression = { elements: (Node | null)[] };
    type OldMethodDefinition = { key: Node; value: Node; kind: 'method' | 'get' | 'set' | 'constructor'; static: boolean; computed: boolean; optional: boolean; abstract: boolean; accessibility: 'public' | 'private' | 'protected' | null };

    it('trickiest payloads round-trip exactly', () => {
        assertEq<Eq<DataOf<'ObjectProperty'>, OldObjectProperty>>();
        assertEq<Eq<DataOf<'TSMappedType'>, OldTSMappedType>>();
        assertEq<Eq<DataOf<'FormalParameter'>, OldFormalParameter>>();
        assertEq<Eq<DataOf<'ImportSpecifier'>, OldImportSpecifier>>();
        assertEq<Eq<DataOf<'ArrayExpression'>, OldArrayExpression>>();
        assertEq<Eq<DataOf<'MethodDefinition'>, OldMethodDefinition>>();
        assertEq<Eq<DataOf<'JSXText'>, null>>();
        expect(true).toBe(true);
    });
});

function synthetic(t: TypeName): { n: Node; expected: string[] } {
    const data: Record<string, unknown> = {};
    const expected: string[] = [];
    for (const spec of CHILD_FIELDS[t]) {
        if (spec.list) {
            const a = node(N.IdentifierReference, 0, 0, `${t}.${spec.name}.0`, null);
            const b = node(N.IdentifierReference, 0, 0, `${t}.${spec.name}.1`, null);
            data[spec.name] = [a, null, b];
            expected.push(a.name, b.name);
        } else {
            const c = node(N.IdentifierReference, 0, 0, `${t}.${spec.name}`, null);
            data[spec.name] = c;
            expected.push(c.name);
        }
    }
    const n = { id: 0, type: N[t], start: 0, end: 0, name: '', data } as unknown as Node;
    return { n, expected };
}

const interiorTypes = NODE_TYPE_NAMES.filter((t) => CHILD_FIELDS[t].length > 0);

describe('walk drift vs CHILD_FIELDS', () => {
    it('hand-switch walk visits every child field of every type, in schema order', () => {
        for (const t of interiorTypes) {
            const { n, expected } = synthetic(t);
            const seen: string[] = [];
            walk(n, (c) => { if (c.type === N.IdentifierReference) seen.push(c.name); });
            expect(seen, `walk cases for ${t}`).toEqual(expected);
        }
    });

    it('hand-switch walk and generic walkChildren agree on visitation order', () => {
        for (const t of interiorTypes) {
            const { n } = synthetic(t);
            const viaSwitch: string[] = [];
            walk(n, (c) => { if (c.type === N.IdentifierReference) viaSwitch.push(c.name); });
            const viaSchema: string[] = [];
            walkChildren(n, (c) => { viaSchema.push(c.name); });
            expect(viaSwitch, `oracle agreement for ${t}`).toEqual(viaSchema);
        }
    });

    it('tolerates all-null child fields and empty lists', () => {
        for (const t of interiorTypes) {
            const data: Record<string, unknown> = {};
            for (const spec of CHILD_FIELDS[t]) data[spec.name] = spec.list ? [] : null;
            const n = { id: 0, type: N[t], start: 0, end: 0, name: '', data } as unknown as Node;
            const seen: Node[] = [];
            walk(n, (c) => { seen.push(c); });
            expect(seen).toEqual([n]);
        }
    });

    it('enter=false skips children', () => {
        const { n } = synthetic('IfStatement');
        const seen: string[] = [];
        walk(n, (c) => { seen.push(c.name); return c.type === N.IfStatement ? false : undefined; });
        expect(seen).toEqual(['']);
    });
});

describe('isTypeOnlyNode range: keyword leaves + TSThisType vs value/runtime types', () => {
    const KEYWORD_LEAVES: TypeName[] = [
        'TSAnyKeyword', 'TSStringKeyword', 'TSNumberKeyword', 'TSBooleanKeyword', 'TSBigIntKeyword',
        'TSSymbolKeyword', 'TSObjectKeyword', 'TSVoidKeyword', 'TSUndefinedKeyword', 'TSNullKeyword',
        'TSNeverKeyword', 'TSUnknownKeyword', 'TSIntrinsicKeyword', 'TSThisType',
    ];

    it('the 14 keyword leaves (incl. TSThisType) are contiguous type ids', () => {
        const ids = KEYWORD_LEAVES.map((t) => N[t]);
        for (let i = 1; i < ids.length; i++) expect(ids[i]).toBe(ids[i - 1] + 1);
    });

    it('every keyword leaf classifies as type-only', () => {
        for (const t of KEYWORD_LEAVES) expect(isTypeOnlyNode(N[t]), t).toBe(true);
    });

    it('ImportMeta / NewTarget and value-wrapping TS exprs are NOT type-only', () => {
        for (const t of ['ImportMeta', 'NewTarget', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSEnumDeclaration', 'TSEnumMember', 'TSModuleDeclaration'] as TypeName[]) {
            expect(isTypeOnlyNode(N[t]), t).toBe(false);
        }
    });
});
