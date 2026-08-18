import { mutateChildren, type Node } from '../ast.ts';

/**
 * A mutation pass over the AST-as-IR. `enter`/`exit` may return a Node to REPLACE the current
 * node, `null` to DROP it (only meaningful in a list slot — a dropped statement/element is
 * removed), or `undefined`/nothing to leave it. Ordered like oxc's `TransformerImpl`: a
 * pipeline fans out to every pass's `enter` (in order) on the way down, then every pass's
 * `exit` on the way up, in ONE traversal — so passes compose and later passes see earlier
 * passes' rewrites. `ctx` is the shared cooperation surface (semantic, source, name minting).
 */
/** A hook returns a Node to replace, `null` to drop, or `undefined` to leave. `null` (not
 *  optional) when a pass has no enter/exit — keeps every `Pass` object one monomorphic shape. */
export type PassHook<C> = (n: Node, ctx: C) => Node | null | undefined;
export type Pass<C> = {
    name: string;
    enter: PassHook<C> | null;
    exit: PassHook<C> | null;
};

/** Visit one node through the ordered pass list; returns its replacement (or null to drop). */
function visit<C>(n: Node, passes: Pass<C>[], ctx: C): Node | null {
    let node = n;
    for (let i = 0; i < passes.length; i++) {
        const fn = passes[i].enter;
        if (fn === null) continue;
        const r = fn(node, ctx);
        if (r === null) return null;
        if (r !== undefined) node = r;
    }
    mutateChildren(node, (c) => visit(c, passes, ctx));
    for (let i = 0; i < passes.length; i++) {
        const fn = passes[i].exit;
        if (fn === null) continue;
        const r = fn(node, ctx);
        if (r === null) return null;
        if (r !== undefined) node = r;
    }
    return node;
}

/**
 * Run `passes` over `program` in a single fused traversal, mutating in place. The root is never
 * dropped/replaced (a program has no parent slot to write back to); root-level rewrites belong
 * in a pass's `enter(Program)` mutating `program.data.body` directly.
 */
export function runPasses<C>(program: Node, passes: Pass<C>[], ctx: C): void {
    for (let i = 0; i < passes.length; i++) {
        const fn = passes[i].enter;
        if (fn !== null) fn(program, ctx);
    }
    mutateChildren(program, (c) => visit(c, passes, ctx));
    for (let i = 0; i < passes.length; i++) {
        const fn = passes[i].exit;
        if (fn !== null) fn(program, ctx);
    }
}

/** Convenience: run a single pass. */
export function runPass<C>(program: Node, pass: Pass<C>, ctx: C): void {
    runPasses(program, [pass], ctx);
}
