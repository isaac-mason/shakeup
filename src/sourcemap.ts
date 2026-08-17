const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// char CODES for each base64 digit — write these into a byte buffer instead of pushing 1-char
// strings, which for a large module means a giant string[] + join (the old hot path + GC).
const BASE64_CODES = /* @__PURE__ */ (() => {
    const t = new Uint8Array(64);
    for (let i = 0; i < BASE64.length; i++) t[i] = BASE64.charCodeAt(i);
    return t;
})();
const CH_SEMI = 59; // ';'
const CH_COMMA = 44; // ','

/** Decode an ASCII (latin1) byte buffer `[0,len)` to a string, chunked to dodge fromCharCode's
 *  argument-count limit on large maps. */
function asciiBufToString(buf: Uint8Array, len: number): string {
    let s = '';
    for (let i = 0; i < len; i += 8192) {
        s += String.fromCharCode.apply(null, buf.subarray(i, Math.min(i + 8192, len)) as unknown as number[]);
    }
    return s;
}

/**
 * One SMv3 mapping segment (absolute positions; column in UTF-16 units): `[genCol]` for a
 * generated-only boundary with no origin, or `[genCol, sourceIdx, srcLine, srcCol]` (+ `nameIdx`).
 */
type Segment = number[];

/**
 * Mappings accumulator — segments per generated line, in generated order. Held in a named-field
 * object (not a bare array) so the shape can grow — e.g. a names table for renamed identifiers —
 * without changing any call site. Build in generated order with {@link newMappings}/{@link addLine}/
 * {@link addSegment}/{@link addUnmapped}; serialize with {@link encodeMappings}.
 */
export type Mappings = { lines: Segment[][] };

/** A fresh mappings accumulator positioned on generated line 0. */
export const newMappings = (): Mappings => ({ lines: [[]] });

/** Start a new generated line (call once per '\n' emitted to the output). */
export const addLine = (m: Mappings): void => {
    m.lines.push([]);
};

/** A generated-only boundary at `genCol` on the current line (no source origin). */
export const addUnmapped = (m: Mappings, genCol: number): void => {
    m.lines[m.lines.length - 1].push([genCol]);
};

/** Map generated (current line, `genCol`) → source (`sourceIdx`,`srcLine`,`srcCol`), optional name. */
export function addSegment(m: Mappings, genCol: number, sourceIdx: number, srcLine: number, srcCol: number, nameIdx = -1): void {
    m.lines[m.lines.length - 1].push(
        nameIdx < 0 ? [genCol, sourceIdx, srcLine, srcCol] : [genCol, sourceIdx, srcLine, srcCol, nameIdx],
    );
}

/** Encode accumulated segments to the SMv3 `mappings` VLQ string (fields delta-encoded per spec). */
export function encodeMappings(m: Mappings): string {
    let buf = new Uint8Array(1024);
    let pos = 0;
    const ensure = (n: number): void => {
        if (pos + n <= buf.length) return;
        let cap = buf.length * 2;
        while (cap < pos + n) cap *= 2;
        const nb = new Uint8Array(cap);
        nb.set(buf);
        buf = nb;
    };
    const vlq = (value: number): void => {
        let v = value < 0 ? (-value << 1) | 1 : value << 1;
        ensure(6); // a 32-bit VLQ is ≤ 6 base64 digits
        do {
            let digit = v & 0x1f;
            v >>>= 5;
            if (v > 0) digit |= 0x20;
            buf[pos++] = BASE64_CODES[digit];
        } while (v > 0);
    };

    let prevSourceIdx = 0;
    let prevSrcLine = 0;
    let prevSrcCol = 0;
    let prevNameIdx = 0;
    for (let li = 0; li < m.lines.length; li++) {
        if (li > 0) {
            ensure(1);
            buf[pos++] = CH_SEMI;
        }
        const segs = m.lines[li];
        let prevGenCol = 0; // generated column resets to 0 at the start of every line
        for (let si = 0; si < segs.length; si++) {
            if (si > 0) {
                ensure(1);
                buf[pos++] = CH_COMMA;
            }
            const seg = segs[si];
            vlq(seg[0] - prevGenCol);
            prevGenCol = seg[0];
            if (seg.length === 1) continue;
            vlq(seg[1] - prevSourceIdx);
            prevSourceIdx = seg[1];
            vlq(seg[2] - prevSrcLine);
            prevSrcLine = seg[2];
            vlq(seg[3] - prevSrcCol);
            prevSrcCol = seg[3];
            if (seg.length === 5) {
                vlq(seg[4] - prevNameIdx);
                prevNameIdx = seg[4];
            }
        }
    }
    return asciiBufToString(buf, pos);
}

const B64_INV = (() => {
    const inv = new Int8Array(128).fill(-1);
    for (let i = 0; i < BASE64.length; i++) inv[BASE64.charCodeAt(i)] = i;
    return inv;
})();

/** Decode one base64-VLQ segment string to its signed-integer fields. */
function decodeSeg(s: string): number[] {
    const fields: number[] = [];
    let shift = 0;
    let value = 0;
    for (let i = 0; i < s.length; i++) {
        const d = B64_INV[s.charCodeAt(i)];
        value += (d & 0x1f) << shift;
        if (d & 0x20) {
            shift += 5;
        } else {
            fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
            shift = 0;
            value = 0;
        }
    }
    return fields;
}

