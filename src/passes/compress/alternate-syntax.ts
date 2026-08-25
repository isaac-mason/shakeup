// B-substitute — substitute alternate (shorter) syntax for equivalent values (esbuild `minifySyntax`,
// terser / oxc `substitute_alternate_syntax`). Fewer bytes, and the substitutions gzip well:
//   • `true`  → `!0`      (boolean keyword literals — never shadowable, always safe)
//   • `false` → `!1`
//   • `undefined` → `void 0`  (ONLY the GLOBAL `undefined`; a locally-shadowed `undefined`, or one
//     used as a property key/name, is left alone)
//   • `new Object()` → `{}` ; `new Array()` → `[]`   (global, ZERO args only — `new Array(5)` differs)
//   • `Boolean(x)` → `!!x`   (global `Boolean`, exactly one non-spread argument)
//   • `new Error(…)` → `Error(…)`   (global error constructors are `new`-optional; drop the `new`)
//   • `return undefined;` / `return void 0;` → `return;`   (drop a redundant `undefined` argument)
//
// The first three yield a `UnaryExpression` whose argument is a `NumericLiteral`. Because we build a
// real UnaryExpression, the printer's precedence machinery parenthesizes it wherever a unary can't
// appear bare (`(void 0).x`, `new (void 0)`, …), so the substitution is behavior-preserving in every
// context. The constructor/call rewrites likewise build real nodes, so the printer handles context.
//
// SHADOW SAFETY: every substitution that NAMES a global (`Object`/`Array`/`Boolean`/`Error`…) only
// fires when the callee is an IdentifierReference whose `sym === 0` — unresolved, i.e. the true
// global. A local `let Object = …` (nonzero sym) resolves to that binding and is left untouched. This
// is the same `sym === 0` test the `undefined` case already relies on.
//
// PLACEMENT: this pass runs in FINAL_PASSES — once, after the fixed-point loop settles — so these
// byte-shaving swaps never re-enter the loop and can't oscillate against fold-constants (`!0`→`true`).
//
// SKIPPED for v1: `Infinity` → `1/0` (a BinaryExpression at multiplicative precedence — not always a
// clean swap in context; deferred, low payoff).
import { N, type Node, node } from '../../ast.ts';
import * as create from '../../parser/create.ts';
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

/** Is `callee` an IdentifierReference to the GLOBAL binding named `name`? `sym === 0` = unresolved,
 *  i.e. not shadowed by any local `let name = …`. Conservative: only the true global qualifies. */
const isGlobalRef = (callee: Node, name: string): boolean =>
    callee.type === N.IdentifierReference && callee.name === name && callee.sym === 0;

/** `undefined` OR `void 0` — either spelling of the JS `undefined` value. A `return`ed one is
 *  redundant (already-substituted `void 0` refs, or hand-written `void 0`, both count). */
const isUndefinedValue = (n: Node): boolean =>
    isGlobalUndefined(n) ||
    (n.type === N.UnaryExpression &&
        (n.data as { operator: string; argument: Node }).operator === 'void' &&
        (n.data as { argument: Node }).argument.type === N.NumericLiteral);

/** Error constructors that produce an identical result whether called or constructed — `Error(x)` and
 *  `new Error(x)` create the same instance, so the `new` is pure byte overhead. (ES spec: each of
 *  these ordinary constructors creates an instance whether invoked with or without `new`.) */
const ERROR_CTORS = new Set([
    'Error',
    'TypeError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'EvalError',
    'URIError',
    'AggregateError',
]);

/** The shortest source text that parses back to EXACTLY the same numeric value, or `null` to leave the
 *  literal alone. Mirrors what oxc's codegen does when minifying (`0xffffffff` → `4294967295`,
 *  `0.5` → `.5`, `1000000` → `1e6`). Every candidate is verified by re-parsing, so a rewrite can never
 *  change the value; ties prefer plain decimal, which is what oxc emits.
 *
 *  Skipped: BigInt (a different node type), and anything that looks like a LEGACY OCTAL (`017`), whose
 *  value depends on sloppy-vs-strict mode and which `Number()` would misread as decimal. */
