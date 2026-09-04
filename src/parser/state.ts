// Shared parser substrate: the threaded `ParserState`, the packed token-identity
// aliases (P / K / T_*), and diagnostic raising. Both lexer.ts and parser.ts
// import from here, so this module depends on neither of them (a clean DAG:
// state ← lexer ← parser).
import type { Node } from '../ast/index.ts';
import { formatError, type ParseErrorCode } from './errors.ts';
import { TOK } from './token.ts';

// Literal/structural token kinds. `state.tok` is a packed token (token.ts); these
// aliases keep the comparison sites readable (`state.tok === T_NUM`). The coarse
// `T_PUNCT`/`T_KW` are gone — use `isPunct(state.tok)` / `isKeyword(state.tok)`.
export const T_EOF = TOK.EOF;
export const T_IDENT = TOK.IDENT;
export const T_NUM = TOK.NUMERIC_LITERAL;
export const T_BIGINT = TOK.BIGINT_LITERAL;
export const T_STR = TOK.STRING_LITERAL;
export const T_TEMPLATE_FULL = TOK.TEMPLATE_FULL;
export const T_TEMPLATE_HEAD = TOK.TEMPLATE_HEAD;
export const T_REGEX = TOK.REGEXP_LITERAL;
export const T_JSX_TEXT = TOK.JSX_TEXT;
export const T_PRIVATE = TOK.PRIVATE_IDENTIFIER;

// Punctuator and keyword identities are the packed token constants from token.ts.
// A punctuator's packed value can never equal a keyword's (disjoint kind bytes),
// so `state.tok === P.LPAREN` / `state.tok === K.IN` compare whole packed values.
export const P = TOK;
export const K = TOK;

/** tokFlags bit: a newline preceded this token (for ASI / no-line-terminator rules). */
export const F_NL = 1;
/** The current token is an identifier written with at least one `\uXXXX` escape, so its NAME is
 *  `tokCooked` rather than the source slice. A token flag rather than a separate reset, because
 *  `tokFlags` is already assigned once per token — checking for an escaped identifier therefore
 *  costs nothing on the hot path. */
export const F_ESCAPED = 2;
/** The template part just scanned contains an escape the language does not define — `\x` without
 *  two hex digits, a legacy octal, `\8`. It is NOT an error by itself: a TAGGED template may carry
 *  one (its cooked value is simply `undefined`), and only an untagged one rejects it. The lexer
 *  records it and `parseTemplate` decides, because only the caller knows about the tag. */
export const F_BAD_ESCAPE = 4;

/**
 * Grammar context, as one word. Bit positions mirror oxc's `Context`
 * (`oxc_parser/src/context.rs`) so the two read side by side. Bits 0, 3 and 8 — `In`, `Return`,
 * `NewTarget` — are absent because we model those as a parameter and two depth counters.
 */
