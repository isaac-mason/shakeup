// GEN/KILL — what a statement or expression READS and what it OVERWRITES.
//
// This is the ANALYSIS SEMANTICS, shared by both liveness drivers: the structural walker
// (`liveness.ts`) and the CFG + dataflow solver (`live-vars.ts`). It is deliberately separate from
// either, because the two things are separable and conflating them has already cost us:
//
//   • WHAT a kill is → this file. Portable; survives a change of driver.
//   • HOW control flows between statements → the driver. Not portable.
//
// They used to be duplicated, one copy per driver, and the copies DISAGREED — `liveness.ts` treated a
// bare `var h;` as a kill while the Closure-aligned version killed only an INITIALISED declarator. That
// divergence was a real miscompile (dead-store deleted a live store before a hoisted `var`; see
// `tst/dead-store-declarations.test.ts`). One copy makes that class of bug impossible, and it sharpens
// `tst/cfg-equivalence.test.ts` into a real oracle: with identical semantics, any remaining difference
// between the two drivers is PROVABLY a control-flow difference.
//
// Ported from Closure's `LiveVariablesAnalysis.computeGenKill`
// (llm/closure/src/com/google/javascript/jscomp/LiveVariablesAnalysis.java:252).
import { N, type Node, walkChildren } from '../ast.ts';

/**
 * Accumulate the symbols `n` READS (`gen`) and definitely OVERWRITES (`kill`).
 *
 * NODE-ROLE AWARENESS is essential and is what a naive "walk the whole subtree" version gets wrong: an
 * `if` or a loop contributes ONLY its condition, because its branches are reached by control flow, not
 * by being nested — every driver visits them separately. A block contributes nothing at all.
 *
 * `conditional` means the assignments encountered MIGHT NOT happen, so they gen but do not kill. A
 * driver sets it when the node can terminate part-way (an exception edge out); it is also turned on
 * when descending into a short-circuit right operand or a conditional arm.
 */
export function genKill(
    n: Node | null,
    tracked: ReadonlySet<number>,
    conditional: boolean,
    gen: (s: number) => void,
    kill: (s: number) => void,
): void {
    if (n === null) return;
    switch (n.type) {
        // Containers contribute nothing — their contents are separate CFG nodes.
        case N.Program:
        case N.BlockStatement:
        case N.StaticBlock:
        case N.FunctionDeclaration:
        case N.FunctionExpression:
        case N.ArrowFunctionExpression:
            return;
        // A loop/if CFG node IS its condition.
        case N.IfStatement:
        case N.WhileStatement:
            genKill((n.data as { test: Node }).test, tracked, conditional, gen, kill);
            return;
        case N.DoWhileStatement:
            genKill((n.data as { test: Node }).test, tracked, conditional, gen, kill);
            return;
        case N.ForStatement:
            genKill((n.data as { test: Node | null }).test, tracked, conditional, gen, kill);
            return;
        case N.SwitchStatement:
            genKill((n.data as { discriminant: Node }).discriminant, tracked, conditional, gen, kill);
            return;
        case N.SwitchCase:
            genKill((n.data as { test: Node | null }).test, tracked, conditional, gen, kill);
            return;
        case N.ForInStatement:
        case N.ForOfStatement: {
            // Closure: the LHS "may never be assigned to or evaluated, like in `for (x in []) {}`, so
            // should not be killed"; and the RHS "is executed only once so we don't go into it every
            // loop" (it has its own CFG node).
            let lhs = (n.data as { left: Node }).left;
            if (lhs.type === N.VariableDeclaration) {
                const decls = (lhs.data as { declarations: Node[] }).declarations;
                if (decls.length > 0) lhs = (decls[decls.length - 1].data as { id: Node }).id;
            }
            genKill(lhs, tracked, conditional, gen, kill);
            return;
        }
        case N.VariableDeclaration: {
            for (const d of (n.data as { declarations: Node[] }).declarations) {
                const dd = d.data as { id: Node; init: Node | null };
                if (dd.id.type === N.BindingIdentifier) {
                    if (dd.init !== null) {
                        genKill(dd.init, tracked, conditional, gen, kill);
                        if (!conditional) {
                            const s = (dd.id as { sym: number }).sym;
                            if (tracked.has(s)) kill(s);
                        }
                    }
                } else {
                    // Destructuring: every bound name is killed, and the init is read.
                    if (!conditional) lhsNames(dd.id, tracked, kill);
                    genKill(dd.init, tracked, conditional, gen, kill);
                }
            }
            return;
        }
        case N.LogicalExpression: {
            const d = n.data as { left: Node; right: Node };
            genKill(d.left, tracked, conditional, gen, kill);
            genKill(d.right, tracked, true, gen, kill); // may short circuit
            return;
        }
        case N.ConditionalExpression: {
            const d = n.data as { test: Node; consequent: Node; alternate: Node };
            genKill(d.test, tracked, conditional, gen, kill);
            genKill(d.consequent, tracked, true, gen, kill);
            genKill(d.alternate, tracked, true, gen, kill);
            return;
        }
        case N.IdentifierReference: {
            const s = (n as { sym: number }).sym;
            if (tracked.has(s)) gen(s);
            return;
        }
        case N.BindingIdentifier:
            return; // a declaration site is neither a read nor, by itself, a kill
        case N.AssignmentExpression: {
            const d = n.data as { operator: string; left: Node; right: Node };
            if (d.left.type === N.IdentifierReference) {
                const s = (d.left as { sym: number }).sym;
                if (tracked.has(s)) {
                    if (!conditional) kill(s);
                    if (d.operator !== '=') gen(s); // `a += 1` READS a first
                }
                genKill(d.right, tracked, conditional, gen, kill);
                return;
            }
            if (d.left.type === N.ArrayPattern || d.left.type === N.ObjectPattern) {
                if (!conditional) lhsNames(d.left, tracked, kill);
                genKill(d.right, tracked, conditional, gen, kill);
                return;
            }
            break; // member target etc. — fall through to the generic walk
        }
        case N.UpdateExpression: {
            const arg = (n.data as { argument: Node }).argument;
            if (arg.type === N.IdentifierReference) {
                const s = (arg as { sym: number }).sym;
                if (tracked.has(s)) {
                    gen(s); // `a++` reads then writes
                    if (!conditional) kill(s);
                }
                return;
            }
            break;
        }
        default:
            break;
    }
    walkChildren(n, (c) => {
        genKill(c, tracked, conditional, gen, kill);
    });
}

/** Every tracked name bound by a destructuring pattern. */
function lhsNames(pattern: Node, tracked: ReadonlySet<number>, kill: (s: number) => void): void {
    if (pattern.type === N.BindingIdentifier || pattern.type === N.IdentifierReference) {
        const s = (pattern as { sym: number }).sym;
        if (tracked.has(s)) kill(s);
        return;
    }
    walkChildren(pattern, (c) => {
        lhsNames(c, tracked, kill);
    });
}
