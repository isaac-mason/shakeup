import { enumeration } from '../util/enumeration';
import {
    type Node,
    N,
    isIdentifier,
    walkChildren,
} from '../ast.ts';

/** Scope kinds, stored in `ScopeRec.flags`. */
export const SCOPE = enumeration('MODULE', 'FUNCTION', 'BLOCK', 'CLASS', 'CATCH', 'FOR', 'SWITCH', 'TYPE', 'ENUM', 'NAMESPACE');

/** Symbol-kind bit flags, OR-combined in `SymbolRec.flags` (a dual-namespace symbol carries both a value and a type bit). */
export const SYM = {
    VAR: 1 << 0,
    LET: 1 << 1,
    CONST: 1 << 2,
    FUNCTION: 1 << 3,
    CLASS: 1 << 4,
    PARAM: 1 << 5,
    IMPORT: 1 << 6,
    CATCH: 1 << 7,
    TYPE: 1 << 8,
    ENUM: 1 << 9,
    NAMESPACE: 1 << 10,
} as const;

/** namespace selector for binding/resolution */
const NS_VALUE = 0;
const NS_TYPE = 1;

/** One lexical scope. `parent` is a scope id (0 = none); `node` is the scope-owning AST node. */
export type ScopeRec = { parent: number; flags: number; node: Node | null };

/** One binding. `scope` is the owning scope id; `decl` is the declaring Ident; `nameId` is an interned name. */
export type SymbolRec = { scope: number; decl: Node | null; flags: number; nameId: number };

/**
 * Scope/symbol tables over one module's AST; reusable across analyze() calls (warm
 * capacity persists). Scopes and symbols are plain records held in arrays indexed by a
 * dense integer id (index 0 is a null sentinel); node→scope/symbol association is a Map,
 * so there is no fixed-cap indexing and no absolute-id math to overflow.
 */
export type Semantic = {
    scopes: ScopeRec[];
    symbols: SymbolRec[];

    nodeSym: Map<Node, number>;
    nodeScope: Map<Node, number>;

    unresolved: Node[];

    names: Map<string, number>;
    bindings: Map<number, number>;
};

/** Allocate an empty {@link Semantic}; reuse it across analyze() calls to keep warm capacity. */
export function createSemantic(): Semantic {
    return {
        scopes: [{ parent: 0, flags: 0, node: null }],
        symbols: [{ scope: 0, decl: null, flags: 0, nameId: 0 }],
        nodeSym: new Map(),
        nodeScope: new Map(),
        unresolved: [],
        names: new Map(),
        bindings: new Map(),
    };
}

/**
 * Per-analyze() traversal state, threaded as the first arg to every pass function so a
 * run holds no module-global state (reentrant). `sem` is the table being filled; `scope`
 * is the current-scope cursor, saved/restored as the walk descends and ascends.
 */
type AnalyseState = { sem: Semantic; scope: number };

function newScope(state: AnalyseState, flags: number, node: Node | null): number {
    const id = state.sem.scopes.length;
    state.sem.scopes.push({ parent: state.scope, flags, node });
    if (node !== null) state.sem.nodeScope.set(node, id);
    return id;
}

const bindingKey = (scopeId: number, ns: number, nameId: number): number => (scopeId * 2 + ns) * 0x400000 + nameId;

function internName(state: AnalyseState, s: string): number {
    let id = state.sem.names.get(s);
    if (id === undefined) {
        id = state.sem.names.size + 1;
        state.sem.names.set(s, id);
    }
    return id;
}

function declare(state: AnalyseState, identNode: Node, flags: number, ns: number, targetScope: number): number {
    const nameId = internName(state, identNode.name);
    const key = bindingKey(targetScope, ns, nameId);
    const existing = state.sem.bindings.get(key);
    if (existing !== undefined) {
        state.sem.symbols[existing].flags |= flags;
        state.sem.nodeSym.set(identNode, existing);
        return existing;
    }
    const id = state.sem.symbols.length;
    state.sem.symbols.push({ scope: targetScope, decl: identNode, flags, nameId });
    state.sem.bindings.set(key, id);
    state.sem.nodeSym.set(identNode, id);
    return id;
}

