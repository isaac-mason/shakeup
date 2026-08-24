import { isIdentifier, N, type Node, walkChildren } from '../ast.ts';
import { enumeration } from '../util/enumeration';

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

    // node→symbol lives on the node (`node.sym`, oxc model); only scope-owning nodes still map here.
    nodeScope: Map<Node, number>;

    unresolved: Node[];

    /**
     * REVERSE INDEX: symbol id → the reference nodes that resolve to it (reads and writes both;
     * `IdentifierReference` nodes only — a declaration is not a reference).
     *
     * This is oxc's `Scoping::resolved_references` (`ArenaVec<ArenaVec<ReferenceId>>`), the structure
     * that lets a pass ask "is this symbol unused / how many reads has it" in O(1) instead of walking
     * the whole program. Without it, `analysis/movement.ts`'s `tallyRefs` is the only way to answer, so
     * `constProp`, `aliasInline` and `dropUnused` each walk every node, every traverse, every
     * fixed-point iteration — which profiling showed to be the dominant cost of compress.
     *
     * MAINTENANCE CONTRACT (oxc's, verbatim from `compressor.rs`): a stale EXTRA reference only costs
     * optimizations — the output stays correct; an ADDED reference that was never recorded can produce
     * INCORRECT output. So: **prune lazily, register eagerly.** A pass that drops a subtree may leave
     * its references behind (they resolve to nodes no longer in the tree, and readers must tolerate
     * that); a pass that introduces a reference MUST record it.
     */
    resolvedReferences: Node[][];

    names: Map<string, number>;
    bindings: Map<number, number>;

};

/**
 * Resolve `name` in the VALUE namespace starting at `scope` and walking to the root, returning the
 * symbol it binds to, or 0 when nothing binds it (a global / unresolved reference).
 *
 * Used for hygiene checks when code MOVES between scopes: an inliner must confirm that a free
 * variable in a callee body still resolves to the same binding at the call site, or splicing the body
 * there would silently re-bind it.
 */
export function lookupValue(sem: Semantic, scope: number, name: string): number {
    const nameId = sem.names.get(name);
    if (nameId === undefined) return 0;
    let s = scope;
    for (;;) {
        const hit = sem.bindings.get(bindingKey(s, NS_VALUE, nameId));
        if (hit !== undefined) return hit;
        const p = s <= 0 ? 0 : sem.scopes[s].parent;
        if (s === 0 || p === s) return 0;
        s = p;
    }
}

/** Allocate an empty {@link Semantic}; reuse it across analyze() calls to keep warm capacity. */
export function createSemantic(): Semantic {
    return {
        scopes: [{ parent: 0, flags: 0, node: null }],
        symbols: [{ scope: 0, decl: null, flags: 0, nameId: 0 }],
        nodeScope: new Map(),
        unresolved: [],
        resolvedReferences: [],
        names: new Map(),
        bindings: new Map(),
    };
}

/**
 * Per-analyze() traversal state, threaded as the first arg to every pass function so a
 * run holds no module-global state (reentrant). `sem` is the table being filled; `scope`
 * is the current-scope cursor, saved/restored as the walk descends and ascends.
 */
type RefColl = { node: Node; scope: number; ns: number };
type AnalyseState = { sem: Semantic; scope: number; pending: RefColl[] };

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
        identNode.sym = existing;
        return existing;
    }
    const id = state.sem.symbols.length;
    state.sem.symbols.push({ scope: targetScope, decl: identNode, flags, nameId });
    state.sem.bindings.set(key, id);
    identNode.sym = id;
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

/** Record `identNode` as a reference to `sym` in the reverse index (oxc `add_resolved_reference`). */
function recordRef(sem: Semantic, sym: number, identNode: Node): void {
    const list = sem.resolvedReferences[sym];
    if (list === undefined) sem.resolvedReferences[sym] = [identNode];
    else list.push(identNode);
}

