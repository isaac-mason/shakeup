import { A, type Ast, FL, N, type NodeId, walkChildren } from '../ast';

/**
 * Visit every Ident in `node`'s subtree that is a reference or binding
 * occurrence, skipping mere-name Idents (non-computed member/object/class keys,
 * labels, import/export specifier names). `cb`'s `shorthandProp` is the
 * shorthand-property node id when the Ident is a shorthand object-property key
 * (`{ a }` / `{ a = 1 }`) and 0 otherwise — renamers must then expand to
 * `a: a$1` rather than replace the span.
 */
export function walkRefIdents(
    ast: Ast,
    node: NodeId,
    cb: (ident: NodeId, shorthandProp: NodeId) => void,
): void {
    const t = ast.type[node];
    if (t === N.Ident) {
        cb(node, 0);
        return;
    }
    if (t === N.Property && (ast.flags[node] & FL.SHORTHAND) !== 0) {
        const key = A.Property.key(ast, node);
        const value = A.Property.value(ast, node);
        if (ast.type[key] === N.Ident) cb(key, node);
        if (value !== key && ast.type[value] === N.AssignPattern) {
            walkRefIdents(ast, A.AssignPattern.right(ast, value), cb);
        }
        return;
    }
    if (t === N.Member && (ast.flags[node] & FL.COMPUTED) === 0) {
        walkRefIdents(ast, A.Member.object(ast, node), cb);
        return;
    }
    if ((t === N.MethodDef || t === N.PropDef || t === N.TSPropSig) && (ast.flags[node] & FL.COMPUTED) === 0) {
        // walk everything except the non-computed key
        const key = t === N.MethodDef ? A.MethodDef.key(ast, node) : t === N.PropDef ? A.PropDef.key(ast, node) : A.TSPropSig.key(ast, node);
        walkChildren(ast, node, (child) => {
            if (child !== key) walkRefIdents(ast, child, cb);
        });
        return;
    }
    walkChildren(ast, node, (child) => {
        walkRefIdents(ast, child, cb);
    });
}
