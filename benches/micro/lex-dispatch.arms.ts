
// Lexer token dispatch — `nextToken`'s arm chain (src/parser/lexer.ts:245 onward).
//
// oxc dispatches on the next byte through a 256-entry table of handler functions
// (crates/oxc_parser/src/lexer/byte_handlers.rs — `byte_handlers[byte as usize](self)`), so every
// token kind costs the SAME O(1) dispatch. shakeup walks an if-chain instead, and the chain is
// ordered against the measured reality:
//
//   arm            three.core.js   crashcat/src   failed tests before it fires
//   1-ident            39.1%          41.8%          0
//   2-number            4.9%           4.1%          1
//   3-string            1.1%           0.4%          2
//   4-template          1.5%           0.0%          4
//   5-private           0.0%           0.0%          5
//   6-punct            53.3%          53.6%          6      <- the MAJORITY arm is LAST
//
//   -> 3.33 (three) / 3.27 (crashcat) failed dispatch tests per token.
//
// Punctuation additionally re-reads `CHAR[c]` two or three times (once for the C_ID test, once for
// C_DIG, once more for the `.`-then-digit probe) before reaching PUNCT1.
//
// Three arms, because there are two independent hypotheses and they must not be confounded:
//   A  today's chain                      (incumbent)
//   B  reorder only — punct probed first  (isolates "the order is wrong")
//   C  one CHAR lookup + switch on class  (isolates "the chain itself is wrong" — the JS analogue
//      of oxc's byte handlers: a jump table, but with INLINE arms, not a table of function pointers.
//      That distinction matters: the fused dispatch table tried earlier regressed traverse 11.6% ->
//      16.2% precisely because it collapsed 18 inline caches into one megamorphic CALL.)
//
// RESULT — MEASURED, RESOLVED, AND THE LEXER WAS LEFT UNCHANGED. The chain is already the best of
// the four; the "53% of tokens pay 6 failed tests" theory is real in COUNT and worth ~nothing in TIME.
//
// Verdict from the paired harness (./lex-dispatch.paired.ts), 1500 rounds, control flat at 1.005x
// (z=0.8) so the comparison is admissible:
//
//   A'  identical copy of A (CONTROL)   1.005x   z= 0.8   flat, as it must be
//   B   reorder only, punct first       1.003x   z= 0.7   FLAT — no win
//   C   one CHAR lookup + class switch  0.951x   z=-8.2   4.9% SLOWER
//   D   hoist duplicate CHAR load       0.984x   z=-3.2   1.6% SLOWER
//
// B and C reproduce across independent 400- and 1500-round runs, so this is settled, not provisional.
//
// WHY the count-based theory failed: those six failed tests are register-cheap compares on a value
// already in hand, and the branch predictor learns them (the token stream is highly repetitive). Both
// "fixes" pay for their skipped compares with an EXTRA TABLE LOAD on the hot path — PUNCT1 in B,
// CHAR2 in C — and C additionally doubles the table footprint competing for L1. A load costs more
// than the predicted compares it removes. Same lesson as node-touch-counts: a work-COUNT proxy
// mispriced the real cost. oxc's 256-entry byte-handler table is the right design in Rust, where the
// handler is a direct static call and the table is hot; it does not carry over.
//
// MEASUREMENT NOTE — this could not be decided by `pnpm bench` alone on a loaded machine, and the
// first three attempts to do so all produced DIFFERENT winners. labs runs each arm in its own
// sequential window, so a load spike lands on one arm. A saved multi-block run (labs >= 0.8,
// 8 fresh processes) quantified why: "Median spread +-23.3% across 8 fresh runs, comparison
// resolution ~+-32.6%, clock explains ~0%" — every effect here is far under that floor. The paired
// round-robin above cancels the drift instead of trying to average it away, and its control proves it.
//
// Bodies are the REAL scan work (identifier loop + imul hash + keyword gate, number, string, punct
// table), not a constant return. A trivial body has twice produced a bench that predicted a win and
// delivered nothing (`parens` 2.33x -> zero; codegen'd `walkChildren` 1.52x -> 1.04%).

