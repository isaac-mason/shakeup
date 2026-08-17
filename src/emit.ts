import { walkRefIdents } from './analysis/refs.ts';
import { isTypeOnlyNode, N, type Node, walk, walkChildren } from './ast.ts';
import { addLine, addSegment, type Mappings, newMappings, type Part, trimMappings } from './sourcemap.ts';

/** Emit options; `stripTypes: false` yields byte-identical passthrough. */
export type EmitOptions = { stripTypes: boolean };

/** JSX lowering hooks the bundler supplies. null => JSX is passed
 * through unchanged (parse/AST only — the emit-only strip path). */
export type JSXLower = {
    runtimeName: (kind: 'jsx' | 'jsxs' | 'Fragment' | 'createElement') => string;
    renameIdent: (idNode: Node) => string | null;
};

/** A point interior of an edit's replacement `text`: output offset `at` (within `text`) originates
 *  at source offset `src`. Lets a lowered blob (jsx()/enum) map its interior value expressions to
 *  their source rather than to one coarse block. */
export type Interior = { at: number; src: number };

/** An edit over the source. `text` present ⇒ replacement (`inner` optionally carries per-value
 *  provenance for fine mapping); absent ⇒ blank. */
export type Edit = { start: number; end: number; text?: string; inner?: Interior[] };

type Ctx = {
    src: string;
    edits: Edit[];
    root: Node;
    dropExportKeyword: boolean;
    enumFinalName: ((idNode: Node) => string | null) | null;
    jsx: JSXLower | null;
};

/** blank [start, end): each char -> space, but keep \n and \r for line parity. */
function blank(ctx: Ctx, start: number, end: number): void {
    if (end > start) ctx.edits.push({ start, end });
}

/** replace [start, end) with `text` verbatim (used only for runtime lowering). */
function replace(ctx: Ctx, start: number, end: number, text: string): void {
    ctx.edits.push({ start, end, text });
}

/** whitespace version of a source slice: everything -> space except \n and \r. (Regex replace is
 *  O(n); a per-char `out +=` build is O(n²) on a large blanked region.) */
function blankText(src: string, start: number, end: number): string {
    return src.slice(start, end).replace(/[^\n\r]/g, ' ');
}

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

