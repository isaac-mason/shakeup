// TS type stripping by span blanking (ts-blank-space model) plus enum lowering.
// AST-driven: a single walk collects edits that are sorted and applied by slicing.

import {
    A,
    type Ast,
    FL,
    isTypeOnlyNode,
    listAt,
    listLen,
    N,
    type NodeId,
    walk,
} from './ast.ts';

/** Emit options; `stripTypes: false` yields byte-identical passthrough. */
export type EmitOptions = { stripTypes: boolean };

/* ------------------------------------------------------------------ edits */

/** An edit over the source. `text` present => replacement; absent => blank. */
export type Edit = { start: number; end: number; text?: string };

type Ctx = {
    ast: Ast;
    src: string;
    edits: Edit[];
    rootId: NodeId;
    /** bundling mode: lowered enums emit `var` instead of `export var` (the
     * bundler removes module export syntax and re-exports at the entry) */
    dropExportKeyword: boolean;
    /** bundling: final (deconflicted) name for an enum's declaring Ident node */
    enumFinalName: ((idNode: NodeId) => string | null) | null;
};

/** blank [start, end): each char -> space, but keep \n and \r for line parity. */
function blank(ctx: Ctx, start: number, end: number): void {
    if (end > start) ctx.edits.push({ start, end });
}

/** replace [start, end) with `text` verbatim (used only for runtime lowering). */
function replace(ctx: Ctx, start: number, end: number, text: string): void {
    ctx.edits.push({ start, end, text });
}

/** whitespace version of a source slice: everything -> space except \n and \r. */
function blankText(src: string, start: number, end: number): string {
    let out = '';
    for (let i = start; i < end; i++) {
        const c = src.charCodeAt(i);
        out += c === 10 || c === 13 ? src[i] : ' ';
    }
    return out;
}

/* --------------------------------------------------------- char scanning */

function isWs(c: number): boolean {
    return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
}
function isIdentStart(c: number): boolean {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95;
}
function isIdentPart(c: number): boolean {
    return isIdentStart(c) || (c >= 48 && c <= 57);
}

/** scan forward from `from` over whitespace, return first non-ws index (or `end`). */
function skipWs(src: string, from: number, end: number): number {
    let i = from;
    while (i < end && isWs(src.charCodeAt(i))) i++;
    return i;
}

/** read the identifier word starting at `from` (assumes ident-start there). */
function readWord(src: string, from: number, end: number): string {
    let i = from;
    while (i < end && isIdentPart(src.charCodeAt(i))) i++;
    return src.slice(from, i);
}

/**
 * Scan [from, limit) for the exact keyword `kw` at an identifier boundary;
 * return its start offset, or -1. Skips any intervening non-word chars (e.g. a
 * closing paren the parser excluded from the operand span).
 */
function scanForwardKeyword(ctx: Ctx, from: number, limit: number, kw: string): number {
    const src = ctx.src;
    for (let i = from; i + kw.length <= limit; i++) {
        if (isIdentStart(src.charCodeAt(i))) {
            const w = readWord(src, i, limit);
            if (w === kw) return i;
            i += w.length - 1; // skip past this word
        }
    }
    return -1;
}

/** scan [from, limit) for the first occurrence of char code `cc`; -1 if none. */
function scanForwardChar(ctx: Ctx, from: number, limit: number, cc: number): number {
    const src = ctx.src;
    for (let i = from; i < limit; i++) if (src.charCodeAt(i) === cc) return i;
    return -1;
}

/* --------------------------------------------------------- blanking rules */

/** blank a whole node's span. */
function blankNode(ctx: Ctx, id: NodeId): void {
    if (id !== 0) blank(ctx, ctx.ast.start[id], ctx.ast.end[id]);
}

/**
 * Blank an optional `?` that sits immediately after `afterEnd` (skipping ws).
 * Used for optional params and optional class members (FL.OPTIONAL).
 */
