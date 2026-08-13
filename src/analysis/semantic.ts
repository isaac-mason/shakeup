/** Scope/symbol/reference tables. Design notes: llm/notes/oxc-internals.md §semantic */

import {
    type Ast,
    type NodeId,
    A,
    FIELD_COUNT,
    FIELD_INLINE,
    FIELD_LIST_MASK,
    FL,
    N,
    VAR_KIND,
    enumeration,
    listAt,
    listLen,
    text,
} from '../ast.ts';

/* ------------------------------------------------------------------- flags */

/** Scope kinds, stored in `Semantic.scopeFlags`. */
export const SCOPE = enumeration('MODULE', 'FUNCTION', 'BLOCK', 'CLASS', 'CATCH', 'FOR', 'SWITCH', 'TYPE', 'ENUM', 'NAMESPACE');

/** Symbol-kind bit flags, OR-combined in `Semantic.symFlags` (a dual-namespace symbol carries both a value and a type bit). */
export const SYM = {
    VAR: 1 << 0,
    LET: 1 << 1,
    CONST: 1 << 2,
    FUNCTION: 1 << 3,
    CLASS: 1 << 4,
    PARAM: 1 << 5,
    IMPORT: 1 << 6,
    CATCH: 1 << 7,
    TYPE: 1 << 8, // interface / type alias / type param — type namespace
    ENUM: 1 << 9,
    NAMESPACE: 1 << 10,
} as const;

/** namespace selector for binding/resolution */
const NS_VALUE = 0;
const NS_TYPE = 1;

/* ------------------------------------------------------------------ struct */

/** Flat scope/symbol tables over one module's AST; reusable across analyze() calls (warm capacity persists). */
export type Semantic = {
    /* scope tree (SoA, index = ScopeId; 0 = none) */
    scopeParent: Uint32Array;
    scopeFlags: Uint16Array;
    scopeNode: Uint32Array; // owning NodeId
    scopeCount: number;

    /* symbols (SoA, index = SymbolId; 0 = none) */
    symScope: Uint32Array;
    symDecl: Uint32Array; // declaring Ident NodeId (name = its span)
    symFlags: Uint16Array;
    symCount: number;

    /** NodeId -> SymbolId for declaring AND resolved referencing Idents (0 = none/global) */
    nodeSymbol: Uint32Array;
    /** NodeId -> ScopeId for scope-owning nodes (0 = none) */
    nodeScope: Uint32Array;

    /** unresolved value-namespace references (globals like Math): Ident NodeIds */
    unresolved: number[];

    /* interning + binding maps (rebuilt per analyze) */
    names: Map<string, number>;
    bindings: Map<number, number>; // key(scope, ns, nameId) -> SymbolId
    symNameId: Uint32Array;
};

/** Allocate an empty {@link Semantic}; reuse it across analyze() calls to keep warm capacity. */
export function createSemantic(): Semantic {
    const cap = 1 << 8;
    return {
        scopeParent: new Uint32Array(cap),
        scopeFlags: new Uint16Array(cap),
        scopeNode: new Uint32Array(cap),
        scopeCount: 1,
        symScope: new Uint32Array(cap),
        symDecl: new Uint32Array(cap),
        symFlags: new Uint16Array(cap),
        symCount: 1,
        nodeSymbol: new Uint32Array(cap),
        nodeScope: new Uint32Array(cap),
        unresolved: [],
        names: new Map(),
        bindings: new Map(),
        symNameId: new Uint32Array(cap),
    };
}

/* ----------------------------------------------------------- module state */

let sem: Semantic;
let ast: Ast;
let scope = 0; // current ScopeId

const growU32 = (a: Uint32Array): Uint32Array => {
    const n = new Uint32Array(a.length * 2);
    n.set(a);
    return n;
};
const growU16 = (a: Uint16Array): Uint16Array => {
    const n = new Uint16Array(a.length * 2);
    n.set(a);
    return n;
};

function newScope(flags: number, node: NodeId): number {
    const id = sem.scopeCount;
    if (id >= sem.scopeParent.length) {
        sem.scopeParent = growU32(sem.scopeParent);
        sem.scopeFlags = growU16(sem.scopeFlags);
        sem.scopeNode = growU32(sem.scopeNode);
    }
    sem.scopeParent[id] = scope;
    sem.scopeFlags[id] = flags;
    sem.scopeNode[id] = node;
    sem.scopeCount = id + 1;
    if (node !== 0) sem.nodeScope[node] = id;
    return id;
}

