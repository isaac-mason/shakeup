/**
 * The source-patch engine: a magic-string-style splice over the original source, used by the
 * plugin `transform` patch API (`ctx.patch` → `Edit[]`). This is the ONLY surviving user of the
 * edit model — the strip/runner transforms moved to AST mutation passes + the printer.
 */

/** A point interior of an edit's replacement `text`: output offset `at` (within `text`) originates
 *  at source offset `src`. Lets a lowered blob map its interior value expressions to their source. */
export type Interior = { at: number; src: number };

/** An edit over the source. `text` present ⇒ replacement (`inner` optionally carries per-value
 *  provenance); absent ⇒ blank (whitespace, preserving newlines). */
export type Edit = { start: number; end: number; text?: string; inner?: Interior[] };

/** whitespace version of a source slice: everything → space except \n and \r. */
function blankText(src: string, start: number, end: number): string {
    return src.slice(start, end).replace(/[^\n\r]/g, ' ');
}

/**
 * Apply `edits` to `src`: copy untouched spans verbatim, splice in replacement text, blank the
 * rest. Edits are sorted by position; overlapping edits are clipped to the running cursor.
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
