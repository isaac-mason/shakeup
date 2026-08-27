import {
    allocId,
    type BindingIdentifier,
    type IdentifierName,
    type IdentifierReference,
    type LabelIdentifier,
    lineColOf,
    N,
    type Node,
    type Program,
} from '../ast.ts';
import { enumeration } from '../util/enumeration';
import * as create from './create.ts';
import { FL, type KeywordType, OP, VAR_KIND } from './create.ts';
import { ParseErrorCode } from './errors.ts';
import {
    buildLineStarts,
    C_DIG,
    C_ID,
    C_NL,
    C_WS,
    CHAR,
    hashRange,
    intern,
    nextToken,
    reScanRegex,
    reScanTemplateContinue,
    sliceFlat,
} from './lexer.ts';
import {
    F_NL,
    K,
    P,
    type ParseError,
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
import {
    isAssignOp,
    isBinaryOp,
    isContextual,
    isKeyword,
    isLogical,
    isMemberCont,
    isPunct,
    opTextOf,
    precedenceOf,
} from './token.ts';

// Re-exported so the parser's public surface (via index.ts) still carries ParseError.
export type { ParseError };

/** Any of the four identifier-role leaves; the role is fixed by the constructing call site. */
type Identifier = BindingIdentifier | IdentifierReference | IdentifierName | LabelIdentifier;

const R_BIND = N.BindingIdentifier;
const R_REF = N.IdentifierReference;
const R_NAME = N.IdentifierName;
const R_LABEL = N.LabelIdentifier;

const TSOP = enumeration('KEYOF', 'READONLY', 'UNIQUE');

/** A parse slot: a node object, or null when absent. */
type Ref = Node | null;

// Token-identity aliases (P / K / T_*), F_NL, ParserState, and raise now live in
// state.ts; the lexer/scanner lives in lexer.ts (both imported at the top).

/** Fresh parser state for one `parse` call. Every field is initialized here so
 * `state` keeps a single stable hidden class for the whole parse. */
/** `FL.PURE` when a `/*@__PURE__*​/` annotation immediately precedes the expression starting at
 *  `start` (the whitespace skipper records that position in `state.pureAt`), else 0.
 *
 *  The annotation is CONSUMED on the first match. In `/*@__PURE__*​/ new Matrix3().set(…)` both the
 *  inner `new` and the outer `.set()` call begin at the same offset, so without consuming it the one
 *  annotation would mark two nodes — printing two markers and failing to round-trip. Nodes are built
 *  innermost-first, so the `new` claims it: that matches the convention (esbuild/rollup) that the
 *  marker applies to the call it immediately precedes. */
function pureFlag(state: ParserState, start: number): number {
    if (state.pureAt !== start) return 0;
    state.pureAt = -1;
    return FL.PURE;
}

function createParserState(source: string, options: ParseOptions): ParserState {
    // Start the per-file buffers small and let them grow on demand (push / internGrow).
    // Most modules are small; oversizing every state (esp. the null-filled stk and the
    // zeroed interner arrays) was pure per-file allocation. Large files just regrow.
    const cap = 1 << 10;
    return {
        src: source,
        srcLen: source.length,
        pos: 0,
        tok: T_EOF,
        tokStart: 0,
        tokEnd: 0,
        tokFlags: 0,
        pureAt: -1,
        tokHash: 0,
        tsMode: options.ts,
        jsxMode: options.jsx,
        fnDepth: 0,
        newTargetDepth: 0,
        // `unambiguous` (the default) stays permissive, so adopting the goal gate is NOT a breaking
        // change: only a file with an explicit signal — `.cjs`/`.mjs`/`.cts`/`.mts` or a declared
        // `package.json#type` — is held to it. Mirrors oxc's `ModuleKind::Unambiguous`.
        allowTopReturn: options.kind !== 'module',
        allowTopNewTarget: options.kind !== 'module',
        // Top-level await: legal in an ES module, not in a CommonJS body (which is wrapped in a
        // non-async function). `unambiguous` stays permissive, as with the other two gates.
        awaitOk: options.kind !== 'commonjs',
        errors: [],
        baseId: 0,
        itKeys: new Array(cap),
        itHashes: new Int32Array(cap),
        itMask: cap - 1,
        itCount: 0,
        stk: new Array(1 << 8).fill(null),
        sp: 0,
        speculating: 0,
        sawJSX: false,
        sawTopLevelReturn: false,
        sawRequire: false,
        sawTopLevelAwait: false,
        sawEsmExport: false,
        sawEsmImport: false,
        fatal: false,
        thisDepth: 0,
        topLevelThis: [],
        sawImportSyntax: false,
        chainSawOptional: false,
        noCondType: false,
    };
}

function nextId(state: ParserState): number {
    const id = allocId();
    if (state.baseId === 0) state.baseId = id;
    return id;
}

// `v` is a packed token constant (P.* / K.*); packed values are unique per kind,
// so a whole-value compare is both the kind check and the identity check.
const isP = (state: ParserState, v: number): boolean => state.tok === v;
const isK = (state: ParserState, v: number): boolean => state.tok === v;

function eatP(state: ParserState, v: number): boolean {
    if (isP(state, v)) {
        nextToken(state);
        return true;
    }
    return false;
}
/**
 * Force progress in a RECOVERY LOOP, returning true if the loop should stop.
 *
 * Every `while (!isP(state, <closer>) && tok !== T_EOF)` in this file assumes its body consumes at
 * least one token. On invalid input that assumption breaks: `expectP` and `parseNameAsIdent` REPORT
 * without consuming, so a token that is neither the closer, nor EOF, nor anything the body handles
 * leaves the state identical and the loop runs forever — allocating a node per iteration.
 *
 * That is not hypothetical. `llm/repro/parser-oom.js` is 347 bytes of Flow-typed source that
 * exhausted a 4GB heap and killed the process: `parseBindingTarget`'s object-pattern loop spun on a
 * token it could not start a property with, pushing one `ObjectProperty` per turn. A bundler must
 * never be killed by its input, and the file was reached simply by parsing `node_modules`.
 *
 * Call at the END of a loop body with the `state.tokStart` captured at the START. No extra
 * diagnostic: the body already raised one for this exact token — that is WHY it made no progress —
 * and a second would be noise. Cost is one integer compare per iteration.
 */
function noProgress(state: ParserState, mark: number): boolean {
    if (state.tokStart !== mark) return false;
    if ((state.tok as number) === T_EOF) return true;
    nextToken(state);
    return false;
}

function expectP(state: ParserState, v: number, what: string): void {
    if (isP(state, v)) nextToken(state);
    else raise(state, ParseErrorCode.Expected, what);
}
function eatK(state: ParserState, v: number): boolean {
    if (isK(state, v)) {
        nextToken(state);
        return true;
    }
    return false;
}

function isIdentLike(state: ParserState): boolean {
    return state.tok === T_IDENT || isContextual(state.tok);
}
function isNameLike(state: ParserState): boolean {
    return state.tok === T_IDENT || isKeyword(state.tok);
}

/** Human description of the current token for diagnostics: `token 'foo'`, or `end of input`. */
function tokenDesc(state: ParserState): string {
    return state.tokEnd > state.tokStart ? `token '${state.src.slice(state.tokStart, state.tokEnd)}'` : 'end of input';
}

/** Note a `this` that is at the module top level, where CommonJS gives it `module.exports`. */
function recordThis(state: ParserState, n: Node): Node {
    if (state.thisDepth === 0) state.topLevelThis.push(n);
    return n;
}

function ident(state: ParserState, role: number, start: number, end: number): Identifier {
    const h = start === state.tokStart && end === state.tokEnd ? state.tokHash : hashRange(state, start, end);
    const name = intern(state, start, end, h);
    // Cheap syntactic gate for the `require("lit")` edge walk — set here rather than by a dedicated
    // pass, exactly as `sawJSX` is. A false positive (a local named `require`) only costs one walk.
    if (name.length === 7 && name === 'require') state.sawRequire = true;
    return { id: nextId(state), type: role, start, end, name, sym: 0, data: null } as Identifier;
}
function leafRaw(state: ParserState, flatType: number, start: number, end: number): Node {
    return { id: nextId(state), type: flatType, start, end, name: sliceFlat(state, start, end), sym: 0, data: null } as Node;
}
/** Parse an identifier token in the given role. `role` picks the leaf type. */
function parseIdent(state: ParserState, role: number): Identifier {
    if (!isIdentLike(state)) {
        raise(state, ParseErrorCode.ExpectedIdentifier);
        return makeMissingIdent(state, role);
    }
    const id = ident(state, role, state.tokStart, state.tokEnd);
    nextToken(state);
    return id;
}
/** Parse a name-or-keyword token as an identifier in the given role (property
 * keys, member names, specifier names — usually IdentifierName). */
function parseNameAsIdent(state: ParserState, role: number): Identifier {
    if (!isNameLike(state)) {
        raise(state, ParseErrorCode.ExpectedName);
        return makeMissingIdent(state, role);
    }
    const id = ident(state, role, state.tokStart, state.tokEnd);
    nextToken(state);
    return id;
}
function makeMissingIdent(state: ParserState, role: number): Identifier {
    return { id: nextId(state), type: role, start: 0, end: 0, name: '', sym: 0, data: null } as Identifier;
}
/** A literal/leaf of the given flat type at the current token span. */
function leaf(state: ParserState, flatType: number, start: number, end: number): Node {
    return leafRaw(state, flatType, start, end);
}

const canInsertSemi = (state: ParserState): boolean =>
    (state.tokFlags & F_NL) !== 0 || state.tok === T_EOF || isP(state, P.RBRACE);
function consumeSemi(state: ParserState): void {
    if (eatP(state, P.SEMI)) return;
    if (!canInsertSemi(state)) raise(state, ParseErrorCode.Expected, "';'");
}

// No line-table field to save/restore: the line table is built once, deferred, so nothing
// mutates it during (speculative) parsing.
type LexState = [number, number, number, number, number, number, number, boolean];
const saveState = (state: ParserState): LexState => [
    state.pos,
    state.tok,
    state.tokStart,
    state.tokEnd,
    state.tokFlags,
    state.errors.length,
    state.tokHash,
    state.fatal,
];
function restoreState(state: ParserState, s: LexState): void {
    state.pos = s[0];
    state.tok = s[1];
    state.tokStart = s[2];
    state.tokEnd = s[3];
    state.tokFlags = s[4];
    state.errors.length = s[5];
    state.tokHash = s[6];
    // Rewound with everything else: speculation raises errors deliberately, so a failed probe must
    // not leave the parse latched.
    state.fatal = s[7];
}

function push(state: ParserState, v: Ref): void {
    const stk = state.stk;
    if (state.sp === stk.length) {
        const n = stk.length;
        for (let i = 0; i < n; i++) stk.push(null);
    }
    stk[state.sp++] = v;
}
const DEV = process.env.NODE_ENV !== 'production';

/** Position of the current token as `line:col`, for invariant messages. The line table
 * is built deferred (not during lex), so compute it on demand here — dev/error path only. */
function here(state: ParserState): string {
    const { line, column } = lineColOf(buildLineStarts(state.src), state.tokStart);
    return `${line}:${column}`;
}

/** Materialize [from, sp) into a fresh exact-size packed array (dropping the run).
 * Grammar-guaranteed list: asserts (dev) that no hole slipped through. */
// Shared frozen empty list. Every no-arg call `f()`, empty `{}` block and absent param/type list
// finishes a zero-length list (~2k per module on real code). Downstream passes never mutate a
// node's list array in place — the AST is rebuilt, not spliced — so one shared array is safe;
// frozen so any accidental in-place mutation throws loudly instead of corrupting siblings.
const EMPTY_LIST: Node[] = Object.freeze([]) as unknown as Node[];

function finishList(state: ParserState, from: number): Node[] {
    if (from === state.sp) return EMPTY_LIST;
    const stk = state.stk;
    if (DEV)
        for (let i = from; i < state.sp; i++)
            if (stk[i] === null) throw new Error(`parser invariant: null in list at ${here(state)}`);
    const out = stk.slice(from, state.sp) as Node[];
    state.sp = from;
    return out;
}
/** As finishList but typed to preserve nulls (array-pattern / call holes). */
function finishListWithHoles(state: ParserState, from: number): (Node | null)[] {
    const out = state.stk.slice(from, state.sp);
    state.sp = from;
    return out;
}

function applyDeclare(inner: Node, start: number): void {
    const r = inner as { data: { declare?: boolean } | null };
    if (r.data !== null) r.data.declare = true;
    inner.start = start;
}

function parseExpression(state: ParserState, noIn = false): Node {
    const expr = parseAssign(state, noIn);
    if (isP(state, P.COMMA)) {
        const start = expr.start;
        const from = state.sp;
        push(state, expr);
        while (eatP(state, P.COMMA)) push(state, parseAssign(state, noIn));
        return create.SequenceExpression(start, state.tokStart, 0, finishList(state, from)) as Node;
    }
    return expr;
}

function parseAssign(state: ParserState, noIn = false): Node {
    if (isP(state, P.LPAREN) && arrowAheadFromParen(state)) return parseArrow(state, state.tokStart, 0, null);
    if (isIdentLike(state) && !isK(state, K.ASYNC) && identArrowAhead(state)) {
        // `ident =>` confirmed by source peek — parse the identifier once, as the arrow param.
        const idStart = state.tokStart;
        const maybe = parseIdent(state, R_BIND);
        return parseArrowAfterSingleParam(state, idStart, maybe, 0);
    }
    // The grammar's restriction is `async [no LineTerminator here] ArrowFunction` — it sits BETWEEN
    // `async` and its parameters, which is the check below on the NEXT token. Testing `F_NL` on the
    // `async` token itself asked a different question ("was there a newline before `async`") and a
    // newline there is perfectly legal, so every multiline call taking an async arrow argument —
    //     f('PLUGIN',
    //       async (data) => { … })
    // — a newline anywhere before `async` — failed with `expected ')'`. Measured against oxc across
    // webpack/rspack/vite: 131 real files.
    if (isK(state, K.ASYNC)) {
        const s = saveState(state);
        const asyncStart = state.tokStart;
        nextToken(state);
        if ((state.tokFlags & F_NL) === 0) {
            if (isP(state, P.LPAREN) && arrowAheadFromParen(state)) return parseArrow(state, asyncStart, FL.ASYNC, null);
            if (isIdentLike(state)) {
                const idStart = state.tokStart;
                const single = parseIdent(state, R_BIND);
                if (isP(state, P.ARROW)) return parseArrowAfterSingleParam(state, asyncStart, single, FL.ASYNC, idStart);
            }
        }
        restoreState(state, s);
    }
    if (state.tsMode && isP(state, P.LT)) {
        const s = saveState(state);
        const start = state.tokStart;
        const tp = tryParseTypeParams(state);
        if (tp !== null && isP(state, P.LPAREN) && arrowAheadFromParen(state)) return parseArrow(state, start, 0, tp);
        restoreState(state, s);
    }
    if (isK(state, K.YIELD)) {
        const start = state.tokStart;
        nextToken(state);
        let flags = 0;
        if (isP(state, P.STAR)) {
            flags |= FL.DELEGATE;
            nextToken(state);
        }
        let arg: Ref = null;
        if (
            !canInsertSemi(state) &&
            !isP(state, P.RPAREN) &&
            !isP(state, P.RBRACKET) &&
            !isP(state, P.RBRACE) &&
            !isP(state, P.COMMA) &&
            !isP(state, P.SEMI) &&
            !isP(state, P.COLON)
        )
            arg = parseAssign(state, noIn);
        return create.YieldExpression(start, arg ? arg.end : state.tokStart, flags, arg) as Node;
    }

    const left = parseConditional(state, noIn);
    if (isAssignOp(state.tok)) {
        const op = opTextOf(state.tok);
        nextToken(state);
        const right = parseAssign(state, noIn);
        return create.AssignmentExpression(left.start, right.end, op, left, right) as Node;
    }
    return left;
}

function parseConditional(state: ParserState, noIn: boolean): Node {
    const test = parseBinary(state, 0, noIn);
    if (!isP(state, P.QUESTION)) return test;
    nextToken(state);
    const cons = parseAssign(state, false);
    expectP(state, P.COLON, "':'");
    const alt = parseAssign(state, noIn);
    return create.ConditionalExpression(test.start, alt.end, 0, test, cons, alt) as Node;
}

function parseBinary(state: ParserState, minPrec: number, noIn: boolean): Node {
    let left = parseUnary(state);
    for (;;) {
        const tok = state.tok;
        // TS `as` / `satisfies` are type operators (they consume a type), not binary ops.
        if (state.tsMode && (tok === K.AS || tok === K.SATISFIES) && (state.tokFlags & F_NL) === 0) {
            const satisfies = tok === K.SATISFIES;
            nextToken(state);
            const ty = parseType(state);
            left = satisfies
                ? (create.TSSatisfiesExpression(left.start, ty.end, 0, left, ty) as Node)
                : (create.TSAsExpression(left.start, ty.end, 0, left, ty) as Node);
            continue;
        }
        // One uniform path: punctuator ops and `in`/`instanceof` all carry precedence
        // + IsBinaryOp in the packed token (token.ts), so there is no punct-vs-keyword branch.
        if (!isBinaryOp(tok)) return left;
        if (tok === K.IN && noIn) return left; // `in` is not an operator in a no-in context
        const prec = precedenceOf(tok);
        if (prec <= minPrec) return left;
        nextToken(state);
        const right = parseBinary(state, tok === P.STARSTAR ? prec - 1 : prec, noIn);
        const op = opTextOf(tok);
        left = isLogical(tok)
            ? (create.LogicalExpression(left.start, right.end, op, left, right) as Node)
            : (create.BinaryExpression(left.start, right.end, op, left, right) as Node);
    }
}

function parseUnary(state: ParserState): Node {
    const start = state.tokStart;
    if (isPunct(state.tok)) {
        switch (state.tok as number) {
            case P.PLUS:
            case P.MINUS:
            case P.BANG:
            case P.TILDE: {
                const op =
                    state.tok === P.PLUS ? OP.POS : state.tok === P.MINUS ? OP.NEG : state.tok === P.BANG ? OP.NOT : OP.BIT_NOT;
                nextToken(state);
                const arg = parseUnary(state);
                return create.UnaryExpression(start, arg.end, op, arg) as Node;
            }
            case P.PLUSPLUS:
            case P.MINUSMINUS: {
                const op = state.tok === P.PLUSPLUS ? OP.INC : OP.DEC;
                nextToken(state);
                const arg = parseUnary(state);
                return create.UpdateExpression(start, arg.end, op | FL.PREFIX, arg) as Node;
            }
        }
    } else if (isKeyword(state.tok)) {
        switch (state.tok as number) {
            case K.TYPEOF:
            case K.VOID:
            case K.DELETE: {
                const op = state.tok === K.TYPEOF ? OP.TYPEOF : state.tok === K.VOID ? OP.VOID : OP.DELETE;
                nextToken(state);
                const arg = parseUnary(state);
                return create.UnaryExpression(start, arg.end, op, arg) as Node;
            }
            case K.AWAIT: {
                // Only an operator where `await` is in scope. Elsewhere it is an ordinary
                // identifier (`await` is contextual), so fall out of the switch and let the normal
                // expression path handle it — oxc `js/expression.rs:89`.
                if (!state.awaitOk) break;
                if (state.fnDepth === 0) state.sawTopLevelAwait = true;
                nextToken(state);
                const arg = parseUnary(state);
                return create.AwaitExpression(start, arg.end, 0, arg) as Node;
            }
        }
    }
    let expr = parsePostfixChain(state);
    if (isPunct(state.tok) && (state.tok === P.PLUSPLUS || state.tok === P.MINUSMINUS) && (state.tokFlags & F_NL) === 0) {
        const op = state.tok === P.PLUSPLUS ? OP.INC : OP.DEC;
        nextToken(state);
        expr = create.UpdateExpression(expr.start, state.tokStart, op, expr) as Node;
    }
    return expr;
}

function parsePostfixChain(state: ParserState): Node {
    if (isK(state, K.NEW)) return parseNew(state);
    return parseMemberChain(state, parsePrimary(state), true);
}

function parseNew(state: ParserState): Node {
    const start = state.tokStart;
    nextToken(state);
    if (isP(state, P.DOT)) {
        nextToken(state);
        parseNameAsIdent(state, R_NAME);
        if (state.newTargetDepth === 0 && !state.allowTopNewTarget) raise(state, ParseErrorCode.TopLevelNewTarget);
        // Chained, exactly like the NewExpression path below. `new.target` is an ordinary expression
        // and `new.target.value` / `new.target?.name` are legal — returning it unchained stopped the
        // parse at the `.` with `expected ';'`. 8 real webpack files, found by `pnpm parsercorpus`.
        return parseMemberChain(state, create.NewTarget(start, state.tokStart, 0) as Node, true);
    }
    let callee: Node;
    if (isK(state, K.NEW)) {
        callee = parseNew(state);
    } else {
        callee = parseMemberChain(state, parsePrimary(state), false);
        // `new a?.b()` is a SyntaxError; the parenthesized `new (a?.b)()` is legal (the `?.`
        // is consumed inside parsePrimary, so this frame's flag stays false there).
        if (state.chainSawOptional) raise(state, ParseErrorCode.NewOptionalChain);
    }
    let typeArgs: Ref = null;
    if (state.tsMode && isP(state, P.LT)) {
        const t = tryParseTypeArgsForCall(state);
        if (t !== null) typeArgs = t;
    }
    let args: Node[] | null = null;
    let end = callee.end;
    if (isP(state, P.LPAREN)) {
        args = parseArgs(state);
        end = state.tokStart;
    }
    const nw = create.NewExpression(start, end, pureFlag(state, start), callee, args, typeArgs) as Node;
    return parseMemberChain(state, nw, true);
}

function parseArgs(state: ParserState): Node[] {
    nextToken(state);
    const from = state.sp;
    while (!isP(state, P.RPAREN) && (state.tok as number) !== T_EOF) {
        if (isP(state, P.DOTDOTDOT)) {
            const s = state.tokStart;
            nextToken(state);
            const arg = parseAssign(state);
            push(state, create.SpreadElement(s, arg.end, 0, arg) as Node);
        } else push(state, parseAssign(state));
        if (!eatP(state, P.COMMA)) break;
    }
    expectP(state, P.RPAREN, "')'");
    return finishList(state, from);
}

function parseMemberChain(state: ParserState, expr: Node, allowCall: boolean): Node {
    // Fast-exit BEFORE allocating anything: most expressions have no member/call chain,
    // so a single bit-test returns immediately — no `finish` closure, no call. (Runs for
    // every expression; the closure + finish() call were pure overhead on the common path.)
    if (!isMemberCont(state.tok)) {
        state.chainSawOptional = false;
        return expr;
    }
    let sawOptional = false;
    const finish = (e: Node): Node => {
        state.chainSawOptional = sawOptional;
        return sawOptional ? (create.ChainExpression(e.start, e.end, 0, e) as Node) : e;
    };
    for (;;) {
        if (!isMemberCont(state.tok)) return finish(expr);
        if (isP(state, P.DOT)) {
            nextToken(state);
            if (state.tok === T_PRIVATE) {
                const prop = parsePrivate(state);
                expr = create.PrivateFieldExpression(expr.start, prop.end, 0, expr, prop) as Node;
            } else {
                const prop = parseNameAsIdent(state, R_NAME);
                expr = create.StaticMemberExpression(expr.start, prop.end, 0, expr, prop) as Node;
            }
        } else if (isP(state, P.QDOT)) {
            sawOptional = true;
            nextToken(state);
            if (isP(state, P.LPAREN)) {
                if (!allowCall) return finish(expr);
                const args = parseArgs(state);
                expr = create.CallExpression(
                    expr.start,
                    state.tokStart,
                    FL.OPTIONAL | pureFlag(state, expr.start),
                    expr,
                    args,
                    null,
                ) as Node;
            } else if (isP(state, P.LBRACKET)) {
                nextToken(state);
                const prop = parseExpression(state);
                expectP(state, P.RBRACKET, "']'");
                expr = create.ComputedMemberExpression(expr.start, state.tokStart, FL.OPTIONAL, expr, prop) as Node;
            } else if (state.tok === T_PRIVATE) {
                const prop = parsePrivate(state);
                expr = create.PrivateFieldExpression(expr.start, prop.end, FL.OPTIONAL, expr, prop) as Node;
            } else {
                const prop = parseNameAsIdent(state, R_NAME);
                expr = create.StaticMemberExpression(expr.start, prop.end, FL.OPTIONAL, expr, prop) as Node;
            }
        } else if (isP(state, P.LBRACKET)) {
            nextToken(state);
            const prop = parseExpression(state);
            expectP(state, P.RBRACKET, "']'");
            expr = create.ComputedMemberExpression(expr.start, state.tokStart, 0, expr, prop) as Node;
        } else if (allowCall && isP(state, P.LPAREN)) {
            const args = parseArgs(state);
            expr = create.CallExpression(expr.start, state.tokStart, pureFlag(state, expr.start), expr, args, null) as Node;
        } else if (state.tok === T_TEMPLATE_FULL || state.tok === T_TEMPLATE_HEAD) {
            if (sawOptional) raise(state, ParseErrorCode.TaggedOptionalChain);
            const quasi = parseTemplate(state);
            expr = create.TaggedTemplateExpression(expr.start, quasi.end, 0, expr, quasi) as Node;
        } else if (state.tsMode && isP(state, P.BANG) && (state.tokFlags & F_NL) === 0) {
            nextToken(state);
            expr = create.TSNonNullExpression(expr.start, state.tokStart, 0, expr) as Node;
        } else if (state.tsMode && allowCall && isP(state, P.LT)) {
            const t = tryParseTypeArgsForCall(state);
            if (t === null) return finish(expr);
            if (isP(state, P.LPAREN)) {
                const args = parseArgs(state);
                expr = create.CallExpression(expr.start, state.tokStart, pureFlag(state, expr.start), expr, args, t) as Node;
            } else if (state.tok === T_TEMPLATE_FULL || state.tok === T_TEMPLATE_HEAD) {
                if (sawOptional) raise(state, ParseErrorCode.TaggedOptionalChain);
                const quasi = parseTemplate(state);
                expr = create.TaggedTemplateExpression(expr.start, quasi.end, 0, expr, quasi) as Node;
            } else {
                // bare instantiation expression `f<number>`: keep the type args as a
                // node so emit strips them. tryParseTypeArgsForCall's follow-set
                // already gated that `<...>` is type args here (not a `<` comparison).
                expr = create.TSInstantiationExpression(expr.start, t.end, 0, expr, t) as Node;
            }
        } else return finish(expr);
    }
}

function parsePrivate(state: ParserState): Node {
    const id: Node = {
        id: nextId(state),
        type: N.PrivateIdentifier,
        start: state.tokStart,
        end: state.tokEnd,
        name: intern(state, state.tokStart + 1, state.tokEnd, state.tokHash),
        sym: 0,
        data: null,
    };
    nextToken(state);
    return id;
}

function parseTemplate(state: ParserState): Node {
    const start = state.tokStart;
    if (state.tok === T_TEMPLATE_FULL) {
        const q = leaf(state, N.TemplateElement, start + 1, state.tokEnd - 1);
        nextToken(state);
        return create.TemplateLiteral(start, q.end + 1, 0, [q], []) as Node;
    }
    const qFrom = state.sp;
    const eFrom: Node[] = [];
    push(state, leaf(state, N.TemplateElement, start + 1, state.tokEnd - 2));
    nextToken(state);
    for (;;) {
        eFrom.push(parseExpression(state));
        if (!isP(state, P.RBRACE)) {
            raise(state, ParseErrorCode.ExpectedRBraceInTemplate);
            break;
        }
        reScanTemplateContinue(state);
        if (state.tok === T_TEMPLATE_FULL) {
            push(state, leaf(state, N.TemplateElement, state.tokStart + 1, state.tokEnd - 1));
            nextToken(state);
            break;
        }
        push(state, leaf(state, N.TemplateElement, state.tokStart + 1, state.tokEnd - 2));
        nextToken(state);
    }
    const quasis = finishList(state, qFrom);
    return create.TemplateLiteral(start, state.tokStart, 0, quasis, eFrom) as Node;
}

/** Is `c` a valid start char of a JSX identifier (letter / `_` / `$`, or any
 * non-ASCII treated as ident). */
function isJSXIdentStart(c: number): boolean {
    return c < 128 ? CHAR[c] === C_ID : c !== 0x2028 && c !== 0x2029;
}

function scanJSXName(state: ParserState): [number, number] {
    const src = state.src,
        srcLen = state.srcLen;
    const start = state.pos;
    let pos = state.pos + 1;
    while (pos < srcLen) {
        const c = src.charCodeAt(pos);
        if (c < 128) {
            const cl = CHAR[c];
            if (cl === C_ID || cl === C_DIG || c === 45) {
                pos++;
                continue;
            }
            break;
        }
        if (c === 0x2028 || c === 0x2029) break;
        pos++;
    }
    state.pos = pos;
    return [start, pos];
}

/** Skip whitespace/newlines inside a JSX tag interior. (Line starts are built deferred.) */
function skipJSXTagWs(state: ParserState): void {
    const src = state.src,
        srcLen = state.srcLen;
    let pos = state.pos;
    while (pos < srcLen) {
        const c = src.charCodeAt(pos);
        if (c < 128 ? CHAR[c] === C_WS || CHAR[c] === C_NL : c === 0x2028 || c === 0x2029 || c === 0xa0 || c === 0xfeff) {
            pos++;
            continue;
        }
        break;
    }
    state.pos = pos;
}

/** A JSXIdentifier leaf (data:null, raw name in the name slot). */
function jsxIdent(state: ParserState, start: number, end: number): Node {
    return {
        id: nextId(state),
        type: N.JSXIdentifier,
        start,
        end,
        name: sliceFlat(state, start, end),
        sym: 0,
        data: null,
    } as Node;
}

function parseJSXName(state: ParserState): Node {
    const src = state.src,
        srcLen = state.srcLen;
    skipJSXTagWs(state);
    if (!isJSXIdentStart(src.charCodeAt(state.pos))) {
        raise(state, ParseErrorCode.ExpectedJSXName);
        return makeMissingIdent(state, R_NAME) as Node;
    }
    const [s0, e0] = scanJSXName(state);
    const first = src.charCodeAt(s0);
    if (state.pos < srcLen && src.charCodeAt(state.pos) === 58) {
        state.pos++;
        const [s1, e1] = isJSXIdentStart(src.charCodeAt(state.pos)) ? scanJSXName(state) : [state.pos, state.pos];
        return create.JSXNamespacedName(s0, e1, 0, jsxIdent(state, s0, e0), jsxIdent(state, s1, e1)) as Node;
    }
    if (state.pos < srcLen && src.charCodeAt(state.pos) === 46) {
        const isThis = e0 - s0 === 4 && src.startsWith('this', s0);
        let obj: Node = isThis
            ? recordThis(state, create.ThisExpression(s0, e0, 0) as Node)
            : (ident(state, R_REF, s0, e0) as Node);
        while (state.pos < srcLen && src.charCodeAt(state.pos) === 46) {
            state.pos++;
            const [ps, pe] = isJSXIdentStart(src.charCodeAt(state.pos)) ? scanJSXName(state) : [state.pos, state.pos];
            obj = create.JSXMemberExpression(s0, pe, 0, obj, jsxIdent(state, ps, pe)) as Node;
        }
        return obj;
    }
    if (e0 - s0 === 4 && first === 116 && src.startsWith('this', s0))
        return recordThis(state, create.ThisExpression(s0, e0, 0) as Node);
    if (first >= 65 && first <= 90) return ident(state, R_REF, s0, e0) as Node;
    return jsxIdent(state, s0, e0);
}

/** Parse a JSX attribute name: JSXIdentifier or JSXNamespacedName (`a:b`). Pos-driven. */
function parseJSXAttributeName(state: ParserState): Node {
    const src = state.src,
        srcLen = state.srcLen;
    const [s0, e0] = scanJSXName(state);
    if (state.pos < srcLen && src.charCodeAt(state.pos) === 58) {
        state.pos++;
        const [s1, e1] = isJSXIdentStart(src.charCodeAt(state.pos)) ? scanJSXName(state) : [state.pos, state.pos];
        return create.JSXNamespacedName(s0, e1, 0, jsxIdent(state, s0, e0), jsxIdent(state, s1, e1)) as Node;
    }
    return jsxIdent(state, s0, e0);
}

function parseJSXBrace(state: ParserState, inChildren: boolean): Node {
    const bracePos = state.pos;
    state.pos = bracePos + 1;
    nextToken(state);
    let node: Node;
    if (isP(state, P.DOTDOTDOT)) {
        nextToken(state);
        const arg = parseAssign(state);
        node = inChildren
            ? (create.JSXSpreadChild(bracePos, state.tokEnd, 0, arg) as Node)
            : (create.JSXExpressionContainer(bracePos, state.tokEnd, 0, arg) as Node);
    } else if (isP(state, P.RBRACE)) {
        node = create.JSXExpressionContainer(
            bracePos,
            state.tokEnd,
            0,
            create.JSXEmptyExpression(bracePos + 1, state.tokStart, 0) as Node,
        ) as Node;
    } else {
        const expr = parseExpression(state);
        node = create.JSXExpressionContainer(bracePos, state.tokEnd, 0, expr) as Node;
    }
    if (isP(state, P.RBRACE)) {
        state.pos = state.tokEnd;
    } else {
        raise(state, ParseErrorCode.ExpectedInJSX, "'}'");
        state.pos = state.tokStart;
    }
    return node;
}

function parseJSXSpreadAttribute(state: ParserState): Node {
    const bracePos = state.pos;
    state.pos = bracePos + 1;
    nextToken(state);
    if (!eatP(state, P.DOTDOTDOT)) raise(state, ParseErrorCode.ExpectedJSXSpread);
    const arg = parseAssign(state);
    const node = create.JSXSpreadAttribute(bracePos, state.tokEnd, 0, arg) as Node;
    if (isP(state, P.RBRACE)) {
        state.pos = state.tokEnd;
    } else {
        raise(state, ParseErrorCode.ExpectedInJSX, "'}'");
        state.pos = state.tokStart;
    }
    return node;
}

/** Parse opening-tag attributes. Pos-driven; `pos` sits just past the name.
 * Leaves `pos` on `>` or `/`. */
function parseJSXAttributes(state: ParserState): Node[] {
    const src = state.src,
        srcLen = state.srcLen;
    const from = state.sp;
    for (;;) {
        skipJSXTagWs(state);
        const c = state.pos < srcLen ? src.charCodeAt(state.pos) : 0;
        if (c === 62 || c === 47 || c === 0) break;
        if (c === 123) {
            push(state, parseJSXSpreadAttribute(state));
            continue;
        }
        if (!isJSXIdentStart(c)) {
            raise(state, ParseErrorCode.UnexpectedCharInJSXAttrs);
            state.pos++;
            continue;
        }
        const name = parseJSXAttributeName(state);
        const nameEnd = state.pos;
        skipJSXTagWs(state);
        let value: Ref = null;
        let end = nameEnd;
        if (state.pos < srcLen && src.charCodeAt(state.pos) === 61) {
            state.pos++;
            skipJSXTagWs(state);
            const vc = state.pos < srcLen ? src.charCodeAt(state.pos) : 0;
            if (vc === 34 || vc === 39) {
                const vs = state.pos;
                state.pos++;
                while (state.pos < srcLen && src.charCodeAt(state.pos) !== vc) {
                    state.pos++;
                }
                state.pos++;
                value = leafRaw(state, N.StringLiteral, vs, state.pos);
                end = state.pos;
            } else if (vc === 123) {
                value = parseJSXBrace(state, false);
                end = state.pos;
            } else if (vc === 60) {
                value = parseJSXNested(state);
                end = state.pos;
            } else {
                raise(state, ParseErrorCode.ExpectedJSXAttrValue);
            }
        }
        push(state, create.JSXAttribute(name.start, end, 0, name, value) as Node);
    }
    return finishList(state, from);
}

/** Parse JSX children (pos-driven). On entry `pos` sits just after the opening
 * `>`; leaves `pos` on the closing-tag `<`. */
function parseJSXChildren(state: ParserState): Node[] {
    const src = state.src,
        srcLen = state.srcLen;
    const from = state.sp;
    for (;;) {
        const textStart = state.pos;
        while (state.pos < srcLen) {
            const c = src.charCodeAt(state.pos);
            if (c === 60 || c === 123) break;
            state.pos++;
        }
        if (state.pos > textStart)
            push(state, {
                id: nextId(state),
                type: N.JSXText,
                start: textStart,
                end: state.pos,
                name: sliceFlat(state, textStart, state.pos),
                sym: 0,
                data: null,
            } as Node);
        if (state.pos >= srcLen) {
            raise(state, ParseErrorCode.UnterminatedJSXElement);
            break;
        }
        const c = src.charCodeAt(state.pos);
        if (c === 123) {
            push(state, parseJSXBrace(state, true));
            continue;
        }
        if (src.charCodeAt(state.pos + 1) === 47) break;
        push(state, parseJSXNested(state));
    }
    return from === state.sp ? [] : finishList(state, from);
}

/** Parse a nested JSX element/fragment in child or attribute-value position. `pos`
 * sits on `<`. Pure raw scan (no lexer sync — the outermost parseJSXRoot resyncs). */
function parseJSXNested(state: ParserState): Node {
    const src = state.src,
        srcLen = state.srcLen;
    const start = state.pos;
    state.pos++;
    skipJSXTagWs(state);
    if (state.pos < srcLen && src.charCodeAt(state.pos) === 62) {
        const openFrag = create.JSXOpeningFragment(start, state.pos + 1, 0) as Node;
        state.pos++;
        const children = parseJSXChildren(state);
        const closeStart = state.pos;
        state.pos += 2;
        skipJSXTagWs(state);
        expectRawChar(state, 62, "'>'");
        const closeFrag = create.JSXClosingFragment(closeStart, state.pos, 0) as Node;
        return create.JSXFragment(start, state.pos, 0, openFrag, children, closeFrag) as Node;
    }
    const name = parseJSXName(state);
    let typeArgs: Ref = null;
    if (state.tsMode && state.pos < srcLen && src.charCodeAt(state.pos) === 60) {
        nextToken(state);
        const ta = tryParseTypeArgsInType(state);
        if (ta !== null) {
            typeArgs = ta;
            state.pos = state.tokStart;
        } else state.pos = state.tokStart;
    }
    const attrs = parseJSXAttributes(state);
    skipJSXTagWs(state);
    if (state.pos < srcLen && src.charCodeAt(state.pos) === 47) {
        state.pos++;
        skipJSXTagWs(state);
        expectRawChar(state, 62, "'>'");
        const open = create.JSXOpeningElement(start, state.pos, 0, name, typeArgs, attrs) as Node;
        return create.JSXElement(start, state.pos, 0, open, [], null) as Node;
    }
    expectRawChar(state, 62, "'>'");
    const open = create.JSXOpeningElement(start, state.pos, 0, name, typeArgs, attrs) as Node;
    const children = parseJSXChildren(state);
    const closeStart = state.pos;
    state.pos += 2;
    const closeName = parseJSXName(state);
    skipJSXTagWs(state);
    expectRawChar(state, 62, "'>'");
    const close = create.JSXClosingElement(closeStart, state.pos, 0, closeName) as Node;
    return create.JSXElement(start, state.pos, 0, open, children, close) as Node;
}

function parseJSXRoot(state: ParserState): Node {
    state.sawJSX = true; // per-module "uses JSX" flag, computed free during parse (esbuild model)
    state.pos = state.tokStart;
    const node = parseJSXNested(state);
    nextToken(state);
    return node;
}

/** Consume the exact raw char `ch` at `pos` (advancing past it); error otherwise. */
function expectRawChar(state: ParserState, ch: number, what: string): void {
    if (state.pos < state.srcLen && state.src.charCodeAt(state.pos) === ch) {
        state.pos++;
        return;
    }
    raise(state, ParseErrorCode.ExpectedInJSX, what);
}

function parsePrimary(state: ParserState): Node {
    const start = state.tokStart;
    switch (state.tok as number) {
        case T_NUM: {
            const n = leaf(state, N.NumericLiteral, start, state.tokEnd);
            nextToken(state);
            return n;
        }
        case T_BIGINT: {
            const n = leaf(state, N.BigIntLiteral, start, state.tokEnd);
            nextToken(state);
            return n;
        }
        case T_STR: {
            const n = leaf(state, N.StringLiteral, start, state.tokEnd);
            nextToken(state);
            return n;
        }
        case T_REGEX: {
            const n = leaf(state, N.RegExpLiteral, start, state.tokEnd);
            nextToken(state);
            return n;
        }
        case T_TEMPLATE_FULL:
        case T_TEMPLATE_HEAD:
            return parseTemplate(state);
        case T_PRIVATE:
            return parsePrivate(state);
        case T_IDENT:
            return parseIdent(state, R_REF);
    }
    if (isPunct(state.tok)) {
        switch (state.tok as number) {
            case P.LT:
                if (state.jsxMode) return parseJSXRoot(state);
                break;
            case P.SLASH:
            case P.SLASHEQ:
                reScanRegex(state);
                return parsePrimary(state);
            case P.LPAREN: {
                nextToken(state);
                const e = parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                return e;
            }
            case P.LBRACKET: {
                nextToken(state);
                const from = state.sp;
                while (!isP(state, P.RBRACKET) && (state.tok as number) !== T_EOF) {
                    const mark = state.tokStart;
                    if (isP(state, P.COMMA)) {
                        push(state, null);
                        nextToken(state);
                        continue;
                    }
                    if (isP(state, P.DOTDOTDOT)) {
                        const s = state.tokStart;
                        nextToken(state);
                        const arg = parseAssign(state);
                        push(state, create.SpreadElement(s, arg.end, 0, arg) as Node);
                    } else push(state, parseAssign(state));
                    if (!isP(state, P.RBRACKET)) expectP(state, P.COMMA, "','");
                    if (noProgress(state, mark)) break;
                }
                expectP(state, P.RBRACKET, "']'");
                return create.ArrayExpression(start, state.tokStart, 0, finishListWithHoles(state, from)) as Node;
            }
            case P.LBRACE:
                return parseObjectLiteral(state);
        }
    } else if (isKeyword(state.tok)) {
        switch (state.tok as number) {
            case K.THIS:
                nextToken(state);
                return recordThis(state, create.ThisExpression(start, state.tokStart, 0) as Node);
            case K.SUPER:
                nextToken(state);
                return create.Super(start, state.tokStart, 0) as Node;
            case K.TRUE:
                nextToken(state);
                return create.BooleanLiteral(start, state.tokStart, 1) as Node;
            case K.FALSE:
                nextToken(state);
                return create.BooleanLiteral(start, state.tokStart, 0) as Node;
            case K.NULL:
                nextToken(state);
                return create.NullLiteral(start, state.tokStart, 0) as Node;
            case K.FUNCTION:
                return parseFunction(state, false, false, true);
            case K.ASYNC:
                nextToken(state);
                if (isK(state, K.FUNCTION)) return parseFunction(state, true, false, true);
                return ident(state, R_REF, start, start + 5);
            case K.CLASS:
                return parseClass(state, true, 0);
            case K.IMPORT: {
                nextToken(state);
                if (isP(state, P.DOT)) {
                    nextToken(state);
                    parseNameAsIdent(state, R_NAME);
                    state.sawImportSyntax = true;
                    return create.ImportMeta(start, state.tokStart, 0) as Node;
                }
                expectP(state, P.LPAREN, "'('");
                const source = parseAssign(state);
                let options: Ref = null;
                if (eatP(state, P.COMMA) && !isP(state, P.RPAREN)) options = parseAssign(state);
                eatP(state, P.COMMA);
                expectP(state, P.RPAREN, "')'");
                state.sawImportSyntax = true;
                return create.ImportExpression(start, state.tokStart, 0, source, options) as Node;
            }
            case K.NEW:
                return parseNew(state);
        }
        if (isContextual(state.tok)) return parseIdent(state, R_REF);
    }
    raise(state, ParseErrorCode.UnexpectedInExpression, tokenDesc(state));
    nextToken(state);
    return makeMissingIdent(state, R_REF);
}

function parseObjectLiteral(state: ParserState): Node {
    const start = state.tokStart;
    nextToken(state);
    const from = state.sp;
    let last = -1;
    while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
        if (state.tokStart === last) {
            raise(state, ParseErrorCode.UnexpectedInObjectLiteral, tokenDesc(state));
            nextToken(state);
            continue;
        }
        last = state.tokStart;
        if (isP(state, P.DOTDOTDOT)) {
            const s = state.tokStart;
            nextToken(state);
            const arg = parseAssign(state);
            push(state, create.SpreadElement(s, arg.end, 0, arg) as Node);
        } else push(state, parseObjectMember(state));
        if (!isP(state, P.RBRACE)) expectP(state, P.COMMA, "','");
    }
    expectP(state, P.RBRACE, "'}'");
    return create.ObjectExpression(start, state.tokStart, 0, finishList(state, from)) as Node;
}

