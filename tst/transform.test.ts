import { describe, expect, it } from 'vitest';
import { devTransform, moduleRunnerTransform, transform } from '../src/transform.ts';

/** Transform, asserting no diagnostics, and return the code. */
function ok(filename: string, src: string): string {
    const { code, errors } = transform(filename, src);
    expect(errors).toEqual([]);
    return code;
}

/** Evaluate transformed code (module-body form: strip `export ` for a plain eval)
 * and return whatever `${expr}` yields in its scope. */
function run(src: string, expr: string): unknown {
    const code = ok('t.ts', src).replace(/\bexport /g, '');
    // biome-ignore lint/security/noGlobalEval: test-only evaluation of trusted output.
    return new Function(`${code}\n;return (${expr});`)();
}

describe('transform — TS strip', () => {
    it('erases type annotations but keeps runtime code', () => {
        const code = ok('t.ts', `const x: number = 1;\nlet y: string;`);
        expect(code).not.toMatch(/:\s*number/);
        expect(code).toContain('const x');
        expect(code).toContain('= 1');
    });

    it('NEVER elides value imports (onlyRemoveTypeImports guarantee)', () => {
        const code = ok('t.ts', `import { dep } from './d';\nimport './side-effect';\nconst x: number = 1;`);
        expect(code).toContain(`import { dep } from './d'`);
        expect(code).toContain(`import './side-effect'`);
    });

    it('removes `import type` and type-only specifiers', () => {
        const code = ok('t.ts', `import type { T } from './t';\nimport { a, type B } from './m';`);
        expect(code).not.toMatch(/import type/);
        expect(code).not.toMatch(/\bB\b/);
        expect(code).toContain('a');
    });

    it('preserves export statements verbatim (dropExportKeyword=false)', () => {
        const code = ok('t.ts', `export const a = 1;\nexport { a as b };\nexport default 5;`);
        expect(code).toContain('export const a');
        expect(code).toContain('export { a as b }');
        expect(code).toContain('export default');
    });
});

describe('transform — lowerings (execution)', () => {
    it('lowers TS enums', () => {
        expect(run(`enum E { A, B }`, 'E.A')).toBe(0);
        expect(run(`enum E { A, B }`, 'E.B')).toBe(1);
        expect(run(`enum E { A = 5, B }`, 'E.B')).toBe(6);
    });

    it('lowers flag enums with intra-member + parenthesized initializers', () => {
        // `AB = A | B` must qualify prior members (E.A | E.B); parenthesized inits
        // must keep their outer parens. Regression: bare `A` was a ReferenceError,
        // and `(1<<4)|(1<<5)` had its outer parens dropped.
        const src = `enum F { A = 1 << 0, B = 1 << 1, AB = A | B, YZ = (1 << 0) | (1 << 1) }
            export const v = [F.A, F.B, F.AB, F.YZ];`;
        expect(run(src, 'JSON.stringify(v)')).toBe(JSON.stringify([1, 2, 3, 3]));
    });

    it('lowers parameter properties to constructor assignments', () => {
        const inst = run(`class A { constructor(private x: number, readonly y = 7) {} }`, 'new A(3)') as {
            x: number;
            y: number;
        };
        expect(inst.x).toBe(3);
        expect(inst.y).toBe(7);
    });
});

