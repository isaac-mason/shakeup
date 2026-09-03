import { bench, group } from '@pmndrs/labs';

// S1 — does `traverse`'s WINNING dispatch shape transfer to the SEMANTIC walk?
//
// `descend-dispatch.bench.ts` settled this for `traverse.descend`: a table of small codegen'd walkers
// beat oxc's one-big-switch by 24.5%, and the principle went on record as "Rust rewards one big match;
// V8 rewards many small functions".
//
// But `semantic.ts`'s `descendVisit` (`buildDescendBody`, semantic.ts:777) IS one big switch — the
// shape that lost. It was never benched against a table; `visit-descend.bench.ts` only compared it to
// the closure + dynamic-key `walkChildren` it replaced (1.20x). So the two results do not cover each
// other and the semantic walk may be sitting on the losing shape.
//
// Two structural differences from `traverse` make this a real question rather than a foregone one:
//   1. READ-ONLY. No writeback (`d[key]=S(c)`), so each arm is half the code — a smaller switch, which
//      is exactly the axis on which V8 declines to optimise the big one.
//   2. `visit` has a hand-written switch of SPECIFIC arms in front, and only unhandled types reach the
//      generated descent. So the generated function sees a different, colder type distribution.
//
// Modelled here rather than imported: a 138,056-node tree with 151 real hidden classes, ~20 "specific"
// types handled by `visit` itself (doing collect-like work) and the rest falling through to descent.
const N_NODES = 138_056;
const SHAPES = 151;
const SPECIFIC = 20; // types `visit` handles with its own arm, as the real one does
const FIELD_NAMES = ['a', 'b', 'c', 'body', 'left', 'right', 'test', 'argument'];
const SHAPE_FLD = Array.from({ length: SHAPES }, (_, i) =>
    [0, 1, 2].map((j) => ({ name: FIELD_NAMES[(i + j) % FIELD_NAMES.length], list: (i + j) % 7 === 0 })),
);

type BNode = { type: number; sym: number; data: any };

/** A real tree — every node has exactly one parent — with 151 distinct `data` hidden classes. */
function build(): BNode[] {
    const counts = new Int32Array(N_NODES);
    const childStart = new Int32Array(N_NODES).fill(-1);
    const capOf = (i: number): number => { const r = i % 10; return r < 5 ? 0 : r === 5 ? 1 : r < 8 ? 2 : 3; };
    let parent = 0, filled = 0;
    for (let i = 1; i < N_NODES; i++) {
        while (parent < i && filled >= capOf(parent)) { parent++; filled = 0; }
        if (parent >= i) parent = i - 1;
        if (childStart[parent] < 0) childStart[parent] = i;
        counts[parent]++; filled++;
    }
    const makers: ((k: number, a: any, b: any, c: any) => any)[] = [];
    for (let s = 0; s < SHAPES; s++) {
        const f = SHAPE_FLD[s];
        const asg = f.map((fld, j) => `if (k >= ${j + 1}) o.${fld.name} = ${fld.list ? `[${'abc'[j]}]` : 'abc'[j]};`).join(' ');
        makers.push(new Function(`return function make(k,a,b,c){const o={pad${s}:${s},${f.map((x) => `${x.name}:null`).join(',')}};${asg};return o}`)() as never);
    }
    const all: BNode[] = new Array(N_NODES);
    for (let i = N_NODES - 1; i >= 0; i--) {
        const k = counts[i], cs = childStart[i], t = i % SHAPES;
        all[i] = { type: t, sym: 0, data: k === 0 ? null : makers[t](k, all[cs], all[cs + 1], all[cs + 2]) };
    }
    return all;
}
const TREE = build();
const ROOT = TREE[0];