function scanForwardKeyword(ctx: Ctx, from: number, limit: number, kw: string): number {
    const src = ctx.src;
    for (let i = from; i + kw.length <= limit; i++) {
        if (isIdentStart(src.charCodeAt(i))) {
            const w = readWord(src, i, limit);
            if (w === kw) return i;
            i += w.length - 1;
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

/** blank a whole node's span. */
function blankNode(ctx: Ctx, n: Node | null): void {
    if (n !== null) blank(ctx, n.start, n.end);
}

function blankTrailingQuestion(ctx: Ctx, afterEnd: number, limit: number): void {
    const src = ctx.src;
    const i = skipWs(src, afterEnd, limit);
    if (i < limit && src.charCodeAt(i) === 63) blank(ctx, i, i + 1);
}

function blankDefinite(ctx: Ctx, afterEnd: number, limit: number): void {
    const src = ctx.src;
    const i = skipWs(src, afterEnd, limit);
    if (i < limit && src.charCodeAt(i) === 33) blank(ctx, i, i + 1);
}

const ERASABLE_MEMBER_MODS = new Set(['public', 'private', 'protected', 'readonly', 'abstract', 'override', 'declare']);
const KEEP_MEMBER_MODS = new Set(['static', 'get', 'set', 'async']);
function blankMemberModifiers(ctx: Ctx, start: number, keyStart: number): void {
    const src = ctx.src;
    let i = start;
    for (;;) {
        i = skipWs(src, i, keyStart);
        if (i >= keyStart) break;
        const c = src.charCodeAt(i);
        if (!isIdentStart(c)) break;
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
        break;
    }
}

function blankImplements(ctx: Ctx, impl: Node[]): void {
    const n = impl.length;
    if (n === 0) return;
    const first = impl[0];
    const last = impl[n - 1];
    const src = ctx.src;
    let i = first.start;
    while (i > 0 && isWs(src.charCodeAt(i - 1))) i--;
    const kwEnd = i;
    while (i > 0 && isIdentPart(src.charCodeAt(i - 1))) i--;
    if (src.slice(i, kwEnd) === 'implements') {
        blank(ctx, i, last.end);
    } else {
        blank(ctx, first.start, last.end);
    }
}

/** Render an enum member's initializer over the RAW source range `[rawStart,rawEnd)`
 *  (paren-safe — a parenthesized expr's node span excludes its wrapping parens),
 *  rewriting bare references to prior members (`A` → `EnumName.A`) by splicing at
 *  their absolute source offsets. Returns the trimmed raw slice when nothing needs it. */
function renderEnumInit(ctx: Ctx, init: Node, prior: Set<string>, enumName: string, rawStart: number, rawEnd: number): string {
    const src = ctx.src;
    if (prior.size === 0) return src.slice(rawStart, rawEnd).trim();
    const edits: { start: number; end: number; text: string }[] = [];
    walkRefIdents(init, (ident) => {
        if (ident.type === N.IdentifierReference && prior.has(ident.name)) {
            edits.push({ start: ident.start, end: ident.end, text: `${enumName}.${ident.name}` });
        }
    });
    if (edits.length === 0) return src.slice(rawStart, rawEnd).trim();
    edits.sort((a, b) => a.start - b.start);
    let out = '';
    let cur = rawStart;
    for (const e of edits) {
        out += src.slice(cur, e.start) + e.text;
        cur = e.end;
    }
    return (out + src.slice(cur, rawEnd)).trim();
}

function lowerEnum(ctx: Ctx, enumNode: Node & { type: typeof N.TSEnumDeclaration }, exportNode: Node | null): void {
    const src = ctx.src;
    const nameNode = enumNode.data.id;
    const name = ctx.enumFinalName?.(nameNode) ?? src.slice(nameNode.start, nameNode.end);
    const members = enumNode.data.members;

    // Built as source-tracked pieces so each member initializer maps back to its source; the keys
    // and scaffolding are generated. The pieces assemble to the enum's runtime IIFE.
    const varKw = exportNode !== null && !ctx.dropExportKeyword ? 'export var' : 'var';
    const pieces: PieceItem[] = [];
    const put = (text: string, srcOff?: number): void => {
        pieces.push({ text, src: srcOff });
    };
    put(`${varKw} ${name}; (function (${name}) { `);

    let autoNext = 0;
    let autoOk = true;
    // Names of members declared so far. A bare reference to one of these inside a
    // later member's initializer resolves to that member (enum members shadow the
    // outer scope in initializer position), so it must be emitted as `Name.member`
    // — `A << 1` → `E.A << 1`. Without this the bare `A` is a ReferenceError.
    const prior = new Set<string>();

    for (const memberNode of members) {
        if (memberNode.type !== N.TSEnumMember) continue;
        const memId = memberNode.data.id;
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
            put(`${name}[${name}[${keyLit}] = ${autoNext}] = ${keyLit}; `);
            autoNext++;
            prior.add(key);
            continue;
        }

        const eq = scanForwardChar(ctx, memId.end, memberNode.end, 61 /* = */);
        const rendered = renderEnumInit(ctx, init, prior, name, eq + 1, memberNode.end);

        if (init.type === N.StringLiteral) {
            put(`${name}[${keyLit}] = `);
            put(rendered, init.start);
            put('; ');
            autoOk = false;
        } else if (init.type === N.NumericLiteral) {
            put(`${name}[${name}[${keyLit}] = `);
            put(rendered, init.start);
            put(`] = ${keyLit}; `);
            const v = Number(src.slice(init.start, init.end));
            if (Number.isFinite(v)) {
                autoNext = v + 1;
                autoOk = true;
            } else {
                autoOk = false;
            }
        } else {
            put(`${name}[${name}[${keyLit}] = `);
            put(rendered, init.start);
            put(`] = ${keyLit}; `);
            autoOk = false;
        }
        prior.add(key);
    }

    put(`})(${name} || (${name} = {}));`);

    const { text: out, inner } = assemblePieces(pieces);
    const start = exportNode !== null ? exportNode.start : enumNode.start;
    const end = exportNode !== null ? exportNode.end : enumNode.end;
    ctx.edits.push({ start, end, text: out, inner: inner.length > 0 ? inner : undefined });
}

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
        if (after < src.length && src.charCodeAt(after) === 44) {
            e = after + 1;
        } else {
            let b = s;
            while (b > 0 && isWs(src.charCodeAt(b - 1))) b--;
            if (b > 0 && src.charCodeAt(b - 1) === 44) {
                blank(ctx, b - 1, e);
                continue;
            }
        }
        blank(ctx, s, e);
    }
}

