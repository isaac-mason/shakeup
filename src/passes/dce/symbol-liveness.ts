// Port of oxc_minifier/src/symbol_liveness/mod.rs.
//
// Reference counting removes an acyclic unused declaration once its last reference goes, but not
// `function a() { b() } function b() { a() }`: each keeps the other's count above zero. This adds
// the reachability question for function declarations (the candidates), plus the stable
// implicit-observability facts (module exports, Script roots, Annex B aliases, `using` disposal)
// that every count-based removal must respect. Analysis runs after scoping is flushed, from the
// settled resolved-reference lists.

import { type DataOf, N, type Node, walk } from '../../ast/index.ts';
import { boundNames } from './bound-names.ts';
import type { CompressOptions } from './options.ts';
import type { SourceType } from './state.ts';
import { ensureLiveness } from './symbol-state.ts';
import { referenceIsTypeOnly, scopeContainsDirectEval, scopeIsStrictMode, scopeIsVar } from './syntax.ts';
import { type DceCtx, getResolvedReferences, referenceOf, type Scoping, scopeAncestors, symbolIsUnused } from './traverse-context.ts';

/** The recursive-function reachability graph and its reused analysis buffers. */
type FunctionGraph = {
    /** Eligible functions still tracked. A non-dead candidate whose references all lie outside
     *  registered functions stops being tracked; graph-independent removal checks handle it. */
    candidates: Uint8Array;
    /** Each registered function declaration's own scope, mapped to its symbol (0 for none). */
    functionByScope: number[];
    /** Function symbols already published as unreachable. Monotonic. */
    dead: Uint8Array;
    scratch: GraphScratch;
};

type GraphScratch = {
    /** Functions proven live during the current analysis. */
    live: Uint8Array;
    /** Live functions whose owned references have not been propagated yet. */
    liveWorklist: number[];
    /** `[owner, target]` for each reference to `target` inside `owner`'s body. */
    ownedReferences: [number, number][];
    /** Candidates that no longer need graph reachability. */
    candidatesToUntrack: Uint8Array;
};

/** Stable program-wide symbol facts plus the optional recursive-function graph. */
export type SymbolLiveness = {
    /** Bindings with a runtime observer independent of resolved references. */
    implicitlyObservable: Uint8Array;
    recursiveFunctions: FunctionGraph | null;
};

/** Null when the configuration needs no symbol liveness: a non-module source with unused-declaration
 *  removal disabled. */
export function createSymbolLivenessIfEnabled(
    sourceType: SourceType,
    options: CompressOptions,
    scoping: Scoping,
): SymbolLiveness | null {
    const recursiveFunctionsEnabled = options.unused !== 'keep';
    if (sourceType !== 'module' && !recursiveFunctionsEnabled) return null;
    return createSymbolLiveness(sourceType, scoping);
}

/** Seed implicit observability; the function graph is created at the first registration. */
function createSymbolLiveness(sourceType: SourceType, scoping: Scoping): SymbolLiveness {
    const symbolCount = scoping.symbolFlags.length;
    const implicitlyObservable = new Uint8Array(symbolCount);
    if (sourceType === 'script') {
        // oxc `get_bindings(root_scope_id())`: every binding of the root scope.
        for (let symbolId = 1; symbolId < symbolCount; symbolId++) {
            if (scoping.symbolScopeIds[symbolId] === scoping.rootScopeId) implicitlyObservable[symbolId] = 1;
        }
    }
    return { implicitlyObservable, recursiveFunctions: null };
}

export const livenessIsImplicitlyObservable = (liveness: SymbolLiveness, symbolId: number): boolean =>
    liveness.implicitlyObservable[symbolId] === 1;

export const livenessFunctionIsDead = (liveness: SymbolLiveness, symbolId: number): boolean =>
    liveness.recursiveFunctions !== null && liveness.recursiveFunctions.dead[symbolId] === 1;

function markImplicitlyObservable(liveness: SymbolLiveness, symbolId: number): void {
    liveness.implicitlyObservable[symbolId] = 1;
}

