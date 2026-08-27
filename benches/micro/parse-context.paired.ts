// Is a packed parse-context bitfield (oxc's shape) cheaper than separate fields? See ./parse-context.arms.ts.
// Paired round-robin with an A' control, same design as `lex-dispatch.paired.ts`.
//
// RESULT (2026-08-27, control flat at 1.000x): B **1.054x faster**, C 0.989x.
//
// Read it carefully before acting on it. This bench does NOTHING but manipulate context flags, so a
// 5% win here is an upper bound on a quantity that is a small fraction of real parse time — expect
// well under 1% end to end, i.e. unmeasurable. The bitfield's real argument is ERGONOMIC (one word to
// save and restore, instead of ~12 fields each restored by hand at every call site), and that case
// has to stand on its own; the perf case does not carry it.
//
// C is the useful negative: folding the depth COUNTERS into the same word as the flags is SLOWER than
// keeping them separate. If this is ever done, pack the booleans only.
import { bitfield, bitfieldPacked, fields, fields2 } from './parse-context.arms.ts';

const ARMS: [string, () => number][] = [
    ['A  separate fields (today)', fields],
    ["A' identical copy of A (CONTROL)", fields2],
    ['B  packed bitfield', bitfield],
    ['C  bitfield + depth in same word', bitfieldPacked],
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
    const faster = ratios.filter((x) => x > 1).length;
    return { med: median(ratios), faster, z: (faster - ROUNDS / 2) / Math.sqrt(ROUNDS / 4) };
}
console.log(`\npaired round-robin — ${ROUNDS} rounds, order rotated each round`);
console.log(`baseline = ${ARMS[0][0]}  (median ${median(times[0]).toFixed(3)} ms/iter)\n`);
for (let i = 1; i < ARMS.length; i++) {
    const p = paired(i);
    console.log(
        `${ARMS[i][0].padEnd(36)}${median(times[i]).toFixed(3).padStart(9)}${(p.med.toFixed(3) + 'x').padStart(10)}${(p.faster + '/' + ROUNDS).padStart(10)}${('z=' + p.z.toFixed(1)).padStart(9)}${Math.abs(p.z) > 3 ? '  <-- significant' : ''}`,
    );
}
const c = paired(1);
console.log(Math.abs(c.z) > 3 ? '\nCONTROL MOVED — inadmissible, discard the above.' : '\nControl flat — admissible.');
