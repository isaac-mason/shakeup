import { C_AFTER_NEWLINE, C_BLOCK, C_HAS_NEWLINE } from './lexer.ts';

/**
 * Comments are retained as spans and classified ON DEMAND.
 *
 * oxc classifies eagerly, at insertion (`lexer/trivia_builder.rs:240-369`), because `memchr` makes
 * the `@license`/`@preserve` body sweep free in Rust. In JS it is not: measured on three.core.js
 * (1.44 MB, 3,397 comments), retaining spans costs 0.021 ms while the eager sweep costs 0.274 ms —
 * 13x more, to find one legal comment. So the cheap half is unconditional and the expensive half is
 * the consumer's to ask for.
 */
export const COMMENT_STRIDE = 4;

export const commentCount = (c: Int32Array): number => c.length / COMMENT_STRIDE;
export const commentStart = (c: Int32Array, i: number): number => c[i * COMMENT_STRIDE];
export const commentEnd = (c: Int32Array, i: number): number => c[i * COMMENT_STRIDE + 1];
/** Start offset of the token this comment precedes — the join is by OFFSET, as in oxc. */
export const commentAttachedTo = (c: Int32Array, i: number): number => c[i * COMMENT_STRIDE + 3];
export const isBlockComment = (c: Int32Array, i: number): boolean => (c[i * COMMENT_STRIDE + 2] & C_BLOCK) !== 0;
/** The comment itself spans a line break — a block comment only. */
export const commentSpansLines = (c: Int32Array, i: number): boolean => (c[i * COMMENT_STRIDE + 2] & C_HAS_NEWLINE) !== 0;
export const commentOnOwnLine = (c: Int32Array, i: number): boolean => (c[i * COMMENT_STRIDE + 2] & C_AFTER_NEWLINE) !== 0;

/** Text between the delimiters. oxc's `Comment::content_span` (`ast/comment.rs:195`). */
export function commentBody(src: string, c: Int32Array, i: number): string {
    const start = commentStart(c, i) + 2;
    return src.slice(start, isBlockComment(c, i) ? commentEnd(c, i) - 2 : commentEnd(c, i));
}

export const CommentKind = {
    Normal: 0,
    /** `/*!` or a body containing `@license` / `@preserve` — must survive minification. */
    Legal: 1,
    /** `/**` — a JSDoc block. */
    Jsdoc: 2,
    Annotation: 3,
    /** `//# sourceMappingURL=` / `//# sourceURL=` — must be DROPPED, not re-emitted, or it collides
     *  with the one the bundler appends. */
    SourceMapping: 4,
} as const;
export type CommentKind = (typeof CommentKind)[keyof typeof CommentKind];

const ANNOTATIONS = ['__PURE__', '__NO_SIDE_EFFECTS__', '@vite-ignore', 'webpackChunkName', 'webpackIgnore', '@__INLINE__'];

/**
 * Classify one comment. Ported from oxc's `parse_annotation` + `contains_license_or_preserve_comment`
 * (`lexer/trivia_builder.rs:240-409`), but called by the consumer rather than the lexer.
 */
export function classifyComment(src: string, c: Int32Array, i: number): CommentKind {
    const start = commentStart(c, i);
    const block = isBlockComment(c, i);
    const first = src.charCodeAt(start + 2);
    if (first === 33) return CommentKind.Legal; // `/*!` and `//!` both mark a legal comment
    if (!block && first === 35) {
        const body = src.slice(start + 3, commentEnd(c, i));
        if (body.startsWith(' sourceMappingURL=') || body.startsWith('sourceMappingURL=')) return CommentKind.SourceMapping;
        if (body.startsWith(' sourceURL=') || body.startsWith('sourceURL=')) return CommentKind.SourceMapping;
    }
    const body = commentBody(src, c, i);
    for (const a of ANNOTATIONS) if (body.includes(a)) return CommentKind.Annotation;
    if (body.includes('@license') || body.includes('@preserve')) return CommentKind.Legal;
    // `/**` — but not `/**/`, which is an empty block comment, nor `/***`.
    if (block && first === 42 && src.charCodeAt(start + 3) !== 47) return CommentKind.Jsdoc;
    return CommentKind.Normal;
}
