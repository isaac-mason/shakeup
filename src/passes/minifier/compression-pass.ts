// Port of oxc_minifier/src/compression_pass.rs: completion of Normalize and peephole passes.
//
// Mutation helpers accumulate removed references and dropped direct `eval` calls on `PassChanges`.
// Each pass ends at the same boundary: prune those references from the per-symbol lists, refresh
// direct-eval scope flags, then derive function reachability from the settled references.

import { N, type Node, walk } from '../../ast/index.ts';
import { peepholeOptimizations } from './peephole/index.ts';
import { passChangesAreClean, takeRevisitRequested } from './state.ts';
import { resetValues } from './symbol-state.ts';
import { analyze, deadReferencesAffectAnalysis } from './symbol-liveness.ts';
import { ScopeFlags, scopeContainsDirectEval } from './syntax.ts';
import { asDirectEvalCall, type DceCtx, referenceOf } from './traverse-context.ts';
import { compileWalker, hookNamesOf } from './traverse.ts';

/** Clear `DirectEval` from every scope, then set it again from each scope that still holds a direct
 *  `eval(...)` call up to the root. */
function refreshDirectEvalFlags(ctx: DceCtx, directEvalScopes: ReadonlySet<number>): void {
    const scoping = ctx.scoping;
    if (directEvalScopes.size === 0 && !scopeContainsDirectEval(scoping.scopeFlags[scoping.rootScopeId])) return;
    for (let scopeId = 0; scopeId < scoping.scopeFlags.length; scopeId++) scoping.scopeFlags[scopeId] &= ~ScopeFlags.DirectEval;
    for (const scopeId of directEvalScopes) {
        for (let scope = scopeId; scope > 0; scope = scoping.scopeParentIds[scope] ?? 0) {
            // An earlier scope already flagged this chain.
            if (scopeContainsDirectEval(scoping.scopeFlags[scope])) break;
            scoping.scopeFlags[scope] |= ScopeFlags.DirectEval;
        }
    }
}

/** The scopes that hold a live direct `eval(...)` call. */
function liveDirectEvalScopes(program: Node, ctx: DceCtx): Set<number> {
    const scopes = new Set<number>();
    walk(program, (visited) => {
        if (visited.type !== N.CallExpression) return;
        const callee = asDirectEvalCall(visited);
        if (callee === null) return;
        const reference = referenceOf(ctx, callee);
        if (reference !== null) scopes.add(reference.scopeId);
    });
    return scopes;
}

/** Debug guard: every reference about to be pruned must really be gone from the program. */
function assertNoOverPrune(program: Node, ctx: DceCtx): void {
    walk(program, (visited) => {
        if (visited.type !== N.IdentifierReference) return;
        const reference = referenceOf(ctx, visited);
        if (reference?.markedRemoved)
            throw new Error(
                `dce: over-prune, reference ${reference.id} (\`${visited.name}\`) is marked removed but still in the program`,
            );
    });
}

/** Debug guard run after the loop: every reference still listed for a symbol is in the program,
 *  except references minted during the loop. */
export function assertNoUnderPrune(program: Node, ctx: DceCtx, initialReferenceCount: number): void {
    const live = new Set<Node>();
    walk(program, (visited) => {
        if (visited.type === N.IdentifierReference) live.add(visited);
    });
    for (const list of ctx.scoping.resolvedReferences) {
        if (list === undefined) continue;
        for (const reference of list) {
            if (reference.id < initialReferenceCount && !live.has(reference.node))
                throw new Error(
                    `dce: under-prune, reference ${reference.id} (\`${reference.node.name}\`) is still listed but its node left the program`,
                );
        }
    }
}

/** Debug guard: every live direct `eval` call has `DirectEval` on its scope and every ancestor. */
function assertNoStaleDirectEval(program: Node, ctx: DceCtx): void {
    walk(program, (visited) => {
        if (visited.type !== N.CallExpression) return;
        const callee = asDirectEvalCall(visited);
        if (callee === null) return;
        const reference = referenceOf(ctx, callee);
        if (reference === null || reference.symbolId !== 0) return;
        for (let scope = reference.scopeId; scope > 0; scope = ctx.scoping.scopeParentIds[scope] ?? 0) {
            if (!scopeContainsDirectEval(ctx.scoping.scopeFlags[scope]))
                throw new Error(`dce: stale direct-eval flags, scope ${scope} is missing DirectEval for a live eval call`);
        }
    });
}

/** Consume the `PassChanges` accumulator: prune removed references, refresh direct-eval flags if an
 *  `eval(...)` call was dropped, and reset for the next pass. Returns whether liveness inputs changed. */
export function flushPassChanges(program: Node, ctx: DceCtx): boolean {
    const changes = ctx.state.passChanges;
    const hadRemovedReferences = changes.removedReferences.length > 0;
    const livenessInputsChanged = changes.directEvalDropped || (hadRemovedReferences && deadReferencesAffectAnalysis(ctx));

    if (hadRemovedReferences) {
        if (ctx.verify) assertNoOverPrune(program, ctx);
        // oxc `retain_resolved_references_excluding`, one pass per affected symbol.
        const affectedSymbols = new Set<number>();
        for (const reference of changes.removedReferences) {
            reference.pruned = true;
            reference.markedRemoved = false;
            if (reference.symbolId > 0) affectedSymbols.add(reference.symbolId);
        }
        for (const symbolId of affectedSymbols) {
            const list = ctx.scoping.resolvedReferences[symbolId];
            if (list !== undefined) ctx.scoping.resolvedReferences[symbolId] = list.filter((reference) => !reference.pruned);
        }
    }

    if (changes.directEvalDropped) refreshDirectEvalFlags(ctx, liveDirectEvalScopes(program, ctx));
    if (ctx.verify) assertNoStaleDirectEval(program, ctx);

    changes.removedReferences = [];
    changes.referenceCapacity = ctx.scoping.references.length;
    changes.directEvalDropped = false;
    return livenessInputsChanged;
}

/** Flush the pass's changes into scoping, then derive function reachability from them. */
function finishPass(program: Node, ctx: DceCtx, forceLivenessAnalysis: boolean): boolean {
    const livenessInputsChanged = flushPassChanges(program, ctx);
    return analyze(program, ctx, forceLivenessAnalysis || livenessInputsChanged);
}

function assertPassChangesClean(ctx: DceCtx): void {
    if (ctx.verify && !passChangesAreClean(ctx.state)) throw new Error('dce: pass changes were not consumed');
}

/** Finish Normalize before the unconditional first peephole pass. Its shape changes do not drive
 *  convergence, so the revisit request and any newly dead functions are consumed and ignored. */
export function finishNormalizePass(program: Node, ctx: DceCtx): void {
    takeRevisitRequested(ctx.state);
    finishPass(program, ctx, true);
    assertPassChangesClean(ctx);
}

const walkPeephole = compileWalker<DceCtx>(hookNamesOf(peepholeOptimizations));

/** Run and finish one peephole pass. Returns whether another pass is needed. */
export function runPeepholePass(program: Node, ctx: DceCtx): boolean {
    assertPassChangesClean(ctx);
    resetValues(ctx.state.symbols);
    walkPeephole(peepholeOptimizations, program, ctx);
    const revisitRequested = takeRevisitRequested(ctx.state);
    const newlyDead = finishPass(program, ctx, false);
    if (ctx.verify && newlyDead && !revisitRequested) throw new Error('dce: liveness progress without a recorded pass change');
    assertPassChangesClean(ctx);
    return revisitRequested || newlyDead;
}
