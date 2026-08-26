// Lexer / scanner: turns source text into tokens. Owns the char-classification
// table, the newline tracker, the identifier interner, and the scan routines.
// Shared state substrate lives in state.ts; token identities in token.ts.
import { ParseErrorCode } from './errors.ts';
import {
    F_NL,
    P,
    type ParserState,
    raise,
    T_BIGINT,
    T_EOF,
    T_IDENT,
    T_NUM,
    T_PRIVATE,
    T_REGEX,
    T_STR,
    T_TEMPLATE_FULL,
    T_TEMPLATE_HEAD,
} from './state.ts';
import { KEYWORD_ENTRIES } from './token.ts';

const FLATTEN_MIN = 13;

/** Materialize src[start,end) as a string that NEVER retains the source. */
export function sliceFlat(state: ParserState, start: number, end: number): string {
    const s = state.src.slice(start, end);
    return end - start >= FLATTEN_MIN ? (' ' + s).substring(1) : s;
}

function internGrow(state: ParserState): void {
    const oldKeys = state.itKeys,
        oldHashes = state.itHashes;
    const cap = (state.itMask + 1) << 1;
    const itKeys: (string | undefined)[] = new Array(cap);
    const itHashes = new Int32Array(cap);
    const itMask = cap - 1;
    for (let i = 0; i < oldKeys.length; i++) {
        const k = oldKeys[i];
        if (k === undefined) continue;
        const h = oldHashes[i];
        let j = h & itMask;
        while (itKeys[j] !== undefined) j = (j + 1) & itMask;
        itKeys[j] = k;
        itHashes[j] = h;
    }
    state.itKeys = itKeys;
    state.itHashes = itHashes;
    state.itMask = itMask;
}

/** Rolling hash over src[start,end) — same formula the lexer computes inline. */
export function hashRange(state: ParserState, start: number, end: number): number {
    const src = state.src;
    let h = 0;
    for (let i = start; i < end; i++) h = (Math.imul(h, 31) + src.charCodeAt(i)) | 0;
    return h;
}

/** Intern src[start,end) given its rolling hash. The probe is slice-free: hash,
 * then length, then direct charCodeAt comparison against the source. */
export function intern(state: ParserState, start: number, end: number, hash: number): string {
    const src = state.src,
        itKeys = state.itKeys,
        itHashes = state.itHashes,
        itMask = state.itMask;
    let i = hash & itMask;
    const len = end - start;
    for (;;) {
        const k = itKeys[i];
        if (k === undefined) break;
        if (itHashes[i] === hash && k.length === len) {
            let j = 0;
            while (j < len && k.charCodeAt(j) === src.charCodeAt(start + j)) j++;
            if (j === len) return k;
        }
        i = (i + 1) & itMask;
    }
    const s = sliceFlat(state, start, end);
    itKeys[i] = s;
    itHashes[i] = hash;
    if (++state.itCount * 4 > (itMask + 1) * 3) internGrow(state);
    return s;
}

/** Build the line-start table in ONE deferred native scan, decoupled from tokenization
 * (oxc's model: the tokenizer only tracks a per-token "newline before" boolean for ASI;
 * line/column for diagnostics is computed later from byte offsets). `lines[i]` = the start
 * offset of line i+1: line 1 at 0, then the offset after each `\n`. Only `\n` is tracked
 * (matches the old per-token recorder — CR-only and LS/PS were never in the table).
 * `indexOf` runs in V8's C++ memchr, far cheaper than a per-char JS branch scattered
 * through the hot lexer, string, template and comment paths. */
export function buildLineStarts(src: string): Uint32Array {
    const starts: number[] = [0];
    let i = src.indexOf('\n');
    while (i !== -1) {
        starts.push(i + 1);
        i = src.indexOf('\n', i + 1);
    }
    return Uint32Array.from(starts);
}

export const C_WS = 1,
    C_NL = 2,
    C_ID = 3,
    C_DIG = 4;
export const CHAR = new Uint8Array(128);
CHAR[9] = C_WS;
CHAR[11] = C_WS;
CHAR[12] = C_WS;
CHAR[32] = C_WS;
CHAR[10] = C_NL;
CHAR[13] = C_NL;
for (let i = 97; i <= 122; i++) CHAR[i] = C_ID;
for (let i = 65; i <= 90; i++) CHAR[i] = C_ID;
CHAR[95] = C_ID;
CHAR[36] = C_ID;
for (let i = 48; i <= 57; i++) CHAR[i] = C_DIG;

