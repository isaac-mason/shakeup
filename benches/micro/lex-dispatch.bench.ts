import { bench, group } from '@pmndrs/labs';
import { loopA, loopA2, loopB, loopC, loopD, same } from './lex-dispatch.arms.ts';

// Arm implementations, the measured token mix they are calibrated to, and the full write-up live in
// ./lex-dispatch.arms.ts — shared verbatim with benches/micro/lex-dispatch.paired.ts so both
// instruments measure exactly the same code.
//
// labs measures each arm in its OWN sequential time window, which is why this file could not decide
// the question on a loaded machine (see the RESULT block in the arms module). `lex-dispatch.paired.ts`
// runs the same arms round-robin and compares PAIRED per-round differences instead; use that one
// while the machine is busy, and this one when it is quiet.

group('lexer dispatch: if-chain vs reorder vs class switch @micro @lex', () => {
    bench('A: if-chain, punct last (today)', function* () { yield () => same(loopA()); }).gc(true);
    bench("A': identical copy of A (control)", function* () { yield () => same(loopA2()); }).gc(true);
    bench('B: reorder only, punct first', function* () { yield () => same(loopB()); }).gc(true);
    bench('C: one CHAR lookup + switch on class', function* () { yield () => same(loopC()); }).gc(true);
    bench('D: hoist duplicate CHAR load only', function* () { yield () => same(loopD()); }).gc(true);
});