function renderNode(ctx: Ctx, node: Node): string {
    const sub: Ctx = { ...ctx, edits: [] };
    collect(sub, node);
    if (ctx.jsx !== null) {
        const rename = ctx.jsx.renameIdent;
        collectRenameEdits(node, (idNode, shorthandProp) => {
            const nn = rename(idNode);
            if (nn === null || nn === idNode.name) return;
            sub.edits.push({
                start: idNode.start,
                end: idNode.end,
                text: shorthandProp ? `${idNode.name}: ${nn}` : nn,
            });
        });
    }
    return applyEditsRange(ctx.src, node.start, node.end, sub.edits);
}

function collectRenameEdits(node: Node, cb: (idNode: Node, shorthand: boolean) => void): void {
    if (node.type === N.BindingIdentifier || node.type === N.IdentifierReference) {
        cb(node, false);
        return;
    }
    if (node.type === N.IdentifierName || node.type === N.LabelIdentifier || node.type === N.PrivateIdentifier) return;
    if (node.type === N.ObjectProperty && node.data.shorthand) {
        const value = node.data.value;
        if (value.type === N.BindingIdentifier || value.type === N.IdentifierReference) cb(value, true);
        else if (value.type === N.AssignmentPattern) {
            const left = value.data.left;
            if (left.type === N.BindingIdentifier || left.type === N.IdentifierReference) cb(left, true);
            collectRenameEdits(value.data.right, cb);
        }
        return;
    }
    walkChildren(node, (child) => {
        collectRenameEdits(child, cb);
    });
}

/** Apply `edits` (spans over `src`) restricted to `[from,to)`, returning the
 * transformed slice. Edits outside the range are ignored; overlaps clamp. */
function applyEditsRange(src: string, from: number, to: number, edits: Edit[]): string {
    const inRange = edits.filter((e) => e.start >= from && e.end <= to).sort((a, b) => a.start - b.start || a.end - b.end);
    let out = '';
    let cursor = from;
    for (const e of inRange) {
        if (e.start < cursor) {
            if (e.end <= cursor) continue;
            out += e.text ?? blankText(src, cursor, e.end);
            cursor = e.end;
            continue;
        }
        out += src.slice(cursor, e.start);
        out += e.text ?? blankText(src, e.start, e.end);
        cursor = e.end;
    }
    out += src.slice(cursor, to);
    return out;
}

const JSX_NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    copy: '©',
    reg: '®',
    trade: '™',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    bull: '•',
    middot: '·',
    deg: '°',
    laquo: '«',
    raquo: '»',
    times: '×',
    divide: '÷',
    euro: '€',
    pound: '£',
    cent: '¢',
    yen: '¥',
    sect: '§',
    para: '¶',
    dagger: '†',
    Dagger: '‡',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
};
export function decodeJSXEntities(s: string): string {
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
        if (body[0] === '#') {
            const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
        }
        const named = JSX_NAMED_ENTITIES[body];
        return named !== undefined ? named : m;
    });
}