function markBoundNames(liveness: SymbolLiveness, declaration: Node): void {
    boundNames(declaration, (ident) => {
        if (ident.sym > 0) markImplicitlyObservable(liveness, ident.sym);
    });
}

function createFunctionGraph(scoping: Scoping): FunctionGraph {
    const symbolCount = scoping.symbolFlags.length;
    const functionByScope: number[] = new Array(scoping.scopeFlags.length);
    for (let index = 0; index < functionByScope.length; index++) functionByScope[index] = 0;
    return {
        candidates: new Uint8Array(symbolCount),
        functionByScope,
        dead: new Uint8Array(symbolCount),
        scratch: {
            live: new Uint8Array(symbolCount),
            liveWorklist: [],
            ownedReferences: [],
            candidatesToUntrack: new Uint8Array(symbolCount),
        },
    };
}

function livenessRegisterFunction(liveness: SymbolLiveness, fn: Node, sourceType: SourceType, scoping: Scoping): void {
    const id = (fn.data as DataOf<'FunctionDeclaration'>).id;
    const symbolId = id === null ? 0 : id.sym;
    if (symbolId === 0) return;
    const scopeId = (fn.data as { scopeId: number }).scopeId;
    if (!(scopeId > 0)) return;

    const bindingScopeId = scoping.symbolScopeIds[symbolId];

    // Annex B block functions also write their function object to a var-like alias the block-scoped
    // symbol does not represent, so they are observable without a resolved reference.
    const bindingScopeFlags = scoping.scopeFlags[bindingScopeId] ?? 0;
    const data = fn.data as { async: boolean; generator: boolean };
    if (!data.async && !data.generator && !scopeIsVar(bindingScopeFlags) && !scopeIsStrictMode(bindingScopeFlags)) {
        markImplicitlyObservable(liveness, symbolId);
        return;
    }

    // Script root bindings were seeded implicitly observable; only graph candidacy is skipped.
    if (sourceType === 'script' && bindingScopeId === scoping.rootScopeId) return;

    if (liveness.recursiveFunctions === null) liveness.recursiveFunctions = createFunctionGraph(scoping);
    const graph = liveness.recursiveFunctions;
    graph.functionByScope[scopeId] = symbolId;
    graph.candidates[symbolId] = 1;
}

/** The nearest registered function whose body contains `scopeId`, or 0 outside every registered one. */
function graphOwner(graph: FunctionGraph, scoping: Scoping, scopeId: number): number {
    for (const scope of scopeAncestors(scoping, scopeId)) {
        const owner = graph.functionByScope[scope] ?? 0;
        if (owner !== 0) return owner;
    }
    return 0;
}

function scratchMarkLive(scratch: GraphScratch, symbolId: number): void {
    if (scratch.live[symbolId] === 0) {
        scratch.live[symbolId] = 1;
        scratch.liveWorklist.push(symbolId);
    }
}

/** Mark the direct targets referenced by `owner` live. `ownedReferences` is sorted by owner. */
function scratchMarkTargetsLive(scratch: GraphScratch, owner: number): void {
    const owned = scratch.ownedReferences;
    let low = 0;
    let high = owned.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (owned[middle][0] < owner) low = middle + 1;
        else high = middle;
    }
    for (let index = low; index < owned.length && owned[index][0] === owner; index++) scratchMarkLive(scratch, owned[index][1]);
}

function scratchPropagateLiveness(scratch: GraphScratch, candidates: Uint8Array): void {
    // References owned by functions no longer in the graph cannot propagate.
    scratch.ownedReferences = scratch.ownedReferences.filter(([owner]) => candidates[owner] === 1);
    scratch.ownedReferences.sort((left, right) => left[0] - right[0]);
    while (scratch.liveWorklist.length > 0) {
        const owner = scratch.liveWorklist.pop() as number;
        // Seeded before it was untracked: its targets were handled by graph-independent liveness.
        if (candidates[owner] === 0) continue;
        scratchMarkTargetsLive(scratch, owner);
    }
}