function blankTrailingQuestion(ctx: Ctx, afterEnd: number, limit: number): void {
    const src = ctx.src;
    const i = skipWs(src, afterEnd, limit);
    if (i < limit && src.charCodeAt(i) === 63 /* ? */) blank(ctx, i, i + 1);
}

/**
 * Blank a definite-assignment `!` (FL.DEFINITE) that sits between the id/key
 * span end and the next child (typeAnn) or the declarator/prop end.
 */
function blankDefinite(ctx: Ctx, afterEnd: number, limit: number): void {
    const src = ctx.src;
    const i = skipWs(src, afterEnd, limit);
    if (i < limit && src.charCodeAt(i) === 33 /* ! */) blank(ctx, i, i + 1);
}

/**
 * Blank leading member-modifier keywords in [start, keyStart): the erasable
 * TS ones (accessibility, readonly, abstract, override, declare). Real JS
 * modifiers (static, get, set, async, *) are kept. Stops at the key, at `[`
 * (computed), `#`, `*`, `(`, a string quote, or an unrecognized word.
 */
const ERASABLE_MEMBER_MODS = new Set(['public', 'private', 'protected', 'readonly', 'abstract', 'override', 'declare']);
const KEEP_MEMBER_MODS = new Set(['static', 'get', 'set', 'async']);
function blankMemberModifiers(ctx: Ctx, start: number, keyStart: number): void {
    const src = ctx.src;
    let i = start;
    for (;;) {
        i = skipWs(src, i, keyStart);
        if (i >= keyStart) break;
        const c = src.charCodeAt(i);
        if (!isIdentStart(c)) break; // '[', '#', '*', '"', '(' etc. — key region
        const word = readWord(src, i, keyStart);
        const wordEnd = i + word.length;
        if (ERASABLE_MEMBER_MODS.has(word)) {
            blank(ctx, i, wordEnd);
            i = wordEnd;
            continue;
        }
        if (KEEP_MEMBER_MODS.has(word)) {
            i = wordEnd;
            continue;
        }
        break; // the key itself (an identifier name)
    }
}

/**
 * Blank an `implements` clause: from the `implements` keyword (char-scanned
 * back from the first heritage node) through the last heritage node's end.
 */
function blankImplements(ctx: Ctx, classId: NodeId): void {
    const ast = ctx.ast;
    const acc = ast.type[classId] === N.ClassDecl ? A.ClassDecl : A.ClassExpr;
    const impl = acc.implements(ast, classId);
    const n = listLen(ast, impl);
    if (n === 0) return;
    const first = listAt(ast, impl, 0);
    const last = listAt(ast, impl, n - 1);
    // scan back from the first heritage start to the start of "implements".
    const src = ctx.src;
    let i = ast.start[first];
    // back over whitespace
    while (i > 0 && isWs(src.charCodeAt(i - 1))) i--;
    // back over the keyword word
    let kwEnd = i;
    while (i > 0 && isIdentPart(src.charCodeAt(i - 1))) i--;
    if (src.slice(i, kwEnd) === 'implements') {
        blank(ctx, i, ast.end[last]);
    } else {
        // fallback: blank just the heritage nodes (keyword position uncertain)
        blank(ctx, ast.start[first], ast.end[last]);
    }
}

/* ------------------------------------------------------------ enum lowering */

/**
 * Lower a TSEnumDecl to the standard tsc runtime form:
 *
 *   var E;
 *   (function (E) {
 *       E[E["A"] = 0] = "A";        // numeric: reverse-mapped
 *       E["S"] = "str";             // string: forward only
 *   })(E || (E = {}));
 *
 * `exportId` non-zero (enum is an ExportNamed.decl) replaces the whole export
 * span with an `export var` form. LIMIT: const enums lowered identically to
 * plain enums (no inlining).
 */