function parseObjectMember(state: ParserState): Node {
    const start = state.tokStart;
    let flags = 0;
    let async = false;
    let generator = false;
    if (isK(state, K.ASYNC) && !nextIsPropertyEnd(state)) {
        async = true;
        nextToken(state);
    }
    if (isP(state, P.STAR)) {
        generator = true;
        nextToken(state);
    }
    let kind = 0;
    if ((isK(state, K.GET) || isK(state, K.SET)) && !nextIsPropertyEnd(state)) {
        kind = isK(state, K.GET) ? 1 : 2;
        nextToken(state);
    }
    let key: Node;
    if (isP(state, P.LBRACKET)) {
        flags |= FL.COMPUTED;
        nextToken(state);
        key = parseAssign(state);
        expectP(state, P.RBRACKET, "']'");
    } else if ((state.tok as number) === T_STR) {
        key = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    } else if (state.tok === T_NUM) {
        key = leaf(state, N.NumericLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    } else key = parseNameAsIdent(state, R_NAME);

    if (kind !== 0 || async || generator || isP(state, P.LPAREN)) {
        const fn = parseMethodTail(state, start, (async ? FL.ASYNC : 0) | (generator ? FL.GENERATOR : 0));
        flags |= kind << FL.KIND_SHIFT;
        return create.ObjectProperty(start, fn.end, flags, key, fn) as Node;
    }
    if (isP(state, P.COLON)) {
        nextToken(state);
        const value = parseAssign(state);
        return create.ObjectProperty(start, value.end, flags, key, value) as Node;
    }
    const shorthandRef = ident(state, R_REF, key.start, key.end);
    if (isP(state, P.EQ)) {
        nextToken(state);
        const right = parseAssign(state);
        const value = create.AssignmentPattern(key.start, right.end, 0, shorthandRef, right) as Node;
        return create.ObjectProperty(start, right.end, flags | FL.SHORTHAND, key, value) as Node;
    }
    return create.ObjectProperty(start, key.end, flags | FL.SHORTHAND, key, shorthandRef) as Node;
}

function nextIsPropertyEnd(state: ParserState): boolean {
    const s = saveState(state);
    nextToken(state);
    const endLike =
        state.tok === T_EOF ||
        (isPunct(state.tok) &&
            (state.tok === P.COLON ||
                state.tok === P.COMMA ||
                state.tok === P.RBRACE ||
                state.tok === P.LPAREN ||
                state.tok === P.EQ ||
                state.tok === P.QUESTION ||
                state.tok === P.SEMI ||
                state.tok === P.RPAREN ||
                state.tok === P.LT ||
                state.tok === P.BANG ||
                state.tok === P.RBRACKET));
    restoreState(state, s);
    return endLike;
}

function parseMethodTail(state: ParserState, start: number, flags: number): Node {
    let typeParams: Ref = null;
    if (state.tsMode && isP(state, P.LT)) {
        const t = tryParseTypeParams(state);
        if (t !== null) typeParams = t;
    }
    const params = parseParams(state);
    let returnType: Ref = null;
    if (state.tsMode && isP(state, P.COLON)) returnType = parseTypeAnn(state);
    let body: Ref = null;
    if (isP(state, P.LBRACE)) body = parseFunctionBody(state, (flags & FL.ASYNC) !== 0);
    else consumeSemi(state);
    return create.FunctionExpression(start, state.tokStart, flags, null, typeParams, params, returnType, body) as Node;
}

function arrowAheadFromParen(state: ParserState): boolean {
    const src = state.src,
        srcLen = state.srcLen;
    let p = state.tokStart + 1;
    let depth = 1;
    while (p < srcLen && depth > 0) {
        const c = src.charCodeAt(p);
        if (c === 40 || c === 91 || c === 123) (depth += c === 40 ? 1 : 0), (depth += c === 91 || c === 123 ? 1 : 0);
        else if (c === 41 || c === 93 || c === 125) depth--;
        else if (c === 34 || c === 39 || c === 96) {
            const q = c;
            p++;
            while (p < srcLen) {
                const cc = src.charCodeAt(p);
                if (cc === 92) {
                    p += 2;
                    continue;
                }
                if (cc === q) break;
                p++;
            }
        } else if (c === 47) {
            const c1 = src.charCodeAt(p + 1);
            if (c1 === 47) {
                while (p < srcLen && src.charCodeAt(p) !== 10) p++;
                continue;
            }
            if (c1 === 42) {
                p += 2;
                while (p < srcLen && !(src.charCodeAt(p) === 42 && src.charCodeAt(p + 1) === 47)) p++;
                p += 2;
                continue;
            }
        }
        p++;
    }
    for (;;) {
        while (p < srcLen) {
            const c = src.charCodeAt(p);
            if (c < 128 && (CHAR[c] === C_WS || CHAR[c] === C_NL)) p++;
            else break;
        }
        if (src.charCodeAt(p) === 47 && src.charCodeAt(p + 1) === 47) {
            while (p < srcLen && src.charCodeAt(p) !== 10) p++;
            continue;
        }
        if (src.charCodeAt(p) === 47 && src.charCodeAt(p + 1) === 42) {
            p += 2;
            while (p < srcLen && !(src.charCodeAt(p) === 42 && src.charCodeAt(p + 1) === 47)) p++;
            p += 2;
            continue;
        }
        break;
    }
    if (src.charCodeAt(p) === 61 && src.charCodeAt(p + 1) === 62) return true;
    if (state.tsMode && src.charCodeAt(p) === 58) {
        const s = saveState(state);
        const ok = trySpeculativeArrow(state);
        restoreState(state, s);
        return ok;
    }
    return false;
}

/** Peek whether the just-lexed single identifier is an arrow parameter, i.e. `ident =>`,
 * by scanning source from the identifier's end — no speculation, no throwaway node. A line
 * terminator before `=>` disqualifies it (the no-LineTerminator rule), matching the old
 * post-parseIdent `tokFlags & F_NL === 0` check. */
function identArrowAhead(state: ParserState): boolean {
    const src = state.src,
        srcLen = state.srcLen;
    let p = state.pos;
    for (;;) {
        while (p < srcLen) {
            const c = src.charCodeAt(p);
            if (c === 32 || c === 9 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff) {
                p++;
                continue;
            }
            break;
        }
        if (p >= srcLen) return false;
        const c = src.charCodeAt(p);
        if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) return false; // newline → not an arrow
        if (c === 47 && src.charCodeAt(p + 1) === 47) return false; // line comment ends in a newline
        if (c === 47 && src.charCodeAt(p + 1) === 42) {
            p += 2;
            while (p < srcLen && !(src.charCodeAt(p) === 42 && src.charCodeAt(p + 1) === 47)) {
                const cc = src.charCodeAt(p);
                if (cc === 10 || cc === 13 || cc === 0x2028 || cc === 0x2029) return false;
                p++;
            }
            p += 2;
            continue;
        }
        break;
    }
    return src.charCodeAt(p) === 61 && src.charCodeAt(p + 1) === 62;
}

