// B-fold — constant folding (terser/esbuild `evaluate`). Collapse binary/unary ops whose operands
// are ALL literals to a single literal, but ONLY where the JS runtime result is bit-exact and can
// be re-emitted as a literal whose re-parse yields the identical value. Conservative bail is always
// correct: a missed fold costs bytes, a wrong fold is a miscompile.
//
// THE SAFETY BOUNDARY (deliberately narrow for v1):
//  - Numbers: fold `num OP num` (+ - * / % ** & | ^ << >> >>> and < <= > >= == === != !==) ONLY when
//    the arithmetic result is a FINITE number that ROUND-TRIPS — `String(result)` re-parses
//    (`Number(...)`) to the exact same value AND is not `-0` (which prints as `0`, dropping the
//    sign). This admits `0.1+0.2`'s exact double (its `String` form round-trips), and rejects
//    `1/0` (Infinity, not a literal), `0/0` (NaN), and `-0`.
//  - Strings: fold `str + str` ONLY when both raw literals are JSON-decodable (standard double-quoted
//    escapes) — then the concatenation is re-emitted via `JSON.stringify`, itself a valid,
//    exactly-round-tripping literal. Single-quoted / escape-exotic raws bail.
//  - MIXED types never fold (no `1 + "a"`, no `true + 1`) — replicating JS `+`/comparison coercion
//    exactly is a minefield; we skip it wholesale.
//  - Unary: `-`/`+`/`~` on a numeric literal; `!` on a boolean/number/string/null literal; `typeof`
//    on any recognised literal → its type string. All gated by the same round-trip check.
//  - `typeof <object/array/function/arrow/regexp literal>` → `"object"`/`"function"` — the type is
//    statically known WITHOUT evaluating the argument, but ONLY when that literal is side-effect-free
//    (`isPureExpr`): `typeof {a:foo()}` must NOT fold, since that would drop the `foo()` call.
//  - `.length` on a string literal (`"abc".length`→`3`) or on a PURE array literal (`[a,b].length`→`2`;
//    a `[...x]` spread or any side-effecting element bails via `isPureExpr` — spread makes the length
//    unknown, an impure element must not be dropped). Static member only (`.length`), never `?.`.
//  - `str[i]` — an in-range non-negative INTEGER index into a string literal (`"abc"[0]`→`"a"`). Array
//    index is deliberately NOT folded (an element is an arbitrary expression; skipped for v1).
//  - Anything touching an identifier, call, template, or BigInt literal bails; member/regexp fold only
//    in the exact static shapes above.
import { isPureExpr } from '../../analysis/effects.ts';
import { N, type Node, set } from '../../ast.ts';
import { hookTable, type Visitor } from '../traverse.ts';

// --- literal-kind probes -----------------------------------------------------------------------
const isNum = (n: Node): boolean => n.type === N.NumericLiteral;
const isStr = (n: Node): boolean => n.type === N.StringLiteral;
const isBool = (n: Node): boolean => n.type === N.BooleanLiteral;
const isNull = (n: Node): boolean => n.type === N.NullLiteral;

// --- literal readers ---------------------------------------------------------------------------
// A numeric literal's `.name` is its raw source (`42`, `0xFF`, `1e3`). `Number(raw)` yields the exact
// double for every valid JS numeric literal EXCEPT `_`-separated forms (`1_000` → NaN), which then
// bail via the finite check. A NaN-valued numeric literal token cannot exist, so this never folds a
// NaN operand silently.
function numValue(n: Node): number | null {
    const v = Number(n.name);
    return Number.isFinite(v) ? v : null;
}