const C_WS = 1, C_NL = 2, C_ID = 3, C_DIG = 4;
// Extended classes for arm C. Values continue the existing enum so the table stays one Uint8Array.
const C_PUNCT = 5, C_QUOTE = 6, C_TICK = 7, C_HASH = 8;

const CHAR = new Uint8Array(128);
const CHAR2 = new Uint8Array(128);
{
    for (let i = 0; i < 128; i++) {
        const ch = String.fromCharCode(i);
        if (i === 10 || i === 13) { CHAR[i] = C_NL; CHAR2[i] = C_NL; }
        else if (i === 32 || i === 9 || i === 11 || i === 12) { CHAR[i] = C_WS; CHAR2[i] = C_WS; }
        else if (/[A-Za-z_$]/.test(ch)) { CHAR[i] = C_ID; CHAR2[i] = C_ID; }
        else if (i >= 48 && i <= 57) { CHAR[i] = C_DIG; CHAR2[i] = C_DIG; }
    }
    // Arm C only: classify what the chain tests for individually.
    CHAR2[34] = C_QUOTE; CHAR2[39] = C_QUOTE; CHAR2[96] = C_TICK; CHAR2[35] = C_HASH;
    for (const p of '{}()[];,<>+-*/%&|^!~?:=.') CHAR2[p.charCodeAt(0)] ||= C_PUNCT;
}

// Single-char punctuation token ids (stand-in for PUNCT1; value is irrelevant, presence is not).
const PUNCT1 = new Uint8Array(128);
{ let n = 100; for (const p of '{}()[];,<>+-*/%&|^!~?:=.') PUNCT1[p.charCodeAt(0)] = n++; }

const T_IDENT = 1, T_NUM = 2, T_STR = 3, T_TMPL = 4, T_PRIV = 5;
const KEYWORDS = new Set(['const','let','var','function','return','if','else','for','while','new','this','class','import','export','from','of','in','typeof','async','await']);

type St = { src: string; srcLen: number; pos: number; tok: number; tokStart: number; tokEnd: number; tokHash: number };

// ---- shared real bodies (identical code for all three arms; only DISPATCH differs) ----

function scanIdent(s: St, c: number): void {
    const src = s.src, srcLen = s.srcLen;
    let pos = s.pos, h = c;
    pos++;
    while (pos < srcLen) {
        const cc = src.charCodeAt(pos);
        if (cc < 128) { const cl = CHAR[cc]; if (cl !== C_ID && cl !== C_DIG) break; }
        h = (Math.imul(h, 31) + cc) | 0;
        pos++;
    }
    s.pos = pos; s.tokHash = h; s.tokEnd = pos;
    // Keyword gate: only for a lowercase first char, as the real lexer does.
    s.tok = c >= 0x61 && c <= 0x7a && KEYWORDS.has(src.slice(s.tokStart, pos)) ? 90 : T_IDENT;
}

function scanNumber(s: St): void {
    const src = s.src, srcLen = s.srcLen;
    let pos = s.pos;
    while (pos < srcLen) { const cc = src.charCodeAt(pos); if (!(CHAR[cc] === C_DIG || cc === 46)) break; pos++; }
    s.pos = pos; s.tok = T_NUM; s.tokEnd = pos;
}

function scanString(s: St, q: number): void {
    const src = s.src, srcLen = s.srcLen;
    let pos = s.pos + 1;
    while (pos < srcLen) {
        const cc = src.charCodeAt(pos);
        if (cc === q) { pos++; break; }
        if (cc === 92) pos += 2; else pos++;
    }
    s.pos = pos; s.tok = T_STR; s.tokEnd = pos;
}

function scanTemplate(s: St): void {
    const src = s.src, srcLen = s.srcLen;
    let pos = s.pos + 1;
    while (pos < srcLen) { const cc = src.charCodeAt(pos); if (cc === 96) { pos++; break; } pos++; }
    s.pos = pos; s.tok = T_TMPL; s.tokEnd = pos;
}

