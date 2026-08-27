// PAIRED round-robin: what does the escaped-identifier hook cost the identifier scan?
//
// `\u0061` is valid JavaScript that shakeup rejected. Accepting it needs ONE integer comparison in
// the parser's hottest loop, and "one comparison is free" is exactly the kind of claim this repo
// requires a bench for rather than an argument. Two placements were measured against the
// pre-change loop, over a real source file so the character mix is representative.
//
// FINDING, stable across six independent runs:
//   B  hook on the loop's BREAK branch (as shipped)   0.986-0.997x
//   C  hook AFTER the loop, body untouched            0.917-0.972x
// while the control sat at 1.002-1.011x. So the shipped placement costs roughly 1% OF THIS LOOP —
// a fraction of a percent of a whole parse — and the intuitive alternative of leaving the loop body
// byte-identical is three to four times worse, presumably because the extra `charCodeAt` after the
// loop is a real load where the in-loop compare reuses a value already in a register.
//
// ADMISSIBILITY: at ROUNDS >= 1500 the control's own drift (~0.5%) trips the sign test and the
// harness declares itself inadmissible. That gate is doing its job — it means the ABSOLUTE numbers
// here are not trustworthy to better than about a percent. What is trustworthy is the ORDERING,
// which held in every run: control > B > C, with C separated from the other two by far more than
// the control's drift. Do not quote a single figure from one run.
//
// See `lex-dispatch.paired.ts` for why the design is paired with a negative control at all.
import { loopAfter, loopAfterOut, loopBefore, loopBeforeControl } from './escaped-ident.arms.ts';

const ARMS: [string, () => number][] = [
    ['A  identifier scan BEFORE the hook', loopBefore],
    ["A' identical copy of A (CONTROL)", loopBeforeControl],
    ['B  hook INSIDE the loop (as shipped)', loopAfter],
    ['C  hook AFTER the loop', loopAfterOut],
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

const median = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

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
console.log(
    `${'arm'.padEnd(34)}${'median'.padStart(8)}${'speedup'.padStart(10)}${'95% band'.padStart(18)}${'faster'.padStart(10)}${'z'.padStart(9)}`,
);
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
console.log(
    Math.abs(ctrl.z) > 3
        ? '  INADMISSIBLE — the control moved, so the instrument is measuring itself. Discard all verdicts above.'
        : '  Control is flat, as it must be. Verdicts above are admissible.',
);
