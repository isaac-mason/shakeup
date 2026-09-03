import { bench, group } from '@pmndrs/labs';

// S3 — can codegen give JS what `#[inline(always)]` gives oxc?
//
// oxc's checker is free when off because `checker::check(kind, self)` is `#[inline(always)]`, so the
// `AstKind` match constant-folds at each call site and the `check_syntax_error` branch disappears.
// JS has no per-call-site specialisation, so a runtime flag stays a live branch.
//
// But this file already builds its walker as SOURCE TEXT at startup (`buildDescendBody`). So the JS
// analogue is not a flag — it is emitting the walker TWICE: once with the check calls spliced into the
// arms that need them, once without, choosing at first use. A no-check build then contains no branch
// at all. Whether that is worth anything over a predictable flag is the question.
//
// Two things are being decided, and they have different audiences:
//   GROUP 1 (checking path, 1 of 8 `analyze` callers): does fusing beat a second walk?
//   GROUP 2 (non-checking path, 7 of 8 callers): what does the fused walker cost them, flag vs codegen?
//
// If group 2 shows the flag costs nothing, S3's codegen trick is unnecessary and fusion is simply free
// for the other callers. That is a perfectly good outcome and the cheaper one to ship.
const N_NODES = 138_056;
const SHAPES = 151;
const RULE_TYPES = 8; // types carrying a checker rule, ~5% of nodes, as the real 13 rules do
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

// A rule body with the shape the real ones have: a strict-mode flag read plus a reserved-word lookup.
const RESERVED = new Set(['implements', 'interface', 'let', 'package', 'private', 'protected', 'public', 'static', 'yield']);
const NAMES = ['x', 'let', 'y', 'static', 'z', 'package', 'w', 'q'];
function rule(state: any, n: BNode): void {
    if ((state.flags & 16) === 0) return;
    if (RESERVED.has(NAMES[n.type & 7])) state.errs++;
}

const descendSrc = (withCheck: boolean): string => {
    let s = 'const d=n.data;if(d===null)return;switch(n.type){';
    for (let t = 0; t < SHAPES; t++) {
        s += `case ${t}:{`;
        if (withCheck && t < RULE_TYPES) s += 'R(state,n);'; // spliced in ONLY for the checking build
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
// The flag build: one generated walker carrying a live `state.check` branch at every rule-bearing arm.
const descendFlagSrc = (): string => {
    let s = 'const d=n.data;if(d===null)return;switch(n.type){';
    for (let t = 0; t < SHAPES; t++) {
        s += `case ${t}:{`;
        if (t < RULE_TYPES) s += 'if(state.check)R(state,n);';
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

// ── plain walker (no checker in the emitted code at all) — the FLOOR ─────────────────────────────
const d_plain = new Function('state', 'n', 'V', 'R', descendSrc(false)) as any;
function visit_plain(state: any, node: BNode | null): void { if (node !== null) d_plain(state, node, visit_plain, rule); }

// ── CONTROL: byte-identical duplicate of the plain walker ────────────────────────────────────────
const d_ctrl = new Function('state', 'n', 'V', 'R', descendSrc(false)) as any;
function visit_ctrl(state: any, node: BNode | null): void { if (node !== null) d_ctrl(state, node, visit_ctrl, rule); }

// ── codegen'd WITH checks (the checking build) ───────────────────────────────────────────────────
const d_gen = new Function('state', 'n', 'V', 'R', descendSrc(true)) as any;
function visit_gen(state: any, node: BNode | null): void { if (node !== null) d_gen(state, node, visit_gen, rule); }

// ── one walker carrying a runtime flag ───────────────────────────────────────────────────────────
const d_flag = new Function('state', 'n', 'V', 'R', descendFlagSrc()) as any;
function visit_flag(state: any, node: BNode | null): void { if (node !== null) d_flag(state, node, visit_flag, rule); }

// ── today: plain walk, then a SECOND flat-stack walk running the rules ───────────────────────────
const d_two = new Function('state', 'n', 'V', 'R', descendSrc(false)) as any;
function visit_two(state: any, node: BNode | null): void { if (node !== null) d_two(state, node, visit_two, rule); }
function separateWalk(state: any, root: BNode): void {
    visit_two(state, root);
    const stack: BNode[] = [root];
    while (stack.length > 0) {
        const n = stack.pop() as BNode;
        if (n.type < RULE_TYPES) rule(state, n);
        const d = n.data;
        if (d === null) continue;
        for (const f of SHAPE_FLD[n.type]) {
            const c = d[f.name];
            if (c == null) continue;
            if (Array.isArray(c)) { for (const e of c) if (e != null) stack.push(e); } else stack.push(c);
        }
    }
}

let E1 = -1, E2 = -1;
const agree = (slot: 1 | 2, v: number): number => {
    if (slot === 1) { if (E1 === -1) E1 = v; else if (v !== E1) throw new Error(`arm disagrees: ${v} vs ${E1}`); }
    else { if (E2 === -1) E2 = v; else if (v !== E2) throw new Error(`arm disagrees: ${v} vs ${E2}`); }
    return v;
};
const ST = () => ({ flags: 16, check: true, errs: 0, n: 0 });

group('S3a — CHECKING path (1 of 8 analyze callers): fuse vs a second walk', () => {
    bench('separate walk (today)', () => { const s = ST(); separateWalk(s, ROOT); return agree(1, s.errs); });
    bench('fused, codegen with checks', () => { const s = ST(); visit_gen(s, ROOT); return agree(1, s.errs); });
    bench('fused, runtime flag = true', () => { const s = ST(); visit_flag(s, ROOT); return agree(1, s.errs); });
});

// The codegen'd NO-CHECK build needs no arm of its own: `descendSrc(false)` is what `visit_plain`
// already is. That identity IS S3's claim — a no-check build contains no branch because the branch was
// never emitted — so the only comparison left is the live flag against that floor.
group('S3b — NON-CHECKING path (7 of 8 callers): what does fusion cost them?', () => {
    bench('codegen without checks = floor', () => { const s = ST(); s.check = false; visit_plain(s, ROOT); return agree(2, s.errs); });
    bench('same walker (CONTROL)', () => { const s = ST(); s.check = false; visit_ctrl(s, ROOT); return agree(2, s.errs); });
    bench('runtime flag = false', () => { const s = ST(); s.check = false; visit_flag(s, ROOT); return agree(2, s.errs); });
});
