// Alias inline — path 3 of compilecat `inline_variables`
// (compilecat rust/crates/compilecat_core/src/passes/inline_variables.rs:319 `try_alias`), itself a
// subset of Closure's `InlineVariables`.
//
// `const b = a; … b … b …` where `a` is a BARE IDENTIFIER resolving to a stable local/param and `b`
// is never reassigned → rewrite every read of `b` to `a`. Unlike VALUE inlining this is loop-safe and
// identity-safe: we are not copying a value, we are renaming a reference to the very same binding, so
// there is no aliasing hazard, no code motion, and no re-evaluation. That is why it needs none of the
// conditional-definition / loop gating that `const-prop` (path 2) and `inline` (path 1) carry.
//
// We do NOT remove the now-dead `const b = a` here — once its reads are gone, drop-unused (function/
// block scope) or tree-shaking (module scope) reclaims it. Same division of labour as `const-prop`:
// this pass is a pure read-substitution with no statement-slot removal hazards. It also makes
// compilecat's guard #5 ("all reads in the same function as the declaration") unnecessary — that guard
// exists only because their applier gates on function boundaries and would otherwise drop a declarator
// whose nested-function reads went unsubstituted. Substituting by symbol has no such split.
//
// STABILITY GUARD — where this deliberately DIVERGES from the compilecat port. compilecat's guard #2
// is "the aliased binding is never reassigned", tested via `get_resolved_references(sym).any(is_write)`.
// That does not translate: shakeup's `tallyRefs` treats a BindingIdentifier as "neither a read nor a
// value-write", so a declarator's own initialization is INVISIBLE to the write tally and `var a = 1`
// reports zero writes. Porting the guard verbatim would miscompile hoisting:
//     const b = a;      // `a` is a hoisted var, still undefined → b === undefined
//     var a = 1;
//     use(b);           // undefined … but `use(a)` would read 1
// So stability is established from the DECLARATION KIND instead: the aliased symbol must be declared
// by a form whose value is fixed at its declaration and cannot be observed before it — const/let/param/
// function/class — and must additionally have zero writes. `var` is excluded for the reason above, and
// IMPORT because an ESM import is a LIVE binding: `export let counter` can be reassigned by the
// exporter, so a captured `const b = counter` is NOT interchangeable with a fresh read of `counter`.
import { lookupValue, SYM } from '../../analysis/semantic.ts';
import { N, node } from '../../ast.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

/** The binding a candidate alias stands for: its symbol id, and the name to print at each read. */
type Alias = { sym: number; name: string };

/** Map from alias SymbolId to the binding it aliases. Set at Program enter, read by the
 *  IdentifierReference hook. Module-level (single-threaded traverse, like const-prop's). */
let ALIAS: Map<number, Alias> | null = null;

/** Declaration kinds whose value is established AT the declaration and cannot be read before it.
 *  See the STABILITY GUARD note above for why this replaces compilecat's write-tally test. */
const STABLE = SYM.CONST | SYM.LET | SYM.PARAM | SYM.FUNCTION | SYM.CLASS;

/** Kinds that are never safe to alias regardless of any other flag they carry: `var` (hoisted, and
 *  its initialization is invisible to the write tally) and `import` (a LIVE ESM binding). A symbol can
 *  hold both — `var f; function f(){}` ORs VAR|FUNCTION — so this is checked separately from STABLE
 *  rather than folded into it. */
const UNSTABLE = SYM.VAR | SYM.IMPORT;

export const aliasInline: Visitor = {
    name: 'aliasInline',
    enter: hookTable({
        [N.Program]: (_program, ctx: TransformCtx) => {
            const sem = ctx.semantic;
            // All three facts are maintained by `analyze` (see `Semantic.refs`) — no pre-pass walk at
            // all, where this pass once ran `tallyRefs` + `walkRefIdents` + its own export scan.
            const { refs, shorthand, exported } = sem;

            const map = new Map<number, Alias>();
            // Candidates come from `Semantic.symbolInit` (oxc's `SymbolValue` model). This was a
            // FULL-PROGRAM walk at every round's Program enter, re-finding declarations the semantic
            // walk had already visited; filtering the table is O(bindings-with-inits) and applies the
            // same policy in the same order.
            for (const [aliasSym, init] of sem.symbolInit) {
                // A destructuring pattern gives every one of its bindings the SAME declarator, whose
                // `init` is the whole RHS — so `symbolInit` only ever files BindingIdentifier
                // declarators, and an alias must additionally have a bare identifier on the right.
                if (init.type !== N.IdentifierReference) continue;
                // `var b = a` is rejected with the same hoisting argument as the aliased side: reads
                // of `b` above its declaration see `undefined`, not `a`. Read off the symbol's flags
                // now that the declaration node is not in hand.
                if ((sem.symbols[aliasSym].flags & SYM.VAR) !== 0) continue;

                const aliasedSym = init.sym;
                // Unresolved on either side (sym 0) → cannot prove stability or scope. Self-alias
                // (`const x = x` after other rewrites) → nothing to gain, and it would substitute
                // forever.
                if (aliasSym === 0 || aliasedSym === 0 || aliasSym === aliasedSym) continue;
                if (exported.has(aliasSym) || shorthand.has(aliasSym)) continue;

                const a = refs.get(aliasSym);
                if (a === undefined || a.writes > 0 || a.reads === 0) continue;
                const target = refs.get(aliasedSym);
                if (target !== undefined && target.writes > 0) continue;

                const rec = sem.symbols[aliasedSym];
                if (rec === undefined) continue;
                if ((rec.flags & STABLE) === 0 || (rec.flags & UNSTABLE) !== 0) continue;

                map.set(aliasSym, { sym: aliasedSym, name: init.name });
            }
            ALIAS = map.size > 0 ? map : null;
        },
        [N.IdentifierReference]: (n, ctx: TransformCtx) => {
            if (ALIAS === null) return;
            const hit = ALIAS.get(n.sym);
            if (hit === undefined) return;
            // Shadow check AT THE SITE (compilecat guard #4): the aliased NAME must still resolve to
            // the aliased SYMBOL from this reference's own scope, or the substitution would silently
            // re-bind. Decided per-site rather than all-or-nothing as compilecat does it — a shadowed
            // read simply keeps naming the alias, drop-unused then keeps the declarator, and the
            // unshadowed reads are still substituted. Strictly more capable, equally sound.
            if (lookupValue(ctx.semantic, ctx.currentScope, hit.name) !== hit.sym) return;
            const sub = node(N.IdentifierReference, n.start, n.end, hit.name, null);
            sub.sym = hit.sym;
            ctx.replaceWith(sub);
        },
    }),
    exit: null,
};