function lowerEnum(ctx: Ctx, enumId: NodeId, exportId: NodeId): void {
    const ast = ctx.ast;
    const src = ctx.src;
    const nameId = A.TSEnumDecl.id(ast, enumId);
    const name = ctx.enumFinalName?.(nameId) ?? src.slice(ast.start[nameId], ast.end[nameId]);
    const members = A.TSEnumDecl.members(ast, enumId);
    const count = listLen(ast, members);

    let body = '';
    let autoNext = 0; // next auto-increment value (numeric)
    let autoOk = true; // whether auto-increment is currently valid

    for (let m = 0; m < count; m++) {
        const memberId = listAt(ast, members, m);
        const memId = A.TSEnumMember.id(ast, memberId);
        // member key: Ident text, or Str -> its inner value (quotes stripped)
        let key: string;
        if (ast.type[memId] === N.Str) {
            key = src.slice(ast.start[memId] + 1, ast.end[memId] - 1);
        } else {
            key = src.slice(ast.start[memId], ast.end[memId]);
        }
        const keyLit = JSON.stringify(key);
        const init = A.TSEnumMember.init(ast, memberId);

        if (init === 0) {
            // no initializer: auto-increment from previous numeric value
            if (!autoOk) {
                // previous member was non-constant (tsc errors here); fall back to numbering from 0
                autoNext = 0;
                autoOk = true;
            }
            body += `${name}[${name}[${keyLit}] = ${autoNext}] = ${keyLit}; `;
            autoNext++;
            continue;
        }

        // Raw initializer text: slice AFTER the `=` to member end, NOT the init
        // node's own span — the parser excludes wrapping parens from expression
        // spans, so `A = (1 << 4) | (1 << 5)` would slice unbalanced.
        const eq = scanForwardChar(ctx, ast.end[memId], ast.end[memberId], 61 /* = */);
        const raw = src.slice(eq + 1, ast.end[memberId]).trim();

        if (ast.type[init] === N.Str) {
            // string member: forward mapping only, no reverse.
            body += `${name}[${keyLit}] = ${raw}; `;
            autoOk = false;
        } else if (ast.type[init] === N.Num) {
            body += `${name}[${name}[${keyLit}] = ${raw}] = ${keyLit}; `;
            const v = Number(src.slice(ast.start[init], ast.end[init]));
            if (Number.isFinite(v)) {
                autoNext = v + 1;
                autoOk = true;
            } else {
                autoOk = false;
            }
        } else {
            // non-literal initializer expression: emit source verbatim in the
            // reverse-mapping form (matches tsc for numeric-typed exprs).
            body += `${name}[${name}[${keyLit}] = ${raw}] = ${keyLit}; `;
            autoOk = false; // can't statically continue auto-increment
        }
    }

    const varKw = exportId !== 0 && !ctx.dropExportKeyword ? 'export var' : 'var';
    const out = `${varKw} ${name}; (function (${name}) { ${body}})(${name} || (${name} = {}));`;

    const start = exportId !== 0 ? ast.start[exportId] : ast.start[enumId];
    const end = exportId !== 0 ? ast.end[exportId] : ast.end[enumId];
    replace(ctx, start, end, out);
}

/* ---------------------------------------------------------- specifier lists */

/**
 * In a value import/export, blank the type-only specifiers (FL.TYPE_ONLY) plus
 * exactly one adjacent comma so the surviving list stays syntactically valid.
 * Handles first / middle / last positions.
 */
function stripTypeOnlySpecifiers(ctx: Ctx, listRef: number): void {
    const ast = ctx.ast;
    const src = ctx.src;
    const n = listLen(ast, listRef);
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
        const specId = listAt(ast, listRef, i);
        if ((ast.flags[specId] & FL.TYPE_ONLY) === 0) continue;
        const s = ast.start[specId];
        let e = ast.end[specId];
        // absorb one adjacent comma. Prefer the trailing comma; if this is the
        // last specifier, absorb the leading comma instead.
        const after = skipWs(src, e, src.length);
        if (after < src.length && src.charCodeAt(after) === 44 /* , */) {
            e = after + 1;
        } else {
            // no trailing comma (last entry): pull back over the leading comma.
            let b = s;
            while (b > 0 && isWs(src.charCodeAt(b - 1))) b--;
            if (b > 0 && src.charCodeAt(b - 1) === 44 /* , */) {
                blank(ctx, b - 1, e);
                continue;
            }
        }
        blank(ctx, s, e);
    }
}

