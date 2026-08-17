import { N, type Node } from '../src/index.ts';

export const isNode = (x: unknown): x is Node =>
    typeof x === 'object' && x !== null && typeof (x as Node).type === 'number' && 'data' in (x as Node);

/** Strict structural equality over our AST, ignoring node identity (`id`/`start`/`end`).
 *  The gate for whitespace-faithful (non-minify) round-trips. */
export function astEqual(a: unknown, b: unknown): boolean {
    if (isNode(a) && isNode(b)) {
        if (a.type !== b.type || a.name !== b.name) return false;
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
    if (key.type === N.StringLiteral) return `k:${key.name.slice(1, -1)}`;
    if (key.type === N.NumericLiteral) return `k:${Number(key.name)}`;
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
        const out: Rec = { type: x.type, name: x.name, data: canon(x.data) };
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

/** Semantic equality — strict structural equality over the canonicalized trees. */
export const semanticEqual = (a: unknown, b: unknown): boolean => astEqual(canon(a), canon(b));
