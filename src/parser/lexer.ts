// Lexer / scanner: turns source text into tokens. Owns the char-classification
// table, the newline tracker, the identifier interner, and the scan routines.
// Shared state substrate lives in state.ts; token identities in token.ts.
import { ParseErrorCode } from './errors.ts';
import {
    F_ESCAPED,
    F_NL,
    P,
    type ParserState,
    raise,
    T_BIGINT,
    T_EOF,
    T_IDENT,
    T_JSX_TEXT,
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

export const C_WS = 1;
export const C_NL = 2;
export const C_ID = 3;
export const C_DIG = 4;
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

/**
 * Scan an identifier containing at least one `\uXXXX` / `\u{…}` escape, from `state.tokStart`.
 *
 * A cold path in every sense: entered only from the branch that was already ending the identifier
 * loop, or from the punctuator switch's `default`, so the ordinary identifier pays nothing for it.
 * That matters — `\u0061` is valid JavaScript that shakeup rejected with `unexpected character '\'`,
 * but it is also vanishingly rare, and the identifier scan is the parser's hottest loop.
 *
 * The decoded name cannot be interned by source range like every other identifier (the source says
 * `\u0061`, the name is `a`), so it goes through {@link internString} and rides on the token as
 * `tokCooked` + `F_ESCAPED`.
 *
 * Deliberately NOT validated against the Unicode ID_Start/ID_Continue tables. shakeup's lexer
 * treats EVERY non-ASCII character as an identifier character already (`nextToken`'s
 * `c < 128 ? CHAR[c] === C_ID : true`), so applying real tables to escapes alone would reject
 * `\u{1F600}` while accepting the same emoji written literally. ASCII is checked against the same
 * `CHAR` table the raw path uses, which keeps `\u0031` (a leading digit) an error, as it is in oxc.
 */
function scanEscapedIdent(state: ParserState, nameStart: number, tok: number): void {
    const src = state.src,
        srcLen = state.srcLen;
    // Where the NAME begins, which is not where the TOKEN begins for a private name: `#\u0061`
    // spans from the `#` but is called `a`. `parsePrivate` interns from `tokStart + 1` for the same
    // reason.
    let pos = nameStart;
    let name = '';
    let first = true;
    while (pos < srcLen) {
        const c = src.charCodeAt(pos);
        if (c === 92) {
            // Only `\u` — `\x61` is not an identifier escape, which is why the check is on the
            // literal `u` and not on "some escape".
            if (src.charCodeAt(pos + 1) !== 117) {
                raise(state, ParseErrorCode.InvalidUnicodeEscape);
                return;
            }
            let cp: number;
            let next: number;
            if (src.charCodeAt(pos + 2) === 123) {
                // `\u{...}`: one to six hex digits, any code point up to 0x10FFFF.
                let i = pos + 3;
                let v = 0;
                let digits = 0;
                for (;;) {
                    const d = hexVal(src.charCodeAt(i));
                    if (d < 0) break;
                    v = v * 16 + d;
                    digits++;
                    i++;
                }
                if (digits === 0 || v > 0x10ffff || src.charCodeAt(i) !== 125) {
                    raise(state, ParseErrorCode.InvalidUnicodeEscape);
                    return;
                }
                cp = v;
                next = i + 1;
            } else {
                let v = 0;
                for (let k = 0; k < 4; k++) {
                    const d = hexVal(src.charCodeAt(pos + 2 + k));
                    if (d < 0) {
                        raise(state, ParseErrorCode.InvalidUnicodeEscape);
                        return;
                    }
                    v = v * 16 + d;
                }
                // A lone surrogate is not a code point. Two escaped surrogates do NOT combine into
                // one either — oxc rejects `\uD83D\uDE00` — so rejecting each half is the rule.
                if (v >= 0xd800 && v <= 0xdfff) {
                    raise(state, ParseErrorCode.InvalidUnicodeEscape);
                    return;
                }
                cp = v;
                next = pos + 6;
            }
            if (cp < 128) {
                const cl = CHAR[cp];
                if (cl !== C_ID && (first || cl !== C_DIG)) {
                    raise(state, ParseErrorCode.InvalidEscapedIdentChar, String.fromCodePoint(cp));
                    return;
                }
            }
            name += String.fromCodePoint(cp);
            pos = next;
            first = false;
            continue;
        }
        if (c < 128) {
            const cl = CHAR[c];
            if (cl !== C_ID && (first || cl !== C_DIG)) break;
        } else if (c === 0x2028 || c === 0x2029) break;
        name += src[pos];
        pos++;
        first = false;
    }
    if (name === '') {
        raise(state, ParseErrorCode.InvalidUnicodeEscape);
        return;
    }
    state.pos = pos;
    state.tokEnd = pos;
    state.tokCooked = name;
    state.tokFlags |= F_ESCAPED;
    // An escaped identifier is NEVER the keyword it spells: `\u0069f` is an identifier named `if`,
    // and the parser rejects it wherever a reserved word would be illegal. Leaving it `T_IDENT` is
    // what makes `({ \u0069f: 1 })` — a property key, where reserved words are fine — still parse.
    state.tok = tok;
    state.tokHash = 0;
}

const hexVal = (c: number): number => {
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 97 && c <= 102) return c - 87;
    if (c >= 65 && c <= 70) return c - 55;
    return -1;
};

