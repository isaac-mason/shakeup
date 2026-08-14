// src-typedata/parser.ts — fused lexer + parser emitting the TYPE+DATA tree
// directly (src-typedata/ast.ts). Round 6 of the AST-model tournament.
//
// ROUND 6: this parser is now TYPEDATA'S OWN — no longer a costume over estree's
// shared `make.X` dispatcher. It OWNS node construction: at each grammar site it
// builds the outer `{ type, start, end, name, data }` literal DIRECTLY via a local
// per-type constructor `m.X(start, end, flags, ...children)`. Each `m.X` writes
// the outer keys in IDENTICAL order and returns a plain object literal, so the
// whole tree remains ONE hidden class (the shape invariant is structural — every
// constructor emits the same 5-slot key order). There is no `makeBuilder` switch,
// no `mkNode` indirection, no Record lookup on the hot path: the estree-skeleton
// dispatch is gone.
//
// THE POOL IS GONE. Source, the line table and the error sink are the PARSER's
// own module-level state (fused, invisible to callers — the house pattern from
// src/parser.ts). Leaves materialize their name/raw from `src` at scan time (and
// intern identifier names — round-6 lever i3), so after `parse` returns nothing
// references the source. Public API: `parse(source, options): { program, errors,
// lines }` — no pool anywhere.
//
// The GRAMMAR is the reference parser's (src/parser.ts), ported faithfully: same
// token machinery, same lookaheads, same TS corners (optional methods, class
// index signatures, labeled rest tuples, generic-arrow / type-args speculation,
// `>>`-splitting in type-arg context, declare-prefix rewrites).
//
// LIMIT (same as reference): no JSX; assignment-target destructuring stays as
// literal expression nodes (patterns parsed only in binding positions).

import { enumeration } from './util/enumeration';
import {
    type Node,
    type Program,
    type BindingIdentifier,
    type IdentifierReference,
    type IdentifierName,
    type LabelIdentifier,
    type RawNode,
    nodeType,
    N,
    nextNodeId,
    resetNodeIds,
    peekNodeId,
    type Accessibility,
} from './ast.ts';

/** Any of the four identifier-role leaves — the parser's loose handle for a name
 * node whose role is fixed by the constructing call site. */
type Identifier = BindingIdentifier | IdentifierReference | IdentifierName | LabelIdentifier;

/* Identifier-role type ids, aliased for readable call sites (a name node's role
 * is a grammatical property of where it sits — the parser fixes it here). */
const R_BIND = N.BindingIdentifier;   // declaring positions (var/fn/class/param/import-local/type-param names)
const R_REF = N.IdentifierReference;  // resolving positions (expressions, assignment targets, export-local, type refs)
const R_NAME = N.IdentifierName;      // pure names that never resolve (member props, keys, import/export externals, qualified-name right)
const R_LABEL = N.LabelIdentifier;    // statement labels (decl + break/continue targets)

/* shared flag bits — the ints the parser computes and decodes into tight
 * payloads. NOT stored on the node (payloads carry every boolean/kind/operator
 * as a real field); this table is the parser's internal decode key (module-private). */
const FL = {
    /** Ident/PrivateIdent only: name lives in the name slot, not the span */
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
    // 2-bit groups
    KIND_SHIFT: 12, // Property/MethodDef kind: 0 init/method, 1 get, 2 set, 3 ctor
    ACCESS_SHIFT: 14, // 0 none, 1 public, 2 private, 3 protected
} as const;

// VarDecl kinds in low bits
const VAR_KIND = { VAR: 1, LET: 2, CONST: 3, KIND_MASK: 3 } as const;

// operator codes (Binary/Logical/Assign/Unary/Update flags low 6 bits; must stay < 64)
const OP = enumeration(
    // binary
    'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'EXP',
    'SHL', 'SHR', 'USHR', 'BIT_AND', 'BIT_OR', 'BIT_XOR',
    'LT', 'GT', 'LE', 'GE', 'EQ', 'NE', 'SEQ', 'SNE',
    'IN', 'INSTANCEOF',
    // logical
    'AND', 'OR', 'NULLISH',
    // unary
    'NEG', 'POS', 'NOT', 'BIT_NOT', 'TYPEOF', 'VOID', 'DELETE',
    // update
    'INC', 'DEC',
    // assign
    'ASSIGN', 'ADD_A', 'SUB_A', 'MUL_A', 'DIV_A', 'MOD_A', 'EXP_A',
    'SHL_A', 'SHR_A', 'USHR_A', 'AND_A', 'OR_A', 'XOR_A',
    'LOGAND_A', 'LOGOR_A', 'NULLISH_A',
);

const TSOP = enumeration('KEYOF', 'READONLY', 'UNIQUE');

/* ================================================================= operators
 *
 * flags-int -> operator-string decode tables, applied at each construction site.
 */

const BIN_OP_NAME: string[] = [];
const ASSIGN_OP_NAME: string[] = [];
const UNARY_OP_NAME: string[] = [];
const UPDATE_OP_NAME: string[] = [];
const LOGICAL_OP_NAME: string[] = [];
{
    BIN_OP_NAME[OP.ADD] = '+'; BIN_OP_NAME[OP.SUB] = '-'; BIN_OP_NAME[OP.MUL] = '*';
    BIN_OP_NAME[OP.DIV] = '/'; BIN_OP_NAME[OP.MOD] = '%'; BIN_OP_NAME[OP.EXP] = '**';
    BIN_OP_NAME[OP.SHL] = '<<'; BIN_OP_NAME[OP.SHR] = '>>'; BIN_OP_NAME[OP.USHR] = '>>>';
    BIN_OP_NAME[OP.BIT_AND] = '&'; BIN_OP_NAME[OP.BIT_OR] = '|'; BIN_OP_NAME[OP.BIT_XOR] = '^';
    BIN_OP_NAME[OP.LT] = '<'; BIN_OP_NAME[OP.GT] = '>'; BIN_OP_NAME[OP.LE] = '<='; BIN_OP_NAME[OP.GE] = '>=';
    BIN_OP_NAME[OP.EQ] = '=='; BIN_OP_NAME[OP.NE] = '!='; BIN_OP_NAME[OP.SEQ] = '==='; BIN_OP_NAME[OP.SNE] = '!==';
    BIN_OP_NAME[OP.IN] = 'in'; BIN_OP_NAME[OP.INSTANCEOF] = 'instanceof';
    LOGICAL_OP_NAME[OP.AND] = '&&'; LOGICAL_OP_NAME[OP.OR] = '||'; LOGICAL_OP_NAME[OP.NULLISH] = '??';
    UNARY_OP_NAME[OP.NEG] = '-'; UNARY_OP_NAME[OP.POS] = '+'; UNARY_OP_NAME[OP.NOT] = '!';
    UNARY_OP_NAME[OP.BIT_NOT] = '~'; UNARY_OP_NAME[OP.TYPEOF] = 'typeof'; UNARY_OP_NAME[OP.VOID] = 'void';
    UNARY_OP_NAME[OP.DELETE] = 'delete';
    UPDATE_OP_NAME[OP.INC] = '++'; UPDATE_OP_NAME[OP.DEC] = '--';
    ASSIGN_OP_NAME[OP.ASSIGN] = '='; ASSIGN_OP_NAME[OP.ADD_A] = '+='; ASSIGN_OP_NAME[OP.SUB_A] = '-=';
    ASSIGN_OP_NAME[OP.MUL_A] = '*='; ASSIGN_OP_NAME[OP.DIV_A] = '/='; ASSIGN_OP_NAME[OP.MOD_A] = '%=';
    ASSIGN_OP_NAME[OP.EXP_A] = '**='; ASSIGN_OP_NAME[OP.SHL_A] = '<<='; ASSIGN_OP_NAME[OP.SHR_A] = '>>=';
    ASSIGN_OP_NAME[OP.USHR_A] = '>>>='; ASSIGN_OP_NAME[OP.AND_A] = '&='; ASSIGN_OP_NAME[OP.OR_A] = '|=';
    ASSIGN_OP_NAME[OP.XOR_A] = '^='; ASSIGN_OP_NAME[OP.LOGAND_A] = '&&='; ASSIGN_OP_NAME[OP.LOGOR_A] = '||=';
    ASSIGN_OP_NAME[OP.NULLISH_A] = '??=';
}

/** Decode the 2-bit accessibility group of a parser flags int. */
function accessibilityOf(flags: number): Accessibility {
    const a = (flags >> FL.ACCESS_SHIFT) & 3;
    return a === 1 ? 'public' : a === 2 ? 'private' : a === 3 ? 'protected' : null;
}

/** A parse slot: a node object, or null when absent. (Replaces flat's `0`.) */
type Ref = Node | null;

/** Parse errors and offsets. */
export type ParseError = { pos: number; msg: string };

/* ================================================= node construction (m.X)
 *
 * Typedata's OWN constructors. Each returns the outer node as a direct object
 * literal in the fixed key order { type, start, end, name, data } — one hidden
 * class for the whole tree. `flags` (the ints the grammar already computes) are
 * decoded into the tight payload here; children arrive as real Node refs (null =
 * absent) or Node[] lists. No pool, no dispatcher.
 */

