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
