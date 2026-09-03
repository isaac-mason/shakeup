import {
    type BindingIdentifier,
    create,
    FL,
    type IdentifierName,
    type IdentifierReference,
    type KeywordType,
    type LabelIdentifier,
    N,
    type Node,
    type NodeOf,
    type NodeType,
    node,
    OP,
    type Program,
    peekNextId,
    VAR_KIND,
} from '../ast/index.ts';
import { enumeration } from '../util/enumeration.ts';
import { COMMENT_STRIDE } from './comments.ts';
import { ParseErrorCode } from './errors.ts';
import {
    CHAR,
    C_NL,
    C_WS,
    hashRange,
    intern,
    internString,
    keywordCodeOf,
    nextJSXChild,
    nextToken,
    reScanJSXIdentifier,
    reScanRegex,
    reScanTemplateContinue,
    nextJSXAttributeValue,
    sliceFlat,
} from './lexer.ts';
import {
    CTX,
    F_BAD_ESCAPE,
    F_ESCAPED,
    F_NL,
    K,
    P,
    type ParseError,
    type ParserState,
    raise,
    raiseAt,
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
 *  marker applies to the call it immediately precedes.
 *
 *  CALL THIS BEFORE PARSING ARGUMENTS. `pureAt` is a single slot, so an annotation inside the
 *  arguments overwrites it and then consumes it, and the OUTER call silently loses its flag:
 *
 *      /*@__PURE__*​/ f('a', /*@__PURE__*​/ asset('y'))   ->   f=no, asset=PURE
 *
 *  Both oracles drop that whole expression when unused; we kept it, because only `asset` carried the
 *  flag. Capturing at the `(` — before `parseArgs` — gives each call its own annotation. */
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
        nseAt: [],
        comments: new Int32Array(256 * COMMENT_STRIDE),
        commentsLen: 0,
        keepComments: options.comments !== false,
        goalUnknown: options.kind !== 'module' && options.kind !== 'commonjs',
        sawUnbundlable: false,
        staticBlockDepth: 0,
        tokHash: 0,
        tokCooked: '',
        tsMode: options.ts,
        jsxMode: options.jsx,
        fnDepth: 0,
        newTargetDepth: 0,
        // `unambiguous` (the default) stays permissive, so adopting the goal gate is NOT a breaking
        // change: only a file with an explicit signal — `.cjs`/`.mjs`/`.cts`/`.mts` or a declared
        // `package.json#type` — is held to it. Mirrors oxc's `ModuleKind::Unambiguous`.
        allowTopReturn: options.kind !== 'module',
        allowTopNewTarget: options.kind !== 'module',
        // `import.meta` is MODULE-ONLY syntax: node says "Cannot use 'import.meta' outside a module",
        // oxc "Unexpected import.meta expression". Gated on an EXPLICIT commonjs goal for the same
        // reason the two above are — `unambiguous` stays permissive, so only a file carrying a real
        // signal (`.cjs`/`.cts`, or a declared `package.json#type`) is held to it.
        allowImportMeta: options.kind !== 'commonjs',
        // Top-level await: legal in an ES module, not in a CommonJS body (which is wrapped in a
        // non-async function). `unambiguous` stays permissive, as with the other two gates.
        errors: [],
        // The id the first node of this parse will get. `nodeCount` is `program.id - baseId + 1`,
        // which only needs ids to be contiguous and monotonic — peeked here rather than captured on
        // the way past the first allocation, so every node can be built by `node()` (see peekNextId).
        baseId: peekNextId(),
        itKeys: new Array(cap),
        itHashes: new Int32Array(cap),
        itMask: cap - 1,
        itCount: 0,
        stk: new Array(1 << 8).fill(null),
        sp: 0,
        notArrow: null,
        ctx: options.kind === 'module' ? CTX.Await : 0,
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
    };
}

// `v` is a packed token constant (P.* / K.*); packed values are unique per kind,
// so a whole-value compare is both the kind check and the identity check.
const inCtx = (state: ParserState, bit: number): boolean => (state.ctx & bit) !== 0;
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
    // An escaped identifier's NAME is not its source slice, so it cannot be interned by range.
    // Guarded on the flag, which `tokFlags` already carries — the ordinary path is unchanged.
    let name: string;
    if ((state.tokFlags & F_ESCAPED) !== 0 && start === state.tokStart && end === state.tokEnd) {
        name = internString(state, state.tokCooked);
    } else {
        const h = start === state.tokStart && end === state.tokEnd ? state.tokHash : hashRange(state, start, end);
        name = intern(state, start, end, h);
    }
    // Cheap syntactic gate for the `require("lit")` edge walk — set here rather than by a dedicated
    // pass, exactly as `sawJSX` is. A false positive (a local named `require`) only costs one walk.
    if (name.length === 7 && name === 'require') state.sawRequire = true;
    return node(role as NodeType, start, end, name, null) as Identifier;
}
/**
 * An identifier leaf whose NAME is already known and interned.
 *
 * `ident` re-derives the name from the source range, and its escape-cooking branch only fires while
 * the escaped token is still the CURRENT one. A shorthand property's value is built after its key has
 * been consumed, so that branch is skipped and the RAW slice gets interned: `({ \u0061bc })` bound
 * under `\u0061bc` while the key said `abc`. That is not merely a missed diagnostic — the body's
 * `abc` then resolved to whatever was in scope outside, and
 * `const abc = "OUTER"; ({ \u0061bc }) => abc` constant-folded to `"OUTER"` where node returns the
 * parameter. Reusing the key's cooked name is also cheaper: no re-hash, no re-intern.
 */
function identNamed(state: ParserState, role: number, start: number, end: number, name: string): Identifier {
    if (name.length === 7 && name === 'require') state.sawRequire = true;
    return node(role as NodeType, start, end, name, null) as Identifier;
}
function leafRaw(state: ParserState, flatType: number, start: number, end: number): Node {
    return node(flatType as NodeType, start, end, sliceFlat(state, start, end), null);
}
/** Parse an identifier token in the given role. `role` picks the leaf type. */
/** Is `await` reserved as an identifier right here?
 *
 *  Two independent reasons, and neither implies the other. `CTX.Await` needs the extra guard because
 *  it is seeded TRUE at top level for the permissive `unambiguous` goal, where `var await = 1` is
 *  legal script — inside a function body it can only mean `async`, and a declared module is strict
 *  either way, which is exactly what `allowTopReturn` distinguishes. A class STATIC BLOCK reserves
 *  the word without being an async context at all, so it cannot ride on that bit. */
function awaitReserved(state: ParserState): boolean {
    if (state.staticBlockDepth > 0) return true;
    return inCtx(state, CTX.Await) && (state.fnDepth > 0 || !state.allowTopReturn);
}

function parseIdent(state: ParserState, role: number): Identifier {
    if (!isIdentLike(state)) {
        raise(state, ParseErrorCode.ExpectedIdentifier);
        return makeMissingIdent(state, role);
    }
    // `yield` and `await` are contextual: ordinary identifiers until the enclosing function makes
    // them operators, at which point BINDING one is an early error. oxc's `identifier_generator` /
    // `identifier_async` (`diagnostics.rs:573,578`). Only the binding role — a reference is already
    // handled by the operator branches in `parseAssign`/`parseUnary`, which consume the token.
    // An escaped identifier is not the keyword it spells, but it may not APPEAR where the keyword
    // it spells is reserved: `var \u0069f = 1` and `var \u0074his = 1` are both errors. This is
    // `parseIdent` and not `parseNameAsIdent` precisely because that is the split — a property key
    // or member name (`({ \u0069f: 1 })`, `x.\u0069f`) may be a reserved word and stays legal.
    // Contextual keywords (`async`, `let`, `of`) are not reserved, so they pass.
    // An escaped spelling still NAMES the keyword, so `\u0079ield` is `yield` for every rule below —
    // oxc gets this for free because its lexer gives the escaped token the keyword's own `Kind` and
    // `advance` checks `token.escaped() && kind.is_any_keyword()` (`cursor.rs:100`). Ours lexes it as
    // a plain identifier, so the cooked text is what the rules have to consult.
    const escaped = (state.tokFlags & F_ESCAPED) !== 0 ? state.tokCooked : '';
    const yieldHere = inCtx(state, CTX.Yield) && (isK(state, K.YIELD) || escaped === 'yield');
    const awaitHere = (isK(state, K.AWAIT) || escaped === 'await') && awaitReserved(state);
    // Neither word can be a plain identifier where it is reserved, in ANY role: `void yield` inside a
    // generator reaches here as a REFERENCE, because `parseUnary` takes its operand without going
    // through the `yield` branch of `parseAssign`.
    //
    // Which MESSAGE, though, depends on the role. A binding reports the context (`var \u0061wait` in
    // an async function is "cannot use `await` as an identifier"); an escaped reference reports the
    // escape. Both are oxc's, checked against `oxc-parser` case by case. One divergence is accepted:
    // oxc reports the CONTEXT for `function* g() { void \u0079ield; }` and the ESCAPE for
    // `function* g() { \u0079ield; }`, a split that falls out of which recovery path its lexer took.
    // Both spellings are rejected either way, so the wording is not worth modelling.
    if (role !== R_BIND && escaped !== '' && (yieldHere || awaitHere)) raise(state, ParseErrorCode.EscapedKeyword);
    else if (yieldHere) raise(state, ParseErrorCode.IdentifierInGenerator);
    else if (awaitHere) raise(state, ParseErrorCode.IdentifierInAsync);
    else if (escaped !== '') {
        // An escaped identifier is not the keyword it spells, but it may not APPEAR where the keyword
        // it spells is reserved: `var \u0069f = 1` and `var \u0074his = 1` are both errors. This is
        // `parseIdent` and not `parseNameAsIdent` precisely because that is the split — a property key
        // or member name (`({ \u0069f: 1 })`, `x.\u0069f`) may be a reserved word and stays legal.
        // `async` / `let` / `of` are contextual and never reserved, so they pass; `yield` and `await`
        // are contextual but DO become reserved, which is what the two flags above decide.
        const kw = keywordCodeOf(escaped);
        if ((kw !== 0 && !isContextual(kw)) || yieldHere || awaitHere) raise(state, ParseErrorCode.EscapedKeyword);
    }
    const id = ident(state, role, state.tokStart, state.tokEnd);
    nextToken(state);
    return id;
}
/** A shorthand property's name is BOTH a key and an identifier, so the reserved-word rules that
 *  `parseNameAsIdent` deliberately skips for a key apply after all: `({ break: 1 })` is legal and
 *  `({ break })` is not. oxc reaches the same place by a different route — it parses the shorthand
 *  value as an `IdentifierReference` and its recovery then demands the `:` that would have made the
 *  name a key — which is why the message here is "expected ':'" rather than a rule of its own. */
function checkShorthandName(state: ParserState, key: Node): void {
    if (key.type !== N.IdentifierName) return;
    const kw = keywordCodeOf(key.name);
    const reserved =
        (kw !== 0 && !isContextual(kw)) ||
        (key.name === 'yield' && inCtx(state, CTX.Yield)) ||
        (key.name === 'await' && awaitReserved(state));
    if (reserved) raise(state, ParseErrorCode.Expected, "':'");
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
function makeMissingIdent(_state: ParserState, role: number): Identifier {
    return node(role as NodeType, 0, 0, '', null) as Identifier;
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
type LexState = [number, number, number, number, number, number, number, boolean, number, number, number];
const saveState = (state: ParserState): LexState => [
    state.pos,
    state.tok,
    state.tokStart,
    state.tokEnd,
    state.tokFlags,
    state.errors.length,
    state.tokHash,
    state.fatal,
    // APPEND-ONLY collections filled as a side effect of lexing/parsing. A failed probe that ran
    // over `/*@__NO_SIDE_EFFECTS__*/` recorded it, rewound, and the real parse recorded it again —
    // so the annotation appeared twice. Harmless only because `resolveNoSideEffects` de-dupes with a
    // Set; the same hole in `topLevelThis` would not be. Truncating is enough: both only ever grow.
    state.nseAt.length,
    state.commentsLen,
    state.topLevelThis.length,
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
    state.nseAt.length = s[8];
    state.commentsLen = s[10];
    state.topLevelThis.length = s[9];
}

function push(state: ParserState, v: Ref): void {
    const stk = state.stk;
    if (state.sp === stk.length) {
        const n = stk.length;
        for (let i = 0; i < n; i++) stk.push(null);
    }
    stk[state.sp++] = v;
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
        return create.SequenceExpression(start, state.tokStart, 0, finishList(state, from));
    }
    return expr;
}

/**
 * EARLY ERRORS for assignment targets — 13.15.1 and the destructuring cover grammar.
 *
 * The grammar parses `f() = 1` happily, because the left-hand side is only known to be an
 * assignment TARGET once the `=` is seen; the spec handles this with a "cover grammar" that
 * reinterprets an already-parsed expression, and rejects what cannot be reinterpreted. oxc does the
 * reinterpretation for real (`js/grammar.rs`, `CoverGrammar::cover`), turning the expression into a
 * distinct `AssignmentTarget` node. shakeup keeps the expression node — a destructuring assignment
 * stores its target as the ArrayExpression/ObjectExpression it was parsed as — so what is ported is
 * the VALIDATION half: the same walk, raising where oxc raises, without the node conversion.
 *
 * `simple` distinguishes the two positions: `++x` and `x += 1` take a SimpleAssignmentTarget only,
 * while `x = 1` and a for-in/of head also accept a destructuring pattern.
 */
function checkAssignTarget(state: ParserState, node: Node, simple: boolean): void {
    switch (node.type) {
        case N.IdentifierReference:
        case N.BindingIdentifier:
            return;
        case N.StaticMemberExpression:
        case N.ComputedMemberExpression:
        case N.PrivateFieldExpression:
            // A member inside an optional chain is not assignable: `a?.b = 1` is a SyntaxError even
            // though `a.b = 1` is fine. shakeup marks the chain with a wrapping ChainExpression,
            // which the case below rejects, and `optional` on the link itself.
            if (node.data.optional as boolean) break;
            return;
        // TS type-only wrappers are transparent, but only over a SIMPLE target: oxc allows
        // `(a as T) = 1` and rejects `(f() as T) = 1` (`grammar.rs:47-56`).
        case N.TSAsExpression:
        case N.TSSatisfiesExpression:
        case N.TSNonNullExpression:
            checkAssignTarget(state, node.data.expression as Node, true);
            return;
        case N.ArrayExpression:
            if (simple) break;
            checkArrayTarget(state, node);
            return;
        case N.ObjectExpression:
            if (simple) break;
            checkObjectTarget(state, node);
            return;
    }
    raiseAt(state, node.start, simple ? ParseErrorCode.AssignmentNotSimple : ParseErrorCode.InvalidAssignmentTarget);
}

/** An element of a destructuring target, which may carry a default: `[a = 1] = b`. */
function checkMaybeDefault(state: ParserState, node: Node): void {
    // A default reaches here in one of two shapes. `[a = 1]` parses as an ArrayExpression holding an
    // AssignmentExpression, but object SHORTHAND with a default (`{a = 1}`) is not expressible as
    // an object literal at all, so it is parsed straight into an `AssignmentPattern` — a node that
    // exists only in target position and is therefore already validated.
    if (node.type === N.AssignmentPattern) {
        checkAssignTarget(state, node.data.left as Node, false);
        return;
    }
    if (node.type === N.AssignmentExpression) {
        // `[a ||= 1] = b` — a default is spelled with `=` and nothing else.
        if (node.data.operator !== '=') raiseAt(state, node.start, ParseErrorCode.DefaultValueOperator);
        checkAssignTarget(state, node.data.left as Node, false);
        return;
    }
    checkAssignTarget(state, node, false);
}

function checkArrayTarget(state: ParserState, node: NodeOf<'ArrayExpression'>): void {
    const elements = node.data.elements as (Node | null)[];
    for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        if (el === null) continue; // a hole is an elision, and skips its position
        if (el.type !== N.SpreadElement && el.type !== N.RestElement) {
            checkMaybeDefault(state, el);
            continue;
        }
        if (i !== elements.length - 1) {
            raiseAt(state, el.start, ParseErrorCode.SpreadLastElement);
            return;
        }
        // A rest target is wider in an ARRAY than in an object: a nested pattern is allowed
        // (`[...[a]] = b`), which is why this is not just `checkAssignTarget(.., true)`.
        const arg = el.data.argument as Node;
        if (arg.type !== N.ArrayExpression && arg.type !== N.ObjectExpression) checkRestTarget(state, arg);
        else checkAssignTarget(state, arg, false);
    }
}

