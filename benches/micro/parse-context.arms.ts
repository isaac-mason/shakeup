// Arms for `parse-context.paired.ts`: should shakeup's parse-context flags move from ~12 separate
// `ParserState` fields into one packed bitfield, as oxc does (`oxc_parser/src/context.rs`, a `u16`
// with scoped `context_add`/`context_remove`)?
//
// The HAZARD is real and not hypothetical: `awaitOk`, `allowTopReturn`, `allowTopNewTarget`,
// `fnDepth`, `newTargetDepth`, `thisDepth`, `tsMode`, `jsxMode`, `sawEsmExport`, `sawEsmImport`,
// `sawTopLevelAwait`, `sawRequire` — four of those were added in a single session, and each
// save/restore is hand-written at every call site. oxc's scoped helper cannot forget to restore.
//
// The QUESTION here is only cost. Reading and writing a field on a monomorphic object is already
// about as cheap as V8 gets, so this is a "reshape the same work" change — the category this repo's
// notes log as usually washing or regressing. Measure before writing any src.

const N = 300_000;

/** A — today: separate boolean/number fields on one monomorphic object. */
type FieldState = {
    awaitOk: boolean;
    yieldOk: boolean;
    inClass: boolean;
    ts: boolean;
    jsx: boolean;
    fnDepth: number;
    acc: number;
};
const mkFields = (): FieldState => ({ awaitOk: false, yieldOk: false, inClass: false, ts: true, jsx: false, fnDepth: 0, acc: 0 });

export function fields(): number {
    const s = mkFields();
    for (let i = 0; i < N; i++) {
        // Enter a scope: save, set, ... restore. The shape every parse function repeats by hand.
        const savedAwait = s.awaitOk;
        const savedYield = s.yieldOk;
        s.awaitOk = true;
        s.yieldOk = false;
        s.fnDepth++;
        if (s.awaitOk && !s.yieldOk && s.ts) s.acc++;
        if (s.fnDepth > 0 && !s.inClass) s.acc++;
        s.fnDepth--;
        s.awaitOk = savedAwait;
        s.yieldOk = savedYield;
    }
    return s.acc;
}

/** A' — byte-identical copy of A. NEGATIVE CONTROL. */
export function fields2(): number {
    const s = mkFields();
    for (let i = 0; i < N; i++) {
        const savedAwait = s.awaitOk;
        const savedYield = s.yieldOk;
        s.awaitOk = true;
        s.yieldOk = false;
        s.fnDepth++;
        if (s.awaitOk && !s.yieldOk && s.ts) s.acc++;
        if (s.fnDepth > 0 && !s.inClass) s.acc++;
        s.fnDepth--;
        s.awaitOk = savedAwait;
        s.yieldOk = savedYield;
    }
    return s.acc;
}

const AWAIT = 1 << 0;
const YIELD = 1 << 1;
const IN_CLASS = 1 << 2;
const TS = 1 << 3;
const JSX = 1 << 4;

/** B — oxc's shape: one integer, bit-tested. Save/restore is ONE word, which is the ergonomic win. */
type BitState = { ctx: number; fnDepth: number; acc: number };
export function bitfield(): number {
    const s: BitState = { ctx: TS, fnDepth: 0, acc: 0 };
    for (let i = 0; i < N; i++) {
        const saved = s.ctx;
        s.ctx = (s.ctx | AWAIT) & ~YIELD;
        s.fnDepth++;
        if ((s.ctx & AWAIT) !== 0 && (s.ctx & YIELD) === 0 && (s.ctx & TS) !== 0) s.acc++;
        if (s.fnDepth > 0 && (s.ctx & IN_CLASS) === 0) s.acc++;
        s.fnDepth--;
        s.ctx = saved;
    }
    return s.acc;
}

/** C — bitfield with the depth counters folded into the same word (bits 8+), so scope entry/exit is
 *  a single save/restore with no separate decrement. The furthest version of the idea. */
export function bitfieldPacked(): number {
    let ctx = TS;
    let acc = 0;
    for (let i = 0; i < N; i++) {
        const saved = ctx;
        ctx = ((ctx | AWAIT) & ~YIELD) + (1 << 8);
        if ((ctx & AWAIT) !== 0 && (ctx & YIELD) === 0 && (ctx & TS) !== 0) acc++;
        if (ctx >>> 8 > 0 && (ctx & IN_CLASS) === 0) acc++;
        ctx = saved;
    }
    return acc;
}
