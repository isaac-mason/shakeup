// inline-functions (DIRECT strategy) — replace a call to an `@inline`-annotated function with its
// body. Port of the DIRECT half of compilecat `passes/inline_functions.rs` (Closure `InlineFunctions`
// / `FunctionInjector`).
//
//   /* @inline */ function add(a, b) { return a + b; }
//   const x = add(p, 2);            →   const x = p + 2;
//
// DIRECT handles a body that is a single `return <expr>`. BLOCK — any other body, including one with
// interior `return`s — is spliced through `block-mutate` and lands next; the two share candidate
// collection.
//
// ── The four conditions, and why each is a correctness requirement, not a nicety ────────────────
//
//  1. ELIGIBILITY. Not async/generator (the call's value is a promise/iterator, not the body's);
//     simple identifier parameters (a pattern needs destructuring semantics we would have to
//     reproduce); no `this`/`arguments` (both re-bind at the call site); and not recursive — a
//     self-referencing body would expand forever, so it is refused rather than partially expanded.
//
//  2. ARGUMENT DUPLICATION. Substituting an argument expression for a parameter used TWICE evaluates
//     it twice. `add(next(), 1)` with `a + a` would call `next()` twice. So a parameter used more than
//     once accepts only a SIMPLE argument (identifier / literal / `this`), which is free to duplicate.
//
//  3. DROPPED EFFECTS. A parameter used ZERO times discards its argument — fine for a literal, a
//     miscompile for `f(sideEffect())`. Refused unless the argument is provably pure.
//
//  4. HYGIENE. A free variable in the body must resolve to the SAME binding at the call site. Splicing
//     `return scale * x` into a scope that has its own `scale` would silently re-bind it, so every free
//     variable is re-resolved with `lookupValue` at the call site and the inline is refused on any
//     mismatch. This also covers globals (`Math`), which a local binding at the call site can shadow.
import { isPureExpr } from '../../analysis/effects.ts';
import { lookupValue, type Semantic } from '../../analysis/semantic.ts';
import { cloneNode, N, type Node, walk } from '../../ast.ts';
import { hookTable, type TransformCtx, traverse, type Visitor } from '../traverse.ts';
import { DIRECTIVE, directiveSpans } from './directives.ts';

type Candidate = {
    /** Symbol of the function binding, so call sites match by binding rather than by name. */
    sym: number;
    /** Parameter binding symbols, in order. */
    paramSyms: number[];
    /** The returned expression (kept in the tree; cloned per call site). */
    value: Node;
    /** Free variables of `value`: name → the symbol it resolved to where the function was DEFINED. */
    free: Map<string, number>;
    /** How many times each parameter is read in `value`. */
    uses: number[];
};

const isFn = (n: Node): boolean =>
    n.type === N.FunctionDeclaration || n.type === N.FunctionExpression || n.type === N.ArrowFunctionExpression;

/** An argument that is free to duplicate and free to drop. */
const isSimpleArg = (n: Node): boolean =>
    n.type === N.IdentifierReference ||
    n.type === N.NumericLiteral ||
    n.type === N.StringLiteral ||
    n.type === N.BooleanLiteral ||
    n.type === N.NullLiteral ||
    n.type === N.ThisExpression;

/** Parameter binding symbols, or `null` if any parameter is not a plain identifier. */
function simpleParamSyms(params: readonly Node[]): number[] | null {
    const out: number[] = [];
    for (const p of params) {
        const pattern = (p.data as { pattern: Node; init: Node | null }).pattern;
        if (pattern.type !== N.BindingIdentifier) return null;
        if ((p.data as { init: Node | null }).init !== null) return null; // default value → not simple
        out.push((pattern as { sym: number }).sym);
    }
    return out;
}

/** The single `return <expr>` of a DIRECT-eligible body, else `null`. */
function directValue(fn: Node): Node | null {
    const d = fn.data as { body: Node | null; async?: boolean; generator?: boolean; expression?: boolean };
    if (d.async === true || d.generator === true) return null;
    const body = d.body;
    if (body === null) return null;
    // An expression-bodied arrow (`(a) => a + 1`) is already the value.
    if (body.type !== N.BlockStatement) return body;
    const stmts = (body.data as { body: Node[] }).body;
    if (stmts.length !== 1 || stmts[0].type !== N.ReturnStatement) return null;
    return (stmts[0].data as { argument: Node | null }).argument;
}

/** `this` / `arguments` re-bind at the call site, so a body reading either cannot move. */
function readsThisOrArguments(value: Node): boolean {
    let hit = false;
    walk(value, (n) => {
        if (hit) return false;
        if (isFn(n)) return false; // a nested function has its own `this`/`arguments`
        if (n.type === N.ThisExpression) hit = true;
        else if (n.type === N.IdentifierReference && n.name === 'arguments') hit = true;
        return undefined;
    });
    return hit;
}

