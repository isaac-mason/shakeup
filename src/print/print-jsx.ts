import { N, type Node } from '../ast';
import { attrKeyText, attrsHaveKeyAfterSpreadEmit, childrenAreStatic, decodeJSXEntities, normalizeJSXText } from '../jsx-text';
import { Prec } from './precedence';
import { printExpr } from './print-js';
import { mark, type Printer, softSpace, write } from './printer';

// Loose view of a node's payload (JSX node types aren't narrowable through `n.data`).
type JD = Record<string, Node | (Node | null)[] | string | number | boolean | null>;
const jd = (n: Node): JD => n.data as unknown as JD;

/** Emit a JSXElement/JSXFragment as an automatic-runtime call. Native port of emit.ts
 *  `lowerJSX` (`src/emit.ts:503`): the call scaffolding is generated; every value
 *  (attributes, children, key) is printed through `printExpr`, so nesting, renaming, and
 *  minification all compose for free. Requires `p.jsx` (runtime + rename hooks). */
export function emitJSX(p: Printer, node: Node): void {
    const jsx = p.jsx;
    if (jsx === null) throw new Error('printer: JSX node without a configured JSX runtime');

    let tagName: Node | null;
    let attributes: Node[];
    let children: Node[];
    if (node.type === N.JSXFragment) {
        tagName = null;
        attributes = [];
        children = jd(node).children as Node[];
    } else {
        const d = node.data as { openingElement: Node; children: Node[] };
        const opening = jd(d.openingElement);
        tagName = opening.name as Node;
        attributes = opening.attributes as Node[];
        children = d.children;
    }

    const emitTag = (): void => {
        if (tagName === null) write(p, jsx.runtimeName('Fragment'));
        else emitJSXTag(p, tagName);
    };

    const childItems = collectChildren(children);

    // `key` after a spread cannot be hoisted to the props object → classic createElement.
    if (attrsHaveKeyAfterSpreadEmit(attributes)) {
        write(p, jsx.runtimeName('createElement'));
        write(p, '(');
        emitTag();
        const propAttrs = attributes.filter((a) => a.type === N.JSXSpreadAttribute || a.type === N.JSXAttribute);
        if (propAttrs.length > 0) {
            write(p, ',');
            softSpace(p);
            emitPropsObject(p, propAttrs);
        } else {
            write(p, ',');
            softSpace(p);
            write(p, 'null');
        }
        for (const c of childItems) {
            write(p, ',');
            softSpace(p);
            emitChild(p, c);
        }
        write(p, ')');
        return;
    }

    // Split out `key`; the rest become props.
    let keyValue: Node | null | undefined; // undefined = no key; null = bare `key` (=> true)
    let hasKey = false;
    const propAttrs: Node[] = [];
    for (const a of attributes) {
        if (a.type === N.JSXSpreadAttribute) {
            propAttrs.push(a);
        } else if (a.type === N.JSXAttribute) {
            const name = jd(a).name as Node;
            if (name.type === N.JSXIdentifier && name.name === 'key') {
                keyValue = jd(a).value as Node | null;
                hasKey = true;
                continue;
            }
            propAttrs.push(a);
        }
    }

    const fn =
        childItems.length > 0 && childrenAreStatic(childItems.map(childText)) ? jsx.runtimeName('jsxs') : jsx.runtimeName('jsx');
    write(p, fn);
    write(p, '(');
    emitTag();
    write(p, ',');
    softSpace(p);
    emitPropsObjectWithChildren(p, propAttrs, childItems);
    if (hasKey) {
        write(p, ',');
        softSpace(p);
        emitAttrValue(p, keyValue ?? null);
    }
    write(p, ')');
}

/** The tag argument: intrinsic name → string literal, component → (renamed) identifier. */
function emitJSXTag(p: Printer, name: Node): void {
    switch (name.type) {
        case N.JSXIdentifier:
            write(p, JSON.stringify(name.name));
            return;
        case N.IdentifierReference:
            write(p, p.jsx?.renameIdent(name) ?? name.name);
            return;
        case N.ThisExpression:
            write(p, 'this');
            return;
        case N.JSXMemberExpression:
            emitJSXTag(p, jd(name).object as Node);
            write(p, '.');
            write(p, (jd(name).property as Node).name);
            return;
        case N.JSXNamespacedName:
            write(p, JSON.stringify(`${(jd(name).namespace as Node).name}:${(jd(name).name as Node).name}`));
            return;
        default:
            // A runner-rewritten import tag (`<Foo/>` where Foo is imported → `_0.Foo`): the pass
            // replaced the IdentifierReference with a member expression, so print it as one.
            printExpr(p, name, Prec.Assign);
    }
}