function checkObjectTarget(state: ParserState, node: NodeOf<'ObjectExpression'>): void {
    const props = node.data.properties as Node[];
    for (let i = 0; i < props.length; i++) {
        const prop = props[i];
        if (prop.type === N.SpreadElement || prop.type === N.RestElement) {
            if (i !== props.length - 1) {
                raiseAt(state, prop.start, ParseErrorCode.SpreadLastElement);
                return;
            }
            // Unlike an array rest, an object rest takes a SIMPLE target only: `({...{a}} = b)` is
            // an error (`grammar.rs:192-201`).
            checkRestTarget(state, prop.data.argument as Node);
            continue;
        }
        if (prop.type !== N.ObjectProperty) continue;
        // A getter/setter cannot appear in a destructuring target; its `value` is a function, which
        // the target check below rejects on its own.
        checkMaybeDefault(state, prop.data.value as Node);
    }
}

/** The rest target's own rule: identifier or member expression, nothing else. oxc reports this one
 *  NON-fatally and then still runs the ordinary target check, so the shape is the same either way;
 *  shakeup's `raise` latches, so only the first message is kept. */
function checkRestTarget(state: ParserState, arg: Node): void {
    switch (arg.type) {
        case N.IdentifierReference:
        case N.BindingIdentifier:
            return;
        case N.StaticMemberExpression:
        case N.ComputedMemberExpression:
        case N.PrivateFieldExpression:
            if (arg.data.optional as boolean) break;
            return;
    }
    raiseAt(state, arg.start, ParseErrorCode.InvalidRestTarget);
}

function parseAssign(state: ParserState, noIn = false, allowReturnType = true): Node {
    if (isP(state, P.LPAREN)) {
        const tri = classifyArrowHead(state);
        if (tri === TRI_TRUE) return parseArrow(state, state.tokStart, 0, null, allowReturnType);
        if (tri === TRI_MAYBE) {
            const arrow = tryParseArrow(state, state.tokStart, 0, null, allowReturnType);
            if (arrow !== null) return arrow;
        }
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
            if (isP(state, P.LPAREN)) {
                const tri = classifyArrowHead(state);
                if (tri === TRI_TRUE) return parseArrow(state, asyncStart, FL.ASYNC, null, allowReturnType);
                if (tri === TRI_MAYBE) {
                    const arrow = tryParseArrow(state, asyncStart, FL.ASYNC, null, allowReturnType);
                    if (arrow !== null) return arrow;
                }
            }
            if (isIdentLike(state)) {
                const idStart = state.tokStart;
                const single = parseIdent(state, R_BIND);
                if (isP(state, P.ARROW)) {
                    // "It is a Syntax Error if ArrowParameters Contains AwaitExpression is true."
                    // Checked on the identifier we already parsed, which is oxc's shape exactly
                    // (`js/arrow.rs:44-47`) — the name is only reserved once `=>` proves this is an
                    // async arrow, so it cannot be caught earlier in `parseIdent`.
                    if (single.name === 'await') raiseAt(state, idStart, ParseErrorCode.IdentifierInAsync);
                    return parseArrowAfterSingleParam(state, asyncStart, single, FL.ASYNC, idStart, allowReturnType);
                }
            }
        }
        restoreState(state, s);
    }
    if (state.tsMode && isP(state, P.LT) && classifyAngleArrowHead(state) !== TRI_FALSE) {
        const s = saveState(state);
        const start = state.tokStart;
        const tp = tryParseTypeParams(state);
        if (tp !== null && isP(state, P.LPAREN)) {
            const tri = classifyArrowHead(state);
            if (tri === TRI_TRUE) return parseArrow(state, start, 0, tp, allowReturnType);
            if (tri === TRI_MAYBE) {
                const arrow = tryParseArrow(state, start, 0, tp, allowReturnType);
                if (arrow !== null) return arrow;
            }
        }
        restoreState(state, s);
    }
    // Only where `yield` is in scope. Elsewhere it is an ordinary identifier — the same shape as
    // `await` above, and the same reason: `yield => 1` and `var yield = 1` are legal outside a
    // generator, and `function f(){ yield 1 }` then fails naturally as two adjacent identifiers.
    if (isK(state, K.YIELD) && inCtx(state, CTX.Yield)) {
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
        return create.YieldExpression(start, arg ? arg.end : state.tokStart, flags, arg);
    }

    const left = parseConditional(state, noIn, allowReturnType);
    // `ident => …`, decided AFTER parsing rather than by scanning source ahead of it — meriyah's
    // shape (`parseMemberOrUpdateExpression`: `if (parser.getToken() === 10) … parseArrowFromIdentifier`,
    // reclassifying the identifier it already parsed). We used to run `identArrowAhead`, a forward
    // source scan skipping trivia, on EVERY identifier-led expression: measured 37,137 calls and
    // **zero** hits on a real JS corpus, costing 2.0% of parse. The token is already lexed here, so
    // the same question is one comparison.
    //
    // Reaching here with a bare `IdentifierReference` means nothing else claimed it — `a.b => c` is a
    // MemberExpression and correctly falls through to the error path. The paren and `async` forms are
    // handled above and never get this far. The role IS the node type (`R_REF`/`R_BIND`), so
    // reinterpreting is one node, built only on the rare real arrow.
    //
    // `[no LineTerminator here]` is part of the production, so a newline before `=>` is not an arrow.
    if (isP(state, P.ARROW) && left.type === N.IdentifierReference && (state.tokFlags & F_NL) === 0) {
        const bind = node(N.BindingIdentifier, left.start, left.end, left.name, null) as Identifier;
        return parseArrowAfterSingleParam(state, left.start, bind, 0, left.start, allowReturnType);
    }
    if (isAssignOp(state.tok)) {
        const op = opTextOf(state.tok);
        // `x = …` reinterprets the left side through the destructuring cover grammar; every other
        // operator (`+=`, `&&=`, …) reads the old value first and so needs a SIMPLE target.
        checkAssignTarget(state, left, op !== '=');
        nextToken(state);
        const right = parseAssign(state, noIn);
        return create.AssignmentExpression(left.start, right.end, op, left, right);
    }
    return left;
}

function parseConditional(state: ParserState, noIn: boolean, allowReturnType: boolean): Node {
    const test = parseBinary(state, 0, noIn);
    if (!isP(state, P.QUESTION)) return test;
    nextToken(state);
    // The consequent is the one place a parsed return type is suspect — `x ? y => ({y}) : z => ({z})`
    // would otherwise read `({y}) : z => ({z})` as an arrow returning `z`, swallowing the `:` that
    // terminates the conditional. oxc passes `false` in exactly this position
    // (`js/expression.rs:1458-1462`). The ALTERNATE inherits, because nothing new is ambiguous there.
    const cons = parseAssign(state, false, false);
    expectP(state, P.COLON, "':'");
    const alt = parseAssign(state, noIn, allowReturnType);
    return create.ConditionalExpression(test.start, alt.end, 0, test, cons, alt);
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
                ? create.TSSatisfiesExpression(left.start, ty.end, 0, left, ty)
                : create.TSAsExpression(left.start, ty.end, 0, left, ty);
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
            ? create.LogicalExpression(left.start, right.end, op, left, right)
            : create.BinaryExpression(left.start, right.end, op, left, right);
    }
}

/** oxc `Kind::is_after_await_or_yield` (`lexer/kind.rs:315`). */
const startsAwaitOperand = (tok: number): boolean =>
    !isBinaryOp(tok) && (isLiteralTok(tok) || tok === T_IDENT || isKeyword(tok));

function isUnambiguousAwait(state: ParserState): boolean {
    const pos = state.pos;
    const tok = state.tok;
    const tokStart = state.tokStart;
    const tokEnd = state.tokEnd;
    const tokFlags = state.tokFlags;
    const tokHash = state.tokHash;
    const errorCount = state.errors.length;
    const fatal = state.fatal;
    nextToken(state);
    const next = state.tok;
    const newline = (state.tokFlags & F_NL) !== 0;
    state.pos = pos;
    state.tok = tok;
    state.tokStart = tokStart;
    state.tokEnd = tokEnd;
    state.tokFlags = tokFlags;
    state.tokHash = tokHash;
    state.errors.length = errorCount;
    state.fatal = fatal;
    // A line break makes it ASI-ambiguous; `of` and `using` have their own for-head and
    // declaration readings.
    if (newline || next === K.OF || next === K.USING) return false;
    return startsAwaitOperand(next);
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
                return create.UnaryExpression(start, arg.end, op, arg);
            }
            case P.PLUSPLUS:
            case P.MINUSMINUS: {
                const op = state.tok === P.PLUSPLUS ? OP.INC : OP.DEC;
                nextToken(state);
                const arg = parseUnary(state);
                // `++f()` / `++1`: an update reads AND writes, so only a simple target will do.
                checkAssignTarget(state, arg, true);
                return create.UpdateExpression(start, arg.end, op | FL.PREFIX, arg);
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
                return create.UnaryExpression(start, arg.end, op, arg);
            }
            case K.AWAIT: {
                // An operator where `await` is in scope. Where it is NOT — a script, or a file whose
                // goal is not yet known — it is an ordinary identifier UNLESS the next token settles
                // it: `await x` can only be the operator, while `await;`, `await = 1`,
                // `await instanceof F` and `await (x)` can only be the identifier. A top-level
                // unambiguous `await` that IS the operator makes the file a module, which is how
                // `import y from 'm'; await x;` and `var await = 1; await;` both parse without a
                // second pass. oxc `is_unambiguous_await` (`js/expression.rs:1685`).
                // Only where the goal is genuinely undeclared, and only at the MODULE top level: a
                // declared script must reject `await x`, and a class static block reserves `await`
                // outright even though it is not a function scope (`newTargetDepth` is what a static
                // block bumps). oxc accepts the static-block case; node rejects it, and node is right.
                if (!inCtx(state, CTX.Await)) {
                    if (!state.goalUnknown || state.fnDepth !== 0 || state.newTargetDepth !== 0) break;
                    if (!isUnambiguousAwait(state)) break;
                }
                if (state.fnDepth === 0) state.sawTopLevelAwait = true;
                nextToken(state);
                const arg = parseUnary(state);
                return create.AwaitExpression(start, arg.end, 0, arg);
            }
        }
    }
    let expr = parsePostfixChain(state);
    if (isPunct(state.tok) && (state.tok === P.PLUSPLUS || state.tok === P.MINUSMINUS) && (state.tokFlags & F_NL) === 0) {
        const op = state.tok === P.PLUSPLUS ? OP.INC : OP.DEC;
        checkAssignTarget(state, expr, true);
        nextToken(state);
        expr = create.UpdateExpression(expr.start, state.tokStart, op, expr);
    }
    return expr;
}

function parsePostfixChain(state: ParserState): Node {
    if (isK(state, K.NEW)) return parseNew(state);
    return parseMemberChain(state, parsePrimary(state), true);
}

/** `import(...)`, and the phase forms `import.source(...)` / `import.defer(...)` which share it —
 *  oxc's `parse_import_expression` (`js/module.rs:32`). A spread is refused per ARGUMENT rather than
 *  once for the list, because `import(a, ...b)` is as invalid as `import(...a)`. */
function parseImportCall(state: ParserState, start: number, phase: 'source' | 'defer' | null): Node {
    expectP(state, P.LPAREN, "'('");
    if (isP(state, P.RPAREN)) {
        raise(state, ParseErrorCode.ImportRequiresSpecifier);
        nextToken(state);
        state.sawImportSyntax = true;
        return create.ImportExpression(start, state.tokStart, 0, makeMissingIdent(state, R_REF), null, phase);
    }
    const source = parseImportArgument(state);
    let options: Ref = null;
    if (eatP(state, P.COMMA) && !isP(state, P.RPAREN)) options = parseImportArgument(state);
    eatP(state, P.COMMA);
    if (!eatP(state, P.RPAREN)) raise(state, ParseErrorCode.ImportArguments);
    state.sawImportSyntax = true;
    // A phase import PARSES but cannot be bundled, the same split `with` and decorators got — see
    // `scan.ts`'s `errorImportPhase`, which covers the declaration form. Flagging it here routes the
    // expression form into `collectUnsupported` rather than letting it lower to an EAGER import.
    if (phase !== null) state.sawUnbundlable = true;
    return create.ImportExpression(start, state.tokStart, 0, source, options, phase);
}

function parseImportArgument(state: ParserState): Node {
    if (isP(state, P.DOTDOTDOT)) {
        raise(state, ParseErrorCode.DynamicImportSpread);
        nextToken(state);
    }
    return parseAssign(state);
}

/** oxc's `is_import_expression_or_member_access_on_import_expression` (`js/expression.rs:26`) — the
 *  callee of a `new` may REACH a dynamic import through member accesses, a tagged template or a
 *  non-null assertion, and `new import('m').then` is an error just as `new import('m')` is. */
function reachesImportExpression(node: Node): boolean {
    let expr = node;
    for (;;) {
        switch (expr.type) {
            case N.ImportExpression:
                return true;
            case N.StaticMemberExpression:
            case N.ComputedMemberExpression:
            case N.PrivateFieldExpression:
                expr = expr.data.object;
                break;
            case N.TaggedTemplateExpression:
                expr = expr.data.tag;
                break;
            case N.TSNonNullExpression:
                expr = expr.data.expression;
                break;
            default:
                return false;
        }
    }
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
        return parseMemberChain(state, create.NewTarget(start, state.tokStart, 0), true);
    }
    let callee: Node;
    // `new import('m')` is an error but `new (import('m'))` is not, so the test is on the token that
    // OPENS the callee, not on the parsed shape alone — oxc's `is_import` (`js/expression.rs:1009`).
    const calleeIsBareImport = isK(state, K.IMPORT);
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
    // CLAIM THE ANNOTATION BEFORE PARSING ARGUMENTS — see `pureFlag`. `state.pureAt` is one slot, so
    // an annotation inside the arguments overwrites (and then consumes) the outer one.
    const pure = pureFlag(state, start);
    if (isP(state, P.LPAREN)) {
        args = parseArgs(state);
        end = state.tokStart;
    }
    if (calleeIsBareImport && reachesImportExpression(callee)) raise(state, ParseErrorCode.NewDynamicImport);
    const nw = create.NewExpression(start, end, pure, callee, args, typeArgs);
    return parseMemberChain(state, nw, true);
}

