// Hand-written convenience builders, layered over the per-node builders in `create.ts`.
//
// oxc's `builder/custom.rs` is the reference: methods that "take less params (with common
// defaults), add additional functionality, or are shortcuts for common patterns". Two kinds
// live here, and they are different things:
//
//   1. LEAF BUILDERS. `create.ts` has a builder for 126 of the 152 node types; the 26 it
//      lacks are exactly the null-data leaves (identifiers, literals, TS keywords), because
//      their content lives in the node's `name` slot rather than in `data`. Six pass files
//      each hand-rolled their own, so those are here once.
//   2. SHORTHANDS over `create.*` for shapes lowering passes build constantly (`a.b`, `a = b`,
//      `<expr>;`).
//
// When `create.ts` becomes generated from `DEFS`, this file stays hand-written — that split is
// the point of having two files.
//
// SCOPE: these serve code SYNTHESIS — a lowering pass minting nodes no source text produced, which
// is why the shorthands pin `SPAN` rather than taking one. Code REWRITING is a different job: it
// carries the original node's span through so sourcemaps survive, and `src/transform.ts` keeps its
// own span-taking helpers for exactly that reason. Do not "unify" the two by adding span parameters
// here — losing a real span to a zero-width one is a silent sourcemap regression.
import { N, type Node, node } from './ast.ts';
import * as create from './create.ts';
import { OP } from './create.ts';

/** An empty span, for a node that no source text produced.
 *
 *  oxc's `oxc_span::SPAN` ("An empty span. Should be used for newly created new AST nodes"),
 *  used 667× in its transformer. Five pass files each declared their own `const S = 0`. */
export const SPAN = 0;

// --- leaf builders -------------------------------------------------------------------------
//
// The identifier trio is split BOUND vs UNBOUND rather than defaulting `sym` to 0, mirroring
// oxc's `new_identifier_reference` / `new_identifier_reference_with_reference_id` pair (and
// `new_binding_identifier` / `..._with_symbol_id`).
//
// The split is not decoration. A synthesized reference that SHOULD carry a symbol but silently
// gets 0 is a live miscompile shape in this codebase, not a hypothetical: see the note in
// `passes/lazy-split.ts` `toTarget`, where dropping `sym` through a retype printed the raw
// source name while the namespace getters printed the mangled one. A required parameter cannot
// be forgotten; a defaulted one can.

/** An unbound `IdentifierReference` — `sym` 0, for names a later stage resolves (a runtime
 *  helper, a wrapper parameter) rather than ones the semantic model already knows. */
export const ref = (name: string, at = SPAN): Node => node(N.IdentifierReference, at, at, name, null);

/** An `IdentifierReference` carrying the symbol it resolves to, so renaming and mangling tie
 *  this use to its declaration. */
export const boundRef = (name: string, sym: number, at = SPAN): Node => {
    const n = node(N.IdentifierReference, at, at, name, null);
    (n as { sym: number }).sym = sym;
    return n;
};

/** An unbound `BindingIdentifier` — see {@link ref}. */
export const binding = (name: string, at = SPAN): Node => node(N.BindingIdentifier, at, at, name, null);

/** A `BindingIdentifier` carrying its symbol. */
export const boundBinding = (name: string, sym: number, at = SPAN): Node => {
    const n = node(N.BindingIdentifier, at, at, name, null);
    n.sym = sym;
    return n;
};

/** A non-binding name: a property key, a member's property, an import/export specifier name.
 *  Carries no symbol by definition — it never resolves to a binding. */
export const idName = (name: string, at = SPAN): Node => node(N.IdentifierName, at, at, name, null);

/** The label of a `break`/`continue`/labelled statement. Named `labelId`, not `label`, because
 *  `label` is a natural local variable name for the label's TEXT at every call site that needs one. */
export const labelId = (name: string, at = SPAN): Node => node(N.LabelIdentifier, at, at, name, null);

/** A string literal for the JS string `text`.
 *
 *  Takes the VALUE and quotes it, because a literal's `name` holds raw source text — quotes
 *  and escapes included — which the printer emits verbatim. Two pass files previously had a
 *  local `str` and disagreed on this: one quoted, one required a pre-quoted argument. Same
 *  name, opposite contracts. Quoting here is the safe direction — passing already-quoted text
 *  to the raw form was the shape that could emit a broken literal without failing anything. */
export const str = (text: string, at = SPAN): Node => node(N.StringLiteral, at, at, JSON.stringify(text), null);

export const num = (value: number, at = SPAN): Node => node(N.NumericLiteral, at, at, String(value), null);
export const bool = (value: boolean, at = SPAN): Node => node(N.BooleanLiteral, at, at, value ? 'true' : 'false', null);
export const nullLit = (at = SPAN): Node => node(N.NullLiteral, at, at, 'null', null);

// --- shorthands ----------------------------------------------------------------------------

/** `object.property` */
export const member = (object: Node, property: Node): Node => create.StaticMemberExpression(SPAN, SPAN, 0, object, property);

/** `object[expression]` */
export const computed = (object: Node, expression: Node): Node =>
    create.ComputedMemberExpression(SPAN, SPAN, 0, object, expression);

/** `target = value` */
export const assign = (target: Node, value: Node): Node => create.AssignmentExpression(SPAN, SPAN, '=', target, value);

/** `<expression>;` */
export const exprStmt = (expression: Node): Node => create.ExpressionStatement(SPAN, SPAN, 0, expression);

/** `{}` */
export const emptyObject = (): Node => create.ObjectExpression(SPAN, SPAN, 0, []);

/** `void 0` — `undefined` in expression position (oxc `Expression::new_void_0`). */
export const void0 = (): Node => create.UnaryExpression(SPAN, SPAN, OP.VOID, num(0));
