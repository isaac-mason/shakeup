import { bench, group } from '@pmndrs/labs';

// INDEPENDENT re-assessment of AST node representation. The standing rule is "never touch node+data
// shape" (monomorphism, deliberate) — this does not propose changing it, it measures what the
// alternatives would actually buy, because ~42% of all allocation is parser AST and GC is 33-38% of a
// bundle. Skepticism is the right prior; the point is to replace it with numbers.
//
// Shape today: `{ id, type, start, end, name, sym, data }` PLUS a per-type `data` object = TWO
// allocations per node. oxc gets one, in an arena.
//
// Operations are the ones we actually perform, not synthetic ones:
//   build      — the parser allocating a tree (where the 42% lives)
//   traverse   — recursive walk dispatching on `type` and descending into children (dominant op)
//   fieldRead  — reading one named child, the `node.data.body` pattern
//   mutate     — writing `sym`, then replacing a child slot
const N = 138_056; // three.core.js
const CHILD_SLOTS = 4;

/**
 * A GENUINE TREE — every node has exactly one parent and the walk visits each exactly once.
 *
 * The first cut of this built children as `i+1, i+2, i+3`, which is a shared DAG, and rooted the walk
 * at a node whose arity happened to be 0 — so "traverse" measured ONE node and reported 246ns. The
 * shape of a benchmark is as easy to get wrong as the code it measures; `assertVisits` below exists so
 * that failure mode cannot recur silently.
 *
 * Layout: a pre-order plan of `(nodeIndex, childCount)` with a cursor, so children occupy the
 * following block. Arity mix mirrors a real AST — mostly leaves, some unary/binary, a few ternary.
 */
const KIDS = (() => {
    const counts = new Int32Array(N);
    const childStart = new Int32Array(N).fill(-1);
    // Assign every node a PARENT rather than assigning children from a cursor. Handing out children
    // top-down dies as soon as the frontier is all leaves — the first two attempts produced trees of
    // 1 and 4 nodes. Walking parents forward guarantees all N are connected, and because each parent's
    // children are consumed consecutively they stay CONTIGUOUS, so `childStart + k` still indexes them.
    const capOf = (i: number): number => {
        const r = i % 10;
        return r < 5 ? 0 : r === 5 ? 1 : r < 8 ? 2 : 3; // ~50% leaves, avg 1.1 children
    };
    let parent = 0;
    let filled = 0;
    for (let i = 1; i < N; i++) {
        while (parent < i && filled >= capOf(parent)) {
            parent++;
            filled = 0;
        }
        if (parent >= i) parent = i - 1; // never run out: the previous node adopts
        if (childStart[parent] < 0) childStart[parent] = i;
        counts[parent]++;
        filled++;
    }
    return { counts, childStart };
})();

/** Guard against a degenerate tree silently making a benchmark meaningless. */
function assertVisits(n: number): number {
    if (n < N * 0.9) throw new Error(`traversal visited ${n} of ${N} nodes — the tree is degenerate`);
    return n;
}


// ── 1. CURRENT: node object + separate data object ────────────────────────────────────────────────
type CurNode = { id: number; type: number; start: number; end: number; name: string; sym: number; data: any };
function buildCurrent(): CurNode[] {
    const all: CurNode[] = new Array(N);
    for (let i = N - 1; i >= 0; i--) {
        const k = KIDS.counts[i], cs = KIDS.childStart[i];
        const data: any = k === 0 ? null : { a: null, b: null, c: null };
        if (k >= 1) data.a = all[cs];
        if (k >= 2) data.b = all[cs + 1];
        if (k >= 3) data.c = all[cs + 2];
        all[i] = { id: i, type: i % 151, start: i, end: i + 1, name: '', sym: 0, data };
    }
    return all;
}

// ── 2. FLAT: ONE object per node, fixed monomorphic shape, children in generic slots ──────────────
type FlatNode = {
    id: number; type: number; start: number; end: number; name: string; sym: number;
    c0: FlatNode | null; c1: FlatNode | null; c2: FlatNode | null; c3: FlatNode | null;
};
function buildFlat(): FlatNode[] {
    const all: FlatNode[] = new Array(N);
    for (let i = N - 1; i >= 0; i--) {
        const k = KIDS.counts[i], cs = KIDS.childStart[i];
        all[i] = {
            id: i, type: i % 151, start: i, end: i + 1, name: '', sym: 0,
            c0: k >= 1 ? all[cs] : null,
            c1: k >= 2 ? all[cs + 1] : null,
            c2: k >= 3 ? all[cs + 2] : null,
            c3: null,
        };
    }
    return all;
}