// Punctuators with no multi-char form: resolved by one table lookup in nextToken,
// so a bare `(` / `,` / `;` skips the scanPunct call + char-switch entirely
// (seafox's inline single-char dispatch). 0 = fall through to scanPunct.
const PUNCT1 = new Int32Array(128);
PUNCT1[40] = P.LPAREN; //  (
PUNCT1[41] = P.RPAREN; //  )
PUNCT1[123] = P.LBRACE; // {
PUNCT1[125] = P.RBRACE; // }
PUNCT1[91] = P.LBRACKET; // [
PUNCT1[93] = P.RBRACKET; // ]
PUNCT1[44] = P.COMMA; //   ,
PUNCT1[59] = P.SEMI; //    ;
PUNCT1[58] = P.COLON; //   :
PUNCT1[126] = P.TILDE; //  ~
PUNCT1[64] = P.AT; //      @

// Keyword recognizer: an open-addressed hash table keyed by the identifier's
// rolling hash — which nextToken already computed as `state.tokHash`. A plain
// identifier short-circuits on an empty slot instead of running a length-switch +
// `startsWith` cascade (meriyah/seafox model). Built once from token.ts's keyword set.
const KW_MASK = 127; // 128 slots for ~62 keywords (~48% load factor)
const KW_STR: (string | undefined)[] = new Array(KW_MASK + 1);
const KW_HASH = new Int32Array(KW_MASK + 1);
const KW_TOK = new Int32Array(KW_MASK + 1);
{
    // Must match nextToken's identifier hash exactly: h0 = code(0); h = imul(h,31)+code(i).
    const hashOf = (w: string): number => {
        let h = w.charCodeAt(0);
        for (let i = 1; i < w.length; i++) h = (Math.imul(h, 31) + w.charCodeAt(i)) | 0;
        return h;
    };
    for (const [w, tok] of KEYWORD_ENTRIES) {
        const h = hashOf(w);
        let i = h & KW_MASK;
        while (KW_STR[i] !== undefined) i = (i + 1) & KW_MASK;
        KW_STR[i] = w;
        KW_HASH[i] = h;
        KW_TOK[i] = tok;
    }
}

/** Map the just-scanned identifier (src[s,e), hash in `state.tokHash`) to its keyword
 * token, or 0 for a plain identifier. */
function keywordCode(state: ParserState, s: number, e: number): number {
    const h = state.tokHash;
    const len = e - s;
    const src = state.src;
    let i = h & KW_MASK;
    for (;;) {
        const kw = KW_STR[i];
        if (kw === undefined) return 0;
        if (KW_HASH[i] === h && kw.length === len) {
            let j = 0;
            while (j < len && kw.charCodeAt(j) === src.charCodeAt(s + j)) j++;
            if (j === len) return KW_TOK[i];
        }
        i = (i + 1) & KW_MASK;
    }
}

