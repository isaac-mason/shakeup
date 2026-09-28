import { bigIntLiteralValue, numericLiteralValue, stringLiteralText, templateElementCooked } from '../src/analysis/const-eval.ts';
import { N, type Node } from '../src/ast.ts';

export const isNode = (x: unknown): x is Node =>
    typeof x === 'object' && x !== null && typeof (x as Node).type === 'number' && 'data' in (x as Node);

/** What a node's `name` compares as. The printer prints number, bigint and string literals from their
 *  value, as oxc does, so `0xff` and `'a'` come back as `255` and `"a"`: their values are compared. */
function nameValue(n: Node): string {
    if (n.type === N.StringLiteral) return stringLiteralText(n);
    if (n.type === N.NumericLiteral) return String(numericLiteralValue(n));
    if (n.type === N.BigIntLiteral) return String(bigIntLiteralValue(n));
    return n.name;
}

/** Strict structural equality over our AST, ignoring node identity (`id`/`start`/`end`) and the
 *  spelling of a literal's value. The gate for whitespace-faithful (non-minify) round-trips. */
export function astEqual(a: unknown, b: unknown): boolean {
    if (isNode(a) && isNode(b)) {
        if (a.type !== b.type || nameValue(a) !== nameValue(b)) return false;
        return astEqual(a.data, b.data);
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((x, i) => astEqual(x, b[i]));
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const ka = Object.keys(a);
        const kb = Object.keys(b);
        return ka.length === kb.length && ka.every((k) => astEqual((a as Rec)[k], (b as Rec)[k]));
    }
    return a === b;
}
type Rec = Record<string, unknown>;

/** Canonical token of a non-computed property key, so `"foo"` (StringLiteral) and `foo`
 *  (IdentifierName) compare equal after minify unquotes them. */
function keyToken(key: Node): string {
    if (key.type === N.StringLiteral) return `k:${stringLiteralText(key)}`;
    if (key.type === N.NumericLiteral) return `k:${numericLiteralValue(key)}`;
    return `k:${key.name}`;
}

const KEYED = new Set<number>([N.ObjectProperty, N.MethodDefinition, N.PropertyDefinition]);

/** Canonicalize an AST for SEMANTIC comparison under minify: drop `EmptyStatement`s from
 *  statement lists and normalize non-computed property keys. Everything else is preserved,
 *  so this catches any *real* behavioural divergence while tolerating the legal syntactic
 *  freedoms a minifier takes. (Value-level transforms — DCE, folding — are verified by
 *  execution-differential tests, not this.) */
export function canon(x: unknown): unknown {
    if (isNode(x)) {
        if (x.type === N.EmptyStatement) return EMPTY;
        // Minify prints a string as a template literal wherever that is cheapest, as oxc does.
        const asString = templateAsString(x);
        if (asString !== null) return { type: N.StringLiteral, name: JSON.stringify(asString), data: null };
        const out: Rec = { type: x.type, name: x.name, data: canon(x.data) };
        // `/*@__PURE__*​/` is intentionally NOT re-emitted under minify (oxc drops all 214 of
        // three.core.js's annotations too), so the flag legitimately differs after a minified
        // round-trip. It carries no behaviour of its own — it only licenses removals this build has
        // already made — so canonicalising it away keeps the comparison about printer fidelity.
        if (out.data !== null && typeof out.data === 'object') delete (out.data as Rec).pure;
        if (KEYED.has(x.type)) {
            const d = x.data as Rec;
            if (d.computed === false) (out.data as Rec).key = keyToken(d.key as Node);
        }
        return out;
    }
    if (Array.isArray(x)) return x.map(canon).filter((e) => e !== EMPTY);
    if (x && typeof x === 'object') {
        const o: Rec = {};
        for (const k of Object.keys(x)) o[k] = canon((x as Rec)[k]);
        return o;
    }
    return x;
}
const EMPTY = Symbol('empty-statement');

/** The cooked value of a template literal without substitutions, else null. */
function templateAsString(n: Node): string | null {
    if (n.type !== N.TemplateLiteral) return null;
    const d = n.data as { quasis: Node[]; expressions: Node[] };
    if (d.expressions.length > 0) return null;
    return templateElementCooked(d.quasis[0])?.value ?? null;
}

/** Semantic equality — strict structural equality over the canonicalized trees. */
export const semanticEqual = (a: unknown, b: unknown): boolean => astEqual(canon(a), canon(b));
