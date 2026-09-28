import { lineColOf, type Node } from '../ast/index.ts';
import { CommentKind, classifyComment, commentAttachedTo, commentCount, commentEnd, commentStart } from '../parser/comments.ts';
import { addLine, addSegment, type Mappings, newMappings } from '../util/sourcemap.ts';

/** Options controlling how the printer renders. Whitespace and syntactic-form
 *  selection are toggled by `minify` — the single flag oxc's codegen keys off
 *  (`llm/libs/oxc/crates/oxc_codegen/src/options.rs:16`). */
export type PrintOptions = {
    minify: boolean;
    /** Preserve a class's `.name` when deconfliction renamed its binding — see
     *  {@link Printer.originalNameSym}. Off by default, as in rolldown and esbuild. */
    keepNames?: boolean;
};

/** Resolve an identifier node to its final output name. In a full bundle this wraps
 *  `renameOf` (finalNames / cross-chunk locals, `src/bundle.ts:152`); standalone it
 *  falls back to the node's own text. Never returns null — the caller defaults. */
export type NameResolver = (identNode: Node) => string;

/** A stretch of the positions a printed program uses, from `start` up to the next region's start,
 *  belonging to one original source. */
export type SourceRegion = {
    start: number;
    /** Line-start offsets of that source, relative to `start`. */
    lines: Uint32Array;
    /** Index of the source in the map's `sources`, -1 for text with no source to map to. */
    sourceIdx: number;
};

/** Extra config for {@link createPrinter}. Providing `sources` turns on sourcemap
 *  building (segments emitted during the walk, oxc's `SourcemapBuilder` model). */
export type PrinterConfig = {
    nameOf?: NameResolver;
    /** The mangler's private member names, one map per class in the order the mangler met the classes: oxc
     *  codegen's `with_private_member_mappings`. */
    privateMemberMappings?: readonly ReadonlyMap<string, string>[];
    /** The regions node positions fall in, in position order. Enables the map. */
    sources?: SourceRegion[];
    /** Retained comment spans for THIS module, plus the source they index into. Both or neither:
     *  the spans are meaningless without the text. Absent ⇒ no comments are printed. */
    comments?: Int32Array;
    src?: string;
    /** Which comment classes to print. rolldown's defaults (`comments.rs:26`), minus `normal`,
     *  which rolldown does not print either. */
    commentOpts?: CommentPrintOptions;
};

/** Mirrors rolldown's `PrintCommentsOptions` (`rolldown_ecmascript/src/ecma_compiler.rs:159`). */
/** `normal` is for a chunk's reprint only: oxc's codegen keeps ordinary comments unless it is removing whitespace
 *  (`CommentOptions.normal`, which rolldown's `minify_chunks` sets to `!remove_whitespace`), and that is how a banner
 *  written as a comment survives it. */
export type CommentPrintOptions = { legal: boolean; jsdoc: boolean; normal?: boolean };

/** Printer state. Mirrors the load-bearing fields of oxc's `Codegen`
 *  (`llm/libs/oxc/crates/oxc_codegen/src/lib.rs:87-148`), trimmed to what we emit. */