function trySpeculativeArrow(state: ParserState): boolean {
    try {
        state.speculating++;
        parseParams(state);
        if (isP(state, P.COLON)) parseTypeAnn(state);
        const ok = isP(state, P.ARROW);
        state.speculating--;
        return ok;
    } catch {
        state.speculating--;
        return false;
    }
}

function parseArrow(state: ParserState, start: number, flags: number, typeParams: Ref): Node {
    const params = parseParams(state);
    let returnType: Ref = null;
    if (state.tsMode && isP(state, P.COLON)) returnType = parseTypeAnn(state);
    expectP(state, P.ARROW, "'=>'");
    const isAsync = (flags & FL.ASYNC) !== 0;
    let exprBody = false;
    const body: Node = inFunctionScope(
        state,
        isAsync,
        () => {
            if (isP(state, P.LBRACE)) return parseBlock(state);
            exprBody = true;
            return parseAssign(state);
        },
        true,
    );
    if (exprBody) flags |= FL.EXPR_BODY;
    return create.ArrowFunctionExpression(start, body.end, flags, typeParams, params, returnType, body) as Node;
}

function parseArrowAfterSingleParam(state: ParserState, start: number, id: Identifier, flags: number, identStart?: number): Node {
    const param = create.FormalParameter(identStart ?? start, id.end, 0, id, null, null) as Node;
    expectP(state, P.ARROW, "'=>'");
    const isAsync = (flags & FL.ASYNC) !== 0;
    let exprBody = false;
    const body: Node = inFunctionScope(
        state,
        isAsync,
        () => {
            if (isP(state, P.LBRACE)) return parseBlock(state);
            exprBody = true;
            return parseAssign(state);
        },
        true,
    );
    if (exprBody) flags |= FL.EXPR_BODY;
    return create.ArrowFunctionExpression(start, body.end, flags, null, [param], null, body) as Node;
}

