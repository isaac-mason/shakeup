// Remove unused expression (oxc `remove_unused_expression.rs`). When an expression's VALUE is
// discarded (an ExpressionStatement), strip the side-effect-free parts, keeping only what has an
// observable effect: `[a(), b];` → `a();`, `(f(), 5);` → `f();`, `void g();` → `g();`, `1 + 2;` →
// removed, and a pure call to what its arguments do: `/*@__PURE__*/ f(g(), a.b);` → `g(), a.b;`. Reuses the coarse
// `mayHaveSideEffects` predicate (analysis/effects.ts); member reads stay effectful (matching oxc's default
// `PropertyReadSideEffects::All`, no pure-getter assumption).
//
// NOT ported (deferred, honestly): the dead-STORE case (`x = v;` when `x` is never read afterward).
// oxc's `remove_unused_assignment_expr` needs position-sensitive liveness + `is_implicitly_observable`
// + is itself gated behind a `CompressOptionsUnused` option — a larger, separately-gated pass.
import { isPureCall, mayHaveSideEffects } from '../../analysis/effects.ts';
import { create, N, type Node, statementListOf } from '../../ast/index.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

/** Combine effect-preserving remainders into one expression: none → null, one → itself, many → a
 *  comma SequenceExpression (evaluated left-to-right, preserving order). */
function seqOf(parts: Node[]): Node | null {
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    return create.SequenceExpression(parts[0].start, parts[parts.length - 1].end, 0, parts);
}

/** Reduce a VALUE-DISCARDED expression to just its observable effects, or `null` if it has none
 *  (fully removable). Mirrors oxc's per-type `remove_unused_*` handlers; anything not specially
 *  handled is kept whole when impure (a call's effect can't be stripped). */
function stripDiscarded(node: Node): Node | null {
    // The whole thing is side-effect-free → nothing to keep.
    if (!mayHaveSideEffects(node)) return null;

    const d = node.data as Record<string, unknown>;
    switch (node.type) {
        case N.SequenceExpression: {
            const kept: Node[] = [];
            for (const e of d.expressions as Node[]) {
                const s = stripDiscarded(e);
                if (s !== null) kept.push(s);
            }
            // Nothing stripped → return the SAME reference. Rebuilding an identical node would make
            // the caller report a change on every pass, so the fixed-point loop would never settle.
            return sameList(kept, d.expressions as Node[]) ? node : seqOf(kept);
        }
        case N.BinaryExpression: {
            // Both operands evaluate unconditionally, the operator is pure → keep both effects.
            const kept: Node[] = [];
            const l = stripDiscarded(d.left as Node);
            if (l !== null) kept.push(l);
            const r = stripDiscarded(d.right as Node);
            if (r !== null) kept.push(r);
            return seqOf(kept);
        }
        case N.UnaryExpression: {
            // `!x`/`void x`/`typeof x`/`+x`/`-x`/`~x` just evaluate the operand; `delete` mutates.
            if ((d.operator as string) === 'delete') return node;
            return stripDiscarded(d.argument as Node);
        }
        case N.LogicalExpression: {
            // `a && b` / `a || b` / `a ?? b`: left always runs (its value gates right). If the right's
            // effects strip away, only left's effect remains; else keep `left <op> strippedRight`.
            const rs = stripDiscarded(d.right as Node);
            if (rs === null) return stripDiscarded(d.left as Node);
            if (rs === d.right) return node; // unchanged — do not rebuild (see `sameList`)
            return create.LogicalExpression(node.start, node.end, d.operator as string, d.left as Node, rs);
        }
        case N.ArrayExpression: {
            // The literal itself is inert; keep only effectful elements. A spread iterates, so it stays, and while one
            // does the result stays an array: a bare `...x` isn't an expression (oxc `remove_unused_array_expr`).
            const elements = d.elements as (Node | null)[];
            const kept: Node[] = [];
            let spreads = false;
            for (const el of elements) {
                if (el === null) continue;
                if (el.type === N.SpreadElement) {
                    if (!spreadMayHaveSideEffects(el)) continue;
                    kept.push(el);
                    spreads = true;
                    continue;
                }
                const s = stripDiscarded(el);
                if (s !== null) kept.push(s);
            }
            if (!spreads) return seqOf(kept);
            return sameList(kept, elements as Node[]) ? node : create.ArrayExpression(node.start, node.end, 0, kept);
        }
        case N.CallExpression:
        case N.NewExpression: {
            // oxc `remove_unused_call_expr` / `remove_unused_new_expr`: a pure call whose value is discarded leaves only
            // what its arguments do. Any other call runs as it is.
            if (!isPureCall(node)) return node;
            return seqOf(neededArguments(d.arguments as Node[]));
        }
        case N.ObjectExpression: {
            // oxc `remove_unused_object_expr`: the literal is inert, so keep each computed key and value that has an
            // effect, in order. A spread copies (and so reads) its source; consecutive ones stay together as an object.
            const properties = d.properties as Node[];
            if (properties.every((p) => p.type === N.SpreadElement)) return node;
            const kept: Node[] = [];
            let spreads: Node[] = [];
            const flushSpreads = (): void => {
                if (spreads.length === 0) return;
                kept.push(create.ObjectExpression(spreads[0].start, spreads[spreads.length - 1].end, 0, spreads));
                spreads = [];
            };
            for (const property of properties) {
                if (property.type === N.SpreadElement) {
                    spreads.push(property);
                    continue;
                }
                flushSpreads();
                const p = property.data as { key: Node; value: Node; computed: boolean };
                if (p.computed) {
                    const key = stripDiscarded(p.key);
                    if (key !== null) kept.push(key);
                }
                const value = stripDiscarded(p.value);
                if (value !== null) kept.push(value);
            }
            flushSpreads();
            return seqOf(kept);
        }
        case N.ConditionalExpression: {
            // oxc `remove_unused_conditional_expr`: `t ? 1 : 2` → `t`, `t ? 1 : b()` → `t || b()`, `t ? a() : 2` →
            // `t && a()`.
            const test = d.test as Node;
            const consequent = stripDiscarded(d.consequent as Node);
            const alternate = stripDiscarded(d.alternate as Node);
            if (consequent === null && alternate === null) return stripDiscarded(test);
            if (consequent === null) return create.LogicalExpression(node.start, node.end, '||', test, alternate as Node);
            if (alternate === null) return create.LogicalExpression(node.start, node.end, '&&', test, consequent);
            if (consequent === d.consequent && alternate === d.alternate) return node;
            return create.ConditionalExpression(node.start, node.end, 0, test, consequent, alternate);
        }
        case N.TemplateLiteral: {
            // String cooked parts are inert; keep effectful `${…}` interpolations.
            const kept: Node[] = [];
            for (const e of d.expressions as Node[]) {
                const s = stripDiscarded(e);
                if (s !== null) kept.push(s);
            }
            return seqOf(kept);
        }
        // Member reads, impure calls, assignments and the rest: kept whole.
        default:
            return node;
    }
}