const bindingKey = (scopeId: number, ns: number, nameId: number): number => (scopeId * 2 + ns) * 0x400000 + nameId;

// LIMIT: interning allocates one string per distinct occurrence via a Map;
// the hash-then-verify zero-alloc scheme (llm/notes/ast-format.md) is unused.
function internName(s: string): number {
    let id = sem.names.get(s);
    if (id === undefined) {
        id = sem.names.size + 1;
        sem.names.set(s, id);
    }
    return id;
}

function declare(identNode: NodeId, flags: number, ns: number, targetScope: number): number {
    const nameId = internName(text(ast, identNode));
    const key = bindingKey(targetScope, ns, nameId);
    const existing = sem.bindings.get(key);
    if (existing !== undefined) {
        // redeclaration (var/var, function overloads, etc.) — merge flags, keep first symbol
        sem.symFlags[existing] |= flags;
        sem.nodeSymbol[identNode] = existing;
        return existing;
    }
    const id = sem.symCount;
    if (id >= sem.symScope.length) {
        sem.symScope = growU32(sem.symScope);
        sem.symDecl = growU32(sem.symDecl);
        sem.symFlags = growU16(sem.symFlags);
        sem.symNameId = growU32(sem.symNameId);
    }
    sem.symScope[id] = targetScope;
    sem.symDecl[id] = identNode;
    sem.symFlags[id] = flags;
    sem.symNameId[id] = nameId;
    sem.symCount = id + 1;
    sem.bindings.set(key, id);
    sem.nodeSymbol[identNode] = id;
    return id;
}

/**
 * Declare ONE symbol reachable from both value and type namespaces (classes,
 * enums, type-only imports). Must stay a single symbol per declaration so
 * nodeSymbol, export binding, and rename all point at one identity — two
 * symbols for one ident splits exported-class renames.
 */
function declareDualNs(identNode: NodeId, flags: number, targetScope: number): number {
    const sym = declare(identNode, flags, NS_VALUE, targetScope);
    const nameId = internName(text(ast, identNode));
    const typeKey = bindingKey(targetScope, NS_TYPE, nameId);
    if (!sem.bindings.has(typeKey)) sem.bindings.set(typeKey, sym);
    return sym;
}

/** nearest function/module scope for var/function-decl hoisting */
function hoistTarget(): number {
    let s = scope;
    for (;;) {
        const f = sem.scopeFlags[s];
        if (f === SCOPE.FUNCTION || f === SCOPE.MODULE || f === SCOPE.NAMESPACE) return s;
        s = sem.scopeParent[s];
        if (s === 0) return scope;
    }
}

function resolveRef(identNode: NodeId, ns: number): void {
    const nameId = sem.names.get(text(ast, identNode));
    if (nameId !== undefined) {
        let s = scope;
        while (s !== 0) {
            const hit = sem.bindings.get(bindingKey(s, ns, nameId));
            if (hit !== undefined) {
                sem.nodeSymbol[identNode] = hit;
                return;
            }
            // enums/classes bind in both namespaces; fall through handled by dual declare
            s = sem.scopeParent[s];
        }
        if (ns === NS_TYPE) {
            // a type ref may legally name a class/enum declared value-side first
            s = scope;
            while (s !== 0) {
                const hit = sem.bindings.get(bindingKey(s, NS_VALUE, nameId));
                if (hit !== undefined && (sem.symFlags[hit] & (SYM.CLASS | SYM.ENUM | SYM.IMPORT | SYM.NAMESPACE)) !== 0) {
                    sem.nodeSymbol[identNode] = hit;
                    return;
                }
                s = sem.scopeParent[s];
            }
        }
    }
    if (ns === NS_VALUE) sem.unresolved.push(identNode);
}

/* ------------------------------------------------------------ entry point */

/** Return value of {@link analyze}. */
export type SemanticResult = { semantic: Semantic };

/**
 * Build scope and symbol tables for `program` into `out` (reset first).
 * Runs a declare pass (scopes + bindings) then a resolve pass that fills
 * `nodeSymbol` for every referencing Ident. LIMIT: no TDZ or redeclaration
 * diagnostics; labels are not tracked as symbols.
 */
