import { N, type Node, walkChildren } from '../ast/index.ts';
import type { Semantic } from './semantic.ts';

/** True if the module contains a direct `eval(...)` call — it can resolve a name dynamically, so
 *  removing a binding (even a single-use local) is unsafe. Coarse module-wide check (oxc uses a
 *  per-scope `contains_direct_eval` flag; module-wide is a safe over-approximation). `with` can't
 *  occur — bundled input is ESM, i.e. always strict mode. */
export function hasDirectEval(program: Node, semantic: Semantic): boolean {
    // FAST REJECT, and an exact one. The call below only matches a callee with `sym === 0`, i.e. an
    // UNRESOLVED value reference — and `analyze` files every one of those in `semantic.unresolved`.
    // So if nothing unresolved is named `eval`, no call site can match and the whole-program walk is
    // skipped entirely. This runs at every Program enter, once per compress round per module, and it
    // was walking every node of the program to answer a question that is almost always "no": 2.89% of
    // a bundling profile. Not an over-approximation — when an `eval` reference IS present, the exact
    // walk below still runs to confirm it is actually a callee.
    let mentionsEval = false;
    for (const u of semantic.unresolved) {
        if (u.name === 'eval') {
            mentionsEval = true;
            break;
        }
    }
    if (!mentionsEval) return false;

    let found = false;
    const visit = (n: Node): void => {
        if (found) return;
        if (n.type === N.CallExpression) {
            const callee = (n.data as { callee: Node }).callee;
            if (callee.type === N.IdentifierReference && callee.name === 'eval' && callee.sym === 0) {
                found = true;
                return;
            }
        }
        walkChildren(n, visit);
    };
    visit(program);
    return found;
}
