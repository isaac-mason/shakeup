// block-flatten — lift bare `{ … }` blocks into their enclosing statement list.
//
// Port of Closure's `renameForFlatten` + `tryMergeBlock`, via compilecat `block_flatten.rs`. Its
// reason for existing is inlining: BLOCK inlining wraps each spliced callee body in a block purely to
// scope its `const p = arg;` prologue temps, and without this those blocks survive as pure overhead.
//
//   f(); { const a = 1; g(a); } h();   →   f(); const a = 1; g(a); h();
//
// THE COLLISION PROBLEM: two calls to the same inlined helper produce two blocks that each declare the
// same prologue name, so naively lifting both is a `SyntaxError` (duplicate `let`). compilecat solves
// it by renaming lexical bindings to be unique within the function, matching references BY NAME while
// tracking shadowing. shakeup can do better: references carry a RESOLVED `sym`, so renaming a binding
// means renaming exactly the nodes whose `sym` matches — shadowing is handled for free, with no
// scope-walking at all. A name is only rewritten when it would actually collide, so ordinary
// hand-written blocks flatten without any renaming noise.
//
// LEFT INTACT: a block declaring a `function` or `class` (hoisting and id-renaming are not worth it),
// and any block that is a control-flow body rather than a list element (`if (c) { … }` — `normalize`
// owns that case, and unwrapping it there is subject to the dangling-`else` rule).
import { N, type Node, statementListOf, walk } from '../../ast.ts';
import { scopeOf, type Semantic } from '../../analysis/semantic.ts';
import { hookTable, type TransformCtx, type Visitor } from '../traverse.ts';

/** Lexical (`let`/`const`) bindings declared DIRECTLY in a block, as `[sym, name]`. */
function directLexicalBindings(stmts: readonly Node[]): [number, string][] {
    const out: [number, string][] = [];
    for (const s of stmts) {
        if (s.type !== N.VariableDeclaration) continue;
        const vd = s.data as { kind: string; declarations: Node[] };
        if (vd.kind === 'var') continue; // function-scoped already — lifting changes nothing
        for (const d of vd.declarations) {
            const id = (d.data as { id: Node }).id;
            walk(id, (n) => {
                if (n.type === N.BindingIdentifier) {
                    const sym = (n as { sym: number }).sym;
                    if (sym > 0) out.push([sym, n.name]);
                }
                return undefined;
            });
        }
    }
    return out;
}

/** A block that must keep its scope: it declares a function or class. */
function declaresHoisted(stmts: readonly Node[]): boolean {
    return stmts.some((s) => s.type === N.FunctionDeclaration || s.type === N.ClassDeclaration);
}

/** Rename every node bound to `sym` within `root`. Exact because `sym` is resolved. */
function renameSymbol(root: Node, sym: number, to: string): void {
    walk(root, (n) => {
        if ((n.type === N.IdentifierReference || n.type === N.BindingIdentifier) && (n as { sym: number }).sym === sym) {
            (n as { name: string }).name = to;
        }
        return undefined;
    });
}

export function makeBlockFlatten(): Visitor {
    let counter = 0;
    // The nameId→name reverse map is per-Semantic, not per-statement-list: rebuilding it on every
    // container would make this pass O(names × lists) inside the compress fixed point.
    let cachedSem: Semantic | null = null;
    let nameOf = new Map<number, string>();
    // scope id → names bound directly in it. Built ONCE per Semantic, alongside `nameOf`.
    let namesByScope = new Map<number, Set<string>>();

    const listHook = (n: Node, ctx: TransformCtx): void => {
        const stmts = statementListOf(n);
        if (stmts === null) return;

        // Names already bound in the scope we are lifting INTO. Maintained as we go, so a second block
        // declaring the same name sees the first one's contribution.
        const sem = ctx.semantic as Semantic;
        if (sem !== cachedSem) {
            cachedSem = sem;
            nameOf = new Map<number, string>();
            for (const [name, id] of sem.names) nameOf.set(id, name);
            // Bucket every symbol by its owning scope ONCE. The previous version re-scanned the whole
            // symbol table for EVERY statement-list container — O(symbols x lists) per traversal, which
            // profiling showed as 13.8% of the compress tier, the largest single pass. The comment above
            // already avoided exactly this shape for `nameOf`; the `used` set did it anyway.
            namesByScope = new Map<number, Set<string>>();
            for (let i = 1; i < sem.symbols.length; i++) {
                const rec = sem.symbols[i];
                const nm = nameOf.get(rec.nameId);
                if (nm === undefined) continue;
                let set = namesByScope.get(rec.scope);
                if (set === undefined) {
                    set = new Set<string>();
                    namesByScope.set(rec.scope, set);
                }
                set.add(nm);
            }
        }
        const target = scopeOf(sem, n) || ctx.currentScope;
        // LIVE, not a copy. A lift genuinely moves a binding into `target`, so the name must stay
        // visible to every LATER list that flattens into the SAME scope — otherwise two sibling
        // blocks lifted into one scope cannot see each other.
        //
        // That is not hypothetical: a `switch` gives each `case` its own consequent LIST while all of
        // them share the switch's BLOCK SCOPE, so `case A: { const radius = … }` and
        // `case B: { const radius = … }` were both lifted, both kept the name, and the bundle became a
        // `SyntaxError: Identifier 'radius' has already been declared` — which shakeup's own parser
        // does not diagnose (`semantic.ts`: "no TDZ or redeclaration diagnostics"), so it shipped.
        //
        // Copying was deliberate — it kept this cache faithful to the SEMANTIC — but the semantic is
        // already stale by construction here: lifting mutates the AST without re-analysing. The set
        // has to track the TREE, which is what the collision test actually depends on.
        let used = namesByScope.get(target);
        if (used === undefined) {
            used = new Set<string>();
            namesByScope.set(target, used);
        }

        for (let i = 0; i < stmts.length; i++) {
            const b = stmts[i];
            if (b.type !== N.BlockStatement) continue;
            const inner = (b.data as { body: Node[] }).body;
            if (declaresHoisted(inner)) continue;
            for (const [sym, name] of directLexicalBindings(inner)) {
                if (!used.has(name)) {
                    used.add(name);
                    continue;
                }
                let fresh = `${name}$${++counter}`;
                while (used.has(fresh)) fresh = `${name}$${++counter}`;
                renameSymbol(b, sym, fresh);
                used.add(fresh);
            }
            ctx.spliceStatements(stmts, i, 1, ...inner);
            i--; // re-examine from here: the lifted statements may include further blocks
        }
    };

    return {
        name: 'blockFlatten',
        enter: hookTable({
            [N.Program]: listHook,
            [N.BlockStatement]: listHook,
            [N.StaticBlock]: listHook,
            [N.SwitchCase]: listHook,
        }),
        exit: null,
    };
}

export const blockFlatten = makeBlockFlatten();
