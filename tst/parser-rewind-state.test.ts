import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWithDiagnostics } from '../src/parser/parser.ts';

// `restoreState` restored `commentsLen` from the saved `topLevelThis` length and `topLevelThis.length`
// from the saved comment count — the two indices were SWAPPED. Both directions did damage on every
// speculative rewind:
//
//   · the comment table was truncated to the number of top-level `this` nodes, so comments were
//     silently DROPPED — including `@license` blocks, which survive minification and are the one
//     class of comment a bundler must never lose;
//   · `topLevelThis` was RESIZED to the comment count, inflating a length that `link.ts`'s
//     `wantsCjsWrap` reads as "this module looks like CommonJS".
//
// Nothing caught it: the whole suite passes with the bug reinstated. It surfaced only because a new
// speculative peek elsewhere made the corruption frequent enough to move `pnpm unchanged`.
const parse = (src: string) => parseWithDiagnostics(src, { ts: false, jsx: false, kind: 'unambiguous' });

describe('speculative rewind restores the right state', () => {
    // `(a, b);` makes the parser probe for an arrow, fail at the missing `=>`, and rewind. A
    // top-level `this` before it means the two saved lengths DIFFER, which is what makes a swap
    // observable at all — with both at zero the bug is invisible.
    it('keeps comments across a rewind, and does not inflate `topLevelThis`', () => {
        const r = parse('this; /** doc */ (a, b);');
        expect(r.topLevelThis, 'one top-level `this`').toHaveLength(1);
        expect((r.comments as Int32Array).length, 'the comment survives the rewind').toBe(4);
    });

    it('scales with both counts, so a swap cannot coincidentally match', () => {
        const r = parse('this; this; /*! legal */ /** d */ (a, b);');
        expect(r.topLevelThis).toHaveLength(2);
        expect((r.comments as Int32Array).length).toBe(8);
    });

    it('keeps a `@license` block through a rewind — a real bundle lost one', () => {
        // three.js's license header was being stripped from every MINIFIED build, 92 bytes that a
        // licence-bearing dependency is entitled to keep.
        const src = '/**\n * @license\n * MIT\n */\nthis;\n(a, b);\n';
        expect((parse(src).comments as Int32Array).length, 'the license comment is retained').toBe(4);
    });

    it('holds on a real file: three.core.js keeps its comments and has no top-level `this`', () => {
        const three = 'llm/spikes/node_modules/three/build/three.core.js';
        let src: string;
        try {
            src = readFileSync(three, 'utf8');
        } catch {
            return; // the spike corpus is optional
        }
        const r = parse(src);
        expect(r.errors).toHaveLength(0);
        expect(r.topLevelThis, 'an ES module has no top-level `this`').toHaveLength(0);
        expect((r.comments as Int32Array).length, 'was 7,684 with the swap').toBeGreaterThan(17000);
    });
});
