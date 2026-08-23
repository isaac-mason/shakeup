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

/** Map of `attached-to offset` → directive bits, for every directive comment in `source`. */
export function scanDirectives(source: string): Map<number, number> {
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
    walk(program, (n) => {
        if (n.type !== N.ExportNamedDeclaration && n.type !== N.ExportDefaultDeclaration) return;
        if (!out.has(n.start)) return;
        const decl = (n.data as { declaration: Node | null }).declaration;
        if (decl !== null) out.add(decl.start);
    });
    return out;
}
