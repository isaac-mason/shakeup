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
import { declareLocal, lookupValue, SYM, type Semantic } from '../../analysis/semantic.ts';
import { N, type Node, node, walk } from '../../ast.ts';
import * as create from '../../parser/create.ts';
import { VAR_KIND } from '../../parser/create.ts';
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
    /** Member expressions to rewrite → the scalar name. */
    rewrites: Map<Node, string>;
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
    const visit = (n: Node): boolean | undefined => {
        if (!ok) return false;
        if (n === decl) declDepth = depth;
        if (isFn(n)) {
            depth++;
            walk(n, (c) => (c === n ? undefined : visit(c)));
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
            }
        }
        if (n.type === N.IdentifierReference && (n as { sym: number }).sym === sym) refs.push({ n, depth });
        return undefined;
    };
    walk(program, visit);
    if (!ok || declDepth < 0) return null;
    for (const r of refs) {
        if (!consumed.has(r.n)) return null; // used as a whole object
        if (r.depth !== declDepth) return null; // captured by a nested function
    }

    const names = new Map<string, string>();
    for (const k of keys) names.set(k, scalarName(sem, scope, d.id.name, k));
    const finalRewrites = new Map<Node, string>();
    for (const [m, key] of rewrites) finalRewrites.set(m, names.get(key)!);
    return fields !== null
        ? { decl, names, inits: fields, rewrites: finalRewrites, mode: 'literal', source: null, fields: [...keys] }
        : { decl, names, inits: [], rewrites: finalRewrites, mode: 'destructure', source: d.init, fields: typed! };
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
    const collector: Visitor = {
        name: 'sroa-collect',
        enter: hookTable({
            [N.FunctionDeclaration]: (n) => void stack.push(gate.enterFn(n.start)),
            [N.FunctionExpression]: (n) => void stack.push(gate.enterFn(n.start)),
            [N.ArrowFunctionExpression]: (n) => void stack.push(gate.enterFn(n.start)),
            [N.VariableDeclaration]: (n, ctx: TransformCtx) => {
                if (!gate.active && !spans.has(n.start)) return;
                const plan = planFor(program, n, semantic, ctx.currentScope, shapes);
                if (plan !== null) plans.push(plan);
            },
        }),
        exit: hookTable({
            [N.FunctionDeclaration]: () => gate.exit(stack.pop() ?? false),
            [N.FunctionExpression]: () => gate.exit(stack.pop() ?? false),
            [N.ArrowFunctionExpression]: () => gate.exit(stack.pop() ?? false),
        }),
    };
    traverse(program, semantic, [collector]);
    if (plans.length === 0) return false;

    // Pass 2 — rewrite. Each declaration becomes one `let` of scalars; each member access becomes a
    // reference to the matching scalar.
    const declPlans = new Map<Node, Plan>(plans.map((p) => [p.decl, p]));
    const allRewrites = new Map<Node, string>();
    for (const p of plans) for (const [m, name] of p.rewrites) allRewrites.set(m, name);
    // Scalar NAME -> the symbol minted for it. Both halves of the rewrite need it: the binding, so the
    // table knows the declaration exists, and every member access rewritten to reference it.
    //
    // Without this the scalars were pure text — bindings with no symbol and references with `sym === 0`
    // — so a fresh `analyze` bound them while the maintained table did not, which `verifySemantic`
    // reports as "'v_x' unbound in maintained, bound in truth (UNSAFE)". Unbound in the table is the
    // MISCOMPILE direction: a live symbol looks dead and `dropUnused` deletes a declaration still in use.
    const scalarSyms = new Map<string, number>();

    const delta = new Map<number, RefDelta>();
    const rewriter: Visitor = {
        name: 'sroa',
        enter: hookTable({
            [N.VariableDeclaration]: (n, ctx: TransformCtx) => {
                const plan = declPlans.get(n);
                if (plan === undefined) return;
                const bind = (key: string): Node => {
                    const name = plan.names.get(key)!;
                    const id = node(N.BindingIdentifier, n.start, n.start, name, null);
                    // Declare into the scope the original binding lived in, so the scalar is a real
                    // binding rather than free text.
                    scalarSyms.set(name, declareLocal(semantic, id, ctx.currentScope, SYM.LET));
                    return id;
                };
                if (plan.mode === 'literal') {
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
                const name = allRewrites.get(n);
                if (name === undefined) return;
                const ref = node(N.IdentifierReference, n.start, n.end, name, null);
                (ref as { sym: number }).sym = scalarSyms.get(name) ?? 0;
                ctx.replaceWith(ref);
            },
            [N.ComputedMemberExpression]: (n, ctx: TransformCtx) => {
                const name = allRewrites.get(n);
                if (name === undefined) return;
                const ref = node(N.IdentifierReference, n.start, n.end, name, null);
                (ref as { sym: number }).sym = scalarSyms.get(name) ?? 0;
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
                const left = (n.data as { left: Node }).left;
                if (left.type !== N.IdentifierReference) return;
                const sym = (left as { sym: number }).sym;
                if (sym <= 0 || !scalarSyms.has(left.name) || scalarSyms.get(left.name) !== sym) return;
                let d = delta.get(sym);
                if (d === undefined) {
                    d = { reads: 0, writes: 0, uses: 0 };
                    delta.set(sym, d);
                }
                d.reads -= 1;
                d.writes += 1;
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
