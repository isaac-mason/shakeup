// PAIRED round-robin comparison of the lexer-dispatch arms in ./lex-dispatch.arms.ts.
//
// Why this exists alongside the labs bench: labs measures each arm in its own sequential time
// window, so a load spike lands on ONE arm and corrupts the comparison. On this machine that made
// the labs result undecidable — across 10 processes the incumbent's own time ranged 5.41-14.82ms
// (126%) while the largest between-arm gap was 21%, and every arm was "fastest" in some process.
//
// A PAIRED design is the standard remedy for exactly that: run every arm once per round, and compare
// arms WITHIN a round. Machine drift is shared by all arms in a round, so it cancels in the paired
// difference even when absolute times swing 2x. Position-in-round bias is cancelled by rotating the
// order every round.
//
// This is NOT the "ad-hoc min-of-N timer" that shakeup's benchmarking rule warns against. It reports
// a distribution, not a minimum; it is paired; and it carries a NEGATIVE CONTROL (A', a byte-identical
// copy of A). The control decides admissibility: if A' vs A does not land on ~1.000x, the instrument
// is measuring itself and every other verdict here is void.
import { loopA, loopA2, loopB, loopC, loopD } from './lex-dispatch.arms.ts';

const ARMS: [string, () => number][] = [
    ['A  if-chain, punct last (today)', loopA],
    ["A' identical copy of A (CONTROL)", loopA2],
    ['B  reorder only, punct first', loopB],
    ['C  one CHAR lookup + class switch', loopC],
    ['D  hoist duplicate CHAR load only', loopD],
];

const ROUNDS = Number(process.env.ROUNDS ?? 400);
const WARMUP = 40;

// Warm every arm to steady-state JIT before any timing is recorded.
for (let w = 0; w < WARMUP; w++) for (const [, f] of ARMS) f();

const times: number[][] = ARMS.map(() => []);
for (let r = 0; r < ROUNDS; r++) {
    // Rotate the starting arm each round so no arm sits in a privileged position.
    for (let k = 0; k < ARMS.length; k++) {
        const i = (r + k) % ARMS.length;
        const t0 = process.hrtime.bigint();
        ARMS[i][1]();
        times[i].push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Paired comparison of arm `i` against the baseline arm 0, round by round. */
function paired(i: number) {
    const ratios: number[] = [];
    for (let r = 0; r < ROUNDS; r++) ratios.push(times[0][r] / times[i][r]);
    const sorted = [...ratios].sort((a, b) => a - b);
    const faster = ratios.filter((x) => x > 1).length;
    // Sign test: under "no difference", #faster ~ Binomial(n, 0.5). Normal approximation is ample at n=400.
    const z = (faster - ROUNDS / 2) / Math.sqrt(ROUNDS / 4);
    return {
        med: median(ratios),
        lo: sorted[Math.floor(ROUNDS * 0.025)],
        hi: sorted[Math.floor(ROUNDS * 0.975)],
        faster,
        z,
    };
}

console.log(`\npaired round-robin — ${ROUNDS} rounds, ${WARMUP} warmup, order rotated each round`);
console.log(`baseline = ${ARMS[0][0]}  (median ${median(times[0]).toFixed(2)} ms/iter)\n`);
console.log(`${'arm'.padEnd(34)}${'median'.padStart(8)}${'speedup'.padStart(10)}${'95% band'.padStart(18)}${'faster'.padStart(10)}${'z'.padStart(9)}`);
for (let i = 1; i < ARMS.length; i++) {
    const p = paired(i);
    const sig = Math.abs(p.z) > 3 ? '  <-- significant' : '';
    console.log(
        `${ARMS[i][0].padEnd(34)}${median(times[i]).toFixed(2).padStart(8)}${(p.med.toFixed(3) + 'x').padStart(10)}` +
        `${(p.lo.toFixed(3) + '-' + p.hi.toFixed(3)).padStart(18)}${(p.faster + '/' + ROUNDS).padStart(10)}${p.z.toFixed(1).padStart(9)}${sig}`,
    );
}
const ctrl = paired(1);
console.log(`\nCONTROL A' vs A: ${ctrl.med.toFixed(3)}x (z=${ctrl.z.toFixed(1)}).`);
console.log(Math.abs(ctrl.z) > 3
    ? "  INADMISSIBLE — the control moved, so the instrument is measuring itself. Discard all verdicts above."
    : "  Control is flat, as it must be. Verdicts above are admissible.");