export function nextToken(state: ParserState): void {
    const src = state.src,
        srcLen = state.srcLen;
    let pos = state.pos;
    let nl = 0;
    let sawPure = false;
    while (pos < srcLen) {
        const c = src.charCodeAt(pos);
        if (c < 128) {
            const cls = CHAR[c];
            if (cls === C_WS) {
                pos++;
                continue;
            }
            if (cls === C_NL) {
                nl = F_NL;
                pos++;
                continue;
            }
            if (c === 47) {
                const c1 = src.charCodeAt(pos + 1);
                if (c1 === 47) {
                    // Line comment: native scan to the newline, stop AT it so the outer
                    // loop records the C_NL (sets `nl`) next iteration.
                    const nlPos = src.indexOf('\n', pos + 2);
                    pos = nlPos < 0 ? srcLen : nlPos;
                    continue;
                }
                if (c1 === 42) {
                    // Block comment: native scan to `*/`. A comment spanning a line break
                    // counts as a newline before the next token (ASI), so probe for one `\n`
                    // in the span — but don't record every newline; the line table is built
                    // once, deferred. three.core.js is ~46% block-comment bytes.
                    const end = src.indexOf('*/', pos + 2);
                    if (end < 0) raise(state, ParseErrorCode.UnterminatedComment);
                    const close = end < 0 ? srcLen : end + 2;
                    const nlIn = src.indexOf('\n', pos + 2);
                    if (nlIn !== -1 && nlIn < close) nl = F_NL;
                    // `/*@__PURE__*​/` / `/*#__PURE__*​/` annotation probe. Ordered to stay off the hot
                    // path: virtually every comment fails on the FIRST character comparison, and the
                    // string compare only runs for one that actually opens with `@`/`#`.
                    let a = pos + 2;
                    if (src.charCodeAt(a) === 32) a++;
                    const ac = src.charCodeAt(a);
                    if ((ac === 64 || ac === 35) && src.startsWith('__PURE__', a + 1)) sawPure = true;
                    pos = close;
                    continue;
                }
            }
            break;
        }
        if (c === 0x2028 || c === 0x2029) {
            nl = F_NL;
            pos++;
            continue;
        }
        if (c === 0xa0 || c === 0xfeff) {
            pos++;
            continue;
        }
        break;
    }
    if (sawPure) state.pureAt = pos;
    state.tokFlags = nl;
    state.tokStart = pos;
    if (pos >= srcLen) {
        state.pos = pos;
        state.tok = T_EOF;
        state.tokEnd = pos;
        return;
    }
    const c = src.charCodeAt(pos);

    if (c < 128 ? CHAR[c] === C_ID : true) {
        let h = c;
        pos++;
        while (pos < srcLen) {
            const cc = src.charCodeAt(pos);
            if (cc < 128) {
                const cl = CHAR[cc];
                if (cl !== C_ID && cl !== C_DIG) break;
            } else if (cc === 0x2028 || cc === 0x2029) break;
            h = (Math.imul(h, 31) + cc) | 0;
            pos++;
        }
        state.pos = pos;
        state.tokHash = h;
        // Keywords all start lowercase a-z, so skip the keyword lookup entirely for a
        // PascalCase / _foo / $x / unicode first char (seafox splits Identifier from
        // IdentifierOrKeyword in its first-char table). `c` is the identifier's first char.
        const kw = c >= 0x61 && c <= 0x7a ? keywordCode(state, state.tokStart, pos) : 0;
        state.tok = kw === 0 ? T_IDENT : kw;
        state.tokEnd = pos;
        return;
    }
    if (CHAR[c] === C_DIG || (c === 46 && CHAR[src.charCodeAt(pos + 1)] === C_DIG)) {
        state.pos = pos;
        scanNumber(state);
        return;
    }
    if (c === 34 || c === 39) {
        pos++;
        // `closed` rather than inspecting `src[pos - 1]` afterwards: a source that ends ON the
        // opening quote would read that quote back and look terminated. Written once, on the way
        // out — no per-character cost.
        let closed = false;
        while (pos < srcLen) {
            const cc = src.charCodeAt(pos);
            if (cc === c) {
                pos++;
                closed = true;
                break;
            }
            // A raw line terminator ends a string literal in the grammar; only an escaped one may
            // span lines. Without this an unterminated string swallowed the rest of the file.
            if (cc === 10 || cc === 13) break;
            if (cc === 92) {
                pos += 2; // skip the escaped char (line table is built deferred, not here)
            } else {
                pos++;
            }
        }
        // Reported, not swallowed. An unterminated literal used to parse CLEANLY and reach the
        // output verbatim — `export const x = 'abc` emitted `const x = 'abc;`, itself invalid
        // JavaScript, from a build with `errors: []`. oxc rejects it in every module goal.
        if (!closed) raise(state, ParseErrorCode.UnterminatedString);
        state.pos = pos;
        state.tok = T_STR;
        state.tokEnd = pos;
        return;
    }
    if (c === 96) {
        state.pos = pos + 1;
        scanTemplatePart(state);
        return;
    }
    if (c === 35) {
        if (state.tokStart === 0 && src.charCodeAt(1) === 33) {
            while (pos < srcLen && src.charCodeAt(pos) !== 10) pos++;
            state.pos = pos;
            nextToken(state);
            return;
        }
        pos++;
        let h = 0;
        while (pos < srcLen) {
            const cc = src.charCodeAt(pos);
            if (cc < 128 && CHAR[cc] !== C_ID && CHAR[cc] !== C_DIG) break;
            if (cc >= 128 && (cc === 0x2028 || cc === 0x2029)) break;
            h = (Math.imul(h, 31) + cc) | 0;
            pos++;
        }
        state.pos = pos;
        state.tokHash = h;
        state.tok = T_PRIVATE;
        state.tokEnd = pos;
        return;
    }
    const p1 = PUNCT1[c];
    if (p1 !== 0) {
        state.pos = pos + 1;
        state.tok = p1;
        state.tokEnd = pos + 1;
        return;
    }
    state.pos = pos;
    scanPunct(state, c);
}