function declareDualNs(state: AnalyseState, identNode: Node, flags: number, targetScope: number): number {
    const sym = declare(state, identNode, flags, NS_VALUE, targetScope);
    const nameId = internName(state, identNode.name);
    const typeKey = bindingKey(targetScope, NS_TYPE, nameId);
    if (!state.sem.bindings.has(typeKey)) state.sem.bindings.set(typeKey, sym);
    return sym;
}

/** nearest function/module scope for var/function-decl hoisting */
function hoistTarget(state: AnalyseState): number {
    let s = state.scope;
    for (;;) {
        const f = state.sem.scopes[s].flags;
        if (f === SCOPE.FUNCTION || f === SCOPE.MODULE || f === SCOPE.NAMESPACE) return s;
        s = state.sem.scopes[s].parent;
        if (s === 0) return state.scope;
    }
}

function resolveRef(state: AnalyseState, identNode: Node, ns: number): void {
    const nameId = state.sem.names.get(identNode.name);
    if (nameId !== undefined) {
        let s = state.scope;
        while (s !== 0) {
            const hit = state.sem.bindings.get(bindingKey(s, ns, nameId));
            if (hit !== undefined) {
                state.sem.nodeSym.set(identNode, hit);
                return;
            }
            s = state.sem.scopes[s].parent;
        }
        if (ns === NS_TYPE) {
            s = state.scope;
            while (s !== 0) {
                const hit = state.sem.bindings.get(bindingKey(s, NS_VALUE, nameId));
                if (hit !== undefined && (state.sem.symbols[hit].flags & (SYM.CLASS | SYM.ENUM | SYM.IMPORT | SYM.NAMESPACE)) !== 0) {
                    state.sem.nodeSym.set(identNode, hit);
                    return;
                }
                s = state.sem.scopes[s].parent;
            }
        }
    }
    if (ns === NS_VALUE) state.sem.unresolved.push(identNode);
}

/**
 * Build scope and symbol tables for `program` into `out` (reset first, mutated in place).
 * Runs a declare pass (scopes + bindings) then a resolve pass that fills
 * `nodeSym` for every referencing Ident. LIMIT: no TDZ or redeclaration
 * diagnostics; labels are not tracked.
 */
export function analyze(out: Semantic, program: Node): void {
    out.scopes.length = 1;
    out.symbols.length = 1;
    out.unresolved.length = 0;
    out.names.clear();
    out.bindings.clear();
    out.nodeSym.clear();
    out.nodeScope.clear();

    const state: AnalyseState = { sem: out, scope: 0 };
    const moduleScope = newScope(state, SCOPE.MODULE, program);
    state.scope = moduleScope;
    declarePass(state, program);
    state.scope = moduleScope;
    resolvePass(state, program);
}

/** declare all bindings introduced by a pattern (decl contexts) */
function declarePattern(state: AnalyseState, node: Node | null, flags: number, targetScope: number): void {
    if (node === null) return;
    switch (node.type) {
        case N.BindingIdentifier:
            declare(state, node, flags, NS_VALUE, targetScope);
            return;
        case N.ArrayPattern:
            for (const el of node.data.elements) declarePattern(state, el, flags, targetScope);
            return;
        case N.ObjectPattern:
            for (const p of node.data.properties) declarePattern(state, p, flags, targetScope);
            return;
        case N.ObjectProperty:
            declarePattern(state, node.data.value, flags, targetScope);
            return;
        case N.AssignmentPattern:
            declarePattern(state, node.data.left, flags, targetScope);
            return;
        case N.RestElement:
            declarePattern(state, node.data.argument, flags, targetScope);
            return;
        case N.FormalParameter:
            declarePattern(state, node.data.pattern, flags, targetScope);
            return;
    }
}