function parseBindingTarget(state: ParserState): Node {
    if (isP(state, P.LBRACKET)) {
        const start = state.tokStart;
        nextToken(state);
        const from = state.sp;
        while (!isP(state, P.RBRACKET) && (state.tok as number) !== T_EOF) {
            const mark = state.tokStart;
            if (isP(state, P.COMMA)) {
                push(state, null);
                nextToken(state);
                continue;
            }
            if (isP(state, P.DOTDOTDOT)) {
                const s = state.tokStart;
                nextToken(state);
                const arg = parseBindingTarget(state);
                push(state, create.RestElement(s, arg.end, 0, arg, null) as Node);
            } else push(state, parseBindingElement(state));
            if (!isP(state, P.RBRACKET)) expectP(state, P.COMMA, "','");
            if (noProgress(state, mark)) break;
        }
        expectP(state, P.RBRACKET, "']'");
        return create.ArrayPattern(start, state.tokStart, 0, finishListWithHoles(state, from)) as Node;
    }
    if (isP(state, P.LBRACE)) {
        const start = state.tokStart;
        nextToken(state);
        const from = state.sp;
        while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
            const mark = state.tokStart;
            if (isP(state, P.DOTDOTDOT)) {
                const s = state.tokStart;
                nextToken(state);
                const arg = parseBindingTarget(state);
                push(state, create.RestElement(s, arg.end, 0, arg, null) as Node);
            } else {
                const s = state.tokStart;
                let flags = 0;
                let key: Node;
                if (isP(state, P.LBRACKET)) {
                    flags |= FL.COMPUTED;
                    nextToken(state);
                    key = parseAssign(state);
                    expectP(state, P.RBRACKET, "']'");
                } else if ((state.tok as number) === T_STR) {
                    key = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
                    nextToken(state);
                } else if (state.tok === T_NUM) {
                    key = leaf(state, N.NumericLiteral, state.tokStart, state.tokEnd);
                    nextToken(state);
                } else key = parseNameAsIdent(state, R_NAME);
                let value: Node;
                if (isP(state, P.COLON)) {
                    nextToken(state);
                    value = parseBindingElement(state);
                } else if (isP(state, P.EQ)) {
                    nextToken(state);
                    const right = parseAssign(state);
                    value = create.AssignmentPattern(
                        key.start,
                        right.end,
                        0,
                        ident(state, R_BIND, key.start, key.end),
                        right,
                    ) as Node;
                    flags |= FL.SHORTHAND;
                } else {
                    value = ident(state, R_BIND, key.start, key.end);
                    flags |= FL.SHORTHAND;
                }
                push(state, create.ObjectProperty(s, value.end, flags, key, value) as Node);
            }
            if (!isP(state, P.RBRACE)) expectP(state, P.COMMA, "','");
            if (noProgress(state, mark)) break;
        }
        expectP(state, P.RBRACE, "'}'");
        return create.ObjectPattern(start, state.tokStart, 0, finishList(state, from)) as Node;
    }
    return parseIdent(state, R_BIND);
}

function parseBindingElement(state: ParserState): Node {
    const target = parseBindingTarget(state);
    if (isP(state, P.EQ)) {
        nextToken(state);
        const right = parseAssign(state);
        return create.AssignmentPattern(target.start, right.end, 0, target, right) as Node;
    }
    return target;
}

function parseParams(state: ParserState): Node[] {
    const src = state.src;
    expectP(state, P.LPAREN, "'('");
    const from = state.sp;
    while (!isP(state, P.RPAREN) && (state.tok as number) !== T_EOF) {
        const start = state.tokStart;
        let flags = 0;
        if (state.tsMode) {
            for (;;) {
                if ((isK(state, K.READONLY) || isK(state, K.OVERRIDE)) && !nextIsParamNameEnd(state)) {
                    flags |= FL.READONLY;
                    nextToken(state);
                } else if (isK(state, K.STATIC) && !nextIsParamNameEnd(state)) nextToken(state);
                else if (
                    isKeyword(state.tok) &&
                    (state.tok === K.IMPLEMENTS || state.tok === K.INTERFACE) &&
                    !nextIsParamNameEnd(state)
                )
                    nextToken(state);
                else if (
                    state.tok === T_IDENT &&
                    (src.startsWith('public', state.tokStart) ||
                        src.startsWith('private', state.tokStart) ||
                        src.startsWith('protected', state.tokStart)) &&
                    state.tokEnd - state.tokStart <= 9 &&
                    !nextIsParamNameEnd(state)
                ) {
                    const access = src.startsWith('public', state.tokStart)
                        ? 1
                        : src.startsWith('private', state.tokStart)
                          ? 2
                          : 3;
                    flags |= access << FL.ACCESS_SHIFT;
                    nextToken(state);
                } else break;
            }
        }
        if (isP(state, P.DOTDOTDOT)) {
            nextToken(state);
            const arg = parseBindingTarget(state);
            let typeAnn: Ref = null;
            if (state.tsMode && isP(state, P.COLON)) typeAnn = parseTypeAnn(state);
            push(state, create.RestElement(start, state.tokStart, 0, arg, typeAnn) as Node);
        } else if (isK(state, K.THIS) && state.tsMode) {
            const t = ident(state, R_BIND, state.tokStart, state.tokEnd);
            nextToken(state);
            let typeAnn: Ref = null;
            if (isP(state, P.COLON)) typeAnn = parseTypeAnn(state);
            push(state, create.FormalParameter(start, state.tokStart, 0, t, typeAnn, null) as Node);
        } else {
            const pattern = parseBindingTarget(state);
            if (state.tsMode && isP(state, P.QUESTION)) {
                flags |= FL.OPTIONAL;
                nextToken(state);
            }
            let typeAnn: Ref = null;
            if (state.tsMode && isP(state, P.COLON)) typeAnn = parseTypeAnn(state);
            let init: Ref = null;
            if (isP(state, P.EQ)) {
                nextToken(state);
                init = parseAssign(state);
            }
            push(state, create.FormalParameter(start, state.tokStart, flags, pattern, typeAnn, init) as Node);
        }
        if (!eatP(state, P.COMMA)) break;
    }
    expectP(state, P.RPAREN, "')'");
    return finishList(state, from);
}

function nextIsParamNameEnd(state: ParserState): boolean {
    const s = saveState(state);
    nextToken(state);
    const end =
        state.tok === T_EOF ||
        (isPunct(state.tok) &&
            (state.tok === P.COLON ||
                state.tok === P.COMMA ||
                state.tok === P.RPAREN ||
                state.tok === P.QUESTION ||
                state.tok === P.EQ));
    restoreState(state, s);
    return end;
}

function parseFunction(state: ParserState, async: boolean, isDecl: boolean, isExpr: boolean): Node {
    const start = state.tokStart;
    nextToken(state);
    let flags = async ? FL.ASYNC : 0;
    if (isP(state, P.STAR)) {
        flags |= FL.GENERATOR;
        nextToken(state);
    }
    let id: Ref = null;
    if (isIdentLike(state)) id = parseIdent(state, R_BIND);
    let typeParams: Ref = null;
    if (state.tsMode && isP(state, P.LT)) {
        const t = tryParseTypeParams(state);
        if (t !== null) typeParams = t;
    }
    const params = parseParams(state);
    let returnType: Ref = null;
    if (state.tsMode && isP(state, P.COLON)) returnType = parseTypeAnn(state);
    let body: Ref = null;
    if (isP(state, P.LBRACE)) body = parseFunctionBody(state, (flags & FL.ASYNC) !== 0);
    else consumeSemi(state);
    return isDecl && !isExpr
        ? (create.FunctionDeclaration(start, state.tokStart, flags, id, typeParams, params, returnType, body) as Node)
        : (create.FunctionExpression(start, state.tokStart, flags, id, typeParams, params, returnType, body) as Node);
}

function parseClass(state: ParserState, isExpr: boolean, extraFlags: number, startOverride = -1): Node {
    const start = startOverride >= 0 ? startOverride : state.tokStart;
    nextToken(state);
    let id: Ref = null;
    if (isIdentLike(state) && !isK(state, K.EXTENDS) && !isK(state, K.IMPLEMENTS)) id = parseIdent(state, R_BIND);
    let typeParams: Ref = null;
    if (state.tsMode && isP(state, P.LT)) {
        const t = tryParseTypeParams(state);
        if (t !== null) typeParams = t;
    }
    let superClass: Ref = null;
    let superTypeArgs: Ref = null;
    if (eatK(state, K.EXTENDS)) {
        superClass = parseMemberChain(state, parsePrimary(state), true);
        if (state.tsMode && isP(state, P.LT)) {
            const t = tryParseTypeArgsInType(state);
            if (t !== null) superTypeArgs = t;
        }
    }
    const implFrom = state.sp;
    if (state.tsMode && eatK(state, K.IMPLEMENTS)) {
        do {
            const s = state.tokStart;
            let expr: Node = parseIdent(state, R_REF);
            while (isP(state, P.DOT)) {
                nextToken(state);
                const r = parseNameAsIdent(state, R_NAME);
                expr = create.TSQualifiedName(s, r.end, 0, expr, r) as Node;
            }
            let targs: Ref = null;
            if (isP(state, P.LT)) {
                const t = tryParseTypeArgsInType(state);
                if (t !== null) targs = t;
            }
            push(state, create.TSClassImplements(s, state.tokStart, 0, expr, targs) as Node);
        } while (eatP(state, P.COMMA));
    }
    const impls = finishList(state, implFrom);
    state.thisDepth++;
    const body = parseClassBody(state);
    state.thisDepth--;
    return isExpr
        ? (create.ClassExpression(
              start,
              state.tokStart,
              extraFlags,
              id,
              typeParams,
              superClass,
              superTypeArgs,
              impls,
              body,
          ) as Node)
        : (create.ClassDeclaration(
              start,
              state.tokStart,
              extraFlags,
              id,
              typeParams,
              superClass,
              superTypeArgs,
              impls,
              body,
          ) as Node);
}

function parseClassBody(state: ParserState): Node[] {
    expectP(state, P.LBRACE, "'{'");
    const from = state.sp;
    let last = -1;
    while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
        if (eatP(state, P.SEMI)) continue;
        if (state.tokStart === last) {
            raise(state, ParseErrorCode.UnexpectedInClassBody, tokenDesc(state));
            nextToken(state);
            continue;
        }
        last = state.tokStart;
        push(state, parseClassMember(state));
    }
    expectP(state, P.RBRACE, "'}'");
    return finishList(state, from);
}

function parseClassMember(state: ParserState): Node {
    const src = state.src;
    const start = state.tokStart;
    let flags = 0;
    let async = false;
    let generator = false;
    for (;;) {
        if (isK(state, K.STATIC) && !nextIsPropertyEnd(state)) {
            const s = saveState(state);
            nextToken(state);
            if (isP(state, P.LBRACE)) {
                // A class static block enables `new.target` but NOT `return` — hence bumping only
                // the new.target depth (oxc `js/function.rs:285`, `js/statement.rs:710-713`).
                state.newTargetDepth++;
                const outerAwait = state.awaitOk; // a static block is not an async context
                state.awaitOk = false;
                const b = parseBlock(state);
                state.awaitOk = outerAwait;
                state.newTargetDepth--;
                const body = (b as Extract<Node, { type: typeof N.BlockStatement }>).data.body;
                return create.StaticBlock(start, state.tokStart, 0, body) as Node;
            }
            restoreState(state, s);
            flags |= FL.STATIC;
            nextToken(state);
        } else if (state.tok === T_IDENT && !nextIsPropertyEnd(state) && isAccessModifier(state)) {
            const access = src.startsWith('public', state.tokStart) ? 1 : src.startsWith('private', state.tokStart) ? 2 : 3;
            flags |= access << FL.ACCESS_SHIFT;
            nextToken(state);
        } else if (isK(state, K.READONLY) && !nextIsPropertyEnd(state)) {
            flags |= FL.READONLY;
            nextToken(state);
        } else if (isK(state, K.ABSTRACT) && !nextIsPropertyEnd(state)) {
            flags |= FL.ABSTRACT;
            nextToken(state);
        } else if (isK(state, K.DECLARE) && !nextIsPropertyEnd(state)) {
            flags |= FL.DECLARE;
            nextToken(state);
        } else if (isK(state, K.OVERRIDE) && !nextIsPropertyEnd(state)) nextToken(state);
        else if (isK(state, K.ACCESSOR) && !nextIsPropertyEnd(state)) nextToken(state);
        else break;
    }
    if (isK(state, K.ASYNC) && !nextIsPropertyEnd(state)) {
        async = true;
        nextToken(state);
    }
    if (isP(state, P.STAR)) {
        generator = true;
        nextToken(state);
    }
    let kind = 0;
    if ((isK(state, K.GET) || isK(state, K.SET)) && !nextIsPropertyEnd(state)) {
        kind = isK(state, K.GET) ? 1 : 2;
        nextToken(state);
    }
    let key: Node;
    if (isP(state, P.LBRACKET)) {
        nextToken(state);
        if (state.tsMode && isIdentLike(state)) {
            const s = saveState(state);
            const name = parseIdent(state, R_BIND);
            if (isP(state, P.COLON)) {
                const keyAnn = parseTypeAnn(state);
                const param = create.FormalParameter(name.start, state.tokStart, 0, name, keyAnn, null) as Node;
                expectP(state, P.RBRACKET, "']'");
                let ann: Ref = null;
                if (isP(state, P.COLON)) ann = parseTypeAnn(state);
                consumeSemi(state);
                return create.TSIndexSignature(start, state.tokStart, flags & FL.READONLY, param, ann) as Node;
            }
            restoreState(state, s);
        }
        flags |= FL.COMPUTED;
        key = parseAssign(state);
        expectP(state, P.RBRACKET, "']'");
    } else if ((state.tok as number) === T_STR) {
        key = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    } else if (state.tok === T_NUM) {
        key = leaf(state, N.NumericLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    } else if (state.tok === T_PRIVATE) key = parsePrivate(state);
    else key = parseNameAsIdent(state, R_NAME);

    if (kind === 0 && key.type === N.IdentifierName && src.startsWith('constructor', key.start) && key.end - key.start === 11)
        kind = 3;

    if (state.tsMode && isP(state, P.QUESTION)) {
        flags |= FL.OPTIONAL;
        nextToken(state);
    }

    if (kind !== 0 || async || generator || isP(state, P.LPAREN) || (state.tsMode && isP(state, P.LT))) {
        const fn = parseMethodTail(state, start, (async ? FL.ASYNC : 0) | (generator ? FL.GENERATOR : 0));
        return create.MethodDefinition(start, state.tokStart, flags | (kind << FL.KIND_SHIFT), key, fn) as Node;
    }
    if (state.tsMode && isP(state, P.BANG)) {
        flags |= FL.DEFINITE;
        nextToken(state);
    }
    let typeAnn: Ref = null;
    if (state.tsMode && isP(state, P.COLON)) typeAnn = parseTypeAnn(state);
    let value: Ref = null;
    if (isP(state, P.EQ)) {
        nextToken(state);
        value = parseAssign(state);
    }
    consumeSemi(state);
    return create.PropertyDefinition(start, state.tokStart, flags, key, typeAnn, value) as Node;
}

function isAccessModifier(state: ParserState): boolean {
    const src = state.src;
    const len = state.tokEnd - state.tokStart;
    return (
        (len === 6 && src.startsWith('public', state.tokStart)) ||
        (len === 7 && src.startsWith('private', state.tokStart)) ||
        (len === 9 && src.startsWith('protected', state.tokStart))
    );
}

/** Enter a function's scope for the duration of `parse`, whatever body FORM it has. An arrow with an
 *  EXPRESSION body (`async x => await y`) is still a function boundary: it scopes `await` and
 *  `new.target` exactly like a block body does. Handling only the block form silently let an
 *  expression-bodied async arrow inherit the enclosing scope's `await`, and wrongly rejected
 *  `() => new.target`. */
function inFunctionScope<T>(state: ParserState, isAsync: boolean, parse: () => T, arrow = false): T {
    state.fnDepth++;
    state.newTargetDepth++;
    // An arrow does NOT rebind `this`, so it must not hide the module's own.
    if (!arrow) state.thisDepth++;
    const outerAwait = state.awaitOk;
    state.awaitOk = isAsync; // REPLACED, not unioned — a non-async function inherits no `await`
    const out = parse();
    state.awaitOk = outerAwait;
    if (!arrow) state.thisDepth--;
    state.fnDepth--;
    state.newTargetDepth--;
    return out;
}

/** A FUNCTION body — tracked separately from {@link parseBlock} so top-level-only checks can fire.
 *  A plain `{ }` block at the top level is still top level; a function body is not. */
function parseFunctionBody(state: ParserState, isAsync: boolean): Node {
    return inFunctionScope(state, isAsync, () => parseBlock(state));
}

function parseBlock(state: ParserState): Node {
    const start = state.tokStart;
    expectP(state, P.LBRACE, "'{'");
    const from = state.sp;
    while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
        const mark = state.tokStart;
        push(state, parseStatement(state));
        if (noProgress(state, mark)) break;
    }
    expectP(state, P.RBRACE, "'}'");
    return create.BlockStatement(start, state.tokStart, 0, finishList(state, from)) as Node;
}

