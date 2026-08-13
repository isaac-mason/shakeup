/** Flat-AST design notes: llm/notes/ast-format.md */

/** Node handle: index into the parallel column arrays. 0 = null (no node). */
export type NodeId = number;

/** 1-based auto-numbered enum (`enumeration('A','B')` -> `{A:1,B:2}`); 0 stays the "none" sentinel. Values type as `number`, not literals. */
export function enumeration<const T extends readonly string[]>(...keys: T): { readonly [P in T[number]]: number } {
    const o: Record<string, number> = {};
    for (let i = 0; i < keys.length; i++) o[keys[i]] = i + 1;
    return Object.freeze(o) as { readonly [P in T[number]]: number };
}

/**
 * Parallel typed-array columns indexed by NodeId. Each node is
 * type/start/end/flags/a/b. Types with <=2 fields hold them inline in a/b;
 * wider types store a fixed field block in `extra` at index a. Lists are
 * (len, ...ids) runs in `extra`. Index 0 is reserved as null in every column.
 */
export type Ast = {
    src: string;
    type: Uint16Array;
    start: Uint32Array;
    end: Uint32Array;
    flags: Uint16Array;
    a: Uint32Array;
    b: Uint32Array;
    nodeCount: number;
    extra: Uint32Array;
    extraTop: number;
    /**
     * Synthetic name store (esbuild keeps names in its symbol table; oxc allocs
     * them into the arena — source text is NEVER grown). An Ident/PrivateIdent
     * with FL.NAMED reads its name from names[a] instead of its span.
     * names[0] is a reserved placeholder so index 0 stays "none".
     */
    names: string[];
    errors: { pos: number; msg: string }[];
};

/* ------------------------------------------------------------------ schema */

/** Every node type name in id order (index + 1 = numeric type id). */
export const NODE_TYPE_NAMES = [
    'Program',
    'Ident', 'PrivateIdent', 'Num', 'Str', 'Bool', 'Null', 'Regex', 'BigInt',
    'TemplateElement', 'ThisExpr', 'SuperExpr', 'MetaProp',
    'TemplateLiteral', 'TaggedTemplate', 'ArrayExpr', 'ObjectExpr', 'Property', 'Spread',
    'Binary', 'Logical', 'Assign', 'Unary', 'Update', 'Cond', 'Call', 'New', 'Member',
    'Seq', 'Arrow', 'FuncExpr', 'ClassExpr', 'Yield', 'Await', 'ImportExpr',
    'ExprStmt', 'VarDecl', 'VarDeclarator', 'Block', 'If', 'For', 'ForIn', 'ForOf',
    'While', 'DoWhile', 'Switch', 'SwitchCase', 'Try', 'CatchClause', 'Return', 'Throw',
    'Break', 'Continue', 'Labeled', 'Empty', 'Debugger', 'FuncDecl', 'ClassDecl',
    'MethodDef', 'PropDef', 'StaticBlock',
    'ObjectPattern', 'ArrayPattern', 'AssignPattern', 'RestElement', 'Param',
    'ImportDecl', 'ImportSpec', 'ImportDefaultSpec', 'ImportNamespaceSpec',
    'ExportNamed', 'ExportSpec', 'ExportDefault', 'ExportAll',
    'TSTypeAnn', 'TSKeyword', 'TSTypeRef', 'TSQualifiedName', 'TSTypeArgs', 'TSTypeParams',
    'TSTypeParam', 'TSTuple', 'TSNamedTupleMember', 'TSTypeLit', 'TSPropSig', 'TSMethodSig',
    'TSIndexSig', 'TSCallSig', 'TSCtorSig', 'TSUnion', 'TSIntersection', 'TSFunctionType',
    'TSCtorType', 'TSArrayType', 'TSIndexedAccess', 'TSTypeOperator', 'TSTypeQuery',
    'TSConditional', 'TSInfer', 'TSMapped', 'TSLiteralType', 'TSTemplateLiteralType',
    'TSImportType', 'TSInterfaceDecl', 'TSHeritage', 'TSTypeAliasDecl', 'TSEnumDecl',
    'TSEnumMember', 'TSAs', 'TSSatisfies', 'TSNonNull', 'TSModuleDecl',
] as const;

export type TypeName = (typeof NODE_TYPE_NAMES)[number];
export type Cat = 'expr' | 'stmt' | 'pattern' | 'tstype' | 'leaf' | 'other';
/** what a slot may contain: a category, a concrete node type, or hole/any */
export type Ref = Cat | TypeName | 'hole' | 'any';

export type FieldDef = { kind: 'child' | 'list'; of: readonly Ref[] };
/** child slot: one NodeId, 0 = absent */
const c = (...of: Ref[]): FieldDef => ({ kind: 'child', of: of.length ? of : ['any'] });
/** list slot: ref into extra -> (len, ...ids), 0 or empty run = none; holes = 0 entries */
const l = (...of: Ref[]): FieldDef => ({ kind: 'list', of: of.length ? of : ['any'] });

