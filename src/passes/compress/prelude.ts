// Shared compress prelude — the facts every reference-driven pass needs, gathered in ONE walk.
//
// WHY THIS EXISTS (CPU-profiled, see the roadmap's compress-perf section). Four passes each ran their
// own FULL-PROGRAM pre-pass at `[N.Program]` enter:
//     constProp   → tallyRefs + walkRefIdents
//     aliasInline → tallyRefs + walkRefIdents + scanExports
//     inline      → tallyRefs
//     dropUnused  → countUses (another walkRefIdents)
// That is ~7 whole-program walks PER ITERATION, on top of the main traversal, across ~6 iterations —
// roughly 42 extra walks per module. `walkRefIdents` came out as the single hottest function in the
// entire compress tier (14.2% of self-time), ahead of both the parser and `analyze`. oxc runs ONE
// traversal per iteration and reads everything from its maintained `Scoping`; the ~37x speed gap
// against `oxc-minify` is mostly this, not language.
//
// WHY MERGING IS SAFE — the property that makes this a zero-risk change rather than a redesign: all
// four hooks fire on `[N.Program]` ENTER of the SAME fused traversal, so they each observe the identical
// pre-mutation tree. Computing their inputs once, at that same moment, is therefore SEMANTICALLY
// IDENTICAL — no staleness question, no maintenance contract, no output change. (Maintaining these
// incrementally across a traversal is a separate, much larger step; see the roadmap's P4.)
import { N, type Node } from '../../ast.ts';
import { walkRefIdents } from '../../analysis/refs.ts';
import type { RefCounts } from '../../analysis/movement.ts';
import { walkChildren } from '../../ast.ts';

export type Prelude = {
    /** Read/write counts per symbol — replaces `tallyRefs(program)`. */
    refs: Map<number, RefCounts>;
    /** Symbols read as a shorthand-property VALUE (`{ x }`), which cannot be substituted by span. */
    shorthand: Set<number>;
    /** Locals re-exported by a bare `export { X }` specifier — never rename or substitute these. */
    exported: Set<number>;
    /** Use counts per symbol (reference nodes only, not declarations) — replaces `countUses`. */
    uses: Map<number, number>;
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
    const refs = new Map<number, RefCounts>();
    const shorthand = new Set<number>();
    const exported = new Set<number>();
    const uses = new Map<number, number>();

    const bump = (sym: number, kind: 'reads' | 'writes'): void => {
        if (sym === 0) return;
        let c = refs.get(sym);
        if (c === undefined) {
            c = { reads: 0, writes: 0 };
            refs.set(sym, c);
        }
        c[kind]++;
    };

    // ── pass A: read/write tally (structure copied from `tallyRefs`) ─────────────────────────────
    const visitTarget = (node: Node): void => {
        switch (node.type) {
            case N.IdentifierReference:
                bump(node.sym, 'writes');
                return;
            case N.ArrayExpression:
                for (const el of node.data.elements) if (el !== null) visitTarget(el);
                return;
            case N.ObjectExpression:
                for (const p of node.data.properties) visitTarget(p);
                return;
            case N.ObjectProperty:
                visitTarget(node.data.value);
                return;
            case N.SpreadElement:
            case N.RestElement:
                visitTarget(node.data.argument);
                return;
            case N.AssignmentExpression:
            case N.AssignmentPattern:
                visitTarget(node.data.left);
                visit(node.data.right);
                return;
            case N.StaticMemberExpression:
            case N.ComputedMemberExpression:
                visit(node);
                return;
            default:
                walkChildren(node, visitTarget);
        }
    };

    const visit = (node: Node): void => {
        switch (node.type) {
            case N.AssignmentExpression: {
                const { operator, left, right } = node.data;
                visitTarget(left);
                if (operator !== '=' && left.type === N.IdentifierReference) bump(left.sym, 'reads');
                visit(right);
                return;
            }
            case N.UpdateExpression: {
                const arg = node.data.argument;
                if (arg.type === N.IdentifierReference) {
                    bump(arg.sym, 'writes');
                    bump(arg.sym, 'reads');
                } else visit(arg);
                return;
            }
            case N.ForInStatement:
            case N.ForOfStatement: {
                const { left, right, body } = node.data;
                if (left.type === N.VariableDeclaration) visit(left);
                else visitTarget(left);
                visit(right);
                visit(body);
                return;
            }
            case N.IdentifierReference:
                bump(node.sym, 'reads');
                return;
            case N.BindingIdentifier:
                return;
            case N.ExportSpecifier: {
                // `export { b }` — the specifier's `local` IS an IdentifierReference, so substituting
                // it would rewrite the PUBLIC export name.
                const local = node.data.local;
                if (local.type === N.IdentifierReference && local.sym !== 0) exported.add(local.sym);
                break; // fall through to the generic walk so the ref is still tallied
            }
            default:
                break;
        }
        walkChildren(node, visit);
    };
    visit(program);

    // ── pass B: shorthand + use counts ───────────────────────────────────────────────────────────
    // `walkRefIdents` knows the shorthand-property shape (`{ a }` / `{ a = 1 }`), which the tally walk
    // above does not model; both consumers of it are folded in here.
    walkRefIdents(program, (ident, shp) => {
        if (ident.type !== N.IdentifierReference) return;
        const sym = ident.sym;
        if (sym === 0) return;
        if (shp !== null) shorthand.add(sym);
        uses.set(sym, (uses.get(sym) ?? 0) + 1);
    });

    return { refs, shorthand, exported, uses };
}

// ── sharing across one traversal ──────────────────────────────────────────────────────────────────
// The compress driver computes the prelude ONCE before each fixed-point traversal and installs it here;
// every pass then reads the same object at its `[N.Program]` enter. Module-level state matches how the
// passes already carry per-traversal data (`REFS`, `ALIAS`, `INLINE`, …) — a single-threaded traverse.
let CURRENT: Prelude | null = null;

/** Install the prelude for the traversal about to run (null to clear). */
export const setPrelude = (p: Prelude | null): void => {
    CURRENT = p;
};

/**
 * The prelude for the current traversal, computing it on demand when none is installed.
 *
 * The fallback matters: a pass used standalone (a unit test, a one-off traversal) must still work, and
 * computing it there costs exactly what that pass used to pay for its own pre-pass. Only the shared
 * path gets the saving, which is the point.
 */
export function getPrelude(program: Node): Prelude {
    if (CURRENT !== null) return CURRENT;
    return computePrelude(program);
}