const m = {
    // ---- leaves (interior code path; leaf TEXT is filled by ident()/leaf() below) ----
    BooleanLiteral: (s: number, e: number, flags: number): RawNode => ({ id: nextId(), type: N.BooleanLiteral, start: s, end: e, name: flags !== 0 ? 'true' : 'false', data: null }),
    NullLiteral: (s: number, e: number, _f: number): RawNode => ({ id: nextId(), type: N.NullLiteral, start: s, end: e, name: 'null', data: null }),
    ThisExpression: (s: number, e: number, _f: number): RawNode => ({ id: nextId(), type: N.ThisExpression, start: s, end: e, name: '', data: null }),
    Super: (s: number, e: number, _f: number): RawNode => ({ id: nextId(), type: N.Super, start: s, end: e, name: '', data: null }),
    EmptyStatement: (s: number, e: number, _f: number): RawNode => ({ id: nextId(), type: N.EmptyStatement, start: s, end: e, name: '', data: null }),
    DebuggerStatement: (s: number, e: number, _f: number): RawNode => ({ id: nextId(), type: N.DebuggerStatement, start: s, end: e, name: '', data: null }),
    ImportMeta: (s: number, e: number, _f: number): RawNode => ({ id: nextId(), type: N.ImportMeta, start: s, end: e, name: '', data: null }),
    NewTarget: (s: number, e: number, _f: number): RawNode => ({ id: nextId(), type: N.NewTarget, start: s, end: e, name: '', data: null }),

    // ---- scalar-decoding interior nodes ----
    BinaryExpression: (s: number, e: number, flags: number, l: Ref, r: Ref): RawNode => ({ id: nextId(), type: N.BinaryExpression, start: s, end: e, name: '', data: { operator: BIN_OP_NAME[flags & 63], left: l, right: r } }),
    LogicalExpression: (s: number, e: number, flags: number, l: Ref, r: Ref): RawNode => ({ id: nextId(), type: N.LogicalExpression, start: s, end: e, name: '', data: { operator: LOGICAL_OP_NAME[flags & 63], left: l, right: r } }),
    AssignmentExpression: (s: number, e: number, flags: number, l: Ref, r: Ref): RawNode => ({ id: nextId(), type: N.AssignmentExpression, start: s, end: e, name: '', data: { operator: ASSIGN_OP_NAME[flags & 63], left: l, right: r } }),
    UnaryExpression: (s: number, e: number, flags: number, a: Ref): RawNode => ({ id: nextId(), type: N.UnaryExpression, start: s, end: e, name: '', data: { operator: UNARY_OP_NAME[flags & 63], prefix: true, argument: a } }),
    UpdateExpression: (s: number, e: number, flags: number, a: Ref): RawNode => ({ id: nextId(), type: N.UpdateExpression, start: s, end: e, name: '', data: { operator: UPDATE_OP_NAME[flags & 63], prefix: (flags & FL.PREFIX) !== 0, argument: a } }),
    ObjectProperty: (s: number, e: number, flags: number, key: Ref, value: Ref): RawNode => ({ id: nextId(), type: N.ObjectProperty, start: s, end: e, name: '', data: { key, value, kind: ['init', 'get', 'set'][(flags >> FL.KIND_SHIFT) & 3], computed: (flags & FL.COMPUTED) !== 0, shorthand: (flags & FL.SHORTHAND) !== 0 } }),
    CallExpression: (s: number, e: number, flags: number, callee: Ref, args: Ref[] | null, typeArgs: Ref): RawNode => ({ id: nextId(), type: N.CallExpression, start: s, end: e, name: '', data: { callee, arguments: args ?? [], optional: (flags & FL.OPTIONAL) !== 0, typeArguments: typeArgs ?? null } }),
    StaticMemberExpression: (s: number, e: number, flags: number, obj: Ref, prop: Ref): RawNode => ({ id: nextId(), type: N.StaticMemberExpression, start: s, end: e, name: '', data: { object: obj, property: prop, optional: (flags & FL.OPTIONAL) !== 0 } }),
    ComputedMemberExpression: (s: number, e: number, flags: number, obj: Ref, expr: Ref): RawNode => ({ id: nextId(), type: N.ComputedMemberExpression, start: s, end: e, name: '', data: { object: obj, expression: expr, optional: (flags & FL.OPTIONAL) !== 0 } }),
    PrivateFieldExpression: (s: number, e: number, flags: number, obj: Ref, field: Ref): RawNode => ({ id: nextId(), type: N.PrivateFieldExpression, start: s, end: e, name: '', data: { object: obj, field, optional: (flags & FL.OPTIONAL) !== 0 } }),
    ChainExpression: (s: number, e: number, _f: number, expression: Ref): RawNode => ({ id: nextId(), type: N.ChainExpression, start: s, end: e, name: '', data: { expression } }),
    ArrowFunctionExpression: (s: number, e: number, flags: number, tp: Ref, params: Ref[] | null, rt: Ref, body: Ref): RawNode => ({ id: nextId(), type: N.ArrowFunctionExpression, start: s, end: e, name: '', data: { typeParameters: tp ?? null, params: params ?? [], returnType: rt ?? null, body, async: (flags & FL.ASYNC) !== 0, expression: (flags & FL.EXPR_BODY) !== 0 } }),
    FunctionExpression: (s: number, e: number, flags: number, id: Ref, tp: Ref, params: Ref[] | null, rt: Ref, body: Ref): RawNode => ({ id: nextId(), type: N.FunctionExpression, start: s, end: e, name: '', data: { id: id ?? null, typeParameters: tp ?? null, params: params ?? [], returnType: rt ?? null, body: body ?? null, async: (flags & FL.ASYNC) !== 0, generator: (flags & FL.GENERATOR) !== 0 } }),
    FunctionDeclaration: (s: number, e: number, flags: number, id: Ref, tp: Ref, params: Ref[] | null, rt: Ref, body: Ref): RawNode => ({ id: nextId(), type: N.FunctionDeclaration, start: s, end: e, name: '', data: { id: id ?? null, typeParameters: tp ?? null, params: params ?? [], returnType: rt ?? null, body: body ?? null, async: (flags & FL.ASYNC) !== 0, generator: (flags & FL.GENERATOR) !== 0, declare: (flags & FL.DECLARE) !== 0 } }),
    ClassExpression: (s: number, e: number, _flags: number, id: Ref, tp: Ref, sc: Ref, sta: Ref, impl: Ref[] | null, body: Ref[] | null): RawNode => ({ id: nextId(), type: N.ClassExpression, start: s, end: e, name: '', data: { id: id ?? null, typeParameters: tp ?? null, superClass: sc ?? null, superTypeArguments: sta ?? null, implements: impl ?? [], body: body ?? [] } }),
    ClassDeclaration: (s: number, e: number, flags: number, id: Ref, tp: Ref, sc: Ref, sta: Ref, impl: Ref[] | null, body: Ref[] | null): RawNode => ({ id: nextId(), type: N.ClassDeclaration, start: s, end: e, name: '', data: { id: id ?? null, typeParameters: tp ?? null, superClass: sc ?? null, superTypeArguments: sta ?? null, implements: impl ?? [], body: body ?? [], abstract: (flags & FL.ABSTRACT) !== 0, declare: (flags & FL.DECLARE) !== 0 } }),
    YieldExpression: (s: number, e: number, flags: number, a: Ref): RawNode => ({ id: nextId(), type: N.YieldExpression, start: s, end: e, name: '', data: { argument: a ?? null, delegate: (flags & FL.DELEGATE) !== 0 } }),
    VariableDeclaration: (s: number, e: number, flags: number, decls: Ref[] | null): RawNode => ({ id: nextId(), type: N.VariableDeclaration, start: s, end: e, name: '', data: { declarations: decls ?? [], kind: ['var', 'var', 'let', 'const'][flags & VAR_KIND.KIND_MASK], declare: (flags & FL.DECLARE) !== 0 } }),
    VariableDeclarator: (s: number, e: number, flags: number, id: Ref, ta: Ref, init: Ref): RawNode => ({ id: nextId(), type: N.VariableDeclarator, start: s, end: e, name: '', data: { id, typeAnnotation: ta ?? null, init: init ?? null, definite: (flags & FL.DEFINITE) !== 0 } }),
    ForOfStatement: (s: number, e: number, flags: number, left: Ref, right: Ref, body: Ref): RawNode => ({ id: nextId(), type: N.ForOfStatement, start: s, end: e, name: '', data: { left, right, body, await: (flags & FL.AWAIT) !== 0 } }),
    MethodDefinition: (s: number, e: number, flags: number, key: Ref, value: Ref): RawNode => ({ id: nextId(), type: N.MethodDefinition, start: s, end: e, name: '', data: { key, value, kind: ['method', 'get', 'set', 'constructor'][(flags >> FL.KIND_SHIFT) & 3], static: (flags & FL.STATIC) !== 0, computed: (flags & FL.COMPUTED) !== 0, optional: (flags & FL.OPTIONAL) !== 0, abstract: (flags & FL.ABSTRACT) !== 0, accessibility: accessibilityOf(flags) } }),
    PropertyDefinition: (s: number, e: number, flags: number, key: Ref, ta: Ref, value: Ref): RawNode => ({ id: nextId(), type: N.PropertyDefinition, start: s, end: e, name: '', data: { key, typeAnnotation: ta ?? null, value: value ?? null, static: (flags & FL.STATIC) !== 0, computed: (flags & FL.COMPUTED) !== 0, readonly: (flags & FL.READONLY) !== 0, optional: (flags & FL.OPTIONAL) !== 0, definite: (flags & FL.DEFINITE) !== 0, declare: (flags & FL.DECLARE) !== 0, abstract: (flags & FL.ABSTRACT) !== 0, accessibility: accessibilityOf(flags) } }),
    FormalParameter: (s: number, e: number, flags: number, pat: Ref, ta: Ref, init: Ref): RawNode => ({ id: nextId(), type: N.FormalParameter, start: s, end: e, name: '', data: { pattern: pat, typeAnnotation: ta ?? null, init: init ?? null, optional: (flags & FL.OPTIONAL) !== 0, readonly: (flags & FL.READONLY) !== 0, accessibility: accessibilityOf(flags) } }),
    ImportDeclaration: (s: number, e: number, flags: number, specs: Ref[] | null, source: Ref): RawNode => ({ id: nextId(), type: N.ImportDeclaration, start: s, end: e, name: '', data: { specifiers: specs ?? [], source, importKind: (flags & FL.TYPE_ONLY) !== 0 ? 'type' : 'value' } }),
    ImportSpecifier: (s: number, e: number, flags: number, local: Ref, imported: Ref): RawNode => ({ id: nextId(), type: N.ImportSpecifier, start: s, end: e, name: '', data: { local, imported, importKind: (flags & FL.TYPE_ONLY) !== 0 ? 'type' : 'value' } }),
    ExportNamedDeclaration: (s: number, e: number, flags: number, decl: Ref, specs: Ref[] | null, source: Ref): RawNode => ({ id: nextId(), type: N.ExportNamedDeclaration, start: s, end: e, name: '', data: { declaration: decl ?? null, specifiers: specs ?? [], source: source ?? null, exportKind: (flags & FL.TYPE_ONLY) !== 0 ? 'type' : 'value' } }),
    ExportSpecifier: (s: number, e: number, flags: number, local: Ref, exported: Ref): RawNode => ({ id: nextId(), type: N.ExportSpecifier, start: s, end: e, name: '', data: { local, exported, exportKind: (flags & FL.TYPE_ONLY) !== 0 ? 'type' : 'value' } }),
    // keyword leaf: `kw` is already a TSXKeyword/TSThisType node type id (data:null leaf).
    keyword: (s: number, e: number, kw: number): RawNode => ({ id: nextId(), type: kw, start: s, end: e, name: '', data: null }),
    TSTypeParameter: (s: number, e: number, flags: number, name: Ref, constraint: Ref, dflt: Ref): RawNode => ({ id: nextId(), type: N.TSTypeParameter, start: s, end: e, name: '', data: { name, constraint: constraint ?? null, default: dflt ?? null, in: (flags & 1) !== 0, out: (flags & 2) !== 0, const: (flags & 4) !== 0 } }),
    TSNamedTupleMember: (s: number, e: number, flags: number, label: Ref, elemType: Ref): RawNode => ({ id: nextId(), type: N.TSNamedTupleMember, start: s, end: e, name: '', data: { label, elementType: elemType, optional: (flags & FL.OPTIONAL) !== 0 } }),
    TSPropertySignature: (s: number, e: number, flags: number, key: Ref, ta: Ref): RawNode => ({ id: nextId(), type: N.TSPropertySignature, start: s, end: e, name: '', data: { key, typeAnnotation: ta ?? null, optional: (flags & FL.OPTIONAL) !== 0, readonly: (flags & FL.READONLY) !== 0, computed: (flags & FL.COMPUTED) !== 0 } }),
    TSMethodSignature: (s: number, e: number, flags: number, key: Ref, tp: Ref, params: Ref[] | null, rt: Ref): RawNode => ({ id: nextId(), type: N.TSMethodSignature, start: s, end: e, name: '', data: { key, typeParameters: tp ?? null, params: params ?? [], returnType: rt ?? null, optional: (flags & FL.OPTIONAL) !== 0, kind: ['method', 'get', 'set'][(flags >> FL.KIND_SHIFT) & 3], computed: (flags & FL.COMPUTED) !== 0 } }),
    TSIndexSignature: (s: number, e: number, flags: number, param: Ref, ta: Ref): RawNode => ({ id: nextId(), type: N.TSIndexSignature, start: s, end: e, name: '', data: { parameter: param, typeAnnotation: ta ?? null, readonly: (flags & FL.READONLY) !== 0 } }),
    TSTypeOperator: (s: number, e: number, flags: number, ta: Ref): RawNode => ({ id: nextId(), type: N.TSTypeOperator, start: s, end: e, name: '', data: { operator: flags === 1 ? 'keyof' : flags === 2 ? 'readonly' : flags === 3 ? 'unique' : '', typeAnnotation: ta } }),
    TSMappedType: (s: number, e: number, flags: number, tp: Ref, nameType: Ref, ta: Ref): RawNode => ({ id: nextId(), type: N.TSMappedType, start: s, end: e, name: '', data: { typeParameter: tp, nameType: nameType ?? null, typeAnnotation: ta ?? null, readonlyMod: (flags >> 4) & 3, optionalMod: (flags >> 6) & 3 } }),
    TSConstructorType: (s: number, e: number, flags: number, tp: Ref, params: Ref[] | null, rt: Ref): RawNode => ({ id: nextId(), type: N.TSConstructorType, start: s, end: e, name: '', data: { typeParameters: tp ?? null, params: params ?? [], returnType: rt ?? null, abstract: (flags & FL.ABSTRACT) !== 0 } }),
    TSInterfaceDeclaration: (s: number, e: number, flags: number, id: Ref, tp: Ref, ext: Ref[] | null, body: Ref[] | null): RawNode => ({ id: nextId(), type: N.TSInterfaceDeclaration, start: s, end: e, name: '', data: { id, typeParameters: tp ?? null, extends: ext ?? [], body: body ?? [], declare: (flags & FL.DECLARE) !== 0 } }),
    TSTypeAliasDeclaration: (s: number, e: number, flags: number, id: Ref, tp: Ref, ta: Ref): RawNode => ({ id: nextId(), type: N.TSTypeAliasDeclaration, start: s, end: e, name: '', data: { id, typeParameters: tp ?? null, typeAnnotation: ta, declare: (flags & FL.DECLARE) !== 0 } }),
    TSEnumDeclaration: (s: number, e: number, flags: number, id: Ref, members: Ref[] | null): RawNode => ({ id: nextId(), type: N.TSEnumDeclaration, start: s, end: e, name: '', data: { id, members: members ?? [], const: (flags & FL.CONST_ENUM) !== 0, declare: (flags & FL.DECLARE) !== 0 } }),
    TSModuleDeclaration: (s: number, e: number, flags: number, id: Ref, body: Ref[] | null): RawNode => ({ id: nextId(), type: N.TSModuleDeclaration, start: s, end: e, name: '', data: { id, body: body ?? [], declare: (flags & FL.DECLARE) !== 0, namespace: (flags & FL.NAMESPACE) !== 0 } }),

    // ---- plain interior nodes: payload keys in schema order, direct literal ----
    Program: (s: number, e: number, _f: number, body: Ref[]): RawNode => ({ id: nextId(), type: N.Program, start: s, end: e, name: '', data: { body } }),
    TemplateLiteral: (s: number, e: number, _f: number, quasis: Ref[], expressions: Ref[]): RawNode => ({ id: nextId(), type: N.TemplateLiteral, start: s, end: e, name: '', data: { quasis, expressions } }),
    TaggedTemplateExpression: (s: number, e: number, _f: number, tag: Ref, quasi: Ref): RawNode => ({ id: nextId(), type: N.TaggedTemplateExpression, start: s, end: e, name: '', data: { tag, quasi } }),
    ArrayExpression: (s: number, e: number, _f: number, elements: Ref[]): RawNode => ({ id: nextId(), type: N.ArrayExpression, start: s, end: e, name: '', data: { elements } }),
    ObjectExpression: (s: number, e: number, _f: number, properties: Ref[]): RawNode => ({ id: nextId(), type: N.ObjectExpression, start: s, end: e, name: '', data: { properties } }),
    SpreadElement: (s: number, e: number, _f: number, argument: Ref): RawNode => ({ id: nextId(), type: N.SpreadElement, start: s, end: e, name: '', data: { argument } }),
    ConditionalExpression: (s: number, e: number, _f: number, test: Ref, consequent: Ref, alternate: Ref): RawNode => ({ id: nextId(), type: N.ConditionalExpression, start: s, end: e, name: '', data: { test, consequent, alternate } }),
    NewExpression: (s: number, e: number, _f: number, callee: Ref, args: Ref[] | null, typeArgs: Ref): RawNode => ({ id: nextId(), type: N.NewExpression, start: s, end: e, name: '', data: { callee, arguments: args ?? [], typeArguments: typeArgs ?? null } }),
    SequenceExpression: (s: number, e: number, _f: number, expressions: Ref[]): RawNode => ({ id: nextId(), type: N.SequenceExpression, start: s, end: e, name: '', data: { expressions } }),
    AwaitExpression: (s: number, e: number, _f: number, argument: Ref): RawNode => ({ id: nextId(), type: N.AwaitExpression, start: s, end: e, name: '', data: { argument } }),
    ImportExpression: (s: number, e: number, _f: number, source: Ref, options: Ref): RawNode => ({ id: nextId(), type: N.ImportExpression, start: s, end: e, name: '', data: { source, options: options ?? null } }),
    ExpressionStatement: (s: number, e: number, _f: number, expression: Ref): RawNode => ({ id: nextId(), type: N.ExpressionStatement, start: s, end: e, name: '', data: { expression } }),
    BlockStatement: (s: number, e: number, _f: number, body: Ref[]): RawNode => ({ id: nextId(), type: N.BlockStatement, start: s, end: e, name: '', data: { body } }),
    IfStatement: (s: number, e: number, _f: number, test: Ref, consequent: Ref, alternate: Ref): RawNode => ({ id: nextId(), type: N.IfStatement, start: s, end: e, name: '', data: { test, consequent, alternate: alternate ?? null } }),
    ForStatement: (s: number, e: number, _f: number, init: Ref, test: Ref, update: Ref, body: Ref): RawNode => ({ id: nextId(), type: N.ForStatement, start: s, end: e, name: '', data: { init: init ?? null, test: test ?? null, update: update ?? null, body } }),
    ForInStatement: (s: number, e: number, _f: number, left: Ref, right: Ref, body: Ref): RawNode => ({ id: nextId(), type: N.ForInStatement, start: s, end: e, name: '', data: { left, right, body } }),
    WhileStatement: (s: number, e: number, _f: number, test: Ref, body: Ref): RawNode => ({ id: nextId(), type: N.WhileStatement, start: s, end: e, name: '', data: { test, body } }),
    DoWhileStatement: (s: number, e: number, _f: number, body: Ref, test: Ref): RawNode => ({ id: nextId(), type: N.DoWhileStatement, start: s, end: e, name: '', data: { body, test } }),
    SwitchStatement: (s: number, e: number, _f: number, discriminant: Ref, cases: Ref[]): RawNode => ({ id: nextId(), type: N.SwitchStatement, start: s, end: e, name: '', data: { discriminant, cases } }),
    SwitchCase: (s: number, e: number, _f: number, test: Ref, consequent: Ref[]): RawNode => ({ id: nextId(), type: N.SwitchCase, start: s, end: e, name: '', data: { test: test ?? null, consequent } }),
    TryStatement: (s: number, e: number, _f: number, block: Ref, handler: Ref, finalizer: Ref): RawNode => ({ id: nextId(), type: N.TryStatement, start: s, end: e, name: '', data: { block, handler: handler ?? null, finalizer: finalizer ?? null } }),
    CatchClause: (s: number, e: number, _f: number, param: Ref, body: Ref): RawNode => ({ id: nextId(), type: N.CatchClause, start: s, end: e, name: '', data: { param: param ?? null, body } }),
    ReturnStatement: (s: number, e: number, _f: number, argument: Ref): RawNode => ({ id: nextId(), type: N.ReturnStatement, start: s, end: e, name: '', data: { argument: argument ?? null } }),
    ThrowStatement: (s: number, e: number, _f: number, argument: Ref): RawNode => ({ id: nextId(), type: N.ThrowStatement, start: s, end: e, name: '', data: { argument } }),
    BreakStatement: (s: number, e: number, _f: number, label: Ref): RawNode => ({ id: nextId(), type: N.BreakStatement, start: s, end: e, name: '', data: { label: label ?? null } }),
    ContinueStatement: (s: number, e: number, _f: number, label: Ref): RawNode => ({ id: nextId(), type: N.ContinueStatement, start: s, end: e, name: '', data: { label: label ?? null } }),
    LabeledStatement: (s: number, e: number, _f: number, label: Ref, body: Ref): RawNode => ({ id: nextId(), type: N.LabeledStatement, start: s, end: e, name: '', data: { label, body } }),
    StaticBlock: (s: number, e: number, _f: number, body: Ref[]): RawNode => ({ id: nextId(), type: N.StaticBlock, start: s, end: e, name: '', data: { body } }),
    ObjectPattern: (s: number, e: number, _f: number, properties: Ref[]): RawNode => ({ id: nextId(), type: N.ObjectPattern, start: s, end: e, name: '', data: { properties } }),
    ArrayPattern: (s: number, e: number, _f: number, elements: Ref[]): RawNode => ({ id: nextId(), type: N.ArrayPattern, start: s, end: e, name: '', data: { elements } }),
    AssignmentPattern: (s: number, e: number, _f: number, left: Ref, right: Ref): RawNode => ({ id: nextId(), type: N.AssignmentPattern, start: s, end: e, name: '', data: { left, right } }),
    RestElement: (s: number, e: number, _f: number, argument: Ref, typeAnnotation: Ref): RawNode => ({ id: nextId(), type: N.RestElement, start: s, end: e, name: '', data: { argument, typeAnnotation: typeAnnotation ?? null } }),
    ImportDefaultSpecifier: (s: number, e: number, _f: number, local: Ref): RawNode => ({ id: nextId(), type: N.ImportDefaultSpecifier, start: s, end: e, name: '', data: { local } }),
    ImportNamespaceSpecifier: (s: number, e: number, _f: number, local: Ref): RawNode => ({ id: nextId(), type: N.ImportNamespaceSpecifier, start: s, end: e, name: '', data: { local } }),
    ExportDefaultDeclaration: (s: number, e: number, _f: number, declaration: Ref): RawNode => ({ id: nextId(), type: N.ExportDefaultDeclaration, start: s, end: e, name: '', data: { declaration } }),
    ExportAllDeclaration: (s: number, e: number, _f: number, source: Ref, exported: Ref): RawNode => ({ id: nextId(), type: N.ExportAllDeclaration, start: s, end: e, name: '', data: { source, exported: exported ?? null } }),
    TSTypeAnnotation: (s: number, e: number, _f: number, typeAnnotation: Ref): RawNode => ({ id: nextId(), type: N.TSTypeAnnotation, start: s, end: e, name: '', data: { typeAnnotation } }),
    TSTypeReference: (s: number, e: number, _f: number, typeName: Ref, typeArguments: Ref): RawNode => ({ id: nextId(), type: N.TSTypeReference, start: s, end: e, name: '', data: { typeName, typeArguments: typeArguments ?? null } }),
    TSQualifiedName: (s: number, e: number, _f: number, left: Ref, right: Ref): RawNode => ({ id: nextId(), type: N.TSQualifiedName, start: s, end: e, name: '', data: { left, right } }),
    TSTypeParameterInstantiation: (s: number, e: number, _f: number, params: Ref[]): RawNode => ({ id: nextId(), type: N.TSTypeParameterInstantiation, start: s, end: e, name: '', data: { params } }),
    TSTypeParameterDeclaration: (s: number, e: number, _f: number, params: Ref[]): RawNode => ({ id: nextId(), type: N.TSTypeParameterDeclaration, start: s, end: e, name: '', data: { params } }),
    TSTupleType: (s: number, e: number, _f: number, elementTypes: Ref[]): RawNode => ({ id: nextId(), type: N.TSTupleType, start: s, end: e, name: '', data: { elementTypes } }),
    TSTypeLiteral: (s: number, e: number, _f: number, members: Ref[]): RawNode => ({ id: nextId(), type: N.TSTypeLiteral, start: s, end: e, name: '', data: { members } }),
    TSCallSignatureDeclaration: (s: number, e: number, _f: number, typeParameters: Ref, params: Ref[] | null, returnType: Ref): RawNode => ({ id: nextId(), type: N.TSCallSignatureDeclaration, start: s, end: e, name: '', data: { typeParameters: typeParameters ?? null, params: params ?? [], returnType: returnType ?? null } }),
    TSConstructSignatureDeclaration: (s: number, e: number, _f: number, typeParameters: Ref, params: Ref[] | null, returnType: Ref): RawNode => ({ id: nextId(), type: N.TSConstructSignatureDeclaration, start: s, end: e, name: '', data: { typeParameters: typeParameters ?? null, params: params ?? [], returnType: returnType ?? null } }),
    TSUnionType: (s: number, e: number, _f: number, types: Ref[]): RawNode => ({ id: nextId(), type: N.TSUnionType, start: s, end: e, name: '', data: { types } }),
    TSIntersectionType: (s: number, e: number, _f: number, types: Ref[]): RawNode => ({ id: nextId(), type: N.TSIntersectionType, start: s, end: e, name: '', data: { types } }),
    TSFunctionType: (s: number, e: number, _f: number, typeParameters: Ref, params: Ref[] | null, returnType: Ref): RawNode => ({ id: nextId(), type: N.TSFunctionType, start: s, end: e, name: '', data: { typeParameters: typeParameters ?? null, params: params ?? [], returnType: returnType ?? null } }),
    TSArrayType: (s: number, e: number, _f: number, elementType: Ref): RawNode => ({ id: nextId(), type: N.TSArrayType, start: s, end: e, name: '', data: { elementType } }),
    TSIndexedAccessType: (s: number, e: number, _f: number, objectType: Ref, indexType: Ref): RawNode => ({ id: nextId(), type: N.TSIndexedAccessType, start: s, end: e, name: '', data: { objectType, indexType } }),
    TSTypeQuery: (s: number, e: number, _f: number, exprName: Ref, typeArguments: Ref): RawNode => ({ id: nextId(), type: N.TSTypeQuery, start: s, end: e, name: '', data: { exprName, typeArguments: typeArguments ?? null } }),
    TSConditionalType: (s: number, e: number, _f: number, checkType: Ref, extendsType: Ref, trueType: Ref, falseType: Ref): RawNode => ({ id: nextId(), type: N.TSConditionalType, start: s, end: e, name: '', data: { checkType, extendsType, trueType, falseType } }),
    TSInferType: (s: number, e: number, _f: number, typeParameter: Ref): RawNode => ({ id: nextId(), type: N.TSInferType, start: s, end: e, name: '', data: { typeParameter } }),
    TSLiteralType: (s: number, e: number, _f: number, literal: Ref): RawNode => ({ id: nextId(), type: N.TSLiteralType, start: s, end: e, name: '', data: { literal } }),
    TSTemplateLiteralType: (s: number, e: number, _f: number, quasis: Ref[], types: Ref[]): RawNode => ({ id: nextId(), type: N.TSTemplateLiteralType, start: s, end: e, name: '', data: { quasis, types } }),
    TSImportType: (s: number, e: number, _f: number, source: Ref, qualifier: Ref, typeArguments: Ref): RawNode => ({ id: nextId(), type: N.TSImportType, start: s, end: e, name: '', data: { source, qualifier: qualifier ?? null, typeArguments: typeArguments ?? null } }),
    TSClassImplements: (s: number, e: number, _f: number, expression: Ref, typeArguments: Ref): RawNode => ({ id: nextId(), type: N.TSClassImplements, start: s, end: e, name: '', data: { expression, typeArguments: typeArguments ?? null } }),
    TSInterfaceHeritage: (s: number, e: number, _f: number, expression: Ref, typeArguments: Ref): RawNode => ({ id: nextId(), type: N.TSInterfaceHeritage, start: s, end: e, name: '', data: { expression, typeArguments: typeArguments ?? null } }),
    TSEnumMember: (s: number, e: number, _f: number, id: Ref, initializer: Ref): RawNode => ({ id: nextId(), type: N.TSEnumMember, start: s, end: e, name: '', data: { id, initializer: initializer ?? null } }),
    TSAsExpression: (s: number, e: number, _f: number, expression: Ref, typeAnnotation: Ref): RawNode => ({ id: nextId(), type: N.TSAsExpression, start: s, end: e, name: '', data: { expression, typeAnnotation } }),
    TSSatisfiesExpression: (s: number, e: number, _f: number, expression: Ref, typeAnnotation: Ref): RawNode => ({ id: nextId(), type: N.TSSatisfiesExpression, start: s, end: e, name: '', data: { expression, typeAnnotation } }),
    TSNonNullExpression: (s: number, e: number, _f: number, expression: Ref): RawNode => ({ id: nextId(), type: N.TSNonNullExpression, start: s, end: e, name: '', data: { expression } }),
};

