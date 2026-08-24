// P4 — drop-unused (terser `unused`): remove a `let`/`const` binding that is NEVER referenced, when
// the binding lives in a FUNCTION or BLOCK scope. Top-level/exported bindings are OWNED by treeshake
// (`src/treeshake.ts`), so this pass deliberately does NOT touch module-scope bindings — it only
// reaches the function/block locals treeshake can't see.
//
// THIS IS THE HIGHEST-RISK COMPRESS PASS: a wrongly-removed binding is a miscompile (a stray
// ReferenceError, or a dropped side effect). Every decision below defaults to BAIL. The removals we
// make are, by construction, in the SAFE direction only:
//   - We count USES from a snapshot taken at Program-enter of this traversal. Sibling passes in the
//     same fused traverse (deadCode/foldConstants) only ever DELETE code, never add references, so
//     our snapshot is an UPPER BOUND on real uses. Over-counting → we keep a binding we could have
//     dropped (safe); we can never under-count into a wrong removal. The fixed-point loop
//     (`compress/index.ts`) rebuilds the semantic each round, so a binding that becomes unused after
//     this round is caught on the next.
//
// WHAT WE REMOVE (all must hold):
//   - a `let`/`const` VariableDeclarator whose `id` is a PLAIN BindingIdentifier (no destructuring),
//   - whose symbol has ZERO `IdentifierReference` uses anywhere in the module (the declaration's own
//     BindingIdentifier is NOT an IdentifierReference, so it isn't counted; a self-reference in the
//     init — `const x = x` — IS an IdentifierReference, so it counts as a use → we bail/keep),
//   - whose symbol's owning scope is NOT the module scope (treeshake owns those),
//   - and which is not exported (module-scope exclusion already covers this, but see below).
//   - PURE init  → drop the whole declarator.
//   - IMPURE init → the binding is dead but its side effect must still run: keep the init as an
//     ExpressionStatement. We only do this for a SINGLE-declarator declaration (the clean case);
//     an impure-unused declarator mixed among other declarators BAILS the whole declaration.
//
// HARD BAILS (do nothing): `var` (hoisting/redeclaration), destructuring patterns (getter/iterator
// side effects), any module-scope or exported binding, any binding with ≥1 use, function/class
// declarations (hoisting subtlety — v1 handles only `let`/`const` declarators).
import { isPureExpr } from '../../analysis/effects.ts';
import { SCOPE, type Semantic } from '../../analysis/semantic.ts';
import { N, type Node } from '../../ast.ts';
import * as create from '../../parser/create.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

// Use-count snapshot for the current traversal, keyed by SymbolId. Set on Program-enter (fires once,
// before we descend into any declaration), read by the VariableDeclaration hook. The paired
// `semantic` is captured alongside so scope lookups use the exact table the counts were built from.
let USES: Map<number, number> | null = null;
let SEM: Semantic | null = null;

/** Tally, per SymbolId, how many `IdentifierReference` nodes resolve to it across the whole module.
 *  Declarations are `BindingIdentifier` nodes (a distinct type) and are intentionally excluded, so a
 *  binding with no *reference* uses lands at 0 here even though its declaration ident exists.
 *
 *  MEASURED, do not "optimize" this away: `analyze` can supply the same tally for free, but its
 *  snapshot is stale by any pass that ran EARLIER in the same traversal (several remove references
 *  before this pass sees them). Using it over-counts, which is safe but keeps bindings — worth
 *  +2,782 bytes on three.core.js in `dce` mode, for no measurable time saving. Freshness here is
 *  worth more than the walk costs. */

/** True when SymbolId `sym` is bound in the MODULE scope (treeshake's territory — we must not touch
 *  it). Also treats an out-of-range/zero symbol as "module" so we conservatively bail. */
function inModuleScope(sem: Semantic, sym: number): boolean {
    const rec = sem.symbols[sym];
    if (rec === undefined) return true;
    const scope = sem.scopes[rec.scope];
    if (scope === undefined) return true;
    return scope.flags === SCOPE.MODULE;
}