function scanNumber(state: ParserState): void {
    const src = state.src,
        srcLen = state.srcLen;
    let pos = state.pos;
    let c = src.charCodeAt(pos);
    pos++;
    if (c === 48 && pos < srcLen) {
        const x = src.charCodeAt(pos) | 32;
        if (x === 120 || x === 111 || x === 98) pos++;
    }
    while (pos < srcLen) {
        c = src.charCodeAt(pos);
        if (c < 128 && (CHAR[c] === C_DIG || CHAR[c] === C_ID)) {
            if ((c | 32) === 101 && pos + 1 < srcLen) {
                const nx = src.charCodeAt(pos + 1);
                if (nx === 43 || nx === 45) pos++;
            }
            pos++;
        } else if (c === 46) pos++;
        else break;
    }
    state.pos = pos;
    state.tok = src.charCodeAt(pos - 1) === 110 ? T_BIGINT : T_NUM;
    state.tokEnd = pos;
}

function scanTemplatePart(state: ParserState): void {
    const src = state.src,
        srcLen = state.srcLen;
    let pos = state.pos;
    while (pos < srcLen) {
        const c = src.charCodeAt(pos);
        if (c === 96) {
            pos++;
            state.pos = pos;
            state.tok = T_TEMPLATE_FULL;
            state.tokEnd = pos;
            return;
        }
        if (c === 36 && src.charCodeAt(pos + 1) === 123) {
            pos += 2;
            state.pos = pos;
            state.tok = T_TEMPLATE_HEAD;
            state.tokEnd = pos;
            return;
        }
        if (c === 92) {
            pos += 2;
        } else {
            pos++;
        }
    }
    // Fell off the end without a closing backtick or `${`.
    raise(state, ParseErrorCode.UnterminatedTemplate);
    state.pos = pos;
    state.tok = T_TEMPLATE_FULL;
    state.tokEnd = pos;
}

export function reScanTemplateContinue(state: ParserState): void {
    state.pos = state.tokStart + 1;
    state.tokStart = state.pos - 1;
    scanTemplatePart(state);
}

export function reScanRegex(state: ParserState): void {
    const src = state.src,
        srcLen = state.srcLen;
    let pos = state.tokStart + 1;
    let inClass = false;
    while (pos < srcLen) {
        const c = src.charCodeAt(pos);
        if (c === 92) {
            pos += 2;
            continue;
        }
        if (c === 91) inClass = true;
        else if (c === 93) inClass = false;
        else if (c === 47 && !inClass) {
            pos++;
            while (pos < srcLen) {
                const f = src.charCodeAt(pos);
                if (f < 128 && (CHAR[f] === C_ID || CHAR[f] === C_DIG)) pos++;
                else break;
            }
            state.pos = pos;
            state.tok = T_REGEX;
            state.tokEnd = pos;
            return;
        } else if (c === 10) break;
        pos++;
    }
    state.pos = pos;
    raise(state, ParseErrorCode.UnterminatedRegex);
    state.tok = T_REGEX;
    state.tokEnd = pos;
}