export const CTX = {
    Yield: 1 << 1,
    Await: 1 << 2,
    Decorator: 1 << 4,
    DisallowConditionalTypes: 1 << 5,
    Ambient: 1 << 6,
    TopLevel: 1 << 7,
} as const;

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
    /** Source positions of the token following each `/*@__NO_SIDE_EFFECTS__*​/` annotation. Resolved
     *  to the annotated function AFTER the parse — see `resolveNoSideEffects`. */
    nseAt: number[];
    /** Every comment, flat, stride 4: `[start, end, flags, attachedTo]`. `attachedTo` is the start of
     *  the token the comment precedes — oxc's model (`lexer/trivia_builder.rs`), where comments are
     *  joined to the tree by OFFSET rather than attached to nodes. Same species as {@link nseAt}:
     *  append-only, lex-time, truncated on rewind. */
    comments: Int32Array;
    /** Elements USED in {@link comments}; the buffer is larger and grows by doubling. A count rather
     *  than a length so a failed probe rewinds with a scalar write — truncating a boxed array on
     *  every speculation cost 24% of parse time on a comment-dense file (`perf-findings.md` §1b). */
    commentsLen: number;
    /** Is anything going to READ {@link comments}? False for the dev path, which never prints them. */
    keepComments: boolean;
    /** A top-level `await` was consumed as an IDENTIFIER. Only meaningful for the `unambiguous` goal,
     *  where the module kind is not yet known — oxc's `encountered_await_identifier`
     *  (`ParserState`, `state.rs:32`). */
    /** The module goal is not declared, so `await` may turn out to be either an operator or an
     *  identifier and the next token decides per occurrence. Never true once a goal is declared. */
    goalUnknown: boolean;
    /** Source contains a construct that PARSES but cannot be emitted into an ES module — a `with`
     *  statement or a decorator. A cheap gate so the diagnosing walk runs only for a module that
     *  could produce one; the TS gate beside it cannot cover these, because both are plain JS. */
    sawUnbundlable: boolean;
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
    /** Parsing a FORMAL PARAMETER list right now. A `yield`/`await` EXPRESSION is illegal there —
     *  `function *g(x = yield) {}` and `async function a(x = await 1) {}` — and an arrow INHERITS the
     *  surrounding context, so `function *g() { (x = yield) => {}; }` is an error too while a nested
     *  ordinary function's `yield` is just an identifier. Cleared for any nested BODY. */
    /** The logical operator at the top level of the expression  just returned — 0 none,
     *  1 for `||`/`&&`, 2 for `??`. Lets the caller tell an unparenthesised operand from a
     *  parenthesised one, which the AST cannot: same shape as the unparenthesised-`?.` tracking below. */
    /** Node ids of array/object literals that had a trailing comma after a REST element. Legal in the
     *  literal, illegal once it becomes a destructuring TARGET — and the comma leaves no trace in the
     *  AST, while the literal builders discard their flags argument and the node SHAPE is fixed on
     *  purpose. So it is recorded beside the tree, lazily, like `notArrow` below. */
    restComma: Set<number> | null;
    topLogical: number;
    /** The operator at `parseUnary`'s OWN top level (`''` when its result came from anywhere else,
     *  a parenthesised operand included). The exponentiation rule's equivalent of `topLogical`. */
    unaryTop: string;
    inParams: boolean;
    /** The goal is declared MODULE. `import.meta` and top-level `await` are legal only here (or,
     *  pending resolution, under `unambiguous`). */
    goalIsModule: boolean;
    /**
     * Errors that only hold if the file turns out to be a SCRIPT.
     *
     * oxc's `deferred_script_errors` + `error_on_script` (`error_handler.rs:69`). Under the
     * `unambiguous` goal the module kind is not known until the parse ends, and several rules —
     * `import.meta`, top-level `await`, `for await` at top level — are errors in a script and legal in
     * a module. oxc parks them here and, at the end of `parse`, EMITS them if the file resolved to a
     * script and DISCARDS them if it resolved to a module (`lib.rs:745-753`).
     *
     * This replaces a family of `allow*` booleans that each answered one such question by hand. The
     * mechanism generalises where the flags did not: `import.meta` and top-level `await` are
     * themselves ESM markers, so under `unambiguous` their own deferred error self-cancels, which no
     * flag expressed.
     */
    deferredScriptErrors: ParseError[];
    /** Is `await` the OPERATOR here, rather than a plain identifier? oxc's `Context::has_await`
     *  (`js/arrow.rs:261,311` — `ctx.and_await(r#async)`), which is REPLACED on entering a function
     *  body by that function's async-ness and restored on exit, not accumulated. Seeded at top level
     *  from the module goal: an ES module permits top-level await, a CommonJS body does not.
     *
     *  When false, `await` parses as an identifier rather than erroring — matching oxc
     *  (`js/expression.rs:89`). That is what keeps `await(x)` a call to a function named `await` in
     *  a script, and it makes `await x` fail naturally as two adjacent identifiers. */
    /** The decoded name of an escaped identifier — meaningful only while `tokFlags & F_ESCAPED`.
     *  Never cleared: the flag is what makes it live, so the ordinary identifier path writes
     *  nothing here. */
    tokCooked: string;
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
    /** A syntax error has been recorded and the lexer jumped to EOF. Rewound by `restoreState`, so
     *  speculative probes that fail do not latch it. See {@link raise}. */
    fatal: boolean;
    /** Nesting depth of scopes that REBIND `this` — non-arrow function bodies and class bodies.
     *  Arrows are excluded because they inherit `this` from the enclosing scope, so an arrow at the
     *  module top level still sees the module's `this`. */
    thisDepth: number;
    /** Nesting depth of class STATIC BLOCKS. `await` is reserved as an identifier inside one, but a
     *  static block is not an async context, so `CTX.Await` cannot carry it — the two rules differ
     *  and oxc separates them across two crates (see `parseIdent`). */
    staticBlockDepth: number;
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
    /** Offsets of `(` positions already proven NOT to start an arrow head, so a span is speculated at
     * most once. oxc's `ParserState::not_parenthesized_arrow` (`js/arrow.rs:354`). Lazily created:
     * most parses never speculate. */
    notArrow: Set<number> | null;
    ctx: number;
    /** Set by parseMemberChain on exit: did this frame's top level contain an unparenthesized `?.`?
     * parseNew reads it to reject an optional chain as a `new` callee. */
    chainSawOptional: boolean;
    /** Set true when the parser builds any JSX node — a per-module "uses JSX" flag computed for
     * free during parse (esbuild's `p.jsxRuntimeImports` model), so consumers don't re-walk the AST
     * just to detect JSX. */
    sawJSX: boolean;
    /** Saw `import(...)` or `import.meta` — see `ParseResult.hasImportSyntax`. */
    sawImportSyntax: boolean;
};

