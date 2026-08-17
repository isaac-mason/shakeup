import esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

const SHIM_JS = `
export const Fragment = { $$frag: true };
function normType(t) { return t === Fragment ? 'Fragment' : t; }
function element(kind, type, props, key) { return { kind, type: normType(type), props: props ?? null, key: key === undefined ? null : key }; }
export function jsx(type, props, key) { return element('jsx', type, props, key); }
export function jsxs(type, props, key) { return element('jsxs', type, props, key); }
export function createElement(type, props, ...children) { return { kind: 'createElement', type: normType(type), props: props ?? null, children }; }
`;

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

function normalize(v: unknown): unknown {
    if (typeof v === 'function') return { $fn: (v as { name: string }).name };
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v)) out[k] = normalize(val);
        return out;
    }
    return v;
}

async function ours(fixture: string): Promise<Record<string, unknown>> {
    const files = { '/main.tsx': fixture, '/react/jsx-runtime.ts': SHIM_JS, '/react.ts': SHIM_JS };
    const resolve = (spec: string): string | null =>
        spec === 'react/jsx-runtime' ? '/react/jsx-runtime.ts' : spec === 'react' ? '/react.ts' : null;
    const r = await bundle({ entry: '/main.tsx', fs: createMemoryFs(files), external: [], resolve });
    expect(r.errors, `our bundle errored: ${r.errors.join(', ')}`).toEqual([]);
    return run(r.code);
}

async function esb(fixture: string): Promise<Record<string, unknown>> {
    const out = await esbuild.transform(fixture, {
        loader: 'tsx',
        jsx: 'automatic',
        jsxImportSource: 'react',
    });
    const body = out.code
        .replace(/import\s*\{[^}]*\}\s*from\s*["']react\/jsx-runtime["'];?/g, '')
        .replace(/import\s*\{[^}]*\}\s*from\s*["']react["'];?/g, '');
    return run(`${SHIM_JS}\n${body}`);
}

/** Each fixture exports named values; assert our tree equals esbuild's tree and
 * (via the first) matches the expected shape structurally. */
const FIXTURES: Record<string, string> = {
    'intrinsic + attrs + text child': `
        export const v = <div className="x" id={"y"}>hello</div>;
    `,
    'jsxs for multiple children': `
        export const v = <div>{1}{2}{3}</div>;
    `,
    'key as third arg': `
        export const v = <li key={"k"} className="c">item</li>;
    `,
    'key-after-spread → createElement fallback': `
        const p = { a: 1 };
        export const v = <div {...p} key={"z"} className="c" />;
    `,
    'spread props (no key)': `
        const p = { a: 1, b: 2 };
        export const v = <div {...p} id="x" />;
    `,
    'fragment with children': `
        export const v = <><span>a</span><span>b</span></>;
    `,
    nesting: `
        export const v = <div className="a"><div className="b"><span>{deep()}</span></div></div>;
        function deep() { return 'D'; }
    `,
    'text whitespace normalization': `
        export const v = (
            <section>
                This    is   some
                text   with   irregular

                whitespace and newlines.
            </section>
        );
    `,
    'entities in text and attributes': `
        export const v = <span title="a &amp; b">x &copy; y &#8226; z</span>;
    `,
    'member head': `
        const Ns = { Item(props) { return { it: props }; } };
        export const v = <Ns.Item foo={1}>hi</Ns.Item>;
    `,
    'this head': `
        const host = { Widget: (p) => ({ w: p }), make() { return <this.Widget a={1} />; } };
        export const v = host.make();
    `,
    'generic component tag (tsx)': `
        function List(props) { return props; }
        export const v = <List<number> items={[1, 2, 3]} />;
    `,
    'single spread child → jsxs': `
        const items = [<span key="a">1</span>, <span key="b">2</span>];
        export const v = <ul>{...items}</ul>;
    `,
    'capitalized component with expression children': `
        function Card(props) { return props; }
        const users = [{ id: 1 }, { id: 2 }];
        export const v = <Card>{users.map((u) => <span key={u.id}>{u.id}</span>)}</Card>;
    `,
    'conditional child + logical': `
        const flag = true, n = 5;
        export const v = <div>{flag ? <b>yes</b> : null}{n > 0 && <i>{n}</i>}</div>;
    `,
    'boolean-like attributes': `
        export const v = <input disabled required type="text" />;
    `,
    'nested element as attribute value': `
        function Modal(props) { return props; }
        export const v = <Modal title={<strong>Warn</strong>} footer={<></>} />;
    `,
};

describe('G-JSX-2: execution oracle + esbuild differential', () => {
    for (const [name, fixture] of Object.entries(FIXTURES)) {
        it(`renders identically to esbuild: ${name}`, async () => {
            const mine = await ours(fixture);
            const theirs = await esb(fixture);
            expect(mine.v).toBeDefined();
            expect(normalize(mine.v), 'export `v` differs from esbuild').toEqual(normalize(theirs.v));
        });
    }

    it('shim sanity: a basic tree has the expected shape', async () => {
        const mod = await ours(`export const v = <div className="c">hi</div>;`);
        expect(mod.v).toEqual({ kind: 'jsx', type: 'div', props: { className: 'c', children: 'hi' }, key: null });
    });
});