/* ----------------------------------------------------------------- tokens */

const T_EOF = 0;
const T_IDENT = 1;
const T_KW = 2;
const T_NUM = 3;
const T_BIGINT = 4;
const T_STR = 5;
const T_TEMPLATE_FULL = 6;
const T_TEMPLATE_HEAD = 7;
const T_REGEX = 9;
const T_PUNCT = 10;
const T_PRIVATE = 11;

const P = enumeration(
    'LPAREN', 'RPAREN', 'LBRACE', 'RBRACE', 'LBRACKET', 'RBRACKET',
    'SEMI', 'COMMA', 'DOT', 'DOTDOTDOT', 'ARROW', 'COLON', 'QUESTION',
    'QDOT', 'QQ', 'QQEQ', 'AT',
    'EQ', 'EQEQ', 'EQEQEQ', 'NEQ', 'NEQEQ', 'LT', 'GT', 'LE', 'GE',
    'PLUS', 'MINUS', 'STAR', 'STARSTAR', 'SLASH', 'PERCENT',
    'PLUSPLUS', 'MINUSMINUS', 'SHL', 'SHR', 'USHR',
    'AMP', 'PIPE', 'CARET', 'TILDE', 'BANG', 'AMPAMP', 'PIPEPIPE',
    'PLUSEQ', 'MINUSEQ', 'STAREQ', 'STARSTAREQ', 'SLASHEQ', 'PERCENTEQ',
    'SHLEQ', 'SHREQ', 'USHREQ', 'AMPEQ', 'PIPEEQ', 'CARETEQ',
    'AMPAMPEQ', 'PIPEPIPEEQ',
);

const K = enumeration(
    'BREAK', 'CASE', 'CATCH', 'CLASS', 'CONST', 'CONTINUE', 'DEBUGGER',
    'DEFAULT', 'DELETE', 'DO', 'ELSE', 'EXPORT', 'EXTENDS', 'FINALLY',
    'FOR', 'FUNCTION', 'IF', 'IMPORT', 'IN', 'INSTANCEOF', 'LET',
    'NEW', 'RETURN', 'SUPER', 'SWITCH', 'THIS', 'THROW', 'TRY',
    'TYPEOF', 'VAR', 'VOID', 'WHILE', 'WITH', 'TRUE', 'FALSE',
    'NULL', 'YIELD', 'AWAIT', 'ASYNC', 'OF', 'AS', 'FROM', 'GET',
    'SET', 'STATIC', 'TYPE', 'INTERFACE', 'ENUM', 'NAMESPACE',
    'MODULE', 'DECLARE', 'ABSTRACT', 'OVERRIDE', 'READONLY',
    'SATISFIES', 'KEYOF', 'INFER', 'IS', 'ASSERTS', 'IMPLEMENTS',
    'UNIQUE', 'ACCESSOR',
);

const CONTEXTUAL = new Set<number>([
    K.ASYNC, K.OF, K.AS, K.FROM, K.GET, K.SET, K.STATIC, K.TYPE, K.INTERFACE,
    K.NAMESPACE, K.MODULE, K.DECLARE, K.ABSTRACT, K.OVERRIDE, K.READONLY,
    K.SATISFIES, K.KEYOF, K.INFER, K.IS, K.ASSERTS, K.IMPLEMENTS, K.UNIQUE,
    K.ACCESSOR, K.YIELD, K.AWAIT, K.LET,
]);

const F_NL = 1;

/* ------------------------------------------------------------ lexer state */

let src = '';
let srcLen = 0;
let pos = 0;
let tok = T_EOF;
let tokStart = 0;
let tokEnd = 0;
let tokFlags = 0;
let tokVal = 0;
/** Rolling hash of the current ident-like token's chars (L1): computed DURING
 * the lexer's ident scan (it touches every char anyway), consumed by intern().
 * For T_PRIVATE it covers the name AFTER the '#'. Meaningless for other tokens. */
let tokHash = 0;
let tsMode = true;

/* ---- fused parser state (was the "pool"; now module-local, invisible to callers) ---- */
let errors: ParseError[] = [];

/* ---- node id counter ----
 * Sequential per-parse node id, assigned from 1 (0 = null parity with the old
 * NodeId convention). Every node constructor inlines `id: nextId()` as its FIRST
 * key, so the whole tree is one hidden class AND every node keys the id-indexed
 * side tables (semantic nodeSymbol/nodeScope, shake liveness). Draws from the
 * SHARED ast id counter (so programmatic clones never collide); reset per parse. */
const nextId = nextNodeId;

/* ---- L1: slice-free hash-during-scan identifier interning ----
 * Repeated identifier strings share ONE string object (i3's invariant), but the
 * old slice-then-Map.get interning allocated a throwaway slice on EVERY
 * occurrence (17–27% of parse in the r6 autopsy). Now the LEXER computes a
 * rolling hash while it scans the ident chars (it touches each char anyway →
 * `tokHash`), and interning probes a custom open-addressed table: hash + length
 * + direct charCodeAt comparison against the source — NO slice on the probe.
 * The string is materialized only on FIRST occurrence.
 * SCOPE: identifiers + private-identifier names (the repeated-name population).
 * Literal raws are NOT interned (r6: raws repeat far less, ~1% of retained).
 *
 * SlicedString CAUTION (measured, real): V8 represents `.slice()` results of
 * >= 13 chars as SlicedStrings that RETAIN THE PARENT — a long name sliced
 * straight from the source pins the ENTIRE source in the tree (the pre-L1 code
 * had this bug; llm/spikes/03-parse-levers/bench/sliced-probe.ts retained a
 * 32 MB source through a handful of long names). Every materialization
 * (interned names AND literal raws) therefore force-flattens long slices via
 * the concat trick: `(' ' + s).substring(1)` re-parents the slice onto a fresh
 * (len+1)-char flat string, so nothing in the tree references the source. */
const FLATTEN_MIN = 13; // V8 SlicedString::kMinLength

/** Materialize src[start,end) as a string that NEVER retains the source. */
function sliceFlat(start: number, end: number): string {
    const s = src.slice(start, end);
    return end - start >= FLATTEN_MIN ? (' ' + s).substring(1) : s;
}

let itKeys: (string | undefined)[] = [];
let itHashes = new Int32Array(0);
let itMask = 0;
let itCount = 0;

function internReset(cap: number): void {
    itKeys = new Array(cap);
    itHashes = new Int32Array(cap);
    itMask = cap - 1;
    itCount = 0;
}

function internGrow(): void {
    const oldKeys = itKeys, oldHashes = itHashes;
    const cap = (itMask + 1) << 1;
    itKeys = new Array(cap);
    itHashes = new Int32Array(cap);
    itMask = cap - 1;
    for (let i = 0; i < oldKeys.length; i++) {
        const k = oldKeys[i];
        if (k === undefined) continue;
        const h = oldHashes[i];
        let j = h & itMask;
        while (itKeys[j] !== undefined) j = (j + 1) & itMask;
        itKeys[j] = k;
        itHashes[j] = h;
    }
}

/** Rolling hash over src[start,end) — same formula the lexer computes inline. */
function hashRange(start: number, end: number): number {
    let h = 0;
    for (let i = start; i < end; i++) h = (Math.imul(h, 31) + src.charCodeAt(i)) | 0;
    return h;
}

/** Intern src[start,end) given its rolling hash. The probe is slice-free: hash,
 * then length, then direct charCodeAt comparison against the source. */
function intern(start: number, end: number, hash: number): string {
    let i = hash & itMask;
    const len = end - start;
    for (;;) {
        const k = itKeys[i];
        if (k === undefined) break;
        if (itHashes[i] === hash && k.length === len) {
            let j = 0;
            while (j < len && k.charCodeAt(j) === src.charCodeAt(start + j)) j++;
            if (j === len) return k;
        }
        i = (i + 1) & itMask;
    }
    const s = sliceFlat(start, end); // first occurrence: materialize (source-free)
    itKeys[i] = s;
    itHashes[i] = hash;
    if (++itCount * 4 > (itMask + 1) * 3) internGrow(); // load factor 3/4
    return s;
}

/* ---- L2: line table fused into the lexer ----
 * buildLineTable used to be a SECOND full pass over the source. The lexer is the
 * only consumer of every char, so it records newline offsets as it consumes them
 * (whitespace skip, comments, string/template bodies, escaped newlines). Output
 * is the identical Uint32Array (offset of each line start; only '\n' counts —
 * \r / U+2028 / U+2029 are ASI-relevant but not line starts, matching
 * buildLineTable). Speculation rewinds (saveState/restoreState) truncate via the
 * saved lineCount; re-scans then re-record the same offsets. */
let lineStarts = new Uint32Array(1 << 12);
let lineCount = 0;
/** Record a newline AT offset i (line starts at i+1). */
function recordNL(i: number): void {
    if (lineCount >= lineStarts.length) {
        const bigger = new Uint32Array(lineStarts.length << 1);
        bigger.set(lineStarts);
        lineStarts = bigger;
    }
    lineStarts[lineCount++] = i + 1;
}

const C_WS = 1, C_NL = 2, C_ID = 3, C_DIG = 4;
const CHAR = new Uint8Array(128);
CHAR[9] = C_WS; CHAR[11] = C_WS; CHAR[12] = C_WS; CHAR[32] = C_WS;
CHAR[10] = C_NL; CHAR[13] = C_NL;
for (let i = 97; i <= 122; i++) CHAR[i] = C_ID;
for (let i = 65; i <= 90; i++) CHAR[i] = C_ID;
CHAR[95] = C_ID; CHAR[36] = C_ID;
for (let i = 48; i <= 57; i++) CHAR[i] = C_DIG;

function keywordCode(s: number, e: number): number {
    switch (e - s) {
        case 2:
            if (src.startsWith('if', s)) return K.IF;
            if (src.startsWith('in', s)) return K.IN;
            if (src.startsWith('do', s)) return K.DO;
            if (src.startsWith('of', s)) return K.OF;
            if (src.startsWith('as', s)) return K.AS;
            if (src.startsWith('is', s)) return K.IS;
            return 0;
        case 3:
            if (src.startsWith('var', s)) return K.VAR;
            if (src.startsWith('for', s)) return K.FOR;
            if (src.startsWith('new', s)) return K.NEW;
            if (src.startsWith('let', s)) return K.LET;
            if (src.startsWith('try', s)) return K.TRY;
            if (src.startsWith('get', s)) return K.GET;
            if (src.startsWith('set', s)) return K.SET;
            return 0;
        case 4:
            if (src.startsWith('this', s)) return K.THIS;
            if (src.startsWith('else', s)) return K.ELSE;
            if (src.startsWith('case', s)) return K.CASE;
            if (src.startsWith('true', s)) return K.TRUE;
            if (src.startsWith('null', s)) return K.NULL;
            if (src.startsWith('void', s)) return K.VOID;
            if (src.startsWith('with', s)) return K.WITH;
            if (src.startsWith('enum', s)) return K.ENUM;
            if (src.startsWith('from', s)) return K.FROM;
            if (src.startsWith('type', s)) return K.TYPE;
            return 0;
        case 5:
            if (src.startsWith('const', s)) return K.CONST;
            if (src.startsWith('class', s)) return K.CLASS;
            if (src.startsWith('super', s)) return K.SUPER;
            if (src.startsWith('while', s)) return K.WHILE;
            if (src.startsWith('break', s)) return K.BREAK;
            if (src.startsWith('catch', s)) return K.CATCH;
            if (src.startsWith('throw', s)) return K.THROW;
            if (src.startsWith('false', s)) return K.FALSE;
            if (src.startsWith('yield', s)) return K.YIELD;
            if (src.startsWith('async', s)) return K.ASYNC;
            if (src.startsWith('await', s)) return K.AWAIT;
            if (src.startsWith('keyof', s)) return K.KEYOF;
            if (src.startsWith('infer', s)) return K.INFER;
            return 0;
        case 6:
            if (src.startsWith('return', s)) return K.RETURN;
            if (src.startsWith('typeof', s)) return K.TYPEOF;
            if (src.startsWith('delete', s)) return K.DELETE;
            if (src.startsWith('import', s)) return K.IMPORT;
            if (src.startsWith('export', s)) return K.EXPORT;
            if (src.startsWith('switch', s)) return K.SWITCH;
            if (src.startsWith('static', s)) return K.STATIC;
            if (src.startsWith('module', s)) return K.MODULE;
            if (src.startsWith('unique', s)) return K.UNIQUE;
            return 0;
        case 7:
            if (src.startsWith('default', s)) return K.DEFAULT;
            if (src.startsWith('extends', s)) return K.EXTENDS;
            if (src.startsWith('finally', s)) return K.FINALLY;
            if (src.startsWith('declare', s)) return K.DECLARE;
            if (src.startsWith('asserts', s)) return K.ASSERTS;
            return 0;
        case 8:
            if (src.startsWith('function', s)) return K.FUNCTION;
            if (src.startsWith('continue', s)) return K.CONTINUE;
            if (src.startsWith('debugger', s)) return K.DEBUGGER;
            if (src.startsWith('abstract', s)) return K.ABSTRACT;
            if (src.startsWith('override', s)) return K.OVERRIDE;
            if (src.startsWith('readonly', s)) return K.READONLY;
            if (src.startsWith('accessor', s)) return K.ACCESSOR;
            return 0;
        case 9:
            if (src.startsWith('interface', s)) return K.INTERFACE;
            if (src.startsWith('namespace', s)) return K.NAMESPACE;
            if (src.startsWith('satisfies', s)) return K.SATISFIES;
            return 0;
        case 10:
            if (src.startsWith('instanceof', s)) return K.INSTANCEOF;
            if (src.startsWith('implements', s)) return K.IMPLEMENTS;
            return 0;
        default:
            return 0;
    }
}

function nextToken(): void {
    let nl = 0;
    while (pos < srcLen) {
        const c = src.charCodeAt(pos);
        if (c < 128) {
            const cls = CHAR[c];
            if (cls === C_WS) { pos++; continue; }
            if (cls === C_NL) { nl = F_NL; if (c === 10) recordNL(pos); pos++; continue; }
            if (c === 47) {
                const c1 = src.charCodeAt(pos + 1);
                if (c1 === 47) { pos += 2; while (pos < srcLen && src.charCodeAt(pos) !== 10) pos++; continue; }
                if (c1 === 42) {
                    pos += 2;
                    while (pos < srcLen) {
                        const cc = src.charCodeAt(pos);
                        if (cc === 42 && src.charCodeAt(pos + 1) === 47) { pos += 2; break; }
                        if (cc === 10) { nl = F_NL; recordNL(pos); }
                        pos++;
                    }
                    continue;
                }
            }
            break;
        }
        if (c === 0x2028 || c === 0x2029) { nl = F_NL; pos++; continue; }
        if (c === 0xa0 || c === 0xfeff) { pos++; continue; }
        break;
    }
    tokFlags = nl;
    tokStart = pos;
    if (pos >= srcLen) { tok = T_EOF; tokEnd = pos; tokVal = 0; return; }
    const c = src.charCodeAt(pos);

    if (c < 128 ? CHAR[c] === C_ID : true) {
        let h = c;
        pos++;
        while (pos < srcLen) {
            const cc = src.charCodeAt(pos);
            if (cc < 128) { const cl = CHAR[cc]; if (cl !== C_ID && cl !== C_DIG) break; }
            else if (cc === 0x2028 || cc === 0x2029) break;
            h = (Math.imul(h, 31) + cc) | 0;
            pos++;
        }
        tokHash = h;
        const kw = keywordCode(tokStart, pos);
        if (kw === 0) { tok = T_IDENT; tokVal = 0; } else { tok = T_KW; tokVal = kw; }
        tokEnd = pos;
        return;
    }
    if (CHAR[c] === C_DIG || (c === 46 && CHAR[src.charCodeAt(pos + 1)] === C_DIG)) { scanNumber(); return; }
    if (c === 34 || c === 39) {
        pos++;
        while (pos < srcLen) {
            const cc = src.charCodeAt(pos);
            if (cc === c) { pos++; break; }
            if (cc === 92) { // escaped char may be a line-continuation '\n'
                if (src.charCodeAt(pos + 1) === 10) recordNL(pos + 1);
                pos += 2;
            } else {
                if (cc === 10) recordNL(pos); // tolerated unterminated-string newline
                pos++;
            }
        }
        tok = T_STR; tokEnd = pos; tokVal = 0;
        return;
    }
    if (c === 96) { pos++; scanTemplatePart(); return; }
    if (c === 35) {
        if (tokStart === 0 && src.charCodeAt(1) === 33) {
            while (pos < srcLen && src.charCodeAt(pos) !== 10) pos++;
            nextToken();
            return;
        }
        pos++;
        let h = 0; // hash of the name AFTER the '#' (what parsePrivate interns)
        while (pos < srcLen) {
            const cc = src.charCodeAt(pos);
            if (cc < 128 && CHAR[cc] !== C_ID && CHAR[cc] !== C_DIG) break;
            if (cc >= 128 && (cc === 0x2028 || cc === 0x2029)) break;
            h = (Math.imul(h, 31) + cc) | 0;
            pos++;
        }
        tokHash = h;
        tok = T_PRIVATE; tokEnd = pos; tokVal = 0;
        return;
    }
    scanPunct(c);
}

function scanNumber(): void {
    let c = src.charCodeAt(pos);
    pos++;
    if (c === 48 && pos < srcLen) {
        const x = src.charCodeAt(pos) | 32;
        if (x === 120 || x === 111 || x === 98) pos++;
    }
    while (pos < srcLen) {
        c = src.charCodeAt(pos);
        if (c < 128 && (CHAR[c] === C_DIG || CHAR[c] === C_ID)) {
            if ((c | 32) === 101 && pos + 1 < srcLen) {
                const nx = src.charCodeAt(pos + 1);
                if (nx === 43 || nx === 45) pos++;
            }
            pos++;
        } else if (c === 46) pos++;
        else break;
    }
    tok = src.charCodeAt(pos - 1) === 110 ? T_BIGINT : T_NUM;
    tokEnd = pos;
    tokVal = 0;
}

function scanTemplatePart(): void {
    while (pos < srcLen) {
        const c = src.charCodeAt(pos);
        if (c === 96) { pos++; tok = T_TEMPLATE_FULL; tokEnd = pos; tokVal = 0; return; }
        if (c === 36 && src.charCodeAt(pos + 1) === 123) { pos += 2; tok = T_TEMPLATE_HEAD; tokEnd = pos; tokVal = 0; return; }
        if (c === 92) { // escaped char may be a line-continuation '\n'
            if (src.charCodeAt(pos + 1) === 10) recordNL(pos + 1);
            pos += 2;
        } else {
            if (c === 10) recordNL(pos); // raw newline inside a template literal
            pos++;
        }
    }
    tok = T_TEMPLATE_FULL; tokEnd = pos; tokVal = 0;
}

function reScanTemplateContinue(): void {
    pos = tokStart + 1;
    tokStart = pos - 1;
    scanTemplatePart();
}