export function analyze(out: Semantic, sourceAst: Ast, program: NodeId): SemanticResult {
    sem = out;
    ast = sourceAst;
    scope = 0;

    // reset (warm capacity persists)
    sem.scopeCount = 1;
    sem.symCount = 1;
    sem.unresolved.length = 0;
    sem.names.clear();
    sem.bindings.clear();
    if (sem.nodeSymbol.length < ast.nodeCount) {
        sem.nodeSymbol = new Uint32Array(ast.nodeCount * 2);
        sem.nodeScope = new Uint32Array(ast.nodeCount * 2);
    } else {
        sem.nodeSymbol.fill(0, 0, ast.nodeCount);
        sem.nodeScope.fill(0, 0, ast.nodeCount);
    }

    const moduleScope = newScope(SCOPE.MODULE, program);
    scope = moduleScope;
    declarePass(program);
    scope = moduleScope;
    resolvePass(program);
    return { semantic: sem };
}

/* ------------------------------------------------- pass 1: declarations */

/** declare all bindings introduced by a pattern (decl contexts) */
function declarePattern(node: NodeId, flags: number, targetScope: number): void {
    if (node === 0) return;
    switch (ast.type[node]) {
        case N.Ident:
            declare(node, flags, NS_VALUE, targetScope);
            return;
        case N.ArrayPattern: {
            const ref = A.ArrayPattern.elements(ast, node);
            for (let i = 0; i < listLen(ast, ref); i++) declarePattern(listAt(ast, ref, i), flags, targetScope);
            return;
        }
        case N.ObjectPattern: {
            const ref = A.ObjectPattern.props(ast, node);
            for (let i = 0; i < listLen(ast, ref); i++) declarePattern(listAt(ast, ref, i), flags, targetScope);
            return;
        }
        case N.Property:
            declarePattern(A.Property.value(ast, node), flags, targetScope);
            return;
        case N.AssignPattern:
            declarePattern(A.AssignPattern.left(ast, node), flags, targetScope);
            return; // .right is an expression — resolve pass handles it
        case N.RestElement:
            declarePattern(A.RestElement.arg(ast, node), flags, targetScope);
            return;
        case N.Param:
            declarePattern(A.Param.pattern(ast, node), flags, targetScope);
            return;
    }
}

// LIMIT: params bind into the function scope, shared with the body (spec gives params their own scope).
function declareParams(listRef: number): void {
    for (let i = 0; i < listLen(ast, listRef); i++) declarePattern(listAt(ast, listRef, i), SYM.PARAM, scope);
}

function declareTypeParams(node: NodeId): void {
    if (node === 0) return;
    const ref = A.TSTypeParams.params(ast, node);
    for (let i = 0; i < listLen(ast, ref); i++) {
        const tp = listAt(ast, ref, i);
        declare(A.TSTypeParam.name(ast, tp), SYM.TYPE, NS_TYPE, scope);
    }
}

function declareInScope(kind: number, node: NodeId, body: () => void): void {
    const prev = scope;
    scope = newScope(kind, node);
    body();
    scope = prev;
}