function scanPunct(state: ParserState, c: number): void {
    const src = state.src,
        srcLen = state.srcLen;
    let pos = state.pos;
    const c1 = pos + 1 < srcLen ? src.charCodeAt(pos + 1) : 0;
    const c2 = pos + 2 < srcLen ? src.charCodeAt(pos + 2) : 0;
    let v = 0;
    let n = 1;
    switch (c) {
        case 40:
            v = P.LPAREN;
            break;
        case 41:
            v = P.RPAREN;
            break;
        case 123:
            v = P.LBRACE;
            break;
        case 125:
            v = P.RBRACE;
            break;
        case 91:
            v = P.LBRACKET;
            break;
        case 93:
            v = P.RBRACKET;
            break;
        case 59:
            v = P.SEMI;
            break;
        case 44:
            v = P.COMMA;
            break;
        case 64:
            v = P.AT;
            break;
        case 126:
            v = P.TILDE;
            break;
        case 46:
            if (c1 === 46 && c2 === 46) {
                v = P.DOTDOTDOT;
                n = 3;
            } else v = P.DOT;
            break;
        case 61:
            if (c1 === 61) {
                if (c2 === 61) {
                    v = P.EQEQEQ;
                    n = 3;
                } else {
                    v = P.EQEQ;
                    n = 2;
                }
            } else if (c1 === 62) {
                v = P.ARROW;
                n = 2;
            } else v = P.EQ;
            break;
        case 33:
            if (c1 === 61) {
                if (c2 === 61) {
                    v = P.NEQEQ;
                    n = 3;
                } else {
                    v = P.NEQ;
                    n = 2;
                }
            } else v = P.BANG;
            break;
        case 60:
            if (c1 === 60) {
                if (c2 === 61) {
                    v = P.SHLEQ;
                    n = 3;
                } else {
                    v = P.SHL;
                    n = 2;
                }
            } else if (c1 === 61) {
                v = P.LE;
                n = 2;
            } else v = P.LT;
            break;
        case 62:
            if (c1 === 62) {
                if (c2 === 62) {
                    if (src.charCodeAt(pos + 3) === 61) {
                        v = P.USHREQ;
                        n = 4;
                    } else {
                        v = P.USHR;
                        n = 3;
                    }
                } else if (c2 === 61) {
                    v = P.SHREQ;
                    n = 3;
                } else {
                    v = P.SHR;
                    n = 2;
                }
            } else if (c1 === 61) {
                v = P.GE;
                n = 2;
            } else v = P.GT;
            break;
        case 43:
            if (c1 === 43) {
                v = P.PLUSPLUS;
                n = 2;
            } else if (c1 === 61) {
                v = P.PLUSEQ;
                n = 2;
            } else v = P.PLUS;
            break;
        case 45:
            if (c1 === 45) {
                v = P.MINUSMINUS;
                n = 2;
            } else if (c1 === 61) {
                v = P.MINUSEQ;
                n = 2;
            } else v = P.MINUS;
            break;
        case 42:
            if (c1 === 42) {
                if (c2 === 61) {
                    v = P.STARSTAREQ;
                    n = 3;
                } else {
                    v = P.STARSTAR;
                    n = 2;
                }
            } else if (c1 === 61) {
                v = P.STAREQ;
                n = 2;
            } else v = P.STAR;
            break;
        case 47:
            if (c1 === 61) {
                v = P.SLASHEQ;
                n = 2;
            } else v = P.SLASH;
            break;
        case 37:
            if (c1 === 61) {
                v = P.PERCENTEQ;
                n = 2;
            } else v = P.PERCENT;
            break;
        case 38:
            if (c1 === 38) {
                if (c2 === 61) {
                    v = P.AMPAMPEQ;
                    n = 3;
                } else {
                    v = P.AMPAMP;
                    n = 2;
                }
            } else if (c1 === 61) {
                v = P.AMPEQ;
                n = 2;
            } else v = P.AMP;
            break;
        case 124:
            if (c1 === 124) {
                if (c2 === 61) {
                    v = P.PIPEPIPEEQ;
                    n = 3;
                } else {
                    v = P.PIPEPIPE;
                    n = 2;
                }
            } else if (c1 === 61) {
                v = P.PIPEEQ;
                n = 2;
            } else v = P.PIPE;
            break;
        case 94:
            if (c1 === 61) {
                v = P.CARETEQ;
                n = 2;
            } else v = P.CARET;
            break;
        case 63:
            if (c1 === 63) {
                if (c2 === 61) {
                    v = P.QQEQ;
                    n = 3;
                } else {
                    v = P.QQ;
                    n = 2;
                }
            } else if (c1 === 46 && !(c2 >= 48 && c2 <= 57)) {
                v = P.QDOT;
                n = 2;
            } else v = P.QUESTION;
            break;
        case 58:
            v = P.COLON;
            break;
        default:
            raise(state, ParseErrorCode.UnexpectedChar, String.fromCharCode(c));
            state.pos = pos + 1;
            nextToken(state);
            return;
    }
    pos += n;
    state.pos = pos;
    state.tok = v; // v is the packed punctuator token (P.* === its packed constant)
    state.tokEnd = pos;
}