export type Printer = {
    /**
     * CodeBuffer — one growable UTF-8 byte buffer, oxc's `CodeBuffer` model (`Vec<u8>` +
     * `print_ascii_byte`), decoded once at the end.
     *
     * This replaced `out: string[]` + `push` per token + `join('')`. Instrumenting a real bundle showed
     * why it matters: three.core.js emits 169,790 pushes for 376,544 chars, and **75% of those pushes
     * are a SINGLE CHARACTER** (78% on crashcat) — the output is punctuation-dominated, so the array
     * held ~170k one-char strings before joining them. Benched in isolation against the measured token
     * profile (`benches/micro/emit.bench.ts`, cross-arm string equality enforced): 3.90ms -> 1.35ms,
     * **2.89x**, beating `string +=` (2.16ms) and an 8KB-chunked hybrid (2.24ms).
     */
    buf: Uint8Array;
    /** Bytes written so far — the buffer's logical length. */
    len: number;
    opts: PrintOptions;
    /** Current indentation depth (ignored under minify). */
    indent: number;
    /** Rename resolver for identifiers. */
    nameOf: NameResolver;
    /** While a preserved-name class body is being emitted, THIS symbol prints its ORIGINAL name
     *  rather than its deconflicted one — Rollup's `useOriginalName` (`ClassDeclaration.render`).
     *
     *  Not cosmetic. `let C$1 = class C { static x = C$1; }` throws `ReferenceError: Cannot access
     *  'C$1' before initialization`: a static initialiser runs while the class is being defined,
     *  BEFORE the outer `let` is assigned. Only the class's own binding is in scope there. Verified
     *  against node; a method body would have been fine either way. 0 ⇒ no override. */
    originalNameSym: number;
    /** See {@link PrinterConfig.privateMemberMappings}; null when private names print as written. */
    privateMemberMappings: readonly ReadonlyMap<string, string>[] | null;
    /** Ids of the classes being printed, innermost last. oxc's `class_stack`. */
    classStack: number[];
    /** The id the next printed class takes. oxc's `next_class_id`. */
    nextClassId: number;
    /** Buffer length right after a printed number literal that a following `.` would extend (`0 .x`).
     *  oxc's `need_space_before_dot`. */
    needSpaceBeforeDot: number;
    // Generated position + sourcemap (all null/0 when the map is off).
    map: Mappings | null;
    line: number; // 0-based generated line
    col: number; // 0-based generated column (UTF-16 units)
    sources: SourceRegion[] | null;
    /** Printable comments, keyed by the offset of the node they precede. Null ⇒ none to print. */
    comments: Map<number, string[]> | null;
    /** Sorted anchors of LEGAL comments, so one whose anchor was dropped can still be flushed. */
    legalKeys: number[];
    /** How far through {@link legalKeys} the orphan flush has got. */
    legalAt: number;
    /** A mandatory separator that has been requested but not yet committed — see {@link space}. */
    pendingSpace: boolean;
    /** Last character actually emitted, for deciding whether `pendingSpace` is really needed. */
    lastChar: string;
};

/** Would `a` and `b`, written adjacently, lex as ONE token instead of two? */
function wouldMerge(a: string, b: string): boolean {
    if (a === '' || b === '') return false;
    const ident = (c: string): boolean => /[A-Za-z0-9_$\\]/.test(c) || c.charCodeAt(0) > 127;
    if (ident(a) && ident(b)) return true; // `return x`, `typeof y`
    if (a === '+' && (b === '+' || b === '=')) return true; // `+ +x` vs `++x`
    if (a === '-' && (b === '-' || b === '=')) return true;
    if (a === '/' && (b === '/' || b === '*')) return true; // would open a comment
    if (a === '<' && b === '!') return true; // `<!--` is a line comment in scripts
    return false;
}

/** Whether comments of `kind` print under `options`. A source-mapping comment never does: the bundler
 *  appends its own, and two would collide. Normal comments are dropped where rolldown drops them, which is
 *  everywhere but a chunk reprint. */
export const keepsComment = (options: CommentPrintOptions, kind: CommentKind): boolean =>
    (kind === CommentKind.Legal && options.legal) ||
    (kind === CommentKind.Jsdoc && options.jsdoc) ||
    (kind === CommentKind.Normal && options.normal === true);

/** Group the comments this printer may emit by the offset of the node they precede — oxc's
 *  `build_comments` (`codegen/src/comment.rs:71`), which keys a map by `attached_to` and looks it up
 *  from each node's own start.
 *
 *  Classification is deferred until here rather than done at lex time, which is `comments.ts`'s whole
 *  design: the `@license` body sweep costs 13x what retaining the span does, so it runs once per
 *  PRINTED module instead of once per parse, and only for the classes we might emit.
 *
 *  `legalKeys` is the sorted subset that must outlive its anchor. A licence whose statement is
 *  tree-shaken still has to reach the output — oxc's `preserve_when_orphaned` (`comment.rs:17`). */
function buildCommentIndex(cfg: PrinterConfig): {
    comments: Map<number, string[]> | null;
    legalKeys: number[];
    legalAt: number;
} {
    const c = cfg.comments;
    const src = cfg.src;
    const want = cfg.commentOpts;
    if (c === undefined || src === undefined || want === undefined || c.length === 0) {
        return { comments: null, legalKeys: [], legalAt: 0 };
    }
    const map = new Map<number, string[]>();
    const legalKeys: number[] = [];
    for (let i = 0; i < commentCount(c); i++) {
        const kind = classifyComment(src, c, i);
        if (!keepsComment(want, kind)) continue;
        const at = commentAttachedTo(c, i);
        const text = src.slice(commentStart(c, i), commentEnd(c, i));
        const bucket = map.get(at);
        if (bucket === undefined) map.set(at, [text]);
        else bucket.push(text);
        if (kind === CommentKind.Legal && legalKeys[legalKeys.length - 1] !== at) legalKeys.push(at);
    }
    return { comments: map.size > 0 ? map : null, legalKeys, legalAt: 0 };
}