function declarePass(node: NodeId): void {
    if (node === 0) return;
    const t = ast.type[node];
    switch (t) {
        case N.VarDecl: {
            const kind = ast.flags[node] & VAR_KIND.KIND_MASK;
            const flags = kind === VAR_KIND.VAR ? SYM.VAR : kind === VAR_KIND.LET ? SYM.LET : SYM.CONST;
            const target = kind === VAR_KIND.VAR ? hoistTarget() : scope;
            const ref = A.VarDecl.declarators(ast, node);
            for (let i = 0; i < listLen(ast, ref); i++) {
                const d = listAt(ast, ref, i);
                declarePattern(A.VarDeclarator.id(ast, d), flags, target);
                declarePass(A.VarDeclarator.init(ast, d));
            }
            return;
        }
        case N.FuncDecl: {
            const id = A.FuncDecl.id(ast, node);
            if (id !== 0) declare(id, SYM.FUNCTION, NS_VALUE, hoistTarget());
            declareInScope(SCOPE.FUNCTION, node, () => {
                declareTypeParams(A.FuncDecl.typeParams(ast, node));
                declareParams(A.FuncDecl.params(ast, node));
                declarePass(A.FuncDecl.body(ast, node));
            });
            return;
        }
        case N.FuncExpr: {
            declareInScope(SCOPE.FUNCTION, node, () => {
                const id = A.FuncExpr.id(ast, node);
                if (id !== 0) declare(id, SYM.FUNCTION, NS_VALUE, scope);
                declareTypeParams(A.FuncExpr.typeParams(ast, node));
                declareParams(A.FuncExpr.params(ast, node));
                declarePass(A.FuncExpr.body(ast, node));
            });
            return;
        }
        case N.Arrow:
            declareInScope(SCOPE.FUNCTION, node, () => {
                declareTypeParams(A.Arrow.typeParams(ast, node));
                declareParams(A.Arrow.params(ast, node));
                declarePass(A.Arrow.body(ast, node));
            });
            return;
        case N.ClassDecl: {
            const id = A.ClassDecl.id(ast, node);
            if (id !== 0) declareDualNs(id, SYM.CLASS | SYM.TYPE, scope);
            declareInScope(SCOPE.CLASS, node, () => {
                declareTypeParams(A.ClassDecl.typeParams(ast, node));
                declareClassBody(A.ClassDecl.body(ast, node));
            });
            declarePass(A.ClassDecl.superClass(ast, node));
            return;
        }
        case N.ClassExpr:
            declareInScope(SCOPE.CLASS, node, () => {
                const id = A.ClassExpr.id(ast, node);
                if (id !== 0) declare(id, SYM.CLASS, NS_VALUE, scope);
                declareTypeParams(A.ClassExpr.typeParams(ast, node));
                declareClassBody(A.ClassExpr.body(ast, node));
            });
            declarePass(A.ClassExpr.superClass(ast, node));
            return;
        case N.Block:
        case N.StaticBlock:
            declareInScope(SCOPE.BLOCK, node, () => {
                const ref = A.Block.body(ast, node);
                for (let i = 0; i < listLen(ast, ref); i++) declarePass(listAt(ast, ref, i));
            });
            return;
        case N.For:
            declareInScope(SCOPE.FOR, node, () => {
                declarePass(A.For.init(ast, node));
                declarePass(A.For.test(ast, node));
                declarePass(A.For.update(ast, node));
                declarePass(A.For.body(ast, node));
            });
            return;
        case N.ForIn:
        case N.ForOf:
            declareInScope(SCOPE.FOR, node, () => {
                declarePass(A.ForOf.left(ast, node));
                declarePass(A.ForOf.right(ast, node));
                declarePass(A.ForOf.body(ast, node));
            });
            return;
        case N.Switch:
            declareInScope(SCOPE.SWITCH, node, () => {
                declarePass(A.Switch.disc(ast, node));
                const ref = A.Switch.cases(ast, node);
                for (let i = 0; i < listLen(ast, ref); i++) declarePass(listAt(ast, ref, i));
            });
            return;
        case N.CatchClause:
            declareInScope(SCOPE.CATCH, node, () => {
                declarePattern(A.CatchClause.param(ast, node), SYM.CATCH, scope);
                declarePass(A.CatchClause.body(ast, node));
            });
            return;
        case N.ImportDecl: {
            const ref = A.ImportDecl.specifiers(ast, node);
            for (let i = 0; i < listLen(ast, ref); i++) {
                const spec = listAt(ast, ref, i);
                const st = ast.type[spec];
                const local =
                    st === N.ImportSpec
                        ? A.ImportSpec.local(ast, spec)
                        : st === N.ImportDefaultSpec
                          ? A.ImportDefaultSpec.local(ast, spec)
                          : A.ImportNamespaceSpec.local(ast, spec);
                const typeOnly = (ast.flags[node] | ast.flags[spec]) & FL.TYPE_ONLY;
                if (typeOnly) declareDualNs(local, SYM.IMPORT | SYM.TYPE, scope);
                else declare(local, SYM.IMPORT, NS_VALUE, scope);
            }
            return;
        }
        case N.TSInterfaceDecl:
            declare(A.TSInterfaceDecl.id(ast, node), SYM.TYPE, NS_TYPE, scope);
            declareInScope(SCOPE.TYPE, node, () => {
                declareTypeParams(A.TSInterfaceDecl.typeParams(ast, node));
            });
            return;
        case N.TSTypeAliasDecl:
            declare(A.TSTypeAliasDecl.id(ast, node), SYM.TYPE, NS_TYPE, scope);
            declareInScope(SCOPE.TYPE, node, () => {
                declareTypeParams(A.TSTypeAliasDecl.typeParams(ast, node));
            });
            return;
        case N.TSEnumDecl: {
            const id = A.TSEnumDecl.id(ast, node);
            declareDualNs(id, SYM.ENUM | SYM.TYPE, scope);
            // LIMIT: enum members are not bound inside an enum body scope.
            const ref = A.TSEnumDecl.members(ast, node);
            for (let i = 0; i < listLen(ast, ref); i++) declarePass(A.TSEnumMember.init(ast, listAt(ast, ref, i)));
            return;
        }
        case N.TSModuleDecl: {
            const id = A.TSModuleDecl.id(ast, node);
            if (ast.type[id] === N.Ident) declare(id, SYM.NAMESPACE, NS_VALUE, scope);
            declareInScope(SCOPE.NAMESPACE, node, () => {
                const ref = A.TSModuleDecl.body(ast, node);
                for (let i = 0; i < listLen(ast, ref); i++) declarePass(listAt(ast, ref, i));
            });
            return;
        }
        // TS type positions declare nothing (type params handled at their owners)
        case N.TSTypeAnn:
        case N.TSTypeRef:
            return;
    }
    // default: recurse into children generically via schema tables
    genericChildren(node, declarePass);
}

