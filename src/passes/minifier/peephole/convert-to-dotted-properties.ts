// Port of oxc_minifier/src/peephole/convert_to_dotted_properties.rs. Full minify only.

import { stringLiteralText } from '../../../analysis/const-eval.ts';
import { N, type Node, node, set } from '../../../ast/index.ts';
import { isIdentifierNamePatched } from '../syntax.ts';
import { type DceCtx, noticeChange, replaceExpression, stringToEquivalentNumberValue } from '../traverse-context.ts';

/**
 * Converts property accesses from quoted string or bracket access syntax to dot or unquoted string
 * syntax, where possible. Dot syntax is more compact.
 *
 * `foo['bar']` -> `foo.bar`
 * `foo?.['bar']` -> `foo?.bar`
 */
export function convertToDottedProperties(ctx: DceCtx, expr: Node): void {
    if (expr.type !== N.ComputedMemberExpression) return;
    const literal = expr.data.expression as Node;
    if (literal.type !== N.StringLiteral) return;
    const value = stringLiteralText(literal);
    if (isIdentifierNamePatched(value)) {
        const property = node(N.IdentifierName, literal.start, literal.end, value, null);
        set(expr, N.StaticMemberExpression, { object: expr.data.object, property, optional: expr.data.optional });
        noticeChange(ctx);
        return;
    }
    if (expr.data.optional) return;
    const numberValue = stringToEquivalentNumberValue(value);
    if (numberValue !== null)
        replaceExpression(ctx, literal, node(N.NumericLiteral, literal.start, literal.end, String(numberValue), null));
}