/** Decode an SMv3 `mappings` VLQ string back to absolute {@link Mappings} (inverse of {@link encodeMappings}). */
export function decodeMappings(s: string): Mappings {
    const lines: Segment[][] = [];
    let srcIdx = 0;
    let srcLine = 0;
    let srcCol = 0;
    let nameIdx = 0;
    for (const lineStr of s.split(';')) {
        const segs: Segment[] = [];
        let genCol = 0;
        if (lineStr.length > 0) {
            for (const segStr of lineStr.split(',')) {
                const f = decodeSeg(segStr);
                genCol += f[0];
                if (f.length === 1) {
                    segs.push([genCol]);
                } else {
                    srcIdx += f[1];
                    srcLine += f[2];
                    srcCol += f[3];
                    if (f.length === 5) {
                        nameIdx += f[4];
                        segs.push([genCol, srcIdx, srcLine, srcCol, nameIdx]);
                    } else segs.push([genCol, srcIdx, srcLine, srcCol]);
                }
            }
        }
        lines.push(segs);
    }
    return { lines };
}

const countLines = (s: string): number => {
    let n = 1;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
};

/** Trim the leading/trailing whitespace of `code` (as {@link String.trim}) and shift `m` to match:
 *  drop the leading blank lines + columns and any trailing blank lines. Returns the trimmed code. */
export function trimMappings(code: string, m: Mappings): string {
    const trimmed = code.trim();
    if (trimmed === code) return code;
    const leading = code.length - code.trimStart().length;
    let droppedLines = 0;
    let lastNl = -1;
    for (let i = 0; i < leading; i++)
        if (code.charCodeAt(i) === 10) {
            droppedLines++;
            lastNl = i;
        }
    const droppedCols = leading - (lastNl + 1);
    if (droppedLines > 0) m.lines.splice(0, droppedLines);
    if (droppedCols > 0 && m.lines[0]) for (const seg of m.lines[0]) seg[0] = Math.max(0, seg[0] - droppedCols);
    const keep = countLines(trimmed);
    if (m.lines.length > keep) m.lines.length = keep;
    return trimmed;
}

/** A piece of assembled output. `map` present ⇒ its segments (relative to the piece's own line 0);
 *  absent ⇒ synthetic generated-only content (no source origin). */
export type Part = { code: string; map?: Mappings };

/**
 * Concatenate `parts` with '\n' separators plus a trailing '\n', and build the combined
 * {@link Mappings}: each part contributes `countLines(part.code)` generated lines — its own
 * segments if mapped, else unmapped lines. Segments already carry their `sourceIdx`, so there is
 * no renumbering here.
 */
export function joinParts(parts: Part[]): { code: string; map: Mappings } {
    const codes: string[] = [];
    const lines: Segment[][] = [];
    for (const p of parts) {
        codes.push(p.code);
        const n = countLines(p.code);
        for (let k = 0; k < n; k++) lines.push(p.map ? (p.map.lines[k] ?? []) : []);
    }
    lines.push([]); // the trailing '\n'
    return { code: `${codes.join('\n')}\n`, map: { lines } };
}

/** Nearest-preceding mapped segment on `line` at/-before `col`. */
function traceSegment(m: Mappings, line: number, col: number): Segment | null {
    const segs = m.lines[line];
    if (!segs) return null;
    let best: Segment | null = null;
    for (const seg of segs) if (seg.length >= 4 && seg[0] <= col) best = seg;
    return best;
}

/**
 * Compose two single-source maps into one: `outer` maps final output → an intermediate whose own
 * origin is described by `inner`; the result maps final output → `inner`'s sources. Each `outer`
 * segment is retraced through `inner`. Assumes a single inner source (index 0).
 */
export function composeSourceMaps(outer: SourceMap, inner: SourceMap): SourceMap {
    const om = decodeMappings(outer.mappings);
    const im = decodeMappings(inner.mappings);
    const result = newMappings();
    for (let gl = 0; gl < om.lines.length; gl++) {
        if (gl > 0) addLine(result);
        for (const seg of om.lines[gl]) {
            if (seg.length < 4) {
                addUnmapped(result, seg[0]);
                continue;
            }
            const t = traceSegment(im, seg[2], seg[3]);
            if (t) addSegment(result, seg[0], 0, t[2], t[3], t.length === 5 ? t[4] : -1);
            else addUnmapped(result, seg[0]);
        }
    }
    return {
        version: 3,
        sources: inner.sources,
        sourcesContent: inner.sourcesContent,
        names: inner.names,
        mappings: encodeMappings(result),
    };
}

/** A shakeup source map (SMv3). `sources[i] === null` marks a synthetic source with no origin. */
export type SourceMap = {
    version: 3;
    file?: string;
    sources: (string | null)[];
    sourcesContent?: (string | null)[];
    names: string[];
    mappings: string;
    /** Indices into `sources` flagged as third-party/ignored (DevTools `x_google_ignoreList`). */
    x_google_ignoreList?: number[];
};

/** Serialize a {@link SourceMap} to a JSON string. */
export const sourceMapToJSON = (map: SourceMap): string => JSON.stringify(map);

/** Base64 of a UTF-8 string — browser+Node safe (no Buffer/btoa; reuses the base64 alphabet). */
function base64Utf8(s: string): string {
    const bytes = new TextEncoder().encode(s);
    const out: string[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1;
        out.push(BASE64[b0 >> 2]);
        out.push(BASE64[((b0 & 3) << 4) | (b1 < 0 ? 0 : b1 >> 4)]);
        out.push(b1 < 0 ? '=' : BASE64[((b1 & 15) << 2) | (b2 < 0 ? 0 : b2 >> 6)]);
        out.push(b2 < 0 ? '=' : BASE64[b2 & 63]);
    }
    return out.join('');
}

/** An inline `//# sourceMappingURL=data:...` comment carrying a base64 data URL of the map. */
export function inlineSourceMapComment(map: SourceMap): string {
    return `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${base64Utf8(sourceMapToJSON(map))}`;
}
