import { N, type Node, walk, walkChildren } from '../ast.ts';
import { type Semantic, symbolOf } from './semantic.ts';

/** How a namespace-import binding (`import * as ns`) is consumed within one module.
 *  `escapes` = the binding appears anywhere other than a static member read (`ns.foo`), so the
 *  whole namespace surface may be observed and cannot be narrowed. Otherwise `members` is the
 *  exact set of statically-read member names. */
export type NsUsage = { escapes: boolean; members: Set<string> };

/** Classify every namespace-import symbol in `nsSyms` by how it's used across `program`:
 *  `ns.foo` / `ns?.foo` records member `foo`; any other appearance — bare reference, call,
 *  computed access `ns[x]`, passed as an argument, destructured, reassigned — sets `escapes`.
 *  One walk classifies all of a module's namespace bindings at once. */
export function analyzeNsUsage(program: Node, semantic: Semantic, nsSyms: Set<number>): Map<number, NsUsage> {
    const out = new Map<number, NsUsage>();
    for (const s of nsSyms) out.set(s, { escapes: false, members: new Set() });

    /** The namespace symbol an identifier node resolves to, or 0 if it isn't one we track. */
    const nsSymOf = (node: Node): number => {
        if (node.type !== N.IdentifierReference) return 0;
        const s = symbolOf(semantic, node);
        return nsSyms.has(s) ? s : 0;
    };

    const visit = (node: Node): void => {
        if (node.type === N.StaticMemberExpression) {
            const s = nsSymOf(node.data.object);
            if (s !== 0) {
                // `ns.foo` — a narrow member read. Property is an IdentifierName (no symbol); do
                // not recurse into the object (that would re-see the `ns` ident as a bare use).
                out.get(s)!.members.add(node.data.property.name);
                return;
            }
        } else if (node.type === N.ComputedMemberExpression) {
            const s = nsSymOf(node.data.object);
            if (s !== 0) {
                // `ns[expr]` — even a string-literal key is treated as escape for now (conservative;
                // static `ns.foo` covers the overwhelming common case). The key may itself read a
                // namespace, so still visit it.
                out.get(s)!.escapes = true;
                visit(node.data.expression);
                return;
            }
        } else if (node.type === N.IdentifierReference) {
            const s = nsSymOf(node);
            if (s !== 0) out.get(s)!.escapes = true;
            return;
        }
        walkChildren(node, visit);
    };
    visit(program);
    return out;
}

const allUsage = (): NsUsage => ({ escapes: true, members: new Set() });
const noUsage = (): NsUsage => ({ escapes: false, members: new Set() });

/** Members read by an object-destructuring pattern (`const { a, b } = …`). A rest element,
 *  computed key, or non-identifier key means the whole surface may be observed → escape. */
function membersFromPattern(pattern: Node): NsUsage {
    if (pattern.type !== N.ObjectPattern) return allUsage();
    const members = new Set<string>();
    for (const prop of pattern.data.properties) {
        if (prop.type !== N.ObjectProperty || prop.data.computed) return allUsage();
        const key = prop.data.key;
        if (key.type !== N.IdentifierName) return allUsage();
        members.add(key.name);
    }
    return { escapes: false, members };
}

/** Usage of a namespace-valued binding (an `await import()` result or a `.then` callback param):
 *  reuse the `ns.foo` classifier over that single symbol. */
function bindingUsage(binding: Node, program: Node, semantic: Semantic): NsUsage {
    const sym = symbolOf(semantic, binding);
    if (sym === 0) return allUsage();
    return analyzeNsUsage(program, semantic, new Set([sym])).get(sym)!;
}