function parseArgs(state: ParserState): Node[] {
    const outerCtx = state.ctx;
    state.ctx &= ~CTX.Decorator;
    nextToken(state);
    const from = state.sp;
    while (!isP(state, P.RPAREN) && (state.tok as number) !== T_EOF) {
        if (isP(state, P.DOTDOTDOT)) {
            const s = state.tokStart;
            nextToken(state);
            const arg = parseAssign(state);
            push(state, create.SpreadElement(s, arg.end, 0, arg));
        } else push(state, parseAssign(state));
        if (!eatP(state, P.COMMA)) break;
    }
    expectP(state, P.RPAREN, "')'");
    state.ctx = outerCtx;
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
        if (sawOptional && inCtx(state, CTX.Decorator)) raiseAt(state, e.start, ParseErrorCode.DecoratorOptionalChain);
        return sawOptional ? create.ChainExpression(e.start, e.end, 0, e) : e;
    };
    for (;;) {
        if (!isMemberCont(state.tok)) return finish(expr);
        if (isP(state, P.DOT)) {
            nextToken(state);
            if (state.tok === T_PRIVATE) {
                const prop = parsePrivate(state);
                expr = create.PrivateFieldExpression(expr.start, prop.end, 0, expr, prop);
            } else {
                const prop = parseNameAsIdent(state, R_NAME);
                expr = create.StaticMemberExpression(expr.start, prop.end, 0, expr, prop);
            }
        } else if (isP(state, P.QDOT)) {
            sawOptional = true;
            nextToken(state);
            if (isP(state, P.LPAREN)) {
                if (!allowCall) return finish(expr);
                const pure = pureFlag(state, expr.start);
                const args = parseArgs(state);
                expr = create.CallExpression(expr.start, state.tokStart, FL.OPTIONAL | pure, expr, args, null);
            } else if (isP(state, P.LBRACKET)) {
                nextToken(state);
                const prop = parseExpression(state);
                expectP(state, P.RBRACKET, "']'");
                expr = create.ComputedMemberExpression(expr.start, state.tokStart, FL.OPTIONAL, expr, prop);
            } else if (state.tok === T_PRIVATE) {
                const prop = parsePrivate(state);
                expr = create.PrivateFieldExpression(expr.start, prop.end, FL.OPTIONAL, expr, prop);
            } else {
                const prop = parseNameAsIdent(state, R_NAME);
                expr = create.StaticMemberExpression(expr.start, prop.end, FL.OPTIONAL, expr, prop);
            }
        } else if (isP(state, P.LBRACKET) && !inCtx(state, CTX.Decorator)) {
            nextToken(state);
            const prop = parseExpression(state);
            expectP(state, P.RBRACKET, "']'");
            expr = create.ComputedMemberExpression(expr.start, state.tokStart, 0, expr, prop);
        } else if (allowCall && isP(state, P.LPAREN)) {
            const pure = pureFlag(state, expr.start);
            const args = parseArgs(state);
            expr = create.CallExpression(expr.start, state.tokStart, pure, expr, args, null);
        } else if (state.tok === T_TEMPLATE_FULL || state.tok === T_TEMPLATE_HEAD) {
            if (sawOptional) raise(state, ParseErrorCode.TaggedOptionalChain);
            const quasi = parseTemplate(state, true);
            expr = create.TaggedTemplateExpression(expr.start, quasi.end, 0, expr, quasi);
        } else if (state.tsMode && isP(state, P.BANG) && (state.tokFlags & F_NL) === 0) {
            nextToken(state);
            expr = create.TSNonNullExpression(expr.start, state.tokStart, 0, expr);
        } else if (state.tsMode && allowCall && isP(state, P.LT)) {
            const t = tryParseTypeArgsForCall(state);
            if (t === null) return finish(expr);
            if (isP(state, P.LPAREN)) {
                const pure = pureFlag(state, expr.start);
                const args = parseArgs(state);
                expr = create.CallExpression(expr.start, state.tokStart, pure, expr, args, t);
            } else if (state.tok === T_TEMPLATE_FULL || state.tok === T_TEMPLATE_HEAD) {
                if (sawOptional) raise(state, ParseErrorCode.TaggedOptionalChain);
                const quasi = parseTemplate(state, true);
                expr = create.TaggedTemplateExpression(expr.start, quasi.end, 0, expr, quasi);
            } else {
                // bare instantiation expression `f<number>`: keep the type args as a
                // node so emit strips them. tryParseTypeArgsForCall's follow-set
                // already gated that `<...>` is type args here (not a `<` comparison).
                expr = create.TSInstantiationExpression(expr.start, t.end, 0, expr, t);
            }
        } else return finish(expr);
    }
}

function parsePrivate(state: ParserState): Node {
    const start = state.tokStart;
    const end = state.tokEnd;
    // An escaped private name (`#\u0061`) carries its decoded name on the token, like any other
    // escaped identifier — the source slice would be the escape text.
    const name =
        (state.tokFlags & F_ESCAPED) !== 0 ? internString(state, state.tokCooked) : intern(state, start + 1, end, state.tokHash);
    const id = node(N.PrivateIdentifier, start, end, name, null);
    nextToken(state);
    return id;
}

/** `tagged` decides whether an undefined escape is an error. A tag receives the RAW strings and a
 *  `cooked` of `undefined`, so `tag`\x`` is legal; an untagged template has only the cooked value,
 *  so there is nothing for `` `\x` `` to mean. Only the caller knows which it is, which is why the
 *  lexer records `F_BAD_ESCAPE` per part and the decision happens here. */
function parseTemplate(state: ParserState, tagged: boolean): Node {
    const start = state.tokStart;
    const badEscape = (pos: number) => {
        if (!tagged && (state.tokFlags & F_BAD_ESCAPE) !== 0) raiseAt(state, pos, ParseErrorCode.BadTemplateEscape);
    };
    if (state.tok === T_TEMPLATE_FULL) {
        badEscape(start);
        const q = leaf(state, N.TemplateElement, start + 1, state.tokEnd - 1);
        nextToken(state);
        return create.TemplateLiteral(start, q.end + 1, 0, [q], []);
    }
    const qFrom = state.sp;
    const eFrom: Node[] = [];
    badEscape(start);
    push(state, leaf(state, N.TemplateElement, start + 1, state.tokEnd - 2));
    nextToken(state);
    for (;;) {
        eFrom.push(parseExpression(state));
        if (!isP(state, P.RBRACE)) {
            raise(state, ParseErrorCode.ExpectedRBraceInTemplate);
            break;
        }
        reScanTemplateContinue(state);
        badEscape(state.tokStart);
        if (state.tok === T_TEMPLATE_FULL) {
            push(state, leaf(state, N.TemplateElement, state.tokStart + 1, state.tokEnd - 1));
            nextToken(state);
            break;
        }
        push(state, leaf(state, N.TemplateElement, state.tokStart + 1, state.tokEnd - 2));
        nextToken(state);
    }
    const quasis = finishList(state, qFrom);
    return create.TemplateLiteral(start, state.tokStart, 0, quasis, eFrom);
}

/** Is `c` a valid start char of a JSX identifier (letter / `_` / `$`, or any
 * non-ASCII treated as ident). */
/** Consume `>` WITHOUT lexing past it: what follows is child text, not a token. */
function eatJSXGt(state: ParserState): number {
    if (!isP(state, P.GT)) {
        raise(state, ParseErrorCode.ExpectedInJSX, "'>'");
        return state.tokStart;
    }
    state.pos = state.tokEnd;
    return state.tokEnd;
}

function parseJSXIdentifier(state: ParserState): Node {
    if (!isNameLike(state)) {
        raise(state, ParseErrorCode.ExpectedJSXName);
        return makeMissingIdent(state, R_NAME);
    }
    reScanJSXIdentifier(state);
    const n = node(N.JSXIdentifier, state.tokStart, state.tokEnd, sliceFlat(state, state.tokStart, state.tokEnd), null);
    nextToken(state);
    return n;
}

/** `<a:b>`, `<A.B.C>`, `<this.X>`, or a plain `<div>`. */
function parseJSXElementName(state: ParserState): Node {
    const first = parseJSXIdentifier(state);
    if (isP(state, P.COLON)) {
        nextToken(state);
        return create.JSXNamespacedName(first.start, state.tokStart, 0, first, parseJSXIdentifier(state));
    }
    if (isP(state, P.DOT)) {
        const isThis = first.name === 'this';
        let obj: Node = isThis
            ? recordThis(state, create.ThisExpression(first.start, first.end, 0))
            : ident(state, R_REF, first.start, first.end);
        while (eatP(state, P.DOT)) obj = create.JSXMemberExpression(first.start, state.tokStart, 0, obj, parseJSXIdentifier(state));
        return obj;
    }
    if (first.name === 'this') return recordThis(state, create.ThisExpression(first.start, first.end, 0));
    const c = state.src.charCodeAt(first.start);
    return c >= 65 && c <= 90 ? ident(state, R_REF, first.start, first.end) : first;
}

function parseJSXAttributeName(state: ParserState): Node {
    const first = parseJSXIdentifier(state);
    if (!isP(state, P.COLON)) return first;
    nextToken(state);
    return create.JSXNamespacedName(first.start, state.tokStart, 0, first, parseJSXIdentifier(state));
}

/** `{ … }` in child or attribute position; the current token is `{`. */
function parseJSXBrace(state: ParserState, inChildren: boolean): Node {
    const start = state.tokStart;
    nextToken(state);
    let inner: Node;
    if (isP(state, P.DOTDOTDOT)) {
        nextToken(state);
        const arg = parseAssign(state);
        inner = inChildren
            ? create.JSXSpreadChild(start, state.tokEnd, 0, arg)
            : create.JSXExpressionContainer(start, state.tokEnd, 0, arg);
    } else if (isP(state, P.RBRACE)) {
        inner = create.JSXExpressionContainer(start, state.tokEnd, 0, create.JSXEmptyExpression(start + 1, state.tokStart, 0));
    } else {
        inner = create.JSXExpressionContainer(start, state.tokEnd, 0, parseExpression(state));
    }
    if (!isP(state, P.RBRACE)) raise(state, ParseErrorCode.ExpectedInJSX, "'}'");
    return inner;
}

function parseJSXSpreadAttribute(state: ParserState): Node {
    const start = state.tokStart;
    nextToken(state);
    if (!eatP(state, P.DOTDOTDOT)) raise(state, ParseErrorCode.ExpectedJSXSpread);
    const arg = parseAssign(state);
    const n = create.JSXSpreadAttribute(start, state.tokEnd, 0, arg);
    if (!isP(state, P.RBRACE)) raise(state, ParseErrorCode.ExpectedInJSX, "'}'");
    nextToken(state);
    return n;
}

function parseJSXAttributes(state: ParserState): Node[] {
    const from = state.sp;
    while (!isP(state, P.GT) && !isP(state, P.SLASH) && (state.tok as number) !== T_EOF) {
        if (isP(state, P.LBRACE)) {
            push(state, parseJSXSpreadAttribute(state));
            continue;
        }
        if (!isNameLike(state)) {
            raise(state, ParseErrorCode.UnexpectedCharInJSXAttrs);
            nextToken(state);
            continue;
        }
        const name = parseJSXAttributeName(state);
        let value: Ref = null;
        let end = state.tokStart;
        if (isP(state, P.EQ)) {
            nextJSXAttributeValue(state);
            if ((state.tok as number) === T_STR) {
                value = leafRaw(state, N.StringLiteral, state.tokStart, state.tokEnd);
                end = state.tokEnd;
                nextToken(state);
            } else if (isP(state, P.LBRACE)) {
                value = parseJSXBrace(state, false);
                end = state.tokEnd;
                nextToken(state);
            } else if (isP(state, P.LT)) {
                value = parseJSXElement(state);
                end = value.end;
                nextToken(state);
            } else raise(state, ParseErrorCode.ExpectedJSXAttrValue);
        }
        push(state, create.JSXAttribute(name.start, end, 0, name, value));
    }
    return finishList(state, from);
}

/** Children of an element whose `>` has just been consumed. Leaves the token on the closing `<`. */
function parseJSXChildren(state: ParserState): Node[] {
    const from = state.sp;
    for (;;) {
        nextJSXChild(state);
        if ((state.tok as number) === T_JSX_TEXT) {
            push(state, node(N.JSXText, state.tokStart, state.tokEnd, sliceFlat(state, state.tokStart, state.tokEnd), null));
            continue;
        }
        if ((state.tok as number) === T_EOF) {
            raise(state, ParseErrorCode.UnterminatedJSXElement);
            break;
        }
        if (isP(state, P.LBRACE)) {
            push(state, parseJSXBrace(state, true));
            continue;
        }
        if (state.src.charCodeAt(state.tokStart + 1) === 47) break;
        push(state, parseJSXElement(state));
    }
    return from === state.sp ? [] : finishList(state, from);
}

/** An element or fragment whose `<` is the current token. Leaves the token AFTER the closing `>`. */
function parseJSXElement(state: ParserState): Node {
    const start = state.tokStart;
    nextToken(state);
    if (isP(state, P.GT)) {
        const open = create.JSXOpeningFragment(start, eatJSXGt(state), 0);
        const children = parseJSXChildren(state);
        const closeStart = state.tokStart;
        nextToken(state);
        expectP(state, P.SLASH, "'/'");
        const end = eatJSXGt(state);
        return create.JSXFragment(start, end, 0, open, children, create.JSXClosingFragment(closeStart, end, 0));
    }
    const name = parseJSXElementName(state);
    let typeArgs: Ref = null;
    if (state.tsMode && isP(state, P.LT)) {
        const ta = tryParseTypeArgsInType(state);
        if (ta !== null) typeArgs = ta;
    }
    const attrs = parseJSXAttributes(state);
    if (eatP(state, P.SLASH)) {
        const end = eatJSXGt(state);
        return create.JSXElement(start, end, 0, create.JSXOpeningElement(start, end, 0, name, typeArgs, attrs), [], null);
    }
    const open = create.JSXOpeningElement(start, eatJSXGt(state), 0, name, typeArgs, attrs);
    const children = parseJSXChildren(state);
    const closeStart = state.tokStart;
    nextToken(state);
    expectP(state, P.SLASH, "'/'");
    const closeName = parseJSXElementName(state);
    const end = eatJSXGt(state);
    return create.JSXElement(start, end, 0, open, children, create.JSXClosingElement(closeStart, end, 0, closeName));
}

function parseJSXRoot(state: ParserState): Node {
    state.sawJSX = true;
    const n = parseJSXElement(state);
    nextToken(state);
    return n;
}

function parsePrimary(state: ParserState): Node {
    const start = state.tokStart;
    switch (state.tok as number) {
        case P.AT: {
            const decorators = parseDecorators(state);
            if (isK(state, K.CLASS)) return parseClass(state, true, 0, start, decorators);
            raise(state, ParseErrorCode.DecoratorsUnsupported);
            return parsePrimary(state);
        }
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
            return parseTemplate(state, false);
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
                        push(state, create.SpreadElement(s, arg.end, 0, arg));
                    } else push(state, parseAssign(state));
                    if (!isP(state, P.RBRACKET)) expectP(state, P.COMMA, "','");
                    if (noProgress(state, mark)) break;
                }
                expectP(state, P.RBRACKET, "']'");
                return create.ArrayExpression(start, state.tokStart, 0, finishListWithHoles(state, from));
            }
            case P.LBRACE:
                return parseObjectLiteral(state);
        }
    } else if (isKeyword(state.tok)) {
        switch (state.tok as number) {
            case K.THIS:
                nextToken(state);
                return recordThis(state, create.ThisExpression(start, state.tokStart, 0));
            case K.SUPER:
                nextToken(state);
                return create.Super(start, state.tokStart, 0);
            case K.TRUE:
                nextToken(state);
                return create.BooleanLiteral(start, state.tokStart, 1);
            case K.FALSE:
                nextToken(state);
                return create.BooleanLiteral(start, state.tokStart, 0);
            case K.NULL:
                nextToken(state);
                return create.NullLiteral(start, state.tokStart, 0);
            case K.FUNCTION:
                return parseFunction(state, false, false, true, false);
            case K.ASYNC:
                nextToken(state);
                if (isK(state, K.FUNCTION)) return parseFunction(state, true, false, true, false);
                return ident(state, R_REF, start, start + 5);
            case K.CLASS:
                return parseClass(state, true, 0);
            case K.IMPORT: {
                nextToken(state);
                if (!isP(state, P.DOT)) return parseImportCall(state, start, null);
                // oxc's `parse_import_meta_or_call` (`js/expression.rs:676`): `meta` is the only
                // property; `source` and `defer` are the import-PHASE proposal and are not properties
                // at all — each must be followed by a call, so they route into the same call parser.
                nextToken(state);
                if (isK(state, K.SOURCE)) {
                    nextToken(state);
                    return parseImportCall(state, start, 'source');
                }
                if (isK(state, K.DEFER)) {
                    nextToken(state);
                    return parseImportCall(state, start, 'defer');
                }
                const prop = parseNameAsIdent(state, R_NAME);
                if (prop.name !== 'meta') raise(state, ParseErrorCode.InvalidImportProperty);
                else if (!state.allowImportMeta) raise(state, ParseErrorCode.ImportMetaOutsideModule);
                state.sawImportSyntax = true;
                return create.ImportMeta(start, state.tokStart, 0);
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
            push(state, create.SpreadElement(s, arg.end, 0, arg));
        } else push(state, parseObjectMember(state));
        if (!isP(state, P.RBRACE)) expectP(state, P.COMMA, "','");
    }
    expectP(state, P.RBRACE, "'}'");
    return create.ObjectExpression(start, state.tokStart, 0, finishList(state, from));
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
    } else if (state.tok === T_NUM || (state.tok as number) === T_BIGINT) {
        key = leaf(state, (state.tok as number) === T_BIGINT ? N.BigIntLiteral : N.NumericLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    } else key = parseNameAsIdent(state, R_NAME);

    if (kind !== 0 || async || generator || isP(state, P.LPAREN)) {
        const fn = parseMethodTail(state, start, (async ? FL.ASYNC : 0) | (generator ? FL.GENERATOR : 0));
        flags |= kind << FL.KIND_SHIFT;
        // `get`/`set` already print in shorthand form off `kind`; FL.METHOD marks the plain
        // `{ m(){} }` case so the printer does not degrade it to `{ m: function(){} }`.
        if (kind === 0) flags |= FL.METHOD;
        return create.ObjectProperty(start, fn.end, flags, key, fn);
    }
    if (isP(state, P.COLON)) {
        nextToken(state);
        const value = parseAssign(state);
        return create.ObjectProperty(start, value.end, flags, key, value);
    }
    checkShorthandName(state, key);
    const shorthandRef = identNamed(state, R_REF, key.start, key.end, key.name);
    if (isP(state, P.EQ)) {
        nextToken(state);
        const right = parseAssign(state);
        const value = create.AssignmentPattern(key.start, right.end, 0, shorthandRef, right);
        return create.ObjectProperty(start, right.end, flags | FL.SHORTHAND, key, value);
    }
    return create.ObjectProperty(start, key.end, flags | FL.SHORTHAND, key, shorthandRef);
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
    const isAsync = (flags & FL.ASYNC) !== 0;
    const isGenerator = (flags & FL.GENERATOR) !== 0;
    let typeParams: Ref = null;
    let params: Node[] = EMPTY_LIST;
    let returnType: Ref = null;
    let body: Ref = null;
    // A method has no name to place, but its PARAMETERS are the function's own just as a function
    // declaration's are — `class C { *m(yield) {} }` is an error — so the head shares the body's
    // scope here for the same reason it does in `parseFunction`.
    inFunctionScope(
        state,
        isAsync,
        () => {
            if (state.tsMode && isP(state, P.LT)) {
                const t = tryParseTypeParams(state);
                if (t !== null) typeParams = t;
            }
            params = parseParams(state);
            if (state.tsMode && isP(state, P.COLON)) returnType = parseTypeAnn(state);
            if (isP(state, P.LBRACE)) body = parseBlock(state);
            else consumeSemi(state);
        },
        false,
        isGenerator,
    );
    return create.FunctionExpression(start, state.tokStart, flags, null, typeParams, params, returnType, body);
}