/** Per-declarator verdict. */
const KEEP = 0; // referenced, or a bail case (var/destructuring/module-scope/self-ref) — leave as-is
const DROP_PURE = 1; // dead binding, pure init — delete the declarator outright
const DROP_IMPURE = 2; // dead binding, impure init — the init's side effect must be preserved

/** Classify a single declarator of a `let`/`const` declaration. */
function classify(decl: Node, sem: Semantic, uses: Map<number, number>): number {
    if (decl.type !== N.VariableDeclarator) return KEEP;
    const id = decl.data.id;
    // Only PLAIN identifier bindings — destructuring patterns may run getter/iterator side effects,
    // so we never remove them (a pattern element's absence could change observable behavior).
    if (id.type !== N.BindingIdentifier) return KEEP;
    const sym = id.sym;
    if (sym === 0) return KEEP; // no resolved symbol — bail
    if (inModuleScope(sem, sym)) return KEEP; // treeshake owns module-scope bindings
    if ((uses.get(sym) ?? 0) !== 0) return KEEP; // ≥1 reference (incl. a self-ref in its own init)
    // Dead binding in a function/block scope. Pure init → drop; impure init → keep the effect.
    return isPureExpr(decl.data.init) ? DROP_PURE : DROP_IMPURE;
}

/** VariableDeclaration hook: only `let`/`const`; compute per-declarator verdicts and rewrite the
 *  statement conservatively. */
function onVariableDeclaration(n: Node, ctx: TransformCtx): void {
    if (n.type !== N.VariableDeclaration) return;
    if (n.data.kind === 'var') return; // HARD BAIL: `var` hoists / can redeclare
    const sem = SEM;
    const uses = USES;
    if (sem === null || uses === null) return; // snapshot not built (shouldn't happen) — bail

    const decls = n.data.declarations;
    const verdicts = new Array<number>(decls.length);
    let anyDrop = false;
    let impureCount = 0;
    for (let i = 0; i < decls.length; i++) {
        const v = classify(decls[i], sem, uses);
        verdicts[i] = v;
        if (v !== KEEP) anyDrop = true;
        if (v === DROP_IMPURE) impureCount++;
    }
    if (!anyDrop) return; // nothing to do

    // SINGLE-DECLARATOR impure-unused: replace the whole declaration with an ExpressionStatement of
    // the init, preserving its side effect while dropping the (dead) binding.
    if (decls.length === 1 && verdicts[0] === DROP_IMPURE) {
        const only = decls[0];
        const init = only.type === N.VariableDeclarator ? only.data.init : null;
        if (init === null) return; // no init to preserve (defensive; DROP_IMPURE implies a non-pure init)
        ctx.replaceWith(create.ExpressionStatement(n.start, n.end, 0, init));
        return;
    }

    // Any impure drop mixed among MULTIPLE declarators is fiddly to order-preserve — BAIL the whole
    // declaration (always correct). We only auto-drop PURE-unused declarators below.
    if (impureCount > 0) return;

    // Drop every DROP_PURE declarator (pure inits are effect-free, so removal is order-independent).
    const kept: Node[] = [];
    for (let i = 0; i < decls.length; i++) if (verdicts[i] !== DROP_PURE) kept.push(decls[i]);

    if (kept.length === 0) {
        ctx.remove(); // the declaration is now empty → drop the whole statement
        return;
    }
    // Rewrite in place with the surviving declarators.
    n.data.declarations = kept;
    ctx.changed = true;
}

export const dropUnused: Visitor = {
    name: 'dropUnused',
    enter: hookTable({
        // Program-enter fires once, before descending — snapshot the module's use counts here so the
        // VariableDeclaration hook (fired during descent) reads a consistent, current tally.
        [N.Program]: (_n, ctx) => {
            SEM = ctx.semantic;
            USES = ctx.semantic.uses;
        },
        [N.VariableDeclaration]: onVariableDeclaration,
    }),
    exit: null,
};