export function normalizeJSXText(raw: string): string | null {
    const lines = raw.split('\n');
    let acc = '';
    let first = true;
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].replace(/\r$/, '');
        if (i !== 0) line = line.replace(/^[ \t\v\f ]+/, '');
        if (i !== lines.length - 1) line = line.replace(/[ \t\v\f ]+$/, '');
        if (line === '') continue;
        if (!first) acc += ' ';
        acc += line;
        first = false;
    }
    if (acc === '') return null;
    return decodeJSXEntities(acc);
}

/** Lower a JSX element name to its runtime `tag` argument text. */
function lowerJSXTag(ctx: Ctx, name: Node): string {
    switch (name.type) {
        case N.JSXIdentifier:
            return JSON.stringify(name.name);
        case N.IdentifierReference: {
            const nn = ctx.jsx!.renameIdent(name);
            return nn ?? name.name;
        }
        case N.ThisExpression:
            return 'this';
        case N.JSXMemberExpression:
            return `${lowerJSXTag(ctx, name.data.object)}.${(name.data.property as Node).name}`;
        case N.JSXNamespacedName:
            return JSON.stringify(`${(name.data.namespace as Node).name}:${(name.data.name as Node).name}`);
        default:
            return ctx.src.slice(name.start, name.end);
    }
}

/** A single attribute-name as an object-key text (identifier or quoted string). */
export function attrKeyText(name: Node): string {
    const raw =
        name.type === N.JSXNamespacedName ? `${(name.data.namespace as Node).name}:${(name.data.name as Node).name}` : name.name;
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(raw) ? raw : JSON.stringify(raw);
}

/** Render an attribute VALUE as an expression string. `null` value = `true`. */
function attrValueText(ctx: Ctx, value: Node | null): string {
    if (value === null) return 'true';
    if (value.type === N.StringLiteral) {
        const inner = ctx.src.slice(value.start + 1, value.end - 1);
        return JSON.stringify(decodeJSXEntities(inner));
    }
    if (value.type === N.JSXExpressionContainer) return renderNode(ctx, value.data.expression);
    if (value.type === N.JSXElement || value.type === N.JSXFragment) return renderNode(ctx, value);
    return renderNode(ctx, value);
}

/** Source offset an attribute value maps to (the expression inside `{}`, or the literal); none for a bare attr. */
function attrValueSrc(value: Node | null): number | undefined {
    if (value === null) return undefined;
    if (value.type === N.JSXExpressionContainer) return value.data.expression.start;
    return value.start;
}

/** A fragment of a lowered construct's output. `src` present ⇒ this fragment's text originates there. */
type PieceItem = { text: string; src?: number };

/** Assemble ordered pieces into the final text plus interiors — each `src`-bearing piece's output
 *  offset paired with its source offset — so a lowered construct's value expressions map to source. */
function assemblePieces(pieces: PieceItem[]): { text: string; inner: Interior[] } {
    let text = '';
    const inner: Interior[] = [];
    for (const p of pieces) {
        if (p.src !== undefined) inner.push({ at: text.length, src: p.src });
        text += p.text;
    }
    return { text, inner };
}

function lowerJSXChildItems(ctx: Ctx, children: Node[]): PieceItem[] {
    const out: PieceItem[] = [];
    for (const child of children) {
        if (child.type === N.JSXText) {
            const t = normalizeJSXText(child.name);
            if (t !== null) out.push({ text: JSON.stringify(t) });
        } else if (child.type === N.JSXExpressionContainer) {
            const expr = child.data.expression;
            if (expr.type === N.JSXEmptyExpression) continue;
            out.push({ text: renderNode(ctx, expr), src: expr.start });
        } else if (child.type === N.JSXSpreadChild) {
            out.push({ text: `...${renderNode(ctx, child.data.expression)}`, src: child.data.expression.start });
        } else if (child.type === N.JSXElement || child.type === N.JSXFragment) {
            out.push({ text: renderNode(ctx, child), src: child.start });
        }
    }
    return out;
}

/** True when the folded children form a static ARRAY (jsxs): >1 child, or a
 * single spread child. */
export function childrenAreStatic(childTexts: string[]): boolean {
    if (childTexts.length > 1) return true;
    return childTexts.length === 1 && childTexts[0].startsWith('...');
}