/** Classify the `.then(cb)` callback's first parameter as the namespace value. */
function callbackUsage(cb: Node | undefined, program: Node, semantic: Semantic): NsUsage {
    if (cb === undefined || (cb.type !== N.ArrowFunctionExpression && cb.type !== N.FunctionExpression)) return allUsage();
    const first = cb.data.params[0];
    if (first === undefined) return noUsage(); // `.then(() => …)` ignores the module
    // Params are wrapped in a FormalParameter (pattern + optional default); unwrap to the binding.
    const param = first.type === N.FormalParameter ? first.data.pattern : first;
    if (param.type === N.BindingIdentifier) return bindingUsage(param, program, semantic);
    if (param.type === N.ObjectPattern) return membersFromPattern(param);
    return allUsage();
}

/** Classify how the resolved module of `await import()` is consumed, given its await node. */
function awaitedUsage(awaitNode: Node, parentOf: Map<Node, Node>, program: Node, semantic: Semantic): NsUsage {
    const q = parentOf.get(awaitNode);
    if (q === undefined) return allUsage();
    if (q.type === N.VariableDeclarator && q.data.init === awaitNode) {
        const id = q.data.id;
        if (id.type === N.BindingIdentifier) return bindingUsage(id, program, semantic);
        if (id.type === N.ObjectPattern) return membersFromPattern(id);
        return allUsage();
    }
    // `(await import(x)).foo`
    if (q.type === N.StaticMemberExpression && q.data.object === awaitNode) {
        return { escapes: false, members: new Set([q.data.property.name]) };
    }
    if (q.type === N.ExpressionStatement) return noUsage(); // `await import(x);` — result discarded
    return allUsage();
}

/** Classify how each literal `import('spec')`'s resolved module is consumed across `program`,
 *  mirroring rolldown's DynamicImportExportsUsage. Handles `const ns = await import()` /
 *  `const { a } = await import()` / `(await import()).a` / `import().then(m => m.a)`; a bare
 *  `import()` statement is `none` (result unused); anything else escapes to the whole surface.
 *  Returns one entry per literal `import()` site, in source order. */
export function analyzeDynamicUsage(program: Node, semantic: Semantic, source: string): { specifier: string; usage: NsUsage }[] {
    // Find the `import()` sites FIRST. The parent map below exists only to classify them, and it is a
    // `Map<Node, Node>` covering EVERY node in the module — 138k entries on three.core.js — built once
    // per module by `computeDynamicUsage`, whether or not the module contains a single dynamic import.
    // Most modules contain none, so the map was allocated, filled and discarded: 4.6% of a no-minify
    // bundle's profile, and a top source of `Map.set` allocation in the heap profile.
    const sites: Node[] = [];
    walk(program, (n) => {
        if (n.type === N.ImportExpression && n.data.source.type === N.StringLiteral) sites.push(n);
        return undefined;
    });
    if (sites.length === 0) return [];

    const parentOf = new Map<Node, Node>();
    const buildParents = (n: Node): void => {
        walkChildren(n, (c) => {
            parentOf.set(c, n);
            buildParents(c);
        });
    };
    buildParents(program);

    const out: { specifier: string; usage: NsUsage }[] = [];
    for (const n of sites) {
        const src = (n.data as { source: Node }).source;
        const specifier = source.slice(src.start + 1, src.end - 1);
        out.push({ specifier, usage: classifyImportExpr(n, parentOf, program, semantic) });
    }
    return out;
}

function classifyImportExpr(imp: Node, parentOf: Map<Node, Node>, program: Node, semantic: Semantic): NsUsage {
    const p = parentOf.get(imp);
    if (p === undefined) return allUsage();
    if (p.type === N.StaticMemberExpression && p.data.object === imp) {
        // `import(x).then(cb)` — anything else off the promise (`.catch`/`.finally`/…) is opaque.
        if (p.data.property.name === 'then') {
            const call = parentOf.get(p);
            if (call !== undefined && call.type === N.CallExpression && call.data.callee === p) {
                return callbackUsage(call.data.arguments[0], program, semantic);
            }
        }
        return allUsage();
    }
    if (p.type === N.AwaitExpression) return awaitedUsage(p, parentOf, program, semantic);
    if (p.type === N.ExpressionStatement) return noUsage(); // bare `import(x);` — fire and forget
    return allUsage();
}
