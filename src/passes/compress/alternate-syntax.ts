// B-substitute — substitute alternate (shorter) syntax for equivalent values (esbuild `minifySyntax`,
// terser `substitute_alternate_syntax`). Fewer bytes, and the substitutions gzip well:
//   • `true`  → `!0`      (boolean keyword literals — never shadowable, always safe)
//   • `false` → `!1`
//   • `undefined` → `void 0`  (ONLY the GLOBAL `undefined`; a locally-shadowed `undefined`, or one
//     used as a property key/name, is left alone)
//
// All three yield a `UnaryExpression` whose argument is a `NumericLiteral`. Because we build a real
// UnaryExpression, the printer's precedence machinery parenthesizes it wherever a unary can't appear
// bare (`(void 0).x`, `new (void 0)`, …), so the substitution is behavior-preserving in every context.
//
// SKIPPED for v1: `Infinity` → `1/0` (a BinaryExpression at multiplicative precedence — not always a
// clean swap in context; deferred, low payoff).
import { N, type Node, node } from '../../ast.ts';
import { OP, UnaryExpression } from '../../parser/create.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

/** `NumericLiteral` `0`/`1` — data-less leaf; the printer emits `node.name` verbatim. */
const num = (n: Node, text: string): Node => node(N.NumericLiteral, n.start, n.end, text, null);

/** `!<0|1>` for a boolean literal: `true` → `!0`, `false` → `!1`. */
const notNum = (n: Node, digit: string): Node => UnaryExpression(n.start, n.end, OP.NOT, num(n, digit));

/** `void 0` for a global `undefined` reference. */
const voidZero = (n: Node): Node => UnaryExpression(n.start, n.end, OP.VOID, num(n, '0'));

/** Is `n` an IdentifierReference to the GLOBAL `undefined`? `sym === 0` = unresolved/global, so a
 *  shadowed `let undefined = …` (nonzero sym) is correctly excluded. */
const isGlobalUndefined = (n: Node): boolean => n.type === N.IdentifierReference && n.name === 'undefined' && n.sym === 0;

export const substituteAlternateSyntax: Visitor = {
    name: 'substituteAlternateSyntax',
    enter: hookTable({
        // `true`/`false` are keyword literals — never a binding name, so substitution is
        // unconditionally safe. The BooleanLiteral node carries its text in `name`.
        [N.BooleanLiteral]: (n, ctx: TransformCtx) => {
            ctx.replaceWith(n.name === 'true' ? notNum(n, '0') : notNum(n, '1'));
        },
        // A GLOBAL `undefined` reference → `void 0`. Non-computed property KEYS (`{ undefined: 1 }`,
        // `obj.undefined`) parse as IdentifierName, never IdentifierReference, so they never reach this
        // hook. Shorthand-property values (`{ undefined }`) are expanded at the ObjectProperty level
        // below before descent reaches them, so they don't reach this hook as a bare reference either.
        [N.IdentifierReference]: (n, ctx: TransformCtx) => {
            if (isGlobalUndefined(n)) ctx.replaceWith(voidZero(n));
        },
        // Shorthand `{ undefined }` means `{ undefined: undefined }`, but its value is an
        // IdentifierReference the printer only emits when the *name* changed. Substituting the value to
        // `void 0` in place would be swallowed (shorthand still prints `undefined`), so we expand the
        // property to the explicit `undefined: void 0` form here — clearing `shorthand` and swapping the
        // value — which the printer emits correctly. (Booleans can't be shorthand: `{ true }` is a
        // syntax error.)
        [N.ObjectProperty]: (n, _ctx: TransformCtx) => {
            const d = n.data as { shorthand: boolean; value: Node };
            if (d.shorthand && isGlobalUndefined(d.value)) {
                d.shorthand = false;
                d.value = voidZero(d.value);
            }
        },
    }),
    exit: null,
};
