import { isIdentifier, N, type Node, walkChildren } from '../ast/index.ts';

/**
 * Visit every identifier in `node`'s subtree that carries a symbol — the
 * `IdentifierReference` and `BindingIdentifier` roles. The pure-name roles
 * (`IdentifierName`, `LabelIdentifier`) are distinct node types and are skipped.
 *
 * `cb`'s `shorthandProp` is the shorthand-property node when the identifier is
 * the VALUE of a shorthand object property (`{ a }` / `{ a = 1 }`) and null
 * otherwise — renamers must then expand to `a: a$1` rather than replace the span
 * (the key text stays, only the value name changes).
 */
export function walkRefIdents(node: Node, cb: (ident: Node, shorthandProp: Node | null) => void): void {
    // An explicit stack, not recursion: this descends one frame per AST level, and a deeply nested
    // program overflowed the stack here — 300 nested blocks was enough. It was the last walker still
    // capping what the bundler could handle.
    const stack: Node[] = [node];
    while (stack.length > 0) {
        const n = stack.pop() as Node;
        if (n.type === N.BindingIdentifier || n.type === N.IdentifierReference) {
            cb(n, null);
            continue;
        }
        if (isIdentifier(n.type)) continue;
        if (n.type === N.ObjectProperty && n.data.shorthand) {
            const value = n.data.value;
            if (value.type === N.BindingIdentifier || value.type === N.IdentifierReference) cb(value, n);
            else if (value.type === N.AssignmentPattern) {
                const left = value.data.left;
                if (left.type === N.BindingIdentifier || left.type === N.IdentifierReference) cb(left, n);
                stack.push(value.data.right);
            }
            continue;
        }
        // Children arrive in source order but a stack reverses, so the freshly pushed run is flipped
        // in place — callers see identifiers in the same order as before. Reversing the segment
        // rather than buffering into a per-node array keeps this allocation-free.
        const from = stack.length;
        walkChildren(n, (child) => {
            stack.push(child);
        });
        for (let i = from, j = stack.length - 1; i < j; i++, j--) {
            const t = stack[i];
            stack[i] = stack[j];
            stack[j] = t;
        }
    }
}