/** Build the `children:` prop value text (0 → null meaning absent; 1 → value;
 * >1 → array). Returns null when there are no children. */
function childrenPropText(childTexts: string[]): string | null {
    if (childTexts.length === 0) return null;
    if (childTexts.length === 1 && !childTexts[0].startsWith('...')) return childTexts[0];
    return `[${childTexts.join(', ')}]`;
}

/** Lower a JSXElement/JSXFragment to its automatic-runtime call, built as source-tracked pieces so
 *  its value expressions (attributes, children, key) map back to their own source. */
function lowerJSX(ctx: Ctx, node: Node): { text: string; inner: Interior[] } {
    const jsx = ctx.jsx!;
    let tag: string;
    let tagSrc: number;
    let attributes: Node[];
    let children: Node[];
    if (node.type === N.JSXFragment) {
        const d = (node as Node & { type: typeof N.JSXFragment }).data;
        tag = jsx.runtimeName('Fragment');
        tagSrc = node.start;
        attributes = [];
        children = d.children;
    } else {
        const d = (node as Node & { type: typeof N.JSXElement }).data;
        const opening = d.openingElement as Node & { type: typeof N.JSXOpeningElement };
        tag = lowerJSXTag(ctx, opening.data.name);
        tagSrc = opening.data.name.start;
        attributes = opening.data.attributes;
        children = d.children;
    }

    const pieces: PieceItem[] = [];
    const put = (text: string, src?: number): void => {
        pieces.push({ text, src });
    };
    // one attribute → its `key: value` (or `...spread`) pieces
    const putAttr = (a: Node): void => {
        if (a.type === N.JSXSpreadAttribute) {
            put('...');
            put(renderNode(ctx, a.data.argument), a.data.argument.start);
        } else if (a.type === N.JSXAttribute) {
            put(`${attrKeyText(a.data.name)}: `);
            put(attrValueText(ctx, a.data.value), attrValueSrc(a.data.value));
        }
    };

    const childItems = lowerJSXChildItems(ctx, children);
    const childTexts = childItems.map((c) => c.text);
    const keyAfterSpread = attrsHaveKeyAfterSpreadEmit(attributes);

    if (keyAfterSpread) {
        put(`${jsx.runtimeName('createElement')}(`);
        put(tag, tagSrc);
        const propAttrs = attributes.filter((a) => a.type === N.JSXSpreadAttribute || a.type === N.JSXAttribute);
        if (propAttrs.length > 0) {
            put(', { ');
            propAttrs.forEach((a, i) => {
                if (i > 0) put(', ');
                putAttr(a);
            });
            put(' }');
        } else put(', null');
        for (const c of childItems) {
            put(', ');
            put(c.text, c.src);
        }
        put(')');
        return assemblePieces(pieces);
    }

    let keyText: string | null = null;
    let keySrc: number | undefined;
    const propAttrs: Node[] = [];
    for (const a of attributes) {
        if (a.type === N.JSXSpreadAttribute) {
            propAttrs.push(a);
        } else if (a.type === N.JSXAttribute) {
            const name = a.data.name;
            if (name.type === N.JSXIdentifier && name.name === 'key') {
                keyText = attrValueText(ctx, a.data.value);
                keySrc = attrValueSrc(a.data.value);
                continue;
            }
            propAttrs.push(a);
        }
    }
    const childrenProp = childrenPropText(childTexts);
    const fn = childrenAreStatic(childTexts) ? jsx.runtimeName('jsxs') : jsx.runtimeName('jsx');
    put(`${fn}(`);
    put(tag, tagSrc);
    put(', ');
    if (propAttrs.length > 0 || childrenProp !== null) {
        put('{ ');
        let first = true;
        for (const a of propAttrs) {
            if (!first) put(', ');
            first = false;
            putAttr(a);
        }
        if (childrenProp !== null) {
            if (!first) put(', ');
            put('children: ');
            if (childItems.length === 1 && !childTexts[0].startsWith('...')) {
                put(childItems[0].text, childItems[0].src);
            } else {
                put('[');
                childItems.forEach((c, i) => {
                    if (i > 0) put(', ');
                    put(c.text, c.src);
                });
                put(']');
            }
        }
        put(' }');
    } else put('{}');
    if (keyText !== null) {
        put(', ');
        put(keyText, keySrc);
    }
    put(')');
    return assemblePieces(pieces);
}

