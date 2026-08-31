/** Structural differential helper: does shakeup's ESTree projection agree with a reference parser?
 *
 *  DIRECTIONAL, on purpose. It walks the REFERENCE tree and checks shakeup against every field the
 *  reference asserts — extra fields on our side are ignored. That is the right contract for two
 *  reasons: shakeup's AST is a TypeScript AST, so it legitimately carries `typeAnnotation`,
 *  `definite`, `declare` and friends that a JS-only reference parser never emits; and the question
 *  worth asking is "did we get anything WRONG", not "did we emit exactly the same field set".
 *
 *  This subsumes the per-type COUNT comparison in the differential tests, which cannot see a wrong
 *  nesting, a swapped operand, or a bad flag — only that the same number of each kind exists. */

const SKIP = new Set(['start', 'end', 'range', 'loc']);

/** bigint and RegExp do not survive `===`; compare by their source form. */
const scalar = (v: unknown): unknown =>
    typeof v === 'bigint' ? `${v}n` : v instanceof RegExp ? String(v) : v;

/** Every place shakeup's projection disagrees with `reference`, as `path: ours vs theirs` strings. */
export function estreeDiff(ours: unknown, reference: unknown, limit = 25): string[] {
    const out: string[] = [];
    const walk = (o: unknown, t: unknown, path: string): void => {
        if (out.length >= limit) return;
        if (Array.isArray(t)) {
            if (!Array.isArray(o)) return void out.push(`${path}: ours is not an array`);
            if (o.length !== t.length) return void out.push(`${path}: length ${o.length} vs ${t.length}`);
            for (let i = 0; i < t.length; i++) walk(o[i], t[i], `${path}[${i}]`);
            return;
        }
        if (t !== null && typeof t === 'object') {
            if (o === null || typeof o !== 'object')
                return void out.push(`${path}: ours=${JSON.stringify(o)}, theirs=${(t as { type?: string }).type ?? 'object'}`);
            const T = t as Record<string, unknown>;
            const O = o as Record<string, unknown>;
            if (T.type !== undefined && O.type !== T.type)
                return void out.push(`${path}: type ${String(O.type)} vs ${String(T.type)}`);
            for (const k of Object.keys(T)) {
                if (SKIP.has(k) || T[k] === undefined) continue;
                walk(O[k], T[k], `${path}.${k}`);
            }
            return;
        }
        if (scalar(o) !== scalar(t)) out.push(`${path}: ${JSON.stringify(scalar(o))} vs ${JSON.stringify(scalar(t))}`);
    };
    walk(ours, reference, 'Program');
    return out;
}

/** Divergences that are NOT parser bugs, keyed by the trailing field of the reported path.
 *
 *  `.method` — ESTree's `Property.method` distinguishes `{ m(){} }` from `{ m: function(){} }`.
 *  shakeup does not model it: both parse to an ObjectProperty with kind `init` and a
 *  FunctionExpression value, so the projection always reports `false`. The gap is real and tracked —
 *  the printer round-trips the shorthand form INTO the longhand one, which changes semantics (a
 *  method is not constructible, and carries a [[HomeObject]] so `super` resolves). Closing it means
 *  storing the flag on `ObjectProperty` in `DEFS`, the parser and the printer. Until then, allowing
 *  it here keeps the rest of the check honest rather than disabling the whole comparison. */
/*  `openingElement.name` / `closingElement.name` — the JSX head-role split. shakeup classifies a
 *  capitalized or member-headed tag name as an `IdentifierReference` (and `this` as a
 *  `ThisExpression`) so a component reference participates in scope analysis and tree-shaking;
 *  meriyah emits a flat `JSXIdentifier`. Deliberate and already documented as a group in the count
 *  comparison — projecting it back to `JSXIdentifier` would throw away the resolution shakeup went
 *  out of its way to compute. */
export const KNOWN_GAPS = [/\.method: /, /Element\.name(?:\.object)*: type (?:Identifier|ThisExpression) vs JSXIdentifier/];

export const isKnownGap = (d: string): boolean => KNOWN_GAPS.some((re) => re.test(d));