/* --------------------------------------------------------------- the walk */

/** true if this statement is a bare TS-erasable statement (whole span blanks). */
function isErasableStatement(ast: Ast, id: NodeId): boolean {
    const t = ast.type[id];
    if (t === N.TSInterfaceDecl || t === N.TSTypeAliasDecl) return true;
    if (ast.flags[id] & FL.DECLARE) return true; // declare var/func/class/...
    if (t === N.ImportDecl && ast.flags[id] & FL.TYPE_ONLY) return true;
    if (t === N.ExportNamed && ast.flags[id] & FL.TYPE_ONLY) return true;
    return false;
}

/** collect all edits for `program`. */
function collect(ctx: Ctx): void {
    const ast = ctx.ast;

    walk(ast, ctx.rootId, (id: NodeId): boolean | void => {
        const t = ast.type[id];

        // whole-statement erasure -----------------------------------------
        if (isErasableStatement(ast, id)) {
            blankNode(ctx, id);
            return false; // don't descend
        }

        // pure type nodes: blank the whole subtree, skip children ----------
        if (isTypeOnlyNode(t)) {
            blankNode(ctx, id);
            return false;
        }

        switch (t) {
            case N.ExportNamed: {
                // `export interface`/`export type X = ...`: decl is a type-only
                // decl -> blank the whole export statement.
                const decl = A.ExportNamed.decl(ast, id);
                if (decl !== 0 && (isTypeOnlyNode(ast.type[decl]) || isErasableStatement(ast, decl))) {
                    blankNode(ctx, id);
                    return false;
                }
                // `export enum`: lower with export prefix, skip subtree.
                if (decl !== 0 && ast.type[decl] === N.TSEnumDecl && (ast.flags[decl] & FL.DECLARE) === 0) {
                    lowerEnum(ctx, decl, id);
                    return false;
                }
                // value export: strip type-only specifiers, keep descending.
                stripTypeOnlySpecifiers(ctx, A.ExportNamed.specifiers(ast, id));
                return;
            }

            case N.ImportDecl: {
                stripTypeOnlySpecifiers(ctx, A.ImportDecl.specifiers(ast, id));
                return;
            }

            case N.TSEnumDecl: {
                // top-level (non-exported, non-declare) enum.
                if (ast.flags[id] & FL.DECLARE) {
                    blankNode(ctx, id);
                    return false;
                }
                lowerEnum(ctx, id, 0);
                return false;
            }

            case N.FuncDecl:
            case N.FuncExpr: {
                // bodyless FuncDecl is an overload signature -> whole node blanks
                // (bodyless FuncExpr is an abstract/overload method, handled at MethodDef).
                if ((t === N.FuncDecl ? A.FuncDecl.body(ast, id) : A.FuncExpr.body(ast, id)) === 0) {
                    if (t === N.FuncDecl) {
                        blankNode(ctx, id);
                        return false;
                    }
                }
                blankFuncTypeBits(ctx, id, t);
                return;
            }

            case N.Arrow: {
                blankFuncTypeBits(ctx, id, t);
                return;
            }

            case N.ClassDecl:
            case N.ClassExpr: {
                blankClassTypeBits(ctx, id, t);
                return;
            }

            case N.MethodDef: {
                if (blankMethodDef(ctx, id)) return false;
                return;
            }

            case N.PropDef: {
                if (blankPropDef(ctx, id)) return false;
                return;
            }

            case N.VarDeclarator: {
                // typeAnn is a TSTypeAnn child -> blanked by the type-node rule.
                // definite `!` between id and typeAnn/init.
                if (ast.flags[id] & FL.DEFINITE) {
                    const idNode = A.VarDeclarator.id(ast, id);
                    blankDefinite(ctx, ast.end[idNode], ast.end[id]);
                }
                return;
            }

            case N.Param: {
                blankParam(ctx, id);
                return;
            }

            case N.Call:
            case N.New: {
                // typeArgs child (TSTypeArgs) blanked by the type-node rule.
                return;
            }

            case N.TSAs:
            case N.TSSatisfies: {
                // Blank the `as T` / `satisfies T` suffix. The parser excludes
                // wrapping parens from node spans, so a parenthesized operand
                // like `(a) as T` leaves a `)` between expr.end and the `as`
                // keyword — we must start blanking AT the keyword, not right
                // after the operand, or we'd eat the closing paren.
                const expr = t === N.TSAs ? A.TSAs.expr(ast, id) : A.TSSatisfies.expr(ast, id);
                const kw = t === N.TSAs ? 'as' : 'satisfies';
                const kwStart = scanForwardKeyword(ctx, ast.end[expr], ast.end[id], kw);
                if (kwStart >= 0) blank(ctx, kwStart, ast.end[id]);
                return; // descend into expr (may contain nested strips)
            }

            case N.TSNonNull: {
                // Blank the trailing `!`. Scan forward for it (parens may sit
                // between the operand end and the `!`).
                const expr = A.TSNonNull.expr(ast, id);
                const bang = scanForwardChar(ctx, ast.end[expr], ast.end[id], 33 /* ! */);
                if (bang >= 0) blank(ctx, bang, bang + 1);
                return;
            }
        }
    });
}

