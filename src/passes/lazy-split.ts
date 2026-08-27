import { N, type Node, node, set } from '../ast';
import * as create from '../parser/create';

/** A synthetic identifier at a zero-width span, the shape the other lowering passes use. */
const ident = (name: string, at = 0): Node => node(N.IdentifierReference, at, at, name, null);
const binding = (name: string, at = 0): Node => node(N.BindingIdentifier, at, at, name, null);

/**
 * Split a module's top-level DECLARATIONS from their INITIALIZERS, so the whole body can move inside
 * an `__esm` lazy-init closure while its bindings stay visible at top level.
 *
 * Needed for a module that is BOTH `require`d and statically `import`ed (cjs.md §7.25 / C1). The
 * require-only case does not need it — nothing outside wants the bindings, so the body goes into the
 * closure untouched. Here a static importer still reads them, so they must be hoisted:
 *
 *     const a = 1;              →   var a;
 *     class C {}                    function f() {}        // hoisted, left alone
 *     function f() {}               var C;
 *     sideEffect();                 var init = __esm(() => {
 *                                       a = 1;
 *                                       C = class {};
 *                                       sideEffect();
 *                                   });
 *
 * This is rolldown's `misc/wrapped_esm` shape. It trades `const`/`let` for `var` — losing TDZ — which
 * is the cost rolldown pays unconditionally and shakeup pays only for the mixed case.
 *
 * Returns null when nothing needs splitting, so the caller can keep the cheaper path.
 */
export type LazySplit = {
    /** Bare `var a, b, c;` declarations to emit at top level, before the closure. */
    hoisted: Node[];
    /** Function declarations, which hoist on their own and must stay OUTSIDE the closure — a static
     *  importer may call one before the module has been initialised, exactly as it could in ESM. */
    functions: Node[];
    /** Everything else, in source order, to go inside the closure. */
    body: Node[];
};

/** Every binding name a declarator introduces, including through destructuring patterns. */
function patternNames(target: Node, out: string[]): void {
    switch (target.type) {
        case N.BindingIdentifier:
            out.push(target.name);
            return;
        case N.ObjectPattern:
            for (const p of (target.data as { properties: Node[] }).properties) {
                if (p === null) continue;
                if (p.type === N.RestElement) patternNames((p.data as { argument: Node }).argument, out);
                else patternNames((p.data as { value: Node }).value, out);
            }
            return;
        case N.ArrayPattern:
            for (const el of (target.data as { elements: (Node | null)[] }).elements) {
                if (el === null) continue;
                if (el.type === N.RestElement) patternNames((el.data as { argument: Node }).argument, out);
                else patternNames(el, out);
            }
            return;
        case N.AssignmentPattern:
            patternNames((target.data as { left: Node }).left, out);
            return;
        case N.RestElement:
            patternNames((target.data as { argument: Node }).argument, out);
            return;
        default:
            return;
    }
}

/**
 * Retype a binding PATTERN into the assignment-TARGET shape the parser produces from source, so the
 * printer treats it identically — including the parentheses an expression statement starting with
 * `{` requires.
 *
 * The two are the same data under different names, which is the cover grammar: `ObjectPattern` and
 * `ObjectExpression` both hold `properties`, `ArrayPattern` and `ArrayExpression` both hold
 * `elements`. Verified against what the parser actually builds for `({ a: { b } } = o)` — nested
 * patterns become nested ObjectExpressions, a `BindingIdentifier` becomes an `IdentifierReference`,
 * and `AssignmentPattern` (a default) stays as it is.
 *
 * In place, per `set`'s contract: the parent already points at this node.
 */
function toTarget(n: Node): Node {
    switch (n.type) {
        case N.BindingIdentifier:
            set(n, N.IdentifierReference, null);
            return n;
        case N.ObjectPattern: {
            const props = (n.data as { properties: Node[] }).properties;
            for (const p of props) {
                if (p === null) continue;
                if (p.type === N.RestElement) toTarget((p.data as { argument: Node }).argument);
                else toTarget((p.data as { value: Node }).value);
            }
            set(n, N.ObjectExpression, { properties: props });
            return n;
        }
        case N.ArrayPattern: {
            const els = (n.data as { elements: (Node | null)[] }).elements;
            for (const el of els) {
                if (el === null) continue;
                if (el.type === N.RestElement) toTarget((el.data as { argument: Node }).argument);
                else toTarget(el);
            }
            set(n, N.ArrayExpression, { elements: els });
            return n;
        }
        case N.AssignmentPattern:
            toTarget((n.data as { left: Node }).left);
            return n;
        default:
            return n;
    }
}

/** `const {a} = o` → the assignment `({a} = o)`. A destructuring assignment whose target is an object
 *  pattern must be PARENTHESISED as an expression, or `{` starts a block — the printer sees an
 *  ObjectPattern in assignment position and emits the parens. */
function toAssignment(decl: Node): Node[] {
    const out: Node[] = [];
    for (const d of (decl.data as { declarations: Node[] }).declarations) {
        const dd = d.data as { id: Node; init: Node | null };
        // No initializer (`let x;`) — the hoisted `var` already covers it, nothing to run.
        if (dd.init === null) continue;
        const target = toTarget(dd.id);
        out.push(
            create.ExpressionStatement(
                d.start,
                d.end,
                0,
                create.AssignmentExpression(d.start, d.end, '=', target, dd.init),
            ) as Node,
        );
    }
    return out;
}

export function lazySplit(body: Node[]): LazySplit {
    const hoisted: Node[] = [];
    const functions: Node[] = [];
    const out: Node[] = [];
    const names: string[] = [];

    for (const stmt of body) {
        if (stmt.type === N.FunctionDeclaration) {
            functions.push(stmt);
            continue;
        }
        if (stmt.type === N.VariableDeclaration) {
            for (const d of (stmt.data as { declarations: Node[] }).declarations)
                patternNames((d.data as { id: Node }).id, names);
            out.push(...toAssignment(stmt));
            continue;
        }
        if (stmt.type === N.ClassDeclaration) {
            const id = (stmt.data as { id: Node | null }).id;
            if (id !== null) {
                names.push(id.name);
                // A class declaration is not hoisted like a function — its binding exists but is in
                // TDZ until evaluated, so the initializer genuinely belongs inside the closure.
                // `class C {}` becomes `C = class {}` — the SAME node retyped, so its body and any
                // analysis attached to it survive; only the statement wrapper changes.
                const expr = node(N.ClassExpression, stmt.start, stmt.end, '', stmt.data as never);
                out.push(
                    create.ExpressionStatement(
                        stmt.start,
                        stmt.end,
                        0,
                        create.AssignmentExpression(stmt.start, stmt.end, '=', ident(id.name, id.start), expr),
                    ) as Node,
                );
                continue;
            }
        }
        out.push(stmt);
    }

    if (names.length > 0) {
        hoisted.push(
            create.VariableDeclaration(
                0,
                0,
                0,
                names.map((n) => create.VariableDeclarator(0, 0, 0, binding(n), null, null) as Node),
            ) as Node,
        );
    }
    return { hoisted, functions, body: out };
}