/** Local copy of the key-after-spread check (emit side; graph has its own). */
export function attrsHaveKeyAfterSpreadEmit(attrs: Node[]): boolean {
    let sawSpread = false;
    for (const a of attrs) {
        if (a.type === N.JSXSpreadAttribute) sawSpread = true;
        else if (a.type === N.JSXAttribute) {
            const name = a.data.name;
            if (sawSpread && name.type === N.JSXIdentifier && name.name === 'key') return true;
        }
    }
    return false;
}

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

/** collect all edits for the module (or a subtree when `root` is given). */
function collect(ctx: Ctx, root?: Node): void {
    walk(root ?? ctx.root, (n: Node): boolean | void => {
        if (ctx.jsx !== null && (n.type === N.JSXElement || n.type === N.JSXFragment)) {
            const low = lowerJSX(ctx, n);
            ctx.edits.push({ start: n.start, end: n.end, text: low.text, inner: low.inner.length > 0 ? low.inner : undefined });
            return false;
        }
        if (isErasableStatement(n)) {
            blankNode(ctx, n);
            return false;
        }

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
                if (n.data.body === null) {
                    blankNode(ctx, n);
                    return false;
                }
                blankNode(ctx, n.data.typeParameters);
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
                synthParamProps(ctx, n);
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
                if (blankThisParam(ctx, n)) return false;
                blankParam(ctx, n);
                return;
            }

            case N.CallExpression:
            case N.NewExpression: {
                return;
            }

            case N.TSAsExpression:
            case N.TSSatisfiesExpression: {
                const expr = n.data.expression;
                const kw = n.type === N.TSAsExpression ? 'as' : 'satisfies';
                const kwStart = scanForwardKeyword(ctx, expr.end, n.end, kw);
                if (kwStart >= 0) blank(ctx, kwStart, n.end);
                return;
            }

            case N.TSNonNullExpression: {
                const expr = n.data.expression;
                const bang = scanForwardChar(ctx, expr.end, n.end, 33);
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

/** True if `n` is a `super(...)` call statement (parameter-property assignments must follow it). */
function isSuperCallStmt(n: Node): boolean {
    if (n.type !== N.ExpressionStatement) return false;
    const e = n.data.expression;
    return e.type === N.CallExpression && e.data.callee.type === N.Super;
}

/** Synthesize `this.x = x;` for each TS parameter property (`constructor(private x: number)`).
 *  Inserted at the top of the constructor body, or right after `super(...)` in a derived class
 *  (touching `this` before super is illegal). Emit-time transform, modeled on lowerEnum. */
function synthParamProps(ctx: Ctx, n: Node & { type: typeof N.MethodDefinition }): void {
    if (n.data.kind !== 'constructor') return;
    const value = n.data.value;
    if (value.type !== N.FunctionExpression) return;
    const body = value.data.body;
    if (body === null || body.type !== N.BlockStatement) return;
    let inject = '';
    for (const p of value.data.params) {
        if (p.type !== N.FormalParameter) continue;
        if (p.data.accessibility === null && !p.data.readonly) continue;
        const pat = p.data.pattern;
        if (pat.type !== N.BindingIdentifier) continue; // TS forbids destructuring param props
        inject += ` this.${pat.name} = ${pat.name};`;
    }
    if (inject === '') return;
    const first = body.data.body[0] ?? null;
    if (first !== null && isSuperCallStmt(first)) {
        replace(ctx, first.end, first.end, `;${inject}`); // leading `;` guards ASI after `super()`
    } else {
        replace(ctx, body.start + 1, body.start + 1, inject);
    }
}

function blankMethodDef(ctx: Ctx, n: Node & { type: typeof N.MethodDefinition }): boolean {
    const value = n.data.value;
    const abstractOrOverload = n.data.abstract || (value.type === N.FunctionExpression && value.data.body === null);
    if (abstractOrOverload) {
        blankNode(ctx, n);
        return true;
    }
    const key = n.data.key;
    blankMemberModifiers(ctx, n.start, key.start);
    if (n.data.optional) blankTrailingQuestion(ctx, key.end, n.end);
    return false;
}

function blankPropDef(ctx: Ctx, n: Node & { type: typeof N.PropertyDefinition }): boolean {
    if (n.data.declare || n.data.abstract) {
        blankNode(ctx, n);
        return true;
    }
    const key = n.data.key;
    blankMemberModifiers(ctx, n.start, key.start);
    if (n.data.optional) blankTrailingQuestion(ctx, key.end, n.end);
    if (n.data.definite) blankDefinite(ctx, key.end, n.end);
    return false;
}

/** A TS `this` parameter (`function f(this: T, ...)`) is not a runtime parameter — `this` is a
 *  reserved word, so keeping it emits broken JS. Remove the whole param plus its trailing comma
 *  so the parameter list stays valid. Returns true when it removed a `this` param. */
function blankThisParam(ctx: Ctx, n: Node & { type: typeof N.FormalParameter }): boolean {
    const p = n.data.pattern;
    if (p.type !== N.BindingIdentifier || p.name !== 'this') return false;
    blank(ctx, n.start, n.end);
    const i = skipWs(ctx.src, n.end, ctx.src.length);
    if (i < ctx.src.length && ctx.src.charCodeAt(i) === 44 /* , */) blank(ctx, i, i + 1);
    return true;
}

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
}

/** Mapping cursor threaded through {@link renderEdits} when a source map is wanted. Tracks the
 *  current source and generated position (line, UTF-16 column, both 0-based); `seg` collects segments. */
export type MapCtx = {
    seg: Mappings;
    srcIdx: number;
    srcLine: number;
    srcCol: number;
    genLine: number;
    genCol: number;
    lines: number[]; // source line-start table (UTF-16 offsets), for interior positions
};

/** UTF-16 line-start offsets of `src` — the table for {@link srcPosAt}. */
export const buildLineTable = (src: string): number[] => {
    const t = [0];
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) t.push(i + 1);
    return t;
};

/** (line, UTF-16 column) of source offset `off` via a precomputed line table. */
function srcPosAt(lines: number[], off: number): { line: number; col: number } {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lines[mid] <= off) lo = mid;
        else hi = mid - 1;
    }
    return { line: lo, col: off - lines[lo] };
}

