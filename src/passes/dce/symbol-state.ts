// Port of oxc_minifier/src/symbol_state.rs.

import type { CompressOptions } from './options.ts';
import type { SourceType } from './state.ts';
import {
    createPersistentSymbolMetadata,
    type FunctionSummary,
    MemberWriteEffect,
    type PersistentSymbolMetadata,
    recordMemberWriteEffectOn,
} from './symbol-metadata.ts';
import {
    createSymbolLivenessIfEnabled,
    livenessFunctionIsDead,
    livenessIsImplicitlyObservable,
    type SymbolLiveness,
} from './symbol-liveness.ts';
import type { SymbolValue } from './symbol-value.ts';
import type { Scoping } from './traverse-context.ts';

/** Symbol-indexed data owned by the minifier: per-pass values, persistent metadata, liveness. */
export type SymbolState = {
    /** Per-pass scratch indexed by symbol id, rebuilt each peephole pass. */
    values: (SymbolValue | null)[];
    persistent: Map<number, PersistentSymbolMetadata>;
    liveness: SymbolLiveness | null;
};

export function createSymbolState(sourceType: SourceType, options: CompressOptions, scoping: Scoping): SymbolState {
    const values: (SymbolValue | null)[] = new Array(scoping.symbolFlags.length);
    for (let index = 0; index < values.length; index++) values[index] = null;
    return { values, persistent: new Map(), liveness: createSymbolLivenessIfEnabled(sourceType, options, scoping) };
}

/** oxc `SymbolState::reset_values`. */
export function resetValues(symbols: SymbolState): void {
    for (let index = 0; index < symbols.values.length; index++) symbols.values[index] = null;
}

/** oxc `SymbolState::init_value`. */
export function storeSymbolValue(symbols: SymbolState, symbolId: number, value: SymbolValue): void {
    symbols.values[symbolId] = value;
}

/** oxc `SymbolState::value`. */
export const symbolValueOf = (symbols: SymbolState, symbolId: number): SymbolValue | null => symbols.values[symbolId] ?? null;

function persistentEntry(symbols: SymbolState, symbolId: number): PersistentSymbolMetadata {
    let metadata = symbols.persistent.get(symbolId);
    if (metadata === undefined) {
        metadata = createPersistentSymbolMetadata();
        symbols.persistent.set(symbolId, metadata);
    }
    return metadata;
}

export function setFunctionSummary(symbols: SymbolState, symbolId: number, summary: FunctionSummary): void {
    persistentEntry(symbols, symbolId).functionSummary = summary;
}

export function clearFunctionSummary(symbols: SymbolState, symbolId: number): void {
    // Cleared in place: removing the shared entry would also erase its monotone member-write effect.
    const metadata = symbols.persistent.get(symbolId);
    if (metadata !== undefined) metadata.functionSummary = 'unknown';
}

export const functionSummary = (symbols: SymbolState, symbolId: number): FunctionSummary =>
    symbols.persistent.get(symbolId)?.functionSummary ?? 'unknown';

export function recordMemberWriteEffect(symbols: SymbolState, symbolId: number, effect: MemberWriteEffect): void {
    recordMemberWriteEffectOn(persistentEntry(symbols, symbolId), effect);
}

export const memberWriteEffect = (symbols: SymbolState, symbolId: number): MemberWriteEffect =>
    symbols.persistent.get(symbolId)?.memberWriteEffect ?? MemberWriteEffect.None;

/** Whether the binding has an observer independent of its resolved references. False without liveness state. */
export const isImplicitlyObservable = (symbols: SymbolState, symbolId: number): boolean =>
    symbols.liveness !== null && livenessIsImplicitlyObservable(symbols.liveness, symbolId);

/** Whether post-flush graph analysis proved a function declaration unreachable. */
export const functionIsDead = (symbols: SymbolState, symbolId: number): boolean =>
    symbols.liveness !== null && livenessFunctionIsDead(symbols.liveness, symbolId);

export function ensureLiveness(symbols: SymbolState, create: () => SymbolLiveness): SymbolLiveness {
    if (symbols.liveness === null) symbols.liveness = create();
    return symbols.liveness;
}
