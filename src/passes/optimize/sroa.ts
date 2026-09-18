// sroa — Scalar Replacement of Aggregates, directive-driven. Port of the LITERAL-shape half of
// compilecat `passes/sroa.rs` (`src/compiler/scalar-replace-aggregates.ts`).
//
//   /* @sroa */ const v = [a, b];  … v[0] … v[1] = x
//     →  let v_0 = a, v_1 = b;     … v_0  … v_1  = x
//
//   /* @sroa */ const p = { x: 1, y: 2 };  … p.x …
//     →  let p_x = 1, p_y = 2;             … p_x …
//
// The aggregate never exists at runtime: its fields become plain locals, so the allocation and every
// property lookup disappear.
//
// ── The escape analysis is the whole safety argument ────────────────────────────────────────────
// EVERY reference to the binding must be a constant-index element read/write (tuple) or a known-field
// property read/write (record). One reference that uses the object AS an object — passing it to a
// function, `{...v}`, a dynamic index, returning it, reassigning the binding — means something can
// observe an aggregate that would no longer exist, so the whole rewrite is refused.
//
// Also refused: a reference from inside a NESTED function. The scalars would still be captured
// correctly, but matching compilecat's conservatism keeps the analysis obviously sound.
//
// SCOPE (v1): the shape comes from a literal initialiser, which needs no type information and so runs
// after `tsStrip` like any other pass. compilecat additionally derives shapes from TS type
// annotations (`const v: Vec3 = mk()`) and across modules; that needs the typed AST captured at the
// transform stage and is tracked separately.
import { declareLocal, lookupValue, retireSymbol, type Semantic, scopeOf, SYM } from '../../analysis/semantic.ts';
import { create, N, type Node, node, VAR_KIND, walk } from '../../ast/index.ts';
import { applyRefDelta, hookTable, type RefDelta, type TransformCtx, traverse, type Visitor } from '../traverse.ts';
import { DIRECTIVE, directiveSpans } from './directives.ts';
import { Gate } from './gate.ts';
import type { ShapeTable } from './shapes.ts';

const isFn = (n: Node): boolean =>
    n.type === N.FunctionDeclaration || n.type === N.FunctionExpression || n.type === N.ArrowFunctionExpression;

/** One aggregate approved for replacement. */
type Plan = {
    /** The declaration statement to replace. */
    decl: Node;
    /** Field key (`"0"`, `"x"`) → the scalar binding name that replaces it. */
    names: Map<string, string>;
    /** Field key → its initialiser expression, in declaration order. Empty in `destructure` mode. */
    inits: [string, Node][];
    /** `literal` splits a literal into scalars; `destructure` binds the fields off an opaque value. */
    mode: 'literal' | 'destructure';
    /** The opaque initialiser, in `destructure` mode. */
    source: Node | null;
    /** Field order for `destructure` mode. */
    fields: string[];
    /** Member expressions to rewrite → the FIELD KEY they name. The key, not the scalar name: the
     *  name is shared across plans whenever two buffers in different scopes are called the same
     *  thing, and the symbol has to be looked up per plan. */
    fieldOf: Map<Node, string>;
    /** The REPLACED buffer's own symbol. Its declaration is gone once the plan is applied, so the
     *  binding has to be retired — otherwise the maintained table keeps counting it live and starts
     *  minting different names from a rebuilt one ("EXTRAS(safe)"). */
    sym: number;
    /** The scope the scalars are DECLARED into: the owner function's for a localized buffer, the
     *  declaration's own otherwise. */
    scope: number;
    /** Field key → the BindingIdentifier minted for its scalar, and the symbol it was declared with.
     *  Both are minted BEFORE the rewriting traversal, because a function written above the buffer is
     *  visited before the declaration is and its reads must already have a symbol to name.
     *  Per-plan, because the NAME is not unique: two buffers called `_m` in different scopes both
     *  mint `_m_0`, and a name-keyed table books one plan's references against the other's binding. */
    syms: Map<string, number>;
    ids: Map<string, Node>;
    /** For a MODULE-SCOPE buffer: the single function the scalars are moved into. `null` for a
     *  declaration that is already function-local and stays where it is. */
    owner: Node | null;
};

