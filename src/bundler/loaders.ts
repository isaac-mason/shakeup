import type { ModuleType } from './plugin';

/** The module types whose loader reads BYTES rather than text.
 *
 *  rolldown splits exactly here — `load_source.rs:79` and `:187` return `StrOrBytes::Bytes` for
 *  `Base64 | Binary | Dataurl` and `StrOrBytes::Str` for everything else, `Text` included. Decoding
 *  a PNG as UTF-8 and re-encoding it would corrupt every byte above 0x7F, so the `Fs` seam grew a
 *  `readBytes` to match. */
export function loaderWantsBytes(type: ModuleType | undefined): boolean {
    return type === 'base64' || type === 'binary' || type === 'dataurl';
}

/** Words that cannot be a `var` binding name. Only the ones that are reserved in *any* mode — a
 *  generated module is ESM and therefore strict, so the strict-only reservations count too. */
const RESERVED = new Set([
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'function',
    'if',
    'implements',
    'import',
    'in',
    'instanceof',
    'interface',
    'let',
    'new',
    'null',
    'package',
    'private',
    'protected',
    'public',
    'return',
    'static',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'with',
    'yield',
]);

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard (padded, `+/`) base64 of `bytes`. Hand-rolled rather than `btoa`/`Buffer`: `btoa`
 *  takes a latin1 STRING, so feeding it bytes means a lossy round-trip, and core must not reach for
 *  node builtins (`fs.ts`) if the browser is to stay a first-class target. */
function toBase64(bytes: Uint8Array): string {
    let out = '';
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    const rest = bytes.length - i;
    if (rest === 1) {
        const n = bytes[i] << 16;
        out += `${B64[n >> 18]}${B64[(n >> 12) & 63]}==`;
    } else if (rest === 2) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
        out += `${B64[n >> 18]}${B64[(n >> 12) & 63]}${B64[(n >> 6) & 63]}=`;
    }
    return out;
}

/** Extension → MIME, transcribed from rolldown's `light_guess.rs` table (24 entries, itself derived
 *  from esbuild's `helpers/mime.go`). The boolean is `is_utf8_encoded`, which appends
 *  `;charset=utf-8` — a text/* type carries it, a binary one does not.
 *
 *  Deliberately NOT a general MIME database: both oracles ship this exact short list and fall
 *  through to content sniffing, so a longer table here would produce data URLs neither of them
 *  emits. Note `txt` is absent from it in BOTH — a `.txt` data URL gets its type from the sniff. */
const MIME_BY_EXT: Record<string, [string, boolean]> = {
    avif: ['image/avif', false],
    css: ['text/css', true],
    eot: ['application/vnd.ms-fontobject', false],
    gif: ['image/gif', false],
    htm: ['text/html', true],
    html: ['text/html', true],
    jpeg: ['image/jpeg', false],
    jpg: ['image/jpeg', false],
    js: ['text/javascript', true],
    json: ['application/json', true],
    markdown: ['text/markdown', true],
    md: ['text/markdown', true],
    mjs: ['text/javascript', true],
    otf: ['font/otf', false],
    pdf: ['application/pdf', false],
    png: ['image/png', false],
    sfnt: ['font/sfnt', false],
    svg: ['image/svg+xml', false],
    ttf: ['font/ttf', false],
    wasm: ['application/wasm', false],
    webmanifest: ['application/manifest+json', false],
    webp: ['image/webp', false],
    woff: ['font/woff', false],
    woff2: ['font/woff2', false],
};

/** Magic-number sniff, second in `guess_mime`'s order after the extension table.
 *
 *  rolldown delegates this to the `infer` crate and esbuild to Go's `http.DetectContentType`, which
 *  already disagree with each other on the tail; the formats below are the ones both recognise. An
 *  unrecognised prefix falls through to the UTF-8 test, exactly as it does in `guess_mime_impl`. */
