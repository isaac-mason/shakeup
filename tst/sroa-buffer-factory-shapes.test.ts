import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

// The exact shape crashcat writes its scratch in, which is also the shape a numeric package forces:
//
//   import { mat4 } from 'math';                    // barrel: export * as mat4 from './mat4.js'
//   const _m: Mat4 = /* @__PURE__ */ mat4.create(); // factory call through the NAMESPACE
//
// Three things have to line up for SROA to reach it: `@flatten` must reach a module-scope initialiser
// of a buffer the optimized function uses, the callee must resolve through a namespace member, and
// the donor lives in another module. Miss any one and the buffer keeps its array — which is what 40
// of crashcat's 57 remaining `no-shape` refusals are.

const build = async (files: Record<string, string>, output: Record<string, unknown> = { optimize: true }) => {
    const r = await bundle({ input: '/m.ts', fs: createMemoryFs(files), external: [], output } as never);
    expect(r.errors).toEqual([]);
    return r.chunks[0].code;
};

const LIB = {
    '/mat4.js': 'export function create() { return [1, 0, 0, 1]; }\nexport function identity(o) { o[0] = 1; o[1] = 0; o[2] = 0; o[3] = 1; return o; }\n',
    '/index.js': "export * as mat4 from './mat4.js';\n",
};

describe('a scratch buffer built by a namespace factory', () => {
    it('reaches SROA through a direct named import', async () => {
        const code = await build({
            '/mat4.js': LIB['/mat4.js'],
            '/m.ts': `import { create } from './mat4.js';

const _m = /* @__PURE__ */ create();

/* @optimize */
export function f(a) { _m[0] = a; _m[1] = a * 2; _m[2] = 0; _m[3] = 1; return _m[0] + _m[1] + _m[3]; }`,
        });
        expect(code).not.toMatch(/_m\s*\[/);
    });

    it('reaches SROA through a namespace member call', async () => {
        const code = await build({
            ...LIB,
            '/m.ts': `import { mat4 } from './index.js';

const _m = /* @__PURE__ */ mat4.create();

/* @optimize */
export function f(a) { _m[0] = a; _m[1] = a * 2; _m[2] = 0; _m[3] = 1; return _m[0] + _m[1] + _m[3]; }`,
        });
        expect(code).not.toMatch(/_m\s*\[/);
    });

    // The annotation is stripped before the optimize tier runs, so it must not change the outcome —
    // but it is what every real declaration carries, so it is worth pinning.
    it('is unaffected by a type annotation naming an imported type', async () => {
        const code = await build({
            ...LIB,
            '/types.ts': 'export type Mat4 = [number, number, number, number];\n',
            '/m.ts': `import { mat4 } from './index.js';
import type { Mat4 } from './types.ts';

const _m: Mat4 = /* @__PURE__ */ mat4.create();

/* @optimize */
export function f(a: number): number { _m[0] = a; _m[1] = a * 2; _m[2] = 0; _m[3] = 1; return _m[0] + _m[1] + _m[3]; }`,
        });
        expect(code).not.toMatch(/_m\s*\[/);
    });

    it('preserves behaviour', async () => {
        const files = {
            ...LIB,
            '/m.ts': `import { mat4 } from './index.js';
const _m = /* @__PURE__ */ mat4.create();
/* @optimize */
export function f(a) { _m[0] = a; _m[1] = a * 2; _m[2] = 0; _m[3] = 1; return _m[0] + _m[1] + _m[3]; }`,
        };
        const strip = (c: string) => c.replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '').replace(/\bexport\s+/g, '');
        const on = new Function(`${strip(await build(files))}\nreturn f(5);`)();
        expect(on).toBe(16);
        expect(on).toBe(new Function(`${strip(await build(files, { optimize: false }))}\nreturn f(5);`)());
    });
});