/** Field keys of a literal initialiser in order, or `null` when the shape is not statically known. */
function literalFields(init: Node): [string, Node][] | null {
    if (init.type === N.ArrayExpression) {
        const els = (init.data as { elements: (Node | null)[] }).elements;
        const out: [string, Node][] = [];
        for (let i = 0; i < els.length; i++) {
            const el = els[i];
            if (el === null || el.type === N.SpreadElement) return null; // hole / spread → unknown shape
            out.push([String(i), el]);
        }
        return out;
    }
    if (init.type !== N.ObjectExpression) return null;
    const props = (init.data as { properties: Node[] }).properties;
    const out: [string, Node][] = [];
    const seen = new Set<string>();
    for (const p of props) {
        if (p.type !== N.ObjectProperty) return null; // spread / method
        const d = p.data as { key: Node; value: Node; computed: boolean; kind: string };
        if (d.computed || d.kind !== 'init') return null; // computed key / getter / setter
        const key = d.key.type === N.IdentifierName || d.key.type === N.StringLiteral ? d.key.name : null;
        if (key === null || seen.has(key)) return null;
        seen.add(key);
        out.push([key, d.value]);
    }
    return out;
}

/** The field key a member expression reads off `v`, or `null` if it is not a fixed field. */
function memberKey(m: Node): string | null {
    if (m.type === N.StaticMemberExpression) {
        const d = m.data as { property: Node; optional: boolean };
        return d.optional ? null : d.property.name;
    }
    if (m.type !== N.ComputedMemberExpression) return null;
    const d = m.data as { expression: Node; optional: boolean };
    if (d.optional || d.expression.type !== N.NumericLiteral) return null;
    const i = Number(d.expression.name);
    return Number.isInteger(i) && i >= 0 ? String(i) : null;
}

/** A scalar name for `base.field` that is not already bound at `scope`. */
function scalarName(sem: Semantic, scope: number, base: string, field: string): string {
    const stem = `${base}_${field}`;
    if (lookupValue(sem, scope, stem) === 0) return stem;
    for (let i = 2; ; i++) {
        const candidate = `${stem}${i}`;
        if (lookupValue(sem, scope, candidate) === 0) return candidate;
    }
}

/**
 * Every field READ in `fn` is preceded by an unconditional WRITE of that field.
 *
 * The question localization turns on: does the buffer carry anything between calls? If each field is
 * filled before it is read, the value the last call left is never observed and the buffer can become
 * per-call locals. If a read can be reached first, it can, and the buffer has to stay where it is.
 *
 * Deliberately crude, and conservative in the safe direction: only a write sitting at the TOP LEVEL of
 * the function body counts, because that is the only place a write is unconditionally reached. A write
 * inside an `if` or a loop proves nothing about the path that skips it, so it is not counted — and a
 * read it would have covered refuses the whole rewrite rather than guessing.
 */
