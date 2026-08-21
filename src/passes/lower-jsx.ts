// JSX lowering pass (transform stage). Ports the print-time emitter (print/print-jsx.ts) to a
// mutation pass that builds real `jsx()/jsxs()/createElement()` CallExpression AST, so the printer
// becomes pure codegen and JSX lowers uniformly through the transform stage. oxc's `jsx/jsx_impl.rs`
// is the reference: automatic runtime (`_jsx(tag, props, key?)`, `_jsxs` for static children) with a
// classic `createElement(tag, props, ...children)` fallback when a `key` follows a spread. The runtime
// callees are REAL imports — this pass lazily mints their symbols (`declareSyntheticImport`) and, on
// Program exit, injects a real `import { jsx as jsx, … } from "<src>/jsx-runtime"` that the normal
// import scan (bundle `extractRecords` / dev `runnerLink`) picks up like any other import. The call is
// `pure`-annotated per `resolveJSXOptions().pure`; standard side-effect detection judges it (oxc/rolldown
// default — no bespoke JSX purity).
import { declareSyntheticImport, type Semantic } from '../analysis/semantic.ts';
import { N, type Node, node } from '../ast.ts';
import { attrKeyText, childrenAreStatic, decodeJSXEntities, normalizeJSXText } from '../jsx-text.ts';
import * as create from '../parser/create.ts';
import { FL } from '../parser/create.ts';
import { hookTable, type Visitor } from './traverse.ts';

const S = 0; // synthetic span (leaves print verbatim; spans collapse to the JSX site)

const idName = (name: string): Node => node(N.IdentifierName, S, S, name, null);
const str = (text: string): Node => node(N.StringLiteral, S, S, JSON.stringify(text), null);
const boolTrue = (): Node => node(N.BooleanLiteral, S, S, 'true', null);
const member = (obj: Node, prop: Node): Node => create.StaticMemberExpression(S, S, 0, obj, prop) as Node;
// Loose payload view — JSX node types aren't narrowable through `n.data`.
const jd = (n: Node): Record<string, Node | (Node | null)[] | string> => n.data as never;

/** Per-module runtime-import state: each JSX runtime name (`jsx`/`jsxs`/`Fragment`/`createElement`) is
 *  minted on first use and remembered so Program-exit can inject one import per source. */
/** The minted runtime-import symbol ids (0 = not used). Filled by the pass; the bundle caller copies
 *  it onto `mod.jsxRuntime` so the runtime-import prune knows which symbols are the injected runtime. */
export type JsxRuntimeSyms = { jsx: number; jsxs: number; Fragment: number; createElement: number };

type Runtime = {
    semantic: Semantic;
    importSource: string;
    pure: boolean;
    minted: Map<string, Node>; // name → the specifier's local BindingIdentifier (carries the sym)
    out: JsxRuntimeSyms;
};

/** A reference to a runtime callee, minting its import symbol on first use. */
function runtimeRef(rt: Runtime, name: keyof JsxRuntimeSyms): Node {
    let local = rt.minted.get(name);
    if (local === undefined) {
        local = node(N.BindingIdentifier, S, S, name, null);
        declareSyntheticImport(rt.semantic, local); // sets local.sym (SYM.IMPORT, module scope)
        rt.minted.set(name, local);
        rt.out[name] = (local as { sym: number }).sym;
    }
    const ref = node(N.IdentifierReference, S, S, name, null);
    (ref as { sym: number }).sym = (local as { sym: number }).sym;
    return ref;
}

/** The tag argument: intrinsic name → string literal; Fragment → the runtime Fragment ref; component
 *  identifier / member / `this` → the value expression (kept as-is; a later pass rewrites imports). */
function buildTag(rt: Runtime, tagName: Node | null): Node {
    if (tagName === null) return runtimeRef(rt, 'Fragment');
    switch (tagName.type) {
        case N.JSXIdentifier:
            return str(tagName.name);
        case N.JSXMemberExpression:
            return member(buildTag(rt, jd(tagName).object as Node), idName((jd(tagName).property as Node).name));
        case N.JSXNamespacedName:
            return str(`${(jd(tagName).namespace as Node).name}:${(jd(tagName).name as Node).name}`);
        default:
            return tagName; // IdentifierReference (component), ThisExpression, or already-rewritten member
    }
}

/** An attribute value → an expression: absent → `true`; string → decoded literal; `{expr}`/element →
 *  the (already-lowered) expression. */
function buildAttrValue(value: Node | null): Node {
    if (value === null) return boolTrue();
    if (value.type === N.StringLiteral) return str(decodeJSXEntities(value.name.slice(1, -1)));
    if (value.type === N.JSXExpressionContainer) return jd(value).expression as Node;
    return value;
}

/** One attribute → an object member: spread → `...arg`; else `key: value`. */
function buildAttr(a: Node): Node {
    if (a.type === N.JSXSpreadAttribute) return create.SpreadElement(S, S, 0, jd(a).argument as Node) as Node;
    const keyText = attrKeyText(jd(a).name as Node);
    const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(keyText) ? idName(keyText) : str(keyText.slice(1, -1));
    return create.ObjectProperty(S, S, 0, key, buildAttrValue(jd(a).value as Node | null)) as Node;
}

/** Children that survive to runtime (text collapses/drops per JSX whitespace rules). At exit-time
 *  nested elements are already lowered, so anything that isn't dropped text / an empty container is a
 *  runtime child expression. */
function collectChildren(children: Node[]): Node[] {
    const out: Node[] = [];
    for (const c of children) {
        if (c.type === N.JSXText) {
            if (normalizeJSXText(c.name) !== null) out.push(c);
        } else if (c.type === N.JSXExpressionContainer) {
            if ((jd(c).expression as Node).type !== N.JSXEmptyExpression) out.push(c);
        } else out.push(c); // JSXSpreadChild, or a lowered child expression
    }
    return out;
}