// ── 3. SoA: parallel typed arrays; children are node INDICES, -1 for absent ───────────────────────
type Soa = { type: Int32Array; start: Int32Array; end: Int32Array; sym: Int32Array; kids: Int32Array; names: string[] };
function buildSoa(): Soa {
    const type = new Int32Array(N), start = new Int32Array(N), end = new Int32Array(N), sym = new Int32Array(N);
    const kids = new Int32Array(N * CHILD_SLOTS).fill(-1);
    const names: string[] = new Array(N).fill('');
    for (let i = N - 1; i >= 0; i--) {
        type[i] = i % 151; start[i] = i; end[i] = i + 1;
        const k = KIDS.counts[i], cs = KIDS.childStart[i], base = i * CHILD_SLOTS;
        for (let sIdx = 0; sIdx < k; sIdx++) kids[base + sIdx] = cs + sIdx;
    }
    return { type, start, end, sym, kids, names };
}

group('AST build (allocation) @micro @ast', () => {
    bench('current: node + data object', function* () { yield () => buildCurrent().length; }).gc(true);
    bench('flat: one object, generic slots', function* () { yield () => buildFlat().length; }).gc(true);
    bench('SoA: typed arrays', function* () { yield () => buildSoa().type.length; }).gc(true);
});

group('AST traverse (dispatch + descend) @micro @ast', () => {
    bench('current', function* () {
        const all = buildCurrent();
        yield () => {
            let acc = 0;
            const go = (n: CurNode): void => {
                acc++;
                const d = n.data;
                if (d === null) return;
                if (d.a !== null) go(d.a);
                if (d.b !== null) go(d.b);
                if (d.c !== null) go(d.c);
            };
            go(all[0]);
            return assertVisits(acc);
        };
    }).gc(true);

    bench('flat', function* () {
        const all = buildFlat();
        yield () => {
            let acc = 0;
            const go = (n: FlatNode): void => {
                acc++;
                if (n.c0 !== null) go(n.c0);
                if (n.c1 !== null) go(n.c1);
                if (n.c2 !== null) go(n.c2);
            };
            go(all[0]);
            return assertVisits(acc);
        };
    }).gc(true);

    bench('SoA', function* () {
        const s = buildSoa();
        yield () => {
            let acc = 0;
            const go = (i: number): void => {
                acc++;
                const base = i * CHILD_SLOTS;
                for (let k = 0; k < 3; k++) { const c = s.kids[base + k]; if (c >= 0) go(c); }
            };
            go(0);
            return assertVisits(acc);
        };
    }).gc(true);
});

// SoA's real argument is LINEAR iteration, not recursive descent — a pre-order layout lets a pass
// sweep 0..N instead of pointer-chasing. Recursive descent is the shape our passes use today, so the
// comparison above is the fair one for the code as written; this is the fair one for the code SoA
// would enable. Both are measured so the conclusion cannot rest on having tested only the weak form.
group('AST traverse: linear sweep where the layout allows it @micro @ast', () => {
    bench('SoA linear pre-order sweep', function* () {
        const s = buildSoa();
        yield () => {
            let acc = 0;
            for (let i = 0; i < N; i++) acc += s.type[i] === 0 ? 1 : 1;
            return assertVisits(acc);
        };
    }).gc(true);

    bench('current: linear sweep over a node array', function* () {
        const all = buildCurrent();
        yield () => {
            let acc = 0;
            for (let i = 0; i < N; i++) acc += all[i].type === 0 ? 1 : 1;
            return assertVisits(acc);
        };
    }).gc(true);

    bench('current: recursive descent (today)', function* () {
        const all = buildCurrent();
        yield () => {
            let acc = 0;
            const go = (n: CurNode): void => {
                acc++;
                const d = n.data;
                if (d === null) return;
                if (d.a !== null) go(d.a);
                if (d.b !== null) go(d.b);
                if (d.c !== null) go(d.c);
            };
            go(all[0]);
            return assertVisits(acc);
        };
    }).gc(true);
});