// Read-only descent source, shared by the arms that build one big switch.
const switchBody = (): string => {
    let s = 'const d=n.data;if(d===null)return;switch(n.type){';
    for (let t = 0; t < SHAPES; t++) {
        s += `case ${t}:{`;
        for (const f of SHAPE_FLD[t]) {
            const key = JSON.stringify(f.name);
            s += f.list
                ? `{const a=d[${key}];if(a!=null){for(let i=0;i<a.length;i++){const c=a[i];if(c!=null)V(state,c);}}}`
                : `{const c=d[${key}];if(c!=null)V(state,c);}`;
        }
        s += 'return;}';
    }
    return `${s}}`;
};
// Per-type descent source, for the arms that build a table of small functions.
const tableBody = (t: number): string => {
    let s = 'const d=n.data;if(d===null)return;';
    for (const f of SHAPE_FLD[t]) {
        const key = JSON.stringify(f.name);
        s += f.list
            ? `{const a=d[${key}];if(a!=null){for(let i=0;i<a.length;i++){const c=a[i];if(c!=null)V(state,c);}}}`
            : `{const c=d[${key}];if(c!=null)V(state,c);}`;
    }
    return s;
};

// ── ARM 1: ONE BIG SWITCH (today's `descendVisit`) ───────────────────────────────────────────────
const descend_sw1 = new Function('state', 'n', 'V', switchBody()) as (s: any, n: BNode, V: any) => void;
function visit_sw1(state: any, node: BNode | null): void {
    if (node === null) return;
    const t = node.type;
    if (t < SPECIFIC) state.n += t; // collect-like work, then descend as the real arms do
    descend_sw1(state, node, visit_sw1);
}

// ── ARM 2: byte-identical CONTROL of arm 1 ───────────────────────────────────────────────────────
const descend_sw2 = new Function('state', 'n', 'V', switchBody()) as (s: any, n: BNode, V: any) => void;
function visit_sw2(state: any, node: BNode | null): void {
    if (node === null) return;
    const t = node.type;
    if (t < SPECIFIC) state.n += t; // collect-like work, then descend as the real arms do
    descend_sw2(state, node, visit_sw2);
}

// ── ARM 3: TABLE of small codegen'd functions (traverse's winning shape) ─────────────────────────
// `V` is passed as an argument, matching arm 1, so the only variable is switch-vs-table.
const TBL: ((state: any, n: BNode, V: any) => void)[] = Array.from({ length: SHAPES }, (_, t) =>
    new Function('state', 'n', 'V', tableBody(t)) as never);
function visit_tbl(state: any, node: BNode | null): void {
    if (node === null) return;
    const t = node.type;
    if (t < SPECIFIC) state.n += t; // collect-like work, then descend as the real arms do
    TBL[t](state, node, visit_tbl);
}

// ── ARM 4: TABLE with `V` closed over rather than passed ─────────────────────────────────────────
// Pass the function itself, never an arrow: an arrow adds a call layer the other arms do not have.
const TBL_C: ((state: any, n: BNode) => void)[] = Array.from({ length: SHAPES }, (_, t) =>
    new Function('V', `return function(state,n){${tableBody(t)}}`)(visit_tblc) as never);
function visit_tblc(state: any, node: BNode | null): void {
    if (node === null) return;
    const t = node.type;
    if (t < SPECIFIC) state.n += t; // collect-like work, then descend as the real arms do
    TBL_C[t](state, node);
}

// Every arm must produce the same accumulator, or it is not walking the same tree.
let EXPECT = -1;
function same(v: number): number {
    if (EXPECT === -1) EXPECT = v;
    else if (v !== EXPECT) throw new Error(`arm disagrees: ${v} vs ${EXPECT}`);
    return v;
}

group('S1 — semantic descent: one big switch vs table of small functions', () => {
    bench('one big switch (today)', () => { const s = { n: 0 }; visit_sw1(s, ROOT); return same(s.n); });
    bench('one big switch (CONTROL)', () => { const s = { n: 0 }; visit_sw2(s, ROOT); return same(s.n); });
    bench('table of small fns (V passed)', () => { const s = { n: 0 }; visit_tbl(s, ROOT); return same(s.n); });
    bench('table of small fns (V closed over)', () => { const s = { n: 0 }; visit_tblc(s, ROOT); return same(s.n); });
});
