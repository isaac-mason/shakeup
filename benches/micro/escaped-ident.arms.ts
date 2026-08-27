// Arms for `escaped-ident.paired.ts`: does the escaped-identifier hook cost anything?
//
// The change adds ONE integer comparison (`cc === 92`) to the identifier scan's break branch. The
// branch was already taken exactly once per identifier and the comparison is never true in real
// code, so the expectation is zero — but "expected free" is exactly the claim this repo requires a
// bench for. Both arms run the FULL loop over a real corpus string so the measurement includes the
// same cache behaviour the parser sees, not a synthetic ident-only input.
import { readFileSync } from 'node:fs';
import { CHAR } from '../../src/parser/lexer.ts';

const C_DIG = 2;
const C_ID = 3;

/** A real file, so the identifier/punctuation/whitespace mix is representative. */
export const SRC: string = readFileSync(new URL('../../src/parser/parser.ts', import.meta.url), 'utf8');

/** The identifier scan as it was BEFORE the escaped-identifier work. */
export function loopBefore(): number {
    const src = SRC;
    const srcLen = src.length;
    let n = 0;
    for (let start = 0; start < srcLen; start++) {
        const c = src.charCodeAt(start);
        if (c >= 128 || CHAR[c] !== C_ID) continue;
        let h = c;
        let pos = start + 1;
        while (pos < srcLen) {
            const cc = src.charCodeAt(pos);
            if (cc < 128) {
                const cl = CHAR[cc];
                if (cl !== C_ID && cl !== C_DIG) break;
            } else if (cc === 0x2028 || cc === 0x2029) break;
            h = (Math.imul(h, 31) + cc) | 0;
            pos++;
        }
        n = (n + h) | 0;
        start = pos;
    }
    return n;
}

/** Byte-identical copy of `loopBefore` — the NEGATIVE CONTROL. If this does not land on ~1.000x
 *  against `loopBefore`, the instrument is measuring itself and every other verdict is void. */
export function loopBeforeControl(): number {
    const src = SRC;
    const srcLen = src.length;
    let n = 0;
    for (let start = 0; start < srcLen; start++) {
        const c = src.charCodeAt(start);
        if (c >= 128 || CHAR[c] !== C_ID) continue;
        let h = c;
        let pos = start + 1;
        while (pos < srcLen) {
            const cc = src.charCodeAt(pos);
            if (cc < 128) {
                const cl = CHAR[cc];
                if (cl !== C_ID && cl !== C_DIG) break;
            } else if (cc === 0x2028 || cc === 0x2029) break;
            h = (Math.imul(h, 31) + cc) | 0;
            pos++;
        }
        n = (n + h) | 0;
        start = pos;
    }
    return n;
}

/** The scan AFTER: the same loop with the `\` hook on the break branch. */
export function loopAfter(): number {
    const src = SRC;
    const srcLen = src.length;
    let n = 0;
    for (let start = 0; start < srcLen; start++) {
        const c = src.charCodeAt(start);
        if (c >= 128 || CHAR[c] !== C_ID) continue;
        let h = c;
        let pos = start + 1;
        while (pos < srcLen) {
            const cc = src.charCodeAt(pos);
            if (cc < 128) {
                const cl = CHAR[cc];
                if (cl !== C_ID && cl !== C_DIG) {
                    if (cc === 92) {
                        n = (n + 1) | 0; // stand-in for the cold call
                        break;
                    }
                    break;
                }
            } else if (cc === 0x2028 || cc === 0x2029) break;
            h = (Math.imul(h, 31) + cc) | 0;
            pos++;
        }
        n = (n + h) | 0;
        start = pos;
    }
    return n;
}

/** The scan after, with the hook moved OUT of the loop body: the loop is byte-identical to
 *  `loopBefore` and the `\\` test happens once, after it exits. Same number of comparisons; the
 *  question is whether keeping the loop body unchanged matters to the JIT. */
export function loopAfterOut(): number {
    const src = SRC;
    const srcLen = src.length;
    let n = 0;
    for (let start = 0; start < srcLen; start++) {
        const c = src.charCodeAt(start);
        if (c >= 128 || CHAR[c] !== C_ID) continue;
        let h = c;
        let pos = start + 1;
        while (pos < srcLen) {
            const cc = src.charCodeAt(pos);
            if (cc < 128) {
                const cl = CHAR[cc];
                if (cl !== C_ID && cl !== C_DIG) break;
            } else if (cc === 0x2028 || cc === 0x2029) break;
            h = (Math.imul(h, 31) + cc) | 0;
            pos++;
        }
        if (src.charCodeAt(pos) === 92) n = (n + 1) | 0; // stand-in for the cold call
        n = (n + h) | 0;
        start = pos;
    }
    return n;
}
