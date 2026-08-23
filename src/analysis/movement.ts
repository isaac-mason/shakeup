// Movement-safety analysis — the substrate for NON-LOCAL compress transforms (constant-propagation,
// single-use inline, and later CSE / dead-store / hoisting). Mirrors oxc's architecture: a coarse
// `mayHaveSideEffects` boolean (in effects.ts) PLUS a read/write-split reference tally
// (oxc `ReferenceCounts`, symbol_value.rs:35-80) — the write half of movement safety comes from the
// semantic layer, not the effect predicate.
//
// INVARIANT (same discipline as drop-unused): never UNDER-count writes. Over-counting a write only
// costs a missed transform; under-counting is a miscompile (we'd move/inline a binding that is
// actually reassigned). Every ambiguous target position is therefore counted as a write.
import { N, type Node, walkChildren } from '../ast.ts';
import { mayHaveSideEffects } from './effects.ts';

/** Per-symbol read/write reference counts. `reads` = value uses; `writes` = reassignments
 *  (`x = …`, `x += …`, `x++`, `for (x of/in …)`, destructuring-assignment target `[x] = …`). The
 *  declaration's own BindingIdentifier is neither. */
export type RefCounts = { reads: number; writes: number };

/** Tally read/write references per SymbolId across `program`. Global/unresolved refs (`sym === 0`)
 *  are ignored. This is the write-detection oxc gets from its reference table; shakeup's
 *  `walkRefIdents` doesn't distinguish targets, so we walk with target-position awareness here. */
export function tallyRefs(program: Node): Map<number, RefCounts> {
    const out = new Map<number, RefCounts>();
    const bump = (sym: number, kind: 'reads' | 'writes'): void => {
        if (sym === 0) return;
        let c = out.get(sym);
        if (c === undefined) {
            c = { reads: 0, writes: 0 };
            out.set(sym, c);
        }
        c[kind]++;
    };

    // Mark every identifier reachable in an assignment/binding TARGET position as a write, while
    // routing member objects and default-value expressions back to the read visitor. Handles the
    // cover-grammar destructuring targets (`[x] = …` / `({x} = …)` parse as Array/ObjectExpression).
    const visitTarget = (node: Node): void => {
        switch (node.type) {
            case N.IdentifierReference:
                bump(node.sym, 'writes');
                return;
            case N.ArrayExpression:
                for (const el of node.data.elements) if (el !== null) visitTarget(el);
                return;
            case N.ObjectExpression:
                for (const p of node.data.properties) visitTarget(p);
                return;
            case N.ObjectProperty:
                visitTarget(node.data.value);
                return;
            case N.SpreadElement:
            case N.RestElement:
                visitTarget(node.data.argument);
                return;
            case N.AssignmentExpression:
            case N.AssignmentPattern:
                // A default in a destructuring target (`[x = d] = …`): `x` is written, `d` is read.
                visitTarget(node.data.left);
                visit(node.data.right);
                return;
            case N.StaticMemberExpression:
            case N.ComputedMemberExpression:
                // `a.b = …` / `a[k] = …` — the property is SET (no binding write); `a` (and `k`) are READS.
                visit(node);
                return;
            default:
                // Unknown target shape — be safe: any identifier inside is treated as a write.
                walkChildren(node, visitTarget);
        }
    };

    const visit = (node: Node): void => {
        switch (node.type) {
            case N.AssignmentExpression: {
                const { operator, left, right } = node.data;
                visitTarget(left);
                // A compound assignment (`x += 1`) also READS the target.
                if (operator !== '=' && left.type === N.IdentifierReference) bump(left.sym, 'reads');
                visit(right);
                return;
            }
            case N.UpdateExpression: {
                // `x++` / `--x` — read AND write of the operand (GetValue + PutValue).
                const arg = node.data.argument;
                if (arg.type === N.IdentifierReference) {
                    bump(arg.sym, 'writes');
                    bump(arg.sym, 'reads');
                } else visit(arg);
                return;
            }
            case N.ForInStatement:
            case N.ForOfStatement: {
                const { left, right, body } = node.data;
                // `for (x of …)` assigns each iteration; `for (let x of …)` is a fresh declaration.
                if (left.type === N.VariableDeclaration) visit(left);
                else visitTarget(left);
                visit(right);
                visit(body);
                return;
            }
            case N.IdentifierReference:
                bump(node.sym, 'reads');
                return;
            case N.BindingIdentifier:
                return; // a declaration is neither a read nor a value-write
        }
        walkChildren(node, visit);
    };

    visit(program);
    return out;
}