function reScanRegex(): void {
    pos = tokStart + 1;
    let inClass = false;
    while (pos < srcLen) {
        const c = src.charCodeAt(pos);
        if (c === 92) { // escape may swallow a '\n' in a (broken) regex body
            if (src.charCodeAt(pos + 1) === 10) recordNL(pos + 1);
            pos += 2;
            continue;
        }
        if (c === 91) inClass = true;
        else if (c === 93) inClass = false;
        else if (c === 47 && !inClass) {
            pos++;
            while (pos < srcLen) {
                const f = src.charCodeAt(pos);
                if (f < 128 && (CHAR[f] === C_ID || CHAR[f] === C_DIG)) pos++;
                else break;
            }
            tok = T_REGEX; tokEnd = pos; tokVal = 0;
            return;
        } else if (c === 10) break;
        pos++;
    }
    err('unterminated regex');
    tok = T_REGEX; tokEnd = pos; tokVal = 0;
}

function scanPunct(c: number): void {
    const c1 = pos + 1 < srcLen ? src.charCodeAt(pos + 1) : 0;
    const c2 = pos + 2 < srcLen ? src.charCodeAt(pos + 2) : 0;
    let v = 0;
    let n = 1;
    switch (c) {
        case 40: v = P.LPAREN; break;
        case 41: v = P.RPAREN; break;
        case 123: v = P.LBRACE; break;
        case 125: v = P.RBRACE; break;
        case 91: v = P.LBRACKET; break;
        case 93: v = P.RBRACKET; break;
        case 59: v = P.SEMI; break;
        case 44: v = P.COMMA; break;
        case 64: v = P.AT; break;
        case 126: v = P.TILDE; break;
        case 46: if (c1 === 46 && c2 === 46) { v = P.DOTDOTDOT; n = 3; } else v = P.DOT; break;
        case 61:
            if (c1 === 61) { if (c2 === 61) { v = P.EQEQEQ; n = 3; } else { v = P.EQEQ; n = 2; } }
            else if (c1 === 62) { v = P.ARROW; n = 2; }
            else v = P.EQ;
            break;
        case 33:
            if (c1 === 61) { if (c2 === 61) { v = P.NEQEQ; n = 3; } else { v = P.NEQ; n = 2; } }
            else v = P.BANG;
            break;
        case 60:
            if (c1 === 60) { if (c2 === 61) { v = P.SHLEQ; n = 3; } else { v = P.SHL; n = 2; } }
            else if (c1 === 61) { v = P.LE; n = 2; }
            else v = P.LT;
            break;
        case 62:
            if (c1 === 62) {
                if (c2 === 62) { if (src.charCodeAt(pos + 3) === 61) { v = P.USHREQ; n = 4; } else { v = P.USHR; n = 3; } }
                else if (c2 === 61) { v = P.SHREQ; n = 3; }
                else { v = P.SHR; n = 2; }
            } else if (c1 === 61) { v = P.GE; n = 2; }
            else v = P.GT;
            break;
        case 43: if (c1 === 43) { v = P.PLUSPLUS; n = 2; } else if (c1 === 61) { v = P.PLUSEQ; n = 2; } else v = P.PLUS; break;
        case 45: if (c1 === 45) { v = P.MINUSMINUS; n = 2; } else if (c1 === 61) { v = P.MINUSEQ; n = 2; } else v = P.MINUS; break;
        case 42:
            if (c1 === 42) { if (c2 === 61) { v = P.STARSTAREQ; n = 3; } else { v = P.STARSTAR; n = 2; } }
            else if (c1 === 61) { v = P.STAREQ; n = 2; }
            else v = P.STAR;
            break;
        case 47: if (c1 === 61) { v = P.SLASHEQ; n = 2; } else v = P.SLASH; break;
        case 37: if (c1 === 61) { v = P.PERCENTEQ; n = 2; } else v = P.PERCENT; break;
        case 38:
            if (c1 === 38) { if (c2 === 61) { v = P.AMPAMPEQ; n = 3; } else { v = P.AMPAMP; n = 2; } }
            else if (c1 === 61) { v = P.AMPEQ; n = 2; }
            else v = P.AMP;
            break;
        case 124:
            if (c1 === 124) { if (c2 === 61) { v = P.PIPEPIPEEQ; n = 3; } else { v = P.PIPEPIPE; n = 2; } }
            else if (c1 === 61) { v = P.PIPEEQ; n = 2; }
            else v = P.PIPE;
            break;
        case 94: if (c1 === 61) { v = P.CARETEQ; n = 2; } else v = P.CARET; break;
        case 63:
            if (c1 === 63) { if (c2 === 61) { v = P.QQEQ; n = 3; } else { v = P.QQ; n = 2; } }
            else if (c1 === 46 && !(c2 >= 48 && c2 <= 57)) { v = P.QDOT; n = 2; }
            else v = P.QUESTION;
            break;
        case 58: v = P.COLON; break;
        default:
            err(`unexpected character '${String.fromCharCode(c)}'`);
            pos++;
            nextToken();
            return;
    }
    pos += n;
    tok = T_PUNCT; tokEnd = pos; tokVal = v;
}

/* ---------------------------------------------------------- parser helpers */

function err(msg: string): void {
    if (errors.length < 100) errors.push({ pos: tokStart, msg });
}

const isP = (v: number): boolean => tok === T_PUNCT && tokVal === v;
const isK = (v: number): boolean => tok === T_KW && tokVal === v;

function eatP(v: number): boolean { if (isP(v)) { nextToken(); return true; } return false; }
function expectP(v: number, what: string): void { if (isP(v)) nextToken(); else err(`expected ${what}`); }
function eatK(v: number): boolean { if (isK(v)) { nextToken(); return true; } return false; }

function isIdentLike(): boolean { return tok === T_IDENT || (tok === T_KW && CONTEXTUAL.has(tokVal)); }
function isNameLike(): boolean { return tok === T_IDENT || tok === T_KW; }

/* ---- leaf constructors (materialize name/value/raw at parse) ---- */

// Leaf constructors: the ONLY node-shape-specific parser code. The identifier's
// name (and every literal's raw) lives in the outer `name` slot (data:null) — the
// type+data leaf. Built as a DIRECT object literal in the fixed key order
// { type, start, end, name, data } so the leaf shares the one hidden class with
// every interior node. Identifier names are INTERNED (i3); literal raws are not.
// Identifier ROLE leaf: the role type id (BindingIdentifier / IdentifierReference
// / IdentifierName / LabelIdentifier) is fixed by the CALL SITE — the parser
// knows the grammatical position. All four are data:null name-slot leaves.
function ident(role: number, start: number, end: number): Identifier {
    // Current-token spans reuse the hash the lexer computed during the scan
    // (tokHash); historical spans (shorthand keys, re-materialized names) rehash
    // — rare and short. Content is sliced from src either way, so this guard is
    // purely a fast path, never a correctness question.
    const h = start === tokStart && end === tokEnd ? tokHash : hashRange(start, end);
    return { id: nextId(), type: role, start, end, name: intern(start, end, h), data: null } as RawNode as Identifier;
}
/** A leaf literal (Num/Str/Regex/BigInt/TemplateElement): raw text sliced (not
 * interned) into the outer name slot; span-only constructors (start,end).
 * sliceFlat: long raws must not retain the source (SlicedString, see L1 note). */
function leafRaw(flatType: number, start: number, end: number): Node {
    return { id: nextId(), type: flatType, start, end, name: sliceFlat(start, end), data: null } as RawNode as Node;
}
/** Parse an identifier token in the given role. `role` picks the leaf type. */
function parseIdent(role: number): Identifier {
    if (!isIdentLike()) { err('expected identifier'); return makeMissingIdent(role); }
    const id = ident(role, tokStart, tokEnd);
    nextToken();
    return id;
}
/** Parse a name-or-keyword token as an identifier in the given role (property
 * keys, member names, specifier names — usually IdentifierName). */
function parseNameAsIdent(role: number): Identifier {
    if (!isNameLike()) { err('expected name'); return makeMissingIdent(role); }
    const id = ident(role, tokStart, tokEnd);
    nextToken();
    return id;
}
function makeMissingIdent(role: number): Identifier { return { id: nextId(), type: role, start: 0, end: 0, name: '', data: null } as RawNode as Identifier; }
/** A literal/leaf of the given flat type at the current token span. */
function leaf(flatType: number, start: number, end: number): Node {
    return leafRaw(flatType, start, end);
}

const canInsertSemi = (): boolean => (tokFlags & F_NL) !== 0 || tok === T_EOF || isP(P.RBRACE);
function consumeSemi(): void { if (eatP(P.SEMI)) return; if (!canInsertSemi()) err("expected ';'"); }

type LexState = [number, number, number, number, number, number, number, number, number];
const saveState = (): LexState => [pos, tok, tokStart, tokEnd, tokFlags, tokVal, errors.length, tokHash, lineCount];
function restoreState(s: LexState): void {
    pos = s[0]; tok = s[1]; tokStart = s[2]; tokEnd = s[3]; tokFlags = s[4]; tokVal = s[5];
    errors.length = s[6]; tokHash = s[7]; lineCount = s[8]; // rewind truncates the line table (L2)
}

// object list stack — the arena-free analogue of flat's Uint32 scratch stack.
// L3: the stack is kept PACKED_ELEMENTS (built by push, grown by push — never
// `new Array(n)` / `length = n`, both of which go HOLEY), so finishList can emit
// each child list as ONE exact-size PACKED array via Array#slice (V8 memcpy fast
// path, no per-element copy loop, no capacity slack, packed elements kind).
const stkInit = (): Ref[] => { const a: Ref[] = []; for (let i = 0; i < 1 << 12; i++) a.push(null); return a; };
let stk: Ref[] = stkInit();
let sp = 0;
function push(v: Ref): void {
    if (sp === stk.length) { const n = stk.length; for (let i = 0; i < n; i++) stk.push(null); }
    stk[sp++] = v;
}
/** Materialize [from, sp) into a fresh exact-size packed array (dropping the run). */
function finishList(from: number): Node[] {
    const out = stk.slice(from, sp) as Node[]; // no nulls in a finishList run
    sp = from;
    return out;
}
/** As finishList but typed to preserve nulls (array-pattern / call holes). */
function finishListWithHoles(from: number): (Node | null)[] {
    const out = stk.slice(from, sp);
    sp = from;
    return out;
}

/* re-derive a scalar from a materialized node (for declare-prefix rewrite):
 * `declare` lives in the node's PAYLOAD (data.declare) in type+data. */
function applyDeclare(inner: Node, start: number): void {
    const r: RawNode = inner;
    if (r.data !== null) r.data.declare = true;
    inner.start = start;
}

/* ------------------------------------------------------------ expressions */

const BIN_PREC = new Uint8Array(64);
const BIN_OP = new Uint8Array(64);
{
    const set = (p: number, prec: number, op: number) => { BIN_PREC[p] = prec; BIN_OP[p] = op; };
    set(P.QQ, 1, OP.NULLISH);
    set(P.PIPEPIPE, 2, OP.OR);
    set(P.AMPAMP, 3, OP.AND);
    set(P.PIPE, 4, OP.BIT_OR);
    set(P.CARET, 5, OP.BIT_XOR);
    set(P.AMP, 6, OP.BIT_AND);
    set(P.EQEQ, 7, OP.EQ); set(P.NEQ, 7, OP.NE); set(P.EQEQEQ, 7, OP.SEQ); set(P.NEQEQ, 7, OP.SNE);
    set(P.LT, 8, OP.LT); set(P.GT, 8, OP.GT); set(P.LE, 8, OP.LE); set(P.GE, 8, OP.GE);
    set(P.SHL, 9, OP.SHL); set(P.SHR, 9, OP.SHR); set(P.USHR, 9, OP.USHR);
    set(P.PLUS, 10, OP.ADD); set(P.MINUS, 10, OP.SUB);
    set(P.STAR, 11, OP.MUL); set(P.SLASH, 11, OP.DIV); set(P.PERCENT, 11, OP.MOD);
    set(P.STARSTAR, 12, OP.EXP);
}
const ASSIGN_OP = new Uint8Array(64);
{
    const a = (p: number, op: number) => { ASSIGN_OP[p] = op; };
    a(P.EQ, OP.ASSIGN); a(P.PLUSEQ, OP.ADD_A); a(P.MINUSEQ, OP.SUB_A); a(P.STAREQ, OP.MUL_A);
    a(P.SLASHEQ, OP.DIV_A); a(P.PERCENTEQ, OP.MOD_A); a(P.STARSTAREQ, OP.EXP_A);
    a(P.SHLEQ, OP.SHL_A); a(P.SHREQ, OP.SHR_A); a(P.USHREQ, OP.USHR_A);
    a(P.AMPEQ, OP.AND_A); a(P.PIPEEQ, OP.OR_A); a(P.CARETEQ, OP.XOR_A);
    a(P.AMPAMPEQ, OP.LOGAND_A); a(P.PIPEPIPEEQ, OP.LOGOR_A); a(P.QQEQ, OP.NULLISH_A);
}

function parseExpression(noIn = false): Node {
    const expr = parseAssign(noIn);
    if (isP(P.COMMA)) {
        const start = expr.start;
        const from = sp;
        push(expr);
        while (eatP(P.COMMA)) push(parseAssign(noIn));
        return m.SequenceExpression(start, tokStart, 0, finishList(from)) as Node;
    }
    return expr;
}

function parseAssign(noIn = false): Node {
    if (isP(P.LPAREN) && arrowAheadFromParen()) return parseArrow(tokStart, 0, null);
    if (isIdentLike() && !isK(K.ASYNC)) {
        const s = saveState();
        if (tok === T_IDENT || CONTEXTUAL.has(tokVal)) {
            const idStart = tokStart;
            // Speculative: this ident is a single arrow param (binding) if `=>`
            // follows; otherwise state is restored and it's reparsed as an expr.
            const maybe = parseIdent(R_BIND);
            if (isP(P.ARROW) && (tokFlags & F_NL) === 0) return parseArrowAfterSingleParam(idStart, maybe, 0);
            restoreState(s);
        }
    }
    if (isK(K.ASYNC) && (tokFlags & F_NL) === 0) {
        const s = saveState();
        const asyncStart = tokStart;
        nextToken();
        if ((tokFlags & F_NL) === 0) {
            if (isP(P.LPAREN) && arrowAheadFromParen()) return parseArrow(asyncStart, FL.ASYNC, null);
            if (isIdentLike()) {
                const idStart = tokStart;
                const p = parseIdent(R_BIND); // single async arrow param (binding)
                if (isP(P.ARROW)) return parseArrowAfterSingleParam(asyncStart, p, FL.ASYNC, idStart);
            }
        }
        restoreState(s);
    }
    if (tsMode && isP(P.LT)) {
        const s = saveState();
        const start = tokStart;
        const tp = tryParseTypeParams();
        if (tp !== null && isP(P.LPAREN) && arrowAheadFromParen()) return parseArrow(start, 0, tp);
        restoreState(s);
    }
    if (isK(K.YIELD)) {
        const start = tokStart;
        nextToken();
        let flags = 0;
        if (isP(P.STAR)) { flags |= FL.DELEGATE; nextToken(); }
        let arg: Ref = null;
        if (!canInsertSemi() && !isP(P.RPAREN) && !isP(P.RBRACKET) && !isP(P.RBRACE) && !isP(P.COMMA) && !isP(P.SEMI) && !isP(P.COLON))
            arg = parseAssign(noIn);
        return m.YieldExpression(start, arg ? arg.end : tokStart, flags, arg) as Node;
    }

    const left = parseConditional(noIn);
    if (tok === T_PUNCT && ASSIGN_OP[tokVal] !== 0) {
        const op = ASSIGN_OP[tokVal];
        nextToken();
        const right = parseAssign(noIn);
        return m.AssignmentExpression(left.start, right.end, op, left, right) as Node;
    }
    return left;
}

function parseConditional(noIn: boolean): Node {
    const test = parseBinary(0, noIn);
    if (!isP(P.QUESTION)) return test;
    nextToken();
    const cons = parseAssign(false);
    expectP(P.COLON, "':'");
    const alt = parseAssign(noIn);
    return m.ConditionalExpression(test.start, alt.end, 0, test, cons, alt) as Node;
}

function parseBinary(minPrec: number, noIn: boolean): Node {
    let left = parseUnary();
    for (;;) {
        let prec = 0;
        let op = 0;
        let logical = false;
        if (tok === T_PUNCT) {
            prec = BIN_PREC[tokVal];
            op = BIN_OP[tokVal];
            logical = tokVal === P.QQ || tokVal === P.PIPEPIPE || tokVal === P.AMPAMP;
        } else if (tok === T_KW) {
            if (tokVal === K.IN && !noIn) { prec = 8; op = OP.IN; }
            else if (tokVal === K.INSTANCEOF) { prec = 8; op = OP.INSTANCEOF; }
            else if (tsMode && (tokVal === K.AS || tokVal === K.SATISFIES) && (tokFlags & F_NL) === 0) {
                const satisfies = tokVal === K.SATISFIES;
                nextToken();
                const ty = parseType();
                left = satisfies
                    ? m.TSSatisfiesExpression(left.start, ty.end, 0, left, ty) as Node
                    : m.TSAsExpression(left.start, ty.end, 0, left, ty) as Node;
                continue;
            }
        }
        if (prec === 0 || prec <= minPrec) return left;
        const rightAssoc = op === OP.EXP;
        nextToken();
        const right = parseBinary(rightAssoc ? prec - 1 : prec, noIn);
        left = logical
            ? m.LogicalExpression(left.start, right.end, op, left, right) as Node
            : m.BinaryExpression(left.start, right.end, op, left, right) as Node;
    }
}

function parseUnary(): Node {
    const start = tokStart;
    if (tok === T_PUNCT) {
        switch (tokVal as number) {
            case P.PLUS: case P.MINUS: case P.BANG: case P.TILDE: {
                const op = tokVal === P.PLUS ? OP.POS : tokVal === P.MINUS ? OP.NEG : tokVal === P.BANG ? OP.NOT : OP.BIT_NOT;
                nextToken();
                const arg = parseUnary();
                return m.UnaryExpression(start, arg.end, op, arg) as Node;
            }
            case P.PLUSPLUS: case P.MINUSMINUS: {
                const op = tokVal === P.PLUSPLUS ? OP.INC : OP.DEC;
                nextToken();
                const arg = parseUnary();
                return m.UpdateExpression(start, arg.end, op | FL.PREFIX, arg) as Node;
            }
        }
    } else if (tok === T_KW) {
        switch (tokVal as number) {
            case K.TYPEOF: case K.VOID: case K.DELETE: {
                const op = tokVal === K.TYPEOF ? OP.TYPEOF : tokVal === K.VOID ? OP.VOID : OP.DELETE;
                nextToken();
                const arg = parseUnary();
                return m.UnaryExpression(start, arg.end, op, arg) as Node;
            }
            case K.AWAIT: {
                nextToken();
                const arg = parseUnary();
                return m.AwaitExpression(start, arg.end, 0, arg) as Node;
            }
        }
    }
    let expr = parsePostfixChain();
    if (tok === T_PUNCT && (tokVal === P.PLUSPLUS || tokVal === P.MINUSMINUS) && (tokFlags & F_NL) === 0) {
        const op = tokVal === P.PLUSPLUS ? OP.INC : OP.DEC;
        nextToken();
        expr = m.UpdateExpression(expr.start, tokStart, op, expr) as Node;
    }
    return expr;
}