/** Intern a STRING, for a name that is not a slice of the source (an escaped identifier). */
export function internString(state: ParserState, s: string): string {
    let hash = s.charCodeAt(0);
    for (let k = 1; k < s.length; k++) hash = (Math.imul(hash, 31) + s.charCodeAt(k)) | 0;
    const itKeys = state.itKeys,
        itHashes = state.itHashes,
        itMask = state.itMask;
    let i = hash & itMask;
    for (;;) {
        const k = itKeys[i];
        if (k === undefined) break;
        if (itHashes[i] === hash && k === s) return k;
        i = (i + 1) & itMask;
    }
    itKeys[i] = s;
    itHashes[i] = hash;
    if (++state.itCount * 4 > (itMask + 1) * 3) internGrow(state);
    return s;
}

/** {@link keywordCode} for a STRING rather than a source range — the escaped-identifier path, where
 *  the name being classified was decoded and is nowhere in the source. */
export function keywordCodeOf(name: string): number {
    let h = name.charCodeAt(0);
    for (let k = 1; k < name.length; k++) h = (Math.imul(h, 31) + name.charCodeAt(k)) | 0;
    let i = h & KW_MASK;
    for (;;) {
        const kw = KW_STR[i];
        if (kw === undefined) return 0;
        if (KW_HASH[i] === h && kw === name) return KW_TOK[i];
        i = (i + 1) & KW_MASK;
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

/** Unicode `Zs`, plus the BOM. `\u00a0` and `\ufeff` alone left every other space class — em quad,
 *  ogham, ideographic, … — lexed as an identifier character. */
const isUnicodeSpace = (c: number): boolean =>
    c === 0xa0 || c === 0xfeff || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000;

/**
 * A block comment spanning a line break counts as a newline for ASI, and `\r`, `\u2028` and
 * `\u2029` are line terminators too. Only reached when the comment holds no `\n` at all, which makes
 * it a single-line comment and so bounds the scan.
 */
function hasRareLineBreak(src: string, from: number, to: number): boolean {
    for (let i = from; i < to; i++) {
        const c = src.charCodeAt(i);
        if (c === 13 || c === 0x2028 || c === 0x2029) return true;
    }
    return false;
}

const isHtmlComment = (src: string, pos: number, c: number, lineStart: boolean): boolean =>
    c === 60
        ? src.charCodeAt(pos + 1) === 33 && src.charCodeAt(pos + 2) === 45 && src.charCodeAt(pos + 3) === 45
        : lineStart && src.charCodeAt(pos + 1) === 45 && src.charCodeAt(pos + 2) === 62;

export function nextToken(state: ParserState): void {
    const src = state.src,
        srcLen = state.srcLen;
    let pos = state.pos;
    let nl = 0;
    let sawPure = false;
    let sawNse = false;
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
                    // Line comment: native scan to the newline, stop AT it so the outer loop records
                    // the C_NL (sets `nl`) next iteration.
                    //
                    // `\r`, U+2028 and U+2029 END a line comment too. Scanning for `\n` alone
                    // swallowed the rest of the FILE after `//c\rvar a = 1;` and reported no error at
                    // all — a silent miscompile, not a rejection. The `\n` search still bounds the
                    // loop, so a comment ending the ordinary way costs one extra pass over its body.
                    const nlPos = src.indexOf('\n', pos + 2);
                    const limit = nlPos < 0 ? srcLen : nlPos;
                    let end = limit;
                    for (let i = pos + 2; i < limit; i++) {
                        const ch = src.charCodeAt(i);
                        if (ch === 13 || ch === 0x2028 || ch === 0x2029) {
                            end = i;
                            break;
                        }
                    }
                    pos = end;
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
                    else if (hasRareLineBreak(src, pos + 2, close)) nl = F_NL;
                    // `/*@__PURE__*​/` / `/*#__PURE__*​/` annotation probe. Ordered to stay off the hot
                    // path: virtually every comment fails on the FIRST character comparison, and the
                    // string compare only runs for one that actually opens with `@`/`#`.
                    let a = pos + 2;
                    if (src.charCodeAt(a) === 32) a++;
                    const ac = src.charCodeAt(a);
                    if (ac === 64 || ac === 35) {
                        if (src.startsWith('__PURE__', a + 1)) sawPure = true;
                        // `@__NO_SIDE_EFFECTS__` asserts that CALLING the annotated function has no
                        // effects, whatever its body does (rollup `annotationNoSideEffects`, rolldown
                        // `SideEffectsFreeFunction`). Same cold branch as `__PURE__`: the `@`/`#`
                        // test above already rejects virtually every comment.
                        else if (src.startsWith('__NO_SIDE_EFFECTS__', a + 1)) sawNse = true;
                    }
                    pos = close;
                    continue;
                }
            }
            // Annex B.1.1 HTML-like comments. `<!--` opens one anywhere; `-->` only where it is the
            // first token on its line. Both are Script-only — in a real module goal they stay
            // ordinary punctuation and the parser rejects them. oxc `lexer/punctuation.rs:21-80`.
            if ((c === 60 || c === 45) && state.allowTopReturn && isHtmlComment(src, pos, c, nl !== 0 || pos === 0)) {
                const nlPos = src.indexOf('\n', pos);
                pos = nlPos < 0 ? srcLen : nlPos;
                continue;
            }
            break;
        }
        if (c === 0x2028 || c === 0x2029) {
            nl = F_NL;
            pos++;
            continue;
        }
        if (isUnicodeSpace(c)) {
            pos++;
            continue;
        }
        break;
    }
    if (sawPure) state.pureAt = pos;
    // A LIST, not a single slot: unlike `pureAt` (consumed by the node that starts exactly there),
    // these are resolved to functions after the parse, and several may be pending at once.
    if (sawNse) state.nseAt.push(pos);
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
                if (cl !== C_ID && cl !== C_DIG) {
                    // `a\u0062c` — a `\` in CONTINUE position. One compare, and only on the branch
                    // that was already ending the loop, so the ordinary identifier costs nothing.
                    if (cc === 92) {
                        scanEscapedIdent(state, state.tokStart, T_IDENT);
                        return;
                    }
                    break;
                }
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
                pos += src.charCodeAt(pos + 1) === 13 && src.charCodeAt(pos + 2) === 10 ? 3 : 2;
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
            while (pos < srcLen) {
                const h = src.charCodeAt(pos);
                if (h === 10 || h === 13 || h === 0x2028 || h === 0x2029) break;
                pos++;
            }
            state.pos = pos;
            nextToken(state);
            return;
        }
        pos++;
        const nameStart = pos;
        let h = 0;
        while (pos < srcLen) {
            const cc = src.charCodeAt(pos);
            if (cc < 128 && CHAR[cc] !== C_ID && CHAR[cc] !== C_DIG) {
                // `#\u0061` — a private name may be escaped exactly as an ordinary identifier may.
                // 750 of test262's rejections were this one case.
                if (cc === 92) {
                    scanEscapedIdent(state, nameStart, T_PRIVATE);
                    return;
                }
                break;
            }
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

const isDecimalDigit = (c: number): boolean => c >= 48 && c <= 57;
const radixDigitOk = (c: number, radix: number): boolean =>
    radix === 16
        ? isDecimalDigit(c) || ((c | 32) >= 97 && (c | 32) <= 102)
        : radix === 8
          ? c >= 48 && c <= 55
          : c === 48 || c === 49;

/**
 * A numeric literal must not run straight into an identifier or another digit: `0.toString()` and
 * `1_a` are syntax errors, not a number followed by something. oxc's `check_after_numeric_literal`
 * (`lexer/numeric.rs:208`), which is the single most load-bearing rule in its numeric scanner and the
 * one shakeup had no analogue of — the old loop swallowed every ASCII identifier character INTO the
 * number token, the exact inverse.
 */
function endNumber(state: ParserState, pos: number, bigint: boolean): void {
    const c = state.src.charCodeAt(pos);
    if (c < 128 && (CHAR[c] === C_DIG || CHAR[c] === C_ID)) {
        state.pos = pos;
        raise(state, ParseErrorCode.InvalidNumberEnd);
        return;
    }
    state.pos = pos;
    state.tok = bigint ? T_BIGINT : T_NUM;
    state.tokEnd = pos;
}

/** `raise` jumps the lexer to EOF, so every rejection must return immediately after it. */
function badNumber(state: ParserState, pos: number): void {
    state.pos = pos;
    raise(state, ParseErrorCode.UnexpectedChar, pos < state.srcLen ? state.src[pos] : '');
}

/** A `_` separator must sit BETWEEN digits — never leading (`1._5`) and never trailing (`1_`). */
function readDigits(state: ParserState, from: number): number {
    const src = state.src,
        srcLen = state.srcLen;
    let pos = from;
    let seenDigit = false;
    while (pos < srcLen) {
        const c = src.charCodeAt(pos);
        if (isDecimalDigit(c)) {
            pos++;
            seenDigit = true;
        } else if (c === 95 && seenDigit && isDecimalDigit(src.charCodeAt(pos + 1))) pos += 2;
        else break;
    }
    return pos;
}

function scanNumber(state: ParserState): void {
    const src = state.src,
        srcLen = state.srcLen;
    const start = state.pos;
    let pos = start;
    const first = src.charCodeAt(pos);
    let leadingZero = false;

    if (first === 48 && pos + 1 < srcLen) {
        const radix = (src.charCodeAt(pos + 1) | 32) === 120 ? 16 : (src.charCodeAt(pos + 1) | 32) === 111 ? 8 : (src.charCodeAt(pos + 1) | 32) === 98 ? 2 : 0;
        if (radix !== 0) {
            pos += 2;
            if (!radixDigitOk(src.charCodeAt(pos), radix)) return badNumber(state, pos);
            while (pos < srcLen) {
                const c = src.charCodeAt(pos);
                if (radixDigitOk(c, radix)) pos++;
                else if (c === 95) {
                    if (!radixDigitOk(src.charCodeAt(pos + 1), radix)) return badNumber(state, pos + 1);
                    pos += 2;
                } else break;
            }
            return endNumber(state, src.charCodeAt(pos) === 110 ? pos + 1 : pos, src.charCodeAt(pos) === 110);
        }
        // Legacy octal / non-octal decimal: `.` and an exponent are legal only once an 8 or 9 has
        // turned the run into a decimal, and a BigInt suffix never is. oxc `numeric.rs:99-127`.
        if (isDecimalDigit(src.charCodeAt(pos + 1))) {
            let decimal = false;
            pos++;
            while (pos < srcLen && isDecimalDigit(src.charCodeAt(pos))) {
                if (src.charCodeAt(pos) > 55) decimal = true;
                pos++;
            }
            if (!decimal) return endNumber(state, pos, false);
            leadingZero = true;
        } else pos++; // a lone `0`: the integer part is exactly that, so `0_1` is not a number
    } else pos = readDigits(state, pos);

    let bigint = false;
    if (!leadingZero && src.charCodeAt(pos) === 110) {
        pos++;
        bigint = true;
    } else {
        if (src.charCodeAt(pos) === 46) {
            pos = readDigits(state, pos + 1);
        }
        const e = src.charCodeAt(pos) | 32;
        if (e === 101) {
            let p = pos + 1;
            const sign = src.charCodeAt(p);
            if (sign === 43 || sign === 45) p++;
            if (!isDecimalDigit(src.charCodeAt(p))) return badNumber(state, p);
            pos = readDigits(state, p);
        }
    }
    endNumber(state, pos, bigint);
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

const isJSXIdentPart = (c: number): boolean =>
    c < 128 ? CHAR[c] === C_ID || CHAR[c] === C_DIG || c === 45 : c !== 0x2028 && c !== 0x2029;

export function nextJSXChild(state: ParserState): void {
    const src = state.src,
        srcLen = state.srcLen;
    const start = state.pos;
    state.tokStart = start;
    state.tokFlags = 0;
    if (start >= srcLen) {
        state.tok = T_EOF;
        state.tokEnd = start;
        return;
    }
    const c = src.charCodeAt(start);
    if (c === 60 || c === 123) {
        state.pos = start + 1;
        state.tok = c === 60 ? P.LT : P.LBRACE;
        state.tokEnd = state.pos;
        return;
    }
    let pos = start;
    while (pos < srcLen) {
        const t = src.charCodeAt(pos);
        if (t === 60 || t === 123) break;
        pos++;
    }
    state.pos = pos;
    state.tok = T_JSX_TEXT;
    state.tokEnd = pos;
}

export function reScanJSXIdentifier(state: ParserState): void {
    const src = state.src,
        srcLen = state.srcLen;
    let pos = state.tokEnd;
    while (pos < srcLen && isJSXIdentPart(src.charCodeAt(pos))) pos++;
    if (pos === state.tokEnd) return;
    state.pos = pos;
    state.tokEnd = pos;
    state.tok = T_IDENT;
    state.tokHash = hashRange(state, state.tokStart, pos);
}

/**
 * A JSX attribute value. JSX strings are raw — no escape processing, and newlines are legal — so the
 * ordinary string scanner would reject `a="x\ny"` and latch `fatal` before the parser could look.
 * Trivia is skipped by `nextToken`, then a quoted value is re-scanned raw and any error it raised is
 * rolled back.
 */
export function nextJSXAttributeValue(state: ParserState): void {
    const from = state.pos;
    const errors = state.errors.length;
    const fatal = state.fatal;
    nextToken(state);
    if (state.errors.length === errors) return;
    const quoteAt = skipTriviaFrom(state, from);
    const quote = state.src.charCodeAt(quoteAt);
    if (quote !== 34 && quote !== 39) return;
    state.errors.length = errors;
    state.fatal = fatal;
    state.tokStart = quoteAt;
    scanJSXAttributeString(state);
}

/** Only reached when the ordinary scan already failed, so it never costs the common path. */
function skipTriviaFrom(state: ParserState, from: number): number {
    const src = state.src,
        srcLen = state.srcLen;
    let pos = from;
    while (pos < srcLen) {
        const c = src.charCodeAt(pos);
        if (c < 128 && (CHAR[c] === C_WS || CHAR[c] === C_NL)) {
            pos++;
            continue;
        }
        if (c === 47 && src.charCodeAt(pos + 1) === 47) {
            const nl = src.indexOf('\n', pos + 2);
            pos = nl < 0 ? srcLen : nl + 1;
            continue;
        }
        if (c === 47 && src.charCodeAt(pos + 1) === 42) {
            const close = src.indexOf('*/', pos + 2);
            pos = close < 0 ? srcLen : close + 2;
            continue;
        }
        break;
    }
    return pos;
}

function scanJSXAttributeString(state: ParserState): void {
    const src = state.src,
        srcLen = state.srcLen;
    const quote = src.charCodeAt(state.tokStart);
    let pos = state.tokStart + 1;
    while (pos < srcLen && src.charCodeAt(pos) !== quote) pos++;
    if (pos >= srcLen) {
        state.pos = srcLen;
        raise(state, ParseErrorCode.UnterminatedString);
        state.tok = T_STR;
        state.tokEnd = srcLen;
        return;
    }
    state.pos = pos + 1;
    state.tok = T_STR;
    state.tokEnd = state.pos;
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
            // `\u0061` — a `\` where an identifier could START. Handled HERE rather than beside the
            // identifier test so the hot path never tests for it: reaching this default already
            // means the character matched nothing else.
            if (c === 92) {
                scanEscapedIdent(state, state.tokStart, T_IDENT);
                return;
            }
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
