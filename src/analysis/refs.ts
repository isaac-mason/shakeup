import { isIdentifier, N, type Node, walkChildren } from '../ast.ts';

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
    if (node.type === N.BindingIdentifier || node.type === N.IdentifierReference) {
        cb(node, null);
        return;
    }
    if (isIdentifier(node.type)) return;
    if (node.type === N.ObjectProperty && node.data.shorthand) {
        const value = node.data.value;
        if (value.type === N.BindingIdentifier || value.type === N.IdentifierReference) cb(value, node);
        else if (value.type === N.AssignmentPattern) {
            const left = value.data.left;
            if (left.type === N.BindingIdentifier || left.type === N.IdentifierReference) cb(left, node);
            walkRefIdents(value.data.right, cb);
        }
        return;
    }
    walkChildren(node, (child) => {
        walkRefIdents(child, cb);
    });
}
