import { describe, expect, it } from 'vitest';
import { analyze, createSemantic, type JSXOptions, type Node, parse, resolveJSXOptions, scanJSX } from '../src/index.ts';
import { assembleRunner, createRunnerCtx, linkRuntime, moduleRunnerPass } from '../src/pass/module-runner.ts';
import { runPass } from '../src/pass/traverse.ts';
import { printModule } from '../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../src/print/printer.ts';

/** The Branch-A JSX dev path: runner pass rewrites refs (incl. component tags), the printer lowers
 *  JSX, and the runtime is linked + referenced as member text. */
function devJsx(filename: string, src: string, jsxOptions: JSXOptions = {}): string {
    const tsx = filename.endsWith('.tsx');
    const { program } = parse(src, { ts: tsx, jsx: true });
    const semantic = createSemantic();
    analyze(semantic, program);
    const { hasJSX, needsCreateElement } = scanJSX(program);
    const ctx = createRunnerCtx(src, semantic);
    runPass(program as Node, moduleRunnerPass, ctx);
    let jsxLower = null;
    if (hasJSX) {
        const { importSource } = resolveJSXOptions(jsxOptions);
        const rt = linkRuntime(ctx, `${importSource}/jsx-runtime`);
        const ce = needsCreateElement ? linkRuntime(ctx, importSource) : '';
        jsxLower = { renameIdent: () => null, runtimeName: (k: string) => (k === 'createElement' ? `${ce}.createElement` : `${rt}.${k}`) };
    }
    const p = createPrinter({ minify: false }, { jsx: jsxLower });
    printModule(p, program);
    return assembleRunner(ctx, finishPrinter(p));
}

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

describe('JSX dev path (pass + printer) — executes correctly', () => {
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
