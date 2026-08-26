import { bench, group } from '@pmndrs/labs';

// Each generated walker writes a child slot back UNCONDITIONALLY:
//
//     {const c=node.data["left"]; if(c!=null) node.data["left"] = S(c,ctx);}   // traverse.ts:54
//
// Measured over a crashcat bundle: 731,315 `visitSingle` calls, 2,534 of which actually replaced the
// node — **0.346%**. So 99.65% of those stores write back the value already in the slot. A pointer
// store into an object field costs a GC write barrier; a reference compare does not, and GC is 3.8% of
// the profile.
//
// oxc pays none of this: `walk_expression(&mut expr)` mutates through a reference, so there is no
// write-back at all. JS cannot take a reference to a property slot, so the aligned move is to make the
// store conditional on the value actually changing.
//
// The replacement rate is MEASURED, not guessed — a bench that replaces nothing would make the
// conditional look free, and one that replaces often would make it look pointless.
const N_NODES = 138_056;
const SHAPES = 151;
const REPLACE_RATE = 0.00346;
const FIELD_NAMES = ['a', 'b', 'c', 'body', 'left', 'right', 'test', 'argument'];
const SHAPE_FLD = Array.from({ length: SHAPES }, (_, i) =>
    [0, 1, 2].map((j) => ({ name: FIELD_NAMES[(i + j) % FIELD_NAMES.length], list: (i + j) % 7 === 0 })),
);

type BNode = { type: number; sym: number; data: any };

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

// Deterministic 0.346% of visits replace, via a counter rather than Math.random (reproducible).
const PERIOD = Math.round(1 / REPLACE_RATE); // ~289

function makeWalkers(conditional: boolean): ((node: BNode, ctx: any, S: any, L: any) => void)[] {
    return SHAPE_FLD.map((f) => {
        let body = '';
        for (const fld of f) {
            const key = JSON.stringify(fld.name);
            body += fld.list
                ? `{const a=node.data[${key}]; if(a!=null)L(a,ctx);}\n`
                : conditional
                    ? `{const c=node.data[${key}]; if(c!=null){const r=S(c,ctx); if(r!==c)node.data[${key}]=r;}}\n`
                    : `{const c=node.data[${key}]; if(c!=null)node.data[${key}]=S(c,ctx);}\n`;
        }
        return new Function('node', 'ctx', 'S', 'L', body) as never;
    });
}

// ── ARM 1: unconditional store (today) ───────────────────────────────────────────────────────────
const W_U = makeWalkers(false);
function descend_u(node: BNode, ctx: any): void { if (node.data !== null) W_U[node.type](node, ctx, S_u, L_u); }
function S_u(node: BNode, ctx: any): BNode {
    ctx.n += node.type & 7;
    descend_u(node, ctx);
    if (++ctx.k % PERIOD === 0) return { type: node.type, sym: 0, data: node.data };
    return node;
}
function L_u(list: BNode[], ctx: any): void {
    for (let i = 0; i < list.length; i++) { const el = list[i]; if (el !== null) list[i] = S_u(el, ctx); }
}

// ── ARM 2: byte-identical CONTROL of arm 1 ───────────────────────────────────────────────────────
const W_C = makeWalkers(false);
function descend_c(node: BNode, ctx: any): void { if (node.data !== null) W_C[node.type](node, ctx, S_c, L_c); }
function S_c(node: BNode, ctx: any): BNode {
    ctx.n += node.type & 7;
    descend_c(node, ctx);
    if (++ctx.k % PERIOD === 0) return { type: node.type, sym: 0, data: node.data };
    return node;
}
function L_c(list: BNode[], ctx: any): void {
    for (let i = 0; i < list.length; i++) { const el = list[i]; if (el !== null) list[i] = S_c(el, ctx); }
}

// ── ARM 3: conditional store (oxc-shaped: no store unless it changed) ────────────────────────────
const W_K = makeWalkers(true);
function descend_k(node: BNode, ctx: any): void { if (node.data !== null) W_K[node.type](node, ctx, S_k, L_k); }
function S_k(node: BNode, ctx: any): BNode {
    ctx.n += node.type & 7;
    descend_k(node, ctx);
    if (++ctx.k % PERIOD === 0) return { type: node.type, sym: 0, data: node.data };
    return node;
}
function L_k(list: BNode[], ctx: any): void {
    for (let i = 0; i < list.length; i++) { const el = list[i]; if (el !== null) { const r = S_k(el, ctx); if (r !== el) list[i] = r; } }
}

let EXPECT = -1;
function same(v: number): number {
    if (EXPECT === -1) EXPECT = v;
    else if (v !== EXPECT) throw new Error(`arm disagrees: ${v} vs ${EXPECT}`);
    return v;
}

group(`child write-back — ${(REPLACE_RATE * 100).toFixed(3)}% replacement (measured)`, () => {
    bench('unconditional store (today)', () => { const ctx = { n: 0, k: 0 }; S_u(ROOT, ctx); return same(ctx.n); });
    bench('unconditional store (CONTROL)', () => { const ctx = { n: 0, k: 0 }; S_c(ROOT, ctx); return same(ctx.n); });
    bench('conditional store (oxc shape)', () => { const ctx = { n: 0, k: 0 }; S_k(ROOT, ctx); return same(ctx.n); });
});