/** Whether a READ of `sym`, encountered in the use-site expression BEFORE the target, blocks moving
 *  the replacement past it (oxc `identifier_read_blocks_reorder` + `symbol_value_may_change`,
 *  mod.rs:200-242). A global/unresolved read (sym 0) may be a getter / change; a mutated local (any
 *  write) may hold a different value once the replacement moves later. Conservative default: block. */
function readBlocksReorder(sym: number, refs: Map<number, RefCounts>): boolean {
    if (sym === 0) return true;
    const c = refs.get(sym);
    return c === undefined || c.writes > 0;
}

/** Whether `node` reads a MUTABLE symbol — one that may hold a different value depending on WHEN it
 *  is evaluated (a global/unresolved read, or a local that's reassigned somewhere). A replacement
 *  that reads only immutable symbols and has no side effects is "freely movable": its value and
 *  effects are position-independent, so it can be substituted anywhere. */
export function readsMutableSymbol(node: Node, refs: Map<number, RefCounts>): boolean {
    let found = false;
    const v = (n: Node): void => {
        if (found) return;
        if (n.type === N.IdentifierReference) {
            if (readBlocksReorder(n.sym, refs)) found = true;
            return;
        }
        walkChildren(n, v);
    };
    v(node);
    return found;
}

/** Result of the movement walk: `done` = the target was found in a safe position and substituted;
 *  `barrier` = hit interference, stop; `inert` = this sub-expression is safe but the target isn't in
 *  it (keep scanning). */
export type SubstResult = 'done' | 'barrier' | 'inert';

/** Move `replacement` into the single read of `searchSym` inside the use-site expression at
 *  `owner.data[field]`, walking in EVALUATION ORDER and refusing to cross any interference (oxc's
 *  `substitute_single_use_symbol_in_expression`, minimize_statements.rs:1444). The kernel every
 *  non-local transform (inline now; CSE/dead-store later) reuses. Conservative by construction:
 *  await/yield/assignment/spread and any UNHANDLED node are barriers, and an impure replacement is
 *  never pushed into a conditionally-evaluated position (`&&`/`||` rhs, `?:` arms). Mutates the AST
 *  (moving `replacement`) only on `done`.
 *
 *  `replacementImpure` = whether `replacement` may have side effects; `refs` is the module read/write
 *  tally. NOTE: this assumes the declaration is IMMEDIATELY BEFORE the use statement (empty gap), so
 *  the replacement only moves LATER within one straight-line statement — which keeps it clear of TDZ
 *  (no suspension can appear in the gap; await/yield inside the use are barriers anyway). */
/** Whether `node`'s subtree reads `sym`. Used to tell "an unmodelled construct that happens to sit in
 *  the way" from "an unmodelled construct the target is buried in". */
function containsSym(node: Node, sym: number): boolean {
    if (node.type === N.IdentifierReference) return node.sym === sym;
    let found = false;
    walkChildren(node, (c) => {
        if (!found && containsSym(c, sym)) found = true;
    });
    return found;
}

