import { bench, group } from '@pmndrs/labs';

// `descend` is the single largest item in a fresh crashcat profile: 16.8% self time, ~75.7 ms/bundle,
// with the whole traverse/visit machinery at ~38%. Its hot line is
//
//     WALKERS[node.type](node, ctx, visitSingle, visitList);      // traverse.ts:362,367
//
// Two costs oxc does not pay. (1) The call site is MEGAMORPHIC — 151 distinct `new Function` walkers
// reached through one indirect call. (2) `visitSingle`/`visitList` are passed as ARGUMENTS on every
// call, because each walker is compiled in isolation and cannot close over them.
//
// oxc's `walk_*` functions are statically dispatched: `walk_statement` matches the enum and calls
// `walk_expression` DIRECTLY, no table, no function arguments. The JS analogue is one generated
// function with a `switch` on the type and each descent inlined, calling S/L by name from module scope.
//
// Arms isolate the two effects: table+4args (today) / table+2args (S,L closed over) / switch+2args.
// RISK being tested, not assumed: a 151-case switch with inlined bodies is a very large function and
// V8 may decline to optimise it. That is precisely why this is a bench and not a patch.
//
// Harness discipline: every arm has its OWN textually-separate descend/S/L triple. Sharing one driver
// makes a single call site that all arms flow through, which earlier in this project moved an
// incumbent from 7.64ms to 10.29ms purely by adding a fourth arm.
const N_NODES = 138_056;
const SHAPES = 151;
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

// Hook tables, as `hookTablesFor` produces them: most types have nothing, a minority fire.
// Real measurement: 1,541,801 fireEnter calls -> 608,648 hook calls = 0.39 hooks/node.
const HOOKS: (((n: BNode, ctx: any) => void)[] | null)[] = Array.from({ length: SHAPES }, (_, t) =>
    t % 5 === 0 ? [(n: BNode, ctx: any) => { ctx.n += n.type & 7; }] : null);

// ── ARM 1: table + 4 args (TODAY) ────────────────────────────────────────────────────────────────
const W_T4: ((node: BNode, ctx: any, S: any, L: any) => void)[] = SHAPE_FLD.map((f) => {
    let body = '';
    for (const fld of f) {
        const key = JSON.stringify(fld.name);
        body += fld.list
            ? `{const a=node.data[${key}]; if(a!=null)L(a,ctx);}\n`
            : `{const c=node.data[${key}]; if(c!=null)node.data[${key}]=S(c,ctx);}\n`;
    }
    return new Function('node', 'ctx', 'S', 'L', body) as never;
});
function descend_t4(node: BNode, ctx: any): void {
    if (node.data === null) return;
    W_T4[node.type](node, ctx, S_t4, L_t4);
}
function S_t4(node: BNode, ctx: any): BNode {
    const h = HOOKS[node.type];
    if (h !== null) for (let i = 0; i < h.length; i++) h[i](node, ctx);
    descend_t4(node, ctx);
    return node;
}
function L_t4(list: BNode[], ctx: any): void {
    for (let i = 0; i < list.length; i++) { const el = list[i]; if (el !== null) list[i] = S_t4(el, ctx); }
}

// ── ARM 2: byte-identical CONTROL of arm 1 (the negative control) ─────────────────────────────────
const W_C4: ((node: BNode, ctx: any, S: any, L: any) => void)[] = SHAPE_FLD.map((f) => {
    let body = '';
    for (const fld of f) {
        const key = JSON.stringify(fld.name);
        body += fld.list
            ? `{const a=node.data[${key}]; if(a!=null)L(a,ctx);}\n`
            : `{const c=node.data[${key}]; if(c!=null)node.data[${key}]=S(c,ctx);}\n`;
    }
    return new Function('node', 'ctx', 'S', 'L', body) as never;
});
function descend_c4(node: BNode, ctx: any): void {
    if (node.data === null) return;
    W_C4[node.type](node, ctx, S_c4, L_c4);
}
function S_c4(node: BNode, ctx: any): BNode {
    const h = HOOKS[node.type];
    if (h !== null) for (let i = 0; i < h.length; i++) h[i](node, ctx);
    descend_c4(node, ctx);
    return node;
}
function L_c4(list: BNode[], ctx: any): void {
    for (let i = 0; i < list.length; i++) { const el = list[i]; if (el !== null) list[i] = S_c4(el, ctx); }
}