function declareParams(state: AnalyseState, list: Node[]): void {
    for (const p of list) declarePattern(state, p, SYM.PARAM, state.scope);
}

function declareTypeParams(state: AnalyseState, node: Node | null): void {
    if (node === null || node.type !== N.TSTypeParameterDeclaration) return;
    for (const tp of node.data.params) {
        if (tp.type === N.TSTypeParameter) declare(state, tp.data.name, SYM.TYPE, NS_TYPE, state.scope);
    }
}

function declareInScope(state: AnalyseState, kind: number, node: Node, body: () => void): void {
    const prev = state.scope;
    state.scope = newScope(state, kind, node);
    body();
    state.scope = prev;
}

function declarePass(state: AnalyseState, node: Node | null): void {
    if (node === null) return;
    switch (node.type) {
        case N.VariableDeclaration: {
            const kind = node.data.kind;
            const flags = kind === 'var' ? SYM.VAR : kind === 'let' ? SYM.LET : SYM.CONST;
            const target = kind === 'var' ? hoistTarget(state) : state.scope;
            for (const d of node.data.declarations) {
                if (d.type !== N.VariableDeclarator) continue;
                declarePattern(state, d.data.id, flags, target);
                declarePass(state, d.data.init);
            }
            return;
        }
        case N.FunctionDeclaration: {
            const id = node.data.id;
            if (id !== null) declare(state, id, SYM.FUNCTION, NS_VALUE, hoistTarget(state));
            declareInScope(state, SCOPE.FUNCTION, node, () => {
                declareTypeParams(state, node.data.typeParameters);
                declareParams(state, node.data.params);
                declarePass(state, node.data.body);
            });
            return;
        }
        case N.FunctionExpression: {
            declareInScope(state, SCOPE.FUNCTION, node, () => {
                const id = node.data.id;
                if (id !== null) declare(state, id, SYM.FUNCTION, NS_VALUE, state.scope);
                declareTypeParams(state, node.data.typeParameters);
                declareParams(state, node.data.params);
                declarePass(state, node.data.body);
            });
            return;
        }
        case N.ArrowFunctionExpression:
            declareInScope(state, SCOPE.FUNCTION, node, () => {
                declareTypeParams(state, node.data.typeParameters);
                declareParams(state, node.data.params);
                declarePass(state, node.data.body);
            });
            return;
        case N.ClassDeclaration: {
            const id = node.data.id;
            if (id !== null) declareDualNs(state, id, SYM.CLASS | SYM.TYPE, state.scope);
            declareInScope(state, SCOPE.CLASS, node, () => {
                declareTypeParams(state, node.data.typeParameters);
                declareClassBody(state, node.data.body);
            });
            declarePass(state, node.data.superClass);
            return;
        }
        case N.ClassExpression:
            declareInScope(state, SCOPE.CLASS, node, () => {
                const id = node.data.id;
                if (id !== null) declare(state, id, SYM.CLASS, NS_VALUE, state.scope);
                declareTypeParams(state, node.data.typeParameters);
                declareClassBody(state, node.data.body);
            });
            declarePass(state, node.data.superClass);
            return;
        case N.BlockStatement:
        case N.StaticBlock:
            declareInScope(state, SCOPE.BLOCK, node, () => {
                for (const s of node.data.body) declarePass(state, s);
            });
            return;
        case N.ForStatement:
            declareInScope(state, SCOPE.FOR, node, () => {
                declarePass(state, node.data.init);
                declarePass(state, node.data.test);
                declarePass(state, node.data.update);
                declarePass(state, node.data.body);
            });
            return;
        case N.ForInStatement:
        case N.ForOfStatement:
            declareInScope(state, SCOPE.FOR, node, () => {
                declarePass(state, node.data.left);
                declarePass(state, node.data.right);
                declarePass(state, node.data.body);
            });
            return;
        case N.SwitchStatement:
            declareInScope(state, SCOPE.SWITCH, node, () => {
                declarePass(state, node.data.discriminant);
                for (const c of node.data.cases) declarePass(state, c);
            });
            return;
        case N.CatchClause:
            declareInScope(state, SCOPE.CATCH, node, () => {
                declarePattern(state, node.data.param, SYM.CATCH, state.scope);
                declarePass(state, node.data.body);
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
                if (typeOnly) declareDualNs(state, local, SYM.IMPORT | SYM.TYPE, state.scope);
                else declare(state, local, SYM.IMPORT, NS_VALUE, state.scope);
            }
            return;
        }
        case N.TSInterfaceDeclaration:
            declare(state, node.data.id, SYM.TYPE, NS_TYPE, state.scope);
            declareInScope(state, SCOPE.TYPE, node, () => {
                declareTypeParams(state, node.data.typeParameters);
            });
            return;
        case N.TSTypeAliasDeclaration:
            declare(state, node.data.id, SYM.TYPE, NS_TYPE, state.scope);
            declareInScope(state, SCOPE.TYPE, node, () => {
                declareTypeParams(state, node.data.typeParameters);
            });
            return;
        case N.TSEnumDeclaration: {
            declareDualNs(state, node.data.id, SYM.ENUM | SYM.TYPE, state.scope);
            for (const member of node.data.members) {
                if (member.type === N.TSEnumMember) declarePass(state, member.data.initializer);
            }
            return;
        }
        case N.TSModuleDeclaration: {
            const id = node.data.id;
            if (id.type === N.BindingIdentifier) declare(state, id, SYM.NAMESPACE, NS_VALUE, state.scope);
            declareInScope(state, SCOPE.NAMESPACE, node, () => {
                for (const s of node.data.body) declarePass(state, s);
            });
            return;
        }
        case N.TSTypeAnnotation:
        case N.TSTypeReference:
            return;
    }
    walkChildren(node, (c) => declarePass(state, c));
}

