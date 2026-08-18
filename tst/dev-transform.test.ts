import { describe, expect, it } from 'vitest';
import { devTransform } from '../src/index.ts';

/** Lower a plain-JS module through the dev transform (the `__shakeup.*` runner protocol). */
const lower = (src: string) => devTransform('/m.js', src);

type Mod = Record<string, unknown>;

/** Execute lowered runner code against a `__shakeup` runtime stub — independent ground truth
 *  (behavior), not a diff against any old implementation. */
async function run(code: string, modules: Record<string, Mod> = {}): Promise<{ exports: Mod; linked: string[] }> {
    const exports: Mod = {};
    const linked: string[] = [];
    const shakeup = {
        link: async (spec: string) => {
            linked.push(spec);
            return modules[spec] ?? {};
        },
        live: (obj: Record<string, () => unknown>) => {
            for (const k of Object.keys(obj)) Object.defineProperty(exports, k, { get: obj[k], enumerable: true, configurable: true });
        },
        meta: { url: 'file:///m.js', env: { MODE: 'test' } },
        exportAll: (ns: Mod) => {
            for (const k of Object.keys(ns)) {
                if (k !== 'default') Object.defineProperty(exports, k, { get: () => ns[k], enumerable: true, configurable: true });
            }
        },
    };
    // biome-ignore lint/security/noGlobalEval: test harness executing generated runner code
    const fn = new Function('__shakeup', `return (async () => {\n${code}\n})();`);
    await fn(shakeup);
    return { exports, linked };
}

describe('devTransform — imports lower + resolve at runtime', () => {
    it('named import resolves through the runtime member', async () => {
        const { exports } = await run(lower('import { a } from "./m";\nexport const r = a;\n').code, { './m': { a: 42 } });
        expect(exports.r).toBe(42);
    });

    it('default import', async () => {
        const { exports } = await run(lower('import f from "./m";\nexport const r = f(3);\n').code, { './m': { default: (n: number) => n * 2 } });
        expect(exports.r).toBe(6);
    });

    it('namespace import', async () => {
        const { exports } = await run(lower('import * as ns from "./m";\nexport const r = ns.x + ns.y;\n').code, { './m': { x: 1, y: 2 } });
        expect(exports.r).toBe(3);
    });

    it('aliased import', async () => {
        const { exports } = await run(lower('import { a as b } from "./m";\nexport const r = b + 1;\n').code, { './m': { a: 10 } });
        expect(exports.r).toBe(11);
    });

    it('non-identifier imported name → computed member', async () => {
        const { exports } = await run(lower('import { "weird-name" as w } from "./m";\nexport const r = w();\n').code, { './m': { 'weird-name': () => 'ok' } });
        expect(exports.r).toBe('ok');
    });

    it('shorthand property expands to a member', async () => {
        const { exports } = await run(lower('import x from "./m";\nexport const r = { x };\n').code, { './m': { default: 'D' } });
        expect(exports.r).toEqual({ x: 'D' });
    });

    it('callee this-preservation: `f()` does not bind `this` to the namespace', async () => {
        const mod = {
            f: function (this: unknown) {
                return this === undefined ? 'unbound' : 'bound';
            },
        };
        const { exports } = await run(lower('import { f } from "./m";\nexport const r = f();\n').code, { './m': mod });
        expect(exports.r).toBe('unbound');
    });

    it('side-effect import links but binds nothing', async () => {
        const { code, deps } = lower('import "./side.js";\nexport const r = 1;\n');
        const { exports, linked } = await run(code, {});
        expect(exports.r).toBe(1);
        expect(linked).toContain('./side.js');
        expect(deps).toEqual(['./side.js']);
    });
});

describe('devTransform — exports lower to live getters', () => {
    it('export const (multiple) / function / class', async () => {
        const { exports } = await run(lower('export const a = 1, b = 2;\nexport function f() { return a; }\nexport class C {}\n').code);
        expect(exports.a).toBe(1);
        expect(exports.b).toBe(2);
        expect((exports.f as () => number)()).toBe(1);
        expect(typeof exports.C).toBe('function');
    });

    it('export destructuring binds every name', async () => {
        const { exports } = await run(lower('const obj = { x: 1, y: [2] };\nexport const { x, y: [z] } = obj;\n').code);
        expect(exports.x).toBe(1);
        expect(exports.z).toBe(2);
    });

    it('export specifiers with rename', async () => {
        const { exports } = await run(lower('const a = 1, b = 2;\nexport { a, b as c };\n').code);
        expect(exports.a).toBe(1);
        expect(exports.c).toBe(2);
    });

    it('re-export a binding from another module', async () => {
        const { exports } = await run(lower('export { x, y as "z-z" } from "./dep";\n').code, { './dep': { x: 7, y: 8 } });
        expect(exports.x).toBe(7);
        expect(exports['z-z']).toBe(8);
    });

    it('export * merges the dep namespace', async () => {
        const { exports } = await run(lower('export * from "./dep";\n').code, { './dep': { a: 1, b: 2 } });
        expect(exports.a).toBe(1);
        expect(exports.b).toBe(2);
    });

    it('export * as namespace', async () => {
        const dep = { a: 1 };
        const { exports } = await run(lower('export * as ns from "./dep";\n').code, { './dep': dep });
        expect(exports.ns).toBe(dep);
    });

    it('export default — anonymous / named / expression', async () => {
        expect((await run(lower('export default 42;\n').code)).exports.default).toBe(42);
        expect(typeof (await run(lower('export default function () {}\n').code)).exports.default).toBe('function');
        expect(typeof (await run(lower('export default class {}\n').code)).exports.default).toBe('function');
        const { exports } = await run(lower('import { a } from "./m";\nexport default a;\n').code, { './m': { a: 'x' } });
        expect(exports.default).toBe('x');
    });
});

describe('devTransform — intrinsics + HMR', () => {
    it('import.meta rewrites to the runtime meta', async () => {
        const { exports } = await run(lower('export const u = import.meta.url;\n').code);
        expect(exports.u).toBe('file:///m.js');
    });

    it('dynamic import rewrites to link, recorded as a dynamic dep', async () => {
        const { code, dynamicDeps } = lower('export const p = import("./d");\n');
        expect(dynamicDeps).toEqual(['./d']);
        const { exports, linked } = await run(code, { './d': { default: 1 } });
        await exports.p;
        expect(linked).toContain('./d');
    });

    it.each([
        ['import.meta.hot.accept();\n', { selfAccepts: true, acceptedDeps: [] }],
        ['import.meta.hot.accept((m) => {});\n', { selfAccepts: true, acceptedDeps: [] }],
        ['import.meta.hot.accept("./dep", (m) => {});\n', { selfAccepts: false, acceptedDeps: ['./dep'] }],
        ['import.meta.hot.accept(["./a", "./b"], (m) => {});\n', { selfAccepts: false, acceptedDeps: ['./a', './b'] }],
        ['import.meta.hot.acceptExports(["x"]);\n', { selfAccepts: true, acceptedDeps: [] }],
    ])('HMR: %s', (src, hmr) => {
        expect(lower(src).hmr).toEqual(hmr);
    });

    it('mixed module: deps + dynamicDeps recorded, exports resolve', async () => {
        const { code, deps, dynamicDeps } = lower('import { a } from "./a";\nimport { b } from "./b";\nexport const u = a + b;\nconst d = import("./d");\n');
        expect(deps).toEqual(['./a', './b']);
        expect(dynamicDeps).toEqual(['./d']);
        const { exports } = await run(code, { './a': { a: 2 }, './b': { b: 3 }, './d': {} });
        expect(exports.u).toBe(5);
    });
});