function parsePostfixChain(): Node {
    if (isK(K.NEW)) return parseNew();
    return parseMemberChain(parsePrimary(), true);
}

function parseNew(): Node {
    const start = tokStart;
    nextToken();
    if (isP(P.DOT)) {
        nextToken();
        parseNameAsIdent(R_NAME); // `target` in new.target — meta-property part, discarded
        return m.NewTarget(start, tokStart, 0) as Node;
    }
    const callee: Node = isK(K.NEW) ? parseNew() : parseMemberChain(parsePrimary(), false);
    let typeArgs: Ref = null;
    if (tsMode && isP(P.LT)) { const t = tryParseTypeArgsForCall(); if (t !== null) typeArgs = t; }
    let args: Node[] | null = null;
    let end = callee.end;
    if (isP(P.LPAREN)) { args = parseArgs(); end = tokStart; }
    const nw = m.NewExpression(start, end, 0, callee, args, typeArgs) as Node;
    return parseMemberChain(nw, true);
}

function parseArgs(): Node[] {
    nextToken();
    const from = sp;
    while (!isP(P.RPAREN) && (tok as number) !== T_EOF) {
        if (isP(P.DOTDOTDOT)) {
            const s = tokStart;
            nextToken();
            const arg = parseAssign();
            push(m.SpreadElement(s, arg.end, 0, arg) as Node);
        } else push(parseAssign());
        if (!eatP(P.COMMA)) break;
    }
    expectP(P.RPAREN, "')'");
    return finishList(from);
}

function parseMemberChain(expr: Node, allowCall: boolean): Node {
    // An optional-chain "run": if ANY link here uses `?.` (member or call), the
    // OUTERMOST node of this run is wrapped in a ChainExpression (ESTree
    // semantics — the whole-chain short-circuit boundary). Parentheses terminate
    // a chain naturally: a parenthesized subexpression is a nested parse whose
    // own run already wrapped, and its members re-enter here as a fresh run.
    let sawOptional = false;
    // Wrap-on-exit helper: every early return must funnel through this so the
    // ChainExpression lands on the outermost link no matter where the run ends.
    const finish = (e: Node): Node => (sawOptional ? (m.ChainExpression(e.start, e.end, 0, e) as Node) : e);
    for (;;) {
        if (isP(P.DOT)) {
            nextToken();
            if (tok === T_PRIVATE) {
                const prop = parsePrivate(); // #field — private field access
                expr = m.PrivateFieldExpression(expr.start, prop.end, 0, expr, prop) as Node;
            } else {
                const prop = parseNameAsIdent(R_NAME); // non-computed member property (IdentifierName)
                expr = m.StaticMemberExpression(expr.start, prop.end, 0, expr, prop) as Node;
            }
        } else if (isP(P.QDOT)) {
            sawOptional = true;
            nextToken();
            if (isP(P.LPAREN)) {
                if (!allowCall) return finish(expr);
                const args = parseArgs();
                expr = m.CallExpression(expr.start, tokStart, FL.OPTIONAL, expr, args, null) as Node;
            } else if (isP(P.LBRACKET)) {
                nextToken();
                const prop = parseExpression();
                expectP(P.RBRACKET, "']'");
                expr = m.ComputedMemberExpression(expr.start, tokStart, FL.OPTIONAL, expr, prop) as Node;
            } else if (tok === T_PRIVATE) {
                const prop = parsePrivate(); // optional private field access `a?.#b`
                expr = m.PrivateFieldExpression(expr.start, prop.end, FL.OPTIONAL, expr, prop) as Node;
            } else {
                const prop = parseNameAsIdent(R_NAME); // non-computed optional member property
                expr = m.StaticMemberExpression(expr.start, prop.end, FL.OPTIONAL, expr, prop) as Node;
            }
        } else if (isP(P.LBRACKET)) {
            nextToken();
            const prop = parseExpression();
            expectP(P.RBRACKET, "']'");
            expr = m.ComputedMemberExpression(expr.start, tokStart, 0, expr, prop) as Node;
        } else if (allowCall && isP(P.LPAREN)) {
            const args = parseArgs();
            expr = m.CallExpression(expr.start, tokStart, 0, expr, args, null) as Node;
        } else if (tok === T_TEMPLATE_FULL || tok === T_TEMPLATE_HEAD) {
            const quasi = parseTemplate();
            expr = m.TaggedTemplateExpression(expr.start, quasi.end, 0, expr, quasi) as Node;
        } else if (tsMode && isP(P.BANG) && (tokFlags & F_NL) === 0) {
            nextToken();
            expr = m.TSNonNullExpression(expr.start, tokStart, 0, expr) as Node;
        } else if (tsMode && allowCall && isP(P.LT)) {
            const t = tryParseTypeArgsForCall();
            if (t === null) return finish(expr);
            if (isP(P.LPAREN)) {
                const args = parseArgs();
                expr = m.CallExpression(expr.start, tokStart, 0, expr, args, t) as Node;
            } else if (tok === T_TEMPLATE_FULL || tok === T_TEMPLATE_HEAD) {
                const quasi = parseTemplate();
                expr = m.TaggedTemplateExpression(expr.start, quasi.end, 0, expr, quasi) as Node;
            } else return finish(expr);
        } else return finish(expr);
    }
}

function parsePrivate(): Node {
    // The ESTree name excludes the leading '#'. Built as a direct leaf literal in
    // the fixed key order (one hidden class); the stripped name is interned like an
    // identifier (private names repeat too).
    const id: Node = { id: nextId(), type: N.PrivateIdentifier, start: tokStart, end: tokEnd, name: intern(tokStart + 1, tokEnd, tokHash), data: null };
    nextToken();
    return id;
}

function parseTemplate(): Node {
    const start = tokStart;
    if (tok === T_TEMPLATE_FULL) {
        const q = leaf(N.TemplateElement, start + 1, tokEnd - 1);
        nextToken();
        return m.TemplateLiteral(start, q.end + 1, 0, [q], []) as Node;
    }
    const qFrom = sp;
    const eFrom: Node[] = [];
    push(leaf(N.TemplateElement, start + 1, tokEnd - 2));
    nextToken();
    for (;;) {
        eFrom.push(parseExpression());
        if (!isP(P.RBRACE)) { err("expected '}' in template"); break; }
        reScanTemplateContinue();
        if (tok === T_TEMPLATE_FULL) {
            push(leaf(N.TemplateElement, tokStart + 1, tokEnd - 1));
            nextToken();
            break;
        }
        push(leaf(N.TemplateElement, tokStart + 1, tokEnd - 2));
        nextToken();
    }
    const quasis = finishList(qFrom);
    return m.TemplateLiteral(start, tokStart, 0, quasis, eFrom) as Node;
}

function parsePrimary(): Node {
    const start = tokStart;
    switch (tok) {
        case T_NUM: { const n = leaf(N.NumericLiteral, start, tokEnd); nextToken(); return n; }
        case T_BIGINT: { const n = leaf(N.BigIntLiteral, start, tokEnd); nextToken(); return n; }
        case T_STR: { const n = leaf(N.StringLiteral, start, tokEnd); nextToken(); return n; }
        case T_REGEX: { const n = leaf(N.RegExpLiteral, start, tokEnd); nextToken(); return n; }
        case T_TEMPLATE_FULL: case T_TEMPLATE_HEAD: return parseTemplate();
        case T_PRIVATE: return parsePrivate();
        case T_IDENT: return parseIdent(R_REF); // primary expression identifier
    }
    if (tok === T_PUNCT) {
        switch (tokVal as number) {
            case P.SLASH: case P.SLASHEQ:
                reScanRegex();
                return parsePrimary();
            case P.LPAREN: {
                nextToken();
                const e = parseExpression();
                expectP(P.RPAREN, "')'");
                return e;
            }
            case P.LBRACKET: {
                nextToken();
                const from = sp;
                while (!isP(P.RBRACKET) && (tok as number) !== T_EOF) {
                    if (isP(P.COMMA)) { push(null); nextToken(); continue; }
                    if (isP(P.DOTDOTDOT)) {
                        const s = tokStart;
                        nextToken();
                        const arg = parseAssign();
                        push(m.SpreadElement(s, arg.end, 0, arg) as Node);
                    } else push(parseAssign());
                    if (!isP(P.RBRACKET)) expectP(P.COMMA, "','");
                }
                expectP(P.RBRACKET, "']'");
                return m.ArrayExpression(start, tokStart, 0, finishListWithHoles(from)) as Node;
            }
            case P.LBRACE: return parseObjectLiteral();
        }
    } else if (tok === T_KW) {
        switch (tokVal as number) {
            case K.THIS: nextToken(); return m.ThisExpression(start, tokStart, 0) as Node;
            case K.SUPER: nextToken(); return m.Super(start, tokStart, 0) as Node;
            case K.TRUE: nextToken(); return m.BooleanLiteral(start, tokStart, 1) as Node;
            case K.FALSE: nextToken(); return m.BooleanLiteral(start, tokStart, 0) as Node;
            case K.NULL: nextToken(); return m.NullLiteral(start, tokStart, 0) as Node;
            case K.FUNCTION: return parseFunction(false, false, true);
            case K.ASYNC:
                nextToken();
                if (isK(K.FUNCTION)) return parseFunction(true, false, true);
                return ident(R_REF, start, start + 5); // `async` used as a plain expression identifier
            case K.CLASS: return parseClass(true, 0);
            case K.IMPORT: {
                nextToken();
                if (isP(P.DOT)) {
                    nextToken();
                    parseNameAsIdent(R_NAME); // `meta` in import.meta — meta-property part, discarded
                    return m.ImportMeta(start, tokStart, 0) as Node;
                }
                expectP(P.LPAREN, "'('");
                const source = parseAssign();
                let options: Ref = null;
                if (eatP(P.COMMA) && !isP(P.RPAREN)) options = parseAssign();
                eatP(P.COMMA);
                expectP(P.RPAREN, "')'");
                return m.ImportExpression(start, tokStart, 0, source, options) as Node;
            }
            case K.NEW: return parseNew();
        }
        if (CONTEXTUAL.has(tokVal)) return parseIdent(R_REF); // contextual keyword as expression identifier
    }
    err('unexpected token in expression');
    nextToken();
    return makeMissingIdent(R_REF);
}

function parseObjectLiteral(): Node {
    const start = tokStart;
    nextToken();
    const from = sp;
    let last = -1;
    while (!isP(P.RBRACE) && (tok as number) !== T_EOF) {
        if (tokStart === last) { err('unexpected token in object literal'); nextToken(); continue; }
        last = tokStart;
        if (isP(P.DOTDOTDOT)) {
            const s = tokStart;
            nextToken();
            const arg = parseAssign();
            push(m.SpreadElement(s, arg.end, 0, arg) as Node);
        } else push(parseObjectMember());
        if (!isP(P.RBRACE)) expectP(P.COMMA, "','");
    }
    expectP(P.RBRACE, "'}'");
    return m.ObjectExpression(start, tokStart, 0, finishList(from)) as Node;
}

function parseObjectMember(): Node {
    const start = tokStart;
    let flags = 0;
    let async = false;
    let generator = false;
    if (isK(K.ASYNC) && !nextIsPropertyEnd()) { async = true; nextToken(); }
    if (isP(P.STAR)) { generator = true; nextToken(); }
    let kind = 0;
    if ((isK(K.GET) || isK(K.SET)) && !nextIsPropertyEnd()) { kind = isK(K.GET) ? 1 : 2; nextToken(); }
    let key: Node;
    if (isP(P.LBRACKET)) {
        flags |= FL.COMPUTED;
        nextToken();
        key = parseAssign();
        expectP(P.RBRACKET, "']'");
    } else if ((tok as number) === T_STR) { key = leaf(N.StringLiteral, tokStart, tokEnd); nextToken(); }
    else if (tok === T_NUM) { key = leaf(N.NumericLiteral, tokStart, tokEnd); nextToken(); }
    else key = parseNameAsIdent(R_NAME); // property key — a pure name (never resolves)

    if (kind !== 0 || async || generator || isP(P.LPAREN)) {
        const fn = parseMethodTail(start, (async ? FL.ASYNC : 0) | (generator ? FL.GENERATOR : 0));
        flags |= kind << FL.KIND_SHIFT;
        return m.ObjectProperty(start, fn.end, flags, key, fn) as Node;
    }
    if (isP(P.COLON)) {
        nextToken();
        const value = parseAssign();
        return m.ObjectProperty(start, value.end, flags, key, value) as Node;
    }
    // shorthand `{ a }` / `{ a = 1 }`: the VALUE resolves, so it is a distinct
    // IdentifierReference (not the IdentifierName key — no one node in two roles).
    const shorthandRef = ident(R_REF, key.start, key.end);
    if (isP(P.EQ)) {
        nextToken();
        const right = parseAssign();
        const value = m.AssignmentPattern(key.start, right.end, 0, shorthandRef, right) as Node;
        return m.ObjectProperty(start, right.end, flags | FL.SHORTHAND, key, value) as Node;
    }
    return m.ObjectProperty(start, key.end, flags | FL.SHORTHAND, key, shorthandRef) as Node;
}

function nextIsPropertyEnd(): boolean {
    const s = saveState();
    nextToken();
    const endLike =
        tok === T_EOF ||
        (tok === T_PUNCT &&
            (tokVal === P.COLON || tokVal === P.COMMA || tokVal === P.RBRACE || tokVal === P.LPAREN ||
                tokVal === P.EQ || tokVal === P.QUESTION || tokVal === P.SEMI || tokVal === P.RPAREN ||
                tokVal === P.LT || tokVal === P.BANG || tokVal === P.RBRACKET));
    restoreState(s);
    return endLike;
}

function parseMethodTail(start: number, flags: number): Node {
    let typeParams: Ref = null;
    if (tsMode && isP(P.LT)) { const t = tryParseTypeParams(); if (t !== null) typeParams = t; }
    const params = parseParams();
    let returnType: Ref = null;
    if (tsMode && isP(P.COLON)) returnType = parseTypeAnn();
    let body: Ref = null;
    if (isP(P.LBRACE)) body = parseBlock();
    else consumeSemi();
    return m.FunctionExpression(start, tokStart, flags, null, typeParams, params, returnType, body) as Node;
}

/* --------------------------------------------------------------- arrows */

function arrowAheadFromParen(): boolean {
    let p = tokStart + 1;
    let depth = 1;
    while (p < srcLen && depth > 0) {
        const c = src.charCodeAt(p);
        if (c === 40 || c === 91 || c === 123) depth += c === 40 ? 1 : 0, depth += c === 91 || c === 123 ? 1 : 0;
        else if (c === 41 || c === 93 || c === 125) depth--;
        else if (c === 34 || c === 39 || c === 96) {
            const q = c;
            p++;
            while (p < srcLen) {
                const cc = src.charCodeAt(p);
                if (cc === 92) { p += 2; continue; }
                if (cc === q) break;
                p++;
            }
        } else if (c === 47) {
            const c1 = src.charCodeAt(p + 1);
            if (c1 === 47) { while (p < srcLen && src.charCodeAt(p) !== 10) p++; continue; }
            if (c1 === 42) { p += 2; while (p < srcLen && !(src.charCodeAt(p) === 42 && src.charCodeAt(p + 1) === 47)) p++; p += 2; continue; }
        }
        p++;
    }
    for (;;) {
        while (p < srcLen) {
            const c = src.charCodeAt(p);
            if (c < 128 && (CHAR[c] === C_WS || CHAR[c] === C_NL)) p++;
            else break;
        }
        if (src.charCodeAt(p) === 47 && src.charCodeAt(p + 1) === 47) { while (p < srcLen && src.charCodeAt(p) !== 10) p++; continue; }
        if (src.charCodeAt(p) === 47 && src.charCodeAt(p + 1) === 42) { p += 2; while (p < srcLen && !(src.charCodeAt(p) === 42 && src.charCodeAt(p + 1) === 47)) p++; p += 2; continue; }
        break;
    }
    if (src.charCodeAt(p) === 61 && src.charCodeAt(p + 1) === 62) return true;
    if (tsMode && src.charCodeAt(p) === 58) {
        const s = saveState();
        const ok = trySpeculativeArrow();
        restoreState(s);
        return ok;
    }
    return false;
}

function trySpeculativeArrow(): boolean {
    try {
        speculating++;
        parseParams();
        if (isP(P.COLON)) parseTypeAnn();
        const ok = isP(P.ARROW);
        speculating--;
        return ok;
    } catch {
        speculating--;
        return false;
    }
}
let speculating = 0;

function parseArrow(start: number, flags: number, typeParams: Ref): Node {
    const params = parseParams();
    let returnType: Ref = null;
    if (tsMode && isP(P.COLON)) returnType = parseTypeAnn();
    expectP(P.ARROW, "'=>'");
    let body: Node;
    if (isP(P.LBRACE)) body = parseBlock();
    else { body = parseAssign(); flags |= FL.EXPR_BODY; }
    return m.ArrowFunctionExpression(start, body.end, flags, typeParams, params, returnType, body) as Node;
}

function parseArrowAfterSingleParam(start: number, id: Identifier, flags: number, identStart?: number): Node {
    const param = m.FormalParameter(identStart ?? start, id.end, 0, id, null, null) as Node;
    expectP(P.ARROW, "'=>'");
    let body: Node;
    if (isP(P.LBRACE)) body = parseBlock();
    else { body = parseAssign(); flags |= FL.EXPR_BODY; }
    return m.ArrowFunctionExpression(start, body.end, flags, null, [param], null, body) as Node;
}

/* ------------------------------------------------------- binding patterns */

function parseBindingTarget(): Node {
    if (isP(P.LBRACKET)) {
        const start = tokStart;
        nextToken();
        const from = sp;
        while (!isP(P.RBRACKET) && (tok as number) !== T_EOF) {
            if (isP(P.COMMA)) { push(null); nextToken(); continue; }
            if (isP(P.DOTDOTDOT)) {
                const s = tokStart;
                nextToken();
                const arg = parseBindingTarget();
                push(m.RestElement(s, arg.end, 0, arg, null) as Node);
            } else push(parseBindingElement());
            if (!isP(P.RBRACKET)) expectP(P.COMMA, "','");
        }
        expectP(P.RBRACKET, "']'");
        return m.ArrayPattern(start, tokStart, 0, finishListWithHoles(from)) as Node;
    }
    if (isP(P.LBRACE)) {
        const start = tokStart;
        nextToken();
        const from = sp;
        while (!isP(P.RBRACE) && (tok as number) !== T_EOF) {
            if (isP(P.DOTDOTDOT)) {
                const s = tokStart;
                nextToken();
                const arg = parseBindingTarget();
                push(m.RestElement(s, arg.end, 0, arg, null) as Node);
            } else {
                const s = tokStart;
                let flags = 0;
                let key: Node;
                if (isP(P.LBRACKET)) {
                    flags |= FL.COMPUTED;
                    nextToken();
                    key = parseAssign();
                    expectP(P.RBRACKET, "']'");
                } else if ((tok as number) === T_STR) { key = leaf(N.StringLiteral, tokStart, tokEnd); nextToken(); }
                else if (tok === T_NUM) { key = leaf(N.NumericLiteral, tokStart, tokEnd); nextToken(); }
                else key = parseNameAsIdent(R_NAME); // pattern property key — a pure name (never resolves)
                let value: Node;
                if (isP(P.COLON)) { nextToken(); value = parseBindingElement(); }
                else if (isP(P.EQ)) {
                    // shorthand-with-default `{ a = 1 }`: value is a BINDING target
                    // (distinct from the IdentifierName key), defaulted.
                    nextToken();
                    const right = parseAssign();
                    value = m.AssignmentPattern(key.start, right.end, 0, ident(R_BIND, key.start, key.end), right) as Node;
                    flags |= FL.SHORTHAND;
                } else { value = ident(R_BIND, key.start, key.end); flags |= FL.SHORTHAND; } // shorthand `{ a }`: value binds
                push(m.ObjectProperty(s, value.end, flags, key, value) as Node);
            }
            if (!isP(P.RBRACE)) expectP(P.COMMA, "','");
        }
        expectP(P.RBRACE, "'}'");
        return m.ObjectPattern(start, tokStart, 0, finishList(from)) as Node;
    }
    return parseIdent(R_BIND); // bare binding-target identifier
}

