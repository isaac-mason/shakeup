import { bench, group } from '@pmndrs/labs';

// SPIKE 2 for `llm/notes/compressor-perf-plan.md` §1: given a set of dirty scopes, what is the
// cheapest way to visit only those?
//
// The tree is modelled on the REAL crashcat chunk, measured 2026-08-28 by parsing the actual 1.2MB
// dce-only chunk text:
//
//     total nodes                  175,446
//     nodes NOT inside any fn       14,728   ( 8.4%)   <- the always-dirty root scope
//     outermost function scopes      1,205
//     nodes inside outermost fns   161,923   (92.3%)   median fn 58 nodes, largest 2,516
//
// DIRTY FRACTIONS are the real per-round measurements, not guesses. Distinct scopes containing a
// mutation, per chunk-level round: 1727 / 456 / 77 / 11 / 1 / 0 (of ~1,700). Expressed against the
// 1,205 outermost functions that is roughly 100% / 26% / 4.5% / 0.6% / 0.1% / 0%.
//
// ARMS. (a) full walk — today, and the thing to beat. (b) DESCEND-AND-CHECK: walk from the root but
// consult a stamp at each function node and skip its whole subtree when clean. (c) WORKLIST: never
// walk the spine at all, iterate an array of dirty function roots and walk only those, then walk the
// top-level nodes separately.
//
// The question (b) vs (c) is whether descending the spine to REACH the dirty functions is a
// meaningful cost. With only ~1,205 outermost functions it probably is not — but "probably" is what
// benches are for, and if (b) ties (c) then (b) wins on simplicity because it needs no separate
// dirty-root registry to keep in sync with a mutating tree.
//
// The always-dirty root scope is modelled: the 14,728 top-level nodes are walked in EVERY arm at
// EVERY fraction. It is the floor, and it is why 0% dirty is not free.

type SNode = { fn: boolean; scope: number; kids: SNode[] };

const TOP_LEVEL = 14_728;
const N_FUNCS = 1_205;
const NODES_IN_FUNCS = 161_923;

/** Function subtree sizes with the measured shape: median 58, max ~2,516, summing to 161,923. */
function fnSizes(): number[] {
    const out: number[] = [];
    let total = 0;
    let x = 987_654;
    for (let i = 0; i < N_FUNCS; i++) {
        x = (x * 1_103_515_245 + 12_345) & 0x7fffffff;
        // Heavy tail: mostly small, a few very large — matches median 58 / max 2516.
        const r = (x % 1000) / 1000;
        const size = r < 0.9 ? 12 + Math.floor(r * 120) : 200 + Math.floor((r - 0.9) * 23_000);
        out.push(size);
        total += size;
    }
    // Normalise to the measured node count so every arm walks the real number of nodes.
    const scale = NODES_IN_FUNCS / total;
    return out.map((s) => Math.max(1, Math.round(s * scale)));
}

function chain(n: number, scope: number): SNode {
    // A chain rather than a bush: depth is what makes a walk expensive, and a flat fan-out would
    // understate it. Real ASTs are deep.
    const root: SNode = { fn: false, scope, kids: [] };
    let cur = root;
    for (let i = 1; i < n; i++) {
        const next: SNode = { fn: false, scope, kids: [] };
        cur.kids.push(next);
        cur = next;
    }
    return root;
}

const SIZES = fnSizes();
const ROOT: SNode = { fn: false, scope: 0, kids: [] };
/** The top-level (root-scope) nodes, kept separately so the worklist arm can walk them for REAL.
 *  An earlier version of this bench added `TOP_LEVEL` to the accumulator instead of walking them,
 *  which made the worklist arm look 16x better than descend at 0.6% dirty — entirely an artifact. */
const TOP_NODES: SNode[] = [];
for (let i = 0; i < TOP_LEVEL; i++) {
    const n: SNode = { fn: false, scope: 0, kids: [] };
    TOP_NODES.push(n);
    ROOT.kids.push(n);
}
const FN_ROOTS: SNode[] = [];
for (let i = 0; i < N_FUNCS; i++) {
    const body = chain(SIZES[i], i + 1);
    const fnNode: SNode = { fn: true, scope: i + 1, kids: [body] };
    FN_ROOTS.push(fnNode);
    ROOT.kids.push(fnNode);
}

/** Deterministic dirty sets at each measured fraction. */
function dirtyFor(count: number): { set: Set<number>; roots: SNode[] } {
    const set = new Set<number>();
    const roots: SNode[] = [];
    const stride = count === 0 ? 0 : Math.max(1, Math.floor(N_FUNCS / count));
    for (let i = 0; i < N_FUNCS && set.size < count; i += stride) {
        set.add(i + 1);
        roots.push(FN_ROOTS[i]);
    }
    return { set, roots };
}