function scanPrivate(s: St): void {
    const src = s.src, srcLen = s.srcLen;
    let pos = s.pos + 1, h = 0;
    while (pos < srcLen) { const cc = src.charCodeAt(pos); if (cc < 128 && CHAR[cc] !== C_ID && CHAR[cc] !== C_DIG) break; h = (Math.imul(h, 31) + cc) | 0; pos++; }
    s.pos = pos; s.tokHash = h; s.tok = T_PRIV; s.tokEnd = pos;
}

/** Whitespace/comment skip — shared verbatim, so it never differentiates the arms. */
function skipTrivia(s: St): boolean {
    const src = s.src, srcLen = s.srcLen;
    let pos = s.pos;
    while (pos < srcLen) {
        const c = src.charCodeAt(pos);
        if (c < 128) {
            const cls = CHAR[c];
            if (cls === C_WS || cls === C_NL) { pos++; continue; }
            if (c === 47) {
                const c1 = src.charCodeAt(pos + 1);
                if (c1 === 47) { const nl = src.indexOf('\n', pos + 2); pos = nl < 0 ? srcLen : nl; continue; }
                if (c1 === 42) { const e = src.indexOf('*/', pos + 2); pos = e < 0 ? srcLen : e + 2; continue; }
            }
        }
        break;
    }
    s.pos = pos; s.tokStart = pos;
    return pos < srcLen;
}

// ---- A: today's chain ----
function nextA(s: St): void {
    if (!skipTrivia(s)) { s.tok = 0; return; }
    const src = s.src, pos = s.pos, c = src.charCodeAt(pos);
    if (c < 128 ? CHAR[c] === C_ID : true) { scanIdent(s, c); return; }
    if (CHAR[c] === C_DIG || (c === 46 && CHAR[src.charCodeAt(pos + 1)] === C_DIG)) { scanNumber(s); return; }
    if (c === 34 || c === 39) { scanString(s, c); return; }
    if (c === 96) { scanTemplate(s); return; }
    if (c === 35) { scanPrivate(s); return; }
    const p1 = PUNCT1[c];
    if (p1 !== 0) { s.pos = pos + 1; s.tok = p1; s.tokEnd = pos + 1; return; }
    s.pos = pos + 1; s.tok = 99; s.tokEnd = pos + 1;
}

// ---- B: reorder only — punct probed first, chain otherwise identical ----
function nextB(s: St): void {
    if (!skipTrivia(s)) { s.tok = 0; return; }
    const src = s.src, pos = s.pos, c = src.charCodeAt(pos);
    const p1 = c < 128 ? PUNCT1[c] : 0;
    if (p1 !== 0 && !(c === 46 && CHAR[src.charCodeAt(pos + 1)] === C_DIG)) {
        s.pos = pos + 1; s.tok = p1; s.tokEnd = pos + 1; return;
    }
    if (c < 128 ? CHAR[c] === C_ID : true) { scanIdent(s, c); return; }
    if (CHAR[c] === C_DIG || c === 46) { scanNumber(s); return; }
    if (c === 34 || c === 39) { scanString(s, c); return; }
    if (c === 96) { scanTemplate(s); return; }
    if (c === 35) { scanPrivate(s); return; }
    s.pos = pos + 1; s.tok = 99; s.tokEnd = pos + 1;
}

// ---- C: one CHAR lookup + switch on class (oxc byte-handler analogue, inline arms) ----
function nextC(s: St): void {
    if (!skipTrivia(s)) { s.tok = 0; return; }
    const src = s.src, pos = s.pos, c = src.charCodeAt(pos);
    const cls = c < 128 ? CHAR2[c] : C_ID;
    switch (cls) {
        case C_ID: scanIdent(s, c); return;
        case C_DIG: scanNumber(s); return;
        case C_PUNCT: {
            // `.` followed by a digit is a number — one extra test, paid only by `.`.
            if (c === 46 && CHAR[src.charCodeAt(pos + 1)] === C_DIG) { scanNumber(s); return; }
            s.pos = pos + 1; s.tok = PUNCT1[c]; s.tokEnd = pos + 1; return;
        }
        case C_QUOTE: scanString(s, c); return;
        case C_TICK: scanTemplate(s); return;
        case C_HASH: scanPrivate(s); return;
        default: s.pos = pos + 1; s.tok = 99; s.tokEnd = pos + 1; return;
    }
}