// Arrow disambiguation, ported from oxc's `is_parenthesized_arrow_function_expression`
// (`oxc_parser/src/js/arrow.rs:58`).
//
// This replaces `arrowAheadFromParen`, which bracket-matched forward over raw CHARACTERS to find the
// closing `)` and then looked for `=>` behind it. That scan hand-rolled string and comment skipping
// but had no case for regex literals, so a `/` fell through and the brackets INSIDE the regex were
// counted as structure: `(x = /[)]/) => x` — valid JS — matched the wrong paren and was rejected.
// Six such shapes were failing. Classifying TOKENS instead of characters cannot have that class of
// bug, because deciding what a `/` starts is the lexer's job and it already does it.
//
// The shape is oxc's: decide from the head in at most four tokens, and only speculate when the head
// is genuinely ambiguous.
const TRI_FALSE = 0;
const TRI_TRUE = 1;
const TRI_MAYBE = 2;

/** oxc's `Kind::is_literal` (`lexer/kind.rs:310`). Templates are deliberately NOT in it. */
function isLiteralTok(tok: number): boolean {
    return (
        tok === T_NUM ||
        tok === T_BIGINT ||
        tok === T_STR ||
        tok === T_REGEX ||
        tok === K.TRUE ||
        tok === K.FALSE ||
        tok === K.NULL
    );
}

/** What `isIdentLike` asks, against a saved token rather than the current one. */
const isBindingIdentTok = (tok: number): boolean => tok === T_IDENT || isContextual(tok);

/**
 * oxc's `Kind::is_modifier_kind` (`lexer/kind.rs:429`), less `public`/`private`/`protected`/`out`,
 * which we do not tokenise as keywords — they reach here as plain identifiers. The only thing that
 * costs is error QUALITY on already-invalid code: oxc calls `(public x` an arrow so it can complain
 * about the modifier, where we call it a parenthesized expression and complain differently. Both
 * reject it.
 */
function isModifierTok(tok: number): boolean {
    return (
        tok === K.ABSTRACT ||
        tok === K.ACCESSOR ||
        tok === K.ASYNC ||
        tok === K.CONST ||
        tok === K.DECLARE ||
        tok === K.IN ||
        tok === K.OVERRIDE ||
        tok === K.READONLY ||
        tok === K.STATIC ||
        tok === K.DEFAULT ||
        tok === K.EXPORT
    );
}

/**
 * Does an arrow parameter list start at the current `(`? `TRI_TRUE` and `TRI_FALSE` are certain;
 * `TRI_MAYBE` means the caller must speculate.
 *
 * Always rewinds — oxc's `lookahead` (`cursor.rs:338`) is likewise just checkpoint + predicate +
 * rewind. What makes it cheap is not the rewind but the work skipped: at most four tokens are lexed,
 * nothing is allocated, and no AST is built.
 *
 * oxc enters the same table from `(`, `async` and `<`; our three call sites strip `async` and any
 * type parameters themselves, so they all arrive here at the `(`.
 */
function classifyArrowHead(state: ParserState): number {
    // Saved as SCALARS rather than through `saveState`, which allocates an eight-element array. This
    // runs on every paren-led expression, and the worker cannot do anything an array would be needed
    // for: it only lexes. `raise` does not throw (it records, sets `fatal` and jumps to EOF), so the
    // two error fields are restored the same way and nothing can escape before the restore.
    const pos = state.pos;
    const tok = state.tok;
    const tokStart = state.tokStart;
    const tokEnd = state.tokEnd;
    const tokFlags = state.tokFlags;
    const tokHash = state.tokHash;
    const errorCount = state.errors.length;
    const fatal = state.fatal;

    const verdict = classifyArrowHeadWorker(state);

    state.pos = pos;
    state.tok = tok;
    state.tokStart = tokStart;
    state.tokEnd = tokEnd;
    state.tokFlags = tokFlags;
    state.tokHash = tokHash;
    state.errors.length = errorCount;
    state.fatal = fatal;
    return verdict;
}

function classifyArrowHeadWorker(state: ParserState): number {
    nextToken(state); // past `(`
    const second = state.tok;

    if (second === P.RPAREN) {
        nextToken(state);
        // `(): T => …` — the return type cannot be told from a conditional's `:` without parsing.
        if (state.tsMode && isP(state, P.COLON)) return TRI_MAYBE;
        // `() {` is not an arrow, but it is almost certainly what was meant, so parse it as one and
        // let the error land on the missing `=>` instead of on the block.
        return isP(state, P.ARROW) || isP(state, P.LBRACE) ? TRI_TRUE : TRI_FALSE;
    }
    // `([a])` / `({a})` — a destructuring parameter, or an ordinary parenthesized expression.
    if (second === P.LBRACKET || second === P.LBRACE) return TRI_MAYBE;
    if (second === P.DOTDOTDOT) {
        nextToken(state);
        // `T_IDENT` and not `isBindingIdentTok`, matching oxc's `Kind::Ident` exactly (`arrow.rs:122`).
        // A contextual keyword after the dots — `(...async`, `(...yield`, `(...type` — is a valid
        // binding, but oxc still routes it through `Maybe` rather than committing, so we do too.
        if (state.tok === T_IDENT) return TRI_TRUE; // `(...rest` is a lambda
        if (isLiteralTok(state.tok)) return TRI_FALSE; // `(...null` is not
        return TRI_MAYBE;
    }

    nextToken(state);
    const third = state.tok;

    // `(xxx yyy` with xxx a modifier: not legal, but treating it as a lambda gives the better error.
    // `(readonly as string)` is the exception — an `as` expression, not a parameter list.
    // https://github.com/microsoft/TypeScript/issues/44466
    if (isModifierTok(second) && second !== K.ASYNC && isBindingIdentTok(third)) {
        return third === K.AS ? TRI_FALSE : TRI_TRUE;
    }
    // A `(` followed by anything that cannot begin a binding is not a parameter list. `this` is not a
    // valid parameter either, but it is parsed as one so the complaint is semantic, not syntactic.
    // This subsumes `(1 + a)`, `("s")` and every other literal-led parenthesized expression.
    if (!isBindingIdentTok(second) && second !== K.THIS) return TRI_FALSE;

    if (third === P.COLON) return TRI_TRUE; // `(a:` — a type-annotated parameter
    if (third === P.QUESTION) {
        // `(a?:`, `(a?,`, `(a?=`, `(a?)` are lambdas; `(a ? b : c)` is a conditional.
        nextToken(state);
        const fourth = state.tok;
        return fourth === P.COLON || fourth === P.COMMA || fourth === P.EQ || fourth === P.RPAREN
            ? TRI_TRUE
            : TRI_FALSE;
    }
    if (third === P.COMMA || third === P.EQ || third === P.RPAREN) return TRI_MAYBE;
    return TRI_FALSE;
}

/**
 * oxc's `LAngle` arm (`js/arrow.rs:176-207`): does `<` begin an arrow's TYPE PARAMETERS, or a JSX
 * element?
 *
 * Outside JSX there is no contest — `<` can only be type parameters, so this is `Maybe` and the
 * caller speculates. **Inside JSX the default flips**: `<T>` is a JSX element, and only `extends`,
 * `=` or `,` after the name can make it an arrow. That is exactly why TypeScript makes you write
 * `<T,>` in a `.tsx` file, and why `<T>(x: T) => x` is a generic arrow in `.ts` and an unclosed JSX
 * tag in `.tsx`. We used to run `tryParseTypeParams` unconditionally and so read the `.tsx` form as
 * an arrow.
 */
function classifyAngleArrowHead(state: ParserState): number {
    const pos = state.pos;
    const tok = state.tok;
    const tokStart = state.tokStart;
    const tokEnd = state.tokEnd;
    const tokFlags = state.tokFlags;
    const tokHash = state.tokHash;
    const errorCount = state.errors.length;
    const fatal = state.fatal;

    const verdict = classifyAngleArrowHeadWorker(state);

    state.pos = pos;
    state.tok = tok;
    state.tokStart = tokStart;
    state.tokEnd = tokEnd;
    state.tokFlags = tokFlags;
    state.tokHash = tokHash;
    state.errors.length = errorCount;
    state.fatal = fatal;
    return verdict;
}

function classifyAngleArrowHeadWorker(state: ParserState): number {
    nextToken(state); // past `<`
    const second = state.tok;
    // `<` not followed by a name is never a type-parameter list.
    if (!isBindingIdentTok(second) && second !== K.CONST) return TRI_FALSE;
    if (!state.jsxMode) return TRI_MAYBE;

    if (second === K.CONST) nextToken(state); // `<const T …>`
    nextToken(state); // past the parameter name
    const third = state.tok;
    if (third === K.EXTENDS) {
        nextToken(state);
        const fourth = state.tok;
        // `<T extends>` / `<T extends=` / `<T extends/` are malformed JSX, not constraints.
        if (fourth === P.EQ || fourth === P.GT || fourth === P.SLASH) return TRI_FALSE;
        return isBindingIdentTok(fourth) ? TRI_MAYBE : TRI_TRUE;
    }
    // `<T,>` — the disambiguating trailing comma — and `<T = U>` are arrows. Anything else is JSX.
    return third === P.EQ || third === P.COMMA ? TRI_TRUE : TRI_FALSE;
}

function rememberNotArrow(state: ParserState, pos: number): void {
    if (state.notArrow === null) state.notArrow = new Set();
    state.notArrow.add(pos);
}

/**
 * The `TRI_MAYBE` path: oxc's `parse_possible_parenthesized_arrow_function_expression`
 * (`arrow.rs:349`). Parses the head for real and, when it works out, KEEPS it — the old code parsed
 * the parameter list speculatively, threw it away, and parsed it again.
 *
 * `allowReturnType` is oxc's `allow_return_type_in_arrow_function`. It exists for
 *
 *     x ? y => ({ y }) : z => ({ z })
 *
 * where parsing the first arrow's body reaches `({ y })` and `({ y }) : z => ({ z })` is a perfectly
 * good arrow with return type `z` — the wrong parse, because that `:` belongs to the conditional. In
 * a conditional's consequent a return type is therefore inadmissible, UNLESS another `:` follows
 * (`a ? (x): string => x : null`), which means the second colon is the conditional's and the first
 * really was a return type.
 */
function tryParseArrow(
    state: ParserState,
    start: number,
    flags: number,
    typeParams: Ref,
    allowReturnType: boolean,
): Node | null {
    const pos = state.tokStart;
    if (state.notArrow !== null && state.notArrow.has(pos)) return null;
    const s = saveState(state);

    let params: Node[] | null = null;
    let returnType: Ref = null;
    try {
        params = parseArrowParams(state, flags);
        if (state.tsMode && isP(state, P.COLON)) returnType = parseTypeAnn(state);
    } catch {
        params = null;
    }
    if (params === null || state.fatal || !isP(state, P.ARROW)) {
        rememberNotArrow(state, pos);
        restoreState(state, s);
        return null;
    }
    nextToken(state); // past `=>`
    const arrow = parseArrowBody(state, start, flags, typeParams, params, returnType, allowReturnType);
    // Checked AFTER the body, as oxc does: whether the trailing `:` exists is only known by then.
    if (!allowReturnType && returnType !== null && !isP(state, P.COLON)) {
        rememberNotArrow(state, pos);
        restoreState(state, s);
        return null;
    }
    return arrow;
}

/** The certain (`TRI_TRUE`) path: the head is known to be a parameter list, so nothing is saved. */
/**
 * An async arrow's PARAMETERS are already inside its async context, so `await` is reserved there:
 * `async (await) => 1` is a syntax error while `(await) => 1` is not. oxc unions the await context
 * before `parse_formal_parameters` (`js/arrow.rs:261-262`). `fnDepth` rides along because
 * `parseIdent`'s guard uses it to stay permissive for top-level script `var await = 1`.
 *
 * Shared by the certain and speculative paths — `async (await) => 1` classifies as `Maybe` (`(a)` is
 * ambiguous), so putting this only in `parseArrow` would have missed the case it was written for.
 */
function parseArrowParams(state: ParserState, flags: number): Node[] {
    if ((flags & FL.ASYNC) === 0) return parseParams(state);
    const outerCtx = state.ctx;
    state.ctx |= CTX.Await;
    state.fnDepth++;
    const params = parseParams(state);
    state.fnDepth--;
    state.ctx = outerCtx;
    return params;
}

function parseArrow(state: ParserState, start: number, flags: number, typeParams: Ref, allowReturnType: boolean): Node {
    const params = parseArrowParams(state, flags);
    let returnType: Ref = null;
    if (state.tsMode && isP(state, P.COLON)) returnType = parseTypeAnn(state);
    expectP(state, P.ARROW, "'=>'");
    return parseArrowBody(state, start, flags, typeParams, params, returnType, allowReturnType);
}

/** Everything after the `=>`, shared by the certain and speculative paths. */
function parseArrowBody(
    state: ParserState,
    start: number,
    flags: number,
    typeParams: Ref,
    params: Node[],
    returnType: Ref,
    allowReturnType: boolean,
): Node {
    const isAsync = (flags & FL.ASYNC) !== 0;
    let exprBody = false;
    const body: Node = inFunctionScope(
        state,
        isAsync,
        () => {
            if (isP(state, P.LBRACE)) return parseBlock(state);
            exprBody = true;
            // The flag rides through the body: in `x ? y => (a) : z => (b)` the offending `:` is
            // reached from INSIDE the first arrow's body, not from the conditional directly.
            return parseAssign(state, false, allowReturnType);
        },
        true,
    );
    if (exprBody) flags |= FL.EXPR_BODY;
    return create.ArrowFunctionExpression(start, body.end, flags, typeParams, params, returnType, body);
}