function parseStatement(state: ParserState): Node {
    const start = state.tokStart;
    if (isPunct(state.tok)) {
        switch (state.tok as number) {
            case P.LBRACE:
                return parseBlock(state);
            case P.SEMI:
                nextToken(state);
                return create.EmptyStatement(start, state.tokStart, 0) as Node;
            case P.AT:
                raise(state, ParseErrorCode.DecoratorsUnsupported);
                nextToken(state);
                return parseStatement(state);
        }
    }
    // `using r = res()` — explicit resource management. `using` is NOT a reserved word, so it is an
    // ordinary identifier token and cannot join the keyword switch below.
    //
    // Contextual, and more narrowly than `let`: the spec allows only a BindingIdentifier (no
    // destructuring) and forbids a LineTerminator after the keyword. Verified against `oxc-parser`,
    // which parses `using [a] = r()` as a MEMBER assignment, `using = 1` as an assignment and
    // `using\n a = r()` as two statements — each of those has to stay an expression here. Both
    // oracles PARSE AND BUNDLE `using`, emitting it verbatim, so there is nothing to lower.
    if (state.tok === T_IDENT && state.tokEnd - state.tokStart === 5 && state.src.startsWith('using', state.tokStart)) {
        const save = saveState(state);
        nextToken(state);
        const isDecl = isIdentLike(state) && (state.tokFlags & F_NL) === 0;
        restoreState(state, save);
        if (isDecl) return parseVarDecl(state, VAR_KIND.USING, 0);
    }
    if (isKeyword(state.tok)) {
        switch (state.tok as number) {
            case K.VAR:
                return parseVarDecl(state, VAR_KIND.VAR, 0);
            case K.CONST: {
                // `const enum` is TS-only and rare; every other `const` is a var decl. Peek one
                // token with an allocation-free scalar rewind instead of a throwaway saveState
                // array (this fires on every `const`). Plain JS skips the peek entirely.
                if (state.tsMode) {
                    const p = state.pos,
                        tk = state.tok,
                        ts0 = state.tokStart,
                        te = state.tokEnd,
                        tf = state.tokFlags,
                        th = state.tokHash;
                    nextToken(state);
                    if (isK(state, K.ENUM)) return parseEnum(state, start, FL.CONST_ENUM);
                    state.pos = p;
                    state.tok = tk;
                    state.tokStart = ts0;
                    state.tokEnd = te;
                    state.tokFlags = tf;
                    state.tokHash = th;
                }
                return parseVarDecl(state, VAR_KIND.CONST, 0);
            }
            case K.LET: {
                // `let` may be a declaration (`let x` / `let {…}` / `let […]`) or an identifier in
                // expression position. One-token peek with allocation-free scalar rewind (no array).
                const p = state.pos,
                    tk = state.tok,
                    ts0 = state.tokStart,
                    te = state.tokEnd,
                    tf = state.tokFlags,
                    th = state.tokHash;
                nextToken(state);
                const isDecl = isIdentLike(state) || isP(state, P.LBRACE) || isP(state, P.LBRACKET);
                state.pos = p;
                state.tok = tk;
                state.tokStart = ts0;
                state.tokEnd = te;
                state.tokFlags = tf;
                state.tokHash = th;
                if (isDecl) return parseVarDecl(state, VAR_KIND.LET, 0);
                break;
            }
            case K.FUNCTION:
                return parseFunction(state, false, true, false);
            case K.ASYNC: {
                // `async function` is a declaration; a bare `async` is an identifier expression.
                // Peek for `function` (same line) with a scalar rewind instead of a saveState array.
                const p = state.pos,
                    tk = state.tok,
                    ts0 = state.tokStart,
                    te = state.tokEnd,
                    tf = state.tokFlags,
                    th = state.tokHash;
                nextToken(state);
                if (isK(state, K.FUNCTION) && (state.tokFlags & F_NL) === 0) return parseFunction(state, true, true, false);
                state.pos = p;
                state.tok = tk;
                state.tokStart = ts0;
                state.tokEnd = te;
                state.tokFlags = tf;
                state.tokHash = th;
                break;
            }
            case K.CLASS:
                return parseClass(state, false, 0);
            case K.IF: {
                nextToken(state);
                expectP(state, P.LPAREN, "'('");
                const test = parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                const cons = parseStatement(state);
                let alt: Ref = null;
                if (eatK(state, K.ELSE)) alt = parseStatement(state);
                return create.IfStatement(start, state.tokStart, 0, test, cons, alt) as Node;
            }
            case K.FOR:
                return parseFor(state, start);
            // `with` is legal in sloppy CommonJS but CANNOT work in shakeup's output: an ES module is
            // always strict, and a `with` body is a SyntaxError there. A documented non-goal
            // (cjs.md §7.18) — and the RIGHT outcome, verified: esbuild refuses it with the same
            // reasoning, while rolldown builds it and emits a bundle that dies at load with
            // `Strict mode code may not include a with statement`. Only the message was wrong; it
            // used to surface as a bare `unexpected token 'with' in expression`.
            case K.WITH:
                raise(state, ParseErrorCode.WithStatement);
                return create.EmptyStatement(start, state.tokStart, 0) as Node;
            case K.WHILE: {
                nextToken(state);
                expectP(state, P.LPAREN, "'('");
                const test = parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                const body = parseStatement(state);
                return create.WhileStatement(start, body.end, 0, test, body) as Node;
            }
            case K.DO: {
                nextToken(state);
                const body = parseStatement(state);
                if (!eatK(state, K.WHILE)) raise(state, ParseErrorCode.Expected, "'while'");
                expectP(state, P.LPAREN, "'('");
                const test = parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                eatP(state, P.SEMI);
                return create.DoWhileStatement(start, state.tokStart, 0, body, test) as Node;
            }
            case K.SWITCH: {
                nextToken(state);
                expectP(state, P.LPAREN, "'('");
                const disc = parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                expectP(state, P.LBRACE, "'{'");
                const from = state.sp;
                while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
                    const mark = state.tokStart;
                    const cs = state.tokStart;
                    let test: Ref = null;
                    if (eatK(state, K.CASE)) {
                        test = parseExpression(state);
                    } else if (!eatK(state, K.DEFAULT)) {
                        raise(state, ParseErrorCode.Expected, "'case'");
                        nextToken(state);
                        continue;
                    }
                    expectP(state, P.COLON, "':'");
                    const bodyFrom = state.sp;
                    while (
                        !isP(state, P.RBRACE) &&
                        !isK(state, K.CASE) &&
                        !isK(state, K.DEFAULT) &&
                        (state.tok as number) !== T_EOF
                    )
                        push(state, parseStatement(state));
                    const body = finishList(state, bodyFrom);
                    push(state, create.SwitchCase(cs, state.tokStart, 0, test, body) as Node);
                    if (noProgress(state, mark)) break;
                }
                expectP(state, P.RBRACE, "'}'");
                return create.SwitchStatement(start, state.tokStart, 0, disc, finishList(state, from)) as Node;
            }
            case K.TRY: {
                nextToken(state);
                const block = parseBlock(state);
                let handler: Ref = null;
                let finalizer: Ref = null;
                if (isK(state, K.CATCH)) {
                    const cs = state.tokStart;
                    nextToken(state);
                    let param: Ref = null;
                    if (eatP(state, P.LPAREN)) {
                        param = parseBindingTarget(state);
                        if (state.tsMode && isP(state, P.COLON)) parseTypeAnn(state);
                        expectP(state, P.RPAREN, "')'");
                    }
                    const cbody = parseBlock(state);
                    handler = create.CatchClause(cs, state.tokStart, 0, param, cbody) as Node;
                }
                if (eatK(state, K.FINALLY)) finalizer = parseBlock(state);
                return create.TryStatement(start, state.tokStart, 0, block, handler, finalizer) as Node;
            }
            case K.RETURN: {
                nextToken(state);
                let arg: Ref = null;
                if (!canInsertSemi(state) && !isP(state, P.SEMI)) arg = parseExpression(state);
                consumeSemi(state);
                if (state.fnDepth === 0) {
                    state.sawTopLevelReturn = true;
                    if (!state.allowTopReturn) raise(state, ParseErrorCode.TopLevelReturn);
                }
                return create.ReturnStatement(start, state.tokStart, 0, arg) as Node;
            }
            case K.THROW: {
                nextToken(state);
                const arg = parseExpression(state);
                consumeSemi(state);
                return create.ThrowStatement(start, state.tokStart, 0, arg) as Node;
            }
            case K.BREAK:
            case K.CONTINUE: {
                const isBreak = state.tok === K.BREAK;
                nextToken(state);
                let label: Ref = null;
                if (isIdentLike(state) && (state.tokFlags & F_NL) === 0) label = parseIdent(state, R_LABEL);
                consumeSemi(state);
                return isBreak
                    ? (create.BreakStatement(start, state.tokStart, 0, label) as Node)
                    : (create.ContinueStatement(start, state.tokStart, 0, label) as Node);
            }
            case K.DEBUGGER:
                nextToken(state);
                consumeSemi(state);
                return create.DebuggerStatement(start, state.tokStart, 0) as Node;
            case K.IMPORT: {
                const s = saveState(state);
                nextToken(state);
                if (isP(state, P.LPAREN) || isP(state, P.DOT)) {
                    restoreState(state, s);
                    break;
                }
                restoreState(state, s);
                return parseImport(state);
            }
            case K.EXPORT:
                return parseExport(state);
            case K.INTERFACE:
                if (state.tsMode) return parseInterface(state, start, 0);
                break;
            case K.TYPE:
                if (state.tsMode) {
                    const s = saveState(state);
                    nextToken(state);
                    if (isIdentLike(state) && (state.tokFlags & F_NL) === 0) {
                        restoreState(state, s);
                        return parseTypeAlias(state, start, 0);
                    }
                    restoreState(state, s);
                }
                break;
            case K.ENUM:
                if (state.tsMode) return parseEnum(state, start, 0);
                break;
            case K.DECLARE:
                if (state.tsMode) {
                    const s = saveState(state);
                    nextToken(state);
                    if (
                        isKeyword(state.tok) &&
                        (state.tok === K.CONST ||
                            state.tok === K.LET ||
                            state.tok === K.VAR ||
                            state.tok === K.FUNCTION ||
                            state.tok === K.CLASS ||
                            state.tok === K.INTERFACE ||
                            state.tok === K.TYPE ||
                            state.tok === K.ENUM ||
                            state.tok === K.NAMESPACE ||
                            state.tok === K.MODULE ||
                            state.tok === K.ABSTRACT ||
                            state.tok === K.ASYNC)
                    ) {
                        const inner = parseStatement(state);
                        applyDeclare(inner, start);
                        return inner;
                    }
                    // `declare global { ... }` — ambient global augmentation; `global` is a
                    // contextual identifier here. Model it as a declare TSModuleDeclaration so
                    // emit erases the whole block (isErasableStatement).
                    if ((state.tok as number) === T_IDENT && state.src.slice(state.tokStart, state.tokEnd) === 'global') {
                        const gid = parseIdent(state, R_BIND);
                        if (isP(state, P.LBRACE)) {
                            nextToken(state);
                            const from = state.sp;
                            while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
                                const mark = state.tokStart;
                                push(state, parseStatement(state));
                                if (noProgress(state, mark)) break;
                            }
                            expectP(state, P.RBRACE, "'}'");
                            const mod = create.TSModuleDeclaration(
                                start,
                                state.tokStart,
                                0,
                                gid,
                                finishList(state, from),
                            ) as Node;
                            applyDeclare(mod, start);
                            return mod;
                        }
                    }
                    restoreState(state, s);
                }
                break;
            case K.ABSTRACT:
                if (state.tsMode) {
                    const s = saveState(state);
                    const abstractStart = state.tokStart;
                    nextToken(state);
                    if (isK(state, K.CLASS)) return parseClass(state, false, FL.ABSTRACT, abstractStart);
                    restoreState(state, s);
                }
                break;
            case K.NAMESPACE:
            case K.MODULE:
                if (state.tsMode) {
                    const s = saveState(state);
                    nextToken(state);
                    if (isIdentLike(state) || (state.tok as number) === T_STR) {
                        const id =
                            (state.tok as number) === T_STR
                                ? leaf(state, N.StringLiteral, state.tokStart, state.tokEnd)
                                : parseIdent(state, R_BIND);
                        if ((state.tok as number) === T_STR) nextToken(state);
                        if (isP(state, P.LBRACE)) {
                            nextToken(state);
                            const from = state.sp;
                            while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
                                const mark = state.tokStart;
                                push(state, parseStatement(state));
                                if (noProgress(state, mark)) break;
                            }
                            expectP(state, P.RBRACE, "'}'");
                            return create.TSModuleDeclaration(
                                start,
                                state.tokStart,
                                FL.NAMESPACE,
                                id,
                                finishList(state, from),
                            ) as Node;
                        }
                    }
                    restoreState(state, s);
                }
                break;
        }
    }
    const expr = parseExpression(state);
    if (expr.type === N.IdentifierReference && isP(state, P.COLON)) {
        nextToken(state);
        const body = parseStatement(state);
        const label = ident(state, R_LABEL, expr.start, expr.end);
        return create.LabeledStatement(start, body.end, 0, label, body) as Node;
    }
    consumeSemi(state);
    return create.ExpressionStatement(start, state.tokStart, 0, expr) as Node;
}

function parseVarDecl(state: ParserState, kind: number, extraFlags: number): Node {
    const start = state.tokStart;
    nextToken(state);
    const from = state.sp;
    do {
        const ds = state.tokStart;
        const target = parseBindingTarget(state);
        let flags = 0;
        if (state.tsMode && isP(state, P.BANG)) {
            flags |= FL.DEFINITE;
            nextToken(state);
        }
        let typeAnn: Ref = null;
        if (state.tsMode && isP(state, P.COLON)) typeAnn = parseTypeAnn(state);
        let init: Ref = null;
        if (isP(state, P.EQ)) {
            nextToken(state);
            init = parseAssign(state);
        }
        push(state, create.VariableDeclarator(ds, state.tokStart, flags, target, typeAnn, init) as Node);
    } while (eatP(state, P.COMMA));
    consumeSemi(state);
    return create.VariableDeclaration(start, state.tokStart, kind | extraFlags, finishList(state, from)) as Node;
}