/** `{ key: value, ...spread }` from a list of JSX attributes (no children). */
function emitPropsObject(p: Printer, attrs: Node[]): void {
    write(p, '{');
    softSpace(p);
    attrs.forEach((a, i) => {
        if (i > 0) {
            write(p, ',');
            softSpace(p);
        }
        emitAttr(p, a);
    });
    softSpace(p);
    write(p, '}');
}

/** Props object folding in a `children:` entry (the jsx/jsxs shape). */
function emitPropsObjectWithChildren(p: Printer, attrs: Node[], childItems: Node[]): void {
    const hasChildren = childItems.length > 0;
    if (attrs.length === 0 && !hasChildren) {
        write(p, '{}');
        return;
    }
    write(p, '{');
    softSpace(p);
    let first = true;
    for (const a of attrs) {
        if (!first) {
            write(p, ',');
            softSpace(p);
        }
        first = false;
        emitAttr(p, a);
    }
    if (hasChildren) {
        if (!first) {
            write(p, ',');
            softSpace(p);
        }
        write(p, 'children:');
        softSpace(p);
        // A single non-spread child is the value directly; otherwise a static array.
        if (childItems.length === 1 && childItems[0].type !== N.JSXSpreadChild) {
            emitChild(p, childItems[0]);
        } else {
            write(p, '[');
            childItems.forEach((c, i) => {
                if (i > 0) {
                    write(p, ',');
                    softSpace(p);
                }
                emitChild(p, c);
            });
            write(p, ']');
        }
    }
    softSpace(p);
    write(p, '}');
}

function emitAttr(p: Printer, a: Node): void {
    if (a.type === N.JSXSpreadAttribute) {
        write(p, '...');
        printExpr(p, jd(a).argument as Node, Prec.Assign);
        return;
    }
    // JSXAttribute
    write(p, attrKeyText(jd(a).name as Node));
    write(p, ':');
    softSpace(p);
    emitAttrValue(p, jd(a).value as Node | null);
}

/** An attribute value: absent → `true`; string → decoded literal; `{expr}`/element → the expression. */
function emitAttrValue(p: Printer, value: Node | null): void {
    if (value === null) {
        write(p, 'true');
        return;
    }
    if (value.type === N.StringLiteral) {
        write(p, JSON.stringify(decodeJSXEntities(value.name.slice(1, -1))));
        return;
    }
    if (value.type === N.JSXExpressionContainer) {
        printExpr(p, jd(value).expression as Node, Prec.Assign);
        return;
    }
    printExpr(p, value, Prec.Assign);
}

/** Children that survive to runtime (text collapses/drops per JSX whitespace rules). */
function collectChildren(children: Node[]): Node[] {
    const out: Node[] = [];
    for (const child of children) {
        if (child.type === N.JSXText) {
            if (normalizeJSXText(child.name) !== null) out.push(child);
        } else if (child.type === N.JSXExpressionContainer) {
            if ((jd(child).expression as Node).type !== N.JSXEmptyExpression) out.push(child);
        } else if (child.type === N.JSXSpreadChild || child.type === N.JSXElement || child.type === N.JSXFragment) {
            out.push(child);
        }
    }
    return out;
}

/** The runtime text of a child, used only to classify static-ness (jsx vs jsxs). */
function childText(child: Node): string {
    return child.type === N.JSXSpreadChild ? '...x' : 'x';
}

function emitChild(p: Printer, child: Node): void {
    mark(p, child);
    if (child.type === N.JSXText) {
        write(p, JSON.stringify(normalizeJSXText(child.name)));
        return;
    }
    if (child.type === N.JSXExpressionContainer) {
        printExpr(p, jd(child).expression as Node, Prec.Assign);
        return;
    }
    if (child.type === N.JSXSpreadChild) {
        write(p, '...');
        printExpr(p, jd(child).expression as Node, Prec.Assign);
        return;
    }
    // Nested JSXElement / JSXFragment.
    printExpr(p, child, Prec.Assign);
}