function resolveRef(state: AnalyseState, identNode: Node, ns: number): void {
    const nameId = state.sem.names.get(identNode.name);
    if (nameId !== undefined) {
        let s = state.scope;
        while (s !== 0) {
            const hit = state.sem.bindings.get(bindingKey(s, ns, nameId));
            if (hit !== undefined) {
                identNode.sym = hit;
                recordRef(state.sem, hit, identNode);
                return;
            }
            s = state.sem.scopes[s].parent;
        }
        if (ns === NS_TYPE) {
            s = state.scope;
            while (s !== 0) {
                const hit = state.sem.bindings.get(bindingKey(s, NS_VALUE, nameId));
                if (
                    hit !== undefined &&
                    (state.sem.symbols[hit].flags & (SYM.CLASS | SYM.ENUM | SYM.IMPORT | SYM.NAMESPACE)) !== 0
                ) {
                    identNode.sym = hit;
                    recordRef(state.sem, hit, identNode);
                    return;
                }
                s = state.sem.scopes[s].parent;
            }
        }
    }
    if (ns === NS_VALUE) state.sem.unresolved.push(identNode);
}

/** Reset a warm {@link Semantic} for reuse across analyze() calls. */
function resetSem(out: Semantic): void {
    out.scopes.length = 1;
    out.symbols.length = 1;
    out.unresolved.length = 0;
    out.resolvedReferences.length = 0;
    out.names.clear();
    out.bindings.clear();
    out.nodeScope.clear();
}

/**
 * Single traversal (oxc SemanticBuilder model): declare bindings + create scopes + COLLECT
 * references in one walk; resolution is DEFERRED to after the walk so forward/hoisted refs see
 * every binding. `resolveRef` is reused verbatim for the deferred step, so resolution is identical
 * to the two-pass. LIMIT: no TDZ or redeclaration diagnostics; labels not tracked.
 */
