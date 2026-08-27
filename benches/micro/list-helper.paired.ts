// Does a shared delimited-list helper (oxc's shape) cost anything in JS? See ./list-helper.arms.ts.
//
// Same paired round-robin design as `lex-dispatch.paired.ts`, and for the same reason: labs measures
// arms in separate time windows, so a load spike lands on one arm. Paired rounds cancel drift; the
// A' control decides admissibility.
//
// RESULT (2026-08-27, control flat at 1.001x): B 1.08x faster, C 0.12x, **D 0.63x**. D is the arm that
// decides it — one shared helper reached from many call sites with DIFFERENT element parsers, which
// is what a real port looks like. B's speedup is an artifact of having a single callee: V8 keeps that
// site monomorphic and inlines it, which no real port gets.
//
// LIMITATION, stated so the number is not over-read: the per-element work here is one object
// allocation, so call overhead is a large share of each iteration. A real parser does much more work
// per element, so the true cost is SMALLER than 1.6x. The direction is what matters — it is a cost,
// not a win, and that is enough to rule the refactor out on a parser already at parity.
import { inlineLoop, inlineLoop2, sharedHelper, sharedHelperClosure, sharedHelperMegamorphic } from './list-helper.arms.ts';

const ARMS: [string, () => number][] = [
    ['A  inline loop per call site (today)', inlineLoop],
    ["A' identical copy of A (CONTROL)", inlineLoop2],
    ['B  shared helper, hoisted callback', sharedHelper],
    ['C  shared helper, fresh closure', sharedHelperClosure],
    ['D  shared helper, 6 distinct callees', sharedHelperMegamorphic],
];

const ROUNDS = Number(process.env.ROUNDS ?? 400);
const WARMUP = 40;
for (let w = 0; w < WARMUP; w++) for (const [, f] of ARMS) f();

const times: number[][] = ARMS.map(() => []);
for (let r = 0; r < ROUNDS; r++) {
    for (let k = 0; k < ARMS.length; k++) {
        const i = (r + k) % ARMS.length;
        const t0 = process.hrtime.bigint();
        ARMS[i][1]();
        times[i].push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
}

const median = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
function paired(i: number) {
    const ratios: number[] = [];
    for (let r = 0; r < ROUNDS; r++) ratios.push(times[0][r] / times[i][r]);
    const sorted = [...ratios].sort((a, b) => a - b);
    const faster = ratios.filter((x) => x > 1).length;
    const z = (faster - ROUNDS / 2) / Math.sqrt(ROUNDS / 4);
    return { med: median(ratios), lo: sorted[Math.floor(ROUNDS * 0.025)], hi: sorted[Math.floor(ROUNDS * 0.975)], faster, z };
}

console.log(`\npaired round-robin — ${ROUNDS} rounds, ${WARMUP} warmup, order rotated each round`);
console.log(`baseline = ${ARMS[0][0]}  (median ${median(times[0]).toFixed(2)} ms/iter)\n`);
console.log(
    `${'arm'.padEnd(38)}${'median'.padStart(8)}${'speedup'.padStart(10)}${'95% band'.padStart(18)}${'faster'.padStart(10)}${'z'.padStart(9)}`,
);
for (let i = 1; i < ARMS.length; i++) {
    const p = paired(i);
    console.log(
        `${ARMS[i][0].padEnd(38)}${median(times[i]).toFixed(2).padStart(8)}${(p.med.toFixed(3) + 'x').padStart(10)}` +
            `${(p.lo.toFixed(3) + '-' + p.hi.toFixed(3)).padStart(18)}${(p.faster + '/' + ROUNDS).padStart(10)}${p.z.toFixed(1).padStart(9)}${Math.abs(p.z) > 3 ? '  <-- significant' : ''}`,
    );
}
const ctrl = paired(1);
console.log(`\nCONTROL A' vs A: ${ctrl.med.toFixed(3)}x (z=${ctrl.z.toFixed(1)}).`);
console.log(
    Math.abs(ctrl.z) > 3 ? '  INADMISSIBLE — discard all verdicts above.' : '  Control is flat. Verdicts above are admissible.',
);