export function createPrinter(opts: PrintOptions, cfg: PrinterConfig = {}): Printer {
    const wantMap = cfg.sources !== undefined;
    return {
        opts,
        indent: 0,
        nameOf: cfg.nameOf ?? ((n) => n.name),
        originalNameSym: 0,
        privateMemberMappings: cfg.privateMemberMappings ?? null,
        classStack: [],
        nextClassId: 0,
        needSpaceBeforeDot: -1,
        map: wantMap ? newMappings() : null,
        line: 0,
        col: 0,
        sources: cfg.sources ?? null,
        ...buildCommentIndex(cfg),
        // Grown by doubling. A printer is created PER MODULE, so a large up-front reservation would be
        // wasted on the many small ones; a 380KB chunk costs ~7 doublings and ~760KB copied in total.
        buf: new Uint8Array(4096),
        len: 0,
        pendingSpace: false,
        lastChar: '',
    };
}

/** Emit any comments anchored to `start`, plus any LEGAL comment anchored earlier whose own node was
 *  dropped. oxc splits these across `print_leading_comments` and `print_orphan_comments_before`
 *  (`codegen/src/comment.rs:160,262`); the orphan half is what makes a licence survive tree-shaking,
 *  and without it the feature is wrong in exactly the case it exists for. */
export function printLeadingComments(p: Printer, start: number): void {
    if (p.comments === null) return;
    while (p.legalAt < p.legalKeys.length && p.legalKeys[p.legalAt] < start) {
        const at = p.legalKeys[p.legalAt++];
        if (at === start) break;
        const orphan = p.comments.get(at);
        if (orphan !== undefined) {
            p.comments.delete(at);
            for (const text of orphan) writeComment(p, text);
        }
    }
    const here = p.comments.get(start);
    if (here === undefined) return;
    p.comments.delete(start);
    for (const text of here) writeComment(p, text);
}

/** Comments after the last statement, anchored to the end of input, and any legal comment still waiting: oxc's
 *  `Program` codegen ends with `print_comments_at(self.span.end)` ("trailing statement comments"). */
export function printTrailingComments(p: Printer, end: number): void {
    if (p.comments === null) return;
    if (!p.comments.has(end) && p.legalAt >= p.legalKeys.length) return;
    softNewline(p);
    printLeadingComments(p, end);
    for (const at of p.legalKeys.slice(p.legalAt)) {
        const orphan = p.comments.get(at);
        if (orphan === undefined) continue;
        p.comments.delete(at);
        for (const text of orphan) writeComment(p, text);
    }
    p.legalAt = p.legalKeys.length;
}

/** A comment is emitted verbatim and always followed by a newline. Under `minify` that newline is the
 *  only whitespace kept — a `//` comment without one would swallow the code after it. */
function writeComment(p: Printer, text: string): void {
    write(p, text);
    write(p, '\n');
    p.lastChar = '\n';
    p.pendingSpace = false;
}

export function finishPrinter(p: Printer): string {
    return DECODER.decode(p.buf.subarray(0, p.len));
}

/** The output plus its sourcemap segments, as a joinable {@link Part}-shaped value.
 *  `map` is undefined when the printer was created without `sources`. */
export function printerPart(p: Printer): { code: string; map?: Mappings } {
    const code = DECODER.decode(p.buf.subarray(0, p.len));
    return p.map === null ? { code } : { code, map: p.map };
}

/** The single output sink: append `s` and advance the generated position, opening a new
 *  mapped line at every '\n' so segments land on the right generated line. */
function push(p: Printer, s: string): void {
    if (p.pendingSpace) {
        p.pendingSpace = false;
        // Commit the deferred separator ONLY if the two tokens would otherwise merge. `return(x)`,
        // `case-1:`, `typeof"a"` and `return--e` are all single tokens shorter than their spaced
        // form, and oxc's codegen emits them that way; we were spending a byte on every one.
        if (s.length > 0 && wouldMerge(p.lastChar, s[0])) emit(p, ' ');
    }
    emit(p, s);
}

