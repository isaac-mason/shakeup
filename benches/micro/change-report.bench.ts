import { bench, group } from '@pmndrs/labs';

// SPIKE 1 for `llm/notes/compressor-perf-plan.md` §1: how should a compress pass REPORT that it
// changed something, so the fixed point can skip unchanged scopes next round?
//
// Measured first (spike-0): rounds 3-6 of the chunk-level fixed point mutate 77 / 11 / 1 / 0 scopes
// out of ~1,700 and still cost ~41ms each, because every round re-walks the whole tree. Skipping
// clean scopes is worth ~170ms of a 309ms loop. But the report has to happen on the HOT path — every
// `ctx.changed = true` — so if reporting costs more than skipping saves, there is no win.
//
// Spike-0 also killed the original plan of hooking `traverse`'s maintenance API: a dozen-plus passes
// set `ctx.changed = true` DIRECTLY (`inline.ts:216`, `boolean-context.ts:135,156,169`,
// `drop-unused.ts:139`, ...), bypassing it entirely. Instrumenting only the five mutation methods
// reported ZERO dirty scopes in rounds 5-6 while the loop was still running. So the hook has to be on
// `changed` itself.
//
// ARMS. (1) plain field, today. (2) the same, as a CONTROL — must read ~1.00x or the numbers are not
// admissible. (3) accessor that only assigns, isolating the cost of making a hot field a property.
// (4) accessor that assigns AND records the scope — the actual candidate. (5) an explicit
// `markChanged()` method instead of an accessor, which every pass would have to be edited to call.
//
// Closure needs 483 hand-written `reportChangeToEnclosingScope` call sites for arm 5's shape. Arm 4
// gets the same coverage from one hook, which is why it is the candidate — IF it is not slower.
//
// WRITE RATE. Not every visit changes something. Round 1 of the real loop set `changed` often; round 6
// never. The rate is swept (1-in-4, 1-in-64, never) because the arms' relative cost depends on it and
// the later rounds — the ones this optimisation targets — are the SPARSE end.

const N_VISITS = 200_000;
const SCOPES = 1_700;

/** A deterministic pseudo-random walk order so every arm does identical work. */
function scopeSeq(n: number): Int32Array {
    const a = new Int32Array(n);
    let x = 12_345;
    for (let i = 0; i < n; i++) {
        x = (x * 1_103_515_245 + 12_345) & 0x7fffffff;
        a[i] = x % SCOPES;
    }
    return a;
}
const SEQ = scopeSeq(N_VISITS);

// ── arm 1: plain field (today) ────────────────────────────────────────────────
class CtxPlain {
    changed = false;
    currentScope = 0;
}
const CTX_PLAIN = new CtxPlain();
function runPlain(every: number): number {
    const ctx = CTX_PLAIN;
    ctx.changed = false;
    for (let i = 0; i < N_VISITS; i++) {
        ctx.currentScope = SEQ[i];
        if (every !== 0 && i % every === 0) ctx.changed = true;
    }
    return ctx.changed ? 1 : 0;
}

// ── arm 2: plain field, CONTROL (textually separate, per harness discipline) ──
class CtxControl {
    changed = false;
    currentScope = 0;
}
const CTX_CONTROL = new CtxControl();
function runControl(every: number): number {
    const ctx = CTX_CONTROL;
    ctx.changed = false;
    for (let i = 0; i < N_VISITS; i++) {
        ctx.currentScope = SEQ[i];
        if (every !== 0 && i % every === 0) ctx.changed = true;
    }
    return ctx.changed ? 1 : 0;
}

// ── arm 3: accessor, assign only (isolates the property cost) ────────────────
class CtxAccessorBare {
    _changed = false;
    currentScope = 0;
    get changed(): boolean {
        return this._changed;
    }
    set changed(v: boolean) {
        this._changed = v;
    }
}
const CTX_BARE = new CtxAccessorBare();
function runAccessorBare(every: number): number {
    const ctx = CTX_BARE;
    ctx.changed = false;
    for (let i = 0; i < N_VISITS; i++) {
        ctx.currentScope = SEQ[i];
        if (every !== 0 && i % every === 0) ctx.changed = true;
    }
    return ctx.changed ? 1 : 0;
}

