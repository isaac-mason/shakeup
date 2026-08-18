import { describe, expect, it } from 'vitest';
import { devTransform, type JSXOptions } from '../src/index.ts';

/** The dev JSX path is just devTransform on a `.tsx`/`.jsx` module (runner-link rewrites refs incl.
 *  component tags; the printer lowers JSX; the runtime is linked + referenced as member text). */
const devJsx = (filename: string, src: string, jsxOptions: JSXOptions = {}): string => devTransform(filename, src, { jsx: jsxOptions }).code;

type El = { t: unknown; p: Record<string, unknown> | null; k: unknown };
const jsxRuntime = {
    jsx: (t: unknown, p: Record<string, unknown> | null, k: unknown): El => ({ t, p, k }),
    jsxs: (t: unknown, p: Record<string, unknown> | null, k: unknown): El => ({ t, p, k }),
    Fragment: { $frag: true },
};

async function runModule(code: string, modules: Record<string, unknown>): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const shakeup = {
        link: async (spec: string) => modules[spec],
        live: (obj: Record<string, () => unknown>) => {
            for (const k of Object.keys(obj)) Object.defineProperty(out, k, { get: obj[k], enumerable: true, configurable: true });
        },
        meta: { url: 'file:///m' },
        exportAll: () => {},
    };
    // biome-ignore lint/security/noGlobalEval: test harness executing generated runner code
    const fn = new Function('__shakeup', `return (async () => {\n${code}\n})();`);
    await fn(shakeup);
    return out;
}

describe('devTransform — JSX executes correctly', () => {
    it('resolves an imported component tag through member access', async () => {
        const src = 'import { Foo } from "./c";\nexport const App = () => <Foo x={1}>hi</Foo>;\n';
        const code = devJsx('/m.tsx', src);
        const Foo = (): string => 'foo';
        const out = await runModule(code, { './c': { Foo }, 'react/jsx-runtime': jsxRuntime, react: jsxRuntime });
        const el = (out.App as () => El)();
        expect(el.t).toBe(Foo); // <Foo/> resolved to the imported component, not a stray identifier
        expect(el.p?.x).toBe(1);
        expect(el.p?.children).toBe('hi');
    });

    it('keeps intrinsic (lowercase) tags as strings and lowers fragments', async () => {
        const src = 'export const V = () => <><div id="a">x</div></>;\n';
        const code = devJsx('/m.tsx', src);
        const out = await runModule(code, { 'react/jsx-runtime': jsxRuntime, react: jsxRuntime });
        const el = (out.V as () => El)();
        expect(el.t).toBe(jsxRuntime.Fragment); // fragment
        const child = el.p?.children as El;
        expect(child.t).toBe('div'); // intrinsic stays a string
        expect(child.p?.id).toBe('a');
    });
});
