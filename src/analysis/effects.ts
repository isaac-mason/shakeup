import { N, type Node } from '../ast.ts';

/**
 * Whether evaluating this expression MAY have an observable side effect (oxc's
 * `may_have_side_effects`). The complement of {@link isPureExpr}; named for intent at
 * movement/compress call sites (a movable expression must not have side effects). Coarser than
 * oxc's contextual version (no `/*@__PURE__*​/` property-read policy beyond what isPureExpr honors),
 * which only ever makes it MORE conservative — safe for movement.
 */
export const mayHaveSideEffects = (node: Node | null): boolean => !isPureExpr(node);

/**
 * Conservatively true if evaluating this expression has no observable side effects.
 */
/** Calls the interprocedural analysis PROVED side-effect-free. Kept in a side table rather than on
 *  `CallExpression.pure` for two reasons: the node data shape stays monomorphic (a parser-perf
 *  invariant), and the printer can then re-emit `/*@__PURE__*​/` for SOURCE annotations only — an
 *  inferred verdict is an internal signal, and emitting a marker for every inferred-pure call would
 *  add bytes to the output that were never in the input. */
let INFERRED_PURE = new WeakSet<object>();

/** Record that `node` (a CallExpression) is provably side-effect-free. */
export const markInferredPure = (node: Node): void => {
    INFERRED_PURE.add(node);
};

/**
 * Drop every inferred-purity verdict. MUST be called once at the start of each build.
 *
 * The verdicts are derived from OTHER modules (a callee's body decides whether a call is pure), and
 * the table only ever grows — so without this a stamp outlives the fact that justified it. Cached
 * modules keep the SAME node objects across rebuilds, so a call marked pure in one build stays marked
 * even after the callee gains a side effect: the next build simply declines to re-stamp it, while the
 * old stamp still says "pure" and DCE drops a call that now has effects.
 *
 * Clearing is the whole fix, and it is cheap because purity is fully re-derived every build anyway
 * (`stampPureCalls` per module, `stampPureCallsGraph` across the graph). That keeps purity OUT of the
 * cached-cross-module-state category entirely — unlike `@inline`, which bakes a body into a cached AST
 * and therefore needs `transformDependencies`.
 */
export const resetInferredPure = (): void => {
    INFERRED_PURE = new WeakSet<object>();
};

export function isPureExpr(node: Node | null): boolean {
    if (node === null) return true;
    switch (node.type) {
        case N.BindingIdentifier:
        case N.IdentifierReference:
        case N.IdentifierName:
        case N.LabelIdentifier:
        case N.NumericLiteral:
        case N.StringLiteral:
        case N.BooleanLiteral:
        case N.NullLiteral:
        case N.RegExpLiteral:
        case N.BigIntLiteral:
        case N.ThisExpression:
        case N.ImportMeta:
        case N.NewTarget:
        case N.ArrowFunctionExpression:
        case N.FunctionExpression:
            return true;
        case N.ClassExpression:
            return node.data.superClass === null && !classHasStaticEffects(node);
        case N.TemplateLiteral: {
            for (const e of node.data.expressions) if (!isPureExpr(e)) return false;
            return true;
        }
        case N.ArrayExpression: {
            for (const el of node.data.elements) {
                if (el === null) continue;
                if (el.type === N.SpreadElement) return false;
                if (!isPureExpr(el)) return false;
            }
            return true;
        }
        case N.ObjectExpression: {
            for (const p of node.data.properties) {
                if (p.type === N.SpreadElement) return false;
                if (p.type !== N.ObjectProperty) continue;
                if (p.data.computed && !isPureExpr(p.data.key)) return false;
                if (p.data.kind === 'init' && !isPureExpr(p.data.value)) return false;
            }
            return true;
        }
        case N.UnaryExpression:
            return node.data.operator !== 'delete' && isPureExpr(node.data.argument);
        case N.BinaryExpression:
            return isPureExpr(node.data.left) && isPureExpr(node.data.right);
        case N.LogicalExpression:
            return isPureExpr(node.data.left) && isPureExpr(node.data.right);
        case N.ConditionalExpression:
            return isPureExpr(node.data.test) && isPureExpr(node.data.consequent) && isPureExpr(node.data.alternate);
        case N.SequenceExpression: {
            for (const e of node.data.expressions) if (!isPureExpr(e)) return false;
            return true;
        }
        case N.TSAsExpression:
        case N.TSSatisfiesExpression:
            return isPureExpr(node.data.expression);
        case N.NewExpression: {
            // An annotated `new` is side-effect-free exactly when its arguments are — same rule the
            // annotated CallExpression case uses below. Unannotated construction stays impure.
            if (node.data.pure !== true) return false;
            for (const arg of node.data.arguments as Node[]) {
                if (arg.type === N.SpreadElement) return false;
                if (!isPureExpr(arg)) return false;
            }
            return true;
        }
        case N.CallExpression: {
            // A `/*@__PURE__*/`-annotated call (oxc `CallExpression.pure`) is side-effect-free iff
            // its arguments are. Lowering passes set this on the enum/namespace IIFE.
            if (node.data.pure !== true && !INFERRED_PURE.has(node)) return false;
            for (const a of node.data.arguments) {
                const arg = a.type === N.SpreadElement ? a.data.argument : a;
                if (!isPureExpr(arg)) return false;
            }
            return true;
        }
        // JSX is lowered to `jsx(...)` calls before any effect analysis runs (jsxLower, transform
        // stage), so JSXElement/JSXFragment never reach here — their purity is the CallExpression's,
        // judged by standard side-effect rules (oxc/rolldown default; no bespoke JSX-spread optimism).
        default:
            return false;
    }
}

/** True if evaluating a class declaration/expression runs static side effects (static blocks, impure static/computed keys). */
export function classHasStaticEffects(classNode: Node): boolean {
    if (classNode.type !== N.ClassDeclaration && classNode.type !== N.ClassExpression) return false;
    for (const m of classNode.data.body) {
        if (m.type === N.StaticBlock) return true;
        if (m.type === N.PropertyDefinition && m.data.static && !isPureExpr(m.data.value)) return true;
        if ((m.type === N.MethodDefinition || m.type === N.PropertyDefinition) && m.data.computed) {
            if (!isPureExpr(m.data.key)) return true;
        }
    }
    return false;
}

/**
 * Conservatively true if executing `stmt` in place has no immediate side
 * effects. Declarations count as pure (liveness is the caller's policy);
 * ImportDecl is pure here since import side-effect policy is a graph concern.
 */
export function isPureStatement(stmt: Node): boolean {
    switch (stmt.type) {
        case N.FunctionDeclaration:
        case N.TSInterfaceDeclaration:
        case N.TSTypeAliasDeclaration:
        case N.ImportDeclaration:
        case N.ExportAllDeclaration:
        case N.EmptyStatement:
            return true;
        case N.TSEnumDeclaration:
            return true;
        case N.ClassDeclaration:
            return stmt.data.superClass === null && !classHasStaticEffects(stmt);
        case N.VariableDeclaration: {
            for (const d of stmt.data.declarations) {
                if (d.type === N.VariableDeclarator && !isPureExpr(d.data.init)) return false;
            }
            return true;
        }
        case N.ExportNamedDeclaration: {
            const decl = stmt.data.declaration;
            return decl === null ? true : isPureStatement(decl);
        }
        case N.ExportDefaultDeclaration: {
            const decl = stmt.data.declaration;
            if (decl.type === N.FunctionDeclaration) return true;
            if (decl.type === N.ClassDeclaration) return isPureStatement(decl);
            return isPureExpr(decl);
        }
        default:
            return false;
    }
}