export type NodeDef = {
    /** primary category — drives IS_EXPR/IS_STMT/... bitmaps */
    cat: Cat;
    /** ordered fields; order defines builder args and slot indices */
    fields?: Record<string, FieldDef>;
    /** documented flag layout (name or name:domain), machine-readable for tooling */
    flags?: string[];
    /** for leaves whose span IS the payload: what the span text means */
    span?: 'name' | 'value' | 'raw';
};

// `satisfies` verifies name<->def agreement both ways; c()/l() refs are checked against Ref at each call site.
const SCHEMA_DEF = {
    Program: { cat: 'other', fields: { body: l('stmt') } },

    // leaves — payload is the span (names/values decode lazily)
    Ident: { cat: 'leaf', span: 'name' },
    PrivateIdent: { cat: 'leaf', span: 'name' },
    Num: { cat: 'leaf', span: 'value' },
    Str: { cat: 'leaf', span: 'value' },
    Bool: { cat: 'leaf', span: 'value', flags: ['value'] },
    Null: { cat: 'leaf' },
    Regex: { cat: 'leaf', span: 'value' },
    BigInt: { cat: 'leaf', span: 'value' },
    TemplateElement: { cat: 'leaf', span: 'raw' },
    ThisExpr: { cat: 'leaf' },
    SuperExpr: { cat: 'leaf' },
    MetaProp: { cat: 'leaf', flags: ['which:1=import.meta,2=new.target'] },

    // expressions
    TemplateLiteral: { cat: 'expr', fields: { quasis: l('TemplateElement'), exprs: l('expr') } },
    TaggedTemplate: { cat: 'expr', fields: { tag: c('expr'), quasi: c('TemplateLiteral') } },
    ArrayExpr: { cat: 'expr', fields: { elements: l('expr', 'Spread', 'hole') } },
    ObjectExpr: { cat: 'expr', fields: { props: l('Property', 'Spread') } },
    Property: { cat: 'other', fields: { key: c('expr'), value: c('expr', 'pattern') }, flags: ['shorthand', 'computed', 'kind:0=init,1=get,2=set'] },
    Spread: { cat: 'expr', fields: { arg: c('expr') } },
    Binary: { cat: 'expr', fields: { left: c('expr'), right: c('expr') }, flags: ['op:OP'] },
    Logical: { cat: 'expr', fields: { left: c('expr'), right: c('expr') }, flags: ['op:OP'] },
    Assign: { cat: 'expr', fields: { left: c('expr', 'pattern'), right: c('expr') }, flags: ['op:OP'] },
    Unary: { cat: 'expr', fields: { arg: c('expr') }, flags: ['op:OP'] },
    Update: { cat: 'expr', fields: { arg: c('expr') }, flags: ['op:OP', 'prefix'] },
    Cond: { cat: 'expr', fields: { test: c('expr'), consequent: c('expr'), alternate: c('expr') } },
    Call: { cat: 'expr', fields: { callee: c('expr'), args: l('expr', 'Spread'), typeArgs: c('TSTypeArgs') }, flags: ['optional'] },
    New: { cat: 'expr', fields: { callee: c('expr'), args: l('expr', 'Spread'), typeArgs: c('TSTypeArgs') } },
    Member: { cat: 'expr', fields: { object: c('expr'), property: c('expr') }, flags: ['computed', 'optional'] },
    Seq: { cat: 'expr', fields: { exprs: l('expr') } },
    Arrow: { cat: 'expr', fields: { typeParams: c('TSTypeParams'), params: l('Param', 'RestElement'), returnType: c('TSTypeAnn'), body: c('Block', 'expr') }, flags: ['async', 'exprBody'] },
    FuncExpr: { cat: 'expr', fields: { id: c('Ident'), typeParams: c('TSTypeParams'), params: l('Param', 'RestElement'), returnType: c('TSTypeAnn'), body: c('Block') }, flags: ['async', 'generator'] },
    ClassExpr: { cat: 'expr', fields: { id: c('Ident'), typeParams: c('TSTypeParams'), superClass: c('expr'), superTypeArgs: c('TSTypeArgs'), implements: l('TSHeritage'), body: l('MethodDef', 'PropDef', 'StaticBlock', 'TSIndexSig') } },
    Yield: { cat: 'expr', fields: { arg: c('expr') }, flags: ['delegate'] },
    Await: { cat: 'expr', fields: { arg: c('expr') } },
    ImportExpr: { cat: 'expr', fields: { source: c('expr'), options: c('expr') } },

    // statements / declarations
    ExprStmt: { cat: 'stmt', fields: { expr: c('expr') } },
    VarDecl: { cat: 'stmt', fields: { declarators: l('VarDeclarator') }, flags: ['kind:VAR_KIND', 'declare'] },
    VarDeclarator: { cat: 'other', fields: { id: c('pattern'), typeAnn: c('TSTypeAnn'), init: c('expr') }, flags: ['definite'] },
    Block: { cat: 'stmt', fields: { body: l('stmt') } },
    If: { cat: 'stmt', fields: { test: c('expr'), consequent: c('stmt'), alternate: c('stmt') } },
    For: { cat: 'stmt', fields: { init: c('VarDecl', 'expr'), test: c('expr'), update: c('expr'), body: c('stmt') } },
    ForIn: { cat: 'stmt', fields: { left: c('VarDecl', 'pattern', 'expr'), right: c('expr'), body: c('stmt') } },
    ForOf: { cat: 'stmt', fields: { left: c('VarDecl', 'pattern', 'expr'), right: c('expr'), body: c('stmt') }, flags: ['await'] },
    While: { cat: 'stmt', fields: { test: c('expr'), body: c('stmt') } },
    DoWhile: { cat: 'stmt', fields: { body: c('stmt'), test: c('expr') } },
    Switch: { cat: 'stmt', fields: { disc: c('expr'), cases: l('SwitchCase') } },
    SwitchCase: { cat: 'other', fields: { test: c('expr'), body: l('stmt') } },
    Try: { cat: 'stmt', fields: { block: c('Block'), handler: c('CatchClause'), finalizer: c('Block') } },
    CatchClause: { cat: 'other', fields: { param: c('pattern'), body: c('Block') } },
    Return: { cat: 'stmt', fields: { arg: c('expr') } },
    Throw: { cat: 'stmt', fields: { arg: c('expr') } },
    Break: { cat: 'stmt', fields: { label: c('Ident') } },
    Continue: { cat: 'stmt', fields: { label: c('Ident') } },
    Labeled: { cat: 'stmt', fields: { label: c('Ident'), body: c('stmt') } },
    Empty: { cat: 'stmt' },
    Debugger: { cat: 'stmt' },
    FuncDecl: { cat: 'stmt', fields: { id: c('Ident'), typeParams: c('TSTypeParams'), params: l('Param', 'RestElement'), returnType: c('TSTypeAnn'), body: c('Block') }, flags: ['async', 'generator', 'declare'] },
    ClassDecl: { cat: 'stmt', fields: { id: c('Ident'), typeParams: c('TSTypeParams'), superClass: c('expr'), superTypeArgs: c('TSTypeArgs'), implements: l('TSHeritage'), body: l('MethodDef', 'PropDef', 'StaticBlock', 'TSIndexSig') }, flags: ['abstract', 'declare'] },
    MethodDef: { cat: 'other', fields: { key: c('expr'), value: c('FuncExpr') }, flags: ['static', 'computed', 'kind:0=method,1=get,2=set,3=ctor', 'abstract', 'access:ACCESS'] },
    PropDef: { cat: 'other', fields: { key: c('expr'), typeAnn: c('TSTypeAnn'), value: c('expr') }, flags: ['static', 'computed', 'readonly', 'optional', 'definite', 'declare', 'access:ACCESS'] },
    StaticBlock: { cat: 'other', fields: { body: l('stmt') } },

    // patterns
    ObjectPattern: { cat: 'pattern', fields: { props: l('Property', 'RestElement') } },
    ArrayPattern: { cat: 'pattern', fields: { elements: l('pattern', 'hole') } },
    AssignPattern: { cat: 'pattern', fields: { left: c('pattern'), right: c('expr') } },
    RestElement: { cat: 'pattern', fields: { arg: c('pattern'), typeAnn: c('TSTypeAnn') } },
    Param: { cat: 'other', fields: { pattern: c('pattern'), typeAnn: c('TSTypeAnn'), init: c('expr') }, flags: ['optional', 'readonly', 'access:ACCESS'] },

    // modules
    ImportDecl: { cat: 'stmt', fields: { specifiers: l('ImportSpec', 'ImportDefaultSpec', 'ImportNamespaceSpec'), source: c('Str') }, flags: ['typeOnly'] },
    ImportSpec: { cat: 'other', fields: { local: c('Ident'), imported: c('Ident', 'Str') }, flags: ['typeOnly'] },
    ImportDefaultSpec: { cat: 'other', fields: { local: c('Ident') } },
    ImportNamespaceSpec: { cat: 'other', fields: { local: c('Ident') } },
    ExportNamed: { cat: 'stmt', fields: { decl: c('stmt'), specifiers: l('ExportSpec'), source: c('Str') }, flags: ['typeOnly'] },
    ExportSpec: { cat: 'other', fields: { local: c('Ident', 'Str'), exported: c('Ident', 'Str') }, flags: ['typeOnly'] },
    ExportDefault: { cat: 'stmt', fields: { decl: c('expr', 'stmt') } },
    ExportAll: { cat: 'stmt', fields: { source: c('Str'), exported: c('Ident') } },

    // TS types — real nodes (llm/notes/ast-format.md "TS types are real nodes")
    TSTypeAnn: { cat: 'tstype', fields: { typeAnn: c('tstype') } }, // span includes ':' — stripping erases whole span
    TSKeyword: { cat: 'tstype', flags: ['which:TSK'] },
    TSTypeRef: { cat: 'tstype', fields: { name: c('Ident', 'TSQualifiedName'), typeArgs: c('TSTypeArgs') } },
    TSQualifiedName: { cat: 'tstype', fields: { left: c('Ident', 'TSQualifiedName'), right: c('Ident') } },
    TSTypeArgs: { cat: 'tstype', fields: { args: l('tstype') } },
    TSTypeParams: { cat: 'tstype', fields: { params: l('TSTypeParam') } },
    TSTypeParam: { cat: 'tstype', fields: { name: c('Ident'), constraint: c('tstype'), default: c('tstype') }, flags: ['in', 'out', 'const'] },
    TSTuple: { cat: 'tstype', fields: { elements: l('tstype', 'TSNamedTupleMember') } },
    TSNamedTupleMember: { cat: 'tstype', fields: { label: c('Ident'), elemType: c('tstype') }, flags: ['optional'] },
    TSTypeLit: { cat: 'tstype', fields: { members: l('TSPropSig', 'TSMethodSig', 'TSIndexSig', 'TSCallSig', 'TSCtorSig') } },
    TSPropSig: { cat: 'tstype', fields: { key: c('expr'), typeAnn: c('TSTypeAnn') }, flags: ['optional', 'readonly', 'computed'] },
    TSMethodSig: { cat: 'tstype', fields: { key: c('expr'), typeParams: c('TSTypeParams'), params: l('Param', 'RestElement'), returnType: c('TSTypeAnn') }, flags: ['optional', 'kind:0=method,1=get,2=set', 'computed'] },
    TSIndexSig: { cat: 'tstype', fields: { param: c('Param'), typeAnn: c('TSTypeAnn') }, flags: ['readonly'] },
    TSCallSig: { cat: 'tstype', fields: { typeParams: c('TSTypeParams'), params: l('Param', 'RestElement'), returnType: c('TSTypeAnn') } },
    TSCtorSig: { cat: 'tstype', fields: { typeParams: c('TSTypeParams'), params: l('Param', 'RestElement'), returnType: c('TSTypeAnn') } },
    TSUnion: { cat: 'tstype', fields: { types: l('tstype') } },
    TSIntersection: { cat: 'tstype', fields: { types: l('tstype') } },
    TSFunctionType: { cat: 'tstype', fields: { typeParams: c('TSTypeParams'), params: l('Param', 'RestElement'), returnType: c('TSTypeAnn') } },
    TSCtorType: { cat: 'tstype', fields: { typeParams: c('TSTypeParams'), params: l('Param', 'RestElement'), returnType: c('TSTypeAnn') }, flags: ['abstract'] },
    TSArrayType: { cat: 'tstype', fields: { elemType: c('tstype') } },
    TSIndexedAccess: { cat: 'tstype', fields: { objType: c('tstype'), indexType: c('tstype') } },
    TSTypeOperator: { cat: 'tstype', fields: { typeAnn: c('tstype') }, flags: ['op:TSOP'] },
    TSTypeQuery: { cat: 'tstype', fields: { exprName: c('Ident', 'TSQualifiedName'), typeArgs: c('TSTypeArgs') } },
    TSConditional: { cat: 'tstype', fields: { checkType: c('tstype'), extendsType: c('tstype'), trueType: c('tstype'), falseType: c('tstype') } },
    TSInfer: { cat: 'tstype', fields: { typeParam: c('TSTypeParam') } },
    TSMapped: { cat: 'tstype', fields: { typeParam: c('TSTypeParam'), nameType: c('tstype'), typeAnn: c('tstype') }, flags: ['roMod:2b@4', 'optMod:2b@6'] },
    TSLiteralType: { cat: 'tstype', fields: { literal: c('leaf') } },
    TSTemplateLiteralType: { cat: 'tstype', fields: { quasis: l('TemplateElement'), types: l('tstype') } },
    TSImportType: { cat: 'tstype', fields: { source: c('Str'), qualifier: c('Ident', 'TSQualifiedName'), typeArgs: c('TSTypeArgs') } },
    TSInterfaceDecl: { cat: 'stmt', fields: { id: c('Ident'), typeParams: c('TSTypeParams'), extends: l('TSHeritage'), body: l('TSPropSig', 'TSMethodSig', 'TSIndexSig', 'TSCallSig', 'TSCtorSig') }, flags: ['declare'] },
    TSHeritage: { cat: 'tstype', fields: { expr: c('Ident', 'TSQualifiedName'), typeArgs: c('TSTypeArgs') } },
    TSTypeAliasDecl: { cat: 'stmt', fields: { id: c('Ident'), typeParams: c('TSTypeParams'), typeAnn: c('tstype') }, flags: ['declare'] },
    TSEnumDecl: { cat: 'stmt', fields: { id: c('Ident'), members: l('TSEnumMember') }, flags: ['constEnum', 'declare'] },
    TSEnumMember: { cat: 'other', fields: { id: c('Ident', 'Str'), init: c('expr') } },
    TSAs: { cat: 'expr', fields: { expr: c('expr'), typeAnn: c('tstype') } },
    TSSatisfies: { cat: 'expr', fields: { expr: c('expr'), typeAnn: c('tstype') } },
    TSNonNull: { cat: 'expr', fields: { expr: c('expr') } },
    TSModuleDecl: { cat: 'stmt', fields: { id: c('Ident', 'Str'), body: l('stmt') }, flags: ['declare', 'namespace'] },
} satisfies Record<TypeName, NodeDef>;

