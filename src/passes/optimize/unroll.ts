// unroll — directive-driven loop unrolling. Port of compilecat `passes/unroll.rs`
// (`src/compiler/loop-unroller.ts`).
//
// Replaces an opt-in loop with a flat sequence of its body, one copy per iteration, the loop variable
// substituted by its concrete value.
//
//   /* @unroll */ for (let i = 0; i < 3; i++) acc += v[i];
//     →  { acc += v[0]; } { acc += v[1]; } { acc += v[2]; }
//
// EXPLICITLY OPT-IN, and deliberately NOT implied by `@optimize`: unrolling trades size for loop
// overhead the JIT usually handles anyway, so folding it into the general gate unrolls loops nobody
// asked for. The author marks the specific hot loops worth it — and even then the budget below caps
// the expansion.
//
// SUPPORTED SHAPE: `for (let i = <num>; i <|<= <num>; i++ | i += <num>) { … }`, where each operand may
// also be a module-level numeric `const`. Anything else soft-fails and leaves the loop intact.
//
// WHY THE SUBSTITUTION IS SAFE: with `let`, each iteration already gets its OWN binding of `i`, so a
// closure created in the body captures that iteration's value — exactly what substituting the literal
// produces. Each iteration is wrapped in its own block so body-level `let`/`const` declarations don't
// collide across copies.
import { cloneNode, N, type Node, node, statementListOf, walk } from '../../ast.ts';
import { attachScopeNode, cloneScopeTree, createScope, SCOPE } from '../../analysis/semantic.ts';
import type { Semantic } from '../../analysis/semantic.ts';
import * as create from '../../parser/create.ts';
import { applyRefDelta, hookTable, type RefDelta, type TransformCtx, traverse, type Visitor } from '../traverse.ts';
import { DIRECTIVE, directiveSpans } from './directives.ts';

/** Hard ceiling on iterations regardless of body size. */
const MAX_TRIP = 64;
/** Ceiling on `trip × bodySize`, so a large body unrolls fewer times than a tiny one. */
const MAX_PRODUCT = 96;

type LoopShape = { varSym: number; start: number; bound: number; inclusive: boolean; step: number };

/** Module-level `const X = <number>` bindings, so bounds can be written as named constants. */
function numericConsts(program: Node): Map<string, number> {
    const out = new Map<string, number>();
    walk(program, (n) => {
        if (n.type !== N.VariableDeclaration) return undefined;
        const vd = n.data as { kind: string; declarations: Node[] };
        if (vd.kind !== 'const') return undefined;
        for (const d of vd.declarations) {
            const dd = d.data as { id: Node; init: Node | null };
            if (dd.id.type !== N.BindingIdentifier || dd.init === null) continue;
            if (dd.init.type === N.NumericLiteral) out.set(dd.id.name, Number(dd.init.name));
        }
        return undefined;
    });
    return out;
}

/** A numeric literal, or a named numeric constant. */
function readOperand(expr: Node | null, consts: ReadonlyMap<string, number>): number | null {
    if (expr === null) return null;
    if (expr.type === N.NumericLiteral) return Number(expr.name);
    if (expr.type === N.IdentifierReference) return consts.get(expr.name) ?? null;
    return null;
}

/** Parse the supported `for` shape, or `null`. */
function parseShape(loop: Node, consts: ReadonlyMap<string, number>): LoopShape | null {
    const d = loop.data as { init: Node | null; test: Node | null; update: Node | null; body: Node };
    if (d.init === null || d.init.type !== N.VariableDeclaration) return null;
    const vd = d.init.data as { kind: string; declarations: Node[] };
    if (vd.declarations.length !== 1) return null;
    const decl = vd.declarations[0].data as { id: Node; init: Node | null };
    if (decl.id.type !== N.BindingIdentifier) return null;
    const varSym = (decl.id as { sym: number }).sym;
    if (varSym <= 0) return null;
    const start = readOperand(decl.init, consts);
    if (start === null) return null;

    if (d.test === null || d.test.type !== N.BinaryExpression) return null;
    const t = d.test.data as { operator: string; left: Node; right: Node };
    if (t.left.type !== N.IdentifierReference || (t.left as { sym: number }).sym !== varSym) return null;
    const bound = readOperand(t.right, consts);
    if (bound === null) return null;
    const inclusive = t.operator === '<=';
    if (!inclusive && t.operator !== '<') return null;

    if (d.update === null) return null;
    let step: number | null = null;
    if (d.update.type === N.UpdateExpression) {
        const u = d.update.data as { operator: string; argument: Node };
        if (u.operator !== '++') return null;
        if (u.argument.type !== N.IdentifierReference || (u.argument as { sym: number }).sym !== varSym) return null;
        step = 1;
    } else if (d.update.type === N.AssignmentExpression) {
        const a = d.update.data as { operator: string; left: Node; right: Node };
        if (a.operator !== '+=') return null;
        if (a.left.type !== N.IdentifierReference || (a.left as { sym: number }).sym !== varSym) return null;
        step = readOperand(a.right, consts);
    }
    if (step === null || step <= 0 || !Number.isInteger(step)) return null;
    if (!Number.isInteger(start) || !Number.isInteger(bound)) return null;
    return { varSym, start, bound, inclusive, step };
}