/** Push a formatted diagnostic (capped, so a runaway parse can't allocate forever). */
/**
 * Record a syntax error and STOP.
 *
 * Every reference parser reports one error per file and stops: meriyah throws, esbuild reports
 * exactly 1, and oxc latches — `set_fatal_error` records the diagnostic and calls
 * `lexer.advance_to_end()` (`oxc_parser/src/error_handler.rs:84-89`). shakeup used to keep going,
 * which produced up to 9 cascading errors for one real mistake and, worse, meant every recovery loop
 * had to be independently proved to terminate. It was not: `llm/repro/parser-oom.js` is 347 bytes
 * that exhausted a 4GB heap.
 *
 * Jumping to EOF is what makes termination STRUCTURAL rather than per-loop — every
 * `while (!isP(state, <closer>) && tok !== T_EOF)` in the parser exits on its next test, with no
 * reasoning required at any individual site.
 *
 * Safe under speculation because `restoreState` rewinds `fatal` along with `pos` and the error list:
 * a failed `saveState`/`restoreState` probe leaves no trace, which it must, since speculation raises
 * errors on purpose.
 *
 * Nothing is lost by stopping: BOTH consumers discard the AST when any error is present —
 * `bundle.ts` returns early on `graph.errors.length > 0`, `transform.ts` returns `emptyResult`.
 */
export function raise(state: ParserState, code: ParseErrorCode, ...params: string[]): void {
    raiseAt(state, state.tokStart, code, ...params);
}

/** {@link raise} at an explicit offset, for an EARLY error — one discovered after the offending
 *  construct has already been parsed, where `tokStart` is a token past it. `f() = 1` is found at the
 *  `=`, but the span oxc labels is the call's. */
/**
 * Record an early error WITHOUT latching `fatal` or jumping to end-of-input, so the parse continues.
 *
 * Needed where the offending construct sits inside a SPECULATIVE arrow head: `raiseAt` aborts to EOF,
 * which makes `tryParseArrow` treat the attempt as a failure, rewind, and re-parse the text as a
 * parenthesised expression — the real diagnostic is discarded and the reader gets "expected ';'".
 *
 * A soft error rides the speculation instead. `restoreState` truncates `state.errors` to its saved
 * length (`restoreState`, index 5), so this survives a probe that SUCCEEDS and is dropped by one that
 * fails — which is exactly the cover-grammar rule: the error only exists if the arrow does.
 */
export function raiseSoft(state: ParserState, pos: number, code: ParseErrorCode, ...params: string[]): void {
    if (state.fatal) return;
    state.errors.push({ pos, msg: formatError(code, params), code });
}

/**
 * Raise an error that only holds if this file is a SCRIPT — oxc's `error_on_script`
 * (`error_handler.rs:69`).
 *
 * With a declared goal the answer is known now, so it behaves like {@link raiseSoft}. Under
 * `unambiguous` it is parked in {@link ParserState.deferredScriptErrors} and resolved once the parse
 * has seen whether the file contains ESM syntax.
 */
export function raiseOnScript(state: ParserState, pos: number, code: ParseErrorCode, ...params: string[]): void {
    if (state.fatal) return;
    const e = { pos, msg: formatError(code, params), code };
    if (state.goalUnknown) state.deferredScriptErrors.push(e);
    else state.errors.push(e);
}

export function raiseAt(state: ParserState, pos: number, code: ParseErrorCode, ...params: string[]): void {
    if (state.fatal) return;
    state.fatal = true;
    state.errors.push({ pos, msg: formatError(code, params), code });
    // Jump the lexer to end-of-input. `tokStart`/`tokEnd` follow so the next `raise` (there will not
    // be one) and any span built from them stay inside the source.
    state.pos = state.srcLen;
    state.tokStart = state.srcLen;
    state.tokEnd = state.srcLen;
    state.tok = T_EOF;
    state.tokFlags = 0;
}