/** String-indexable view of the schema. */
export const SCHEMA: Record<string, NodeDef> = SCHEMA_DEF;

/* shared flag bits (per-type meaning declared in SCHEMA.flags) */
export const FL = {
    /** Ident/PrivateIdent only: name lives in ast.names[a], not the span */
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
export const VAR_KIND = { VAR: 1, LET: 2, CONST: 3, KIND_MASK: 3 } as const;

// operator codes (Binary/Logical/Assign/Unary/Update flags low 6 bits; must stay < 64)
export const OP = enumeration(
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

export const TSK = enumeration(
    'NUMBER', 'STRING', 'BOOLEAN', 'ANY', 'UNKNOWN', 'VOID', 'NULL',
    'UNDEFINED', 'NEVER', 'OBJECT', 'SYMBOL', 'BIGINT', 'INTRINSIC', 'THIS',
);

export const TSOP = enumeration('KEYOF', 'READONLY', 'UNIQUE');

/* ------------------------------------------------- derived schema tables */

export const N: Record<string, number> = {};
export const TYPE_NAME: string[] = ['<null>'];
const FIELD_NAMES: string[][] = [[]];
/** per type: bitmask of which fields are lists */
export const FIELD_LIST_MASK: number[] = [0];
/** per type: field count */
export const FIELD_COUNT: number[] = [0];
/** per type: true if fields live inline in a/b (count <= 2) */
export const FIELD_INLINE: boolean[] = [false];

const DEF_NAMES = NODE_TYPE_NAMES as readonly string[]; // id order = array order
export const TYPE_COUNT = DEF_NAMES.length + 1;

/** category bitmaps, indexed by type id */
export const IS_EXPR = new Uint8Array(TYPE_COUNT);
export const IS_STMT = new Uint8Array(TYPE_COUNT);
export const IS_PATTERN = new Uint8Array(TYPE_COUNT);
export const IS_TSTYPE = new Uint8Array(TYPE_COUNT);
export const IS_LEAF = new Uint8Array(TYPE_COUNT);

for (let i = 0; i < DEF_NAMES.length; i++) {
    const name = DEF_NAMES[i];
    const def = SCHEMA[name];
    const id = i + 1;
    N[name] = id;
    TYPE_NAME[id] = name;
    const fieldNames = def.fields ? Object.keys(def.fields) : [];
    let listMask = 0;
    for (let j = 0; j < fieldNames.length; j++) if (def.fields![fieldNames[j]].kind === 'list') listMask |= 1 << j;
    FIELD_NAMES[id] = fieldNames;
    FIELD_LIST_MASK[id] = listMask;
    FIELD_COUNT[id] = fieldNames.length;
    FIELD_INLINE[id] = fieldNames.length <= 2;
    if (def.cat === 'expr' || def.cat === 'leaf') IS_EXPR[id] = 1; // leaves are expression-position nodes
    if (def.cat === 'stmt') IS_STMT[id] = 1;
    if (def.cat === 'pattern') IS_PATTERN[id] = 1;
    if (def.cat === 'tstype' || (name.startsWith('TS') && def.cat !== 'expr' && def.cat !== 'other')) IS_TSTYPE[id] = 1;
    if (def.cat === 'leaf') IS_LEAF[id] = 1;
}

export const isExpr = (type: number): boolean => IS_EXPR[type] === 1;
export const isStmt = (type: number): boolean => IS_STMT[type] === 1;
export const isPattern = (type: number): boolean => IS_PATTERN[type] === 1;

/** is this node type TS-type-only syntax (erased by emit)? Enums/namespaces are runtime. */
export const isTypeOnlyNode = (type: number): boolean =>
    (IS_TSTYPE[type] === 1 || TYPE_NAME[type] === 'TSInterfaceDecl' || TYPE_NAME[type] === 'TSTypeAliasDecl') &&
    type !== N.TSEnumDecl &&
    type !== N.TSEnumMember &&
    type !== N.TSModuleDecl;

/* ------------------------------------------------------------- ast struct */

/** Allocate an empty Ast. Columns grow by doubling; small initial capacity keeps creation cheap. */
export function createAst(initialCap = 1 << 8): Ast {
    const cap = initialCap;
    return {
        src: '',
        type: new Uint16Array(cap),
        start: new Uint32Array(cap),
        end: new Uint32Array(cap),
        flags: new Uint16Array(cap),
        a: new Uint32Array(cap),
        b: new Uint32Array(cap),
        nodeCount: 1, // 0 reserved as null
        extra: new Uint32Array(cap),
        extraTop: 1, // 0 reserved as null ref
        names: [''],
        errors: [],
    };
}

/** Rewind an Ast for reuse against new source; column capacity persists. */
export function resetAst(ast: Ast, src: string): void {
    ast.src = src;
    ast.nodeCount = 1;
    ast.extraTop = 1;
    ast.names.length = 1;
    ast.errors.length = 0;
}

function growNodes(ast: Ast): void {
    const cap = ast.type.length * 2;
    const g = <T extends Uint16Array | Uint32Array>(old: T, make: (n: number) => T): T => {
        const next = make(cap);
        next.set(old);
        return next;
    };
    ast.type = g(ast.type, (n) => new Uint16Array(n));
    ast.flags = g(ast.flags, (n) => new Uint16Array(n));
    ast.start = g(ast.start, (n) => new Uint32Array(n));
    ast.end = g(ast.end, (n) => new Uint32Array(n));
    ast.a = g(ast.a, (n) => new Uint32Array(n));
    ast.b = g(ast.b, (n) => new Uint32Array(n));
}

/** Ensure `extra` has room for `n` more slots, growing by doubling if needed. */
export function ensureExtra(ast: Ast, n: number): void {
    if (ast.extraTop + n <= ast.extra.length) return;
    let cap = ast.extra.length * 2;
    while (cap < ast.extraTop + n) cap *= 2;
    const next = new Uint32Array(cap);
    next.set(ast.extra);
    ast.extra = next;
}

/** Append a raw node; a/b are inline fields or the extra block index per the type's schema. Returns its NodeId. */
export function addNode(ast: Ast, type: number, start: number, end: number, flags: number, a: number, b: number): NodeId {
    const id = ast.nodeCount;
    if (id >= ast.type.length) growNodes(ast);
    ast.type[id] = type;
    ast.start[id] = start;
    ast.end[id] = end;
    ast.flags[id] = flags;
    ast.a[id] = a;
    ast.b[id] = b;
    ast.nodeCount = id + 1;
    return id;
}

/** Write a `(len, ...ids)` list run into extra and return its ref (0 = empty list). */
export function addList(ast: Ast, items: ArrayLike<number>, from = 0, to = items.length): number {
    const len = to - from;
    ensureExtra(ast, len + 1);
    const at = ast.extraTop;
    const extra = ast.extra;
    extra[at] = len;
    for (let i = 0; i < len; i++) extra[at + 1 + i] = items[(from + i) as number];
    ast.extraTop = at + 1 + len;
    return at;
}

/** Length of the list run at `ref` (0 ref = empty). */
export const listLen = (ast: Ast, ref: number): number => (ref === 0 ? 0 : ast.extra[ref]);
/** The `i`-th id of the list run at `ref`. */
export const listAt = (ast: Ast, ref: number, i: number): NodeId => ast.extra[ref + 1 + i];

/* -------------------------------------------------------- field accessors */

/** Read field `i` of `id` (a NodeId, list ref, or raw payload per the schema). */
export function getField(ast: Ast, id: NodeId, i: number): number {
    if (FIELD_INLINE[ast.type[id]]) return i === 0 ? ast.a[id] : ast.b[id];
    return ast.extra[ast.a[id] + i];
}

/** Write field `i` of `id`. */
export function setField(ast: Ast, id: NodeId, i: number, v: number): void {
    if (FIELD_INLINE[ast.type[id]]) {
        if (i === 0) ast.a[id] = v;
        else ast.b[id] = v;
    } else ast.extra[ast.a[id] + i] = v;
}

/* --------------------------------------------- schema-derived API typing */

type SchemaT = typeof SCHEMA_DEF;
type FieldsOf<T extends TypeName> = SchemaT[T] extends { fields: infer F } ? F : Record<never, never>;
/** Field names of a node type, straight from the schema's literal types. */
export type FieldNameOf<T extends TypeName> = Extract<keyof FieldsOf<T>, string>;

/** `A.Binary.left(ast, id)` / `A.Call.setCallee(ast, id, v)` — misspelled type or field names are compile errors. */
export type Accessors = {
    [T in TypeName]: { [F in FieldNameOf<T>]: (ast: Ast, id: NodeId) => number } & {
        [F in FieldNameOf<T> as `set${Capitalize<F>}`]: (ast: Ast, id: NodeId, v: number) => void;
    };
};

/** Per-type named field accessors generated from the schema; list fields return a list ref. */
export const A = {} as Accessors;
{
    const fill = A as unknown as Record<string, Record<string, unknown>>;
    for (let t = 1; t < TYPE_COUNT; t++) fill[TYPE_NAME[t]] = {};
}
for (let t = 1; t < TYPE_COUNT; t++) {
    const acc: Record<string, any> = {};
    const names = FIELD_NAMES[t];
    for (let i = 0; i < names.length; i++) {
        const idx = i;
        if (FIELD_INLINE[t]) {
            acc[names[i]] = idx === 0 ? (ast: Ast, id: NodeId) => ast.a[id] : (ast: Ast, id: NodeId) => ast.b[id];
            acc['set' + capitalize(names[i])] =
                idx === 0
                    ? (ast: Ast, id: NodeId, v: number) => (ast.a[id] = v)
                    : (ast: Ast, id: NodeId, v: number) => (ast.b[id] = v);
        } else {
            acc[names[i]] = (ast: Ast, id: NodeId) => ast.extra[ast.a[id] + idx];
            acc['set' + capitalize(names[i])] = (ast: Ast, id: NodeId, v: number) => (ast.extra[ast.a[id] + idx] = v);
        }
    }
    Object.assign((A as unknown as Record<string, object>)[TYPE_NAME[t]], acc);
}
function capitalize(s: string): string {
    return s[0].toUpperCase() + s.slice(1);
}

/** Positional builders: `make.Binary(ast, start, end, flags, left, right)` — type-name-keyed; field args follow schema order (arity/order unchecked: the type system cannot order record keys — see `build` for the fully-checked form). */
export type Builders = {
    [T in TypeName]: (ast: Ast, start: number, end: number, flags: number, ...fields: number[]) => NodeId;
};
export const make = {} as Builders;
const makeDyn = make as unknown as Record<string, (ast: Ast, start: number, end: number, flags: number, ...fields: number[]) => NodeId>;
for (let t = 1; t < TYPE_COUNT; t++) {
    const count = FIELD_COUNT[t];
    const type = t;
    if (FIELD_INLINE[t]) {
        makeDyn[TYPE_NAME[t]] = (ast, start, end, flags, f0 = 0, f1 = 0) => addNode(ast, type, start, end, flags, f0, f1);
    } else {
        makeDyn[TYPE_NAME[t]] = (ast, start, end, flags, ...fields) => {
            ensureExtra(ast, count);
            const at = ast.extraTop;
            for (let i = 0; i < count; i++) ast.extra[at + i] = fields[i] ?? 0;
            ast.extraTop = at + count;
            return addNode(ast, type, start, end, flags, at, 0);
        };
    }
}

/**
 * Object-param builders — the fully type-checked construction API derived from
 * the schema: `build.Call(ast, start, end, { callee, args, flags })`. Field
 * names are exactly the schema's (typos = compile errors), order is irrelevant,
 * omitted fields default to 0 (absent). Prefer `make` only on measured hot paths.
 */
export type BuildFields<T extends TypeName> = { [F in FieldNameOf<T>]?: number } & { flags?: number };
export type ObjectBuilders = {
    [T in TypeName]: (ast: Ast, start: number, end: number, fields?: BuildFields<T>) => NodeId;
};
export const build = {} as ObjectBuilders;
{
    const buildDyn = build as unknown as Record<string, (ast: Ast, start: number, end: number, fields?: Record<string, number>) => NodeId>;
    for (let t = 1; t < TYPE_COUNT; t++) {
        const names = FIELD_NAMES[t];
        const name = TYPE_NAME[t];
        buildDyn[name] = (ast, start, end, fields = {}) => {
            const args: number[] = [];
            for (const n of names) args.push(fields[n] ?? 0);
            return makeDyn[name](ast, start, end, fields.flags ?? 0, ...args);
        };
    }
}

/**
 * Splice a list field: remove `removeCount` entries at `index`, insert
 * `insertIds`. Arena discipline: writes a NEW run in `extra` and repoints the
 * owner's slot — the old run becomes garbage until the module re-parses (same
 * cost profile as an arena Vec realloc). O(list length).
 */
export function spliceList(
    ast: Ast,
    owner: NodeId,
    fieldIndex: number,
    index: number,
    removeCount: number,
    insertIds: readonly number[],
): void {
    const oldRef = getField(ast, owner, fieldIndex);
    const oldLen = listLen(ast, oldRef);
    const newLen = oldLen - removeCount + insertIds.length;
    ensureExtra(ast, newLen + 1);
    const at = ast.extraTop;
    ast.extra[at] = newLen;
    let w = at + 1;
    for (let i = 0; i < index; i++) ast.extra[w++] = listAt(ast, oldRef, i);
    for (const id of insertIds) ast.extra[w++] = id;
    for (let i = index + removeCount; i < oldLen; i++) ast.extra[w++] = listAt(ast, oldRef, i);
    ast.extraTop = w;
    setField(ast, owner, fieldIndex, at);
}

/* ---------------------------------------------------------------- walking */

/**
 * Visit direct children of `id` (skips absent optionals). Returning false stops
 * early. `listIndex` is the child's position within a list field, or -1 for a
 * direct slot — MUTATING walkers must branch on it: direct slot -> setField;
 * list element -> spliceList (setField on a list child would overwrite the
 * list REF with a node id and corrupt the field).
 */
export function walkChildren(
    ast: Ast,
    id: NodeId,
    cb: (child: NodeId, fieldIndex: number, listIndex: number) => boolean | void,
): void {
    const t = ast.type[id];
    const count = FIELD_COUNT[t];
    if (count === 0) return;
    const listMask = FIELD_LIST_MASK[t];
    const inline = FIELD_INLINE[t];
    const base = ast.a[id];
    for (let i = 0; i < count; i++) {
        const v = inline ? (i === 0 ? ast.a[id] : ast.b[id]) : ast.extra[base + i];
        if (v === 0) continue;
        if (listMask & (1 << i)) {
            const len = ast.extra[v];
            for (let j = 0; j < len; j++) {
                const child = ast.extra[v + 1 + j];
                if (child !== 0 && cb(child, i, j) === false) return;
            }
        } else if (cb(v, i, -1) === false) return;
    }
}

/** depth-first pre-order walk from `id`. enter may return false to skip the subtree. */
export function walk(ast: Ast, id: NodeId, enter: (id: NodeId) => boolean | void, exit?: (id: NodeId) => void): void {
    if (enter(id) === false) return;
    walkChildren(ast, id, (child) => {
        walk(ast, child, enter, exit);
    });
    exit?.(id);
}

/** clone subtree `id` (possibly from another module's ast) into `dst`; returns new root id. */
export function cloneSubtree(
    src: Ast,
    id: NodeId,
    dst: Ast,
    substitute?: (src: Ast, id: NodeId, dst: Ast) => NodeId | 0,
): NodeId {
    if (id === 0) return 0;
    if (substitute) {
        const sub = substitute(src, id, dst);
        if (sub !== 0) return sub;
    }
    const t = src.type[id];
    const count = FIELD_COUNT[t];
    const stripSpans = src !== dst;
    const start = stripSpans ? 0 : src.start[id];
    const end = stripSpans ? 0 : src.end[id];
    if (count === 0) {
        // leaf spans are the payload (identifier names, literal text) — never strip.
        // FL.NAMED leaves carry their name via the store: same-arena clones share
        // the index; cross-arena clones copy the string into dst.names.
        let a = 0;
        if ((t === N.Ident || t === N.PrivateIdent) && (src.flags[id] & FL.NAMED) !== 0) {
            if (src === dst) a = src.a[id];
            else {
                a = dst.names.length;
                dst.names.push(src.names[src.a[id]]);
            }
        }
        return addNode(dst, t, src.start[id], src.end[id], src.flags[id], a, 0);
    }
    const listMask = FIELD_LIST_MASK[t];
    const inline = FIELD_INLINE[t];
    const base = src.a[id];
    const cloned: number[] = [];
    for (let i = 0; i < count; i++) {
        const v = inline ? (i === 0 ? src.a[id] : src.b[id]) : src.extra[base + i];
        if (v === 0) {
            cloned.push(0);
        } else if (listMask & (1 << i)) {
            const len = src.extra[v];
            const items: number[] = [];
            for (let j = 0; j < len; j++) items.push(cloneSubtree(src, src.extra[v + 1 + j], dst, substitute));
            cloned.push(addList(dst, items));
        } else {
            cloned.push(cloneSubtree(src, v, dst, substitute));
        }
    }
    return (make as Record<string, (typeof make)[TypeName]>)[TYPE_NAME[t]](dst, start, end, src.flags[id], ...cloned);
}

/* ------------------------------------------------------- lazy views (edge) */

export const text = (ast: Ast, id: NodeId): string => ast.src.slice(ast.start[id], ast.end[id]);

/** materialize a subtree to plain objects — the escape hatch / debug view. O(subtree). */
export function toObject(ast: Ast, id: NodeId): unknown {
    if (id === 0) return null;
    const t = ast.type[id];
    const out: Record<string, unknown> = { type: TYPE_NAME[t], start: ast.start[id], end: ast.end[id] };
    if (ast.flags[id] !== 0) out.flags = ast.flags[id];
    if (FIELD_COUNT[t] === 0) {
        if (IS_LEAF[t] === 1 && SCHEMA[TYPE_NAME[t]].span !== undefined) out.text = text(ast, id);
        return out;
    }
    const names = FIELD_NAMES[t];
    const listMask = FIELD_LIST_MASK[t];
    const inline = FIELD_INLINE[t];
    const base = ast.a[id];
    for (let i = 0; i < names.length; i++) {
        const v = inline ? (i === 0 ? ast.a[id] : ast.b[id]) : ast.extra[base + i];
        if (listMask & (1 << i)) {
            const len = v === 0 ? 0 : ast.extra[v];
            const items: unknown[] = [];
            for (let j = 0; j < len; j++) items.push(toObject(ast, ast.extra[v + 1 + j]));
            out[names[i]] = items;
        } else {
            out[names[i]] = v === 0 ? null : toObject(ast, v);
        }
    }
    return out;
}
