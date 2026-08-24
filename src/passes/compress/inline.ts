// Single-use movement inline (oxc `substitute_single_use_symbol_in_statement`,
// minimize_statements.rs:1300+). When a `const`/`let` binding is declared and then used EXACTLY once
// in the immediately-following statement, move its initializer into that single use and drop the
// declaration: `const x = a.b; return f(x)` → `return f(a.b)`. The first NON-LOCAL compress
// transform — it moves code across a statement boundary — and the first client of the reusable
// movement kernel (`substituteSingleUse`, analysis/movement.ts) that CSE / dead-store will also use.
//
// SAFETY. The kernel walks the use expression in evaluation order and refuses to cross interference
// or push an impure init into a conditional branch; anything it can't prove safe is a barrier (no
// inline). Hard bails: `var` (hoisting), multi-declarator decls, exported/observable bindings (a bare
// `const` in a body is never an export), any binding with ≠1 read or any write, and — module-wide —
// the presence of `eval`/`with` (dynamic name resolution could observe the removed binding).
//
// GAP (compilecat `inline_variables` path 1, `single_use_safe`): the use need NOT be the immediately
// following statement. When it is further down the same statement list, the init must cross the
// intervening statements, which needs two things beyond the adjacent case:
//   1. the init is FREELY MOVABLE — no side effects AND reads only immutable symbols (`movement.ts`'s
//      own term), so its value and effects are position-independent;
//   2. nothing in the gap ASSIGNS a symbol the init reads.
// (2) is not implied by (1), and this is the trap: `tallyRefs` treats a BindingIdentifier as "neither
// a read nor a value-write", so a declarator's own initialization is invisible to the write tally and
// `var p = 5` reports ZERO writes — `readsMutableSymbol` would call `p` immutable. Without the gap
// check, `const v = p + 1; var p = 5; use(v)` would move `p + 1` PAST the assignment and read 5 where
// the original read `undefined`. So the gap is scanned for assignments, updates AND declarator inits.
// Same root cause as the guard in `alias-inline.ts`; both are noted there.
//
// Only SIBLING statements are considered. A read nested inside a block, loop body or closure lands in
// a statement shape `substituteInUse` does not accept, so it is refused structurally — which is also
// why no scope-hygiene check is needed: the kernel's `default: 'barrier'` never descends into a
// construct that could introduce a shadowing binding.
// TDZ is never a concern: the init only ever moves LATER.
import { mayHaveSideEffects } from '../../analysis/effects.ts';
import { type RefCounts, readsMutableSymbol, substituteSingleUse } from '../../analysis/movement.ts';
import { getPrelude } from './prelude.ts';
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

/** Whether `n`'s subtree reads `sym` — used to locate the statement holding the binding's sole read. */
function readsSym(n: Node, sym: number): boolean {
    if (n.type === N.IdentifierReference) return (n as { sym: number }).sym === sym;
    let found = false;
    walkChildren(n, (c) => {
        if (!found && readsSym(c, sym)) found = true;
    });
    return found;
}

/** Symbols `init` reads. Empty ⇒ nothing in a gap can disturb it. */
function readSyms(init: Node): Set<number> {
    const out = new Set<number>();
    const visit = (n: Node): void => {
        if (n.type === N.IdentifierReference) {
            out.add((n as { sym: number }).sym);
            return;
        }
        walkChildren(n, visit);
    };
    visit(init);
    return out;
}

/** Whether `stmt` gives a new value to any symbol in `syms`. Covers assignment targets, `++`/`--`
 *  AND declarator initializations — the last because a declarator's init is NOT a write in the ref
 *  tally, which is exactly the `var p = 5` hole described at the top of this file. */
function assignsAny(stmt: Node, syms: Set<number>): boolean {
    let hit = false;
    const targets = (n: Node): void => {
        if (hit) return;
        if (n.type === N.IdentifierReference || n.type === N.BindingIdentifier) {
            if (syms.has((n as { sym: number }).sym)) hit = true;
            return;
        }
        walkChildren(n, targets);
    };
    const visit = (n: Node): void => {
        if (hit) return;
        switch (n.type) {
            case N.AssignmentExpression:
                targets((n.data as { left: Node }).left);
                break;
            case N.UpdateExpression:
                targets((n.data as { argument: Node }).argument);
                break;
            case N.VariableDeclarator:
                if ((n.data as { init: Node | null }).init !== null) targets((n.data as { id: Node }).id);
                break;
            default:
                break;
        }
        walkChildren(n, visit);
    };
    visit(stmt);
    return hit;
}

/** Process one statement list: for each inlinable single-use binding, move its init into the sibling
 *  statement holding the sole read and drop the decl. The use may be any later sibling, not just the
 *  next one — see the GAP note at the top of this file for what crossing statements requires. */
function inlineBody(body: Node[], refs: Map<number, RefCounts>): boolean {
    let changed = false;
    for (let i = 0; i < body.length - 1; i++) {
        const cand = candidate(body[i], refs);
        if (cand === null) continue;

        // Locate the sole read. The binding has exactly one (checked in `candidate`), so the first
        // sibling that mentions it is the use statement.
        let use = -1;
        for (let k = i + 1; k < body.length; k++) {
            if (readsSym(body[k], cand.sym)) {
                use = k;
                break;
            }
        }
        if (use < 0) continue;

        if (use > i + 1) {
            // Crossing statements: the init must be position-independent, and nothing in the gap may
            // reassign what it reads.
            if (cand.impure || cand.fragile) continue;
            const reads = readSyms(cand.init);
            let disturbed = false;
            for (let k = i + 1; k < use && !disturbed; k++) if (assignsAny(body[k], reads)) disturbed = true;
            if (disturbed) continue;
        }

        if (substituteInUse(body[use], cand.sym, cand.init, cand.impure, cand.fragile, refs)) {
            body.splice(i, 1); // drop the now-dead declaration (its init moved into the use)
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
            REFS = DYNAMIC_SCOPE ? null : getPrelude(program).refs;
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
