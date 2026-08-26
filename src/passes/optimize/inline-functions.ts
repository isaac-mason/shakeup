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
import { lookupValue, type Semantic, scopeOf } from '../../analysis/semantic.ts';
import { cloneNode, N, type Node, node, walk, walkChildren } from '../../ast.ts';
import { attachScopeNode, cloneSemanticSubtree, createScope, declareLocal, SCOPE, SYM } from '../../analysis/semantic.ts';
import * as create from '../../parser/create.ts';
import { VAR_KIND } from '../../parser/create.ts';
import { applyRefDelta, hookTable, type RefDelta, type TransformCtx, traverse, type Visitor } from '../traverse.ts';
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

/** Give the nodes `block-mutate` SYNTHESIZED their scopes and symbols.
 *
 *  `block-mutate` is a pure AST builder with no `Semantic`: it mints the wrapper `BlockStatement`, the
 *  `let <result>;` prologue and the `ref(name)` reads as plain nodes — blocks with no `scopeId`, and
 *  identifiers with `sym === 0`. To the verifier that reads as "scope-owning node has no scopeId" and
 *  "'_r0' unbound in maintained, bound in truth", both UNSAFE: unbound in the table is the direction
 *  where a live symbol looks dead and `dropUnused` deletes a declaration still in use.
 *
 *  Binding by NAME is safe here precisely because these names are freshly minted and unique
 *  (`freshName` -> `_r{seq}` / `_L{seq}`), and only identifiers still carrying `sym === 0` are touched —
 *  a reference to something OUTER legitimately has no symbol and must keep it. Two passes, because a
 *  reference can appear before its binding. */
function bindSynthesized(sem: Semantic, root: Node, scope: number): void {
    const minted = new Map<string, number>();
    const declare = (n: Node, sc: number): void => {
        const own = (n.data as { scopeId?: number } | null)?.scopeId ?? 0;
        let inner = sc;
        if (own === 0 && SCOPE_OWNERS.has(n.type)) {
            inner = createScope(sem, sc, SCOPE.BLOCK);
            attachScopeNode(sem, inner, n);
        } else if (own !== 0) {
            inner = own;
        }
        if (n.type === N.BindingIdentifier && (n as { sym: number }).sym === 0 && n.name !== '') {
            minted.set(n.name, declareLocal(sem, n, inner, SYM.LET));
        }
        walkChildren(n, (c) => {
            declare(c, inner);
        });
    };
    declare(root, scope);

    if (minted.size === 0) return;
    const stamp = (n: Node): void => {
        if (n.type === N.IdentifierReference && (n as { sym: number }).sym === 0) {
            const sym = minted.get(n.name);
            if (sym !== undefined) (n as { sym: number }).sym = sym;
        }
        walkChildren(n, stamp);
    };
    stamp(root);
}

/** Node types that OWN a lexical scope and so need one minted when synthesized. */
const SCOPE_OWNERS = new Set<number>([N.BlockStatement, N.StaticBlock]);

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
        // `block-mutate` mutates its input in place, so every splice gets its own copy — and each copy
        // needs its OWN scopes and symbols. `cloneNode` clears `scopeId` and copies `sym`, so without
        // this every inlined copy of a callee shares one binding per local with the original and with
        // every other call site: "no scopeId in maintained" plus "symbol partition mismatch", both
        // UNSAFE. Done here, before `block-mutate` rewrites the statements, while the clone still
        // pairs structurally with its source.
        bodyStmts: cand.body.map((st) => {
            const copy = cloneNode(st) as Node;
            cloneSemanticSubtree(sem, st, copy, scope);
            return copy;
        }),
        params: cand.paramNames.slice(0, Math.max(args.length, 0)),
        args: args.map((a) => cloneNode(a) as Node),
        label,
        resultName: result,
        needsResult: resultName !== null,
    });
    bindSynthesized(sem, out.block, scope);
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
        const scope = scopeOf(semantic, n) || ctx.currentScope;
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
    // Thread a `RefDelta`: without one, `ctx.dropRefs`/`addRefs` are NO-OPS, so references this pass
    // moves never reach the maintained counts. That is the UNDER-count direction — a live symbol looks
    // dead and `dropUnused` deletes a declaration still in use — invisible today only because the
    // optimize tier is followed by a full rebuild.
    const delta = new Map<number, RefDelta>();
    const changed = traverse(program, semantic, [visitor], delta);
    applyRefDelta(semantic, delta);
    return changed;
}