/** Unconditional buffer append + position tracking. */
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function grow(p: Printer, need: number): void {
    let cap = p.buf.length;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(p.buf.subarray(0, p.len));
    p.buf = next;
}

function emit(p: Printer, s: string): void {
    const n = s.length;
    if (n === 0) return;
    p.lastChar = s[n - 1];
    // Worst case is 3 bytes per UTF-16 unit (a surrogate PAIR is 4 bytes for 2 units, so 3/unit holds).
    if (p.len + n * 3 > p.buf.length) grow(p, p.len + n * 3);
    const buf = p.buf;
    let w = p.len;
    let i = 0;
    for (; i < n; i++) {
        const c = s.charCodeAt(i);
        if (c > 0x7f) break;
        buf[w] = c;
        w++;
    }
    if (i < n) {
        // Non-ASCII tail — rare in minified JS, so it takes the slow path and encodes properly rather
        // than complicating the byte loop above.
        const bytes = ENCODER.encode(s.slice(i));
        buf.set(bytes, w);
        w += bytes.length;
    }
    p.len = w;
    if (p.map === null) return;
    for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) === 10) {
            addLine(p.map);
            p.line++;
            p.col = 0;
        } else {
            p.col++;
        }
    }
}

/** Record a mapping from the current generated position to `node`'s source origin. No-op
 *  when the map is off, or when a segment already starts at this generated column. */
export function mark(p: Printer, node: Node): void {
    if (p.map === null || p.sources === null || node.start < 0) return;
    const segs = p.map.lines[p.map.lines.length - 1];
    if (segs.length > 0 && segs[segs.length - 1][0] === p.col) return;
    const region = regionOf(p.sources, node.start);
    if (region.sourceIdx < 0) return;
    const { line, column } = lineColOf(region.lines, node.start - region.start);
    addSegment(p.map, p.col, region.sourceIdx, line - 1, column);
}

/** The last region starting at or before `position`. */
function regionOf(sources: SourceRegion[], position: number): SourceRegion {
    let low = 0;
    let high = sources.length - 1;
    while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (sources[middle].start <= position) low = middle;
        else high = middle - 1;
    }
    return sources[low];
}

/** Append a raw token verbatim. */
export function write(p: Printer, s: string): void {
    push(p, s);
}

/** A space that exists only for readability — elided under minify (`lib.rs:445`). */
export function softSpace(p: Printer): void {
    if (!p.opts.minify) push(p, ' ');
}

/** A newline + indent that exists only for readability — elided under minify
 *  (`lib.rs:457`). */
export function softNewline(p: Printer): void {
    if (!p.opts.minify) {
        push(p, '\n');
        for (let i = 0; i < p.indent; i++) push(p, '    ');
    }
}

/**
 * A mandatory separator (keyword/operand, e.g. `return x`, `typeof x`).
 *
 * DEFERRED, not written. The next {@link push} commits it only when the adjacent characters would
 * actually lex as one token (see `wouldMerge`) — so `return x` keeps its space while `return(x)`,
 * `case-1:` and `return--e` lose it. Worth 217 bytes on three.core.js, which is ~23% of our entire
 * raw size gap against oxc-minify.
 */
export function space(p: Printer): void {
    p.pendingSpace = true;
}

/** oxc's `print_soft_space` after a keyword, followed by its `print_space_before_identifier`: always a space
 *  in readable output (`return -1`), and under minify only where the tokens would merge (`return-1`, `return x`). */
export function keywordSpace(p: Printer): void {
    softSpace(p);
    space(p);
}

/** Statement terminator. */
export function semi(p: Printer): void {
    push(p, ';');
}

/** Minify peephole: drop a just-emitted statement `;` when it sits immediately before a `}`
 *  or the end of output, where it is redundant (a `}`/EOF already terminates the statement).
 *  Safe by construction — it never removes an inter-statement or `for(;;)` separator, which
 *  are emitted as distinct tokens and never land right before this call. */
export function dropTrailingSemi(p: Printer): void {
    if (!p.opts.minify) return;
    // 0x3B is ';'. Simpler than the array form, which had to assume the last CHUNK was exactly ";".
    if (p.len > 0 && p.buf[p.len - 1] === 0x3b) {
        p.len--;
        if (p.map !== null && p.col > 0) p.col--;
    }
}

/** Run `body` wrapped in parentheses iff `cond`. */
export function parens(p: Printer, cond: boolean, body: () => void): void {
    if (cond) push(p, '(');
    body();
    if (cond) push(p, ')');
}
