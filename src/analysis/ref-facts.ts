// Reference-role classification over a RESOLVED tree (`node.sym` already assigned).
//
// `analyze` classifies the same roles while BUILDING the semantic, where resolution is deferred and
// the role has to ride the pending record. Once a tree is resolved the job is much simpler: walk it
// and read `node.sym` directly. Two consumers need exactly that:
//   • the compress prelude ORACLE, which derives the facts independently for the differential;
//   • incremental maintenance, which needs the contribution of a subtree being DROPPED so it can be
//     subtracted from the maintained counts without rebuilding the semantic.
//
// Both go through this one walker so the two directions can never disagree about what a reference IS.
// That symmetry is the whole safety argument: a subtree's contribution is subtracted using the same
// classification that added it. Getting `writes` wrong in particular is not a size regression — an
// under-counted write makes `aliasInline` believe a binding is never reassigned, and it will happily
// substitute across the reassignment.
import { N, type Node, walkChildren } from '../ast.ts';

/** Syntactic role of a reference. Mirrors the private flags in `semantic.ts` deliberately. */
export const REF = {
    READ: 1,
    WRITE: 2,
    SHORTHAND: 4,
    EXPORTED: 8,
} as const;

export type RefEmit = (sym: number, flags: number) => void;

/** Emit every resolved reference under `root` with its role. Unresolved (`sym === 0`) is skipped. */
export function emitRefFacts(root: Node, emit: RefEmit): void {
    const hit = (n: Node, flags: number): void => {
        const sym = (n as { sym: number }).sym;
        if (sym !== 0) emit(sym, flags);
    };

    // `{ x }` / `{ x = 1 }` — the value is a reference that cannot be substituted by span, because
    // rewriting it in place would change the property NAME with it. Orthogonal to direction: a
    // shorthand appears both as a read (`const o = { x }`) and as a write (`({ x } = o)`).
    const shorthandProp = (data: { shorthand: boolean; value: Node }, base: number): boolean => {
        if (!data.shorthand) return false;
        const v = data.value;
        if (v.type === N.IdentifierReference) {
            hit(v, base | REF.SHORTHAND);
            return true;
        }
        if (v.type === N.AssignmentPattern) {
            const l = v.data.left;
            if (l.type === N.IdentifierReference) hit(l, base | REF.SHORTHAND);
            else target(l);
            visit(v.data.right);
            return true;
        }
        return false;
    };

    /** An assignment TARGET: the identifiers it binds are WRITES. A member target is the exception —
     *  `a.b = 1` sets a property, so `a` itself is READ, which is why those arms hand back to `visit`. */
    const target = (n: Node | null): void => {
        if (n === null) return;
        switch (n.type) {
            case N.IdentifierReference:
                hit(n, REF.WRITE);
                return;
            case N.ArrayExpression:
                for (const el of n.data.elements) if (el !== null) target(el);
                return;
            case N.ObjectExpression:
                for (const p of n.data.properties) target(p);
                return;
            case N.ObjectProperty:
                if (n.data.computed) visit(n.data.key);
                if (shorthandProp(n.data, REF.WRITE)) return;
                target(n.data.value);
                return;
            case N.SpreadElement:
            case N.RestElement:
                target(n.data.argument);
                return;
            case N.AssignmentExpression:
            case N.AssignmentPattern:
                target(n.data.left);
                visit(n.data.right);
                return;
            case N.StaticMemberExpression:
            case N.ComputedMemberExpression:
                visit(n);
                return;
            default:
                visit(n);
        }
    };

    const visit = (n: Node | null): void => {
        if (n === null) return;
        switch (n.type) {
            case N.IdentifierReference:
                hit(n, REF.READ);
                return;
            case N.BindingIdentifier:
                return; // a declaration is not a reference
            case N.AssignmentExpression: {
                const { operator, left, right } = n.data;
                // `x += 1` READS x as well as writing it; `x = 1` only writes.
                if (operator !== '=' && left.type === N.IdentifierReference) hit(left, REF.READ | REF.WRITE);
                else target(left);
                visit(right);
                return;
            }
            case N.UpdateExpression: {
                const arg = n.data.argument;
                if (arg.type === N.IdentifierReference) hit(arg, REF.READ | REF.WRITE);
                else visit(arg);
                return;
            }
            case N.ForInStatement:
            case N.ForOfStatement: {
                // `for (x of xs)` ASSIGNS to `x` each turn; only a VariableDeclaration head declares.
                if (n.data.left.type === N.VariableDeclaration) visit(n.data.left);
                else target(n.data.left);
                visit(n.data.right);
                visit(n.data.body);
                return;
            }
            case N.ObjectProperty:
                if (n.data.computed) visit(n.data.key);
                if (shorthandProp(n.data, REF.READ)) return;
                visit(n.data.value);
                return;
            case N.ExportSpecifier: {
                // `export { b }` — the specifier's `local` IS a reference, and substituting it would
                // rewrite the PUBLIC export name.
                const local = n.data.local;
                if (local.type === N.IdentifierReference) {
                    hit(local, REF.READ | REF.EXPORTED);
                    return;
                }
                break;
            }
            default:
                break;
        }
        walkChildren(n, visit);
    };

    visit(root);
}