const isWordChar = (c: number): boolean =>
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 36;

/** Boundary-granularity segments for a verbatim-copied span src[from,to): a segment at each word
 *  start and each non-space punctuation char. Source and generated cursors advance in lockstep. */
function mapKept(m: MapCtx, src: string, from: number, to: number): void {
    let inWord = false;
    for (let i = from; i < to; i++) {
        const c = src.charCodeAt(i);
        if (c === 10) {
            m.genLine++;
            m.genCol = 0;
            m.srcLine++;
            m.srcCol = 0;
            addLine(m.seg);
            inWord = false;
            continue;
        }
        if (isWordChar(c)) {
            if (!inWord) {
                addSegment(m.seg, m.genCol, m.srcIdx, m.srcLine, m.srcCol);
                inWord = true;
            }
        } else {
            inWord = false;
            if (c !== 32 && c !== 9 && c !== 13) addSegment(m.seg, m.genCol, m.srcIdx, m.srcLine, m.srcCol);
        }
        m.genCol++;
        m.srcCol++;
    }
}

/** Map an edit whose generated output is `piece`, consuming source [srcFrom,srcTo): one segment
 *  anchoring the piece to the source start, then advance the gen (over piece) and src cursors apart. */
function mapEdit(m: MapCtx, src: string, piece: string, srcFrom: number, srcTo: number, inner?: Interior[]): void {
    if (piece.length > 0) addSegment(m.seg, m.genCol, m.srcIdx, m.srcLine, m.srcCol); // block anchor (construct start)
    const pts = inner === undefined || inner.length <= 1 ? inner : [...inner].sort((a, b) => a.at - b.at);
    let ii = 0;
    const emitInteriorsAt = (at: number): void => {
        while (pts !== undefined && ii < pts.length && pts[ii].at === at) {
            const p = srcPosAt(m.lines, pts[ii].src);
            addSegment(m.seg, m.genCol, m.srcIdx, p.line, p.col); // fine: value's output start → its source
            ii++;
        }
    };
    for (let i = 0; i < piece.length; i++) {
        emitInteriorsAt(i);
        if (piece.charCodeAt(i) === 10) {
            m.genLine++;
            m.genCol = 0;
            addLine(m.seg);
        } else m.genCol++;
    }
    emitInteriorsAt(piece.length);
    for (let i = srcFrom; i < srcTo; i++) {
        if (src.charCodeAt(i) === 10) {
            m.srcLine++;
            m.srcCol = 0;
        } else m.srcCol++;
    }
}