function declareClassBody(state: AnalyseState, list: Node[]): void {
    for (const m of list) {
        if (m.type === N.MethodDefinition) {
            if (m.data.computed) declarePass(state, m.data.key);
            declarePass(state, m.data.value);
        } else if (m.type === N.PropertyDefinition) {
            if (m.data.computed) declarePass(state, m.data.key);
            declarePass(state, m.data.value);
        } else declarePass(state, m);
    }
}

/** enter the scope this node created in pass 1 (if any), run body, restore */
function inNodeScope(state: AnalyseState, node: Node, body: () => void): void {
    const s = state.sem.nodeScope.get(node);
    if (s === undefined) {
        body();
        return;
    }
    const prev = state.scope;
    state.scope = s;
    body();
    state.scope = prev;
}

function resolvePattern(state: AnalyseState, node: Node | null): void {
    if (node === null) return;
    switch (node.type) {
        case N.BindingIdentifier:
            return;
        case N.ArrayPattern:
            for (const el of node.data.elements) resolvePattern(state, el);
            return;
        case N.ObjectPattern:
            for (const p of node.data.properties) resolvePattern(state, p);
            return;
        case N.ObjectProperty:
            if (node.data.computed) resolvePass(state, node.data.key);
            resolvePattern(state, node.data.value);
            return;
        case N.AssignmentPattern:
            resolvePattern(state, node.data.left);
            resolvePass(state, node.data.right);
            return;
        case N.RestElement:
            resolvePattern(state, node.data.argument);
            return;
        case N.FormalParameter:
            resolvePattern(state, node.data.pattern);
            resolveType(state, node.data.typeAnnotation);
            resolvePass(state, node.data.init);
            return;
    }
}

function resolveParams(state: AnalyseState, list: Node[]): void {
    for (const p of list) {
        if (p.type === N.RestElement) {
            resolvePattern(state, p.data.argument);
            resolveType(state, p.data.typeAnnotation);
        } else resolvePattern(state, p);
    }
}