describe('transform — JSX', () => {
    it('lowers JSX and injects the automatic runtime import', () => {
        const code = ok('t.tsx', `const App = () => <div className="a">{x}</div>;`);
        expect(code).toContain(`from 'react/jsx-runtime'`);
        expect(code).toMatch(/_jsx\("div",/);
        expect(code).not.toMatch(/<div/);
    });

    it('honors a custom jsx importSource', () => {
        const { code } = transform('t.tsx', `const A = () => <div/>;`, { jsx: { importSource: 'preact' } });
        expect(code).toContain(`from 'preact/jsx-runtime'`);
    });

    it('deconflicts runtime locals against user identifiers', () => {
        const code = ok('t.tsx', `const _jsx = 1; const A = () => <div/>;`);
        expect(code).toMatch(/jsx as _jsx1\b/); // runtime local renamed
        expect(code).toContain('const _jsx = 1'); // user binding untouched
    });

    it('does not inject a runtime import when there is no JSX', () => {
        const code = ok('t.tsx', `const x: number = 1;`);
        expect(code).not.toContain('jsx-runtime');
    });
});

describe('transform — unsupported constructs fail loudly (never silent miscompile)', () => {
    const rejects = (src: string, needle: RegExp) => {
        const { code, errors } = transform('t.ts', src);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.join('\n')).toMatch(needle);
        expect(code).toBe('');
    };

    it('rejects value namespaces', () => rejects(`namespace N { export const y = 1 }`, /value namespaces/));
    it('rejects decorators', () => rejects(`@dec class A {}`, /decorators/));
    it('rejects import-equals', () => rejects(`import X = require('y')`, /expected/));

    it('allows `declare namespace` (ambient, erased)', () => {
        const { code, errors } = transform('t.ts', `declare namespace N { const y: number }\nexport const z = 1;`);
        expect(errors).toEqual([]);
        expect(code).toContain('export const z');
        expect(code).not.toMatch(/namespace N/);
    });
});

describe('transform — passthrough', () => {
    it('returns plain JS unchanged', () => {
        const src = `const x = 1;\nexport const y = x + 1;\n`;
        expect(transform('t.js', src).code).toBe(src);
    });
});

// ─── moduleRunnerTransform (native __shakeup protocol) ───────────────────────

/** the transformed code, asserting no diagnostics. */
function mrt(src: string): string {
    const r = moduleRunnerTransform('m.js', src);
    expect(r.errors).toEqual([]);
    return r.code;
}

/** run transformed code against a stub __shakeup runtime; return the exports. */
async function runModule(src: string, link: (spec: string) => unknown): Promise<Record<string, unknown>> {
    const ns: Record<string, unknown> = {};
    const __shakeup = {
        link: async (spec: string) => link(spec),
        live: (g: Record<string, () => unknown>) => {
            for (const k of Object.keys(g)) Object.defineProperty(ns, k, { get: g[k], enumerable: true, configurable: true });
        },
        exportAll: (o: Record<string, unknown>) => {
            for (const k of Object.keys(o))
                if (k !== 'default' && !(k in ns))
                    Object.defineProperty(ns, k, { get: () => o[k], enumerable: true, configurable: true });
        },
        meta: { url: 'file:///m', hot: undefined },
    };
    // biome-ignore lint/security/noGlobalEval: test-only evaluation of trusted output.
    await new Function('__shakeup', `return (async () => {\n${mrt(src)}\n})()`)(__shakeup);
    return ns;
}

describe('moduleRunnerTransform — imports + references', () => {
    it('hoists imports to __shakeup.link and rewrites named refs to members', () => {
        const code = mrt(`import { ref } from 'vue';\nconst x = ref;`);
        expect(code).toContain(`const _0 = await __shakeup.link('vue');`);
        expect(code).toContain('const x = _0.ref');
    });

    it('default import → _0.default; namespace → _0', () => {
        const code = mrt(`import foo from 'a';\nimport * as ns from 'b';\nconst x = [foo.bar, ns.k];`);
        expect(code).toContain('_0.default.bar');
        expect(code).toContain('_1.k');
    });

    it('expands object shorthand', () => {
        expect(mrt(`import { inject } from 'v';\nconst o = { inject };`)).toContain('{ inject: _0.inject }');
    });

    it('rewrites arbitrary module-namespace names with bracket access', () => {
        expect(mrt(`import { "a b" as x } from 'm';\nconst y = x;`)).toContain(`_0["a b"]`);
    });

    it('does NOT rewrite a reference shadowed by a local binding', () => {
        const code = mrt(`import { fn } from 'v';\nfunction A(){ const fn = 1; return fn; }`);
        expect(code).toContain('const fn = 1; return fn;'); // inner fn untouched
        expect(code).not.toMatch(/return _0\.fn/);
    });

    it('rewrites import.meta and dynamic import; collects deps', () => {
        const r = moduleRunnerTransform('m.js', `const u = import.meta.url;\nexport const f = () => import('./x');`);
        expect(r.code).toContain('__shakeup.meta.url');
        expect(r.code).toContain(`__shakeup.link('./x')`);
        expect(r.dynamicDeps).toEqual(['./x']);
        expect(r.deps).toEqual([]);
    });
});