export function substituteSingleUse(
    owner: Node,
    field: string,
    searchSym: number,
    replacement: Node,
    replacementImpure: boolean,
    replacementReadsMutable: boolean,
    refs: Map<number, RefCounts>,
): SubstResult {
    // A "freely movable" replacement (no side effects AND reads only immutable symbols) is
    // position-independent — it can be substituted anywhere with no reorder hazard. Otherwise the
    // replacement must not move PAST a side-effecting sub-expression (effects can't reorder / the
    // effect could mutate what the replacement reads) nor into a conditionally-evaluated position.
    const replFree = !replacementImpure && !replacementReadsMutable;

    // Whether it's safe for the replacement to move past an INERT child (target not inside it):
    // always for a free replacement, else only if the child has no side effects.
    const passable = (c: Node): boolean => replFree || !mayHaveSideEffects(c);

    // Try one child slot: replace it if it IS the target; else recurse, then check we may pass it.
    const slot = (d: Record<string, unknown>, key: string): SubstResult => {
        const c = d[key] as Node | null;
        if (c === null || c === undefined) return 'inert';
        if (c.type === N.IdentifierReference) {
            if (c.sym === searchSym) {
                d[key] = replacement; // single-use → MOVE the node in (decl is dropped by the caller)
                return 'done';
            }
            // A read of a mutable symbol before the target: barrier unless the replacement is free.
            return !replFree && readBlocksReorder(c.sym, refs) ? 'barrier' : 'inert';
        }
        const r = walk(c);
        if (r !== 'inert') return r;
        return passable(c) ? 'inert' : 'barrier';
    };
    // Walk one sub-expression, processing its children in EVALUATION ORDER.
    const walk = (node: Node): SubstResult => {
        const d = node.data as Record<string, unknown>;
        const seq = (keys: string[]): SubstResult => {
            for (const k of keys) {
                const r = slot(d, k);
                if (r !== 'inert') return r;
            }
            return 'inert';
        };
        switch (node.type) {
            // Leaves / atoms — no target inside, no interference.
            case N.NumericLiteral:
            case N.StringLiteral:
            case N.BooleanLiteral:
            case N.NullLiteral:
            case N.BigIntLiteral:
            case N.RegExpLiteral:
            case N.ThisExpression:
            case N.Super:
            case N.IdentifierName:
            case N.PrivateIdentifier:
                return 'inert';
            case N.UnaryExpression:
                return slot(d, 'argument');
            case N.StaticMemberExpression:
                return slot(d, 'object'); // static property name is not evaluated
            case N.ComputedMemberExpression:
                return seq(['object', 'property']);
            case N.BinaryExpression:
                return seq(['left', 'right']);
            case N.LogicalExpression: {
                // `&&`/`||`/`??`: left always runs; right is CONDITIONAL — never push a non-free
                // replacement into it (it might then not run, or run in a changed order).
                const l = slot(d, 'left');
                if (l !== 'inert') return l;
                return replFree ? slot(d, 'right') : 'inert';
            }
            case N.ConditionalExpression: {
                const t = slot(d, 'test');
                if (t !== 'inert') return t;
                if (!replFree) return 'inert'; // arms are conditional
                const c = slot(d, 'consequent');
                if (c !== 'inert') return c;
                return slot(d, 'alternate');
            }
            case N.SequenceExpression:
                return arr(d.expressions as Node[]);
            case N.TemplateLiteral:
                return arr(d.expressions as Node[]);
            case N.ArrayExpression:
                return arr(d.elements as (Node | null)[]);
            case N.CallExpression:
            case N.NewExpression: {
                const r = slot(d, 'callee');
                if (r !== 'inert') return r;
                return arr(d.arguments as Node[]);
            }
            // Anything not modelled above. A FREE replacement (no effects, reads only immutable
            // symbols) is position-independent, so it may pass ANY construct — the only reason to stop
            // is that the target sits INSIDE one we cannot descend into safely, which `containsSym`
            // decides. Declaring `inert` when the target is elsewhere is what lets an init cross e.g.
            // the assignments in `return (a = 1, b = 2, v)`, the shape a folded statement gap takes.
            // A non-free replacement still barriers: passability cannot be proven here.
            default:
                return replFree && !containsSym(node, searchSym) ? 'inert' : 'barrier';
        }
    };
    // Walk a child array in order (call args, sequence, array/template elements).
    const arr = (items: (Node | null)[]): SubstResult => {
        for (let i = 0; i < items.length; i++) {
            const c = items[i];
            if (c === null) continue;
            if (c.type === N.IdentifierReference) {
                if (c.sym === searchSym) {
                    items[i] = replacement;
                    return 'done';
                }
                if (!replFree && readBlocksReorder(c.sym, refs)) return 'barrier';
                continue;
            }
            const r = walk(c);
            if (r !== 'inert') return r;
            if (!passable(c)) return 'barrier'; // can't move a non-free replacement past this effect
        }
        return 'inert';
    };
    return slot(owner.data as Record<string, unknown>, field);
}
