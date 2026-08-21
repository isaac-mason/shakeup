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
    /** CodeBuffer: array of string chunks joined once at the end (V8-cheap cons/rope). */
    out: string[];
    opts: PrintOptions;
    /** Current indentation depth (ignored under minify). */
    indent: number;
    /** Rename resolver for identifiers. */
    nameOf: NameResolver;
    /** Bundle link mode (see {@link PrinterConfig.linkModule}). */
    linkModule: boolean;
    defaultName: (() => string) | null;
    live: Set<number> | null;
    overrides: Map<Node, string> | null;
    // Generated position + sourcemap (all null/0 when the map is off).
    map: Mappings | null;
    line: number; // 0-based generated line
    col: number; // 0-based generated column (UTF-16 units)
    srcLines: Uint32Array | null;
    sourceIdx: number;
};

export function createPrinter(opts: PrintOptions, cfg: PrinterConfig = {}): Printer {
    const wantMap = cfg.srcLines !== undefined;
    return {
        out: [],
        opts,
        indent: 0,
        nameOf: cfg.nameOf ?? ((n) => n.name),
        linkModule: cfg.linkModule ?? false,
        defaultName: cfg.defaultName ?? null,
        live: cfg.live ?? null,
        overrides: cfg.overrides ?? null,
        map: wantMap ? newMappings() : null,
        line: 0,
        col: 0,
        srcLines: cfg.srcLines ?? null,
        sourceIdx: cfg.sourceIdx ?? 0,
    };
}

export function finishPrinter(p: Printer): string {
    return p.out.join('');
}

/** The output plus its sourcemap segments, as a joinable {@link Part}-shaped value.
 *  `map` is undefined when the printer was created without `srcLines`. */
export function printerPart(p: Printer): { code: string; map?: Mappings } {
    return p.map === null ? { code: p.out.join('') } : { code: p.out.join(''), map: p.map };
}

/** The single output sink: append `s` and advance the generated position, opening a new
 *  mapped line at every '\n' so segments land on the right generated line. */
function push(p: Printer, s: string): void {
    p.out.push(s);
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

/** A single mandatory space (keyword/operand separator, e.g. `return x`, `typeof x`).
 *  Always emitted — omitting it would change tokenisation. Phase 2 narrows the cases
 *  where it can be dropped. */
export function space(p: Printer): void {
    push(p, ' ');
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
    if (p.out.length > 0 && p.out[p.out.length - 1] === ';') {
        p.out.pop();
        if (p.map !== null && p.col > 0) p.col--;
    }
}

/** Run `body` wrapped in parentheses iff `cond`. */
export function parens(p: Printer, cond: boolean, body: () => void): void {
    if (cond) push(p, '(');
    body();
    if (cond) push(p, ')');
}
