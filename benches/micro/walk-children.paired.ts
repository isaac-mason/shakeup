// `walkChildren` — codegen'd static field access vs today's dynamic `data[fields[i].name]`.
//
// `walkChildren` is the ONE walker in the codebase that is not generated. `walk` was codegen'd from
// CHILD_FIELDS (a `switch (n.type)` with static field reads); `walkChildren` still does:
//
//     const fields = FIELDS[n.type];
//     for (...) { const v = data[fields[i].name]; ... cb(c, fields[i].name, j) }
//
// so every child read is a DYNAMIC string key against an object whose hidden class varies across
// ~151 node types — the textbook megamorphic property access — and it re-reads `fields[i].name`
// twice more to pass `(field, listIndex)` arguments that, verified across all 25 call sites, NO
// CALLER USES.
//
// A generated `switch` makes each read static (`d.body`) and monomorphic WITHIN its case arm, since
// `d` there is always one node type's data object. That is exactly the change that took `visit`'s
// descent in semantic.ts from 15.4% -> 13.0%.
//
// WHY BENCH IT AGAIN: this was measured once before at 1.52x isolated / 1.04% end-to-end and shelved.
// Both numbers are now suspect. The isolated arm had a TRIVIAL callback body, which flatters the
// wrapper (the same defect that made `parens` predict 2.33x and deliver zero), and the end-to-end
// number came from a tsx-loader profile that inflated total runtime ~40% and misattributed frames to
// esbuild's `__export` getter thunks. On a clean bundled-ESM profile `walkChildren` is 4.41% of our
// code (58ms), so the ceiling is real.
//
// Paired round-robin with a byte-identical control arm, because this machine's labs comparison
// resolution is ~+-33% (see ./lex-dispatch.paired.ts).
import { readFileSync } from 'node:fs';
import { parse } from '../../src/index.ts';
import { CHILD_FIELDS, N, type Node, walkChildren } from '../../src/ast.ts';

type FieldSpec = { name: string; list: boolean };

/** Generated counterpart: one `switch (n.type)`, static field reads, same `cb` contract. */
function buildChildrenBody(): string {
    let s = 'const d=n.data;if(d===null)return;switch(n.type){';
    for (const [name, fields] of Object.entries(CHILD_FIELDS) as [keyof typeof N, FieldSpec[]][]) {
        if (fields.length === 0) continue;
        s += `case ${N[name]}:{`;
        for (const f of fields) {
            const key = JSON.stringify(f.name);
            s += f.list
                ? `{const a=d[${key}];if(a!=null){for(let i=0;i<a.length;i++){const c=a[i];if(c!=null&&cb(c,${key},i)===false)return;}}}`
                : `{const c=d[${key}];if(c!=null&&cb(c,${key},-1)===false)return;}`;
        }
        s += 'return;}';
    }
    return `${s}}`;
}
const walkChildrenGen = new Function('n', 'cb', buildChildrenBody()) as (
    n: Node,
    cb: (child: Node, field: string, listIndex: number) => boolean | void,
) => void;

const SRC = readFileSync('/Users/isaacmason/Development/shakeup/llm/spikes/node_modules/three/build/three.core.js', 'utf8');
const { program } = parse(SRC, { ts: false, jsx: false });

// REALISTIC body: what the actual callers do — recurse, and touch fields the way `refs.ts` /
// `purity.ts` / `ref-facts.ts` do (type test + sym read + span arithmetic). A body that only
// increments a counter measures the wrapper, not the work.
function makeWalker(wc: typeof walkChildren) {
    let acc = 0;
    const visit = (n: Node): void => {
        if (n.type === N.IdentifierReference || n.type === N.BindingIdentifier) acc = (acc + n.sym + n.end - n.start) | 0;
        wc(n, visit);
    };
    return () => {
        acc = 0;
        visit(program);
        return acc;
    };
}
// Four textually separate loops — a shared parameterised runner would put every arm through one
// megamorphic call site and dominate the measurement (see lex-dispatch.arms.ts).
const runA = makeWalker(walkChildren);
const runA2 = makeWalker(walkChildren);
const runB = makeWalker(walkChildrenGen);

const EXPECT = runA();
for (const [name, f] of [["A'", runA2], ['B', runB]] as const) {
    const v = f();
    if (v !== EXPECT) throw new Error(`${name} disagrees: ${v} vs ${EXPECT}`);
}

const ARMS: [string, () => number][] = [
    ['A  dynamic data[fields[i].name] (today)', runA],
    ["A' identical copy of A (CONTROL)", runA2],
    ['B  codegen static field reads', runB],
];
const ROUNDS = Number(process.env.ROUNDS ?? 300);
for (let w = 0; w < 20; w++) for (const [, f] of ARMS) f();
const times: number[][] = ARMS.map(() => []);
for (let r = 0; r < ROUNDS; r++) {
    for (let k = 0; k < ARMS.length; k++) {
        const i = (r + k) % ARMS.length;
        const t0 = process.hrtime.bigint();
        ARMS[i][1]();
        times[i].push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
}
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
console.log(`\npaired round-robin — ${ROUNDS} rounds over the real three.core.js AST`);
console.log(`${'arm'.padEnd(42)}${'median'.padStart(9)}${'speedup'.padStart(10)}${'faster'.padStart(11)}${'z'.padStart(8)}`);
for (let i = 1; i < ARMS.length; i++) {
    const ratios = times[0].map((t, r) => t / times[i][r]);
    const faster = ratios.filter((x) => x > 1).length;
    const z = (faster - ROUNDS / 2) / Math.sqrt(ROUNDS / 4);
    console.log(`${ARMS[i][0].padEnd(42)}${median(times[i]).toFixed(3).padStart(9)}${(median(ratios).toFixed(3) + 'x').padStart(10)}${(faster + '/' + ROUNDS).padStart(11)}${z.toFixed(1).padStart(8)}${Math.abs(z) > 3 ? '  <-- significant' : ''}`);
}