/** The concrete values the loop variable takes, or `null` if that exceeds the trip ceiling. */
function tripValues(s: LoopShape): number[] | null {
    const out: number[] = [];
    for (let v = s.start; s.inclusive ? v <= s.bound : v < s.bound; v += s.step) {
        if (out.length > MAX_TRIP) return null;
        out.push(v);
    }
    return out;
}

const isFn = (n: Node): boolean =>
    n.type === N.FunctionDeclaration || n.type === N.FunctionExpression || n.type === N.ArrowFunctionExpression;

/** `break`/`continue` in the body targets THIS loop, which will not exist after unrolling. Any
 *  occurrence is refused — including one inside a nested loop, which is conservative but never wrong. */
function hasLoopControlFlow(body: Node): boolean {
    let bad = false;
    walk(body, (n) => {
        if (bad) return false;
        if (isFn(n)) return false; // a nested function cannot break out to this loop
        if (n.type === N.BreakStatement || n.type === N.ContinueStatement) bad = true;
        return undefined;
    });
    return bad;
}

/** Whether the body WRITES the loop variable — substituting a literal would then be wrong. */
function writesVar(body: Node, varSym: number): boolean {
    let bad = false;
    const targets = (t: Node): boolean =>
        (t.type === N.IdentifierReference || t.type === N.BindingIdentifier) && (t as { sym: number }).sym === varSym;
    walk(body, (n) => {
        if (bad) return false;
        if (n.type === N.AssignmentExpression && targets((n.data as { left: Node }).left)) bad = true;
        else if (n.type === N.UpdateExpression && targets((n.data as { argument: Node }).argument)) bad = true;
        return undefined;
    });
    return bad;
}

/** Rough AST size of the body — a nested loop counts its whole subtree, so nested outers get big. */
function bodySize(body: Node): number {
    let n = 0;
    walk(body, () => {
        n++;
        return undefined;
    });
    return n;
}

/** One unrolled iteration: the body with the loop variable replaced by `value`, wrapped in a block so
 *  its declarations stay per-iteration. */
function iteration(body: Node, varSym: number, value: number, sem: Semantic, scope: number): Node {
    const substituted = cloneNode(body, (n) =>
        n.type === N.IdentifierReference && (n as { sym: number }).sym === varSym
            ? node(N.NumericLiteral, n.start, n.end, String(value), null)
            : null,
    ) as Node;
    const wrapped =
        substituted.type === N.BlockStatement ? substituted : create.BlockStatement(0, 0, 0, [substituted]);
    // Each iteration is a SEPARATE copy of the body, so it needs FRESH scopes — not the original's,
    // which N copies cannot share. `cloneNode` cleared them; mirror the structure under `scope`.
    // The wrapper block owns a scope of its own so per-iteration declarations stay per-iteration,
    // which is the whole reason it is wrapped.
    if (wrapped !== substituted) attachScopeNode(sem, createScope(sem, scope, SCOPE.BLOCK), wrapped);
    const inner = (wrapped.data as { scopeId?: number } | null)?.scopeId ?? scope;
    cloneScopeTree(sem, body, substituted, wrapped === substituted ? scope : inner);
    return wrapped;
}

/** Unroll `@unroll`-annotated loops. Returns whether anything changed. */
export function unrollLoops(program: Node, semantic: Semantic, source: string): boolean {
    const spans = directiveSpans(source, program, DIRECTIVE.UNROLL);
    if (spans.size === 0) return false;
    const consts = numericConsts(program);

    /** Expand one loop into its iterations, or `null` to leave it alone. */
    const expand = (loop: Node, scope: number): Node[] | null => {
        if (loop.type !== N.ForStatement || !spans.has(loop.start)) return null;
        const shape = parseShape(loop, consts);
        if (shape === null) return null;
        const body = (loop.data as { body: Node }).body;
        if (hasLoopControlFlow(body) || writesVar(body, shape.varSym)) return null;
        const values = tripValues(shape);
        if (values === null) return null;
        // A zero-trip loop is always allowed: it expands to nothing, removing the loop entirely.
        if (values.length > 0 && (values.length > MAX_TRIP || values.length * bodySize(body) > MAX_PRODUCT)) {
            return null;
        }
        return values.map((v) => iteration(body, shape.varSym, v, semantic, scope));
    };

    const listHook = (n: Node, ctx: TransformCtx): void => {
        const list = statementListOf(n);
        if (list === null) return;
        for (let i = 0; i < list.length; i++) {
            const expanded = expand(list[i], ctx.currentScope);
            if (expanded === null) continue;
            // `ctx.spliceStatements`, not a raw `list.splice`: the loop's references have to leave the
            // maintained counts and the iterations' have to enter them. A raw splice moves neither.
            ctx.spliceStatements(list, i, 1, ...expanded);
            i += expanded.length - 1;
        }
    };

    // Thread a `RefDelta`: without one, `ctx.dropRefs`/`addRefs` are NO-OPS, so references this pass
    // moves never reach the maintained counts. That is the UNDER-count direction — a live symbol looks
    // dead and `dropUnused` deletes a declaration still in use — invisible today only because the
    // optimize tier is followed by a full rebuild.
    const delta = new Map<number, RefDelta>();
    const changed = traverse(program, semantic, [
        {
            name: 'unroll',
            enter: hookTable({
                [N.Program]: listHook,
                [N.BlockStatement]: listHook,
                [N.StaticBlock]: listHook,
                [N.SwitchCase]: listHook,
            }),
            exit: null,
        } satisfies Visitor,
    ], delta);
    applyRefDelta(semantic, delta);
    return changed;
}