/** Build a candidate from a function node bound to `sym`, or `null` when ineligible. */
function classifyDirect(fn: Node, sym: number): Candidate | null {
    const params = (fn.data as { params: Node[] }).params;
    const paramSyms = simpleParamSyms(params);
    if (paramSyms === null) return null;
    const value = directValue(fn);
    if (value === null || readsThisOrArguments(value)) return null;

    const uses = new Array<number>(paramSyms.length).fill(0);
    const free = new Map<string, number>();
    let recursive = false;
    walk(value, (n) => {
        if (n.type !== N.IdentifierReference) return undefined;
        const s = (n as { sym: number }).sym;
        const idx = paramSyms.indexOf(s);
        if (s !== 0 && idx !== -1) {
            uses[idx]++;
            return undefined;
        }
        if (s === sym) recursive = true; // self-reference → would expand forever
        free.set(n.name, s);
        return undefined;
    });
    if (recursive) return null;
    return { sym, paramSyms, value, free, uses };
}

/** Collect `@inline`-annotated candidates, keyed by their binding symbol. */
function collectCandidates(program: Node, spans: ReadonlySet<number>): Map<number, Candidate> {
    const out = new Map<number, Candidate>();
    walk(program, (n) => {
        if (n.type === N.FunctionDeclaration && spans.has(n.start)) {
            const id = (n.data as { id: Node | null }).id;
            if (id !== null) {
                const c = classifyDirect(n, (id as { sym: number }).sym);
                if (c !== null) out.set(c.sym, c);
            }
            return undefined;
        }
        // `/* @inline */ const f = (a) => …` — the directive attaches to the declaration.
        if (n.type !== N.VariableDeclaration || !spans.has(n.start)) return undefined;
        const vd = n.data as { kind: string; declarations: Node[] };
        if (vd.kind !== 'const') return undefined; // a rebindable holder is not a stable target
        for (const decl of vd.declarations) {
            const d = decl.data as { id: Node; init: Node | null };
            if (d.init === null || !isFn(d.init) || d.id.type !== N.BindingIdentifier) continue;
            const c = classifyDirect(d.init, (d.id as { sym: number }).sym);
            if (c !== null) out.set(c.sym, c);
        }
        return undefined;
    });
    return out;
}

/** Whether this call site may take `cand`, given its arguments and the scope it sits in. */
function callIsInlinable(cand: Candidate, args: readonly Node[], scope: number, sem: Semantic): boolean {
    if (args.length > cand.paramSyms.length) return false; // extra args still evaluate — keep the call
    for (const a of args) if (a.type === N.SpreadElement) return false;
    for (let i = 0; i < args.length; i++) {
        const uses = cand.uses[i];
        if (uses > 1 && !isSimpleArg(args[i])) return false; // would evaluate the argument twice
        if (uses === 0 && !isPureExpr(args[i])) return false; // would discard its side effect
    }
    // Hygiene: every free variable must still resolve to the binding it had where the body was written.
    for (const [name, sym] of cand.free) {
        if (lookupValue(sem, scope, name) !== sym) return false;
    }
    return true;
}

/** A clone of `cand.value` with parameter references replaced by the matching arguments. */
function substitute(cand: Candidate, args: readonly Node[]): Node {
    return cloneNode(cand.value, (n) => {
        if (n.type !== N.IdentifierReference) return null;
        const idx = cand.paramSyms.indexOf((n as { sym: number }).sym);
        if (idx === -1) return null;
        const arg = args[idx];
        // A parameter with no matching argument is `undefined`; reuse the node shape by cloning a
        // fresh reference to the global `undefined`.
        return arg === undefined ? null : (cloneNode(arg) as Node);
    }) as Node;
}

/**
 * Inline calls to `@inline`-annotated functions. Returns whether anything changed.
 * The now-unreferenced declaration is left for `drop-unused`/treeshake to remove.
 */
export function inlineFunctions(program: Node, semantic: Semantic, source: string): boolean {
    const spans = directiveSpans(source, program, DIRECTIVE.INLINE);
    if (spans.size === 0) return false;
    const candidates = collectCandidates(program, spans);
    if (candidates.size === 0) return false;

    const visitor: Visitor = {
        name: 'inlineFunctions',
        enter: null,
        // EXIT so arguments are themselves inlined first (an `@inline` call passed to another).
        exit: hookTable({
            [N.CallExpression]: (n: Node, ctx: TransformCtx) => {
                const d = n.data as { callee: Node; arguments: Node[]; optional: boolean };
                if (d.optional || d.callee.type !== N.IdentifierReference) return;
                const cand = candidates.get((d.callee as { sym: number }).sym);
                if (cand === undefined) return;
                if (!callIsInlinable(cand, d.arguments, ctx.currentScope, semantic)) return;
                ctx.replaceWith(substitute(cand, d.arguments));
            },
        }),
    };
    return traverse(program, semantic, [visitor]);
}
