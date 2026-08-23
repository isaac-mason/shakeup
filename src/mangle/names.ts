// Ranking + name generation — stages 3-5 of the slot-liveness mangler (P1).
// Port of oxc_mangler `SlotRanking::tally` + `NameTable::generate` + `NameTable::apply`
// (llm/libs/oxc/crates/oxc_mangler/src/lib.rs:729-858).
//
//   tally    — count references per slot; hottest first.
//   generate — one short base54 name per slot, shortest first, skipping reserved candidates.
//   apply    — bucket names by length; give each length-bucket to the next batch of hottest slots,
//              but hand the names out in SLOT (declaration) order within a bucket so neighbouring
//              bindings get near-identical names (gzip locality; trick from Closure `RenameVars`).

import { base54 } from '../deconflict.ts';
import { SLOT_UNASSIGNED, type SlotResult } from './slots.ts';

export interface NameInput extends SlotResult {
    /** Reference count per symbol (drives which slot gets the shortest name). */
    refCount: readonly number[];
    /** A candidate mangled name is reserved (keyword / referenced global / export / kept) → skip it. */
    isReserved: (name: string) => boolean;
    symbolCount: number;
}

/** Assign every slotted symbol its mangled name. Returns `symbol id → name`. */
export function assignNames(input: NameInput): Map<number, string> {
    const { slots, totalSlots, refCount, isReserved, symbolCount } = input;

    // ── tally: reference count + member symbols per slot ──
    const freq = new Float64Array(totalSlots);
    const symsBySlot: number[][] = Array.from({ length: totalSlots }, () => []);
    for (let sym = 0; sym < symbolCount; sym++) {
        const slot = slots[sym];
        if (slot === SLOT_UNASSIGNED) continue;
        freq[slot] += refCount[sym] ?? 0;
        symsBySlot[slot].push(sym);
    }

    // Slots that actually have symbols, hottest first. (Ties resolve by slot id via stable sort,
    // then apply re-sorts each length bucket by slot id anyway.)
    const ranked: number[] = [];
    for (let s = 0; s < totalSlots; s++) if (symsBySlot[s].length > 0) ranked.push(s);
    ranked.sort((a, b) => freq[b] - freq[a]);

    // ── generate: `ranked.length` names, shortest first, skipping reserved candidates ──
    const names: string[] = [];
    let candidate = 0;
    for (let i = 0; i < ranked.length; i++) {
        let name = base54(candidate++);
        while (isReserved(name)) name = base54(candidate++);
        names.push(name);
    }

    // ── apply: length-bucket the names; each bucket → next batch of hottest slots, named in slot order ──
    const out = new Map<number, string>();
    let ni = 0; // index into `names` (shortest first)
    let ri = 0; // index into `ranked` (hottest first)
    while (ni < names.length) {
        const len = names[ni].length;
        let end = ni;
        while (end < names.length && names[end].length === len) end++;
        const bucketNames = names.slice(ni, end); // the N names of this length
        const bucketSlots = ranked.slice(ri, ri + bucketNames.length); // the N hottest remaining slots
        // Hand names out in declaration (slot) order so neighbours get similar names.
        const bySlot = [...bucketSlots].sort((a, b) => a - b);
        for (let k = 0; k < bucketNames.length; k++) {
            for (const sym of symsBySlot[bySlot[k]]) out.set(sym, bucketNames[k]);
        }
        ni = end;
        ri += bucketNames.length;
    }
    return out;
}