function sniffMime(bytes: Uint8Array): string | null {
    const at = (i: number, ...sig: number[]) => sig.every((b, k) => bytes[i + k] === b);
    if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
    if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
    if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
    if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
    if (at(0, 0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
    if (at(0, 0x00, 0x61, 0x73, 0x6d)) return 'application/wasm';
    if (at(0, 0x77, 0x4f, 0x46, 0x46)) return 'font/woff';
    if (at(0, 0x77, 0x4f, 0x46, 0x32)) return 'font/woff2';
    if (at(0, 0x00, 0x01, 0x00, 0x00, 0x00)) return 'font/ttf';
    if (at(0, 0x4f, 0x54, 0x54, 0x4f)) return 'font/otf';
    if (at(0, 0x42, 0x4d)) return 'image/bmp';
    if (at(0, 0x1f, 0x8b)) return 'application/gzip';
    if (at(0, 0x50, 0x4b, 0x03, 0x04)) return 'application/zip';
    return null;
}

/** Decode `bytes` as UTF-8, or `null` if they are not valid UTF-8. The `fatal` decoder is what
 *  makes this a VALIDATION and not a lossy decode — the default replaces bad sequences with U+FFFD,
 *  which would let a JPEG masquerade as text and produce a mangled percent-escaped data URL. */
function decodeUtf8(bytes: Uint8Array): string | null {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
}

/** `guess_mime` (rolldown `mime.rs:52`): extension table, then magic bytes, then "is it UTF-8?"
 *  (`text/plain;charset=utf-8`), then `application/octet-stream`. */
function guessMime(id: string, bytes: Uint8Array, text: string | null): string {
    const dot = id.lastIndexOf('.');
    const slash = id.lastIndexOf('/');
    const ext = dot > slash && dot >= 0 ? id.slice(dot + 1).toLowerCase() : '';
    const known = MIME_BY_EXT[ext];
    if (known !== undefined) return known[1] ? `${known[0]};charset=utf-8` : known[0];
    const sniffed = sniffMime(bytes);
    if (sniffed !== null) return sniffed;
    if (text !== null || bytes.length === 0) return 'text/plain;charset=utf-8';
    return 'application/octet-stream';
}

const HEX = '0123456789ABCDEF';

/** Percent-escaped data URL body, or `null` for non-UTF-8 input (which cannot be percent-encoded).
 *
 *  The escape set is deliberately tiny and is NOT the usual `encodeURIComponent` one: esbuild
 *  derived it empirically in `scripts/dataurl-escapes.html` and rolldown transcribed it
 *  (`percent_encoding.rs`). Only `\t \n \r #`, anything in the trailing run of whitespace/control
 *  characters, and a `%` that would otherwise READ as an escape need escaping — everything else,
 *  spaces and non-ASCII included, goes in raw, which is the whole reason this form is often shorter
 *  than base64. */
function percentEscape(text: string): string {
    const chars = Array.from(text);
    let trailingStart = chars.length;
    while (trailingStart > 0) {
        const c = chars[trailingStart - 1];
        if (c > ' ' || c === '\t' || c === '\n' || c === '\r') break;
        trailingStart--;
    }
    const isHex = (c: string | undefined) => c !== undefined && /^[0-9A-Fa-f]$/.test(c);
    let url = '';
    for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (
            c === '\t' ||
            c === '\n' ||
            c === '\r' ||
            c === '#' ||
            i >= trailingStart ||
            (c === '%' && i + 2 < chars.length && isHex(chars[i + 1]) && isHex(chars[i + 2]))
        ) {
            const cp = c.codePointAt(0) as number;
            url += `%${HEX[cp >> 4]}${HEX[cp & 15]}`;
        } else url += c;
    }
    return url;
}

/** Shorter of the base64 and percent-escaped forms, esbuild's `EncodeStringAsShortestDataURL`
 *  (`helpers/dataurl.go:11`) — rolldown's `encode_as_shortest_dataurl` says in its own comment that
 *  it is adapted from it. */
function shortestDataUrl(mime: string, bytes: Uint8Array, text: string | null): string {
    const base64Url = `data:${mime};base64,${toBase64(bytes)}`;
    if (text === null) return base64Url;
    const percentUrl = `data:${mime},${percentEscape(text)}`;
    return percentUrl.length < base64Url.length ? percentUrl : base64Url;
}

/** Is `k` usable verbatim as both a binding name and an export name? */
const isPlainIdent = (k: string): boolean => IDENT.test(k) && !RESERVED.has(k);

/**
 * Compile a non-JavaScript module to ES module SOURCE, for the rest of the pipeline to parse
 * normally. Returns `null` when the type is already JavaScript.
 *
 * Source-to-source rather than a synthetic AST, because that is what makes the module ORDINARY:
 * tree-shaking, constant folding and inlining all apply to it with no special cases. rolldown does
 * the same — its JSON output is one `var` per top-level key plus an object literal for `default`,
 * and `import d from './d.json'; d.used` folds all the way to `const x = 1`. Emitting a single
 * opaque object literal instead would keep every unused key alive.
 */
export function compileToModule(
    type: ModuleType | undefined,
    source: string | Uint8Array,
    id: string,
): { code: string } | { error: string } | null {
    // Every loader below `json` produces a LAZY default export and nothing else — one expression,
    // which is exactly what rolldown's `has_lazy_export` (`parse_to_ecma_ast.rs:149`) and esbuild's
    // `LazyExportAST` mint. Emitting it as `export default <expr>` reaches the same place through
    // the ordinary pipeline, and lets tree-shaking drop the module when nothing imports it.
    if (type === 'empty') return { code: '' };
    if (type === 'text') {
        // The BOM strip is in both oracles (`bundler.go:334`, `parse_to_ecma_ast.rs:160`): a UTF-8
        // BOM is a file-encoding marker, not a character of the text.
        const text = typeof source === 'string' ? source : (decodeUtf8(source) ?? '');
        return { code: `export default ${JSON.stringify(text.startsWith('\uFEFF') ? text.slice(1) : text)};\n` };
    }
    if (type === 'base64' || type === 'dataurl' || type === 'binary') {
        // `loaderWantsBytes` routes these to `Fs.readBytes`, but a plugin `load` hook returns a
        // string and an in-memory fs may have no bytes to give, so encode as UTF-8 rather than fail.
        const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source;
        if (type === 'base64') return { code: `export default ${JSON.stringify(toBase64(bytes))};\n` };
        if (type === 'binary') {
            // `__toBinary` is a runtime helper, requested by `helpersNeededBy` from the module's
            // recorded `moduleType`. esbuild will emit `Uint8Array.fromBase64(…)` instead when the
            // target is known to support it; shakeup has no target matrix, and `fromBase64` only
            // reached browsers in 2025, so the helper is unconditional.
            return { code: `export default __toBinary(${JSON.stringify(toBase64(bytes))});\n` };
        }
        const text = typeof source === 'string' ? source : decodeUtf8(bytes);
        return { code: `export default ${JSON.stringify(shortestDataUrl(guessMime(id, bytes, text), bytes, text))};\n` };
    }
    if (type !== 'json') return null;
    if (typeof source !== 'string') source = new TextDecoder().decode(source);

    let value: unknown;
    try {
        value = JSON.parse(source) as unknown;
    } catch (e) {
        // A JSON syntax error reported AS a JSON error. Before the loader existed the file went
        // straight to the JavaScript parser and produced `expected ';'`, which points at the right
        // file for the wrong reason.
        return { error: `${id}: invalid JSON — ${String((e as Error).message)}` };
    }

    // Only a plain object gets per-key bindings; an array or a primitive has no keys to name, so it
    // is a default export and nothing else. (`typeof null === 'object'`, hence the null check.)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { code: `export default ${JSON.stringify(value)};\n` };
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const lines: string[] = [];
    const members: string[] = [];
    const exports: string[] = [];
    // Seeded with the default binding's own name: a key literally called `default` sanitises to
    // `_default` and silently redeclared it, so `import d from './x.json'; d.default` read the wrong
    // value. Any collision falls through to the positional `_jsonN` form below.
    const DEFAULT_BINDING = '_default';
    const taken = new Set<string>([DEFAULT_BINDING]);
    entries.forEach(([key, v], i) => {
        // A binding name that is stable, unique, and never a reserved word. A key that is not a
        // plain identifier is exported under its literal string name — `export { _a_b as "a-b" }` —
        // which is what arbitrary module namespace names are for.
        let name = isPlainIdent(key) ? key : `_${key.replace(/[^A-Za-z0-9_$]/g, '_')}`;
        if (!IDENT.test(name) || RESERVED.has(name) || taken.has(name)) name = `_json${i}`;
        taken.add(name);
        lines.push(`var ${name} = ${JSON.stringify(v)};`);
        // `__proto__` as a literal key SETS THE PROTOTYPE; a computed key does not. Without this a
        // `{"__proto__": …}` JSON file silently produced an object with a mangled prototype instead
        // of a `__proto__` property.
        members.push(key === '__proto__' ? `['__proto__']: ${name}` : `${JSON.stringify(key)}: ${name}`);
        // A key literally named `default` is NOT re-exported by name: the module already has a
        // `default` export (the whole document), and emitting `export { x as "default" }` alongside
        // it is a duplicate. It is still reachable through that default object — which is also what
        // Node gives you for a JSON module. Caught by a test that read `[undefined, undefined,
        // undefined]` once every key started being exported.
        if (key === 'default') return;
        exports.push(isPlainIdent(key) && name === key ? key : `${name} as ${JSON.stringify(key)}`);
    });
    lines.push(`var ${DEFAULT_BINDING} = { ${members.join(', ')} };`);
    lines.push(`export default ${DEFAULT_BINDING};`);
    if (exports.length > 0) lines.push(`export { ${exports.join(', ')} };`);
    return { code: `${lines.join('\n')}\n` };
}