/** A plain decimal integer of 1-3 digits (`0`, `7`, `42`, `255`) — the overwhelmingly common literal.
 *
 *  None of them can be shortened, so they can skip the whole candidate machinery below:
 *    · `String(value)` already equals `raw`;
 *    · the exponential form ties at best (`100` -> `1e2`, both 3) and the candidate loop demands
 *      STRICTLY shorter, so a tie is rejected;
 *    · hex is always longer (`255` -> `0xff` is 4 vs 3);
 *    · the `0.x -> .x` candidate needs a `0.` prefix, which a leading zero here excludes.
 *
 *  Worth a fast path because `shortestNumber` runs on every numeric literal of every compress round
 *  and 91.5% of its calls (crashcat) return unchanged — 90.4% of ALL calls are exactly this shape.
 *  Each of those otherwise allocated a `_`-stripped copy, `String(value)`, `toExponential()`, often
 *  `toString(16)`, and a candidate array. Character tests, no regex, no allocation. */
function isShortDecimalInt(raw: string): boolean {
    const n = raw.length;
    if (n === 0 || n > 3) return false;
    const c0 = raw.charCodeAt(0);
    if (c0 < 48 || c0 > 57) return false;
    if (c0 === 48 && n > 1) return false; // leading zero: legacy octal / `0.x` — handled below
    for (let i = 1; i < n; i++) {
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) return false; // covers `_`, `.`, `e`, `x`
    }
    return true;
}

function shortestNumber(raw: string): string | null {
    if (isShortDecimalInt(raw)) return null;
    if (/^0[0-9]/.test(raw)) return null; // legacy octal — never touch
    const value = Number(raw.replace(/_/g, ''));
    if (!Number.isFinite(value) || value < 0) return null;

    const cands: string[] = [];
    const dec = String(value);
    cands.push(dec);
    if (dec.startsWith('0.')) cands.push(dec.slice(1)); // 0.5 → .5
    // Exponential, normalized: `1e+6` → `1e6`, `1.5e-7` → `1.5e-7`.
    const exp = value.toExponential().replace('e+', 'e').replace(/^(\d)(?:\.0+)?e/, '$1e');
    cands.push(exp);
    if (Number.isInteger(value) && value <= Number.MAX_SAFE_INTEGER) cands.push('0x' + value.toString(16));

    // Plain decimal wins on a LENGTH TIE (what oxc emits): `0xffffffff` and `4294967295` are both 10
    // chars, and oxc prints the decimal. Other candidates must be strictly shorter to displace it.
    let best = raw;
    if (dec.length <= best.length && Number(dec) === value) best = dec;
    for (const c of cands) {
        // Re-parse guard: only accept a candidate that is genuinely the same value AND shorter.
        if (c.length < best.length && Number(c) === value) best = c;
    }
    return best === raw ? null : best;
}