/**
 * Apply `edits` to `src`, returning the transformed string. When `map` is provided the SAME walk
 * also emits Boundary-granularity mapping segments (so code and map cannot drift). {@link applyEdits}
 * is exactly this walk with no map — the string is built by identical statements either way.
 */
export function renderEdits(src: string, edits: Edit[], map: MapCtx | null): string {
    if (edits.length === 0) {
        if (map) mapKept(map, src, 0, src.length);
        return src;
    }
    edits.sort((x, y) => x.start - y.start || x.end - y.end);
    let out = '';
    let cursor = 0;
    for (const e of edits) {
        if (e.start < cursor) {
            if (e.end <= cursor) continue;
            const piece = e.text !== undefined ? e.text : blankText(src, cursor, e.end);
            out += piece;
            if (map) mapEdit(map, src, piece, cursor, e.end, e.inner);
            cursor = e.end;
            continue;
        }
        out += src.slice(cursor, e.start);
        if (map) mapKept(map, src, cursor, e.start);
        const piece = e.text !== undefined ? e.text : blankText(src, e.start, e.end);
        out += piece;
        if (map) mapEdit(map, src, piece, e.start, e.end, e.inner);
        cursor = e.end;
    }
    out += src.slice(cursor);
    if (map) mapKept(map, src, cursor, src.length);
    return out;
}

export function applyEdits(src: string, edits: Edit[]): string {
    return renderEdits(src, edits, null);
}

/** Render `edits` over `src` (source index `srcIdx`) into a trimmed, mapped {@link Part} — the
 *  map version of `applyEdits(src, edits).trim()`, for assembly with `joinParts`. */
export function renderMappedPart(src: string, edits: Edit[], srcIdx: number): Part {
    const seg = newMappings();
    const m: MapCtx = { seg, srcIdx, srcLine: 0, srcCol: 0, genLine: 0, genCol: 0, lines: buildLineTable(src) };
    const code = trimMappings(renderEdits(src, edits, m), seg);
    return { code, map: seg };
}

/**
 * Emit the module rooted at `program` over its `source`. With `stripTypes: false`
 * (or a module with no TS syntax) the result is byte-for-byte identical to source.
 */
export function emitModule(program: Node, source: string, options: EmitOptions): string {
    if (!options.stripTypes) return source;
    return applyEdits(source, collectStripEdits(program, source, false, null, null));
}

/** The type-strip pass as reusable edits (the bundler merges these with its own).
 * `jsx` non-null lowers JSX to runtime calls; null passes JSX through (strip only). */
export function collectStripEdits(
    program: Node,
    source: string,
    dropExportKeyword: boolean,
    enumFinalName: ((idNode: Node) => string | null) | null,
    jsx: JSXLower | null,
): Edit[] {
    const ctx: Ctx = { src: source, edits: [], root: program, dropExportKeyword, enumFinalName, jsx };
    collect(ctx);
    return ctx.edits;
}
