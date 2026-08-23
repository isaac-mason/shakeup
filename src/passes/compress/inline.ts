// Single-use movement inline (oxc `substitute_single_use_symbol_in_statement`,
// minimize_statements.rs:1300+). When a `const`/`let` binding is declared and then used EXACTLY once
// in the immediately-following statement, move its initializer into that single use and drop the
// declaration: `const x = a.b; return f(x)` → `return f(a.b)`. The first NON-LOCAL compress
// transform — it moves code across a statement boundary — and the first client of the reusable
// movement kernel (`substituteSingleUse`, analysis/movement.ts) that CSE / dead-store will also use.
//
// SAFETY (conservative v1): only the ADJACENT decl→use case (empty gap, so the init only moves LATER
// within one straight-line statement — clear of TDZ). The kernel walks the use expression in
// evaluation order and refuses to cross interference or push an impure init into a conditional
// branch; anything it can't prove safe is a barrier (no inline). Additional hard bails: `var`
// (hoisting), multi-declarator decls, exported/observable bindings (a bare `const` in a body is
// never an export), any binding with ≠1 read or any write, and — module-wide — the presence of
// `eval`/`with` (dynamic name resolution could observe the removed binding).
import { mayHaveSideEffects } from '../../analysis/effects.ts';
import { type RefCounts, readsMutableSymbol, substituteSingleUse, tallyRefs } from '../../analysis/movement.ts';
import { N, type Node, walkChildren } from '../../ast.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

// Snapshot state for one traversal (set at Program enter; the driver rebuilds the semantic + these
// each fixed-point iteration). REFS is the read/write tally; DYNAMIC_SCOPE bails everything when the
// module uses `eval`/`with`.
let REFS: Map<number, RefCounts> | null = null;
let DYNAMIC_SCOPE = false;

/** True if the module contains a direct `eval(...)` call — it can resolve a name dynamically, so
 *  removing a binding (even a single-use local) is unsafe. Coarse module-wide check (oxc uses a
 *  per-scope `contains_direct_eval` flag; module-wide is a safe over-approximation). `with` can't
 *  occur — bundled input is ESM, i.e. always strict mode. */
function hasDynamicScope(program: Node): boolean {
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

/** If `prev` is an inlinable single-declarator `const`/`let` whose binding is single-read / zero-write,
 *  return its symbol + initializer (+ whether the init is impure); else null. */
function candidate(
    prev: Node,
    refs: Map<number, RefCounts>,
): { sym: number; init: Node; impure: boolean; fragile: boolean } | null {
    if (prev.type !== N.VariableDeclaration) return null;
    const d = prev.data as { kind: string; declarations: Node[] };
    if (d.kind === 'var' || d.declarations.length !== 1) return null; // var hoists; keep v1 single-declarator
    const dcl = d.declarations[0].data as { id: Node; init: Node | null };
    if (dcl.id.type !== N.BindingIdentifier || dcl.init === null) return null;
    const sym = (dcl.id as { sym: number }).sym;
    if (sym === 0) return null;
    const c = refs.get(sym);
    if (c === undefined || c.reads !== 1 || c.writes !== 0) return null; // exactly one read, never reassigned
    return { sym, init: dcl.init, impure: mayHaveSideEffects(dcl.init), fragile: readsMutableSymbol(dcl.init, refs) };
}

/** Try to move `init` into the single use of `sym` inside statement `use`. Only statement shapes whose
 *  evaluated expression is well-defined + adjacent-safe are attempted; for a VariableDeclaration only
 *  the FIRST declarator's init is safe (later declarators run after earlier inits). */
function substituteInUse(
    use: Node,
    sym: number,
    init: Node,
    impure: boolean,
    fragile: boolean,
    refs: Map<number, RefCounts>,
): boolean {
    switch (use.type) {
        case N.ExpressionStatement:
            return substituteSingleUse(use, 'expression', sym, init, impure, fragile, refs) === 'done';
        case N.ReturnStatement:
        case N.ThrowStatement:
            return substituteSingleUse(use, 'argument', sym, init, impure, fragile, refs) === 'done';
        case N.IfStatement:
            return substituteSingleUse(use, 'test', sym, init, impure, fragile, refs) === 'done';
        case N.VariableDeclaration: {
            const first = (use.data as { declarations: Node[] }).declarations[0];
            return first !== undefined && substituteSingleUse(first, 'init', sym, init, impure, fragile, refs) === 'done';
        }
        default:
            return false;
    }
}

/** Process one statement list: for each `decl; use` adjacent pair where `decl` is an inlinable
 *  single-use binding, move the init into the use and drop the decl. */
function inlineBody(body: Node[], refs: Map<number, RefCounts>): boolean {
    let changed = false;
    for (let i = 1; i < body.length; i++) {
        const cand = candidate(body[i - 1], refs);
        if (cand === null) continue;
        if (substituteInUse(body[i], cand.sym, cand.init, cand.impure, cand.fragile, refs)) {
            body.splice(i - 1, 1); // drop the now-dead declaration (its init moved into the use)
            i--; // re-examine from the shifted position
            changed = true;
        }
    }
    return changed;
}

export const inline: Visitor = {
    name: 'inline',
    enter: hookTable({
        [N.Program]: (program) => {
            DYNAMIC_SCOPE = hasDynamicScope(program);
            REFS = DYNAMIC_SCOPE ? null : tallyRefs(program);
        },
    }),
    // Body-level rewrite on EXIT (bottom-up, so inner bodies settle first). Hooks each statement-list
    // container and rewrites its `.body` in place.
    exit: hookTable({
        [N.Program]: (n, ctx: TransformCtx) => bodyHook(n, 'body', ctx),
        [N.BlockStatement]: (n, ctx: TransformCtx) => bodyHook(n, 'body', ctx),
        [N.StaticBlock]: (n, ctx: TransformCtx) => bodyHook(n, 'body', ctx),
    }),
};

function bodyHook(n: Node, field: 'body', ctx: TransformCtx): void {
    if (REFS === null) return;
    if (inlineBody((n.data as Record<'body', Node[]>)[field], REFS)) ctx.changed = true;
}