/** Whether a spread element may have side effects, oxc's `ArrayExpressionElement::may_have_side_effects`: spreading an
 *  array or template literal runs only the built-in iterator, so only the literal's own effects count; a string literal
 *  and the function's own `arguments` have none; anything else may run a user `Symbol.iterator`. */
function spreadMayHaveSideEffects(spread: Node): boolean {
    const argument = (spread.data as { argument: Node }).argument;
    switch (argument.type) {
        case N.ArrayExpression:
        case N.TemplateLiteral:
            return mayHaveSideEffects(argument);
        case N.StringLiteral:
            return false;
        case N.IdentifierReference:
            return !(argument.name === 'arguments' && (argument as { sym: number }).sym === 0);
        default:
            return true;
    }
}

/** A discarded pure call's arguments, each reduced to its effects (oxc `fold_arguments_into_needed_expressions`). A
 *  spread argument iterates its source, so it stays, inside an array. */
function neededArguments(args: readonly Node[]): Node[] {
    const needed: Node[] = [];
    for (const arg of args) {
        const expr = arg.type === N.SpreadElement ? create.ArrayExpression(arg.start, arg.end, 0, [arg]) : arg;
        const s = stripDiscarded(expr);
        if (s !== null) needed.push(s);
    }
    return needed;
}

/** Whether `kept` is exactly `orig` — same length, same node references, same order. Used to return
 *  the ORIGINAL node when a strip removed nothing: returning a freshly-built but identical node makes
 *  `rewriteBody` report a change every time, and the compress fixed point then never converges (it
 *  ran to the iteration cap on every build, re-analysing the module's semantic each round). */
function sameList(kept: readonly Node[], orig: readonly Node[]): boolean {
    if (kept.length !== orig.length) return false;
    for (let i = 0; i < kept.length; i++) if (kept[i] !== orig[i]) return false;
    return true;
}

/** Rewrite one statement list: drop pure ExpressionStatements, and shrink impure ones to just their
 *  effects. */
function rewriteBody(body: Node[], ctx: TransformCtx): boolean {
    let changed = false;
    const out: Node[] = [];
    for (const stmt of body) {
        if (stmt.type !== N.ExpressionStatement) {
            out.push(stmt);
            continue;
        }
        const expr = (stmt.data as { expression: Node }).expression;
        const stripped = stripDiscarded(expr);
        if (stripped === null) {
            ctx.dropRefs(stmt); // leaves the tree here, so its references leave the counts with it
            changed = true; // fully pure → drop the statement
            continue;
        }
        if (stripped !== expr) {
            // `stripped` is carved OUT of `expr`, so the parts that survive are subtracted by the drop
            // and added straight back — only what was discarded actually moves.
            ctx.dropRefs(expr);
            ctx.addRefs(stripped);
            (stmt.data as { expression: Node }).expression = stripped;
            changed = true;
        }
        out.push(stmt);
    }
    if (!changed) return false;
    body.length = 0;
    for (const s of out) body.push(s);
    return true;
}

function bodyHook(n: Node, ctx: TransformCtx): void {
    const list = statementListOf(n);
    if (list !== null && rewriteBody(list, ctx)) ctx.changed = true;
}

export const removeUnusedExpr: Visitor = {
    name: 'removeUnusedExpr',
    enter: hookTable({
        [N.Program]: bodyHook,
        [N.BlockStatement]: bodyHook,
        [N.StaticBlock]: bodyHook,
        [N.SwitchCase]: bodyHook,
    }),
    exit: null,
};
