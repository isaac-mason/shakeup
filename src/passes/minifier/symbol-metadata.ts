// Port of oxc_minifier/src/symbol_metadata.rs.

/** What the minifier has proved about calls to a locally declared function. */
export type FunctionSummary = 'unknown' | 'side-effect-free' | 'side-effect-free-returns-undefined';

export const functionSummaryIsSideEffectFree = (summary: FunctionSummary): boolean =>
    summary === 'side-effect-free' || summary === 'side-effect-free-returns-undefined';

export const functionSummaryReturnsUndefined = (summary: FunctionSummary): boolean =>
    summary === 'side-effect-free-returns-undefined';

/** The strongest program-wide effect recorded for member writes to a symbol. A monotone order, so the
 *  values are comparable numbers. */
export const MemberWriteEffect = { None: 0, Hazard: 1, MayMutatePrototype: 2 } as const;
export type MemberWriteEffect = (typeof MemberWriteEffect)[keyof typeof MemberWriteEffect];

export const memberWriteEffectIsHazardous = (effect: MemberWriteEffect): boolean => effect >= MemberWriteEffect.Hazard;

export const memberWriteEffectMayMutatePrototype = (effect: MemberWriteEffect): boolean =>
    effect >= MemberWriteEffect.MayMutatePrototype;

/** Metadata that remains valid across peephole iterations for one symbol. */
export type PersistentSymbolMetadata = {
    functionSummary: FunctionSummary;
    memberWriteEffect: MemberWriteEffect;
};

export function createPersistentSymbolMetadata(): PersistentSymbolMetadata {
    return { functionSummary: 'unknown', memberWriteEffect: MemberWriteEffect.None };
}

export function recordMemberWriteEffectOn(metadata: PersistentSymbolMetadata, effect: MemberWriteEffect): void {
    if (effect > metadata.memberWriteEffect) metadata.memberWriteEffect = effect;
}
