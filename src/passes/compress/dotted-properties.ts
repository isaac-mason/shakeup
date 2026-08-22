// B-dotted — convert computed member access with a static identifier-shaped string key to dotted
// member access (esbuild `minifySyntax`, terser `properties`, oxc `convert_to_dotted_properties`):
//   • `a["b"]`       → `a.b`
//   • `a["default"]` → `a.default`   (reserved words are valid after `.` in ES5+)
//   • `a?.["b"]`     → `a?.b`         (the `optional` flag rides across on the same node)
//
// Fewer bytes, and `.name` gzips better than `["name"]`. Behavior-preserving: a computed access with
// a string-literal key and a dotted access with that identifier resolve the SAME property; the only
// thing that changes is spelling. This is a READ/WRITE/CALL-agnostic rewrite because it operates on
// the MemberExpression node itself, so `a["b"] = 1`, `a["b"]()`, `delete a["b"]` all covered.
//
// CONSERVATIVE identifier rule — we mirror the printer's object-key unquoting exactly (print-js.ts
// `IDENT_KEY`): the string's DECODED value must be a clean identifier-name shape. Because a
// `StringLiteral.name` carries its RAW source text (quotes + any escapes) and `IDENT_KEY` admits
// only `[A-Za-z_$][A-Za-z0-9_$]*`, testing the raw inner text is both the decode AND the "no
// re-encoding needed" check in one: any escape (`\x`, `\u`, `\n`) contains a backslash the class
// rejects, so an escaped key can never be misread as its own literal spelling and is left alone.
//
// SKIPPED: non-identifier keys (`a["foo-bar"]`, `a["with space"]`), numeric-looking keys (`a["0"]`,
// array indices — `IDENT_KEY`'s leading `[A-Za-z_$]` already excludes a digit start), the empty
// string (`a[""]`), escaped keys we can't verify byte-for-byte, and any non-string-literal computed
// key (`a[x]`, `a[0]`, `a[`t${x}`]`).
import { N, type Node, node } from '../../ast.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

/** Identifier-name shape — identical to the printer's object-key unquoting test (print-js.ts
 *  `IDENT_KEY`). A leading `[A-Za-z_$]` excludes numeric/array-index strings; the absence of `\`
 *  from the class means any escaped string literal fails, so we only ever match a key whose raw
 *  spelling already IS the identifier (no decode/re-encode round-trip risk). */
const IDENT_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export const convertToDottedProperties: Visitor = {
    name: 'convertToDottedProperties',
    enter: hookTable({
        [N.ComputedMemberExpression]: (n, ctx: TransformCtx) => {
            const d = n.data as { object: Node; expression: Node; optional: boolean };
            const key = d.expression;
            if (key.type !== N.StringLiteral) return; // only static string keys
            // `StringLiteral.name` is the raw source slice INCLUDING quotes; strip the one-char
            // delimiter each side. (A well-formed string literal always has both quotes, so slicing
            // 1..-1 is safe; an empty string yields `` which `IDENT_KEY` rejects.)
            const inner = key.name.slice(1, -1);
            if (!IDENT_KEY.test(inner)) return; // non-identifier / numeric / empty / escaped → bail
            // Build the dotted form: `StaticMemberExpression { object, property, optional }` where the
            // property is an IdentifierName whose `.name` the printer emits verbatim after `.`/`?.`.
            const property = node(N.IdentifierName, key.start, key.end, inner, null);
            ctx.replaceWith(
                node(N.StaticMemberExpression, n.start, n.end, '', {
                    object: d.object,
                    property,
                    optional: d.optional, // carries `a?.["b"]` → `a?.b`
                }),
            );
        },
    }),
    exit: null,
};