export function analyze(out: Semantic, program: Node): void {
    resetSem(out);
    const state: AnalyseState = { sem: out, scope: 0, pending: [] };
    const moduleScope = newScope(state, SCOPE.MODULE, program);
    state.scope = moduleScope;
    visit(state, program);
    for (const p of state.pending) {
        state.scope = p.scope;
        resolveRef(state, p.node, p.ns);
    }
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

// ─── single-pass traversal: declare + create scopes + COLLECT refs (resolution deferred) ──────────

const collect = (state: AnalyseState, node: Node, ns: number): void => {
    state.pending.push({ node, scope: state.scope, ns });
};

function collectEntityName(state: AnalyseState, node: Node | null, ns: number): void {
    if (node === null) return;
    if (node.type === N.IdentifierReference) collect(state, node, ns);
    else if (node.type === N.TSQualifiedName) collectEntityName(state, node.data.left, ns);
}

/** type-context traversal: collect type refs (+ the value-ns `typeof` head); declares nothing. */
function visitType(state: AnalyseState, node: Node | null): void {
    if (node === null) return;
    switch (node.type) {
        case N.TSTypeReference:
            collectEntityName(state, node.data.typeName, NS_TYPE);
            visitType(state, node.data.typeArguments);
            return;
        case N.TSTypeQuery:
            collectEntityName(state, node.data.exprName, NS_VALUE);
            visitType(state, node.data.typeArguments);
            return;
        case N.TSMappedType:
            walkChildren(node, (c) => visitType(state, c));
            return;
        case N.TSPropertySignature:
            if (node.data.computed) visit(state, node.data.key);
            visitType(state, node.data.typeAnnotation);
            return;
    }
    if (isIdentifier(node.type)) return;
    walkChildren(node, (c) => visitType(state, c));
}

/** pattern in value context: the caller already declared the bindings; here collect refs in
 *  computed keys, defaults, and type annotations. */
function collectPattern(state: AnalyseState, node: Node | null): void {
    if (node === null) return;
    switch (node.type) {
        case N.BindingIdentifier:
            return;
        case N.ArrayPattern:
            for (const el of node.data.elements) collectPattern(state, el);
            return;
        case N.ObjectPattern:
            for (const p of node.data.properties) collectPattern(state, p);
            return;
        case N.ObjectProperty:
            if (node.data.computed) visit(state, node.data.key);
            collectPattern(state, node.data.value);
            return;
        case N.AssignmentPattern:
            collectPattern(state, node.data.left);
            visit(state, node.data.right);
            return;
        case N.RestElement:
            collectPattern(state, node.data.argument);
            return;
        case N.FormalParameter:
            collectPattern(state, node.data.pattern);
            visitType(state, node.data.typeAnnotation);
            visit(state, node.data.init);
            return;
    }
}

/** declare params into the current scope, then collect refs in their defaults/types. */
function declareCollectParams(state: AnalyseState, list: Node[]): void {
    for (const p of list) declarePattern(state, p, SYM.PARAM, state.scope);
    for (const p of list) {
        if (p.type === N.RestElement) {
            collectPattern(state, p.data.argument);
            visitType(state, p.data.typeAnnotation);
        } else collectPattern(state, p);
    }
}

/** value-context traversal: declares bindings + creates scopes + collects value references. */
function visit(state: AnalyseState, node: Node | null): void {
    if (node === null) return;
    switch (node.type) {
        case N.IdentifierReference:
            collect(state, node, NS_VALUE);
            return;
        case N.StaticMemberExpression:
        case N.PrivateFieldExpression:
            visit(state, node.data.object);
            return;
        case N.ComputedMemberExpression:
            visit(state, node.data.object);
            visit(state, node.data.expression);
            return;
        case N.ChainExpression:
            visit(state, node.data.expression);
            return;
        case N.ObjectProperty:
            if (node.data.computed) visit(state, node.data.key);
            visit(state, node.data.value);
            return;
        case N.MethodDefinition:
            if (node.data.computed) visit(state, node.data.key);
            visit(state, node.data.value);
            return;
        case N.PropertyDefinition:
            if (node.data.computed) visit(state, node.data.key);
            visit(state, node.data.value);
            visitType(state, node.data.typeAnnotation);
            return;
        case N.VariableDeclaration: {
            const kind = node.data.kind;
            const flags = kind === 'var' ? SYM.VAR : kind === 'let' ? SYM.LET : SYM.CONST;
            const target = kind === 'var' ? hoistTarget(state) : state.scope;
            for (const d of node.data.declarations) {
                if (d.type !== N.VariableDeclarator) continue;
                declarePattern(state, d.data.id, flags, target);
                collectPattern(state, d.data.id);
                visitType(state, d.data.typeAnnotation);
                visit(state, d.data.init);
            }
            return;
        }
        case N.FunctionDeclaration: {
            const id = node.data.id;
            if (id !== null) declare(state, id, SYM.FUNCTION, NS_VALUE, hoistTarget(state));
            declareInScope(state, SCOPE.FUNCTION, node, () => {
                declareTypeParams(state, node.data.typeParameters);
                declareCollectParams(state, node.data.params);
                visitType(state, node.data.returnType);
                visit(state, node.data.body);
            });
            return;
        }
        case N.FunctionExpression:
            declareInScope(state, SCOPE.FUNCTION, node, () => {
                const id = node.data.id;
                if (id !== null) declare(state, id, SYM.FUNCTION, NS_VALUE, state.scope);
                declareTypeParams(state, node.data.typeParameters);
                declareCollectParams(state, node.data.params);
                visitType(state, node.data.returnType);
                visit(state, node.data.body);
            });
            return;
        case N.ArrowFunctionExpression:
            declareInScope(state, SCOPE.FUNCTION, node, () => {
                declareTypeParams(state, node.data.typeParameters);
                declareCollectParams(state, node.data.params);
                visitType(state, node.data.returnType);
                visit(state, node.data.body);
            });
            return;
        case N.ClassDeclaration: {
            const id = node.data.id;
            if (id !== null) declareDualNs(state, id, SYM.CLASS | SYM.TYPE, state.scope);
            visit(state, node.data.superClass);
            declareInScope(state, SCOPE.CLASS, node, () => {
                declareTypeParams(state, node.data.typeParameters);
                for (const h of node.data.implements) {
                    if (h.type !== N.TSClassImplements) continue;
                    collectEntityName(state, h.data.expression, NS_TYPE);
                    visitType(state, h.data.typeArguments);
                }
                visitType(state, node.data.superTypeArguments);
                for (const m of node.data.body) visit(state, m);
            });
            return;
        }
        case N.ClassExpression:
            visit(state, node.data.superClass);
            declareInScope(state, SCOPE.CLASS, node, () => {
                const id = node.data.id;
                if (id !== null) declare(state, id, SYM.CLASS, NS_VALUE, state.scope);
                declareTypeParams(state, node.data.typeParameters);
                for (const h of node.data.implements) {
                    if (h.type !== N.TSClassImplements) continue;
                    collectEntityName(state, h.data.expression, NS_TYPE);
                    visitType(state, h.data.typeArguments);
                }
                visitType(state, node.data.superTypeArguments);
                for (const m of node.data.body) visit(state, m);
            });
            return;
        case N.BlockStatement:
        case N.StaticBlock:
            declareInScope(state, SCOPE.BLOCK, node, () => {
                for (const s of node.data.body) visit(state, s);
            });
            return;
        case N.ForStatement:
            declareInScope(state, SCOPE.FOR, node, () => {
                visit(state, node.data.init);
                visit(state, node.data.test);
                visit(state, node.data.update);
                visit(state, node.data.body);
            });
            return;
        case N.ForInStatement:
        case N.ForOfStatement:
            declareInScope(state, SCOPE.FOR, node, () => {
                visit(state, node.data.left);
                visit(state, node.data.right);
                visit(state, node.data.body);
            });
            return;
        case N.SwitchStatement:
            declareInScope(state, SCOPE.SWITCH, node, () => {
                visit(state, node.data.discriminant);
                for (const c of node.data.cases) visit(state, c);
            });
            return;
        case N.CatchClause:
            declareInScope(state, SCOPE.CATCH, node, () => {
                declarePattern(state, node.data.param, SYM.CATCH, state.scope);
                collectPattern(state, node.data.param);
                visit(state, node.data.body);
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
        case N.ExportNamedDeclaration: {
            const decl = node.data.declaration;
            if (decl !== null) {
                visit(state, decl);
                return;
            }
            if (node.data.source !== null) return;
            for (const s of node.data.specifiers) {
                if (s.type !== N.ExportSpecifier) continue;
                const local = s.data.local;
                if (local.type === N.IdentifierReference) collect(state, local, NS_VALUE);
            }
            return;
        }
        case N.LabeledStatement:
            visit(state, node.data.body);
            return;
        case N.BreakStatement:
        case N.ContinueStatement:
            return;
        case N.TSInterfaceDeclaration:
            declare(state, node.data.id, SYM.TYPE, NS_TYPE, state.scope);
            declareInScope(state, SCOPE.TYPE, node, () => {
                declareTypeParams(state, node.data.typeParameters);
                for (const h of node.data.extends) {
                    if (h.type !== N.TSInterfaceHeritage) continue;
                    collectEntityName(state, h.data.expression, NS_TYPE);
                    visitType(state, h.data.typeArguments);
                }
                for (const m of node.data.body) visitType(state, m);
            });
            return;
        case N.TSTypeAliasDeclaration:
            declare(state, node.data.id, SYM.TYPE, NS_TYPE, state.scope);
            declareInScope(state, SCOPE.TYPE, node, () => {
                declareTypeParams(state, node.data.typeParameters);
                visitType(state, node.data.typeAnnotation);
            });
            return;
        case N.TSEnumDeclaration:
            declareDualNs(state, node.data.id, SYM.ENUM | SYM.TYPE, state.scope);
            for (const member of node.data.members) {
                if (member.type === N.TSEnumMember) visit(state, member.data.initializer);
            }
            return;
        case N.TSModuleDeclaration: {
            const id = node.data.id;
            if (id.type === N.BindingIdentifier) declare(state, id, SYM.NAMESPACE, NS_VALUE, state.scope);
            declareInScope(state, SCOPE.NAMESPACE, node, () => {
                for (const s of node.data.body) visit(state, s);
            });
            return;
        }
        case N.TSImportEqualsDeclaration: {
            const id = node.data.id;
            // Mirror ImportDeclaration: a value alias binds in the value ns; a `import type X =`
            // alias binds dual-ns. The entity-name head (`A` in `import X = A.B`) is a value ref so
            // it resolves + is seen by tree-shaking; `require("m")` carries no ref.
            if (node.data.importKind === 'type') declareDualNs(state, id, SYM.IMPORT | SYM.TYPE, state.scope);
            else declare(state, id, SYM.IMPORT, NS_VALUE, state.scope);
            const ref = node.data.moduleReference;
            if (ref.type !== N.TSExternalModuleReference) collectEntityName(state, ref, NS_VALUE);
            return;
        }
        case N.TSAsExpression:
        case N.TSSatisfiesExpression:
            visit(state, node.data.expression);
            visitType(state, node.data.typeAnnotation);
            return;
        case N.TSInstantiationExpression:
            visit(state, node.data.expression);
            visitType(state, node.data.typeArguments);
            return;
        case N.TSTypeAnnotation:
            visitType(state, node);
            return;
        case N.TSTypeReference:
            return;
        case N.CallExpression:
        case N.NewExpression:
            visit(state, node.data.callee);
            visitType(state, node.data.typeArguments);
            for (const a of node.data.arguments) visit(state, a);
            return;
    }
    walkChildren(node, (c) => visit(state, c));
}

/**
 * Declare a synthetic IMPORT binding into an already-analyzed module's semantic
 * (e.g. injected automatic-runtime locals jsx/jsxs/Fragment/createElement).
 * `identNode` is a fresh BindingIdentifier; a symbol record is appended and its
 * node→symbol association recorded. The symbol lands in the module scope so
 * deconflict renames it and link binds it like any import. Returns the new SymbolId.
 */
export function declareSyntheticImport(semantic: Semantic, identNode: Node): number {
    let ms = 1;
    for (let s = 1; s < semantic.scopes.length; s++) {
        if (semantic.scopes[s].flags === SCOPE.MODULE) {
            ms = s;
            break;
        }
    }

    const id = semantic.symbols.length;
    semantic.symbols.push({ scope: ms, decl: identNode, flags: SYM.IMPORT, nameId: 0 });
    identNode.sym = id;
    return id;
}

/** Register a fresh lexical scope (e.g. a lowering pass synthesizing an IIFE), parented to
 *  `parent`. Returns the new scope id. Mirrors analyze's `newScope` but for post-analysis
 *  transform passes; the owning node is not tracked (mangle reads scopes by parent/symbol, not
 *  `nodeScope`). */
export function createScope(semantic: Semantic, parent: number, flags: number): number {
    const id = semantic.scopes.length;
    semantic.scopes.push({ parent, flags, node: null });
    return id;
}

/** Declare a local binding into an already-analyzed module's semantic at `scope` (e.g. an IIFE
 *  param a lowering pass mints via `generateUid`). Appends a symbol record, associates the decl
 *  node, and returns the new SymbolId — the general-scope counterpart to
 *  {@link declareSyntheticImport}. Because the symbol lives in a non-module scope, deconflict
 *  leaves it and the chunk mangler (`src/mangle/`) renames it like any nested local. */
export function declareLocal(semantic: Semantic, declNode: Node, scope: number, flags: number): number {
    const id = semantic.symbols.length;
    semantic.symbols.push({ scope, decl: declNode, flags, nameId: 0 });
    declNode.sym = id;
    return id;
}

/** Declared name of a symbol (the text of its declaring Ident). */
export const symbolName = (semantic: Semantic, symbolId: number): string => semantic.symbols[symbolId].decl?.name ?? '';

/** Resolved symbol id for an Ident node (0 = unresolved/global). The link lives on the node. */
export const symbolOf = (_semantic: Semantic, node: Node): number => node.sym;
/** Scope owned by a scope-bearing node (0 = none). */
export const scopeOf = (semantic: Semantic, node: Node): number => semantic.nodeScope.get(node) ?? 0;
