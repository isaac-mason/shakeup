import { N, type Node, walkChildren } from '../ast.ts';
import { type Semantic, symbolOf } from './semantic.ts';

/** How a namespace-import binding (`import * as ns`) is consumed within one module.
 *  `escapes` = the binding appears anywhere other than a static member read (`ns.foo`), so the
 *  whole namespace surface may be observed and cannot be narrowed. Otherwise `members` is the
 *  exact set of statically-read member names. */
export type NsUsage = { escapes: boolean; members: Set<string> };

/** Classify every namespace-import symbol in `nsSyms` by how it's used across `program`:
 *  `ns.foo` / `ns?.foo` records member `foo`; any other appearance — bare reference, call,
 *  computed access `ns[x]`, passed as an argument, destructured, reassigned — sets `escapes`.
 *  One walk classifies all of a module's namespace bindings at once. */
export function analyzeNsUsage(program: Node, semantic: Semantic, nsSyms: Set<number>): Map<number, NsUsage> {
    const out = new Map<number, NsUsage>();
    for (const s of nsSyms) out.set(s, { escapes: false, members: new Set() });

    /** The namespace symbol an identifier node resolves to, or 0 if it isn't one we track. */
    const nsSymOf = (node: Node): number => {
        if (node.type !== N.IdentifierReference) return 0;
        const s = symbolOf(semantic, node);
        return nsSyms.has(s) ? s : 0;
    };

    const visit = (node: Node): void => {
        if (node.type === N.StaticMemberExpression) {
            const s = nsSymOf(node.data.object);
            if (s !== 0) {
                // `ns.foo` — a narrow member read. Property is an IdentifierName (no symbol); do
                // not recurse into the object (that would re-see the `ns` ident as a bare use).
                out.get(s)!.members.add(node.data.property.name);
                return;
            }
        } else if (node.type === N.ComputedMemberExpression) {
            const s = nsSymOf(node.data.object);
            if (s !== 0) {
                // `ns[expr]` — even a string-literal key is treated as escape for now (conservative;
                // static `ns.foo` covers the overwhelming common case). The key may itself read a
                // namespace, so still visit it.
                out.get(s)!.escapes = true;
                visit(node.data.expression);
                return;
            }
        } else if (node.type === N.IdentifierReference) {
            const s = nsSymOf(node);
            if (s !== 0) out.get(s)!.escapes = true;
            return;
        }
        walkChildren(node, visit);
    };
    visit(program);
    return out;
}
