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
import { N, type Node, statementListOf, walkChildren } from '../../ast.ts';
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

/** Process one statement list, driving from the USE and looking BACKWARD at the adjacent declaration.
 *
 * This is esbuild's `substituteSingleUseSymbolInStmt` shape, which oxc ports as
 * `substitute_single_use_symbol_in_statement` (`peephole/minimize_statements.rs`): for the statement
 * being considered, inspect only the IMMEDIATELY PRECEDING declaration (oxc's `stmts.last_mut()`),
 * substitute, drop it, and repeat — chaining backwards through a run of adjacent declarations.
 *
 * It replaces a forward scan that, for every candidate declaration, called `readsSym` on EVERY later
 * sibling until it found the sole read — a full subtree walk per (candidate, sibling) pair, so
 * O(statements x subtree) per body, and worst on the common case where the sole read is NOT in this
 * list at all (it may live in a nested function) and the scan therefore ran to the end for nothing.
 * CPU profiling put this pass at ~12% of the whole compress tier while producing 20 mutations on
 * three.core.js.
 *
 * WHY DROPPING THE GAP IS FREE. The old code also handled a NON-adjacent use (`use > i + 1`), guarded
 * by a purity check plus a disturbance scan (`readSyms`/`assignsAny`) over the crossed statements.
 * Instrumenting both corpora, every single substitution was adjacent — 20/20 on three.core.js and
 * 99/99 on crashcat, 119 with a gap of zero and none with a gap at all. esbuild and oxc do not support
 * a gap either. So the gap machinery cost the quadratic scan and bought nothing measurable, and the
 * helpers that served it are gone with it.
 */
function inlineBody(body: Node[], refs: Map<number, RefCounts>): boolean {
    let changed = false;
    for (let u = 1; u < body.length; u++) {
        // Chain backwards, mirroring oxc's `while let Some(..) = stmts.last_mut()`: once a declaration
        // is folded into `body[u]`, the one before it may now be adjacent to that same use.
        while (u > 0) {
            const cand = candidate(body[u - 1], refs);
            if (cand === null) break;
            if (!readsSym(body[u], cand.sym)) break;
            if (!substituteInUse(body[u], cand.sym, cand.init, cand.impure, cand.fragile, refs)) break;
            body.splice(u - 1, 1); // the decl is dead — its init moved into the use, which shifts down
            u--;
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
        [N.Program]: bodyHook,
        [N.BlockStatement]: bodyHook,
        [N.StaticBlock]: bodyHook,
    }),
};

function bodyHook(n: Node, ctx: TransformCtx): void {
    if (REFS === null) return;
    const list = statementListOf(n);
    if (list !== null && inlineBody(list, REFS)) ctx.changed = true;
}
