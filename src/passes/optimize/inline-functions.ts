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
import { cloneNode, N, type Node, node, walk } from '../../ast.ts';
import * as create from '../../parser/create.ts';
import { VAR_KIND } from '../../parser/create.ts';
import { hookTable, type TransformCtx, traverse, type Visitor } from '../traverse.ts';
import { mutateForBlockInline } from './block-mutate.ts';
import { DIRECTIVE, directiveSpans } from './directives.ts';

/** A callee whose body is spliced as a STATEMENT (any body, including interior returns). */
type BlockCandidate = {
    sym: number;
    paramSyms: number[];
    paramNames: string[];
    /** Body statements, kept in the tree; cloned per splice because `block-mutate` mutates in place. */
    body: Node[];
    free: Map<string, number>;
};

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

/** Statements a spliced body must not contain: `try`/`with` change control flow in ways the mutator's
 *  `break LABEL` rewrite does not model, and `await`/`yield` belong to the callee's own context. */
function hasUnsupportedConstruct(stmts: readonly Node[]): boolean {
    let bad = false;
    for (const s of stmts) {
        walk(s, (n) => {
            if (bad) return false;
            if (isFn(n)) return false; // a nested function keeps its own constructs
            if (
                n.type === N.TryStatement ||
                n.type === N.AwaitExpression ||
                n.type === N.YieldExpression
            ) {
                bad = true;
            }
            return undefined;
        });
        if (bad) return true;
    }
    return false;
}

/** Build a BLOCK candidate — any body the mutator can splice — or `null` when ineligible. */
function classifyBlock(fn: Node, sym: number): BlockCandidate | null {
    const d = fn.data as { params: Node[]; body: Node | null; async?: boolean; generator?: boolean };
    if (d.async === true || d.generator === true) return null;
    const paramSyms = simpleParamSyms(d.params);
    if (paramSyms === null) return null;
    const body = d.body;
    if (body === null || body.type !== N.BlockStatement) return null;
    const stmts = (body.data as { body: Node[] }).body;
    if (hasUnsupportedConstruct(stmts)) return null;

    const paramNames = d.params.map((p) => ((p.data as { pattern: Node }).pattern).name);
    // Symbols BOUND inside the body are not free variables — they travel with the spliced code. Without
    // this, `const t = a * 2; return t;` would report `t` as free and the call-site hygiene check would
    // refuse every body that declares anything.
    const locals = new Set<number>();
    for (const st of stmts) {
        walk(st, (n) => {
            if (n.type === N.BindingIdentifier) {
                const b = (n as { sym: number }).sym;
                if (b > 0) locals.add(b);
            }
            return undefined;
        });
    }
    const free = new Map<string, number>();
    let bad = false;
    for (const st of stmts) {
        walk(st, (n) => {
            if (bad) return false;
            if (n.type === N.ThisExpression) {
                bad = true; // `this` re-binds at the call site
                return false;
            }
            if (n.type !== N.IdentifierReference) return undefined;
            if (n.name === 'arguments') {
                bad = true;
                return false;
            }
            const s = (n as { sym: number }).sym;
            if (s !== 0 && (paramSyms.includes(s) || locals.has(s))) return undefined;
            if (s === sym) {
                bad = true; // recursive
                return false;
            }
            free.set(n.name, s);
            return undefined;
        });
        if (bad) return null;
    }
    return { sym, paramSyms, paramNames, body: stmts, free };
}

