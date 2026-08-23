// Remove unused expression (oxc `remove_unused_expression.rs`). When an expression's VALUE is
// discarded (an ExpressionStatement), strip the side-effect-free parts, keeping only what has an
// observable effect: `[a(), b];` → `a();`, `(f(), 5);` → `f();`, `void g();` → `g();`, `1 + 2;` →
// removed. Reuses the coarse `mayHaveSideEffects` predicate (analysis/effects.ts); conservative by
// construction — member reads and calls are treated as effectful and kept (matching oxc's default
// `PropertyReadSideEffects::All`, no pure-getter assumption).
//
// NOT ported (deferred, honestly): the dead-STORE case (`x = v;` when `x` is never read afterward).
// oxc's `remove_unused_assignment_expr` needs position-sensitive liveness + `is_implicitly_observable`
// + is itself gated behind a `CompressOptionsUnused` option — a larger, separately-gated pass.
import { mayHaveSideEffects } from '../../analysis/effects.ts';
import { N, type Node } from '../../ast.ts';
import * as create from '../../parser/create.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

/** Combine effect-preserving remainders into one expression: none → null, one → itself, many → a
 *  comma SequenceExpression (evaluated left-to-right, preserving order). */
function seqOf(parts: Node[]): Node | null {
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    return create.SequenceExpression(parts[0].start, parts[parts.length - 1].end, 0, parts) as Node;
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
            return create.LogicalExpression(node.start, node.end, d.operator as string, d.left as Node, rs) as Node;
        }
        case N.ArrayExpression: {
            // The literal itself is inert; keep only effectful elements (a spread iterates → keep whole).
            const kept: Node[] = [];
            for (const el of d.elements as (Node | null)[]) {
                if (el === null) continue;
                if (el.type === N.SpreadElement) {
                    kept.push(el);
                    continue;
                }
                const s = stripDiscarded(el);
                if (s !== null) kept.push(s);
            }
            return seqOf(kept);
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
        // Calls/new/objects/conditionals/member reads (impure here) — can't be partially stripped
        // safely; keep the whole thing.
        default:
            return node;
    }
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
function rewriteBody(body: Node[]): boolean {
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
            changed = true; // fully pure → drop the statement
            continue;
        }
        if (stripped !== expr) {
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

function bodyHook(field: 'body' | 'consequent'): (n: Node, ctx: TransformCtx) => void {
    return (n, ctx) => {
        if (rewriteBody((n.data as Record<string, Node[]>)[field])) ctx.changed = true;
    };
}

export const removeUnusedExpr: Visitor = {
    name: 'removeUnusedExpr',
    enter: hookTable({
        [N.Program]: bodyHook('body'),
        [N.BlockStatement]: bodyHook('body'),
        [N.StaticBlock]: bodyHook('body'),
        [N.SwitchCase]: bodyHook('consequent'),
    }),
    exit: null,
};