group('AST mutate (sym write + child replace) @micro @ast', () => {
    bench('current', function* () {
        const all = buildCurrent();
        yield () => {
            for (let i = 0; i < N; i++) { const n = all[i]; n.sym = i & 0xffff; if (n.data !== null && n.data.a !== null) n.data.a = n.data.a; }
            return all.length;
        };
    }).gc(true);
    bench('flat', function* () {
        const all = buildFlat();
        yield () => {
            for (let i = 0; i < N; i++) { const n = all[i]; n.sym = i & 0xffff; if (n.c0 !== null) n.c0 = n.c0; }
            return all.length;
        };
    }).gc(true);
    bench('SoA', function* () {
        const s = buildSoa();
        yield () => {
            for (let i = 0; i < N; i++) { s.sym[i] = i & 0xffff; const b = i * CHILD_SLOTS; if (s.kids[b] >= 0) s.kids[b] = s.kids[b]; }
            return s.sym.length;
        };
    }).gc(true);
});

// ── WHY FOUR ARRAYS? INTERLEAVING, AND LEANER OBJECTS ─────────────────────────────────────────────
// The SoA arm above used four separate arrays, which scatters ONE node's fields across four cache
// lines — the worst possible layout for pointer-chasing descent, and probably why it lost by 44%.
// An INTERLEAVED buffer (`buf[i * STRIDE + field]`) keeps a node contiguous, which is the version that
// deserves the comparison.
//
// The object side gets the same scrutiny: today's node carries SEVEN fields — `id, type, start, end,
// name, sym, data` — and `name` is a string that only means anything on identifier nodes, so ~90% of
// nodes pay a slot for `''`. `id` is likewise not read on the hot path. A leaner object is a change to
// node shape, but a far smaller one than a representation rewrite.
const STRIDE = 8; // type, start, end, sym, kid0..kid3 — 32 bytes, one cache line

function buildInterleavedI32(): Int32Array {
    const buf = new Int32Array(N * STRIDE).fill(-1);
    for (let i = 0; i < N; i++) {
        const b = i * STRIDE;
        buf[b] = i % 151; buf[b + 1] = i; buf[b + 2] = i + 1; buf[b + 3] = 0;
        const k = KIDS.counts[i], cs = KIDS.childStart[i];
        for (let j = 0; j < 4; j++) buf[b + 4 + j] = j < k ? cs + j : -1;
    }
    return buf;
}
function buildInterleavedNum(): number[] {
    const buf: number[] = new Array(N * STRIDE).fill(-1);
    for (let i = 0; i < N; i++) {
        const b = i * STRIDE;
        buf[b] = i % 151; buf[b + 1] = i; buf[b + 2] = i + 1; buf[b + 3] = 0;
        const k = KIDS.counts[i], cs = KIDS.childStart[i];
        for (let j = 0; j < 4; j++) buf[b + 4 + j] = j < k ? cs + j : -1;
    }
    return buf;
}

/** Today's node minus the two fields the hot path never reads: `id` and `name`. */
type LeanNode = { type: number; start: number; end: number; sym: number; data: any };
function buildLean(): LeanNode[] {
    const all: LeanNode[] = new Array(N);
    for (let i = N - 1; i >= 0; i--) {
        const k = KIDS.counts[i], cs = KIDS.childStart[i];
        const data: any = k === 0 ? null : { a: null, b: null, c: null };
        if (k >= 1) data.a = all[cs];
        if (k >= 2) data.b = all[cs + 1];
        if (k >= 3) data.c = all[cs + 2];
        all[i] = { type: i % 151, start: i, end: i + 1, sym: 0, data };
    }
    return all;
}

/** Lean AND flat: one object, no `id`/`name`, children in slots. The leanest object form. */
type LeanFlat = { type: number; start: number; end: number; sym: number; c0: LeanFlat | null; c1: LeanFlat | null; c2: LeanFlat | null };
function buildLeanFlat(): LeanFlat[] {
    const all: LeanFlat[] = new Array(N);
    for (let i = N - 1; i >= 0; i--) {
        const k = KIDS.counts[i], cs = KIDS.childStart[i];
        all[i] = {
            type: i % 151, start: i, end: i + 1, sym: 0,
            c0: k >= 1 ? all[cs] : null,
            c1: k >= 2 ? all[cs + 1] : null,
            c2: k >= 3 ? all[cs + 2] : null,
        };
    }
    return all;
}