/** Collect `@inline`-annotated candidates, keyed by their binding symbol. */
function collectCandidates(program: Node, spans: ReadonlySet<number>): Candidates {
    const out: Candidates = { direct: new Map(), block: new Map() };
    /** DIRECT is preferred (it produces an expression); BLOCK is the fallback for any other body. */
    const add = (fn: Node, sym: number): void => {
        const d = classifyDirect(fn, sym);
        if (d !== null) {
            out.direct.set(sym, d);
            return;
        }
        const b = classifyBlock(fn, sym);
        if (b !== null) out.block.set(sym, b);
    };
    walk(program, (n) => {
        if (n.type === N.FunctionDeclaration && spans.has(n.start)) {
            const id = (n.data as { id: Node | null }).id;
            if (id !== null) add(n, (id as { sym: number }).sym);
            return undefined;
        }
        // `/* @inline */ const f = (a) => …` — the directive attaches to the declaration.
        if (n.type !== N.VariableDeclaration || !spans.has(n.start)) return undefined;
        const vd = n.data as { kind: string; declarations: Node[] };
        if (vd.kind !== 'const') return undefined; // a rebindable holder is not a stable target
        for (const decl of vd.declarations) {
            const d = decl.data as { id: Node; init: Node | null };
            if (d.init === null || !isFn(d.init) || d.id.type !== N.BindingIdentifier) continue;
            add(d.init, (d.id as { sym: number }).sym);
        }
        return undefined;
    });
    return out;
}

type Candidates = { direct: Map<number, Candidate>; block: Map<number, BlockCandidate> };

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

/** A name not bound at `scope` (and not one of `avoid`), for the result temp and the break label. */
function freshName(sem: Semantic, scope: number, prefix: string, seq: number, avoid: readonly string[]): string {
    for (let i = seq; ; i++) {
        const name = `${prefix}${i}`;
        if (lookupValue(sem, scope, name) === 0 && !avoid.includes(name)) return name;
    }
}

/** Gates common to a BLOCK splice at `scope`. */
function blockIsInlinable(cand: BlockCandidate, args: readonly Node[], scope: number, sem: Semantic): boolean {
    if (args.length > cand.paramSyms.length) return false; // extra args must still be evaluated
    for (const a of args) if (a.type === N.SpreadElement) return false;
    // An argument that READS a parameter's name would hit the prologue binding's TDZ
    // (`const a = a`). compilecat α-renames here; refusing is the sound, simpler answer.
    for (const a of args) {
        let clash = false;
        walk(a, (n) => {
            if (n.type === N.IdentifierReference && cand.paramNames.includes(n.name)) clash = true;
            return clash ? false : undefined;
        });
        if (clash) return false;
    }
    for (const [name, sym] of cand.free) if (lookupValue(sem, scope, name) !== sym) return false;
    return true;
}

/** The spliced statement for one call, or `null` when refused. `resultName` is `null` in statement
 *  position (the value is discarded). */
function buildSplice(
    cand: BlockCandidate,
    args: readonly Node[],
    scope: number,
    sem: Semantic,
    resultName: string | null,
    seq: number,
): Node | null {
    if (!blockIsInlinable(cand, args, scope, sem)) return null;
    const avoid = cand.paramNames;
    const label = freshName(sem, scope, '_L', seq, avoid);
    const result = resultName ?? freshName(sem, scope, '_r', seq, avoid);
    const out = mutateForBlockInline({
        // `block-mutate` mutates its input in place, so every splice gets its own copy.
        bodyStmts: cand.body.map((st) => cloneNode(st) as Node),
        params: cand.paramNames.slice(0, Math.max(args.length, 0)),
        args: args.map((a) => cloneNode(a) as Node),
        label,
        resultName: result,
        needsResult: resultName !== null,
    });
    return out.block;
}

/** `let <name>;` */
const letDecl = (name: string): Node =>
    create.VariableDeclaration(0, 0, VAR_KIND.LET, [
        create.VariableDeclarator(0, 0, 0, node(N.BindingIdentifier, 0, 0, name, null), null, null),
    ]);

/** The call a statement shape wraps, plus where its result must land. */
function callOf(expr: Node): Node | null {
    return expr.type === N.CallExpression ? expr : null;
}

/**
 * Inline calls to `@inline`-annotated functions. Returns whether anything changed.
 * The now-unreferenced declaration is left for `drop-unused`/treeshake to remove.
 */