/** One child → an expression: text → decoded string; `{expr}` → expr; `{...expr}` → spread; lowered
 *  nested element → itself. */
function buildChild(child: Node): Node {
    if (child.type === N.JSXText) return str(normalizeJSXText(child.name) as string);
    if (child.type === N.JSXExpressionContainer) return jd(child).expression as Node;
    if (child.type === N.JSXSpreadChild) return create.SpreadElement(S, S, 0, jd(child).expression as Node) as Node;
    return child;
}

const childText = (c: Node): string => (c.type === N.JSXSpreadChild ? '...x' : 'x');

/** `{ ...attrs, children: <one | [array]> }` — the automatic-runtime props object. */
function buildPropsWithChildren(attrs: Node[], childItems: Node[]): Node {
    const props = attrs.map(buildAttr);
    if (childItems.length > 0) {
        const value =
            childItems.length === 1 && childItems[0].type !== N.JSXSpreadChild
                ? buildChild(childItems[0])
                : (create.ArrayExpression(S, S, 0, childItems.map(buildChild)) as Node);
        props.push(create.ObjectProperty(S, S, 0, idName('children'), value) as Node);
    }
    return create.ObjectExpression(S, S, 0, props) as Node;
}

/** true when a `key` attribute appears AFTER a spread — forces the classic `createElement` form. */
function keyAfterSpread(attrs: Node[]): boolean {
    let sawSpread = false;
    for (const a of attrs) {
        if (a.type === N.JSXSpreadAttribute) sawSpread = true;
        else if (a.type === N.JSXAttribute) {
            const name = jd(a).name as Node;
            if (sawSpread && name.type === N.JSXIdentifier && name.name === 'key') return true;
        }
    }
    return false;
}

const flags = (pure: boolean): number => (pure ? FL.PURE : 0);

/** Lower one JSXElement/JSXFragment (children already lowered) to a runtime call. */
function lowerJsx(rt: Runtime, tagName: Node | null, attributes: Node[], children: Node[]): Node {
    const tag = buildTag(rt, tagName);
    const childItems = collectChildren(children);

    // `key` after a spread can't hoist into props → classic `createElement(tag, props|null, ...children)`.
    if (keyAfterSpread(attributes)) {
        const propAttrs = attributes.filter((a) => a.type === N.JSXSpreadAttribute || a.type === N.JSXAttribute);
        const props =
            propAttrs.length > 0
                ? (create.ObjectExpression(S, S, 0, propAttrs.map(buildAttr)) as Node)
                : node(N.NullLiteral, S, S, 'null', null);
        const args = [tag, props, ...childItems.map(buildChild)];
        return create.CallExpression(S, S, flags(rt.pure), runtimeRef(rt, 'createElement'), args, null) as Node;
    }

    // Split out `key`; the rest become props.
    let keyValue: Node | null | undefined;
    let hasKey = false;
    const propAttrs: Node[] = [];
    for (const a of attributes) {
        if (a.type === N.JSXSpreadAttribute) propAttrs.push(a);
        else if (a.type === N.JSXAttribute) {
            const name = jd(a).name as Node;
            if (name.type === N.JSXIdentifier && name.name === 'key') {
                keyValue = jd(a).value as Node | null;
                hasKey = true;
                continue;
            }
            propAttrs.push(a);
        }
    }

    const useJsxs = childItems.length > 0 && childrenAreStatic(childItems.map(childText));
    const args = [tag, buildPropsWithChildren(propAttrs, childItems)];
    if (hasKey) args.push(buildAttrValue(keyValue ?? null));
    return create.CallExpression(S, S, flags(rt.pure), runtimeRef(rt, useJsxs ? 'jsxs' : 'jsx'), args, null) as Node;
}

/** The JSX lowering pass — a factory holding per-module runtime-import state. Lowers on EXIT (so nested
 *  children are already runtime calls) and injects the runtime import(s) on Program exit. */
export function makeJsxLower(importSource: string, pure: boolean, out: JsxRuntimeSyms): Visitor {
    const rt: Runtime = { semantic: null as unknown as Semantic, importSource, pure, minted: new Map(), out };
    return {
        name: 'jsxLower',
        enter: null,
        exit: hookTable({
            [N.JSXElement]: (n, ctx) => {
                rt.semantic = ctx.semantic;
                const d = n.data as { openingElement: Node; children: Node[] };
                const opening = d.openingElement.data as { name: Node; attributes: Node[] };
                ctx.replaceWith(lowerJsx(rt, opening.name, opening.attributes, d.children));
            },
            [N.JSXFragment]: (n, ctx) => {
                rt.semantic = ctx.semantic;
                ctx.replaceWith(lowerJsx(rt, null, [], (n.data as { children: Node[] }).children));
            },
            [N.Program]: (n) => {
                if (rt.minted.size === 0) return;
                const jsxSpecs: Node[] = [];
                const rootSpecs: Node[] = [];
                for (const [name, local] of rt.minted) {
                    const spec = create.ImportSpecifier(S, S, 0, local, idName(name)) as Node;
                    (name === 'createElement' ? rootSpecs : jsxSpecs).push(spec);
                }
                const imports: Node[] = [];
                if (jsxSpecs.length > 0)
                    imports.push(create.ImportDeclaration(S, S, 0, jsxSpecs, str(`${importSource}/jsx-runtime`)) as Node);
                if (rootSpecs.length > 0) imports.push(create.ImportDeclaration(S, S, 0, rootSpecs, str(importSource)) as Node);
                (n.data as { body: Node[] }).body.unshift(...imports);
            },
        }),
    };
}