function parseArrowAfterSingleParam(
    state: ParserState,
    start: number,
    id: Identifier,
    flags: number,
    identStart: number,
    allowReturnType: boolean,
): Node {
    // `identStart` is the parameter's own start, which differs from the arrow's only for `async x =>`
    // — there `start` is the `async`. Passed explicitly rather than defaulted: both call sites know
    // it, and an optional parameter on a hot path is arity the shape check has to carry.
    const param = create.FormalParameter(identStart, id.end, 0, id, null, null);
    expectP(state, P.ARROW, "'=>'");
    const isAsync = (flags & FL.ASYNC) !== 0;
    let exprBody = false;
    const body: Node = inFunctionScope(
        state,
        isAsync,
        () => {
            if (isP(state, P.LBRACE)) return parseBlock(state);
            exprBody = true;
            return parseAssign(state, false, allowReturnType);
        },
        true,
    );
    if (exprBody) flags |= FL.EXPR_BODY;
    return create.ArrowFunctionExpression(start, body.end, flags, null, [param], null, body);
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
                push(state, create.RestElement(s, arg.end, 0, arg, null));
                if (isP(state, P.COMMA) && !inCtx(state, CTX.Ambient)) {
                    raiseRestNotLast(state, P.RBRACKET, ParseErrorCode.RestElementLast);
                }
            } else push(state, parseBindingElement(state));
            if (!isP(state, P.RBRACKET)) expectP(state, P.COMMA, "','");
            if (noProgress(state, mark)) break;
        }
        expectP(state, P.RBRACKET, "']'");
        return create.ArrayPattern(start, state.tokStart, 0, finishListWithHoles(state, from));
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
                if (arg.type !== N.BindingIdentifier) raise(state, ParseErrorCode.InvalidBindingRestTarget);
                push(state, create.RestElement(s, arg.end, 0, arg, null));
                if (isP(state, P.COMMA) && !inCtx(state, CTX.Ambient)) {
                    raiseRestNotLast(state, P.RBRACE, ParseErrorCode.RestElementLast);
                }
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
                } else if (state.tok === T_NUM || (state.tok as number) === T_BIGINT) {
                    key = leaf(state, (state.tok as number) === T_BIGINT ? N.BigIntLiteral : N.NumericLiteral, state.tokStart, state.tokEnd);
                    nextToken(state);
                } else key = parseNameAsIdent(state, R_NAME);
                let value: Node;
                if (isP(state, P.COLON)) {
                    nextToken(state);
                    value = parseBindingElement(state);
                } else if (isP(state, P.EQ)) {
                    checkShorthandName(state, key);
                    nextToken(state);
                    const right = parseAssign(state);
                    const bound = identNamed(state, R_BIND, key.start, key.end, key.name);
                    value = create.AssignmentPattern(key.start, right.end, 0, bound, right);
                    flags |= FL.SHORTHAND;
                } else {
                    checkShorthandName(state, key);
                    // Same as the expression path above: the key was cooked while its token was
                    // current, and re-deriving here would intern the raw escaped slice instead.
                    value = identNamed(state, R_BIND, key.start, key.end, key.name);
                    flags |= FL.SHORTHAND;
                }
                push(state, create.ObjectProperty(s, value.end, flags, key, value));
            }
            if (!isP(state, P.RBRACE)) expectP(state, P.COMMA, "','");
            if (noProgress(state, mark)) break;
        }
        expectP(state, P.RBRACE, "'}'");
        return create.ObjectPattern(start, state.tokStart, 0, finishList(state, from));
    }
    return parseIdent(state, R_BIND);
}

function parseBindingElement(state: ParserState): Node {
    const target = parseBindingTarget(state);
    if (isP(state, P.EQ)) {
        nextToken(state);
        const right = parseAssign(state);
        return create.AssignmentPattern(target.start, right.end, 0, target, right);
    }
    return target;
}

/** The current token is the comma after a rest element; only what follows it picks the message. */
function raiseRestNotLast(state: ParserState, close: number, notLast: ParseErrorCode): void {
    const saved = saveState(state);
    nextToken(state);
    const trailing = isP(state, close);
    restoreState(state, saved);
    raise(state, trailing ? ParseErrorCode.RestTrailingComma : notLast);
}

function parseParams(state: ParserState): Node[] {
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
                else if (isAccessModifier(state) && !nextIsParamNameEnd(state)) {
                    flags |= accessLevelOf(state.tok) << FL.ACCESS_SHIFT;
                    nextToken(state);
                } else break;
            }
        }
        let isRest = false;
        if (isP(state, P.DOTDOTDOT)) {
            isRest = true;
            nextToken(state);
            const arg = parseBindingTarget(state);
            let typeAnn: Ref = null;
            if (state.tsMode && isP(state, P.COLON)) typeAnn = parseTypeAnn(state);
            push(state, create.RestElement(start, state.tokStart, 0, arg, typeAnn));
        } else if (isK(state, K.THIS) && state.tsMode) {
            const t = ident(state, R_BIND, state.tokStart, state.tokEnd);
            nextToken(state);
            let typeAnn: Ref = null;
            if (isP(state, P.COLON)) typeAnn = parseTypeAnn(state);
            push(state, create.FormalParameter(start, state.tokStart, 0, t, typeAnn, null));
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
            push(state, create.FormalParameter(start, state.tokStart, flags, pattern, typeAnn, init));
        }
        // A rest parameter ends the list: neither another parameter nor even a trailing comma may
        // follow it. One check here covers every function form — declarations, expressions, methods,
        // arrows, async generators — because they all parse parameters through here, which is why
        // test262 counts this as hundreds of separate failures. oxc raises the same two in its PARSER
        // (`js/function.rs:118-131`); the neighbouring duplicate-parameter and strict-body rules are
        // `ctx.strict_mode()` checks in oxc_semantic and are deliberately NOT done here.
        if (isRest && isP(state, P.COMMA) && !inCtx(state, CTX.Ambient)) raiseRestNotLast(state, P.RPAREN, ParseErrorCode.RestParameterLast);
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

function parseFunction(state: ParserState, async: boolean, isDecl: boolean, isExpr: boolean, single: boolean): Node {
    const start = state.tokStart;
    nextToken(state);
    let flags = async ? FL.ASYNC : 0;
    if (isP(state, P.STAR)) {
        flags |= FL.GENERATOR;
        nextToken(state);
    }
    const isAsync = (flags & FL.ASYNC) !== 0;
    const isGenerator = (flags & FL.GENERATOR) !== 0;
    // A plain `function` in a statement-only position is Annex B and stays legal — oxc accepts it and
    // leaves the strict-mode case to `check_function_declaration`. An async function or a generator
    // has no such allowance, so those ARE parser errors. `async` wins the ordering when both apply,
    // matching oxc (`if (x) async function* g(){}` reports the async one).
    if (single) {
        if (isAsync) raise(state, ParseErrorCode.AsyncFnSingleStatement);
        else if (isGenerator) raise(state, ParseErrorCode.GeneratorSingleStatement);
    }
    let id: Ref = null;
    // A DECLARATION's name is bound in the ENCLOSING context, so it is read before the function is
    // entered: `function* yield() {}` is legal at the top level and an error inside a generator.
    //   FunctionDeclaration / GeneratorDeclaration : function [*] BindingIdentifier[?Yield, ?Await]
    if (isDecl && !isExpr && isIdentLike(state)) id = parseIdent(state, R_BIND);
    let typeParams: Ref = null;
    let params: Node[] = EMPTY_LIST;
    let returnType: Ref = null;
    let body: Ref = null;
    // Everything else — an EXPRESSION's name, the parameters, the body — is read inside the
    // function's OWN context, which is what the grammar's parameter lists say:
    //   GeneratorExpression      : function * BindingIdentifier[+Yield, ~Await]
    //   AsyncFunctionExpression  : async function BindingIdentifier[~Yield, +Await]
    //   UniqueFormalParameters[?Yield, ?Await]  — always the function's own
    // so `(function* yield(){})` and `function* g(yield){}` are errors while
    // `function* g() { (function yield(){}) }` and `function* g() { function inner(yield){} }` are
    // not. Reading the enclosing context for an expression's name rejected 3 valid test262 programs.
    inFunctionScope(
        state,
        isAsync,
        () => {
            if (id === null && isIdentLike(state)) id = parseIdent(state, R_BIND);
            if (state.tsMode && isP(state, P.LT)) {
                const t = tryParseTypeParams(state);
                if (t !== null) typeParams = t;
            }
            params = parseParams(state);
            if (state.tsMode && isP(state, P.COLON)) returnType = parseTypeAnn(state);
            if (isP(state, P.LBRACE)) body = parseBlock(state);
            else consumeSemi(state);
        },
        false,
        isGenerator,
    );
    return isDecl && !isExpr
        ? create.FunctionDeclaration(start, state.tokStart, flags, id, typeParams, params, returnType, body)
        : create.FunctionExpression(start, state.tokStart, flags, id, typeParams, params, returnType, body);
}

function parseDecorators(state: ParserState): Node[] {
    if (!isP(state, P.AT)) return EMPTY_LIST;
    const from = state.sp;
    while (isP(state, P.AT)) push(state, parseDecorator(state));
    return finishList(state, from);
}

function parseDecorator(state: ParserState): Node {
    state.sawUnbundlable = true;
    const start = state.tokStart;
    nextToken(state);
    const outerCtx = state.ctx;
    state.ctx |= CTX.Decorator;
    const expr = parseMemberChain(state, parsePrimary(state), true);
    state.ctx = outerCtx;
    return create.Decorator(start, expr.end, 0, expr);
}

function parseClass(state: ParserState, isExpr: boolean, extraFlags: number, startOverride = -1, decorators: Node[] = EMPTY_LIST): Node {
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
                expr = create.TSQualifiedName(s, r.end, 0, expr, r);
            }
            let targs: Ref = null;
            if (isP(state, P.LT)) {
                const t = tryParseTypeArgsInType(state);
                if (t !== null) targs = t;
            }
            push(state, create.TSClassImplements(s, state.tokStart, 0, expr, targs));
        } while (eatP(state, P.COMMA));
    }
    const impls = finishList(state, implFrom);
    state.thisDepth++;
    const body = parseClassBody(state);
    state.thisDepth--;
    return isExpr
        ? create.ClassExpression(start, state.tokStart, extraFlags, decorators, id, typeParams, superClass, superTypeArgs, impls, body)
        : create.ClassDeclaration(start, state.tokStart, extraFlags, decorators, id, typeParams, superClass, superTypeArgs, impls, body);
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

const nameIs = (state: ParserState, key: Node, name: string): boolean => {
    const from = key.type === N.StringLiteral ? key.start + 1 : key.start;
    return key.end - key.start === name.length + (key.type === N.StringLiteral ? 2 : 0) && state.src.startsWith(name, from);
};

function parseClassMember(state: ParserState): Node {
    const start = state.tokStart;
    const decorators = parseDecorators(state);
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
                // A static block is not an async context — `CTX.Await` stays clear so `await x` does
                // not parse as an AwaitExpression — but `await` IS reserved as an identifier there,
                // which `staticBlockDepth` carries instead. oxc splits the same pair across two
                // crates: its parser sets `[+Await]` (giving the identifier rule) and its checker
                // raises `class_static_block_await` for the expression. Having no checker, shakeup
                // keeps both in the parser, which is the call `parse-top-level-await.test.ts`
                // already recorded for the expression half.
                state.staticBlockDepth++;
                const outerCtx = state.ctx;
                state.ctx &= ~CTX.Await;
                const b = parseBlock(state);
                state.ctx = outerCtx;
                state.staticBlockDepth--;
                state.newTargetDepth--;
                const body = (b as Extract<Node, { type: typeof N.BlockStatement }>).data.body;
                return create.StaticBlock(start, state.tokStart, 0, body);
            }
            restoreState(state, s);
            flags |= FL.STATIC;
            nextToken(state);
        } else if (isAccessModifier(state) && !nextIsPropertyEnd(state)) {
            flags |= accessLevelOf(state.tok) << FL.ACCESS_SHIFT;
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
                const param = create.FormalParameter(name.start, state.tokStart, 0, name, keyAnn, null);
                expectP(state, P.RBRACKET, "']'");
                let ann: Ref = null;
                if (isP(state, P.COLON)) ann = parseTypeAnn(state);
                consumeSemi(state);
                return create.TSIndexSignature(start, state.tokStart, flags & FL.READONLY, param, ann);
            }
            restoreState(state, s);
        }
        flags |= FL.COMPUTED;
        key = parseAssign(state);
        expectP(state, P.RBRACKET, "']'");
    } else if ((state.tok as number) === T_STR) {
        key = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    } else if (state.tok === T_NUM || (state.tok as number) === T_BIGINT) {
        key = leaf(state, (state.tok as number) === T_BIGINT ? N.BigIntLiteral : N.NumericLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    } else if (state.tok === T_PRIVATE) key = parsePrivate(state);
    else key = parseNameAsIdent(state, R_NAME);

    // The class's own constructor: an un-computed, NON-STATIC member literally named `constructor`.
    // `static constructor(){}` is an ordinary method that happens to share the name, and marking it
    // kind 3 made a static method claim the constructor slot.
    const namedConstructor =
        (flags & (FL.STATIC | FL.COMPUTED)) === 0 &&
        (key.type === N.IdentifierName || key.type === N.StringLiteral) &&
        nameIs(state, key, 'constructor');
    if (kind === 0 && namedConstructor) kind = 3;
    // Early errors on the constructor's FORM (oxc `diagnostics.rs:547,603` and the class checker).
    // The grammar happily parses each of these; only the name makes them illegal.
    // `#constructor` is reserved outright — static or not, method or field (`diagnostics.rs:534`).
    if (key.type === N.PrivateIdentifier && nameIs(state, key, '#constructor'))
        raise(state, ParseErrorCode.PrivateNameConstructor);
    if (namedConstructor) {
        if (generator) raise(state, ParseErrorCode.ConstructorGenerator);
        else if (async) raise(state, ParseErrorCode.ConstructorAsync);
        else if (kind === 1 || kind === 2) raise(state, ParseErrorCode.ConstructorAccessor);
    }
    // The mirror of `namedConstructor`: a STATIC element named `prototype`, which would shadow the
    // one the class already has. Same three gates for the same reasons — a computed key is not
    // statically known (`static ["prototype"]` is legal), and a private name is a different
    // namespace (`static #prototype` is legal). oxc checks it at both its property and method sites
    // (`js/class.rs:727,829`) and exempts an ambient declaration, which is why `declare` passes.
    if (
        (flags & (FL.STATIC | FL.COMPUTED)) === FL.STATIC &&
        (key.type === N.IdentifierName || key.type === N.StringLiteral) &&
        !inCtx(state, CTX.Ambient) &&
        nameIs(state, key, 'prototype')
    )
        raise(state, ParseErrorCode.StaticPrototype);

    if (state.tsMode && isP(state, P.QUESTION)) {
        flags |= FL.OPTIONAL;
        nextToken(state);
    }

    if (kind !== 0 || async || generator || isP(state, P.LPAREN) || (state.tsMode && isP(state, P.LT))) {
        const fn = parseMethodTail(state, start, (async ? FL.ASYNC : 0) | (generator ? FL.GENERATOR : 0));
        return create.MethodDefinition(start, state.tokStart, flags | (kind << FL.KIND_SHIFT), decorators, key, fn);
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
    return create.PropertyDefinition(start, state.tokStart, flags, decorators, key, typeAnn, value);
}

const isAccessModifier = (state: ParserState): boolean =>
    state.tok === K.PUBLIC || state.tok === K.PRIVATE || state.tok === K.PROTECTED;

const accessLevelOf = (tok: number): number => (tok === K.PUBLIC ? 1 : tok === K.PRIVATE ? 2 : 3);

/** Enter a function's scope for the duration of `parse`, whatever body FORM it has. An arrow with an
 *  EXPRESSION body (`async x => await y`) is still a function boundary: it scopes `await` and
 *  `new.target` exactly like a block body does. Handling only the block form silently let an
 *  expression-bodied async arrow inherit the enclosing scope's `await`, and wrongly rejected
 *  `() => new.target`. */
function inFunctionScope<T>(state: ParserState, isAsync: boolean, parse: () => T, arrow = false, isGenerator = false): T {
    state.fnDepth++;
    // An arrow rebinds neither `this` NOR `new.target`: both come from the enclosing function. It
    // must therefore not INTRODUCE one either — `() => new.target` at the top level is an error,
    // while `function f(){ () => new.target }` is fine because `f` supplied it.
    if (!arrow) state.newTargetDepth++;
    if (!arrow) state.thisDepth++;
    // REPLACED, not unioned: a non-async function inherits no `await`, and an arrow or a plain
    // function nested in a generator inherits no `yield`. A class static block's reservation of
    // `await` is replaced the same way and by EVERY function boundary including an arrow's — both
    // oracles agree that `class C { static { function f(){ var await; } } }` is legal, and test262
    // asserts it directly (`static-init-await-reference.js`).
    const outerCtx = state.ctx;
    const outerStaticBlock = state.staticBlockDepth;
    state.staticBlockDepth = 0;
    state.ctx = (state.ctx & ~(CTX.Await | CTX.Yield)) | (isAsync ? CTX.Await : 0) | (isGenerator ? CTX.Yield : 0);
    const out = parse();
    state.ctx = outerCtx;
    state.staticBlockDepth = outerStaticBlock;
    if (!arrow) state.thisDepth--;
    if (!arrow) state.newTargetDepth--;
    state.fnDepth--;
    return out;
}

function parseBlock(state: ParserState): Node {
    const start = state.tokStart;
    expectP(state, P.LBRACE, "'{'");
    const from = state.sp;
    while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
        const mark = state.tokStart;
        push(state, parseStatement(state, false));
        if (noProgress(state, mark)) break;
    }
    expectP(state, P.RBRACE, "'}'");
    return create.BlockStatement(start, state.tokStart, 0, finishList(state, from));
}

