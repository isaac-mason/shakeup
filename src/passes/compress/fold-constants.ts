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
//  - Anything touching an identifier, member, call, template, regexp, or BigInt literal bails.
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
    if (raw.length < 2 || raw.charCodeAt(0) !== 34 /* " */) return null;
    try {
        const v = JSON.parse(raw) as unknown;
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
function boolCoerce(n: Node): boolean | null {
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

// `typeof <literal>` → the type string, for the literal kinds we recognise.
function typeofOf(n: Node): string | null {
    if (isNum(n)) return 'number';
    if (isStr(n)) return 'string';
    if (isBool(n)) return 'boolean';
    if (isNull(n)) return 'object'; // `typeof null === "object"`
    return null;
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
    }),
};
