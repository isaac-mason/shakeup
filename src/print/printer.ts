import { lineColOf, type Node } from '../ast';
import { addLine, addSegment, type Mappings, newMappings } from '../sourcemap';

/** Options controlling how the printer renders. Whitespace and syntactic-form
 *  selection are toggled by `minify` — the single flag oxc's codegen keys off
 *  (`llm/libs/oxc/crates/oxc_codegen/src/options.rs:16`). */
export type PrintOptions = {
    minify: boolean;
};

/** Resolve an identifier node to its final output name. In a full bundle this wraps
 *  `renameOf` (finalNames / cross-chunk locals, `src/bundle.ts:152`); standalone it
 *  falls back to the node's own text. Never returns null — the caller defaults. */
export type NameResolver = (identNode: Node) => string;

/** Extra config for {@link createPrinter}. Providing `srcLines` turns on sourcemap
 *  building (segments emitted during the walk, oxc's `SourcemapBuilder` model). */
export type PrinterConfig = {
    nameOf?: NameResolver;
    /** Source line-start offsets (the `lines` table from `parse`). Enables the map. */
    srcLines?: Uint32Array;
    /** Index of this module's source in the chunk's `sources` array. */
    sourceIdx?: number;
    /** Bundle "link mode": drop import statements, unwrap `export <decl>` to `<decl>`, and
     *  rewrite anonymous `export default` to `const <defaultName()> =`. Off ⇒ module-faithful. */
    linkModule?: boolean;
    /** Name for an anonymous `export default` in link mode. */
    defaultName?: () => string;
    /** Top-level statement liveness (tree-shaking). A statement whose id is absent is dropped.
     *  null/absent ⇒ keep everything. */
    live?: Set<number> | null;
    /** Per-node text overrides (dynamic `import()` retargeting, asset URL rewrites). A node
     *  present here is emitted as its mapped text verbatim, skipping normal emission. */
    overrides?: Map<Node, string> | null;
};

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
    /** Bundle link mode (see {@link PrinterConfig.linkModule}). */
    linkModule: boolean;
    defaultName: (() => string) | null;
    live: Set<number> | null;
    /** Which declarators to emit for ONE specific declaration node. Set by the `Program` loop and
     *  consumed by `printVarDecl`, which must check `decl` identity: the filter is live for the whole
     *  subtree being printed, so a NESTED declaration (a `for` init, a declaration inside a function
     *  body) would otherwise be filtered against a set holding none of its declarators and emit a
     *  bare `let;`. */
    declFilter: { decl: Node; keep: Set<Node> } | null;
    overrides: Map<Node, string> | null;
    // Generated position + sourcemap (all null/0 when the map is off).
    map: Mappings | null;
    line: number; // 0-based generated line
    col: number; // 0-based generated column (UTF-16 units)
    srcLines: Uint32Array | null;
    sourceIdx: number;
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

export function createPrinter(opts: PrintOptions, cfg: PrinterConfig = {}): Printer {
    const wantMap = cfg.srcLines !== undefined;
    return {
        opts,
        indent: 0,
        nameOf: cfg.nameOf ?? ((n) => n.name),
        linkModule: cfg.linkModule ?? false,
        defaultName: cfg.defaultName ?? null,
        live: cfg.live ?? null,
        declFilter: null,
        // An EMPTY map is normalised to null. `emitExpr` guards on `overrides !== null` and then does
        // a `Map.get` PER EXPRESSION NODE; a module with no dynamic imports and no asset URLs supplies
        // an empty map, which is not null, so every node paid a lookup that could never hit.
        overrides: cfg.overrides !== undefined && cfg.overrides !== null && cfg.overrides.size > 0 ? cfg.overrides : null,
        map: wantMap ? newMappings() : null,
        line: 0,
        col: 0,
        srcLines: cfg.srcLines ?? null,
        sourceIdx: cfg.sourceIdx ?? 0,
        // Grown by doubling. A printer is created PER MODULE, so a large up-front reservation would be
        // wasted on the many small ones; a 380KB chunk costs ~7 doublings and ~760KB copied in total.
        buf: new Uint8Array(4096),
        len: 0,
        pendingSpace: false,
        lastChar: '',
    };
}

export function finishPrinter(p: Printer): string {
    return DECODER.decode(p.buf.subarray(0, p.len));
}

/** The output plus its sourcemap segments, as a joinable {@link Part}-shaped value.
 *  `map` is undefined when the printer was created without `srcLines`. */
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
    if (p.map === null || p.srcLines === null) return;
    const segs = p.map.lines[p.map.lines.length - 1];
    if (segs.length > 0 && segs[segs.length - 1][0] === p.col) return;
    const { line, column } = lineColOf(p.srcLines, node.start);
    addSegment(p.map, p.col, p.sourceIdx, line - 1, column);
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