// ── arm a: full walk (today) ──────────────────────────────────────────────────
function walkFull(n: SNode, acc: { c: number }): void {
    acc.c++;
    const k = n.kids;
    for (let i = 0; i < k.length; i++) walkFull(k[i], acc);
}
function runFull(): number {
    const acc = { c: 0 };
    walkFull(ROOT, acc);
    return acc.c;
}

// ── arm a2: full walk, CONTROL ────────────────────────────────────────────────
function walkCtl(n: SNode, acc: { c: number }): void {
    acc.c++;
    const k = n.kids;
    for (let i = 0; i < k.length; i++) walkCtl(k[i], acc);
}
function runControl(): number {
    const acc = { c: 0 };
    walkCtl(ROOT, acc);
    return acc.c;
}

// ── arm b: descend and check a stamp, skipping clean function subtrees ───────
function walkSkip(n: SNode, dirty: Set<number>, acc: { c: number }): void {
    if (n.fn && !dirty.has(n.scope)) return; // clean function: whole subtree skipped
    acc.c++;
    const k = n.kids;
    for (let i = 0; i < k.length; i++) walkSkip(k[i], dirty, acc);
}
function runSkip(dirty: Set<number>): number {
    const acc = { c: 0 };
    walkSkip(ROOT, dirty, acc);
    return acc.c;
}

// ── arm c: worklist — walk top-level, then only the dirty function roots ─────
function walkPlain(n: SNode, acc: { c: number }): void {
    acc.c++;
    const k = n.kids;
    for (let i = 0; i < k.length; i++) walkPlain(k[i], acc);
}
function runWorklist(roots: SNode[]): number {
    const acc = { c: 0 };
    // The always-dirty root scope is WALKED, not counted — it is the floor both arms must pay.
    acc.c++; // ROOT itself
    for (let i = 0; i < TOP_NODES.length; i++) walkPlain(TOP_NODES[i], acc);
    for (let i = 0; i < roots.length; i++) walkPlain(roots[i], acc);
    return acc.c;
}

// ── arm d: descend + INTEGER STAMP — matching spike-1's decision ─────────────
// Arm (b) above checks membership with `Set.has`, which spike-1 measured as the expensive part of
// the whole scheme. The design we actually chose stamps a `number[]` with the round number, so the
// check is `stamp[id] === round`, an indexed load and an integer compare. Benching (b) with a Set
// while proposing to ship an array would be comparing against a strawman.
// A FRESH array per group. An earlier version shared one module-level `STAMP` and filled it during
// group registration — but `bench` callbacks run later, so every arm saw the LAST group's marking
// (count = 0, nothing dirty) and read a flat ~165us at every fraction. Shared mutable setup state
// and deferred execution do not mix.
const ROUND = 7;
function stampFor(count: number): number[] {
    const stamp: number[] = new Array(N_FUNCS + 1).fill(0);
    const stride = count === 0 ? 0 : Math.max(1, Math.floor(N_FUNCS / count));
    let marked = 0;
    for (let i = 0; i < N_FUNCS && marked < count; i += stride) {
        stamp[i + 1] = ROUND;
        marked++;
    }
    return stamp;
}
function walkSkipStamp(n: SNode, stamp: number[], round: number, acc: { c: number }): void {
    if (n.fn && stamp[n.scope] !== round) return;
    acc.c++;
    const k = n.kids;
    for (let i = 0; i < k.length; i++) walkSkipStamp(k[i], stamp, round, acc);
}
function runSkipStamp(stamp: number[]): number {
    const acc = { c: 0 };
    walkSkipStamp(ROOT, stamp, ROUND, acc);
    return acc.c;
}

const ROUNDS: [string, number][] = [
    ['round 2 — 26% dirty (313 fns)', 313],
    ['round 3 — 4.5% dirty (54 fns)', 54],
    ['round 4 — 0.6% dirty (8 fns)', 8],
    ['round 6 — 0% dirty', 0],
];

for (const [label, count] of ROUNDS) {
    const { set, roots } = dirtyFor(count);
    const stamp = stampFor(count);
    group(`scope skipping — ${label}`, () => {
        bench('full walk (today)', () => runFull());
        bench('full walk (CONTROL)', () => runControl());
        bench('descend + Set check', () => runSkip(set));
        bench('descend + number[] stamp', () => runSkipStamp(stamp));
        bench('worklist of dirty roots', () => runWorklist(roots));
    });
}
