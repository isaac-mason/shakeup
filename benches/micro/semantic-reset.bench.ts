import { bench, group } from '@pmndrs/labs';

// `resetSem` clears the per-module tables on every `analyze` — 99 times per crashcat bundle. The
// PREMISE behind touching this is that `Map.clear()` does not preserve capacity, so each call re-grows
// from empty. That premise is tested here FIRST, because if clear() keeps its backing store the whole
// line of reasoning is wrong and nothing should change.
//
// Real sizes, measured: crashcat's median module has 30 scopes / 94 symbols, its largest 344 / 746;
// three.core.js has 4,393 / 7,332. 99 analyze calls per bundle.
const MODULES = 99;
const SIZES = [94, 94, 94, 200, 746];
const sizeFor = (i: number): number => SIZES[i % SIZES.length];

let EXPECT = -1;
const same = (v: number): number => {
    if (EXPECT === -1) EXPECT = v;
    else if (v !== EXPECT) throw new Error(`arm disagrees: ${v} vs ${EXPECT}`);
    return v;
};

// ── ARM 1: Map + clear() per module (today) ──────────────────────────────────────────────────────
function mapClear(): number {
    const uses = new Map<number, number>();
    let acc = 0;
    for (let m = 0; m < MODULES; m++) {
        uses.clear();
        const n = sizeFor(m);
        for (let k = 1; k <= n; k++) uses.set(k, k);
        for (let k = 1; k <= n; k++) acc += uses.get(k) ?? 0;
    }
    return acc;
}

// ── ARM 2: byte-identical CONTROL ────────────────────────────────────────────────────────────────
function mapClearControl(): number {
    const uses = new Map<number, number>();
    let acc = 0;
    for (let m = 0; m < MODULES; m++) {
        uses.clear();
        const n = sizeFor(m);
        for (let k = 1; k <= n; k++) uses.set(k, k);
        for (let k = 1; k <= n; k++) acc += uses.get(k) ?? 0;
    }
    return acc;
}

// ── ARM 3: a FRESH Map each module (what clear() costs if it drops capacity) ─────────────────────
function mapFresh(): number {
    let acc = 0;
    for (let m = 0; m < MODULES; m++) {
        const uses = new Map<number, number>();
        const n = sizeFor(m);
        for (let k = 1; k <= n; k++) uses.set(k, k);
        for (let k = 1; k <= n; k++) acc += uses.get(k) ?? 0;
    }
    return acc;
}

// ── ARM 4: PLAIN JS ARRAY indexed by symbol id, length reset ────────────────────────────────────
// Grows automatically, no fixed capacity, no bounds hazard — the appeal over a typed array.
function plainArray(): number {
    const uses: number[] = [];
    let acc = 0;
    for (let m = 0; m < MODULES; m++) {
        const n = sizeFor(m);
        uses.length = 0;
        for (let k = 1; k <= n; k++) uses[k] = k;
        for (let k = 1; k <= n; k++) acc += uses[k] ?? 0;
    }
    return acc;
}

// ── ARM 5: plain array, capacity KEPT (fill the used prefix instead of truncating) ──────────────
function plainArrayKeep(): number {
    const uses: number[] = [];
    let acc = 0;
    for (let m = 0; m < MODULES; m++) {
        const n = sizeFor(m);
        for (let k = 1; k <= n; k++) uses[k] = 0; // reset only what will be used
        for (let k = 1; k <= n; k++) uses[k] = k;
        for (let k = 1; k <= n; k++) acc += uses[k] ?? 0;
    }
    return acc;
}

// ── `refs` SHAPES ────────────────────────────────────────────────────────────────────────────────
// `refs` is `Map<symbolId, {reads,writes}>` and ABSENT is load-bearing: `movement.ts:119` reads
// `c === undefined || c.writes > 0` — absent means "unknown, do not reorder", NOT "zero writes". So a
// numeric array pre-filled with zeros would silently permit reordering it used to block.
//
// An ARRAY OF OBJECTS keeps that exactly: `refs[sym]` is `undefined` for a hole, which is precisely
// what `Map.get` returns for absent. The value shape is unchanged, so the 18 sites reading
// `.reads`/`.writes` need no edit at all.
type RefCounts = { reads: number; writes: number };

function refsMap(): number {
    const refs = new Map<number, RefCounts>();
    let acc = 0;
    for (let m = 0; m < MODULES; m++) {
        refs.clear();
        const n = sizeFor(m);
        for (let k = 1; k <= n; k++) {
            let c = refs.get(k);
            if (c === undefined) { c = { reads: 0, writes: 0 }; refs.set(k, c); }
            c.reads++;
        }
        for (let k = 1; k <= n; k++) acc += refs.get(k)?.reads ?? 0;
    }
    return acc;
}

function refsArrayOfObjects(): number {
    let refs: (RefCounts | undefined)[] = [];
    let acc = 0;
    for (let m = 0; m < MODULES; m++) {
        refs = [];
        const n = sizeFor(m);
        for (let k = 1; k <= n; k++) {
            let c = refs[k];
            if (c === undefined) { c = { reads: 0, writes: 0 }; refs[k] = c; }
            c.reads++;
        }
        for (let k = 1; k <= n; k++) acc += refs[k]?.reads ?? 0;
    }
    return acc;
}

/** Same, but POOLING the record objects across modules instead of reallocating them. Absent is still
 *  distinguishable because the reset writes `undefined`, not a zeroed record. */
function refsPooled(): number {
    const refs: (RefCounts | undefined)[] = [];
    const pool: RefCounts[] = [];
    let acc = 0;
    for (let m = 0; m < MODULES; m++) {
        const n = sizeFor(m);
        for (let k = 1; k < refs.length; k++) refs[k] = undefined; // keep capacity, keep "absent"
        for (let k = 1; k <= n; k++) {
            let c = refs[k];
            if (c === undefined) {
                c = pool[k] ?? (pool[k] = { reads: 0, writes: 0 });
                c.reads = 0;
                c.writes = 0;
                refs[k] = c;
            }
            c.reads++;
        }
        for (let k = 1; k <= n; k++) acc += refs[k]?.reads ?? 0;
    }
    return acc;
}

group(`per-module table reset — ${MODULES} analyze calls`, () => {
    bench('Map + clear() (today)', () => same(mapClear()));
    bench('Map + clear() (CONTROL)', () => same(mapClearControl()));
    bench('fresh Map each module', () => same(mapFresh()));
    bench('plain array, length = 0', () => same(plainArray()));
    bench('plain array, capacity kept', () => same(plainArrayKeep()));
});

let EXPECT2 = -1;
const same2 = (v: number): number => {
    if (EXPECT2 === -1) EXPECT2 = v;
    else if (v !== EXPECT2) throw new Error(`refs arm disagrees: ${v} vs ${EXPECT2}`);
    return v;
};

group('refs shape — absent must stay distinguishable from {0,0}', () => {
    bench('Map<sym, RefCounts> (today)', () => same2(refsMap()));
    bench('array of RefCounts', () => same2(refsArrayOfObjects()));
    bench('array of POOLED RefCounts', () => same2(refsPooled()));
});