// ── Cross-module `@inline` ──────────────────────────────────────────────────────────────────────
//
// A call to an `@inline` function IMPORTED from another module. compilecat implements this by
// re-reading the donor file as a plugin; shakeup does not need to — after `link` the donor is already
// parsed, analysed and bound, so the donor body is simply there to be read.
//
// THE CROSS-MODULE HYGIENE PROBLEM, and the v1 answer: a free variable in the donor body refers to a
// binding in the DONOR's module scope, which generally does not exist in the consumer — splicing the
// body across the boundary would produce a dangling reference. compilecat solves the general case by
// dragging the donor's dependencies along with it. Here we take the sound subset: a donor is eligible
// only when every free variable is a GLOBAL (unresolved in the donor), and each of those still
// resolves to a global at the call site. That covers the self-contained helper — the shape `@inline`
// is written for — and refuses everything else rather than emitting a broken reference.

/** Candidates exported by one module, keyed by the symbol they are bound to in THAT module. */
export function moduleInlineCandidates(program: Node, source: string): Map<number, Candidate> {
    const spans = directiveSpans(source, program, DIRECTIVE.INLINE);
    if (spans.size === 0) return new Map();
    return collectCandidates(program, spans).direct;
}

/** True when every free variable of `cand` is a global in the donor — the only shape that can move
 *  between modules without carrying its dependencies. */
const freeVarsAllGlobal = (cand: Candidate): boolean => {
    for (const sym of cand.free.values()) if (sym !== 0) return false;
    return true;
};

/**
 * Inline calls to `@inline` functions imported from another module, across the whole graph.
 * Returns consumer module index → the DONOR modules it inlined from: the consumer's AST now depends
 * on another module's source, which the parse cache cannot see on its own.
 */
export function inlineCrossModule(
    modules: readonly { program: Node; semantic: Semantic; source: string; namedImports: ReadonlyMap<number, unknown> }[],
    resolveImport: (moduleIdx: number, sym: number) => { mod: number; sym: number } | null,
): Map<number, Set<number>> {
    // Donor candidates per module, built lazily — most modules annotate nothing.
    const donorCache = new Map<number, Map<number, Candidate>>();
    const donorsOf = (idx: number): Map<number, Candidate> => {
        let c = donorCache.get(idx);
        if (c === undefined) {
            c = moduleInlineCandidates(modules[idx].program, modules[idx].source);
            donorCache.set(idx, c);
        }
        return c;
    };

    const changed = new Map<number, Set<number>>();
    for (let idx = 0; idx < modules.length; idx++) {
        const mod = modules[idx];
        const producers = new Set<number>();
        const visitor: Visitor = {
            name: 'inlineCrossModule',
            enter: null,
            exit: hookTable({
                [N.CallExpression]: (n: Node, ctx: TransformCtx) => {
                    const d = n.data as { callee: Node; arguments: Node[]; optional: boolean };
                    if (d.optional || d.callee.type !== N.IdentifierReference) return;
                    const localSym = (d.callee as { sym: number }).sym;
                    if (localSym <= 0 || !mod.namedImports.has(localSym)) return; // only imported callees
                    const target = resolveImport(idx, localSym);
                    if (target === null || target.mod === idx) return;
                    const cand = donorsOf(target.mod).get(target.sym);
                    if (cand === undefined || !freeVarsAllGlobal(cand)) return;
                    // Argument gates are the same as the local case; hygiene reduces to "each free
                    // name is still a global here", which `callIsInlinable` checks via `lookupValue`.
                    if (!callIsInlinable(cand, d.arguments, ctx.currentScope, mod.semantic)) return;
                    producers.add(target.mod);
                    ctx.replaceWith(substitute(cand, d.arguments));
                },
            }),
        };
        // Do not traverse a module that CANNOT contain an inlinable call. The hook only ever fires on
        // a call whose callee is a named import resolving to an `@inline` donor in another module, and
        // that is decidable in O(imports) from tables we already hold — whereas the traversal it
        // guards is O(nodes) and, on a graph with no `@inline` at all, finds nothing in any module.
        // Counting traversals rather than reading a profile is what surfaced this: it was 1 of the 12
        // whole-program walks a three.core.js build performed, and that file imports nothing.
        let reachesDonor = false;
        for (const localSym of mod.namedImports.keys()) {
            const target = resolveImport(idx, localSym);
            if (target !== null && target.mod !== idx && donorsOf(target.mod).has(target.sym)) {
                reachesDonor = true;
                break;
            }
        }
        if (!reachesDonor) continue;
        if (traverse(mod.program, mod.semantic, [visitor])) changed.set(idx, producers);
    }
    return changed;
}