/** blank typeParams + returnType on a function-like (children handle the rest). */
function blankFuncTypeBits(ctx: Ctx, id: NodeId, t: number): void {
    const ast = ctx.ast;
    const acc = t === N.FuncDecl ? A.FuncDecl : t === N.FuncExpr ? A.FuncExpr : A.Arrow;
    blankNode(ctx, acc.typeParams(ast, id));
    // returnType is a TSTypeAnn -> blanked by the type-node rule during walk.
}

/** blank typeParams, superTypeArgs, implements on a class. */
function blankClassTypeBits(ctx: Ctx, id: NodeId, t: number): void {
    const ast = ctx.ast;
    const acc = t === N.ClassDecl ? A.ClassDecl : A.ClassExpr;
    // `abstract` keyword (FL.ABSTRACT): sits before `class`.
    if (ast.flags[id] & FL.ABSTRACT) blankAbstractKeyword(ctx, id);
    blankNode(ctx, acc.typeParams(ast, id));
    blankNode(ctx, acc.superTypeArgs(ast, id));
    blankImplements(ctx, id);
}

/** Blank the leading `abstract` keyword on a class (included in the class span). */
function blankAbstractKeyword(ctx: Ctx, classId: NodeId): void {
    const ast = ctx.ast;
    const src = ctx.src;
    const start = ast.start[classId];
    if (isIdentStart(src.charCodeAt(start)) && readWord(src, start, ast.end[classId]) === 'abstract') {
        blank(ctx, start, start + 8);
        return;
    }
    let i = start;
    while (i > 0 && isWs(src.charCodeAt(i - 1))) i--;
    const kwEnd = i;
    while (i > 0 && isIdentPart(src.charCodeAt(i - 1))) i--;
    if (src.slice(i, kwEnd) === 'abstract') blank(ctx, i, kwEnd);
}

/**
 * MethodDef. Returns true if the whole member was blanked (abstract / overload
 * signature with no body -> caller skips descent).
 */
function blankMethodDef(ctx: Ctx, id: NodeId): boolean {
    const ast = ctx.ast;
    const value = A.MethodDef.value(ast, id);
    const abstractOrOverload =
        ast.flags[id] & FL.ABSTRACT || (value !== 0 && A.FuncExpr.body(ast, value) === 0);
    if (abstractOrOverload) {
        blankNode(ctx, id);
        return true;
    }
    const key = A.MethodDef.key(ast, id);
    blankMemberModifiers(ctx, ast.start[id], ast.start[key]);
    // optional `?` after the key (FL.OPTIONAL on the method).
    if (ast.flags[id] & FL.OPTIONAL) blankTrailingQuestion(ctx, ast.end[key], ast.end[id]);
    // typeParams/returnType live on the FuncExpr value; handled when the walk
    // reaches that FuncExpr node.
    return false;
}