/** Rebuild reachability and report whether a newly dead function was published. */
function graphAnalyze(graph: FunctionGraph, ctx: DceCtx, implicitlyObservable: Uint8Array): boolean {
    const scoping = ctx.scoping;
    if (scopeContainsDirectEval(scoping.scopeFlags[scoping.rootScopeId])) {
        if (ctx.verify && graph.dead.includes(1)) throw new Error('dce: direct eval formed after liveness was published');
        graph.dead.fill(0);
        return false;
    }

    const scratch = graph.scratch;
    scratch.live.fill(0);
    scratch.liveWorklist.length = 0;
    scratch.ownedReferences = [];
    scratch.candidatesToUntrack.fill(0);

    // Phase 1: classify every current reference to a candidate.
    const symbolCount = graph.candidates.length;
    for (let target = 0; target < symbolCount; target++) {
        if (graph.candidates[target] === 0) continue;
        if (implicitlyObservable[target] === 1) scratchMarkLive(scratch, target);
        let hasRegisteredFunctionOwner = false;
        for (const reference of getResolvedReferences(ctx, target)) {
            const owner = graphOwner(graph, scoping, reference.scopeId);
            if (owner === 0) {
                scratchMarkLive(scratch, target);
                continue;
            }
            hasRegisteredFunctionOwner = true;
            if (implicitlyObservable[owner] === 1) {
                scratchMarkLive(scratch, target);
                continue;
            }
            if (graph.candidates[owner] === 1) scratch.ownedReferences.push([owner, target]);
            // A registered non-candidate owner keeps the target live only while its body can run.
            else if (!symbolIsUnused(ctx, owner)) scratchMarkLive(scratch, target);
        }
        if (!hasRegisteredFunctionOwner && graph.dead[target] === 0) scratch.candidatesToUntrack[target] = 1;
    }

    // Phase 2: untrack owners that no longer need graph reachability.
    for (const [owner, target] of scratch.ownedReferences) {
        const ownerLeavesGraph = scratch.candidatesToUntrack[owner] === 1;
        if (ownerLeavesGraph && !symbolIsUnused(ctx, owner)) scratchMarkLive(scratch, target);
    }
    for (let symbolId = 0; symbolId < symbolCount; symbolId++) {
        if (scratch.candidatesToUntrack[symbolId] === 1) graph.candidates[symbolId] = 0;
    }

    if (ctx.verify) {
        for (let symbolId = 0; symbolId < symbolCount; symbolId++) {
            if (graph.dead[symbolId] === 1 && graph.candidates[symbolId] === 0)
                throw new Error(`dce: dead function symbol ${symbolId} was untracked`);
        }
    }

    // Phase 3: propagate from unconditional live seeds through references owned by live candidates.
    scratchPropagateLiveness(scratch, graph.candidates);

    if (ctx.verify) {
        for (let symbolId = 0; symbolId < symbolCount; symbolId++) {
            if (graph.dead[symbolId] === 1 && scratch.live[symbolId] === 1)
                throw new Error(`dce: function liveness resurrected dead symbol ${symbolId}`);
        }
    }

    // Phase 4: publish newly unreachable candidates. Existing dead bits stay as tombstones.
    let publishedNewDead = false;
    for (let symbolId = 0; symbolId < symbolCount; symbolId++) {
        if (graph.candidates[symbolId] === 1 && scratch.live[symbolId] === 0 && graph.dead[symbolId] === 0) {
            graph.dead[symbolId] = 1;
            publishedNewDead = true;
        }
    }
    return publishedNewDead;
}

/** Normalize hook: register a function declaration as a potential graph candidate. */
export function registerFunction(ctx: DceCtx, fn: Node): void {
    if (fn.type !== N.FunctionDeclaration) return;
    if (ctx.state.options.unused === 'keep') return;
    const liveness = ctx.state.symbols.liveness;
    if (liveness !== null) livenessRegisterFunction(liveness, fn, ctx.state.sourceType, ctx.scoping);
}