// ── ARM 3: table + 2 args (S/L closed over, built lazily so they can be referenced) ──────────────
const W_T2: ((node: BNode, ctx: any) => void)[] = SHAPE_FLD.map((f) => {
    let body = '';
    for (const fld of f) {
        const key = JSON.stringify(fld.name);
        body += fld.list
            ? `{const a=node.data[${key}]; if(a!=null)L(a,ctx);}\n`
            : `{const c=node.data[${key}]; if(c!=null)node.data[${key}]=S(c,ctx);}\n`;
    }
    // Pass S/L DIRECTLY. Wrapping them in arrows added a call layer arm 1 does not have, which made
    // this arm look slower for a reason that had nothing to do with dispatch. Declarations hoist, so
    // they are already bound at module-evaluation time.
    return new Function('S', 'L', `return function(node,ctx){${body}}`)(S_t2, L_t2) as never;
});
function descend_t2(node: BNode, ctx: any): void {
    if (node.data === null) return;
    W_T2[node.type](node, ctx);
}
function S_t2(node: BNode, ctx: any): BNode {
    const h = HOOKS[node.type];
    if (h !== null) for (let i = 0; i < h.length; i++) h[i](node, ctx);
    descend_t2(node, ctx);
    return node;
}
function L_t2(list: BNode[], ctx: any): void {
    for (let i = 0; i < list.length; i++) { const el = list[i]; if (el !== null) list[i] = S_t2(el, ctx); }
}

// ── ARM 4: ONE switch, bodies inlined, S/L called directly (the oxc shape) ───────────────────────
const descend_sw: (node: BNode, ctx: any) => void = (() => {
    const cases = SHAPE_FLD.map((f, t) => {
        let body = '';
        for (const fld of f) {
            const key = JSON.stringify(fld.name);
            body += fld.list
                ? `{const a=d[${key}]; if(a!=null)L(a,ctx);}`
                : `{const c=d[${key}]; if(c!=null)d[${key}]=S(c,ctx);}`;
        }
        return `case ${t}:{${body}return;}`;
    }).join('\n');
    return new Function('S', 'L', `return function descend(node,ctx){const d=node.data;if(d===null)return;switch(node.type){\n${cases}\n}}`)(S_sw, L_sw) as never;
})();
function S_sw(node: BNode, ctx: any): BNode {
    const h = HOOKS[node.type];
    if (h !== null) for (let i = 0; i < h.length; i++) h[i](node, ctx);
    descend_sw(node, ctx);
    return node;
}
function L_sw(list: BNode[], ctx: any): void {
    for (let i = 0; i < list.length; i++) { const el = list[i]; if (el !== null) list[i] = S_sw(el, ctx); }
}

// Every arm must produce the same accumulator, or it is not walking the same tree.
let EXPECT = -1;
function same(v: number): number {
    if (EXPECT === -1) EXPECT = v;
    else if (v !== EXPECT) throw new Error(`arm disagrees: ${v} vs ${EXPECT}`);
    return v;
}

group('descend dispatch — 151 walkers over a 138k-node tree', () => {
    bench('table + 4 args (today)', () => { const ctx = { n: 0 }; S_t4(ROOT, ctx); return same(ctx.n); });
    bench('table + 4 args (CONTROL)', () => { const ctx = { n: 0 }; S_c4(ROOT, ctx); return same(ctx.n); });
    bench('table + 2 args (S/L closed over)', () => { const ctx = { n: 0 }; S_t2(ROOT, ctx); return same(ctx.n); });
    bench('one switch + 2 args (oxc shape)', () => { const ctx = { n: 0 }; S_sw(ROOT, ctx); return same(ctx.n); });
});