describe('moduleRunnerTransform — this-preservation', () => {
    it('wraps a named-import callee as (0, _0.x) but not a namespace member call', () => {
        expect(mrt(`import { fn } from 'v';\nfn();`)).toContain('(0, _0.fn)()');
        expect(mrt(`import foo from 'v';\nfoo();`)).toContain('(0, _0.default)()');
        // namespace member call keeps its receiver — no wrap
        const nsCall = mrt(`import * as m from 'v';\nm.fn();`);
        expect(nsCall).toContain('_0.fn()');
        expect(nsCall).not.toContain('(0,');
    });

    it('wraps a tagged-template tag that is a named import', () => {
        expect(mrt(`import { tag } from 'v';\ntag\`x\`;`)).toContain('(0, _0.tag)`x`');
    });

    it('EXECUTION: named-import call is receiver-free; namespace call keeps receiver', async () => {
        const nsObj: Record<string, unknown> = {
            fn(this: unknown) {
                return this === nsObj ? 'bound' : 'unbound';
            },
        };
        const named = await runModule(`import { fn } from 'v';\nexport const r = fn();`, () => nsObj);
        expect(named.r).toBe('unbound'); // (0, _0.fn)() → receiver dropped
        const ns = await runModule(`import * as m from 'v';\nexport const r = m.fn();`, () => nsObj);
        expect(ns.r).toBe('bound'); // _0.fn() → receiver is the namespace
    });
});

describe('moduleRunnerTransform — exports', () => {
    it('declares named/default/class exports as live getters', () => {
        const code = mrt(`export const a = 1;\nexport function f(){}\nexport class C {}`);
        expect(code).toContain('__shakeup.live({ a: () => a, f: () => f, C: () => C });');
        expect(code).toContain('const a = 1'); // decl kept, `export` stripped
    });

    it('preserves the async keyword when stripping export (regression)', () => {
        // `export async function` — decl.start excludes `async`, so a naive strip to
        // decl.start would erase it, breaking `await` inside → invalid JS.
        expect(mrt(`export async function f() { await x; }`)).toContain('async function f()');
        expect(mrt(`export default async function g() {}`)).toContain('async function g()');
    });

    it('export default expr → const _default + live', () => {
        const code = mrt(`export default { v: 1 };`);
        expect(code).toContain('__shakeup.live({ default: () => _default });');
        expect(code).toMatch(/const _default =\s+\{ v: 1 \};/);
    });

    it('EXECUTION: exports are live (reflect later mutation)', async () => {
        const ns = await runModule(`export let n = 1;\nn = 42;`, () => ({}));
        expect(ns.n).toBe(42);
    });
});

describe('moduleRunnerTransform — re-exports', () => {
    it('export … from → link + member getters', () => {
        const code = mrt(`export { a, b as c } from 'src';`);
        expect(code).toContain('__shakeup.live({ a: () => _0.a, c: () => _0.b });');
        expect(code).toContain(`const _0 = await __shakeup.link('src');`);
    });

    it('export * → exportAll; export * as → named namespace export', () => {
        expect(mrt(`export * from 'src';`)).toContain('__shakeup.exportAll(_0);');
        expect(mrt(`export * as all from 'src';`)).toContain('__shakeup.live({ all: () => _0 });');
    });

    it('EXECUTION: export * copies names; local exports win over star', async () => {
        const ns = await runModule(`export const a = 99;\nexport * from 'src';`, () => ({ a: 1, b: 2, default: 3 }));
        expect(ns.a).toBe(99); // local precedence
        expect(ns.b).toBe(2); // from star
        expect('default' in ns).toBe(false); // default never re-exported by *
    });
});

