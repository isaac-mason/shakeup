// Cross-module constant propagation — replace a reference to an imported primitive constant with the
// value itself, so folding and dead-branch removal work ACROSS module boundaries.
//
//   // config.js            // app.js
//   export const DEBUG = false;   import { DEBUG } from './config.js';
//                                 if (DEBUG) { expensive(); }
//     →  `DEBUG` becomes `false` in app.js, so the branch folds and `expensive()` shakes out.
//
// Modelled on esbuild's `constValues` ("Track cross-module enum constants during bundling"), which is
// the mechanism it uses for exactly this. Runs post-link, where the producer's value is already
// parsed and bound, and rides the same "touched modules are re-analysed and re-compressed" loop as
// cross-module `@inline`.
//
// SEMANTIC TIER, deliberately: without it, a `DEBUG`-style flag folds in a bundle but not in dev, so
// the two would take DIFFERENT BRANCHES. Propagating in both keeps dev and bundle on the same path.
//
// SAFETY:
//   • Only PRIMITIVES are inlined (number / string / boolean / null, and a negated number). An object
//     or array has identity — duplicating the literal would produce a different object per use.
//   • Immutability is established by the ABSENCE OF WRITES to the binding, not by the `const` keyword:
//     this runs after scan's compress, which has already rewritten `const` → `let` in full-minify mode.
//   • A binding the analysis cannot see whole (re-exported through a namespace, bound to something
//     other than a literal) is simply not a candidate.
import { cloneNode, N, type Node, walk } from '../../ast.ts';
import type { Semantic } from '../../analysis/semantic.ts';
import { hookTable, type TransformCtx, traverse, type Visitor } from '../traverse.ts';

/** A literal whose value can be duplicated freely — no identity, no side effects. */
function primitiveLiteral(init: Node | null): Node | null {
    if (init === null) return null;
    switch (init.type) {
        case N.NumericLiteral:
        case N.StringLiteral:
        case N.BooleanLiteral:
        case N.NullLiteral:
            return init;
        case N.UnaryExpression: {
            // `-1` / `+1` — a signed numeric literal is still a primitive.
            const d = init.data as { operator: string; argument: Node };
            return (d.operator === '-' || d.operator === '+') && d.argument.type === N.NumericLiteral ? init : null;
        }
        default:
            return null;
    }
}

/** Symbols written anywhere in the module (assignment target or update). */
function writtenSymbols(program: Node): Set<number> {
    const out = new Set<number>();
    const mark = (t: Node): void => {
        walk(t, (n) => {
            if (n.type === N.IdentifierReference || n.type === N.BindingIdentifier) {
                const s = (n as { sym: number }).sym;
                if (s > 0) out.add(s);
            }
            return undefined;
        });
    };
    walk(program, (n) => {
        if (n.type === N.AssignmentExpression) mark((n.data as { left: Node }).left);
        else if (n.type === N.UpdateExpression) mark((n.data as { argument: Node }).argument);
        return undefined;
    });
    return out;
}

/** Module-scope bindings holding an immutable primitive, keyed by symbol. */
function moduleConstants(program: Node): Map<number, Node> {
    const out = new Map<number, Node>();
    const written = writtenSymbols(program);
    walk(program, (n) => {
        if (n.type !== N.VariableDeclaration) return undefined;
        const vd = n.data as { kind: string; declarations: Node[] };
        if (vd.kind === 'var') return undefined; // `var` can be re-declared/hoisted — skip
        for (const d of vd.declarations) {
            const dd = d.data as { id: Node; init: Node | null };
            if (dd.id.type !== N.BindingIdentifier) continue;
            const sym = (dd.id as { sym: number }).sym;
            if (sym <= 0 || written.has(sym)) continue; // reassigned somewhere → not constant
            const lit = primitiveLiteral(dd.init);
            if (lit !== null) out.set(sym, lit);
        }
        return undefined;
    });
    return out;
}

/**
 * Replace references to imported primitive constants with the value.
 * Returns consumer module index → the PRODUCER modules it took values from, so the caller can
 * invalidate a consumer exactly when one of its producers changes.
 */
export function propagateCrossModuleConstants(
    modules: readonly { program: Node; semantic: Semantic; namedImports: ReadonlyMap<number, unknown> }[],
    resolveImport: (moduleIdx: number, sym: number) => { mod: number; sym: number } | null,
): Map<number, Set<number>> {
    const constCache = new Map<number, Map<number, Node>>();
    const constsOf = (idx: number): Map<number, Node> => {
        let c = constCache.get(idx);
        if (c === undefined) {
            c = moduleConstants(modules[idx].program);
            constCache.set(idx, c);
        }
        return c;
    };

    const changed = new Map<number, Set<number>>();
    for (let idx = 0; idx < modules.length; idx++) {
        const mod = modules[idx];
        const producers = new Set<number>();
        const visitor: Visitor = {
            name: 'crossModuleConstants',
            enter: hookTable({
                [N.IdentifierReference]: (n: Node, ctx: TransformCtx) => {
                    const sym = (n as { sym: number }).sym;
                    if (sym <= 0 || !mod.namedImports.has(sym)) return;
                    const target = resolveImport(idx, sym);
                    if (target === null || target.mod === idx) return;
                    const lit = constsOf(target.mod).get(target.sym);
                    if (lit === undefined) return;
                    producers.add(target.mod);
                    ctx.replaceWith(cloneNode(lit) as Node);
                },
            }),
            exit: null,
        };
        if (traverse(mod.program, mod.semantic, [visitor])) changed.set(idx, producers);
    }
    return changed;
}