// ── arm 4: accessor that stamps the scope — THE CANDIDATE ────────────────────
class CtxAccessorStamp {
    _changed = false;
    currentScope = 0;
    dirty = new Set<number>();
    get changed(): boolean {
        return this._changed;
    }
    set changed(v: boolean) {
        if (v) this.dirty.add(this.currentScope);
        this._changed = v;
    }
}
const CTX_STAMP = new CtxAccessorStamp();
function runAccessorStamp(every: number): number {
    const ctx = CTX_STAMP;
    ctx.dirty.clear();
    ctx._changed = false;
    for (let i = 0; i < N_VISITS; i++) {
        ctx.currentScope = SEQ[i];
        if (every !== 0 && i % every === 0) ctx.changed = true;
    }
    return ctx.changed ? 1 : 0;
}

// ── arm 5: explicit method — Closure's shape, every pass edited to call it ────
class CtxMethod {
    changed = false;
    currentScope = 0;
    dirty = new Set<number>();
    markChanged(): void {
        this.dirty.add(this.currentScope);
        this.changed = true;
    }
}
const CTX_METHOD = new CtxMethod();
function runMethod(every: number): number {
    const ctx = CTX_METHOD;
    ctx.dirty.clear();
    ctx.changed = false;
    for (let i = 0; i < N_VISITS; i++) {
        ctx.currentScope = SEQ[i];
        if (every !== 0 && i % every === 0) ctx.markChanged();
    }
    return ctx.changed ? 1 : 0;
}

// ── arm 6: Int32Array STAMP — what Closure actually does ─────────────────────
// Closure records `n.getChangeTime()`, an integer, and compares it against when the pass last ran.
// It never builds a set. Arms 4/5 above modelled it as a `Set<number>` and paid 6.6x for the hashing
// in the dense case; an array write indexed by scope id has none of that, and answering "is this
// scope dirty" becomes `stamp[id] === round` instead of a hash lookup.
class CtxStampArray {
    _changed = false;
    currentScope = 0;
    round = 1;
    stamp = new Int32Array(SCOPES);
    get changed(): boolean {
        return this._changed;
    }
    set changed(v: boolean) {
        if (v) this.stamp[this.currentScope] = this.round;
        this._changed = v;
    }
}
const CTX_ARRAY = new CtxStampArray();
function runStampArray(every: number): number {
    const ctx = CTX_ARRAY;
    ctx.round++;
    ctx._changed = false;
    for (let i = 0; i < N_VISITS; i++) {
        ctx.currentScope = SEQ[i];
        if (every !== 0 && i % every === 0) ctx.changed = true;
    }
    return ctx.changed ? 1 : 0;
}

// ── arm 7: plain number[] stamp ──────────────────────────────────────────────
// Is a typed array actually needed? A dense JS array holding only small ints is PACKED_SMI_ELEMENTS
// in V8 — a Smi-tagged backing store, no boxing — so the write should be comparable. What it does
// NOT give you is a guarantee: one hole or one non-Smi and the elements kind degrades, silently and
// permanently. This arm measures whether the guarantee costs anything to have.
class CtxStampNumArr {
    _changed = false;
    currentScope = 0;
    round = 1;
    stamp: number[] = new Array(SCOPES).fill(0);
    get changed(): boolean {
        return this._changed;
    }
    set changed(v: boolean) {
        if (v) this.stamp[this.currentScope] = this.round;
        this._changed = v;
    }
}
const CTX_NUMARR = new CtxStampNumArr();
function runStampNumArr(every: number): number {
    const ctx = CTX_NUMARR;
    ctx.round++;
    ctx._changed = false;
    for (let i = 0; i < N_VISITS; i++) {
        ctx.currentScope = SEQ[i];
        if (every !== 0 && i % every === 0) ctx.changed = true;
    }
    return ctx.changed ? 1 : 0;
}

for (const [label, every] of [
    ['dense  (1 change in 4)  — round 1', 4],
    ['sparse (1 change in 64) — round 3', 64],
    ['none   (0 changes)      — round 6', 0],
] as [string, number][]) {
    group(`change reporting — ${label}`, () => {
        bench('plain field (today)', () => runPlain(every));
        bench('plain field (CONTROL)', () => runControl(every));
        bench('accessor, assign only', () => runAccessorBare(every));
        bench('accessor + stamp scope', () => runAccessorStamp(every));
        bench('explicit markChanged()', () => runMethod(every));
        bench('accessor + Int32Array stamp', () => runStampArray(every));
        bench('accessor + number[] stamp', () => runStampNumArr(every));
    });
}