// ─── devTransform: fused parse-once (dev-path transform) ─────────────────────

/** run runner-protocol code against a stub __shakeup, return the exports. */
async function runCode(code: string, link: (spec: string) => unknown): Promise<Record<string, unknown>> {
    const ns: Record<string, unknown> = {};
    const noop = () => {};
    const __shakeup = {
        link: async (spec: string) => link(spec),
        live: (g: Record<string, () => unknown>) => {
            for (const k of Object.keys(g)) Object.defineProperty(ns, k, { get: g[k], enumerable: true, configurable: true });
        },
        exportAll: (o: Record<string, unknown>) => {
            for (const k of Object.keys(o))
                if (k !== 'default' && !(k in ns))
                    Object.defineProperty(ns, k, { get: () => o[k], enumerable: true, configurable: true });
        },
        meta: {
            url: 't',
            filename: 't',
            env: {},
            hot: {
                data: {},
                accept: noop,
                dispose: noop,
                invalidate: noop,
                prune: noop,
                on: noop,
                off: noop,
                send: noop,
                acceptExports: noop,
            },
        },
    };
    // biome-ignore lint/security/noGlobalEval: test-only evaluation of trusted output.
    await new Function('__shakeup', `return (async () => {\n${code}\n})()`)(__shakeup);
    return ns;
}

/** a deterministic module namespace for any imported specifier. */
const stubLink = () => ({ x: 'X', a: 1, b: 2, fn: () => 'called', default: 'D' });

describe('devTransform — fused output executes identically to sequential', () => {
    // canonicalize across the two eval runs: functions differ by identity, so tag
    // them; recurse objects; primitives compare directly.
    const canon = (v: unknown, d = 0): unknown => {
        if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return v;
        if (typeof v === 'function') return '[fn]';
        if (d > 4) return '[obj]';
        const o: Record<string, unknown> = {};
        for (const k of Object.keys(v as object)) o[k] = canon((v as Record<string, unknown>)[k], d + 1);
        return o;
    };
    const equivalent = async (src: string) => {
        const fused = devTransform('t.ts', src);
        const seq = moduleRunnerTransform('t.ts', transform('t.ts', src).code);
        expect(fused.errors).toEqual([]);
        expect(seq.errors).toEqual([]);
        expect(canon(await runCode(fused.code, stubLink))).toEqual(canon(await runCode(seq.code, stubLink)));
        return fused;
    };

    it('TS annotations + value imports', () => equivalent(`import { x } from './m';\nexport const y: string = x + '!';`));
    it('enum export', () => equivalent(`export enum E { A, B = 3, C }\nexport const v = [E.A, E.C];`));
    it('parameter properties', () =>
        equivalent(`class P { constructor(public a: number, readonly b = 2) {} }\nexport const r = [new P(9).a, new P(9).b];`));
    it('re-exports + this-preservation', () =>
        equivalent(`export * from './b';\nimport { fn } from './c';\nexport const r = fn();`));
    it('default + namespace + dynamic import', () =>
        equivalent(
            `import d from './m';\nimport * as ns from './n';\nexport const load = () => import('./lazy');\nexport const out = [d, ns.x];`,
        ));

    it('reports fused output has the __shakeup protocol (not raw ESM)', async () => {
        const { code } = devTransform('t.ts', `import { x } from './m';\nexport const y = x;`);
        expect(code).toContain('__shakeup.link');
        expect(code).toContain('__shakeup.live');
        expect(code).not.toMatch(/^import /m);
    });

    it('JSX falls back to the sequential path and still lowers correctly', async () => {
        const { code, errors } = devTransform('t.tsx', `const A = () => <div className="x">hi</div>;\nexport const app = A;`);
        expect(errors).toEqual([]);
        expect(code).toContain('jsx-runtime'); // JSX runtime linked
        expect(code).not.toMatch(/<div/);
    });
});
