// `fireEnter`/`fireExit` — probe every visitor per node, vs a per-node-type hook table.
//
// The traversal fires hooks like this, once per node per phase:
//
//     for (let i = 0; i < vs.length; i++) {
//         const e = vs[i].enter;
//         if (e !== null) { const h = e[node.type]; if (h != null) h(node, ctx); }
//     }
//
// so every node asks EVERY visitor whether it cares. Instrumented over a real crashcat bundle:
//
//     fireEnter invocations : 1,541,801
//     visitor probes        : 11,701,596   (7.6 per node)
//     actual hook calls     :   608,648   (0.39 per node)
//     wasted probes         : 11,092,948  = 94.8% of all probing
//
// Precomputing, per node type, the array of hooks that actually exist collapses those 7.6 probes to
// one table load plus ~0.39 calls.
//
// WHY THIS IS NOT THE FUSED-DISPATCH-TABLE IDEA THAT ALREADY FAILED. That attempt regressed the
// traversal 11.6% -> 16.2% because it collapsed 18 separate call sites into ONE megamorphic call.
// This changes no call-site structure at all: `h(node, ctx)` is already a single shared, already-
// megamorphic site inside the loop. The only thing removed is loop iterations that call nothing.
//
// Uses the REAL compress visitor set and a REAL AST, so the hook density and node-type distribution
// are the shipping ones rather than a guess.
import { readFileSync } from 'node:fs';
import { parse } from '../../src/index.ts';
import { N, type Node, TYPE_COUNT, walkChildren } from '../../src/ast.ts';
import { substituteAlternateSyntax } from '../../src/passes/compress/alternate-syntax.ts';
import { blockFlatten } from '../../src/passes/compress/block-flatten.ts';
import { booleanContext } from '../../src/passes/compress/boolean-context.ts';
import { aliasInline } from '../../src/passes/compress/alias-inline.ts';
import { constProp } from '../../src/passes/compress/const-prop.ts';
import { convertToDottedProperties } from '../../src/passes/compress/dotted-properties.ts';
import { deadCode } from '../../src/passes/compress/dead-code.ts';
import { dropDebugger } from '../../src/passes/compress/drop-debugger.ts';
import { dropUnused } from '../../src/passes/compress/drop-unused.ts';
import { foldConstants } from '../../src/passes/compress/fold-constants.ts';
import { inline } from '../../src/passes/compress/inline.ts';
import { joinVars } from '../../src/passes/compress/join-vars.ts';
import { minimizeConditionalExpr } from '../../src/passes/compress/minimize-conditional.ts';
import { minimizeConditions } from '../../src/passes/compress/minimize-conditions.ts';
import { minimizeExitPoints } from '../../src/passes/compress/minimize-exit-points.ts';
import { minimizeNot } from '../../src/passes/compress/minimize-not.ts';
import { minimizeLogical } from '../../src/passes/compress/minimize-logical.ts';
import { normalize } from '../../src/passes/compress/normalize.ts';
import { removeUnusedExpr } from '../../src/passes/compress/remove-unused-expr.ts';
import type { Visitor } from '../../src/passes/traverse.ts';

const VISITORS: Visitor[] = [
    normalize, blockFlatten, dropDebugger, constProp, aliasInline, deadCode, foldConstants,
    minimizeExitPoints, minimizeConditions, minimizeNot, minimizeConditionalExpr, minimizeLogical,
    booleanContext, convertToDottedProperties, inline, removeUnusedExpr, joinVars, dropUnused,
    substituteAlternateSyntax,
];

type Hook = (node: Node, ctx: unknown) => void;

// Count-only stand-in for the real ctx: hooks are never invoked (invoking them would MUTATE the
// shared AST and make the arms diverge). Both arms therefore do identical hook-selection work and
// differ only in how they FIND the hooks, which is exactly what is under test.
let hits = 0;
const countHit = (): void => { hits++; };

/** A: today — probe every visitor. */
function fireA(node: Node): void {
    for (let i = 0; i < VISITORS.length; i++) {
        const e = VISITORS[i].enter;
        if (e !== null) {
            const h = e[node.type];
            if (h !== null && h !== undefined) countHit();
        }
    }
}
/** A': byte-identical control. */
function fireA2(node: Node): void {
    for (let i = 0; i < VISITORS.length; i++) {
        const e = VISITORS[i].enter;
        if (e !== null) {
            const h = e[node.type];
            if (h !== null && h !== undefined) countHit();
        }
    }
}
/** B: per-node-type table of the hooks that actually exist. Built once. */
const ENTER_BY_TYPE: (Hook[] | null)[] = (() => {
    const t: (Hook[] | null)[] = new Array(TYPE_COUNT).fill(null);
    for (let ty = 0; ty < TYPE_COUNT; ty++) {
        let hooks: Hook[] | null = null;
        for (const v of VISITORS) {
            const h = v.enter?.[ty];
            if (h !== null && h !== undefined) (hooks ??= []).push(h as Hook);
        }
        t[ty] = hooks;
    }
    return t;
})();
function fireB(node: Node): void {
    const hooks = ENTER_BY_TYPE[node.type];
    if (hooks === null) return;
    for (let i = 0; i < hooks.length; i++) countHit();
}

const SRC = readFileSync('/Users/isaacmason/Development/shakeup/llm/spikes/node_modules/three/build/three.core.js', 'utf8');
const { program } = parse(SRC, { ts: false, jsx: false });

function makeRun(fire: (n: Node) => void) {
    const visit = (n: Node): void => { fire(n); walkChildren(n, visit); };
    return () => { hits = 0; visit(program); return hits; };
}
const runA = makeRun(fireA), runA2 = makeRun(fireA2), runB = makeRun(fireB);

const EXPECT = runA();
for (const [nm, f] of [["A'", runA2], ['B', runB]] as const) {
    const v = f();
    if (v !== EXPECT) throw new Error(`${nm} selects a different hook set: ${v} vs ${EXPECT}`);
}
console.log(`hook selection agrees across arms: ${EXPECT.toLocaleString()} hook calls for ${VISITORS.length} visitors`);

const ARMS: [string, () => number][] = [
    ['A  probe every visitor (today)', runA],
    ["A' identical copy of A (CONTROL)", runA2],
    ['B  per-node-type hook table', runB],
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
console.log(`${'arm'.padEnd(36)}${'median'.padStart(9)}${'speedup'.padStart(10)}${'faster'.padStart(11)}${'z'.padStart(8)}`);
for (let i = 1; i < ARMS.length; i++) {
    const ratios = times[0].map((t, r) => t / times[i][r]);
    const faster = ratios.filter((x) => x > 1).length;
    const z = (faster - ROUNDS / 2) / Math.sqrt(ROUNDS / 4);
    console.log(`${ARMS[i][0].padEnd(36)}${median(times[i]).toFixed(3).padStart(9)}${(median(ratios).toFixed(3) + 'x').padStart(10)}${(faster + '/' + ROUNDS).padStart(11)}${z.toFixed(1).padStart(8)}${Math.abs(z) > 3 ? '  <-- significant' : ''}`);
}
