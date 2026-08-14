// TS type stripping by span blanking (ts-blank-space model) plus enum lowering.
// AST-driven: a single walk collects edits that are sorted and applied by slicing.
// Edits are spans over the module SOURCE (the edit engine); the type+data tree
// carries .start/.end, and the source is supplied by the caller.

import { type Node, N, isTypeOnlyNode, walk } from './ast.ts';

/** Emit options; `stripTypes: false` yields byte-identical passthrough. */
export type EmitOptions = { stripTypes: boolean };

/* ------------------------------------------------------------------ edits */

/** An edit over the source. `text` present => replacement; absent => blank. */
export type Edit = { start: number; end: number; text?: string };

type Ctx = {
    src: string;
    edits: Edit[];
    root: Node;
    /** bundling mode: lowered enums emit `var` instead of `export var` (the
     * bundler removes module export syntax and re-exports at the entry) */
    dropExportKeyword: boolean;
    /** bundling: final (deconflicted) name for an enum's declaring Ident node */
    enumFinalName: ((idNode: Node) => string | null) | null;
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
 * return its start offset, or -1. Skips any intervening non-word chars.
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
function blankNode(ctx: Ctx, n: Node | null): void {
    if (n !== null) blank(ctx, n.start, n.end);
}

/**
 * Blank an optional `?` that sits immediately after `afterEnd` (skipping ws).
 * Used for optional params and optional class members.
 */
function blankTrailingQuestion(ctx: Ctx, afterEnd: number, limit: number): void {
    const src = ctx.src;
    const i = skipWs(src, afterEnd, limit);
    if (i < limit && src.charCodeAt(i) === 63 /* ? */) blank(ctx, i, i + 1);
}

/**
 * Blank a definite-assignment `!` that sits between the id/key span end and the
 * next child (typeAnn) or the declarator/prop end.
 */
function blankDefinite(ctx: Ctx, afterEnd: number, limit: number): void {
    const src = ctx.src;
    const i = skipWs(src, afterEnd, limit);
    if (i < limit && src.charCodeAt(i) === 33 /* ! */) blank(ctx, i, i + 1);
}

/**
 * Blank leading member-modifier keywords in [start, keyStart): the erasable
 * TS ones (accessibility, readonly, abstract, override, declare). Real JS
 * modifiers (static, get, set, async, *) are kept.
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
function blankImplements(ctx: Ctx, impl: Node[]): void {
    const n = impl.length;
    if (n === 0) return;
    const first = impl[0];
    const last = impl[n - 1];
    const src = ctx.src;
    let i = first.start;
    while (i > 0 && isWs(src.charCodeAt(i - 1))) i--;
    let kwEnd = i;
    while (i > 0 && isIdentPart(src.charCodeAt(i - 1))) i--;
    if (src.slice(i, kwEnd) === 'implements') {
        blank(ctx, i, last.end);
    } else {
        blank(ctx, first.start, last.end);
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
 * `exportNode` non-null (enum is an ExportNamed.decl) replaces the whole export
 * span with an `export var` form. LIMIT: const enums lowered identically.
 */
function lowerEnum(ctx: Ctx, enumNode: Node & { type: typeof N.TSEnumDeclaration }, exportNode: Node | null): void {
    const src = ctx.src;
    const nameNode = enumNode.data.id;
    const name = ctx.enumFinalName?.(nameNode) ?? src.slice(nameNode.start, nameNode.end);
    const members = enumNode.data.members;

    let body = '';
    let autoNext = 0; // next auto-increment value (numeric)
    let autoOk = true; // whether auto-increment is currently valid

    for (const memberNode of members) {
        if (memberNode.type !== N.TSEnumMember) continue;
        const memId = memberNode.data.id;
        // member key: Ident text, or Str -> its inner value (quotes stripped)
        let key: string;
        if (memId.type === N.StringLiteral) {
            key = src.slice(memId.start + 1, memId.end - 1);
        } else {
            key = src.slice(memId.start, memId.end);
        }
        const keyLit = JSON.stringify(key);
        const init = memberNode.data.initializer;

        if (init === null) {
            if (!autoOk) {
                autoNext = 0;
                autoOk = true;
            }
            body += `${name}[${name}[${keyLit}] = ${autoNext}] = ${keyLit}; `;
            autoNext++;
            continue;
        }

        // Raw initializer text: slice AFTER the `=` to member end, NOT the init
        // node's own span — the parser excludes wrapping parens from expression spans.
        const eq = scanForwardChar(ctx, memId.end, memberNode.end, 61 /* = */);
        const raw = src.slice(eq + 1, memberNode.end).trim();

        if (init.type === N.StringLiteral) {
            body += `${name}[${keyLit}] = ${raw}; `;
            autoOk = false;
        } else if (init.type === N.NumericLiteral) {
            body += `${name}[${name}[${keyLit}] = ${raw}] = ${keyLit}; `;
            const v = Number(src.slice(init.start, init.end));
            if (Number.isFinite(v)) {
                autoNext = v + 1;
                autoOk = true;
            } else {
                autoOk = false;
            }
        } else {
            body += `${name}[${name}[${keyLit}] = ${raw}] = ${keyLit}; `;
            autoOk = false;
        }
    }

    const varKw = exportNode !== null && !ctx.dropExportKeyword ? 'export var' : 'var';
    const out = `${varKw} ${name}; (function (${name}) { ${body}})(${name} || (${name} = {}));`;

    const start = exportNode !== null ? exportNode.start : enumNode.start;
    const end = exportNode !== null ? exportNode.end : enumNode.end;
    replace(ctx, start, end, out);
}

/* ---------------------------------------------------------- specifier lists */

/**
 * In a value import/export, blank the type-only specifiers plus exactly one
 * adjacent comma so the surviving list stays syntactically valid.
 */
function stripTypeOnlySpecifiers(ctx: Ctx, specs: Node[]): void {
    const src = ctx.src;
    for (const specNode of specs) {
        const typeOnly =
            (specNode.type === N.ImportSpecifier && specNode.data.importKind === 'type') ||
            (specNode.type === N.ExportSpecifier && specNode.data.exportKind === 'type');
        if (!typeOnly) continue;
        const s = specNode.start;
        let e = specNode.end;
        const after = skipWs(src, e, src.length);
        if (after < src.length && src.charCodeAt(after) === 44 /* , */) {
            e = after + 1;
        } else {
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
function isErasableStatement(n: Node): boolean {
    if (n.type === N.TSInterfaceDeclaration || n.type === N.TSTypeAliasDeclaration) return true;
    if (n.type === N.FunctionDeclaration && n.data.declare) return true;
    if (n.type === N.ClassDeclaration && n.data.declare) return true;
    if (n.type === N.VariableDeclaration && n.data.declare) return true;
    if (n.type === N.TSModuleDeclaration && n.data.declare) return true;
    if (n.type === N.TSEnumDeclaration && n.data.declare) return true;
    if (n.type === N.ImportDeclaration && n.data.importKind === 'type') return true;
    if (n.type === N.ExportNamedDeclaration && n.data.exportKind === 'type') return true;
    return false;
}

/** collect all edits for the module. */
function collect(ctx: Ctx): void {
    walk(ctx.root, (n: Node): boolean | void => {
        // whole-statement erasure -----------------------------------------
        if (isErasableStatement(n)) {
            blankNode(ctx, n);
            return false; // don't descend
        }

        // pure type nodes: blank the whole subtree, skip children ----------
        if (isTypeOnlyNode(n.type)) {
            blankNode(ctx, n);
            return false;
        }

        switch (n.type) {
            case N.ExportNamedDeclaration: {
                const decl = n.data.declaration;
                if (decl !== null && (isTypeOnlyNode(decl.type) || isErasableStatement(decl))) {
                    blankNode(ctx, n);
                    return false;
                }
                if (decl !== null && decl.type === N.TSEnumDeclaration && !decl.data.declare) {
                    lowerEnum(ctx, decl, n);
                    return false;
                }
                stripTypeOnlySpecifiers(ctx, n.data.specifiers);
                return;
            }

            case N.ImportDeclaration: {
                stripTypeOnlySpecifiers(ctx, n.data.specifiers);
                return;
            }

            case N.TSEnumDeclaration: {
                if (n.data.declare) {
                    blankNode(ctx, n);
                    return false;
                }
                lowerEnum(ctx, n, null);
                return false;
            }

            case N.FunctionDeclaration: {
                // bodyless FuncDecl is an overload signature -> whole node blanks
                if (n.data.body === null) {
                    blankNode(ctx, n);
                    return false;
                }
                blankNode(ctx, n.data.typeParameters);
                // returnType is a TSTypeAnn -> blanked by the type-node rule.
                return;
            }
            case N.FunctionExpression: {
                blankNode(ctx, n.data.typeParameters);
                return;
            }

            case N.ArrowFunctionExpression: {
                blankNode(ctx, n.data.typeParameters);
                return;
            }

            case N.ClassDeclaration:
            case N.ClassExpression: {
                if (n.type === N.ClassDeclaration && n.data.abstract) blankAbstractKeyword(ctx, n);
                blankNode(ctx, n.data.typeParameters);
                blankNode(ctx, n.data.superTypeArguments);
                blankImplements(ctx, n.data.implements);
                return;
            }

            case N.MethodDefinition: {
                if (blankMethodDef(ctx, n)) return false;
                return;
            }

            case N.PropertyDefinition: {
                if (blankPropDef(ctx, n)) return false;
                return;
            }

            case N.VariableDeclarator: {
                if (n.data.definite) {
                    blankDefinite(ctx, n.data.id.end, n.end);
                }
                return;
            }

            case N.FormalParameter: {
                blankParam(ctx, n);
                return;
            }

            case N.CallExpression:
            case N.NewExpression: {
                // typeArgs child (TSTypeArgs) blanked by the type-node rule.
                return;
            }

            case N.TSAsExpression:
            case N.TSSatisfiesExpression: {
                const expr = n.data.expression;
                const kw = n.type === N.TSAsExpression ? 'as' : 'satisfies';
                const kwStart = scanForwardKeyword(ctx, expr.end, n.end, kw);
                if (kwStart >= 0) blank(ctx, kwStart, n.end);
                return; // descend into expr (may contain nested strips)
            }

            case N.TSNonNullExpression: {
                const expr = n.data.expression;
                const bang = scanForwardChar(ctx, expr.end, n.end, 33 /* ! */);
                if (bang >= 0) blank(ctx, bang, bang + 1);
                return;
            }
        }
    });
}

/** Blank the leading `abstract` keyword on a class (included in the class span). */
function blankAbstractKeyword(ctx: Ctx, classNode: Node): void {
    const src = ctx.src;
    const start = classNode.start;
    if (isIdentStart(src.charCodeAt(start)) && readWord(src, start, classNode.end) === 'abstract') {
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
function blankMethodDef(ctx: Ctx, n: Node & { type: typeof N.MethodDefinition }): boolean {
    const value = n.data.value;
    const abstractOrOverload =
        n.data.abstract || (value.type === N.FunctionExpression && value.data.body === null);
    if (abstractOrOverload) {
        blankNode(ctx, n);
        return true;
    }
    const key = n.data.key;
    blankMemberModifiers(ctx, n.start, key.start);
    // optional `?` after the key (on a method with a body).
    if (n.data.optional) blankTrailingQuestion(ctx, key.end, n.end);
    return false;
}

/**
 * PropDef. Returns true if the whole member was blanked (declare / abstract).
 */
function blankPropDef(ctx: Ctx, n: Node & { type: typeof N.PropertyDefinition }): boolean {
    if (n.data.declare || n.data.abstract) {
        blankNode(ctx, n);
        return true;
    }
    const key = n.data.key;
    blankMemberModifiers(ctx, n.start, key.start);
    if (n.data.optional) blankTrailingQuestion(ctx, key.end, n.end);
    if (n.data.definite) blankDefinite(ctx, key.end, n.end);
    // typeAnn (TSTypeAnn child) blanked by the type-node rule.
    return false;
}

/** Param: optional `?`, accessibility/readonly param-property modifiers. */
function blankParam(ctx: Ctx, n: Node & { type: typeof N.FormalParameter }): void {
    const pattern = n.data.pattern;
    if (n.data.accessibility !== null || n.data.readonly) {
        blankMemberModifiers(ctx, n.start, pattern.start);
    }
    if (n.data.optional) {
        const typeAnn = n.data.typeAnnotation;
        const init = n.data.init;
        const limit = typeAnn !== null ? typeAnn.start : init !== null ? init.start : n.end;
        blankTrailingQuestion(ctx, pattern.end, limit);
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
 * Emit the module rooted at `program` over its `source`. With `stripTypes: false`
 * (or a module with no TS syntax) the result is byte-for-byte identical to source.
 */
export function emitModule(program: Node, source: string, options: EmitOptions): string {
    if (!options.stripTypes) return source;
    return applyEdits(source, collectStripEdits(program, source, false, null));
}

/** The type-strip pass as reusable edits (the bundler merges these with its own). */
export function collectStripEdits(
    program: Node,
    source: string,
    dropExportKeyword: boolean,
    enumFinalName: ((idNode: Node) => string | null) | null,
): Edit[] {
    const ctx: Ctx = { src: source, edits: [], root: program, dropExportKeyword, enumFinalName };
    collect(ctx);
    return ctx.edits;
}