function parseBindingElement(): Node {
    const target = parseBindingTarget();
    if (isP(P.EQ)) {
        nextToken();
        const right = parseAssign();
        return m.AssignmentPattern(target.start, right.end, 0, target, right) as Node;
    }
    return target;
}

function parseParams(): Node[] {
    expectP(P.LPAREN, "'('");
    const from = sp;
    while (!isP(P.RPAREN) && (tok as number) !== T_EOF) {
        const start = tokStart;
        let flags = 0;
        if (tsMode) {
            for (;;) {
                if ((isK(K.READONLY) || isK(K.OVERRIDE)) && !nextIsParamNameEnd()) { flags |= FL.READONLY; nextToken(); }
                else if (isK(K.STATIC) && !nextIsParamNameEnd()) nextToken();
                else if (tok === T_KW && (tokVal === K.IMPLEMENTS || tokVal === K.INTERFACE) && !nextIsParamNameEnd()) nextToken();
                else if (tok === T_IDENT && (src.startsWith('public', tokStart) || src.startsWith('private', tokStart) || src.startsWith('protected', tokStart)) && tokEnd - tokStart <= 9 && !nextIsParamNameEnd()) {
                    const access = src.startsWith('public', tokStart) ? 1 : src.startsWith('private', tokStart) ? 2 : 3;
                    flags |= access << FL.ACCESS_SHIFT;
                    nextToken();
                } else break;
            }
        }
        if (isP(P.DOTDOTDOT)) {
            nextToken();
            const arg = parseBindingTarget();
            let typeAnn: Ref = null;
            if (tsMode && isP(P.COLON)) typeAnn = parseTypeAnn();
            push(m.RestElement(start, tokStart, 0, arg, typeAnn) as Node);
        } else if (isK(K.THIS) && tsMode) {
            // TS `this` parameter — sits in FormalParameter.pattern (binding slot);
            // kept in the declaring role so semantic treats it as today.
            const t = ident(R_BIND, tokStart, tokEnd);
            nextToken();
            let typeAnn: Ref = null;
            if (isP(P.COLON)) typeAnn = parseTypeAnn();
            push(m.FormalParameter(start, tokStart, 0, t, typeAnn, null) as Node);
        } else {
            const pattern = parseBindingTarget();
            if (tsMode && isP(P.QUESTION)) { flags |= FL.OPTIONAL; nextToken(); }
            let typeAnn: Ref = null;
            if (tsMode && isP(P.COLON)) typeAnn = parseTypeAnn();
            let init: Ref = null;
            if (isP(P.EQ)) { nextToken(); init = parseAssign(); }
            push(m.FormalParameter(start, tokStart, flags, pattern, typeAnn, init) as Node);
        }
        if (!eatP(P.COMMA)) break;
    }
    expectP(P.RPAREN, "')'");
    return finishList(from);
}

function nextIsParamNameEnd(): boolean {
    const s = saveState();
    nextToken();
    const end =
        tok === T_EOF ||
        (tok === T_PUNCT &&
            (tokVal === P.COLON || tokVal === P.COMMA || tokVal === P.RPAREN || tokVal === P.QUESTION || tokVal === P.EQ));
    restoreState(s);
    return end;
}

/* -------------------------------------------------------------- functions */

function parseFunction(async: boolean, isDecl: boolean, isExpr: boolean): Node {
    const start = tokStart;
    nextToken();
    let flags = async ? FL.ASYNC : 0;
    if (isP(P.STAR)) { flags |= FL.GENERATOR; nextToken(); }
    let id: Ref = null;
    if (isIdentLike()) id = parseIdent(R_BIND); // function name — a binding
    let typeParams: Ref = null;
    if (tsMode && isP(P.LT)) { const t = tryParseTypeParams(); if (t !== null) typeParams = t; }
    const params = parseParams();
    let returnType: Ref = null;
    if (tsMode && isP(P.COLON)) returnType = parseTypeAnn();
    let body: Ref = null;
    if (isP(P.LBRACE)) body = parseBlock();
    else consumeSemi();
    return isDecl && !isExpr
        ? m.FunctionDeclaration(start, tokStart, flags, id, typeParams, params, returnType, body) as Node
        : m.FunctionExpression(start, tokStart, flags, id, typeParams, params, returnType, body) as Node;
}

function parseClass(isExpr: boolean, extraFlags: number, startOverride = -1): Node {
    const start = startOverride >= 0 ? startOverride : tokStart;
    nextToken();
    let id: Ref = null;
    if (isIdentLike() && !isK(K.EXTENDS) && !isK(K.IMPLEMENTS)) id = parseIdent(R_BIND); // class name — a binding
    let typeParams: Ref = null;
    if (tsMode && isP(P.LT)) { const t = tryParseTypeParams(); if (t !== null) typeParams = t; }
    let superClass: Ref = null;
    let superTypeArgs: Ref = null;
    if (eatK(K.EXTENDS)) {
        superClass = parseMemberChain(parsePrimary(), true);
        if (tsMode && isP(P.LT)) { const t = tryParseTypeArgsInType(); if (t !== null) superTypeArgs = t; }
    }
    const implFrom = sp;
    if (tsMode && eatK(K.IMPLEMENTS)) {
        do {
            const s = tokStart;
            // heritage `X.Y` — type-namespace entity name: head resolves (ref),
            // qualified `.right` is a pure name.
            let expr: Node = parseIdent(R_REF);
            while (isP(P.DOT)) { nextToken(); const r = parseNameAsIdent(R_NAME); expr = m.TSQualifiedName(s, r.end, 0, expr, r) as Node; }
            let targs: Ref = null;
            if (isP(P.LT)) { const t = tryParseTypeArgsInType(); if (t !== null) targs = t; }
            push(m.TSClassImplements(s, tokStart, 0, expr, targs) as Node);
        } while (eatP(P.COMMA));
    }
    const impls = finishList(implFrom);
    const body = parseClassBody();
    return isExpr
        ? m.ClassExpression(start, tokStart, extraFlags, id, typeParams, superClass, superTypeArgs, impls, body) as Node
        : m.ClassDeclaration(start, tokStart, extraFlags, id, typeParams, superClass, superTypeArgs, impls, body) as Node;
}

function parseClassBody(): Node[] {
    expectP(P.LBRACE, "'{'");
    const from = sp;
    let last = -1;
    while (!isP(P.RBRACE) && (tok as number) !== T_EOF) {
        if (eatP(P.SEMI)) continue;
        if (tokStart === last) { err('unexpected token in class body'); nextToken(); continue; }
        last = tokStart;
        push(parseClassMember());
    }
    expectP(P.RBRACE, "'}'");
    return finishList(from);
}

function parseClassMember(): Node {
    const start = tokStart;
    let flags = 0;
    let async = false;
    let generator = false;
    for (;;) {
        if (isK(K.STATIC) && !nextIsPropertyEnd()) {
            const s = saveState();
            nextToken();
            if (isP(P.LBRACE)) {
                const b = parseBlock();
                // b is a Block; its body list lives behind .data in type+data.
                const body = (b as Extract<Node, { type: typeof N.BlockStatement }>).data.body;
                return m.StaticBlock(start, tokStart, 0, body) as Node;
            }
            restoreState(s);
            flags |= FL.STATIC;
            nextToken();
        } else if (tok === T_IDENT && !nextIsPropertyEnd() && isAccessModifier()) {
            const access = src.startsWith('public', tokStart) ? 1 : src.startsWith('private', tokStart) ? 2 : 3;
            flags |= access << FL.ACCESS_SHIFT;
            nextToken();
        } else if (isK(K.READONLY) && !nextIsPropertyEnd()) { flags |= FL.READONLY; nextToken(); }
        else if (isK(K.ABSTRACT) && !nextIsPropertyEnd()) { flags |= FL.ABSTRACT; nextToken(); }
        else if (isK(K.DECLARE) && !nextIsPropertyEnd()) { flags |= FL.DECLARE; nextToken(); }
        else if (isK(K.OVERRIDE) && !nextIsPropertyEnd()) nextToken();
        else if (isK(K.ACCESSOR) && !nextIsPropertyEnd()) nextToken();
        else break;
    }
    if (isK(K.ASYNC) && !nextIsPropertyEnd()) { async = true; nextToken(); }
    if (isP(P.STAR)) { generator = true; nextToken(); }
    let kind = 0;
    if ((isK(K.GET) || isK(K.SET)) && !nextIsPropertyEnd()) { kind = isK(K.GET) ? 1 : 2; nextToken(); }
    let key: Node;
    if (isP(P.LBRACKET)) {
        nextToken();
        if (tsMode && isIdentLike()) {
            const s = saveState();
            const name = parseIdent(R_BIND); // index-signature parameter name (binding slot)
            if (isP(P.COLON)) {
                const keyAnn = parseTypeAnn();
                const param = m.FormalParameter(name.start, tokStart, 0, name, keyAnn, null) as Node;
                expectP(P.RBRACKET, "']'");
                let ann: Ref = null;
                if (isP(P.COLON)) ann = parseTypeAnn();
                consumeSemi();
                return m.TSIndexSignature(start, tokStart, flags & FL.READONLY, param, ann) as Node;
            }
            restoreState(s);
        }
        flags |= FL.COMPUTED;
        key = parseAssign();
        expectP(P.RBRACKET, "']'");
    } else if ((tok as number) === T_STR) { key = leaf(N.StringLiteral, tokStart, tokEnd); nextToken(); }
    else if (tok === T_NUM) { key = leaf(N.NumericLiteral, tokStart, tokEnd); nextToken(); }
    else if (tok === T_PRIVATE) key = parsePrivate();
    else key = parseNameAsIdent(R_NAME); // class member key — a pure name

    if (kind === 0 && nodeType(key) === N.IdentifierName && src.startsWith('constructor', key.start) && key.end - key.start === 11)
        kind = 3;

    if (tsMode && isP(P.QUESTION)) { flags |= FL.OPTIONAL; nextToken(); }

    if (kind !== 0 || async || generator || isP(P.LPAREN) || (tsMode && isP(P.LT))) {
        const fn = parseMethodTail(start, (async ? FL.ASYNC : 0) | (generator ? FL.GENERATOR : 0));
        return m.MethodDefinition(start, tokStart, flags | (kind << FL.KIND_SHIFT), key, fn) as Node;
    }
    if (tsMode && isP(P.BANG)) { flags |= FL.DEFINITE; nextToken(); }
    let typeAnn: Ref = null;
    if (tsMode && isP(P.COLON)) typeAnn = parseTypeAnn();
    let value: Ref = null;
    if (isP(P.EQ)) { nextToken(); value = parseAssign(); }
    consumeSemi();
    return m.PropertyDefinition(start, tokStart, flags, key, typeAnn, value) as Node;
}

function isAccessModifier(): boolean {
    const len = tokEnd - tokStart;
    return (
        (len === 6 && src.startsWith('public', tokStart)) ||
        (len === 7 && src.startsWith('private', tokStart)) ||
        (len === 9 && src.startsWith('protected', tokStart))
    );
}

/* -------------------------------------------------------------- statements */

function parseBlock(): Node {
    const start = tokStart;
    expectP(P.LBRACE, "'{'");
    const from = sp;
    while (!isP(P.RBRACE) && (tok as number) !== T_EOF) push(parseStatement());
    expectP(P.RBRACE, "'}'");
    return m.BlockStatement(start, tokStart, 0, finishList(from)) as Node;
}

function parseStatement(): Node {
    const start = tokStart;
    if (tok === T_PUNCT) {
        switch (tokVal as number) {
            case P.LBRACE: return parseBlock();
            case P.SEMI: nextToken(); return m.EmptyStatement(start, tokStart, 0) as Node;
            case P.AT: err('decorators not supported'); nextToken(); return parseStatement();
        }
    }
    if (tok === T_KW) {
        switch (tokVal as number) {
            case K.VAR: return parseVarDecl(VAR_KIND.VAR, 0);
            case K.CONST: {
                const s = saveState();
                nextToken();
                if (tsMode && isK(K.ENUM)) return parseEnum(start, FL.CONST_ENUM);
                restoreState(s);
                return parseVarDecl(VAR_KIND.CONST, 0);
            }
            case K.LET: {
                const s = saveState();
                nextToken();
                if (isIdentLike() || isP(P.LBRACE) || isP(P.LBRACKET)) { restoreState(s); return parseVarDecl(VAR_KIND.LET, 0); }
                restoreState(s);
                break;
            }
            case K.FUNCTION: return parseFunction(false, true, false);
            case K.ASYNC: {
                const s = saveState();
                nextToken();
                if (isK(K.FUNCTION) && (tokFlags & F_NL) === 0) return parseFunction(true, true, false);
                restoreState(s);
                break;
            }
            case K.CLASS: return parseClass(false, 0);
            case K.IF: {
                nextToken();
                expectP(P.LPAREN, "'('");
                const test = parseExpression();
                expectP(P.RPAREN, "')'");
                const cons = parseStatement();
                let alt: Ref = null;
                if (eatK(K.ELSE)) alt = parseStatement();
                return m.IfStatement(start, tokStart, 0, test, cons, alt) as Node;
            }
            case K.FOR: return parseFor(start);
            case K.WHILE: {
                nextToken();
                expectP(P.LPAREN, "'('");
                const test = parseExpression();
                expectP(P.RPAREN, "')'");
                const body = parseStatement();
                return m.WhileStatement(start, body.end, 0, test, body) as Node;
            }
            case K.DO: {
                nextToken();
                const body = parseStatement();
                if (!eatK(K.WHILE)) err("expected 'while'");
                expectP(P.LPAREN, "'('");
                const test = parseExpression();
                expectP(P.RPAREN, "')'");
                eatP(P.SEMI);
                return m.DoWhileStatement(start, tokStart, 0, body, test) as Node;
            }
            case K.SWITCH: {
                nextToken();
                expectP(P.LPAREN, "'('");
                const disc = parseExpression();
                expectP(P.RPAREN, "')'");
                expectP(P.LBRACE, "'{'");
                const from = sp;
                while (!isP(P.RBRACE) && (tok as number) !== T_EOF) {
                    const cs = tokStart;
                    let test: Ref = null;
                    if (eatK(K.CASE)) { test = parseExpression(); }
                    else if (!eatK(K.DEFAULT)) { err("expected 'case'"); nextToken(); continue; }
                    expectP(P.COLON, "':'");
                    const bodyFrom = sp;
                    while (!isP(P.RBRACE) && !isK(K.CASE) && !isK(K.DEFAULT) && (tok as number) !== T_EOF) push(parseStatement());
                    const body = finishList(bodyFrom);
                    push(m.SwitchCase(cs, tokStart, 0, test, body) as Node);
                }
                expectP(P.RBRACE, "'}'");
                return m.SwitchStatement(start, tokStart, 0, disc, finishList(from)) as Node;
            }
            case K.TRY: {
                nextToken();
                const block = parseBlock();
                let handler: Ref = null;
                let finalizer: Ref = null;
                if (isK(K.CATCH)) {
                    const cs = tokStart;
                    nextToken();
                    let param: Ref = null;
                    if (eatP(P.LPAREN)) {
                        param = parseBindingTarget();
                        if (tsMode && isP(P.COLON)) parseTypeAnn();
                        expectP(P.RPAREN, "')'");
                    }
                    const cbody = parseBlock();
                    handler = m.CatchClause(cs, tokStart, 0, param, cbody) as Node;
                }
                if (eatK(K.FINALLY)) finalizer = parseBlock();
                return m.TryStatement(start, tokStart, 0, block, handler, finalizer) as Node;
            }
            case K.RETURN: {
                nextToken();
                let arg: Ref = null;
                if (!canInsertSemi() && !isP(P.SEMI)) arg = parseExpression();
                consumeSemi();
                return m.ReturnStatement(start, tokStart, 0, arg) as Node;
            }
            case K.THROW: {
                nextToken();
                const arg = parseExpression();
                consumeSemi();
                return m.ThrowStatement(start, tokStart, 0, arg) as Node;
            }
            case K.BREAK: case K.CONTINUE: {
                const isBreak = tokVal === K.BREAK;
                nextToken();
                let label: Ref = null;
                if (isIdentLike() && (tokFlags & F_NL) === 0) label = parseIdent(R_LABEL); // break/continue target label
                consumeSemi();
                return isBreak ? m.BreakStatement(start, tokStart, 0, label) as Node : m.ContinueStatement(start, tokStart, 0, label) as Node;
            }
            case K.DEBUGGER: nextToken(); consumeSemi(); return m.DebuggerStatement(start, tokStart, 0) as Node;
            case K.IMPORT: {
                const s = saveState();
                nextToken();
                if (isP(P.LPAREN) || isP(P.DOT)) { restoreState(s); break; }
                restoreState(s);
                return parseImport();
            }
            case K.EXPORT: return parseExport();
            case K.INTERFACE:
                if (tsMode) return parseInterface(start, 0);
                break;
            case K.TYPE:
                if (tsMode) {
                    const s = saveState();
                    nextToken();
                    if (isIdentLike() && (tokFlags & F_NL) === 0) { restoreState(s); return parseTypeAlias(start, 0); }
                    restoreState(s);
                }
                break;
            case K.ENUM:
                if (tsMode) return parseEnum(start, 0);
                break;
            case K.DECLARE:
                if (tsMode) {
                    const s = saveState();
                    nextToken();
                    if (tok === T_KW && (tokVal === K.CONST || tokVal === K.LET || tokVal === K.VAR || tokVal === K.FUNCTION ||
                        tokVal === K.CLASS || tokVal === K.INTERFACE || tokVal === K.TYPE || tokVal === K.ENUM ||
                        tokVal === K.NAMESPACE || tokVal === K.MODULE || tokVal === K.ABSTRACT || tokVal === K.ASYNC)) {
                        const inner = parseStatement();
                        applyDeclare(inner, start);
                        return inner;
                    }
                    restoreState(s);
                }
                break;
            case K.ABSTRACT:
                if (tsMode) {
                    const s = saveState();
                    const abstractStart = tokStart;
                    nextToken();
                    if (isK(K.CLASS)) return parseClass(false, FL.ABSTRACT, abstractStart);
                    restoreState(s);
                }
                break;
            case K.NAMESPACE: case K.MODULE:
                if (tsMode) {
                    const s = saveState();
                    nextToken();
                    if (isIdentLike() || (tok as number) === T_STR) {
                        const id = (tok as number) === T_STR ? leaf(N.StringLiteral, tokStart, tokEnd) : parseIdent(R_BIND); // namespace/module name (ident form) — a binding
                        if ((tok as number) === T_STR) nextToken();
                        if (isP(P.LBRACE)) {
                            nextToken();
                            const from = sp;
                            while (!isP(P.RBRACE) && (tok as number) !== T_EOF) push(parseStatement());
                            expectP(P.RBRACE, "'}'");
                            return m.TSModuleDeclaration(start, tokStart, FL.NAMESPACE, id, finishList(from)) as Node;
                        }
                    }
                    restoreState(s);
                }
                break;
        }
    }
    const expr = parseExpression();
    if (nodeType(expr) === N.IdentifierReference && isP(P.COLON)) {
        nextToken();
        const body = parseStatement();
        // the expression-parsed name is actually a statement label: rebuild it in
        // the label role (labels never resolve to symbols).
        const label = ident(R_LABEL, expr.start, expr.end);
        return m.LabeledStatement(start, body.end, 0, label, body) as Node;
    }
    consumeSemi();
    return m.ExpressionStatement(start, tokStart, 0, expr) as Node;
}