/** resolve a TS type subtree (type namespace for TSTypeRef heads, value ns for typeof) */
function resolveType(state: AnalyseState, node: Node | null): void {
    if (node === null) return;
    switch (node.type) {
        case N.TSTypeReference:
            resolveEntityName(state, node.data.typeName, NS_TYPE);
            resolveType(state, node.data.typeArguments);
            return;
        case N.TSTypeQuery:
            resolveEntityName(state, node.data.exprName, NS_VALUE);
            resolveType(state, node.data.typeArguments);
            return;
        case N.TSMappedType:
            inNodeScope(state, node, () => {
                walkChildren(node, (c) => resolveType(state, c));
            });
            return;
        case N.TSPropertySignature:
            if (node.data.computed) resolvePass(state, node.data.key);
            resolveType(state, node.data.typeAnnotation);
            return;
    }
    if (isIdentifier(node.type)) return;
    walkChildren(node, (c) => resolveType(state, c));
}

/** qualified name head resolves; the rest are member-ish */
function resolveEntityName(state: AnalyseState, node: Node | null, ns: number): void {
    if (node === null) return;
    if (node.type === N.IdentifierReference) resolveRef(state, node, ns);
    else if (node.type === N.TSQualifiedName) resolveEntityName(state, node.data.left, ns);
}

function resolvePass(state: AnalyseState, node: Node | null): void {
    if (node === null) return;
    switch (node.type) {
        case N.IdentifierReference:
            resolveRef(state, node, NS_VALUE);
            return;
        case N.StaticMemberExpression:
        case N.PrivateFieldExpression:
            resolvePass(state, node.data.object);
            return;
        case N.ComputedMemberExpression:
            resolvePass(state, node.data.object);
            resolvePass(state, node.data.expression);
            return;
        case N.ChainExpression:
            resolvePass(state, node.data.expression);
            return;
        case N.ObjectProperty:
            if (node.data.computed) resolvePass(state, node.data.key);
            resolvePass(state, node.data.value);
            return;
        case N.MethodDefinition:
            if (node.data.computed) resolvePass(state, node.data.key);
            resolvePass(state, node.data.value);
            return;
        case N.PropertyDefinition:
            if (node.data.computed) resolvePass(state, node.data.key);
            resolvePass(state, node.data.value);
            resolveType(state, node.data.typeAnnotation);
            return;
        case N.VariableDeclaration: {
            for (const d of node.data.declarations) {
                if (d.type !== N.VariableDeclarator) continue;
                resolvePattern(state, d.data.id);
                resolveType(state, d.data.typeAnnotation);
                resolvePass(state, d.data.init);
            }
            return;
        }
        case N.FunctionDeclaration:
        case N.FunctionExpression:
            inNodeScope(state, node, () => {
                resolveParams(state, node.data.params);
                resolveType(state, node.data.returnType);
                resolvePass(state, node.data.body);
            });
            return;
        case N.ArrowFunctionExpression:
            inNodeScope(state, node, () => {
                resolveParams(state, node.data.params);
                resolveType(state, node.data.returnType);
                resolvePass(state, node.data.body);
            });
            return;
        case N.ClassDeclaration:
        case N.ClassExpression: {
            resolvePass(state, node.data.superClass);
            inNodeScope(state, node, () => {
                for (const h of node.data.implements) {
                    if (h.type !== N.TSClassImplements) continue;
                    resolveEntityName(state, h.data.expression, NS_TYPE);
                    resolveType(state, h.data.typeArguments);
                }
                resolveType(state, node.data.superTypeArguments);
                for (const m of node.data.body) resolvePass(state, m);
            });
            return;
        }
        case N.BlockStatement:
        case N.StaticBlock:
        case N.ForStatement:
        case N.SwitchStatement:
        case N.TSModuleDeclaration:
            inNodeScope(state, node, () => {
                walkChildren(node, (c) => resolvePass(state, c));
            });
            return;
        case N.CatchClause:
            inNodeScope(state, node, () => {
                resolvePattern(state, node.data.param);
                resolvePass(state, node.data.body);
            });
            return;
        case N.ForInStatement:
        case N.ForOfStatement:
            inNodeScope(state, node, () => {
                resolvePass(state, node.data.left);
                resolvePass(state, node.data.right);
                resolvePass(state, node.data.body);
            });
            return;
        case N.ImportDeclaration:
            return;
        case N.ExportNamedDeclaration: {
            const decl = node.data.declaration;
            if (decl !== null) {
                resolvePass(state, decl);
                return;
            }
            if (node.data.source !== null) return;
            for (const s of node.data.specifiers) {
                if (s.type !== N.ExportSpecifier) continue;
                const local = s.data.local;
                if (local.type === N.IdentifierReference) resolveRef(state, local, NS_VALUE);
            }
            return;
        }
        case N.LabeledStatement:
            resolvePass(state, node.data.body);
            return;
        case N.BreakStatement:
        case N.ContinueStatement:
            return;
        case N.TSInterfaceDeclaration:
            inNodeScope(state, node, () => {
                for (const h of node.data.extends) {
                    if (h.type !== N.TSInterfaceHeritage) continue;
                    resolveEntityName(state, h.data.expression, NS_TYPE);
                    resolveType(state, h.data.typeArguments);
                }
                for (const m of node.data.body) resolveType(state, m);
            });
            return;
        case N.TSTypeAliasDeclaration:
            inNodeScope(state, node, () => {
                resolveType(state, node.data.typeAnnotation);
            });
            return;
        case N.TSEnumDeclaration:
            for (const member of node.data.members) {
                if (member.type === N.TSEnumMember) resolvePass(state, member.data.initializer);
            }
            return;
        case N.TSAsExpression:
        case N.TSSatisfiesExpression:
            resolvePass(state, node.data.expression);
            resolveType(state, node.data.typeAnnotation);
            return;
        case N.TSTypeAnnotation:
            resolveType(state, node);
            return;
        case N.CallExpression:
        case N.NewExpression:
            resolvePass(state, node.data.callee);
            resolveType(state, node.data.typeArguments);
            for (const a of node.data.arguments) resolvePass(state, a);
            return;
    }
    walkChildren(node, (c) => resolvePass(state, c));
}

