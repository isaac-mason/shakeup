// Comments are retained as SPANS and classified on demand.
//
// The lexer used to discard every comment, keeping only `pureAt`/`nseAt`. That is defensible for a
// minifier and wrong for a toolchain: `@license` preservation, `@ts-ignore` surviving a transform,
// and readable dev output all need them.
//
// Why spans-and-defer rather than oxc's eager classification: measured on three.core.js (1.44 MB,
// 3,397 comments) retention costs 0.021 ms while an eager `@license` sweep costs 0.274 ms — 13x more,
// to find ONE legal comment. `memchr` makes that sweep free in Rust; nothing makes it free in JS.
import { describe, expect, it } from 'vitest';
import {
    classifyComment,
    CommentKind,
    commentAttachedTo,
    commentBody,
    commentCount,
    commentOnOwnLine,
    commentSpansLines,
    isBlockComment,
} from '../src/parser/comments.ts';
import { parse } from '../src/parser/index.ts';

const of = (src: string) => {
    const r = parse(src, { ts: false, jsx: false });
    expect(r.errors).toEqual([]);
    return r.comments;
};

describe('retention', () => {
    it('records every comment in source order', () => {
        const src = '// a\n/* b */ var x = 1; // c';
        const c = of(src);
        expect(commentCount(c)).toBe(3);
        expect([0, 1, 2].map((i) => commentBody(src, c, i))).toEqual([' a', ' b ', ' c']);
    });

    it('distinguishes line from block, and records whether the comment spans lines', () => {
        const src = '// a\n/* b\nb */ var x = 1;';
        const c = of(src);
        expect(isBlockComment(c, 0)).toBe(false);
        expect(isBlockComment(c, 1)).toBe(true);
        expect(commentSpansLines(c, 0)).toBe(false);
        expect(commentSpansLines(c, 1)).toBe(true);
    });

    it('anchors each comment to the token it precedes', () => {
        const src = '/* a */ var x = 1;';
        const c = of(src);
        // The join is by OFFSET, as in oxc — comments are never attached to nodes.
        expect(commentAttachedTo(c, 0)).toBe(src.indexOf('var'));
    });

    it('a comment opening the file is on its own line', () => {
        expect(commentOnOwnLine(of('// a\nvar x = 1;'), 0)).toBe(true);
    });

    it('is rewound by a failed speculation, like every other append-only record', () => {
        // `(a, …)` speculates as an arrow head, fails, and re-parses. Recording twice was a real bug
        // in the `nseAt` list; the same trap applies here.
        const c = of('(a, /* once */ function f(){});');
        expect(commentCount(c)).toBe(1);
    });
});

describe('deferred classification', () => {
    const kind = (src: string) => {
        const c = of(src);
        return classifyComment(src, c, 0);
    };

    it.each([
        ['/*! keep me */ var x = 1;', CommentKind.Legal],
        ['//! keep me\nvar x = 1;', CommentKind.Legal],
        ['/* @license MIT */ var x = 1;', CommentKind.Legal],
        ['/* @preserve */ var x = 1;', CommentKind.Legal],
        ['/** jsdoc */ function f(){}', CommentKind.Jsdoc],
        ['/*@__PURE__*/ f();', CommentKind.Annotation],
        ['/* plain */ var x = 1;', CommentKind.Normal],
        ['// plain\nvar x = 1;', CommentKind.Normal],
        ['//# sourceMappingURL=x.map\nvar x = 1;', CommentKind.SourceMapping],
    ])('%s', (src, expected) => {
        expect(kind(src)).toBe(expected);
    });

    it('an empty block comment is not JSDoc', () => {
        expect(kind('/**/ var x = 1;')).toBe(CommentKind.Normal);
    });
});