function declareClassBody(listRef: number): void {
    for (let i = 0; i < listLen(ast, listRef); i++) {
        const m = listAt(ast, listRef, i);
        const mt = ast.type[m];
        if (mt === N.MethodDef) {
            if ((ast.flags[m] & FL.COMPUTED) !== 0) declarePass(A.MethodDef.key(ast, m));
            declarePass(A.MethodDef.value(ast, m));
        } else if (mt === N.PropDef) {
            if ((ast.flags[m] & FL.COMPUTED) !== 0) declarePass(A.PropDef.key(ast, m));
            declarePass(A.PropDef.value(ast, m));
        } else declarePass(m); // StaticBlock
    }
}

function genericChildren(node: NodeId, visit: (n: NodeId) => void): void {
    const t = ast.type[node];
    const count = FIELD_COUNT[t];
    if (count === 0) return;
    const listMask = FIELD_LIST_MASK[t];
    const inline = FIELD_INLINE[t];
    const base = ast.a[node];
    for (let i = 0; i < count; i++) {
        const v = inline ? (i === 0 ? ast.a[node] : ast.b[node]) : ast.extra[base + i];
        if (v === 0) continue;
        if (listMask & (1 << i)) {
            const len = ast.extra[v];
            for (let j = 0; j < len; j++) {
                const child = ast.extra[v + 1 + j];
                if (child !== 0) visit(child);
            }
        } else visit(v);
    }
}

/* ------------------------------------------------- pass 2: references */

/** enter the scope this node created in pass 1 (if any), run body, restore */
function inNodeScope(node: NodeId, body: () => void): void {
    const s = sem.nodeScope[node];
    if (s === 0) {
        body();
        return;
    }
    const prev = scope;
    scope = s;
    body();
    scope = prev;
}

function resolvePattern(node: NodeId): void {
    // patterns in decl positions: idents are declarations (already bound);
    // defaults + computed keys are expressions to resolve
    if (node === 0) return;
    switch (ast.type[node]) {
        case N.Ident:
            return;
        case N.ArrayPattern: {
            const ref = A.ArrayPattern.elements(ast, node);
            for (let i = 0; i < listLen(ast, ref); i++) resolvePattern(listAt(ast, ref, i));
            return;
        }
        case N.ObjectPattern: {
            const ref = A.ObjectPattern.props(ast, node);
            for (let i = 0; i < listLen(ast, ref); i++) resolvePattern(listAt(ast, ref, i));
            return;
        }
        case N.Property:
            if ((ast.flags[node] & FL.COMPUTED) !== 0) resolvePass(A.Property.key(ast, node));
            resolvePattern(A.Property.value(ast, node));
            return;
        case N.AssignPattern:
            resolvePattern(A.AssignPattern.left(ast, node));
            resolvePass(A.AssignPattern.right(ast, node));
            return;
        case N.RestElement:
            resolvePattern(A.RestElement.arg(ast, node));
            return;
        case N.Param:
            resolvePattern(A.Param.pattern(ast, node));
            resolveType(A.Param.typeAnn(ast, node));
            resolvePass(A.Param.init(ast, node));
            return;
    }
}