function parseVarDecl(kind: number, extraFlags: number): Node {
    const start = tokStart;
    nextToken();
    const from = sp;
    do {
        const ds = tokStart;
        const target = parseBindingTarget();
        let flags = 0;
        if (tsMode && isP(P.BANG)) { flags |= FL.DEFINITE; nextToken(); }
        let typeAnn: Ref = null;
        if (tsMode && isP(P.COLON)) typeAnn = parseTypeAnn();
        let init: Ref = null;
        if (isP(P.EQ)) { nextToken(); init = parseAssign(); }
        push(m.VariableDeclarator(ds, tokStart, flags, target, typeAnn, init) as Node);
    } while (eatP(P.COMMA));
    consumeSemi();
    return m.VariableDeclaration(start, tokStart, kind | extraFlags, finishList(from)) as Node;
}

function parseFor(start: number): Node {
    nextToken();
    let flags = 0;
    if (eatK(K.AWAIT)) flags |= FL.AWAIT;
    expectP(P.LPAREN, "'('");
    let init: Ref = null;
    if (isP(P.SEMI)) nextToken();
    else {
        if (tok === T_KW && (tokVal === K.VAR || tokVal === K.LET || tokVal === K.CONST)) {
            const kind = tokVal === K.VAR ? VAR_KIND.VAR : tokVal === K.LET ? VAR_KIND.LET : VAR_KIND.CONST;
            const ds = tokStart;
            nextToken();
            const target = parseBindingTarget();
            if (isK(K.OF) || isK(K.IN)) {
                const isOf = isK(K.OF);
                nextToken();
                const dtor = m.VariableDeclarator(ds, tokStart, 0, target, null, null) as Node;
                const decl = m.VariableDeclaration(ds, tokStart, kind, [dtor]) as Node;
                const right = isOf ? parseAssign() : parseExpression();
                expectP(P.RPAREN, "')'");
                const body = parseStatement();
                return isOf
                    ? m.ForOfStatement(start, body.end, flags, decl, right, body) as Node
                    : m.ForInStatement(start, body.end, 0, decl, right, body) as Node;
            }
            const dFrom = sp;
            {
                let typeAnn: Ref = null;
                let dflags = 0;
                if (tsMode && isP(P.BANG)) { dflags |= FL.DEFINITE; nextToken(); }
                if (tsMode && isP(P.COLON)) typeAnn = parseTypeAnn();
                let dinit: Ref = null;
                if (isP(P.EQ)) { nextToken(); dinit = parseAssign(true); }
                push(m.VariableDeclarator(ds, tokStart, dflags, target, typeAnn, dinit) as Node);
            }
            while (eatP(P.COMMA)) {
                const ds2 = tokStart;
                const t2 = parseBindingTarget();
                let typeAnn: Ref = null;
                if (tsMode && isP(P.COLON)) typeAnn = parseTypeAnn();
                let dinit: Ref = null;
                if (isP(P.EQ)) { nextToken(); dinit = parseAssign(true); }
                push(m.VariableDeclarator(ds2, tokStart, 0, t2, typeAnn, dinit) as Node);
            }
            init = m.VariableDeclaration(ds, tokStart, kind, finishList(dFrom)) as Node;
            expectP(P.SEMI, "';'");
        } else {
            init = parseExpression(true);
            if (isK(K.OF) || isK(K.IN)) {
                const isOf = tokVal === K.OF;
                nextToken();
                const right = isOf ? parseAssign() : parseExpression();
                expectP(P.RPAREN, "')'");
                const body = parseStatement();
                return isOf
                    ? m.ForOfStatement(start, body.end, flags, init, right, body) as Node
                    : m.ForInStatement(start, body.end, 0, init, right, body) as Node;
            }
            expectP(P.SEMI, "';'");
        }
    }
    let test: Ref = null;
    if (!isP(P.SEMI)) test = parseExpression();
    expectP(P.SEMI, "';'");
    let update: Ref = null;
    if (!isP(P.RPAREN)) update = parseExpression();
    expectP(P.RPAREN, "')'");
    const body = parseStatement();
    return m.ForStatement(start, body.end, 0, init, test, update, body) as Node;
}

/* ---------------------------------------------------------------- modules */

function parseImport(): Node {
    const start = tokStart;
    nextToken();
    let flags = 0;
    if (tsMode && isK(K.TYPE)) {
        const s = saveState();
        nextToken();
        if (!isK(K.FROM) && !isP(P.EQ)) flags |= FL.TYPE_ONLY;
        else restoreState(s);
    }
    const from = sp;
    if ((tok as number) === T_STR) {
        const source = leaf(N.StringLiteral, tokStart, tokEnd);
        nextToken();
        consumeSemi();
        return m.ImportDeclaration(start, tokStart, flags, finishList(from), source) as Node;
    }
    if (isIdentLike()) {
        const local = parseIdent(R_BIND); // default import local — a binding
        push(m.ImportDefaultSpecifier(local.start, local.end, 0, local) as Node);
        eatP(P.COMMA);
    }
    if (isP(P.STAR)) {
        const s = tokStart;
        nextToken();
        if (!eatK(K.AS)) err("expected 'as'");
        const local = parseIdent(R_BIND); // namespace import local — a binding
        push(m.ImportNamespaceSpecifier(s, local.end, 0, local) as Node);
    } else if (isP(P.LBRACE)) {
        nextToken();
        while (!isP(P.RBRACE) && (tok as number) !== T_EOF) {
            const ss = tokStart;
            let specFlags = 0;
            if (tsMode && isK(K.TYPE)) {
                const st = saveState();
                nextToken();
                if (isNameLike() || (tok as number) === T_STR) specFlags |= FL.TYPE_ONLY;
                else restoreState(st);
            }
            const imported = (tok as number) === T_STR ? leaf(N.StringLiteral, tokStart, tokEnd) : parseNameAsIdent(R_NAME); // external name — a pure name
            if ((tok as number) === T_STR) nextToken();
            // `import { a }` — `a` names both the external AND the local binding, but
            // those are two roles: local is a distinct BindingIdentifier over the
            // same span (imported stays the IdentifierName; string form can't be local).
            let local = eatK(K.AS) ? parseIdent(R_BIND) : ident(R_BIND, imported.start, imported.end);
            push(m.ImportSpecifier(ss, tokStart, specFlags, local, imported) as Node);
            if (!isP(P.RBRACE)) expectP(P.COMMA, "','");
        }
        expectP(P.RBRACE, "'}'");
    }
    if (!eatK(K.FROM)) err("expected 'from'");
    let source: Ref = null;
    if ((tok as number) === T_STR) { source = leaf(N.StringLiteral, tokStart, tokEnd); nextToken(); }
    else err('expected module specifier');
    consumeSemi();
    return m.ImportDeclaration(start, tokStart, flags, finishList(from), source) as Node;
}

function parseExport(): Node {
    const start = tokStart;
    nextToken();
    if (eatK(K.DEFAULT)) {
        let decl: Node;
        if (isK(K.FUNCTION)) decl = parseFunction(false, true, false);
        else if (isK(K.ASYNC)) { nextToken(); decl = parseFunction(true, true, false); }
        else if (isK(K.CLASS)) decl = parseClass(false, 0);
        else { decl = parseAssign(); consumeSemi(); }
        return m.ExportDefaultDeclaration(start, tokStart, 0, decl) as Node;
    }
    if (isP(P.STAR)) {
        nextToken();
        let exported: Ref = null;
        if (eatK(K.AS)) exported = parseIdent(R_NAME); // `export * as X` — external name (never resolves)
        if (!eatK(K.FROM)) err("expected 'from'");
        let source: Ref = null;
        if ((tok as number) === T_STR) { source = leaf(N.StringLiteral, tokStart, tokEnd); nextToken(); }
        consumeSemi();
        return m.ExportAllDeclaration(start, tokStart, 0, source, exported) as Node;
    }
    let flags = 0;
    if (tsMode && isK(K.TYPE)) {
        const s = saveState();
        nextToken();
        if (isP(P.LBRACE)) flags |= FL.TYPE_ONLY;
        else restoreState(s);
    }
    if (isP(P.LBRACE)) {
        nextToken();
        const from = sp;
        while (!isP(P.RBRACE) && (tok as number) !== T_EOF) {
            const ss = tokStart;
            let specFlags = 0;
            if (tsMode && isK(K.TYPE)) {
                const st = saveState();
                nextToken();
                if (isNameLike()) specFlags |= FL.TYPE_ONLY;
                else restoreState(st);
            }
            const local = (tok as number) === T_STR ? leaf(N.StringLiteral, tokStart, tokEnd) : parseNameAsIdent(R_REF); // exported local — resolves
            if ((tok as number) === T_STR) nextToken();
            // `export { a }` — `a` is both the resolving local AND the external
            // exported name: two roles, distinct nodes over the same span
            // (exported is a pure IdentifierName; a string local can't be split).
            let exported: Node = eatK(K.AS)
                ? ((tok as number) === T_STR ? leaf(N.StringLiteral, tokStart, tokEnd) : parseNameAsIdent(R_NAME))
                : (nodeType(local) === N.StringLiteral ? local : ident(R_NAME, local.start, local.end));
            if (nodeType(exported) === N.StringLiteral) nextToken();
            push(m.ExportSpecifier(ss, tokStart, specFlags, local, exported) as Node);
            if (!isP(P.RBRACE)) expectP(P.COMMA, "','");
        }
        expectP(P.RBRACE, "'}'");
        let source: Ref = null;
        if (eatK(K.FROM)) {
            if ((tok as number) === T_STR) { source = leaf(N.StringLiteral, tokStart, tokEnd); nextToken(); }
        }
        consumeSemi();
        return m.ExportNamedDeclaration(start, tokStart, flags, null, finishList(from), source) as Node;
    }
    const decl = parseStatement();
    return m.ExportNamedDeclaration(start, tokStart, flags, decl, [], null) as Node;
}

/* ------------------------------------------------------------- TS declels */

function parseInterface(start: number, extraFlags: number): Node {
    nextToken();
    const id = parseIdent(R_BIND); // interface name — a (type-namespace) binding
    let typeParams: Ref = null;
    if (isP(P.LT)) { const t = tryParseTypeParams(); if (t !== null) typeParams = t; }
    const extFrom = sp;
    if (eatK(K.EXTENDS)) {
        do {
            const s = tokStart;
            // heritage `X.Y` — type-namespace entity name: head resolves (ref),
            // qualified `.right` is a pure name.
            let expr: Node = parseIdent(R_REF);
            while (isP(P.DOT)) { nextToken(); const r = parseNameAsIdent(R_NAME); expr = m.TSQualifiedName(s, r.end, 0, expr, r) as Node; }
            let targs: Ref = null;
            if (isP(P.LT)) { const t = tryParseTypeArgsInType(); if (t !== null) targs = t; }
            push(m.TSInterfaceHeritage(s, tokStart, 0, expr, targs) as Node);
        } while (eatP(P.COMMA));
    }
    const ext = finishList(extFrom);
    const body = parseTypeMembers();
    return m.TSInterfaceDeclaration(start, tokStart, extraFlags, id, typeParams, ext, body) as Node;
}

function parseTypeAlias(start: number, extraFlags: number): Node {
    nextToken();
    const id = parseIdent(R_BIND); // type-alias name — a (type-namespace) binding
    let typeParams: Ref = null;
    if (isP(P.LT)) { const t = tryParseTypeParams(); if (t !== null) typeParams = t; }
    expectP(P.EQ, "'='");
    const ty = parseType();
    consumeSemi();
    return m.TSTypeAliasDeclaration(start, tokStart, extraFlags, id, typeParams, ty) as Node;
}

function parseEnum(start: number, extraFlags: number): Node {
    nextToken();
    const id = parseIdent(R_BIND); // enum name — a binding (dual-namespace)
    expectP(P.LBRACE, "'{'");
    const from = sp;
    while (!isP(P.RBRACE) && (tok as number) !== T_EOF) {
        const ms = tokStart;
        let key: Node;
        if ((tok as number) === T_STR) { key = leaf(N.StringLiteral, tokStart, tokEnd); nextToken(); }
        else key = parseNameAsIdent(R_NAME); // enum member name — a pure name (never resolves)
        let init: Ref = null;
        if (isP(P.EQ)) { nextToken(); init = parseAssign(); }
        push(m.TSEnumMember(ms, tokStart, 0, key, init) as Node);
        if (!isP(P.RBRACE)) expectP(P.COMMA, "','");
    }
    expectP(P.RBRACE, "'}'");
    return m.TSEnumDeclaration(start, tokStart, extraFlags, id, finishList(from)) as Node;
}

/* ------------------------------------------------------------- TS types */

function parseTypeAnn(): Node {
    const start = tokStart;
    expectP(P.COLON, "':'");
    if (isK(K.ASSERTS)) {
        nextToken();
        if (isIdentLike() || isK(K.THIS)) nextToken();
        if (eatK(K.IS)) parseType();
        return m.TSTypeAnnotation(start, tokStart, 0, m.keyword(start, tokStart, N.TSAnyKeyword) as Node) as Node;
    }
    const s = saveState();
    if (isIdentLike() || isK(K.THIS)) {
        nextToken();
        if (isK(K.IS)) {
            nextToken();
            const ty = parseType();
            return m.TSTypeAnnotation(start, tokStart, 0, ty) as Node;
        }
        restoreState(s);
    }
    const ty = parseType();
    return m.TSTypeAnnotation(start, ty.end, 0, ty) as Node;
}

function parseType(): Node {
    if (isP(P.LPAREN) && fnTypeAhead()) return parseFnType(0, null);
    if (isP(P.LT)) {
        const tp = tryParseTypeParams();
        if (tp !== null) return parseFnType(0, tp);
    }
    if (isK(K.NEW)) {
        const start = tokStart;
        nextToken();
        let tp: Ref = null;
        if (isP(P.LT)) { const t = tryParseTypeParams(); if (t !== null) tp = t; }
        const params = parseParams();
        expectP(P.ARROW, "'=>'");
        const ret = parseType();
        const ann = m.TSTypeAnnotation(ret.start, ret.end, 0, ret) as Node;
        return m.TSConstructorType(start, tokStart, 0, tp, params, ann) as Node;
    }
    return parseUnionType();
}

function parseFnType(abstractFlag: number, typeParams: Ref): Node {
    const start = tokStart;
    const params = parseParams();
    expectP(P.ARROW, "'=>'");
    const ret = parseType();
    const ann = m.TSTypeAnnotation(ret.start, ret.end, 0, ret) as Node;
    return m.TSFunctionType(start, tokStart, abstractFlag, typeParams, params, ann) as Node;
}

