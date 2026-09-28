// Port of oxc_minifier/src/state.rs.

import type { CompressOptions } from './options.ts';
import { createSymbolState, type SymbolState } from './symbol-state.ts';
import type { Reference, Scoping } from './traverse-context.ts';

/** oxc `CompressionMode`: the full minifier, or the tree-shake-only pipeline rolldown runs per module
 *  and for `minify: 'dce-only'`, which removes dead code without otherwise shrinking the output. */
export type CompressionMode = 'full' | 'tree-shake-only';

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

/** oxc `PrivateMemberUsageStack`: the `#name`s used in each enclosing class, the root at the bottom. */
export type PrivateMemberUsage = Set<string>[];

export type MinifierState = {
    sourceType: SourceType;
    options: CompressOptions;
    mode: CompressionMode;
    symbols: SymbolState;
    privateMemberUsage: PrivateMemberUsage;
    /** One frame per enclosing function body, the program root at the bottom. Never empty. */
    bodyFrames: BodyFrame[];
    passChanges: PassChanges;
};

export function createMinifierState(
    sourceType: SourceType,
    options: CompressOptions,
    mode: CompressionMode,
    scoping: Scoping,
): MinifierState {
    return {
        sourceType,
        options,
        mode,
        symbols: createSymbolState(sourceType, options, scoping),
        privateMemberUsage: [new Set()],
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

export const isTreeShakeOnly = (state: MinifierState): boolean => state.mode === 'tree-shake-only';

/** Whether Normalize's member-write scan should seed persistent metadata: always in full minify, where the
 *  write-only property drop reads it; in tree-shake-only mode only for the `property_write_side_effects:
 *  false` opt-in drop. */
export const shouldTrackMemberWriteEffects = (state: MinifierState): boolean =>
    !isTreeShakeOnly(state) || !state.options.treeshake.propertyWriteSideEffects;

/** Whether every class scope has been exited. */
export const privateMembersAtRoot = (usage: PrivateMemberUsage): boolean => usage.length === 1;

export function enterClassPrivateMembers(usage: PrivateMemberUsage): void {
    usage.push(new Set());
}

/** Exit a class and carry uses of names an outer class declares out to it. */
export function exitClassPrivateMembers(usage: PrivateMemberUsage, declared: Iterable<string>): void {
    const used = usage.pop() as Set<string>;
    for (const name of declared) used.delete(name);
    const outer = usage[usage.length - 1];
    for (const name of used) outer.add(name);
}

export const recordPrivateMemberUse = (usage: PrivateMemberUsage, name: string): void => {
    usage[usage.length - 1].add(name);
};

export const privateMemberIsUsed = (usage: PrivateMemberUsage, name: string): boolean => usage[usage.length - 1].has(name);

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
