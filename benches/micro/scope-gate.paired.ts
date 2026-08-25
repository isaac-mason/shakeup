// `descend`'s scope lookup: an object-keyed `Map.get` per node, vs a type gate in front of it.
//
// `descend` asks `semantic.nodeScope.get(node)` for EVERY node it walks, to see whether that node
// owns a lexical scope. Instrumented over a crashcat bundle:
//
//     descend() calls            : 1,541,155
//     nodeScope.get() hits       :    28,643  (1.86%)
//     wasted object-keyed lookups: 1,512,512  (98.14%)
//     distinct scope-owning types: 12 of ~151
//
// So 98% of a hash lookup on an OBJECT key buys nothing. Gating on a per-semantic
// `Uint8Array[node.type]` — marked wherever a node is registered in `nodeScope`, so it is sound by
// construction rather than a hand-maintained list — turns the common case into one typed-array load.
import { readFileSync } from 'node:fs';
import { parse } from '../../src/index.ts';
import { type Node, TYPE_COUNT, walkChildren } from '../../src/ast.ts';
import { analyze, createSemantic } from '../../src/analysis/semantic.ts';

const SRC = readFileSync('/Users/isaacmason/Development/shakeup/llm/spikes/node_modules/three/build/three.core.js', 'utf8');
const { program } = parse(SRC, { ts: false, jsx: false });
const sem = createSemantic();
analyze(sem, program);
const nodeScope = sem.nodeScope;

// The gate, built from the real nodeScope exactly as the implementation will build it.
const OWNS = new Uint8Array(TYPE_COUNT);
for (const n of nodeScope.keys()) OWNS[n.type] = 1;

let acc = 0;
function walkA(n: Node): void { const s = nodeScope.get(n); if (s !== undefined) acc += s; walkChildren(n, walkA); }
function walkA2(n: Node): void { const s = nodeScope.get(n); if (s !== undefined) acc += s; walkChildren(n, walkA2); }
function walkB(n: Node): void {
    if (OWNS[n.type] !== 0) { const s = nodeScope.get(n); if (s !== undefined) acc += s; }
    walkChildren(n, walkB);
}
const mk = (f: (n: Node) => void) => () => { acc = 0; f(program); return acc; };
const runA = mk(walkA), runA2 = mk(walkA2), runB = mk(walkB);
const EXPECT = runA();
for (const [nm, f] of [["A'", runA2], ['B', runB]] as const) if (f() !== EXPECT) throw new Error(`${nm} disagrees`);
console.log(`arms agree: scope-id checksum ${EXPECT}`);

const ARMS: [string, () => number][] = [
    ['A  Map.get(node) every node (today)', runA],
    ["A' identical copy of A (CONTROL)", runA2],
    ['B  Uint8Array type gate first', runB],
];
const ROUNDS = Number(process.env.ROUNDS ?? 300);
for (let w = 0; w < 20; w++) for (const [, f] of ARMS) f();
const times: number[][] = ARMS.map(() => []);
for (let r = 0; r < ROUNDS; r++)
    for (let k = 0; k < ARMS.length; k++) {
        const i = (r + k) % ARMS.length;
        const t0 = process.hrtime.bigint();
        ARMS[i][1]();
        times[i].push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
console.log(`\npaired round-robin — ${ROUNDS} rounds over the real three.core.js AST`);
console.log(`${'arm'.padEnd(38)}${'median'.padStart(9)}${'speedup'.padStart(10)}${'faster'.padStart(11)}${'z'.padStart(8)}`);
for (let i = 1; i < ARMS.length; i++) {
    const ratios = times[0].map((t, r) => t / times[i][r]);
    const faster = ratios.filter((x) => x > 1).length;
    const z = (faster - ROUNDS / 2) / Math.sqrt(ROUNDS / 4);
    console.log(`${ARMS[i][0].padEnd(38)}${median(times[i]).toFixed(3).padStart(9)}${(median(ratios).toFixed(3) + 'x').padStart(10)}${(faster + '/' + ROUNDS).padStart(11)}${z.toFixed(1).padStart(8)}${Math.abs(z) > 3 ? '  <-- significant' : ''}`);
}