group('interleaved vs scattered vs objects: RECURSIVE descent @micro @ast2', () => {
    bench('current: node + data (today)', function* () {
        const all = buildCurrent();
        yield () => {
            let acc = 0;
            const go = (n: CurNode): void => { acc++; const d = n.data; if (d === null) return;
                if (d.a !== null) go(d.a); if (d.b !== null) go(d.b); if (d.c !== null) go(d.c); };
            go(all[0]); return assertVisits(acc);
        };
    }).gc(true);

    bench('lean object + data (no id/name)', function* () {
        const all = buildLean();
        yield () => {
            let acc = 0;
            const go = (n: LeanNode): void => { acc++; const d = n.data; if (d === null) return;
                if (d.a !== null) go(d.a); if (d.b !== null) go(d.b); if (d.c !== null) go(d.c); };
            go(all[0]); return assertVisits(acc);
        };
    }).gc(true);

    bench('lean flat object (one alloc, slots)', function* () {
        const all = buildLeanFlat();
        yield () => {
            let acc = 0;
            const go = (n: LeanFlat): void => { acc++;
                if (n.c0 !== null) go(n.c0); if (n.c1 !== null) go(n.c1); if (n.c2 !== null) go(n.c2); };
            go(all[0]); return assertVisits(acc);
        };
    }).gc(true);

    bench('interleaved Int32Array (stride 8)', function* () {
        const buf = buildInterleavedI32();
        yield () => {
            let acc = 0;
            const go = (i: number): void => { acc++; const b = i * STRIDE;
                for (let j = 4; j < 7; j++) { const c = buf[b + j]; if (c >= 0) go(c); } };
            go(0); return assertVisits(acc);
        };
    }).gc(true);

    bench('interleaved number[] (stride 8)', function* () {
        const buf = buildInterleavedNum();
        yield () => {
            let acc = 0;
            const go = (i: number): void => { acc++; const b = i * STRIDE;
                for (let j = 4; j < 7; j++) { const c = buf[b + j]; if (c >= 0) go(c); } };
            go(0); return assertVisits(acc);
        };
    }).gc(true);
});

group('interleaved vs objects: BUILD @micro @ast2', () => {
    bench('current: node + data', function* () { yield () => buildCurrent().length; }).gc(true);
    bench('lean object + data', function* () { yield () => buildLean().length; }).gc(true);
    bench('lean flat object', function* () { yield () => buildLeanFlat().length; }).gc(true);
    bench('interleaved Int32Array', function* () { yield () => buildInterleavedI32().length; }).gc(true);
    bench('interleaved number[]', function* () { yield () => buildInterleavedNum().length; }).gc(true);
});

// ── ACCESS PATTERN: the arms above were WRONG, here is the corrected group ────────────────────────
//
// Four defects were found in earlier versions of this file, each of which produced a plausible-looking
// number that would have justified an architecture change:
//   1. the tree was one node (leaf root) — "traverse" reported 246ns;
//   2. the rebuilt tree was four nodes (the frontier was all leaves);
//   3. `data` had ONE hidden class, so `n.data.a` was a monomorphic IC — a fiction, since the real AST
//      has ~151 `data` shapes, and it flattered the incumbent;
//   4. the "per-type switch" arm was `arms[type](d, go)` — an indirect call through a 151-entry
//      function table, i.e. a megamorphic CALL site, not the inline switch it claimed to model.
//
// Defences now in place, because a wrong benchmark here sends the whole project down a bad track:
//   • every arm returns a CHECKSUM derived from node contents, not a visit count, so an arm that skips
//     work cannot look fast;
//   • `expectSame` cross-checks every arm against the first, so a broken arm fails loudly;
//   • the codegen arm is a REAL inline switch built with `new Function`, exactly as `ast.ts` builds
//     `walk` — not a function table.
const SHAPES = 151;
const FIELD_NAMES = ['a', 'b', 'c', 'body', 'left', 'right', 'test', 'argument'];

/** Field names per shape, standing in for `CHILD_FIELDS`. Three child slots per shape. */
const SHAPE_FIELDS: string[][] = Array.from({ length: SHAPES }, (_, i) => [
    FIELD_NAMES[i % FIELD_NAMES.length],
    FIELD_NAMES[(i + 1) % FIELD_NAMES.length],
    FIELD_NAMES[(i + 2) % FIELD_NAMES.length],
]);

type PolyNode = { type: number; start: number; end: number; sym: number; data: any };

/**
 * Build with `SHAPES` genuinely distinct `data` hidden classes.
 *
 * Each shape gets its own literal-creating factory AND a differently-named padding field, so V8 cannot
 * collapse them into one map. Verified below by `expectSame` — if the shapes collapsed, the dynamic and
 * switch arms would not differ from the monomorphic one.
 */
