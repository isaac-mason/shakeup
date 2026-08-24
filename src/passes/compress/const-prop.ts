// Constant propagation (oxc `inline_identifier_reference` + `can_inline_initialized_constant`,
// symbol_value.rs:127; ported from esbuild/SWC). Replace reads of a `const`/`let` binding whose
// initializer is a PRIMITIVE LITERAL with the literal itself — the transform that unlocks
// feature-flag DCE: `const DEBUG = false; if (DEBUG) {…}` → the read becomes `false`, then dead-code
// eliminates the branch (both run in the fixed-point LOOP).
//
// SAFETY: inlining a primitive-valued binding's read is UNCONDITIONALLY correct — primitives have no
// identity (`a === X` ≡ `a === 5`), so there's no aliasing hazard, and no code movement (a literal is
// order-independent). The only precondition is that the binding is never REASSIGNED (zero writes;
// `const` guarantees it, `let` is checked via the read/write tally). We do NOT remove the now-dead
// declaration here — once its reads are gone, drop-unused (function/block scope) or tree-shaking
// (module scope) reclaims it. This keeps the pass a pure read-substitution with no statement-slot
// removal hazards.
//
// SIZE POLICY (oxc/esbuild): a SINGLE-read binding inlines any primitive (the decl then vanishes, net
// win). A MULTI-read binding inlines only SMALL constants (int −99..999, string ≤3 chars, bool/null/
// undefined) — duplicating a long string across many reads would bloat the output.
import { getPrelude } from './prelude.ts';
import { N, type Node, node, walkChildren } from '../../ast.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

/** Map from a candidate SymbolId to the literal template to copy into each of its reads. Set at
 *  Program enter, read by the IdentifierReference hook. Module-level (single-threaded traverse,
 *  like drop-unused's snapshot). */
let INLINE: Map<number, Node> | null = null;

/** A copyable PRIMITIVE constant init, or null. Primitives only — objects/arrays/functions have
 *  identity (duplicating them changes behavior) and are never candidates. */
function constInit(init: Node | null): Node | null {
    if (init === null) return null;
    switch (init.type) {
        case N.NumericLiteral:
        case N.StringLiteral:
        case N.BooleanLiteral:
        case N.NullLiteral:
            return init;
        // The global `undefined` (unresolved ⇒ sym 0). A shadowed local `undefined` is not this.
        case N.IdentifierReference:
            return init.name === 'undefined' && init.sym === 0 ? init : null;
        // `-1` / `+2` — a unary over a numeric literal is a primitive number constant.
        case N.UnaryExpression: {
            const d = init.data as { operator: string; argument: Node };
            return (d.operator === '-' || d.operator === '+') && d.argument.type === N.NumericLiteral ? init : null;
        }
        default:
            return null;
    }
}

/** Whether a primitive-constant init is "small" enough to duplicate across MULTIPLE reads. */
function isSmall(init: Node): boolean {
    switch (init.type) {
        case N.BooleanLiteral:
        case N.NullLiteral:
            return true;
        case N.IdentifierReference:
            return true; // `undefined`
        case N.StringLiteral:
            return init.name.length - 2 <= 3; // raw includes quotes → content length
        case N.NumericLiteral: {
            const n = Number(init.name);
            return Number.isInteger(n) && n >= -99 && n <= 999;
        }
        case N.UnaryExpression: {
            const n = Number((init.data as { argument: Node }).argument.name);
            const v = (init.data as { operator: string }).operator === '-' ? -n : n;
            return Number.isInteger(v) && v >= -99 && v <= 999;
        }
        default:
            return false;
    }
}

/** Deep-copy a primitive-constant node (fresh node per read — never share one AST node across
 *  multiple slots). Only the small shapes `constInit` admits appear here. */
function copyConst(n: Node): Node {
    if (n.type === N.UnaryExpression) {
        const d = n.data as { operator: string; argument: Node };
        const arg = d.argument;
        return node(N.UnaryExpression, n.start, n.end, '', {
            operator: d.operator,
            prefix: true,
            argument: node(arg.type, arg.start, arg.end, arg.name, null),
        });
    }
    return node(n.type, n.start, n.end, n.name, null);
}

export const constProp: Visitor = {
    name: 'constProp',
    enter: hookTable({
        [N.Program]: (program, _ctx) => {
            // Both facts come from the SHARED prelude — one walk for the whole traversal instead of
            // this pass doing its own `tallyRefs` + `walkRefIdents`.
            const { refs, shorthand } = getPrelude(program);
            const map = new Map<number, Node>();
            // Collect candidate declarators: `const`/`let` with a plain BindingIdentifier id and a
            // primitive-literal init, whose symbol has zero writes and the right read count.
            const scan = (n: Node): void => {
                if (n.type === N.VariableDeclaration) {
                    const kind = (n.data as { kind: string }).kind;
                    if (kind !== 'var') {
                        for (const d of (n.data as { declarations: Node[] }).declarations) {
                            const id = (d.data as { id: Node; init: Node | null }).id;
                            const lit = constInit((d.data as { init: Node | null }).init);
                            if (lit === null || id.type !== N.BindingIdentifier) continue;
                            const sym = (id as { sym: number }).sym;
                            if (sym === 0 || shorthand.has(sym)) continue;
                            const c = refs.get(sym);
                            const reads = c?.reads ?? 0;
                            const writes = c?.writes ?? 0;
                            if (writes > 0 || reads === 0) continue; // reassigned, or unused (leave to DCE)
                            if (reads > 1 && !isSmall(lit)) continue; // multi-read: small constants only
                            map.set(sym, lit);
                        }
                    }
                }
                walkChildren(n, scan);
            };
            scan(program);
            INLINE = map.size > 0 ? map : null;
        },
        [N.IdentifierReference]: (n, ctx: TransformCtx) => {
            if (INLINE === null) return;
            const lit = INLINE.get((n as { sym: number }).sym);
            if (lit !== undefined) ctx.replaceWith(copyConst(lit));
        },
    }),
    exit: null,
};
