// Remove private class members nothing reads (oxc `remove_unused_private_members`).
//
// A `#name` is only reachable from inside the class body that declares it — there is no dynamic
// escape hatch (no `obj["#x"]`, no reflection), which is what makes this safe where the same reasoning
// on a public field would not be. So a private member with no `o.#name` read and no `#name in o` brand
// check anywhere in its class is dead.
//
// USES ARE TRACKED ON A STACK, one frame per class, exactly as oxc does
// (`PrivateMemberUsageStack`, `oxc_minifier/src/state.rs:200-250`): a use is recorded into the
// INNERMOST frame, and on leaving a class the names that class DECLARES are removed and the remainder
// propagates to the enclosing frame. That propagation is what makes a nested class referencing an
// OUTER class's `#x` count as a use of the outer member:
//
//     class Outer { #x = 1; m() { return class { n(o) { return o.#x; } }; } }
//
// KEPT DESPITE BEING UNREAD:
//   • a field whose initialiser may have SIDE EFFECTS (`#x = load()`) — dropping it would drop the
//     call. oxc keeps the whole element rather than trying to hoist the initialiser.
//   • a `static {}` block (oxc keeps StaticBlock outright; it has no key, so it is never a candidate).
//   • every non-private member — a public field is reachable by string key.
//
// BAILS ENTIRELY when the class sits under a direct `eval`, which can name a private member at runtime
// (oxc checks `contains_direct_eval` first).
import { isPureExpr } from '../../analysis/effects.ts';
import { N, type Node } from '../../ast.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

/** One frame per class; each holds the `#name`s READ inside it (minus those it declares, on exit). */
let stack: Set<string>[] = [];
/** True when the module contains a direct `eval`, which can name a private member at runtime.
 *  Determined UP FRONT at Program-enter from `semantic.unresolved`, not accumulated during the walk:
 *  a class exits before the rest of the module is visited, so a later `eval` would arrive too late to
 *  stop a removal that had already happened. `mangle/chunk.ts` gates on the same signal. */
let sawDirectEval = false;

const recordUse = (name: string): void => {
    if (stack.length > 0) stack[stack.length - 1].add(name);
};

/** The `#name`s this class body declares — removed from the frame on exit so they do not leak out. */
function declaredNames(body: Node[]): string[] {
    const out: string[] = [];
    for (const el of body) {
        const key = (el.data as { key?: Node } | null)?.key;
        if (key !== undefined && key !== null && key.type === N.PrivateIdentifier) out.push(key.name);
    }
    return out;
}

function onClassExit(n: Node, ctx: TransformCtx): void {
    const frame = stack.pop();
    if (frame === undefined) return;
    const d = n.data as { body: Node[] };
    const body = d.body;

    if (!sawDirectEval) {
        const kept: Node[] = [];
        const dropped: Node[] = [];
        for (const el of body) {
            const key = (el.data as { key?: Node } | null)?.key;
            // Non-private (or keyless, e.g. StaticBlock) elements are never candidates.
            if (key === undefined || key === null || key.type !== N.PrivateIdentifier) {
                kept.push(el);
                continue;
            }
            if (frame.has(key.name)) {
                kept.push(el);
                continue;
            }
            // Unread. A method/accessor body cannot run at definition time, so it goes. A field's
            // initialiser CAN, so it stays unless provably pure.
            if (el.type === N.PropertyDefinition) {
                const value = (el.data as { value: Node | null }).value;
                if (value !== null && !isPureExpr(value)) {
                    kept.push(el);
                    continue;
                }
            } else if (el.type !== N.MethodDefinition) {
                kept.push(el); // unknown element kind — leave it alone
                continue;
            }
            dropped.push(el);
        }
        if (dropped.length > 0) {
            // The dropped elements leave the tree without passing through a `ctx` mutation helper, so
            // their references are subtracted explicitly or the maintained counts keep counting reads
            // that no longer exist.
            for (const el of dropped) ctx.dropRefs(el);
            d.body = kept;
            ctx.changed = true;
        }
    }

    // Propagate: uses of names this class does NOT declare must belong to an enclosing class.
    if (stack.length > 0) {
        const outer = stack[stack.length - 1];
        const mine = new Set(declaredNames(body));
        for (const name of frame) if (!mine.has(name)) outer.add(name);
    }
}

export const removeUnusedPrivateMembers: Visitor = {
    name: 'removeUnusedPrivateMembers',
    enter: hookTable({
        [N.Program]: (_n, ctx: TransformCtx) => {
            stack = [];
            sawDirectEval = false;
            for (const node of ctx.semantic.unresolved) {
                if (node.name === 'eval') { sawDirectEval = true; break; }
            }
        },
        [N.ClassDeclaration]: () => { stack.push(new Set()); },
        [N.ClassExpression]: () => { stack.push(new Set()); },
        // `o.#x` — a read (or write) of a private member.
        [N.PrivateFieldExpression]: (n) => {
            const field = (n.data as { field: Node }).field;
            if (field.type === N.PrivateIdentifier) recordUse(field.name);
        },
        // `#x in o` — the ergonomic brand check. Its LEFT operand is a bare PrivateIdentifier, which is
        // the only place one appears outside a member expression or a class key.
        [N.BinaryExpression]: (n) => {
            const d = n.data as { operator: string; left: Node };
            if (d.operator === 'in' && d.left.type === N.PrivateIdentifier) recordUse(d.left.name);
        },
    }),
    exit: hookTable({
        [N.ClassDeclaration]: onClassExit,
        [N.ClassExpression]: onClassExit,
    }),
};
