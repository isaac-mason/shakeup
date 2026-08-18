import { describe, expect, it } from 'vitest';
import { devTransform } from '../src/transform.ts';

const noop = () => {};

/** Execute devTransform output against a stub `__shakeup` runtime; return the module exports. */
async function runDev(filename: string, src: string, link: (spec: string) => unknown = () => ({})): Promise<Record<string, unknown>> {
    const r = devTransform(filename, src, {});
    expect(r.errors).toEqual([]);
    const ns: Record<string, unknown> = {};
    const __shakeup = {
        link: async (spec: string) => link(spec),
        live: (g: Record<string, () => unknown>) => {
            for (const k of Object.keys(g)) Object.defineProperty(ns, k, { get: g[k], enumerable: true, configurable: true });
        },
        exportAll: (o: Record<string, unknown>) => {
            for (const k of Object.keys(o))
                if (k !== 'default' && !(k in ns)) Object.defineProperty(ns, k, { get: () => o[k], enumerable: true, configurable: true });
        },
        meta: { url: 'file:///m', filename: 'm', env: { MODE: 'test' }, hot: { data: {}, accept: noop, dispose: noop, on: noop, off: noop, send: noop, invalidate: noop, prune: noop, acceptExports: noop } },
    };
    // biome-ignore lint/security/noGlobalEval: test-only evaluation of trusted output.
    await new Function('__shakeup', `return (async () => {\n${r.code}\n})()`)(__shakeup);
    return ns;
}

const jsxRuntime = {
    jsx: (t: unknown, p: Record<string, unknown> | null) => ({ t, p }),
    jsxs: (t: unknown, p: Record<string, unknown> | null) => ({ t, p }),
    Fragment: { $frag: true },
};

describe('devTransform — TS strip (execution + shape)', () => {
    it('erases type annotations, keeps runtime values', async () => {
        const ns = await runDev('t.ts', `const x: number = 1;\nexport const y: number = x + 1;`);
        expect(ns.y).toBe(2);
        expect(devTransform('t.ts', `const x: number = 1;`, {}).code).not.toMatch(/:\s*number/);
    });

    it('value imports are linked (never elided); type-only imports are dropped', () => {
        const r = devTransform('t.ts', `import { dep } from './d';\nimport type { T } from './t';\nimport { a, type B } from './m';\nexport const u = dep;`, {});
        expect(r.deps).toContain('./d');
        expect(r.deps).toContain('./m');
        expect(r.deps).not.toContain('./t'); // type-only import erased, not linked
        expect(r.code).not.toMatch(/\bimport\b/); // no raw ESM survives
    });

    it('rejects unsupported constructs loudly (never silent miscompile)', () => {
        const rejects = (src: string, needle: RegExp) => {
            const r = devTransform('t.ts', src, {});
            expect(r.errors.length).toBeGreaterThan(0);
            expect(r.errors.join('\n')).toMatch(needle);
            expect(r.code).toBe('');
        };
        rejects(`namespace N { export const y = 1 }`, /value namespaces/);
        rejects(`@dec class A {}`, /decorators/);
    });

    it('allows `declare namespace` (ambient, erased)', () => {
        const r = devTransform('t.ts', `declare namespace N { const y: number }\nexport const z = 1;`, {});
        expect(r.errors).toEqual([]);
        expect(r.code).not.toMatch(/namespace N/);
    });
});

describe('devTransform — TS lowerings (execution)', () => {
    it('lowers enums (incl. flag enums with intra-member + parenthesized inits)', async () => {
        const ns = await runDev('t.ts', `export enum F { A = 1 << 0, B = 1 << 1, AB = A | B, YZ = (1 << 0) | (1 << 1) }\nexport const v = [F.A, F.B, F.AB, F.YZ];`);
        expect(ns.v).toEqual([1, 2, 3, 3]);
    });

    it('lowers parameter properties to constructor assignments', async () => {
        const ns = await runDev('t.ts', `class A { constructor(private x: number, readonly y = 7) {} }\nexport const inst = new A(3);`);
        expect(ns.inst).toMatchObject({ x: 3, y: 7 });
    });
});

describe('devTransform — JSX (execution)', () => {
    it('lowers JSX to the linked automatic runtime and resolves imported components', async () => {
        const src = 'import { Icon } from "./icon";\nexport const App = () => <div className="a"><Icon size={2}/></div>;';
        const Icon = (): string => 'icon';
        const ns = await runDev('t.tsx', src, (spec) => (spec === './icon' ? { Icon } : jsxRuntime));
        const el = (ns.App as () => { t: unknown; p: Record<string, unknown> }) ();
        expect(el.t).toBe('div'); // intrinsic stays a string
        expect((el.p.children as { t: unknown }).t).toBe(Icon); // component tag resolved through the import
    });

    it('honors a custom jsx importSource', () => {
        const r = devTransform('t.tsx', `export const A = () => <div/>;`, { jsx: { importSource: 'preact' } });
        expect(r.deps).toContain('preact/jsx-runtime');
    });

    it('a user identifier colliding with a runtime local does not break lowering', async () => {
        // `_0` present in user code must not collide with the runtime module local.
        const ns = await runDev('t.tsx', `const _0 = "user";\nexport const A = () => <div/>;\nexport const kept = _0;`, () => jsxRuntime);
        expect(ns.kept).toBe('user');
        expect(typeof ns.A).toBe('function');
    });

    it('no runtime linked when there is no JSX', () => {
        const r = devTransform('t.tsx', `export const x: number = 1;`, {});
        expect(r.deps).not.toContain('react/jsx-runtime');
    });
});

describe('devTransform — runner protocol', () => {
    it('emits the __shakeup protocol, not raw ESM', () => {
        const r = devTransform('t.ts', `import { x } from './m';\nexport const y = x;`, {});
        expect(r.code).toContain('__shakeup.link');
        expect(r.code).toContain('__shakeup.live');
        expect(r.code).not.toMatch(/^import /m);
    });

    it('end-to-end: imports, live exports, dynamic import, re-export all execute', async () => {
        const ns = await runDev(
            't.ts',
            `import d from './m';\nimport * as n from './n';\nexport * from './b';\nexport const out = [d, n.x];\nexport const load = () => import('./lazy');`,
            (spec) => (spec === './m' ? { default: 'D' } : spec === './n' ? { x: 'X' } : spec === './b' ? { extra: 1 } : {}),
        );
        expect(ns.out).toEqual(['D', 'X']);
        expect(ns.extra).toBe(1); // export * flowed through
        expect(typeof ns.load).toBe('function');
    });
});