/**
 * PropDef. Returns true if the whole member was blanked (declare / abstract).
 */
function blankPropDef(ctx: Ctx, id: NodeId): boolean {
    const ast = ctx.ast;
    if (ast.flags[id] & (FL.DECLARE | FL.ABSTRACT)) {
        blankNode(ctx, id);
        return true;
    }
    const key = A.PropDef.key(ast, id);
    blankMemberModifiers(ctx, ast.start[id], ast.start[key]);
    // optional `?` then definite `!` after the key (mutually exclusive).
    if (ast.flags[id] & FL.OPTIONAL) blankTrailingQuestion(ctx, ast.end[key], ast.end[id]);
    if (ast.flags[id] & FL.DEFINITE) blankDefinite(ctx, ast.end[key], ast.end[id]);
    // typeAnn (TSTypeAnn child) blanked by the type-node rule.
    return false;
}

/** Param: optional `?`, accessibility/readonly param-property modifiers. */
function blankParam(ctx: Ctx, id: NodeId): void {
    const ast = ctx.ast;
    const pattern = A.Param.pattern(ast, id);
    // param-property modifiers (accessibility / readonly): blank keyword region [param.start, pattern.start).
    // LIMIT: erases modifiers only; does NOT synthesize `this.x = x` ctor assignments.
    const access = (ast.flags[id] >> FL.ACCESS_SHIFT) & 3;
    if (access !== 0 || ast.flags[id] & FL.READONLY) {
        blankMemberModifiers(ctx, ast.start[id], ast.start[pattern]);
    }
    // optional `?` after the pattern (FL.OPTIONAL).
    if (ast.flags[id] & FL.OPTIONAL) {
        // limit: before typeAnn/init if present, else param end.
        const typeAnn = A.Param.typeAnn(ast, id);
        const init = A.Param.init(ast, id);
        const limit = typeAnn !== 0 ? ast.start[typeAnn] : init !== 0 ? ast.start[init] : ast.end[id];
        blankTrailingQuestion(ctx, ast.end[pattern], limit);
    }
    // typeAnn (TSTypeAnn) blanked by the type-node rule.
}

/* ---------------------------------------------------------------- assembly */

/**
 * Sort and apply `edits` to `src`. Edits are expected non-overlapping (outer
 * blanks skip descent); any overlap is clamped to the running cursor.
 */
export function applyEdits(src: string, edits: Edit[]): string {
    if (edits.length === 0) return src;
    edits.sort((x, y) => x.start - y.start || x.end - y.end);
    let out = '';
    let cursor = 0;
    for (const e of edits) {
        if (e.start < cursor) {
            // overlap: clamp to cursor to keep output well-formed
            if (e.end <= cursor) continue;
            out += e.text !== undefined ? e.text : blankText(src, cursor, e.end);
            cursor = e.end;
            continue;
        }
        out += src.slice(cursor, e.start);
        out += e.text !== undefined ? e.text : blankText(src, e.start, e.end);
        cursor = e.end;
    }
    out += src.slice(cursor);
    return out;
}

/* ------------------------------------------------------------------ entry */

/**
 * Emit the module rooted at `program`. With `stripTypes: false` (or a module
 * with no TS syntax) the result is byte-for-byte identical to the source.
 */
export function emitModule(ast: Ast, program: NodeId, options: EmitOptions): string {
    const src = ast.src;
    if (!options.stripTypes) return src;
    return applyEdits(src, collectStripEdits(ast, program, false, null));
}

/** The type-strip pass as reusable edits (the bundler merges these with its own). */
export function collectStripEdits(
    ast: Ast,
    program: NodeId,
    dropExportKeyword: boolean,
    enumFinalName: ((idNode: NodeId) => string | null) | null,
): Edit[] {
    const ctx: Ctx = { ast, src: ast.src, edits: [], rootId: program, dropExportKeyword, enumFinalName };
    collect(ctx);
    return ctx.edits;
}
