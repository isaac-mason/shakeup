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

group(`per-module table reset — ${MODULES} analyze calls`, () => {
    bench('Map + clear() (today)', () => same(mapClear()));
    bench('Map + clear() (CONTROL)', () => same(mapClearControl()));
    bench('fresh Map each module', () => same(mapFresh()));
    bench('plain array, length = 0', () => same(plainArray()));
    bench('plain array, capacity kept', () => same(plainArrayKeep()));
});
