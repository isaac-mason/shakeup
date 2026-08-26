import { bench, group } from '@pmndrs/labs';

// `Semantic.refs`/`uses` are keyed by SYMBOL ID — a dense integer 1..symbols.length — but stored as
// `Map<number, RefCounts>` and `Map<number, number>`. oxc stores symbol-indexed data in FLAT ARRAYS
// indexed by `SymbolId` ("Symbol table stored as struct-of-arrays in a single allocation",
// oxc_semantic/src/scoping.rs), and pre-sizes them from a previous run's `Stats` because
// "re-allocation can be very costly" (stats.rs).
//
// MEASURED over a crashcat bundle (counting Map subclass, reverted):
//     uses.get 113,237 · refs.get 106,874 · uses.set 96,312 · refs.set 25,474 · 190 clears each
// so ~340k operations on these two structures per bundle, plus up to 25k `{reads,writes}` OBJECTS.
//
// Table sizes are the real ones: crashcat's median module has 94 symbols, its largest 746, and
// three.core.js has 7,332 — so the bench runs a mix rather than one flattering size.
const MODULES = 190;                     // analyze() calls per bundle
const SIZES = [94, 94, 94, 200, 746];    // symbols per module, repeated to fill MODULES
const USES_GET = 113_237 / MODULES;
const REFS_GET = 106_874 / MODULES;
const USES_SET = 96_312 / MODULES;
const REFS_SET = 25_474 / MODULES;

const sizeFor = (i: number): number => SIZES[i % SIZES.length];

// ── ARM 1: Maps (today) ──────────────────────────────────────────────────────────────────────────
function runMaps(): number {
    const refs = new Map<number, { reads: number; writes: number }>();
    const uses = new Map<number, number>();
    let acc = 0;
    for (let m = 0; m < MODULES; m++) {
        refs.clear();
        uses.clear();
        const n = sizeFor(m);
        for (let k = 0; k < USES_SET; k++) {
            const sym = 1 + (k % n);
            uses.set(sym, (uses.get(sym) ?? 0) + 1);
        }
        for (let k = 0; k < REFS_SET; k++) {
            const sym = 1 + (k % n);
            let c = refs.get(sym);
            if (c === undefined) { c = { reads: 0, writes: 0 }; refs.set(sym, c); }
            c.reads++;
        }
        for (let k = 0; k < USES_GET; k++) acc += uses.get(1 + (k % n)) ?? 0;
        for (let k = 0; k < REFS_GET; k++) acc += refs.get(1 + (k % n))?.reads ?? 0;
    }
    return acc;
}

// ── ARM 2: byte-identical CONTROL of arm 1 ───────────────────────────────────────────────────────
function runMapsControl(): number {
    const refs = new Map<number, { reads: number; writes: number }>();
    const uses = new Map<number, number>();
    let acc = 0;
    for (let m = 0; m < MODULES; m++) {
        refs.clear();
        uses.clear();
        const n = sizeFor(m);
        for (let k = 0; k < USES_SET; k++) {
            const sym = 1 + (k % n);
            uses.set(sym, (uses.get(sym) ?? 0) + 1);
        }
        for (let k = 0; k < REFS_SET; k++) {
            const sym = 1 + (k % n);
            let c = refs.get(sym);
            if (c === undefined) { c = { reads: 0, writes: 0 }; refs.set(sym, c); }
            c.reads++;
        }
        for (let k = 0; k < USES_GET; k++) acc += uses.get(1 + (k % n)) ?? 0;
        for (let k = 0; k < REFS_GET; k++) acc += refs.get(1 + (k % n))?.reads ?? 0;
    }
    return acc;
}

// ── ARM 3: symbol-indexed flat arrays (the oxc shape) ────────────────────────────────────────────
// One allocation each, grown only when a module needs more than the high-water mark, and "cleared"
// by filling the used prefix — no rehash, no per-symbol object.
function runArrays(): number {
    let cap = 0;
    let reads = new Int32Array(0);
    let writes = new Int32Array(0);
    let uses = new Int32Array(0);
    let acc = 0;
    for (let m = 0; m < MODULES; m++) {
        const n = sizeFor(m) + 1;
        if (n > cap) {
            cap = n;
            reads = new Int32Array(cap);
            writes = new Int32Array(cap);
            uses = new Int32Array(cap);
        } else {
            reads.fill(0, 0, n);
            writes.fill(0, 0, n);
            uses.fill(0, 0, n);
        }
        const sz = sizeFor(m);
        for (let k = 0; k < USES_SET; k++) uses[1 + (k % sz)]++;
        for (let k = 0; k < REFS_SET; k++) reads[1 + (k % sz)]++;
        for (let k = 0; k < USES_GET; k++) acc += uses[1 + (k % sz)];
        for (let k = 0; k < REFS_GET; k++) acc += reads[1 + (k % sz)];
    }
    void writes;
    return acc;
}

// The arms must agree, or they are not doing the same work.
let EXPECT = -1;
const same = (v: number): number => {
    if (EXPECT === -1) EXPECT = v;
    else if (v !== EXPECT) throw new Error(`arm disagrees: ${v} vs ${EXPECT}`);
    return v;
};

group('symbol-keyed refs/uses — measured op mix over 190 analyze() calls', () => {
    bench('Map<symbolId, …> (today)', () => same(runMaps()));
    bench('Map<symbolId, …> (CONTROL)', () => same(runMapsControl()));
    bench('symbol-indexed Int32Array (oxc shape)', () => same(runArrays()));
});