function buildPoly(): PolyNode[] {
    const all: PolyNode[] = new Array(N);
    const makers: ((k: number, a: any, b: any, c: any) => any)[] = [];
    for (let sIdx = 0; sIdx < SHAPES; sIdx++) {
        const [f0, f1, f2] = SHAPE_FIELDS[sIdx];
        const body = `return function make(k, a, b, c) {
            const o = { pad${sIdx}: ${sIdx}, ${f0}: null, ${f1}: null, ${f2}: null };
            if (k >= 1) o.${f0} = a;
            if (k >= 2) o.${f1} = b;
            if (k >= 3) o.${f2} = c;
            return o;
        }`;
        // eslint-disable-next-line no-new-func
        makers.push(new Function(body)() as (k: number, a: any, b: any, c: any) => any);
    }
    for (let i = N - 1; i >= 0; i--) {
        const k = KIDS.counts[i], cs = KIDS.childStart[i], t = i % SHAPES;
        const data = k === 0 ? null : makers[t](k, all[cs], all[cs + 1], all[cs + 2]);
        all[i] = { type: t, start: i, end: i + 1, sym: 0, data };
    }
    return all;
}

/** A REAL inline switch over all 151 shapes, generated the way `ast.ts` generates `walk`. */
function buildCodegenWalk(): (n: PolyNode) => number {
    const cases = SHAPE_FIELDS.map((f, t) => {
        const reads = f.map((name) => `{ const c = d.${name}; if (c != null) sum += go(c); }`).join(' ');
        return `case ${t}: { ${reads} break; }`;
    }).join('\n');
    const body = `return function go(n) {
        let sum = n.type + n.start;
        const d = n.data;
        if (d === null) return sum;
        switch (n.type) {
${cases}
        }
        return sum;
    }`;
    // eslint-disable-next-line no-new-func
    return new Function(body)() as (n: PolyNode) => number;
}

/** Cross-arm agreement: a silently-broken arm must fail, not report a fast time. */
let EXPECTED = -1;
function expectSame(v: number): number {
    if (EXPECTED === -1) EXPECTED = v;
    else if (v !== EXPECTED) throw new Error(`arm disagrees: got ${v}, expected ${EXPECTED}`);
    return v;
}

group('access pattern: dynamic key vs codegen switch @micro @ast3', () => {
    bench('151 shapes, DYNAMIC key d[name] (walkChildren today)', function* () {
        const all = buildPoly();
        yield () => {
            const go = (n: PolyNode): number => {
                let sum = n.type + n.start;
                const d = n.data;
                if (d === null) return sum;
                const fields = SHAPE_FIELDS[n.type];
                for (let j = 0; j < fields.length; j++) {
                    const c = d[fields[j]];
                    if (c != null) sum += go(c);
                }
                return sum;
            };
            return expectSame(go(all[0]));
        };
    }).gc(true);

    bench('151 shapes, CODEGEN inline switch (real new Function)', function* () {
        const all = buildPoly();
        const go = buildCodegenWalk();
        yield () => expectSame(go(all[0]));
    }).gc(true);

    bench('151 shapes, generic FIELDS loop + static names', function* () {
        const all = buildPoly();
        yield () => {
            // Same shape-driven loop, but hoisting the field array once per node rather than indexing
            // `SHAPE_FIELDS` inside the inner loop — isolates lookup overhead from access overhead.
            const go = (n: PolyNode): number => {
                let sum = n.type + n.start;
                const d = n.data;
                if (d === null) return sum;
                const f = SHAPE_FIELDS[n.type];
                const a = d[f[0]]; if (a != null) sum += go(a);
                const b = d[f[1]]; if (b != null) sum += go(b);
                const c = d[f[2]]; if (c != null) sum += go(c);
                return sum;
            };
            return expectSame(go(all[0]));
        };
    }).gc(true);
});

// ── THE REAL `walkChildren` CONTRACT ──────────────────────────────────────────────────────────────
// The arm above inlined the recursion, which is NOT what `walkChildren` does. The real one takes a
// CALLBACK — `cb(child, fieldName, listIndex)` — supports early exit by returning `false`, and handles
// LIST fields. An indirect call per child may dominate the property-access saving, in which case
// codegen'ing it buys much less than 1.52x. Model the real contract before recommending anything.
type Fld = { name: string; list: boolean };
const SHAPE_FLD: Fld[][] = SHAPE_FIELDS.map((f, i) =>
    f.map((name, j) => ({ name, list: (i + j) % 7 === 0 })), // ~14% list fields, as the schema has
);