// Decode a StringLiteral's raw source (`.name`, quotes included) to its runtime value, but ONLY for
// raws JSON can parse — i.e. double-quoted with standard escapes. Single-quoted, template, or
// exotic-escape raws return null (bail). JSON.parse of a valid double-quoted JS string is exact.
function strValue(n: Node): string | null {
    const raw = n.name;
    if (raw.length < 2) return null;
    const quote = raw.charCodeAt(0);
    // SINGLE-quoted literals are re-quoted rather than rejected. Requiring `"` here silently
    // disabled string folding for most real code — `'x' === 'x'` survived to the output while
    // `"x" === "x"` folded — and it defeated `define` outright, since the substituted value and the
    // source it is compared against rarely share a quote style.
    let json: string;
    if (quote === 34 /* " */) {
        json = raw;
    } else if (quote === 39 /* ' */) {
        // `\'` is a JS escape but not a JSON one, and a bare `"` is legal inside single quotes but
        // must be escaped once re-quoted. Every OTHER escape is passed through untouched so that
        // `JSON.parse` remains the validator: JS-only forms (`\x41`, `\0`, `\u{1F600}`, a line
        // continuation) fail there and bail to `null`, which costs a fold and never risks a wrong one.
        const inner = raw.slice(1, -1).replace(/\\(.)|(")/gs, (m, esc: string | undefined, dq: string | undefined) =>
            dq !== undefined ? '\\"' : esc === "'" ? "'" : m,
        );
        json = `"${inner}"`;
    } else {
        return null;
    }
    try {
        const v = JSON.parse(json) as unknown;
        return typeof v === 'string' ? v : null;
    } catch {
        return null;
    }
}

// A number result is foldable iff it is finite, its shortest `String` form re-parses to the identical
// bits, and it is not `-0` (which prints as `0`, silently dropping the sign — a semantic change).
function numResultRaw(v: number): string | null {
    if (!Number.isFinite(v)) return null; // Infinity / -Infinity / NaN — no literal form
    if (Object.is(v, -0)) return null; // `-0` would print as `0`
    const raw = String(v);
    return Number(raw) === v ? raw : null; // require exact round-trip
}

// --- literal writers (retype the node in place; parents keep the same reference) ---------------
function toNum(n: Node, v: number): boolean {
    const raw = numResultRaw(v);
    if (raw === null) return false;
    // SIZE GUARD (oxc parity): never fold into a literal LONGER than the source it replaces. `1 / 6`
    // folds to `.16666666666666666` — 17 bytes in place of 3 — so constant-folding was actively
    // GROWING math-heavy code. Verified against oxc: it emits `1/6`, `2/3`, `100/3` and `.1+.2`
    // unfolded, while still folding non-expansive cases like `2*3` → `6`. Only applied when the node
    // carries a real source span; synthesized nodes (start === end) always fold.
    const span = n.end - n.start;
    if (span > 0 && raw.length > span) return false;
    set(n, N.NumericLiteral, null);
    (n as { name: string }).name = raw;
    return true;
}
function toStr(n: Node, v: string): void {
    set(n, N.StringLiteral, null);
    (n as { name: string }).name = JSON.stringify(v);
}
function toBool(n: Node, v: boolean): void {
    set(n, N.BooleanLiteral, null);
    (n as { name: string }).name = v ? 'true' : 'false';
}

// The truthiness of a recognised literal (for `!`). Notably EXCLUDES BigInt/RegExp/template
// literals — those bail (return null).
export function boolCoerce(n: Node): boolean | null {
    if (isBool(n)) return n.name === 'true';
    if (isNull(n)) return false; // `!null` → true
    if (isNum(n)) {
        const v = numValue(n);
        return v === null ? null : v !== 0; // NaN impossible; -0/0 both falsy
    }
    if (isStr(n)) {
        const v = strValue(n);
        return v === null ? null : v.length !== 0;
    }
    return null;
}

// `typeof <literal>` → the type string, for argument shapes whose type is statically known WITHOUT
// evaluating anything. Primitive literals are always safe. Object/array/function/arrow/regexp
// literals have a statically-known `typeof`, but `typeof <expr>` still evaluates `<expr>` for its
// side effects before discarding the value — folding to a bare string would DROP those effects (e.g.
// `typeof {a: foo()}` must keep the `foo()` call). So the compound-literal cases fold ONLY when the
// argument is side-effect-free (`isPureExpr`, which also rejects a spread inside array/object).
function typeofOf(n: Node): string | null {
    if (isNum(n)) return 'number';
    if (isStr(n)) return 'string';
    if (isBool(n)) return 'boolean';
    if (isNull(n)) return 'object'; // `typeof null === "object"`
    if (n.type === N.FunctionExpression || n.type === N.ArrowFunctionExpression) return isPureExpr(n) ? 'function' : null;
    if (n.type === N.ArrayExpression || n.type === N.ObjectExpression || n.type === N.RegExpLiteral)
        return isPureExpr(n) ? 'object' : null;
    return null;
}

// --- member folding (`.length` / string index) -------------------------------------------------
// The STATIC length of the object of a `.length` access, or null (bail). A string literal contributes
// its decoded code-unit length; a PURE array literal (no spread, no side-effecting element — the
// `isPureExpr` guard covers both) contributes its element count. Impure array bails: dropping it
// would drop its elements' side effects. Non-integer / >2^53 lengths never arise here (JSON-decoded
// string length and array element count are always small exact integers).
function lengthOf(obj: Node): number | null {
    if (isStr(obj)) {
        const v = strValue(obj);
        return v === null ? null : v.length;
    }
    if (obj.type === N.ArrayExpression) {
        return isPureExpr(obj) ? obj.data.elements.length : null;
    }
    return null;
}

// Fold `obj.property` (static member, non-optional) when it is `<literal>.length`.
function foldStaticMember(n: Node): boolean {
    const d = n.data as { object: Node; property: Node; optional: boolean };
    if (d.optional) return false; // `x?.length` — object may be null/undefined; not statically known
    if (d.property.type !== N.IdentifierName || d.property.name !== 'length') return false;
    const len = lengthOf(d.object);
    return len === null ? false : toNum(n, len);
}

// Fold `obj[index]` (computed member, non-optional) when it is an in-range integer index into a
// string literal → the single-character string. Array indexing is intentionally NOT folded (an
// element is an arbitrary expression, and even a literal element is deferred to a later version).
function foldComputedMember(n: Node): boolean {
    const d = n.data as { object: Node; expression: Node; optional: boolean };
    if (d.optional) return false;
    if (!isStr(d.object) || !isNum(d.expression)) return false;
    const s = strValue(d.object);
    const i = numValue(d.expression);
    if (s === null || i === null) return false;
    if (!Number.isInteger(i) || i < 0 || i >= s.length) return false; // out-of-range / non-integer → `undefined`, bail
    toStr(n, s[i]);
    return true;
}

// --- binary numeric folding --------------------------------------------------------------------
function foldNumBinary(op: string, a: number, b: number): number | null {
    switch (op) {
        case '+':
            return a + b;
        case '-':
            return a - b;
        case '*':
            return a * b;
        case '/':
            return a / b;
        case '%':
            return a % b;
        case '**':
            return a ** b;
        case '&':
            return a & b;
        case '|':
            return a | b;
        case '^':
            return a ^ b;
        case '<<':
            return a << b;
        case '>>':
            return a >> b;
        case '>>>':
            return a >>> b;
        default:
            return null;
    }
}
function foldNumCompare(op: string, a: number, b: number): boolean | null {
    switch (op) {
        case '<':
            return a < b;
        case '<=':
            return a <= b;
        case '>':
            return a > b;
        case '>=':
            return a >= b;
        case '==':
        case '===':
            return a === b; // both operands numeric → loose/strict coincide
        case '!=':
        case '!==':
            return a !== b;
        default:
            return null;
    }
}

function foldBinary(n: Node): boolean {
    const d = n.data as { operator: string; left: Node; right: Node };
    const op = d.operator;
    const l = d.left;
    const r = d.right;
    // number OP number
    if (isNum(l) && isNum(r)) {
        const a = numValue(l);
        const b = numValue(r);
        if (a === null || b === null) return false;
        const cmp = foldNumCompare(op, a, b);
        if (cmp !== null) {
            toBool(n, cmp);
            return true;
        }
        const num = foldNumBinary(op, a, b);
        return num === null ? false : toNum(n, num);
    }
    // string + string (concatenation only; string comparisons are intentionally out of scope for v1)
    if (op === '+' && isStr(l) && isStr(r)) {
        const a = strValue(l);
        const b = strValue(r);
        if (a === null || b === null) return false;
        toStr(n, a + b);
        return true;
    }
    // string COMPARE string. `foldNumCompare` above already does this for numbers, but the string case
    // was missing entirely — `1 === 1` folded to `!0` while `"a" === "a"` survived to the output, which
    // oxc folds. Both operands being strings makes loose and strict coincide, and `<`/`>` on strings is
    // the lexicographic comparison JS performs, so every operator below is exact.
    if (isStr(l) && isStr(r)) {
        const a = strValue(l);
        const b = strValue(r);
        if (a === null || b === null) return false;
        let v: boolean;
        switch (op) {
            case '==':
            case '===':
                v = a === b;
                break;
            case '!=':
            case '!==':
                v = a !== b;
                break;
            case '<':
                v = a < b;
                break;
            case '<=':
                v = a <= b;
                break;
            case '>':
                v = a > b;
                break;
            case '>=':
                v = a >= b;
                break;
            default:
                return false;
        }
        toBool(n, v);
        return true;
    }
    return false;
}

// --- unary folding -----------------------------------------------------------------------------
function foldUnary(n: Node): boolean {
    const d = n.data as { operator: string; argument: Node };
    const op = d.operator;
    const arg = d.argument;
    if (op === 'typeof') {
        const t = typeofOf(arg);
        if (t === null) return false;
        toStr(n, t);
        return true;
    }
    if (op === '!') {
        const b = boolCoerce(arg);
        if (b === null) return false;
        toBool(n, !b);
        return true;
    }
    // numeric unaries — argument must be a numeric literal.
    if (!isNum(arg)) return false;
    const v = numValue(arg);
    if (v === null) return false;
    if (op === '-') return toNum(n, -v);
    if (op === '+') return toNum(n, +v);
    if (op === '~') return toNum(n, ~v);
    return false;
}

/** Splice a constant expression into the surrounding template text: `` `x${2}y` `` → `` `x2y` ``.
 *
 *  oxc folds these; we were emitting the hole. Restricted to NUMBER / BOOLEAN / NULL, whose string
 *  forms cannot contain a character that is special inside a template — a backtick, a backslash, or a
 *  `${`. Folding a STRING would need those escaped, and a mis-escape here produces a syntax error or,
 *  worse, an injected interpolation; not worth it for the bytes.
 *
 *  `TemplateElement.name` carries the RAW text, so the merge is a plain splice of the two neighbours
 *  around the hole. */
function foldTemplate(n: Node): boolean {
    const d = n.data as { quasis: Node[]; expressions: Node[] };
    let changed = false;
    for (let i = d.expressions.length - 1; i >= 0; i--) {
        const e = d.expressions[i];
        let text: string | null = null;
        if (isNum(e)) {
            const v = numValue(e);
            if (v !== null && Number.isFinite(v)) text = String(v);
        } else if (isBool(e)) {
            text = e.name;
        } else if (isNull(e)) {
            text = 'null';
        }
        if (text === null) continue;
        // Merge quasis[i] + text + quasis[i+1], then drop the hole.
        const left = d.quasis[i];
        const right = d.quasis[i + 1];
        if (left === undefined || right === undefined) continue;
        (left as { name: string }).name = left.name + text + right.name;
        d.quasis.splice(i + 1, 1);
        d.expressions.splice(i, 1);
        changed = true;
    }
    return changed;
}

export const foldConstants: Visitor = {
    name: 'foldConstants',
    // EXIT phase: children are folded first, so `1 + 2 + 3` collapses bottom-up in one traversal
    // (`(1+2)` → `3`, then `3+3` → `6`) rather than needing extra fixed-point iterations.
    enter: null,
    exit: hookTable({
        [N.BinaryExpression]: (node, ctx) => {
            if (foldBinary(node)) ctx.replaceWith(node);
        },
        [N.UnaryExpression]: (node, ctx) => {
            if (foldUnary(node)) ctx.replaceWith(node);
        },
        [N.TemplateLiteral]: (node, ctx) => {
            if (foldTemplate(node)) ctx.changed = true;
        },
        [N.StaticMemberExpression]: (node, ctx) => {
            if (foldStaticMember(node)) ctx.replaceWith(node);
        },
        [N.ComputedMemberExpression]: (node, ctx) => {
            if (foldComputedMember(node)) ctx.replaceWith(node);
        },
    }),
};
