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
    /** Source position of the token immediately after a `/*@__PURE__*​/` (or `#__PURE__`) annotation,
     *  or -1. A call/new whose span STARTS here is the annotated one. Set by the whitespace skipper. */
    pureAt: number;
    tokHash: number;
    tsMode: boolean;
    jsxMode: boolean;
    /** Nesting depth of FUNCTION bodies (not plain blocks, and not class static blocks). `return`
     *  is legal only when this is > 0, or when the module goal allows it at top level. oxc's
     *  `Context::has_return` (`oxc_parser/src/lib.rs:875-877`), as a counter. */
    fnDepth: number;
    /** Like {@link fnDepth} but ALSO entered by a class static block — oxc enables `new.target`
     *  there while still forbidding `return` (`js/function.rs:285`, `js/statement.rs:710-713`). */
    newTargetDepth: number;
    /** Module goal allows top-level `return` — true for a CommonJS-declared file (its body is
     *  wrapped in a function) and for the permissive `unambiguous` default. */
    allowTopReturn: boolean;
    /** Module goal allows top-level `new.target`. Same rule as {@link allowTopReturn}. */
    allowTopNewTarget: boolean;
    /** Is `await` the OPERATOR here, rather than a plain identifier? oxc's `Context::has_await`
     *  (`js/arrow.rs:261,311` — `ctx.and_await(r#async)`), which is REPLACED on entering a function
     *  body by that function's async-ness and restored on exit, not accumulated. Seeded at top level
     *  from the module goal: an ES module permits top-level await, a CommonJS body does not.
     *
     *  When false, `await` parses as an identifier rather than erroring — matching oxc
     *  (`js/expression.rs:89`). That is what keeps `await(x)` a call to a function named `await` in
     *  a script, and it makes `await x` fail naturally as two adjacent identifiers. */
    awaitOk: boolean;
    /** Module contained a `return` outside any function body. rolldown's
     *  `EcmaModuleAstUsage::TopLevelReturn` — tier 2 of the CommonJS kind rule, since only a CJS
     *  body (wrapped in a function) can legally contain one. Free to record here: the goal gate
     *  already computes the predicate. */
    sawTopLevelReturn: boolean;
    /** Module contains an identifier `require` (anywhere). A cheap syntactic gate — like
     *  {@link sawJSX} / `sawImportSyntax` — so the whole-program walk that finds `require("lit")`
     *  edges runs only on modules that could have one. rolldown's `sawRequire` equivalent. */
    sawRequire: boolean;
    /** A module-level `await` — outside every function scope. Recorded because such a body cannot
     *  be moved inside a synchronous wrapper closure (`__commonJS` / `__esm`), which is a build
     *  error rather than something to discover as `Unexpected reserved word` at load. */
    sawTopLevelAwait: boolean;
    /** The SOURCE contained an `import`/`export` DECLARATION. Recorded at parse time because a
     *  module's format is a property of its source, not of what survives lowering: an `export` after
     *  an unconditional top-level `throw` is unreachable and gets eliminated, and classifying from
     *  the surviving AST then decided a genuine ES module was CommonJS. Excludes `import()`, which
     *  is legal in a CommonJS file and settles nothing. */
    sawEsmExport: boolean;
    /** Same, for an `import` DECLARATION. Kept separate from {@link sawEsmExport} because the two
     *  feed DIFFERENT classification tiers: an export decides ESM outright, while an import only
     *  breaks the final tie — a file with `import` AND `module.exports` is CommonJS. */
    sawEsmImport: boolean;
    /** Nesting depth of scopes that REBIND `this` — non-arrow function bodies and class bodies.
     *  Arrows are excluded because they inherit `this` from the enclosing scope, so an arrow at the
     *  module top level still sees the module's `this`. */
    thisDepth: number;
    /** `this` expressions at the module top level. In CommonJS these mean `module.exports` (the body
     *  is called with it as the receiver); in an ES module they are `undefined`. Collected here
     *  because the predicate is a parse-time fact — oxc/rolldown likewise gather them during
     *  scanning and defer the rewrite (`ast_scanner/mod.rs:352-362`). */
    topLevelThis: Node[];
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
    /** Saw `import(...)` or `import.meta` — see `ParseResult.hasImportSyntax`. */
    sawImportSyntax: boolean;
};

/** Push a formatted diagnostic (capped, so a runaway parse can't allocate forever). */
export function raise(state: ParserState, code: ParseErrorCode, ...params: string[]): void {
    if (state.errors.length < 100) {
        state.errors.push({ pos: state.tokStart, msg: formatError(code, params), code });
    }
}