function writesPrecedeReads(fn: Node, rewrites: ReadonlyMap<Node, string>): boolean {
    const body = (fn.data as { body: Node | null }).body;
    if (body === null || body.type !== N.BlockStatement) return false; // expression-bodied arrow
    let ok = true;
    /** Refuse if `n`'s subtree reads a field not yet written on every path reaching it. */
    const checkReads = (n: Node | null, written: ReadonlySet<string>): void => {
        if (n === null || !ok) return;
        walk(n, (c) => {
            if (!ok) return false;
            const key = rewrites.get(c);
            if (key !== undefined && !written.has(key)) ok = false;
            return undefined;
        });
    };

    /**
     * Statements in order, carrying the fields written on every path to this point.
     *
     * A BARE BLOCK is transparent — it always runs, and it is where an inlined helper's body lands,
     * so refusing to look inside one would refuse every buffer filled by a helper.
     *
     * A CONDITIONAL or a LOOP body gets a COPY of the set, which is the whole point: a write inside it
     * dominates the reads that follow IN THE SAME pass through it, so `for (…) { _m[0] = f(i); use(_m[0]); }`
     * is fine — but the loop may run zero times, so those writes must not satisfy a read AFTER it. The
     * parts that run BEFORE the body (a loop's test, an `if`'s condition) are checked against the outer
     * set, since no write inside the body has happened yet when they are evaluated.
     *
     * Anything else is checked whole against the outer set: unrecognized control flow refuses rather
     * than guesses, which costs an optimisation and never correctness.
     */
    const scan = (list: readonly Node[], written: Set<string>): void => {
        for (const st of list) {
            if (!ok) return;
            const d = st.data as Record<string, Node | Node[] | null>;
            switch (st.type) {
                case N.BlockStatement:
                    scan(d.body as Node[], written);
                    continue;
                case N.IfStatement:
                    checkReads(d.test as Node, written);
                    scan([d.consequent as Node], new Set(written));
                    if (d.alternate !== null) scan([d.alternate as Node], new Set(written));
                    continue;
                case N.ForStatement:
                    checkReads(d.init as Node | null, written);
                    checkReads(d.test as Node | null, written);
                    checkReads(d.update as Node | null, written);
                    scan([d.body as Node], new Set(written));
                    continue;
                case N.WhileStatement:
                    checkReads(d.test as Node, written);
                    scan([d.body as Node], new Set(written));
                    continue;
                case N.DoWhileStatement:
                    checkReads(d.test as Node, written);
                    scan([d.body as Node], new Set(written));
                    continue;
                case N.ForOfStatement:
                case N.ForInStatement:
                    checkReads(d.right as Node, written);
                    scan([d.body as Node], new Set(written));
                    continue;
                case N.ExpressionStatement: {
                    const e = d.expression as Node;
                    if (e.type === N.AssignmentExpression) {
                        const a = e.data as { operator: string; left: Node; right: Node };
                        const key = rewrites.get(a.left);
                        // `_m[0] = rhs` — a plain write. A COMPOUND write (`+=`) reads first, so not one.
                        if (key !== undefined && a.operator === '=') {
                            checkReads(a.right, written);
                            if (!ok) return;
                            written.add(key);
                            continue;
                        }
                    }
                    checkReads(st, written);
                    continue;
                }
                default:
                    checkReads(st, written);
            }
        }
    };
    scan((body.data as { body: Node[] }).body, new Set());
    return ok;
}

/**
 * Approve a declaration for replacement, or return `null`.
 * `declDepth` is the function nesting depth the declaration sits at; a reference from deeper is refused.
 */
