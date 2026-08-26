// Reference-fact ORACLE for `tst/semantic-refs-differential.test.ts`. NOT part of the pipeline.
//
// HISTORY, because the comment that used to live here described a design that no longer exists.
// Four compress passes each ran their own full-program pre-pass at `[N.Program]` enter (constProp,
// aliasInline, inline, dropUnused — `tallyRefs` / `walkRefIdents` / an export scan between them),
// ~7 whole-program walks per iteration. That collapsed into ONE shared walk here, and then into no
// walk at all: `analyze` now maintains `refs`/`uses`/`shorthand`/`exported` on the `Semantic` as it
// goes, because it already visits every node and already collects every reference.
//
// This file survives as the differential's reference implementation, deriving the four facts from a
// RESOLVED tree (`analysis/ref-facts.ts`) rather than from the semantic builder's deferred-resolution
// queue. Those two routes stay independent, which is what the differential tests. Do not "simplify"
// this to call into `analyze` — that would delete the test's only evidence.
//
// It shares `emitRefFacts` with incremental maintenance ON PURPOSE: a subtree's contribution must be
// subtracted using the same classification that added it, and the analyze-vs-oracle differential
// covers that shared walker for free.
//
// Keep it CORRECT, not merely historical: it is asserted equal to `analyze`, so a bug here reads as a
// bug there. It has already had one (computed keys in a destructuring target went uncounted).
import type { RefCounts } from '../../analysis/movement.ts';
import type { Node } from '../../ast.ts';
import { emitRefFacts, REF } from '../../analysis/ref-facts.ts';

export type Prelude = {
    /** Read/write counts per symbol — replaces `tallyRefs(program)`. */
    refs: (RefCounts | undefined)[];
    /** Symbols read as a shorthand-property VALUE (`{ x }`), which cannot be substituted by span. */
    shorthand: Set<number>;
    /** Locals re-exported by a bare `export { X }` specifier — never rename or substitute these. */
    exported: Set<number>;
    /** Use counts per symbol (reference nodes only, not declarations) — replaces `countUses`. */
    uses: number[];
};

/**
 * Walk `program` once and gather every reference-derived fact the compress passes need.
 *
 * Classification mirrors `tallyRefs` EXACTLY, including its quirks, because the passes were written
 * against it: a compound assignment (`x += 1`) and an update (`x++`) count as BOTH a read and a write;
 * a member target (`a.b = …`) sets a property, so `a` is a READ, not a binding write; a BindingIdentifier
 * is neither (a declaration is not a reference). `tst/compress-prelude.test.ts` pins the equivalence.
 */
export function computePrelude(program: Node): Prelude {
    const refs: (RefCounts | undefined)[] = [];
    const shorthand = new Set<number>();
    const exported = new Set<number>();
    const uses: number[] = [];
    emitRefFacts(program, (sym, flags) => {
        if ((flags & (REF.READ | REF.WRITE)) !== 0) {
            let c = refs[sym];
            if (c === undefined) {
                c = { reads: 0, writes: 0 };
                refs[sym] = c;
            }
            if ((flags & REF.READ) !== 0) c.reads++;
            if ((flags & REF.WRITE) !== 0) c.writes++;
        }
        uses[sym] = (uses[sym] ?? 0) + 1;
        if ((flags & REF.SHORTHAND) !== 0) shorthand.add(sym);
        if ((flags & REF.EXPORTED) !== 0) exported.add(sym);
    });
    return { refs, shorthand, exported, uses };
}
