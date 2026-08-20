// Shared parser substrate: the threaded `ParserState`, the packed token-identity
// aliases (P / K / T_*), and diagnostic raising. Both lexer.ts and parser.ts
// import from here, so this module depends on neither of them (a clean DAG:
// state ← lexer ← parser).
import type { Node } from '../ast.ts';
import { formatError, type ParseErrorCode } from './errors.ts';
import { TOK } from './token.ts';

// Literal/structural token kinds. `state.tok` is a packed token (token.ts); these
// aliases keep the comparison sites readable (`state.tok === T_NUM`). The coarse
// `T_PUNCT`/`T_KW` are gone — use `isPunct(state.tok)` / `isKeyword(state.tok)`.
export const T_EOF = TOK.EOF;
export const T_IDENT = TOK.IDENT;
export const T_NUM = TOK.NUM;
export const T_BIGINT = TOK.BIGINT;
export const T_STR = TOK.STR;
export const T_TEMPLATE_FULL = TOK.TEMPLATE_FULL;
export const T_TEMPLATE_HEAD = TOK.TEMPLATE_HEAD;
export const T_REGEX = TOK.REGEX;
export const T_PRIVATE = TOK.PRIVATE;

// Punctuator and keyword identities are the packed token constants from token.ts.
// A punctuator's packed value can never equal a keyword's (disjoint kind bytes),
// so `state.tok === P.LPAREN` / `state.tok === K.IN` compare whole packed values.
export const P = TOK;
export const K = TOK;

/** tokFlags bit: a newline preceded this token (for ASI / no-line-terminator rules). */
export const F_NL = 1;

/** Parse errors and offsets. */
export type ParseError = { pos: number; msg: string; code: ParseErrorCode };

/** All mutable parser state for one `parse` call, threaded as the first argument
 * (`state`) to every lexing/parsing function. Explicit state (rather than
 * module-scope `let`s) keeps the parser re-entrant. */
export type ParserState = {
    src: string;
    srcLen: number;
    pos: number;
    tok: number;
    tokStart: number;
    tokEnd: number;
    tokFlags: number;
    tokHash: number;
    tsMode: boolean;
    jsxMode: boolean;
    errors: ParseError[];
    baseId: number;
    itKeys: (string | undefined)[];
    itHashes: Int32Array;
    itMask: number;
    itCount: number;
    stk: (Node | null)[];
    sp: number;
    speculating: number;
    /** Set by parseMemberChain on exit: did this frame's top level contain an unparenthesized `?.`?
     * parseNew reads it to reject an optional chain as a `new` callee. */
    chainSawOptional: boolean;
    /** True while parsing the `extends` type of a conditional type (or an `infer` constraint),
     * where a trailing `? … : …` binds to the OUTER conditional rather than starting a new one.
     * Public `parseType` clears it; nested bracketed types re-enter through `parseType`. */
    noCondType: boolean;
    /** Set true when the parser builds any JSX node — a per-module "uses JSX" flag computed for
     * free during parse (esbuild's `p.jsxRuntimeImports` model), so consumers don't re-walk the AST
     * just to detect JSX. */
    sawJSX: boolean;
};

/** Push a formatted diagnostic (capped, so a runaway parse can't allocate forever). */
export function raise(state: ParserState, code: ParseErrorCode, ...params: string[]): void {
    if (state.errors.length < 100) {
        state.errors.push({ pos: state.tokStart, msg: formatError(code, params), code });
    }
}