function parseFor(state: ParserState, start: number): Node {
    nextToken(state);
    let flags = 0;
    if (eatK(state, K.AWAIT)) flags |= FL.AWAIT;
    expectP(state, P.LPAREN, "'('");
    let init: Ref = null;
    if (isP(state, P.SEMI)) nextToken(state);
    else {
        if (isKeyword(state.tok) && (state.tok === K.VAR || state.tok === K.LET || state.tok === K.CONST)) {
            const kind = state.tok === K.VAR ? VAR_KIND.VAR : state.tok === K.LET ? VAR_KIND.LET : VAR_KIND.CONST;
            const ds = state.tokStart;
            nextToken(state);
            const target = parseBindingTarget(state);
            if (isK(state, K.OF) || isK(state, K.IN)) {
                const isOf = isK(state, K.OF);
                nextToken(state);
                const dtor = create.VariableDeclarator(ds, state.tokStart, 0, target, null, null) as Node;
                const decl = create.VariableDeclaration(ds, state.tokStart, kind, [dtor]) as Node;
                const right = isOf ? parseAssign(state) : parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                const body = parseStatement(state);
                return isOf
                    ? (create.ForOfStatement(start, body.end, flags, decl, right, body) as Node)
                    : (create.ForInStatement(start, body.end, 0, decl, right, body) as Node);
            }
            const dFrom = state.sp;
            {
                let typeAnn: Ref = null;
                let dflags = 0;
                if (state.tsMode && isP(state, P.BANG)) {
                    dflags |= FL.DEFINITE;
                    nextToken(state);
                }
                if (state.tsMode && isP(state, P.COLON)) typeAnn = parseTypeAnn(state);
                let dinit: Ref = null;
                if (isP(state, P.EQ)) {
                    nextToken(state);
                    dinit = parseAssign(state, true);
                }
                push(state, create.VariableDeclarator(ds, state.tokStart, dflags, target, typeAnn, dinit) as Node);
            }
            while (eatP(state, P.COMMA)) {
                const ds2 = state.tokStart;
                const t2 = parseBindingTarget(state);
                let typeAnn: Ref = null;
                if (state.tsMode && isP(state, P.COLON)) typeAnn = parseTypeAnn(state);
                let dinit: Ref = null;
                if (isP(state, P.EQ)) {
                    nextToken(state);
                    dinit = parseAssign(state, true);
                }
                push(state, create.VariableDeclarator(ds2, state.tokStart, 0, t2, typeAnn, dinit) as Node);
            }
            init = create.VariableDeclaration(ds, state.tokStart, kind, finishList(state, dFrom)) as Node;
            expectP(state, P.SEMI, "';'");
        } else {
            init = parseExpression(state, true);
            if (isK(state, K.OF) || isK(state, K.IN)) {
                const isOf = state.tok === K.OF;
                nextToken(state);
                const right = isOf ? parseAssign(state) : parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                const body = parseStatement(state);
                return isOf
                    ? (create.ForOfStatement(start, body.end, flags, init, right, body) as Node)
                    : (create.ForInStatement(start, body.end, 0, init, right, body) as Node);
            }
            expectP(state, P.SEMI, "';'");
        }
    }
    let test: Ref = null;
    if (!isP(state, P.SEMI)) test = parseExpression(state);
    expectP(state, P.SEMI, "';'");
    let update: Ref = null;
    if (!isP(state, P.RPAREN)) update = parseExpression(state);
    expectP(state, P.RPAREN, "')'");
    const body = parseStatement(state);
    return create.ForStatement(start, body.end, 0, init, test, update, body) as Node;
}

function parseImport(state: ParserState): Node {
    const start = state.tokStart;
    nextToken(state);
    let flags = 0;
    if (state.tsMode && isK(state, K.TYPE)) {
        const s = saveState(state);
        nextToken(state);
        if (!isK(state, K.FROM) && !isP(state, P.EQ)) flags |= FL.TYPE_ONLY;
        else restoreState(state, s);
    }
    // Import PHASE: `import source w from './m.wasm'` / `import defer * as ns from './m.js'`.
    //
    // Both are CONTEXTUAL — `import source from './m'` is a default import of a binding NAMED
    // `source`, which oxc accepts with `phase: null`. The disambiguator is the token AFTER: a phase
    // keyword is never followed by `from`. Verified against `oxc-parser` for every form, including
    // the ones it REJECTS: `import source * as w`, `import defer d`, `import defer { a }`, and a
    // bare `import defer '…'` — `source` takes only a default binding, `defer` only a namespace.
    let phase: 'source' | 'defer' | null = null;
    if (state.tok === T_IDENT && !isK(state, K.FROM)) {
        const isSource = state.src.startsWith('source', state.tokStart) && state.tokEnd - state.tokStart === 6;
        const isDefer = state.src.startsWith('defer', state.tokStart) && state.tokEnd - state.tokStart === 5;
        if (isSource || isDefer) {
            const save = saveState(state);
            nextToken(state);
            if (isK(state, K.FROM) || isP(state, P.EQ)) restoreState(state, save);
            else phase = isSource ? 'source' : 'defer';
        }
    }
    const from = state.sp;
    if ((state.tok as number) === T_STR) {
        const source = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
        const attrs = parseImportAttributes(state);
        consumeSemi(state);
        state.sawEsmImport = true;
        return create.ImportDeclaration(start, state.tokStart, flags, finishList(state, from), source, attrs, phase) as Node;
    }
    if (isIdentLike(state)) {
        const local = parseIdent(state, R_BIND);
        // `import X = …` — TS import-equals, not an ESM default import.
        if (isP(state, P.EQ)) return finishImportEquals(state, start, flags, local);
        push(state, create.ImportDefaultSpecifier(local.start, local.end, 0, local) as Node);
        eatP(state, P.COMMA);
    }
    if (isP(state, P.STAR)) {
        const s = state.tokStart;
        nextToken(state);
        if (!eatK(state, K.AS)) raise(state, ParseErrorCode.Expected, "'as'");
        const local = parseIdent(state, R_BIND);
        push(state, create.ImportNamespaceSpecifier(s, local.end, 0, local) as Node);
    } else if (isP(state, P.LBRACE)) {
        nextToken(state);
        while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
            const mark = state.tokStart;
            const ss = state.tokStart;
            let specFlags = 0;
            if (state.tsMode && isK(state, K.TYPE)) {
                const st = saveState(state);
                nextToken(state);
                if (isNameLike(state) || (state.tok as number) === T_STR) specFlags |= FL.TYPE_ONLY;
                else restoreState(state, st);
            }
            const imported =
                (state.tok as number) === T_STR
                    ? leaf(state, N.StringLiteral, state.tokStart, state.tokEnd)
                    : parseNameAsIdent(state, R_NAME);
            if ((state.tok as number) === T_STR) nextToken(state);
            const local = eatK(state, K.AS) ? parseIdent(state, R_BIND) : ident(state, R_BIND, imported.start, imported.end);
            push(state, create.ImportSpecifier(ss, state.tokStart, specFlags, local, imported) as Node);
            if (!isP(state, P.RBRACE)) expectP(state, P.COMMA, "','");
            if (noProgress(state, mark)) break;
        }
        expectP(state, P.RBRACE, "'}'");
    }
    if (!eatK(state, K.FROM)) raise(state, ParseErrorCode.Expected, "'from'");
    let source: Ref = null;
    if ((state.tok as number) === T_STR) {
        source = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    } else raise(state, ParseErrorCode.ExpectedModuleSpecifier);
    const attrs = parseImportAttributes(state);
    consumeSemi(state);
    state.sawEsmImport = true;
    return create.ImportDeclaration(
        start,
        state.tokStart,
        flags,
        finishList(state, from),
        source ?? leaf(state, N.StringLiteral, state.tokStart, state.tokStart),
        attrs,
        phase,
    ) as Node;
}

/**
 * An import-attributes clause: `with { type: "json" }`, or the older `assert { … }` spelling that is
 * still widely shipped (36 of the failing rspack files use it). Returns null when there is none.
 *
 * Grammar checked against `oxc-parser`, which accepts all of: identifier keys AND string-literal
 * keys, several attributes, an EMPTY clause (`with { }`), a trailing comma, and a line break before
 * the keyword. It attaches to every module-specifier form — `import`, `import *`, bare `import`,
 * `export … from`, `export *`, `export * as ns`.
 *
 * `with` is a reserved word and `assert` is contextual, so they are recognised differently.
 */
function parseImportAttributes(state: ParserState): Node[] | null {
    const isWith = isK(state, K.WITH);
    // `assert` is not reserved, so guard on it being followed by `{` — otherwise `assert` could be
    // the start of the next statement entirely (`import 'x'\nassert(y)`).
    const isAssert =
        !isWith && state.tok === T_IDENT && state.src.startsWith('assert', state.tokStart) && state.tokEnd - state.tokStart === 6;
    if (!isWith && !isAssert) return null;
    if (isAssert) {
        const save = saveState(state);
        nextToken(state);
        if (!isP(state, P.LBRACE)) {
            restoreState(state, save);
            return null;
        }
    } else nextToken(state);
    expectP(state, P.LBRACE, "'{'");
    const from = state.sp;
    while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
        const mark = state.tokStart;
        const s = state.tokStart;
        const key =
            (state.tok as number) === T_STR
                ? leaf(state, N.StringLiteral, state.tokStart, state.tokEnd)
                : parseNameAsIdent(state, R_NAME);
        if ((state.tok as number) === T_STR) nextToken(state);
        expectP(state, P.COLON, "':'");
        const value = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
        if ((state.tok as number) === T_STR) nextToken(state);
        else raise(state, ParseErrorCode.Expected, 'a string');
        push(state, create.ImportAttribute(s, state.tokStart, 0, key, value) as Node);
        if (!isP(state, P.RBRACE)) expectP(state, P.COMMA, "','");
        if (noProgress(state, mark)) break;
    }
    expectP(state, P.RBRACE, "'}'");
    return finishList(state, from);
}

/** A value entity name (`A` / `A.B.C`) as an IdentifierReference head + chained TSQualifiedName —
 *  the import-equals module reference and the same shape as a type-position `typeName`. */
function parseEntityNameRef(state: ParserState): Node {
    const s = state.tokStart;
    let name: Node = parseNameAsIdent(state, R_REF) as Node;
    while (isP(state, P.DOT)) {
        nextToken(state);
        const r = parseNameAsIdent(state, R_NAME);
        name = create.TSQualifiedName(s, r.end, 0, name, r) as Node;
    }
    return name;
}

/** `import X = <module reference>` — TS import-equals. Called with the leading id already parsed and
 *  the current token at `=`. The reference is `require("m")` (external) or an entity name `A.B`. */
function finishImportEquals(state: ParserState, start: number, flags: number, id: Identifier): Node {
    nextToken(state); // consume '='
    let moduleRef: Node;
    if (isIdentLike(state) && state.src.slice(state.tokStart, state.tokEnd) === 'require') {
        const rs = state.tokStart;
        const save = saveState(state);
        nextToken(state);
        if (isP(state, P.LPAREN)) {
            nextToken(state);
            const expr =
                (state.tok as number) === T_STR
                    ? leaf(state, N.StringLiteral, state.tokStart, state.tokEnd)
                    : leaf(state, N.StringLiteral, state.tokStart, state.tokStart);
            if ((state.tok as number) === T_STR) nextToken(state);
            else raise(state, ParseErrorCode.ExpectedModuleSpecifier);
            expectP(state, P.RPAREN, "')'");
            moduleRef = create.TSExternalModuleReference(rs, state.tokStart, 0, expr) as Node;
        } else {
            restoreState(state, save);
            moduleRef = parseEntityNameRef(state);
        }
    } else {
        moduleRef = parseEntityNameRef(state);
    }
    consumeSemi(state);
    return create.TSImportEqualsDeclaration(start, state.tokStart, flags, id as Node, moduleRef) as Node;
}

function parseExport(state: ParserState): Node {
    const start = state.tokStart;
    nextToken(state);
    if (eatK(state, K.DEFAULT)) {
        let decl: Node;
        if (isK(state, K.FUNCTION)) decl = parseFunction(state, false, true, false);
        else if (isK(state, K.ASYNC)) {
            nextToken(state);
            decl = parseFunction(state, true, true, false);
        } else if (isK(state, K.CLASS)) decl = parseClass(state, false, 0);
        else {
            decl = parseAssign(state);
            consumeSemi(state);
        }
        state.sawEsmExport = true;
        return create.ExportDefaultDeclaration(start, state.tokStart, 0, decl) as Node;
    }
    if (isP(state, P.STAR)) {
        nextToken(state);
        let exported: Ref = null;
        if (eatK(state, K.AS)) exported = parseIdent(state, R_NAME);
        if (!eatK(state, K.FROM)) raise(state, ParseErrorCode.Expected, "'from'");
        let source: Ref = null;
        if ((state.tok as number) === T_STR) {
            source = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
            nextToken(state);
        }
        const attrs = parseImportAttributes(state);
        consumeSemi(state);
        state.sawEsmExport = true;
        return create.ExportAllDeclaration(
            start,
            state.tokStart,
            0,
            source ?? leaf(state, N.StringLiteral, state.tokStart, state.tokStart),
            exported,
            attrs,
        ) as Node;
    }
    let flags = 0;
    if (state.tsMode && isK(state, K.TYPE)) {
        const s = saveState(state);
        nextToken(state);
        if (isP(state, P.LBRACE)) flags |= FL.TYPE_ONLY;
        else restoreState(state, s);
    }
    if (isP(state, P.LBRACE)) {
        nextToken(state);
        const from = state.sp;
        while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
            const mark = state.tokStart;
            const ss = state.tokStart;
            let specFlags = 0;
            if (state.tsMode && isK(state, K.TYPE)) {
                const st = saveState(state);
                nextToken(state);
                if (isNameLike(state)) specFlags |= FL.TYPE_ONLY;
                else restoreState(state, st);
            }
            const local =
                (state.tok as number) === T_STR
                    ? leaf(state, N.StringLiteral, state.tokStart, state.tokEnd)
                    : parseNameAsIdent(state, R_REF);
            if ((state.tok as number) === T_STR) nextToken(state);
            const exported: Node = eatK(state, K.AS)
                ? (state.tok as number) === T_STR
                    ? leaf(state, N.StringLiteral, state.tokStart, state.tokEnd)
                    : parseNameAsIdent(state, R_NAME)
                : local.type === N.StringLiteral
                  ? local
                  : ident(state, R_NAME, local.start, local.end);
            if (exported.type === N.StringLiteral) nextToken(state);
            push(state, create.ExportSpecifier(ss, state.tokStart, specFlags, local, exported) as Node);
            if (!isP(state, P.RBRACE)) expectP(state, P.COMMA, "','");
            if (noProgress(state, mark)) break;
        }
        expectP(state, P.RBRACE, "'}'");
        let source: Ref = null;
        if (eatK(state, K.FROM)) {
            if ((state.tok as number) === T_STR) {
                source = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
                nextToken(state);
            }
        }
        const attrs = parseImportAttributes(state);
        consumeSemi(state);
        state.sawEsmExport = true;
        return create.ExportNamedDeclaration(start, state.tokStart, flags, null, finishList(state, from), source, attrs) as Node;
    }
    const decl = parseStatement(state);
    state.sawEsmExport = true;
    return create.ExportNamedDeclaration(start, state.tokStart, flags, decl, [], null) as Node;
}

function parseInterface(state: ParserState, start: number, extraFlags: number): Node {
    nextToken(state);
    const id = parseIdent(state, R_BIND);
    let typeParams: Ref = null;
    if (isP(state, P.LT)) {
        const t = tryParseTypeParams(state);
        if (t !== null) typeParams = t;
    }
    const extFrom = state.sp;
    if (eatK(state, K.EXTENDS)) {
        do {
            const s = state.tokStart;
            let expr: Node = parseIdent(state, R_REF);
            while (isP(state, P.DOT)) {
                nextToken(state);
                const r = parseNameAsIdent(state, R_NAME);
                expr = create.TSQualifiedName(s, r.end, 0, expr, r) as Node;
            }
            let targs: Ref = null;
            if (isP(state, P.LT)) {
                const t = tryParseTypeArgsInType(state);
                if (t !== null) targs = t;
            }
            push(state, create.TSInterfaceHeritage(s, state.tokStart, 0, expr, targs) as Node);
        } while (eatP(state, P.COMMA));
    }
    const ext = finishList(state, extFrom);
    const body = parseTypeMembers(state);
    return create.TSInterfaceDeclaration(start, state.tokStart, extraFlags, id, typeParams, ext, body) as Node;
}

