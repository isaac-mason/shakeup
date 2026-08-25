import { bench, group } from '@pmndrs/labs';

// `visit`'s generic descent in `analysis/semantic.ts:768`:
//
//     walkChildren(node, (c) => visit(state, c));
//
// Two costs per node: a CLOSURE capturing `state`, and `walkChildren`'s DYNAMIC key
// `data[fields[i].name]` across ~151 hidden classes. `visit` is 7.68% of a crashcat bundling profile —
// half of `semantic.ts`, which is now the single largest file in it.
//
// The alternative is a codegen'd descent that reads each child field by NAME and calls `visit`
// DIRECTLY. That is NOT the same thing as codegen'ing `walkChildren` itself, which measured only 1.04%
// — that arm had to preserve the `(child, fieldName, listIndex)` callback and early exit, and the
// indirect call dominated. `visit` needs none of that, so the callback disappears entirely.
//
// LESSON APPLIED: the visit body below does REALISTIC work (a switch plus a couple of writes), because
// a trivial body makes any wrapper look expensive — that defect produced a fictitious 2.33x for
// `parens` and a fictitious 1.52x for `walkChildren` earlier in this session.
const N_NODES = 138_056;
const SHAPES = 151;
const FIELD_NAMES = ['a', 'b', 'c', 'body', 'left', 'right', 'test', 'argument'];
const SHAPE_FLD = Array.from({ length: SHAPES }, (_, i) =>
    [0, 1, 2].map((j) => ({ name: FIELD_NAMES[(i + j) % FIELD_NAMES.length], list: (i + j) % 7 === 0 })),
);

type BNode = { type: number; sym: number; data: any };

/** A real tree (every node one parent), with ~151 distinct `data` hidden classes and list fields. */
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

/** Today's generic `walkChildren` — dynamic key, list handling, callback. */
function walkChildren(n: BNode, cb: (c: BNode) => void): void {
    const fields = SHAPE_FLD[n.type];
    const d = n.data;
    if (d === null) return;
    for (let i = 0; i < fields.length; i++) {
        const v = d[fields[i].name];
        if (v == null) continue;
        if (fields[i].list) { const arr = v as BNode[]; for (let j = 0; j < arr.length; j++) if (arr[j] != null) cb(arr[j]); }
        else cb(v as BNode);
    }
}

/** Codegen'd descent: static field names, `visit(state, child)` called DIRECTLY, no callback. */
const descend: (state: { n: number }, n: BNode, visit: (s: { n: number }, c: BNode) => void) => void = (() => {
    const cases = SHAPE_FLD.map((f, t) => {
        const reads = f.map((fld) =>
            fld.list
                ? `{const v=d.${fld.name};if(v!=null){for(let j=0;j<v.length;j++){const c=v[j];if(c!=null)visit(state,c);}}}`
                : `{const v=d.${fld.name};if(v!=null)visit(state,v);}`,
        ).join('');
        return `case ${t}:{${reads}return;}`;
    }).join('\n');
    return new Function(`return function descend(state,n,visit){const d=n.data;if(d===null)return;switch(n.type){\n${cases}\n}}`)() as never;
})();

/** Realistic per-node work: a switch with a few arms that write state, as `visit` does. */
function nodeWork(state: { n: number }, n: BNode): void {
    switch (n.type % 8) {
        case 0: state.n += n.type; break;
        case 1: n.sym = state.n & 0xffff; break;
        case 2: state.n ^= n.type; break;
        default: state.n++;
    }
}

let EXPECT = -1;
function same(v: number): number {
    if (EXPECT === -1) EXPECT = v;
    else if (v !== EXPECT) throw new Error(`arm disagrees: ${v} vs ${EXPECT}`);
    return v;
}

group('visit descent: walkChildren+closure vs codegen direct @micro @descend', () => {
    bench('walkChildren(node, c => visit(state, c)) (today)', function* () {
        yield () => {
            const state = { n: 0 };
            const visit = (s: { n: number }, n: BNode): void => {
                nodeWork(s, n);
                walkChildren(n, (c) => visit(s, c));
            };
            visit(state, TREE[0]);
            return same(state.n);
        };
    }).gc(true);

    bench('codegen descent, direct recursion, no closure', function* () {
        yield () => {
            const state = { n: 0 };
            const visit = (s: { n: number }, n: BNode): void => {
                nodeWork(s, n);
                descend(s, n, visit);
            };
            visit(state, TREE[0]);
            return same(state.n);
        };
    }).gc(true);
});
