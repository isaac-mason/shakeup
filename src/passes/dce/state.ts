// Port of oxc_minifier/src/state.rs for `CompressionMode::TreeShakeOnly`.

import type { CompressOptions } from './options.ts';
import { createSymbolState, type SymbolState } from './symbol-state.ts';
import type { Reference, Scoping } from './traverse-context.ts';

/** oxc `SourceType`'s module kind: an ES module, a Script, or a CommonJS module. */
export type SourceType = 'module' | 'script' | 'commonjs';

export const sourceTypeIsModule = (sourceType: SourceType): boolean => sourceType === 'module';
export const sourceTypeIsScript = (sourceType: SourceType): boolean => sourceType === 'script';

/** Changes accumulated between two pass-completion boundaries, consumed by `compression-pass.ts`. */
export type PassChanges = {
    /** The completed pass changed facts or AST shape and needs another traversal. */
    revisitRequested: boolean;
    /** References whose node was removed this pass. */
    removedReferences: Reference[];
    /** `references_len()` at the last flush. References minted since are treated as live everywhere:
     *  never marked removed, never pruned (oxc's capacity guard). */
    referenceCapacity: number;
    /** At least one direct `eval(...)` call was dropped this pass. */
    directEvalDropped: boolean;
};

/** State associated with one enclosing function body or the program root. */
export type BodyFrame = {
    /** Semantic scope containing the body's top-level statements. */
    scopeId: number;
    /** A preceding statement could observe a later hoisted variable before its initializer runs. */
    hoistedVarInliningUnsafe: boolean;
    /** Source offset after the first unconditional top-level `super()` call. */
    thisInitializedAt: number | null;
};

export type MinifierState = {
    sourceType: SourceType;
    options: CompressOptions;
    symbols: SymbolState;
    /** One frame per enclosing function body, the program root at the bottom. Never empty. */
    bodyFrames: BodyFrame[];
    passChanges: PassChanges;
};

export function createMinifierState(sourceType: SourceType, options: CompressOptions, scoping: Scoping): MinifierState {
    return {
        sourceType,
        options,
        symbols: createSymbolState(sourceType, options, scoping),
        bodyFrames: [{ scopeId: scoping.rootScopeId, hoistedVarInliningUnsafe: false, thisInitializedAt: null }],
        passChanges: {
            revisitRequested: false,
            removedReferences: [],
            referenceCapacity: scoping.references.length,
            directEvalDropped: false,
        },
    };
}

export const lastBodyFrame = (state: MinifierState): BodyFrame => state.bodyFrames[state.bodyFrames.length - 1];

/** Whether Normalize's member-write scan should seed persistent metadata. In tree-shake-only mode only
 *  the `property_write_side_effects: false` opt-in drop reads it. */
export const shouldTrackMemberWriteEffects = (state: MinifierState): boolean => !state.options.treeshake.propertyWriteSideEffects;

export function requestRevisit(state: MinifierState): void {
    state.passChanges.revisitRequested = true;
}

/** Record an AST change and schedule the traversal needed to consume it. */
export function recordAstChange(state: MinifierState): void {
    requestRevisit(state);
}

/** Return whether the completed pass requested another traversal, then reset the signal. */
export function takeRevisitRequested(state: MinifierState): boolean {
    const requested = state.passChanges.revisitRequested;
    state.passChanges.revisitRequested = false;
    return requested;
}

export function passChangesAreClean(state: MinifierState): boolean {
    const changes = state.passChanges;
    return !changes.revisitRequested && changes.removedReferences.length === 0 && !changes.directEvalDropped;
}