export const substituteAlternateSyntax: Visitor = {
    name: 'substituteAlternateSyntax',
    enter: hookTable({
        // `const x = …` → `let x = …`. Two bytes per declaration, and `const` is pervasive in modern
        // source, so this is one of the largest single wins in the pass. `let` and `const` share
        // block scoping, TDZ, and per-iteration binding (`for (const x of …)` ≡ `for (let x of …)`);
        // the ONLY semantic difference is that assigning to a `const` throws a TypeError, which valid
        // code never does. Safe HERE specifically because this is a FINAL pass: const-prop and inline
        // read `kind === 'const'` for immutability during the fixed-point loop, which has already
        // settled. (oxc / terser / esbuild all do this.)
        [N.VariableDeclaration]: (n, ctx: TransformCtx) => {
            const d = n.data as { kind: string };
            if (d.kind === 'const') {
                d.kind = 'let';
                ctx.changed = true;
            }
        },
        // Numeric literals → their shortest exact source form (see `shortestNumber`).
        [N.NumericLiteral]: (n, ctx: TransformCtx) => {
            const short = shortestNumber(n.name);
            if (short !== null) {
                n.name = short;
                ctx.changed = true;
            }
        },
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
        // `new Object()` → `{}`, `new Array()` → `[]` (global, ZERO args), and `new <Error>(…)` →
        // `<Error>(…)` (drop the `new` from a `new`-optional error constructor). Each names a global,
        // so `isGlobalRef` gates on the unresolved (unshadowed) binding.
        [N.NewExpression]: (n, ctx: TransformCtx) => {
            const d = n.data as { callee: Node; arguments: Node[]; typeArguments: Node | null };
            const args = d.arguments;
            // `new Object()`/`new Array()` → `{}`/`[]` — ONLY with zero args. `new Array(5)` builds a
            // length-5 array (NOT `[]`), and `new Object(x)` boxes/returns `x`, so ANY argument bails.
            if (args.length === 0) {
                if (isGlobalRef(d.callee, 'Object')) {
                    ctx.replaceWith(create.ObjectExpression(n.start, n.end, 0, []));
                    return;
                }
                if (isGlobalRef(d.callee, 'Array')) {
                    ctx.replaceWith(create.ArrayExpression(n.start, n.end, 0, []));
                    return;
                }
            }
            // `new Error(…)` → `Error(…)`: same instance without `new`. Args (incl. spreads) carry over
            // verbatim into the call, so no arity reasoning is needed here.
            if (d.callee.type === N.IdentifierReference && d.callee.sym === 0 && ERROR_CTORS.has(d.callee.name)) {
                ctx.replaceWith(create.CallExpression(n.start, n.end, 0, d.callee, args, d.typeArguments));
            }
        },
        // `Boolean(x)` → `!!x` (global `Boolean`, EXACTLY one non-spread argument). `Boolean(a, b)`
        // ignores `b`, but we conservatively bail on any arity ≠ 1; a spread `Boolean(...xs)` has
        // unknown arity, so it bails too; and an optional call `Boolean?.(x)` is left alone.
        [N.CallExpression]: (n, ctx: TransformCtx) => {
            const d = n.data as { callee: Node; arguments: Node[]; optional: boolean };
            // `Math.pow(a, b)` → `a ** b` (oxc `replace_known_methods`; terser/esbuild do the same).
            // Gated on the GLOBAL `Math` (`sym === 0`), a non-optional `.pow`, and exactly two plain
            // arguments. The printer already parenthesises a unary/lower-precedence left operand
            // (`(-2) ** 2`) and honours right-associativity, so the swap is safe in every context.
            // CAVEAT (matches oxc/terser/esbuild): for BigInt operands the two differ — `Math.pow`
            // coerces with ToNumber and throws, while `**` is defined for BigInt. Code relying on
            // `Math.pow` THROWING for a BigInt is already broken, so this follows the established
            // minifier behaviour rather than adding an unprovable type guard.
            if (!d.optional && d.arguments.length === 2 && d.callee.type === N.StaticMemberExpression) {
                const m = d.callee.data as { object: Node; property: Node; optional: boolean };
                const [base, exp] = d.arguments;
                if (
                    !m.optional &&
                    m.property.name === 'pow' &&
                    isGlobalRef(m.object, 'Math') &&
                    base.type !== N.SpreadElement &&
                    exp.type !== N.SpreadElement
                ) {
                    ctx.replaceWith(create.BinaryExpression(n.start, n.end, '**', base, exp));
                    return;
                }
            }
            if (d.optional || d.arguments.length !== 1 || !isGlobalRef(d.callee, 'Boolean')) return;
            const arg = d.arguments[0];
            if (arg.type === N.SpreadElement) return;
            // `!!x` — inner `!` then outer `!`; the printer parenthesizes the argument as needed.
            ctx.replaceWith(UnaryExpression(n.start, n.end, OP.NOT, UnaryExpression(arg.start, arg.end, OP.NOT, arg)));
        },
        // `return undefined;` / `return void 0;` → `return;` — a ReturnStatement whose argument is the
        // undefined value yields the same completion value with the argument dropped. (An implicit
        // `return;` is already argument-less, so there is nothing to do in that case.)
        [N.ReturnStatement]: (n, _ctx: TransformCtx) => {
            const d = n.data as { argument: Node | null };
            if (d.argument !== null && isUndefinedValue(d.argument)) d.argument = null;
        },
    }),
    exit: null,
};
