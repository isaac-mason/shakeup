import { CHILD_FIELDS, isIdentifier, N, type Node, walkChildren, TYPE_COUNT } from '../ast.ts';
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
    /** `1` for every node TYPE that owns a scope in this semantic, `0` otherwise.
     *
     *  A gate in front of `nodeScope`, which is keyed by node OBJECT: `traverse`'s `descend` asks it
     *  about every node it walks, and measured over a crashcat bundle 1,512,512 of 1,541,155 lookups
     *  (98.14%) found nothing — only 12 of ~151 node types ever own a scope. Marked wherever a node
     *  is registered below, so it is derived from the data rather than a hand-maintained list, and
     *  can only ever be a SUPERSET of the owning types (never a false negative). */
    scopeOwnerTypes: Uint8Array;

    unresolved: Node[];

    names: Map<string, number>;
    bindings: Map<number, number>;

    // ── reference facts (compress prelude, computed here instead of by a separate walk) ───────────
    // These were `computePrelude`'s job: it ran a full ref-tally walk PLUS a `walkRefIdents` walk at
    // the start of every compress round, 23.8% of the fixed point's time. This walk already visits
    // every node and already collects every reference, so the same facts cost a counter bump each.
    // Identity is deliberately NOT tracked (oxc keys a `ReferenceId` off the AST node; we must not
    // widen `Node`) — every consumer wants counts and sticky flags, never a reference list.
    /** Read/write counts per symbol. A compound assign / update counts as BOTH. */
    refs: Map<number, RefCounts>;
    /** Reference-node count per symbol — NOT reads+writes (`x += 1` is 2 there, 1 here). */
    uses: Map<number, number>;
    /** Symbols read as a shorthand-property VALUE (`{ x }`), which cannot be substituted by span. */
    shorthand: Set<number>;
    /** Locals re-exported by a bare `export { X }` — renaming one would rewrite the public name. */
    exported: Set<number>;
    /**
     * The INIT expression of the declarator that bound each symbol, for plain-identifier bindings.
     *
     * oxc's `SymbolValue` / `init_symbol_value`: record what a binding was initialized with as the
     * declarator is walked, so consumers read a table instead of hunting for declarations. `constProp`
     * and `aliasInline` each used to walk the WHOLE PROGRAM at `[N.Program]` enter to build their own
     * candidate map — 5.9% of profile between them, every round, the same shape as the prelude walks
     * this file already absorbed. They now filter this table by their own policy instead.
     *
     * Deliberately UNFILTERED: it records the init for every `BindingIdentifier` declarator regardless
     * of kind, literalness or reference counts, because the two consumers want different subsets
     * (`constProp` wants primitive literals, `aliasInline` wants bare identifiers). Kind lives on
     * `symbols[sym].flags` (`SYM.VAR`/`LET`/`CONST`), so a consumer that cares still has it.
     */
    symbolInit: Map<number, Node>;
};

/** Read/write tally for one symbol. */
export type RefCounts = { reads: number; writes: number };

// Syntactic role of a collected reference, carried on the PENDING record (resolution is deferred, so
// the role is known when we collect and the symbol only when we resolve).
const REF_READ = 1;
const REF_WRITE = 2;
const REF_SHORTHAND = 4;
const REF_EXPORTED = 8;

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
        scopeOwnerTypes: new Uint8Array(TYPE_COUNT),
        refs: new Map(),
        uses: new Map(),
        shorthand: new Set(),
        exported: new Set(),
        symbolInit: new Map(),
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
/**
 * Deferred references, held as PARALLEL ARRAYS rather than an array of records.
 *
 * Resolution is deferred to after the walk (so forward/hoisted references see every binding), which
 * means every reference in the module is queued. As `{ node, scope, ns, flags }` records that was one
 * OBJECT ALLOCATION PER REFERENCE — tens of thousands per module, on a path where GC is 38% of a
 * crashcat bundle. Four arrays hold the same data with no per-entry object, and the consume loop reads
 * them by index.
 */
