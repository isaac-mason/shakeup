// JSX syntax corners: fragments, member-expression heads, namespaced names,
// dashed intrinsics, boolean-like attributes, empty containers, spread children,
// nested attribute-value elements, whitespace/newline text, entities (raw in P1).
import { Menu } from './menu';

const memberHead = <Menu.Item icon="home">Home</Menu.Item>;
const deepMember = <A.B.C.D prop={1} />;
const thisHead = <this.Widget />;
const namespaced = <svg:rect x="0" y="0" width="10" height="10" />;
const namespacedAttr = <a xlink:href="#" aria-label="link">go</a>;
const dashed = <my-web-component custom-attr="v" />;
const booleanAttrs = <input disabled required readOnly type="text" />;
const emptyContainer = <div>{}</div>;
const commentOnly = <div>{/* nothing here */}</div>;
const spreadChild = <ul>{...items}</ul>;
const nestedAttr = <Modal title={<strong>Warning</strong>} footer={<></>} />;

const multiline = (
    <section>
        This    is   some
        text   with   irregular

        whitespace and newlines.
        {value}
        Trailing text &amp; entities &#8226; here.
    </section>
);

const conditional = flag ? <Yes /> : <No count={n} />;
const listOfFragments = items.map((it) => (
    <React.Fragment key={it.id}>
        <dt>{it.term}</dt>
        <dd>{it.definition}</dd>
    </React.Fragment>
));

export { memberHead, deepMember, thisHead, namespaced, namespacedAttr, dashed, booleanAttrs, emptyContainer, commentOnly, spreadChild, nestedAttr, multiline, conditional, listOfFragments };