/** oxc `Kind::is_after_let` (`lexer/kind.rs:298`). */
const isAfterLet = (tok: number): boolean =>
    tok !== K.IN &&
    tok !== K.INSTANCEOF &&
    (tok === P.LBRACE || tok === P.LBRACKET || tok === T_IDENT || isKeyword(tok));

function parseStatement(state: ParserState, single: boolean): Node {
    // Consume the module-scope flag: this statement may be an `import`/`export`, and every statement
    // it goes on to nest may not.
    const atModuleScope = inCtx(state, CTX.TopLevel);
    state.ctx &= ~CTX.TopLevel;
    const start = state.tokStart;
    if (isPunct(state.tok)) {
        switch (state.tok as number) {
            case P.LBRACE:
                return parseBlock(state);
            case P.SEMI:
                nextToken(state);
                return create.EmptyStatement(start, state.tokStart, 0);
            case P.AT: {
                const decorators = parseDecorators(state);
                if (isK(state, K.CLASS)) return parseClass(state, false, 0, start, decorators);
                if (isK(state, K.EXPORT)) return parseExport(state, decorators);
                raise(state, ParseErrorCode.DecoratorsUnsupported);
                return parseStatement(state, false);
            }
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
    if (isK(state, K.USING)) {
        const save = saveState(state);
        nextToken(state);
        const isDecl = isIdentLike(state) && (state.tokFlags & F_NL) === 0;
        restoreState(state, save);
        if (isDecl) {
            if (single) raise(state, ParseErrorCode.LexicalDeclSingleStatement);
            return parseVarDecl(state, VAR_KIND.USING, 0);
        }
    }
    // `await using r = res()` — the async form, disposed with `[Symbol.asyncDispose]`. Same
    // contextual rules one token further in, and `await` must still be able to start an ordinary
    // expression (`await using` where `using` is a variable, `await usingFoo()`).
    if (isK(state, K.AWAIT)) {
        const save = saveState(state);
        nextToken(state);
        let isDecl = false;
        if (isK(state, K.USING) && (state.tokFlags & F_NL) === 0) {
            nextToken(state);
            isDecl = isIdentLike(state) && (state.tokFlags & F_NL) === 0;
        }
        restoreState(state, save);
        if (isDecl) {
            if (single) raise(state, ParseErrorCode.LexicalDeclSingleStatement);
            nextToken(state); // consume `await`; `parseVarDecl` consumes `using`
            return parseVarDecl(state, VAR_KIND.AWAIT_USING, 0);
        }
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
                if (single) raise(state, ParseErrorCode.LexicalDeclSingleStatement);
                return parseVarDecl(state, VAR_KIND.CONST, 0);
            }
            case K.LET: {
                // `let` is a declaration or an ordinary identifier, and WHERE it appears decides.
                // A LexicalDeclaration is not a Statement, so `if (x) let\n{}` is `let` as an
                // identifier plus ASI, not a destructuring declaration. oxc's `parse_let`
                // (`js/declaration.rs:9-38`), ordered the same way.
                const p = state.pos,
                    tk = state.tok,
                    ts0 = state.tokStart,
                    te = state.tokEnd,
                    tf = state.tokFlags,
                    th = state.tokHash;
                nextToken(state);
                const peeked = state.tok;
                state.pos = p;
                state.tok = tk;
                state.tokStart = ts0;
                state.tokEnd = te;
                state.tokFlags = tf;
                state.tokHash = th;
                if (!single && isAfterLet(peeked)) return parseVarDecl(state, VAR_KIND.LET, 0);
                if (isAssignOp(peeked) || isBinaryOp(peeked)) break;
                if (peeked === P.DOT || peeked === P.QDOT || peeked === P.LPAREN) break;
                // `let [` stays a declaration even here: it is ambiguous with `let[a] = b` member
                // assignment, so the position rule cannot settle it.
                if ((single && peeked !== P.LBRACKET) || peeked === P.SEMI) break;
                return parseVarDecl(state, VAR_KIND.LET, 0);
            }
            case K.FUNCTION:
                return parseFunction(state, false, true, false, single);
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
                if (isK(state, K.FUNCTION) && (state.tokFlags & F_NL) === 0) return parseFunction(state, true, true, false, single);
                state.pos = p;
                state.tok = tk;
                state.tokStart = ts0;
                state.tokEnd = te;
                state.tokFlags = tf;
                state.tokHash = th;
                break;
            }
            case K.CLASS:
                // A ClassDeclaration is not a Statement either, but it gets its OWN diagnostic in
                // oxc (`js/class.rs:26` vs `js/statement.rs:294`), so the split is kept.
                if (single) raise(state, ParseErrorCode.ClassDeclSingleStatement);
                return parseClass(state, false, 0);
            case K.IF: {
                nextToken(state);
                expectP(state, P.LPAREN, "'('");
                const test = parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                const cons = parseStatement(state, true);
                let alt: Ref = null;
                if (eatK(state, K.ELSE)) alt = parseStatement(state, true);
                return create.IfStatement(start, state.tokStart, 0, test, cons, alt);
            }
            case K.FOR:
                return parseFor(state, start);
            // `with` is legal in sloppy CommonJS but CANNOT work in shakeup's output: an ES module is
            // always strict, and a `with` body is a SyntaxError there. A documented non-goal
            // (cjs.md §7.18) — and the RIGHT outcome, verified: esbuild refuses it with the same
            // reasoning, while rolldown builds it and emits a bundle that dies at load with
            // `Strict mode code may not include a with statement`. Only the message was wrong; it
            // used to surface as a bare `unexpected token 'with' in expression`.
            case K.WITH: {
                // PARSED, not refused. The reason `with` cannot be bundled — ESM output is always
                // strict, and a `with` body cannot run in strict code — is a property of the OUTPUT,
                // not of the grammar, so it belongs at the transform (`collectUnsupported`) where
                // decorators are refused for the same kind of reason. oxc parses it; esbuild refuses
                // to BUILD it; rolldown builds it and emits a bundle that dies at load. Parsing it
                // and refusing to build is both of the right halves.
                //
                // A module is strict, so `with` is a grammar error there — and only there.
                nextToken(state);
                expectP(state, P.LPAREN, "'('");
                const object = parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                const withBody = parseStatement(state, true);
                if (!state.allowTopReturn) raise(state, ParseErrorCode.WithStatement);
                state.sawUnbundlable = true;
                return create.WithStatement(start, withBody.end, 0, object, withBody);
            }
            case K.WHILE: {
                nextToken(state);
                expectP(state, P.LPAREN, "'('");
                const test = parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                const body = parseStatement(state, true);
                return create.WhileStatement(start, body.end, 0, test, body);
            }
            case K.DO: {
                nextToken(state);
                const body = parseStatement(state, true);
                if (!eatK(state, K.WHILE)) raise(state, ParseErrorCode.Expected, "'while'");
                expectP(state, P.LPAREN, "'('");
                const test = parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                eatP(state, P.SEMI);
                return create.DoWhileStatement(start, state.tokStart, 0, body, test);
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
                        push(state, parseStatement(state, false));
                    const body = finishList(state, bodyFrom);
                    push(state, create.SwitchCase(cs, state.tokStart, 0, test, body));
                    if (noProgress(state, mark)) break;
                }
                expectP(state, P.RBRACE, "'}'");
                return create.SwitchStatement(start, state.tokStart, 0, disc, finishList(state, from));
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
                    handler = create.CatchClause(cs, state.tokStart, 0, param, cbody);
                }
                if (eatK(state, K.FINALLY)) finalizer = parseBlock(state);
                return create.TryStatement(start, state.tokStart, 0, block, handler, finalizer);
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
                return create.ReturnStatement(start, state.tokStart, 0, arg);
            }
            case K.THROW: {
                nextToken(state);
                const arg = parseExpression(state);
                consumeSemi(state);
                return create.ThrowStatement(start, state.tokStart, 0, arg);
            }
            case K.BREAK:
            case K.CONTINUE: {
                const isBreak = state.tok === K.BREAK;
                nextToken(state);
                let label: Ref = null;
                if (isIdentLike(state) && (state.tokFlags & F_NL) === 0) label = parseIdent(state, R_LABEL);
                consumeSemi(state);
                return isBreak
                    ? create.BreakStatement(start, state.tokStart, 0, label)
                    : create.ContinueStatement(start, state.tokStart, 0, label);
            }
            case K.DEBUGGER:
                nextToken(state);
                consumeSemi(state);
                return create.DebuggerStatement(start, state.tokStart, 0);
            case K.IMPORT: {
                const s = saveState(state);
                nextToken(state);
                if (isP(state, P.LPAREN) || isP(state, P.DOT)) {
                    restoreState(state, s);
                    break;
                }
                restoreState(state, s);
                // `import(…)` and `import.meta` are expressions and legal anywhere; an import
                // DECLARATION is a module item and legal only at the top level. The two are
                // separated above, so this check lands only on the declaration.
                if (!atModuleScope) raise(state, ParseErrorCode.ImportExportNotTopLevel);
                return parseImport(state);
            }
            case K.EXPORT:
                if (!atModuleScope) raise(state, ParseErrorCode.ImportExportNotTopLevel);
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
                        // `declare const x;` has no initializer BY DESIGN — an ambient declaration
                        // may not have one. oxc exempts the same way (`Context::Ambient`).
                        const outerCtx = state.ctx;
                        state.ctx |= CTX.Ambient;
                        const inner = parseStatement(state, false);
                        state.ctx = outerCtx;
                        applyDeclare(inner, start);
                        return inner;
                    }
                    // `declare global { ... }` — ambient global augmentation; `global` is a
                    // contextual identifier here. Model it as a declare TSModuleDeclaration so
                    // emit erases the whole block (isErasableStatement).
                    if (isK(state, K.GLOBAL)) {
                        const gid = parseIdent(state, R_BIND);
                        if (isP(state, P.LBRACE)) {
                            nextToken(state);
                            // `declare global { const G: number }` is ambient too — it reaches here
                            // rather than through the keyword list above, so it needs the flag set
                            // separately or the missing-initializer errors fire inside it.
                            const outerCtx = state.ctx;
                            state.ctx |= CTX.Ambient;
                            const from = state.sp;
                            while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
                                const mark = state.tokStart;
                                // A TypeScript namespace/module body is a module scope of its own:
                                // `namespace N { export const y = 1 }` is the whole point of one.
                                // esbuild threads this as `parseStmtOpts.isNamespaceScope`.
                                state.ctx |= CTX.TopLevel;
                                push(state, parseStatement(state, false));
                                if (noProgress(state, mark)) break;
                            }
                            state.ctx = outerCtx;
                            expectP(state, P.RBRACE, "'}'");
                            const mod = create.TSModuleDeclaration(start, state.tokStart, 0, gid, finishList(state, from));
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
                                // A TypeScript namespace/module body is a module scope of its own:
                                // `namespace N { export const y = 1 }` is the whole point of one.
                                // esbuild threads this as `parseStmtOpts.isNamespaceScope`.
                                state.ctx |= CTX.TopLevel;
                                push(state, parseStatement(state, false));
                                if (noProgress(state, mark)) break;
                            }
                            expectP(state, P.RBRACE, "'}'");
                            return create.TSModuleDeclaration(start, state.tokStart, FL.NAMESPACE, id, finishList(state, from));
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
        const body = parseStatement(state, true);
        const label = ident(state, R_LABEL, expr.start, expr.end);
        return create.LabeledStatement(start, body.end, 0, label, body);
    }
    consumeSemi(state);
    return create.ExpressionStatement(start, state.tokStart, 0, expr);
}

/**
 * The three early errors a declarator with no initializer can trip. oxc's `check_missing_initializer`
 * (`js/declaration.rs:166-181`), which groups them because they share the "no `=` followed" trigger
 * and the same ambient exemption.
 *
 *     const x;      missing initializer in const declaration
 *     const {a};    missing initializer in destructuring declaration  (any kind, incl. `var`)
 *     using x;      using declarations must have an initializer
 *
 * All three are real syntax errors — node rejects every one — and we accepted all of them. NOT called
 * from the for-in/for-of head, where the iteration supplies the value and no initializer is legal.
 */
function checkMissingInit(state: ParserState, kind: number, target: Node, init: Ref, pos: number): void {
    if (init !== null || inCtx(state, CTX.Ambient)) return;
    const k = kind & VAR_KIND.KIND_MASK;
    if (target.type !== N.BindingIdentifier) raiseAt(state, pos, ParseErrorCode.MissingInitInDestructuring);
    else if (k === VAR_KIND.CONST) raiseAt(state, pos, ParseErrorCode.MissingInitInConst);
    else if (k === VAR_KIND.USING || k === VAR_KIND.AWAIT_USING) raiseAt(state, pos, ParseErrorCode.MissingInitInUsing);
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
        checkMissingInit(state, kind, target, init, ds);
        push(state, create.VariableDeclarator(ds, state.tokStart, flags, target, typeAnn, init));
    } while (eatP(state, P.COMMA));
    consumeSemi(state);
    return create.VariableDeclaration(start, state.tokStart, kind | extraFlags, finishList(state, from));
}