function resolveParams(listRef: number): void {
    for (let i = 0; i < listLen(ast, listRef); i++) {
        const p = listAt(ast, listRef, i);
        if (ast.type[p] === N.RestElement) {
            resolvePattern(A.RestElement.arg(ast, p));
            resolveType(A.RestElement.typeAnn(ast, p));
        } else resolvePattern(p);
    }
}

/** resolve a TS type subtree (type namespace for TSTypeRef heads, value ns for typeof) */
function resolveType(node: NodeId): void {
    if (node === 0) return;
    const t = ast.type[node];
    switch (t) {
        case N.TSTypeRef: {
            const name = A.TSTypeRef.name(ast, node);
            resolveEntityName(name, NS_TYPE);
            resolveType(A.TSTypeRef.typeArgs(ast, node));
            return;
        }
        case N.TSTypeQuery: // typeof X — value namespace
            resolveEntityName(A.TSTypeQuery.exprName(ast, node), NS_VALUE);
            resolveType(A.TSTypeQuery.typeArgs(ast, node));
            return;
        case N.TSMapped:
            inNodeScope(node, () => {
                // LIMIT: mapped-type param not scoped separately; resolve constituents
                genericChildren(node, resolveType);
            });
            return;
        case N.TSPropSig:
            if ((ast.flags[node] & FL.COMPUTED) !== 0) resolvePass(A.TSPropSig.key(ast, node));
            resolveType(A.TSPropSig.typeAnn(ast, node));
            return;
        case N.Ident:
            return; // bare idents inside type structures we don't classify (labels etc.)
    }
    genericChildren(node, resolveType);
}

/** qualified name head resolves; the rest are member-ish */
function resolveEntityName(node: NodeId, ns: number): void {
    if (node === 0) return;
    if (ast.type[node] === N.Ident) resolveRef(node, ns);
    else if (ast.type[node] === N.TSQualifiedName) resolveEntityName(A.TSQualifiedName.left(ast, node), ns);
}