export function inlineFunctions(program: Node, semantic: Semantic, source: string): boolean {
    const spans = directiveSpans(source, program, DIRECTIVE.INLINE);
    if (spans.size === 0) return false;
    const cands = collectCandidates(program, spans);
    if (cands.direct.size === 0 && cands.block.size === 0) return false;

    let seq = 0;
    /** The BLOCK candidate a call resolves to, if any. */
    const blockFor = (call: Node): BlockCandidate | undefined => {
        const d = call.data as { callee: Node; optional: boolean };
        if (d.optional || d.callee.type !== N.IdentifierReference) return undefined;
        return cands.block.get((d.callee as { sym: number }).sym);
    };
    const argsOf = (call: Node): Node[] => (call.data as { arguments: Node[] }).arguments;

    /** Splice `const x = f(args);` declarations found directly in a statement list. */
    const listHook = (n: Node, ctx: TransformCtx): void => {
        const field = n.type === N.SwitchCase ? 'consequent' : 'body';
        const list = (n.data as Record<string, Node[]>)[field];
        if (!Array.isArray(list)) return;
        // Statements in this container live in the container's OWN scope, not the enclosing one.
        const scope = semantic.nodeScope.get(n) ?? ctx.currentScope;
        for (let i = 0; i < list.length; i++) {
            const st = list[i];
            if (st.type !== N.VariableDeclaration) continue;
            const vd = st.data as { declarations: Node[] };
            if (vd.declarations.length !== 1) continue;
            const d = vd.declarations[0].data as { id: Node; init: Node | null };
            if (d.init === null || d.id.type !== N.BindingIdentifier) continue;
            const call = callOf(d.init);
            if (call === null) continue;
            const cand = blockFor(call);
            if (cand === undefined) continue;
            const name = d.id.name;
            const block = buildSplice(cand, argsOf(call), scope, semantic, name, seq++);
            if (block === null) continue;
            list.splice(i, 1, letDecl(name), block);
            i++; // skip the block we just inserted
            ctx.changed = true;
        }
    };

    const visitor: Visitor = {
        name: 'inlineFunctions',
        // BLOCK splices happen on ENTER at the STATEMENT level: the body becomes a statement, so it
        // can only replace a call sitting in one of the three shapes below.
        enter: hookTable({
            [N.ExpressionStatement]: (n: Node, ctx: TransformCtx) => {
                const expr = (n.data as { expression: Node }).expression;
                // `f(args);` — the value is discarded.
                const bare = callOf(expr);
                if (bare !== null) {
                    const cand = blockFor(bare);
                    if (cand === undefined) return;
                    const block = buildSplice(cand, argsOf(bare), ctx.currentScope, semantic, null, seq++);
                    if (block !== null) ctx.replaceWith(block);
                    return;
                }
                // `x = f(args);` — assign straight into the existing binding.
                if (expr.type !== N.AssignmentExpression) return;
                const a = expr.data as { operator: string; left: Node; right: Node };
                if (a.operator !== '=' || a.left.type !== N.IdentifierReference) return;
                const call = callOf(a.right);
                if (call === null) return;
                const cand = blockFor(call);
                if (cand === undefined) return;
                const block = buildSplice(cand, argsOf(call), ctx.currentScope, semantic, a.left.name, seq++);
                if (block !== null) ctx.replaceWith(block);
            },
            // `const x = f(args);` → `let x; { …; x = … }`. Handled on the enclosing statement LIST
            // rather than on the declaration: the rewrite produces TWO statements, which a
            // single-child slot (`export const x = f()`, a `for` initialiser) cannot hold. Working on
            // the list also means such a slot is simply skipped rather than throwing.
            [N.Program]: listHook,
            [N.BlockStatement]: listHook,
            [N.StaticBlock]: listHook,
            [N.SwitchCase]: listHook,
        }),
        // DIRECT replaces the call expression itself, on EXIT so a nested `@inline` argument is
        // already inlined by the time this fires.
        exit: hookTable({
            [N.CallExpression]: (n: Node, ctx: TransformCtx) => {
                const d = n.data as { callee: Node; arguments: Node[]; optional: boolean };
                if (d.optional || d.callee.type !== N.IdentifierReference) return;
                const cand = cands.direct.get((d.callee as { sym: number }).sym);
                if (cand === undefined) return;
                if (!callIsInlinable(cand, d.arguments, ctx.currentScope, semantic)) return;
                ctx.replaceWith(substitute(cand, d.arguments));
            },
        }),
    };
    return traverse(program, semantic, [visitor]);
}