function parseFor(state: ParserState, start: number): Node {
    nextToken(state);
    let flags = 0;
    if (eatK(state, K.AWAIT)) flags |= FL.AWAIT;
    expectP(state, P.LPAREN, "'('");
    let init: Ref = null;
    if (isP(state, P.SEMI)) nextToken(state);
    else {
        // `for (using x of xs)` / `for (await using x of xs)` — the for-of head takes a `using`
        // declaration too. `using` is a plain identifier here, so it cannot join the keyword test
        // below; and `await using` is distinct from the `for await` on line above, which has already
        // been consumed into `flags`.
        let usingKind = 0;
        // The binding may not be `of`: the spec keeps `for (using of xs)` meaning "iterate into the
        // variable `using`", so `using` followed by `of` is never a declaration. oxc agrees.
        const bindingFollows = (awaited: boolean): boolean => {
            if (!isIdentLike(state) || (state.tokFlags & F_NL) !== 0) return false;
            if (awaited || !isK(state, K.OF)) return true;
            // `for (using of xs)` iterates into a variable named `using` — UNLESS what follows the
            // `of` shows it was the binding all along: `for (using of = null;;)`.
            const saved = saveState(state);
            nextToken(state);
            const isBinding = isP(state, P.EQ) || isP(state, P.SEMI) || isP(state, P.COLON);
            restoreState(state, saved);
            return isBinding;
        };
        const save = saveState(state);
        if (isK(state, K.USING)) {
            nextToken(state);
            if (bindingFollows(false)) usingKind = VAR_KIND.USING;
        } else if (isK(state, K.AWAIT)) {
            nextToken(state);
            if (isK(state, K.USING)) {
                nextToken(state);
                if (bindingFollows(true)) usingKind = VAR_KIND.AWAIT_USING;
            }
        }
        restoreState(state, save);
        // The shared path below consumes ONE token as the keyword, so `await using` needs its
        // `await` dropped here first.
        if (usingKind === VAR_KIND.AWAIT_USING) nextToken(state);
        // `for (let;;)` and `for (let in {})` are `let` the IDENTIFIER, not a declaration — the same
        // one-token test the statement path uses (oxc `js/statement.rs:405-420`).
        let letIsDecl = true;
        if (isK(state, K.LET)) {
            const saved = saveState(state);
            nextToken(state);
            letIsDecl = isAfterLet(state.tok);
            restoreState(state, saved);
        }
        if (
            usingKind !== 0 ||
            (isKeyword(state.tok) && (state.tok === K.VAR || state.tok === K.CONST || (state.tok === K.LET && letIsDecl)))
        ) {
            const kind =
                usingKind !== 0
                    ? usingKind
                    : state.tok === K.VAR
                      ? VAR_KIND.VAR
                      : state.tok === K.LET
                        ? VAR_KIND.LET
                        : VAR_KIND.CONST;
            const ds = state.tokStart;
            nextToken(state);
            const target = parseBindingTarget(state);
            if (isK(state, K.OF) || isK(state, K.IN)) {
                const isOf = isK(state, K.OF);
                nextToken(state);
                const dtor = create.VariableDeclarator(ds, state.tokStart, 0, target, null, null);
                const decl = create.VariableDeclaration(ds, state.tokStart, kind, [dtor]);
                const right = isOf ? parseAssign(state) : parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                const body = parseStatement(state, true);
                return isOf
                    ? create.ForOfStatement(start, body.end, flags, decl, right, body)
                    : create.ForInStatement(start, body.end, 0, decl, right, body);
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
                checkMissingInit(state, kind, target, dinit, ds);
                push(state, create.VariableDeclarator(ds, state.tokStart, dflags, target, typeAnn, dinit));
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
                checkMissingInit(state, kind, t2, dinit, ds2);
                push(state, create.VariableDeclarator(ds2, state.tokStart, 0, t2, typeAnn, dinit));
            }
            init = create.VariableDeclaration(ds, state.tokStart, kind, finishList(state, dFrom));
            expectP(state, P.SEMI, "';'");
        } else {
            init = parseExpression(state, true);
            if (isK(state, K.OF) || isK(state, K.IN)) {
                const isOf = state.tok === K.OF;
                // A for-in/of head without a declaration is an assignment target, and takes the
                // same cover grammar as `=` — `for (f() in {})` is a SyntaxError.
                checkAssignTarget(state, init, false);
                nextToken(state);
                const right = isOf ? parseAssign(state) : parseExpression(state);
                expectP(state, P.RPAREN, "')'");
                const body = parseStatement(state, true);
                return isOf
                    ? create.ForOfStatement(start, body.end, flags, init, right, body)
                    : create.ForInStatement(start, body.end, 0, init, right, body);
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
    const body = parseStatement(state, true);
    return create.ForStatement(start, body.end, 0, init, test, update, body);
}

/**
 * Is the `type` at the cursor a type-only MODIFIER, or a binding named `type`? oxc's
 * `parse_import_or_export_kind` (`js/module.rs:1025-1047`), which we approximated as "anything but
 * `from` or `=`" and got two shapes wrong:
 *
 *     import type, {A} from "m";      a DEFAULT import named `type`, plus named imports
 *     import type from from "m";      a type-only default import named `from`
 *
 * The second is the reason a plain token test cannot decide it: after `type`, a `from` is either the
 * clause keyword (`import type from "m"` — a default import named `type`) or the binding itself, and
 * only the token after that tells them apart.
 */
/** oxc's `can_parse_module_export_name` (`js/module.rs:1060`). */
const atModuleExportName = (state: ParserState): boolean => isNameLike(state) || (state.tok as number) === T_STR;

/** A `ModuleExportName`: an identifier name, or an arbitrary string (`{ "a-b" as c }`). */
function parseModuleExportName(state: ParserState): Node {
    if ((state.tok as number) === T_STR) {
        const n = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
        return n;
    }
    return parseNameAsIdent(state, R_NAME);
}

/**
 * One `{ … }` specifier, resolving the `type` modifier against the `as` chain. oxc's
 * `parse_import_or_export_specifier` (`js/module.rs:826-901`).
 *
 * `type` is contextual, so every prefix is ambiguous with a binding actually NAMED `type`, and the
 * only way through is to count the `as`es:
 *
 *     { type A }          type-only import of A
 *     { type as }         type-only import of `as`
 *     { type as as }      import `type`, renamed to `as`      <- we rejected this
 *     { type as as as }   type-only import of `as`, renamed to `as`
 *     { type as B }       import `type`, renamed to B         <- we rejected this
 *
 * Returns the specifier's parts; the caller builds the import- or export-shaped node.
 */
function parseSpecifierParts(state: ParserState): { name: Node; property: Node | null; typeOnly: boolean } {
    const wasType = state.tsMode && isK(state, K.TYPE);
    let typeOnly = false;
    let property: Node | null = null;
    let canParseAs = true;
    let name = parseModuleExportName(state);
    const typeNameNode = name;

    if (wasType && name.type !== N.StringLiteral) {
        if (isK(state, K.AS)) {
            const firstAs = parseNameAsIdent(state, R_NAME);
            if (isK(state, K.AS)) {
                const secondAs = parseNameAsIdent(state, R_NAME);
                if (atModuleExportName(state)) {
                    // `{ type as as X }` — type-only, importing `as` under the name X.
                    typeOnly = true;
                    property = firstAs;
                    name = parseModuleExportName(state);
                } else {
                    // `{ type as as }` — no modifier: `type` itself, renamed to `as`.
                    property = typeNameNode;
                    name = secondAs;
                }
                canParseAs = false;
            } else if (atModuleExportName(state)) {
                // `{ type as B }` — no modifier: `type` renamed to B.
                property = typeNameNode;
                name = parseModuleExportName(state);
                canParseAs = false;
            } else {
                // `{ type as }` — type-only import of `as`.
                typeOnly = true;
                name = firstAs;
            }
        } else if (atModuleExportName(state)) {
            // `{ type A }` — the ordinary type-only form.
            typeOnly = true;
            name = parseModuleExportName(state);
        }
    }

    if (canParseAs && eatK(state, K.AS)) {
        property = name;
        name = parseModuleExportName(state);
    }
    return { name, property, typeOnly };
}

function importTypeModifierFollows(state: ParserState): boolean {
    const s = saveState(state);
    nextToken(state); // past `type`
    let modifier: boolean;
    if (isP(state, P.LBRACE) || isP(state, P.STAR)) modifier = true;
    // `,` `=` or a specifier string: `type` is the binding, not a modifier.
    else if (!isIdentLike(state)) modifier = false;
    else if (!isK(state, K.FROM)) modifier = true;
    else {
        nextToken(state); // past `from`
        modifier = isK(state, K.FROM); // `import type from from "m"`
    }
    restoreState(state, s);
    return modifier;
}

function parseImport(state: ParserState): Node {
    const start = state.tokStart;
    nextToken(state);
    let flags = 0;
    if (state.tsMode && isK(state, K.TYPE) && importTypeModifierFollows(state)) {
        flags |= FL.TYPE_ONLY;
        nextToken(state);
    }
    // Import PHASE: `import source w from './m.wasm'` / `import defer * as ns from './m.js'`.
    //
    // Both are CONTEXTUAL — `import source from './m'` is a default import of a binding NAMED
    // `source`, which oxc accepts with `phase: null`. The disambiguator is the token AFTER: a phase
    // keyword is never followed by `from`. Verified against `oxc-parser` for every form, including
    // the ones it REJECTS: `import source * as w`, `import defer d`, `import defer { a }`, and a
    // bare `import defer '…'` — `source` takes only a default binding, `defer` only a namespace.
    let phase: 'source' | 'defer' | null = null;
    if (isK(state, K.SOURCE) || isK(state, K.DEFER)) {
        const isSource = isK(state, K.SOURCE);
        {
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
        return create.ImportDeclaration(start, state.tokStart, flags, finishList(state, from), source, attrs, phase);
    }
    if (isIdentLike(state)) {
        const local = parseIdent(state, R_BIND);
        // `import X = …` — TS import-equals, not an ESM default import.
        if (isP(state, P.EQ)) return finishImportEquals(state, start, flags, local);
        push(state, create.ImportDefaultSpecifier(local.start, local.end, 0, local));
        eatP(state, P.COMMA);
    }
    if (isP(state, P.STAR)) {
        const s = state.tokStart;
        nextToken(state);
        if (!eatK(state, K.AS)) raise(state, ParseErrorCode.Expected, "'as'");
        const local = parseIdent(state, R_BIND);
        push(state, create.ImportNamespaceSpecifier(s, local.end, 0, local));
    } else if (isP(state, P.LBRACE)) {
        nextToken(state);
        while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
            const mark = state.tokStart;
            const ss = state.tokStart;
            const parts = parseSpecifierParts(state);
            const imported = parts.property ?? parts.name;
            const local = ident(state, R_BIND, parts.name.start, parts.name.end);
            push(state, create.ImportSpecifier(ss, state.tokStart, parts.typeOnly ? FL.TYPE_ONLY : 0, local, imported));
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
    );
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
        !isWith && isK(state, K.ASSERT);
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
        push(state, create.ImportAttribute(s, state.tokStart, 0, key, value));
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
    let name: Node = parseNameAsIdent(state, R_REF);
    while (isP(state, P.DOT)) {
        nextToken(state);
        const r = parseNameAsIdent(state, R_NAME);
        name = create.TSQualifiedName(s, r.end, 0, name, r);
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
            moduleRef = create.TSExternalModuleReference(rs, state.tokStart, 0, expr);
        } else {
            restoreState(state, save);
            moduleRef = parseEntityNameRef(state);
        }
    } else {
        moduleRef = parseEntityNameRef(state);
    }
    consumeSemi(state);
    return create.TSImportEqualsDeclaration(start, state.tokStart, flags, id as Node, moduleRef);
}

/** Is the `async` at the cursor the start of an `async function` declaration, rather than an async
 *  ARROW or a plain identifier?
 *
 *  `export default async` used to assume `function` unconditionally, so
 *  `export default async (v) => v * 2` failed with `expected '('` — a perfectly ordinary default
 *  export of an async arrow. The same shape one level in (`const f = async (v) => v`) always worked,
 *  which is how it survived. A LineTerminator between them means ASI has already ended the
 *  expression, so `async` is an identifier there. */
function asyncFunctionFollows(state: ParserState): boolean {
    const save = saveState(state);
    nextToken(state);
    const yes = isK(state, K.FUNCTION) && (state.tokFlags & F_NL) === 0;
    restoreState(state, save);
    return yes;
}

function parseExport(state: ParserState, decorators: Node[] = EMPTY_LIST): Node {
    const start = state.tokStart;
    nextToken(state);
    // `export @dec class C {}` as well as `@dec export class C {}`; oxc accepts both
    // (`js/module.rs:479,685`).
    if (isP(state, P.AT)) decorators = parseDecorators(state);
    if (eatK(state, K.DEFAULT)) {
        if (isP(state, P.AT)) decorators = parseDecorators(state);
        let decl: Node;
        if (isK(state, K.FUNCTION)) decl = parseFunction(state, false, true, false, false);
        else if (isK(state, K.ASYNC) && asyncFunctionFollows(state)) {
            nextToken(state);
            decl = parseFunction(state, true, true, false, false);
        } else if (isK(state, K.CLASS)) decl = parseClass(state, false, 0, -1, decorators);
        else {
            decl = parseAssign(state);
            consumeSemi(state);
        }
        state.sawEsmExport = true;
        return create.ExportDefaultDeclaration(start, state.tokStart, 0, decl);
    }
    // `export type ...` — the lookahead has to run BEFORE the `*` branch, because `export type * from`
    // is type-only re-export syntax (TS 5.0) and the `type` keyword sits in front of the star. Only
    // `{` and `*` may follow: `export type Foo = …` is a type ALIAS declaration, not a modifier, and
    // must fall through to the declaration path with the token restored.
    let flags = 0;
    if (state.tsMode && isK(state, K.TYPE)) {
        const s0 = saveState(state);
        nextToken(state);
        if (isP(state, P.LBRACE) || isP(state, P.STAR)) flags |= FL.TYPE_ONLY;
        else restoreState(state, s0);
    }
    if (isP(state, P.STAR)) {
        nextToken(state);
        let exported: Ref = null;
        if (eatK(state, K.AS)) {
            // `export * as "ns name" from './m'` — the namespace name may be a string too.
            if ((state.tok as number) === T_STR) {
                exported = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
                nextToken(state);
            } else exported = parseNameAsIdent(state, R_NAME);
        }
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
            flags,
            source ?? leaf(state, N.StringLiteral, state.tokStart, state.tokStart),
            exported,
            attrs,
        );
    }
    if (isP(state, P.LBRACE)) {
        nextToken(state);
        const from = state.sp;
        while (!isP(state, P.RBRACE) && (state.tok as number) !== T_EOF) {
            const mark = state.tokStart;
            const ss = state.tokStart;
            // Same `type`/`as` resolution as the import side — `export { type as as }` is `type`
            // re-exported under the name `as`, NOT a type-only export. Arbitrary module namespace
            // names (`export { a as "x y" }`, `export { "a-b" as c }`, `export { "a-b" }`) come from
            // `parseModuleExportName` on both halves.
            //
            // oxc maps this the mirror of imports: the LOCAL is the property name when there was an
            // `as`, else the name itself (`js/module.rs:951-955`).
            const parts = parseSpecifierParts(state);
            const exported = parts.name;
            const localSrc = parts.property ?? exported;
            const local: Node =
                localSrc.type === N.StringLiteral ? localSrc : ident(state, R_REF, localSrc.start, localSrc.end);
            push(state, create.ExportSpecifier(ss, state.tokStart, parts.typeOnly ? FL.TYPE_ONLY : 0, local, exported));
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
        return create.ExportNamedDeclaration(start, state.tokStart, flags, null, finishList(state, from), source, attrs);
    }
    // The DECLARATION an `export` prefixes is still at module scope — `export import X = o.Y` is a
    // TypeScript import-equals, and `parseStatement` cleared the flag on the way in here.
    state.ctx |= CTX.TopLevel;
    const decl = parseStatement(state, false);
    state.sawEsmExport = true;
    return create.ExportNamedDeclaration(start, state.tokStart, flags, decl, [], null);
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
                expr = create.TSQualifiedName(s, r.end, 0, expr, r);
            }
            let targs: Ref = null;
            if (isP(state, P.LT)) {
                const t = tryParseTypeArgsInType(state);
                if (t !== null) targs = t;
            }
            push(state, create.TSInterfaceHeritage(s, state.tokStart, 0, expr, targs));
        } while (eatP(state, P.COMMA));
    }
    const ext = finishList(state, extFrom);
    const body = parseTypeMembers(state);
    return create.TSInterfaceDeclaration(start, state.tokStart, extraFlags, id, typeParams, ext, body);
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
    return create.TSTypeAliasDeclaration(start, state.tokStart, extraFlags, id, typeParams, ty);
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
        push(state, create.TSEnumMember(ms, state.tokStart, 0, key, init));
        if (!isP(state, P.RBRACE)) expectP(state, P.COMMA, "','");
        if (noProgress(state, mark)) break;
    }
    expectP(state, P.RBRACE, "'}'");
    return create.TSEnumDeclaration(start, state.tokStart, extraFlags, id, finishList(state, from));
}

const predicateName = (state: ParserState): Node =>
    isK(state, K.THIS) ? create.keyword(state.tokStart, state.tokEnd, N.TSThisType) : parseNameAsIdent(state, R_NAME);

/** `x is T` / `this is T`. Only legal where a RETURN type is expected. */
function parseTypeOrPredicate(state: ParserState): Node {
    if (isIdentLike(state) || isK(state, K.THIS)) {
        const pos = state.pos,
            tok = state.tok,
            tokStart = state.tokStart,
            tokEnd = state.tokEnd,
            tokFlags = state.tokFlags,
            tokHash = state.tokHash;
        const start = state.tokStart;
        const name = predicateName(state);
        if (isK(state, K.THIS)) nextToken(state);
        if (isK(state, K.IS)) {
            nextToken(state);
            const ty = parseType(state);
            return create.TSTypePredicate(start, ty.end, 0, name, create.TSTypeAnnotation(ty.start, ty.end, 0, ty));
        }
        state.pos = pos;
        state.tok = tok;
        state.tokStart = tokStart;
        state.tokEnd = tokEnd;
        state.tokFlags = tokFlags;
        state.tokHash = tokHash;
    }
    return parseType(state);
}

function parseTypeAnn(state: ParserState): Node {
    const start = state.tokStart;
    expectP(state, P.COLON, "':'");
    const ty = parseTypeOrPredicate(state);
    return create.TSTypeAnnotation(start, ty.end, 0, ty);
}

/** Public type entry: conditional types are ALLOWED here (a trailing `? … : …` starts a new
 * conditional). Nested bracketed types (`(T)`, `{…}`, `T[…]`, `<…>`) route back through this,
 * so disallow-conditional state never leaks across a bracket boundary — matching oxc/TS. */
function parseType(state: ParserState): Node {
    const outerCtx = state.ctx;
    state.ctx &= ~CTX.DisallowConditionalTypes;
    const t = parseTypeInner(state);
    state.ctx = outerCtx;
    return t;
}

