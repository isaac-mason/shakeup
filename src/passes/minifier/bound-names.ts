// Port of oxc_ecmascript/src/bound_names.rs.

import { N, type Node } from '../../ast/index.ts';

/** Every `BindingIdentifier` a declaration, parameter or binding pattern binds, in source order. */
export function boundNames(root: Node, visit: (ident: Node) => void): void {
    const pending: Node[] = [root];
    const pushReversed = (nodes: readonly (Node | null)[]): void => {
        for (let index = nodes.length - 1; index >= 0; index--) {
            const item = nodes[index];
            if (item !== null) pending.push(item);
        }
    };
    while (pending.length > 0) {
        const current = pending.pop() as Node;
        switch (current.type) {
            case N.BindingIdentifier:
                visit(current);
                break;
            case N.VariableDeclaration:
                pushReversed(current.data.declarations);
                break;
            case N.VariableDeclarator:
                pending.push(current.data.id);
                break;
            case N.FormalParameter:
                pending.push(current.data.pattern);
                break;
            case N.ObjectPattern:
                pushReversed(current.data.properties);
                break;
            case N.ObjectProperty:
                pending.push(current.data.value);
                break;
            case N.ArrayPattern:
                pushReversed(current.data.elements);
                break;
            case N.AssignmentPattern:
                pending.push(current.data.left);
                break;
            case N.RestElement:
                pending.push(current.data.argument);
                break;
            case N.FunctionDeclaration:
            case N.ClassDeclaration:
                if (current.data.id !== null) visit(current.data.id);
                break;
            case N.TSEnumDeclaration:
            case N.TSModuleDeclaration:
                if (current.data.id.type === N.BindingIdentifier) visit(current.data.id);
                break;
        }
    }
}