// ---- D: minimal — hoist the duplicated CHAR[c] load, chain and order otherwise UNCHANGED ----
// A reads CHAR[c] twice (the C_ID test, then C_DIG) and a third time for the `.`-digit probe.
// This removes the duplicate loads and NOTHING else: no new table, no reordering. It is strictly
// less work than A with identical structure, which makes it the honest floor for this idea.
function nextD(s: St): void {
    if (!skipTrivia(s)) { s.tok = 0; return; }
    const src = s.src, pos = s.pos, c = src.charCodeAt(pos);
    const cls = c < 128 ? CHAR[c] : C_ID;
    if (cls === C_ID) { scanIdent(s, c); return; }
    if (cls === C_DIG || (c === 46 && CHAR[src.charCodeAt(pos + 1)] === C_DIG)) { scanNumber(s); return; }
    if (c === 34 || c === 39) { scanString(s, c); return; }
    if (c === 96) { scanTemplate(s); return; }
    if (c === 35) { scanPrivate(s); return; }
    const p1 = PUNCT1[c];
    if (p1 !== 0) { s.pos = pos + 1; s.tok = p1; s.tokEnd = pos + 1; return; }
    s.pos = pos + 1; s.tok = 99; s.tokEnd = pos + 1;
}

// ---- input: synthetic source calibrated to the MEASURED token mix ----
function makeSource(approxTokens: number): string {
    // Weights from the tally above (three.core.js / crashcat agree within 1pt).
    const idents = ['value','this','geometry','_matrix','THREE','x','material','update','i','renderer','Vector3','count'];
    const puncts = ['.', '(', ')', ',', ';', '=', '{', '}', '[', ']', '+', '*', '<', '>', ':', '-'];
    const nums = ['0', '1', '2.5', '255', '0.001', '16'];
    const kws = ['const','return','if','function','new','this','for','let'];
    const out: string[] = [];
    let seed = 987654321;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < approxTokens; i++) {
        const r = rnd() % 1000;
        if (r < 533) out.push(puncts[rnd() % puncts.length]);          // 53.3% punctuation
        else if (r < 860) out.push(idents[rnd() % idents.length]);      // 32.7% identifiers
        else if (r < 924) out.push(kws[rnd() % kws.length]);            //  6.4% keywords
        else if (r < 973) out.push(nums[rnd() % nums.length]);          //  4.9% numbers
        else if (r < 984) out.push(`'str${rnd() % 100}'`);              //  1.1% strings
        else if (r < 999) out.push('`tpl`');                            //  1.5% templates
        else out.push('/* c */');                                       //  trivia
        if ((rnd() & 7) === 0) out.push(' ');
        if ((rnd() & 63) === 0) out.push('\n');
    }
    return out.join(' ');
}

const SRC = makeSource(200_000);

export function newSt(): St { return { src: SRC, srcLen: SRC.length, pos: 0, tok: 0, tokStart: 0, tokEnd: 0, tokHash: 0 }; }

/** Checksum every token so the arms must agree on kind, span AND hash — not just token count.
 *
 * BENCH DEFECT FIXED HERE: this was once a single `run(next)` taking the dispatch as a PARAMETER.
 * That made the `next(s)` call site megamorphic across the four arms, and it dominated what was
 * being measured — going from 3 arms to 4 moved the INCUMBENT's own time 7.64ms -> 10.29ms and
 * flipped the A/B ordering. Each arm now gets its own loop with a DIRECT call, so the dispatch under
 * test is the only thing that differs. (Same defect class as the "fake switch arm that was really a
 * megamorphic call table" caught earlier.) */