function parseTypeInner(state: ParserState): Node {
    // `asserts x` / `asserts x is T` is a type in its own right, legal wherever a type may start.
    if (isK(state, K.ASSERTS)) {
        const start = state.tokStart;
        nextToken(state);
        const name = predicateName(state);
        if (isK(state, K.THIS)) nextToken(state);
        let ann: Ref = null;
        if (eatK(state, K.IS)) {
            const ty = parseType(state);
            ann = create.TSTypeAnnotation(ty.start, ty.end, 0, ty);
        }
        return create.TSTypePredicate(start, state.tokStart, FL.ASSERTS, name, ann);
    }
    if (isP(state, P.LPAREN) && fnTypeAhead(state)) return parseFnType(state, 0, null);
    if (isP(state, P.LT)) {
        const tp = tryParseTypeParams(state);
        if (tp !== null) return parseFnType(state, 0, tp);
    }
    if (isK(state, K.NEW)) return parseConstructorType(state, state.tokStart, 0);
    if (isK(state, K.ABSTRACT)) {
        const saved = saveState(state);
        const start = state.tokStart;
        nextToken(state);
        if (isK(state, K.NEW)) return parseConstructorType(state, start, FL.ABSTRACT);
        restoreState(state, saved);
    }
    return parseConditionalTypeOrHigher(state);
}

function parseConstructorType(state: ParserState, start: number, flags: number): Node {
    nextToken(state);
    let tp: Ref = null;
    if (isP(state, P.LT)) {
        const t = tryParseTypeParams(state);
        if (t !== null) tp = t;
    }
    const params = parseParams(state);
    expectP(state, P.ARROW, "'=>'");
    const ret = parseTypeOrPredicate(state);
    return create.TSConstructorType(start, state.tokStart, flags, tp, params, create.TSTypeAnnotation(ret.start, ret.end, 0, ret));
}

function parseFnType(state: ParserState, abstractFlag: number, typeParams: Ref): Node {
    const start = state.tokStart;
    const params = parseParams(state);
    expectP(state, P.ARROW, "'=>'");
    const ret = parseTypeOrPredicate(state);
    const ann = create.TSTypeAnnotation(ret.start, ret.end, 0, ret);
    return create.TSFunctionType(start, state.tokStart, abstractFlag, typeParams, params, ann);
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
    // A conditional's extends-type is parsed with conditionals disallowed (`CTX.DisallowConditionalTypes`), so a
    // trailing `? … : …` there binds to THIS conditional, not a nested one.
    if (inCtx(state, CTX.DisallowConditionalTypes) || !isK(state, K.EXTENDS)) return checkType;
    nextToken(state);
    state.ctx |= CTX.DisallowConditionalTypes;
    const extendsType = parseTypeInner(state);
    state.ctx &= ~CTX.DisallowConditionalTypes;
    expectP(state, P.QUESTION, "'?'");
    const trueType = parseType(state);
    expectP(state, P.COLON, "':'");
    const falseType = parseType(state);
    return create.TSConditionalType(checkType.start, falseType.end, 0, checkType, extendsType, trueType, falseType);
}

function parseUnionType(state: ParserState): Node {
    eatP(state, P.PIPE);
    const first = parseIntersectionType(state);
    if (!isP(state, P.PIPE)) return first;
    const start = first.start;
    const from = state.sp;
    push(state, first);
    while (eatP(state, P.PIPE)) push(state, parseIntersectionType(state));
    return create.TSUnionType(start, state.tokStart, 0, finishList(state, from));
}

function parseIntersectionType(state: ParserState): Node {
    eatP(state, P.AMP);
    const first = parseTypeOperator(state);
    if (!isP(state, P.AMP)) return first;
    const start = first.start;
    const from = state.sp;
    push(state, first);
    while (eatP(state, P.AMP)) push(state, parseTypeOperator(state));
    return create.TSIntersectionType(start, state.tokStart, 0, finishList(state, from));
}

function parseTypeOperator(state: ParserState): Node {
    const start = state.tokStart;
    if (isK(state, K.KEYOF)) {
        nextToken(state);
        const t = parseTypeOperator(state);
        return create.TSTypeOperator(start, t.end, TSOP.KEYOF, t);
    }
    if (isK(state, K.READONLY)) {
        nextToken(state);
        const t = parseTypeOperator(state);
        return create.TSTypeOperator(start, t.end, TSOP.READONLY, t);
    }
    if (isK(state, K.UNIQUE)) {
        nextToken(state);
        const t = parseTypeOperator(state);
        return create.TSTypeOperator(start, t.end, TSOP.UNIQUE, t);
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
            const outerCtx = state.ctx;
            nextToken(state);
            state.ctx |= CTX.DisallowConditionalTypes;
            const c = parseTypeInner(state);
            state.ctx = outerCtx;
            if (inCtx(state, CTX.DisallowConditionalTypes) || !isP(state, P.QUESTION)) constraint = c;
            else restoreState(state, s);
        }
        const tp = create.TSTypeParameter(name.start, state.tokStart, 0, name, constraint, null);
        return create.TSInferType(start, state.tokStart, 0, tp);
    }
    return parseTypePostfixAndCond(state, parsePrimaryType(state));
}

function parseTypePostfixAndCond(state: ParserState, t: Node): Node {
    for (;;) {
        if (isP(state, P.LBRACKET) && (state.tokFlags & F_NL) === 0) {
            nextToken(state);
            if (isP(state, P.RBRACKET)) {
                nextToken(state);
                t = create.TSArrayType(t.start, state.tokStart, 0, t);
            } else {
                const idx = parseType(state);
                expectP(state, P.RBRACKET, "']'");
                t = create.TSIndexedAccessType(t.start, state.tokStart, 0, t, idx);
            }
        } else return t;
    }
}

function parseImportType(state: ParserState, start: number): Node {
    nextToken(state);
    expectP(state, P.LPAREN, "'('");
    let source: Ref = null;
    if ((state.tok as number) === T_STR) {
        source = leaf(state, N.StringLiteral, state.tokStart, state.tokEnd);
        nextToken(state);
    }
    let options: Ref = null;
    if (eatP(state, P.COMMA) && !isP(state, P.RPAREN)) options = parseAssign(state);
    expectP(state, P.RPAREN, "')'");
    let qualifier: Ref = null;
    if (isP(state, P.DOT)) {
        nextToken(state);
        let q: Node = parseNameAsIdent(state, R_NAME);
        while (isP(state, P.DOT)) {
            nextToken(state);
            const r = parseNameAsIdent(state, R_NAME);
            q = create.TSQualifiedName(q.start, r.end, 0, q, r);
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
        options,
        qualifier,
        targs,
    );
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
        return create.TSLiteralType(start, state.tokStart, 0, l);
    }
    if (state.tok === T_NUM) {
        const l = leaf(state, N.NumericLiteral, start, state.tokEnd);
        nextToken(state);
        return create.TSLiteralType(start, state.tokStart, 0, l);
    }
    if (state.tok === T_BIGINT) {
        const l = leaf(state, N.BigIntLiteral, start, state.tokEnd);
        nextToken(state);
        return create.TSLiteralType(start, state.tokStart, 0, l);
    }
    if (state.tok === T_TEMPLATE_FULL || state.tok === T_TEMPLATE_HEAD) return parseTemplateLiteralType(state);
    if (isP(state, P.MINUS)) {
        nextToken(state);
        if (state.tok === T_NUM) {
            const l = leaf(state, N.NumericLiteral, start, state.tokEnd);
            nextToken(state);
            return create.TSLiteralType(start, state.tokStart, 0, l);
        }
        raise(state, ParseErrorCode.ExpectedNumber);
        return create.keyword(start, state.tokStart, N.TSAnyKeyword);
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
                        t = create.TSNamedTupleMember(label.start, ty.end, opt, label, ty);
                    } else restoreState(state, sv);
                }
                if (t === null) t = parseType(state);
                push(state, create.TSTypeOperator(s, t.end, 0, t));
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
                        push(state, create.TSNamedTupleMember(label.start, t.end, opt, label, t));
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
        return create.TSTupleType(start, state.tokStart, 0, finishList(state, from));
    }
    if (isP(state, P.LBRACE)) {
        if (mappedTypeAhead(state)) return parseMappedType(state);
        const members = parseTypeMembers(state);
        return create.TSTypeLiteral(start, state.tokStart, 0, members);
    }
    if (isK(state, K.TYPEOF)) {
        nextToken(state);
        const s = state.tokStart;
        // `typeof this.foo` — the entity-name root may be `this` (or any reserved word). TS/oxc
        // parse a reserved-word-tolerant entity name here.
        let expr: Node;
        if (isK(state, K.THIS)) {
            expr = create.ThisExpression(state.tokStart, state.tokEnd, 0);
            nextToken(state);
        } else if (isK(state, K.IMPORT)) {
            expr = parseImportType(state, state.tokStart);
        } else {
            expr = parseIdent(state, R_REF);
        }
        while (isP(state, P.DOT)) {
            nextToken(state);
            const r = parseNameAsIdent(state, R_NAME);
            expr = create.TSQualifiedName(s, r.end, 0, expr, r);
        }
        let targs: Ref = null;
        if (isP(state, P.LT)) {
            const t = tryParseTypeArgsInType(state);
            if (t !== null) targs = t;
        }
        return create.TSTypeQuery(start, state.tokStart, 0, expr, targs);
    }
    if (isK(state, K.IMPORT)) return parseImportType(state, start);
    if (isK(state, K.THIS)) {
        nextToken(state);
        return create.keyword(start, state.tokStart, N.TSThisType);
    }
    if (isIdentLike(state) || isKeyword(state.tok)) {
        const kw = tsKeywordType(state);
        if (kw !== 0) {
            nextToken(state);
            return create.keyword(start, state.tokStart, kw);
        }
        const s = state.tokStart;
        let name: Node = parseNameAsIdent(state, R_REF);
        while (isP(state, P.DOT)) {
            nextToken(state);
            const r = parseNameAsIdent(state, R_NAME);
            name = create.TSQualifiedName(s, r.end, 0, name, r);
        }
        let targs: Ref = null;
        if (isP(state, P.LT)) {
            const t = tryParseTypeArgsInType(state);
            if (t !== null) targs = t;
        }
        return create.TSTypeReference(start, state.tokStart, 0, name, targs);
    }
    raise(state, ParseErrorCode.ExpectedType);
    nextToken(state);
    return create.keyword(start, state.tokStart, N.TSAnyKeyword);
}

function tsKeywordType(state: ParserState): KeywordType | 0 {
    switch (state.tok) {
        case K.ANY:
            return N.TSAnyKeyword;
        case K.VOID:
            return N.TSVoidKeyword;
        case K.NEVER:
            return N.TSNeverKeyword;
        case K.NUMBER:
            return N.TSNumberKeyword;
        case K.STRING:
            return N.TSStringKeyword;
        case K.SYMBOL:
            return N.TSSymbolKeyword;
        case K.OBJECT:
            return N.TSObjectKeyword;
        case K.BIGINT:
            return N.TSBigIntKeyword;
        case K.BOOLEAN:
            return N.TSBooleanKeyword;
        case K.UNKNOWN:
            return N.TSUnknownKeyword;
        case K.UNDEFINED:
            return N.TSUndefinedKeyword;
        case K.NULL:
            return N.TSNullKeyword;
        default:
            return 0;
    }
}

function parseTemplateLiteralType(state: ParserState): Node {
    const start = state.tokStart;
    if (state.tok === T_TEMPLATE_FULL) {
        const q = leaf(state, N.TemplateElement, start + 1, state.tokEnd - 1);
        nextToken(state);
        return create.TSTemplateLiteralType(start, state.tokStart, 0, [q], []);
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
    return create.TSTemplateLiteralType(start, state.tokStart, 0, quasis, types);
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
    const tp = create.TSTypeParameter(name.start, constraint.end, 0, name, constraint, null);
    return create.TSMappedType(start, state.tokStart, flags, tp, nameType, typeAnn);
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
        return create.TSConstructSignatureDeclaration(start, state.tokStart, 0, tp, params, ret);
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
        return create.TSCallSignatureDeclaration(start, state.tokStart, 0, tp, params, ret);
    }
    if (isP(state, P.LBRACKET)) {
        nextToken(state);
        const ps = state.tokStart;
        const name = parseNameAsIdent(state, R_REF);
        if (isP(state, P.COLON)) {
            const keyAnn = parseTypeAnn(state);
            const param = create.FormalParameter(ps, state.tokStart, 0, ident(state, R_BIND, name.start, name.end), keyAnn, null);
            expectP(state, P.RBRACKET, "']'");
            let ann: Ref = null;
            if (isP(state, P.COLON)) ann = parseTypeAnn(state);
            return create.TSIndexSignature(start, state.tokStart, flags, param, ann);
        }
        let key: Node = name;
        while (isP(state, P.DOT)) {
            nextToken(state);
            const r = parseNameAsIdent(state, R_NAME);
            key = create.StaticMemberExpression(ps, r.end, 0, key, r);
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
            return create.TSMethodSignature(start, state.tokStart, mflags, key, tp, params, ret);
        }
        let ann: Ref = null;
        if (isP(state, P.COLON)) ann = parseTypeAnn(state);
        return create.TSPropertySignature(start, state.tokStart, mflags, key, ann);
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
    } else if (state.tok === T_NUM || (state.tok as number) === T_BIGINT) {
        key = leaf(state, (state.tok as number) === T_BIGINT ? N.BigIntLiteral : N.NumericLiteral, state.tokStart, state.tokEnd);
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
        return create.TSMethodSignature(start, state.tokStart, flags | (kind << FL.KIND_SHIFT), key, tp, params, ret);
    }
    let ann: Ref = null;
    if (isP(state, P.COLON)) ann = parseTypeAnn(state);
    return create.TSPropertySignature(start, state.tokStart, flags, key, ann);
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
    const s = saveState(state);
    const startPos = state.tokStart;
    nextToken(state);
    const from = state.sp;
    try {
        while (!isGtLike(state) && (state.tok as number) !== T_EOF) {
            const ts = state.tokStart;
            let flags = 0;
            for (;;) {
                if (isK(state, K.IN)) {
                    flags |= 1;
                    nextToken(state);
                } else if (
                    isK(state, K.OUT) &&
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
            push(state, create.TSTypeParameter(ts, state.tokStart, flags, name, constraint, dflt));
            if (!eatP(state, P.COMMA)) break;
        }
        if (!isGtLike(state)) throw 0;
        expectGtInType(state);
        return create.TSTypeParameterDeclaration(startPos, state.tokStart, 0, finishList(state, from));
    } catch {
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
        while (!isGtLike(state) && (state.tok as number) !== T_EOF) {
            push(state, parseType(state));
            if (!eatP(state, P.COMMA)) break;
        }
        if (!isGtLike(state)) throw 0;
        expectGtInType(state);
        return create.TSTypeParameterInstantiation(startPos, state.tokStart, 0, finishList(state, from));
    } catch {
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
    /** Source positions of the token after each `/*@__NO_SIDE_EFFECTS__*​/`. Empty for the vast
     *  majority of files; resolved to function symbols by `resolveNoSideEffects`. */
    noSideEffectsAt: number[];
    /** Every comment, flat, stride 4: `[start, end, flags, attachedTo]`. Read it with the helpers in
     *  `parser/comments.ts`; classification is deferred, so retaining costs no scanning. */
    comments: Int32Array;
    /** A `with` statement or a decorator: parses, but cannot be emitted into an ES module. */
    hasUnbundlable: boolean;
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

export type ParseOptions = {
    ts: boolean;
    jsx: boolean;
    kind?: ParseKind;
    /** Retain comment spans. Default TRUE, because the bundler needs them: legal and JSDoc comments
     *  are printed (`print-comments.test.ts`), and a dropped `@license` is a compliance problem.
     *
     *  A consumer that never prints comments should pass `false` — the DEV/transform path is exactly
     *  that. This is the shape acorn (`onComment: null` by default) and meriyah use, and the reason
     *  they use it: retaining is the single largest cost in the lexer's comment path, ~2.7us per
     *  comment, and it is pure waste when nothing reads the result. oxc has no such option because a
     *  `Vec<Comment>` of `Copy` structs is nearly free in Rust; in JS it is not. */
    comments?: boolean;
};

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
        // THE module scope: only a statement parsed directly here may be an `import`/`export`
        // declaration. `parseStatement` clears the flag on entry, so everything it nests is out.
        state.ctx |= CTX.TopLevel;
        push(state, parseStatement(state, false));
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
        noSideEffectsAt: state.nseAt,
        comments: state.comments.subarray(0, state.commentsLen),
        hasUnbundlable: state.sawUnbundlable,
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
