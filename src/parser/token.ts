// One integer per token — the meriyah/seafox model.
//
// Today the scanner produces a coarse kind (`T_PUNCT`/`T_KW`/…) plus a separate
// `tokVal` (a `P.*` or `K.*` id), and every dispatch predicate is a side table
// keyed off that pair: `BIN_PREC`, `BIN_OP`, `ASSIGN_OP`, the `CONTEXTUAL` set,
// and a hardcoded `in`/`instanceof` branch in `parseBinary`. This module folds
// all of it into ONE self-describing token value:
//
//   bits 0-7   kind      — a `TK` id (punctuator, keyword, or literal class)
//   bits 8-11  precedence — binary/relational operator precedence (0-12)
//   bit 12     IsBinaryOp
//   bit 13     IsAssignOp
//   bit 14     IsLogicalOp
//   bit 15     IsKeyword
//   bit 16     IsPunctuator
//   bit 17     IsContextual (a contextual keyword — ident-like in expr position)
//
// Each kind's flags are constant, so the packed value per kind is a constant
// too: `state.tok === P.LPAREN` compares whole packed values, no masking. The
// kind byte is only unmasked when indexing a per-kind table (operator text).
//
// The upshot for `parseBinary`: `in`/`instanceof` carry precedence 8 + IsBinaryOp
// like any punctuator, so the punct-vs-keyword branch disappears — one uniform
// `precedenceOf(state.tok)` / `isBinaryOp(state.tok)` loop.
import { enumeration } from '../util/enumeration';

// Kind ids (the low byte). Literal/structural classes, then punctuators, then
// keywords — names mirror the old `T_*` / `P` / `K` spaces exactly.
export const TK = enumeration(
    // literal & structural classes
    'EOF',
    'IDENT',
    'PRIVATE',
    'NUM',
    'BIGINT',
    'STR',
    'TEMPLATE_FULL',
    'TEMPLATE_HEAD',
    'REGEX',
    // punctuators
    'LPAREN',
    'RPAREN',
    'LBRACE',
    'RBRACE',
    'LBRACKET',
    'RBRACKET',
    'SEMI',
    'COMMA',
    'DOT',
    'DOTDOTDOT',
    'ARROW',
    'COLON',
    'QUESTION',
    'QDOT',
    'QQ',
    'QQEQ',
    'AT',
    'EQ',
    'EQEQ',
    'EQEQEQ',
    'NEQ',
    'NEQEQ',
    'LT',
    'GT',
    'LE',
    'GE',
    'PLUS',
    'MINUS',
    'STAR',
    'STARSTAR',
    'SLASH',
    'PERCENT',
    'PLUSPLUS',
    'MINUSMINUS',
    'SHL',
    'SHR',
    'USHR',
    'AMP',
    'PIPE',
    'CARET',
    'TILDE',
    'BANG',
    'AMPAMP',
    'PIPEPIPE',
    'PLUSEQ',
    'MINUSEQ',
    'STAREQ',
    'STARSTAREQ',
    'SLASHEQ',
    'PERCENTEQ',
    'SHLEQ',
    'SHREQ',
    'USHREQ',
    'AMPEQ',
    'PIPEEQ',
    'CARETEQ',
    'AMPAMPEQ',
    'PIPEPIPEEQ',
    // keywords
    'BREAK',
    'CASE',
    'CATCH',
    'CLASS',
    'CONST',
    'CONTINUE',
    'DEBUGGER',
    'DEFAULT',
    'DELETE',
    'DO',
    'ELSE',
    'EXPORT',
    'EXTENDS',
    'FINALLY',
    'FOR',
    'FUNCTION',
    'IF',
    'IMPORT',
    'IN',
    'INSTANCEOF',
    'LET',
    'NEW',
    'RETURN',
    'SUPER',
    'SWITCH',
    'THIS',
    'THROW',
    'TRY',
    'TYPEOF',
    'VAR',
    'VOID',
    'WHILE',
    'WITH',
    'TRUE',
    'FALSE',
    'NULL',
    'YIELD',
    'AWAIT',
    'ASYNC',
    'OF',
    'AS',
    'FROM',
    'GET',
    'SET',
    'STATIC',
    'TYPE',
    'INTERFACE',
    'ENUM',
    'NAMESPACE',
    'MODULE',
    'DECLARE',
    'ABSTRACT',
    'OVERRIDE',
    'READONLY',
    'SATISFIES',
    'KEYOF',
    'INFER',
    'IS',
    'ASSERTS',
    'IMPLEMENTS',
    'UNIQUE',
    'ACCESSOR',
);
export type TK = (typeof TK)[keyof typeof TK];
type TokName = keyof typeof TK;

// --- bit layout --------------------------------------------------------------
const KIND_MASK = 0xff;
const PREC_SHIFT = 8;
const PREC_MASK = 0xf;
const F_BINOP = 1 << 12;
const F_ASSIGN = 1 << 13;
const F_LOGICAL = 1 << 14;
const F_KEYWORD = 1 << 15;
const F_PUNCT = 1 << 16;
const F_CONTEXTUAL = 1 << 17;
// Token can continue a member/call chain (`.` `?.` `[` `(` tagged-template, and in TS
// `!` / `<`). Lets parseMemberChain fast-exit with one bit-test (meriyah's model).
const F_MEMBER_CONT = 1 << 18;