function planFor(program: Node, decl: Node, sem: Semantic, scope: number, shapes: ShapeTable): Plan | null {
    const vd = decl.data as { declarations: Node[] };
    if (vd.declarations.length !== 1) return null;
    const d = vd.declarations[0].data as { id: Node; init: Node | null };
    if (d.id.type !== N.BindingIdentifier || d.init === null) return null;
    const sym = (d.id as { sym: number }).sym;
    if (sym <= 0) return null;
    // Shape from the literal initialiser, else from the captured TYPE annotation.
    const fields = literalFields(d.init);
    const typed = fields === null ? (shapes.get(decl.start) ?? null) : null;
    if (fields === null && typed === null) return null;
    const keys = new Set(fields !== null ? fields.map(([k]) => k) : typed!);

    // Every reference must be a fixed-field member access, at the declaration's own function depth.
    const rewrites = new Map<Node, string>();
    const consumed = new Set<Node>();
    let declDepth = -1;
    let depth = 0;
    let ok = true;
    const refs: { n: Node; depth: number }[] = [];
    // The functions a reference was found in, outermost first — enough to tell "all uses sit directly
    // in one function" from "spread across several, or buried in a closure".
    const owners = new Set<Node>();
    let nested = false;
    const fnStack: Node[] = [];
    const visit = (n: Node): boolean | undefined => {
        if (!ok) return false;
        if (n === decl) declDepth = depth;
        if (isFn(n)) {
            depth++;
            fnStack.push(n);
            walk(n, (c) => (c === n ? undefined : visit(c)));
            fnStack.pop();
            depth--;
            return false;
        }
        if (n.type === N.StaticMemberExpression || n.type === N.ComputedMemberExpression) {
            const obj = (n.data as { object: Node }).object;
            if (obj.type === N.IdentifierReference && (obj as { sym: number }).sym === sym) {
                const key = memberKey(n);
                if (key === null || !keys.has(key)) {
                    ok = false; // dynamic index, unknown field, or optional chaining
                    return false;
                }
                consumed.add(obj);
                rewrites.set(n, key);
                if (fnStack.length === 0) ok = false; // a use outside any function — not scratch
                else {
                    owners.add(fnStack[0]);
                    if (fnStack.length > 1) nested = true;
                }
            }
        }
        if (n.type === N.IdentifierReference && (n as { sym: number }).sym === sym) refs.push({ n, depth });
        return undefined;
    };
    walk(program, visit);
    if (!ok || declDepth < 0) return null;
    for (const r of refs) {
        if (!consumed.has(r.n)) return null; // used as a whole object
        // A LOCAL read from a nested function is captured: the scalars replacing it would be locals
        // of the declaring function and invisible to the closure. A MODULE-SCOPE buffer has no such
        // problem — its scalars are module-scope too, with exactly the array's lifetime and
        // visibility — and that is the shape the house style uses for per-call scratch, which is
        // otherwise never scalarized at all.
        if (declDepth > 0 && r.depth !== declDepth) return null;
    }

    // A MODULE-SCOPE buffer is only worth rewriting if its scalars can be LOCALIZED. Left where they
    // are they would be module-scope `let`s — context slots, measured 8.7x slower than the array
    // indexing they replace (`bench/.ab/micro`), so scalarizing in place makes the program worse. The
    // move is sound only when the buffer carries nothing between calls, which needs three things:
    // exactly one owning function, no use from a closure inside it (whose lifetime could outlast the
    // call), and every field read preceded by an unconditional write.
    let owner: Node | null = null;
    if (declDepth === 0) {
        if (fields === null) return null; // an opaque init must keep running once, at module scope
        if (owners.size !== 1 || nested) return null;
        owner = [...owners][0];
        // The scalars are declared into the owner's own scope, so that scope has to be nameable. A
        // synthesized function that never got one cannot receive them.
        if (scopeOf(sem, owner) === 0) return null;
        if (!writesPrecedeReads(owner, rewrites)) return null;
    }

    const names = new Map<string, string>();
    for (const k of keys) names.set(k, scalarName(sem, scope, d.id.name, k));
    return fields !== null
        ? { decl, names, owner, sym, scope: owner === null ? scope : scopeOf(sem, owner), inits: fields, fieldOf: rewrites, syms: new Map(), ids: new Map(), mode: 'literal', source: null, fields: [...keys] }
        : { decl, names, owner, sym, scope, inits: [], fieldOf: rewrites, syms: new Map(), ids: new Map(), mode: 'destructure', source: d.init, fields: typed! };
}