/** Normalize hook: disposal reads a `using` binding through runtime state, not a resolved reference. */
export function registerUsingDeclaration(ctx: DceCtx, declaration: Node): void {
    const kind = (declaration.data as { kind: string }).kind;
    if (kind !== 'using' && kind !== 'await using') return;
    const liveness = ensureLiveness(ctx.state.symbols, () => createSymbolLiveness(ctx.state.sourceType, ctx.scoping));
    markBoundNames(liveness, declaration);
}

/** Normalize hook: the runtime bindings an exported declaration exposes. */
export function registerExportDeclaration(ctx: DceCtx, exportDeclaration: Node): void {
    const liveness = ctx.state.symbols.liveness;
    if (liveness === null) return;
    const data = exportDeclaration.data as { declaration: Node | null; exportKind: string };
    if (data.exportKind !== 'type' && data.declaration !== null) markBoundNames(liveness, data.declaration);
}

/** Normalize hook: the local bindings a named export (`export { a }`) exposes. */
export function registerNamedExport(ctx: DceCtx, exportDeclaration: Node): void {
    const data = exportDeclaration.data as { specifiers: Node[]; exportKind: string };
    if (data.exportKind === 'type') return;
    const liveness = ctx.state.symbols.liveness;
    if (liveness === null) return;
    for (const specifier of data.specifiers) {
        if (specifier.type !== N.ExportSpecifier || specifier.data.exportKind === 'type') continue;
        const local = specifier.data.local;
        if (local.type !== N.IdentifierReference) continue;
        const reference = referenceOf(ctx, local);
        if (reference === null || referenceIsTypeOnly(reference.flags)) continue;
        if (reference.symbolId > 0) markImplicitlyObservable(liveness, reference.symbolId);
    }
}

/** Normalize hook: the local binding of a named default function or class. `export default ident`
 *  exports the evaluated value, not later writes to the binding, so it is excluded. */
export function registerDefaultExport(ctx: DceCtx, exportDefault: Node): void {
    const declaration = (exportDefault.data as DataOf<'ExportDefaultDeclaration'>).declaration;
    let symbolId = 0;
    if (declaration.type === N.FunctionDeclaration || declaration.type === N.ClassDeclaration) {
        const id = declaration.data.id as Node | null;
        symbolId = id === null ? 0 : id.sym;
    }
    const liveness = ctx.state.symbols.liveness;
    if (symbolId > 0 && liveness !== null) markImplicitlyObservable(liveness, symbolId);
}

/** Whether pruning this pass's removed references can change a graph input. */
export function deadReferencesAffectAnalysis(ctx: DceCtx): boolean {
    const liveness = ctx.state.symbols.liveness;
    if (liveness === null) return false;
    const graph = liveness.recursiveFunctions;
    if (graph === null) return false;
    // Disabled while the root holds a direct eval; dropping the last eval forces a recompute anyway.
    if (scopeContainsDirectEval(ctx.scoping.scopeFlags[ctx.scoping.rootScopeId])) return false;
    return ctx.state.passChanges.removedReferences.some(
        (reference) => reference.symbolId > 0 && graph.candidates[reference.symbolId] === 1,
    );
}

/** Check that every previously published dead declaration was removed, then optionally recompute. */
export function analyze(program: Node, ctx: DceCtx, recompute: boolean): boolean {
    const liveness = ctx.state.symbols.liveness;
    if (ctx.verify && liveness !== null && liveness.recursiveFunctions !== null) {
        assertDeadFunctionDeclarationsRemoved(program, liveness.recursiveFunctions.dead);
    }
    if (!recompute || liveness === null || liveness.recursiveFunctions === null) return false;
    return graphAnalyze(liveness.recursiveFunctions, ctx, liveness.implicitlyObservable);
}

function assertDeadFunctionDeclarationsRemoved(program: Node, dead: Uint8Array): void {
    if (!dead.includes(1)) return;
    walk(program, (visited) => {
        if (visited.type !== N.FunctionDeclaration) return;
        const id = visited.data.id as Node | null;
        if (id !== null && id.sym > 0 && dead[id.sym] === 1)
            throw new Error(`dce: dead function \`${id.name}\` survived the pass after its deadness was published`);
    });
}
