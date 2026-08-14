/** Scope/symbol/reference tables. Design notes: llm/notes/oxc-internals.md §semantic
 *
 * SoA architecture (compilecat convergence — load-bearing): scope/symbol columns
 * are typed arrays indexed by ScopeId/SymbolId; nodeSymbol/nodeScope columns are
 * sized by nodeCount and indexed by node.id. Only the tree-walk reads node
 * OBJECTS now (was flat (ast,id)); the tables are unchanged in shape. symDecl and
 * scopeNode hold the declaring/owning Node (so names read straight off `.name`).
 */

import { enumeration } from '../util/enumeration';
import {
    type Node,
    N,
    isIdentifier,
    walkChildren,
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
    scopeNode: (Node | null)[]; // owning Node
    scopeCount: number;

    /* symbols (SoA, index = SymbolId; 0 = none) */
    symScope: Uint32Array;
    symDecl: (Node | null)[]; // declaring Ident Node (name = its .name)
    symFlags: Uint16Array;
    symCount: number;

    /** node.id -> SymbolId for declaring AND resolved referencing Idents (0 = none/global) */
    nodeSymbol: Uint32Array;
    /** node.id -> ScopeId for scope-owning nodes (0 = none) */
    nodeScope: Uint32Array;

    /** unresolved value-namespace references (globals like Math): Ident Nodes */
    unresolved: Node[];

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
        scopeNode: new Array(cap).fill(null),
        scopeCount: 1,
        symScope: new Uint32Array(cap),
        symDecl: new Array(cap).fill(null),
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

function newScope(flags: number, node: Node | null): number {
    const id = sem.scopeCount;
    if (id >= sem.scopeParent.length) {
        sem.scopeParent = growU32(sem.scopeParent);
        sem.scopeFlags = growU16(sem.scopeFlags);
    }
    sem.scopeParent[id] = scope;
    sem.scopeFlags[id] = flags;
    sem.scopeNode[id] = node;
    sem.scopeCount = id + 1;
    if (node !== null) sem.nodeScope[node.id] = id;
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

function declare(identNode: Node, flags: number, ns: number, targetScope: number): number {
    const nameId = internName(identNode.name);
    const key = bindingKey(targetScope, ns, nameId);
    const existing = sem.bindings.get(key);
    if (existing !== undefined) {
        // redeclaration (var/var, function overloads, etc.) — merge flags, keep first symbol
        sem.symFlags[existing] |= flags;
        sem.nodeSymbol[identNode.id] = existing;
        return existing;
    }
    const id = sem.symCount;
    if (id >= sem.symScope.length) {
        sem.symScope = growU32(sem.symScope);
        sem.symFlags = growU16(sem.symFlags);
        sem.symNameId = growU32(sem.symNameId);
    }
    sem.symScope[id] = targetScope;
    sem.symDecl[id] = identNode;
    sem.symFlags[id] = flags;
    sem.symNameId[id] = nameId;
    sem.symCount = id + 1;
    sem.bindings.set(key, id);
    sem.nodeSymbol[identNode.id] = id;
    return id;
}

/**
 * Declare ONE symbol reachable from both value and type namespaces (classes,
 * enums, type-only imports). Must stay a single symbol per declaration so
 * nodeSymbol, export binding, and rename all point at one identity.
 */
function declareDualNs(identNode: Node, flags: number, targetScope: number): number {
    const sym = declare(identNode, flags, NS_VALUE, targetScope);
    const nameId = internName(identNode.name);
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

function resolveRef(identNode: Node, ns: number): void {
    const nameId = sem.names.get(identNode.name);
    if (nameId !== undefined) {
        let s = scope;
        while (s !== 0) {
            const hit = sem.bindings.get(bindingKey(s, ns, nameId));
            if (hit !== undefined) {
                sem.nodeSymbol[identNode.id] = hit;
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
                    sem.nodeSymbol[identNode.id] = hit;
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
 * `nodeSymbol` for every referencing Ident. `nodeCount` sizes the id-indexed
 * columns. LIMIT: no TDZ or redeclaration diagnostics; labels are not tracked.
 */
export function analyze(out: Semantic, program: Node, nodeCount: number): SemanticResult {
    sem = out;
    scope = 0;

    // reset (warm capacity persists)
    sem.scopeCount = 1;
    sem.symCount = 1;
    sem.unresolved.length = 0;
    sem.names.clear();
    sem.bindings.clear();
    if (sem.nodeSymbol.length < nodeCount) {
        sem.nodeSymbol = new Uint32Array(nodeCount * 2);
        sem.nodeScope = new Uint32Array(nodeCount * 2);
    } else {
        sem.nodeSymbol.fill(0, 0, nodeCount);
        sem.nodeScope.fill(0, 0, nodeCount);
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
function declarePattern(node: Node | null, flags: number, targetScope: number): void {
    if (node === null) return;
    switch (node.type) {
        case N.BindingIdentifier: // the only declaring role
            declare(node, flags, NS_VALUE, targetScope);
            return;
        case N.ArrayPattern:
            for (const el of node.data.elements) declarePattern(el, flags, targetScope);
            return;
        case N.ObjectPattern:
            for (const p of node.data.properties) declarePattern(p, flags, targetScope);
            return;
        case N.ObjectProperty:
            declarePattern(node.data.value, flags, targetScope);
            return;
        case N.AssignmentPattern:
            declarePattern(node.data.left, flags, targetScope);
            return; // .right is an expression — resolve pass handles it
        case N.RestElement:
            declarePattern(node.data.argument, flags, targetScope);
            return;
        case N.FormalParameter:
            declarePattern(node.data.pattern, flags, targetScope);
            return;
    }
}

// LIMIT: params bind into the function scope, shared with the body (spec gives params their own scope).
function declareParams(list: Node[]): void {
    for (const p of list) declarePattern(p, SYM.PARAM, scope);
}

function declareTypeParams(node: Node | null): void {
    if (node === null || node.type !== N.TSTypeParameterDeclaration) return;
    for (const tp of node.data.params) {
        if (tp.type === N.TSTypeParameter) declare(tp.data.name, SYM.TYPE, NS_TYPE, scope);
    }
}

function declareInScope(kind: number, node: Node, body: () => void): void {
    const prev = scope;
    scope = newScope(kind, node);
    body();
    scope = prev;
}

function declarePass(node: Node | null): void {
    if (node === null) return;
    switch (node.type) {
        case N.VariableDeclaration: {
            const kind = node.data.kind;
            const flags = kind === 'var' ? SYM.VAR : kind === 'let' ? SYM.LET : SYM.CONST;
            const target = kind === 'var' ? hoistTarget() : scope;
            for (const d of node.data.declarations) {
                if (d.type !== N.VariableDeclarator) continue;
                declarePattern(d.data.id, flags, target);
                declarePass(d.data.init);
            }
            return;
        }
        case N.FunctionDeclaration: {
            const id = node.data.id;
            if (id !== null) declare(id, SYM.FUNCTION, NS_VALUE, hoistTarget());
            declareInScope(SCOPE.FUNCTION, node, () => {
                declareTypeParams(node.data.typeParameters);
                declareParams(node.data.params);
                declarePass(node.data.body);
            });
            return;
        }
        case N.FunctionExpression: {
            declareInScope(SCOPE.FUNCTION, node, () => {
                const id = node.data.id;
                if (id !== null) declare(id, SYM.FUNCTION, NS_VALUE, scope);
                declareTypeParams(node.data.typeParameters);
                declareParams(node.data.params);
                declarePass(node.data.body);
            });
            return;
        }
        case N.ArrowFunctionExpression:
            declareInScope(SCOPE.FUNCTION, node, () => {
                declareTypeParams(node.data.typeParameters);
                declareParams(node.data.params);
                declarePass(node.data.body);
            });
            return;
        case N.ClassDeclaration: {
            const id = node.data.id;
            if (id !== null) declareDualNs(id, SYM.CLASS | SYM.TYPE, scope);
            declareInScope(SCOPE.CLASS, node, () => {
                declareTypeParams(node.data.typeParameters);
                declareClassBody(node.data.body);
            });
            declarePass(node.data.superClass);
            return;
        }
        case N.ClassExpression:
            declareInScope(SCOPE.CLASS, node, () => {
                const id = node.data.id;
                if (id !== null) declare(id, SYM.CLASS, NS_VALUE, scope);
                declareTypeParams(node.data.typeParameters);
                declareClassBody(node.data.body);
            });
            declarePass(node.data.superClass);
            return;
        case N.BlockStatement:
        case N.StaticBlock:
            declareInScope(SCOPE.BLOCK, node, () => {
                for (const s of node.data.body) declarePass(s);
            });
            return;
        case N.ForStatement:
            declareInScope(SCOPE.FOR, node, () => {
                declarePass(node.data.init);
                declarePass(node.data.test);
                declarePass(node.data.update);
                declarePass(node.data.body);
            });
            return;
        case N.ForInStatement:
        case N.ForOfStatement:
            declareInScope(SCOPE.FOR, node, () => {
                declarePass(node.data.left);
                declarePass(node.data.right);
                declarePass(node.data.body);
            });
            return;
        case N.SwitchStatement:
            declareInScope(SCOPE.SWITCH, node, () => {
                declarePass(node.data.discriminant);
                for (const c of node.data.cases) declarePass(c);
            });
            return;
        case N.CatchClause:
            declareInScope(SCOPE.CATCH, node, () => {
                declarePattern(node.data.param, SYM.CATCH, scope);
                declarePass(node.data.body);
            });
            return;
        case N.ImportDeclaration: {
            for (const spec of node.data.specifiers) {
                let local: Node;
                if (spec.type === N.ImportSpecifier) local = spec.data.local;
                else if (spec.type === N.ImportDefaultSpecifier) local = spec.data.local;
                else if (spec.type === N.ImportNamespaceSpecifier) local = spec.data.local;
                else continue;
                const specTypeOnly = spec.type === N.ImportSpecifier && spec.data.importKind === 'type';
                const typeOnly = node.data.importKind === 'type' || specTypeOnly;
                if (typeOnly) declareDualNs(local, SYM.IMPORT | SYM.TYPE, scope);
                else declare(local, SYM.IMPORT, NS_VALUE, scope);
            }
            return;
        }
        case N.TSInterfaceDeclaration:
            declare(node.data.id, SYM.TYPE, NS_TYPE, scope);
            declareInScope(SCOPE.TYPE, node, () => {
                declareTypeParams(node.data.typeParameters);
            });
            return;
        case N.TSTypeAliasDeclaration:
            declare(node.data.id, SYM.TYPE, NS_TYPE, scope);
            declareInScope(SCOPE.TYPE, node, () => {
                declareTypeParams(node.data.typeParameters);
            });
            return;
        case N.TSEnumDeclaration: {
            declareDualNs(node.data.id, SYM.ENUM | SYM.TYPE, scope);
            // LIMIT: enum members are not bound inside an enum body scope.
            for (const member of node.data.members) {
                if (member.type === N.TSEnumMember) declarePass(member.data.initializer);
            }
            return;
        }
        case N.TSModuleDeclaration: {
            const id = node.data.id;
            if (id.type === N.BindingIdentifier) declare(id, SYM.NAMESPACE, NS_VALUE, scope);
            declareInScope(SCOPE.NAMESPACE, node, () => {
                for (const s of node.data.body) declarePass(s);
            });
            return;
        }
        // TS type positions declare nothing (type params handled at their owners)
        case N.TSTypeAnnotation:
        case N.TSTypeReference:
            return;
    }
    // default: recurse into children generically via schema walk
    walkChildren(node, declarePass);
}

function declareClassBody(list: Node[]): void {
    for (const m of list) {
        if (m.type === N.MethodDefinition) {
            if (m.data.computed) declarePass(m.data.key);
            declarePass(m.data.value);
        } else if (m.type === N.PropertyDefinition) {
            if (m.data.computed) declarePass(m.data.key);
            declarePass(m.data.value);
        } else declarePass(m); // StaticBlock
    }
}

/* ------------------------------------------------- pass 2: references */

/** enter the scope this node created in pass 1 (if any), run body, restore */
function inNodeScope(node: Node, body: () => void): void {
    const s = sem.nodeScope[node.id];
    if (s === 0) {
        body();
        return;
    }
    const prev = scope;
    scope = s;
    body();
    scope = prev;
}

function resolvePattern(node: Node | null): void {
    // patterns in decl positions: idents are declarations (already bound);
    // defaults + computed keys are expressions to resolve
    if (node === null) return;
    switch (node.type) {
        case N.BindingIdentifier: // a declaration — already bound, nothing to resolve
            return;
        case N.ArrayPattern:
            for (const el of node.data.elements) resolvePattern(el);
            return;
        case N.ObjectPattern:
            for (const p of node.data.properties) resolvePattern(p);
            return;
        case N.ObjectProperty:
            if (node.data.computed) resolvePass(node.data.key);
            resolvePattern(node.data.value);
            return;
        case N.AssignmentPattern:
            resolvePattern(node.data.left);
            resolvePass(node.data.right);
            return;
        case N.RestElement:
            resolvePattern(node.data.argument);
            return;
        case N.FormalParameter:
            resolvePattern(node.data.pattern);
            resolveType(node.data.typeAnnotation);
            resolvePass(node.data.init);
            return;
    }
}

function resolveParams(list: Node[]): void {
    for (const p of list) {
        if (p.type === N.RestElement) {
            resolvePattern(p.data.argument);
            resolveType(p.data.typeAnnotation);
        } else resolvePattern(p);
    }
}

/** resolve a TS type subtree (type namespace for TSTypeRef heads, value ns for typeof) */
function resolveType(node: Node | null): void {
    if (node === null) return;
    switch (node.type) {
        case N.TSTypeReference:
            resolveEntityName(node.data.typeName, NS_TYPE);
            resolveType(node.data.typeArguments);
            return;
        case N.TSTypeQuery: // typeof X — value namespace
            resolveEntityName(node.data.exprName, NS_VALUE);
            resolveType(node.data.typeArguments);
            return;
        case N.TSMappedType:
            inNodeScope(node, () => {
                // LIMIT: mapped-type param not scoped separately; resolve constituents
                walkChildren(node, resolveType);
            });
            return;
        case N.TSPropertySignature:
            if (node.data.computed) resolvePass(node.data.key);
            resolveType(node.data.typeAnnotation);
            return;
    }
    // any bare identifier role reached generically inside a type structure is a
    // leaf we don't resolve here (type-ref heads go through resolveEntityName;
    // IdentifierName/LabelIdentifier never resolve).
    if (isIdentifier(node.type)) return;
    walkChildren(node, resolveType);
}

/** qualified name head resolves; the rest are member-ish */
function resolveEntityName(node: Node | null, ns: number): void {
    if (node === null) return;
    // the head of an entity name is an IdentifierReference (type-ref typeName /
    // typeof exprName); the qualified `.right` spine is IdentifierName (skipped).
    if (node.type === N.IdentifierReference) resolveRef(node, ns);
    else if (node.type === N.TSQualifiedName) resolveEntityName(node.data.left, ns);
}

function resolvePass(node: Node | null): void {
    if (node === null) return;
    switch (node.type) {
        case N.IdentifierReference: // every expression-position name resolves (value ns)
            resolveRef(node, NS_VALUE);
            return;
        case N.StaticMemberExpression:
        case N.PrivateFieldExpression:
            // property/field is an IdentifierName / PrivateIdentifier — never resolves
            resolvePass(node.data.object);
            return;
        case N.ComputedMemberExpression:
            resolvePass(node.data.object);
            resolvePass(node.data.expression);
            return;
        case N.ChainExpression: // transparent wrapper — resolve the wrapped chain
            resolvePass(node.data.expression);
            return;
        case N.ObjectProperty: // object literal
            if (node.data.computed) resolvePass(node.data.key); // key is otherwise an IdentifierName (never resolves)
            // shorthand `{ a }`: value is a distinct IdentifierReference — resolve it
            resolvePass(node.data.value);
            return;
        case N.MethodDefinition:
            if (node.data.computed) resolvePass(node.data.key);
            resolvePass(node.data.value);
            return;
        case N.PropertyDefinition:
            if (node.data.computed) resolvePass(node.data.key);
            resolvePass(node.data.value);
            resolveType(node.data.typeAnnotation);
            return;
        case N.VariableDeclaration: {
            for (const d of node.data.declarations) {
                if (d.type !== N.VariableDeclarator) continue;
                resolvePattern(d.data.id);
                resolveType(d.data.typeAnnotation);
                resolvePass(d.data.init);
            }
            return;
        }
        case N.FunctionDeclaration:
        case N.FunctionExpression:
            inNodeScope(node, () => {
                resolveParams(node.data.params);
                resolveType(node.data.returnType);
                resolvePass(node.data.body);
            });
            return;
        case N.ArrowFunctionExpression:
            inNodeScope(node, () => {
                resolveParams(node.data.params);
                resolveType(node.data.returnType);
                resolvePass(node.data.body);
            });
            return;
        case N.ClassDeclaration:
        case N.ClassExpression: {
            resolvePass(node.data.superClass);
            inNodeScope(node, () => {
                for (const h of node.data.implements) {
                    if (h.type !== N.TSClassImplements) continue;
                    resolveEntityName(h.data.expression, NS_TYPE);
                    resolveType(h.data.typeArguments);
                }
                resolveType(node.data.superTypeArguments);
                for (const m of node.data.body) resolvePass(m);
            });
            return;
        }
        case N.BlockStatement:
        case N.StaticBlock:
        case N.ForStatement:
        case N.SwitchStatement:
        case N.TSModuleDeclaration:
            inNodeScope(node, () => {
                walkChildren(node, resolvePass);
            });
            return;
        case N.CatchClause:
            inNodeScope(node, () => {
                resolvePattern(node.data.param);
                resolvePass(node.data.body);
            });
            return;
        case N.ForInStatement:
        case N.ForOfStatement:
            inNodeScope(node, () => {
                resolvePass(node.data.left);
                resolvePass(node.data.right);
                resolvePass(node.data.body);
            });
            return;
        case N.ImportDeclaration:
            return; // no references inside
        case N.ExportNamedDeclaration: {
            const decl = node.data.declaration;
            if (decl !== null) {
                resolvePass(decl);
                return;
            }
            if (node.data.source !== null) return; // re-export: no local refs
            for (const s of node.data.specifiers) {
                if (s.type !== N.ExportSpecifier) continue;
                const local = s.data.local;
                if (local.type === N.IdentifierReference) resolveRef(local, NS_VALUE);
            }
            return;
        }
        case N.LabeledStatement: // label ident is not a symbol ref
            resolvePass(node.data.body);
            return;
        case N.BreakStatement:
        case N.ContinueStatement:
            return; // label refs are not symbols
        case N.TSInterfaceDeclaration:
            inNodeScope(node, () => {
                for (const h of node.data.extends) {
                    if (h.type !== N.TSInterfaceHeritage) continue;
                    resolveEntityName(h.data.expression, NS_TYPE);
                    resolveType(h.data.typeArguments);
                }
                for (const m of node.data.body) resolveType(m);
            });
            return;
        case N.TSTypeAliasDeclaration:
            inNodeScope(node, () => {
                resolveType(node.data.typeAnnotation);
            });
            return;
        case N.TSEnumDeclaration:
            for (const member of node.data.members) {
                if (member.type === N.TSEnumMember) resolvePass(member.data.initializer);
            }
            return;
        case N.TSAsExpression:
        case N.TSSatisfiesExpression:
            resolvePass(node.data.expression);
            resolveType(node.data.typeAnnotation);
            return;
        case N.TSTypeAnnotation:
            resolveType(node);
            return;
        case N.CallExpression:
        case N.NewExpression:
            resolvePass(node.data.callee);
            resolveType(node.data.typeArguments);
            for (const a of node.data.arguments) resolvePass(a);
            return;
    }
    walkChildren(node, resolvePass);
}

/* ------------------------------------------------------------- accessors */

/** Declared name of a symbol (the text of its declaring Ident). */
export const symbolName = (semantic: Semantic, symbolId: number): string =>
    semantic.symDecl[symbolId]?.name ?? '';

/** Resolved symbol id for an Ident node (0 = unresolved/global). */
export const symbolOf = (semantic: Semantic, node: Node): number => semantic.nodeSymbol[node.id];