// --- per-token metadata spec (mirrors the parser's current tables) -----------
// [precedence, operator text, isLogical]
const BINARY: Partial<Record<TokName, readonly [number, string, boolean]>> = {
    QQ: [1, '??', true],
    PIPEPIPE: [2, '||', true],
    AMPAMP: [3, '&&', true],
    PIPE: [4, '|', false],
    CARET: [5, '^', false],
    AMP: [6, '&', false],
    EQEQ: [7, '==', false],
    NEQ: [7, '!=', false],
    EQEQEQ: [7, '===', false],
    NEQEQ: [7, '!==', false],
    LT: [8, '<', false],
    GT: [8, '>', false],
    LE: [8, '<=', false],
    GE: [8, '>=', false],
    IN: [8, 'in', false],
    INSTANCEOF: [8, 'instanceof', false],
    SHL: [9, '<<', false],
    SHR: [9, '>>', false],
    USHR: [9, '>>>', false],
    PLUS: [10, '+', false],
    MINUS: [10, '-', false],
    STAR: [11, '*', false],
    SLASH: [11, '/', false],
    PERCENT: [11, '%', false],
    STARSTAR: [12, '**', false],
};
const ASSIGN: Partial<Record<TokName, string>> = {
    EQ: '=',
    PLUSEQ: '+=',
    MINUSEQ: '-=',
    STAREQ: '*=',
    SLASHEQ: '/=',
    PERCENTEQ: '%=',
    STARSTAREQ: '**=',
    SHLEQ: '<<=',
    SHREQ: '>>=',
    USHREQ: '>>>=',
    AMPEQ: '&=',
    PIPEEQ: '|=',
    CARETEQ: '^=',
    AMPAMPEQ: '&&=',
    PIPEPIPEEQ: '||=',
    QQEQ: '??=',
};
const CONTEXTUAL: readonly TokName[] = [
    'ASYNC',
    'OF',
    'AS',
    'FROM',
    'GET',
    'SET',
    'STATIC',
    'TYPE',
    'INTERFACE',
    'NAMESPACE',
    'MODULE',
    'DECLARE',
    'ABSTRACT',
    'OVERRIDE',
    'READONLY',
    'SATISFIES',
    'KEYOF',
    'INFER',
    'IS',
    'ASSERTS',
    'IMPLEMENTS',
    'UNIQUE',
    'ACCESSOR',
    'YIELD',
    'AWAIT',
    'LET',
];

// --- build the packed table + operator-text table (indexed by kind) ----------
const idOf = (name: TokName): number => TK[name] as unknown as number;
const firstPunct = idOf('LPAREN');
const lastPunct = idOf('PIPEPIPEEQ');
const firstKeyword = idOf('BREAK');
const lastKeyword = idOf('ACCESSOR');

const packed: number[] = [];
const OP_TEXT: string[] = [];
for (const name of Object.keys(TK) as TokName[]) {
    const k = idOf(name);
    let v = k;
    if (k >= firstPunct && k <= lastPunct) v |= F_PUNCT;
    if (k >= firstKeyword && k <= lastKeyword) v |= F_KEYWORD;
    packed[k] = v;
}
for (const name of Object.keys(BINARY) as TokName[]) {
    const spec = BINARY[name];
    if (spec === undefined) continue;
    const [prec, text, logical] = spec;
    const k = idOf(name);
    packed[k] |= F_BINOP | (prec << PREC_SHIFT) | (logical ? F_LOGICAL : 0);
    OP_TEXT[k] = text;
}
for (const name of Object.keys(ASSIGN) as TokName[]) {
    const text = ASSIGN[name];
    if (text === undefined) continue;
    const k = idOf(name);
    packed[k] |= F_ASSIGN;
    OP_TEXT[k] = text;
}
for (const name of CONTEXTUAL) packed[idOf(name)] |= F_CONTEXTUAL;
for (const name of ['DOT', 'QDOT', 'LBRACKET', 'LPAREN', 'BANG', 'LT', 'TEMPLATE_FULL', 'TEMPLATE_HEAD'] as TokName[]) {
    packed[idOf(name)] |= F_MEMBER_CONT;
}

/**
 * Packed token constants keyed by name — what `state.tok` is set to, and what
 * `P.*` / `K.*` resolve to at comparison sites (`state.tok === P.LPAREN`).
 */
export const TOK = (() => {
    const o: Record<string, number> = {};
    for (const name of Object.keys(TK) as TokName[]) o[name] = packed[idOf(name)];
    return o as { readonly [K in TokName]: number };
})();

/** Keyword source spellings paired with their packed token — the lexer builds its
 * keyword recognizer from this (source string === the kind name lowercased). */
export const KEYWORD_ENTRIES: readonly (readonly [string, number])[] = (Object.keys(TK) as TokName[])
    .filter((n) => {
        const k = idOf(n);
        return k >= firstKeyword && k <= lastKeyword;
    })
    .map((n) => [n.toLowerCase(), TOK[n]] as [string, number]);

// --- accessors (read straight off the packed token) --------------------------
export const kindOf = (tok: number): number => tok & KIND_MASK;
export const precedenceOf = (tok: number): number => (tok >> PREC_SHIFT) & PREC_MASK;
export const isBinaryOp = (tok: number): boolean => (tok & F_BINOP) !== 0;
export const isAssignOp = (tok: number): boolean => (tok & F_ASSIGN) !== 0;
export const isLogical = (tok: number): boolean => (tok & F_LOGICAL) !== 0;
export const isKeyword = (tok: number): boolean => (tok & F_KEYWORD) !== 0;
export const isPunct = (tok: number): boolean => (tok & F_PUNCT) !== 0;
export const isContextual = (tok: number): boolean => (tok & F_CONTEXTUAL) !== 0;
export const isMemberCont = (tok: number): boolean => (tok & F_MEMBER_CONT) !== 0;
/** Operator source text (`'+'`, `'==='`, `'in'`, `'&&='`) for a binary/logical/assign token. */
export const opTextOf = (tok: number): string => OP_TEXT[tok & KIND_MASK];