function parseTypeAlias(state: ParserState, start: number, extraFlags: number): Node {
    nextToken(state);
    const id = parseIdent(state, R_BIND);
    let typeParams: Ref = null;
    if (isP(state, P.LT)) {
        const t = tryParseTypeParams(state);
        if (t !== null) typeParams = t;
    }
    expectP(state, P.EQ, "'='");
    const ty = parseType(state);
    consumeSemi(state);
    return create.TSTypeAliasDeclaration(start, state.tokStart, extraFlags, id, typeParams, ty) as Node;
}

function parseEnum(state: ParserState, start: number, extraFlags: number): Node {
    nextToken(state);
    const id = parseIdent(state, R_BIND);
    expectP(state, P.LBRACE, "'{'");
    const from = state.sp;
    while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
        const mark = state.tokStart;
        const ms = state.tokStart;
        let key: Node;
        if ((state.tok as number) === T_STR) {
            key = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
            nextToken(state);
        } else key = parseNameAsIdent(state, R_NAME);
        let init: Ref = null;
        if (isP(state, P.EQ)) {
            nextToken(state);
            init = parseAssign(state);
        }
        push(state, create.TSEnumMember(ms, state.tokStart, 0, key, init) as Node);
        if (!isP(state, P.RBRACE)) expectP(state, P.COMMA, "','");
        if (noProgress(state, mark)) break;
    }
    expectP(state, P.RBRACE, "'}'");
    return create.TSEnumDeclaration(start, state.tokStart, extraFlags, id, finishList(state, from)) as Node;
}

function parseTypeAnn(state: ParserState): Node {
    const start = state.tokStart;
    expectP(state, P.COLON, "':'");
    if (isK(state, K.ASSERTS)) {
        nextToken(state);
        if (isIdentLike(state) || isK(state, K.THIS)) nextToken(state);
        if (eatK(state, K.IS)) parseType(state);
        return create.TSTypeAnnotation(
            start,
            state.tokStart,
            0,
            create.keyword(start, state.tokStart, N.TSAnyKeyword) as Node,
        ) as Node;
    }
    // Type predicate `x is T` / `this is T`: detect the `is` with an allocation-free scalar
    // rewind (fires on every ident-led annotation, e.g. `: Foo`), and only when the annotation
    // actually starts with an ident/`this` — object/tuple/paren types skip the peek entirely.
    if (isIdentLike(state) || isK(state, K.THIS)) {
        const p = state.pos,
            tk = state.tok,
            ts0 = state.tokStart,
            te = state.tokEnd,
            tf = state.tokFlags,
            th = state.tokHash;
        nextToken(state);
        if (isK(state, K.IS)) {
            nextToken(state);
            const ty = parseType(state);
            return create.TSTypeAnnotation(start, state.tokStart, 0, ty) as Node;
        }
        state.pos = p;
        state.tok = tk;
        state.tokStart = ts0;
        state.tokEnd = te;
        state.tokFlags = tf;
        state.tokHash = th;
    }
    const ty = parseType(state);
    return create.TSTypeAnnotation(start, ty.end, 0, ty) as Node;
}

/** Public type entry: conditional types are ALLOWED here (a trailing `? … : …` starts a new
 * conditional). Nested bracketed types (`(T)`, `{…}`, `T[…]`, `<…>`) route back through this,
 * so disallow-conditional state never leaks across a bracket boundary — matching oxc/TS. */
function parseType(state: ParserState): Node {
    const saved = state.noCondType;
    state.noCondType = false;
    const t = parseTypeInner(state);
    state.noCondType = saved;
    return t;
}

function parseTypeInner(state: ParserState): Node {
    if (isP(state, P.LPAREN) && fnTypeAhead(state)) return parseFnType(state, 0, null);
    if (isP(state, P.LT)) {
        const tp = tryParseTypeParams(state);
        if (tp !== null) return parseFnType(state, 0, tp);
    }
    if (isK(state, K.NEW)) {
        const start = state.tokStart;
        nextToken(state);
        let tp: Ref = null;
        if (isP(state, P.LT)) {
            const t = tryParseTypeParams(state);
            if (t !== null) tp = t;
        }
        const params = parseParams(state);
        expectP(state, P.ARROW, "'=>'");
        const ret = parseType(state);
        const ann = create.TSTypeAnnotation(ret.start, ret.end, 0, ret) as Node;
        return create.TSConstructorType(start, state.tokStart, 0, tp, params, ann) as Node;
    }
    return parseConditionalTypeOrHigher(state);
}

function parseFnType(state: ParserState, abstractFlag: number, typeParams: Ref): Node {
    const start = state.tokStart;
    const params = parseParams(state);
    expectP(state, P.ARROW, "'=>'");
    const ret = parseType(state);
    const ann = create.TSTypeAnnotation(ret.start, ret.end, 0, ret) as Node;
    return create.TSFunctionType(start, state.tokStart, abstractFlag, typeParams, params, ann) as Node;
}

function fnTypeAhead(state: ParserState): boolean {
    const src = state.src,
        srcLen = state.srcLen;
    let p = state.tokStart + 1;
    let depth = 1;
    while (p < srcLen && depth > 0) {
        const c = src.charCodeAt(p);
        if (c === 40 || c === 91 || c === 123) depth++;
        else if (c === 41 || c === 93 || c === 125) depth--;
        else if (c === 34 || c === 39 || c === 96) {
            const q = c;
            p++;
            while (p < srcLen && src.charCodeAt(p) !== q) p += src.charCodeAt(p) === 92 ? 2 : 1;
        }
        p++;
    }
    while (p < srcLen) {
        const c = src.charCodeAt(p);
        if (c < 128 && (CHAR[c] === C_WS || CHAR[c] === C_NL)) p++;
        else break;
    }
    return src.charCodeAt(p) === 61 && src.charCodeAt(p + 1) === 62;
}

function parseConditionalTypeOrHigher(state: ParserState): Node {
    const checkType = parseUnionType(state);
    // A conditional's extends-type is parsed with conditionals disallowed (`noCondType`), so a
    // trailing `? … : …` there binds to THIS conditional, not a nested one.
    if (state.noCondType || !isK(state, K.EXTENDS)) return checkType;
    nextToken(state);
    state.noCondType = true;
    const extendsType = parseTypeInner(state);
    state.noCondType = false;
    expectP(state, P.QUESTION, "'?'");
    const trueType = parseType(state);
    expectP(state, P.COLON, "':'");
    const falseType = parseType(state);
    return create.TSConditionalType(checkType.start, falseType.end, 0, checkType, extendsType, trueType, falseType) as Node;
}

function parseUnionType(state: ParserState): Node {
    eatP(state, P.PIPE);
    const first = parseIntersectionType(state);
    if (!isP(state, P.PIPE)) return first;
    const start = first.start;
    const from = state.sp;
    push(state, first);
    while (eatP(state, P.PIPE)) push(state, parseIntersectionType(state));
    return create.TSUnionType(start, state.tokStart, 0, finishList(state, from)) as Node;
}

function parseIntersectionType(state: ParserState): Node {
    eatP(state, P.AMP);
    const first = parseTypeOperator(state);
    if (!isP(state, P.AMP)) return first;
    const start = first.start;
    const from = state.sp;
    push(state, first);
    while (eatP(state, P.AMP)) push(state, parseTypeOperator(state));
    return create.TSIntersectionType(start, state.tokStart, 0, finishList(state, from)) as Node;
}

function parseTypeOperator(state: ParserState): Node {
    const start = state.tokStart;
    if (isK(state, K.KEYOF)) {
        nextToken(state);
        const t = parseTypeOperator(state);
        return create.TSTypeOperator(start, t.end, TSOP.KEYOF, t) as Node;
    }
    if (isK(state, K.READONLY)) {
        nextToken(state);
        const t = parseTypeOperator(state);
        return create.TSTypeOperator(start, t.end, TSOP.READONLY, t) as Node;
    }
    if (isK(state, K.UNIQUE)) {
        nextToken(state);
        const t = parseTypeOperator(state);
        return create.TSTypeOperator(start, t.end, TSOP.UNIQUE, t) as Node;
    }
    if (isK(state, K.INFER)) {
        nextToken(state);
        const name = parseIdent(state, R_BIND);
        // `infer X extends C`: the `extends C` is the inferred type's constraint — UNLESS we're in
        // an allow-conditional context and a `?` follows, in which case `extends` opens the outer
        // conditional and we roll back. (oxc/TS `tryParseConstraintOfInferType`.)
        let constraint: Ref = null;
        if (isK(state, K.EXTENDS)) {
            const s = saveState(state);
            const inDisallow = state.noCondType;
            nextToken(state);
            state.noCondType = true;
            const c = parseTypeInner(state);
            state.noCondType = inDisallow;
            if (inDisallow || !isP(state, P.QUESTION)) constraint = c;
            else restoreState(state, s);
        }
        const tp = create.TSTypeParameter(name.start, state.tokStart, 0, name, constraint, null) as Node;
        return create.TSInferType(start, state.tokStart, 0, tp) as Node;
    }
    return parseTypePostfixAndCond(state, parsePrimaryType(state));
}

function parseTypePostfixAndCond(state: ParserState, t: Node): Node {
    for (;;) {
        if (isP(state, P.LBRACKET) && (state.tokFlags & F_NL) === 0) {
            nextToken(state);
            if (isP(state, P.RBRACKET)) {
                nextToken(state);
                t = create.TSArrayType(t.start, state.tokStart, 0, t) as Node;
            } else {
                const idx = parseType(state);
                expectP(state, P.RBRACKET, "']'");
                t = create.TSIndexedAccessType(t.start, state.tokStart, 0, t, idx) as Node;
            }
        } else return t;
    }
}

function parsePrimaryType(state: ParserState): Node {
    const start = state.tokStart;
    if (isP(state, P.LPAREN)) {
        if (fnTypeAhead(state)) return parseFnType(state, 0, null);
        nextToken(state);
        const t = parseType(state);
        expectP(state, P.RPAREN, "')'");
        return t;
    }
    if ((state.tok as number) === T_STR) {
        const l = leaf(state, N.StringLiteral, start, state.tokEnd);
        nextToken(state);
        return create.TSLiteralType(start, state.tokStart, 0, l) as Node;
    }
    if (state.tok === T_NUM) {
        const l = leaf(state, N.NumericLiteral, start, state.tokEnd);
        nextToken(state);
        return create.TSLiteralType(start, state.tokStart, 0, l) as Node;
    }
    if (state.tok === T_BIGINT) {
        const l = leaf(state, N.BigIntLiteral, start, state.tokEnd);
        nextToken(state);
        return create.TSLiteralType(start, state.tokStart, 0, l) as Node;
    }
    if (state.tok === T_TEMPLATE_FULL || state.tok === T_TEMPLATE_HEAD) return parseTemplateLiteralType(state);
    if (isP(state, P.MINUS)) {
        nextToken(state);
        if (state.tok === T_NUM) {
            const l = leaf(state, N.NumericLiteral, start, state.tokEnd);
            nextToken(state);
            return create.TSLiteralType(start, state.tokStart, 0, l) as Node;
        }
        raise(state, ParseErrorCode.ExpectedNumber);
        return create.keyword(start, state.tokStart, N.TSAnyKeyword) as Node;
    }
    if (isP(state, P.LBRACKET)) {
        nextToken(state);
        const from = state.sp;
        while (!isP(state, P.RBRACKET) && (state.tok as number) !== T_EOF) {
            const mark = state.tokStart;
            if (isP(state, P.DOTDOTDOT)) {
                const s = state.tokStart;
                nextToken(state);
                const sv = saveState(state);
                let t: Ref = null;
                if (isIdentLike(state)) {
                    const label = parseIdent(state, R_NAME);
                    let opt = 0;
                    if (isP(state, P.QUESTION)) {
                        opt = FL.OPTIONAL;
                        nextToken(state);
                    }
                    if (isP(state, P.COLON)) {
                        nextToken(state);
                        const ty = parseType(state);
                        t = create.TSNamedTupleMember(label.start, ty.end, opt, label, ty) as Node;
                    } else restoreState(state, sv);
                }
                if (t === null) t = parseType(state);
                push(state, create.TSTypeOperator(s, t.end, 0, t) as Node);
            } else {
                const s = saveState(state);
                if (isIdentLike(state)) {
                    const label = parseIdent(state, R_NAME);
                    let opt = 0;
                    if (isP(state, P.QUESTION)) {
                        opt = FL.OPTIONAL;
                        nextToken(state);
                    }
                    if (isP(state, P.COLON)) {
                        nextToken(state);
                        const t = parseType(state);
                        push(state, create.TSNamedTupleMember(label.start, t.end, opt, label, t) as Node);
                        if (!isP(state, P.RBRACKET)) expectP(state, P.COMMA, "','");
                        continue;
                    }
                    restoreState(state, s);
                }
                push(state, parseType(state));
                // unlabeled optional element `[string?]` — consume the marker. Optionality
                // isn't modeled without a TSOptionalType node, and the whole tuple type is
                // erased at emit, so dropping it is invisible to output (cf. `...` as TSTypeOperator).
                if (isP(state, P.QUESTION)) nextToken(state);
            }
            if (!isP(state, P.RBRACKET)) expectP(state, P.COMMA, "','");
            if (noProgress(state, mark)) break;
        }
        expectP(state, P.RBRACKET, "']'");
        return create.TSTupleType(start, state.tokStart, 0, finishList(state, from)) as Node;
    }
    if (isP(state, P.LBRACE)) {
        if (mappedTypeAhead(state)) return parseMappedType(state);
        const members = parseTypeMembers(state);
        return create.TSTypeLiteral(start, state.tokStart, 0, members) as Node;
    }
    if (isK(state, K.TYPEOF)) {
        nextToken(state);
        const s = state.tokStart;
        // `typeof this.foo` — the entity-name root may be `this` (or any reserved word). TS/oxc
        // parse a reserved-word-tolerant entity name here.
        let expr: Node;
        if (isK(state, K.THIS)) {
            expr = create.ThisExpression(state.tokStart, state.tokEnd, 0) as Node;
            nextToken(state);
        } else {
            expr = parseIdent(state, R_REF);
        }
        while (isP(state, P.DOT)) {
            nextToken(state);
            const r = parseNameAsIdent(state, R_NAME);
            expr = create.TSQualifiedName(s, r.end, 0, expr, r) as Node;
        }
        let targs: Ref = null;
        if (isP(state, P.LT)) {
            const t = tryParseTypeArgsInType(state);
            if (t !== null) targs = t;
        }
        return create.TSTypeQuery(start, state.tokStart, 0, expr, targs) as Node;
    }
    if (isK(state, K.IMPORT)) {
        nextToken(state);
        expectP(state, P.LPAREN, "'('");
        let source: Ref = null;
        if ((state.tok as number) === T_STR) {
            source = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
            nextToken(state);
        }
        expectP(state, P.RPAREN, "')'");
        let qualifier: Ref = null;
        if (isP(state, P.DOT)) {
            nextToken(state);
            let q: Node = parseNameAsIdent(state, R_NAME);
            while (isP(state, P.DOT)) {
                nextToken(state);
                const r = parseNameAsIdent(state, R_NAME);
                q = create.TSQualifiedName(q.start, r.end, 0, q, r) as Node;
            }
            qualifier = q;
        }
        let targs: Ref = null;
        if (isP(state, P.LT)) {
            const t = tryParseTypeArgsInType(state);
            if (t !== null) targs = t;
        }
        return create.TSImportType(
            start,
            state.tokStart,
            0,
            source ?? leaf(state, N.StringLiteral, state.tokStart, state.tokStart),
            qualifier,
            targs,
        ) as Node;
    }
    if (isK(state, K.THIS)) {
        nextToken(state);
        return create.keyword(start, state.tokStart, N.TSThisType) as Node;
    }
    if (isIdentLike(state) || isKeyword(state.tok)) {
        const kw = tsKeywordType(state);
        if (kw !== 0) {
            nextToken(state);
            return create.keyword(start, state.tokStart, kw) as Node;
        }
        const s = state.tokStart;
        let name: Node = parseNameAsIdent(state, R_REF);
        while (isP(state, P.DOT)) {
            nextToken(state);
            const r = parseNameAsIdent(state, R_NAME);
            name = create.TSQualifiedName(s, r.end, 0, name, r) as Node;
        }
        let targs: Ref = null;
        if (isP(state, P.LT)) {
            const t = tryParseTypeArgsInType(state);
            if (t !== null) targs = t;
        }
        return create.TSTypeReference(start, state.tokStart, 0, name, targs) as Node;
    }
    raise(state, ParseErrorCode.ExpectedType);
    nextToken(state);
    return create.keyword(start, state.tokStart, N.TSAnyKeyword) as Node;
}