function fnTypeAhead(): boolean {
    let p = tokStart + 1;
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

function parseUnionType(): Node {
    eatP(P.PIPE);
    const first = parseIntersectionType();
    if (!isP(P.PIPE)) return parseCondTail(first);
    const start = first.start;
    const from = sp;
    push(first);
    while (eatP(P.PIPE)) push(parseIntersectionType());
    const u = m.TSUnionType(start, tokStart, 0, finishList(from)) as Node;
    return parseCondTail(u);
}

function parseIntersectionType(): Node {
    eatP(P.AMP);
    const first = parseTypeOperator();
    if (!isP(P.AMP)) return first;
    const start = first.start;
    const from = sp;
    push(first);
    while (eatP(P.AMP)) push(parseTypeOperator());
    return m.TSIntersectionType(start, tokStart, 0, finishList(from)) as Node;
}

function parseCondTail(checkType: Node): Node {
    if (!isK(K.EXTENDS)) return checkType;
    nextToken();
    const extendsType = parseIntersectionType();
    if (!isP(P.QUESTION)) { expectP(P.QUESTION, "'?'"); return checkType; }
    nextToken();
    const trueType = parseType();
    expectP(P.COLON, "':'");
    const falseType = parseType();
    return m.TSConditionalType(checkType.start, falseType.end, 0, checkType, extendsType, trueType, falseType) as Node;
}

function parseTypeOperator(): Node {
    const start = tokStart;
    if (isK(K.KEYOF)) { nextToken(); const t = parseTypeOperator(); return m.TSTypeOperator(start, t.end, TSOP.KEYOF, t) as Node; }
    if (isK(K.READONLY)) { nextToken(); const t = parseTypeOperator(); return m.TSTypeOperator(start, t.end, TSOP.READONLY, t) as Node; }
    if (isK(K.UNIQUE)) { nextToken(); const t = parseTypeOperator(); return m.TSTypeOperator(start, t.end, TSOP.UNIQUE, t) as Node; }
    if (isK(K.INFER)) {
        nextToken();
        const name = parseIdent(R_BIND); // `infer X` — introduces a type-param binding
        const tp = m.TSTypeParameter(name.start, name.end, 0, name, null, null) as Node;
        return m.TSInferType(start, tokStart, 0, tp) as Node;
    }
    return parseTypePostfixAndCond(parsePrimaryType());
}

function parseTypePostfixAndCond(t: Node): Node {
    for (;;) {
        if (isP(P.LBRACKET) && (tokFlags & F_NL) === 0) {
            nextToken();
            if (isP(P.RBRACKET)) { nextToken(); t = m.TSArrayType(t.start, tokStart, 0, t) as Node; }
            else {
                const idx = parseType();
                expectP(P.RBRACKET, "']'");
                t = m.TSIndexedAccessType(t.start, tokStart, 0, t, idx) as Node;
            }
        } else return t;
    }
}

function parsePrimaryType(): Node {
    const start = tokStart;
    if (isP(P.LPAREN)) {
        if (fnTypeAhead()) return parseFnType(0, null);
        nextToken();
        const t = parseType();
        expectP(P.RPAREN, "')'");
        return t;
    }
    if ((tok as number) === T_STR) { const l = leaf(N.StringLiteral, start, tokEnd); nextToken(); return m.TSLiteralType(start, tokStart, 0, l) as Node; }
    if (tok === T_NUM) { const l = leaf(N.NumericLiteral, start, tokEnd); nextToken(); return m.TSLiteralType(start, tokStart, 0, l) as Node; }
    if (tok === T_BIGINT) { const l = leaf(N.BigIntLiteral, start, tokEnd); nextToken(); return m.TSLiteralType(start, tokStart, 0, l) as Node; }
    if (tok === T_TEMPLATE_FULL || tok === T_TEMPLATE_HEAD) return parseTemplateLiteralType();
    if (isP(P.MINUS)) {
        nextToken();
        if (tok === T_NUM) { const l = leaf(N.NumericLiteral, start, tokEnd); nextToken(); return m.TSLiteralType(start, tokStart, 0, l) as Node; }
        err('expected number');
        return m.keyword(start, tokStart, N.TSAnyKeyword) as Node;
    }
    if (isP(P.LBRACKET)) {
        nextToken();
        const from = sp;
        while (!isP(P.RBRACKET) && (tok as number) !== T_EOF) {
            if (isP(P.DOTDOTDOT)) {
                const s = tokStart;
                nextToken();
                const sv = saveState();
                let t: Ref = null;
                if (isIdentLike()) {
                    const label = parseIdent(R_NAME); // named tuple member label — a pure name
                    let opt = 0;
                    if (isP(P.QUESTION)) { opt = FL.OPTIONAL; nextToken(); }
                    if (isP(P.COLON)) {
                        nextToken();
                        const ty = parseType();
                        t = m.TSNamedTupleMember(label.start, ty.end, opt, label, ty) as Node;
                    } else restoreState(sv);
                }
                if (t === null) t = parseType();
                push(m.TSTypeOperator(s, t.end, 0, t) as Node);
            } else {
                const s = saveState();
                if (isIdentLike()) {
                    const label = parseIdent(R_NAME); // named tuple member label — a pure name
                    let opt = 0;
                    if (isP(P.QUESTION)) { opt = FL.OPTIONAL; nextToken(); }
                    if (isP(P.COLON)) {
                        nextToken();
                        const t = parseType();
                        push(m.TSNamedTupleMember(label.start, t.end, opt, label, t) as Node);
                        if (!isP(P.RBRACKET)) expectP(P.COMMA, "','");
                        continue;
                    }
                    restoreState(s);
                }
                push(parseType());
            }
            if (!isP(P.RBRACKET)) expectP(P.COMMA, "','");
        }
        expectP(P.RBRACKET, "']'");
        return m.TSTupleType(start, tokStart, 0, finishList(from)) as Node;
    }
    if (isP(P.LBRACE)) {
        if (mappedTypeAhead()) return parseMappedType();
        const members = parseTypeMembers();
        return m.TSTypeLiteral(start, tokStart, 0, members) as Node;
    }
    if (isK(K.TYPEOF)) {
        nextToken();
        const s = tokStart;
        // `typeof X.Y` — value-namespace entity name: head resolves (ref), `.right` is a pure name.
        let expr: Node = parseIdent(R_REF);
        while (isP(P.DOT)) { nextToken(); const r = parseNameAsIdent(R_NAME); expr = m.TSQualifiedName(s, r.end, 0, expr, r) as Node; }
        let targs: Ref = null;
        if (isP(P.LT)) { const t = tryParseTypeArgsInType(); if (t !== null) targs = t; }
        return m.TSTypeQuery(start, tokStart, 0, expr, targs) as Node;
    }
    if (isK(K.IMPORT)) {
        nextToken();
        expectP(P.LPAREN, "'('");
        let source: Ref = null;
        if ((tok as number) === T_STR) { source = leaf(N.StringLiteral, tokStart, tokEnd); nextToken(); }
        expectP(P.RPAREN, "')'");
        let qualifier: Ref = null;
        if (isP(P.DOT)) {
            nextToken();
            // `import('m').X.Y` qualifier — names members of the imported module
            // namespace; never resolves to a local symbol, so pure names throughout.
            qualifier = parseNameAsIdent(R_NAME);
            while (isP(P.DOT)) { nextToken(); const r = parseNameAsIdent(R_NAME); qualifier = m.TSQualifiedName(qualifier!.start, r.end, 0, qualifier, r) as Node; }
        }
        let targs: Ref = null;
        if (isP(P.LT)) { const t = tryParseTypeArgsInType(); if (t !== null) targs = t; }
        return m.TSImportType(start, tokStart, 0, source, qualifier, targs) as Node;
    }
    if (isK(K.THIS)) { nextToken(); return m.keyword(start, tokStart, N.TSThisType) as Node; }
    if (isIdentLike() || tok === T_KW) {
        const kw = tsKeywordType();
        if (kw !== 0) { nextToken(); return m.keyword(start, tokStart, kw) as Node; }
        const s = tokStart;
        // type reference `X.Y` — type-namespace entity name: head resolves (ref),
        // qualified `.right` is a pure name.
        let name: Node = parseNameAsIdent(R_REF);
        while (isP(P.DOT)) { nextToken(); const r = parseNameAsIdent(R_NAME); name = m.TSQualifiedName(s, r.end, 0, name, r) as Node; }
        let targs: Ref = null;
        if (isP(P.LT)) { const t = tryParseTypeArgsInType(); if (t !== null) targs = t; }
        return m.TSTypeReference(start, tokStart, 0, name, targs) as Node;
    }
    err('expected type');
    nextToken();
    return m.keyword(start, tokStart, N.TSAnyKeyword) as Node;
}

/** Recognize a TS keyword type at the current token; returns the TSXKeyword node
 * type id directly (the lexer's keyword recognition maps straight to type ids),
 * or 0 for a non-keyword name. */
function tsKeywordType(): number {
    const len = tokEnd - tokStart;
    const st = tokStart;
    switch (len) {
        case 3: if (src.startsWith('any', st)) return N.TSAnyKeyword; break;
        case 4: if (src.startsWith('void', st)) return N.TSVoidKeyword; break;
        case 5: if (src.startsWith('never', st)) return N.TSNeverKeyword; break;
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
        case 9: if (src.startsWith('undefined', st)) return N.TSUndefinedKeyword;
    }
    if (isK(K.NULL)) return N.TSNullKeyword;
    return 0;
}

function parseTemplateLiteralType(): Node {
    const start = tokStart;
    if (tok === T_TEMPLATE_FULL) {
        const q = leaf(N.TemplateElement, start + 1, tokEnd - 1);
        nextToken();
        return m.TSTemplateLiteralType(start, tokStart, 0, [q], []) as Node;
    }
    const qFrom = sp;
    const types: Node[] = [];
    push(leaf(N.TemplateElement, start + 1, tokEnd - 2));
    nextToken();
    for (;;) {
        types.push(parseType());
        if (!isP(P.RBRACE)) { err("expected '}'"); break; }
        reScanTemplateContinue();
        if (tok === T_TEMPLATE_FULL) {
            push(leaf(N.TemplateElement, tokStart + 1, tokEnd - 1));
            nextToken();
            break;
        }
        push(leaf(N.TemplateElement, tokStart + 1, tokEnd - 2));
        nextToken();
    }
    const quasis = finishList(qFrom);
    return m.TSTemplateLiteralType(start, tokStart, 0, quasis, types) as Node;
}

function mappedTypeAhead(): boolean {
    const s = saveState();
    nextToken();
    let ok = false;
    if (isP(P.PLUS) || isP(P.MINUS)) nextToken();
    if (isK(K.READONLY)) nextToken();
    if (isP(P.LBRACKET)) {
        nextToken();
        if (isIdentLike()) { nextToken(); ok = isK(K.IN); }
    }
    restoreState(s);
    return ok;
}

function parseMappedType(): Node {
    const start = tokStart;
    nextToken();
    let flags = 0;
    if (isP(P.PLUS)) { nextToken(); if (eatK(K.READONLY)) flags |= 1 << 4; }
    else if (isP(P.MINUS)) { nextToken(); if (eatK(K.READONLY)) flags |= 2 << 4; }
    else if (eatK(K.READONLY)) flags |= 3 << 4;
    expectP(P.LBRACKET, "'['");
    const name = parseIdent(R_BIND); // mapped-type parameter — a type-param binding
    if (!eatK(K.IN)) err("expected 'in'");
    const constraint = parseType();
    let nameType: Ref = null;
    if (eatK(K.AS)) nameType = parseType();
    expectP(P.RBRACKET, "']'");
    if (isP(P.PLUS)) { nextToken(); if (eatP(P.QUESTION)) flags |= 1 << 6; }
    else if (isP(P.MINUS)) { nextToken(); if (eatP(P.QUESTION)) flags |= 2 << 6; }
    else if (eatP(P.QUESTION)) flags |= 3 << 6;
    let typeAnn: Ref = null;
    if (isP(P.COLON)) { nextToken(); typeAnn = parseType(); }
    eatP(P.SEMI);
    expectP(P.RBRACE, "'}'");
    const tp = m.TSTypeParameter(name.start, constraint.end, 0, name, constraint, null) as Node;
    return m.TSMappedType(start, tokStart, flags, tp, nameType, typeAnn) as Node;
}

function parseTypeMembers(): Node[] {
    expectP(P.LBRACE, "'{'");
    const from = sp;
    let last = -1;
    while (!isP(P.RBRACE) && (tok as number) !== T_EOF) {
        if (tokStart === last) { err('unexpected token in type member'); nextToken(); continue; }
        last = tokStart;
        push(parseTypeMember());
        eatP(P.COMMA);
        eatP(P.SEMI);
    }
    expectP(P.RBRACE, "'}'");
    return finishList(from);
}

function parseTypeMember(): Node {
    const start = tokStart;
    let flags = 0;
    if (isK(K.READONLY) && !nextIsPropertyEnd()) { flags |= FL.READONLY; nextToken(); }
    if (isK(K.NEW) && !nextIsPropertyEnd()) {
        nextToken();
        let tp: Ref = null;
        if (isP(P.LT)) { const t = tryParseTypeParams(); if (t !== null) tp = t; }
        const params = parseParams();
        let ret: Ref = null;
        if (isP(P.COLON)) ret = parseTypeAnn();
        return m.TSConstructSignatureDeclaration(start, tokStart, 0, tp, params, ret) as Node;
    }
    if (isP(P.LPAREN) || isP(P.LT)) {
        let tp: Ref = null;
        if (isP(P.LT)) { const t = tryParseTypeParams(); if (t !== null) tp = t; }
        const params = parseParams();
        let ret: Ref = null;
        if (isP(P.COLON)) ret = parseTypeAnn();
        return m.TSCallSignatureDeclaration(start, tokStart, 0, tp, params, ret) as Node;
    }
    if (isP(P.LBRACKET)) {
        nextToken();
        const ps = tokStart;
        // Ambiguous `[name...`: either an index-signature parameter (`[k: string]`,
        // a binding) or a computed key `[Foo.Bar]` (Foo is a reference object).
        // Parse as a reference; if it turns out to be an index-sig param, rebuild
        // it in the binding role (no single node straddling two roles).
        const name = parseNameAsIdent(R_REF);
        if (isP(P.COLON)) {
            const keyAnn = parseTypeAnn();
            const param = m.FormalParameter(ps, tokStart, 0, ident(R_BIND, name.start, name.end), keyAnn, null) as Node;
            expectP(P.RBRACKET, "']'");
            let ann: Ref = null;
            if (isP(P.COLON)) ann = parseTypeAnn();
            return m.TSIndexSignature(start, tokStart, flags, param, ann) as Node;
        }
        let key: Node = name;
        while (isP(P.DOT)) {
            nextToken();
            const r = parseNameAsIdent(R_NAME); // computed-key member property — a pure name
            key = m.StaticMemberExpression(ps, r.end, 0, key, r) as Node;
        }
        expectP(P.RBRACKET, "']'");
        let mflags = flags | FL.COMPUTED;
        if (isP(P.QUESTION)) { mflags |= FL.OPTIONAL; nextToken(); }
        if (isP(P.LPAREN) || isP(P.LT)) {
            let tp: Ref = null;
            if (isP(P.LT)) { const t = tryParseTypeParams(); if (t !== null) tp = t; }
            const params = parseParams();
            let ret: Ref = null;
            if (isP(P.COLON)) ret = parseTypeAnn();
            return m.TSMethodSignature(start, tokStart, mflags, key, tp, params, ret) as Node;
        }
        let ann: Ref = null;
        if (isP(P.COLON)) ann = parseTypeAnn();
        return m.TSPropertySignature(start, tokStart, mflags, key, ann) as Node;
    }
    let kind = 0;
    if ((isK(K.GET) || isK(K.SET)) && !nextIsPropertyEnd()) { kind = isK(K.GET) ? 1 : 2; nextToken(); }
    let key: Node;
    if ((tok as number) === T_STR) { key = leaf(N.StringLiteral, tokStart, tokEnd); nextToken(); }
    else if (tok === T_NUM) { key = leaf(N.NumericLiteral, tokStart, tokEnd); nextToken(); }
    else key = parseNameAsIdent(R_NAME); // type-member (prop/method signature) key — a pure name
    if (isP(P.QUESTION)) { flags |= FL.OPTIONAL; nextToken(); }
    if (isP(P.LPAREN) || isP(P.LT) || kind !== 0) {
        let tp: Ref = null;
        if (isP(P.LT)) { const t = tryParseTypeParams(); if (t !== null) tp = t; }
        const params = parseParams();
        let ret: Ref = null;
        if (isP(P.COLON)) ret = parseTypeAnn();
        return m.TSMethodSignature(start, tokStart, flags | (kind << FL.KIND_SHIFT), key, tp, params, ret) as Node;
    }
    let ann: Ref = null;
    if (isP(P.COLON)) ann = parseTypeAnn();
    return m.TSPropertySignature(start, tokStart, flags, key, ann) as Node;
}

function expectGtInType(): void {
    if (isP(P.GT)) { nextToken(); return; }
    if (tok === T_PUNCT && (tokVal === P.SHR || tokVal === P.USHR || tokVal === P.GE || tokVal === P.SHREQ || tokVal === P.USHREQ)) {
        pos = tokStart + 1;
        nextToken();
        return;
    }
    err("expected '>'");
}
const isGtLike = (): boolean =>
    tok === T_PUNCT && (tokVal === P.GT || tokVal === P.SHR || tokVal === P.USHR || tokVal === P.GE || tokVal === P.SHREQ || tokVal === P.USHREQ);

function tryParseTypeParams(): Node | null {
    const s = saveState();
    const startPos = tokStart;
    nextToken();
    const from = sp;
    try {
        speculating++;
        while (!isGtLike() && (tok as number) !== T_EOF) {
            const ts = tokStart;
            let flags = 0;
            for (;;) {
                if (isK(K.IN)) { flags |= 1; nextToken(); }
                else if (tok === T_IDENT && tokEnd - tokStart === 3 && src.startsWith('out', tokStart) && !nextIsTypeParamEnd()) { flags |= 2; nextToken(); }
                else if (isK(K.CONST)) { flags |= 4; nextToken(); }
                else break;
            }
            const name = parseIdent(R_BIND); // `<T>` type parameter — a type-namespace binding
            let constraint: Ref = null;
            if (eatK(K.EXTENDS)) constraint = parseType();
            let dflt: Ref = null;
            if (isP(P.EQ)) { nextToken(); dflt = parseType(); }
            push(m.TSTypeParameter(ts, tokStart, flags, name, constraint, dflt) as Node);
            if (!eatP(P.COMMA)) break;
        }
        if (!isGtLike()) throw 0;
        expectGtInType();
        speculating--;
        return m.TSTypeParameterDeclaration(startPos, tokStart, 0, finishList(from)) as Node;
    } catch {
        speculating--;
        sp = from;
        restoreState(s);
        return null;
    }
}

function nextIsTypeParamEnd(): boolean {
    const s = saveState();
    nextToken();
    const end = isGtLike() || isP(P.COMMA) || isK(K.EXTENDS) || isP(P.EQ);
    restoreState(s);
    return end;
}

function tryParseTypeArgsInType(): Node | null {
    const s = saveState();
    const startPos = tokStart;
    nextToken();
    const from = sp;
    try {
        speculating++;
        while (!isGtLike() && (tok as number) !== T_EOF) {
            push(parseType());
            if (!eatP(P.COMMA)) break;
        }
        if (!isGtLike()) throw 0;
        expectGtInType();
        speculating--;
        return m.TSTypeParameterInstantiation(startPos, tokStart, 0, finishList(from)) as Node;
    } catch {
        speculating--;
        sp = from;
        restoreState(s);
        return null;
    }
}

function tryParseTypeArgsForCall(): Node | null {
    const s = saveState();
    const ref = tryParseTypeArgsInType();
    if (ref === null) return null;
    if (isP(P.LPAREN) || tok === T_TEMPLATE_FULL || tok === T_TEMPLATE_HEAD || isP(P.RPAREN) || isP(P.COMMA) || isP(P.SEMI) || isP(P.RBRACE) || tok === T_EOF) {
        return ref;
    }
    restoreState(s);
    return null;
}

/* ------------------------------------------------------------------ entry */

/** The parse result: the standalone program, the error list, and the source-free
 * line table for offset->line/col. NO pool — the source is not retained (leaves
 * materialized their name/raw into the outer `name` slot; identifier names are
 * interned). */
export type ParseResult = { program: Program; errors: ParseError[]; lines: Uint32Array; nodeCount: number };
export type ParseOptions = { ts: boolean };

/** Parse `source` into a standalone type+data Program. House signature:
 * `parse(source, options): { program, errors, lines }` — no pool, no out-param.
 * Source, error sink, intern map and line table are the parser's own fused state,
 * reset at entry; nothing references `source` after this returns. */
export function parse(source: string, options: ParseOptions): ParseResult {
    tsMode = options.ts;
    src = source;
    srcLen = source.length;
    pos = 0;
    sp = 0;
    resetNodeIds();
    errors = [];
    internReset(1 << 13); // holds ~6k distinct names before one growth
    lineCount = 0;
    recordNL(-1); // line 1 starts at offset 0
    void speculating;
    nextToken();
    const from = sp;
    let lastPos = -1;
    while ((tok as number) !== T_EOF) {
        if (pos === lastPos && (tok as number) !== T_EOF) { err('parser stalled'); nextToken(); }
        lastPos = pos;
        push(parseStatement());
    }
    const body = finishList(from);
    const program = m.Program(0, srcLen, 0, body) as RawNode as Program;
    const lines = lineStarts.slice(0, lineCount); // fused table (L2) — no second pass
    const outErrors = errors;
    const nodeCount = peekNodeId() + 1; // ids run 1..peek; +1 for the reserved 0 slot
    // Drop the parser's references so the source string, intern table and stack
    // slots are not pinned by module-level state after we return. (Nulling stk
    // writes null into packed elements — the packed kind is preserved.)
    src = '';
    errors = [];
    internReset(1);
    for (let i = 0; i < stk.length; i++) stk[i] = null;
    return { program, errors: outErrors, lines, nodeCount };
}

/** Convenience: just the standalone Program. */
export function parseProgram(source: string, options: ParseOptions): Program {
    return parse(source, options).program;
}
/** Convenience: program + diagnostics + source-free line table. */
export function parseWithDiagnostics(source: string, options: ParseOptions): ParseResult {
    return parse(source, options);
}

/* --------------------------------------------------- round-6 i4 probe hooks
 *
 * Parse-autopsy support: run the LEXER alone (tokenize the whole source, no node
 * allocation, no grammar) to isolate the lexing share of parse time. Idents are
 * materialized+interned exactly as in a real parse (that cost belongs to lexing),
 * so this bounds the "scan + intern" floor under the grammar/alloc work. The sum
 * escapes so the loop is not dead-code-eliminated. */
export function lexOnly(source: string, options: ParseOptions): number {
    tsMode = options.ts;
    src = source;
    srcLen = source.length;
    pos = 0;
    errors = [];
    internReset(1 << 13);
    lineCount = 0;
    let sum = 0;
    nextToken();
    let lastPos = -1;
    while (tok !== T_EOF) {
        if (tok === T_IDENT) sum += intern(tokStart, tokEnd, tokHash).length;
        else sum += tokEnd - tokStart;
        if (pos === lastPos) break;
        lastPos = pos;
        nextToken();
    }
    src = '';
    errors = [];
    internReset(1);
    return sum;
}
