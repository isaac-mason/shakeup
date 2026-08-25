// Directive scanning — the opt-in marker layer for the optimizer tier.
// Port of compilecat `passes/directives.rs` (which mirrors its own `src/compiler/directives.ts`).
//
// A directive is a `/* @inline */`-style comment attached to the construct that FOLLOWS it. Unlike
// `/*@__PURE__*/` — which has to be resolved during parsing, because it marks an expression the parser
// is building — directives mark whole declarations, so they are scanned from the SOURCE afterwards.
// That keeps them entirely off the lexer's hot path: `anyInSource` is a substring test that fails
// immediately for the overwhelming majority of files, which never carry a directive at all.
//
// KNOWN APPROXIMATION: the scan does not lex, so a directive-looking comment inside a string or
// template literal is not excluded. To matter it would have to sit at a position that also happens to
// be a construct's exact start offset, which authored code does not produce by accident. compilecat
// avoids this by reading the parser's comment list; if it ever bites, that is the fix.
import { N, type Node, walk } from '../../ast.ts';

/** The authored optimization directives, as a bit per token. */
export const DIRECTIVE = {
    INLINE: 1,
    FLATTEN: 2,
    SROA: 4,
    UNROLL: 8,
    OPTIMIZE: 16,
} as const;

/** `@optimize` is a combo that implies `@flatten` + `@sroa` + `@unroll` (NOT `@inline`, and NOT
 *  `@unroll` in compilecat's own gate — unrolling trades size for loop overhead and stays explicitly
 *  opt-in). Passes test against this expansion. */
export const OPTIMIZE_IMPLIES = DIRECTIVE.FLATTEN | DIRECTIVE.SROA;

const TOKENS: ReadonlyArray<readonly [string, number]> = [
    ['@inline', DIRECTIVE.INLINE],
    ['@flatten', DIRECTIVE.FLATTEN],
    ['@sroa', DIRECTIVE.SROA],
    ['@unroll', DIRECTIVE.UNROLL],
    ['@optimize', DIRECTIVE.OPTIMIZE],
];

/** Cheap pre-filter: does `source` mention any directive at all? Lets a caller skip the scan for the
 *  overwhelming majority of files. */
export function anyInSource(source: string): boolean {
    if (!source.includes('@')) return false;
    for (const [tok] of TOKENS) if (source.includes(tok)) return true;
    return false;
}

/** Source offset of the next non-whitespace character at or after `i` (the construct a comment
 *  attaches to), or -1 at end of input. */
function nextTokenStart(source: string, i: number): number {
    for (let p = i; p < source.length; p++) {
        const c = source.charCodeAt(p);
        if (c !== 32 && c !== 9 && c !== 10 && c !== 13) return p;
    }
    return -1;
}

// One-entry memo. `directiveSpans` is called once per OPTIMIZE PASS per module — six passes, all with
// the same source, back to back — so each module was scanned six times over. The `anyInSource`
// pre-filter does not save it either: any file containing an `@` anywhere (JSDoc, an email in a
// comment) falls through to a full `String.includes` sweep PER DIRECTIVE TOKEN, and on three.core.js
// that came to ~30 scans of 1.2MB, 3.3% of a whole bundle, to conclude "no directives here".
//
// A single slot is the right size: the calls are consecutive per module, so it hits five times out of
// six, and nothing is retained past the next module (a Map keyed by source would pin every module's
// text for the life of the process).
let MEMO_SRC: string | null = null;
let MEMO_HITS: Map<number, number> | null = null;

/** Map of `attached-to offset` → directive bits, for every directive comment in `source`. */
export function scanDirectives(source: string): Map<number, number> {
    if (MEMO_SRC === source && MEMO_HITS !== null) return MEMO_HITS;
    const computed = scanDirectivesUncached(source);
    MEMO_SRC = source;
    MEMO_HITS = computed;
    return computed;
}

function scanDirectivesUncached(source: string): Map<number, number> {
    const hits = new Map<number, number>();
    if (!anyInSource(source)) return hits;
    for (let i = source.indexOf('/*'); i !== -1; i = source.indexOf('/*', i + 2)) {
        const end = source.indexOf('*/', i + 2);
        if (end === -1) break;
        const text = source.slice(i + 2, end);
        let mask = 0;
        if (text.includes('@')) for (const [tok, bit] of TOKENS) if (text.includes(tok)) mask |= bit;
        if (mask !== 0) {
            const at = nextTokenStart(source, end + 2);
            if (at !== -1) hits.set(at, (hits.get(at) ?? 0) | mask);
        }
        i = end;
    }
    return hits;
}

/** True when `mask` opts into `want`, honouring the `@optimize` combo. */
export const opts = (mask: number, want: number): boolean =>
    (mask & want) !== 0 || ((mask & DIRECTIVE.OPTIMIZE) !== 0 && (OPTIMIZE_IMPLIES & want) !== 0);

/**
 * Span starts of the constructs opted into `want`.
 *
 * A directive written before `export function f() {}` attaches to `export`, so the annotation is
 * propagated to the exported declaration — the common shape for declaration-level directives
 * (compilecat `annotated_spans_with_exports`).
 */
export function directiveSpans(source: string, program: Node, want: number): Set<number> {
    const out = new Set<number>();
    const hits = scanDirectives(source);
    if (hits.size === 0) return out;
    for (const [at, mask] of hits) if (opts(mask, want)) out.add(at);
    // The walk below only ever propagates an annotation from an `export` to the declaration it wraps,
    // and it does that by testing `out.has(n.start)`. With nothing in `out` it cannot add anything, so
    // the walk is pure waste. The existing `hits.size === 0` guard above does not cover this: a module
    // that carries `@inline` but no `@optimize` has hits, yet an empty `out` for the `@optimize` query.
    // Measured on a crashcat bundle: 27 of 55 walks (49.1%) start from an empty set.
    if (out.size === 0) return out;
    walk(program, (n) => {
        if (n.type !== N.ExportNamedDeclaration && n.type !== N.ExportDefaultDeclaration) return;
        if (!out.has(n.start)) return;
        const decl = (n.data as { declaration: Node | null }).declaration;
        if (decl !== null) out.add(decl.start);
    });
    return out;
}
