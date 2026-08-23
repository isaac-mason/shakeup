// B-exit — minimize-exit-points (Closure `MinimizeExitPoints`, compilecat `minimize_exit_points.rs`,
// oxc's `minimize_statements` guard folding): turn an early-return GUARD into a negated conditional
// wrapping the rest of the function body.
//
//   function f() { …; if (c) return; A; B; }   →   function f() { …; if (!c) { A; B; } }
//
// which the existing pipeline then finishes for free:
//   sequences (`join-vars`)  `{ A; B; }` → `{ A, B; }`
//   normalize                `if (!c) { A, B; }` → `if (!c) A, B;`
//   minimize-conditions      `if (!c) A, B;` → `c || (A, B);`
// giving exactly what oxc emits (`message in _cache || (_cache[message] = !0, warn(...params))`).
//
// WHY IT IS SAFE — and the two conditions that make it so:
//
//  1. The `if` must sit DIRECTLY in the FUNCTION BODY's statement list, and the moved statements must
//     be ALL the statements after it. `return` exits the whole function, so `if (c) return;` skips
//     everything to the end of the body — not merely to the end of the enclosing block. Applying this
//     inside a nested block would be a MISCOMPILE: in `{ if (c) return; A; } B;` the original skips
//     both `A` and `B` when `c` is truthy, but `{ if (!c) { A; } } B;` still runs `B`.
//
//  2. Every moved statement must be an `ExpressionStatement`. That keeps the rewrite free of the
//     hoisting hazards a general version would have to reason about: moving a `function`/`class`/
//     `let`/`const` declaration into a block changes its hoisting or scoping, and a hoisted function
//     could be called by code ABOVE the guard (`g(); if (c) return; function g() {}`), which the
//     rewrite would break. Restricting to expression statements sidesteps all of it, and is exactly
//     the guard-clause shape this pattern appears in.
//
// The consequent must be a BARE `return;` — a `return <value>` is not equivalent (the function would
// yield that value rather than `undefined`), and a `return undefined` spelling is left alone because
// `substituteAlternateSyntax` only normalises those in the FINAL pass, after this one has run.
import { N, type Node } from '../../ast.ts';
import * as create from '../../parser/create.ts';
import { OP, UnaryExpression } from '../../parser/create.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

/** The single statement a clause holds, unwrapping a one-statement block (`{ return; }` → `return;`). */
function soleStatement(clause: Node): Node | null {
    if (clause.type !== N.BlockStatement) return clause;
    const body = (clause.data as { body: Node[] }).body;
    return body.length === 1 ? body[0] : null;
}

/** `if (c) return;` with no `else` — the guard shape this pass consumes. */
function guardTest(stmt: Node): Node | null {
    if (stmt.type !== N.IfStatement) return null;
    const d = stmt.data as { test: Node; consequent: Node; alternate: Node | null };
    if (d.alternate !== null) return null;
    const only = soleStatement(d.consequent);
    if (only === null || only.type !== N.ReturnStatement) return null;
    return (only.data as { argument: Node | null }).argument === null ? d.test : null;
}

/** Rewrite the FIRST guard in a function body whose remainder is all expression statements. */
function foldGuard(body: Node[]): boolean {
    for (let i = 0; i < body.length - 1; i++) {
        const test = guardTest(body[i]);
        if (test === null) continue;
        const rest = body.slice(i + 1);
        if (!rest.every((s) => s.type === N.ExpressionStatement)) continue;
        const block = create.BlockStatement(rest[0].start, rest[rest.length - 1].end, 0, rest);
        const negated = UnaryExpression(test.start, test.end, OP.NOT, test);
        const rewritten = create.IfStatement(body[i].start, block.end, 0, negated, block, null);
        body.length = i;
        body.push(rewritten);
        return true;
    }
    return false;
}

const fnHook = (n: Node, ctx: TransformCtx): void => {
    const body = (n.data as { body: Node | null }).body;
    if (body === null || body.type !== N.BlockStatement) return;
    if (foldGuard((body.data as { body: Node[] }).body)) ctx.changed = true;
};

export const minimizeExitPoints: Visitor = {
    name: 'minimizeExitPoints',
    enter: hookTable({
        [N.FunctionDeclaration]: fnHook,
        [N.FunctionExpression]: fnHook,
        [N.ArrowFunctionExpression]: fnHook,
    }),
    exit: null,
};