type AnalyseState = {
    sem: Semantic;
    scope: number;
    pendNode: Node[];
    pendScope: number[];
    pendNs: number[];
    pendFlags: number[];
};

function newScope(state: AnalyseState, flags: number, node: Node | null): number {
    const id = state.sem.scopes.length;
    state.sem.scopes.push({ parent: state.scope, flags, node });
    if (node !== null) {
        state.sem.nodeScope.set(node, id);
        state.sem.scopeOwnerTypes[node.type] = 1;
    }
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

function resolveRef(state: AnalyseState, identNode: Node, ns: number): void {
    const nameId = state.sem.names.get(identNode.name);
    if (nameId !== undefined) {
        let s = state.scope;
        while (s !== 0) {
            const hit = state.sem.bindings.get(bindingKey(s, ns, nameId));
            if (hit !== undefined) {
                identNode.sym = hit;
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
    out.names.clear();
    out.bindings.clear();
    out.nodeScope.clear();
    out.scopeOwnerTypes.fill(0);
    out.refs.clear();
    out.uses.clear();
    out.shorthand.clear();
    out.exported.clear();
    out.symbolInit.clear();
}

/**
 * Single traversal (oxc SemanticBuilder model): declare bindings + create scopes + COLLECT
 * references in one walk; resolution is DEFERRED to after the walk so forward/hoisted refs see
 * every binding. `resolveRef` is reused verbatim for the deferred step, so resolution is identical
 * to the two-pass. LIMIT: no TDZ or redeclaration diagnostics; labels not tracked.
 */
export function analyze(out: Semantic, program: Node): void {
    resetSem(out);
    const state: AnalyseState = { sem: out, scope: 0, pendNode: [], pendScope: [], pendNs: [], pendFlags: [] };
    const moduleScope = newScope(state, SCOPE.MODULE, program);
    state.scope = moduleScope;
    visit(state, program);
    const pn = state.pendNode;
    for (let i = 0; i < pn.length; i++) {
        const node = pn[i];
        state.scope = state.pendScope[i];
        resolveRef(state, node, state.pendNs[i]);
        // Tally AFTER resolution — the role was recorded when we collected, the symbol is known only
        // now. Mirrors `computePrelude` exactly, including its quirks: a compound assignment and an
        // update count as BOTH a read and a write, while `uses` counts the reference NODE once.
        const sym = node.sym;
        if (sym === 0) continue;
        const f = state.pendFlags[i];
        if ((f & (REF_READ | REF_WRITE)) !== 0) {
            let c = out.refs.get(sym);
            if (c === undefined) {
                c = { reads: 0, writes: 0 };
                out.refs.set(sym, c);
            }
            if ((f & REF_READ) !== 0) c.reads++;
            if ((f & REF_WRITE) !== 0) c.writes++;
        }
        out.uses.set(sym, (out.uses.get(sym) ?? 0) + 1);
        if ((f & REF_SHORTHAND) !== 0) out.shorthand.add(sym);
        if ((f & REF_EXPORTED) !== 0) out.exported.add(sym);
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

const collect = (state: AnalyseState, node: Node, ns: number, flags: number = REF_READ): void => {
    state.pendNode.push(node);
    state.pendScope.push(state.scope);
    state.pendNs.push(ns);
    state.pendFlags.push(flags);
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
/**
 * Handle an ObjectProperty that is written SHORTHAND (`{ x }` or `{ x = 1 }`), returning whether it
 * was consumed. Such a value is a reference that cannot be substituted by span — rewriting it in
 * place would change the property NAME with it.
 *
 * Shared by both walks because shorthand is orthogonal to direction: `const o = { x }` READS x and
 * `({ x } = o)` WRITES it, and `computePrelude` (via `walkRefIdents`) marks both, so missing the
 * target case desynchronises the two.
 */
function collectShorthandProp(
    state: AnalyseState,
    data: { shorthand: boolean; value: Node },
    base: number,
): boolean {
    if (!data.shorthand) return false;
    const v = data.value;
    if (v.type === N.IdentifierReference) {
        collect(state, v, NS_VALUE, base | REF_SHORTHAND);
        return true;
    }
    if (v.type === N.AssignmentPattern) {
        const l = v.data.left;
        if (l.type === N.IdentifierReference) collect(state, l, NS_VALUE, base | REF_SHORTHAND);
        else collectTarget(state, l);
        visit(state, v.data.right);
        return true;
    }
    return false;
}

/**
 * Walk an ASSIGNMENT TARGET, marking the identifiers it binds as WRITES.
 *
 * Ported from `computePrelude`'s `visitTarget` so the two agree exactly. The subtle case is a member
 * target: in `a.b = 1` the assignment sets a PROPERTY, so `a` itself is READ, not written — hence the
 * member arms hand back to the ordinary value walk.
 */
function collectTarget(state: AnalyseState, node: Node | null): void {
    if (node === null) return;
    switch (node.type) {
        case N.IdentifierReference:
            collect(state, node, NS_VALUE, REF_WRITE);
            return;
        case N.ArrayExpression:
            for (const el of node.data.elements) if (el !== null) collectTarget(state, el);
            return;
        case N.ObjectExpression:
            for (const p of node.data.properties) collectTarget(state, p);
            return;
        case N.ObjectProperty:
            if (node.data.computed) visit(state, node.data.key);
            if (collectShorthandProp(state, node.data, REF_WRITE)) return;
            collectTarget(state, node.data.value);
            return;
        case N.SpreadElement:
        case N.RestElement:
            collectTarget(state, node.data.argument);
            return;
        case N.AssignmentExpression:
        case N.AssignmentPattern:
            collectTarget(state, node.data.left);
            visit(state, node.data.right);
            return;
        case N.StaticMemberExpression:
        case N.ComputedMemberExpression:
            visit(state, node);
            return;
        default:
            visit(state, node);
    }
}

/**
 * Visit a FUNCTION BODY without opening a block scope of its own.
 *
 * A function body's top-level lexical declarations belong to the FUNCTION scope, not to a nested
 * block: `function f(e) { let e; }` is an early SyntaxError, which only holds if the parameter and the
 * `let` inhabit ONE scope. oxc encodes this structurally — its `FunctionBody` is a distinct AST node
 * and never enters a scope, so only the function scope covers both — while shakeup reuses
 * `BlockStatement` for bodies, and that case unconditionally opened a `SCOPE.BLOCK`.
 *
 * The consequence was not theoretical. `mangle/slots.ts` is a faithful port of oxc's
 * `SlotAssignment::compute`, where two symbols may share a slot (hence a NAME) when their live ranges
 * do not overlap. A parameter never read in the body has empty liveness, so a body-level `let` was
 * free to take its slot — emitting `onBeforeRender(e,t,n,r,i){ … let e = … }` and a bundle Node
 * refuses to parse. The mangler was right; the scope tree it was given was wrong.
 */

/**
 * Codegen'd child descent for {@link visit} — one generated `switch (n.type)` reading each child field
 * by NAME and recursing DIRECTLY, mirroring `ast.ts`'s `buildWalkBody`.
 *
 * It replaces `walkChildren(node, (c) => visit(state, c))`, which cost two things on every node without
 * a specific case (most of them): a CLOSURE capturing `state`, and `walkChildren`'s DYNAMIC key
 * `data[fields[i].name]` across ~151 hidden classes. `visit` is 7.68% of a crashcat bundling profile —
 * half of this file, which is the largest in it.
 *
 * Note this is NOT the same proposition as codegen'ing `walkChildren` itself, which measured only 1.04%
 * and was rejected: that has to keep its `(child, fieldName, listIndex)` callback and early exit, and
 * the indirect call dominates. `visit` needs none of that, so the callback disappears. Benched at
 * **1.20x** with a realistic per-node body (`benches/micro/visit-descend.bench.ts`) — the simplified
 * arm claimed 1.52x, which is why the bench body does real work.
 *
 * `V` is passed in rather than closed over because a `new Function` body runs in global scope.
 */
function buildDescendBody(): string {
    let s = 'const d=n.data;if(d===null)return;switch(n.type){';
    for (const [name, fields] of Object.entries(CHILD_FIELDS) as [keyof typeof N, { name: string; list: boolean }[]][]) {
        if (fields.length === 0) continue;
        s += `case ${N[name]}:{`;
        for (const f of fields) {
            const key = JSON.stringify(f.name);
            s += f.list
                ? `{const a=d[${key}];if(a!=null){for(let i=0;i<a.length;i++){const c=a[i];if(c!=null)V(state,c);}}}`
                : `{const c=d[${key}];if(c!=null)V(state,c);}`;
        }
        s += 'return;}';
    }
    return `${s}}`;
}

const descendVisit = new Function('state', 'n', 'V', buildDescendBody()) as (
    state: AnalyseState,
    n: Node,
    V: (state: AnalyseState, node: Node | null) => void,
) => void;

function visitFunctionBody(state: AnalyseState, body: Node | null): void {
    if (body === null) return;
    if (body.type !== N.BlockStatement) {
        visit(state, body); // concise arrow body — an expression, no scope either way
        return;
    }
    for (const s of body.data.body) visit(state, s);
}

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
            if (collectShorthandProp(state, node.data, REF_READ)) return;
            visit(state, node.data.value);
            return;
        case N.AssignmentExpression: {
            const { operator, left, right } = node.data;
            // `x += 1` READS x as well as writing it; `x = 1` only writes.
            if (operator !== '=' && left.type === N.IdentifierReference)
                collect(state, left, NS_VALUE, REF_READ | REF_WRITE);
            else collectTarget(state, left);
            visit(state, right);
            return;
        }
        case N.UpdateExpression: {
            const arg = node.data.argument;
            if (arg.type === N.IdentifierReference) collect(state, arg, NS_VALUE, REF_READ | REF_WRITE);
            else visit(state, arg);
            return;
        }
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
                // `declarePattern` has assigned `id.sym` by here, so the init can be filed against it.
                const dId = d.data.id;
                if (dId.type === N.BindingIdentifier && d.data.init !== null && dId.sym !== 0)
                    state.sem.symbolInit.set(dId.sym, d.data.init);
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
                visitFunctionBody(state, node.data.body);
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
                visitFunctionBody(state, node.data.body);
            });
            return;
        case N.ArrowFunctionExpression:
            declareInScope(state, SCOPE.FUNCTION, node, () => {
                declareTypeParams(state, node.data.typeParameters);
                declareCollectParams(state, node.data.params);
                visitType(state, node.data.returnType);
                visitFunctionBody(state, node.data.body);
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
                // `for (x of xs)` ASSIGNS to `x` each turn; only a VariableDeclaration head declares.
                if (node.data.left.type === N.VariableDeclaration) visit(state, node.data.left);
                else collectTarget(state, node.data.left);
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
                if (local.type === N.IdentifierReference) collect(state, local, NS_VALUE, REF_READ | REF_EXPORTED);
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
    descendVisit(state, node, visit);
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

/** Associate a scope-owning NODE with an existing scope, exactly as `newScope` does during
 *  `analyze` (`scopes[id].node` + the `nodeScope` reverse index). A lowering that mints a scope —
 *  or reuses one — for a node it has just BUILT must call this: `createScope` cannot, because the
 *  node does not exist yet at the point the scope is needed (an enum's IIFE param is declared
 *  before the `FunctionExpression` wrapping it is constructed).
 *
 *  Without it the scope is invisible to `scopeOf`/`ctx.currentScope`, so every name resolved inside
 *  that region silently resolves from the WRONG scope — the defect that forced a full post-lowering
 *  `analyze()` rebuild. */
export function attachScopeNode(semantic: Semantic, scope: number, node: Node): void {
    semantic.scopes[scope].node = node;
    semantic.nodeScope.set(node, scope);
    semantic.scopeOwnerTypes[node.type] = 1;
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
