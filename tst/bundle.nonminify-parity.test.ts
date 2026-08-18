import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

const SHIM = `
export const Fragment = { $frag: true };
export function jsx(type, props, key) { return { type, props: props ?? null, key: key ?? null }; }
export function jsxs(type, props, key) { return { type, props: props ?? null, key: key ?? null }; }
export function createElement(type, props, ...children) { return { type, props, children }; }
`;

function normalize(v: unknown): unknown {
    // A function's `.name` legitimately differs under minify rename, so compare it generically.
    if (typeof v === 'function') return '$fn';
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === 'object') {
        const o: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as object)) o[k] = normalize(val);
        return o;
    }
    return v;
}

const REACT_ALIAS = { alias: { 'react/jsx-runtime': '/react/jsx-runtime.ts', react: '/react.ts' } };

async function bundled(files: Record<string, string>, minify: boolean): Promise<Record<string, unknown>> {
    const withShim = { ...files, '/react/jsx-runtime.ts': SHIM, '/react.ts': SHIM };
    const r = await bundle({ input: '/main.tsx', fs: createMemoryFs(withShim), external: [], resolve: REACT_ALIAS, output: { minify } });
    expect(r.errors, `bundle errored: ${r.errors.join(', ')}`).toEqual([]);
    return run(r.code);
}

// Each case exports `result`; non-minify and minify must execute to the SAME value AND to `expected`.
// Before the cutover this proves edit-engine ≡ printer; after, it guards the printer non-minify path.
const CASES: { name: string; files: Record<string, string>; expected: unknown }[] = [
    {
        name: 'TS strip + import/export + interface erasure',
        files: {
            '/main.tsx': `import { add } from './m';\ninterface X { a: number }\nexport const result: number = add(2 as number, 3);\n`,
            '/m.ts': `export const add = (a: number, b: number): number => a + b;\n`,
        },
        expected: 5,
    },
    {
        name: 're-export + export * + aliases',
        files: {
            '/main.tsx': `export { a, b as bee } from './lib';\nexport * from './more';\nimport { a } from './lib';\nexport const result = a;\n`,
            '/lib.ts': `export const a = 1;\nexport const b = 2;\n`,
            '/more.ts': `export const c = 3;\n`,
        },
        expected: 1,
    },
    {
        name: 'default export (named fn) + usage',
        files: {
            '/main.tsx': `import greet from './g';\nexport const result = greet('x');\n`,
            '/g.ts': `export default function greet(n: string) { return 'hi ' + n; }\n`,
        },
        expected: 'hi x',
    },
    {
        name: 'tree-shaking: dead export with a poison side-effect is dropped',
        files: {
            '/main.tsx': `import { keep } from './m';\nexport const result = keep();\n`,
            '/m.ts': `export const keep = () => 42;\nexport const drop = () => { throw new Error('should be shaken'); };\n`,
        },
        expected: 42,
    },
    {
        name: 'class with TS parameter properties',
        files: {
            '/main.tsx': `class P { constructor(public x: number, private y: number) {} sum() { return this.x + this.y; } }\nexport const result = new P(2, 3).sum();\n`,
        },
        expected: 5,
    },
    {
        name: 'enum lowering',
        files: {
            '/main.tsx': `enum E { A = 1, B }\nexport const result = E.A + E.B;\n`,
        },
        expected: 3,
    },
    {
        name: 'JSX automatic runtime + component + fragment',
        files: {
            '/main.tsx': `import { Box } from './box';\nexport const result = <><Box id="a">hi</Box></>;\n`,
            '/box.tsx': `export const Box = (p: { id: string; children?: unknown }) => ({ box: p.id });\n`,
        },
        expected: { type: { $frag: true }, props: { children: { type: '$fn', props: { id: 'a', children: 'hi' }, key: null } }, key: null },
    },
];

describe('bundle non-minify parity — executes identically to minify (and to expected)', () => {
    for (const c of CASES) {
        it(c.name, async () => {
            const nonmin = normalize((await bundled(c.files, false)).result);
            const min = normalize((await bundled(c.files, true)).result);
            expect(nonmin).toEqual(c.expected);
            expect(min).toEqual(c.expected);
            expect(nonmin).toEqual(min);
        });
    }
});