/** Recompute the four reference facts for `program` from scratch. Ground truth. */
export function computeRefFacts(program: Node): {
    refs: Map<number, { reads: number; writes: number }>;
    uses: Map<number, number>;
    shorthand: Set<number>;
    exported: Set<number>;
} {
    const refs = new Map<number, { reads: number; writes: number }>();
    const uses = new Map<number, number>();
    const shorthand = new Set<number>();
    const exported = new Set<number>();
    emitRefFacts(program, (sym, flags) => {
        if ((flags & (REF.READ | REF.WRITE)) !== 0) {
            let c = refs.get(sym);
            if (c === undefined) {
                c = { reads: 0, writes: 0 };
                refs.set(sym, c);
            }
            if ((flags & REF.READ) !== 0) c.reads++;
            if ((flags & REF.WRITE) !== 0) c.writes++;
        }
        uses.set(sym, (uses.get(sym) ?? 0) + 1);
        if ((flags & REF.SHORTHAND) !== 0) shorthand.add(sym);
        if ((flags & REF.EXPORTED) !== 0) exported.add(sym);
    });
    return { refs, uses, shorthand, exported };
}

/**
 * Compare INCREMENTALLY MAINTAINED counts against ground truth recomputed from `program`.
 *
 * oxc's `debug_assert_no_over_prune` / `debug_assert_no_under_prune`. The two directions are NOT
 * equally serious and the report says which is which: a maintained count that is too HIGH costs an
 * optimization, a maintained count that is too LOW deletes a binding that is still referenced.
 */
export function verifyRefFacts(
    maintained: { refs: Map<number, { reads: number; writes: number }>; uses: Map<number, number> },
    program: Node,
): string[] {
    const truth = computeRefFacts(program);
    const out: string[] = [];
    const syms = new Set<number>([...truth.refs.keys(), ...maintained.refs.keys()]);
    for (const sym of syms) {
        const m = maintained.refs.get(sym);
        const t = truth.refs.get(sym);
        const mr = m?.reads ?? 0;
        const tr = t?.reads ?? 0;
        const mw = m?.writes ?? 0;
        const tw = t?.writes ?? 0;
        if (mr !== tr) out.push(`sym ${sym} reads maintained=${mr} truth=${tr} ${mr < tr ? 'UNDER(unsafe)' : 'over(safe)'}`);
        if (mw !== tw) out.push(`sym ${sym} writes maintained=${mw} truth=${tw} ${mw < tw ? 'UNDER(unsafe)' : 'over(safe)'}`);
    }
    for (const sym of new Set<number>([...truth.uses.keys(), ...maintained.uses.keys()])) {
        const mu = maintained.uses.get(sym) ?? 0;
        const tu = truth.uses.get(sym) ?? 0;
        if (mu !== tu) out.push(`sym ${sym} uses maintained=${mu} truth=${tu} ${mu < tu ? 'UNDER(unsafe)' : 'over(safe)'}`);
    }
    return out;
}