function tsKeywordType(state: ParserState): KeywordType | 0 {
    const src = state.src;
    const len = state.tokEnd - state.tokStart;
    const st = state.tokStart;
    switch (len) {
        case 3:
            if (src.startsWith('any', st)) return N.TSAnyKeyword;
            break;
        case 4:
            if (src.startsWith('void', st)) return N.TSVoidKeyword;
            break;
        case 5:
            if (src.startsWith('never', st)) return N.TSNeverKeyword;
            break;
        case 6:
            if (src.startsWith('number', st)) return N.TSNumberKeyword;
            if (src.startsWith('string', st)) return N.TSStringKeyword;
            if (src.startsWith('symbol', st)) return N.TSSymbolKeyword;
            if (src.startsWith('object', st)) return N.TSObjectKeyword;
            if (src.startsWith('bigint', st)) return N.TSBigIntKeyword;
            break;
        case 7:
            if (src.startsWith('boolean', st)) return N.TSBooleanKeyword;
            if (src.startsWith('unknown', st)) return N.TSUnknownKeyword;
            break;
        case 9:
            if (src.startsWith('undefined', st)) return N.TSUndefinedKeyword;
    }
    if (isK(state, K.NULL)) return N.TSNullKeyword;
    return 0;
}

function parseTemplateLiteralType(state: ParserState): Node {
    const start = state.tokStart;
    if (state.tok === T_TEMPLATE_FULL) {
        const q = leaf(state, N.TemplateElement, start + 1, state.tokEnd - 1);
        nextToken(state);
        return create.TSTemplateLiteralType(start, state.tokStart, 0, [q], []) as Node;
    }
    const qFrom = state.sp;
    const types: Node[] = [];
    push(state, leaf(state, N.TemplateElement, start + 1, state.tokEnd - 2));
    nextToken(state);
    for (;;) {
        types.push(parseType(state));
        if (!isP(state, P.RBRACE)) {
            raise(state, ParseErrorCode.Expected, "'}'");
            break;
        }
        reScanTemplateContinue(state);
        if (state.tok === T_TEMPLATE_FULL) {
            push(state, leaf(state, N.TemplateElement, state.tokStart + 1, state.tokEnd - 1));
            nextToken(state);
            break;
        }
        push(state, leaf(state, N.TemplateElement, state.tokStart + 1, state.tokEnd - 2));
        nextToken(state);
    }
    const quasis = finishList(state, qFrom);
    return create.TSTemplateLiteralType(start, state.tokStart, 0, quasis, types) as Node;
}

function mappedTypeAhead(state: ParserState): boolean {
    const s = saveState(state);
    nextToken(state);
    let ok = false;
    if (isP(state, P.PLUS) || isP(state, P.MINUS)) nextToken(state);
    if (isK(state, K.READONLY)) nextToken(state);
    if (isP(state, P.LBRACKET)) {
        nextToken(state);
        if (isIdentLike(state)) {
            nextToken(state);
            ok = isK(state, K.IN);
        }
    }
    restoreState(state, s);
    return ok;
}

function parseMappedType(state: ParserState): Node {
    const start = state.tokStart;
    nextToken(state);
    let flags = 0;
    if (isP(state, P.PLUS)) {
        nextToken(state);
        if (eatK(state, K.READONLY)) flags |= 1 << 4;
    } else if (isP(state, P.MINUS)) {
        nextToken(state);
        if (eatK(state, K.READONLY)) flags |= 2 << 4;
    } else if (eatK(state, K.READONLY)) flags |= 3 << 4;
    expectP(state, P.LBRACKET, "'['");
    const name = parseIdent(state, R_BIND);
    if (!eatK(state, K.IN)) raise(state, ParseErrorCode.Expected, "'in'");
    const constraint = parseType(state);
    let nameType: Ref = null;
    if (eatK(state, K.AS)) nameType = parseType(state);
    expectP(state, P.RBRACKET, "']'");
    if (isP(state, P.PLUS)) {
        nextToken(state);
        if (eatP(state, P.QUESTION)) flags |= 1 << 6;
    } else if (isP(state, P.MINUS)) {
        nextToken(state);
        if (eatP(state, P.QUESTION)) flags |= 2 << 6;
    } else if (eatP(state, P.QUESTION)) flags |= 3 << 6;
    let typeAnn: Ref = null;
    if (isP(state, P.COLON)) {
        nextToken(state);
        typeAnn = parseType(state);
    }
    eatP(state, P.SEMI);
    expectP(state, P.RBRACE, "'}'");
    const tp = create.TSTypeParameter(name.start, constraint.end, 0, name, constraint, null) as Node;
    return create.TSMappedType(start, state.tokStart, flags, tp, nameType, typeAnn) as Node;
}

function parseTypeMembers(state: ParserState): Node[] {
    expectP(state, P.LBRACE, "'{'");
    const from = state.sp;
    let last = -1;
    while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
        if (state.tokStart === last) {
            raise(state, ParseErrorCode.UnexpectedInTypeMember, tokenDesc(state));
            nextToken(state);
            continue;
        }
        last = state.tokStart;
        push(state, parseTypeMember(state));
        eatP(state, P.COMMA);
        eatP(state, P.SEMI);
    }
    expectP(state, P.RBRACE, "'}'");
    return finishList(state, from);
}

function parseTypeMember(state: ParserState): Node {
    const start = state.tokStart;
    let flags = 0;
    if (isK(state, K.READONLY) && !nextIsPropertyEnd(state)) {
        flags |= FL.READONLY;
        nextToken(state);
    }
    if (isK(state, K.NEW) && !nextIsPropertyEnd(state)) {
        nextToken(state);
        let tp: Ref = null;
        if (isP(state, P.LT)) {
            const t = tryParseTypeParams(state);
            if (t !== null) tp = t;
        }
        const params = parseParams(state);
        let ret: Ref = null;
        if (isP(state, P.COLON)) ret = parseTypeAnn(state);
        return create.TSConstructSignatureDeclaration(start, state.tokStart, 0, tp, params, ret) as Node;
    }
    if (isP(state, P.LPAREN) || isP(state, P.LT)) {
        let tp: Ref = null;
        if (isP(state, P.LT)) {
            const t = tryParseTypeParams(state);
            if (t !== null) tp = t;
        }
        const params = parseParams(state);
        let ret: Ref = null;
        if (isP(state, P.COLON)) ret = parseTypeAnn(state);
        return create.TSCallSignatureDeclaration(start, state.tokStart, 0, tp, params, ret) as Node;
    }
    if (isP(state, P.LBRACKET)) {
        nextToken(state);
        const ps = state.tokStart;
        const name = parseNameAsIdent(state, R_REF);
        if (isP(state, P.COLON)) {
            const keyAnn = parseTypeAnn(state);
            const param = create.FormalParameter(
                ps,
                state.tokStart,
                0,
                ident(state, R_BIND, name.start, name.end),
                keyAnn,
                null,
            ) as Node;
            expectP(state, P.RBRACKET, "']'");
            let ann: Ref = null;
            if (isP(state, P.COLON)) ann = parseTypeAnn(state);
            return create.TSIndexSignature(start, state.tokStart, flags, param, ann) as Node;
        }
        let key: Node = name;
        while (isP(state, P.DOT)) {
            nextToken(state);
            const r = parseNameAsIdent(state, R_NAME);
            key = create.StaticMemberExpression(ps, r.end, 0, key, r) as Node;
        }
        expectP(state, P.RBRACKET, "']'");
        let mflags = flags | FL.COMPUTED;
        if (isP(state, P.QUESTION)) {
            mflags |= FL.OPTIONAL;
            nextToken(state);
        }
        if (isP(state, P.LPAREN) || isP(state, P.LT)) {
            let tp: Ref = null;
            if (isP(state, P.LT)) {
                const t = tryParseTypeParams(state);
                if (t !== null) tp = t;
            }
            const params = parseParams(state);
            let ret: Ref = null;
            if (isP(state, P.COLON)) ret = parseTypeAnn(state);
            return create.TSMethodSignature(start, state.tokStart, mflags, key, tp, params, ret) as Node;
        }
        let ann: Ref = null;
        if (isP(state, P.COLON)) ann = parseTypeAnn(state);
        return create.TSPropertySignature(start, state.tokStart, mflags, key, ann) as Node;
    }
    let kind = 0;
    if ((isK(state, K.GET) || isK(state, K.SET)) && !nextIsPropertyEnd(state)) {
        kind = isK(state, K.GET) ? 1 : 2;
        nextToken(state);
    }
    let key: Node;
    if ((state.tok as number) === T_STR) {
        key = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    } else if (state.tok === T_NUM) {
        key = leaf(state, N.NumericLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    } else key = parseNameAsIdent(state, R_NAME);
    if (isP(state, P.QUESTION)) {
        flags |= FL.OPTIONAL;
        nextToken(state);
    }
    if (isP(state, P.LPAREN) || isP(state, P.LT) || kind !== 0) {
        let tp: Ref = null;
        if (isP(state, P.LT)) {
            const t = tryParseTypeParams(state);
            if (t !== null) tp = t;
        }
        const params = parseParams(state);
        let ret: Ref = null;
        if (isP(state, P.COLON)) ret = parseTypeAnn(state);
        return create.TSMethodSignature(start, state.tokStart, flags | (kind << FL.KIND_SHIFT), key, tp, params, ret) as Node;
    }
    let ann: Ref = null;
    if (isP(state, P.COLON)) ann = parseTypeAnn(state);
    return create.TSPropertySignature(start, state.tokStart, flags, key, ann) as Node;
}

function expectGtInType(state: ParserState): void {
    if (isP(state, P.GT)) {
        nextToken(state);
        return;
    }
    if (
        isPunct(state.tok) &&
        (state.tok === P.SHR || state.tok === P.USHR || state.tok === P.GE || state.tok === P.SHREQ || state.tok === P.USHREQ)
    ) {
        state.pos = state.tokStart + 1;
        nextToken(state);
        return;
    }
    raise(state, ParseErrorCode.Expected, "'>'");
}
const isGtLike = (state: ParserState): boolean =>
    isPunct(state.tok) &&
    (state.tok === P.GT ||
        state.tok === P.SHR ||
        state.tok === P.USHR ||
        state.tok === P.GE ||
        state.tok === P.SHREQ ||
        state.tok === P.USHREQ);

function tryParseTypeParams(state: ParserState): Node | null {
    const src = state.src;
    const s = saveState(state);
    const startPos = state.tokStart;
    nextToken(state);
    const from = state.sp;
    try {
        state.speculating++;
        while (!isGtLike(state) && (state.tok as number) !== T_EOF) {
            const ts = state.tokStart;
            let flags = 0;
            for (;;) {
                if (isK(state, K.IN)) {
                    flags |= 1;
                    nextToken(state);
                } else if (
                    state.tok === T_IDENT &&
                    state.tokEnd - state.tokStart === 3 &&
                    src.startsWith('out', state.tokStart) &&
                    !nextIsTypeParamEnd(state)
                ) {
                    flags |= 2;
                    nextToken(state);
                } else if (isK(state, K.CONST)) {
                    flags |= 4;
                    nextToken(state);
                } else break;
            }
            const name = parseIdent(state, R_BIND);
            let constraint: Ref = null;
            if (eatK(state, K.EXTENDS)) constraint = parseType(state);
            let dflt: Ref = null;
            if (isP(state, P.EQ)) {
                nextToken(state);
                dflt = parseType(state);
            }
            push(state, create.TSTypeParameter(ts, state.tokStart, flags, name, constraint, dflt) as Node);
            if (!eatP(state, P.COMMA)) break;
        }
        if (!isGtLike(state)) throw 0;
        expectGtInType(state);
        state.speculating--;
        return create.TSTypeParameterDeclaration(startPos, state.tokStart, 0, finishList(state, from)) as Node;
    } catch {
        state.speculating--;
        state.sp = from;
        restoreState(state, s);
        return null;
    }
}

function nextIsTypeParamEnd(state: ParserState): boolean {
    const s = saveState(state);
    nextToken(state);
    const end = isGtLike(state) || isP(state, P.COMMA) || isK(state, K.EXTENDS) || isP(state, P.EQ);
    restoreState(state, s);
    return end;
}

function tryParseTypeArgsInType(state: ParserState): Node | null {
    const s = saveState(state);
    const startPos = state.tokStart;
    nextToken(state);
    const from = state.sp;
    try {
        state.speculating++;
        while (!isGtLike(state) && (state.tok as number) !== T_EOF) {
            push(state, parseType(state));
            if (!eatP(state, P.COMMA)) break;
        }
        if (!isGtLike(state)) throw 0;
        expectGtInType(state);
        state.speculating--;
        return create.TSTypeParameterInstantiation(startPos, state.tokStart, 0, finishList(state, from)) as Node;
    } catch {
        state.speculating--;
        state.sp = from;
        restoreState(state, s);
        return null;
    }
}

function tryParseTypeArgsForCall(state: ParserState): Node | null {
    const s = saveState(state);
    const ref = tryParseTypeArgsInType(state);
    if (ref === null) return null;
    if (
        isP(state, P.LPAREN) ||
        state.tok === T_TEMPLATE_FULL ||
        state.tok === T_TEMPLATE_HEAD ||
        isP(state, P.RPAREN) ||
        isP(state, P.COMMA) ||
        isP(state, P.SEMI) ||
        isP(state, P.RBRACE) ||
        state.tok === T_EOF
    ) {
        return ref;
    }
    restoreState(state, s);
    return null;
}

/** The parse result: the program, the error list, and the node count. The source is not
 * retained after the parse. A line table is NOT included — it had no consumers, and building
 * one eagerly cost a second full pass over the source; the sourcemap path builds its own
 * (`buildLineTable`, lazy, only when a map is wanted) and diagnostics compute line/col on
 * demand from byte offsets (`buildLineStarts`). */
export type ParseResult = {
    program: Program;
    errors: ParseError[];
    nodeCount: number;
    /** Module uses JSX (set during parse; avoids a JSX-detection walk). */
    hasJSX: boolean;
    /** Module contained a `return` outside any function body — tier 2 of the CommonJS kind rule
     *  (rolldown `EcmaModuleAstUsage::TopLevelReturn`). */
    hasTopLevelReturn: boolean;
    /** Module mentions `require` — gates the `require("lit")` edge walk. */
    hasRequire: boolean;
    hasTopLevelAwait: boolean;
    hasEsmExport: boolean;
    hasEsmImport: boolean;
    /** `this` expressions at the module top level (CommonJS: `module.exports`). */
    topLevelThis: Node[];
    /** Did the module contain `import(...)` or `import.meta`?
     *
     *  `extractRecords` walks the whole program for dynamic-import edges and `new URL(…,
     *  import.meta.url)` asset references, because both nest arbitrarily deep in expressions. Both
     *  are also RARE: on a crashcat bundle all 97 modules contained neither, so every one of those
     *  walks (167,349 nodes) found nothing. The parser already visits these nodes, so it records the
     *  fact for free — the same trick `hasJSX` uses. `new URL` asset detection additionally requires
     *  `import.meta.url`, so `import.meta` is the discriminating marker there (a bare `NewExpression`
     *  is far too common to gate on). */
    hasImportSyntax: boolean;
};
/** Module goal, mirroring oxc's `ModuleKind` (`oxc_span/src/source_type.rs:56-75`). `unambiguous`
 *  is the permissive default and is parser-input only — it never describes a finished AST. */
export type ParseKind = 'module' | 'commonjs' | 'unambiguous';

export type ParseOptions = { ts: boolean; jsx: boolean; kind?: ParseKind };

/** Parse `source` into a standalone Program. Source, error sink, intern map and
 * line table are the parser's own state, reset at entry; nothing references
 * `source` after this returns. */
export function parse(source: string, options: ParseOptions): ParseResult {
    const state = createParserState(source, options);
    nextToken(state);
    const from = state.sp;
    let lastPos = -1;
    while ((state.tok as number) !== T_EOF) {
        if (state.pos === lastPos && (state.tok as number) !== T_EOF) {
            raise(state, ParseErrorCode.ParserStalled);
            nextToken(state);
        }
        lastPos = state.pos;
        push(state, parseStatement(state));
    }
    const body = finishList(state, from);
    const program = create.Program(0, state.srcLen, 0, body) as Program;
    const nodeCount = program.id - state.baseId + 1;
    return {
        program,
        errors: state.errors,
        nodeCount,
        hasJSX: state.sawJSX,
        hasImportSyntax: state.sawImportSyntax,
        hasTopLevelReturn: state.sawTopLevelReturn,
        hasRequire: state.sawRequire,
        hasTopLevelAwait: state.sawTopLevelAwait,
        hasEsmExport: state.sawEsmExport,
        hasEsmImport: state.sawEsmImport,
        topLevelThis: state.topLevelThis,
    };
}

export function parseProgram(source: string, options: ParseOptions): Program {
    return parse(source, options).program;
}
export function parseWithDiagnostics(source: string, options: ParseOptions): ParseResult {
    return parse(source, options);
}

export function lexOnly(source: string, options: ParseOptions): number {
    const state = createParserState(source, options);
    let sum = 0;
    nextToken(state);
    let lastPos = -1;
    while (state.tok !== T_EOF) {
        if (state.tok === T_IDENT) sum += intern(state, state.tokStart, state.tokEnd, state.tokHash).length;
        else sum += state.tokEnd - state.tokStart;
        if (state.pos === lastPos) break;
        lastPos = state.pos;
        nextToken(state);
    }
    return sum;
}
