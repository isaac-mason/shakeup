// Port of oxc's `PeepholeOptimizations::should_keep_indirect_access`
// (`oxc_minifier/src/peephole/remove_dead_code.rs`).
//
// Folding a conditional or logical expression down to one operand is normally free, but not when the
// expression is a CALL'S CALLEE or a TAGGED TEMPLATE'S TAG and the survivor is a member expression:
// `(true && o.f)()` calls `f` with `this === undefined`, while `o.f()` calls it with `this === o`.
// oxc's own doc comment names the exact case this file exists for:
//
//     let o = { f() { assert.ok(this !== o); } }; (true && o.f)(); (true && o.f)``;
//
// The fix both bundlers use is to keep the access INDIRECT by folding to `(0, o.f)` instead of
// `o.f` — a sequence expression whose value is the function but whose reference is not a member
// reference, so `this` stays undefined.
//
// Two more parents need the same protection, for different reasons, and oxc handles them in the same
// helper: a global `eval` loses its DIRECT-eval powers through `(0, eval)`, and `typeof` / `delete`
// change meaning when their operand stops being parenthesised.
import { create, N, type Node, num } from '../../ast/index.ts';

/** Is `node` a member expression — the shape whose `this` binding a fold would change? */
const isMemberExpr = (node: Node): boolean => node.type === N.StaticMemberExpression || node.type === N.ComputedMemberExpression;

/**
 * Would replacing the current node with `value` change meaning, given its `parent`?
 *
 * Mirrors oxc's match on `ctx.parent()`. `eval` is matched by NAME only: shakeup has no
 * `is_global_reference` here, so a shadowed local `eval` is treated conservatively as the global —
 * costing two bytes in a case nobody writes, and never wrong in the unsafe direction.
 */
export function shouldKeepIndirectAccess(value: Node, node: Node, parent: Node | null): boolean {
    if (parent === null) return false;
    if (parent.type === N.CallExpression || parent.type === N.TaggedTemplateExpression) {
        const callee = (parent.data as { callee?: Node; tag?: Node }).callee ?? (parent.data as { tag?: Node }).tag;
        // POSITION, not just parent type. Only the callee/tag slot binds `this`; an ARGUMENT of the
        // same call is unaffected, and wrapping it would be pure bloat. Checking the parent's type
        // alone wrapped `g(true && o.f)` as `g((0, o.f))`.
        if (callee !== node) return false;
        if (isMemberExpr(value)) return true;
        return value.type === N.IdentifierReference && value.name === 'eval';
    }
    if (parent.type === N.UnaryExpression) {
        const op = (parent.data as { operator: string }).operator;
        // `typeof (0, foo)` throws on an undeclared `foo`; `typeof foo` does not.
        if (op === 'typeof') return (parent.data as { argument: Node }).argument === node && value.type === N.IdentifierReference;
        // `delete (0, foo)` is a no-op; `delete foo` is a SyntaxError in strict mode, and
        // `delete (0, o.x)` is a no-op where `delete o.x` removes the property.
        if (op === 'delete')
            return (
                (parent.data as { argument: Node }).argument === node &&
                (value.type === N.IdentifierReference || isMemberExpr(value))
            );
    }
    return false;
}

/** `value`, or `(0, value)` when the parent context requires the access to stay indirect. `node` is
 *  the node being REPLACED — needed to tell the callee slot from an argument slot. */
export function keepIndirectAccess(value: Node, node: Node, parent: Node | null): Node {
    if (!shouldKeepIndirectAccess(value, node, parent)) return value;
    return create.SequenceExpression(value.start, value.end, 0, [num(0, value.start), value]);
}
