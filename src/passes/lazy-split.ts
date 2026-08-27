import { N, type Node, node, set } from '../ast';
import * as create from '../parser/create';

/** A synthetic identifier at a zero-width span, the shape the other lowering passes use. */
const ident = (name: string, at = 0): Node => node(N.IdentifierReference, at, at, name, null);
const binding = (name: string, at = 0): Node => node(N.BindingIdentifier, at, at, name, null);

/**
 * Split a module's top-level DECLARATIONS from their INITIALIZERS, so the whole body can move inside
 * an `__esm` lazy-init closure while its bindings stay visible at top level.
 *
 * Applied to EVERY lazily-initialised module (cjs.md §7.25 / C1), which is what rolldown does
 * (`module_finalizers/impl_visit_mut.rs:283-331`) — it has no unsplit variant. The bindings have to
 * be hoisted because the module's namespace object is built at top level from getters that close
 * over them, and because a static importer would read them directly:
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
 * is the cost rolldown pays unconditionally, and now so do we.
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

/** Every binding a declarator introduces, including through destructuring patterns. Collected as
 *  NODES rather than names so the hoisted `var` keeps each binding's SYMBOL — see `toTarget`. */
function patternNames(target: Node, out: Node[]): void {
    switch (target.type) {
        case N.BindingIdentifier:
            out.push(target);
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
        case N.BindingIdentifier: {
            // `set` zeroes `sym` — a retyped node is normally a fresh node. Here it is NOT: the
            // cover grammar means this is the SAME binding read back as a reference, and the symbol
            // is what every later stage renames through. Dropping it printed the raw source name
            // while the namespace getters printed the mangled one, so `{ get a() { return e; } }`
            // read a variable that did not exist.
            const sym = n.sym;
            set(n, N.IdentifierReference, null);
            n.sym = sym;
            return n;
        }
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

/**
 * @param defaultName the binding link mode gives `export default <expr>` (`linked.defaultRefs`).
 *   Without it a default export's value would stay inside the closure and be invisible to a static
 *   importer — the same failure the split exists to prevent for named bindings.
 */
export function lazySplit(body: Node[], defaultName?: string): LazySplit {
    const hoisted: Node[] = [];
    const functions: Node[] = [];
    const out: Node[] = [];
    const names: Node[] = [];

    // `export const v = 1` is an ExportNamedDeclaration WRAPPING the declaration. Link mode drops the
    // `export` keyword and prints the inner declaration, so the split has to see through the wrapper
    // — otherwise the binding stays inside the closure and the static importer reads `undefined`.
    const unwrapped: Node[] = [];
    for (const stmt of body) {
        if (stmt.type === N.ExportNamedDeclaration) {
            const decl = (stmt.data as { declaration: Node | null }).declaration;
            unwrapped.push(decl ?? stmt);
        } else if (stmt.type === N.ExportDefaultDeclaration && defaultName !== undefined) {
            const decl = (stmt.data as { declaration: Node }).declaration;
            // A default FUNCTION declaration hoists like any other; a default class or expression
            // becomes an assignment to the synthesized default binding.
            if (decl.type === N.FunctionDeclaration) unwrapped.push(decl);
            else {
                names.push(binding(defaultName, stmt.start));
                out.push(
                    create.ExpressionStatement(
                        stmt.start,
                        stmt.end,
                        0,
                        create.AssignmentExpression(stmt.start, stmt.end, '=', ident(defaultName, stmt.start), decl),
                    ) as Node,
                );
            }
        } else unwrapped.push(stmt);
    }

    for (const stmt of unwrapped) {
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
                names.push(id);
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
                names.map((n) => {
                    // A FRESH binding node per hoisted declarator — the original is retyped in place
                    // into the assignment target — carrying the same symbol, so renaming and mangling
                    // resolve the declaration and its uses to one name.
                    const b = binding(n.name, n.start);
                    b.sym = n.sym;
                    return create.VariableDeclarator(0, 0, 0, b, null, null) as Node;
                }),
            ) as Node,
        );
    }
    return { hoisted, functions, body: out };
}