/**
 * Declare a synthetic IMPORT binding into an already-analyzed module's semantic
 * (plan §5c: the injected automatic-runtime locals jsx/jsxs/Fragment/
 * createElement). `identNode` is a fresh BindingIdentifier; a symbol record is
 * appended and its node→symbol association recorded. The symbol lands in the
 * module scope so deconflict renames it and link binds it like any import.
 * Returns the new SymbolId.
 */
export function declareSyntheticImport(semantic: Semantic, identNode: Node): number {
    let ms = 1;
    for (let s = 1; s < semantic.scopes.length; s++) {
        if (semantic.scopes[s].flags === SCOPE.MODULE) { ms = s; break; }
    }

    const id = semantic.symbols.length;
    semantic.symbols.push({ scope: ms, decl: identNode, flags: SYM.IMPORT, nameId: 0 });
    semantic.nodeSym.set(identNode, id);
    return id;
}

/** Declared name of a symbol (the text of its declaring Ident). */
export const symbolName = (semantic: Semantic, symbolId: number): string =>
    semantic.symbols[symbolId].decl?.name ?? '';

/** Resolved symbol id for an Ident node (0 = unresolved/global). */
export const symbolOf = (semantic: Semantic, node: Node): number => semantic.nodeSym.get(node) ?? 0;
/** Scope owned by a scope-bearing node (0 = none). */
export const scopeOf = (semantic: Semantic, node: Node): number => semantic.nodeScope.get(node) ?? 0;