/** Replace `@sroa`-approved aggregates with scalars. Returns whether anything changed. */
export function scalarReplaceAggregates(
    program: Node,
    semantic: Semantic,
    source: string,
    shapes: ShapeTable = new Map(),
): boolean {
    const spans = directiveSpans(source, program, DIRECTIVE.SROA);
    if (spans.size === 0) return false;

    // Pass 1 — approve declarations. The gate lets `@sroa` sit on the declaration itself OR on an
    // enclosing function, matching compilecat's opt-in surface.
    const gate = Gate.gated(spans);
    const stack: boolean[] = [];
    const plans: Plan[] = [];
    // Module-scope buffers are never inside an annotated function, so the gate above cannot see them.
    // Collect them separately and approve one when a gated function actually reads it.
    const moduleDecls: Node[] = [];
    const gatedRefs = new Set<number>();
    const collector: Visitor = {
        name: 'sroa-collect',
        enter: hookTable({
            [N.FunctionDeclaration]: (n) => void stack.push(gate.enterFn(n.start)),
            [N.FunctionExpression]: (n) => void stack.push(gate.enterFn(n.start)),
            [N.ArrowFunctionExpression]: (n) => void stack.push(gate.enterFn(n.start)),
            [N.VariableDeclaration]: (n, ctx: TransformCtx) => {
                if (stack.length === 0 && !spans.has(n.start)) {
                    moduleDecls.push(n);
                    return;
                }
                if (!gate.active && !spans.has(n.start)) return;
                const plan = planFor(program, n, semantic, ctx.currentScope, shapes);
                if (plan !== null) plans.push(plan);
            },
            [N.IdentifierReference]: (n) => {
                if (!gate.active) return;
                const sym = (n as { sym: number }).sym;
                if (sym > 0) gatedRefs.add(sym);
            },
        }),
        exit: hookTable({
            [N.FunctionDeclaration]: () => gate.exit(stack.pop() ?? false),
            [N.FunctionExpression]: () => gate.exit(stack.pop() ?? false),
            [N.ArrowFunctionExpression]: () => gate.exit(stack.pop() ?? false),
        }),
    };
    traverse(program, semantic, [collector]);
    for (const decl of moduleDecls) {
        const vd = decl.data as { declarations: Node[] };
        if (vd.declarations.length !== 1) continue;
        const id = (vd.declarations[0].data as { id: Node }).id;
        if (id.type !== N.BindingIdentifier) continue;
        if (!gatedRefs.has((id as { sym: number }).sym)) continue;
        const plan = planFor(program, decl, semantic, 0, shapes);
        if (plan !== null) plans.push(plan);
    }
    if (plans.length === 0) return false;

    // Pass 2 — rewrite. Each declaration becomes one `let` of scalars; each member access becomes a
    // reference to the matching scalar.
    const declPlans = new Map<Node, Plan>(plans.map((p) => [p.decl, p]));
    // Node → the PLAN that owns it and the field it names. Keyed this way, not by scalar name, so a
    // name shared by two buffers in different scopes cannot cross the two plans' bindings.
    const allRewrites = new Map<Node, { plan: Plan; key: string }>();
    for (const p of plans) for (const [m, key] of p.fieldOf) allRewrites.set(m, { plan: p, key });
    // Scalar NAME -> the symbol minted for it. Both halves of the rewrite need it: the binding, so the
    // table knows the declaration exists, and every member access rewritten to reference it.
    //
    // Without this the scalars were pure text — bindings with no symbol and references with `sym === 0`
    // — so a fresh `analyze` bound them while the maintained table did not, which `verifySemantic`
    // reports as "'v_x' unbound in maintained, bound in truth (UNSAFE)". Unbound in the table is the
    // MISCOMPILE direction: a live symbol looks dead and `dropUnused` deletes a declaration still in use.
    /** Every symbol this pass minted, for the write-reclassification below. */
    const mintedSyms = new Set<number>();
    // MINT FIRST, rewrite second. The rewriting traversal replaces a member read the moment it reaches
    // one, and it reaches a function written ABOVE the buffer before it reaches the declaration — so
    // minting as the declaration is visited left those reads naming a symbol that did not exist yet
    // ("unbound in maintained, bound in truth"). Nothing here depends on traversal order.
    for (const p of plans) {
        for (const key of p.names.keys()) {
            const id = node(N.BindingIdentifier, p.decl.start, p.decl.start, p.names.get(key)!, null);
            const sym = declareLocal(semantic, id, p.scope, SYM.LET);
            p.ids.set(key, id);
            p.syms.set(key, sym);
            mintedSyms.add(sym);
        }
    }

    const delta = new Map<number, RefDelta>();
    const rewriter: Visitor = {
        name: 'sroa',
        enter: hookTable({
            [N.VariableDeclaration]: (n, ctx: TransformCtx) => {
                const plan = declPlans.get(n);
                if (plan === undefined) return;
                // The buffer's declaration is about to stop existing in every branch below.
                retireSymbol(semantic, plan.sym);
                const bind = (key: string): Node => plan.ids.get(key)!;
                if (plan.mode === 'literal') {
                    if (plan.owner !== null) {
                        // LOCALIZED: the declaration leaves module scope entirely and the scalars are
                        // declared at the top of the one function that uses them, so they are registers
                        // rather than context slots. The literal initialisers come along — every one is
                        // a dead store by `writesPrecedeReads`, and a dead store to a local costs
                        // nothing, while `let a, b, c;` would hand back `undefined` if that analysis
                        // were ever wrong. Cheap insurance against the worst failure mode.
                        const stmts = ((plan.owner.data as { body: Node }).body.data as { body: Node[] }).body;
                        const decls = plan.inits.map(([key, init]) =>
                            create.VariableDeclarator(n.start, n.end, 0, plan.ids.get(key)!, null, init),
                        );
                        ctx.spliceStatements(stmts, 0, 0, create.VariableDeclaration(n.start, n.end, VAR_KIND.LET, decls));
                        ctx.remove();
                        return;
                    }
                    const decls = plan.inits.map(([key, init]) =>
                        create.VariableDeclarator(n.start, n.end, 0, bind(key), null, init),
                    );
                    ctx.replaceWith(create.VariableDeclaration(n.start, n.end, VAR_KIND.LET, decls));
                    return;
                }
                // Opaque value + a shape from its TYPE → bind the fields by destructuring it once.
                // A tuple shape (numeric keys) destructures positionally.
                const isTuple = plan.fields.every((f) => /^\d+$/.test(f));
                const pattern = isTuple
                    ? create.ArrayPattern(n.start, n.end, 0, plan.fields.map((f) => bind(f)))
                    : create.ObjectPattern(
                          n.start,
                          n.end,
                          0,
                          plan.fields.map((f) =>
                              create.ObjectProperty(n.start, n.end, 0, node(N.IdentifierName, n.start, n.start, f, null), bind(f)),
                          ),
                      );
                ctx.replaceWith(
                    create.VariableDeclaration(n.start, n.end, VAR_KIND.LET, [
                        create.VariableDeclarator(n.start, n.end, 0, pattern, null, plan.source),
                    ]),
                );
            },
            [N.StaticMemberExpression]: (n, ctx: TransformCtx) => {
                const hit = allRewrites.get(n);
                if (hit === undefined) return;
                const ref = node(N.IdentifierReference, n.start, n.end, hit.plan.names.get(hit.key)!, null);
                (ref as { sym: number }).sym = hit.plan.syms.get(hit.key) ?? 0;
                ctx.replaceWith(ref);
            },
            [N.ComputedMemberExpression]: (n, ctx: TransformCtx) => {
                const hit = allRewrites.get(n);
                if (hit === undefined) return;
                const ref = node(N.IdentifierReference, n.start, n.end, hit.plan.names.get(hit.key)!, null);
                (ref as { sym: number }).sym = hit.plan.syms.get(hit.key) ?? 0;
                ctx.replaceWith(ref);
            },
        }),
        // EXIT, once the LHS has actually been replaced. `ctx.addRefs(newNode)` classifies by walking
        // the replacement SUBTREE, and a bare `IdentifierReference` carries no assignment context — so
        // `obj.x = 1` rewritten to `v_x = 1` books a READ where truth sees a WRITE
        // ("writes maintained=0 truth=1 UNDER(unsafe)"). Under-counted writes are the unsafe direction:
        // `movement.ts` blocks a reorder on `writes > 0`, so a missing write PERMITS a reorder it
        // should forbid. Correct the classification here, where the position IS known.
        exit: hookTable({
            [N.AssignmentExpression]: (n) => {
                const a = n.data as { left: Node; operator: string };
                if (a.left.type !== N.IdentifierReference) return;
                const sym = (a.left as { sym: number }).sym;
                if (sym <= 0 || !mintedSyms.has(sym)) return;
                let d = delta.get(sym);
                if (d === undefined) {
                    d = { reads: 0, writes: 0, uses: 0 };
                    delta.set(sym, d);
                }
                // A COMPOUND assignment reads before it writes: `_m_0 += v` is one use that counts as
                // BOTH, exactly as a rebuilt table counts it. Only a plain `=` turns the read the
                // replacement booked into a write; treating `+=` the same way dropped the read and
                // undercounted every scratch field a solver accumulates into.
                d.writes += 1;
                if (a.operator === '=') d.reads -= 1;
            },
        }),
    };
    // Thread a `RefDelta` through: without one, `ctx.dropRefs`/`addRefs` are NO-OPS, so the references
    // this rewrite moves never reach the maintained counts. That is the UNDER-count direction — a live
    // symbol looks dead and `dropUnused` deletes a declaration still in use — and it is only invisible
    // today because the optimize tier is followed by a full rebuild.
    const changed = traverse(program, semantic, [rewriter], delta);
    applyRefDelta(semantic, delta);
    return changed;
}
