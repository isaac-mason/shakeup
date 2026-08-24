// Reference-fact ORACLE for `tst/semantic-refs-differential.test.ts`. NOT part of the pipeline.
//
// HISTORY, because the comment that used to live here described a design that no longer exists.
// Four compress passes each ran their own full-program pre-pass at `[N.Program]` enter (constProp,
// aliasInline, inline, dropUnused — `tallyRefs` / `walkRefIdents` / an export scan between them),
// ~7 whole-program walks per iteration. That collapsed into ONE shared walk here, and then into no
// walk at all: `analyze` now maintains `refs`/`uses`/`shorthand`/`exported` on the `Semantic` as it
// goes, because it already visits every node and already collects every reference.
//
// This file survives ONLY as the differential's reference implementation, and that is the point of
// keeping it: it derives the same four facts by a completely INDEPENDENT route (a bespoke tally walk
// plus `walkRefIdents`, rather than the semantic builder's deferred-resolution queue). Two
// implementations that share no code disagreeing is a signal; one implementation agreeing with itself
// is not. Do not "simplify" this to call into `analyze` — that would delete the test's only evidence.
//
// Keep it CORRECT, not merely historical: it is asserted equal to `analyze`, so a bug here reads as a
// bug there. It has already had one (computed keys in a destructuring target went uncounted).
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
                // `({ [k]: a } = o)` EVALUATES `k` to pick the property, so `k` is a genuine read.
                // This walk used to skip it, under-counting — the direction the invariant forbids.
                // It happened to be benign (`const-prop` gates on `reads === 0 -> skip`, so the loss
                // was an optimization, not a miscompile), but `analyze` counts it, and this oracle
                // has to agree or the differential is asserting the wrong thing.
                if (node.data.computed) visit(node.data.key);
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