function resolvePass(node: NodeId): void {
    if (node === 0) return;
    const t = ast.type[node];
    switch (t) {
        case N.Ident:
            resolveRef(node, NS_VALUE);
            return;
        case N.Member:
            resolvePass(A.Member.object(ast, node));
            if ((ast.flags[node] & FL.COMPUTED) !== 0) resolvePass(A.Member.property(ast, node));
            return;
        case N.Property: // object literal
            if ((ast.flags[node] & FL.COMPUTED) !== 0) resolvePass(A.Property.key(ast, node));
            // shorthand `{ a }`: key === value node; resolve once
            resolvePass(A.Property.value(ast, node));
            return;
        case N.MethodDef:
        case N.PropDef:
            if ((ast.flags[node] & FL.COMPUTED) !== 0) resolvePass(A.MethodDef.key(ast, node));
            resolvePass(t === N.MethodDef ? A.MethodDef.value(ast, node) : A.PropDef.value(ast, node));
            if (t === N.PropDef) resolveType(A.PropDef.typeAnn(ast, node));
            return;
        case N.VarDecl: {
            const ref = A.VarDecl.declarators(ast, node);
            for (let i = 0; i < listLen(ast, ref); i++) {
                const d = listAt(ast, ref, i);
                resolvePattern(A.VarDeclarator.id(ast, d));
                resolveType(A.VarDeclarator.typeAnn(ast, d));
                resolvePass(A.VarDeclarator.init(ast, d));
            }
            return;
        }
        case N.FuncDecl:
        case N.FuncExpr:
            inNodeScope(node, () => {
                resolveParams(A.FuncDecl.params(ast, node));
                resolveType(A.FuncDecl.returnType(ast, node));
                resolvePass(A.FuncDecl.body(ast, node));
            });
            return;
        case N.Arrow:
            inNodeScope(node, () => {
                resolveParams(A.Arrow.params(ast, node));
                resolveType(A.Arrow.returnType(ast, node));
                resolvePass(A.Arrow.body(ast, node));
            });
            return;
        case N.ClassDecl:
        case N.ClassExpr: {
            resolvePass(A.ClassDecl.superClass(ast, node));
            inNodeScope(node, () => {
                const impls = A.ClassDecl.implements(ast, node);
                for (let i = 0; i < listLen(ast, impls); i++) {
                    const h = listAt(ast, impls, i);
                    resolveEntityName(A.TSHeritage.expr(ast, h), NS_TYPE);
                    resolveType(A.TSHeritage.typeArgs(ast, h));
                }
                resolveType(A.ClassDecl.superTypeArgs(ast, node));
                const body = A.ClassDecl.body(ast, node);
                for (let i = 0; i < listLen(ast, body); i++) resolvePass(listAt(ast, body, i));
            });
            return;
        }
        case N.Block:
        case N.StaticBlock:
        case N.For:
        case N.ForIn:
        case N.ForOf:
        case N.Switch:
        case N.CatchClause:
        case N.TSModuleDecl:
            inNodeScope(node, () => {
                if (t === N.CatchClause) {
                    resolvePattern(A.CatchClause.param(ast, node));
                    resolvePass(A.CatchClause.body(ast, node));
                } else if (t === N.ForIn || t === N.ForOf) {
                    const left = A.ForOf.left(ast, node);
                    if (ast.type[left] === N.VarDecl) resolvePass(left);
                    else resolvePass(left); // assignment-target form: plain expression refs
                    resolvePass(A.ForOf.right(ast, node));
                    resolvePass(A.ForOf.body(ast, node));
                } else genericChildren(node, resolvePass);
            });
            return;
        case N.ImportDecl:
            return; // no references inside
        case N.ExportNamed: {
            const decl = A.ExportNamed.decl(ast, node);
            if (decl !== 0) {
                resolvePass(decl);
                return;
            }
            if (A.ExportNamed.source(ast, node) !== 0) return; // re-export: no local refs
            const specs = A.ExportNamed.specifiers(ast, node);
            for (let i = 0; i < listLen(ast, specs); i++) {
                const s = listAt(ast, specs, i);
                const local = A.ExportSpec.local(ast, s);
                if (ast.type[local] === N.Ident) resolveRef(local, NS_VALUE);
            }
            return;
        }
        case N.Labeled: // label ident is not a symbol ref
            resolvePass(A.Labeled.body(ast, node));
            return;
        case N.Break:
        case N.Continue:
            return; // label refs are not symbols
        case N.TSInterfaceDecl:
            inNodeScope(node, () => {
                const ext = A.TSInterfaceDecl.extends(ast, node);
                for (let i = 0; i < listLen(ast, ext); i++) {
                    const h = listAt(ast, ext, i);
                    resolveEntityName(A.TSHeritage.expr(ast, h), NS_TYPE);
                    resolveType(A.TSHeritage.typeArgs(ast, h));
                }
                const body = A.TSInterfaceDecl.body(ast, node);
                for (let i = 0; i < listLen(ast, body); i++) resolveType(listAt(ast, body, i));
            });
            return;
        case N.TSTypeAliasDecl:
            inNodeScope(node, () => {
                resolveType(A.TSTypeAliasDecl.typeAnn(ast, node));
            });
            return;
        case N.TSEnumDecl: {
            const ref = A.TSEnumDecl.members(ast, node);
            for (let i = 0; i < listLen(ast, ref); i++) resolvePass(A.TSEnumMember.init(ast, listAt(ast, ref, i)));
            return;
        }
        case N.TSAs:
        case N.TSSatisfies:
            resolvePass(A.TSAs.expr(ast, node));
            resolveType(A.TSAs.typeAnn(ast, node));
            return;
        case N.TSTypeAnn:
            resolveType(node);
            return;
        case N.Call:
        case N.New:
            resolvePass(A.Call.callee(ast, node));
            resolveType(A.Call.typeArgs(ast, node));
            {
                const args = A.Call.args(ast, node);
                for (let i = 0; i < listLen(ast, args); i++) resolvePass(listAt(ast, args, i));
            }
            return;
    }
    genericChildren(node, resolvePass);
}

/* ------------------------------------------------------------- accessors */

/** Declared name of a symbol (the text of its declaring Ident). */
export const symbolName = (semantic: Semantic, sourceAst: Ast, symbolId: number): string =>
    text(sourceAst, semantic.symDecl[symbolId]);

/** Resolved symbol id for an Ident node (0 = unresolved/global). */
export const symbolOf = (semantic: Semantic, node: NodeId): number => semantic.nodeSymbol[node];