/** Build shapes where some child fields hold ARRAYS, matching the real schema. */
function buildPolyLists(): PolyNode[] {
    const all: PolyNode[] = new Array(N);
    const makers: ((k: number, a: any, b: any, c: any) => any)[] = [];
    for (let sIdx = 0; sIdx < SHAPES; sIdx++) {
        const f = SHAPE_FLD[sIdx];
        const asg = f
            .map((fld, j) => {
                const src = j === 0 ? 'a' : j === 1 ? 'b' : 'c';
                return `if (k >= ${j + 1}) o.${fld.name} = ${fld.list ? `[${src}]` : src};`;
            })
            .join(' ');
        const body = `return function make(k, a, b, c) {
            const o = { pad${sIdx}: ${sIdx}, ${f.map((x) => `${x.name}: null`).join(', ')} };
            ${asg}
            return o;
        }`;
        // eslint-disable-next-line no-new-func
        makers.push(new Function(body)() as (k: number, a: any, b: any, c: any) => any);
    }
    for (let i = N - 1; i >= 0; i--) {
        const k = KIDS.counts[i], cs = KIDS.childStart[i], t = i % SHAPES;
        all[i] = { type: t, start: i, end: i + 1, sym: 0, data: k === 0 ? null : makers[t](k, all[cs], all[cs + 1], all[cs + 2]) };
    }
    return all;
}

/** Today's `walkChildren`, transcribed: dynamic key, list handling, callback, early exit. */
function wcDynamic(n: PolyNode, cb: (c: PolyNode, field: string, idx: number) => boolean | void): void {
    const fields = SHAPE_FLD[n.type];
    const data = n.data;
    if (data === null) return;
    for (let i = 0; i < fields.length; i++) {
        const v = data[fields[i].name];
        if (v == null) continue;
        if (fields[i].list) {
            const arr = v as (PolyNode | null)[];
            for (let j = 0; j < arr.length; j++) {
                const c = arr[j];
                if (c != null && cb(c, fields[i].name, j) === false) return;
            }
        } else if (cb(v as PolyNode, fields[i].name, -1) === false) return;
    }
}

/** The same contract, codegen'd: one inline switch, literal field names, static access. */
const wcCodegen: (n: PolyNode, cb: (c: PolyNode, field: string, idx: number) => boolean | void) => void = (() => {
    const cases = SHAPE_FLD.map((f, t) => {
        const reads = f
            .map((fld) =>
                fld.list
                    ? `{ const v = d.${fld.name}; if (v != null) { for (let j = 0; j < v.length; j++) { const c = v[j]; if (c != null && cb(c, ${JSON.stringify(fld.name)}, j) === false) return; } } }`
                    : `{ const v = d.${fld.name}; if (v != null && cb(v, ${JSON.stringify(fld.name)}, -1) === false) return; }`,
            )
            .join(' ');
        return `case ${t}: { ${reads} return; }`;
    }).join('\n');
    const body = `return function wc(n, cb) {
        const d = n.data;
        if (d === null) return;
        switch (n.type) {
${cases}
        }
    }`;
    // eslint-disable-next-line no-new-func
    return new Function(body)() as never;
})();

let WC_EXPECTED = -1;
function wcSame(v: number): number {
    if (WC_EXPECTED === -1) WC_EXPECTED = v;
    else if (v !== WC_EXPECTED) throw new Error(`walkChildren arm disagrees: ${v} vs ${WC_EXPECTED}`);
    return v;
}

group('walkChildren: real contract (callback + lists + early exit) @micro @ast4', () => {
    bench('dynamic key d[fields[i].name] (today)', function* () {
        const all = buildPolyLists();
        yield () => {
            let sum = 0;
            const visit = (n: PolyNode): void => {
                sum += n.type;
                wcDynamic(n, (c) => {
                    visit(c);
                    return undefined;
                });
            };
            visit(all[0]);
            return wcSame(sum);
        };
    }).gc(true);

    bench('codegen inline switch, same contract', function* () {
        const all = buildPolyLists();
        yield () => {
            let sum = 0;
            const visit = (n: PolyNode): void => {
                sum += n.type;
                wcCodegen(n, (c) => {
                    visit(c);
                    return undefined;
                });
            };
            visit(all[0]);
            return wcSame(sum);
        };
    }).gc(true);
});