// Four TEXTUALLY SEPARATE loops. A single parameterised `run(next)` was the first version of this
// bench and it was a defect: the `next(s)` call site was shared by every arm, so it went megamorphic
// and dominated the measurement — going from 3 arms to 4 moved the INCUMBENT's own time
// 7.64ms -> 10.29ms and flipped the A/B ordering. A closure factory (`mkRun(next)`) is not a reliable
// fix either, since all four closures share one function body and may share a feedback vector.
// Duplicating the loop is the only version with no shared call site to contaminate the result.
// (Same defect class as the "fake switch arm that was really a megamorphic call table" caught
// earlier in this codebase.)
export function loopA(): number {
    const s = newSt(); let acc = 0, n = 0;
    for (;;) { nextA(s); if (s.tok === 0) break; acc = (acc * 31 + s.tok + s.tokEnd - s.tokStart + s.tokHash) | 0; if (++n > 5_000_000) break; }
    return (acc ^ n) | 0;
}
export function loopB(): number {
    const s = newSt(); let acc = 0, n = 0;
    for (;;) { nextB(s); if (s.tok === 0) break; acc = (acc * 31 + s.tok + s.tokEnd - s.tokStart + s.tokHash) | 0; if (++n > 5_000_000) break; }
    return (acc ^ n) | 0;
}
export function loopC(): number {
    const s = newSt(); let acc = 0, n = 0;
    for (;;) { nextC(s); if (s.tok === 0) break; acc = (acc * 31 + s.tok + s.tokEnd - s.tokStart + s.tokHash) | 0; if (++n > 5_000_000) break; }
    return (acc ^ n) | 0;
}
export function loopD(): number {
    const s = newSt(); let acc = 0, n = 0;
    for (;;) { nextD(s); if (s.tok === 0) break; acc = (acc * 31 + s.tok + s.tokEnd - s.tokStart + s.tokHash) | 0; if (++n > 5_000_000) break; }
    return (acc ^ n) | 0;
}

export let EXPECT: number | null = null;
export function same(v: number): number {
    if (EXPECT === null) EXPECT = v;
    else if (v !== EXPECT) throw new Error(`arm disagrees: ${v} vs ${EXPECT}`);
    return v;
}
// Fail fast at load time rather than mid-measurement.
same(loopA()); same(loopB()); same(loopC()); same(loopD());


/** NEGATIVE CONTROL — a byte-identical duplicate of `nextA`/`loopA` under a different name.
 *  Any instrument that reports A' as meaningfully different from A is measuring itself, not the
 *  code, and its verdict on B/C/D must be discarded. This is the arm that decides whether the
 *  measurement is admissible at all. */
function nextA2(s: St): void {
    if (!skipTrivia(s)) { s.tok = 0; return; }
    const src = s.src, pos = s.pos, c = src.charCodeAt(pos);
    if (c < 128 ? CHAR[c] === C_ID : true) { scanIdent(s, c); return; }
    if (CHAR[c] === C_DIG || (c === 46 && CHAR[src.charCodeAt(pos + 1)] === C_DIG)) { scanNumber(s); return; }
    if (c === 34 || c === 39) { scanString(s, c); return; }
    if (c === 96) { scanTemplate(s); return; }
    if (c === 35) { scanPrivate(s); return; }
    const p1 = PUNCT1[c];
    if (p1 !== 0) { s.pos = pos + 1; s.tok = p1; s.tokEnd = pos + 1; return; }
    s.pos = pos + 1; s.tok = 99; s.tokEnd = pos + 1;
}
export function loopA2(): number {
    const s = newSt(); let acc = 0, n = 0;
    for (;;) { nextA2(s); if (s.tok === 0) break; acc = (acc * 31 + s.tok + s.tokEnd - s.tokStart + s.tokHash) | 0; if (++n > 5_000_000) break; }
    return (acc ^ n) | 0;
}
same(loopA2());
